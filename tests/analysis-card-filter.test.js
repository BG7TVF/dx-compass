'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../lib/analysis/paths.js');
const {hiddenReason, visiblePathRows} = require('../public/shared/analysis/card-filter.mjs');

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

test('两个方向都不可通才隐藏', () => {
    assert.equal(hiddenReason(card(direction(), direction())), 'unworkable');
});

test('只要一侧是可通或边缘就保留', () => {
    assert.equal(hiddenReason(card(
        direction({CW: 'marginal', SSB: 'marginal'}), direction())), null);
    assert.equal(hiddenReason(card(
        direction(), direction({CW: 'workable', SSB: 'unworkable'}))), null);
});

test('两侧都不可用才隐藏，单侧有数据仍保留', () => {
    const insufficient = direction({CW: 'unknown', SSB: 'unknown'}, false);
    // 两侧都样本不足/无数据：隐藏，单独归为“无数据”。
    assert.equal(hiddenReason(card(insufficient, insufficient)), 'no-data');
    assert.equal(hiddenReason(card(null, null)), 'no-data');
    // 单侧有数据：即使是不可通，也保留用于呈现方向差异。
    assert.equal(hiddenReason(card(insufficient, direction())), null);
    assert.equal(hiddenReason(card(direction(), null)), null);
    assert.equal(hiddenReason(card(direction({CW: 'unknown', SSB: 'unworkable'}), direction())), null);
});

test('过滤保持原有顺序，两类隐藏分别计数', () => {
    const first = card(direction(), direction({CW: 'marginal', SSB: 'marginal'}), {dxcc: 291});
    const unworkable = card(direction(), direction(), {dxcc: 339});
    const noData = card(direction(null, false), direction(null, false), {dxcc: 110});
    const last = card(direction(), direction({CW: 'workable', SSB: 'workable'}), {dxcc: 318});
    const result = visiblePathRows([first, unworkable, noData, last]);
    assert.equal(result.hiddenUnworkable, 1);
    assert.equal(result.hiddenNoData, 1);
    assert.deepEqual(result.visible.map(item => item.region.dxcc), [291, 318]);
    assert.deepEqual(visiblePathRows(null),
        {visible: [], hiddenUnworkable: 0, hiddenNoData: 0});
});

/**
 * 同一份数据覆盖三种卡片：弱信号（双向不可通）、强信号（双向可通）、
 * 仅单方向一条报告（双向都不可用，归入无数据）。
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
    rows.push({
        spot_call: 'KH6ZZ', de: 'N1AA', band: '40m', snr: -10,
        comment: 'PSKR FT8 -10 dB', mode: 'DIGI', timestamp: '2026-11-10T12:00:10Z',
        sender_grid: 'BL11', receiver_grid: 'OL42AA',
        dxcc_sender: 110, dxcc_receiver: 318,
        lat: 22, lon: 110, dx_lat: 21, dx_lon: 158
    });
    return paths.analyzePaths({
        myCall: 'BG7TV', myGrid: 'OL42ET', rows, now: NOW_SEC
    });
}

test('真实研判结果：双向不可通与双向无数据分别隐藏并计数，算法结果不受影响', () => {
    const report = reportRows();
    assert.equal(report.rows.length, 3);
    const weak = report.rows.find(item => item.region.dxcc === 339);
    const strong = report.rows.find(item => item.region.dxcc === 291);
    const noData = report.rows.find(item => item.region.dxcc === 110);
    assert.equal(weak.directions.aToB.available, true);
    assert.equal(weak.directions.bToA.available, true);
    assert.equal(weak.modes.CW.lower, 'unworkable');
    assert.equal(weak.modes.SSB.lower, 'unworkable');
    assert.equal(strong.modes.CW.lower, 'workable');
    // 只有一条单方向报告：该方向样本不足，另一方向完全没有数据。
    assert.equal(noData.directions.aToB.available, false);
    assert.equal(noData.directions.bToA, null);

    const filtered = visiblePathRows(report.rows);
    assert.equal(filtered.hiddenUnworkable, 1);
    assert.equal(filtered.hiddenNoData, 1);
    assert.deepEqual(filtered.visible.map(item => item.region.dxcc), [291]);
    // 展示层过滤不修改原始报告。
    assert.equal(report.rows.length, 3);
    assert.equal(report.observations.totalRows, 3);
});
