'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {largeGridFrom} = require('../lib/radio/maidenhead.js');
const paths = require('../lib/analysis/paths.js');
const pathService = require('../lib/analysis/path-service.js');
const neighborSql = require('../lib/storage/neighbor-sql.js');

const BASE = {
    myCall: 'BG7TV',
    myGrid: 'OL42ET',
    monitored: ['K1ABC'],
    windowMinutes: 15
};
const NOW_SEC = Math.floor(Date.parse('2026-11-10T13:00:00Z') / 1000);

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
    return paths.analyzePaths(Object.assign({}, BASE, {rows, now: NOW_SEC}, extra || {}));
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

test('功率标称 50 W：归一到 100 W 为 +3 dB，且不做 50 Hz→2500 Hz 的 −17 dB 换算', () => {
    assert.ok(Math.abs(paths.powerOffsetDb() - 3.0103) < 0.001);
    assert.ok(Math.abs(paths.normalizeTo100(-3, 500) - (-9.99)) < 0.01);
    assert.ok(Math.abs(paths.normalizeTo100(-3, 50) - 0.01) < 0.01);
    const report = analyze(baseRows());
    const a = report.rows[0].directions.aToB;
    // 原始中位数 −5 dB，加 3 dB 标称后约 −2 dB。
    assert.equal(a.snrDb, -2);
    assert.equal(a.margins.CW, 7);
    assert.equal(a.margins.SSB, -8);
    assert.notEqual(a.margins.CW, 4);
    assert.equal(report.snrReferenceHz, 2500);
    assert.equal(report.bandwidthConversion, 'none');
    assert.equal(report.power.nominalWatts, 50);
});

test('功率假设区间 10–70 W 相对 50 W 不对称：−7.0 / +1.5 dB', () => {
    const minus = paths.POWER_UNCERTAINTY_DB.minus;
    const plus = paths.POWER_UNCERTAINTY_DB.plus;
    assert.equal(minus, -7);
    assert.equal(plus, 1.5);
    assert.ok(Math.abs(10 * Math.log10(10 / 50) - minus) < 0.02);
    assert.ok(Math.abs(10 * Math.log10(70 / 50) - plus) < 0.05);
    // 功率差本身必须落在不对称带内，不能硬写成 ±4.5。
    assert.ok(10 * Math.log10(10 / 50) > -7.1 && 10 * Math.log10(10 / 50) < -6.9);
    assert.ok(10 * Math.log10(70 / 50) > 1.4 && 10 * Math.log10(70 / 50) < 1.6);
});

test('双向分别计算，不合并成单一中位数', () => {
    const report = analyze(baseRows());
    const directions = report.rows[0].directions;
    assert.equal(directions.aToB.snrDb, -2);
    // B→A 的接收方都在同一个远方台 R1XX，按“接收站×窗口”聚合后得 7.5。
    assert.equal(directions.bToA.snrDb, 7.5);
    assert.equal(directions.aToB.samples, 6);
    assert.equal(directions.bToA.samples, 6);
});

test('功率为假设时置信度不得为高', () => {
    const rows = [];
    const stations = ['N1AA', 'N2BB', 'N3CC'];
    for (const call of stations) {
        for (let i = 0; i < 4; i += 1) {
            rows.push(aToB(0, call, 'OL42' + call.slice(2), `2026-11-10T12:0${i}:10Z`));
            rows.push(bToA(0, call, 'OL42' + call.slice(2), `2026-11-10T12:1${i}:10Z`));
        }
    }
    const rowOut = analyze(rows).rows[0];
    assert.ok(rowOut.directions.aToB.samples >= 10);
    assert.ok(rowOut.directions.bToA.samples >= 10);
    assert.equal(rowOut.directions.aToB.powerKnown, false);
    assert.equal(rowOut.confidence.level, 'medium');
    assert.notEqual(rowOut.confidence.level, 'high');
    assert.ok(rowOut.confidence.notes.includes('power-assumed'));
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
    assert.equal(a.snrDb, -7);
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
    assert.equal(a.snrDb, -10);
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
    assert.ok(!report.local.neighbors.some(item => item.call === 'BG7TV'));
});

