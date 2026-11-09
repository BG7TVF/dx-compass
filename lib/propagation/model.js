'use strict';

/* The propagation model is lifted from public/js/prop.js. All coefficients and
 * fallback decisions are intentionally unchanged. Every function that used
 * propState now receives the raw snapshot and an environment containing nowMs;
 * no wall clock, DOM, network or UI state is consulted here. */

const PROP_BANDS = [
    {name: '160M', f: 1.9}, {name: '80M', f: 3.6}, {name: '60M', f: 5.3},
    {name: '40M', f: 7.1}, {name: '30M', f: 10.1}, {name: '20M', f: 14.1},
    {name: '17M', f: 18.1}, {name: '15M', f: 21.1}, {name: '12M', f: 24.9},
    {name: '10M', f: 28.5}
];

const PROP_CONTINENTS = [
    {key: 'af', pts: [[6, 20], [-5, 25], [12, 0], [-18, 25]]},
    {key: 'as', pts: [[45, 90], [30, 75], [20, 105], [10, 80], [50, 100]]},
    {key: 'eu', pts: [[50, 15], [60, 10], [45, 0], [40, 20]]},
    {key: 'na', pts: [[40, -100], [30, -90], [50, -110], [20, -100]]},
    {key: 'sa', pts: [[-10, -60], [-20, -50], [-30, -60], [0, -70]]},
    {key: 'oc', pts: [[-25, 135], [-35, 145], [-10, 145]]},
    {key: 'an', pts: [[-80, 0], [-80, 120], [-80, -120]]}
];

const PROP_HOP_KM = 3000;
const PROP_MUF_LAT_STEP = 6;
const PROP_MUF_LON_STEP = 10;
const PROP_MAG_POLE = {lat: 80.6, lon: -72.7};
const PROP_GEO_STATIONS = [
    ['SHU', 31.1, 121.2], ['BDT', 40.0, 116.3], ['GUA', 13.6, 144.9],
    ['HON', 21.3, -157.0], ['BOU', 40.1, -105.2], ['NEW', 48.3, -117.1],
    ['TUC', 32.2, -110.7], ['BSL', 30.4, -89.6], ['SIT', 57.1, -135.3],
    ['CMO', 64.9, -147.9], ['SJG', 18.1, -66.2], ['BRW', 71.3, -156.6],
    ['FRN', 37.1, -118.7], ['DED', 70.0, -145.0]
];

const propRad = d => d * Math.PI / 180;
const propDeg = r => r * 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const propLonRel = (lon, lonC) => ((lon - lonC + 540) % 360) - 180;

function asDate(value) {
    return value instanceof Date ? value : new Date(value);
}

function nowOf(env, when) {
    return env && Number.isFinite(env.nowMs) ? env.nowMs : asDate(when).getTime();
}

/* Solar geometry, including the terminator points used by the original page.
 * Memoisation only avoids repeated allocation; it never changes the result. */
let propTermMemo = null;
function propTerminator(value, lonC) {
    const now = asDate(value);
    lonC = lonC || 0;
    const key = String(Math.floor(now.getTime() / 60000)) + '|' + lonC;
    if (propTermMemo && propTermMemo.key === key) return propTermMemo.val;
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const doy = (now - start) / 86400000;
    const decDeg = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365.25);
    const dec = propRad(decDeg);
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 +
        now.getUTCSeconds() / 3600;
    const lonSun = 180 - utcH * 15;
    const base = [];
    let prev = 0;
    for (let d = -180; d <= 180; d += 2) {
        const H = propRad(d + lonC - lonSun);
        let lat = Math.atan(-Math.cos(H) / Math.tan(dec)) * 180 / Math.PI;
        if (!isFinite(lat)) lat = prev;
        base.push([lat, d]);
        prev = lat;
    }
    const val = {
        dec: decDeg, lonSun, base,
        nightPole: decDeg > 0 ? -89.99 : 89.99,
        equinox: Math.abs(decDeg) < 0.6
    };
    propTermMemo = {key, val};
    return val;
}

