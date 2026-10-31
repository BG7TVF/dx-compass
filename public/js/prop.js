/* ============================================================
 * DX-Compass - Propagation page
 *
 * A dedicated page ("Propagation Map") combining:
 *   - a canvas world map with Mercator / azimuthal / Robinson
 *     projections, selectable MUF / weather / aurora backgrounds,
 *     the mandatory gray line (day/night terminator + night shading)
 *   - space-weather readings with history sparklines (SFI, SSN, Kp,
 *     A, Bz, Bt, solar wind, density, X-ray, Dst, aurora, DRAP)
 *   - NOAA R/S/G scales, HamQSL HF band conditions, global MUF/TOA
 *     readings and a DE->DX 24h x band availability matrix
 *
 * Data comes from GET /api/prop (server-side collector in lib/prop.js).
 * Everything is approximate except the measured indices; the point-to-
 * point matrix is explicitly labelled as an approximation (no VOACAP).
 * ============================================================ */

/* Bands used by the path matrix (band name + centre frequency in MHz). */
const PROP_BANDS = [
    {name: '160M', f: 1.9}, {name: '80M', f: 3.6}, {name: '60M', f: 5.3},
    {name: '40M', f: 7.1}, {name: '30M', f: 10.1}, {name: '20M', f: 14.1},
    {name: '17M', f: 18.1}, {name: '15M', f: 21.1}, {name: '12M', f: 24.9},
    {name: '10M', f: 28.5}
];

/* Sampling points per continent, as [lat, lon]. Each point is evaluated as its
 * own path from the home station and the band scores are averaged, so the row
 * is a plain mean of the same model that drives the DE->DX matrix -- nothing
 * is smoothed, floored or otherwise polished afterwards. */
const PROP_CONTINENTS = [
    {key: 'af', pts: [[6, 20], [-5, 25], [12, 0], [-18, 25]]},
    {key: 'as', pts: [[45, 90], [30, 75], [20, 105], [10, 80], [50, 100]]},
    {key: 'eu', pts: [[50, 15], [60, 10], [45, 0], [40, 20]]},
    {key: 'na', pts: [[40, -100], [30, -90], [50, -110], [20, -100]]},
    {key: 'sa', pts: [[-10, -60], [-20, -50], [-30, -60], [0, -70]]},
    {key: 'oc', pts: [[-25, 135], [-35, 145], [-10, 145]]},
    {key: 'an', pts: [[-80, 0], [-80, 120], [-80, -120]]}
];

const PROP_PROJECTIONS = ['mercator', 'azimuthal', 'robinson'];
const PROP_LAYERS = ['muf', 'weather', 'aurora'];
/* Mainland-safe limits used when filling the width: only land beyond these
 * may be clipped (Arctic islands above 78N, Antarctica below 56S). Cape
 * Chelyuskin (77.7N) and Cape Horn (56S), the outermost mainland tips, stay
 * inside the map. */
const PROP_NORTH_MIN = 78;
const PROP_SOUTH_MIN = -56;

const propState = {
    data: null, err: null, loading: false,
    proj: 'mercator', layer: 'muf',
    dx: {lat: 40, lon: -100}, de: null,
    canvas: null, wrap: null, ctx: null, w: 0, h: 0,
    hover: null, timer: null, poll: null, ro: null, view: false,
    lastDraw: 0
};

const propRad = d => d * Math.PI / 180;
const propDeg = r => r * 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* Every map on this page is centred on the home station's meridian: the flat
 * projections work in longitudes relative to it, propLonRel() folds a true
 * longitude into [-180,180] around that centre and propLonAbs() unfolds it. */
const propLonRel = (lon, lonC) => ((lon - lonC + 540) % 360) - 180;
const propLonAbs = (d, lonC) => ((d + lonC + 540) % 360) - 180;

function propNum(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return digits === undefined ? String(v) : Number(v).toFixed(digits);
}
function propShortTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(11, 16);
    return d.toISOString().slice(11, 16) + 'Z';
}

/* ---------------------------------------------------------------
 * Projections. Each returns {fwd(lon,lat), inv(x,y)} in CSS pixels,
 * fitted width-first (see propFit): the map always spans the full canvas
 * width, the northern edge sits on the top border, and the polar caps are
 * clipped -- Antarctica first, then the Arctic islands -- but never beyond
 * PROP_SOUTH_MIN / PROP_NORTH_MIN, so no mainland is ever cut. The map is
 * static: no wheel zoom and no panning. The azimuthal disc is an exception
 * -- it is centred and fitted with "contain" so the circular view stays
 * whole.
 * ------------------------------------------------------------- */
const ROB_X = [1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216,
    0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322];
const ROB_Y = [0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958,
    0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1];

function robinsonTable(absLat, table) {
    const i = clamp(Math.floor(absLat / 5), 0, 17);
    const t = absLat / 5 - i;
    return table[i] + (table[i + 1] - table[i]) * t;
}

/* Robinson Y table -> latitude (degrees, positive), by binary search on the
 * 5-degree rows. */
function robLatFromY(y) {
    const ay = Math.min(Math.abs(y / 1.3523), 1);
    let lo = 0, hi = 18;
    for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (robinsonTable(mid * 5, ROB_Y) < ay) lo = mid; else hi = mid;
    }
    return clamp(((lo + hi) / 2) * 5, 0, 90);
}

/* Width-first fit. Returns {sc, north, south, centered}:
 *  - the whole world when the canvas is tall enough (centred, vertical margins),
 *  - otherwise the latitude window that fills the width: give up the Antarctic
 *    first, then the Arctic islands, stopping at the mainland-safe limits,
 *  - and if even that window is too tall, shrink so side margins remain.
 * yOf(lat) must return the (positive) projected distance from the equator and
 * latFromY(y) its inverse, so the same logic serves every projection. */
function propFit(w, h, worldWidth, yNorth, yOf, latFromY, northLimit) {
    const scW = w / worldWidth;
    const need = h / scW;                       // vertical span at full width
    const yS = yOf(Math.abs(PROP_SOUTH_MIN));   // deepest allowed southern crop
    const yN = yOf(PROP_NORTH_MIN);             // deepest allowed northern crop
    if (need >= 2 * yNorth) {
        return {sc: scW, north: northLimit, south: -northLimit, centered: true};
    }
    const yS1 = need - yNorth;
    if (yS1 >= yS) {
        return {sc: scW, north: northLimit, south: -latFromY(yS1), centered: false};
    }
    const yN1 = need - yS;
    if (yN1 >= yN) {
        return {sc: scW, north: latFromY(yN1), south: PROP_SOUTH_MIN, centered: false};
    }
    return {sc: Math.min(scW, h / (yN + yS)), north: PROP_NORTH_MIN,
        south: PROP_SOUTH_MIN, centered: false};
}

