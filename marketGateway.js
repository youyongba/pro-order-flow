'use strict';
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { httpAgent, httpsAgent } = require('./lib/httpAgents');
const { insideRoot } = require('./lib/runtime');
const WALLS_FILE = insideRoot('data/mtf_walls.json');
const intervals = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);
const wallTimeframes = new Set([...intervals, '1D']);
const wss = new WebSocket.Server({ noServer: true, maxPayload: 65536 });
const binanceTimeoutMs = Number(process.env.BINANCE_TIMEOUT_MS || 10000);
if (!Number.isSafeInteger(binanceTimeoutMs) || binanceTimeoutMs <= 0) {
  throw new Error('BINANCE_TIMEOUT_MS must be a positive integer');
}

function proxyAgent() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return undefined;
  if (/^socks/i.test(proxy)) return new (require('socks-proxy-agent').SocksProxyAgent)(proxy);
  return new (require('https-proxy-agent').HttpsProxyAgent)(proxy);
}

function loadWalls() {
  if (!fs.existsSync(WALLS_FILE)) return {};
  const data = JSON.parse(fs.readFileSync(WALLS_FILE, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid walls archive');
  return data;
}

function attachRoutes(app) {
  for (const endpoint of ['klines', 'depth']) {
    app.get('/api/proxy/' + endpoint, async (req, res) => {
      const symbol = req.query.symbol || 'BTCUSDT';
      const limit = Number(req.query.limit || (endpoint === 'depth' ? 1000 : 150));
      if (symbol !== 'BTCUSDT' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return res.status(400).json({ error: 'Invalid symbol or limit' });
      }
      const params = { symbol, limit };
      if (endpoint === 'klines') {
        if (!intervals.has(req.query.interval || '1m')) return res.status(400).json({ error: 'Invalid interval' });
        params.interval = req.query.interval || '1m';
        if (req.query.endTime !== undefined) {
          const endTime = Number(req.query.endTime);
          if (!Number.isSafeInteger(endTime) || endTime < 0) return res.status(400).json({ error: 'Invalid endTime' });
          params.endTime = endTime;
        }
      }
      try {
        const response = await axios.get('https://api.binance.com/api/v3/' + endpoint, {
          params, timeout: binanceTimeoutMs, httpAgent, httpsAgent: proxyAgent() || httpsAgent, proxy: false,
        });
        res.json(response.data);
      } catch (error) {
        res.status(502).json({ error: 'Market data unavailable: ' + error.message });
      }
    });
  }
  app.get('/api/mtf_walls', (req, res) => {
    try { res.json(loadWalls()); }
    catch (_) { res.status(500).json({ error: 'Cannot read walls archive; original file preserved' }); }
  });
  app.post('/api/mtf_walls', (req, res) => {
    const { tf, buy, sell } = req.body || {};
    if (!wallTimeframes.has(tf) || !Number.isFinite(Number(buy)) || !Number.isFinite(Number(sell)) ||
        Number(buy) < 0 || Number(sell) < 0) {
      return res.status(400).json({ error: 'Invalid wall values or timeframe' });
    }
    try {
      const walls = loadWalls();
      walls[tf] = { buy: Number(buy), sell: Number(sell), ts: Date.now() };
      fs.mkdirSync(path.dirname(WALLS_FILE), { recursive: true });
      const temp = WALLS_FILE + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(walls, null, 2), { mode: 0o600 });
      fs.renameSync(temp, WALLS_FILE);
      res.json({ success: true, walls });
    } catch (_) {
      res.status(500).json({ error: 'Cannot save walls archive' });
    }
  });
}

wss.on('connection', (client, request) => {
  const url = new URL(request.url, 'http://localhost');
  const streams = url.searchParams.get('streams');
  let upstream;
  try {
    upstream = new WebSocket('wss://stream.binance.com:9443/stream?streams=' + streams, {
      agent: proxyAgent(), handshakeTimeout: 12000,
    });
  } catch (_) { client.close(1011, 'Upstream unavailable'); return; }
  let lastMessage = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - lastMessage > 30000) upstream.terminate();
  }, 10000);
  timer.unref();
  upstream.on('message', (data, binary) => {
    lastMessage = Date.now();
    if (client.readyState === WebSocket.OPEN) {
      if (client.bufferedAmount > 1024 * 1024) client.close(1013, 'Slow consumer');
      else client.send(data, { binary });
    }
  });
  upstream.on('close', () => { clearInterval(timer); client.close(); });
  upstream.on('error', () => { clearInterval(timer); client.close(1011, 'Upstream unavailable'); });
  client.on('close', () => { clearInterval(timer); upstream.terminate(); });
  client.on('error', () => { clearInterval(timer); upstream.terminate(); });
});

function upgrade(request, socket, head) {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/ws/binance/stream') return false;
  const streams = (url.searchParams.get('streams') || '').split('/');
  if (!streams.length || streams.length > 2 ||
      streams.some(s => !['btcusdt@aggTrade', 'btcusdt@depth20@100ms'].includes(s))) return false;
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  return true;
}

module.exports = { attachRoutes, upgrade };
