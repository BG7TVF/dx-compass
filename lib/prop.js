/**
 * DX-Compass - propagation / space-weather collector.
 *
 * Runs inside Node-RED (exposed as `prop` through functionGlobalContext) and
 * also usable as a plain Node module for local testing:
 *     node -e "require('./lib/prop.js').collect({get:async()=>null,set:(k,v)=>console.log('set',k,v&&v.ts)})"
 *
 * Data sources (all public, no API key):
 *   - NOAA SWPC  : Kp, Dst, 10.7 cm flux, sunspot cycle, GOES X-ray,
 *                  real-time solar wind (plasma + IMF), OVATION aurora,
 *                  DRAP absorption grid, NOAA R/S/G scales
 *   - HamQSL     : current SFI/SSN/Kp/X-ray/aurora plus HF band conditions
 *   - prop.kc2g.com: ionosonde stations (foF2 / MUF3000)
 *   - Open-Meteo : global current weather grid
 *
 * Everything is cached in the Node-RED global context as `propData`; a failed
 * source keeps its previous value, so a partially reachable network still
 * yields a complete payload.
 */
'use strict';

const https = require('https');

const UA = 'DX-Compass/2.0 (propagation page; +https://github.com/BG7TVF/dx-compass)';
const HEAVY_TTL = 20 * 60 * 1000;      // large feeds (solar wind / aurora / x-ray)
const LIGHT_TTL = 4 * 60 * 1000;       // small feeds
const WX_TTL = 10 * 60 * 1000;

const URLS = {
    kp: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    dst: 'https://services.swpc.noaa.gov/products/kyoto-dst.json',
    sfi: 'https://services.swpc.noaa.gov/products/10cm-flux-30-day.json',
    ssn: 'https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json',
    xray: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json',
    wind: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',
    mag: 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json',
    aurora: 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
    drap: 'https://services.swpc.noaa.gov/text/drap_global_frequencies.txt',
    scales: 'https://services.swpc.noaa.gov/products/noaa-scales.json',
    ham: 'https://www.hamqsl.com/solarxml.php',
    muf: 'https://prop.kc2g.com/api/stations.json'
};
/* Open-Meteo takes latitude/longitude lists of equal length, so the grid is
 * flattened into a paired coordinate list (6 latitudes x 11 longitudes). */
const WX_LATS = [-40, -20, 0, 20, 40, 60];
const WX_LONS = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
const WX_URL = 'https://api.open-meteo.com/v1/forecast?latitude=' +
    WX_LATS.map(l => WX_LONS.map(() => l).join(',')).join(',') +
    '&longitude=' + WX_LATS.map(() => WX_LONS.join(',')).join(',') +
    '&current=temperature_2m,weather_code&timezone=UTC';

/* Keep a few parallel requests per host: several public feeds sit behind
 * WAFs (HamQSL/Sucuri) that reset bursts. */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
    return out;
}

/* ---------- tiny HTTP helper ---------- */
function fetchOnce(url, timeoutMs) {
    timeoutMs = timeoutMs || 25000;
    return new Promise((resolve, reject) => {
        const req = https.get(url, {headers: {'User-Agent': UA}}, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                resolve(fetchText(res.headers.location, timeoutMs));
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
            res.on('end', () => resolve(buf));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout ' + url)));
    });
}
const fetchJson = url => fetchText(url).then(JSON.parse);

/* one retry: public feeds behind CDN/WAF layers occasionally reset a burst */
async function fetchText(url, timeoutMs) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await fetchOnce(url, timeoutMs);
        } catch (e) {
            lastErr = e;
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw lastErr;
}

const num = v => {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
};
const round = (v, d) => v === null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

/* ---------- parsers ---------- */

