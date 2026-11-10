'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {parseSValue, sMeterToDbm, normalizeStrength} = require('../lib/analysis/strength.js');
const {loadReferences, gainForAntennaType, callVariants} = require('../lib/analysis/references.js');
const {medianPathLossDb} = require('../lib/analysis/path-loss.js');
const {
    median, robustSigma, angularDiff, sectorStats, classifyAntenna, mapToClass,
    estimateTarget, POWER_CLASSES
} = require('../lib/analysis/estimate.js');
const {analysisQuery} = require('../lib/storage/spot-sql.js');
const service = require('../lib/analysis/service.js');

const TARGET = 'K1T';
const REF = 'K1R';

function row(overrides) {
    return Object.assign({
        timestamp: '2026-11-08 12:00:00',
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

function emptyTable() {
    return {loaded: false, path: '(test)', error: 'missing', references: [], receivers: [], warnings: []};
}

function refTable(references, receivers) {
    return {
        loaded: true,
        path: '(test)',
        error: null,
        references: references || [],
        receivers: receivers || [],
        warnings: []
    };
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

test('绝对法下 D3/D4/D5 必须合并，不给单一确定档', () => {
    const merged = mapToClass(58, 8.8, 'absolute');
    assert.equal(merged.mainClass, 'D3-D5');
    assert.ok(merged.possibleClasses.some(c => c.id === 'D3-D5'));
    assert.equal(merged.possibleClasses.some(c => c.id === 'D4'), false);
    assert.ok(merged.confidence > 0 && merged.confidence < 1);

    const low = mapToClass(41, 8.8, 'absolute');
    assert.equal(low.mainClass, 'D1');
    assert.ok(!low.possibleClasses.some(c => c.id === 'D5'));
});

test('线路 A 精度下不合并 D3/D4/D5，但仍给相邻档', () => {
    const result = mapToClass(62, 3.5, 'lineA');
    assert.equal(result.mergedHigh, false);
    assert.equal(result.mainClass, 'D5');
    assert.ok(result.possibleClasses.some(c => c.id === 'D4'));
    assert.equal(result.possibleClasses.some(c => c.id === 'D3-D5'), false);
    assert.ok(result.confidence < 1);
});

test('热力峰值不参与强度：最强点被替换，估计值不被带动', () => {
    const build = signalOfPeak => [0, 2, 4, 6, 8, 10, 12].map((hour, i) => row({
        de: 'R' + i,
        timestamp: `2026-11-08 ${String(hour).padStart(2, '0')}:00:00`,
        signal: i === 0 ? signalOfPeak : 'S5',
        lat: 40,
        lon: -100
    }));
    const normal = estimateTarget({call: TARGET, rows: build('S5'), references: emptyTable()});
    const withPeak = estimateTarget({call: TARGET, rows: build('S9'), references: emptyTable()});
    // 7 个单点组，中位数不受单个极端峰值影响；均值则会被拉高。
    assert.equal(normal.power.estimateDbm, withPeak.power.estimateDbm);
    assert.equal(normal.observations.medianLevelDbm, -97);
    assert.equal(withPeak.observations.medianLevelDbm, -97);
});

test('绝对法：S 表点可估功率，样本量翻倍不缩小误差地板', () => {
    const rows = [1, 2, 3, 4].map((n, i) => row({
        de: 'R' + n,
        timestamp: `2026-11-08 1${i}:30:00`,
        signal: 'S6',
        lat: 0,
        lon: -45,
        dx_lat: 0,
        dx_lon: 0
    }));
    const few = estimateTarget({call: TARGET, rows, references: emptyTable()});
    const manyRows = [];
    for (let k = 0; k < 12; k += 1) manyRows.push(...rows);
    const many = estimateTarget({call: TARGET, rows: manyRows, references: emptyTable()});

    assert.equal(few.method, 'absolute');
    assert.equal(few.power.ok, true);
    const expectedLp = medianPathLossDb(14.025, 5003.6);
    const expected = -91 - 3 + expectedLp - few.methodDetail.gainAssumptionDbi;
    assert.ok(Math.abs(few.power.estimateDbm - expected) < 1.2);
    assert.ok(few.power.sigma >= 8.5 && few.power.sigma <= 9);
    assert.equal(few.power.sigma, many.power.sigma);
});

test('无可用强度（全部 SNR）时不输出档位，只保留方位观测', () => {
    const rows = Array.from({length: 10}, (_, i) => row({
        de: 'R' + i,
        timestamp: `2026-11-08 ${String(10 + (i % 4)).padStart(2, '0')}:00:00`,
        snr: 20 + i,
        lat: 35,
        lon: -100 - i * 3
    }));
    const result = estimateTarget({call: TARGET, rows, references: emptyTable()});
    assert.equal(result.power.ok, false);
    assert.equal(result.power.insufficient, true);
    assert.ok(result.observations.excluded.snrOnly >= 10);
    assert.equal(result.power.mainClass, undefined);
    assert.ok(result.warnings.includes('insufficient-samples'));
});

test('配对条件不满足时回退绝对法并声明原因', () => {
    const rows = [1, 2, 3, 4].map((n, i) => row({
        de: 'R' + n,
        timestamp: `2026-11-08 1${i}:30:00`,
        signal: 'S6',
        lat: 0,
        lon: -45,
        dx_lat: 0,
        dx_lon: 0
    }));
    const table = refTable([{call: REF, powerW: 100, antennaType: 'dipole', powerDbm: 50}]);
    const result = estimateTarget({call: TARGET, rows, references: table});
    assert.equal(result.method, 'absolute');
    assert.ok(result.warnings.includes('no-qualified-pairs'));
    assert.equal(result.power.refsUsed, undefined);
});

test('参照表缺失/为空时不编造参照台，只走绝对法', () => {
    const missing = loadReferences('tests/__does_not_exist__.json');
    assert.equal(missing.loaded, false);
    assert.deepEqual(missing.references, []);
    assert.equal(missing.error, 'missing');

    const rows = [1, 2, 3, 4].map((n, i) => row({
        de: 'R' + n,
        timestamp: `2026-11-08 1${i}:30:00`,
        signal: 'S6',
        lat: 0,
        lon: -45,
        dx_lat: 0,
        dx_lon: 0
    }));
    const result = estimateTarget({call: TARGET, rows, references: missing});
    assert.equal(result.references.referenceCount, 0);
    assert.equal(result.references.loaded, false);
    assert.ok(result.warnings.includes('reference-table-unavailable'));
    assert.equal(result.method, 'absolute');
    assert.equal(JSON.stringify(result).includes('"powerDbm":50'), false);
});

test('线路 A：同接收站配对取差分，参照台功率作为锚点', () => {
    const rows = [];
    for (let r = 0; r < 3; r += 1) {
        const de = 'R' + (r + 1);
        const lon = -100 - r * 4;
        const t = `2026-11-08 1${r}:00:00`;
        rows.push(row({de, timestamp: t, spot_call: TARGET, signal: 'S9', lat: 40, lon, dx_lat: 40, dx_lon: -90}));
        rows.push(row({de, timestamp: t, spot_call: REF, signal: 'S7', lat: 40, lon, dx_lat: 40, dx_lon: -90.5}));
    }
    const table = refTable([{
        call: REF, powerW: 100, powerDbm: 50, gainDbi: 8, antennaType: 'directional'
    }]);
    const result = estimateTarget({call: TARGET, rows, references: table});
    assert.equal(result.method, 'lineA');
    assert.equal(result.power.ok, true);
    assert.equal(result.observations.pairs, 3);
    const gainT = result.methodDetail.gainAssumptionDbi;
    const expected = 50 + (sMeterToDbm(9) - sMeterToDbm(7)) + (8 - gainT);
    assert.ok(Math.abs(result.power.estimateDbm - expected) < 0.01);
    assert.equal(result.power.estimateDbm, 68);
    assert.ok(result.power.sigma >= 3.4 && result.power.sigma <= 3.6);
    assert.ok(result.warnings.includes('reference-table-empty') === false);
});

test('线路 A 不满足条件（时间差过大）时该配对不成立', () => {
    const rows = [
        row({de: 'R1', timestamp: '2026-11-08 10:00:00', spot_call: TARGET, signal: 'S9'}),
        row({de: 'R1', timestamp: '2026-11-08 12:30:00', spot_call: REF, signal: 'S7', dx_lon: -90.5})
    ];
    const table = refTable([{call: REF, powerW: 100, powerDbm: 50, antennaType: 'dipole'}]);
    const result = estimateTarget({call: TARGET, rows, references: table});
    assert.equal(result.method, 'absolute');
    assert.equal(result.observations.pairs, 0);
});

test('方位差超出 20° 的配对被拒绝', () => {
    const rows = [
        row({de: 'R1', timestamp: '2026-11-08 10:00:00', spot_call: TARGET, signal: 'S9'}),
        row({de: 'R1', timestamp: '2026-11-08 10:10:00', spot_call: REF, signal: 'S7', dx_lat: 20, dx_lon: -90})
    ];
    const table = refTable([{call: REF, powerW: 100, powerDbm: 50, antennaType: 'dipole'}]);
    const result = estimateTarget({call: TARGET, rows, references: table});
    assert.equal(result.method, 'absolute');
});

test('呼号变体匹配 RBN 的 -# 后缀', () => {
    assert.deepEqual(callVariants('DL8WR-#'), ['DL8WR-#', 'DL8WR']);
    assert.deepEqual(callVariants('N0CALL-5'), ['N0CALL-5', 'N0CALL']);
    assert.equal(gainForAntennaType('directional'), 8);
    assert.equal(gainForAntennaType('dipole'), 2);
    assert.equal(gainForAntennaType('omni'), 1.5);
});

test('扇区统计的 12 桶覆盖全部方位且份额归一', () => {
    const stats = sectorStats([0, 10, 20, 100, 190, 350]);
    assert.equal(stats.bins.length, 12);
    assert.equal(stats.bins.reduce((a, b) => a + b, 0), 6);
    assert.ok(stats.share > 0 && stats.share <= 1);
});

test('analysisQuery 同时取回目标与参照台并按时间窗过滤', () => {
    const sql = analysisQuery(TARGET, '2026-11-08 00:00:00', '2026-11-09 00:00:00', 5000, [REF]);
    assert.match(sql, /monitored_call IN \('K1T', 'K1R'\)/);
    assert.match(sql, /spot_call IN \('K1T', 'K1R'\)/);
    assert.match(sql, /datetime\('2026-11-08 00:00:00'\)/);
    assert.match(sql, /ORDER BY id ASC/);
    assert.match(sql, /LIMIT 5000/);
    assert.equal(analysisQuery('', null, null, 10, []), 'SELECT * FROM spots WHERE 1=0;');
});

test('功率档位定义与档间距符合规格', () => {
    const db = POWER_CLASSES.map(c => c.dbm);
    assert.equal(Math.round(db[1] - db[0]), 10);
    assert.equal(Math.round(db[2] - db[1]), 7);
    assert.equal(Math.round(db[3] - db[2]), 3);
    assert.equal(Math.round(db[4] - db[3]), 3);
});

test('接口服务层：缺少呼号返回 400 语义，正常请求组装 SQL 并产出报告', () => {
    const table = refTable([{call: REF, powerW: 100, powerDbm: 50, antennaType: 'dipole'}]);
    const missing = service.prepare({}, table);
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'call-required');
    assert.match(missing.sql, /WHERE 1=0/);
    assert.deepEqual(service.complete(missing, []), {error: 'call-required'});

    const prepared = service.prepare({call: ' k1t ', from: '2026-11-08 00:00', to: '2026-11-09 00:00'}, table);
    assert.equal(prepared.ok, true);
    assert.match(prepared.sql, /monitored_call IN \('K1T', 'K1R'\)/);
    assert.match(prepared.sql, /datetime\('2026-11-08 00:00:00'\)/);
    assert.deepEqual(prepared.request.refCalls, ['K1R']);

    const report = service.complete(prepared, []);
    assert.equal(report.target, 'K1T');
    assert.equal(report.window.from, '2026-11-08 00:00:00');
    assert.equal(report.power.ok, false);
    assert.ok(report.warnings.includes('insufficient-samples'));
});

test('时间参数解析：非法值回落到默认窗口而不是抛错', () => {
    assert.equal(service.parseTime('not-a-date'), null);
    assert.equal(service.parseTime('2026-11-08'), '2026-11-08 00:00:00');
    assert.equal(service.parseTime('2026-11-08T12:30:00Z'), '2026-11-08 12:30:00');
    assert.equal(service.parseTime(null), null);
});