function propDistance(a, b) {
    const f1 = propRad(a.lat), f2 = propRad(b.lat);
    const df = f2 - f1, dl = propRad(b.lon - a.lon);
    const x = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(Math.min(1, x)));
}

function propBearing(a, b) {
    const f1 = propRad(a.lat), f2 = propRad(b.lat), dl = propRad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (propDeg(Math.atan2(y, x)) + 360) % 360;
}

function propAlong(a, b, t) {
    const f1 = propRad(a.lat), l1 = propRad(a.lon);
    const f2 = propRad(b.lat), l2 = propRad(b.lon);
    const d = 2 * Math.asin(Math.sqrt(Math.sin((f2 - f1) / 2) ** 2 +
        Math.cos(f1) * Math.cos(f2) * Math.sin((l2 - l1) / 2) ** 2));
    if (d < 1e-9) return {lat: a.lat, lon: a.lon};
    const A = Math.sin((1 - t) * d) / Math.sin(d);
    const B = Math.sin(t * d) / Math.sin(d);
    const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
    const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
    const z = A * Math.sin(f1) + B * Math.sin(f2);
    return {lat: propDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
        lon: propDeg(Math.atan2(y, x))};
}

function sunFactor(lat, lon, value) {
    const term = propTerminator(value);
    const dec = propRad(term.dec);
    const H = propRad(lon - term.lonSun);
    return Math.sin(propRad(lat)) * Math.sin(dec) +
        Math.cos(propRad(lat)) * Math.cos(dec) * Math.cos(H);
}

const propHourFactorCache = new Map();
function propStationHourFactor(s) {
    if (typeof s[5] !== 'string' || !s[5]) return 1;
    const key = s[5] + '@' + s[0] + ',' + s[1];
    const hit = propHourFactorCache.get(key);
    if (hit !== undefined) return hit;
    const iso = /Z|[+-]\d{2}:?\d{2}$/.test(s[5]) ? s[5] : s[5] + 'Z';
    const t = new Date(iso);
    const v = isNaN(t) ? 1 : Math.max(0.55, propMufDayFactor(sunFactor(s[0], s[1], t)));
    if (propHourFactorCache.size > 600) propHourFactorCache.clear();
    propHourFactorCache.set(key, v);
    return v;
}

function propSondeAgeWeight(s, nowMs) {
    if (typeof s[5] !== 'string' || !s[5]) return 0.3;
    const iso = /Z|[+-]\d{2}:?\d{2}$/.test(s[5]) ? s[5] : s[5] + 'Z';
    const t = new Date(iso);
    if (isNaN(t)) return 0.3;
    const ageH = (nowMs - t.getTime()) / 3600e3;
    if (ageH <= 1) return 1;
    return clamp(1 - (ageH - 1) / 720, 0, 1);
}

function propIonoAt(lat, lon, value, snapshot, env) {
    const when = asDate(value);
    const st = snapshot && snapshot.muf && snapshot.muf.stations;
    if (!st || !st.length) return null;
    const nowMs = nowOf(env, when);
    let num = 0, den = 0, numF = 0, dMin = Infinity;
    for (const s of st) {
        if (typeof s[2] !== 'number') continue;
        const d = propDistance({lat, lon}, {lat: s[0], lon: s[1]});
        if (d < dMin) dMin = d;
        if (d > 2500) continue;
        const ageW = propSondeAgeWeight(s, nowMs);
        if (!ageW) continue;
        const wgt = ageW / Math.pow(d + 40, 2);
        const kM = propStationHourFactor(s);
        num += (s[2] / kM) * wgt;
        den += wgt;
        numF += ((typeof s[3] === 'number' ? s[3] : 0.62 * s[2]) / kM) * wgt;
    }
    if (!den) return null;
    const base = num / den;
    const baseF = (numF ? numF / den : 0.62 * base);
    const kAt = propMufDayFactor(sunFactor(lat, lon, when));
    return {muf: base * kAt, fof2: baseF * kAt, dMin};
}