/* HamQSL solarxml.php -> current indices + HF band conditions */
function parseHamqsl(xml) {
    const tag = name => {
        const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i').exec(xml);
        return m ? m[1].trim() : '';
    };
    const bands = [];
    const re = /<band\s+name="([^"]+)"\s+time="([^"]+)">([^<]*)<\/band>/gi;
    let m;
    while ((m = re.exec(xml))) bands.push({name: m[1], time: m[2], cond: m[3]});
    const vhf = [];
    const reV = /<phenomenon\s+name="([^"]+)"\s+location="([^"]+)">([^<]*)<\/phenomenon>/gi;
    while ((m = reV.exec(xml))) vhf.push({name: m[1], loc: m[2], cond: m[3]});
    return {
        sfi: num(tag('solarflux')),
        aindex: num(tag('aindex')),
        kp: num(tag('kindex')),
        xray: tag('xray'),
        ssn: num(tag('sunspots')),
        aurora: num(tag('aurora')),
        wind: num(tag('solarwind')),
        bz: num(tag('magneticfield')),
        latdeg: num(tag('latdegree')),
        muf: tag('muf'),
        geomag: tag('geomagfield'),
        noise: tag('signalnoise'),
        updated: tag('updated'),
        bands, vhf
    };
}

/* SwPC keyed JSON array -> [[time, value], ...] */
function seriesFrom(rows, timeKey, valueKey, limit) {
    const out = [];
    for (const r of rows) {
        const t = r[timeKey], v = num(r[valueKey]);
        if (t && v !== null) out.push([t, v]);
    }
    return limit ? out.slice(-limit) : out;
}

/* OVATION aurora: [lon, lat, probability] on a 1x1 degree grid */
function parseAurora(obj) {
    const out = [];
    const coords = obj && obj.coordinates || [];
    for (const c of coords) {
        const lon = c[0], lat = c[1], p = c[2];
        if (p < 8) continue;
        // 4-degree subsample keeps the payload small (~500 points)
        if ((lon + 360) % 4 !== 0 || (lat + 90) % 4 !== 0) continue;
        out.push([lon > 180 ? lon - 360 : lon, lat, p]);
    }
    return {
        ts: obj && obj['Observation Time'] || null,
        forecast: obj && obj['Forecast Time'] || null,
        grid: out
    };
}

/* DRAP tabular text: rows "lat | f1 f2 ..." with a longitude header line */
function parseDrap(text) {
    const lines = text.split(/\r?\n/);
    let lons = null;
    const lats = [], vals = [];
    for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        if (/^[-0-9.\s]+$/.test(t) && t.split(/\s+/).length > 8 && lons === null &&
            /-\d/.test(t)) {
            lons = t.split(/\s+/).filter(Boolean).map(Number);
            continue;
        }
        const m = /^(-?\d+)\s*\|\s*([-0-9.\s]+)$/.exec(t);
        if (m) {
            lats.push(+m[1]);
            vals.push(m[2].split(/\s+/).filter(Boolean).map(v => round(num(v), 1)));
        }
    }
    const valid = /Valid At\s*:\s*(.+)/.exec(text);
    return {
        valid: valid ? valid[1].trim() : null,
        lons: lons || [],
        lats, vals
    };
}

/* kc2g ionosonde stations -> compact [lat, lon, mufd, fof2] rows */
function parseStations(rows) {
    const out = [];
    for (const r of rows || []) {
        const s = r && r.station;
        if (!s) continue;
        const lat = num(s.latitude), lon = num(s.longitude);
        const muf = num(r.mufd);
        if (lat === null || lon === null) continue;
        out.push([round(lat, 1), round(lon > 180 ? lon - 360 : lon, 1),
            round(muf, 1), round(num(r.fof2), 1), s.name || '']);
    }
    return {ts: null, stations: out};
}

/* NOAA scales payload -> {r: {scale, text}, s: {...}, g: {...}} */
function parseScales(obj) {
    const sec = obj && (obj['0'] || obj[0] || obj);
    const pick = k => {
        const v = sec && sec[k];
        if (!v) return null;
        return {
            scale: num(v.Scale),
            text: v.Text || '',
            prob: num(v.MinorProb !== undefined && v.MinorProb !== null ? v.MinorProb : v.Prob)
        };
    };
    return {r: pick('R'), s: pick('S'), g: pick('G')};
}

/* ---------- collection ---------- */

