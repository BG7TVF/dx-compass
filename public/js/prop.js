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

const PROP_PROJECTIONS = ['mercator', 'azimuthal', 'robinson'];
const PROP_LAYERS = ['muf', 'weather', 'aurora'];
/* Southern edge kept when filling the width would otherwise crop the map
 * north of this latitude: only the Antarctic cap below it is sacrificed. */
const PROP_CUT_LAT = -70;

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
 * fitted width-first: the map always spans the full canvas width, the
 * northern edge sits on the top border, and any southern overflow is
 * clipped by the canvas. The clip never reaches further north than
 * PROP_CUT_LAT, so only the polar cap (Antarctica) can be lost. The map
 * is static: no wheel zoom and no panning. The azimuthal disc is an
 * exception -- it is centred and fitted with "contain" so the circular
 * view stays whole.
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

function makeProjection(kind, w, h, de) {
    if (kind === 'azimuthal') {
        const lat0 = propRad(de ? de.lat : 40);
        const lon0 = propRad(de ? de.lon : 0);
        const sc = Math.min(w, h) / (2 * Math.PI);
        const cx = w / 2, cy = h / 2;
        return {
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
        const ySouth = 1.3523 * robinsonTable(Math.abs(PROP_CUT_LAT), ROB_Y);
        const sc = Math.min(w / (2 * xMax), h / (yMax + ySouth));
        const cx = w / 2, cy = yMax * sc;
        return {
            fwd(lon, lat) {
                const a = Math.abs(lat), sg = lat < 0 ? -1 : 1;
                return [cx + 0.8487 * robinsonTable(a, ROB_X) * propRad(lon) * sc,
                    cy - 1.3523 * robinsonTable(a, ROB_Y) * sg * sc];
            },
            inv(px, py) {
                const x = (px - cx) / sc, y = (cy - py) / sc;
                const ay = Math.min(Math.abs(y / 1.3523), 1);
                // invert the Y table by binary search on the 5-degree rows
                let lo = 0, hi = 18;
                for (let i = 0; i < 24; i++) {
                    const mid = (lo + hi) / 2;
                    const v = robinsonTable(mid * 5, ROB_Y);
                    if (v < ay) lo = mid; else hi = mid;
                }
                const absLat = clamp(((lo + hi) / 2) * 5, 0, 90);
                const lat = y < 0 ? -absLat : absLat;
                const xs = 0.8487 * robinsonTable(absLat, ROB_X);
                if (!xs) return null;
                const lon = ((propDeg(x / (xs * sc)) + 540) % 360) - 180;
                return [lat, lon];
            }
        };
    }
    // Mercator: full longitudes always fit the width, the southern cap may be cut
    const MY = lat => Math.log(Math.tan(Math.PI / 4 +
        clamp(lat, -85.06, 85.06) * Math.PI / 360));
    const myMax = MY(85.06);
    const mySouth = MY(PROP_CUT_LAT);
    const sc = Math.min(w / (2 * Math.PI), h / (myMax - mySouth));
    const cx = w / 2, cy = myMax * sc;
    return {
        fwd(lon, lat) { return [cx + propRad(lon) * sc, cy - MY(lat) * sc]; },
        inv(px, py) {
            const x = (px - cx) / sc, y = (cy - py) / sc;
            const lat = propDeg(2 * Math.atan(Math.exp(y)) - Math.PI / 2);
            const lon = ((propDeg(x) + 540) % 360) - 180;
            return [clamp(lat, -85, 85), lon];
        }
    };
}

/* ---------------------------------------------------------------
 * Solar geometry (identical math to the Leaflet gray line)
 * ------------------------------------------------------------- */
function propTerminator(now) {
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const doy = (now - start) / 86400000;
    const decDeg = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365.25);
    const dec = propRad(decDeg);
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 +
        now.getUTCSeconds() / 3600;
    const lonSun = 180 - utcH * 15;
    const base = [];
    let prev = 0;
    for (let lon = -180; lon <= 180; lon += 2) {
        const H = propRad(lon - lonSun);
        let lat = Math.atan(-Math.cos(H) / Math.tan(dec)) * 180 / Math.PI;
        if (!isFinite(lat)) lat = prev;   // singular only at the exact equinox
        base.push([lat, lon]);
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
function propMidpoint(a, b) {
    const f1 = propRad(a.lat), l1 = propRad(a.lon);
    const f2 = propRad(b.lat), l2 = propRad(b.lon);
    const bx = Math.cos(f2) * Math.cos(l2 - l1);
    const by = Math.cos(f2) * Math.sin(l2 - l1);
    const f = Math.atan2(Math.sin(f1) + Math.sin(f2),
        Math.sqrt((Math.cos(f1) + bx) ** 2 + by ** 2));
    const l = l1 + Math.atan2(by, Math.cos(f1) + bx);
    return {lat: propDeg(f), lon: ((propDeg(l) + 540) % 360) - 180};
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
function propMufAt(lat, lon) {
    const st = propState.data && propState.data.muf && propState.data.muf.stations;
    if (!st || !st.length) return null;
    let num = 0, den = 0;
    for (const s of st) {
        if (s[2] === null) continue;
        const d = propDistance({lat, lon}, {lat: s[0], lon: s[1]});
        if (d > 4000) continue;
        const wgt = 1 / Math.pow(d + 40, 2);
        num += s[2] * wgt;
        den += wgt;
    }
    return den ? num / den : null;
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

/* Approximate DE->DX availability per hour (no VOACAP):
 * MUF at the path midpoint scaled by the local solar elevation, lower bound
 * from the DRAP absorption grid, then a smooth band-pass per frequency. */
function propPathMatrix() {
    const data = propState.data;
    if (!data) return null;
    const de = propState.de, dx = propState.dx;
    if (!de) return null;
    const mid = propMidpoint(de, dx);
    const dist = propDistance(de, dx);
    const baseMuf = propMufAt(mid.lat, mid.lon) ||
        (data.ham && data.ham.sfi ? 1.5 + 0.22 * data.ham.sfi : 8);
    const baseDrap = propDrapAt(mid.lat, mid.lon);
    const now = new Date();
    const hourNow = now.getUTCHours();
    const rows = PROP_BANDS.map(b => {
        const cells = [];
        for (let h = 0; h < 24; h++) {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
                now.getUTCDate(), h, 0, 0));
            const sf = sunFactor(mid.lat, mid.lon, d);       // -1..1
            const day = clamp((sf + 0.15) / 0.85, 0, 1);     // 0 night .. 1 day
            const muf = baseMuf * (0.58 + 0.55 * day);
            const luf = Math.max(2.0, 1.1 + 1.35 * (baseDrap || 0));
            const hi = 1 / (1 + Math.exp((b.f - 0.95 * muf) / (0.12 * muf || 1)));
            const lo = 1 / (1 + Math.exp((luf - b.f) / 1.1));
            // long paths need more than a single 3000 km hop
            const hop = dist > 3500 ? clamp(1 - (dist - 3500) / 9000, 0.55, 1) : 1;
            cells.push(Math.round(100 * hi * lo * hop));
        }
        return {name: b.name, f: b.f, cells};
    });
    return {rows, mid, dist, baseMuf, hourNow,
        bearing: propBearing(de, dx)};
}

/* ---------------------------------------------------------------
 * Canvas rendering
 * ------------------------------------------------------------- */
function themeColors() {
    const cs = getComputedStyle(document.body);
    const get = n => cs.getPropertyValue(n).trim();
    return {
        bg: get('--map-bg') || '#0a1929',
        land: get('--map-land') || get('--panel-2') || '#1c232c',
        line: get('--map-line') || get('--text-dim') || '#8a97a5',
        border: get('--border') || '#2a333d',
        text: get('--text') || '#d6dde4',
        dim: get('--text-dim') || '#8a97a5',
        accent: get('--accent') || '#00e5ff',
        green: get('--green') || '#2ecc71',
        yellow: get('--yellow') || '#f1c40f',
        red: get('--red') || '#e74c3c'
    };
}

function drawProp() {
    const s = propState;
    if (!s.ctx || !s.w || !s.h) return;
    const ctx = s.ctx, w = s.w, h = s.h, C = themeColors();
    const proj = makeProjection(s.proj, w, h, s.de);
    const now = new Date();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

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
    ctx.fillStyle = C.land;
    for (const ring of land) { trace(ring); ctx.closePath(); ctx.fill(); }

    /* graticule every 30 degrees */
    ctx.strokeStyle = C.border;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    for (let lon = -180; lon < 180; lon += 30) {
        const a = proj.fwd(lon, -85), b = proj.fwd(lon, 85);
        if (!a || !b) continue;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath();
        let started = false;
        for (let lon = -180; lon <= 180; lon += 3) {
            const p = proj.fwd(lon, lat);
            if (!p) { started = false; continue; }
            if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
            else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke();
    }

    ctx.strokeStyle = C.line;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 0.7;
    for (const seg of (window.BORDERS || [])) { trace(seg); ctx.stroke(); }
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    for (const ring of land) { trace(ring); ctx.stroke(); }
    ctx.globalAlpha = 1;

    /* background layer */
    if (s.layer === 'muf') drawMufLayer(ctx, proj, C);
    else if (s.layer === 'weather') drawWeatherLayer(ctx, proj, C);
    else if (s.layer === 'aurora') drawAuroraLayer(ctx, proj, C);

    /* gray line: night shading + terminator, refreshed every minute */
    drawGrayline(ctx, proj, w, h, now, C);

    /* DE -> DX great circle + markers */
    drawPath(ctx, proj, C);

    /* projection-appropriate frame */
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

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
    ctx.globalAlpha = 0.55;
    for (let lat = -85; lat < 85; lat += 5) {
        for (let lon = -180; lon < 180; lon += 10) {
            const muf = has ? propMufAt(lat + 2.5, lon + 5) : null;
            if (muf === null) continue;
            const col = mufColor(muf);
            ctx.fillStyle = 'rgb(' + col.join(',') + ')';
            const a = proj.fwd(lon, lat), b = proj.fwd(lon + 10, lat);
            const c = proj.fwd(lon + 10, lat + 5), d = proj.fwd(lon, lat + 5);
            if (!a || !b || !c || !d) continue;
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
            ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
            ctx.closePath();
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1;
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

function drawGrayline(ctx, proj, w, h, now, C) {
    const t = propTerminator(now);
    ctx.globalAlpha = 1;
    if (t.equinox) {
        /* near the equinox the terminator degenerates to a meridian:
         * shading the whole night half avoids the pole singularity */
        const a = proj.fwd(t.lonSun - 90, -85), b = proj.fwd(t.lonSun - 90, 85);
        const c = proj.fwd(t.lonSun + 90, 85), d = proj.fwd(t.lonSun + 90, -85);
        if (a && b && c && d) {
            ctx.fillStyle = 'rgba(0,0,0,0.28)';
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
            ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
            ctx.closePath();
            ctx.fill();
        }
        return;
    }
    const night = [];
    for (const p of t.base) night.push(p);
    night.push([t.nightPole, 180]);
    night.push([t.nightPole, -180]);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    let started = false;
    for (const p of night) {
        const q = proj.fwd(p[1], p[0]);
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
    for (const p of t.base) {
        const q = proj.fwd(p[1], p[0]);
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q[0], q[1]); started = true; }
        else ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
}

function drawPath(ctx, proj, C) {
    const de = propState.de, dx = propState.dx;
    if (de && dx) {
        const pts = greatCirclePoints(de.lat, de.lon, dx.lat, dx.lon, 64);
        ctx.strokeStyle = C.yellow;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        let started = false, prevLon = null;
        for (const p of pts) {
            if (prevLon !== null && Math.abs(p[1] - prevLon) > 180) started = false;
            prevLon = p[1];
            const q = proj.fwd(p[1], p[0]);
            if (!q) { started = false; continue; }
            if (!started) { ctx.moveTo(q[0], q[1]); started = true; }
            else ctx.lineTo(q[0], q[1]);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    const dot = (lat, lon, color, label) => {
        const q = proj.fwd(lon, lat);
        if (!q) return;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1;
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
 * HamQSL's solarxml.php only ships four combined groups (80m-40m /
 * 30m-20m / 17m-15m / 12m-10m), so individual band values are estimated
 * from the measured SFI and Kp with a simple MUF/LUF model. These are
 * approximations, not measured band openings (labelled as such in the UI).
 * ------------------------------------------------------------- */
function estBandCond(freq, muf, luf, degrade) {
    if (freq > muf) return 'Closed';          // above MUF: penetrates the ionosphere
    if (freq < luf) return 'Poor';            // below LUF: absorbed by the D layer
    const head = (muf - freq) / Math.max(1, muf - luf);
    let c = head > 0.55 ? 'Good' : head > 0.25 ? 'Fair' : 'Poor';
    if (degrade) c = c === 'Good' ? 'Fair' : 'Poor';   // geomagnetic storm penalty
    return c;
}

function estBandConds() {
    const sfi = cardValue('sfi');
    if (sfi === null || !isFinite(sfi)) return null;
    const kp = cardValue('kp');
    const mufDay = 7 + 0.17 * sfi;                 // ~27 MHz at SFI 120
    const mufNight = Math.max(4, 0.52 * mufDay);
    const lufDay = 2.2 + 0.035 * sfi;              // strong D-layer absorption by day
    const lufNight = 0.7 + 0.006 * sfi;            // night absorption is low
    const degrade = kp !== null && kp >= 5;
    const out = {};
    for (const b of PROP_BANDS) {
        out[b.name] = {
            day: estBandCond(b.f, mufDay, lufDay, degrade),
            night: estBandCond(b.f, mufNight, lufNight, degrade)
        };
    }
    return out;
}

function renderPropPanel() {
    const side = $('#propSide'), foot = $('#propFoot');
    if (!side || !foot) return;
    const d = propState.data;
    if (!d) {
        side.innerHTML = '<div class="prop-empty">' + t('propNoData') +
            (propState.err ? '<br><span class="prop-dim">' + propState.err + '</span>' : '') +
            '</div>';
        foot.innerHTML = '';
        return;
    }
    const ham = d.ham || {};
    /* The inverted-L places the space-weather cards in the column right of
     * the map and the tables/readouts in the strip underneath it. */
    const html = [];   // right-hand column
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
     * Per-band values are estimated from SFI/Kp; HamQSL's four combined
     * groups are only used as a fallback when SFI is unavailable. ---- */
    const est = estBandConds();
    if (est) {
        low.push('<div class="prop-sec sec-bands"><div class="prop-sec-title">' + t('propBands') +
            '<span class="prop-upd">' + t('propApprox') + '</span></div><div class="prop-bandgrid">');
        for (const b of PROP_BANDS) {
            const e = est[b.name];
            low.push('<div class="band-card"><div class="bc-name">' + b.name + '</div>' +
                '<div class="bc-row"><span class="bc-time">' + t('propDay') +
                '</span><b class="bc-cond ' + bandCondClass(e.day) + '">' + condText(e.day) + '</b></div>' +
                '<div class="bc-row"><span class="bc-time">' + t('propNight') +
                '</span><b class="bc-cond ' + bandCondClass(e.night) + '">' + condText(e.night) + '</b></div></div>');
        }
        low.push('</div>');
        if (ham.geomag) {
            low.push('<div class="prop-note">Geomag: ' + ham.geomag +
                ' · Noise: ' + (ham.noise || '—') + '</div>');
        }
        low.push('</div>');
    } else {
        const bands = ham.bands || [];
        if (bands.length) {
            const day = bands.filter(b => b.time === 'day');
            const night = bands.filter(b => b.time === 'night');
            low.push('<div class="prop-sec sec-bands"><div class="prop-sec-title">' + t('propBands') +
                '</div><div class="prop-bandgrid">');
            for (const b of day) {
                const nb = night.find(x => x.name === b.name);
                const condRow = (label, o) => o
                    ? '<div class="bc-row"><span class="bc-time">' + label +
                      '</span><b class="bc-cond ' + bandCondClass(o.cond) + '">' + condText(o.cond) + '</b></div>'
                    : '';
                low.push('<div class="band-card"><div class="bc-name">' + b.name + '</div>' +
                    condRow(t('propDay'), b) + condRow(t('propNight'), nb) + '</div>');
            }
            low.push('</div>');
            if (ham.geomag) {
                low.push('<div class="prop-note">Geomag: ' + ham.geomag +
                    ' · Noise: ' + (ham.noise || '—') + '</div>');
            }
            low.push('</div>');
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
                const alpha = p < 10 ? 0 : 0.12 + (p / 100) * 0.62;
                const cls = (h === mat.hourNow ? 'now' : '') + (p === best ? ' best' : '');
                return '<td class="' + cls + '" style="background:rgba(46,204,113,' +
                    alpha.toFixed(3) + ')" title="' + p + '%">' +
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

    /* ---- SDO latest solar image (NASA GSFC "latest" mirror, ~1/min) ---- */
    const sdoCap = new Date().toISOString().slice(11, 16) + 'Z';
    low.push('<div class="prop-sec sec-sdo"><div class="prop-sec-title">' + t('propSdo') +
        '</div><div class="prop-sdo">' +
        '<img src="https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0193.jpg?t=' + Date.now() +
        '" alt="SDO AIA 193" onerror="this.parentElement.classList.add(\'sdo-fail\')">' +
        '<div class="prop-sdo-cap">AIA 193 Å · ' + sdoCap + '</div>' +
        '</div></div>');

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

    side.innerHTML = html.join('');
    foot.innerHTML = low.join('');

    redrawPropSparks();
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
        hover.textContent = ll[0].toFixed(1) + '°, ' + ll[1].toFixed(1) + '°';
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
