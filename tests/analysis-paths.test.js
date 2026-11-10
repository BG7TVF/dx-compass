'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {largeGridFrom} = require('../lib/radio/maidenhead.js');
const paths = require('../lib/analysis/paths.js');
const pathService = require('../lib/analysis/path-service.js');

const BASE = {
    myCall: 'BG7TV',
    myGrid: 'OL42ET',
    monitored: ['K1ABC'],
    windowMinutes: 15
};

function row(overrides) {
    return Object.assign({
        spot_call: 'R1XX',
        de: 'N1AA',
        band: '20m',
        snr: -5,
        comment: 'PSKR FT8 -5 dB',
        mode: 'DIGI',
        timestamp: '2026-11-10T12:00:00Z',
        sender_grid: 'JO22',
        receiver_grid: 'OL42AA',
        dxcc_sender: 230,
        dxcc_receiver: 224,
        lat: 52.0,
        lon: 5.0,
        dx_lat: 52.5,
        dx_lon: 4.9
    }, overrides || {});
}

/** A→B：远方台发射、本地邻近台接收。 */
function aToB(snr, receiver, receiverGrid, time, extra) {
    return row(Object.assign({
        spot_call: 'R1XX', de: receiver, snr,
        sender_grid: 'JO22', receiver_grid: receiverGrid,
        timestamp: time || '2026-11-10T12:00:00Z',
        dxcc_sender: 230, dxcc_receiver: 224
    }, extra || {}));
}

/** B→A：本地邻近台发射、远方台接收。 */
function bToA(snr, sender, senderGrid, time, extra) {
    return row(Object.assign({
        spot_call: sender, de: 'R1XX', snr,
        sender_grid: senderGrid, receiver_grid: 'JO22',
        timestamp: time || '2026-11-10T12:00:00Z',
        dxcc_sender: 224, dxcc_receiver: 230
    }, extra || {}));
}

function baseRows() {
    return [
        aToB(-4, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-6, 'N1AA', 'OL42AA', '2026-11-10T12:20:10Z'),
        aToB(-3, 'N2BB', 'OL42BB', '2026-11-10T12:01:10Z'),
        aToB(-5, 'N2BB', 'OL42BB', '2026-11-10T12:21:10Z'),
        aToB(-7, 'N3CC', 'OL42CC', '2026-11-10T12:02:10Z'),
        aToB(-5, 'N3CC', 'OL42CC', '2026-11-10T12:22:10Z'),
        bToA(4, 'N1AA', 'OL42AA', '2026-11-10T12:03:10Z'),
        bToA(6, 'N1AA', 'OL42AA', '2026-11-10T12:23:10Z'),
        bToA(3, 'N2BB', 'OL42BB', '2026-11-10T12:04:10Z'),
        bToA(5, 'N2BB', 'OL42BB', '2026-11-10T12:24:10Z'),
        bToA(7, 'N3CC', 'OL42CC', '2026-11-10T12:05:10Z'),
        bToA(5, 'N3CC', 'OL42CC', '2026-11-10T12:25:10Z')
    ];
}

function analyze(rows, extra) {
    return paths.analyzePaths(Object.assign({}, BASE, {rows}, extra || {}));
}

test('largeGridFrom: 6→4, 4 原样, 非法退回空', () => {
    assert.equal(largeGridFrom('OL42ET'), 'OL42');
    assert.equal(largeGridFrom('ol42et'), 'OL42');
    assert.equal(largeGridFrom('OL42'), 'OL42');
    assert.equal(largeGridFrom(' OL42 '), 'OL42');
    assert.equal(largeGridFrom('OL4'), '');
    assert.equal(largeGridFrom('OL42E'), '');
    assert.equal(largeGridFrom('XX42ET'), '');
    assert.equal(largeGridFrom(''), '');
    assert.equal(largeGridFrom(null), '');
});

