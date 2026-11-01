/**
 * DX-Compass - IRTAM / GAMBIT coefficient evaluation.
 *
 * LGDC publishes the IRI-based Real-Time Assimilative Model (IRTAM) as a
 * Jones-Gallet temporal-spatial expansion over a 46 x 45 global grid:
 *
 *   https://lgdc.uml.edu/rix/gambit-coeffs?time=yyyy.mm.ddThh:mm&charName=foF2
 *
 * The payload carries 1064 numbers. The first 988 are the classic 13-term
 * Jones-Gallet expansion (13 temporal functions x 76 spatial functions, the
 * same basis CCIR/IRI uses), the trailing 76 are the linear-trend block
 * ("JonesGallet_LinTrend"), which is zero at the time of validity.
 *
 *   P(t, lat, lon) = sum_k sum_j  c[j + 13*k] * D_j(t) * G_k(lat, lon)
 *
 * D(t)  = [1, sin(0)=0, cos T, sin T, cos 2T, sin 2T, ... cos 6T], T = 15UT - 180 deg
 * G(.,.) = sin(modip)^i * cos(lat)^j * {cos(j lon), sin(j lon)}
 *
 * modip needs the geomagnetic inclination, so the module carries a small
 * IGRF-13 synthesis (Schmidt semi-normalised, degree 13) and interpolates the
 * published coefficients in igrf13.shc to the requested date. A dipole
 * approximation was measured to shift the reconstructed field by ~1.5% per
 * degree of modip error, which is why IGRF is used instead.
 *
 * Only downloading/validating the payload lives in gambit.js; this module
 * turns coefficients into a field. Nothing here touches the network.
 *
 *   node lib/irtam.js --file gambit.json          # stats + CLI self-check
 *   node lib/irtam.js --time 2026.10.25T12:00     # fetch then evaluate
 */
'use strict';

const fs = require('fs');
const path = require('path');

const R_EARTH = 6371.2;         // IGRF reference radius, km
const IGRF_ALT = 300;           // IRI evaluates geomagnetic elements at 300 km
const SHC_FILE = path.join(__dirname, 'igrf13.shc');

/* Spatial basis: Q[j] is the power of sin(modip) used with cos(lat)^j.
 * 12 + 24 + 18 + 10 + 4 + 2 + 2 + 2 + 2 = 76 functions. */
const Q = [12, 12, 9, 5, 2, 1, 1, 1, 1];
const NK = 76;
const NJ = 13;

/* ---------------- IGRF-13 ---------------- */

let IGRF = null;

function loadIg() {
    if (IGRF) return IGRF;
    const text = fs.readFileSync(SHC_FILE, 'utf8');
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    let i = 0;
    while (i < lines.length && lines[i].trim().startsWith('#')) i++;
    const head = lines[i].trim().split(/\s+/);
    const nmax = +head[1];
    const years = lines[i + 1].trim().split(/\s+/).map(Number);
    const rows = [];
    for (i += 2; i < lines.length; i++) {
        const f = lines[i].trim().split(/\s+/).map(Number);
        if (f.length < years.length + 2) continue;
        rows.push({n: f[0], m: f[1], v: f.slice(2, 2 + years.length)});
    }
    const g = [], h = [];
    for (let n = 0; n <= nmax; n++) {
        g[n] = [];
        h[n] = [];
        for (let m = 0; m <= n; m++) {
            /* h has no m = 0 term, so every slot starts out as a real array */
            g[n][m] = new Array(years.length).fill(0);
            h[n][m] = new Array(years.length).fill(0);
        }
    }
    for (const r of rows) {
        if (r.m >= 0) g[r.n][r.m] = r.v;
        else h[r.n][-r.m] = r.v;
    }
    IGRF = {nmax, years, g, h};
    return IGRF;
}

/* Interpolate every coefficient to a decimal year (linear, as IRI does; the
 * extrapolation past the last epoch is the same linear continuation). */