function propMufAt(lat, lon, when, snapshot, env) {
    const p = propIonoAt(lat, lon, when, snapshot, env);
    return p ? p.muf : null;
}

function propMufShown(lat, lon, when, snapshot, env) {
    const m = propMufAt(lat, lon, when, snapshot, env);
    return m !== null ? m : propClimatMuf(lat, lon, when, snapshot, env);
}

function propDrapAt(lat, lon, snapshot) {
    const d = snapshot && snapshot.drap;
    if (!d || !d.lats || !d.lats.length) return null;
    if (d.noData) return null;
    const li = clamp(Math.round((d.lats[0] - lat) / 2), 0, d.lats.length - 1);
    const lo = clamp(Math.round((lon + 178) / 4), 0, d.lons.length - 1);
    const row = d.vals[li];
    return row && row[lo] !== undefined ? row[lo] : null;
}

function propWxAt(lat, lon, snapshot) {
    const pts = snapshot && snapshot.wx && snapshot.wx.pts;
    if (!pts || !pts.length) return null;
    let best = null, bd = Infinity;
    for (const p of pts) {
        const d = propDistance({lat, lon}, {lat: p[0], lon: p[1]});
        if (d < bd) { bd = d; best = p; }
    }
    return best;
}

function propPathProfile(a, b) {
    const dist = propDistance(a, b);
    const hops = Math.max(1, Math.ceil(dist / PROP_HOP_KM));
    const hopLen = dist / hops;
    const mids = [];
    for (let i = 0; i < hops; i++) mids.push(propAlong(a, b, (i + 0.5) / hops));
    return {dist, hops, hopLen, mids};
}

function propMufDayFactor(sf) {
    return 0.55 + 0.62 * Math.pow(clamp((sf + 0.12) / 1.12, 0, 1), 0.65);
}

function propGambitSliceAt(g, slice, lat, lon) {
    const nLat = g.lats.length, nLon = g.lons.length;
    const dLat = g.lats[1] - g.lats[0] || 1;
    const dLon = g.lons[1] - g.lons[0] || 1;
    const y = clamp((lat - g.lats[0]) / dLat, 0, nLat - 1 - 1e-6);
    const i = Math.floor(y), ty = y - i;
    let x = (((lon - g.lons[0]) / dLon) % nLon + nLon) % nLon;
    const j = Math.floor(x), tx = x - j;
    const j2 = (j + 1) % nLon;
    const r0 = slice[i] || [], r1 = slice[Math.min(i + 1, nLat - 1)] || [];
    const v00 = r0[j], v01 = r0[j2], v10 = r1[j], v11 = r1[j2];
    if (typeof v00 !== 'number' || typeof v10 !== 'number') return null;
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) +
        (v10 * (1 - tx) + v11 * tx) * ty;
}

function propGambitFof2At(lat, lon, value, snapshot) {
    const g = snapshot && snapshot.gambit;
    if (!g || !g.lats || !g.lats.length || !g.values || !g.uts) return null;
    const t = asDate(value);
    const ut = t.getUTCHours() + t.getUTCMinutes() / 60;
    const uts = g.uts, n = uts.length;
    let a = 0;
    for (let i = 0; i < n; i++) if (uts[i] <= ut) a = i;
    const b = (a + 1) % n;
    const f = (((ut - uts[a]) + 24) % 24) / ((24 / n) || 1);
    const va = propGambitSliceAt(g, g.values[a], lat, lon);
    if (va === null) return null;
    const vb = propGambitSliceAt(g, g.values[b], lat, lon);
    return vb === null ? va : va * (1 - f) + vb * f;
}