test('缺少呼号或网格直接报错，不产出任何结论', () => {
    assert.equal(paths.analyzePaths({rows: [], myCall: '', myGrid: 'OL42ET'}).error, 'call-required');
    assert.equal(paths.analyzePaths({rows: [], myCall: 'BG7TV', myGrid: 'bad'}).error, 'grid-required');
});

test('不做 50 Hz→2500 Hz 的 -17 dB 换算，余量按 2500 Hz 基准直接相加', () => {
    const report = analyze(baseRows());
    const a = report.rows[0].directions.aToB;
    assert.equal(a.snrDb, -5);
    assert.equal(a.margins.CW, 4);
    assert.equal(a.margins.SSB, -11);
    assert.notEqual(a.margins.CW, 4 + 17);
    assert.equal(report.snrReferenceHz, 2500);
    assert.equal(report.bandwidthConversion, 'none');
});

test('双向分别计算，不合并成单一中位数', () => {
    const report = analyze(baseRows());
    const directions = report.rows[0].directions;
    assert.equal(directions.aToB.snrDb, -5);
    assert.equal(directions.bToA.snrDb, 4.5);
    assert.equal(directions.aToB.samples, 6);
    assert.equal(directions.bToA.samples, 6);
});

test('跨接收站不直接比绝对值：中位数 = 各接收站中位数的中位数', () => {
    const rows = [
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:10:10Z'),
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:20:10Z'),
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:30:10Z'),
        aToB(-10, 'N2BB', 'OL42BB', '2026-11-10T12:00:20Z'),
        aToB(-30, 'N3CC', 'OL42CC', '2026-11-10T12:00:30Z')
    ];
    const a = analyze(rows).rows[0].directions.aToB;
    assert.equal(a.stations, 3);
    assert.equal(a.snrDb, -10);
    assert.notEqual(a.snrDb, -2);
});

test('窗口先取中位再向上汇总，不把窗口内的点混成一个池', () => {
    const rows = [
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:01:10Z'),
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:02:10Z'),
        aToB(-20, 'N1AA', 'OL42AA', '2026-11-10T12:20:10Z'),
        aToB(-4, 'N2BB', 'OL42BB', '2026-11-10T12:00:20Z'),
        aToB(-4, 'N2BB', 'OL42BB', '2026-11-10T12:01:20Z'),
        aToB(-4, 'N2BB', 'OL42BB', '2026-11-10T12:02:20Z'),
        aToB(-22, 'N2BB', 'OL42BB', '2026-11-10T12:20:20Z'),
        aToB(-6, 'N3CC', 'OL42CC', '2026-11-10T12:00:30Z'),
        aToB(-6, 'N3CC', 'OL42CC', '2026-11-10T12:01:30Z'),
        aToB(-6, 'N3CC', 'OL42CC', '2026-11-10T12:02:30Z'),
        aToB(-24, 'N3CC', 'OL42CC', '2026-11-10T12:20:30Z')
    ];
    const a = analyze(rows).rows[0].directions.aToB;
    assert.equal(a.windows, 2);
    assert.equal(a.snrDb, -13);
});

test('功率归一到 100 W：500 W 是 -7 dB，方向不能反', () => {
    assert.ok(Math.abs(paths.normalizeTo100(-3, 500) - (-9.99)) < 0.01);
    assert.ok(Math.abs(paths.normalizeTo100(-3, 50) - 0.01) < 0.01);
    const report = analyze(baseRows(), {txPowerOverrides: 'N1AA=500, N2BB=500, N3CC=500'});
    const directions = report.rows[0].directions;
    assert.equal(directions.aToB.powerCorrected, false);
    assert.equal(directions.bToA.powerCorrected, true);
    assert.ok(directions.bToA.snrDb < 0, '500 W 必须把电平压低，不能抬高');
    assert.equal(directions.bToA.snrDb, -2.5);
});

