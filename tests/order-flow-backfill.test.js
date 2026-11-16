'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { OrderFlowArchive } = require('../trading/order-flow/archive');
const { HistoricalBackfill } = require('../trading/order-flow/backfill');
const T = 1700000040000;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderflow-backfill-'));
  const archive = new OrderFlowArchive(path.join(dir, 'archive.sqlite'));
  t.after(() => { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return archive;
}

function source(trades, mismatch = false) {
  const calls = [];
  const request = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint === 'aggTrades') return trades.filter(raw => params.fromId !== undefined
      ? raw.a >= params.fromId : raw.T >= params.startTime && raw.T <= params.endTime).slice(0, params.limit);
    return Array.from({ length: params.limit }, (_, i) => {
      const time = params.startTime + i * 60000;
      const minute = trades.filter(raw => raw.T >= time && raw.T < time + 60000);
      const total = minute.reduce((sum, raw) => sum + Number(raw.q), 0);
      const buy = minute.filter(raw => !raw.m).reduce((sum, raw) => sum + Number(raw.q), 0);
      return [time, 0, 0, 0, 0, String(total + (mismatch ? 1 : 0)), 0, 0, 0, String(buy)];
    });
  };
  return { calls, request };
}

test('真实历史多页回补原子替换实时部分数据，重复回补不翻倍', async t => {
  const archive = fixture(t);
  const trades = Array.from({ length: 1500 }, (_, i) => ({
    a: 1000 + i, T: T + i, p: '60001', q: '1', m: i % 2 === 0,
  }));
  trades.push({ a: 2500, T: T + 60000, p: '60001', q: '1', m: false });
  archive.ingest(trades[800]);
  archive.ingest({ a: 3000, T: T + 120000, p: '60001', q: '2', m: false });
  const checkpoint = archive.status();
  const remote = source(trades);
  const worker = new HistoricalBackfill(archive, remote);
  assert.equal(await worker.minute(T), 1500);
  assert.ok(remote.calls.some(c => c.params.fromId === 2000));
  const bar = archive.getHistory('1m', T, 1)[0];
  assert.equal(bar.coverage, 'complete');
  assert.deepEqual(bar.cells[60000], { buyVol: 750, sellVol: 750 });
  assert.deepEqual(archive.status(), checkpoint);
  await worker.minute(T);
  assert.deepEqual(archive.getHistory('1m', T, 1)[0], bar);
  archive.ingest({ a: 3001, T: T + 180000, p: '60001', q: '3', m: false });
  assert.equal(archive.getHistory('1m', T + 180000, 1)[0].cells[60000].buyVol, 3);
});

test('晚到的实时成交不能重复写入已验证分钟，checkpoint仍推进', async t => {
  const archive = fixture(t);
  const trade = { a: 1, T: T + 1, p: '60001', q: '1', m: false };
  await new HistoricalBackfill(archive, source([trade])).minute(T);
  assert.equal(archive.ingest(trade), true);
  archive.flush();
  assert.equal(archive.getHistory('1m', T, 1)[0].cells[60000].buyVol, 1);
  assert.equal(archive.status().lastAggId, 1);
});

test('缺ID、数量校验失败和请求失败都不覆盖已有分钟', async t => {
  const archive = fixture(t);
  archive.ingest({ a: 10, T, p: '60001', q: '2', m: false });
  const old = archive.getHistory('1m', T, 1)[0];
  const trades = [
    { a: 1, T, p: '60001', q: '1', m: false },
    { a: 3, T: T + 1, p: '60001', q: '1', m: false },
  ];
  await assert.rejects(new HistoricalBackfill(archive, source(trades)).minute(T), /不连续/);
  await assert.rejects(new HistoricalBackfill(archive, source(trades.slice(0, 1), true)).minute(T), /不一致/);
  await assert.rejects(new HistoricalBackfill(archive, {
    request: async () => { throw new Error('upstream offline'); },
  }).minute(T), /offline/);
  assert.deepEqual(archive.getHistory('1m', T, 1)[0], old);
  assert.equal(archive.isBackfilled(T), false);
});

test('零成交分钟也必须与真实K线核对，跨周期完整性合并，重启保留', async t => {
  const archive = fixture(t);
  const worker = new HistoricalBackfill(archive, source([]));
  const start = Math.floor(T / 300000) * 300000;
  for (let i = 0; i < 5; i++) await worker.minute(start + i * 60000);
  assert.equal(archive.getHistory('5m', start, 1)[0].coverage, 'complete');
  const file = archive.db.name;
  archive.close();
  const restored = new OrderFlowArchive(file);
  try {
    assert.equal(restored.getHistory('5m', start, 1)[0].coverage, 'complete');
  } finally { restored.close(); }
});

