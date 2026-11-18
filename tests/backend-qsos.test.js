'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const qsoApi = require('../lib/qsos');
const storage = require('../lib/storage');

const NOW = new Date('2026-11-08T12:34:00.000Z');

function contact() {
    return {contactreplace: {
        ID: ['{ABC-1}'], timestamp: ['2026-11-08 12:30:00'], mycall: ['N0CALL'],
        operator: ['OP'], call: ['k1abc'], band: ['20'], rxfreq: ['1407400'], mode: ['CW'],
        snt: ['599'], rcv: ['579'], exchange1: [''], section: ['CT'], zone: ['05'],
        gridsquare: ['PM95'], countryprefix: ['K'], continent: ['NA'], points: ['2'],
        ismultiplier1: ['1'], ismultiplier2: ['0'], ismultiplier3: ['1'],
        contestname: ['CQWW'], radionr: ['2'], StationName: ['Remote']
    }};
}

test('representative N1MM contactreplace XML object preserves UTC, multiplier and dynamic radioNr', () => {
    assert.equal(qsoApi.routeContact(contact()), 'contactreplace');
    const qso = qsoApi.parseContact(contact(), NOW);
    assert.equal(qso.n1mmId, 'DXI|REMOTE|{ABC-1}');
    assert.equal(qso.instance, 'REMOTE');
    assert.equal(qso.call, 'K1ABC');
    assert.equal(qso.ts, '2026-11-08T12:30:00.000Z');
    assert.equal(qso.freqKhz, 14074);
    assert.equal(qso.exchange, 'CT');
    assert.equal(qso.points, 2);
    assert.equal(qso.isMult, true);
    assert.equal(qso.radioNr, '2');
    assert.equal(qso.stationName, 'Remote');
    assert.deepEqual({lat: qso.lat, lon: qso.lon}, {lat: 40, lon: 149});
});

test('QSO coordinate lookup keeps QRZ, grid then spots priority', () => {
    const withGrid = qsoApi.parseContact(contact(), NOW);
    assert.equal(qsoApi.coordinateRoute(withGrid, true), 'qrz');
    assert.equal(qsoApi.coordinateRoute(withGrid, false), 'broadcast');
    const noGrid = {...withGrid, lat: null, lon: null};
    assert.equal(qsoApi.coordinateRoute(noGrid, false), 'spots');
    assert.match(qsoApi.coordinateTopic(noGrid), /spot_call = 'K1ABC'/);
    qsoApi.applySpotCoords(noGrid, [{dx_lat: 12.5, dx_lon: -45}]);
    assert.equal(noGrid.lat, 12.5);
    assert.equal(noGrid.lon, -45);
    assert.equal(qsoApi.coordinateRoute({type: 'qsoDelete'}, true), 'broadcast');
});

test('spots fallback coordinates are persisted for the live QSO chain', () => {
    const hit = {n1mmId: 'DXI|REMOTE|{ABC-1}', call: 'K1ABC', lat: null, lon: null};
    assert.match(qsoApi.spotCoordsUpdate(hit, [{dx_lat: 12.5, dx_lon: -45}]),
        /UPDATE qsos SET lat=12\.5, lon=-45 WHERE n1mm_id='DXI\|REMOTE\|\{ABC-1\}';/);
    // 数据库已有坐标时绝不覆盖（QRZ / 网格反算优先）。
    assert.equal(qsoApi.spotCoordsUpdate({...hit, lat: 40, lon: 149}, [{dx_lat: 12.5, dx_lon: -45}]), null);
    // 没有 n1mm_id 无法定位行。
    assert.equal(qsoApi.spotCoordsUpdate({call: 'K1ABC', lat: null}, [{dx_lat: 12.5, dx_lon: -45}]), null);
    assert.equal(qsoApi.spotCoordsUpdate(hit, []), null);
    assert.equal(qsoApi.spotCoordsUpdate(hit, undefined), null);
    assert.equal(qsoApi.spotCoordsUpdate(hit, [{dx_lat: null, dx_lon: null}]), null);
    // 只有一半坐标时不落库，否则会写出一行永远画不出来的记录。
    assert.equal(qsoApi.spotCoordsUpdate(hit, [{dx_lat: 12.5, dx_lon: null}]), null);
    assert.equal(qsoApi.spotCoordsUpdate(null, [{dx_lat: 12.5}]), null);
    // 只生成 SQL，不改动内存对象，广播仍由 applySpotCoords 负责。
    assert.equal(hit.lat, null);
});

test('historical coord backfill only touches NULL rows that spots can resolve', () => {
    const sql = storage.qso.backfillCoords(500);
    assert.match(sql, /^UPDATE qsos SET lat = \(SELECT s\.dx_lat FROM spots s/);
    assert.match(sql, /lon = \(SELECT s\.dx_lon FROM spots s WHERE s\.spot_call = qsos\.call/);
    assert.match(sql, /AND s\.dx_lat IS NOT NULL AND s\.dx_lon IS NOT NULL ORDER BY s\.id DESC LIMIT 1\)/);
    assert.match(sql, /WHERE id IN \(SELECT q\.id FROM qsos q WHERE q\.lat IS NULL/);
    assert.match(sql, /AND EXISTS \(SELECT 1 FROM spots s WHERE s\.spot_call = q\.call AND s\.dx_lat IS NOT NULL AND s\.dx_lon IS NOT NULL\)/);
    assert.match(sql, /ORDER BY q\.id DESC LIMIT 500\);$/);
    // EXISTS 兜住后不会有行被写成 NULL，也不会覆盖 QRZ/网格已有坐标。
    assert.doesNotMatch(sql, /SET lat=NULL|SET lat = NULL|ELSE NULL/i);
    assert.match(storage.qso.backfillCoords(), /LIMIT 5000\);$/);
    assert.match(storage.qso.backfillCoords(0), /LIMIT 5000\);$/);
    assert.match(storage.qso.backfillCoords(-5), /LIMIT 1\);$/);
    assert.match(storage.qso.backfillCoords(999999), /LIMIT 50000\);$/);
    assert.match(storage.qso.backfillCoords('abc'), /LIMIT 5000\);$/);
});

