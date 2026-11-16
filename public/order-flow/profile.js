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

    return { visibleIndices, aggregate, replaceCells, notification };
});
