'use strict';

const crypto = require('crypto');
const model = require('./model.js');
const {resolveGeo} = require('./geo.js');

const MODEL_VERSION = 'prop.js-unified-v1';
const forecastCaches = new WeakMap();

/* Same 4/6-character Maidenhead conversion as public/js/app.js. */
function gridToLatLon(grid) {
    const g = (grid || '').toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
    let lon = (g.charCodeAt(0) - 65) * 20 - 180 + parseInt(g[2], 10) * 2 + 1;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90 + parseInt(g[3], 10) + 0.5;
    if (g.length === 6) {
        lon += (g.charCodeAt(4) - 65) * (2 / 24) - 1 + (1 / 24);
        lat += (g.charCodeAt(5) - 65) * (1 / 24) - 0.5 + (1 / 48);
    }
    return [lat, lon];
}

function environment(settings, nowMs) {
    settings = settings && typeof settings === 'object' ? settings : {};
    /* grid is the field currently saved by the UI. myGrid is accepted for the
     * transitional adapter mentioned in the migration plan. */
    const grid = settings.grid || settings.myGrid || '';
    const ll = gridToLatLon(grid);
    return {
        nowMs,
        grid,
        de: ll ? {lat: ll[0], lon: ll[1]} : null,
        dx: {
            lat: isFinite(settings.propDxLat) ? Number(settings.propDxLat) : 40,
            lon: isFinite(settings.propDxLon) ? Number(settings.propDxLon) : -100
        }
    };
}

function createForecastCacheKey(raw, env) {
    const fetched = {};
    for (const key of Object.keys(raw.fetched || {}).sort()) fetched[key] = raw.fetched[key];
    return JSON.stringify({
        model: MODEL_VERSION,
        fetched,
        home: env.de ? [env.de.lat, env.de.lon] : null,
        grid: env.grid || '',
        dx: [env.dx.lat, env.dx.lon],
        utcHour: new Date(env.nowMs).toISOString().slice(0, 13),
        geoAt: raw.geoAt || 0,
        drapNoData: !!(raw.drap && raw.drap.noData)
    });
}