const yearCache = new Map();
function igrfAt(year) {
    const key = Math.round(year * 100) / 100;
    if (yearCache.has(key)) return yearCache.get(key);
    const ig = loadIg();
    const ys = ig.years;
    let a = 0;
    while (a < ys.length - 2 && key > ys[a + 1]) a++;
    const f = (key - ys[a]) / (ys[a + 1] - ys[a]);
    const g = [], h = [];
    for (let n = 0; n <= ig.nmax; n++) {
        g[n] = [];
        h[n] = [];
        for (let m = 0; m <= n; m++) {
            g[n][m] = ig.g[n][m][a] + (ig.g[n][m][a + 1] - ig.g[n][m][a]) * f;
            h[n][m] = ig.h[n][m][a] + (ig.h[n][m][a + 1] - ig.h[n][m][a]) * f;
        }
    }
    const out = {nmax: ig.nmax, g, h};
    yearCache.set(key, out);
    return out;
}

const FAC = [1];
for (let i = 1; i <= 26; i++) FAC[i] = FAC[i - 1] * i;

/* Schmidt semi-normalisation: sqrt((2 - delta_m0) * (n-m)! / (n+m)!) */
function schmidt(n, m) {
    return Math.sqrt((m === 0 ? 2 : 1) * FAC[n - m] / FAC[n + m]);
}

/* Associated Legendre P_n^m(cos theta) and dP/dtheta, unnormalised (no
 * Condon-Shortley phase), degrees up to nmax. */
function legendre(nmax, theta) {
    const ct = Math.cos(theta), st = Math.sin(theta);
    const P = [[1]], dP = [[0]];
    for (let n = 1; n <= nmax; n++) {
        P[n] = new Array(n + 1).fill(0);
        dP[n] = new Array(n + 1).fill(0);
        P[n][n] = (2 * n - 1) * st * P[n - 1][n - 1];
        dP[n][n] = (2 * n - 1) * (st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]);
        P[n][n - 1] = (2 * n - 1) * ct * P[n - 1][n - 1];
        dP[n][n - 1] = (2 * n - 1) * (ct * dP[n - 1][n - 1] - st * P[n - 1][n - 1]);
        for (let m = 0; m <= n - 2; m++) {
            P[n][m] = ((2 * n - 1) * ct * P[n - 1][m] - (n + m - 1) * P[n - 2][m]) / (n - m);
            dP[n][m] = ((2 * n - 1) * (ct * dP[n - 1][m] - st * P[n - 1][m]) -
                (n + m - 1) * dP[n - 2][m]) / (n - m);
        }
    }
    return {P, dP};
}

/* Geomagnetic inclination, degrees (downward positive), at 300 km. */
function inclination(lat, lon, year) {
    const ig = igrfAt(year);
    const r = R_EARTH + IGRF_ALT;
    const ar = R_EARTH / r;
    const theta = (90 - lat) * Math.PI / 180;
    const phi = lon * Math.PI / 180;
    const st = Math.sin(theta);
    const {P, dP} = legendre(ig.nmax, theta);
    let br = 0, bt = 0, bp = 0;
    for (let n = 1; n <= ig.nmax; n++) {
        const f = Math.pow(ar, n + 2);
        let sr = 0, sth = 0, sph = 0;
        for (let m = 0; m <= n; m++) {
            const s = schmidt(n, m);
            const g = ig.g[n][m] * s, h = ig.h[n][m] * s;
            const cm = Math.cos(m * phi), sm = Math.sin(m * phi);
            const gh = g * cm + h * sm;
            sr += gh * P[n][m];
            sth += gh * dP[n][m];
            sph += m * (g * sm - h * cm) * P[n][m];
        }
        br += (n + 1) * f * sr;
        bt -= f * sth;
        bp += f * sph / (Math.abs(st) < 1e-9 ? 1e-9 : st);
    }
    const x = -bt, y = bp, z = -br;                    // north, east, down
    return Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI;
}

