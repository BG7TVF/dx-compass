'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const contestRules = require('../lib/contest/rules.js');
const engine = require('../lib/advice/engine.js');

const NOW = new Date('2026-11-08T12:40:00.000Z');
const FAMILIES = ['CQWW', 'CQWPX', 'CQWW_RTTY', 'ARRL_DX', 'IARU', 'CQ160', 'WAE'];

function settings(patch) {
    return Object.assign({
        category: 'M2', contestType: 'CQWW', multMode: 'dxcc-per-band',
        bandChangeRule: 'none', bandChangeLimit: 0, msRole: 'none',
        seatCount: 2, seatRadios: '1,2'
    }, patch || {});
}

function rows() {
    return [
        {kind: 'band', band: '20', qsos: 40, points: 120, mults: 12,
            first_ts: '2026-11-08T12:01:00.000Z', last_ts: '2026-11-08T12:20:00.000Z'},
        {kind: 'bucket', bucket: '2026-11-08T12:00:00.000Z', qsos: 40, points: 120,
            mults: 12, spots: 0}
    ];
}

function advice(patch) {
    return engine.buildAdvice({
        settings: settings(patch),
        rows: rows(),
        prop: {},
        radio: {freqKhz: 14025, mode: 'CW', isRunning: true},
        activeEntities: 342,
        cooldown: {},
        now: NOW
    });
}

test('规则文件包含九个可选赛事中的七个结构化家族', () => {
    const raw = JSON.parse(fs.readFileSync(contestRules.RULES_PATH, 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    for (const family of FAMILIES) {
        const entry = raw.contests[family];
        assert.ok(entry, `${family} missing`);
        assert.ok(Array.isArray(entry.sources) && entry.sources.length, `${family} sources`);
        assert.equal(entry.sources[0].ok, true, `${family} first source fetched`);
        assert.ok(entry.sources[0].fetchedAt, `${family} fetchedAt`);
        assert.ok(Array.isArray(entry.modes) && entry.modes.length, `${family} modes`);
        assert.ok(entry.bands === 'unknown' || Array.isArray(entry.bands), `${family} bands`);
    }
    assert.equal(contestRules.familyOf('CQWW_RTTY'), 'CQWW_RTTY');
    assert.equal(contestRules.familyOf('WAE'), 'WAE');
});

test('CQWW RTTY 与 WAE 都有抓取到的波段与比赛时段', () => {
    const rtty = contestRules.constraintsFor(settings({contestType: 'CQWW_RTTY'}), 'CQWW_RTTY');
    assert.equal(rtty.structured, true);
    assert.deepEqual(rtty.bands, ['80m', '40m', '20m', '15m', '10m']);
    assert.deepEqual(rtty.modes, ['RTTY']);
    assert.equal(rtty.multiplierCounting, 'dxcc-per-band');

    const wae = contestRules.constraintsFor(settings({contestType: 'WAE', category: 'MS'}), 'WAE');
    assert.equal(wae.structured, true);
    assert.deepEqual(wae.bands, ['80m', '40m', '20m', '15m', '10m']);
    assert.equal(wae.bandChange.rule, 'time-lock');
    assert.equal(wae.source.includes('wae-dx-contest'), true);
});

test('OTHER 与 AUTO 的回退是显式且可查询的', () => {
    for (const type of ['OTHER', 'AUTO']) {
        const info = contestRules.describe(type);
        assert.equal(info.structured, false);
        assert.equal(info.fallback, 'settings-config');
        assert.ok(info.reason);
        const book = contestRules.constraintsFor(settings({contestType: type}), type);
        assert.equal(book.structured, false);
        assert.equal(book.fallback, 'settings-config');
        assert.equal(book.available, false);
    }
    assert.equal(contestRules.describe('CQWW').structured, true);
    assert.equal(contestRules.describe('CQWW').fallback, null);
});

test('CQ WW M2：规则文件给 2 个信号与每小时 8 次，设置可覆盖', () => {
    const book = contestRules.constraintsFor(settings(), 'CQWW');
    assert.equal(book.multiplierCounting, 'dxcc-per-band');
    assert.equal(book.simultaneousSignals, 2);
    assert.deepEqual(book.bandChange, {rule: 'hourly-quota', limitPerHour: 8});

    const base = advice();
    assert.equal(base.contest.bandChangeRule, 'hourly-quota');
    assert.equal(base.contest.limit, 8);
    assert.equal(base.gates.quota, 8);

    const override = advice({bandChangeLimit: 5});
    assert.equal(override.contest.limit, 5);
    assert.equal(override.gates.quota, 5);
});

test('CQ WPX 默认乘数计法来自规则文件，设置可覆盖', () => {
    const wpx = advice({contestType: 'CQWPX'});
    assert.equal(wpx.contest.multMode, 'wpx');

    const manual = advice({contestType: 'CQWPX', multMode: 'dxcc-total'});
    assert.equal(manual.contest.multMode, 'dxcc-total');
});

test('CQ WW MS：规则文件给 10 分钟时间锁与乘数台身份', () => {
    const book = contestRules.constraintsFor(settings({category: 'MS'}), 'CQWW');
    assert.equal(book.bandChange.rule, 'time-lock');
    assert.equal(book.multiplierStationRole, 'mult');

    const out = advice({category: 'MS'});
    assert.equal(out.contest.bandChangeRule, 'time-lock');
    assert.equal(out.contest.msRole, 'mult');
    const ids = out.advice.map(item => item.id);
    assert.ok(ids.includes('G3'), ids.join(','));
});

test('MM 与 CQ 160 的规则门控不被规则文件破坏', () => {
    const mm = advice({category: 'MM'});
    assert.equal(mm.gates.blockBandChange, 'G9');
    assert.equal(mm.contest.simultaneousSignals, 6);

    const cq160 = advice({contestType: 'CQ160', category: 'SO1R'});
    assert.equal(cq160.gates.blockBandChange, 'G7');
});

test('规则缺失时回落到内置配额，未知值不会被当成 0', () => {
    const arrl = advice({contestType: 'ARRL_DX'});
    assert.equal(arrl.gates.quota, 6);
    assert.equal(contestRules.constraintsFor(settings({category: 'M2'}), 'ARRL_DX').bandChange, null);
    assert.equal(contestRules.familyOf('OTHER'), null);
    assert.equal(contestRules.familyOf('AUTO'), null);
    assert.equal(contestRules.describe('OTHER').fallback, 'settings-config');
});

test('席位数与席位-电台绑定进入决策模块输出', () => {
    const out = advice({seatCount: 2, seatRadios: '1,2'});
    assert.equal(out.contest.seatCount, 2);
    assert.equal(out.contest.seatRadios, '1,2');
    assert.ok(out.rulesSource || out.contest.rulesSource);
});
