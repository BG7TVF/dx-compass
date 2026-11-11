'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/advice/engine.js');
const {thresholds, DEFAULTS} = require('../lib/advice/config.js');
const solar = require('../lib/solar.js');

const NOW = new Date('2026-11-08T12:00:00.000Z');

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

const PROP = {
    sfi: {list: [['t', 150]]},
    ssn: {list: [['t', 80]]},
    kp: {list: [['t', 2]]},
    a: {list: [['t', 8]]},
    scales: {s: 0, r: 0}
};

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

function run(overrides) {
    return engine.buildAdvice(Object.assign({
        settings: SETTINGS,
        rows: rows(),
        prop: PROP,
        radio: {freqKhz: 14025, mode: 'CW', isRunning: true},
        score: {qsos: 260},
        activeEntities: 342,
        cooldown: {},
        now: NOW
    }, overrides || {}));
}

function ids(result) {
    return result.advice.map(item => item.id);
}

test('环境档位：CGM 纬度、季节、BPI、Ap 一并进入输出', () => {
    const env = run().environment;
    assert.equal(env.available, true);
    assert.equal(env.latBand, 'mid');
    assert.equal(env.season, 'winter');
    assert.equal(env.ap, 8);
    assert.equal(env.sfiTier, 'mid');
    assert.ok(env.bpi['20'] >= 1);
    assert.equal(typeof env.solarElev, 'number');
});

test('跑台率低时给出 R1，并把替代波段与阈值写进证据', () => {
    const result = run();
    assert.equal(result.degraded, null);
    assert.equal(result.currentBand, '20');
    const r1 = result.advice.find(item => item.id === 'R1');
    assert.ok(r1, 'R1 missing: ' + ids(result).join(','));
    assert.equal(r1.action, 'evaluate-band-change');
    assert.equal(r1.evidence.band, '20');
    assert.equal(r1.evidence.rate, 18);
    assert.equal(r1.evidence.prevRate, 18);
    assert.equal(r1.evidence.stayRate, 30);
    assert.ok(r1.title.zh.includes('40m') || r1.title.en.includes('40m'));
});

test('乘数缺口与 t* 满足时给出 B3/B13，且 S&P 建议可降级但不消失', () => {
    const result = run();
    const b3 = result.advice.find(item => item.id === 'B3');
    assert.ok(b3);
    assert.equal(b3.action, 'change-band-for-mult');
    assert.ok(b3.evidence.tStar > b3.evidence.tau + 5);
    assert.ok(b3.evidence.gap >= 2);
    assert.deepEqual(b3.missing, ['unworked-mult-spots']);
    assert.ok(result.advice.some(item => item.id === 'B13'));
    const s1 = result.advice.find(item => item.id === 'S1');
    assert.equal(s1.confidence, 'low');
});

test('没有 VFO 时不生成该波段建议，但引擎整体仍可用', () => {
    const result = run({radio: {}});
    assert.equal(result.ok, true);
    assert.equal(result.dependencies.radio, false);
    assert.equal(result.currentBand, '20');
    assert.ok(result.advice.length > 0);
});

test('完全没有 QSO 时标记 degraded，不产出规则建议', () => {
    const result = run({rows: []});
    assert.equal(result.degraded, 'no-qsos');
    assert.deepEqual(result.advice, []);
    assert.equal(result.dependencies.qsos, false);
});

test('CQ 160 触发 G7 单波段门控，B 组建议全部被否决', () => {
    const result = run({settings: Object.assign({}, SETTINGS, {contestType: 'CQ160'})});
    assert.equal(result.gates.blockBandChange, 'G7');
    assert.ok(ids(result).includes('G7'));
    assert.equal(ids(result).some(id => id.startsWith('B')), false);
});

test('冷却中的规则被压制而不是重复弹出', () => {
    const result = run({cooldown: {R1: NOW.getTime() - 1000}});
    assert.equal(ids(result).includes('R1'), false);
    assert.ok(result.suppressed.some(item => item.id === 'R1' && item.reason === 'cooldown'));
});

test('提高最低置信度后低置信度建议被过滤', () => {
    const result = run({settings: Object.assign({}, SETTINGS, {adviceMinConfidence: 'high'})});
    assert.deepEqual(result.advice, []);
    assert.ok(result.suppressed.every(item => item.reason === 'confidence'));
});

test('阈值可被 adviceConfig 覆盖，且默认值保持不变', () => {
    assert.equal(thresholds({}).tau.SO1R, DEFAULTS.tau.SO1R);
    const cfg = thresholds({adviceConfig: '{"tau":{"SO1R":5},"kpStorm":4}'});
    assert.equal(cfg.tau.SO1R, 5);
    assert.equal(cfg.tau.SO2R, DEFAULTS.tau.SO2R);
    assert.equal(cfg.kpStorm, 4);
    assert.deepEqual(thresholds({adviceConfig: 'not json'}).tau, DEFAULTS.tau);
});

test('赛事类型与功率组别可自动推断', () => {
    assert.equal(engine.contestTypeOf({contestName: 'CQ WPX CW'}), 'CQWPX');
    assert.equal(engine.contestTypeOf({contestName: 'CQ 160 CW'}), 'CQ160');
    assert.equal(engine.contestTypeOf({contestType: 'WAE', contestName: 'CQ WW'}), 'WAE');
    assert.equal(engine.powerClassOf({txPowerW: 5}), 'QRP');
    assert.equal(engine.powerClassOf({txPowerW: 100}), 'LP');
    assert.equal(engine.powerClassOf({txPowerW: 1500}), 'HP');
});

test('太阳几何：赤纬、高度角、灰线与季节', () => {
    const june = solar.solarParams('2026-06-21T12:00:00.000Z');
    assert.ok(Math.abs(june.declination - 23.4) < 1);
    const december = solar.solarParams('2026-12-21T12:00:00.000Z');
    assert.ok(Math.abs(december.declination + 23.4) < 1);
    assert.ok(solar.solarElevation(0, 0, '2026-03-20T12:00:00.000Z') > 85);
    assert.equal(solar.season('2026-06-21T12:00:00.000Z', 40), 'summer');
    assert.equal(solar.season('2026-06-21T12:00:00.000Z', -40), 'winter');
    const gray = solar.grayline(0, 0, 40, -100, '2026-11-08T12:00:00.000Z');
    assert.equal(typeof gray.ok, 'boolean');
    assert.equal(typeof gray.elevA, 'number');
});