test('回补队列串行运行、范围去重、进度和失败可重试', async t => {
  const archive = fixture(t);
  const worker = new HistoricalBackfill(archive, source([]));
  const first = worker.enqueue(T, T + 120000);
  assert.equal(worker.enqueue(T, T + 120000).id, first.id);
  await worker.drain();
  assert.equal(first.state, 'complete');
  assert.equal(first.completed, 2);
  const fail = new HistoricalBackfill(archive, { request: async () => { throw new Error('offline'); } });
  const failed = fail.enqueue(T - 60000, T);
  await fail.drain();
  assert.equal(failed.state, 'failed');
  assert.match(failed.error, /offline/);
  assert.notEqual(fail.enqueue(T - 60000, T).id, failed.id);
  await fail.drain();
  assert.throws(() => worker.enqueue(T + 1, T + 60000), RangeError);
});

for (const days of [151, 296, 1500]) {
  test(`${days}天日线范围可提交，仍按5分钟下载并能被新视口取消`, async t => {
    const archive = fixture(t);
    const remote = source([]);
    let latest;
    let big;
    const worker = new HistoricalBackfill(archive, {
      request: async (endpoint, params) => {
        if (endpoint === 'aggTrades' && params.endTime === T - 5 * 60000 - 1) {
          assert.equal(big.completed, 5);
          latest = worker.enqueue(T, T + 60000, 'daily_page');
        }
        return remote.request(endpoint, params);
      },
    });
    big = worker.enqueue(T - days * 86400000, T, 'daily_page');
    assert.equal(big.total, days * 1440);
    assert.equal(worker.enqueue(big.start, T, 'daily_page'), big);
    await worker.drain();
    assert.equal(big.state, 'cancelled');
    assert.equal(big.completed, 5);
    assert.equal(latest.state, 'complete');
    assert.equal(archive.isBackfilled(T - 60000), true);
    assert.equal(archive.isBackfilled(T - 6 * 60000), false);
    assert.equal(remote.calls[0].params.startTime, T - 5 * 60000);
    assert.ok(remote.calls.filter(c => c.endpoint === 'aggTrades')
      .every(c => c.params.endTime - c.params.startTime < 5 * 60000));
    assert.ok(remote.calls.filter(c => c.endpoint === 'klines').every(c => c.params.limit <= 5));
  });
}

test('范围校验分别提示时间类型、分钟边界、历史下限和未来时间，不取消有效任务', async t => {
  const worker = new HistoricalBackfill(fixture(t), source([]));
  const active = worker.enqueue(T, T + 60000, 'page_a');
  const closed = Math.floor(Date.now() / 60000) * 60000;
  assert.throws(() => worker.enqueue(String(T), T + 60000, 'page_a'), /整数毫秒/);
  assert.throws(() => worker.enqueue(T, NaN, 'page_a'), /整数毫秒/);
  assert.throws(() => worker.enqueue(T + 1, T + 60000, 'page_a'), /分钟边界/);
  assert.throws(() => worker.enqueue(0, T, 'page_a'), /早于支持/);
  assert.throws(() => worker.enqueue(T, T, 'page_a'), /晚于开始/);
  assert.throws(() => worker.enqueue(T, closed + 120000, 'page_a'), /未来时间/);
  assert.equal(active.state, 'queued');
  await worker.drain();
  assert.equal(active.state, 'complete');
});

test('币安429响应设置冷却并明确报错，不自动无限重试', async t => {
  const archive = fixture(t);
  const worker = new HistoricalBackfill(archive);
  const axios = require('axios');
  const original = axios.get;
  let calls = 0;
  axios.get = async () => {
    calls++;
    const error = new Error('rate limited');
    error.response = { status: 429, headers: { 'retry-after': '120' } };
    throw error;
  };
  try {
    await assert.rejects(worker.binance('aggTrades', {}), /限流/);
    assert.equal(calls, 1);
    assert.ok(worker.nextRequest >= Date.now() + 119000);
  } finally { axios.get = original; }
});