test('双向不一致时以较差方向为下限并按较差方向建议', () => {
    const rows = [
        aToB(-5, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-5, 'N1AA', 'OL42AA', '2026-11-10T12:20:10Z'),
        aToB(-5, 'N2BB', 'OL42BB', '2026-11-10T12:01:10Z'),
        aToB(-5, 'N2BB', 'OL42BB', '2026-11-10T12:21:10Z'),
        aToB(-5, 'N3CC', 'OL42CC', '2026-11-10T12:02:10Z'),
        aToB(-5, 'N3CC', 'OL42CC', '2026-11-10T12:22:10Z'),
        bToA(5, 'N1AA', 'OL42AA', '2026-11-10T12:03:10Z'),
        bToA(5, 'N1AA', 'OL42AA', '2026-11-10T12:23:10Z'),
        bToA(5, 'N2BB', 'OL42BB', '2026-11-10T12:04:10Z'),
        bToA(5, 'N2BB', 'OL42BB', '2026-11-10T12:24:10Z'),
        bToA(5, 'N3CC', 'OL42CC', '2026-11-10T12:05:10Z'),
        bToA(5, 'N3CC', 'OL42CC', '2026-11-10T12:25:10Z')
    ];
    const summary = analyze(rows).rows[0].modes.SSB;
    assert.equal(summary.aToB, 'unworkable');
    assert.equal(summary.bToA, 'marginal');
    assert.equal(summary.upper, 'marginal');
    assert.equal(summary.lower, 'unworkable');
    assert.equal(summary.advice, 'unworkable');
});

test('本台报告混入后区域中位数不变，且标记未计入', () => {
    const base = analyze(baseRows()).rows[0].directions.aToB;
    const selfRows = [
        row({spot_call: 'R9ZZ', de: 'BG7TV', snr: 40, receiver_grid: 'OL42ET',
            timestamp: '2026-11-10T12:06:10Z'}),
        row({spot_call: 'R9ZZ', de: 'BG7TV', snr: -40, receiver_grid: 'OL42ET',
            timestamp: '2026-11-10T12:26:10Z'})
    ];
    const report = analyze(baseRows().concat(selfRows));
    const rowOut = report.rows[0];
    assert.equal(rowOut.directions.aToB.snrDb, base.snrDb);
    assert.equal(rowOut.directions.aToB.samples, base.samples);
    assert.equal(rowOut.self.aToB.samples, 2);
    assert.equal(rowOut.self.aToB.includedInMedian, false);
    assert.equal(report.observations.excluded.selfReference, 2);
    assert.ok(!report.local.neighbors.includes('BG7TV'));
});

test('本地邻近台不足时输出样本不足，不退回用本台数据凑', () => {
    const rows = [
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-3, 'N1AA', 'OL42AA', '2026-11-10T12:01:10Z'),
        aToB(-4, 'N1AA', 'OL42AA', '2026-11-10T12:02:10Z'),
        aToB(-5, 'N1AA', 'OL42AA', '2026-11-10T12:03:10Z'),
        aToB(-6, 'N1AA', 'OL42AA', '2026-11-10T12:04:10Z'),
        row({de: 'BG7TV', receiver_grid: 'OL42ET', snr: 30,
            timestamp: '2026-11-10T12:05:10Z'})
    ];
    const report = analyze(rows);
    const rowOut = report.rows[0];
    assert.equal(rowOut.directions.aToB.available, false);
    assert.equal(rowOut.directions.aToB.insufficient, true);
    assert.equal(rowOut.directions.aToB.reason, 'too-few-stations');
    assert.equal(rowOut.directions.aToB.stations, 1);
    assert.equal(rowOut.confidence.level, 'low');
    assert.ok(rowOut.confidence.notes.includes('a-to-b-insufficient'));
    assert.equal(rowOut.self.aToB.samples, 1);
});

test('报告少于 5 条同样判样本不足', () => {
    const rows = [
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-3, 'N2BB', 'OL42BB', '2026-11-10T12:01:10Z'),
        aToB(-4, 'N3CC', 'OL42CC', '2026-11-10T12:02:10Z')
    ];
    const a = analyze(rows).rows[0].directions.aToB;
    assert.equal(a.available, false);
    assert.equal(a.reason, 'too-few-reports');
    assert.equal(a.samples, 3);
});

