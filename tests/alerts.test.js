'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');

const service = require('../lib/alerts/service.js');
const rank = require('../lib/alerts/rank.js');
const sql = require('../lib/storage/alert-sql.js');

const NOW = Math.floor(Date.parse('2026-11-11T12:00:00Z') / 1000);

const ENTITIES = {
    K1ABC: {dxcc: 291, country: 'United States', prefix: 'K', deleted: false},
    DL1ABC: {dxcc: 230, country: 'Fed. Rep. of Germany', prefix: 'DL', deleted: false},
    'KH8/S': {dxcc: 515, country: 'Swains Island', prefix: 'KH8', deleted: false},
    VQ9X: {dxcc: 33, country: 'Chagos Is.', prefix: 'VQ9', deleted: true}
};

function resolve(call) {
    return ENTITIES[String(call || '').toUpperCase()] || null;
}

function rule(patch) {
    const result = service.normalizeRule(Object.assign({
        name: 'test', enabled: 1, popup: 1, sound: 1
    }, patch || {}));
    assert.equal(result.ok, true, result.error);
    return result.rule;
}

function baseSettings(patch) {
    return Object.assign({
        alertsEnabled: true,
        alertMinIntervalSec: 0,
        alertDedupeMin: 10,
        alertPopup: true,
        alertSound: false,
        qsoVoiceAlert: true,
        freqDeltaKhz: 1
    }, patch || {});
}

function spot(patch) {
    return Object.assign({
        spot_call: 'K1ABC',
        band: '20m',
        mode: 'CW',
        freq: 14025.0,
        snr: 18,
        source: 'rbn',
        de: 'DL1ABC',
        comment: 'CW 28 WPM'
    }, patch || {});
}

function indexWith(rows, windowFrom, windowTo) {
    return rank.buildIndex(rows, resolve, windowFrom, windowTo);
}

