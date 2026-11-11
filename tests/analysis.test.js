'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {parseSValue, sMeterToDbm, normalizeStrength} = require('../lib/analysis/strength.js');
const {
    median, robustSigma, angularDiff, circularMedian, sectorStats, classifyAntenna,
    relativeLevelEvidence, callVariants, groupByPeriod, analyzeTarget,
    MIN_ANTENNA_POINTS, MAX_WINDOW_HOURS
} = require('../lib/analysis/estimate.js');
const {analysisQuery} = require('../lib/storage/spot-sql.js');
const service = require('../lib/analysis/service.js');

const TARGET = 'K1T';

/** 以目标台 (0,0) 为原点，按方位角与距离（度）放置一个报告点。 */
function spotAt(bearingDeg, distanceDeg) {
    const br = bearingDeg * Math.PI / 180;
    const d = (distanceDeg === undefined ? 10 : distanceDeg) * Math.PI / 180;
    return {
        lat: Math.asin(Math.sin(d) * Math.cos(br)) * 180 / Math.PI,
        lon: Math.atan2(Math.sin(br) * Math.sin(d), Math.cos(d)) * 180 / Math.PI
    };
}

function row(overrides) {
    return Object.assign({
        timestamp: '2026-11-08T12:00:00Z',
        de: 'W1RX',
        spot_call: TARGET,
        freq: 14025,
        band: '20m',
        signal: null,
        snr: null,
        lat: 40,
        lon: -100,
        dx_lat: 40,
        dx_lon: -90
    }, overrides);
}

/** RBN 风格：只有 SNR，没有 RST。 */
function snrRow(bearing, overrides) {
    const pos = spotAt(bearing);
    return row(Object.assign({
        de: `R${bearing}`,
        snr: 20,
        lat: pos.lat,
        lon: pos.lon,
        dx_lat: 0,
        dx_lon: 0
    }, overrides));
}

function directionalRows() {
    const bearings = [245, 248, 251, 254, 257, 260, 263, 266, 90, 160];
    return bearings.map(bearing => snrRow(bearing, {de: `R${bearing}`}));
}

test('RST 解析取 S 位而不是 R 位，未知强度不强行换算', () => {
    assert.equal(parseSValue('599'), 9);
    assert.equal(parseSValue('57'), 7);
    assert.equal(parseSValue('5NN'), 9);
    assert.equal(parseSValue('S5'), 5);
    assert.equal(parseSValue('S9+10'), 9);
    assert.equal(parseSValue(''), null);
    assert.equal(parseSValue(null), null);
    assert.equal(sMeterToDbm(9), -73);
    assert.equal(sMeterToDbm(5), -97);
});

test('SNR（RBN db / PSKR）不当作 S 表读数，只标记为不可用', () => {
    const skimmer = normalizeStrength({snr: 25, signal: null, source: 'RBN'});
    assert.equal(skimmer.usable, false);
    assert.equal(skimmer.kind, 'snr');
    assert.equal(skimmer.dbm, null);
    const pskr = normalizeStrength({snr: -12, signal: null, source: 'PSKR'});
    assert.equal(pskr.usable, false);
    assert.match(pskr.source, /pskr/);
    const cluster = normalizeStrength({signal: '579', snr: null, source: 'DX Cluster'});
    assert.equal(cluster.usable, true);
    assert.equal(cluster.dbm, -85);
});

test('中位数不被长尾拉高：均值会明显偏离', () => {
    const values = [-95, -94, -93, -92, -91, -60];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    assert.equal(median(values), -92.5);
    assert.ok(mean - median(values) > 4);
});

test('稳健离散度不随样本量收缩（误差地板不靠堆样本突破）', () => {
    const few = [-90, -92, -94, -96];
    const many = few.concat(few, few, few, few, few);
    assert.equal(robustSigma(few), robustSigma(many));
    assert.ok(robustSigma(few) > 0);
});