test('目标区域按 DXCC 优先、缺 DXCC 时退回 4 位网格前缀', () => {
    const rows = [
        aToB(-5, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z', {dxcc_sender: 291}),
        aToB(-5, 'N2BB', 'OL42BB', '2026-11-10T12:01:10Z', {dxcc_sender: 291}),
        aToB(-5, 'N3CC', 'OL42CC', '2026-11-10T12:02:10Z', {dxcc_sender: 291}),
        aToB(-6, 'N1AA', 'OL42AA', '2026-11-10T12:03:10Z',
            {dxcc_sender: null, sender_grid: 'JO22'}),
        aToB(-6, 'N2BB', 'OL42BB', '2026-11-10T12:04:10Z',
            {dxcc_sender: null, sender_grid: 'JO22'}),
        aToB(-6, 'N3CC', 'OL42CC', '2026-11-10T12:05:10Z',
            {dxcc_sender: null, sender_grid: 'JO22'})
    ];
    const keys = analyze(rows).rows.map(item => item.region.key).sort();
    assert.deepEqual(keys, ['dxcc:291', 'grid:JO22']);
});

test('对手落在远方时按实际位置归类，并打上对手标记', () => {
    const rows = [
        aToB(-5, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z', {spot_call: 'K1ABC'}),
        aToB(-5, 'N2BB', 'OL42BB', '2026-11-10T12:01:10Z', {spot_call: 'K1ABC'}),
        aToB(-5, 'N3CC', 'OL42CC', '2026-11-10T12:02:10Z', {spot_call: 'K1ABC'})
    ];
    const rowOut = analyze(rows).rows[0];
    assert.equal(rowOut.region.key, 'dxcc:230');
    assert.deepEqual(rowOut.opponents, ['K1ABC']);
});

test('被排除的点分别计数：非 FT8、无 SNR、无时间、同侧、本台参考', () => {
    const rows = [
        row({comment: 'CW 599', mode: 'CW'}),
        row({snr: null}),
        row({timestamp: 'not-a-time'}),
        row({spot_call: 'N1AA', de: 'N2BB', sender_grid: 'OL42AA', receiver_grid: 'OL42BB'}),
        aToB(-5, 'R2YY', 'JO22', '2026-11-10T12:01:10Z', {sender_grid: 'JO22'}),
        row({de: 'BG7TV', receiver_grid: 'OL42ET'})
    ];
    const report = analyze(rows);
    const excluded = report.observations.excluded;
    assert.equal(excluded.notFt8, 1);
    assert.equal(excluded.noSnr, 1);
    assert.equal(excluded.noTime, 1);
    assert.equal(excluded.outOfScope, 2);
    assert.equal(excluded.selfReference, 1);
});

class Ctx {
    constructor(values) { this.values = values; }
    get(key) { return this.values[key]; }
}

test('path-service 从设置取身份与窗口，缺设置时返回明确错误', () => {
    const global = new Ctx({
        uiSettings: {myCall: 'BG7TV', grid: 'OL42ET', pskWindowMin: '30', txPowerW: 100},
        monitoredCalls: ['K1ABC']
    });
    const prepared = pathService.prepare({}, global);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.request.windowMinutes, 30);
    assert.match(prepared.sql, /PSKR FT8%/);
    assert.match(prepared.sql, /OL42%/);
    assert.ok(prepared.sql.includes('K1ABC'));

    const result = pathService.complete(prepared, []);
    assert.equal(result.ok, true);
    assert.equal(result.windowMinutes, 30);
    assert.deepEqual(result.rows, []);

    const noCall = pathService.prepare({}, new Ctx({uiSettings: {grid: 'OL42ET'}}));
    assert.equal(noCall.error, 'call-required');
    const noGrid = pathService.prepare({}, new Ctx({uiSettings: {myCall: 'BG7TV'}}));
    assert.equal(noGrid.error, 'grid-required');
});
