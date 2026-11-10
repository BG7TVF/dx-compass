'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const spots = require('../lib/spots');

const NOW = Date.parse('2026-11-08T12:00:00.000Z');

class Context {
    constructor(values = {}) { this.values = {...values}; }
    get(key) { return this.values[key]; }
    set(key, value) { this.values[key] = value; }
}

function env(overrides = {}) {
    return {
        global: new Context({monitoredCalls: ['K1ABC'],
            uiSettings: {myCall: 'N0CALL', grid: 'OL42ET'},
            monitoring: true, recording: {active: false}}),
        flow: new Context(),
        now: NOW,
        ...overrides
    };
}

function info(lat, lon) {
    return [null, null, null, null, null, null, lat, lon];
}

function dxwatchFixture() {
    return {
        s: {
            101: ['de-1', '14074.1', 'k1abc', 'FT8 Rcvd: -12 &amp; 599', '12:00', '30'],
            102: ['DE-2', '21074', 'N0CALL', 'CW 25 WPM', '11:00', '3700'],
            103: ['DE-3', '14074', 'OTHER', 'CW', '12:00', '10']
        },
        ci: {
            'DE-1': info(35, 139),
            K1ABC: info(40, -100),
            'DE-2': info(50, 0),
            N0CALL: info(30, -90)
        }
    };
}

test('dxwatch normalization preserves shadow call, DTO fields and one-hour WS gate', () => {
    const e = env();
    const result = spots.ingest('dxwatch', dxwatchFixture(), e);
    assert.equal(result.records.length, 2);
    assert.equal(result.fresh.length, 1);
    assert.equal(result.records[0].monitored_call, 'K1ABC');
    assert.equal(result.records[0].de, 'DE-1');
    assert.equal(result.records[0].comment, 'FT8 Rcvd: -12 & 599');
    assert.equal(result.records[0].snr, -12);
    assert.equal(result.records[0].signal, '599');
    assert.equal(result.records[0].mode, 'DIGI');
    assert.equal(result.records[0].band, '20m');
    assert.equal(result.records[0].timestamp, '2026-11-08T11:59:30.000Z');
    assert.equal(result.records[1].monitored_call, 'N0CALL');
    assert.equal(e.flow.get('lastSpotId'), 102);
    assert.ok(e.flow.get('seenIds')[101]);
    assert.equal(spots.ingest('dxwatch', dxwatchFixture(), e).records.length, 0);
});

test('dxwatch backfill enforces seven days and 150 records without advancing live cursor', () => {
    const e = env({backfillCall: 'K1ABC'});
    e.flow.set('lastSpotId', 99);
    const s = {};
    for (let id = 1; id <= 152; id++) s[id] = ['DE' + id, '14074', 'K1ABC', 'CW', '', '60'];
    s[200] = ['DE', '14074', 'K1ABC', 'CW', '', String(8 * 86400)];
    const result = spots.ingest('dxwatch', {s, ci: {}}, e);
    assert.equal(result.records.length, 150);
    assert.equal(e.flow.get('lastSpotId'), 99);
    assert.ok(!result.records.some(r => r.spot_id === 200));
});

test('RBN shares dedup keys and resets a stale version hash on non-200', () => {
    const e = env();
    spots.ingest('dxwatch', dxwatchFixture(), e);
    const epoch = Math.floor(NOW / 1000) - 30;
    const rbn = {
        lastid_c: 500,
        spots: {500: ['DE-7', '14074.1', 'K1ABC', '20', '24', '11:59', '', '', '', '', String(epoch)]},
        call_info: {}
    };
    const duplicate = spots.ingest('rbn', rbn, {...e, statusCode: 200});
    assert.equal(duplicate.records.length, 0);
    assert.equal(e.flow.get('lastRbnId'), 500);
    e.flow.set('rbnH', 'abc');
    const stale = spots.ingest('rbn', {}, {...e, statusCode: 400});
    assert.equal(stale.refreshHash, true);
    assert.equal(e.flow.get('rbnH'), null);
});