function propRegionBias(lat, lon, value, snapshot, env) {
    const when = asDate(value);
    const st = snapshot && snapshot.muf && snapshot.muf.stations;
    if (!st || !st.length || !snapshot.gambit) return 1;
    const nowMs = nowOf(env, when);
    const kAt = propMufDayFactor(sunFactor(lat, lon, when));
    let num = 0, den = 0;
    for (const s of st) {
        if (typeof s[3] !== 'number' || s[3] <= 0) continue;
        const d = propDistance({lat, lon}, {lat: s[0], lon: s[1]});
        if (d > 2500) continue;
        const ageW = propSondeAgeWeight(s, nowMs);
        if (!ageW) continue;
        const model = propGambitFof2At(s[0], s[1], when, snapshot);
        if (model === null || model < 1) continue;
        const kM = propStationHourFactor(s) || 1;
        const wgt = ageW / Math.pow(d + 40, 2);
        num += ((s[3] / kM) * kAt / model) * wgt;
        den += wgt;
    }
    if (!den) return 1;
    return clamp(num / den, 0.75, 1.35);
}

function propIrtamMuf(lat, lon, when, snapshot, env) {
    const fof2 = propGambitFof2At(lat, lon, when, snapshot);
    if (fof2 === null) return null;
    const sf = clamp(sunFactor(lat, lon, when), 0, 1);
    return fof2 * propRegionBias(lat, lon, when, snapshot, env) * (2.45 + 0.55 * sf);
}

function propClimatMuf(lat, lon, when, snapshot, env) {
    const irtam = propIrtamMuf(lat, lon, when, snapshot, env);
    if (irtam !== null) return irtam;
    const sfi = snapshot && snapshot.ham && snapshot.ham.sfi;
    const base = sfi ? 1.5 + 0.22 * sfi : 8;
    const dec = propTerminator(when).dec;
    const noonSf = Math.max(0, Math.cos(propRad(Math.abs(lat - dec))));
    const peak = base * (0.30 + 0.70 * Math.pow(noonSf, 0.7));
    const kAt = propMufDayFactor(sunFactor(lat, lon, when));
    const kNoon = propMufDayFactor(noonSf);
    return peak * clamp(kAt / (kNoon || 1), 0.35, 1.15) * propGeoMufFactor(snapshot);
}

function propAbsWeight(sf) {
    return clamp((sf + 0.15) / 1.15, 0.1, 1);
}

function propXrayNow(snapshot) {
    const list = snapshot && snapshot.xray && snapshot.xray.list;
    if (list && list.length) {
        const last = list[list.length - 1];
        const f = Array.isArray(last) ? last[1] : null;
        if (f > 0) return f;
    }
    const hx = snapshot && snapshot.ham && snapshot.ham.xray;
    if (hx) {
        const m = /^([ABCMX])([\d.]+)/i.exec(String(hx).trim());
        if (m) {
            const scale = {A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4}[m[1].toUpperCase()];
            const v = scale * parseFloat(m[2]);
            if (v > 0) return v;
        }
    }
    return 3e-7;
}

function propLufClim(lat, lon, when, snapshot) {
    const sf = sunFactor(lat, lon, when);
    if (sf <= -0.05) return 0;
    const x = propXrayNow(snapshot);
    const xScale = clamp(Math.pow(x / 3e-7, 0.25), 0.5, 4);
    return 5.2 * xScale * Math.pow(clamp(sf, 0, 1), 0.75) * propGeoAbsFactor(snapshot);
}

function propMagLat(lat, lon) {
    const p = propRad(PROP_MAG_POLE.lat);
    const s = Math.sin(propRad(lat)) * Math.sin(p) +
        Math.cos(propRad(lat)) * Math.cos(p) * Math.cos(propRad(lon - PROP_MAG_POLE.lon));
    return propDeg(Math.asin(clamp(s, -1, 1)));
}