test('单站单方向也出结论，样本量照实标注、不退回用本台数据凑', () => {
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
    assert.equal(rowOut.directions.aToB.available, true);
    assert.equal(rowOut.directions.aToB.stations, 1);
    assert.equal(rowOut.directions.aToB.samples, 5);
    assert.equal(rowOut.directions.bToA, null);
    assert.equal(rowOut.evidence.level, 'single-direction');
    assert.deepEqual(rowOut.evidence.stations, {aToB: 1, bToA: 0});
    assert.deepEqual(rowOut.evidence.reports, {aToB: 5, bToA: 0});
    assert.equal(rowOut.confidence.level, 'low');
    assert.ok(rowOut.confidence.notes.includes('single-direction'));
    assert.equal(rowOut.self.aToB.samples, 1);
});

test('每个方向 1 条报告即可出结论，不再要求 5 条', () => {
    const rows = [
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-3, 'N2BB', 'OL42BB', '2026-11-10T12:01:10Z'),
        aToB(-4, 'N3CC', 'OL42CC', '2026-11-10T12:02:10Z')
    ];
    const rowOut = analyze(rows).rows[0];
    const a = rowOut.directions.aToB;
    assert.equal(a.available, true);
    assert.equal(a.samples, 3);
    assert.equal(a.stations, 3);
    assert.equal(rowOut.evidence.level, 'single-direction');
});

