'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../lib/advice/service.js');

const NOW = new Date('2026-11-08T12:00:00.000Z');
const SETTINGS = {
    category: 'SO1R',
    grid: 'EM12',
    contestName: 'CQ WW DX CW',
    contestStart: '2026-11-08T00:00',
    contestEnd: '2026-11-09T00:00',
    multPerBand: true,
    multMode: 'dxcc-per-band',
    txPowerW: 100,
    adviceMinConfidence: 'low'
};
const PROP = {
    sfi: {list: [['t', 150]]},
    ssn: {list: [['t', 80]]},
    kp: {list: [['t', 2]]},
    a: {list: [['t', 8]]},
    scales: {s: 0, r: 0}
};

function rows() {
    return [
        {kind: 'band', band: '20', qsos: 200, points: 600, mults: 40,
            first_ts: '2026-11-08T06:00:00.000Z', last_ts: '2026-11-08T12:00:00.000Z'},
        {kind: 'band', band: '40', qsos: 60, points: 180, mults: 30,
            first_ts: '2026-11-08T00:00:00.000Z', last_ts: '2026-11-08T05:00:00.000Z'},
        {kind: 'bucket', band: '20', bucket: '2026-11-08T11:50', qsos: 3, points: 9},
        {kind: 'bucket', band: '20', bucket: '2026-11-08T12:00', qsos: 3, points: 9},
        {kind: 'bucket', band: '40', bucket: '2026-11-08T12:00', qsos: 2, points: 200}
    ];
}

test('无 QSO 数据时返回降级状态而不是报错', () => {
    const prepared = service.prepare({}, SETTINGS, NOW);
    assert.equal(prepared.ok, true);
    assert.match(prepared.sql, /FROM qsos/);
    assert.match(prepared.sql, /band_activity/);
    const result = service.complete(prepared, []);
    assert.equal(result.ok, true);
    assert.equal(result.degraded, 'no-qsos');
    assert.deepEqual(result.advice, []);
});

test('给定聚合行与电台状态时能算出真实建议', () => {
    const prepared = service.prepare({}, SETTINGS, NOW);
    const result = service.complete(prepared, rows(), {
        prop: PROP,
        radio: {freqKhz: 14025, mode: 'CW', isRunning: true},
        score: {qsos: 260}
    });
    assert.equal(result.degraded, null);
    assert.equal(result.currentBand, '20');
    const ids = result.advice.map(item => item.id);
    assert.ok(ids.includes('R1'), ids.join(','));
    assert.ok(ids.includes('S1'), ids.join(','));
    assert.equal(typeof result.environment.ap, 'number');
});

test('缺少 VFO 时规则整体仍可计算，只降级依赖项', () => {
    const prepared = service.prepare({}, SETTINGS, NOW);
    const result = service.complete(prepared, rows(), {prop: PROP, radio: {}});
    assert.equal(result.ok, true);
    assert.equal(result.dependencies.radio, false);
    assert.ok(result.advice.length > 0);
});