function propScaleS(snapshot) {
    const list = (snapshot && snapshot.proton && snapshot.proton.list) || [];
    for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i][1];
        if (typeof f !== 'number' || !isFinite(f)) continue;
        if (f >= 1e5) return 5;
        if (f >= 1e4) return 4;
        if (f >= 1e3) return 3;
        if (f >= 100) return 2;
        if (f >= 10) return 1;
        return 0;
    }
    return null;
}

function propPcaLuf(lat, lon, when, snapshot) {
    const s = propScaleS(snapshot);
    if (!s) return 0;
    const m = Math.abs(propMagLat(lat, lon));
    const cutoff = 60;
    if (m <= cutoff) return 0;
    const depth = clamp((m - cutoff) / 12, 0.25, 1);
    const day = propAbsWeight(sunFactor(lat, lon, when));
    const base = [0, 2.5, 4, 6, 8, 10][clamp(s, 0, 5)];
    return base * depth * day;
}

function propGeomagDistance(a, b) {
    const dLat = propRad(a[1] - b.lat);
    const dLon = propRad(a[2] - b.lon);
    const k = Math.sin(dLat / 2) ** 2 +
        Math.cos(propRad(b.lat)) * Math.cos(propRad(a[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(k));
}

function propKFromAmp(a) {
    if (a >= 500) return 9;
    if (a >= 300) return 8;
    if (a >= 200) return 7;
    if (a >= 140) return 6;
    if (a >= 100) return 5;
    if (a >= 70) return 4;
    if (a >= 50) return 3;
    if (a >= 30) return 2;
    if (a >= 18) return 1;
    return 0;
}

function propGeoK(snapshot) {
    const geo = snapshot && snapshot.geo;
    if (geo && geo.k !== null && geo.k !== undefined) return geo.k;
    const list = snapshot && snapshot.kp && snapshot.kp.list;
    if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
            const v = list[i][1];
            if (typeof v === 'number' && isFinite(v)) return v;
        }
    }
    return null;
}

function propGeoMufFactor(snapshot) {
    const k = propGeoK(snapshot);
    if (k === null || k < 4) return 1;
    return clamp(1 - 0.012 * Math.pow(k - 3, 1.6), 0.75, 1);
}

function propGeoAbsFactor(snapshot) {
    const k = propGeoK(snapshot);
    if (k === null || k < 4) return 1;
    return clamp(1 + 0.008 * Math.pow(k - 3, 1.5), 1, 1.25);
}

function propSnapshotTime(snapshot, env) {
    const f = snapshot && snapshot.fetched;
    if (f && f.muf) return new Date(f.muf);
    const t = snapshot && snapshot.ts;
    return t ? new Date(t) : new Date(env.nowMs);
}

function propDrapTime(snapshot, env) {
    const d = snapshot && snapshot.drap;
    const m = d && d.valid
        ? /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*UTC/i.exec(d.valid) : null;
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    const f = snapshot && snapshot.fetched;
    return f && f.drap ? new Date(f.drap) : propSnapshotTime(snapshot, env);
}