test('天线三分类：定向/偶极/全向概率与朝向', () => {
    const directional = Array.from({length: 8}, (_, i) => ({bearing: 250 + i * 5, distanceKm: 800}))
        .concat([{bearing: 90, distanceKm: 800}, {bearing: 160, distanceKm: 800}]);
    const dir = classifyAntenna(directional);
    assert.equal(dir.type, 'directional');
    assert.ok(dir.probabilities.directional > 0.5);
    assert.ok(angularDiff(dir.azimuthDeg, 268) < 15);
    assert.ok(dir.evidence.mainShare > 0.6);

    const omni = Array.from({length: 12}, (_, i) => ({bearing: i * 30, distanceKm: 600}));
    const om = classifyAntenna(omni);
    assert.equal(om.type, 'omni');
    assert.ok(om.probabilities.omni > om.probabilities.directional);

    const dipole = [80, 85, 90, 95, 260, 265, 270, 275]
        .map(bearing => ({bearing, distanceKm: 700}));
    const dp = classifyAntenna(dipole);
    assert.equal(dp.type, 'dipole');
    assert.ok(dp.probabilities.dipole > dp.probabilities.omni);
    assert.ok(angularDiff(dp.azimuthDeg, 90) < 45 || angularDiff(dp.azimuthDeg, 270) < 45);
});

test('样本不足时天线判定为 unknown 且给出证据缺口', () => {
    const result = classifyAntenna([{bearing: 90, distanceKm: 500}, {bearing: 92, distanceKm: 520}]);
    assert.equal(result.ok, false);
    assert.equal(result.type, 'unknown');
    assert.ok(result.notes.includes('insufficient-points'));
    assert.equal(result.evidence.mainShare > 0.9, true);
});

test('扇区统计的 12 桶覆盖全部方位且份额归一', () => {
    const stats = sectorStats([0, 10, 20, 100, 190, 350]);
    assert.equal(stats.bins.length, 12);
    assert.equal(stats.bins.reduce((a, b) => a + b, 0), 6);
    assert.ok(stats.share > 0 && stats.share <= 1);
});

test('圆中位数对跨 0° 的方位不会算成 180°', () => {
    assert.ok(angularDiff(circularMedian([355, 5, 350, 10]), 0) < 5);
});

test('呼号变体匹配 RBN 的 -# 后缀', () => {
    assert.deepEqual(callVariants('DL8WR-#'), ['DL8WR-#', 'DL8WR']);
    assert.deepEqual(callVariants('N0CALL-5'), ['N0CALL-5', 'N0CALL']);
});

test('分组只做样本量追溯：同波段同 2 小时合并为一组', () => {
    const points = [
        {band: '20m', epoch: 0},
        {band: '20m', epoch: 3600},
        {band: '40m', epoch: 3600},
        {band: '20m', epoch: 7200}
    ];
    const groups = groupByPeriod(points);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups.map(g => g.n), [2, 1, 1]);
});

test('相对电平只在同一报告站内部比较方位差，且只作辅助证据', () => {
    const point = (spotter, bearing, signal) => ({
        spotter,
        bearing,
        strength: normalizeStrength({signal})
    });
    const points = [
        point('R1', 90, '599'), point('R1', 110, '599'), point('R1', 70, '599'),
        point('R1', 210, 'S5'), point('R1', 270, 'S5'),
        point('R2', 60, 'S7'), point('R2', 90, '599'),
        point('R2', 240, 'S5'), point('R2', 300, 'S5')
    ];
    const result = relativeLevelEvidence(points, 90);
    assert.equal(result.available, true);
    assert.equal(result.receivers, 2);
    assert.equal(result.usablePoints, 9);
    assert.equal(result.usage, 'auxiliary-only');
    // R1: -73 - (-97) = 24 dB；R2: -79 - (-97) = 18 dB；取中位 21 dB。
    assert.equal(result.deltaDb, 21);
    assert.deepEqual(
        result.perReceiver.map(item => [item.spotter, item.deltaDb]),
        [['R1', 24], ['R2', 18]]
    );
});

test('SNR 点不参与相对电平，单站也不足以形成结论', () => {
    const snrPoint = (spotter, bearing) => ({
        spotter,
        bearing,
        strength: normalizeStrength({signal: null, snr: 20})
    });
    const snrOnly = relativeLevelEvidence(
        [snrPoint('R1', 90), snrPoint('R1', 200), snrPoint('R1', 300),
            snrPoint('R2', 90), snrPoint('R2', 200), snrPoint('R2', 300)],
        90
    );
    assert.equal(snrOnly.available, false);
    assert.equal(snrOnly.reason, 'no-usable-strength');
    assert.equal(snrOnly.usablePoints, 0);

    const point = (spotter, bearing, signal) => ({
        spotter,
        bearing,
        strength: normalizeStrength({signal})
    });
    const oneReceiver = relativeLevelEvidence([
        point('R1', 90, '599'), point('R1', 110, 'S7'), point('R1', 210, 'S5'), point('R1', 270, 'S5')
    ], 90);
    assert.equal(oneReceiver.available, false);
    assert.equal(oneReceiver.reason, 'too-few-receivers');
    assert.equal(oneReceiver.receivers, 1);
});

