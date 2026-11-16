'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { OrderFlowArchive } = require('../trading/order-flow/archive');
const Profile = require('../public/order-flow/profile');
const T = 1700000040000;
const tick = (a, T, q = '1', m = false, p = '60001') => ({ a, T, q, m, p });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderflow-archive-'));
  const file = path.join(dir, 'archive.sqlite');
  const archive = new OrderFlowArchive(file);
  t.after(() => { archive.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, archive };
}

test('正常退出和重新打开恢复成交，重复ID及无效成交不重复计量', t => {
  const { file, archive } = fixture(t);
  assert.equal(archive.ingest(tick(10, T, '0.00000001')), true);
  assert.equal(archive.ingest(tick(11, T + 1000, '2.10000000', true)), true);
  archive.close();
  const restored = new OrderFlowArchive(file);
  try {
    assert.equal(restored.ingest(tick(11, T + 1000, '2.10000000', true)), false);
    assert.equal(restored.ingest(tick(9, T)), false);
    assert.equal(restored.ingest(tick(12, T - 1)), false);
    assert.equal(restored.ingest(tick(12, T, 'NaN')), false);
    assert.equal(restored.ingest({ ...tick(12, T), a: undefined }), false);
    assert.equal(restored.ingest(tick(12, T + 2000, '0.00000002')), true);
    const bar = restored.getHistory('1m', T, 1)[0];
    assert.equal(bar.cells[60000].buyVol, 0.00000003);
    assert.equal(bar.cells[60000].sellVol, 2.1);
    assert.equal(restored.status().lastAggId, 12);
  } finally { restored.close(); }
});

test('历史超过150根仍可分页，跨周期聚合一致且边界不重复', t => {
  const { archive } = fixture(t);
  for (let i = 0; i < 400; i++) archive.ingest(tick(i + 1, T + i * 60000));
  const latest = archive.getHistory('1m', T + 399 * 60000, 150);
  const previous = archive.getHistory('1m', latest[0].startTime - 1, 150);
  assert.equal(latest[0].startTime, T + 250 * 60000);
  assert.equal(previous[0].startTime, T + 100 * 60000);
  assert.equal(previous.at(-1).startTime + 60000, latest[0].startTime);
  const first = archive.getHistory('1m', T, 1)[0];
  assert.equal(first.cells[60000].buyVol, 1);
  for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
    const bars = archive.getHistory(tf, T + 399 * 60000, 150);
    assert.equal(bars.reduce((sum, bar) => sum + bar.totalDelta, 0), 400);
  }
});

test('连续成交覆盖空成交分钟；初始缺失、跳号和重启缺口明确标记', t => {
  const { file, archive } = fixture(t);
  archive.ingest(tick(1, T + 1000));
  archive.flush();
  archive.ingest(tick(2, T + 3 * 60000));
  archive.flush();
  assert.deepEqual(archive.getHistory('1m', T + 2 * 60000, 4).map(b => b.coverage),
    ['missing', 'partial', 'complete', 'complete']);
  archive.close();
  const restored = new OrderFlowArchive(file);
  try {
    restored.ingest(tick(5, T + 5 * 60000));
    restored.ingest(tick(6, T + 7 * 60000));
    const bars = restored.getHistory('1m', T + 7 * 60000, 5);
    assert.deepEqual(bars.map(b => b.coverage), ['partial', 'missing', 'complete', 'complete', 'partial']);
  } finally { restored.close(); }
});

test('事务失败不推进磁盘checkpoint，重试不会重复已提交数据', t => {
  const { file, archive } = fixture(t);
  archive.ingest(tick(1, T));
  archive.flush();
  archive.ingest(tick(2, T + 1000));
  archive.db.exec(`CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON checkpoint
    BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  assert.throws(() => archive.flush(), /test failure/);
  const Database = require('better-sqlite3');
  const reader = new Database(file, { readonly: true });
  assert.equal(reader.prepare('SELECT last_id FROM checkpoint').get().last_id, 1);
  assert.equal(reader.prepare('SELECT buy_units FROM volume_cells').get().buy_units, 100000000);
  reader.close();
  archive.db.exec('DROP TRIGGER fail_checkpoint');
  archive.flush();
  assert.equal(archive.getHistory('1m', T, 1)[0].cells[60000].buyVol, 2);
});

test('异常退出后已提交批次可恢复，未提交批次留下可识别缺口', t => {
  const { file, archive } = fixture(t);
  archive.close();
  const child = spawnSync(process.execPath, ['-e', `
    const {OrderFlowArchive}=require(${JSON.stringify(require.resolve('../trading/order-flow/archive'))});
    const db=new OrderFlowArchive(${JSON.stringify(file)});
    db.ingest(${JSON.stringify(tick(1, T))}); db.flush();
    db.ingest(${JSON.stringify(tick(2, T + 60000))});
    process.kill(process.pid, 'SIGKILL');
  `]);
  assert.equal(child.signal, 'SIGKILL');
  const restored = new OrderFlowArchive(file);
  try {
    restored.ingest(tick(3, T + 120000));
    const bars = restored.getHistory('1m', T + 120000, 3);
    assert.equal(bars[1].coverage, 'missing');
    assert.equal(bars[0].cells[60000].buyVol, 1);
  } finally { restored.close(); }
});

test('可见范围不混入屏幕外成交，价位快照重复同步不翻倍', () => {
  class Cell { constructor() { this.buyVol = 0; this.sellVol = 0; } }
  const bars = Array.from({ length: 20 }, (_, i) => ({
    startTime: T + i * 60000, cells: new Map([[60000 + i * 10, { buyVol: i + 1, sellVol: 0 }]]),
  }));
  const [first, end] = Profile.visibleIndices(bars.length, 1000, 0, 80);
  const live = Profile.aggregate(bars.slice(first, end));
  assert.equal(live.has(60000), false);
  assert.equal(live.has(60190), true);
  const [oldFirst, oldEnd] = Profile.visibleIndices(bars.length, 1000, 800, 80);
  const old = Profile.aggregate(bars.slice(oldFirst, oldEnd));
  assert.equal(old.has(60190), false);
  assert.equal(old.has(60000), true);
  const snapshot = { cells: { 60000: { buyVol: 2, sellVol: 1 } }, coverage: 'complete' };
  Profile.replaceCells(bars[0], snapshot, Cell);
  Profile.replaceCells(bars[0], snapshot, Cell);
  assert.deepEqual(Profile.aggregate([bars[0]]).get(60000), { buy: 2, sell: 1, total: 3 });
});

test('平移、缩放和历史返回只建立通知基线，实时范围内变化才通知', () => {
  let state = Profile.notification(null, 'live', 'A', true);
  assert.equal(state.send, false);
  state = Profile.notification(state, 'live', 'B', true);
  assert.equal(state.send, true);
  state = Profile.notification(state, 'zoom', 'C', true);
  assert.equal(state.send, false);
  state = Profile.notification(state, 'history', 'D', false);
  assert.equal(state.send, false);
  state = Profile.notification(state, 'live', 'E', true);
  assert.equal(state.send, false);
});