test('RadioInfo and Score update current and per-radio station state', () => {
    class Context {
        constructor() { this.values = {}; }
        get(k) { return this.values[k]; }
        set(k, v) { this.values[k] = v; }
    }
    const ctx = new Context();
    // 真实 N1MM 的 RadioInfo 带 StationName，席位按它识别（无 ComputerName 时亦然）。
    const radio = qsoApi.saveRadio(ctx, {RadioInfo: {RadioNr: ['2'], Freq: ['1407400'],
        TXFreq: ['14.074'], Mode: ['CW'], IsRunning: ['True'], ActiveRadioNr: ['1'],
        StationName: ['Remote']}}, NOW);
    assert.equal(radio.freqKhz, 14074);
    assert.equal(radio.txFreqKhz, 14074);
    assert.equal(radio.isRunning, true);
    assert.equal(radio.seat, 'REMOTE:2');
    assert.equal(ctx.get('radioStates')['REMOTE:2'], radio);
    const score = qsoApi.saveScore(ctx, {dynamicresults: {contest: ['CQWW'], score: ['123.5'],
        breakdown: [{$: {}, qso: [{$: {band: 'total', mode: 'ALL'}, _: '10'}],
            mult: [{$: {band: 'total', mode: 'ALL'}, _: '4'}],
            points: [{$: {band: 'total', mode: 'ALL'}, _: '30'}]}]}}, NOW);
    assert.deepEqual([score.qsos, score.mults, score.points, score.score], [10, 4, 30, 123.5]);
    assert.equal(qsoApi.stationState(ctx).score, score);
});

test('frequency claims enforce same-frequency ownership and release authorization', () => {
    const values = {radioStates: {
        'PC-A:1': {seat: 'PC-A:1', opCall: 'OPA', stationName: 'Alpha'},
        'PC-B:1': {seat: 'PC-B:1', opCall: 'OPB', stationName: 'Beta'}
    }};
    const ctx = {get: key => values[key], set: (key, value) => { values[key] = value; }};
    const at = new Date('2026-11-12T00:00:00Z');
    const first = qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'pc-a:1', freqKhz: 14025}, at);
    assert.equal(first.ok, true);
    assert.equal(first.claim.owner, 'PC-A:1');
    assert.equal(first.claim.operator, 'OPA');
    assert.deepEqual(qsoApi.stationState(ctx).claims, first.claims);

    const conflict = qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'PC-B:1', freqKhz: '14025.000'}, at);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.error, 'frequency-claimed');
    assert.equal(conflict.owner.seat, 'PC-A:1');
    const forbidden = qsoApi.changeFrequencyClaim(ctx, 'release', {seat: 'PC-B:1', freqKhz: 14025}, at);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.error, 'not-claim-owner');

    const released = qsoApi.changeFrequencyClaim(ctx, 'release', {seat: 'PC-A:1', freqKhz: 14025}, at);
    assert.equal(released.ok, true);
    assert.equal(released.changed, true);
    assert.deepEqual(released.claims, []);
    const second = qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'PC-B:1', freqKhz: 14025}, at);
    assert.equal(second.ok, true);
    assert.equal(second.claim.operator, 'OPB');
});

test('a new claim replaces only the same seat old claim and validates input', () => {
    const values = {};
    const ctx = {get: key => values[key], set: (key, value) => { values[key] = value; }};
    const at = new Date('2026-11-12T00:00:00Z');
    qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'PC-A:1', freqKhz: 14025}, at);
    qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'PC-B:1', freqKhz: 7025}, at);
    const moved = qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'PC-A:1', freqKhz: 21025}, at);
    assert.deepEqual(moved.claims.map(claim => claim.freqKhz), [7025, 21025]);
    const idempotent = qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'PC-A:1', freqKhz: 21025}, at);
    assert.equal(idempotent.changed, false);
    assert.equal(qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: '', freqKhz: 14025}, at).status, 400);
    assert.equal(qsoApi.changeFrequencyClaim(ctx, 'claim', {seat: 'PC-A:1', freqKhz: -1}, at).status, 400);
    assert.equal(qsoApi.changeFrequencyClaim(ctx, 'other', {seat: 'PC-A:1', freqKhz: 14025}, at).status, 400);
});

test('QRZ success updates coordinates and session failures request relogin', () => {
    const qso = {n1mmId: "id'1", call: 'K1ABC', lat: null, lon: null};
    const ok = qsoApi.parseResult({QRZDatabase: {Callsign: [{lat: [{_: '12.5'}], lon: [{_: '-45'}]}]}}, qso);
    assert.equal(ok.kind, 'coords');
    assert.equal(qso.lat, 12.5);
    assert.match(ok.topic, /UPDATE qsos SET lat=12.5, lon=-45/);
    const failure = qsoApi.parseResult({QRZDatabase: {Session: [{Error: [{_: 'Session timeout'}]}]}}, qso);
    assert.equal(failure.kind, 'sessionError');
    assert.match(qsoApi.callsignQuery(qso, 'secret').url, /callsign=K1ABC/);
});
