'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../lib/propagation');
const collector = require('../lib/propagation/collector.js');
const {environment, MODEL_VERSION} = require('../lib/propagation/service.js');

const NOW = Date.parse('2026-11-08T12:34:00.000Z');

function fixture() {
    const uts = [0, 3, 6, 9, 12, 15, 18, 21];
    const lats = [-80, 0, 80];
    const lons = [-180, 0];
    const values = uts.map((ut, u) => lats.map((lat, i) => lons.map((lon, j) =>
        Math.round((4.5 + u * 0.17 + i * 0.31 + j * 0.13) * 10) / 10)));
    const fetched = {};
    for (const key of ['ham', 'kp', 'dst', 'sfi', 'ssn', 'scales', 'a', 'proton',
        'xray', 'wind', 'mag', 'aurora', 'drap', 'icao', 'muf', 'gambit', 'wx']) {
        fetched[key] = NOW - 60000;
    }
    return {
        ts: new Date(NOW - 30000).toISOString(),
        fetched,
        errors: [],
        ham: {sfi: 112, xray: 'B2.0'},
        kp: {list: [['2026-11-08T12:00:00Z', 2.3]]},
        dst: {list: [['2026-11-08T12:00:00Z', -12]]},
        sfi: {list: [['2026-11-08T00:00:00Z', 112]]},
        proton: {list: [['2026-11-08T12:00:00Z', 0.2]]},
        xray: {list: [['2026-11-08T12:30:00Z', 3e-7]]},
        muf: {stations: [
            [35.5, 139.5, 25.2, 6.4, 'Tokyo', '2026-11-08T11:30:00'],
            [40.1, -105.2, 20.4, 5.3, 'Boulder', '2026-11-08T11:40:00']
        ]},
        gambit: {tov: '2026-11-04T00:00:00Z', uts, lats, lons, values},
        drap: {
            valid: '2026-11-08 12:00 UTC', noData: false,
            lats: [90, 88, 86], lons: [-178, -174, -170],
            vals: [[2, 2, 2], [2, 2, 2], [2, 2, 2]]
        },
        wx: {ts: new Date(NOW - 60000).toISOString(), pts: [[40, 140, 12, 1]]},
        geo: null,
        geoAt: 0
    };
}

function envAt(nowMs, raw) {
    const env = environment({grid: 'PM95', propDxLat: 40, propDxLon: -100}, nowMs);
    return {...env, raw};
}

class Context {
    constructor(values) { this.values = new Map(Object.entries(values || {})); }
    async get(key) { return this.values.get(key); }
    async set(key, value) { this.values.set(key, value); }
}

test('collector exports the complete established implementation', () => {
    assert.strictEqual(api.collect, collector.collect);
    for (const name of ['parseHamqsl', 'parseDrap', 'parseAurora', 'parseStations',
        'parseScales', 'parseIcao', 'parseGambitField']) {
        assert.strictEqual(api[name], collector[name]);
    }
});

test('fixed snapshot and environment produce deterministic forecast output', () => {
    const raw = fixture();
    const env = envAt(NOW);
    const a = api.buildForecast(raw, env);
    const b = api.buildForecast(raw, env);
    assert.deepStrictEqual(a, b);
    assert.equal(a.modelVersion, MODEL_VERSION);
    assert.equal(a.computedAt, '2026-11-08T12:34:00.000Z');
    assert.match(a.inputSignature, /^[a-f0-9]{64}$/);
});

test('UTC day and hour are explicit model inputs and change the forecast', () => {
    const raw = fixture();
    const base = api.buildForecast(raw, envAt(NOW));
    const nextHour = api.buildForecast(raw, envAt(NOW + 3600000));
    const nextDay = api.buildForecast(raw, envAt(NOW + 86400000));
    assert.equal(base.pathMatrix.hourNow, 12);
    assert.equal(nextHour.pathMatrix.hourNow, 13);
    assert.notEqual(base.inputSignature, nextHour.inputSignature);
    assert.notDeepStrictEqual(base.mufGrid.values, nextHour.mufGrid.values);
    assert.equal(nextDay.pathMatrix.hourNow, 12);
    assert.notEqual(nextDay.pathMatrix.date, base.pathMatrix.date);
    assert.notDeepStrictEqual(base.mufGrid.values, nextDay.mufGrid.values);
});