test('连续5分钟合并下载只需2次请求，仍逐分钟核验并入库', async t => {
  const archive = fixture(t);
  const trades = Array.from({ length: 30 }, (_, i) => ({
    a: 100 + i, T: T + Math.floor(i / 6) * 60000 + i % 6,
    p: '60001', q: '1', m: i % 2 === 0,
  }));
  const remote = source(trades);
  const worker = new HistoricalBackfill(archive, remote);
  const job = worker.enqueue(T, T + 5 * 60000, 'page_a');
  await worker.drain();
  assert.equal(job.state, 'complete');
  assert.equal(job.completed, 5);
  assert.equal(job.batches, 1);
  assert.equal(remote.calls.length, 2);
  assert.equal(remote.calls[1].params.limit, 5);
  for (const bar of archive.getHistory('1m', T + 4 * 60000, 5)) {
    assert.equal(bar.coverage, 'complete');
    assert.deepEqual(bar.cells[60000], { buyVol: 3, sellVol: 3 });
  }
});

test('新视口优先获得一批，大任务分批轮转而非占满执行器', async t => {
  const archive = fixture(t);
  const remote = source([]);
  let other;
  const worker = new HistoricalBackfill(archive, {
    request: async (endpoint, params) => {
      if (!other) other = worker.enqueue(T + 30 * 60000, T + 31 * 60000, 'page_b');
      return remote.request(endpoint, params);
    },
  });
  const big = worker.enqueue(T, T + 15 * 60000, 'page_a');
  await worker.drain();
  assert.deepEqual(remote.calls.filter(c => c.endpoint === 'aggTrades').map(c => c.params.startTime),
    [T + 10 * 60000, T + 30 * 60000, T + 5 * 60000, T]);
  assert.equal(big.batches, 3);
  assert.equal(big.completed, 15);
  assert.equal(other.state, 'complete');
});

test('高成交批次6次请求后让出，分页续传不重下且保留完整性', async t => {
  const archive = fixture(t);
  const trades = Array.from({ length: 8000 }, (_, i) => ({
    a: 1000 + i, T: T + Math.floor(i / 1600) * 60000 + i % 1600,
    p: '60001', q: '1', m: i % 2 === 0,
  }));
  const remote = source(trades);
  let other;
  let big;
  const worker = new HistoricalBackfill(archive, {
    request: async (endpoint, params) => {
      if (!other) other = worker.enqueue(T + 10 * 60000, T + 11 * 60000, 'page_b');
      if (params.startTime === T + 10 * 60000) {
        assert.equal(big.completed, 0);
        assert.equal(archive.isBackfilled(T), false);
      }
      return remote.request(endpoint, params);
    },
  });
  big = worker.enqueue(T, T + 5 * 60000, 'page_a');
  await worker.drain();
  assert.equal(remote.calls[6].params.startTime, T + 10 * 60000);
  assert.equal(remote.calls[8].params.fromId, 7000);
  assert.equal(remote.calls.filter(c => c.endpoint === 'aggTrades' && c.params.startTime === T).length, 1);
  assert.equal(big.state, 'complete');
  assert.equal(big.trades, 8000);
  assert.equal(other.state, 'complete');
  for (const bar of archive.getHistory('1m', T + 4 * 60000, 5)) {
    assert.deepEqual(bar.cells[60000], { buyVol: 800, sellVol: 800 });
  }
});

test('持续不一致的批次拆分重试后保留缺口，完整区间不重复下载', async t => {
  const archive = fixture(t);
  const failed = new HistoricalBackfill(archive, { ...source([], true), retryDelays: [0, 0] });
  const job = failed.enqueue(T, T + 5 * 60000, 'page_a');
  await failed.drain();
  assert.equal(job.state, 'partial');
  assert.equal(job.completed, 0);
  assert.equal(job.skipped, 5);
  assert.equal(job.retries, 10);
  for (let i = 0; i < 5; i++) assert.equal(archive.isBackfilled(T + i * 60000), false);
  const remote = source([]);
  const worker = new HistoricalBackfill(archive, remote);
  await worker.minute(T + 2 * 60000);
  remote.calls.length = 0;
  const resume = worker.enqueue(T, T + 5 * 60000, 'page_a');
  await worker.drain();
  assert.equal(resume.completed, 5);
  assert.deepEqual(remote.calls.filter(c => c.endpoint === 'aggTrades').map(c => [
    c.params.startTime, c.params.endTime
  ]), [[T + 3 * 60000, T + 5 * 60000 - 1], [T, T + 2 * 60000 - 1]]);
});