function propPathWindow(prof, when, snapshot, env) {
    const data = snapshot || {};
    const drapAt = propDrapTime(data, env);
    const sfi = data.ham && data.ham.sfi;
    let mufMin = Infinity, lufMax = 0;
    for (const m of prof.mids) {
        const iono = propIonoAt(m.lat, m.lon, when, data, env);
        const span = clamp(prof.hopLen / PROP_HOP_KM, 0, 1);
        let base;
        if (iono) {
            base = iono.fof2 + (iono.muf - iono.fof2) * span;
        } else {
            const eq = propClimatMuf(m.lat, m.lon, when, data, env);
            base = 0.62 * eq + 0.38 * eq * span;
        }
        if (base < mufMin) mufMin = base;

        const drap = propDrapAt(m.lat, m.lon, data);
        const lufClim = propLufClim(m.lat, m.lon, when, data) * Math.sqrt(prof.hops);
        let lufHop = lufClim;
        if (drap !== null && !(data.drap && data.drap.noData)) {
            const wAt = propAbsWeight(sunFactor(m.lat, m.lon, when));
            const wNow = propAbsWeight(sunFactor(m.lat, m.lon, drapAt));
            const scale = clamp(wAt / wNow, 0.3, 4);
            lufHop = Math.max(lufHop, Math.max(2.0,
                1.55 * drap * Math.sqrt(prof.hops) * scale));
        }
        const pca = propPcaLuf(m.lat, m.lon, when, data);
        if (pca > lufHop) lufHop = pca;
        if (lufHop > lufMax) lufMax = lufHop;
    }
    if (!isFinite(mufMin)) mufMin = sfi ? 1.5 + 0.22 * sfi : 8;
    return {muf: mufMin, luf: lufMax};
}

function propBandScore(b, win) {
    const hi = 1 / (1 + Math.exp((b.f - 0.95 * win.muf) / (0.12 * win.muf || 1)));
    const lo = 1 / (1 + Math.exp((win.luf - b.f) / 1.1));
    return Math.round(100 * hi * lo);
}

function propNoonHour(lon, value) {
    const now = asDate(value);
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let best = 0, bestD = 999;
    for (let h = 0; h < 24; h += 0.25) {
        const d = Math.abs(propLonRel(lon - propTerminator(new Date(base + h * 3600e3)).lonSun, 0));
        if (d < bestD) { bestD = d; best = h; }
    }
    return best;
}

function propHomeProfile(de) {
    return {dist: PROP_HOP_KM, hops: 1, hopLen: PROP_HOP_KM,
        mids: [{lat: de.lat, lon: de.lon}]};
}

function bandCondOf(f, win, limits) {
    const lim = limits || {};
    const closed = Number.isFinite(lim.closed) ? lim.closed : 0.97;
    const good = Number.isFinite(lim.good) ? lim.good : 0.55;
    const fair = Number.isFinite(lim.fair) ? lim.fair : 0.25;
    if (f > closed * win.muf) return 'Closed';
    if (f < win.luf) return 'Poor';
    const head = (win.muf - f) / Math.max(1, win.muf - win.luf);
    return head > good ? 'Good' : head > fair ? 'Fair' : 'Poor';
}

function propBandConds(de, value, snapshot, env) {
    if (!de || !snapshot) return null;
    const now = asDate(value);
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const noon = propNoonHour(de.lon, now);
    const prof = propHomeProfile(de);
    const day = propPathWindow(prof, new Date(base + noon * 3600e3), snapshot, env);
    const night = propPathWindow(prof, new Date(base + ((noon + 12) % 24) * 3600e3), snapshot, env);
    const bands = {};
    for (const b of PROP_BANDS) {
        bands[b.name] = {day: bandCondOf(b.f, day, env && env.cond),
            night: bandCondOf(b.f, night, env && env.cond)};
    }
    return {bands, day, night, noon};
}

function propPathMatrix(de, dx, value, snapshot, env) {
    if (!snapshot || !de) return null;
    const now = asDate(value);
    const prof = propPathProfile(de, dx);
    const mid = propAlong(de, dx, 0.5);
    const hourNow = now.getUTCHours();
    const rows = PROP_BANDS.map(b => ({name: b.name, f: b.f, cells: []}));
    let baseMuf = 8;
    for (let h = 0; h < 24; h++) {
        const when = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
            now.getUTCDate(), h, 0, 0));
        const win = propPathWindow(prof, when, snapshot, env);
        if (h === hourNow) baseMuf = win.muf;
        for (const r of rows) r.cells.push(propBandScore(r, win));
    }
    return {rows, mid, dist: prof.dist, hops: prof.hops, baseMuf, hourNow,
        bearing: propBearing(de, dx)};
}