test('双向各 1 条即成立，证据强度标为单站佐证并保持模式门限', () => {
    const rows = [
        aToB(-2, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        bToA(-2, 'N1AA', 'OL42AA', '2026-11-10T12:00:20Z')
    ];
    const rowOut = analyze(rows).rows[0];
    assert.equal(rowOut.directions.aToB.available, true);
    assert.equal(rowOut.directions.bToA.available, true);
    assert.equal(rowOut.directions.aToB.samples, 1);
    assert.equal(rowOut.directions.bToA.samples, 1);
    assert.equal(rowOut.directions.aToB.sparse, true);
    // 1 dB 的原始中位数 + 3 dB 标称 → CW 10 可通、SSB −5 不可通，门限不放宽。
    assert.equal(rowOut.modes.CW.advice, 'workable');
    assert.equal(rowOut.modes.SSB.advice, 'unworkable');
    assert.equal(rowOut.evidence.level, 'single-station');
    assert.equal(rowOut.evidence.consistent, true);
    assert.deepEqual(rowOut.evidence.stations, {aToB: 1, bToA: 1});
    assert.deepEqual(rowOut.evidence.reports, {aToB: 1, bToA: 1});
});

test('双向多站：证据强度标为 multi-station，计数与一致性与判定对齐', () => {
    const rows = [];
    ['N1AA', 'N2BB', 'N3CC'].forEach((call, index) => {
        const grid = 'OL42' + call.slice(2);
        rows.push(aToB(-2, call, grid, `2026-11-10T12:0${index}:10Z`));
        rows.push(bToA(-2, call, grid, `2026-11-10T12:0${index}:20Z`));
    });
    const rowOut = analyze(rows).rows[0];
    assert.equal(rowOut.evidence.level, 'multi-station');
    assert.equal(rowOut.evidence.consistent, true);
    assert.deepEqual(rowOut.evidence.stations, {aToB: 3, bToA: 3});
    assert.deepEqual(rowOut.evidence.reports, {aToB: 3, bToA: 3});
});

test('聚合窗口默认 15 分钟，可配置并夹紧到 1–60 分钟', () => {
    assert.equal(paths.DEFAULT_WINDOW_MINUTES, 15);
    assert.equal(paths.clampWindowMinutes(undefined), 15);
    assert.equal(paths.clampWindowMinutes(0), 15);
    assert.equal(paths.clampWindowMinutes('5'), 5);
    assert.equal(paths.clampWindowMinutes(90), 60);
    assert.equal(analyze([], {windowMinutes: 5}).windowMinutes, 5);
    assert.deepEqual(analyze([]).windowRange, {min: 1, max: 60, default: 15});
    assert.equal(analyze([]).thresholds.minStationsPerDirection, 1);
    assert.equal(analyze([]).thresholds.minReportsPerDirection, 1);
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

test('邻台注册表：按大网格与 30 分钟时效过滤，过期邻台失效', () => {
    const neighbors = [
        {call: 'N1AA', grid4: 'OL42', lastSeen: '2026-11-10T12:31:00Z', reports: 9},
        {call: 'N9OLD', grid4: 'OL42', lastSeen: '2026-11-10T12:29:00Z', reports: 50},
        {call: 'N8FAR', grid4: 'JO22', lastSeen: '2026-11-10T12:59:00Z', reports: 4},
        {call: 'BG7TV', grid4: 'OL42', lastSeen: '2026-11-10T12:59:00Z', reports: 3}
    ];
    const report = analyze(baseRows(), {neighbors});
    assert.equal(report.local.neighborCount, 1);
    assert.equal(report.local.neighbors[0].call, 'N1AA');
    assert.equal(report.neighborTtlMinutes, 30);
    assert.ok(!report.local.neighbors.some(item => item.call === 'N9OLD'));
    assert.ok(!report.local.neighbors.some(item => item.call === 'N8FAR'));
});

test('有效期边界：29 分钟内仍在，31 分钟失效（30 分钟整仍有效）', () => {
    const neighbors = [
        {call: 'N1AA', grid4: 'OL42', lastSeen: '2026-11-10T12:31:00Z', reports: 1},
        {call: 'N2BB', grid4: 'OL42', lastSeen: '2026-11-10T12:29:00Z', reports: 1},
        {call: 'N3CC', grid4: 'OL42', lastSeen: '2026-11-10T12:30:00Z', reports: 1}
    ];
    const report = analyze([], {neighbors});
    assert.deepEqual(report.local.neighbors.map(item => item.call).sort(), ['N1AA', 'N3CC']);
});

test('邻台列表按最近出现时间排序，失效台站不参与统计与排序', () => {
    const neighbors = [
        {call: 'N1AA', grid4: 'OL42', lastSeen: '2026-11-10T12:40:00Z', reports: 1},
        {call: 'N2BB', grid4: 'OL42', lastSeen: '2026-11-10T12:55:00Z', reports: 2},
        {call: 'N3CC', grid4: 'OL42', lastSeen: '2026-11-10T12:50:00Z', reports: 3}
    ];
    const report = analyze([], {neighbors});
    assert.deepEqual(report.local.neighbors.map(item => item.call), ['N2BB', 'N3CC', 'N1AA']);
});

test('失效邻台的历史报告不进入统计与贡献列表', () => {
    const neighbors = [
        {call: 'N1AA', grid4: 'OL42', lastSeen: '2026-11-10T12:59:00Z', reports: 1},
        {call: 'N2BB', grid4: 'OL42', lastSeen: '2026-11-10T12:00:00Z', reports: 1},
        {call: 'N3CC', grid4: 'OL42', lastSeen: '2026-11-10T12:00:00Z', reports: 1}
    ];
    const report = analyze(baseRows(), {neighbors});
    const a = report.rows[0].directions.aToB;
    // 只有 N1AA 的 2 条报告进入统计；N2BB / N3CC 虽有历史报告，但已失效。
    assert.equal(a.samples, 2);
    assert.equal(a.stations, 1);
    assert.equal(a.available, true);
    assert.equal(report.rows[0].evidence.level, 'single-station');
    assert.deepEqual(a.contributors.map(item => item.call), ['N1AA']);
    assert.deepEqual(report.local.neighbors.map(item => item.call), ['N1AA']);
    assert.ok(!(report.rows[0].remoteCalls || []).includes('N2BB'));
});

test('无任何邻台时给出空态，不虚构结论', () => {
    const report = analyze([], {neighbors: []});
    assert.equal(report.ok, true);
    assert.equal(report.local.neighborCount, 0);
    assert.deepEqual(report.rows, []);
});

test('邻台存在但只有单向数据时，另一方向明确为空', () => {
    const rows = [
        aToB(-5, 'N1AA', 'OL42AA', '2026-11-10T12:00:10Z'),
        aToB(-5, 'N1AA', 'OL42AA', '2026-11-10T12:20:10Z'),
        aToB(-5, 'N2BB', 'OL42BB', '2026-11-10T12:01:10Z'),
        aToB(-5, 'N2BB', 'OL42BB', '2026-11-10T12:21:10Z'),
        aToB(-5, 'N3CC', 'OL42CC', '2026-11-10T12:02:10Z'),
        aToB(-5, 'N3CC', 'OL42CC', '2026-11-10T12:22:10Z')
    ];
    const report = analyze(rows, {
        neighbors: [
            {call: 'N1AA', grid4: 'OL42', lastSeen: '2026-11-10T12:50:00Z', reports: 4},
            {call: 'N2BB', grid4: 'OL42', lastSeen: '2026-11-10T12:50:00Z', reports: 4},
            {call: 'N3CC', grid4: 'OL42', lastSeen: '2026-11-10T12:50:00Z', reports: 4}
        ]
    });
    const rowOut = report.rows[0];
    assert.equal(rowOut.directions.aToB.available, true);
    assert.equal(rowOut.directions.bToA, null);
    assert.equal(rowOut.confidence.level, 'low');
    assert.ok(rowOut.confidence.notes.includes('single-direction'));
});

test('下钻：贡献邻台附带网格、时效与样本量，最多 12 个', () => {
    const report = analyze(baseRows());
    const a = report.rows[0].directions.aToB;
    assert.equal(a.contributors.length, 3);
    const first = a.contributors[0];
    assert.equal(first.samples, 2);
    assert.equal(first.grid4, 'OL42');
    assert.ok(first.margins.CW !== null);
    for (const item of a.contributors) {
        assert.ok(item.samples >= 1);
        assert.ok(item.call.startsWith('N'));
    }
});

test('按可利用性排序：可通区域排在不可通区域之前', () => {
    const rows = [];
    const stations = ['N1AA', 'N2BB', 'N3CC'];
    stations.forEach((call, index) => {
        const grid = 'OL42' + call.slice(2);
        [0, 20].forEach(minute => {
            rows.push(aToB(10, call, grid, `2026-11-10T12:${String(minute + index).padStart(2, '0')}:10Z`,
                {dxcc_sender: 291, band: '20m'}));
            rows.push(bToA(10, call, grid, `2026-11-10T12:${String(minute + index).padStart(2, '0')}:20Z`,
                {dxcc_sender: 291, band: '20m', dxcc_receiver: 291}));
            rows.push(aToB(-30, call, grid, `2026-11-10T12:${String(minute + index).padStart(2, '0')}:30Z`,
                {dxcc_sender: 230, band: '40m'}));
            rows.push(bToA(-30, call, grid, `2026-11-10T12:${String(minute + index).padStart(2, '0')}:40Z`,
                {dxcc_sender: 230, band: '40m', dxcc_receiver: 230}));
        });
    });
    const report = analyze(rows);
    assert.equal(report.rows.length, 2);
    assert.equal(report.rows[0].region.key, 'dxcc:291');
    assert.equal(report.rows[0].band, '20m');
    assert.ok(report.rows[0].usability > report.rows[1].usability);
});

test('邻台 SQL：只取本大网格且 30 分钟内活跃的记录', () => {
    const sql = neighborSql.freshQuery('OL42', 30, 240);
    assert.match(sql, /FROM neighbors/);
    assert.match(sql, /grid4 = 'OL42'/);
    assert.match(sql, /datetime\('now', '-30 minutes'\)/);
    assert.match(sql, /LIMIT 240/);
    assert.match(neighborSql.freshQuery('', 30), /1=0/);
});

test('清理只删过期行：默认删除 60 分钟前的邻台', () => {
    const sql = neighborSql.purge();
    assert.match(sql, /^DELETE FROM neighbors/);
    assert.match(sql, /datetime\('now', '-60 minutes'\)/);
    assert.match(neighborSql.purge(90), /-90 minutes/);
});

test('邻台表不做历史回填：建表脚本只有建表、重建触发器，没有回填', () => {
    const schema = require('../lib/storage/schema.js');
    const statements = schema.createNeighbors();
    assert.equal(statements.length, 5);
    assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS neighbors/);
    assert.match(statements[1], /^DROP TRIGGER IF EXISTS trg_spots_neighbor_tx/);
    assert.match(statements[2], /^CREATE TRIGGER IF NOT EXISTS trg_spots_neighbor_tx/);
    assert.match(statements[3], /^DROP TRIGGER IF EXISTS trg_spots_neighbor_rx/);
    assert.match(statements[4], /^CREATE TRIGGER IF NOT EXISTS trg_spots_neighbor_rx/);
    for (const sql of statements) {
        assert.ok(!/INSERT[^;]*INTO neighbors[\s\S]*SELECT/i.test(sql),
            'neighbors must not be backfilled from historical spots');
    }
});

class Ctx {
    constructor(values) { this.values = values; }
    get(key) { return this.values[key]; }
}

test('path-service 全自动：准备两段查询、并入邻台、补时间窗', () => {
    const global = new Ctx({
        uiSettings: {myCall: 'BG7TV', grid: 'OL42ET', pskWindowMin: '30', txPowerW: 100},
        monitoredCalls: ['K1ABC']
    });
    const prepared = pathService.prepare({}, global);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.request.windowMinutes, 30);
    assert.equal(prepared.request.neighborTtlMinutes, 30);
    assert.match(prepared.neighborSql, /-30 minutes/);
    assert.match(prepared.neighborSql, /FROM neighbors/);
    assert.match(prepared.sql, /PSKR FT8%/);
    assert.match(prepared.sql, /OL42%/);
    assert.ok(prepared.sql.includes('K1ABC'));

    const spots = pathService.prepareSpots(prepared, [
        {call: 'N1AA', grid4: 'OL42', first_seen: '2026-11-10T10:00:00Z',
            last_seen: '2026-11-10T12:00:00Z', reports: 5}
    ]);
    assert.equal(spots.request.neighbors.length, 1);
    assert.equal(spots.request.neighbors[0].lastSeen, '2026-11-10T12:00:00Z');

    const result = pathService.complete({ok: true, request: spots.request}, []);
    assert.equal(result.ok, true);
    assert.equal(result.windowMinutes, 30);
    assert.equal(result.window.minutes, 30);
    assert.ok(result.generatedAt);
    assert.deepEqual(result.rows, []);

    const noCall = pathService.prepare({}, new Ctx({uiSettings: {grid: 'OL42ET'}}));
    assert.equal(noCall.error, 'call-required');
    assert.equal(pathService.complete(noCall, []).error, 'call-required');
    const noGrid = pathService.prepare({}, new Ctx({uiSettings: {myCall: 'BG7TV'}}));
    assert.equal(noGrid.error, 'grid-required');
});

test('path-service 按 hours 决定回看范围，窗口缺省取 15 分钟', () => {
    const global = new Ctx({
        uiSettings: {myCall: 'BG7TV', grid: 'OL42ET'},
        monitoredCalls: []
    });
    const defaults = pathService.prepare({}, global);
    assert.equal(defaults.request.windowMinutes, 15);
    const span = (prepared) => (Date.parse(prepared.request.to) -
        Date.parse(prepared.request.from)) / 3600000;
    assert.equal(Math.round(span(defaults)), 6);
    const op = pathService.prepare({hours: '2'}, global);
    assert.equal(Math.round(span(op)), 2);
    const clamped = pathService.prepare({hours: '99'}, global);
    assert.equal(Math.round(span(clamped)), pathService.allowedWindowHours().maxHours);
    assert.equal(pathService.allowedWindowHours().defaultHours, 6);
});

test('页面无需任何输入即可产出结果：prepare({}) 直接可用', () => {
    const global = new Ctx({
        uiSettings: {myCall: 'BG7TV', grid: 'OL42ET'},
        monitoredCalls: []
    });
    const prepared = pathService.prepare({}, global);
    assert.equal(prepared.ok, true);
    // 邻台注册表只保留 30 分钟内活跃台站，这里用“刚刚出现过”的实时行。
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const spots = pathService.prepareSpots(prepared, ['N1AA', 'N2BB', 'N3CC'].map(call => ({
        call, grid4: 'OL42', last_seen: recent, reports: 4
    })));
    const result = pathService.complete({ok: true, request: spots.request}, baseRows());
    assert.equal(result.ok, true);
    assert.equal(result.local.largeGrid, 'OL42');
    assert.equal(result.local.neighborCount, 3);
    assert.ok(result.rows.length >= 1);
    assert.ok(result.rows[0].directions.aToB.samples > 0);
});
