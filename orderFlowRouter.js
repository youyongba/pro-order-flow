'use strict';
const express = require('express');
const router = express.Router();
const orderFlowStore = require('./trading/orderFlowStore');
const { queryRange } = require('./trading/order-flow/archive');
const { HistoricalBackfill } = require('./trading/order-flow/backfill');
const backfill = new HistoricalBackfill(orderFlowStore.archive);
router.post('/orderflow/backfill', (req, res) => {
  const { startTime, endTime, clientId = null } = req.body || {};
  if (typeof startTime !== 'number' || typeof endTime !== 'number') {
    return res.status(400).json({ ok: false, error: 'startTime/endTime must be integer milliseconds' });
  }
  try {
    const job = backfill.enqueue(startTime, endTime, clientId);
    res.status(202).json({ ok: true, job });
  } catch (error) {
    res.status(error instanceof RangeError ? 400 : 429).json({ ok: false, error: error.message });
  }
});
router.get('/orderflow/backfill/:id', (req, res) => {
  const job = backfill.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: '回补任务不存在或服务已重启，请重新发起' });
  res.json({ ok: true, job });
});
router.get('/orderflow/history', (req, res) => {
  const tf = req.query.tf || '1m';
  const tfMap = {
    '1m': '1m', '5m': '5m', '15m': '15m', '60m': '1h', '1h': '1h', '4h': '4h', '1d': '1d'
  };
  const key = tfMap[tf];
  if (!key) return res.status(400).json({ ok: false, error: 'Unsupported timeframe' });
  const endTime = req.query.endTime === undefined ? Date.now() : Number(req.query.endTime);
  const limit = req.query.limit === undefined ? 150 : Number(req.query.limit);
  try {
    if ((req.query.endTime !== undefined && !/^\d+$/.test(req.query.endTime)) ||
        (req.query.limit !== undefined && !/^\d+$/.test(req.query.limit))) throw new Error();
    queryRange(key, endTime, limit);
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'Invalid endTime or limit (1..150)' });
  }
  try {
    res.json({
      ok: true,
      data: orderFlowStore.getHistory(key, endTime, limit),
      archive: orderFlowStore.archive.status(),
      largeOrders: orderFlowStore.largeOrders,
      largeOrderStats: orderFlowStore.largeOrderStats
    });
  } catch (error) {
    console.error('[orderFlow] Archive query failed:', error.message);
    res.status(503).json({ ok: false, error: 'Order-flow archive unavailable' });
  }
});

// ============ POST /notify-profile ============
// 前端 pro_order_flow 检测到 VAH/VAL/vPOC 变化时，推送到飞书
const webhook = require('./notifier/feishuWebhook');
router.post('/notify-profile', express.json(), (req, res) => {
  const { tf, vpoc, vah, val, symbol } = req.body;
  if (!tf || !vpoc || !vah || !val) {
    return res.status(400).json({ ok: false, error: 'Missing parameters' });
  }

  let title = `📊 ${symbol || 'BTCUSDT'} ${tf} 周期 Volume Profile 变动`;
  let interpretation = '价值区域代表了 70% 成交量聚集的区间，vPOC 为流动性最密集的吸筹/派发中心。';

  // 针对 15m 周期进行高亮强化，契合狙击手流动性猎杀策略
  if (tf === '15m') {
    title = `🚨 [重点关注] ${symbol || 'BTCUSDT'} 15m 主力筹码区转移`;
    interpretation = '🔥 15分钟级别是寻找流动性猎杀 (Liquidation Hunt) 的核心周期！请结合 15m RSI 极值，在 VAH/VAL 边缘寻找「假突破+吸收」的反转狙击机会！';
  }

  webhook.sendRich(title, [
    [{ text: '🎯 控制价位 (vPOC)：', bold: true }, { text: String(vpoc) }],
    [{ text: '📈 价值区高点 (VAH)：', bold: true }, { text: String(vah) }],
    [{ text: '📉 价值区低点 (VAL)：', bold: true }, { text: String(val) }],
    [{ text: '💡 解读：', bold: true }, { text: interpretation }],
    [{ text: `⏰ ${new Date().toLocaleString()}`, italic: true }]
  ]);

  res.json({ ok: true });
});

// ============ POST /notify-delta ============
// 前端 pro_order_flow 在 1m 图上看到单根 Delta 越过 ±50 时推飞书
// (页面用现货 aggTrade, 后台 store 用合约, 两边 Delta 可能不一致; 此接口保证「你看见的」能推到)
router.post('/notify-delta', express.json(), (req, res) => {
  const { tf, delta, direction, startTime, symbol } = req.body || {};
  const dir = direction === 'short' ? 'short' : direction === 'long' ? 'long' : null;
  const d = Number(delta);
  if (!dir || !Number.isFinite(d)) {
    return res.status(400).json({ ok: false, error: 'direction must be long|short, delta must be a number' });
  }
  const min = orderFlowStore.DELTA_ALERT_MIN || 50;
  if (dir === 'long' && d < min) return res.json({ ok: false, skipped: 'below_threshold' });
  if (dir === 'short' && d > -min) return res.json({ ok: false, skipped: 'below_threshold' });
  const r = orderFlowStore.trySendDeltaAlert({
    tf: tf || '1m',
    direction: dir,
    delta: d,
    startTime: Number(startTime) || Date.now(),
    symbol: symbol || 'BTCUSDT',
    source: 'pro_order_flow',
  });
  res.json({ ok: r.ok !== false, ...r });
});


module.exports = router;
