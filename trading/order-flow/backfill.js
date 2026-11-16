'use strict';
const axios = require('axios');
const { httpAgent, httpsAgent } = require('../../lib/httpAgents');

function units(value) {
  if (!/^\d+(\.\d{1,8})?$/.test(String(value))) throw new Error('Invalid Binance quantity');
  const [whole, fraction = ''] = String(value).split('.');
  const result = Number(whole) * 100000000 + Number(fraction.padEnd(8, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('Quantity exceeds integer precision');
  return result;
}

function agent() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return httpsAgent;
  return /^socks/i.test(proxy) ? new (require('socks-proxy-agent').SocksProxyAgent)(proxy)
    : new (require('https-proxy-agent').HttpsProxyAgent)(proxy);
}

class HistoricalBackfill {
  constructor(archive, options = {}) {
    this.archive = archive;
    this.jobs = new Map();
    this.running = false;
    this.sequence = 0;
    this.nextRequest = 0;
    this.work = new WeakMap();
    this.turn = 0;
    this.preferNew = true;
    this.retryDelays = options.retryDelays || [2000, 5000];
    this.retryTimer = null;
    this.request = options.request || this.binance.bind(this);
  }

  async binance(endpoint, params) {
    const wait = this.nextRequest - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.nextRequest = Date.now() + 400; // At most 2.5 historical requests/s for this process.
    try {
      const response = await axios.get('https://api.binance.com/api/v3/' + endpoint, {
        params: { symbol: 'BTCUSDT', ...params }, timeout: Number(process.env.BINANCE_TIMEOUT_MS || 10000),
        httpAgent, httpsAgent: agent(), proxy: false, maxContentLength: 8 * 1024 * 1024,
      });
      return response.data;
    } catch (error) {
      if ([418, 429].includes(error.response?.status)) {
        const retry = Number(error.response.headers?.['retry-after']);
        this.nextRequest = Date.now() + Math.max(60000, Number.isFinite(retry) ? retry * 1000 : 0);
        throw new Error('币安限流，至少等待一分钟后重试');
      }
      throw new Error('币安历史成交请求失败: ' + error.message);
    }
  }

  enqueue(start, end, clientId = null) {
    if (clientId !== null && (typeof clientId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(clientId))) throw new RangeError('Invalid backfill clientId');
    const closed = Math.floor(Date.now() / 60000) * 60000;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new RangeError('回补起止时间须为整数毫秒时间戳');
    }
    if (start % 60000 || end % 60000) throw new RangeError('回补起止时间须对齐分钟边界');
    if (start < 1500000000000) throw new RangeError('回补起始时间早于支持的历史范围');
    if (end <= start) throw new RangeError('回补结束时间须晚于开始时间');
    if (end > closed + 60000) throw new RangeError('回补不支持未来时间，请检查客户端和服务器时钟');
    // Bound downloads per turn, not the viewport span: daily charts can exceed 150 days.
    end = Math.min(end, closed);
    for (const job of this.jobs.values()) {
      if (job.clientId === clientId && job.start === start && job.end === end &&
          !['failed', 'cancelled', 'partial'].includes(job.state)) return job;
    }
    // Each page owns one viewport. Superseded work must not occupy the bounded queue.
    if (clientId !== null) {
      for (const job of this.jobs.values()) {
        if (job.clientId === clientId && ['queued', 'running'].includes(job.state)) {
          job.state = 'cancelled';
          if (this.executingJob !== job) this.work.get(job).download = null;
        }
      }
    }
    const active = [...this.jobs.values()].filter(j => ['queued', 'running'].includes(j.state));
    if (active.length >= 8) {
      // Legacy pages without clientId are bounded too; newest visible work replaces stale queued work.
      const oldest = active.find(j => j.state === 'queued');
      if (oldest) {
        oldest.state = 'cancelled';
        this.work.get(oldest).download = null;
      }
    }
    if (this.jobs.size >= 32) {
      for (const [id, job] of this.jobs) {
        if (!['queued', 'running'].includes(job.state) && this.executingJob !== job) {
          this.jobs.delete(id); break;
        }
      }
    }
    const job = { id: String(++this.sequence), clientId, start, end, state: 'queued',
      total: Math.max(0, (end - start) / 60000), completed: 0, trades: 0, error: null,
      batches: 0, batchMinutes: 5, phase: 'waiting', retries: 0, skipped: 0, failures: [] };
    this.work.set(job, { cursor: end, priority: true, order: ++this.turn, download: null,
      readyAt: 0, splitUntil: end, attempts: new Map() });
    this.jobs.set(job.id, job);
    // Keep HTTP enqueue responses immediate; the worker owns all upstream concurrency.
    setImmediate(() => this.drain());
    return job;
  }

  async drain() {
    if (this.running) return;
    clearTimeout(this.retryTimer);
    this.running = true;
    try {
      for (;;) {
        const pending = [...this.jobs.values()].filter(j => j.state === 'queued');
        const queued = pending.filter(j => this.work.get(j).readyAt <= Date.now());
        const regular = queued.filter(j => !this.work.get(j).priority)
          .sort((a, b) => this.work.get(a).order - this.work.get(b).order);
        const newest = queued.slice().reverse().find(j => this.work.get(j).priority);
        // Alternate first turns for new viewports with fair turns for existing jobs.
        const job = newest && (this.preferNew || !regular.length) ? newest : regular[0];
        if (!job) {
          if (pending.length) {
            const readyAt = Math.min(...pending.map(j => this.work.get(j).readyAt));
            this.retryTimer = setTimeout(() => this.drain(), Math.max(1, readyAt - Date.now()));
            this.retryTimer.unref();
          }
          break;
        }
        const work = this.work.get(job);
        this.preferNew = newest && regular.length ? !work.priority : true;
        work.priority = false;
        this.executingJob = job;
        job.state = 'running';
        job.phase = 'downloading';
        try {
          if (!work.download && work.cursor > job.start) {
            const size = Math.min(work.cursor > work.splitUntil ? 1 : 5,
              (work.cursor - job.start) / 60000);
            const bars = this.archive.getHistory('1m', work.cursor - 1, size);
            let index = bars.length - 1;
            while (index >= 0 && bars[index].coverage === 'complete') {
              work.cursor -= 60000;
              job.completed++;
              index--;
            }
            if (index >= 0) {
              const end = work.cursor;
              while (index >= 0 && bars[index].coverage !== 'complete') index--;
              const start = index >= 0 ? bars[index].startTime + 60000 : bars[0].startTime;
              work.download = this.createDownload(start, end);
            }
          }
          if (work.download) {
            const result = await this.download(work.download, () => job.state === 'cancelled', 6);
            if (result.done) {
              job.completed += (work.download.end - work.download.start) / 60000;
              work.cursor = work.download.start;
              job.trades += result.count;
              job.batches++;
              work.attempts.delete(work.download.start);
              work.download = null;
            }
          }
          if (job.state !== 'cancelled') {
            job.state = work.cursor <= job.start ? (job.skipped ? 'partial' : 'complete') : 'queued';
            job.phase = job.state === 'queued' ? 'rotating' : job.state;
            if (job.state === 'partial') job.error = `${job.skipped} 个分钟校验仍不一致，可重试缺口`;
            work.order = ++this.turn;
          }
        } catch (error) {
          if (job.state !== 'cancelled') {
            if (error.code === 'VOLUME_MISMATCH' && work.download) {
              const { start, end } = work.download;
              job.lastMismatch = error.details;
              work.download = null; // A fresh attempt must not reuse the suspect aggregate snapshot.
              job.state = 'queued';
              work.order = ++this.turn;
              if (end - start > 60000) {
                work.splitUntil = start;
                job.phase = 'splitting';
              } else {
                const attempts = work.attempts.get(start) || 0;
                if (attempts < this.retryDelays.length) {
                  work.attempts.set(start, attempts + 1);
                  work.readyAt = Date.now() + this.retryDelays[attempts];
                  job.retryAt = work.readyAt;
                  job.retries++;
                  job.phase = 'retrying';
                } else {
                  job.skipped++;
                  job.failures.push({ minute: start, ...error.details[0] });
                  if (job.failures.length > 20) job.failures.shift();
                  work.cursor = start;
                  work.attempts.delete(start);
                  job.phase = 'rotating';
                }
              }
              console.warn('[orderFlowBackfill] Volume validation mismatch:', JSON.stringify({
                job: job.id, start, end, phase: job.phase, details: error.details,
              }));
            } else {
              job.state = 'failed';
              job.error = error.message;
            }
          }
        } finally {
          this.executingJob = null;
          if (['failed', 'cancelled', 'partial'].includes(job.state)) work.download = null;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { this.running = false; }
  }

  async minute(start, cancelled = () => false) {
    const result = await this.download(this.createDownload(start, start + 60000), cancelled);
    return result.count;
  }

  createDownload(start, end) {
    const bars = new Map();
    for (let minute = start; minute < end; minute += 60000) {
      bars.set(minute, { cells: new Map(), buy: 0, sell: 0 });
    }
    return { start, end, bars, last: null, count: 0, pages: 0, finished: false };
  }

  async download(state, cancelled = () => false, budget = Infinity) {
    const checkCancelled = () => {
      if (cancelled()) throw new Error('Backfill superseded by a newer viewport');
    };
    const request = async (endpoint, params) => {
      checkCancelled();
      const result = await this.request(endpoint, params);
      checkCancelled();
      return result;
    };
    const { start, end } = state;
    let requests = 0;
    while (!state.finished) {
      if (requests >= budget) return { done: false };
      if (state.pages >= 1000) throw new Error('成交批次分页超过安全上限，未写入');
      const page = await request('aggTrades', state.last
        ? { fromId: state.last.a + 1, limit: 1000 }
        : { startTime: start, endTime: end - 1, limit: 1000 });
      requests++;
      state.pages++;
      if (!Array.isArray(page) || page.length > 1000) throw new Error('Invalid historical trade response');
      let reachedEnd = false;
      for (const raw of page) {
        if (!Number.isSafeInteger(raw.a) || raw.a < 0 || !Number.isSafeInteger(raw.T) ||
            raw.T < start || typeof raw.m !== 'boolean' ||
            (state.last && (raw.a !== state.last.a + 1 || raw.T < state.last.T))) {
          throw new Error('历史成交 ID 不连续或时间非法，未写入');
        }
        if (raw.T >= end) { reachedEnd = true; break; }
        const price = Number(raw.p);
        const quantity = units(raw.q);
        if (!Number.isFinite(price) || price <= 0 || quantity <= 0) throw new Error('Invalid historical trade');
        const level = Math.floor(price / 10) * 10;
        const bar = state.bars.get(Math.floor(raw.T / 60000) * 60000);
        const cell = bar.cells.get(level) || { buy: 0, sell: 0 };
        if (raw.m) { cell.sell += quantity; bar.sell += quantity; }
        else { cell.buy += quantity; bar.buy += quantity; }
        if (!Number.isSafeInteger(bar.buy + bar.sell)) throw new Error('Historical volume precision exceeded');
        bar.cells.set(level, cell);
        state.last = raw;
        state.count++;
      }
      state.finished = reachedEnd || page.length < 1000;
    }
    if (requests >= budget) return { done: false };
    const klines = await request('klines', {
      interval: '1m', startTime: start, endTime: end - 1, limit: state.bars.size,
    });
    if (!Array.isArray(klines) || klines.length !== state.bars.size) {
      throw new Error('币安 K 线批次缺失，未写入');
    }
    const mismatches = [];
    for (let i = 0; i < klines.length; i++) {
      const kline = klines[i];
      const bar = state.bars.get(start + i * 60000);
      if (!kline || kline[0] !== start + i * 60000) throw new Error('Invalid Binance kline time');
      const expectedTotalUnits = units(kline[5]);
      const expectedBuyUnits = units(kline[9]);
      if (expectedTotalUnits !== bar.buy + bar.sell || expectedBuyUnits !== bar.buy) {
        mismatches.push({ minute: kline[0], actualTotalUnits: bar.buy + bar.sell,
          actualBuyUnits: bar.buy, expectedTotalUnits, expectedBuyUnits });
      }
    }
    if (mismatches.length) {
      const error = new Error('历史成交与币安 K 线买卖量不一致，未写入；可稍后重试');
      error.code = 'VOLUME_MISMATCH';
      error.details = mismatches;
      throw error;
    }
    checkCancelled();
    for (const [minute, bar] of [...state.bars].reverse()) this.archive.replaceMinute(minute, bar.cells);
    return { done: true, count: state.count };
  }
}

module.exports = { HistoricalBackfill, units };