function makeProjection(kind, w, h, de) {
    if (kind === 'azimuthal') {
        const lat0 = propRad(de ? de.lat : 40);
        const lon0 = propRad(de ? de.lon : 0);
        const sc = Math.min(w, h) / (2 * Math.PI);
        const cx = w / 2, cy = h / 2;
        return {
            kind: 'azimuthal',
            lon0: propDeg(lon0),
            lat0: propDeg(lat0),
            fwd(lon, lat) {
                const f = propRad(lat), dl = propRad(lon) - lon0;
                const cosc = Math.sin(lat0) * Math.sin(f) +
                    Math.cos(lat0) * Math.cos(f) * Math.cos(dl);
                const c = Math.acos(clamp(cosc, -1, 1));
                if (c > Math.PI * 0.999) return null;
                const k = c < 1e-9 ? 1 : c / Math.sin(c);
                const x = k * Math.cos(f) * Math.sin(dl);
                const y = k * (Math.cos(lat0) * Math.sin(f) -
                    Math.sin(lat0) * Math.cos(f) * Math.cos(dl));
                return [cx + x * sc, cy - y * sc];
            },
            inv(px, py) {
                const x = (px - cx) / sc, y = (cy - py) / sc;
                const c = Math.hypot(x, y);
                if (c > Math.PI) return null;
                if (c < 1e-9) return [propDeg(lat0), propDeg(lon0)];
                const lat = Math.asin(Math.cos(c) * Math.sin(lat0) +
                    (y * Math.sin(c) * Math.cos(lat0)) / c);
                const lon = lon0 + Math.atan2(x * Math.sin(c),
                    c * Math.cos(lat0) * Math.cos(c) - y * Math.sin(lat0) * Math.sin(c));
                let dlon = propDeg(lon);
                dlon = ((dlon + 540) % 360) - 180;
                return [propDeg(lat), dlon];
            }
        };
    }
    if (kind === 'robinson') {
        const xMax = 0.8487 * Math.PI, yMax = 1.3523;
        const yOf = lat => 1.3523 * robinsonTable(Math.abs(lat), ROB_Y);
        const fit = propFit(w, h, 2 * xMax, yMax, yOf, robLatFromY, 90);
        const sc = fit.sc, cx = w / 2;
        const cy = fit.centered ? h / 2 : yOf(fit.north) * sc;
        const lonC = de ? de.lon : 0;
        /* d is a longitude offset from the home meridian, never wrapped, so
         * ring copies shifted by +/-360 project outside the canvas instead of
         * folding back across it. */
        const fwdRaw = (d, lat) => {
            const a = Math.abs(lat), sg = lat < 0 ? -1 : 1;
            return [cx + 0.8487 * robinsonTable(a, ROB_X) * propRad(d) * sc,
                cy - 1.3523 * robinsonTable(a, ROB_Y) * sg * sc];
        };
        return {
            kind: 'robinson', lon0: lonC,
            fwd(lon, lat) { return fwdRaw(propLonRel(lon, lonC), lat); },
            fwdRaw,
            inv(px, py) {
                const x = (px - cx) / sc, y = (cy - py) / sc;
                const absLat = robLatFromY(y);
                const lat = y < 0 ? -absLat : absLat;
                const xs = 0.8487 * robinsonTable(absLat, ROB_X);
                if (!xs) return null;
                /* x is already in projection units (pixels/sc), so the offset
                 * in radians is x/xs -- dividing by sc again shrank the
                 * longitude to ~1/sc of the truth and clicks always landed on
                 * the home meridian. */
                return [lat, propLonAbs(propDeg(x / xs), lonC)];
            }
        };
    }
    // Mercator: same width-first fit, latitudes clamped at the Leaflet world bounds
    const northLimit = 85.06;
    const MY = lat => Math.log(Math.tan(Math.PI / 4 +
        clamp(lat, -northLimit, northLimit) * Math.PI / 360));
    const yOf = lat => MY(Math.abs(lat));
    const latFromY = y => propDeg(2 * Math.atan(Math.exp(y)) - Math.PI / 2);
    const fit = propFit(w, h, 2 * Math.PI, MY(northLimit), yOf, latFromY, northLimit);
    const sc = fit.sc, cx = w / 2;
    const cy = fit.centered ? h / 2 : yOf(fit.north) * sc;
    const lonC = de ? de.lon : 0;
    const fwdRaw = (d, lat) => [cx + propRad(d) * sc, cy - MY(lat) * sc];
    return {
        kind: 'mercator', lon0: lonC,
        fwd(lon, lat) { return fwdRaw(propLonRel(lon, lonC), lat); },
        fwdRaw,
        inv(px, py) {
            const x = (px - cx) / sc, y = (cy - py) / sc;
            const lat = latFromY(y);
            return [clamp(lat, -85, 85), propLonAbs(propDeg(x), lonC)];
        }
    };
}

/* ---------------------------------------------------------------
 * Solar geometry (identical math to the Leaflet gray line)
 * ------------------------------------------------------------- */
/* lonC = longitude the result is relative to (0 = true longitudes, used by
 * the azimuthal disc); the flat maps sweep their own home-centred range so
 * the terminator never jumps at the seam. */
function propTerminator(now, lonC) {
    lonC = lonC || 0;
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
        if (!isFinite(lat)) lat = prev;   // singular only at the exact equinox
        base.push([lat, d]);
        prev = lat;
    }
    return {
        dec: decDeg, lonSun, base,
        nightPole: decDeg > 0 ? -89.99 : 89.99,
        equinox: Math.abs(decDeg) < 0.6
    };
}

/* ---------------------------------------------------------------
 * Geodesy helpers
 * ------------------------------------------------------------- */
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
/* Point at fraction t along the great circle from a to b. */
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

/* Solar zenith cosine at a location -> 1 (sun overhead) .. -1 (antipodal) */
function sunFactor(lat, lon, d) {
    const dec = propRad(propTerminator(d).dec);
    const H = propRad(lon - propTerminator(d).lonSun);
    return Math.sin(propRad(lat)) * Math.sin(dec) +
        Math.cos(propRad(lat)) * Math.cos(dec) * Math.cos(H);
}

/* ---------------------------------------------------------------
 * Data lookups against the last collector snapshot
 * ------------------------------------------------------------- */
/* Interpolated ionosphere at a point from the kc2g sonde snapshot: MUF(3000)
 * and foF2, inverse-square weighted over stations within 2500 km.
 * The soundings are not simultaneous -- each station value belongs to its own
 * observation time, and kc2g can serve a sounding that is hours or years old.
 * So every value is first divided by the day factor at its station for its
 * own measured instant (a common "noon-equivalent" reference), interpolated,
 * and then multiplied by the day factor at the target for `when`. Without
 * this, a daytime sounding and a night-time sounding were averaged as if they
 * described the same ionosphere. Soundings older than a month are dropped and
 * older ones fade (propSondeAgeWeight). */
function propStationHourFactor(s) {
    if (typeof s[5] !== 'string' || !s[5]) return 1;
    /* kc2g timestamps carry no zone suffix; they are UTC, so pin them --
     * otherwise Date() reads them in the viewer's local zone. */
    const iso = /Z|[+-]\d{2}:?\d{2}$/.test(s[5]) ? s[5] : s[5] + 'Z';
    const t = new Date(iso);
    if (isNaN(t)) return 1;
    return Math.max(0.55, propMufDayFactor(sunFactor(s[0], s[1], t)));
}

/* Sounding age weight. Most kc2g rows are not fresh -- on a typical snapshot
 * only about a third are younger than a day, the rest go back weeks, months
 * or years -- so a stale sounding must not outweigh a fresh one nearby, and
 * anything older than a month is dropped outright (a 2023 measurement has no
 * business shaping today's forecast). */
function propSondeAgeWeight(s, nowMs) {
    if (typeof s[5] !== 'string' || !s[5]) return 0.3;    // unknown age
    const iso = /Z|[+-]\d{2}:?\d{2}$/.test(s[5]) ? s[5] : s[5] + 'Z';
    const t = new Date(iso);
    if (isNaN(t)) return 0.3;
    const ageH = (nowMs - t.getTime()) / 3600e3;
    if (ageH <= 1) return 1;
    return clamp(1 - (ageH - 1) / 720, 0, 1);             // fades out by 30 d
}

