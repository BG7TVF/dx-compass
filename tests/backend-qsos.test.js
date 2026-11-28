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

test('QRZ conclusion is stored as one statement and never for transient errors', () => {
    const found = {status: 'found', callsign: {call: 'W2IUK', name: "Bob O'Neil", fname: 'Bob',
        country: 'USA', grid: 'FN31PR', dxcc: '291', lat: '41.7', lon: '-72.6', qslmgr: ''}};
    const sql = storage.qrz.upsert('w2iuk ', found, '2026-11-28T01:02:03.000Z');
    assert.match(sql, /^INSERT INTO qrz_calls \(/);
    assert.match(sql, /VALUES \('W2IUK', 'found'/);
    // 单引号必须转义，否则会拼坏语句。
    assert.match(sql, /'Bob O''Neil'/);
    assert.match(sql, /'2026-11-28T01:02:03\.000Z', '2026-11-28T01:02:03\.000Z'\)/);
    // 换波段重复遇到同一呼号：只更新结论，first_seen 保留首次时间。
    assert.match(sql, /ON CONFLICT\(call\) DO UPDATE SET status = excluded\.status/);
    assert.match(sql, /first_seen = qrz_calls\.first_seen, last_seen = excluded\.last_seen;$/);
    // sqlite 节点的 msg.topic 模式走 db.all，只能喂一条语句。
    assert.equal(sql.split(';').filter(part => part.trim()).length, 1);
    // 经纬度写成数值，空字段写 NULL，qslmgr 为空不落成空串。
    assert.match(sql, /41\.7, -72\.6, NULL, '2026/);
    assert.doesNotMatch(sql, /'', '2026-11-28/);

    const missing = storage.qrz.upsert('VE3XYZ', {status: 'not-found', error: 'Callsign not found'});
    assert.match(missing, /VALUES \('VE3XYZ', 'not-found'/);
    assert.match(missing, /NULL, NULL, NULL, 'Callsign not found'/);
    // 会话/网络错误不入库，下次照常重试。
    assert.equal(storage.qrz.upsert('VE3XYZ', {status: 'error', error: 'Session expired'}), null);
    assert.equal(storage.qrz.upsert('', found), null);
    assert.equal(storage.qrz.upsert('VE3XYZ', null), null);
});

test('qrz_calls table is created idempotently and read back newest-first', () => {
    const ddl = storage.qrz.create();
    assert.equal(ddl.length, 2);
    assert.match(ddl[0], /^CREATE TABLE IF NOT EXISTS qrz_calls \(/);
    assert.match(ddl[0], /call TEXT PRIMARY KEY/);
    assert.match(ddl[0], /first_seen TEXT NOT NULL,\s+last_seen TEXT NOT NULL/);
    assert.match(ddl[1], /^CREATE INDEX IF NOT EXISTS idx_qrz_calls_seen ON qrz_calls\(last_seen\);$/);
    assert.match(storage.qrz.recentQuery(), /^SELECT \* FROM qrz_calls ORDER BY last_seen DESC LIMIT 5000;$/);
    assert.match(storage.qrz.recentQuery(10), /LIMIT 10;$/);
    assert.match(storage.qrz.recentQuery(0), /LIMIT 5000;$/);
    assert.match(storage.qrz.recentQuery(-3), /LIMIT 1;$/);
    assert.match(storage.qrz.recentQuery(999999), /LIMIT 50000;$/);
});

test('stored QRZ rows prime the cache so a band change costs no extra lookup', () => {
    const at = Date.now();
    const iso = ms => new Date(ms).toISOString();
    const rows = [
        {call: 'DL1ABC', status: 'found', name: 'Hans', country: 'Germany', dxcc: '230',
            lat: 52.4, lon: 13.4, last_seen: iso(at - 60000)},
        {call: 'EA9ABC', status: 'not-found', error: 'Callsign not found', last_seen: iso(at - 60000)},
        {call: 'ZS9OLD', status: 'not-found', error: 'Callsign not found', last_seen: iso(at - 40 * 60 * 1000)},
        {call: 'G3BAD', status: 'error', error: 'Session expired', last_seen: iso(at - 60000)},
        {call: 'G4NODATE', status: 'found', name: 'No Stamp'}
    ];
    const size = qsoApi.primeCache(rows);
    assert.ok(size >= 2);
    const dl = qsoApi.cachedLookup('dl1abc');
    assert.equal(dl.status, 'found');
    // 与 QRZ 接口返回同形：坐标保持字符串，由 applyCached 统一 parseFloat。
    assert.equal(dl.callsign.lat, '52.4');
    assert.equal(dl.callsign.lon, '13.4');
    assert.equal(dl.callsign.country, 'Germany');
    // not-found 同样是结论，复核侧不必再打接口。
    assert.equal(qsoApi.cachedLookup('EA9ABC').status, 'not-found');
    // not-found 只保留 30 分钟，新登记的呼号还能及时查到。
    assert.equal(qsoApi.cachedLookup('ZS9OLD'), null);
    // 错误结论与缺时间戳的行不回填。
    assert.equal(qsoApi.cachedLookup('G3BAD'), null);
    assert.equal(qsoApi.cachedLookup('G4NODATE'), null);
    assert.equal(qsoApi.primeCache(null), qsoApi.primeCache([]));

    const qso = {n1mmId: 'DXI|SHACK|{D1}', call: 'DL1ABC', band: '15', lat: null, lon: null};
    const applied = qsoApi.applyCached(qso, dl);
    assert.equal(applied.kind, 'coords');
    assert.equal(qso.lat, 52.4);
    assert.match(applied.topic, /UPDATE qsos SET lat=52\.4, lon=13\.4 WHERE n1mm_id='DXI\|SHACK\|\{D1\}';/);
    // 复用结论同样生成入库语句，把 last_seen 推到本次比赛。
    assert.match(qsoApi.upsertSql('DL1ABC', dl), /ON CONFLICT\(call\) DO UPDATE/);
    const gone = {call: 'EA9ABC', lat: null, lon: null};
    assert.deepEqual(qsoApi.applyCached(gone, qsoApi.cachedLookup('EA9ABC')), {kind: 'fallback', qso: gone});
    // found 但没有可用坐标时不猜测，交给调用方继续走网格/spots。
    assert.equal(qsoApi.applyCached({call: 'XX1Y'}, {status: 'found', callsign: {lat: '', lon: ''}}), null);
    assert.equal(qsoApi.applyCached(null, dl), null);
    assert.equal(qsoApi.applyCached({call: 'XX1Y'}, null), null);
    assert.equal(qsoApi.upsertSql('XX1Y', {status: 'error'}), null);
});