test('missing or no-data DRAP retains climatological LUF fallback', () => {
    const raw = fixture();
    const withDrap = api.buildForecast(raw, envAt(NOW));
    const missing = {...raw, drap: undefined};
    const noData = {...raw, drap: {...raw.drap, noData: true}};
    const withoutDrap = api.buildForecast(missing, envAt(NOW));
    const flaggedDrap = api.buildForecast(noData, envAt(NOW));
    assert.equal(api.propDrapAt(35, 140, missing), null);
    assert.equal(api.propDrapAt(35, 140, noData), null);
    assert.equal(withoutDrap.degraded.drap, true);
    assert.equal(flaggedDrap.degraded.drap, true);
    assert.notDeepStrictEqual(withDrap.pathMatrix.rows, withoutDrap.pathMatrix.rows);
    assert.deepStrictEqual(withoutDrap.pathMatrix.rows, flaggedDrap.pathMatrix.rows);
    for (const row of withoutDrap.pathMatrix.rows) {
        for (const cell of row.cells) assert.ok(Number.isFinite(cell));
    }
});

test('missing USGS geo falls back to Kp, then to neutral correction', () => {
    const raw = {...fixture(), kp: {list: [['2026-11-08T12:00:00Z', 6.7]]}};
    assert.equal(api.propGeoK(raw), 6.7);
    assert.ok(api.propGeoMufFactor(raw) < 1);
    assert.ok(api.propGeoAbsFactor(raw) > 1);
    const noKp = {...raw, kp: undefined};
    assert.equal(api.propGeoK(noKp), null);
    assert.equal(api.propGeoMufFactor(noKp), 1);
    assert.equal(api.propGeoAbsFactor(noKp), 1);
    const forecast = api.buildForecast(raw, envAt(NOW));
    assert.equal(forecast.degraded.geo, true);
    assert.ok(forecast.mufGrid.values.flat().every(Number.isFinite));
});

test('forecast DTO has interpolation metadata, 24-hour matrix and band products', () => {
    const forecast = api.buildForecast(fixture(), envAt(NOW));
    const grid = forecast.mufGrid;
    assert.equal(grid.nLat, 31);
    assert.equal(grid.nLon, 36);
    assert.equal(grid.latStep, 6);
    assert.equal(grid.lonStep, 10);
    assert.equal(grid.lats[0], -90);
    assert.equal(grid.lats.at(-1), 90);
    assert.equal(grid.lons[0], -180);
    assert.equal(grid.lons.at(-1), 170);
    assert.equal(grid.longitudeWrap, true);
    assert.equal(grid.interpolation, 'bilinear');
    assert.equal(grid.values.length, 31);
    assert.ok(grid.values.every(row => row.length === 36 && row.every(Number.isFinite)));
    assert.equal(forecast.pathMatrix.rows.length, 10);
    assert.deepStrictEqual(forecast.pathMatrix.hours, Array.from({length: 24}, (_, i) => i));
    for (const row of forecast.pathMatrix.rows) {
        assert.equal(row.cells.length, 24);
        assert.ok(row.cells.every(v => Number.isInteger(v) && v >= 0 && v <= 100));
    }
    assert.equal(Object.keys(forecast.bandConditions.bands).length, 10);
    assert.equal(forecast.continents.rows.length, 6);
    assert.deepStrictEqual(forecast.home, {grid: 'PM95', lat: 35.5, lon: 139});
    assert.deepStrictEqual(forecast.dx, {lat: 40, lon: -100});
});

test('forecast readouts use the unified current model and null DE-dependent values', () => {
    const raw = fixture();
    const env = envAt(NOW);
    const when = new Date(NOW);
    const forecast = api.buildForecast(raw, env);
    assert.deepStrictEqual(Object.keys(forecast.readouts),
        ['mufDe', 'mufDx', 'drapDe', 'drapDx', 'toaDeg']);
    assert.equal(forecast.readouts.mufDe,
        api.propMufShown(env.de.lat, env.de.lon, when, raw, env));
    assert.equal(forecast.readouts.mufDx,
        api.propMufShown(env.dx.lat, env.dx.lon, when, raw, env));
    assert.equal(forecast.readouts.drapDe, api.propDrapAt(env.de.lat, env.de.lon, raw));
    assert.equal(forecast.readouts.drapDx, api.propDrapAt(env.dx.lat, env.dx.lon, raw));
    const distance = api.propDistance(env.de, env.dx);
    const expectedToa = api.propDeg(Math.atan(300 / Math.max(1, distance / 2)));
    assert.ok(Math.abs(forecast.readouts.toaDeg - expectedToa) < 1e-12);

    const noHomeEnv = environment({grid: '', propDxLat: 40, propDxLon: -100}, NOW);
    const noHome = api.buildForecast(raw, noHomeEnv);
    assert.equal(noHome.readouts.mufDe, null);
    assert.equal(noHome.readouts.drapDe, null);
    assert.equal(noHome.readouts.toaDeg, null);
    assert.equal(noHome.readouts.mufDx, forecast.readouts.mufDx);
    assert.equal(noHome.readouts.drapDx, forecast.readouts.drapDx);
});