function propIonoAt(lat, lon, when) {
    const st = propState.data && propState.data.muf && propState.data.muf.stations;
    if (!st || !st.length) return null;
    const nowMs = Date.now();
    let num = 0, den = 0, numF = 0;
    for (const s of st) {
        if (typeof s[2] !== 'number') continue;
        const d = propDistance({lat, lon}, {lat: s[0], lon: s[1]});
        /* 2500 km: a sounding farther away describes a different F2 region,
         * not the one over the hop -- the caller then uses the SFI fallback
         * instead of extrapolating, e.g. a tropical sonde 4000 km north. */
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
    return {muf: base * kAt, fof2: baseF * kAt};
}

function propMufAt(lat, lon, when) {
    const p = propIonoAt(lat, lon, when || new Date());
    return p ? p.muf : null;
}

function propDrapAt(lat, lon) {
    const d = propState.data && propState.data.drap;
    if (!d || !d.lats || !d.lats.length) return null;
    const li = clamp(Math.round((d.lats[0] - lat) / 2), 0, d.lats.length - 1);
    const lo = clamp(Math.round((lon + 178) / 4), 0, d.lons.length - 1);
    const row = d.vals[li];
    return row && row[lo] !== undefined ? row[lo] : null;
}

function propWxAt(lat, lon) {
    const pts = propState.data && propState.data.wx && propState.data.wx.pts;
    if (!pts || !pts.length) return null;
    let best = null, bd = Infinity;
    for (const p of pts) {
        const d = propDistance({lat, lon}, {lat: p[0], lon: p[1]});
        if (d < bd) { bd = d; best = p; }
    }
    return best;
}

/* Approximate DE->DX availability (no VOACAP, but no longer a single
 * midpoint either):
 *  - the path is split into PROP_HOP_KM hops; every hop is sampled at its
 *    great-circle midpoint, so a 12000 km path crosses several local times
 *    instead of inheriting one mid-path noon;
 *  - the sonde snapshot gives MUF(3000) / foF2 per hop, blended by hop length
 *    (vertical foF2 for a short hop, MUF3000 for a full 3000 km hop); each
 *    sounding is normalised by the solar elevation at its own measured instant
 *    and then re-evaluated at the forecast hour, because soundings are neither
 *    simultaneous nor fresh;
 *  - the lower bound comes from the DRAP grid, which is already "the frequency
 *    absorbed by 1 dB"; a usable path needs ~1.55x that, scaled by sqrt(hops)
 *    (per-hop loss budget shrinks with hop count) and by the ratio of
 *    absorption at the forecast hour to absorption at the DRAP valid time;
 *  - the path MUF is the weakest hop, the path LUF the strongest one.
 * Availability (0-100) of one band for a prepared {muf, luf} window. */
const PROP_HOP_KM = 3000;

/* Great-circle profile: total length, hop count, hop length and the midpoint
 * of every hop. */
function propPathProfile(a, b) {
    const dist = propDistance(a, b);
    const hops = Math.max(1, Math.ceil(dist / PROP_HOP_KM));
    const hopLen = dist / hops;
    const mids = [];
    for (let i = 0; i < hops; i++) mids.push(propAlong(a, b, (i + 0.5) / hops));
    return {dist, hops, hopLen, mids};
}

/* Measured MUF/foF2 already sit at the snapshot's local solar elevation;
 * normalise them to "noon-equivalent" first, then apply the forecast hour's
 * elevation. Day factor: ~0.58 at night, ~1.13 with the sun overhead. */
function propMufDayFactor(sf) {
    return 0.58 + 0.55 * clamp((sf + 0.15) / 0.85, 0, 1);
}

/* Relative D-region absorption: ~0.1 at night, 1.0 with the sun overhead. */
function propAbsWeight(sf) {
    return clamp((sf + 0.15) / 1.15, 0.1, 1);
}

/* Sonde snapshot instant (kc2g refreshes every few minutes, so the fetch
 * time is a good stand-in for the observation time). */
function propSnapshotTime() {
    const f = propState.data && propState.data.fetched;
    if (f && f.muf) return new Date(f.muf);
    const t = propState.data && propState.data.ts;
    return t ? new Date(t) : new Date();
}

/* DRAP grid valid instant ("# Product Valid At : 2026-10-31 12:27 UTC"),
 * falling back to the fetch time. Absorption must be rescaled relative to the
 * grid's own hour, not to the sonde snapshot. */
function propDrapTime() {
    const d = propState.data && propState.data.drap;
    const m = d && d.valid
        ? /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*UTC/i.exec(d.valid) : null;
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    const f = propState.data && propState.data.fetched;
    return f && f.drap ? new Date(f.drap) : propSnapshotTime();
}

/* Path window (weakest-hop MUF and strongest-hop LUF) for the forecast `when`. */
function propPathWindow(prof, when) {
    const data = propState.data;
    const drapAt = propDrapTime();
    const sfi = data && data.ham && data.ham.sfi;
    let mufMin = Infinity, lufMax = 0;
    for (const m of prof.mids) {
        const iono = propIonoAt(m.lat, m.lon, when);
        const span = clamp(prof.hopLen / PROP_HOP_KM, 0, 1);
        let base;
        if (iono) {
            base = iono.fof2 + (iono.muf - iono.fof2) * span;
        } else {
            const eq = (sfi ? 1.5 + 0.22 * sfi : 8) *
                propMufDayFactor(sunFactor(m.lat, m.lon, when));
            base = 0.62 * eq + 0.38 * eq * span;
        }
        if (base < mufMin) mufMin = base;

        const drap = propDrapAt(m.lat, m.lon);
        if (drap !== null) {
            const wAt = propAbsWeight(sunFactor(m.lat, m.lon, when));
            const wNow = propAbsWeight(sunFactor(m.lat, m.lon, drapAt));
            const scale = clamp(wAt / wNow, 0.3, 4);
            const lufHop = Math.max(2.0,
                1.55 * drap * Math.sqrt(prof.hops) * scale);
            if (lufHop > lufMax) lufMax = lufHop;
        }
    }
    if (!isFinite(mufMin)) mufMin = sfi ? 1.5 + 0.22 * sfi : 8;
    return {muf: mufMin, luf: lufMax};
}

/* Smooth band-pass: usable below ~MUF, above the LUF. */
function propBandScore(b, win) {
    const hi = 1 / (1 + Math.exp((b.f - 0.95 * win.muf) / (0.12 * win.muf || 1)));
    const lo = 1 / (1 + Math.exp((win.luf - b.f) / 1.1));
    return Math.round(100 * hi * lo);
}

function propPathMatrix() {
    const data = propState.data;
    if (!data) return null;
    const de = propState.de, dx = propState.dx;
    if (!de) return null;
    const prof = propPathProfile(de, dx);
    const mid = propAlong(de, dx, 0.5);
    const now = new Date();
    const hourNow = now.getUTCHours();
    const rows = PROP_BANDS.map(b => ({name: b.name, f: b.f, cells: []}));
    let baseMuf = 8;
    for (let h = 0; h < 24; h++) {
        const when = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
            now.getUTCDate(), h, 0, 0));
        const win = propPathWindow(prof, when);
        if (h === hourNow) baseMuf = win.muf;
        for (const r of rows) r.cells.push(propBandScore(r, win));
    }
    return {rows, mid, dist: prof.dist, hops: prof.hops, baseMuf, hourNow,
        bearing: propBearing(de, dx)};
}

/* Best band from the home station to every other continent, for this instant.
 * The continent the station sits in is left out (nearest sampling point
 * decides it); the rest report their raw best-band score, even when it is
 * close to zero. */
function propContinentTable() {
    const de = propState.de, data = propState.data;
    if (!de || !data) return null;
    const when = new Date();
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
        /* one path window per sampling point, reused for all ten bands */
        const wins = c.pts.map(p => propPathWindow(
            propPathProfile(de, {lat: p[0], lon: p[1]}), when));
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

/* ---------------------------------------------------------------
 * Canvas rendering
 * ------------------------------------------------------------- */
/* The propagation canvas always uses HamClock's console palette -- a near
 * black ocean, dark grey land and a thin bright coastline. Keeping it fixed
 * (instead of following --map-bg / --map-land) means the coast and the
 * colour-coded MUF/weather field keep the same contrast under every UI
 * theme; in the light theme the old pastel land washed out completely. */
const PROP_MAP_COLORS = {
    bg: '#050b11',
    land: '#1b2932',
    line: '#7fb0c4',
    border: '#23404e',
    accent: '#00e5ff',
    orange: '#ff9f43',
    yellow: '#ffd166'
};

function mapColors() {
    return PROP_MAP_COLORS;
}

/* Project one ring for a home-centred flat map: the longitudes are unwrapped
 * around lonC and returned as up to three continuous copies (centre, -360,
 * +360). Each copy is projected raw, so whatever falls past the silhouette
 * simply leaves the canvas and is clipped away -- no ring is ever closed with
 * a chord across the map. */
function propRingCopies(ring, lonC, proj) {
    const flat = typeof ring[0] === 'number';
    const n = flat ? ring.length / 2 : ring.length;
    if (!n) return [];
    const at = i => flat ? [ring[i * 2], ring[i * 2 + 1]] : ring[i];
    const first = at(0), last = at(n - 1);
    const closed = Math.abs(first[0] - last[0]) < 1e-6 &&
        Math.abs(first[1] - last[1]) < 1e-6;
    /* Natural Earth closes Antarctica through a pole: the ring ends at -90
     * without repeating its start. Such a ring must be filled around the
     * pole edge, never closed with a chord back to its first point -- that
     * chord is the line that used to cut across every projection. */
    const pole = !closed && Math.abs(last[1]) >= 89.5
        ? (last[1] < 0 ? -89.99 : 89.99) : null;
    let tail = 0;
    if (pole) {
        while (tail < n && Math.abs(at(n - 1 - tail)[1]) >= 89.5) tail++;
    }
    const rels = new Float64Array(n), lats = new Float64Array(n);
    let prev = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
        const lon = flat ? ring[i * 2] : ring[i][0];
        const lat = flat ? ring[i * 2 + 1] : ring[i][1];
        let d = propLonRel(lon, lonC);
        if (i > 0) {
            while (d - prev > 180) d -= 360;
            while (prev - d > 180) d += 360;
        }
        rels[i] = d; lats[i] = lat; prev = d;
        if (d < min) min = d;
        if (d > max) max = d;
    }
    const out = [];
    for (let k = -1; k <= 1; k++) {
        if (max + 360 * k < -180 || min + 360 * k > 180) continue;
        const pts = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) {
            const q = proj.fwdRaw(rels[i] + 360 * k, lats[i]);
            pts[i * 2] = q[0]; pts[i * 2 + 1] = q[1];
        }
        out.push({pts, pole, tail,
            dFirst: rels[0] + 360 * k, dLast: rels[n - 1] + 360 * k});
    }
    return out;
}

