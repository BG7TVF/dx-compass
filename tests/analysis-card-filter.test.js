'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../lib/analysis/paths.js');
const {
    hiddenReason, isBidirectionalWorkable, visiblePathRows
} = require('../public/shared/analysis/card-filter.mjs');

const NOW_SEC = Math.floor(Date.parse('2026-11-10T13:00:00Z') / 1000);

function direction(verdicts, available = true) {
    return {
        available,
        verdicts: verdicts || {CW: 'unworkable', SSB: 'unworkable'},
        margins: {CW: -8, SSB: -23}
    };
}

function card(aToB, bToA, region) {
    return {
        region: region || {dxcc: 339, country: 'Japan', prefix: 'JA'},
        band: '40m',
        directions: {aToB, bToA}
    };
}

test('同一模式双向可通才保留', () => {
    const both = direction({CW: 'workable', SSB: 'workable'});
    assert.equal(isBidirectionalWorkable(card(both, both)), true);
    assert.equal(hiddenReason(card(both, both)), null);
});

test('仅 CW 双向可通或仅 SSB 双向可通都保留', () => {
    const cwOnly = card(
        direction({CW: 'workable', SSB: 'unworkable'}),
        direction({CW: 'workable', SSB: 'unworkable'}));
    assert.equal(hiddenReason(cwOnly), null);
    const ssbOnly = card(
        direction({CW: 'unworkable', SSB: 'workable'}),
        direction({CW: 'unworkable', SSB: 'workable'}));
    assert.equal(hiddenReason(ssbOnly), null);
});

test('单向可通（另一侧同模式不通）隐藏并计入 marginal', () => {
    assert.equal(hiddenReason(card(
        direction({CW: 'workable', SSB: 'unworkable'}), direction())), 'marginal');
});

test('双向边缘计入 marginal', () => {
    const marginal = direction({CW: 'marginal', SSB: 'marginal'});
    assert.equal(hiddenReason(card(marginal, marginal)), 'marginal');
    // 一侧边缘、一侧不可通也归入 marginal（优先级高于 unworkable）。
    assert.equal(hiddenReason(card(marginal, direction())), 'marginal');
});

test('双向不可通计入 unworkable', () => {
    assert.equal(hiddenReason(card(direction(), direction())), 'unworkable');
});

test('任一侧无数据计入 no-data，available 必须为 true 才算可通', () => {
    const insufficient = direction({CW: 'unknown', SSB: 'unknown'}, false);
    assert.equal(hiddenReason(card(insufficient, direction())), 'no-data');
    assert.equal(hiddenReason(card(null, direction())), 'no-data');
    // 即使 verdict 写着 workable，available=false 也不能算可通。
    const claimed = direction({CW: 'workable', SSB: 'workable'}, false);
    assert.equal(isBidirectionalWorkable(card(claimed, claimed)), false);
    assert.equal(hiddenReason(card(claimed, claimed)), 'no-data');
});

test('三类分别计数且保持原有顺序', () => {
    const bothWorkable = direction({CW: 'workable', SSB: 'workable'});
    const soft = direction({CW: 'marginal', SSB: 'unworkable'});
    const off = direction({CW: 'unknown', SSB: 'unknown'}, false);
    const rows = [
        card(bothWorkable, bothWorkable, {dxcc: 291}),
        card(soft, soft, {dxcc: 224}),
        card(direction(), direction(), {dxcc: 339}),
        card(off, off, {dxcc: 110}),
        card(direction({CW: 'workable', SSB: 'unworkable'}),
            direction({CW: 'workable', SSB: 'unworkable'}), {dxcc: 318})
    ];
    const result = visiblePathRows(rows);
    assert.equal(result.hiddenMarginal, 1);
    assert.equal(result.hiddenUnworkable, 1);
    assert.equal(result.hiddenNoData, 1);
    assert.deepEqual(result.visible.map(item => item.region.dxcc), [291, 318]);
    assert.deepEqual(visiblePathRows(null),
        {visible: [], hiddenMarginal: 0, hiddenUnworkable: 0, hiddenNoData: 0});
});