test('完全没有信号强度时仍能给出天线类型与朝向', () => {
    const report = analyzeTarget({
        call: TARGET,
        rows: directionalRows(),
        from: '2026-11-08 00:00:00',
        to: '2026-11-09 00:00:00'
    });
    assert.equal(report.method, 'bearing-distribution');
    assert.equal(report.antenna.ok, true);
    assert.equal(report.antenna.type, 'directional');
    assert.ok(report.antenna.probabilities.directional > 0.5);
    assert.ok(angularDiff(report.antenna.azimuthDeg, 255) < 20);
    assert.equal(report.relative.available, false);
    assert.equal(report.relative.reason, 'no-usable-strength');
    assert.equal(report.observations.strengthSources.snrOnly, 10);
    assert.equal(report.observations.strengthSources.rst, 0);
    assert.equal(report.observations.positioned, 10);
    assert.equal(report.observations.sectorCoverage, 3);
});

test('输出中不存在任何功率、EIRP 或路径损耗结论', () => {
    const report = analyzeTarget({
        call: TARGET,
        rows: directionalRows(),
        from: '2026-11-08 00:00:00',
        to: '2026-11-09 00:00:00'
    });
    assert.equal(report.power, undefined);
    assert.equal(report.powerClass, undefined);
    assert.equal(report.estimateDbm, undefined);
    assert.equal(report.disclaimer.noPower, 'antenna-only');
    assert.equal(report.disclaimer.strengthUsage, 'relative-only');
    const text = JSON.stringify(report);
    for (const token of ['dbm', 'dBm', 'EIRP', 'eirp', 'pathLoss', 'path-loss', 'watts', 'Watt', 'mainClass', 'estimateDbm']) {
        assert.equal(text.includes(token), false, `report leaks "${token}"`);
    }
    // 相对电平是 dB 差（此处不可用，为 null），不是绝对电平。
    assert.equal(report.relative.deltaDb, null);
});

test('功率反算模块已彻底移除：文件不存在、导出为空', () => {
    for (const file of ['path-loss.js', 'references.js', 'reference-stations.json']) {
        assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', 'analysis', file)), false);
    }
    const estimate = require('../lib/analysis/estimate.js');
    for (const name of ['estimateTarget', 'mapToClass', 'POWER_CLASSES', 'absoluteMethod', 'lineAMethod']) {
        assert.equal(estimate[name], undefined, `${name} should be gone`);
    }
    const analysis = require('../lib/analysis/index.js');
    assert.equal(analysis.estimateTarget, undefined);
});

test('无 spot 时给出 insufficient 与 no-spots 告警', () => {
    const report = analyzeTarget({call: TARGET, rows: [], from: '2026-11-08 00:00:00', to: '2026-11-09 00:00:00'});
    assert.equal(report.antenna.ok, false);
    assert.equal(report.antenna.type, 'unknown');
    assert.ok(report.warnings.includes('antenna-insufficient'));
    assert.ok(report.warnings.includes('no-spots'));
});

test('时间窗超过 7 天只告警，不阻断研判', () => {
    const report = analyzeTarget({
        call: TARGET,
        rows: directionalRows(),
        from: '2026-11-01 00:00:00',
        to: '2026-11-09 00:00:00'
    });
    assert.equal(report.window.hours > MAX_WINDOW_HOURS, true);
    assert.ok(report.warnings.includes('window-too-long'));
    assert.equal(report.antenna.ok, true);
});

test('非目标台的点计入排除，不进入天线判断', () => {
    const rows = directionalRows().concat([snrRow(10, {
        de: 'OTHER', spot_call: 'K9X', snr: 30
    })]);
    const report = analyzeTarget({call: TARGET, rows, from: '2026-11-08 00:00:00', to: '2026-11-09 00:00:00'});
    assert.equal(report.observations.excluded.otherCall, 1);
    assert.equal(report.observations.targetRows, 10);
    assert.equal(report.observations.positioned, 10);
});