function drawProp() {
    const s = propState;
    if (!s.ctx || !s.w || !s.h) return;
    const ctx = s.ctx, w = s.w, h = s.h, C = mapColors();
    const proj = makeProjection(s.proj, w, h, s.de);
    const lonC = proj.lon0 || 0;
    const now = new Date();
    /* The azimuthal view is a disc: everything is clipped to it, otherwise a
     * land ring or graticule line crossing the antipode (where fwd() returns
     * null) gets closed with a long straight chord right across the map --
     * the stray lines that made the disc look scrambled. */
    const disc = s.proj === 'azimuthal';
    const discR = Math.min(w, h) / 2;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.save();
    if (disc) {
        /* paint the disc only: the corners stay transparent so the panel
         * background shows through instead of a black slab */
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, discR, 0, Math.PI * 2);
        ctx.fill();
        ctx.clip();
    } else {
        /* Clip to the world silhouette traced along the +/-180 meridians.
         * On Robinson those meridians are curves, so a rectangle clip (the
         * old fix) still let the +/-360 ring copies bleed past the
         * elliptical edge at high latitudes -- land pixels outside the
         * world. The background fills the silhouette only, so the margins
         * show the panel colour like the disc's corners do. */
        ctx.beginPath();
        for (let lat = -90; lat <= 90; lat += 2) {
            const q = proj.fwdRaw(180, lat);
            if (lat === -90) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        }
        for (let lat = 90; lat >= -90; lat -= 2) {
            const q = proj.fwdRaw(-180, lat);
            ctx.lineTo(q[0], q[1]);
        }
        ctx.closePath();
        ctx.fill();
        ctx.clip();
    }

    /* land: filled polygons, then country borders, then coastlines.
     * land.js / borders.js store rings as flat [lon,lat,lon,lat,...]
     * arrays; nested [[lon,lat],...] is also accepted. */
    const land = window.LAND || [];
    const trace = ring => {
        ctx.beginPath();
        let started = false;
        const flat = typeof ring[0] === 'number';
        const n = flat ? ring.length / 2 : ring.length;
        for (let i = 0; i < n; i++) {
            const lon = flat ? ring[i * 2] : ring[i][0];
            const lat = flat ? ring[i * 2 + 1] : ring[i][1];
            const p = proj.fwd(lon, lat);
            if (!p) { started = false; continue; }
            if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
            else ctx.lineTo(p[0], p[1]);
        }
    };
    /* Flat maps are centred on the home meridian, so every ring is unwrapped
     * around it and painted in up to three copies (+/-360). Each copy stays
     * continuous, and the canvas clip hides the seam -- drawing a single
     * wrapped copy would close a land mass with a chord right across the map. */
    const paintRing = (ring, mode) => {
        if (disc) {
            trace(ring);
            /* No closePath: a closing chord would cut across the disc. The
             * implicit fill closure is the pole meridian for Antarctica, and
             * open border lines must never be tied back to their start. */
            if (mode === 'fill') ctx.fill(); else ctx.stroke();
            return;
        }
        for (const copy of propRingCopies(ring, lonC, proj)) {
            const pts = copy.pts;
            /* Antarctica's pole points collapse onto one projected point, so
             * the coastline stroke drops them and stops at the last real
             * vertex instead of doubling back. */
            const end = pts.length - (mode === 'stroke' && copy.pole ? copy.tail * 2 : 0);
            if (end < 4) continue;
            ctx.beginPath();
            ctx.moveTo(pts[0], pts[1]);
            for (let i = 2; i < end; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
            if (mode === 'fill') {
                /* fill around the pole edge instead of chording back to the
                 * first vertex (the stray line across every projection) */
                if (copy.pole) {
                    const a = proj.fwdRaw(copy.dLast, copy.pole);
                    const b = proj.fwdRaw(copy.dFirst, copy.pole);
                    ctx.lineTo(a[0], a[1]);
                    ctx.lineTo(b[0], b[1]);
                }
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.stroke();
            }
        }
    };
    ctx.fillStyle = C.land;
    for (const ring of land) paintRing(ring, 'fill');

    /* Background layer: painted over the land fill but *under* the graticule
     * and the coastline. Drawing it on top (the old order) at 0.55 alpha hid
     * the coast completely -- the map turned into a checkerboard. HamClock
     * keeps the coast crisp whatever the propagation field does. */
    if (s.layer === 'muf') drawMufLayer(ctx, proj, C);
    else if (s.layer === 'weather') drawWeatherLayer(ctx, proj, C);
    else if (s.layer === 'aurora') drawAuroraLayer(ctx, proj, C);

    /* graticule every 30 degrees */
    ctx.strokeStyle = C.border;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    for (let lon = -180; lon < 180; lon += 30) {
        if (disc) {
            /* meridians are curves on the disc, never straight chords */
            ctx.beginPath();
            let started = false;
            for (let lat = -85; lat <= 85; lat += 3) {
                const p = proj.fwd(lon, lat);
                if (!p) { started = false; continue; }
                if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
                else ctx.lineTo(p[0], p[1]);
            }
            ctx.stroke();
            continue;
        }
        const a = proj.fwd(lon, -85), b = proj.fwd(lon, 85);
        if (!a || !b) continue;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        let started = false;
        /* sweep the home-centred range so the parallel never jumps at the seam */
        for (let lon = -180; lon <= 180; lon += 3) {
            const p = disc ? proj.fwd(lon + lonC, lat) : proj.fwdRaw(lon, lat);
            if (!p) { started = false; continue; }
            if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
            else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke();
    }

    /* Country borders stay on the flat projections only: the coarse 110m
     * outlines are stretched badly by the disc and read as noise. */
    if (!disc) {
        ctx.strokeStyle = C.line;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 0.7;
        for (const seg of (window.BORDERS || [])) paintRing(seg, 'stroke');
    }
    /* coastline last, at full strength: this is what makes the land legible */
    ctx.strokeStyle = C.line;
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    for (const ring of land) paintRing(ring, 'stroke');

    /* gray line: night shading + terminator, refreshed every minute */
    drawGrayline(ctx, proj, w, h, now, C);

    /* DE -> DX great circle + markers */
    drawPath(ctx, proj, C);

    /* projection-appropriate frame: a complete circle on the disc, a
     * rectangle for the flat maps (drawn outside the world clip) */
    ctx.restore();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    if (disc) {
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, discR - 0.5, 0, Math.PI * 2);
        ctx.stroke();
    } else {
        ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    }

    propState.lastDraw = Date.now();
}

/* MUF heat grid: inverse-distance weighted ionosonde MUF3000 per cell */
function mufColor(muf) {
    const t = clamp((muf - 3) / 27, 0, 1);          // 3..30 MHz
    const stops = [
        [20, 60, 180], [40, 150, 220], [60, 190, 140],
        [220, 200, 60], [240, 120, 40], [220, 40, 60]
    ];
    const i = clamp(Math.floor(t * (stops.length - 1)), 0, stops.length - 2);
    const f = t * (stops.length - 1) - i;
    const a = stops[i], b = stops[i + 1];
    return [Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f)];
}

function drawMufLayer(ctx, proj, C) {
    const data = propState.data;
    if (!data) return;
    const has = data.muf && data.muf.stations && data.muf.stations.length;
    /* HamClock paints its MUF field as a soft colour wash, not a checkerboard.
     * A blurred 5x10 degree grid, drawn at low alpha under the coastline,
     * gives the same smooth gradient while the coast stays readable. */
    ctx.save();
    ctx.filter = 'blur(4px)';
    ctx.globalAlpha = 0.30;
    /* The grid is walked in home-centred offsets so no cell straddles the seam
     * of the shifted maps; the disc maps the offset back to a true longitude. */
    const lonC = proj.lon0 || 0;
    const raw = proj.fwdRaw || ((d, lat) => proj.fwd(propLonAbs(d, lonC), lat));
    for (let lat = -85; lat < 85; lat += 5) {
        for (let dl = -180; dl < 180; dl += 10) {
            const muf = has ? propMufAt(lat + 2.5, propLonAbs(dl + 5, lonC)) : null;
            if (muf === null) continue;
            const col = mufColor(muf);
            ctx.fillStyle = 'rgb(' + col.join(',') + ')';
            const a = raw(dl, lat), b = raw(dl + 10, lat);
            const c = raw(dl + 10, lat + 5), d = raw(dl, lat + 5);
            if (!a || !b || !c || !d) continue;
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
            ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
            ctx.closePath();
            ctx.fill();
        }
    }
    ctx.restore();
}

function wxColor(t) {
    const x = clamp((t + 30) / 70, 0, 1);
    const stops = [[40, 70, 160], [70, 150, 210], [90, 200, 150],
        [240, 210, 90], [235, 120, 50], [200, 40, 40]];
    const i = clamp(Math.floor(x * (stops.length - 1)), 0, stops.length - 2);
    const f = x * (stops.length - 1) - i;
    const a = stops[i], b = stops[i + 1];
    return [Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f)];
}

function drawWeatherLayer(ctx, proj, C) {
    const wx = propState.data && propState.data.wx;
    if (!wx || !wx.pts) return;
    const size = Math.max(20, Math.min(44, propState.w / 22));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 11px "Segoe UI", sans-serif';
    for (const p of wx.pts) {
        const q = proj.fwd(p[1], p[0]);
        if (!q) continue;
        const col = wxColor(p[2]);
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = 'rgb(' + col.join(',') + ')';
        ctx.fillRect(q[0] - size / 2, q[1] - size / 2, size, size);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.fillText(Math.round(p[2]) + '°', q[0], q[1]);
    }
    ctx.textAlign = 'start';
}