function propContinentTable(de, value, snapshot, env) {
    if (!de || !snapshot) return null;
    const when = asDate(value);
    let own = null, ownDist = Infinity;
    for (const c of PROP_CONTINENTS) {
        for (const p of c.pts) {
            const d = propDistance(de, {lat: p[0], lon: p[1]});
            if (d < ownDist) { ownDist = d; own = c.key; }
        }
    }
    const rows = [];
    for (const c of PROP_CONTINENTS) {
        if (c.key === own) continue;
        const wins = c.pts.map(p => propPathWindow(
            propPathProfile(de, {lat: p[0], lon: p[1]}), when, snapshot, env));
        let best = null;
        for (const b of PROP_BANDS) {
            let sum = 0;
            for (const win of wins) sum += propBandScore(b, win);
            const score = Math.round(sum / c.pts.length);
            if (!best || score > best.score) best = {band: b.name, score};
        }
        rows.push({key: c.key, band: best.band, score: best.score});
    }
    return {rows, own};
}

function propMufField(when, snapshot, env) {
    const nLat = 180 / PROP_MUF_LAT_STEP + 1;
    const nLon = 360 / PROP_MUF_LON_STEP;
    const vals = new Float32Array(nLat * nLon);
    for (let i = 0; i < nLat; i++) {
        const lat = -90 + i * PROP_MUF_LAT_STEP;
        for (let j = 0; j < nLon; j++) {
            const lon = -180 + j * PROP_MUF_LON_STEP;
            const clim = propClimatMuf(lat, lon, when, snapshot, env);
            const iono = propIonoAt(lat, lon, when, snapshot, env);
            let muf = clim;
            if (iono) {
                const w = clamp((2500 - iono.dMin) / 700, 0, 1);
                muf = w * iono.muf + (1 - w) * clim;
            }
            vals[i * nLon + j] = muf;
        }
    }
    return {vals, nLat, nLon};
}

function mufFieldAt(f, lat, lon) {
    const y = clamp((lat + 90) / PROP_MUF_LAT_STEP, 0, f.nLat - 1 - 1e-6);
    const i = Math.floor(y), ty = y - i;
    let x = (((lon + 180) / PROP_MUF_LON_STEP) % f.nLon + f.nLon) % f.nLon;
    const j = Math.floor(x), tx = x - j;
    const j2 = (j + 1) % f.nLon;
    const r0 = i * f.nLon, r1 = Math.min(i + 1, f.nLat - 1) * f.nLon;
    const v00 = f.vals[r0 + j], v01 = f.vals[r0 + j2];
    const v10 = f.vals[r1 + j], v11 = f.vals[r1 + j2];
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) +
        (v10 * (1 - tx) + v11 * tx) * ty;
}

module.exports = {
    PROP_BANDS, PROP_CONTINENTS, PROP_HOP_KM, PROP_MUF_LAT_STEP, PROP_MUF_LON_STEP,
    PROP_MAG_POLE, PROP_GEO_STATIONS,
    propRad, propDeg, clamp, propLonRel, propTerminator, propDistance, propBearing,
    propAlong, sunFactor, propStationHourFactor, propSondeAgeWeight, propIonoAt,
    propMufAt, propMufShown, propDrapAt, propWxAt, propPathProfile, propMufDayFactor,
    propGambitSliceAt, propGambitFof2At, propRegionBias, propIrtamMuf, propClimatMuf,
    propAbsWeight, propXrayNow, propLufClim, propMagLat, propScaleS, propPcaLuf,
    propGeomagDistance, propKFromAmp, propGeoK, propGeoMufFactor, propGeoAbsFactor,
    propSnapshotTime, propDrapTime, propPathWindow, propBandScore, propNoonHour,
    propHomeProfile, bandCondOf, propBandConds, propPathMatrix, propContinentTable,
    propMufField, mufFieldAt
};
