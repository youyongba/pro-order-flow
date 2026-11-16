'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { EventEmitter } = require('events');
const { OrderFlowArchive } = require('../trading/order-flow/archive');
const OrderFlowProfile = require('../public/order-flow/profile');

test('行情 REST 使用配置的超时，拒绝非法超时', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../marketGateway.js'), 'utf8');
  function load(value) {
    const requests = [];
    const context = {
      module: { exports: {} },
      process: { env: value === undefined ? {} : { BINANCE_TIMEOUT_MS: value } },
      require: name => {
        if (name === 'axios') return { get: async (url, options) => {
          requests.push(options);
          return { data: [] };
        } };
        if (name === 'ws') return { Server: EventEmitter };
        if (name === './lib/httpAgents') return {};
        if (name === './lib/runtime') return { insideRoot: file => file };
        return require(name);
      },
    };
    vm.runInNewContext(source, context);
    return { gateway: context.module.exports, requests };
  }
  for (const [value, expected] of [[undefined, 10000], ['2500', 2500]]) {
    const { gateway, requests } = load(value);
    const routes = new Map();
    gateway.attachRoutes({ get: (url, handler) => routes.set(url, handler), post() {} });
    for (const endpoint of ['klines', 'depth']) {
      await routes.get('/api/proxy/' + endpoint)({ query: {} }, { json() {} });
    }
    assert.equal(requests.length, 2);
    for (const options of requests) assert.equal(options.timeout, expected);
  }
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5']) {
    assert.throws(() => load(value), /BINANCE_TIMEOUT_MS must be a positive integer/);
  }
});

test('六个订单流周期独立聚合真实tick，非法成交不进入统计', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orderflow-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sockets = [];
  class Socket extends EventEmitter {
    constructor(url) { super(); sockets.push(url); }
  }
  const context = {
    module: { exports: {} }, process: { env: {}, once() {} }, console, setInterval: () => ({ unref() {} }),
    setTimeout: () => ({ unref() {} }), clearInterval() {},
    require: name => name === 'ws' ? Socket : name === '../notifier/feishuWebhook'
      ? { sendRich: async () => ({ ok: true }) } : name === './order-flow/archive'
        ? { OrderFlowArchive } : name === '../lib/runtime'
          ? { insideRoot: () => path.join(dir, 'archive.sqlite') } : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../trading/orderFlowStore.js'), 'utf8'), context);
  const store = context.module.exports;
  t.after(() => store.archive.close());
  assert.match(sockets[0], /^wss:\/\/stream\.binance\.com:9443\/stream/);
  const T = 1700000000000;
  store._onTick({ ts: T, raw: { a: 1, p: '60001', q: '2', m: false, T } });
  store._onTick({ ts: T, raw: { a: 2, p: '60001', q: '0.5', m: true, T } });
  store._onTick({ ts: T, raw: { a: 3, p: 'NaN', q: '1', m: false, T } });
  for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
    const bars = store.getHistory(tf, T, 1);
    assert.equal(bars.length, 1, tf);
    assert.equal(bars[0].totalDelta, 1.5, tf);
    assert.equal(bars[0].cells[60000].buyVol, 2, tf);
  }
});

test('缺失足迹不随机伪造，仍使用K线真实买卖量计算Delta', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/pro_order_flow.html'), 'utf8');
  assert.equal(html.includes('Math.random()'), false);
  const classes = html.slice(html.indexOf('class FPCell'), html.indexOf('let ws ='));
  const build = html.slice(html.indexOf('function buildHistoricalFootprint('), html.indexOf('let isLoadingMoreHistory'));
  const context = { OrderFlowProfile, STATE: { currentPrice: 100, footprints: [], globalVolumeProfile: new Map() },
    CONFIG: { tickSize: 10, imbalanceRatio: 3 } };
  vm.runInNewContext(classes + '\n' + build + '\nthis.build = buildHistoricalFootprint;', context);
  context.build([[1700000000000, '100', '110', '90', '105', '10', 0, 0, 0, '7']]);
  assert.equal(context.STATE.footprints[0].cells.size, 0);
  assert.equal(context.STATE.globalVolumeProfile.size, 0);
  assert.equal(context.STATE.footprints[0].totalDelta, 4);
  context.STATE.footprints[0].addTick(106, 1, false);
  assert.equal(context.STATE.footprints[0].totalDelta, 5);
  assert.equal(context.STATE.footprints[0].cells.get(100).buyVol, 1);
});