function drawAuroraLayer(ctx, proj, C) {
    const au = propState.data && propState.data.aurora;
    if (!au || !au.grid) return;
    const r = Math.max(2.5, Math.min(7, propState.w / 160));
    for (const p of au.grid) {
        const q = proj.fwd(p[0], p[1]);
        if (!q) continue;
        const a = clamp(p[2] / 100, 0, 1);
        ctx.globalAlpha = 0.25 + a * 0.6;
        ctx.fillStyle = a > 0.6 ? '#ff4d6d' : a > 0.3 ? '#f1c40f' : '#2ecc71';
        ctx.beginPath();
        ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

/* Terminator on the azimuthal disc as a radial boundary around the screen
 * centre. For every bearing there is exactly one crossing of the great circle
 * 90 degrees from the sun, so the loop is continuous everywhere -- sweeping
 * the terminator latitude by longitude (the old approach) put consecutive
 * samples on opposite sides of the antipode and drew chords across the map.
 * Day/night is decided by A = sun . centre-vector: with A > 0 the centre is
 * lit and the day region is the star around it. */
function propDiscBoundary(proj, w, h, t) {
    const lat0 = propRad(proj.lat0 || 0), lon0 = propRad(proj.lon0 || 0);
    const dec = propRad(t.dec), sun = propRad(t.lonSun);
    const A = Math.sin(dec) * Math.sin(lat0) +
        Math.cos(dec) * Math.cos(lat0) * Math.cos(sun - lon0);
    /* sun components along the local north and east directions at the centre */
    const sN = Math.sin(dec) * Math.cos(lat0) -
        Math.sin(lat0) * Math.cos(dec) * Math.cos(sun - lon0);
    const sE = Math.cos(dec) * Math.sin(sun - lon0);
    const cx = w / 2, cy = h / 2;
    const cpx = Math.min(w, h) / 2 / Math.PI;   // projected pixels per radian
    const pts = [];
    for (let deg = 0; deg < 360; deg += 2) {
        const th = propRad(deg);
        const B = sN * Math.cos(th) + sE * Math.sin(th);
        /* first root of A cos c + B sin c = 0 in [0, pi) */
        let c = Math.atan2(-A, B);
        c = ((c % Math.PI) + Math.PI) % Math.PI;
        pts.push([cx + cpx * c * Math.sin(th), cy - cpx * c * Math.cos(th)]);
    }
    return {pts, day: A > 0};
}

function drawGrayline(ctx, proj, w, h, now, C) {
    const lonC = proj.lon0 || 0;
    /* the disc works in true longitudes, the flat maps in home-centred ones */
    const t = propTerminator(now, proj.kind === 'azimuthal' ? 0 : lonC);
    ctx.globalAlpha = 1;
    if (proj.kind === 'azimuthal') {
        const b = propDiscBoundary(proj, w, h, t);
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.beginPath();
        /* Night is the disc minus the day star when the centre is lit; fill
         * the whole clip rect and punch the star out with even-odd. */
        if (b.day) ctx.rect(0, 0, w, h);
        ctx.moveTo(w / 2, h / 2);
        for (const p of b.pts) ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        ctx.fill(b.day ? 'evenodd' : 'nonzero');

        ctx.strokeStyle = '#aaa';
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(b.pts[0][0], b.pts[0][1]);
        for (let i = 1; i < b.pts.length; i++) ctx.lineTo(b.pts[i][0], b.pts[i][1]);
        ctx.closePath();
        ctx.stroke();
        ctx.globalAlpha = 1;
        return;
    }
    const west = proj.fwdRaw(-180, 0)[0];
    const east = proj.fwdRaw(180, 0)[0];
    if (t.equinox) {
        /* Near the equinox the terminator degenerates to a meridian: the day
         * half is the arc between lonSun +/- 90 that contains the subsolar
         * meridian; shade the other half (both pieces when it wraps around
         * the edges of the home-centred map). */
        const xA = proj.fwdRaw(propLonRel(t.lonSun + 90, lonC), 0)[0];
        const xB = proj.fwdRaw(propLonRel(t.lonSun - 90, lonC), 0)[0];
        const xSun = proj.fwdRaw(propLonRel(t.lonSun, lonC), 0)[0];
        const lo = Math.min(xA, xB), hi = Math.max(xA, xB);
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        if (xSun >= lo && xSun <= hi) {
            ctx.fillRect(west, 0, lo - west, h);
            ctx.fillRect(hi, 0, east - hi, h);
        } else {
            ctx.fillRect(lo, 0, hi - lo, h);
        }
        return;
    }
    const base = t.base;
    const night = [];
    for (let i = 0; i < base.length; i++) night.push(base[i]);
    /* Close the night polygon down the two edge meridians, sampling every
     * 2 degrees. On Robinson those meridians are curves, and the old single
     * chord from the last terminator point straight to the pole cut the
     * shading off the map's upper/lower corners. */
    const edgeTo = (fromLat, toLat, d) => {
        const steps = Math.max(1, Math.ceil(Math.abs(toLat - fromLat) / 2));
        for (let i = 1; i <= steps; i++) {
            night.push([fromLat + (toLat - fromLat) * i / steps, d]);
        }
    };
    const latEnd = base[base.length - 1][0], latStart = base[0][0];
    edgeTo(latEnd, t.nightPole, 180);
    night.push([t.nightPole, -180]);
    edgeTo(t.nightPole, latStart, -180);

    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath();
    let started = false;
    for (const p of night) {
        const q = proj.fwdRaw(p[1], p[0]);   // p[1] is a home-centred offset
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q[0], q[1]); started = true; }
        else ctx.lineTo(q[0], q[1]);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#aaa';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    started = false;
    for (const p of base) {
        const q = proj.fwdRaw(p[1], p[0]);
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q[0], q[1]); started = true; }
        else ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
}

/* Great-circle DE -> DX path cut at the antimeridian, in canonical
 * longitudes. greatCirclePoints() (app.js) unwraps the longitudes, so a path
 * crossing the date line keeps advancing past +/-180 and is projected off
 * the canvas -- the line runs into the empty area beside the map instead of
 * re-entering from the opposite edge. Split it where it crosses 180 and
 * shift each piece back into [-180, 180]: the stroke then stops on one edge
 * and restarts on the other, with both endpoints on the main world. */
function propPathSegments(lat1, lon1, lat2, lon2, samples, lonC) {
    const pts = greatCirclePoints(lat1, lon1, lat2, lon2, samples);
    /* cut at the seam of the home-centred map, not at Greenwich */
    const center = lonC || 0;
    const worldOf = lon => Math.floor((lon - center + 180) / 360);
    const segs = [];
    let copy = worldOf(pts[0][1]);
    let seg = [[pts[0][0], pts[0][1] - 360 * copy]];
    for (let i = 1; i < pts.length; i++) {
        const c = worldOf(pts[i][1]);
        if (c === copy) {
            seg.push([pts[i][0], pts[i][1] - 360 * copy]);
            continue;
        }
        const [la, lo] = pts[i - 1];
        const [lb, ln] = pts[i];
        const boundary = c > copy ? center + 180 + 360 * copy
            : center - 180 + 360 * copy;
        const crossLat = la + (lb - la) * ((boundary - lo) / (ln - lo));
        seg.push([crossLat, boundary - 360 * copy]);   // close at the edge
        segs.push(seg);
        seg = [[crossLat, boundary - 360 * c]];        // re-enter the other edge
        seg.push([pts[i][0], pts[i][1] - 360 * c]);
        copy = c;
    }
    segs.push(seg);
    return segs;
}

