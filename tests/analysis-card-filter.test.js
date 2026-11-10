'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../lib/analysis/paths.js');
const {isUnworkableCard, visiblePathRows} = require('../public/shared/analysis/card-filter.mjs');

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
    assert.equal(isUnworkableCard(card(direction(), direction())), true);
});

test('只要一侧是可通或边缘就保留', () => {
    assert.equal(isUnworkableCard(card(
        direction({CW: 'marginal', SSB: 'marginal'}), direction())), false);
    assert.equal(isUnworkableCard(card(
        direction(), direction({CW: 'workable', SSB: 'unworkable'}))), false);
});

test('某方向样本不足或无法判定时保留，不能被误隐藏', () => {
    const insufficient = direction({CW: 'unknown', SSB: 'unknown'}, false);
    assert.equal(isUnworkableCard(card(insufficient, direction())), false);
    assert.equal(isUnworkableCard(card(direction(), null)), false);
    assert.equal(isUnworkableCard(card(direction(), direction({CW: 'unknown', SSB: 'unworkable'}))), false);
});

test('过滤保持原有顺序，只返回被隐藏的数量', () => {
    const first = card(direction(), direction({CW: 'marginal', SSB: 'marginal'}), {dxcc: 291});
    const hidden = card(direction(), direction(), {dxcc: 339});
    const last = card(direction(), direction({CW: 'workable', SSB: 'workable'}), {dxcc: 318});
    const result = visiblePathRows([first, hidden, last]);
    assert.equal(result.hidden, 1);
    assert.deepEqual(result.visible.map(item => item.region.dxcc), [291, 318]);
    assert.deepEqual(visiblePathRows(null), {visible: [], hidden: 0});
});

/** 弱信号（双向全不可通）与强信号（双向可通）各一个区域，用于核对过滤前后卡片数。 */
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
    return paths.analyzePaths({
        myCall: 'BG7TV', myGrid: 'OL42ET', rows, now: NOW_SEC
    });
}

test('真实研判结果：双向不可通区域被隐藏，算法结果本身不受影响', () => {
    const report = reportRows();
    assert.equal(report.rows.length, 2);
    const weak = report.rows.find(item => item.region.dxcc === 339);
    const strong = report.rows.find(item => item.region.dxcc === 291);
    assert.equal(weak.directions.aToB.available, true);
    assert.equal(weak.directions.bToA.available, true);
    assert.equal(weak.modes.CW.lower, 'unworkable');
    assert.equal(weak.modes.SSB.lower, 'unworkable');
    assert.equal(strong.modes.CW.lower, 'workable');

    const filtered = visiblePathRows(report.rows);
    assert.equal(filtered.hidden, 1);
    assert.deepEqual(filtered.visible.map(item => item.region.dxcc), [291]);
    // 展示层过滤不修改原始报告。
    assert.equal(report.rows.length, 2);
    assert.equal(report.observations.totalRows, 2);
});