/**
 * 同一份数据覆盖四类卡片：双向可通、边缘、双向不可通、双向无数据。
 */
function reportRows() {
    const rows = [];
    const add = (remoteDxcc, remoteCall, snr) => {
        ['N1AA', 'N2BB', 'N3CC'].forEach((call, i) => {
            ['12:00', '12:20'].forEach((clock, k) => {
                const time = `2026-11-10T${clock}:${String(10 + i + k).padStart(2, '0')}Z`;
                rows.push({
                    spot_call: remoteCall, de: call, band: '40m', snr,
                    comment: `PSKR FT8 ${snr} dB`, mode: 'DIGI', timestamp: time,
                    sender_grid: remoteDxcc === 339 ? 'PM95' : 'FN31',
                    receiver_grid: 'OL42' + call.slice(2),
                    dxcc_sender: remoteDxcc, dxcc_receiver: 318,
                    lat: 22, lon: 110, dx_lat: 35, dx_lon: 139
                });
                rows.push({
                    spot_call: call, de: remoteCall, band: '40m', snr,
                    comment: `PSKR FT8 ${snr} dB`, mode: 'DIGI', timestamp: time,
                    sender_grid: 'OL42' + call.slice(2),
                    receiver_grid: remoteDxcc === 339 ? 'PM95' : 'FN31',
                    dxcc_sender: 318, dxcc_receiver: remoteDxcc,
                    lat: 35, lon: 139, dx_lat: 22, dx_lon: 110
                });
            });
        });
    };
    add(339, 'JA1XX', -20);
    add(291, 'K1ABC', 10);
    add(224, 'F1XX', -10);
    rows.push({
        spot_call: 'KH6ZZ', de: 'N1AA', band: '40m', snr: -20,
        comment: 'PSKR FT8 -20 dB', mode: 'DIGI', timestamp: '2026-11-10T12:00:10Z',
        sender_grid: 'BL11', receiver_grid: 'OL42AA',
        dxcc_sender: 110, dxcc_receiver: 318,
        lat: 22, lon: 110, dx_lat: 21, dx_lon: 158
    });
    return paths.analyzePaths({
        myCall: 'BG7TV', myGrid: 'OL42ET', rows, now: NOW_SEC
    });
}

test('真实研判结果：白名单保留双向可通，其余三类分别计数，算法结果不受影响', () => {
    const report = reportRows();
    assert.equal(report.rows.length, 4);
    const weak = report.rows.find(item => item.region.dxcc === 339);
    const strong = report.rows.find(item => item.region.dxcc === 291);
    const soft = report.rows.find(item => item.region.dxcc === 224);
    const noData = report.rows.find(item => item.region.dxcc === 110);
    assert.equal(weak.directions.aToB.available, true);
    assert.equal(weak.directions.bToA.available, true);
    assert.equal(weak.modes.CW.lower, 'unworkable');
    assert.equal(weak.modes.SSB.lower, 'unworkable');
    assert.equal(strong.modes.CW.lower, 'workable');
    assert.equal(strong.modes.SSB.lower, 'workable');
    assert.equal(soft.modes.CW.lower, 'marginal');
    // 只有一条单方向报告：该方向现在也出结论（样本量标注在 samples/sparse），
    // 但另一方向完全没有数据，展示层仍归入 no-data。
    assert.equal(noData.directions.aToB.available, true);
    assert.equal(noData.directions.aToB.samples, 1);
    assert.equal(noData.evidence.level, 'single-direction');
    assert.equal(noData.directions.bToA, null);

    const filtered = visiblePathRows(report.rows);
    assert.equal(filtered.hiddenMarginal, 1);
    assert.equal(filtered.hiddenUnworkable, 1);
    assert.equal(filtered.hiddenNoData, 1);
    assert.deepEqual(filtered.visible.map(item => item.region.dxcc), [291]);
    // 展示层过滤不修改原始报告。
    assert.equal(report.rows.length, 4);
    assert.equal(report.observations.totalRows, 4);
});