test('偶发数量不一致自动重新下载，两次快照不叠加', async t => {
  const archive = fixture(t);
  let downloads = 0;
  const worker = new HistoricalBackfill(archive, {
    retryDelays: [0, 0],
    request: async endpoint => {
      if (endpoint === 'aggTrades') {
        downloads++;
        return [{ a: 10, T, p: '60001', q: downloads === 1 ? '1' : '2', m: false }];
      }
      return [[T, 0, 0, 0, 0, '2', 0, 0, 0, '2']];
    },
  });
  const job = worker.enqueue(T, T + 60000, 'page_a');
  await worker.drain();
  assert.equal(job.state, 'complete');
  assert.equal(job.retries, 1);
  assert.equal(downloads, 2);
  assert.equal(archive.getHistory('1m', T, 1)[0].cells[60000].buyVol, 2);
});

test('单个持续错误分钟不阻断其他历史，缺口可单独再次回补', async t => {
  const archive = fixture(t);
  const remote = source([]);
  let mismatch = true;
  const worker = new HistoricalBackfill(archive, {
    retryDelays: [0, 0],
    request: async (endpoint, params) => {
      const result = await remote.request(endpoint, params);
      if (endpoint === 'klines' && mismatch) {
        for (const row of result) if (row[0] === T + 2 * 60000) row[5] = '1';
      }
      return result;
    },
  });
  const job = worker.enqueue(T, T + 5 * 60000, 'page_a');
  await worker.drain();
  assert.equal(job.state, 'partial');
  assert.equal(job.completed, 4);
  assert.equal(job.skipped, 1);
  assert.equal(job.failures[0].minute, T + 2 * 60000);
  assert.equal(job.failures[0].actualTotalUnits, 0);
  assert.equal(job.failures[0].expectedTotalUnits, 100000000);
  assert.equal(archive.isBackfilled(T + 2 * 60000), false);
  assert.equal(archive.isBackfilled(T), true);
  assert.equal(archive.isBackfilled(T + 4 * 60000), true);
  remote.calls.length = 0;
  mismatch = false;
  const retry = worker.enqueue(T, T + 5 * 60000, 'page_a');
  assert.notEqual(retry.id, job.id);
  await worker.drain();
  assert.equal(retry.state, 'complete');
  assert.equal(remote.calls.filter(call => call.endpoint === 'aggTrades').length, 1);
  assert.equal(remote.calls[0].params.startTime, T + 2 * 60000);
});

test('重试退避不占住执行器，新页面可继续，旧任务取消后不再重试', async t => {
  const archive = fixture(t);
  const remote = source([]);
  let mismatch = true;
  const worker = new HistoricalBackfill(archive, {
    retryDelays: [10000, 10000],
    request: async (endpoint, params) => {
      const result = await remote.request(endpoint, params);
      if (endpoint === 'klines' && mismatch && params.startTime === T) result[0][5] = '1';
      return result;
    },
  });
  const old = worker.enqueue(T, T + 60000, 'page_a');
  await worker.drain();
  assert.equal(old.phase, 'retrying');
  assert.equal(old.state, 'queued');
  const other = worker.enqueue(T + 60000, T + 120000, 'page_b');
  await worker.drain();
  assert.equal(other.state, 'complete');
  assert.equal(old.retries, 1);
  mismatch = false;
  const latest = worker.enqueue(T - 60000, T + 60000, 'page_a');
  await worker.drain();
  assert.equal(old.state, 'cancelled');
  assert.equal(latest.state, 'complete');
  assert.equal(archive.isBackfilled(T), true);
});

test('同一页面连续切换20个范围只保留最新任务，旧页面队列也有界', async t => {
  const archive = fixture(t);
  const worker = new HistoricalBackfill(archive, source([]));
  let latest;
  for (let i = 0; i < 20; i++) latest = worker.enqueue(T + i * 60000, T + (i + 1) * 60000, 'page_a');
  assert.equal([...worker.jobs.values()].filter(j => j.state === 'queued').length, 1);
  await worker.drain();
  assert.equal(latest.state, 'complete');
  assert.equal(archive.isBackfilled(T), false);
  assert.equal(archive.isBackfilled(latest.start), true);
  for (let i = 0; i < 40; i++) worker.enqueue(T - (i + 1) * 60000, T - i * 60000);
  assert.ok([...worker.jobs.values()].filter(j => j.state === 'queued').length <= 8);
  assert.ok(worker.jobs.size <= 32);
  await worker.drain();
  assert.throws(() => worker.enqueue(T, T + 60000, 'invalid client id'), RangeError);
});