function drawPath(ctx, proj, C) {
    const de = propState.de, dx = propState.dx;
    if (de && dx) {
        const segs = propPathSegments(de.lat, de.lon, dx.lat, dx.lon, 64,
            proj.lon0 || 0);
        ctx.strokeStyle = C.yellow;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        for (const seg of segs) {
            let started = false;
            for (const p of seg) {
                const q = proj.fwd(p[1], p[0]);
                if (!q) { started = false; continue; }
                if (!started) { ctx.moveTo(q[0], q[1]); started = true; }
                else ctx.lineTo(q[0], q[1]);
            }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    const dot = (lat, lon, color, label) => {
        const q = proj.fwd(lon, lat);
        if (!q) return;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(q[0], q[1], 6.5, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '600 11px "Segoe UI", sans-serif';
        ctx.fillText(label, q[0] + 9, q[1] + 4);
    };
    if (de) dot(de.lat, de.lon, C.accent, 'DE');
    if (dx) dot(dx.lat, dx.lon, C.orange || '#e67e22', 'DX');
}

/* ---------------------------------------------------------------
 * Panel rendering
 * ------------------------------------------------------------- */
function sparkValues(key) {
    const d = propState.data || {};
    const col = (list, idx) => (list || []).map(r => r[idx]).filter(v => v !== null && isFinite(v));
    switch (key) {
    case 'sfi': return col(d.sfi && d.sfi.list, 1);
    case 'ssn': return col(d.ssn && d.ssn.list, 1);
    case 'kp': return col(d.kp && d.kp.list, 1);
    case 'bz': return col(d.mag && d.mag.list, 2);
    case 'bt': return col(d.mag && d.mag.list, 1);
    case 'wind': return col(d.wind && d.wind.list, 1);
    case 'dens': return col(d.wind && d.wind.list, 2);
    case 'xray': return col(d.xray && d.xray.list, 1);
    case 'dst': return col(d.dst && d.dst.list, 1);
    }
    return [];
}

function drawSpark(cv, vals, color, logScale) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 120, h = cv.clientHeight || 26;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!vals.length) return;
    let v = vals.slice();
    if (logScale) v = v.map(x => Math.log10(Math.max(x, 1e-9)));
    let min = Math.min(...v), max = Math.max(...v);
    if (max === min) { max = min + 1; }
    const pad = 2;
    const X = i => v.length === 1 ? w / 2 : (i / (v.length - 1)) * (w - pad * 2) + pad;
    const Y = y => h - pad - ((y - min) / (max - min)) * (h - pad * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    v.forEach((y, i) => i ? ctx.lineTo(X(i), Y(y)) : ctx.moveTo(X(i), Y(y)));
    ctx.stroke();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = color;
    ctx.beginPath();
    v.forEach((y, i) => i ? ctx.lineTo(X(i), Y(y)) : ctx.moveTo(X(i), Y(y)));
    ctx.lineTo(X(v.length - 1), h - pad);
    ctx.lineTo(X(0), h - pad);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(X(v.length - 1), Y(v[v.length - 1]), 2.4, 0, Math.PI * 2);
    ctx.fill();
}

/* i18n holds the localised card name; label is the fallback abbreviation. */
const PROP_CARDS = [
    {key: 'sfi', label: 'SFI', i18n: 'pcSfi', unit: ''},
    {key: 'ssn', label: 'SSN', i18n: 'pcSsn', unit: ''},
    {key: 'kp', label: 'Kp', i18n: 'pcKp', unit: ''},
    {key: 'a', label: 'A', i18n: 'pcA', unit: ''},
    {key: 'bz', label: 'Bz', i18n: 'pcBz', unit: 'nT'},
    {key: 'bt', label: 'Bt', i18n: 'pcBt', unit: 'nT'},
    {key: 'wind', label: 'Wind', i18n: 'pcWind', unit: 'km/s'},
    {key: 'dens', label: 'Dens', i18n: 'pcDens', unit: 'p/cm³'},
    {key: 'xray', label: 'X-ray', i18n: 'pcXray', unit: ''},
    {key: 'dst', label: 'Dst', i18n: 'pcDst', unit: 'nT'},
    {key: 'aur', label: 'Aurora', i18n: 'pcAur', unit: '%'},
    {key: 'drap', label: 'DRAP', i18n: 'pcDrap', unit: 'MHz'}
];

function cardValue(key) {
    const d = propState.data || {};
    const ham = d.ham || {};
    const last = (list, idx) => {
        const rows = list || [];
        for (let i = rows.length - 1; i >= 0; i--) {
            const v = rows[i][idx];
            if (v !== null && v !== undefined) return v;
        }
        return null;
    };
    switch (key) {
    case 'sfi': return ham.sfi !== null ? ham.sfi : last(d.sfi && d.sfi.list, 1);
    case 'ssn': return ham.ssn !== null ? ham.ssn : last(d.ssn && d.ssn.list, 1);
    case 'kp': return ham.kp !== null ? ham.kp : last(d.kp && d.kp.list, 1);
    case 'a': return ham.aindex;
    case 'bz': return last(d.mag && d.mag.list, 2);
    case 'bt': return last(d.mag && d.mag.list, 1);
    case 'wind': return last(d.wind && d.wind.list, 1);
    case 'dens': return last(d.wind && d.wind.list, 2);
    case 'xray': return ham.xray || '';
    case 'dst': return last(d.dst && d.dst.list, 1);
    case 'aur': return ham.aurora;
    case 'drap': return propState.de ? propDrapAt(propState.de.lat, propState.de.lon) : null;
    }
    return null;
}

function cardClass(key, v) {
    if (typeof v !== 'number') return '';
    if (key === 'kp') return v >= 5 ? 'alert' : v >= 4 ? 'warn' : '';
    if (key === 'bz') return v <= -10 ? 'alert' : v <= -5 ? 'warn' : '';
    if (key === 'dst') return v <= -100 ? 'alert' : v <= -50 ? 'warn' : '';
    if (key === 'xray') return '';
    return '';
}

function bandCondClass(cond) {
    const c = (cond || '').toLowerCase();
    if (c.includes('good')) return 'good';
    if (c.includes('fair')) return 'fair';
    if (c.includes('poor')) return 'poor';
    return 'closed';
}

/* Condition identifiers stay English internally (they drive the CSS class);
 * only the visible text is localised. */
function condText(cond) {
    const key = {Good: 'condGood', Fair: 'condFair', Poor: 'condPoor', Closed: 'condClosed'}[cond];
    return key ? t(key) : (cond || '—');
}

/* ---------------------------------------------------------------
 * Per-band HF conditions.
 *
 * Same model as the DE->DX matrix, evaluated at the home station itself:
 * one 3000 km hop with the station as its midpoint, at the home station's
 * own local solar noon and local solar midnight (solved from the sun's
 * longitude, so the equation of time and the season are included). The
 * window comes from the sonde snapshot (each sounding normalised by its
 * own observation time) plus the DRAP absorption grid, so the cards follow
 * the actual ionosphere instead of a global SFI lookup table.
 * HamQSL's four combined groups are only a fallback when no home station
 * is set.
 * ------------------------------------------------------------- */

/* UTC hour (0..23.75) at which the sun is over `lon` -- local solar noon. */
function propNoonHour(lon) {
    const now = new Date();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let best = 0, bestD = 999;
    for (let h = 0; h < 24; h += 0.25) {
        const d = Math.abs(propLonRel(lon - propTerminator(new Date(base + h * 3600e3)).lonSun, 0));
        if (d < bestD) { bestD = d; best = h; }
    }
    return best;
}

/* A single 3000 km hop whose midpoint is the home station: the reference
 * path used for "which bands are workable from here". */
function propHomeProfile(de) {
    return {dist: PROP_HOP_KM, hops: 1, hopLen: PROP_HOP_KM,
        mids: [{lat: de.lat, lon: de.lon}]};
}

function bandCondOf(f, win) {
    if (f > 0.97 * win.muf) return 'Closed';     // above the MUF
    if (f < win.luf) return 'Poor';              // below the LUF: absorbed
    const head = (win.muf - f) / Math.max(1, win.muf - win.luf);
    return head > 0.55 ? 'Good' : head > 0.25 ? 'Fair' : 'Poor';
}

function propBandConds() {
    const de = propState.de, data = propState.data;
    if (!de || !data) return null;
    const now = new Date();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const noon = propNoonHour(de.lon);
    const prof = propHomeProfile(de);
    const day = propPathWindow(prof, new Date(base + noon * 3600e3));
    const night = propPathWindow(prof, new Date(base + ((noon + 12) % 24) * 3600e3));
    const bands = {};
    for (const b of PROP_BANDS) {
        bands[b.name] = {day: bandCondOf(b.f, day), night: bandCondOf(b.f, night)};
    }
    return {bands, day, night, noon};
}

function renderPropPanel() {
    const side = $('#propSide'), foot = $('#propFoot'), armL = $('#propArmL');
    if (!side || !foot || !armL) return;
    const d = propState.data;
    if (!d) {
        side.innerHTML = '<div class="prop-empty">' + t('propNoData') +
            (propState.err ? '<br><span class="prop-dim">' + propState.err + '</span>' : '') +
            '</div>';
        foot.innerHTML = '';
        armL.innerHTML = '';
        return;
    }
    const ham = d.ham || {};
    /* The U places band conditions and the SDO image in the left arm,
     * space-weather cards in the right arm and the tables/readouts in the
     * strip that closes the bottom. */
    const html = [];   // right arm
    const left = [];   // left arm
    const low = [];    // bottom strip

    /* ---- NOAA R / S / G (placed above the cards so the card grid can
     * flex-fill all the way down to the map's bottom edge) ---- */
    const sc = d.scales || {};
    const scaleBox = (k, o) => {
        const lvl = o && o.scale !== null ? o.scale : 0;
        return '<div class="prop-scale s' + lvl + '"><b>' + k + '</b><span>' +
            (o ? (o.text || '') : '—') + '</span><i>G' + lvl + '</i></div>';
    };
    html.push('<div class="prop-sec sec-wx"><div class="prop-sec-title">' + t('propSpaceWx') +
        '<span class="prop-upd">' + t('propUpdated') + ' ' +
        propShortTime(d.ts) + '</span></div>');
    html.push('<div class="prop-scales">' + scaleBox('R', sc.r) + scaleBox('S', sc.s) +
        scaleBox('G', sc.g) + '</div>');

    /* ---- space weather cards (flex-fill the remaining height) ---- */
    html.push('<div class="prop-cards">');
    for (const c of PROP_CARDS) {
        const v = cardValue(c.key);
        const cls = cardClass(c.key, v);
        html.push('<div class="prop-card ' + cls + '" data-card="' + c.key + '">' +
            '<div class="pc-head"><span class="pc-label">' +
            (c.i18n ? t(c.i18n) : c.label) +
            '</span><span class="pc-val">' + (typeof v === 'number' ? propNum(v, c.key === 'xray' ? 0 : 1) : (v || '—')) +
            '</span></div>' +
            '<div class="pc-unit">' + (c.unit || '') + '</div>' +
            '<canvas class="pc-spark"></canvas></div>');
    }
    html.push('</div></div>');

    /* ---- HF band conditions (card grid, same language as the
     * space-weather cards and the global readouts).
     * Per-band values come from the same hop/DRAP model as the path matrix,
     * sampled at the home station's local solar noon and midnight; HamQSL's
     * four combined groups are only used when no home station is set. ---- */
    const bc = propBandConds();
    if (bc) {
        left.push('<div class="prop-sec sec-bands"><div class="prop-sec-title">' + t('propBands') +
            '<span class="prop-upd">' + t('propApprox') + '</span></div><div class="prop-bandgrid">');
        for (const b of PROP_BANDS) {
            const e = bc.bands[b.name];
            left.push('<div class="band-card"><div class="bc-name">' + b.name + '</div>' +
                '<div class="bc-row"><span class="bc-time">' + t('propDay') +
                '</span><b class="bc-cond ' + bandCondClass(e.day) + '">' + condText(e.day) + '</b></div>' +
                '<div class="bc-row"><span class="bc-time">' + t('propNight') +
                '</span><b class="bc-cond ' + bandCondClass(e.night) + '">' + condText(e.night) + '</b></div></div>');
        }
        left.push('</div>');
        const nowD = new Date();
        const noonIso = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(),
            nowD.getUTCDate()) + bc.noon * 3600e3).toISOString().slice(11, 16);
        left.push('<div class="prop-note">MUF3000 ' + propNum(bc.day.muf, 1) + ' / ' +
            propNum(bc.night.muf, 1) + ' MHz · LUF ' + propNum(bc.day.luf, 1) + ' / ' +
            propNum(bc.night.luf, 1) + ' MHz · local noon ' + noonIso + 'Z</div>');
        if (ham.geomag) {
            left.push('<div class="prop-note">Geomag: ' + ham.geomag +
                ' · Noise: ' + (ham.noise || '—') + '</div>');
        }
        left.push('</div>');
    } else {
        const bands = ham.bands || [];
        if (bands.length) {
            const day = bands.filter(b => b.time === 'day');
            const night = bands.filter(b => b.time === 'night');
            left.push('<div class="prop-sec sec-bands"><div class="prop-sec-title">' + t('propBands') +
                '</div><div class="prop-bandgrid">');
            for (const b of day) {
                const nb = night.find(x => x.name === b.name);
                const condRow = (label, o) => o
                    ? '<div class="bc-row"><span class="bc-time">' + label +
                      '</span><b class="bc-cond ' + bandCondClass(o.cond) + '">' + condText(o.cond) + '</b></div>'
                    : '';
                left.push('<div class="band-card"><div class="bc-name">' + b.name + '</div>' +
                    condRow(t('propDay'), b) + condRow(t('propNight'), nb) + '</div>');
            }
            left.push('</div>');
            if (ham.geomag) {
                left.push('<div class="prop-note">Geomag: ' + ham.geomag +
                    ' · Noise: ' + (ham.noise || '—') + '</div>');
            }
            left.push('</div>');
        }
    }

    /* ---- DE -> DX path matrix ---- */
    const mat = propPathMatrix();
    if (mat) {
        low.push('<div class="prop-sec sec-path"><div class="prop-sec-title">' + t('propPath') +
            '<span class="prop-upd">' + t('propApprox') + '</span></div>');
        low.push('<div class="prop-path-head"><b>DE</b> ' + propState.de.lat.toFixed(1) + '°, ' +
            propState.de.lon.toFixed(1) + '° <span class="prop-arrow">→</span> <b>DX</b> ' +
            propState.dx.lat.toFixed(1) + '°, ' + propState.dx.lon.toFixed(1) + '°</div>');
        low.push('<div class="prop-path-meta">' + Math.round(mat.dist) + ' km · ' +
            Math.round(mat.bearing) + '° · MUF ' + propNum(mat.baseMuf, 1) + ' MHz</div>');
        low.push('<div class="prop-matrix"><table><thead><tr><th></th>' +
            Array.from({length: 24}, (_, h) =>
                '<th class="' + (h === mat.hourNow ? 'now' : '') + '">' + h + '</th>').join('') +
            '</tr></thead><tbody>');
        for (const r of mat.rows) {
            const best = Math.max(...r.cells);
            low.push('<tr><th>' + r.name + '</th>' + r.cells.map((p, h) => {
                /* 0 % is red, 100 % is green: the hue sweeps 0 -> 120 deg with
                 * the raw score, no clamping or quantising of the value. */
                const hue = Math.round(p * 1.2);
                const light = (32 + p * 0.14).toFixed(1);
                const cls = (h === mat.hourNow ? 'now' : '') + (p === best ? ' best' : '');
                return '<td class="' + cls + '" style="background:hsl(' + hue +
                    ',66%,' + light + '%)" title="' + p + '%">' +
                    (p >= 55 ? '•' : '') + '</td>';
            }).join('') + '</tr>');
        }
        low.push('</tbody></table></div>');
        const nowRow = mat.rows.reduce((a, b) => {
            const pa = a.cells[mat.hourNow], pb = b.cells[mat.hourNow];
            return pb > pa ? b : a;
        });
        low.push('<div class="prop-note">' + t('propBestBand') + ': <b>' + nowRow.name +
            '</b> (' + nowRow.cells[mat.hourNow] + '%)</div>');
        low.push('</div>');
    } else if (!propState.de) {
        low.push('<div class="prop-sec"><div class="prop-note">' + t('propSetGrid') +
            '</div></div>');
    }

    /* ---- SDO latest solar image (NASA GSFC "latest" mirror, ~1/min), in
     * the bottom strip between the path matrix and the readouts ---- */
    const sdoCap = new Date().toISOString().slice(11, 16) + 'Z';
    low.push('<div class="prop-sec sec-sdo"><div class="prop-sec-title">' + t('propSdo') +
        '</div><div class="prop-sdo">' +
        '<img src="https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0193.jpg?t=' + Date.now() +
        '" alt="SDO AIA 193" onerror="this.parentElement.classList.add(\'sdo-fail\')">' +
        '<div class="prop-sdo-cap">AIA 193 Å · ' + sdoCap + '</div>' +
        '</div></div>');

    /* ---- best band to every other continent right now (same model as the
     * DE->DX matrix, plain averages, no rounding of the underlying scores).
     * Drawn as R/S/G-style tiles, filled on the same red->green score ramp. ---- */
    const cty = propContinentTable();
    if (cty) {
        low.push('<div class="prop-sec sec-cty"><div class="prop-sec-title">' +
            t('propCtyTitle') + '</div><div class="prop-cty">' +
            cty.rows.map(r => {
                const hue = Math.round(r.score * 1.2);
                /* progress-bar fill: the score colours a left-to-right strip
                 * over the dark panel base instead of filling the whole tile */
                return '<div class="prop-scale" style="--sev:hsl(' + hue +
                    ',70%,52%);background:linear-gradient(90deg,hsla(' + hue +
                    ',70%,48%,.5) 0,hsla(' + hue + ',70%,48%,.5) ' + r.score +
                    '%,transparent ' + r.score + '%),var(--panel-2)"><span>' +
                    t('propCty' + r.key.charAt(0).toUpperCase() + r.key.slice(1)) +
                    '</span><b>' + r.band + '</b><i>' + r.score + '%</i></div>';
            }).join('') + '</div></div>');
    }

    /* ---- global readouts (card tiles, same visual language as space-weather cards) ---- */
    const st = (d.muf && d.muf.stations) || [];
    let maxSt = null;
    for (const s of st) if (s[2] !== null && (!maxSt || s[2] > maxSt[2])) maxSt = s;
    const au = d.aurora && d.aurora.grid;
    let auMax = 0;
    if (au) for (const p of au) if (p[2] > auMax) auMax = p[2];
    const wx = propWxAt(propState.dx.lat, propState.dx.lon);
    low.push('<div class="prop-sec sec-read"><div class="prop-sec-title">' + t('propReadouts') +
        '</div><div class="prop-read">');
    const read = (k, v) => '<div class="pr-card"><div class="pr-label">' + k +
        '</div><div class="pr-val">' + v + '</div></div>';
    low.push(read(t('rdMufDe'), propNum(propState.de ? propMufAt(propState.de.lat, propState.de.lon) : null, 1) + ' MHz'));
    low.push(read(t('rdMufMax'), maxSt ? propNum(maxSt[2], 1) + ' MHz · ' + maxSt[4] : '—'));
    low.push(read(t('rdMufDx'), propNum(propMufAt(propState.dx.lat, propState.dx.lon), 1) + ' MHz'));
    low.push(read(t('rdAurora'), auMax ? auMax + '%' : '—'));
    low.push(read(t('rdDrapDe'), propNum(cardValue('drap'), 1) + ' MHz'));
    low.push(read(t('rdDrapDx'), propNum(propDrapAt(propState.dx.lat, propState.dx.lon), 1) + ' MHz'));
    low.push(read(t('rdToa'), propState.de
        ? Math.round(propDeg(Math.atan(300 / Math.max(1, propDistance(propState.de, propState.dx) / 2)))) + '°'
        : '—'));
    low.push(read(t('propWeatherDx'), wx ? (propNum(wx[2], 1) + '°C · WMO ' + (wx[3] === null ? '—' : wx[3])) : '—'));
    low.push('</div></div>');

    armL.innerHTML = left.join('');
    side.innerHTML = html.join('');
    foot.innerHTML = low.join('');
    sizePropSdo();

    redrawPropSparks();
}

