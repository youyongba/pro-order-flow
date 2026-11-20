'use strict';

// detectBalance 单元测试：构造具有已知 OHLC 与 cells 的 bars，验证
// 1) 盘整识别（连续压缩 + 漂移约束）
// 2) vPOC/VAH/VAL 是否落在预期价格档位
// 3) 找不到 LVN 时是否回退到段内 high/low

const { test } = require('node:test');
const assert = require('node:assert/strict');
const OrderFlowProfile = require('../public/order-flow/profile');

// 构造单根 K 线：open/high/low/close 直接给定；cells 用 { price: totalVol } 简写，买卖各半。
function bar(open, high, low, close, cells) {
    const map = new Map();
    for (const [price, total] of Object.entries(cells || {})) {
        map.set(Number(price), { buyVol: total / 2, sellVol: total / 2 });
    }
    return { open, high, low, close, cells: map };
}

test('detectBalance: bars 数量不足时返回 null', () => {
    const bars = Array.from({ length: 5 }, () => bar(100, 101, 99, 100, { 100: 10 }));
    assert.equal(OrderFlowProfile.detectBalance(bars), null);
});

test('detectBalance: 全是大波幅趋势 K 线时返回 null', () => {
    // 每根 K 线高低跨度 20，远大于 ATR×1.5，不被视为压缩
    const bars = [];
    let price = 100;
    for (let i = 0; i < 30; i++) {
        bars.push(bar(price, price + 20, price, price + 20, { [price + 10]: 10 }));
        price += 20;
    }
    assert.equal(OrderFlowProfile.detectBalance(bars), null);
});

test('detectBalance: 识别最长连续压缩段并返回 vPOC', () => {
    const bars = [];
    // 前 20 根：100-101 窄幅震荡（压缩）
    for (let i = 0; i < 20; i++) {
        bars.push(bar(100, 101, 99.5, 100.5, { 100: 50, 100.5: 30 }));
    }
    // 后 10 根：大波幅趋势
    let p = 101;
    for (let i = 0; i < 10; i++) {
        bars.push(bar(p, p + 15, p, p + 15, { [p + 7]: 10 }));
        p += 15;
    }
    const result = OrderFlowProfile.detectBalance(bars);
    assert.ok(result, '应识别出前段盘整');
    assert.equal(result.startIdx, 0);
    assert.equal(result.endIdx, 19);
    assert.equal(result.length, 20);
    assert.equal(result.vpoc, 100, 'vPOC 应落在成交量最大的价格档');
});

test('detectBalance: VAH/VAL 落在 POC 上下最近的 LVN', () => {
    // 构造 VP：100 是 POC (vol=100)，101 是 HVN (vol=80)，102 是 LVN (vol=5)，103 是 HVN (vol=70)
    //          99 是 HVN (vol=80)，98 是 LVN (vol=5)，97 是 HVN (vol=60)
    // 期望：vah=102，val=98
    const cells = { 97: 60, 98: 5, 99: 80, 100: 100, 101: 80, 102: 5, 103: 70 };
    const bars = Array.from({ length: 20 }, () => bar(100, 103, 97, 100, cells));
    const result = OrderFlowProfile.detectBalance(bars, { minBars: 12 });
    assert.ok(result);
    assert.equal(result.vpoc, 100);
    assert.equal(result.vah, 102, 'VAH 应落在 POC 上方最近的 LVN');
    assert.equal(result.val, 98, 'VAL 应落在 POC 下方最近的 LVN');
});

test('detectBalance: 找不到 LVN 时回退到段内 high/low', () => {
    // VP 均匀分布，无 LVN
    const cells = { 99: 50, 100: 50, 101: 50 };
    const bars = Array.from({ length: 20 }, () => bar(100, 101, 99, 100, cells));
    const result = OrderFlowProfile.detectBalance(bars);
    assert.ok(result);
    assert.equal(result.vah, 101, 'VAH 应回退到段内最高价');
    assert.equal(result.val, 99, 'VAL 应回退到段内最低价');
});

test('detectBalance: 漂移过大时不识别为盘整', () => {
    // 单根 K 线都压缩（range=1），但整段从 100 漂到 130，超过 ATR×2
    const bars = [];
    for (let i = 0; i < 30; i++) {
        const base = 100 + i;
        bars.push(bar(base, base + 1, base, base + 1, { [base + 0.5]: 10 }));
    }
    assert.equal(OrderFlowProfile.detectBalance(bars), null);
});

test('detectBalance: 选择最长合法段而非首个合法段', () => {
    const bars = [];
    // 第 0-14 根：15 根压缩
    for (let i = 0; i < 15; i++) bars.push(bar(100, 101, 99, 100, { 100: 50 }));
    // 第 15-19 根：5 根大波幅
    let p = 101;
    for (let i = 0; i < 5; i++) { bars.push(bar(p, p + 20, p, p + 20, { [p + 10]: 10 })); p += 20; }
    // 第 20-49 根：30 根压缩（最长）
    for (let i = 0; i < 30; i++) bars.push(bar(200, 201, 199, 200, { 200: 80 }));
    const result = OrderFlowProfile.detectBalance(bars);
    assert.ok(result);
    assert.equal(result.startIdx, 20);
    assert.equal(result.endIdx, 49);
    assert.equal(result.length, 30);
    assert.equal(result.vpoc, 200);
});