function inputSignature(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

function hasNumericSeries(source) {
    const list = source && source.list;
    return !!(list && list.some(row => Array.isArray(row) &&
        typeof row[1] === 'number' && isFinite(row[1])));
}

function hasXray(raw) {
    const list = raw.xray && raw.xray.list;
    if (list && list.some(row => Array.isArray(row) && row[1] > 0)) return true;
    const hx = raw.ham && raw.ham.xray;
    if (!hx) return false;
    const m = /^([ABCMX])([\d.]+)/i.exec(String(hx).trim());
    return !!(m && parseFloat(m[2]) > 0);
}

function degradedInputs(raw) {
    return {
        drap: !raw.drap || !raw.drap.lats || !raw.drap.lats.length || !!raw.drap.noData,
        xray: !hasXray(raw),
        kp: !hasNumericSeries(raw.kp),
        dst: !hasNumericSeries(raw.dst),
        sfi: !(raw.ham && raw.ham.sfi),
        weather: !(raw.wx && raw.wx.pts && raw.wx.pts.length),
        geo: !raw.geo,
        gambit: !(raw.gambit && raw.gambit.values && raw.gambit.values.length),
        ionosonde: !(raw.muf && raw.muf.stations && raw.muf.stations.length)
    };
}

function gridDto(field, generatedAt) {
    const lats = Array.from({length: field.nLat}, (_, i) =>
        -90 + i * model.PROP_MUF_LAT_STEP);
    const lons = Array.from({length: field.nLon}, (_, i) =>
        -180 + i * model.PROP_MUF_LON_STEP);
    const values = Array.from({length: field.nLat}, (_, i) =>
        Array.from(field.vals.subarray(i * field.nLon, (i + 1) * field.nLon)));
    return {
        generatedAt,
        quantity: 'MUF',
        unit: 'MHz',
        interpolation: 'bilinear',
        longitudeWrap: true,
        nLat: field.nLat,
        nLon: field.nLon,
        latMin: -90,
        latMax: 90,
        latStep: model.PROP_MUF_LAT_STEP,
        lonMin: -180,
        lonMax: 170,
        lonStep: model.PROP_MUF_LON_STEP,
        lats,
        lons,
        values
    };
}

/*
 * forecast DTO (all coordinates are true geographic degrees, never projected):
 * {
 *   modelVersion, computedAt, inputSignature,
 *   home: {grid, lat, lon} | null,
 *   dx: {lat, lon},
 *   readouts: {
 *     mufDe: MHz | null, mufDx: MHz,
 *     drapDe: MHz | null, drapDx: MHz | null,
 *     toaDeg: degrees | null       // DE-dependent fields are null without HOME
 *   },
 *   mufGrid: {
 *     generatedAt, quantity, unit, interpolation, longitudeWrap,
 *     nLat, nLon, latMin, latMax, latStep, lonMin, lonMax, lonStep,
 *     lats: number[nLat], lons: number[nLon],
 *     values: number[nLat][nLon]       // MHz, row-major with lats
 *   },
 *   bandConditions: {bands, day, night, noon} | null,
 *   pathMatrix: {
 *     de, dx, date, hours: [0..23], rows: [{name, f, cells: number[24]}],
 *     mid, dist, hops, baseMuf, hourNow, bearing
 *   } | null,
 *   continents: {own, rows: [{key, band, score}]} | null,
 *   degraded: {drap, xray, kp, dst, sfi, weather, geo, gambit, ionosonde},
 *   errors: string[]
 * }
 * For longitude interpolation, j2 = (j + 1) % nLon; latitude is clamped.
 */
function buildForecast(raw, env) {
    const now = new Date(env.nowMs);
    const computedAt = now.toISOString();
    const key = createForecastCacheKey(raw, env);
    const field = model.propMufField(now, raw, env);
    const matrix = model.propPathMatrix(env.de, env.dx, now, raw, env);
    const pathMatrix = matrix ? {
        de: env.de,
        dx: env.dx,
        date: computedAt.slice(0, 10),
        hours: Array.from({length: 24}, (_, h) => h),
        ...matrix
    } : null;
    const readouts = {
        mufDe: env.de ? model.propMufShown(env.de.lat, env.de.lon, now, raw, env) : null,
        mufDx: model.propMufShown(env.dx.lat, env.dx.lon, now, raw, env),
        drapDe: env.de ? model.propDrapAt(env.de.lat, env.de.lon, raw) : null,
        drapDx: model.propDrapAt(env.dx.lat, env.dx.lon, raw),
        toaDeg: matrix ? model.propDeg(Math.atan(300 / Math.max(1, matrix.dist / 2))) : null
    };
    return {
        modelVersion: MODEL_VERSION,
        computedAt,
        inputSignature: inputSignature(key),
        home: env.de ? {grid: env.grid, lat: env.de.lat, lon: env.de.lon} : null,
        dx: {lat: env.dx.lat, lon: env.dx.lon},
        readouts,
        mufGrid: gridDto(field, computedAt),
        bandConditions: model.propBandConds(env.de, now, raw, env),
        pathMatrix,
        continents: model.propContinentTable(env.de, now, raw, env),
        degraded: degradedInputs(raw),
        errors: Array.isArray(raw.errors) ? [...raw.errors] : []
    };
}

function optionNow(options) {
    if (typeof options.now === 'function') return options.now();
    return Number.isFinite(options.now) ? options.now : Date.now();
}

async function getSnapshot(ctx, options) {
    options = options || {};
    const data = await ctx.get('propData');
    if (!data) return {error: 'collecting'};
    let settings = null;
    try { settings = await ctx.get('uiSettings'); } catch (e) { /* defaults */ }
    const nowMs = optionNow(options);
    const env = environment(settings, nowMs);

    /* USGS is ancillary: cache/fetch errors must never suppress propData. */
    let geoResult = {geo: null, geoAt: 0};
    if (env.de) {
        try {
            const resolver = options.geoResolver || resolveGeo;
            geoResult = await resolver(ctx, env.de, {...options.geoOptions, now: nowMs});
        } catch (e) {
            geoResult = {geo: null, geoAt: 0};
        }
    }
    const raw = {...data, geo: geoResult.geo || null, geoAt: geoResult.geoAt || 0};
    const key = createForecastCacheKey(raw, env);
    const hit = forecastCaches.get(ctx);
    if (hit && hit.key === key) {
        /* Heavy products stay cached, but transport errors belong to the
         * latest raw envelope rather than to the hour-old calculation. */
        const forecast = {...hit.forecast,
            errors: Array.isArray(raw.errors) ? [...raw.errors] : []};
        return {...raw, forecast};
    }

    const forecast = buildForecast(raw, env);
    forecastCaches.set(ctx, {key, forecast});
    return {...raw, forecast};
}

module.exports = {MODEL_VERSION, gridToLatLon, environment, createForecastCacheKey,
    inputSignature, degradedInputs, buildForecast, getSnapshot};