/* The SDO frame must be strictly 1:1 and end flush with the path matrix, so
 * its size is taken from the matrix content height instead of CSS. */
function sizePropSdo() {
    const foot = $('#propFoot');
    const sec = foot && foot.querySelector('.sec-sdo');
    const box = sec && sec.querySelector('.prop-sdo');
    if (!sec || !box) return;
    const ref = foot.querySelector('.sec-path') || sec;
    /* Use the last child so a stretched grid cell does not inflate the size. */
    const last = ref.lastElementChild || ref;
    const side = Math.floor(last.getBoundingClientRect().bottom -
        box.getBoundingClientRect().top);
    if (side > 40) {
        box.style.width = side + 'px';
        box.style.height = side + 'px';
    }
}

/* Redraw every space-weather sparkline against its current canvas size.
 * Called after renderPropPanel and on every resize so the lines rescale
 * when the card grid stretches to match the map height. */
function redrawPropSparks() {
    const side = $('#propSide');
    if (!side) return;
    side.querySelectorAll('[data-card]').forEach(el => {
        const key = el.dataset.card;
        const vals = sparkValues(key);
        if (!vals.length) return;
        const cv = el.querySelector('.pc-spark');
        const color = key === 'bz' ? '#e74c3c' : key === 'kp' ? '#f1c40f' : '#00e5ff';
        drawSpark(cv, vals, color, key === 'xray');
    });
}