test('替换正在分页的任务安全取消，不写入未验证分钟且不影响其它页面', async t => {
  const archive = fixture(t);
  let release;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const worker = new HistoricalBackfill(archive, {
    request: async (endpoint, params) => {
      if (endpoint === 'aggTrades' && params.startTime === T) {
        requested();
        return new Promise(resolve => { release = resolve; });
      }
      return endpoint === 'aggTrades' ? [] : [[params.startTime, 0, 0, 0, 0, '0', 0, 0, 0, '0']];
    },
  });
  const old = worker.enqueue(T, T + 60000, 'page_a');
  const draining = worker.drain();
  await started;
  const other = worker.enqueue(T + 120000, T + 180000, 'page_b');
  const latest = worker.enqueue(T + 60000, T + 120000, 'page_a');
  assert.equal(old.state, 'cancelled');
  assert.equal(other.state, 'queued');
  release([]);
  await draining;
  assert.equal(old.state, 'cancelled');
  assert.equal(archive.isBackfilled(T), false);
  assert.equal(latest.state, 'complete');
  assert.equal(other.state, 'complete');
});

test('页面自动回补在历史模式刷新快照，不叠加且不触发通知', async () => {
  const vm = require('vm');
  const Profile = require('../public/order-flow/profile');
  const html = fs.readFileSync(path.join(__dirname, '../public/pro_order_flow.html'), 'utf8');
  const code = html.slice(html.indexOf('let historicalJob ='), html.indexOf('async function loadHistoricalAndConnect()'));
  const nodes = new Map();
  const calls = [];
  let now = Date.now();
  let busy = false;
  const end = T + 60000;
  class Cell {}
  const snapshot = { startTime: T, coverage: 'complete',
    cells: { 60000: { buyVol: 2, sellVol: 1 } } };
  const state = { isRunning: false, archiveAvailable: true, archiveVersion: 0,
    profileRange: { start: T, end }, profileNotification: { value: 'old' },
    footprints: [{ startTime: T, cells: new Map(), coverage: 'missing' }] };
  const job = { id: '1', state: 'queued', total: 1, completed: 0 };
  const context = {
    STATE: state, CONFIG: { timeframe: 60000 }, loadGeneration: 1, currentBinanceTF: '1m',
    FPCell: Cell, OrderFlowProfile: Profile, AbortSignal, console,
    crypto: require('crypto').webcrypto,
    Date: class extends Date { static now() { return now; } },
    renderAll() {},
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, hidden: true });
      return nodes.get(id);
    } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (busy && options?.method === 'POST') {
        return { status: 429, ok: false, json: async () => ({ ok: false, error: 'queue full' }) };
      }
      return { ok: true, json: async () => url.includes('history?')
        ? { ok: true, data: [snapshot] } : { ok: true, job: { ...job } } };
    },
  };
  vm.runInNewContext(code + '\nthis.sync = syncHistoricalBackfill;', context);
  await context.sync();
  assert.equal(calls[0].options.method, 'POST');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.startTime, T);
  assert.equal(payload.endTime, end);
  assert.match(payload.clientId, /^[a-f0-9]{32}$/);
  assert.equal(state.footprints[0].cells.get(60000).buyVol, 2);
  assert.equal(state.profileNotification, null);
  assert.match(nodes.get('vp-backfill').textContent, /准备中/);
  job.phase = 'rotating';
  await context.sync();
  assert.match(nodes.get('vp-backfill').textContent, /分批轮转中/);
  job.phase = 'retrying';
  await context.sync();
  assert.match(nodes.get('vp-backfill').textContent, /自动重试中/);
  job.state = 'complete'; job.completed = 1;
  await context.sync();
  assert.equal(state.footprints[0].cells.get(60000).buyVol, 2);
  assert.match(nodes.get('vp-backfill').textContent, /完成 1\/1/);
  assert.equal(calls.some(call => call.url.includes('notify-')), false);
  state.profileRange.end += 60000;
  job.state = 'partial'; job.skipped = 1; job.total = 2;
  await context.sync();
  assert.match(nodes.get('vp-backfill').textContent, /1 分钟仍有缺口/);
  assert.equal(nodes.get('vp-backfill-retry').hidden, false);
  const terminalCount = calls.length;
  await context.sync();
  assert.equal(calls.length, terminalCount);
  state.profileRange.end += 60000;
  busy = true;
  await context.sync();
  assert.match(nodes.get('vp-backfill').textContent, /自动重试/);
  assert.equal(nodes.get('vp-backfill-retry').hidden, true);
  const count = calls.length;
  await context.sync();
  assert.equal(calls.length, count);
  now += 16000;
  busy = false;
  await context.sync();
  const posts = calls.filter(call => call.options?.method === 'POST');
  assert.equal(posts.length, 4);
  assert.equal(JSON.parse(posts.at(-1).options.body).clientId, payload.clientId);
});