async function collect(ctx) {
    const prev = (await ctx.get('propData')) || {};
    const prevFetched = prev.fetched || {};
    const now = Date.now();
    const jobs = {};

    /* each job stores its own fetch timestamp so heavy feeds can be reused */
    const job = (key, url, ttl, fn, json) => {
        jobs[key] = {url, ttl, fn, json: !!json};
    };

    job('ham', URLS.ham, LIGHT_TTL, txt => parseHamqsl(txt));
    job('kp', URLS.kp, LIGHT_TTL, rows => ({list: seriesFrom(rows, 'time_tag', 'Kp', 40)}), true);
    job('dst', URLS.dst, LIGHT_TTL, rows => ({list: seriesFrom(rows, 'time_tag', 'dst', 72)}), true);
    job('sfi', URLS.sfi, LIGHT_TTL, rows => ({list: seriesFrom(rows, 'time_tag', 'flux', 32)}), true);
    job('ssn', URLS.ssn, HEAVY_TTL, rows => {
        const list = [];
        for (const r of rows) {
            const s = num(r.ssn);
            if (s === null || s < 0) continue;
            list.push([r['time-tag'], s]);
        }
        return {list: list.slice(-24)};
    }, true);
    job('scales', URLS.scales, LIGHT_TTL, obj => parseScales(obj), true);
    job('xray', URLS.xray, HEAVY_TTL, rows => {
        // 10-minute max buckets keep flare peaks and cut the payload 10x
        const buckets = new Map();
        for (const r of rows) {
            const t = r.time_tag, f = num(r.flux);
            if (!t || f === null) continue;
            const key = t.slice(0, 15) + '0';
            buckets.set(key, Math.max(buckets.get(key) || 0, f));
        }
        return {list: Array.from(buckets.entries()).sort().slice(-144)};
    }, true);
    job('wind', URLS.wind, HEAVY_TTL, rows => {
        /* several spacecraft report the same minute: keep one row per minute
         * and return the most recent 120 (2 h) in ascending time order */
        const map = new Map();
        for (const r of rows) {
            const t = r.time_tag, sp = num(r.proton_speed), de = num(r.proton_density);
            if (!t || sp === null) continue;
            if (!map.has(t)) map.set(t, [t, round(sp, 1), de === null ? null : round(de, 2)]);
        }
        return {list: Array.from(map.values()).sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-120)};
    }, true);
    job('mag', URLS.mag, HEAVY_TTL, rows => {
        const map = new Map();
        for (const r of rows) {
            const t = r.time_tag, bt = num(r.bt), bz = num(r.bz_gsm);
            if (!t || bt === null) continue;
            if (!map.has(t)) map.set(t, [t, round(bt, 2), bz === null ? null : round(bz, 2)]);
        }
        return {list: Array.from(map.values()).sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-120)};
    }, true);
    job('aurora', URLS.aurora, HEAVY_TTL, obj => parseAurora(obj), true);
    job('drap', URLS.drap, LIGHT_TTL, txt => parseDrap(txt));
    job('muf', URLS.muf, HEAVY_TTL, rows => parseStations(rows), true);

    const data = {ts: new Date().toISOString(), fetched: {...prevFetched}, errors: []};

    await mapLimit(Object.keys(jobs), 4, async key => {
        const j = jobs[key];
        const age = now - (prevFetched[key] || 0);
        if (prev[key] && age < j.ttl) {
            data[key] = prev[key];       // still fresh: reuse the cached copy
            return;
        }
        try {
            const raw = await fetchText(j.url);
            data[key] = j.fn(j.json ? JSON.parse(raw) : raw);
            data.fetched[key] = now;
        } catch (e) {
            data.errors.push(key + ': ' + e.message);
            if (prev[key]) {
                data[key] = prev[key];   // fallback: last known good value
            } else {
                data.fetched[key] = 0;
            }
        }
    });

    /* weather grid is separate so its failure never blocks space weather */
    const wxAge = now - (prevFetched.wx || 0);
    if (prev.wx && wxAge < WX_TTL) {
        data.wx = prev.wx;
    } else {
        try {
            const rows = JSON.parse(await fetchText(WX_URL));
            const pts = [];
            for (const r of rows) {
                const cur = r && r.current;
                if (!cur) continue;
                pts.push([round(r.latitude, 1), round(r.longitude, 1),
                    round(num(cur.temperature_2m), 1), num(cur.weather_code)]);
            }
            data.wx = {ts: new Date().toISOString(), pts};
            data.fetched.wx = now;
        } catch (e) {
            data.errors.push('wx: ' + e.message);
            if (prev.wx) data.wx = prev.wx;
            else data.fetched.wx = 0;
        }
    }

    await ctx.set('propData', data);
    return data;
}

module.exports = {collect, parseHamqsl, parseDrap, parseAurora, parseStations, parseScales};