/* ---------------------------------------------------------------
 * Map interaction
 * ------------------------------------------------------------- */
function propEventToLatLon(ev) {
    const r = propState.canvas.getBoundingClientRect();
    const proj = makeProjection(propState.proj, propState.w, propState.h, propState.de);
    return proj.inv(ev.clientX - r.left, ev.clientY - r.top);
}

function bindPropMap() {
    const cv = propState.canvas;
    const hover = $('#propHover');
    cv.addEventListener('mousemove', ev => {
        const ll = propEventToLatLon(ev);
        propState.hover = ll;
        if (!hover) return;
        if (!ll) { hover.classList.add('hidden'); return; }
        hover.classList.remove('hidden');
        /* Bearing from the DE (own) station to the pointer: the useful readout
         * when picking a DX point. Falls back to a dash when no grid is set. */
        const de = propState.de;
        hover.textContent = de
            ? 'Az ' + (Math.round(propBearing(de, {lat: ll[0], lon: ll[1]})) % 360) + '°'
            : '—';
        const r = propState.wrap.getBoundingClientRect();
        hover.style.left = (ev.clientX - r.left + 14) + 'px';
        hover.style.top = (ev.clientY - r.top + 14) + 'px';
    });
    cv.addEventListener('mouseleave', () => {
        if (hover) hover.classList.add('hidden');
    });
    cv.addEventListener('click', ev => {
        const ll = propEventToLatLon(ev);
        if (!ll) return;
        propState.dx = {lat: Math.round(ll[0] * 10) / 10, lon: Math.round(ll[1] * 10) / 10};
        settings.propDxLat = propState.dx.lat;
        settings.propDxLon = propState.dx.lon;
        saveSettings();
        drawProp();
        renderPropPanel();
    });
}

function propResize() {
    const cv = propState.canvas, wrap = propState.wrap;
    if (!cv || !wrap) return;
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    propState.w = r.width;
    propState.h = r.height;
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    propState.ctx = cv.getContext('2d');
    propState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawProp();
    redrawPropSparks();
    sizePropSdo();
}

/* ---------------------------------------------------------------
 * Data + lifecycle
 * ------------------------------------------------------------- */
async function propFetch() {
    if (propState.loading) return;
    propState.loading = true;
    try {
        const r = await fetch('/api/prop', {cache: 'no-store'});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        if (!d || d.error) throw new Error((d && d.error) || 'no data');
        propState.data = d;
        propState.err = null;
        if (propState.view) {
            renderPropPanel();
            drawProp();
        }
    } catch (e) {
        propState.err = e.message;
        if (propState.view) renderPropPanel();
    } finally {
        propState.loading = false;
    }
}

/* Recompute the DE position from the shared Maidenhead grid setting. */
function propSyncDe() {
    const ll = gridToLatLon(settings.grid);
    propState.de = ll ? {lat: ll[0], lon: ll[1]} : null;
}

function initProp() {
    propState.wrap = $('#propMapWrap');
    propState.canvas = $('#propCanvas');
    if (!propState.canvas) return;

    const projSel = $('#propProj');
    projSel.innerHTML = PROP_PROJECTIONS.map(p =>
        '<option value="' + p + '">' + t('prop' + p.charAt(0).toUpperCase() + p.slice(1)) +
        '</option>').join('');
    projSel.value = PROP_PROJECTIONS.includes(settings.propProj) ? settings.propProj : 'mercator';
    propState.proj = projSel.value;
    projSel.addEventListener('change', () => {
        propState.proj = projSel.value;
        settings.propProj = propState.proj;
        saveSettings();
        drawProp();
    });

    const layerSel = $('#propLayer');
    layerSel.innerHTML = PROP_LAYERS.map(p =>
        '<option value="' + p + '">' + t('propLayer' + p.charAt(0).toUpperCase() + p.slice(1)) +
        '</option>').join('');
    layerSel.value = PROP_LAYERS.includes(settings.propLayer) ? settings.propLayer : 'muf';
    propState.layer = layerSel.value;
    layerSel.addEventListener('change', () => {
        propState.layer = layerSel.value;
        settings.propLayer = propState.layer;
        saveSettings();
        drawProp();
    });

    propState.dx = {
        lat: isFinite(settings.propDxLat) ? settings.propDxLat : 40,
        lon: isFinite(settings.propDxLon) ? settings.propDxLon : -100
    };
    propSyncDe();

    bindPropMap();
    propResize();

    if (window.ResizeObserver) {
        propState.ro = new ResizeObserver(() => { if (propState.view) propResize(); });
        propState.ro.observe(propState.wrap);
    }

    /* gray line / solar position: redraw once a minute */
    propState.timer = setInterval(() => { if (propState.view) drawProp(); }, 60000);
    propState.poll = setInterval(propFetch, 60000);
    propFetch();
}

function showPropView() {
    propState.view = true;
    propSyncDe();
    if (propState.dx) {
        propState.dx = {
            lat: isFinite(settings.propDxLat) ? settings.propDxLat : propState.dx.lat,
            lon: isFinite(settings.propDxLon) ? settings.propDxLon : propState.dx.lon
        };
    }
    propResize();
    renderPropPanel();
    propFetch();
}

function hidePropView() {
    propState.view = false;
}

/* Re-apply translated labels after a language switch. */
function applyPropLang() {
    const projSel = $('#propProj'), layerSel = $('#propLayer');
    if (projSel) {
        const keep = projSel.value;
        projSel.innerHTML = PROP_PROJECTIONS.map(p =>
            '<option value="' + p + '">' + t('prop' + p.charAt(0).toUpperCase() + p.slice(1)) +
            '</option>').join('');
        projSel.value = keep;
    }
    if (layerSel) {
        const keep = layerSel.value;
        layerSel.innerHTML = PROP_LAYERS.map(p =>
            '<option value="' + p + '">' + t('propLayer' + p.charAt(0).toUpperCase() + p.slice(1)) +
            '</option>').join('');
        layerSel.value = keep;
    }
    const hint = $('#propHint');
    if (hint) hint.textContent = t('propClickDx');
    const title = $('#propTitle');
    if (title) title.textContent = t('propView');
    renderPropPanel();
}
