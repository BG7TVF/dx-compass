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
        global: new Context({monitoredCalls: ['K1ABC'], uiSettings: {myCall: 'N0CALL'},
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
    const raw = {sq: 123, f: 14074000, md: 'FT8', rp: -8,
        t: Math.floor(NOW / 1000) - 3700, sc: 'K1ABC', sl: 'PM95', rc: 'DE.1', rl: 'JN58'};
    const result = spots.ingest('pskr', raw, e);
    assert.equal(result.records.length, 1);
    assert.equal(result.fresh.length, 0);
    assert.equal(result.records[0].spot_id, -123);
    assert.equal(result.records[0].de, 'DE/1');
    assert.equal(result.records[0].freq, 14074);
    assert.equal(result.records[0].mode, 'DIGI');
    assert.equal(spots.ingest('pskr', raw, e).records.length, 0);
    e.global.set('monitoring', false);
    assert.equal(spots.liveRequest(e), null);
});

test('PSKR subscriptions include own call and unsubscribe removed topics', () => {
    const e = env();
    e.flow.set('pskrSubs', {'pskr/filter/v2/+/+/OLD/#': {qos: 0}});
    const result = spots.syncPskrSubscriptions(e);
    assert.deepEqual(result.actions[0], {action: 'unsubscribe', topic: 'pskr/filter/v2/+/+/OLD/#'});
    assert.ok(result.actions.some(a => a.topic === 'pskr/filter/v2/+/+/N0CALL/#'));
});