test('forecast cache key covers fetched sources, HOME, UTC hour and geo time', () => {
    const raw = fixture();
    const env = envAt(NOW);
    const base = api.createForecastCacheKey(raw, env);
    const fetched = {...raw, fetched: {...raw.fetched, ham: raw.fetched.ham + 1}};
    assert.notEqual(api.createForecastCacheKey(fetched, env), base);
    assert.notEqual(api.createForecastCacheKey({...raw, geoAt: NOW}, env), base);
    assert.notEqual(api.createForecastCacheKey(raw, envAt(NOW + 3600000)), base);
    assert.notEqual(api.createForecastCacheKey(raw, {
        ...env, grid: 'PM94', de: {lat: env.de.lat, lon: env.de.lon - 2}
    }), base);
    assert.notEqual(api.createForecastCacheKey(raw, {
        ...env, dx: {lat: 41, lon: -100}
    }), base);
});

test('getSnapshot returns collecting, preserves raw fields and reuses DTO within cache key', async () => {
    const empty = new Context();
    assert.deepStrictEqual(await api.getSnapshot(empty, {now: NOW}), {error: 'collecting'});

    const raw = fixture();
    const ctx = new Context({
        propData: raw,
        uiSettings: {grid: 'PM95', propDxLat: 40, propDxLon: -100}
    });
    const geoResolver = async () => ({
        geo: {code: 'SHU', k: 2, amp: 35, distance: 1800}, geoAt: NOW - 60000
    });
    const a = await api.getSnapshot(ctx, {now: NOW, geoResolver});
    const updatedRaw = {...raw, ts: '2026-11-08T12:40:00.000Z', errors: ['kp: offline fixture']};
    await ctx.set('propData', updatedRaw);
    const b = await api.getSnapshot(ctx, {now: NOW + 600000, geoResolver});
    assert.notStrictEqual(a, b); // the latest raw envelope is always returned
    assert.notStrictEqual(a.forecast, b.forecast);
    assert.strictEqual(a.forecast.mufGrid, b.forecast.mufGrid);
    assert.strictEqual(a.forecast.pathMatrix, b.forecast.pathMatrix);
    assert.strictEqual(a.forecast.readouts, b.forecast.readouts);
    assert.equal(a.forecast.computedAt, b.forecast.computedAt);
    assert.equal(b.ts, updatedRaw.ts);
    assert.deepStrictEqual(b.errors, updatedRaw.errors);
    assert.deepStrictEqual(b.forecast.errors, updatedRaw.errors);
    assert.strictEqual(a.ham, raw.ham);
    assert.strictEqual(a.gambit, raw.gambit);
    assert.match(a.forecast.inputSignature, /^[a-f0-9]{64}$/);
    assert.equal(a.geo.code, 'SHU');
    const later = await api.getSnapshot(ctx, {now: NOW + 3600000, geoResolver});
    assert.notStrictEqual(later.forecast, a.forecast);
    assert.notEqual(later.forecast.inputSignature, a.forecast.inputSignature);
});

test('Maidenhead and great-circle helpers retain the browser calculations', () => {
    assert.deepStrictEqual(api.gridToLatLon('PM95'), [35.5, 139]);
    assert.deepStrictEqual(api.gridToLatLon('invalid'), null);
    const mid = api.propAlong({lat: 0, lon: 0}, {lat: 0, lon: 90}, 0.5);
    assert.ok(Math.abs(mid.lat) < 1e-10);
    assert.ok(Math.abs(mid.lon - 45) < 1e-10);
});