/* Modified dip latitude (the magnetic coordinate of the Jones-Gallet basis).
 * modip = atan(I / sqrt(cos(lat))); cached per half-degree cell because the
 * IGRF synthesis is the expensive part of a field evaluation. */
const modipCache = new Map();
function modip(lat, lon, year) {
    const yr = Math.round((year || 2026) * 10) / 10;
    const cLat = Math.round(lat * 2) / 2;
    const cLon = Math.round(lon * 2) / 2;
    const key = yr + '|' + cLat + '|' + cLon;
    const hit = modipCache.get(key);
    if (hit !== undefined) return hit;
    const inc = inclination(cLat, cLon, yr);
    const arg = (inc * Math.PI / 180) / Math.sqrt(Math.max(0.01, Math.cos(cLat * Math.PI / 180)));
    const v = Math.atan(arg) * 180 / Math.PI;
    if (modipCache.size > 40000) modipCache.clear();
    modipCache.set(key, v);
    return v;
}

/* ---------------- Jones-Gallet basis ---------------- */

/* 76 spatial functions, in the order the coefficient file uses them. */
function basis(lat, lon, mip) {
    const out = new Array(NK);
    const s = Math.sin(mip * Math.PI / 180);
    const c = Math.cos(lat * Math.PI / 180);
    let k = 0;
    for (let j = 0; j < Q.length; j++) {
        const cj = Math.pow(c, j);
        for (let i = 0; i < Q[j]; i++) {
            const si = Math.pow(s, i) * cj;
            for (let m = 0; m < 2; m++) {
                if (j === 0 && m === 1) continue;      // only cos(0)=1
                const f3 = m === 0 ? Math.cos(lon * j * Math.PI / 180)
                    : Math.sin(lon * j * Math.PI / 180);
                out[k++] = si * f3;
            }
        }
    }
    return out;
}

/* 13 temporal functions at universal time `ut` (hours).
 * The second slot is sin(0) = 0: a dummy the CCIR fit reserves, kept here so
 * the 13 coefficients per spatial function stay aligned. */
function diurnal(ut) {
    const t = (15 * ut - 180) * Math.PI / 180;
    const out = new Array(NJ);
    out[0] = 1;
    out[1] = 0;
    for (let n = 1, k = 2; k < NJ; n++) {
        out[k++] = Math.cos(n * t);
        if (k < NJ) out[k++] = Math.sin(n * t);
    }
    return out;
}

/* Evaluate one characteristic at a point. `coeffs` holds 988 (or 1064) values. */
function expand(coeffs, ut, lat, lon, year) {
    const gg = basis(lat, lon, modip(lat, lon, year));
    const dd = diurnal(ut);
    let v = 0;
    for (let k = 0; k < NK; k++) {
        let s = 0;
        const off = 13 * k;
        for (let j = 0; j < NJ; j++) s += coeffs[off + j] * dd[j];
        v += s * gg[k];
    }
    return v;
}

/**
 * Sample a field on a regular grid.
 * opts: {lats:[...], lons:[...], ut, year, floor}
 * Returns {lats, lons, ut, values: [[per lon] per lat]}.
 */
function gridField(coeffs, opts) {
    const o = opts || {};
    const lats = o.lats, lons = o.lons;
    const ut = o.ut === undefined ? 12 : o.ut;
    const year = o.year || 2026;
    const floor = o.floor === undefined ? null : o.floor;
    const values = [];
    for (const lat of lats) {
        const row = [];
        for (const lon of lons) {
            let v = expand(coeffs, ut, lat, lon, year);
            if (floor !== null && v < floor) v = floor;
            row.push(Math.round(v * 100) / 100);
        }
        values.push(row);
    }
    return {lats, lons, ut, year, values};
}

/* ---------------- helpers ---------------- */

