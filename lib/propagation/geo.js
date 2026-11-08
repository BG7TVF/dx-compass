'use strict';

const https = require('https');
const {
    PROP_GEO_STATIONS, propGeomagDistance, propKFromAmp
} = require('./model.js');

const GEO_TTL = 10 * 60 * 1000;
const GEO_CONTEXT_KEY = 'propGeo';
const UA = 'DX-Compass/2.0 (propagation page; +https://github.com/BG7TVF/dx-compass)';

function requestJson(url, timeoutMs, redirects) {
    timeoutMs = timeoutMs || 10000;
    redirects = redirects || 0;
    return new Promise((resolve, reject) => {
        const req = https.get(url, {headers: {'User-Agent': UA}}, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirects >= 3) {
                    reject(new Error('too many redirects for ' + url));
                    return;
                }
                resolve(requestJson(new URL(res.headers.location, url).toString(),
                    timeoutMs, redirects + 1));
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
                return;
            }
            res.setEncoding('utf8');
            let buf = '';
            res.on('data', c => { buf += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout ' + url)));
    });
}

function homeKey(de) {
    return de.lat.toFixed(6) + ',' + de.lon.toFixed(6);
}

function geoUrl(code, nowMs) {
    const end = new Date(nowMs);
    const start = new Date(nowMs - 4 * 3600 * 1000);
    return 'https://geomag.usgs.gov/ws/data/?id=' + code +
        '&elements=H&format=json&sampling_period=60' +
        '&starttime=' + start.toISOString() + '&endtime=' + end.toISOString();
}

/* Try the nearest three observatories, exactly as the browser implementation
 * did. `request` is injectable so model tests never need external network. */
async function fetchGeo(de, options) {
    options = options || {};
    const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
    const request = options.request || requestJson;
    const near = PROP_GEO_STATIONS
        .map(s => ({s, d: propGeomagDistance(s, de)}))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
    for (const c of near) {
        const code = c.s[0];
        try {
            const o = await request(geoUrl(code, nowMs), options.timeoutMs);
            const vals = o && o.values && o.values[0] && o.values[0].values;
            if (!Array.isArray(vals)) continue;
            const h = vals.filter(v => typeof v === 'number' && isFinite(v));
            if (h.length < 30) continue;
            const win = h.slice(-180);
            const amp = Math.max(...win) - Math.min(...win);
            return {code, k: propKFromAmp(amp), amp: Math.round(amp),
                distance: Math.round(c.d)};
        } catch (e) {
            /* Try the next station. A complete outage is a neutral correction. */
        }
    }
    return null;
}

/* Cache both successes and failures per HOME for ten minutes. On a later
 * failure, retain a previous reading for the same HOME (the old UI behaviour);
 * an initial failure simply returns null and never rejects the whole snapshot. */
async function resolveGeo(ctx, de, options) {
    options = options || {};
    if (!de) return {geo: null, geoAt: 0};
    const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
    const key = homeKey(de);
    let prev = null;
    try { prev = await ctx.get(GEO_CONTEXT_KEY); } catch (e) { /* no cache */ }
    if (prev && prev.home === key && prev.at && nowMs - prev.at < GEO_TTL) {
        return {geo: prev.geo || null, geoAt: prev.at};
    }
    let next = null;
    try {
        next = await fetchGeo(de, {...options, now: nowMs});
    } catch (e) {
        next = null;
    }
    const geo = next || (prev && prev.home === key ? prev.geo || null : null);
    const state = {home: key, at: nowMs, geo};
    try { await ctx.set(GEO_CONTEXT_KEY, state); } catch (e) { /* still return data */ }
    return {geo, geoAt: nowMs};
}

module.exports = {GEO_TTL, GEO_CONTEXT_KEY, requestJson, homeKey, geoUrl, fetchGeo,
    propFetchGeo: fetchGeo, resolveGeo};