test('PSKR keeps old records for SQLite but suppresses their live output', () => {
    const e = env();
    const raw = {sq: 123, f: 14074000, md: 'FT8', rp: -8, sa: 291, ra: 230,
        t: Math.floor(NOW / 1000) - 3700, sc: 'K1ABC', sl: 'PM95', rc: 'DE.1', rl: 'JN58'};
    const result = spots.ingest('pskr', raw, e);
    assert.equal(result.records.length, 1);
    assert.equal(result.fresh.length, 0);
    assert.equal(result.records[0].spot_id, -123);
    assert.equal(result.records[0].de, 'DE/1');
    assert.equal(result.records[0].freq, 14074);
    assert.equal(result.records[0].mode, 'DIGI');
    assert.equal(result.records[0].sender_grid, 'PM95');
    assert.equal(result.records[0].receiver_grid, 'JN58');
    assert.equal(result.records[0].dxcc_sender, 291);
    assert.equal(result.records[0].dxcc_receiver, 230);
    assert.equal(spots.ingest('pskr', raw, e).records.length, 0);
    e.global.set('monitoring', false);
    assert.equal(spots.liveRequest(e), null);
});

test('PSKR intake accepts local-neighbour spots and rejects unrelated pairs', () => {
    const e = env();
    // 发送方不是监控呼号，但落在本台大网格 OL42 内 → 属于本地邻近台，必须入库。
    const neighbour = {sq: 201, f: 14074000, md: 'FT8', rp: -15, sa: 291, ra: 230,
        t: Math.floor(NOW / 1000) - 60, sc: 'K9NEI', sl: 'OL42AA', rc: 'DE.9', rl: 'JO22'};
    const kept = spots.ingest('pskr', neighbour, e);
    assert.equal(kept.records.length, 1);
    assert.equal(kept.records[0].monitored_call, 'DE/9');

    // 两端都既不在监控列表，也不在 OL42 大网格内 → 拒收。
    const unrelated = {sq: 202, f: 14074000, md: 'FT8', rp: -10,
        t: Math.floor(NOW / 1000) - 60, sc: 'AA1AA', sl: 'FN42', rc: 'DE.9', rl: 'JO22'};
    assert.equal(spots.ingest('pskr', unrelated, e).records.length, 0);
});

test('PSKR subscriptions include own call and unsubscribe removed topics', () => {
    const e = env();
    e.flow.set('pskrSubs', {'pskr/filter/v2/+/+/OLD/#': {qos: 0}});
    const result = spots.syncPskrSubscriptions(e);
    assert.deepEqual(result.actions[0], {action: 'unsubscribe', topic: 'pskr/filter/v2/+/+/OLD/#'});
    const topics = result.actions.map(a => a.topic);
    assert.ok(topics.includes('pskr/filter/v2/+/+/N0CALL/#'));
    assert.ok(topics.includes('pskr/filter/v2/+/+/+/N0CALL/#'));
    assert.ok(topics.includes('pskr/filter/v2_field/+/+/OL/+'));
    assert.ok(topics.includes('pskr/filter/v2_field/+/+/+/OL'));
    // locator 层不支持前缀匹配：不能出现 OL42* 这种非法主题。
    assert.ok(!topics.some(topic => topic.includes('OL42')));
    assert.ok(!topics.some(topic => /v2\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/OL/.test(topic)));
});

