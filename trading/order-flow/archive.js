'use strict';
const Database = require('better-sqlite3');

const TIMEFRAMES = Object.freeze({
  '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000,
});
const UNITS = 100000000;

function queryRange(tf, endTime = Date.now(), limit = 150) {
  const duration = TIMEFRAMES[tf];
  if (!duration || !Number.isSafeInteger(endTime) || endTime < 0 ||
      endTime > 8640000000000000 - duration || !Number.isInteger(limit) || limit < 1 || limit > 150) {
    throw new RangeError('Invalid timeframe, endTime or limit (1..150)');
  }
  const last = Math.floor(endTime / duration) * duration;
  return { duration, start: Math.max(0, last - (limit - 1) * duration), end: last + duration };
}

class OrderFlowArchive {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true });
    if (version > 1) throw new Error('Unsupported order-flow database version');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS volume_cells (
        minute INTEGER NOT NULL, level INTEGER NOT NULL,
        buy_units INTEGER NOT NULL, sell_units INTEGER NOT NULL,
        PRIMARY KEY (minute, level)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS coverage_segments (
        first_id INTEGER PRIMARY KEY, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS coverage_end ON coverage_segments(end_time);
      CREATE TABLE IF NOT EXISTS checkpoint (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        last_id INTEGER NOT NULL, last_time INTEGER NOT NULL, segment_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS backfilled_minutes (
        minute INTEGER PRIMARY KEY, completed_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const saved = this.db.prepare('SELECT * FROM checkpoint WHERE singleton = 1').get();
    this.lastId = saved?.last_id ?? null;
    this.lastTime = saved?.last_time ?? null;
    this.segmentId = saved?.segment_id ?? null;
    this.cells = new Map();
    this.segments = new Map();
    this.findBackfilled = this.db.prepare('SELECT 1 FROM backfilled_minutes WHERE minute = ?');
    const putCell = this.db.prepare(`INSERT INTO volume_cells VALUES (?, ?, ?, ?)
      ON CONFLICT(minute, level) DO UPDATE SET
      buy_units = buy_units + excluded.buy_units, sell_units = sell_units + excluded.sell_units`);
    const putSegment = this.db.prepare(`INSERT INTO coverage_segments VALUES (?, ?, ?)
      ON CONFLICT(first_id) DO UPDATE SET end_time = excluded.end_time`);
    const putCheckpoint = this.db.prepare(`INSERT INTO checkpoint VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
      last_id = excluded.last_id, last_time = excluded.last_time, segment_id = excluded.segment_id`);
    this.commit = this.db.transaction(() => {
      for (const cell of this.cells.values()) putCell.run(cell.minute, cell.level, cell.buy, cell.sell);
      for (const segment of this.segments.values()) putSegment.run(segment.id, segment.start, segment.end);
      putCheckpoint.run(this.lastId, this.lastTime, this.segmentId);
    });
  }

  ingest(raw) {
    const id = Number(raw?.a);
    const time = Number(raw?.T);
    const price = Number(raw?.p);
    const quantity = String(raw?.q ?? '');
    if (raw?.a == null || raw?.T == null || !Number.isSafeInteger(id) || id < 0 ||
        !Number.isSafeInteger(time) || time < 0 || time > 8640000000000000 ||
        !Number.isFinite(price) || price <= 0 || typeof raw.m !== 'boolean' ||
        !/^\d+(\.\d{1,8})?$/.test(quantity)) return false;
    const [whole, fraction = ''] = quantity.split('.');
    const units = Number(whole) * UNITS + Number(fraction.padEnd(8, '0'));
    if (!Number.isSafeInteger(units) || units <= 0 ||
        (this.lastId !== null && id <= this.lastId) ||
        (this.lastTime !== null && time < this.lastTime)) return false;

    // Binance aggregate IDs are ordered. A jump starts a new, explicitly partial segment.
    if (this.lastId === null || id !== this.lastId + 1) this.segmentId = id;
    const segment = this.segments.get(this.segmentId) ||
      { id: this.segmentId, start: time, end: time };
    segment.end = time;
    this.segments.set(this.segmentId, segment);
    const minute = Math.floor(time / 60000) * 60000;
    const level = Math.floor(price / 10) * 10;
    const key = `${minute}:${level}`;
    // A verified closed minute is authoritative, even if the socket later delivers a late trade.
    if (!this.isBackfilled(minute)) {
      const cell = this.cells.get(key) || { minute, level, buy: 0, sell: 0 };
      if (raw.m) cell.sell += units;
      else cell.buy += units;
      this.cells.set(key, cell);
    }
    this.lastId = id;
    this.lastTime = time;
    return true;
  }

  flush() {
    if (!this.segments.size) return;
    this.commit();
    this.cells.clear();
    this.segments.clear();
  }

  isBackfilled(minute) {
    return !!this.findBackfilled.get(minute);
  }

  replaceMinute(minute, cells) {
    if (!Number.isSafeInteger(minute) || minute % 60000 !== 0 ||
        minute + 60000 > Date.now()) throw new Error('Only closed minutes can be backfilled');
    for (const [level, cell] of cells) {
      if (!Number.isSafeInteger(level) || level <= 0 || level % 10 ||
          !Number.isSafeInteger(cell.buy) || cell.buy < 0 ||
          !Number.isSafeInteger(cell.sell) || cell.sell < 0) throw new Error('Invalid historical volume');
    }
    this.flush();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM volume_cells WHERE minute = ?').run(minute);
      const put = this.db.prepare('INSERT INTO volume_cells VALUES (?, ?, ?, ?)');
      for (const [level, cell] of cells) put.run(minute, level, cell.buy, cell.sell);
      this.db.prepare('INSERT OR REPLACE INTO backfilled_minutes VALUES (?, ?)').run(minute, Date.now());
    })();
  }

  getHistory(tf, endTime = Date.now(), limit = 150) {
    const { duration, start, end } = queryRange(tf, endTime, limit);
    this.flush();
    const rows = this.db.prepare(`SELECT CAST(minute / ? AS INTEGER) * ? AS startTime, level,
      SUM(buy_units) AS buy, SUM(sell_units) AS sell FROM volume_cells
      WHERE minute >= ? AND minute < ? GROUP BY startTime, level ORDER BY startTime, level`)
      .all(duration, duration, start, end);
    const segments = this.db.prepare(`SELECT start_time AS start, end_time AS end FROM coverage_segments
      WHERE end_time >= ? AND start_time < ? ORDER BY start_time`).all(start, end);
    const bars = new Map();
    const verified = new Set(this.db.prepare(
      'SELECT minute FROM backfilled_minutes WHERE minute >= ? AND minute < ?').all(start, end).map(r => r.minute));
    for (let time = start; time < end; time += duration) {
      let complete = true;
      let partial = segments.some(s => s.start < time + duration && s.end >= time);
      for (let minute = time; minute < time + duration; minute += 60000) {
        const covered = verified.has(minute) ||
          segments.some(s => s.start <= minute && s.end >= minute + 60000);
        if (verified.has(minute)) partial = true;
        if (!covered) complete = false;
      }
      bars.set(time, { startTime: time, cells: {}, totalDelta: 0,
        coverage: complete ? 'complete' : partial ? 'partial' : 'missing' });
    }
    for (const row of rows) {
      const bar = bars.get(row.startTime);
      bar.cells[row.level] = { buyVol: row.buy / UNITS, sellVol: row.sell / UNITS };
      bar.totalDelta += (row.buy - row.sell) / UNITS;
      if (bar.coverage === 'missing') bar.coverage = 'partial';
    }
    return [...bars.values()];
  }

  status() {
    return { market: 'spot', symbol: 'BTCUSDT', tickSize: 10,
      lastAggId: this.lastId, lastTradeTime: this.lastTime };
  }

  close() {
    if (!this.db.open) return;
    this.flush();
    this.db.close();
  }
}

module.exports = { OrderFlowArchive, TIMEFRAMES, queryRange };
