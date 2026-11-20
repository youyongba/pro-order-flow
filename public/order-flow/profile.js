(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OrderFlowProfile = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function visibleIndices(length, width, offsetX, candleWidth) {
        const anchor = width - 300 + offsetX;
        const first = Math.max(0, Math.ceil(length - 1 + (-candleWidth / 2 - anchor) / candleWidth));
        const last = Math.min(length - 1,
            Math.floor(length - 1 + (width - 75 + candleWidth / 2 - anchor) / candleWidth));
        return first > last ? [0, 0] : [first, last + 1];
    }

    function aggregate(bars) {
        const profile = new Map();
        for (const bar of bars) {
            for (const [price, cell] of bar.cells) {
                const value = profile.get(price) || { buy: 0, sell: 0, total: 0 };
                value.buy += cell.buyVol;
                value.sell += cell.sellVol;
                value.total += cell.buyVol + cell.sellVol;
                profile.set(price, value);
            }
        }
        return profile;
    }

    function replaceCells(bar, snapshot, Cell) {
        bar.cells.clear();
        for (const [price, value] of Object.entries(snapshot.cells)) {
            const cell = new Cell(Number(price));
            cell.buyVol = value.buyVol;
            cell.sellVol = value.sellVol;
            bar.cells.set(Number(price), cell);
        }
        bar.coverage = snapshot.coverage || 'missing';
    }

    // Changes in viewport establish a baseline, never a market notification.
    function notification(previous, range, value, enabled) {
        return {
            range: enabled ? range : null,
            value,
            send: !!(enabled && previous?.range === range && previous.value !== value),
        };
    }

    /**
     * 识别可见 bars 中最长的一段"盘整区间"，并返回该区间的 vPOC / VAH / VAL。
     *
     * 算法：
     * 1) ATR 压缩判定：单根 K 线真实波幅 <= ATR × compressFactor 视为压缩。
     * 2) 连续压缩 + 整段漂移约束：连续压缩段长度 >= minBars，且整段首尾价差 <= ATR × driftFactor，
     *    取最长的合法段作为盘整区间。
     * 3) 在该区间内聚合 Volume Profile，取 vPOC。
     * 4) 自 vPOC 向上 / 向下扫描 LVN（邻域均量 × lvnFactor 以下的低谷），首个 LVN 即 VAH / VAL；
     *    找不到 LVN 时回退到该段 K 线的最高价 / 最低价。
     *
     * 未识别到盘整时返回 null，由调用方决定是否回退到旧的 70% 价值区算法。
     *
     * @param {Array} bars 可见 K 线（按时间升序），需含 high/low/open/close 及 cells: Map<price, {buyVol, sellVol}>。
     * @param {Object} [options] 算法参数。
     * @returns {null | { vah:number, val:number, vpoc:number, startIdx:number, endIdx:number, length:number }}
     */
    function detectBalance(bars, options) {
        const opt = Object.assign({
            minBars: 12,          // 连续盘整至少需要的 K 线数量
            atrPeriod: 14,        // ATR 周期（SMA）
            compressFactor: 1.5,  // 单根 K 线 TR <= ATR × factor 视为压缩
            driftFactor: 2.0,     // 整段累计漂移 <= ATR × factor 视为无方向
            lvnFactor: 0.5,       // LVN 判定：柱子量 <= 邻域均量 × factor
            neighborhood: 2,      // 邻域半径（左右各取 N 档）
        }, options || {});

        if (!Array.isArray(bars) || bars.length < opt.minBars) return null;

        // 1. 计算 TR 与 ATR（SMA）
        const trs = new Array(bars.length);
        for (let i = 0; i < bars.length; i++) {
            const b = bars[i];
            const prevClose = i > 0 ? bars[i - 1].close : b.open;
            trs[i] = Math.max(
                b.high - b.low,
                Math.abs(b.high - prevClose),
                Math.abs(b.low - prevClose),
            );
        }
        const atrs = trs.map((_, i) => {
            const start = Math.max(0, i - opt.atrPeriod + 1);
            let sum = 0;
            for (let k = start; k <= i; k++) sum += trs[k];
            return sum / (i - start + 1) || 0;
        });

        // 2. 单根压缩标记
        const compressed = bars.map((b, i) => {
            const atr = atrs[i];
            if (atr <= 0) return false;
            return (b.high - b.low) <= atr * opt.compressFactor;
        });

        // 3. 找最长合法连续压缩段
        let best = null;
        let i = 0;
        while (i < bars.length) {
            if (!compressed[i]) { i++; continue; }
            let j = i;
            while (j + 1 < bars.length && compressed[j + 1]) j++;
            const len = j - i + 1;
            if (len >= opt.minBars) {
                const drift = Math.abs(bars[j].close - bars[i].open);
                let atrSum = 0;
                for (let k = i; k <= j; k++) atrSum += atrs[k];
                const avgAtr = atrSum / len;
                if (avgAtr > 0 && drift <= avgAtr * opt.driftFactor) {
                    if (!best || len > best.length) best = { startIdx: i, endIdx: j, length: len };
                }
            }
            i = j + 1;
        }
        if (!best) return null;

        // 4. 段内聚合 VP，定位 vPOC
        const segment = bars.slice(best.startIdx, best.endIdx + 1);
        const profile = aggregate(segment);
        if (profile.size === 0) return null;

        const levels = [];
        let vpoc = null;
        let maxVol = -1;
        profile.forEach((v, price) => {
            levels.push({ price, vol: v.total });
            if (v.total > maxVol) { maxVol = v.total; vpoc = price; }
        });
        levels.sort((a, b) => a.price - b.price);
        const vpocIdx = levels.findIndex(l => l.price === vpoc);
        if (vpocIdx < 0) return null;

        // 5. 邻域均量（含自身，左右各 opt.neighborhood 档）
        const neighborAvg = (idx) => {
            let sum = 0;
            let count = 0;
            for (let k = -opt.neighborhood; k <= opt.neighborhood; k++) {
                const t = idx + k;
                if (t >= 0 && t < levels.length) { sum += levels[t].vol; count++; }
            }
            return count ? sum / count : 0;
        };

        // 6. 自 vPOC 向上 / 向下找最近 LVN
        let vah = null;
        for (let k = vpocIdx + 1; k < levels.length; k++) {
            if (levels[k].vol <= neighborAvg(k) * opt.lvnFactor) { vah = levels[k].price; break; }
        }
        let val = null;
        for (let k = vpocIdx - 1; k >= 0; k--) {
            if (levels[k].vol <= neighborAvg(k) * opt.lvnFactor) { val = levels[k].price; break; }
        }

        // 7. 找不到 LVN 时回退到段内最高 / 最低价
        if (vah === null) vah = Math.max.apply(null, segment.map(b => b.high));
        if (val === null) val = Math.min.apply(null, segment.map(b => b.low));

        return {
            vah, val, vpoc,
            startIdx: best.startIdx,
            endIdx: best.endIdx,
            length: best.length,
        };
    }

    return { visibleIndices, aggregate, replaceCells, notification, detectBalance };
});