test('source switches and poll intervals gate requests and ingestion', () => {
    const off = env();
    off.global.set('uiSettings', {myCall: 'N0CALL', sourceDxwatch: false});
    assert.equal(spots.liveRequest(off), null);
    assert.equal(spots.ingest('dxwatch', dxwatchFixture(), off).records.length, 0);

    const gate = env();
    assert.ok(spots.liveRequest(gate).url.includes('dxwatch.com'));
    assert.equal(spots.liveRequest(gate), null); // 30 s interval not elapsed
    assert.ok(spots.liveRequest({...gate, now: NOW + 31000}));

    const rbnOff = env();
    rbnOff.flow.set('rbnH', 'abc');
    rbnOff.global.set('uiSettings', {sourceRbn: false});
    assert.equal(spots.rbnRequest(rbnOff), null);

    const pskrOff = env();
    pskrOff.global.set('uiSettings', {sourcePskr: false});
    const raw = {sq: 1, f: 14074000, md: 'FT8', rp: -8,
        t: Math.floor(NOW / 1000), sc: 'K1ABC', sl: 'PM95', rc: 'DE.1', rl: 'JN58'};
    assert.equal(spots.ingest('pskr', raw, pskrOff).records.length, 0);
});

test('PSKR regional intake works with the monitor switch off and no monitored calls', () => {
    // 分析页邻台来自本台大网格的区域采集，不能被“开始监控”开关或监控列表挡住。
    const e = env();
    e.global.set('uiSettings', {myCall: 'BG7TVF', grid: 'OL53OP'});
    e.global.set('monitoredCalls', []);
    e.global.set('monitoring', false);
    const t = Math.floor(NOW / 1000) - 60;

    const localRow = {sq: 401, f: 14074000, md: 'FT8', rp: -11, t,
        sc: 'K9OL53', sl: 'OL53AA', rc: 'DE.9', rl: 'JO22'};
    const kept = spots.ingest('pskr', localRow, e);
    assert.equal(kept.records.length, 1);
    assert.equal(kept.records[0].sender_grid, 'OL53AA');

    const remoteRow = {sq: 402, f: 14074000, md: 'FT8', rp: -11, t,
        sc: 'AA1AA', sl: 'FN42', rc: 'DE.9', rl: 'JO22'};
    assert.equal(spots.ingest('pskr', remoteRow, e).records.length, 0);

    // 监控呼号仍然只在“开始监控”后入库。
    e.global.set('monitoredCalls', ['K1ABC']);
    const watched = {sq: 403, f: 14074000, md: 'FT8', rp: -11, t,
        sc: 'K1ABC', sl: 'PM95', rc: 'DE.9', rl: 'JN58'};
    assert.equal(spots.ingest('pskr', watched, e).records.length, 0);
    e.global.set('monitoring', true);
    assert.equal(spots.ingest('pskr', watched, e).records.length, 1);
});

test('PSKR subscriptions rebuild immediately when the grid field changes', () => {
    const e = env();
    const first = spots.syncPskrSubscriptions(e).actions.map(a => a.topic);
    assert.ok(first.includes('pskr/filter/v2_field/+/+/OL/+'));
    // 同步间隔未到，但大网格由 OL 变为 OM：必须立刻重建，不能等 pollPskrSyncSec。
    e.global.set('uiSettings', {myCall: 'N0CALL', grid: 'OM53OP'});
    const second = spots.syncPskrSubscriptions({...e, now: NOW + 1000});
    const topics = second.actions.map(a => a.topic);
    assert.ok(topics.includes('pskr/filter/v2_field/+/+/OM/+'));
    assert.ok(topics.includes('pskr/filter/v2_field/+/+/+/OM'));
    assert.ok(second.actions.some(a => a.action === 'unsubscribe' && a.topic.endsWith('/OL/+')));
});

test('fresh window follows freshSec instead of the former one-hour constant', () => {
    const stale = {s: {900: ['DE-X', '14074', 'K1ABC', 'CW', '', '3700']}, ci: {}};
    const wide = env();
    wide.global.set('uiSettings', {freshSec: 7200});
    const wideResult = spots.ingest('dxwatch', stale, wide);
    assert.equal(wideResult.records.length, 1);
    assert.equal(wideResult.fresh.length, 1);

    const narrow = env();
    narrow.global.set('uiSettings', {freshSec: 600});
    assert.equal(spots.ingest('dxwatch', stale, narrow).fresh.length, 0);
});