/* Decimal year for an ISO date string (default now). */
function decimalYear(d) {
    const t = d ? new Date(d) : new Date();
    const y = t.getUTCFullYear();
    const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
    return y + (t.getTime() - start) / (end - start);
}

/* GAMBIT time of validity "2026.10.25T12:00" -> decimal year. */
function yearOfGambit(valid) {
    const m = /(\d{4})\.(\d{2})\.(\d{2})T(\d{2}):(\d{2})/.exec(String(valid || ''));
    if (!m) return decimalYear();
    return decimalYear(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}

/* UT hours of a GAMBIT time of validity. */
function utOfGambit(valid) {
    const m = /T(\d{2}):(\d{2})/.exec(String(valid || ''));
    return m ? +m[1] + +m[2] / 60 : 12;
}

module.exports = {
    Q, NK, NJ,
    loadIg, igrfAt, inclination, modip,
    basis, diurnal, expand, gridField,
    decimalYear, yearOfGambit, utOfGambit
};

/* ---------------- CLI self-check ---------------- */
function fmt(v, d) { return v.toFixed(d === undefined ? 2 : d); }

function stats(values) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0, neg = 0;
    for (const row of values) for (const v of row) {
        if (v < min) min = v;
        if (v > max) max = v;
        if (v < 0) neg++;
        sum += v;
        n++;
    }
    return {min, max, mean: sum / n, neg, n};
}

async function main() {
    const argv = process.argv.slice(2);
    const argOf = name => {
        const i = argv.indexOf('--' + name);
        return i >= 0 ? argv[i + 1] : null;
    };

    console.log('IGRF check (inclination / modip):');
    for (const p of [[39.9, 116.4, 'Beijing'], [0, 0, 'Gulf of Guinea'],
        [-33.9, 151.2, 'Sydney'], [69.6, 18.9, 'Tromso']]) {
        console.log('  ' + p[2].padEnd(16) + ' inc ' +
            fmt(inclination(p[0], p[1], 2026.8), 1) + '  modip ' +
            fmt(modip(p[0], p[1], 2026.8), 1));
    }

    let payload;
    const file = argOf('file');
    if (file) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        payload = raw.items ? raw.items[0] : raw;
        payload = {valid: payload.valid || payload.time, coeffs: payload.coeffs};
    } else {
        const gambit = require('./gambit.js');
        const time = argOf('time') || gambit.defaultTime();
        const res = await gambit.fetchGambit(time, argOf('char') || 'foF2');
        const p = gambit.parseGambit(res.body);
        if (!p.complete) throw new Error('incomplete payload ' +
            p.coeffs.length + '/' + p.expected);
        payload = {valid: p.valid, coeffs: p.coeffs};
    }

    const year = yearOfGambit(payload.valid);
    console.log('\nGAMBIT ' + payload.valid + '  coeffs ' + payload.coeffs.length +
        '  decimal year ' + fmt(year, 3) + '  units per file');

    const lats = [], lons = [];
    for (let la = -80; la <= 80; la += 10) lats.push(la);
    for (let lo = -180; lo <= 180; lo += 10) lons.push(lo);

    for (const ut of [0, 6, 12, 18]) {
        const g = gridField(payload.coeffs, {lats, lons, ut, year});
        const s = stats(g.values);
        console.log('  UT ' + String(ut).padStart(2, '0') + '  min ' + fmt(s.min) +
            '  max ' + fmt(s.max) + '  mean ' + fmt(s.mean) +
            '  negative ' + s.neg + '/' + s.n);
    }

    const bj = [];
    for (let ut = 0; ut < 24; ut += 3)
        bj.push(fmt(expand(payload.coeffs, ut, 39.9, 116.4, year), 1));
    console.log('  Beijing (39.9N 116.4E) every 3 h UT: ' + bj.join(' '));
}

if (require.main === module) {
    main().catch(e => {
        console.error('irtam self-check failed:', e && e.message ? e.message : e);
        process.exitCode = 1;
    });
}
