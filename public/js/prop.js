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

/* Every provider feeding this page, with the licence its data ships under.
 * GIRO's Rules of the Road and the CC BY-NC-SA terms of the LGDC products
 * both require the attribution to be visible, so the list is drawn under the
 * page unconditionally -- not only once a payload arrives. `lic` is a key into
 * the licence table in renderPropCredits(); provider names stay untranslated
 * because they are proper nouns. */
const PROP_SOURCES = [
    {name: 'NOAA SWPC', url: 'https://www.swpc.noaa.gov/', lic: 'pd'},
    {name: 'HamQSL', url: 'https://www.hamqsl.com/solar.html', lic: 'courtesy'},
    {name: 'prop.kc2g.com', url: 'https://prop.kc2g.com/', lic: 'MIT'},
    {name: 'GIRO / DIDBase', url: 'https://lgdc.uml.edu/', lic: 'ccbyncsa'},
    {name: 'LGDC GAMBIT', url: 'https://lgdc.uml.edu/rix/', lic: 'ccbyncsa'},
    {name: 'Open-Meteo', url: 'https://open-meteo.com/', lic: 'ccby'},
    {name: 'NASA SDO', url: 'https://sdo.gsfc.nasa.gov/', lic: 'pd'}
];

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
    lastDraw: 0, calc: null, sig: null, lastHour: -1,
    geo: null, geoAt: 0
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

/* Free text from an external feed (ICAO advisories) is injected as HTML, so
 * it must be escaped first. */