test('规则规范化：列表、波段小写、布尔默认值', () => {
    const result = service.normalizeRule({
        name: '  EU 20m  ',
        call: ' dl1abc , k1abc/p ',
        band: '20M, 40M',
        mode: 'cw',
        snrMin: '10',
        voice: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.rule.name, 'EU 20m');
    assert.equal(result.rule.call, 'DL1ABC,K1ABC/P');
    assert.equal(result.rule.band, '20m,40m');
    assert.equal(result.rule.mode, 'CW');
    assert.equal(result.rule.snrMin, 10);
    assert.equal(result.rule.voice, 1);
    assert.equal(result.rule.popup, 1);
    assert.equal(result.rule.sound, 1);
});

test('规则规范化：名称与正向条件必填', () => {
    assert.equal(service.normalizeRule({call: 'K1ABC'}).error, 'name-required');
    assert.equal(service.normalizeRule({name: 'empty'}).error, 'condition-required');
    assert.equal(service.normalizeRule({name: 'wildcard only', call: ''}).error, 'condition-required');
});

test('fromRow 把 snake_case 行还原成规则对象', () => {
    const mapped = service.fromRow({
        id: 7,
        name: 'DL',
        enabled: 0,
        call: 'DL1ABC',
        band: '20m',
        snr_min: 12,
        popup: 0,
        voice: 1,
        sound: 1
    });
    assert.equal(mapped.id, 7);
    assert.equal(mapped.enabled, 0);
    assert.equal(mapped.snrMin, 12);
    assert.equal(mapped.popup, 0);
    assert.equal(mapped.voice, 1);
    assert.equal(mapped.sound, 1);
});

test('匹配：字段之间 AND，字段内部逗号列表 OR，支持尾部通配', () => {
    const ctx = {
        now: NOW, call: 'DL1ABC', band: '20m', mode: 'CW', source: 'rbn',
        dxcc: 230, prefix: 'DL', snr: 20, wpm: 28
    };
    assert.equal(service.matchRule(rule({call: 'K1ABC,DL*', band: '20m,40m', mode: 'CW,SSB'}), ctx), true);
    assert.equal(service.matchRule(rule({call: 'DL*', band: '40m'}), ctx), false);
    assert.equal(service.matchRule(rule({prefix: 'DL', snrMin: 15, wpmMin: 25}), ctx), true);
    assert.equal(service.matchRule(rule({prefix: 'DL', snrMin: 25}), ctx), false);
});

test('匹配：负向条件命中即排除，禁用规则不参与', () => {
    const ctx = {
        now: NOW, call: 'DL1ABC', band: '20m', mode: 'CW', source: 'rbn',
        dxcc: 230, prefix: 'DL', snr: 20, wpm: null
    };
    assert.equal(service.matchRule(rule({prefix: 'DL', notCall: 'DL1ABC'}), ctx), false);
    assert.equal(service.matchRule(rule({prefix: 'DL', notBand: '40m'}), ctx), true);
    assert.equal(service.matchRule(rule({prefix: 'DL', notSource: 'rbn'}), ctx), false);
    assert.equal(service.matchRule(rule({prefix: 'DL', enabled: 0}), ctx), false);
});

test('匹配：生效时间窗按 UTC 闭区间', () => {
    const ctx = {now: NOW, call: 'K1ABC', band: '20m', mode: 'CW', source: 'rbn', dxcc: 291, prefix: 'K', snr: 10, wpm: null};
    const before = rule({call: 'K1ABC', from: '2026-11-11T13:00:00Z'});
    const open = rule({call: 'K1ABC', from: '2026-11-11T11:00:00Z', to: '2026-11-11T13:00:00Z'});
    assert.equal(service.matchRule(before, ctx), false);
    assert.equal(service.matchRule(open, ctx), true);
});

test('评估：总开关关闭时不产出告警', () => {
    const out = service.evaluate(spot(), {
        settings: baseSettings({alertsEnabled: false}),
        rules: [rule({call: 'K1ABC'})],
        state: {now: NOW, dedupe: {}, lastAlertAt: 0},
        resolve
    });
    assert.equal(out.alert, null);
    assert.equal(out.reason, 'disabled');
});

test('评估：命中后给出优先级、触发规则与通知门控', () => {
    const out = service.evaluate(spot(), {
        settings: baseSettings(),
        rules: [rule({name: 'US 20m', call: 'K1ABC', voice: 1}), rule({name: 'US CW', prefix: 'K', mode: 'CW'})],
        index: indexWith([], null),
        history: {},
        state: {now: NOW, dedupe: {}, lastAlertAt: 0},
        resolve
    });
    assert.equal(out.reason, 'alert');
    assert.equal(out.alert.kind, 'newBand');
    assert.equal(out.alert.call, 'K1ABC');
    assert.equal(out.alert.state, 'newMultiplier');
    assert.equal(out.alert.priority, 0);
    assert.equal(out.alert.ruleNames, 'US 20m, US CW');
    assert.equal(out.alert.rules.length, 2);
    assert.equal(out.alert.notify.popup, true);
    assert.equal(out.alert.notify.sound, false);
    assert.equal(out.alert.notify.voice, true);
    assert.equal(out.alert.country, 'United States');
});

test('评估：同波段频率在阈值内不提醒，超出阈值报新频率', () => {
    const history = {};
    const settings = baseSettings();
    const rules = [rule({call: 'K1ABC'})];
    const first = service.evaluate(spot(), {
        settings, rules, history, state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(first.reason, 'alert');
    assert.equal(first.alert.kind, 'newBand');
    const repeat = service.evaluate(spot({freq: 14025.4}), {
        settings, rules, history,
        state: {now: NOW + 60, dedupe: {}, lastAlertAt: first.lastAlertAt}, resolve
    });
    assert.equal(repeat.reason, 'duplicate');
    assert.equal(repeat.alert, null);
    const moved = service.evaluate(spot({freq: 14040.0}), {
        settings, rules, history,
        state: {now: NOW + 120, dedupe: {}, lastAlertAt: first.lastAlertAt}, resolve
    });
    assert.equal(moved.reason, 'alert');
    assert.equal(moved.alert.kind, 'newFreq');
    assert.equal(moved.alert.previous.band, '20m');
});

test('评估：其他波段仍在 TTL 内报新频段', () => {
    const history = {};
    const settings = baseSettings();
    const rules = [rule({call: 'K1ABC'})];
    service.evaluate(spot(), {
        settings, rules, history, state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    const other = service.evaluate(spot({band: '40m', freq: 7025}), {
        settings, rules, history, state: {now: NOW + 60, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(other.reason, 'alert');
    assert.equal(other.alert.kind, 'newBand');
    assert.equal(other.alert.previous.band, '20m');
});

test('评估：原有波段超出 TTL 后换台报换频段', () => {
    const history = {};
    const settings = baseSettings({ttl: {CW: 1, SSB: 1, DIGI: 1}});
    service.evaluate(spot(), {
        settings, history, state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    const moved = service.evaluate(spot({band: '40m', freq: 7025}), {
        settings, history, state: {now: NOW + 120, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(moved.reason, 'alert');
    assert.equal(moved.alert.kind, 'bandChange');
    assert.equal(moved.alert.previous.band, '20m');
});

test('评估：同波段即使记录过期也只按频率阈值判断', () => {
    const history = {};
    const settings = baseSettings({ttl: {CW: 1, SSB: 1, DIGI: 1}});
    service.evaluate(spot(), {
        settings, history, state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    const same = service.evaluate(spot(), {
        settings, history, state: {now: NOW + 120, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(same.reason, 'duplicate');
    const moved = service.evaluate(spot({freq: 14035}), {
        settings, history, state: {now: NOW + 180, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(moved.reason, 'alert');
    assert.equal(moved.alert.kind, 'newFreq');
});

test('评估：同一波段组合在去重窗口内只提醒一次', () => {
    const history = {
        K1ABC: {
            bands: {
                '20m': {freq: 14020, at: NOW - 10, mode: 'CW'},
                '40m': {freq: 7010, at: NOW - 20, mode: 'CW'}
            },
            combo: '20m+40m',
            comboAt: NOW - 60
        }
    };
    const out = service.evaluate(spot({band: '40m', freq: 7015}), {
        settings: baseSettings(), history, state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(out.reason, 'band-combo');
    assert.equal(out.alert, null);
});

test('评估：只对监控呼号告警，我的 SPOT 交给前端批量处理', () => {
    const history = {};
    const settings = baseSettings({myCall: 'BG7TVF'});
    const other = service.evaluate(spot(), {
        settings, history, monitored: ['DL1ABC'], state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(other.reason, 'not-monitored');
    const mine = service.evaluate(spot({spot_call: 'BG7TVF'}), {
        settings, history, monitored: ['BG7TVF'], state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(mine.reason, 'my-spot');
    assert.equal(mine.alert, null);
});

test('评估：没有规则行时三类内置对手告警照常工作', () => {
    const out = service.evaluate(spot(), {
        settings: baseSettings(), rules: [], history: {},
        state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(out.reason, 'alert');
    assert.equal(out.alert.kind, 'newBand');
    assert.equal(out.alert.ruleNames, '');
    assert.equal(out.alert.notify.voice, true);
    assert.equal(out.alert.notify.popup, true);
});

test('评估：全局最短间隔只节流，不写入告警', () => {
    const rules = [rule({name: 'any K', prefix: 'K'}), rule({name: 'any DL', prefix: 'DL'})];
    const history = {};
    const first = service.evaluate(spot(), {
        settings: baseSettings(), rules, history,
        state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    const throttled = service.evaluate(spot({spot_call: 'DL1ABC', freq: 14030, de: 'K1ABC'}), {
        settings: baseSettings({alertMinIntervalSec: 120}), rules, history,
        state: {now: NOW + 30, dedupe: {}, lastAlertAt: first.lastAlertAt}, resolve
    });
    assert.equal(throttled.reason, 'throttled');
    assert.equal(throttled.alert, null);
    assert.equal(throttled.hit.suppressed, 'throttled');
    assert.equal(throttled.hit.notified, false);
    assert.deepEqual(throttled.dedupe, {});
});

test('评估：语音与弹窗门控跟随设置开关', () => {
    const rules = [rule({call: 'K1ABC', voice: 1, popup: 1})];
    const quiet = service.evaluate(spot(), {
        settings: baseSettings({qsoVoiceAlert: false}), rules, history: {},
        state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(quiet.alert.notify.voice, false);
    assert.equal(quiet.alert.notify.popup, true);
    const loud = service.evaluate(spot(), {
        settings: baseSettings(), rules, history: {},
        state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(loud.alert.notify.voice, true);
    const noPopup = service.evaluate(spot(), {
        settings: baseSettings({alertPopup: false}), rules, history: {},
        state: {now: NOW, dedupe: {}, lastAlertAt: 0}, resolve
    });
    assert.equal(noPopup.alert.notify.popup, false);
});

test('索引：newMultiplier > newBand > rare > other，窗口外不参与', () => {
    const rows = [
        {timestamp: '2026-11-11T10:00:00Z', call: 'K1ABC', band: '20m'},
        {timestamp: '2026-11-09T10:00:00Z', call: 'DL1ABC', band: '20m'},
        {timestamp: '2026-11-11T10:30:00Z', call: 'VQ9X', band: '20m'}
    ];
    const from = Date.parse('2026-11-11T00:00:00Z') / 1000;
    const index = indexWith(rows, from);
    assert.equal(rank.stateFor(291, '20m', index).state, 'other');
    assert.equal(rank.stateFor(291, '40m', index).state, 'newBand');
    assert.equal(rank.stateFor(230, '20m', index).state, 'newMultiplier');
    assert.equal(rank.stateFor(33, '20m', index).state, 'rare');
    assert.equal(rank.stateFor(null, '20m', index).state, 'unknown');
});

test('窗口：优先设置，其次按最近一届赛事推断', () => {
    const rows = [
        {timestamp: '2026-11-09T08:00:00Z', call: 'K1ABC', band: '20m', contestname: 'OLD'},
        {timestamp: '2026-11-11T08:00:00Z', call: 'DL1ABC', band: '20m', contestname: 'NEW'},
        {timestamp: '2026-11-11T18:00:00Z', call: 'DL1ABC', band: '40m', contestname: 'NEW'}
    ];
    const derived = service.windowFor(rows, {});
    assert.equal(derived.source, 'derived');
    assert.equal(derived.contest, 'NEW');
    assert.equal(derived.from, Date.parse('2026-11-11T08:00:00Z') / 1000);
    assert.equal(derived.to, Date.parse('2026-11-11T18:00:00Z') / 1000);

    const fromSettings = service.windowFor(rows, {
        wallTimerStart: '2026-11-10T00:00', wallTimerEnd: '2026-11-12T00:00'
    });
    assert.equal(fromSettings.source, 'settings');
    assert.equal(fromSettings.from, Date.parse('2026-11-10T00:00:00Z') / 1000);
});

test('聚合：recordHit 同一 call|band 在窗口内折叠并累计来源与次数', () => {
    let hits = [];
    hits = rank.recordHit(hits, {
        at: '2026-11-11T11:59:00Z', call: 'K1ABC', band: '20m', source: 'rbn',
        priority: 1, state: 'newBand', rules: [{id: 1, name: 'A'}], notified: true
    }, 50, 600, NOW);
    hits = rank.recordHit(hits, {
        at: '2026-11-11T11:59:30Z', call: 'k1abc', band: '20M', source: 'dxwatch',
        priority: 1, state: 'newBand', rules: [{id: 1, name: 'A'}], notified: false
    }, 50, 600, NOW);
    hits = rank.recordHit(hits, {
        at: '2026-11-11T11:58:00Z', call: 'DL1ABC', band: '40m', source: 'pskr',
        priority: 0, state: 'newMultiplier', rules: [{id: 2, name: 'B'}], notified: true
    }, 50, 600, NOW);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].call, 'DL1ABC');
    const grouped = hits[1];
    assert.equal(grouped.reports, 2);
    assert.deepEqual(grouped.sources.sort(), ['dxwatch', 'rbn']);
    assert.equal(grouped.ruleNames, 'A');
    assert.equal(grouped.notified, true);
    assert.equal(grouped.at, '2026-11-11T11:59:30Z');
});

test('聚合：窗口外不合并，规则合并，priority 取更优先，cap 截断', () => {
    const base = {
        call: 'K1ABC', band: '20m', source: 'rbn', priority: 2,
        rules: [{id: 1, name: 'A'}], notified: true
    };
    const first = rank.recordHit([], Object.assign({}, base, {at: '2026-11-11T11:55:00Z'}), 50, 600, NOW);
    const old = rank.recordHit([], Object.assign({}, base, {at: '2026-11-11T11:40:00Z'}), 50, 600, NOW);
    const reopened = rank.recordHit(old, Object.assign({}, base, {at: '2026-11-11T11:59:00Z'}), 50, 600, NOW);
    assert.equal(reopened.length, 2);

    const upgraded = rank.recordHit(first, Object.assign({}, base, {
        at: '2026-11-11T11:59:00Z', priority: 0, state: 'newMultiplier', rules: [{id: 2, name: 'B'}]
    }), 50, 600, NOW);
    assert.equal(upgraded.length, 1);
    assert.equal(upgraded[0].priority, 0);
    assert.equal(upgraded[0].state, 'newMultiplier');
    assert.equal(upgraded[0].ruleNames, 'A, B');

    let many = [];
    for (let i = 0; i < 5; i += 1) {
        many = rank.recordHit(many, {
            at: new Date((NOW + i) * 1000).toISOString(), call: `K${i}ABC`, band: '20m',
            source: 'rbn', priority: 3, rules: [{id: 1, name: 'A'}], notified: true
        }, 3, 600, NOW + i);
    }
    assert.equal(many.length, 3);
});

test('排序：优先级升序，同优先级时间新者在前', () => {
    const sorted = rank.rankAlerts([
        {at: '2026-11-11T11:00:00Z', call: 'A', priority: 3},
        {at: '2026-11-11T11:30:00Z', call: 'B', priority: 1},
        {at: '2026-11-11T11:40:00Z', call: 'C', priority: 1},
        {at: '2026-11-11T11:50:00Z', call: 'D', priority: 0}
    ]);
    assert.deepEqual(sorted.map(item => item.call), ['D', 'C', 'B', 'A']);
});

test('去重键与频率容差：缺频率按重复处理', () => {
    assert.equal(rank.dedupeKey(' k1abc ', '20M'), 'K1ABC|20m');
    assert.equal(rank.isDuplicate({freq: 14025}, 14025.9, 1), true);
    assert.equal(rank.isDuplicate({freq: 14025}, 14027, 1), false);
    assert.equal(rank.isDuplicate({freq: null}, 14025, 1), true);
});

test('规则 SQL：建表、转义、更新、删除与快照', () => {
    assert.match(sql.createTable(), /CREATE TABLE IF NOT EXISTS alert_rules/);
    assert.match(sql.createTable(), /not_source TEXT/);
    const inserted = sql.insert(rule({name: "O'Brien", call: 'K1ABC'}));
    assert.match(inserted, /INSERT INTO alert_rules/);
    assert.match(inserted, /'O''Brien'/);
    assert.match(inserted, /'K1ABC'/);
    assert.equal(sql.update(rule({call: 'K1ABC'})), null);
    const updated = sql.update(rule({id: 4, call: 'K1ABC'}));
    assert.match(updated, /WHERE id = 4;/);
    assert.equal(sql.remove('nope'), null);
    assert.equal(sql.remove(9), 'DELETE FROM alert_rules WHERE id = 9;');
    assert.match(sql.qsoSnapshot(10), /LIMIT 10;/);
    assert.match(sql.list(), /ORDER BY id ASC/);
});