test('analysisQuery 只按目标呼号取点，不接收参照台列表', () => {
    const sql = analysisQuery(TARGET, '2026-11-08 00:00:00', '2026-11-09 00:00:00', 5000);
    assert.match(sql, /\(monitored_call = 'K1T' OR spot_call = 'K1T'\)/);
    assert.match(sql, /datetime\('2026-11-08 00:00:00'\)/);
    assert.match(sql, /ORDER BY id ASC/);
    assert.match(sql, /LIMIT 5000/);
    assert.equal(sql.includes('IN ('), false);
    assert.equal(analysisQuery('', null, null, 10), 'SELECT * FROM spots WHERE 1=0;');
});

test('接口服务层：缺少呼号返回 400 语义，正常请求组装 SQL 并产出天线报告', () => {
    const missing = service.prepare({});
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'call-required');
    assert.match(missing.sql, /WHERE 1=0/);
    assert.deepEqual(service.complete(missing, []), {error: 'call-required'});

    const prepared = service.prepare({call: ' k1t ', from: '2026-11-08 00:00', to: '2026-11-09 00:00'});
    assert.equal(prepared.ok, true);
    assert.match(prepared.sql, /\(monitored_call = 'K1T' OR spot_call = 'K1T'\)/);
    assert.match(prepared.sql, /datetime\('2026-11-08 00:00:00'\)/);
    assert.deepEqual(prepared.request, {
        call: 'K1T',
        from: '2026-11-08 00:00:00',
        to: '2026-11-09 00:00:00',
        limit: 20000
    });
    assert.equal('refCalls' in prepared.request, false);

    const report = service.complete(prepared, directionalRows());
    assert.equal(report.target, 'K1T');
    assert.equal(report.window.from, '2026-11-08 00:00:00');
    assert.equal(report.antenna.type, 'directional');
    assert.equal(report.power, undefined);

    const empty = service.complete(prepared, []);
    assert.equal(empty.antenna.ok, false);
    assert.ok(empty.warnings.includes('antenna-insufficient'));
});

test('时间参数解析：非法值回落到默认窗口而不是抛错', () => {
    assert.equal(service.parseTime('not-a-date'), null);
    assert.equal(service.parseTime('2026-11-08'), '2026-11-08 00:00:00');
    assert.equal(service.parseTime('2026-11-08T12:30:00Z'), '2026-11-08 12:30:00');
    assert.equal(service.parseTime(null), null);
});

test('最小数据条件：至少 MIN_ANTENNA_POINTS 个带坐标的方位点才给三分类', () => {
    const rows = Array.from({length: MIN_ANTENNA_POINTS - 1}, (_, i) => snrRow(250 + i * 2));
    const short = analyzeTarget({call: TARGET, rows, from: '2026-11-08 00:00:00', to: '2026-11-09 00:00:00'});
    assert.equal(short.antenna.ok, false);

    rows.push(snrRow(270));
    const enough = analyzeTarget({call: TARGET, rows, from: '2026-11-08 00:00:00', to: '2026-11-09 00:00:00'});
    assert.equal(enough.antenna.ok, true);
    assert.notEqual(enough.antenna.type, 'unknown');
});

test('按波段输出：每波段天线独立研判，频率取最近一次', () => {
    const rows = directionalRows().concat([
        snrRow(250, {band: '40m', freq: 7025, timestamp: '2026-11-08T13:00:00Z'}),
        snrRow(255, {band: '40m', freq: 7035, timestamp: '2026-11-08T14:00:00Z'})
    ]);
    const report = analyzeTarget({call: TARGET, rows, from: '2026-11-08 00:00:00', to: '2026-11-09 00:00:00'});
    assert.deepEqual(report.bands.map(item => item.band), ['40m', '20m']);

    const forty = report.bands[0];
    assert.equal(forty.freqKhz, 7035);
    assert.equal(forty.samples, 2);
    assert.equal(forty.antenna.ok, false);
    assert.equal(forty.antenna.type, 'unknown');

    const twenty = report.bands[1];
    assert.equal(twenty.freqKhz, 14025);
    assert.equal(twenty.samples, 10);
    assert.equal(twenty.antenna.ok, true);
    assert.notEqual(twenty.antenna.type, 'unknown');
    assert.ok(twenty.antenna.confidence > 0);
});