function propEsc(s) {
    return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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
                /* Past the poles or outside the elliptical edge there is no
                 * coordinate -- same phantom-position guard as Mercator. */
                if (Math.abs(y) > yMax + 0.02) return null;
                const absLat = robLatFromY(y);
                const lat = y < 0 ? -absLat : absLat;
                if (lat > fit.north + 0.3 || lat < fit.south - 0.3) return null;
                const xs = 0.8487 * robinsonTable(absLat, ROB_X);
                if (!xs) return null;
                if (Math.abs(x / xs) > Math.PI + 0.02) return null;
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
            /* Outside the world silhouette there is no coordinate: the margins
             * (or the cropped latitudes) must not yield phantom clamped
             * positions for clicks and the hover readout. */
            if (Math.abs(propDeg(x)) > 180.5) return null;
            const lat = latFromY(y);
            if (lat > fit.north + 0.3 || lat < fit.south - 0.3) return null;
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
    /* Pure function of (minute, lonC) that allocates a 181-point curve, and the
     * MUF field asks for it thousands of times per redraw -- cache the latest. */
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
        if (!isFinite(lat)) lat = prev;   // singular only at the exact equinox
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
let propTermMemo = null;

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
/* Parsing the ISO string and evaluating the sun angle per station per query
 * dominated the MUF lattice build; the factor only depends on the station's
 * own observation instant, so keep it. */
const propHourFactorCache = new Map();

function propStationHourFactor(s) {
    if (typeof s[5] !== 'string' || !s[5]) return 1;
    /* kc2g timestamps carry no zone suffix; they are UTC, so pin them --
     * otherwise Date() reads them in the viewer's local zone. */
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
    let num = 0, den = 0, numF = 0, dMin = Infinity;
    for (const s of st) {
        if (typeof s[2] !== 'number') continue;
        const d = propDistance({lat, lon}, {lat: s[0], lon: s[1]});
        if (d < dMin) dMin = d;
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
    /* dMin lets the map cross-fade into climatology near the trust radius;
     * the other callers ignore it. */
    return {muf: base * kAt, fof2: baseF * kAt, dMin};
}

function propMufAt(lat, lon, when) {
    const p = propIonoAt(lat, lon, when || new Date());
    return p ? p.muf : null;
}

/* MUF readout value: fresh-sonde interpolation first; where no sounding
 * survives the age/distance gate (e.g. East Asia -- the Chinese sondes went
 * silent in 2021 and the Japanese ones in 2023), fall back to the same
 * climatological estimate the path matrix and the map cross-fade use, so
 * the readout never disagrees with what is painted underneath. */
function propMufShown(lat, lon) {
    const m = propMufAt(lat, lon);
    return m !== null ? m : propClimatMuf(lat, lon, new Date());
}

function propDrapAt(lat, lon) {
    const d = propState.data && propState.data.drap;
    if (!d || !d.lats || !d.lats.length) return null;
    /* SWPC's chronic "NO INPUT DATA AVAILABLE" grid is all zeros -- treat it
     * as absent so the card/readouts show -- instead of a fake 0.0 MHz. */
    if (d.noData) return null;
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
 * elevation. Day factor: ~0.55 through the night, 1.17 with the sun overhead.
 * The exponent keeps the curve rising past sf~0.7 instead of flattening there
 * -- a saturating linear ramp made the midday sun at 40N and at the equator
 * score the same factor, which erased the latitude contrast. */
function propMufDayFactor(sf) {
    return 0.55 + 0.62 * Math.pow(clamp((sf + 0.12) / 1.12, 0, 1), 0.65);
}

/* ---------- IRTAM (GAMBIT) assimilative field ---------- */

/* Bilinear sample of one GAMBIT universal-time slice. The grid is 10 x 20
 * degrees over the whole globe, so it resolves the equatorial anomaly but not
 * individual fronts -- which is exactly the resolution this MUF picture is
 * drawn at. */
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

/* foF2 at a point and a time. The collector publishes eight universal-time
 * slices of the same assimilated state, so the diurnal phase is interpolated
 * in UT and the 24-hour band matrix keeps its shape instead of repeating one
 * snapshot. */
function propGambitFof2At(lat, lon, when) {
    const g = propState.data && propState.data.gambit;
    if (!g || !g.lats || !g.lats.length || !g.values || !g.uts) return null;
    const t = when || new Date();
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

/* Regional bias: what the sounding network says about the model, expressed as
 * a ratio (measured foF2 / GAMBIT foF2). Each station is re-phased to "now"
 * with the same day factor propIonoAt uses, then blended by inverse-square
 * distance inside the same 2500 km trust radius; the result is clamped so one
 * outlier cannot repaint half a continent. 1.0 means "the model is right". */
function propRegionBias(lat, lon, when) {
    const st = propState.data && propState.data.muf && propState.data.muf.stations;
    if (!st || !st.length || !propState.data.gambit) return 1;
    const nowMs = Date.now();
    const kAt = propMufDayFactor(sunFactor(lat, lon, when));
    let num = 0, den = 0;
    for (const s of st) {
        if (typeof s[3] !== 'number' || s[3] <= 0) continue;    // no foF2 row
        const d = propDistance({lat, lon}, {lat: s[0], lon: s[1]});
        if (d > 2500) continue;
        const ageW = propSondeAgeWeight(s, nowMs);
        if (!ageW) continue;
        const model = propGambitFof2At(s[0], s[1], when);
        if (model === null || model < 1) continue;
        const kM = propStationHourFactor(s) || 1;
        const wgt = ageW / Math.pow(d + 40, 2);
        num += ((s[3] / kM) * kAt / model) * wgt;
        den += wgt;
    }
    if (!den) return 1;
    return clamp(num / den, 0.75, 1.35);
}

/* MUF from the assimilative foF2: the model supplies the density (anomaly
 * crests, storm depletions, real diurnal phase), the hop still needs an
 * M(3000)F2 factor, which runs ~2.45 at night and ~3.0 with the sun up. */
function propIrtamMuf(lat, lon, when) {
    const fof2 = propGambitFof2At(lat, lon, when);
    if (fof2 === null) return null;
    const sf = clamp(sunFactor(lat, lon, when), 0, 1);
    return fof2 * propRegionBias(lat, lon, when) * (2.45 + 0.55 * sf);
}

/* Climatological MUF(3000) for a hop where no fresh sonde covers the point.
 * When the collector has a GAMBIT/IRTAM foF2 field the assimilated model
 * takes over (propIrtamMuf); the SFI curve below is then only the fallback.
 * The SFI term alone is one global scalar, so latitude and season have to
 * enter separately:
 *  - dec is the subsolar latitude on the forecast date, so |lat - dec| is the
 *    noon zenith distance at that latitude: 0 at the subsolar point, ~90 in
 *    polar night. noonSf = cos(lat - dec) is the noon solar elevation.
 *  - the peak is the SFI scale shaped by that noon elevation (0.30 base for a
 *    sun that never rises, up to 1.0 at the subsolar point), i.e. the seasonal
 *    and latitudinal ceiling for that day.
 *  - the day factor then moves that peak from local noon to the forecast
 *    hour, so a night-time sample is scaled down by the usual day/night ratio
 *    rather than by an elevation that already had no latitude in it.
 * Order of magnitude with SFI=90 (21.3 MHz base): equator ~21/11, 23N ~19/10,
 * 60N ~12/8, 75N in late October ~7/5 MHz (day/night). */
function propClimatMuf(lat, lon, when) {
    const irtam = propIrtamMuf(lat, lon, when);
    if (irtam !== null) return irtam;
    const sfi = propState.data && propState.data.ham && propState.data.ham.sfi;
    const base = sfi ? 1.5 + 0.22 * sfi : 8;
    const dec = propTerminator(when).dec;
    const noonSf = Math.max(0, Math.cos(propRad(Math.abs(lat - dec))));
    const peak = base * (0.30 + 0.70 * Math.pow(noonSf, 0.7));
    const kAt = propMufDayFactor(sunFactor(lat, lon, when));
    const kNoon = propMufDayFactor(noonSf);
    return peak * clamp(kAt / (kNoon || 1), 0.35, 1.15) * propGeoMufFactor();
}

/* Relative D-region absorption: ~0.1 at night, 1.0 with the sun overhead. */
function propAbsWeight(sf) {
    return clamp((sf + 0.15) / 1.15, 0.1, 1);
}

/* Latest GOES X-ray flux in W/m^2 (0.1-0.8 nm long channel). Drives the
 * climatological D-region absorption below; hamqsl's "A5.4"-style letter
 * class is the fallback when the GOES feed is stale. */
function propXrayNow() {
    const d = propState.data;
    const list = d && d.xray && d.xray.list;
    if (list && list.length) {
        const last = list[list.length - 1];
        const f = Array.isArray(last) ? last[1] : null;
        if (f > 0) return f;
    }
    const hx = d && d.ham && d.ham.xray;
    if (hx) {
        const m = /^([ABCMX])([\d.]+)/i.exec(String(hx).trim());
        if (m) {
            const scale = {A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4}[m[1].toUpperCase()];
            const v = scale * parseFloat(m[2]);
            if (v > 0) return v;   // hamqsl sometimes reports "A0.0"
        }
    }
    return 3e-7;   // quiet-Sun mid-B background
}

/* Climatological one-hop LUF (MHz) from solar zenith + X-ray flux. This is
 * the fallback for the DRAP grid, which is event-driven: outside solar
 * proton events SWPC regularly ships an all-zero "no estimates" grid, and
 * trusting those zeros made 80M/160M look open at local noon.
 * Calibration: quiet Sun (xray ~3e-7) gives ~5.2 MHz at the subsolar point,
 * so 80M is absorbed by day and open by night while 40M stays usable --
 * matching the classic daytime LUF for a 3000 km F2 hop. M-class flares
 * scale it up by ~1.8x, X-class by ~3.2x. At night (sun below the
 * terminator) the D layer vanishes and only a small residual is kept. */
function propLufClim(lat, lon, when) {
    const sf = sunFactor(lat, lon, when);
    if (sf <= -0.05) return 0;
    const x = propXrayNow();
    const xScale = clamp(Math.pow(x / 3e-7, 0.25), 0.5, 4);
    return 5.2 * xScale * Math.pow(clamp(sf, 0, 1), 0.75) * propGeoAbsFactor();
}

/* ---------------------------------------------------------------
 * Polar cap absorption (PCA) from GOES >=10 MeV protons.
 * During an S-level radiation storm, energetic protons funnel down the open
 * field lines into the polar cap D layer and absorb HF over the whole cap --
 * this is exactly what the DRAP grid tries to show, but SWPC ships an
 * all-zero "no estimates" grid most of the time, so without this term the
 * model keeps trans-polar 80M/40M paths open during real proton events.
 * Cutoff: >=10 MeV protons precipitate poleward of roughly 60 deg magnetic
 * latitude; absorption scales with the S level and, like all D-layer
 * absorption, is strongest on the sunlit side.
 * ------------------------------------------------------------- */
const PROP_MAG_POLE = {lat: 80.6, lon: -72.7};   // IGRF dipole north pole ~2025

/* Magnetic (dipole) latitude -- enough for a PCA cutoff, not for field work. */
function propMagLat(lat, lon) {
    const p = propRad(PROP_MAG_POLE.lat);
    const s = Math.sin(propRad(lat)) * Math.sin(p) +
        Math.cos(propRad(lat)) * Math.cos(p) * Math.cos(propRad(lon - PROP_MAG_POLE.lon));
    return propDeg(Math.asin(clamp(s, -1, 1)));
}

/* LUF floor (MHz) contributed by polar cap absorption at a hop midpoint:
 * 0 outside the cap or at S0, up to ~10 MHz at S5 deep in the cap by day. */
function propPcaLuf(lat, lon, when) {
    const s = propScaleS();
    if (!s) return 0;
    const m = Math.abs(propMagLat(lat, lon));
    const cutoff = 60;
    if (m <= cutoff) return 0;
    const depth = clamp((m - cutoff) / 12, 0.25, 1);
    const day = propAbsWeight(sunFactor(lat, lon, when));
    const base = [0, 2.5, 4, 6, 8, 10][clamp(s, 0, 5)];
    return base * depth * day;
}

/* ---------------------------------------------------------------
 * Local geomagnetic activity (USGS / INTERMAGNET observatories).
 * The nearest reporting observatory's H trace gives a local K estimate from
 * the 3-hour amplitude using the standard K ranges (18/30/50/70/100/140/
 * 200/300/500 nT -> K1..K9). Storms depress foF2 and thicken the D layer:
 * the MUF factor removes up to ~20% from climatology, the absorption factor
 * adds up to ~25% to the LUF. Measured ionosonde data is left untouched --
 * it already contains the storm.
 * ------------------------------------------------------------- */
const PROP_GEO_STATIONS = [
    ['SHU', 31.1, 121.2], ['BDT', 40.0, 116.3], ['GUA', 13.6, 144.9],
    ['HON', 21.3, -157.0], ['BOU', 40.1, -105.2], ['NEW', 48.3, -117.1],
    ['TUC', 32.2, -110.7], ['BSL', 30.4, -89.6], ['SIT', 57.1, -135.3],
    ['CMO', 64.9, -147.9], ['SJG', 18.1, -66.2], ['BRW', 71.3, -156.6],
    ['FRN', 37.1, -118.7], ['DED', 70.0, -145.0]
];

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

/* foF2 depression: none below K4, then -1.2%/K^1.6 (K5 -4%, K7 -15%, K9 -20%). */
/* Local K from the nearest USGS observatory, falling back to the global Kp
 * when no observatory answer is available (offline, CORS failure, station
 * outage). Kp is planetary 3-hour and smoother than a local K, but far
 * better than treating a failed fetch as quiet conditions. */
function propGeoK() {
    if (propState.geo && propState.geo.k !== null && propState.geo.k !== undefined) {
        return propState.geo.k;
    }
    const list = propState.data && propState.data.kp && propState.data.kp.list;
    if (list) {
        for (let i = list.length - 1; i >= 0; i--) {
            const v = list[i][1];
            if (typeof v === 'number' && isFinite(v)) return v;
        }
    }
    return null;
}

function propGeoMufFactor() {
    const k = propGeoK();
    if (k === null || k < 4) return 1;
    return clamp(1 - 0.012 * Math.pow(k - 3, 1.6), 0.75, 1);
}

/* Extra D-layer / auroral absorption, much weaker than the MUF loss. */
function propGeoAbsFactor() {
    const k = propGeoK();
    if (k === null || k < 4) return 1;
    return clamp(1 + 0.008 * Math.pow(k - 3, 1.5), 1, 1.25);
}

/* Nearest observatory that actually reports today; USGS data is CC0 and
 * serves Access-Control-Allow-Origin: *, so this runs straight from the
 * browser. Failures leave the whole correction neutral. */
async function propFetchGeo() {
    const de = propState.de;
    if (!de) return;
    const now = Date.now();
    if (propState.geoAt && now - propState.geoAt < 10 * 60000) return;
    const near = PROP_GEO_STATIONS
        .map(s => ({s, d: propGeomagDistance(s, de)}))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
    for (const c of near) {
        const code = c.s[0];
        const end = new Date(now);
        const start = new Date(now - 4 * 3600 * 1000);
        const url = 'https://geomag.usgs.gov/ws/data/?id=' + code +
            '&elements=H&format=json&sampling_period=60' +
            '&starttime=' + start.toISOString() + '&endtime=' + end.toISOString();
        try {
            const r = await fetch(url, {cache: 'no-store'});
            if (!r.ok) continue;
            const o = await r.json();
            const vals = o && o.values && o.values[0] && o.values[0].values;
            if (!Array.isArray(vals)) continue;
            const h = vals.filter(v => typeof v === 'number' && isFinite(v));
            if (h.length < 30) continue;
            const win = h.slice(-180);           // last ~3 hours
            const amp = Math.max(...win) - Math.min(...win);
            const k = propKFromAmp(amp);
            propState.geo = {code, k, amp: Math.round(amp), distance: Math.round(c.d)};
            propState.geoAt = now;
            propRecalc();
            return;
        } catch (e) {
            /* try the next observatory */
        }
    }
    propState.geoAt = now;      // do not hammer the service when all fail
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
            /* no sonde within 2500 km: climatological MUF with the day's
             * latitude/season correction (propClimatMuf), not the bare SFI
             * scalar that ignored both. */
            const eq = propClimatMuf(m.lat, m.lon, when);
            base = 0.62 * eq + 0.38 * eq * span;
        }
        if (base < mufMin) mufMin = base;

        const drap = propDrapAt(m.lat, m.lon);
        /* Climatological D-region LUF always applies; the DRAP grid (when it
         * carries real estimates) can only make things worse, never better. */
        const lufClim = propLufClim(m.lat, m.lon, when) * Math.sqrt(prof.hops);
        let lufHop = lufClim;
        if (drap !== null && !(data.drap && data.drap.noData)) {
            const wAt = propAbsWeight(sunFactor(m.lat, m.lon, when));
            const wNow = propAbsWeight(sunFactor(m.lat, m.lon, drapAt));
            const scale = clamp(wAt / wNow, 0.3, 4);
            lufHop = Math.max(lufHop, Math.max(2.0,
                1.55 * drap * Math.sqrt(prof.hops) * scale));
        }
        /* Polar cap absorption floor from the GOES proton flux (S level):
         * independent of DRAP, which is all-zero in most proton storms. */
        const pca = propPcaLuf(m.lat, m.lon, when);
        if (pca > lufHop) lufHop = pca;
        if (lufHop > lufMax) lufMax = lufHop;
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

    /* graticule every 30 degrees. Meridians are sampled point by point on
     * every projection: on Robinson they are curves that bulge toward the
     * centre meridian, and the old straight (lon,-85)->(lon,85) chord cut
     * across the map near the equator -- the graticule no longer lies about
     * the projection. */
    ctx.strokeStyle = C.border;
    for (let lon = -180; lon < 180; lon += 30) {
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.beginPath();
        let started = false;
        for (let lat = -90; lat <= 90; lat += 3) {
            const p = proj.fwd(lon, lat);
            if (!p) { started = false; continue; }
            if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
            else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        /* the equator carries a little more weight than the other parallels */
        ctx.globalAlpha = lat === 0 ? 0.8 : 0.55;
        ctx.lineWidth = lat === 0 ? 1.3 : 1;
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
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;

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

    drawPropLegend(ctx, w, h);

    propState.lastDraw = Date.now();
}

/* Layer legend chip in the lower-left corner: a gradient strip with the two
 * scale ends. Units only (MHz / deg C / %), so it stays language-neutral. */
function drawPropLegend(ctx, w, h) {
    const d = propState.data;
    if (!d) return;
    let stops = null, lo = '', hi = '';
    if (propState.layer === 'muf') {
        stops = [3, 9, 15, 21, 27, 30].map(v => mufColor(v));
        lo = '3'; hi = '30 MHz';
    } else if (propState.layer === 'weather') {
        if (!d.wx || !d.wx.pts || !d.wx.pts.length) return;
        stops = [-30, -16, -2, 12, 26, 40].map(v => wxColor(v));
        lo = '-30°'; hi = '+40°C';
    } else if (propState.layer === 'aurora') {
        if (!d.aurora || !d.aurora.grid) return;
        stops = [[46, 204, 113], [241, 196, 15], [255, 77, 109]];
        lo = '0'; hi = '100%';
    }
    if (!stops) return;
    const bw = 120, bh = 7, x0 = 12, y0 = h - 22;
    ctx.save();
    ctx.fillStyle = 'rgba(5,11,17,.72)';
    ctx.strokeStyle = 'rgba(127,176,196,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0 - 7, y0 - 12, bw + 14, bh + 22, 4);
    else ctx.rect(x0 - 7, y0 - 12, bw + 14, bh + 22);
    ctx.fill();
    ctx.stroke();
    const g = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
    for (let i = 0; i < stops.length; i++) {
        g.addColorStop(i / (stops.length - 1), 'rgb(' + stops[i].join(',') + ')');
    }
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, bw, bh);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = '#c8d6de';
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(lo, x0, y0 - 2);
    ctx.textAlign = 'right';
    ctx.fillText(hi, x0 + bw, y0 - 2);
    ctx.restore();
}

/* MUF heat grid: inverse-distance weighted ionosonde MUF3000 per cell */
const MUF_STOPS = [
    [20, 60, 180], [40, 150, 220], [60, 190, 140],
    [220, 200, 60], [240, 120, 40], [220, 40, 60]
];

function mufColor(muf) {
    const t = clamp((muf - 3) / 27, 0, 1);          // 3..30 MHz
    const i = clamp(Math.floor(t * (MUF_STOPS.length - 1)), 0, MUF_STOPS.length - 2);
    const f = t * (MUF_STOPS.length - 1) - i;
    const a = MUF_STOPS[i], b = MUF_STOPS[i + 1];
    return [Math.round(a[0] + (b[0] - a[0]) * f),
        Math.round(a[1] + (b[1] - a[1]) * f),
        Math.round(a[2] + (b[2] - a[2]) * f)];
}

/* MUF field lattice for the current snapshot. Sondes only cover a 2500 km
 * disc around each station, so most of the ocean used to stay unpainted; every
 * node now gets a value -- the sonde interpolation where it applies and the
 * latitude/season climatology elsewhere -- and the two sources are cross-faded
 * across the outer 700 km of the trust radius so their boundary is a gradient,
 * not a ring. 6 x 10 degree nodes are fine because the caller bilinearly
 * interpolates between them per pixel. */
const PROP_MUF_LAT_STEP = 6;
const PROP_MUF_LON_STEP = 10;

function propMufField() {
    const now = new Date();
    const nLat = 180 / PROP_MUF_LAT_STEP + 1;       // -90 .. 90
    const nLon = 360 / PROP_MUF_LON_STEP;           // -180 .. 170
    const vals = new Float32Array(nLat * nLon);
    for (let i = 0; i < nLat; i++) {
        const lat = -90 + i * PROP_MUF_LAT_STEP;
        for (let j = 0; j < nLon; j++) {
            const lon = -180 + j * PROP_MUF_LON_STEP;
            const clim = propClimatMuf(lat, lon, now);
            const iono = propIonoAt(lat, lon, now);
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

/* Bilinear sample of the lattice at a true lat/lon (longitude wraps). */
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

/* Shared field painter: rasterise a low-frequency field at a coarse step and
 * upscale with the canvas' own bilinear filter. Per-pixel inverse projection
 * (which is what keeps the wash rectangular-free on curved projections) stays
 * cheap, and the result is a continuous gradient instead of a checkerboard.
 * colorAt(lat, lon) returns [r, g, b, a] or null for transparent. */
function propPaintField(ctx, proj, cvKey, colorAt) {
    const w = propState.w, h = propState.h;
    if (!w || !h) return;
    const step = Math.max(2, Math.ceil(Math.sqrt(w * h / 80000)));
    const W = Math.max(2, Math.round(w / step));
    const H = Math.max(2, Math.round(h / step));
    const cv = propState[cvKey] || (propState[cvKey] = document.createElement('canvas'));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const off = cv.getContext('2d');
    const img = off.createImageData(W, H);
    const px = img.data;
    for (let y = 0; y < H; y++) {
        const py = y * step + step / 2;
        for (let x = 0; x < W; x++) {
            const p = proj.inv(x * step + step / 2, py);
            if (!p) continue;
            const col = colorAt(p[0], p[1]);
            if (!col) continue;
            const o = (y * W + x) * 4;
            px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2];
            px[o + 3] = col[3];
        }
    }
    off.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cv, 0, 0, w, h);
    ctx.restore();
}

function drawMufLayer(ctx, proj, C) {
    if (!propState.data) return;
    const field = propMufField();
    propPaintField(ctx, proj, 'mufCv', (lat, lon) => {
        const col = mufColor(mufFieldAt(field, lat, lon));
        return [col[0], col[1], col[2], 77];   // uniform ~0.30 wash
    });
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
    /* Soft temperature tint under every reading first: overlapping stations
     * blend into each other instead of stacking the old opaque squares that
     * hid the map. Values stay the stations' own, nothing is interpolated. */
    for (const p of wx.pts) {
        const q = proj.fwd(p[1], p[0]);
        if (!q) continue;
        const col = wxColor(p[2]);
        const r = size * 1.4;
        const g = ctx.createRadialGradient(q[0], q[1], 0, q[0], q[1], r);
        g.addColorStop(0, 'rgba(' + col.join(',') + ',.30)');
        g.addColorStop(1, 'rgba(' + col.join(',') + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
        ctx.fill();
    }
    /* then the readings themselves, as compact chips with a temperature-tinted
     * border -- readable over land, wash and night shading alike */
    for (const p of wx.pts) {
        const q = proj.fwd(p[1], p[0]);
        if (!q) continue;
        const col = wxColor(p[2]);
        const label = Math.round(p[2]) + '°';
        const bw = ctx.measureText(label).width + 10, bh = 16;
        ctx.fillStyle = 'rgba(5,11,17,.78)';
        ctx.strokeStyle = 'rgba(' + col.join(',') + ',.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(q[0] - bw / 2, q[1] - bh / 2, bw, bh, 4);
        else ctx.rect(q[0] - bw / 2, q[1] - bh / 2, bw, bh);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgb(' + col.join(',') + ')';
        ctx.fillText(label, q[0], q[1] + 0.5);
    }
    ctx.textAlign = 'start';
}

/* OVATION points arrive on a regular 4x4 degree lattice with the <8% nodes
 * filtered out. Re-expanding them into the full lattice with implicit zeros
 * lets the field be bilinearly interpolated into a continuous auroral oval
 * instead of polka dots; missing nodes genuinely mean "below 8%" (server-side
 * filter), so zero-padding invents nothing. */
const PROP_AU_STEP = 4;

function propAuroraField(grid) {
    const nLat = 180 / PROP_AU_STEP + 1;        // -90 .. 90
    const nLon = 360 / PROP_AU_STEP;            // -180 .. 176
    const vals = new Float32Array(nLat * nLon);
    for (const p of grid) {
        const i = Math.round((p[1] + 90) / PROP_AU_STEP);
        let j = Math.round((p[0] + 180) / PROP_AU_STEP) % nLon;
        if (j < 0) j += nLon;
        if (i < 0 || i >= nLat) continue;
        vals[i * nLon + j] = p[2];
    }
    return {vals, nLat, nLon};
}

/* Bilinear sample of the aurora lattice at a true lat/lon (longitude wraps). */
function auroraFieldAt(f, lat, lon) {
    const y = clamp((lat + 90) / PROP_AU_STEP, 0, f.nLat - 1 - 1e-6);
    const i = Math.floor(y), ty = y - i;
    let x = (((lon + 180) / PROP_AU_STEP) % f.nLon + f.nLon) % f.nLon;
    const j = Math.floor(x), tx = x - j;
    const j2 = (j + 1) % f.nLon;
    const r0 = i * f.nLon, r1 = Math.min(i + 1, f.nLat - 1) * f.nLon;
    const v00 = f.vals[r0 + j], v01 = f.vals[r0 + j2];
    const v10 = f.vals[r1 + j], v11 = f.vals[r1 + j2];
    return (v00 * (1 - tx) + v01 * tx) * (1 - ty) +
        (v10 * (1 - tx) + v11 * tx) * ty;
}

/* Continuous intensity ramp: the aurora stays green at low probability and
 * turns yellow, then red, only where the oval is genuinely strong. */
const AU_STOPS = [
    [8, [24, 120, 70]], [25, [46, 204, 113]], [50, [241, 196, 15]],
    [75, [230, 110, 50]], [100, [255, 77, 109]]
];

function auroraColor(p) {
    const x = clamp(p, AU_STOPS[0][0], AU_STOPS[AU_STOPS.length - 1][0]);
    let i = 0;
    while (i < AU_STOPS.length - 2 && AU_STOPS[i + 1][0] < x) i++;
    const a = AU_STOPS[i], b = AU_STOPS[i + 1];
    const f = (x - a[0]) / (b[0] - a[0]);
    return [Math.round(a[1][0] + (b[1][0] - a[1][0]) * f),
        Math.round(a[1][1] + (b[1][1] - a[1][1]) * f),
        Math.round(a[1][2] + (b[1][2] - a[1][2]) * f)];
}

function drawAuroraLayer(ctx, proj, C) {
    const au = propState.data && propState.data.aurora;
    if (!au || !au.grid || !au.grid.length) return;
    const field = propAuroraField(au.grid);
    propPaintField(ctx, proj, 'auCv', (lat, lon) => {
        const p = auroraFieldAt(field, lat, lon);
        if (p < 6) return null;                // fade out below the noise
        const col = auroraColor(p);
        const a = Math.round(clamp((p - 6) / 60, 0, 1) * 150);
        return [col[0], col[1], col[2], a];
    });
}

/* Terminator on the azimuthal disc as a radial boundary around the screen
 * centre. For every bearing there is exactly one crossing of the target sun
 * elevation (0 for the terminator, -6 for the twilight edge), so the loop is
 * continuous everywhere -- sweeping the terminator latitude by longitude (the
 * old approach) put consecutive samples on opposite sides of the antipode and
 * drew chords across the map. sinH is the sine of the target elevation; the
 * filled side is decided by A (sun elevation at the centre) vs sinH. Returns
 * null when the centre itself sits inside the twilight band -- the -6 contour
 * then wraps around the centre instead of forming a clean star, and the
 * caller falls back to the single night fill. */
function propDiscBoundary(proj, w, h, t, sinH) {
    const lat0 = propRad(proj.lat0 || 0), lon0 = propRad(proj.lon0 || 0);
    const dec = propRad(t.dec), sun = propRad(t.lonSun);
    const A = Math.sin(dec) * Math.sin(lat0) +
        Math.cos(dec) * Math.cos(lat0) * Math.cos(sun - lon0);
    if (sinH && Math.abs(A) < Math.abs(sinH)) return null;
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
        /* elevation along this bearing: sin(el(c)) = A cos c + B sin c.
         * h = 0 reduces to the plain terminator root; h = -6 picks the root
         * on the night side, clamped to the rim when the contour leaves the
         * disc before closing. */
        let c;
        if (!sinH) {
            c = Math.atan2(-A, B);
            c = ((c % Math.PI) + Math.PI) % Math.PI;
        } else {
            c = Math.atan2(B, A) + (A >= 0 ? 1 : -1) *
                Math.acos(clamp(sinH / Math.hypot(A, B), -1, 1));
            /* the raw root can land negative (the crossing then lies in the
             * opposite bearing); fold into [0, 2*pi) first, then clamp to the
             * rim -- plain clamping dropped those roots onto the centre. */
            c = ((c % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            c = clamp(c, 0, Math.PI);
        }
        pts.push([cx + cpx * c * Math.sin(th), cy - cpx * c * Math.cos(th)]);
    }
    return {pts, day: A > sinH};
}

/* Fill the region below a disc boundary (day side punched out when the
 * centre is above the threshold). */
function propDiscShade(ctx, w, h, b, alpha) {
    ctx.fillStyle = 'rgba(0,0,0,' + alpha + ')';
    ctx.beginPath();
    if (b.day) ctx.rect(0, 0, w, h);
    ctx.moveTo(w / 2, h / 2);
    for (const p of b.pts) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fill(b.day ? 'evenodd' : 'nonzero');
}

function propDiscStroke(ctx, b, alpha, width) {
    ctx.strokeStyle = '#aaa';
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(b.pts[0][0], b.pts[0][1]);
    for (let i = 1; i < b.pts.length; i++) ctx.lineTo(b.pts[i][0], b.pts[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
}

/* Terminator latitude for a target sun elevation hDeg at hour angle H,
 * declination dec. sin(el) = sin(dec) sin(lat) + cos(dec) cos(lat) cos(H)
 * solved for lat; reduces to the classic atan(-cos(H)/tan(dec)) at h = 0.
 * Null where the sun never reaches that elevation on this meridian. */
function propTermLat(hDeg, H, dec) {
    const sH = Math.sin(propRad(hDeg));
    const A = Math.sin(dec), B = Math.cos(dec) * Math.cos(H);
    const R = Math.hypot(A, B);
    if (R < Math.abs(sH)) return null;
    const phi = Math.atan2(B, A);
    const a = Math.asin(clamp(sH / R, -1, 1));
    /* asin has a second branch (pi - a): the twilight contour must stay
     * continuous with the plain terminator, so pick whichever branch lands
     * closer to it -- the principal branch alone jumps to the far side of
     * the pole on the midnight meridian. The reference is the classic
     * atan(-cos(H)/tan(dec)) curve, a genuine latitude in [-90, 90]; folding
     * -phi instead would alias it to 180 degrees when dec is negative. */
    const lat0 = Math.atan(-Math.cos(H) / (Math.tan(dec) || 1e-12));
    const l1 = a - phi, l2 = (Math.PI - a) - phi;
    const fold = x => Math.atan2(Math.sin(x), Math.cos(x));
    const l1f = fold(l1), l2f = fold(l2);
    const d1 = Math.abs(fold(l1f - lat0)), d2 = Math.abs(fold(l2f - lat0));
    return propDeg(d1 <= d2 ? l1f : l2f);
}

function drawGrayline(ctx, proj, w, h, now, C) {
    const lonC = proj.lon0 || 0;
    /* the disc works in true longitudes, the flat maps in home-centred ones */
    const t = propTerminator(now, proj.kind === 'azimuthal' ? 0 : lonC);
    const sinTwi = Math.sin(propRad(-6));
    ctx.globalAlpha = 1;
    if (proj.kind === 'azimuthal') {
        const b0 = propDiscBoundary(proj, w, h, t, 0);
        /* Civil-twilight edge: a second, deeper fill inside the night, so the
         * band between the two curves reads as dusk/dawn. Absent while the
         * home station itself is inside the twilight (contour wraps it). */
        const b6 = propDiscBoundary(proj, w, h, t, sinTwi);
        propDiscShade(ctx, w, h, b0, b6 ? 0.18 : 0.42);
        if (b6) {
            propDiscShade(ctx, w, h, b6, 0.26);
            propDiscStroke(ctx, b6, 0.3, 1);
        }
        propDiscStroke(ctx, b0, 0.85, 1.5);
        return;
    }
    if (t.equinox) {
        /* Near the equinox the terminator degenerates to the two meridians
         * lonSun +/- 90. Trace the day strip point by point along both of
         * them and punch it out of the shading: on Robinson the meridians
         * are curves, and the old fillRect band cut straight across the
         * elliptical edge of the map. */
        const dE = propLonRel(t.lonSun + 90, lonC);
        const dW = propLonRel(t.lonSun - 90, lonC);
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        for (let lat = -90; lat <= 90; lat += 2) {
            const q = proj.fwdRaw(dE, lat);
            if (lat === -90) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        }
        for (let lat = 90; lat >= -90; lat -= 2) {
            const q = proj.fwdRaw(dW, lat);
            ctx.lineTo(q[0], q[1]);
        }
        ctx.closePath();
        ctx.fill('evenodd');

        ctx.strokeStyle = '#aaa';
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        for (const d of [dE, dW]) {
            ctx.beginPath();
            for (let lat = -90; lat <= 90; lat += 2) {
                const q = proj.fwdRaw(d, lat);
                if (lat === -90) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        return;
    }
    /* A night-region polygon: the boundary curve plus the closure down both
     * edge meridians and through the night pole. Sampling every 2 degrees
     * keeps the curved Robinson edge meridians honest (the old single chord
     * cut the shading off the map's upper/lower corners). */
    const fillNight = (curve, alpha) => {
        const night = curve.slice();
        const edgeTo = (fromLat, toLat, d) => {
            const steps = Math.max(1, Math.ceil(Math.abs(toLat - fromLat) / 2));
            for (let i = 1; i <= steps; i++) {
                night.push([fromLat + (toLat - fromLat) * i / steps, d]);
            }
        };
        const latEnd = curve[curve.length - 1][0], latStart = curve[0][0];
        edgeTo(latEnd, t.nightPole, 180);
        night.push([t.nightPole, -180]);
        edgeTo(t.nightPole, latStart, -180);
        ctx.fillStyle = 'rgba(0,0,0,' + alpha + ')';
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
    };
    const strokeCurve = (curve, alpha, width) => {
        ctx.strokeStyle = '#aaa';
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.beginPath();
        let started = false;
        for (const p of curve) {
            const q = proj.fwdRaw(p[1], p[0]);
            if (!q) { started = false; continue; }
            if (!started) { ctx.moveTo(q[0], q[1]); started = true; }
            else ctx.lineTo(q[0], q[1]);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    };
    const base = t.base;
    /* Civil-twilight curve (sun at -6). It is a clean latitude-per-longitude
     * line only away from the equinox: within +/-6 degrees of declination the
     * -6 contour loops around a pole instead, and the single night fill keeps
     * the map honest there. */
    const dec = propRad(t.dec);
    let twi = null;
    if (Math.abs(Math.sin(dec)) >= Math.abs(sinTwi)) {
        twi = [];
        for (let d = -180; d <= 180; d += 2) {
            const lat6 = propTermLat(-6, propRad(d + lonC - t.lonSun), dec);
            if (lat6 === null) { twi = null; break; }
            twi.push([clamp(lat6, -89.99, 89.99), d]);
        }
    }

    fillNight(base, twi ? 0.18 : 0.42);
    if (twi) {
        fillNight(twi, 0.26);
        strokeCurve(twi, 0.3, 1);
    }
    strokeCurve(base, 0.85, 1.5);
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
        /* soft glow under the line so the path stays readable over the MUF
         * wash and the night shading */
        ctx.save();
        ctx.strokeStyle = C.yellow;
        ctx.lineWidth = 1.8;
        ctx.globalAlpha = 0.92;
        ctx.shadowColor = 'rgba(255,209,102,.6)';
        ctx.shadowBlur = 5;
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
        ctx.restore();
        /* direction arrow at the midpoint of the longest segment, oriented
         * along the projected line (DE -> DX) */
        const seg = segs.reduce((a, b) => (b.length > a.length ? b : a), segs[0]);
        if (seg && seg.length > 2) {
            const i = seg.length >> 1;
            const p1 = proj.fwd(seg[i - 1][1], seg[i - 1][0]);
            const p2 = proj.fwd(seg[i + 1][1], seg[i + 1][0]);
            if (p1 && p2) {
                const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
                const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
                ctx.fillStyle = C.yellow;
                ctx.beginPath();
                ctx.moveTo(mx + 7 * Math.cos(ang), my + 7 * Math.sin(ang));
                ctx.lineTo(mx + 5 * Math.cos(ang + 2.5), my + 5 * Math.sin(ang + 2.5));
                ctx.lineTo(mx + 5 * Math.cos(ang - 2.5), my + 5 * Math.sin(ang - 2.5));
                ctx.closePath();
                ctx.fill();
            }
        }
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
    case 'a': return col(d.a && d.a.list, 1);
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

/* S scale from the latest GOES >=10 MeV integral proton measurement, or null
 * when the feed has no usable row (then scales.json / probability decides). */
function propScaleS() {
    const list = (propState.data && propState.data.proton && propState.data.proton.list) || [];
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

/* R scale from the GOES 0.1-0.8 nm flux (M1 = 1e-5, M5 = 5e-5, X1 = 1e-4,
 * X10 = 1e-3, X20 = 5e-3 W/m2). */
function propScaleR() {
    const list = (propState.data && propState.data.xray && propState.data.xray.list) || [];
    for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i][1];
        if (typeof f !== 'number' || !isFinite(f) || f <= 0) continue;
        if (f >= 5e-3) return 5;
        if (f >= 1e-3) return 4;
        if (f >= 1e-4) return 3;
        if (f >= 5e-5) return 2;
        if (f >= 1e-5) return 1;
        return 0;
    }
    return null;
}

/* G scale from the observed planetary Kp (G1 = Kp5 ... G5 = Kp9). */
function propScaleG() {
    const list = (propState.data && propState.data.kp && propState.data.kp.list) || [];
    for (let i = list.length - 1; i >= 0; i--) {
        const k = list[i][1];
        if (typeof k !== 'number' || !isFinite(k)) continue;
        if (k >= 9) return 5;
        if (k >= 8) return 4;
        if (k >= 7) return 3;
        if (k >= 6) return 2;
        if (k >= 5) return 1;
        return 0;
    }
    return null;
}

/* GOES flux -> A1.0 / B3.2 / C5.4 / M2.1 / X1.0 notation. */
function propXrayClass(f) {
    if (typeof f !== 'number' || !isFinite(f) || f <= 0) return null;
    const dec = Math.floor(Math.log10(f));
    const letter = dec <= -8 ? 'A' : dec === -7 ? 'B' : dec === -6 ? 'C' : dec === -5 ? 'M' : 'X';
    const n = f / Math.pow(10, dec);
    return letter + (n >= 10 ? Math.round(n) : n.toFixed(1));
}

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
    /* SWPC observations first; HamQSL only fills the gaps. */
    case 'sfi': return last(d.sfi && d.sfi.list, 1) !== null ? last(d.sfi && d.sfi.list, 1) :
        ham.sfi !== null ? ham.sfi : null;
    case 'ssn': return last(d.ssn && d.ssn.list, 1) !== null ? last(d.ssn && d.ssn.list, 1) :
        ham.ssn !== null ? ham.ssn : null;
    case 'kp': return last(d.kp && d.kp.list, 1) !== null ? last(d.kp && d.kp.list, 1) :
        ham.kp !== null ? ham.kp : null;
    case 'a': return last(d.a && d.a.list, 1) !== null ? last(d.a && d.a.list, 1) : ham.aindex;
    case 'bz': return last(d.mag && d.mag.list, 2);
    case 'bt': return last(d.mag && d.mag.list, 1);
    case 'wind': return last(d.wind && d.wind.list, 1);
    case 'dens': return last(d.wind && d.wind.list, 2);
    case 'xray': return propXrayClass(last(d.xray && d.xray.list, 1)) || ham.xray || '';
    case 'dst': return last(d.dst && d.dst.list, 1);
    /* Aurora card shows the OVATION peak probability -- the same source as
     * the map layer and the rdAurora readout, and a true percentage. The
     * HamQSL "aurora" field is a 1-10 activity index, which displayed as
     * "n %" was simply wrong. */
    case 'aur': {
        const g = d.aurora && d.aurora.grid;
        if (!g || !g.length) return null;
        let mx = 0;
        for (const p of g) if (p[2] > mx) mx = p[2];
        return mx;
    }
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

/* One chip per provider, licence next to the name, then a single note that
 * says which part of the page each licensed product feeds. Redrawn on every
 * panel render so a language switch updates it together with the rest. */
function renderPropCredits() {
    const box = $('#propCredit');
    if (!box) return;
    const lic = {
        pd: t('propLicPd'),
        courtesy: t('propLicCourtesy'),
        MIT: 'MIT',
        ccbyncsa: 'CC BY-NC-SA 4.0',
        ccby: 'CC BY 4.0'
    };
    box.innerHTML = '<div class="prop-sec-title">' + propEsc(t('propCredits')) + '</div>' +
        '<div class="prop-credit-list">' + PROP_SOURCES.map(s =>
            '<a class="prop-credit-item" href="' + s.url +
            '" target="_blank" rel="noopener">' + '<b>' + propEsc(s.name) + '</b><i>' +
            propEsc(lic[s.lic] || s.lic) + '</i></a>').join('') + '</div>' +
        '<div class="prop-credit-note">' + propEsc(t('propCreditsNote')) + '</div>';
}

function renderPropPanel() {
    const side = $('#propSide'), foot = $('#propFoot'), armL = $('#propArmL');
    if (!side || !foot || !armL) return;
    renderPropCredits();
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
    /* NOAA ships "none/minor/moderate/strong/severe/extreme"; translate the
     * state text and put the scale's own name in the tooltip. */
    const SC_NAME = {R: 'propScR', S: 'propScS', G: 'propScG'};
    const SC_STATE = [
        'propScNone', 'propScMinor', 'propScModerate',
        'propScStrong', 'propScSevere', 'propScExtreme'
    ];
    const scaleBox = (k, o) => {
        /* In-progress event -> its level word (minor/moderate/.../extreme);
         * otherwise the forecast probability if NOAA publishes one; otherwise
         * "none". Never an em dash: an empty box reads as broken data. */
        const lvl0 = o && o.scale !== null ? clamp(o.scale, 0, 5) : 0;
        /* scales.json often lags or leaves S null; the GOES/Kp measurements
         * just added are authoritative, so prefer them when available. */
        const meas = k === 'R' ? propScaleR() : k === 'S' ? propScaleS() :
            k === 'G' ? propScaleG() : null;
        const lvl = meas !== null ? meas : lvl0;
        let note;
        if (lvl > 0) note = t(SC_STATE[lvl]);
        else if (o && o.prob !== null && o.prob !== undefined) note = o.prob + '%';
        else note = t('propScNone');
        return '<div class="prop-scale s' + lvl + '" title="' + t(SC_NAME[k]) + ' · ' + note +
            '"><b>' + t(SC_NAME[k]) + '</b><span>' + note + '</span><i>' + k + lvl + '</i></div>';
    };
    html.push('<div class="prop-sec sec-wx"><div class="prop-sec-title">' + t('propSpaceWx') +
        '<span class="prop-upd">' + t('propUpdated') + ' ' +
        propShortTime(d.ts) + '</span></div>');
    html.push('<div class="prop-scales">' + scaleBox('R', sc.r) + scaleBox('S', sc.s) +
        scaleBox('G', sc.g) + '</div>');

    /* ---- ICAO space weather advisories: event driven, so the block is
     * absent unless one is actually in force ---- */
    const icao = (d.icao && d.icao.list) || [];
    if (icao.length) {
        html.push('<div class="prop-icao">');
        for (const a of icao.slice(0, 3)) {
            const head = ['ICAO', a.phenomenon, a.severity].filter(Boolean).join(' · ');
            html.push('<div class="prop-note"><b>' + propEsc(head) + '</b>' +
                (a.issued ? ' · ' + propEsc(propShortTime(a.issued)) : '') +
                '<br>' + propEsc(a.text) + '</div>');
        }
        html.push('</div>');
    }

    /* ---- space weather cards (flex-fill the remaining height) ---- */
    html.push('<div class="prop-cards">');
    for (const c of PROP_CARDS) {
        const v = cardValue(c.key);
        const cls = cardClass(c.key, v);
        /* aur/drap have no history series (single-look products) -- collapse
         * the blank sparkline canvas instead of framing an empty plot. */
        const noSpark = sparkValues(c.key).length ? '' : ' no-spark';
        html.push('<div class="prop-card ' + cls + noSpark + '" data-card="' + c.key + '">' +
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
    low.push(read(t('rdMufDe'), propNum(propState.de ? propMufShown(propState.de.lat, propState.de.lon) : null, 1) + ' MHz'));
    low.push(read(t('rdMufMax'), maxSt ? propNum(maxSt[2], 1) + ' MHz · ' + maxSt[4] : '—'));
    low.push(read(t('rdMufDx'), propNum(propMufShown(propState.dx.lat, propState.dx.lon), 1) + ' MHz'));
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
        /* Pointer readout: coordinates, and with a home station also the
         * bearing and distance -- the useful numbers when picking a DX point.
         * On the MUF layer the interpolated field at the pointer joins in. */
        const de = propState.de;
        const pt = {lat: ll[0], lon: ll[1]};
        const parts = [Math.abs(ll[0]).toFixed(1) + '°' + (ll[0] >= 0 ? 'N' : 'S') +
            ' ' + Math.abs(ll[1]).toFixed(1) + '°' + (ll[1] >= 0 ? 'E' : 'W')];
        if (de) {
            parts.push('Az ' + (Math.round(propBearing(de, pt)) % 360) + '°');
            parts.push(Math.round(propDistance(de, pt)).toLocaleString('en-US') + ' km');
        }
        if (propState.layer === 'muf' && propState.data) {
            const m = propMufAt(pt.lat, pt.lon);
            if (m !== null) parts.push('MUF ' + m.toFixed(1));
        }
        hover.textContent = parts.join(' · ');
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
/* Signature of the space-weather inputs that drive the propagation model.
 * Every source carries its own fetch timestamp (see lib/prop.js), so a new
 * value in any of them means the space weather changed and the band
 * conditions / path matrix / continent table must be recomputed at once,
 * instead of waiting for the 30-minute background recalculation. */
function propDataSig(d) {
    if (!d) return null;
    const f = d.fetched || {};
    return [d.ts, f.ham, f.muf, f.drap, f.xray, f.kp, f.dst, f.sfi, f.scales,
        f.proton,   /* S-level change drives the PCA floor: recalc at once */
        d.drap && d.drap.noData ? 1 : 0].join('|');
}

/* Recompute every derived view (band conditions, DE->DX matrix, continent
 * best-band) from the cached data and redraw the map. */
function propRecalc() {
    if (!propState.view || !propState.data) return;
    propState.lastHour = new Date().getUTCHours();
    renderPropPanel();
    drawProp();
}

async function propFetch() {
    if (propState.loading) return;
    propState.loading = true;
    try {
        const r = await fetch('/api/prop', {cache: 'no-store'});
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json();
        if (!d || d.error) throw new Error((d && d.error) || 'no data');
        const sig = propDataSig(d);
        propState.data = d;
        propState.err = null;
        /* Local geomagnetic activity runs on its own 10-minute cache and
         * recalculates the paths itself when a new reading lands. */
        propFetchGeo();
        /* Space weather changed -> recompute immediately, without touching
         * the independent 30-minute recalculation timer. */
        if (sig !== propState.sig) {
            propState.sig = sig;
            propRecalc();
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
    const de = ll ? {lat: ll[0], lon: ll[1]} : null;
    /* A different home station means a different nearest observatory. */
    if (de && (!propState.de || propState.de.lat !== de.lat || propState.de.lon !== de.lon)) {
        propState.geo = null;
        propState.geoAt = 0;
    }
    propState.de = de;
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

    /* gray line / solar position: redraw once a minute. The same tick also
     * catches UTC hour rollovers, which shift the "current hour" column of
     * the path matrix even when the space weather itself is quiet. */
    propState.timer = setInterval(() => {
        if (!propState.view) return;
        if (new Date().getUTCHours() !== propState.lastHour) propRecalc();
        else drawProp();
    }, 60000);
    propState.poll = setInterval(propFetch, 60000);
    /* Space weather unchanged: full recalculation every 30 minutes so the
     * forecast windows keep tracking the clock. */
    propState.calc = setInterval(propRecalc, 30 * 60000);
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
