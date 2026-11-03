/* ============================================================
 * DX-Compass - wall display renderer (read-only)
 *
 * One Mercator map on the propagation page's base: dark ocean, Natural
 * Earth coastline outlines from public/data, MUF heat and gray line.
 * Overlay layers (level 1: propagation / aurora / weather, level 2: QSO /
 * my spots / opponent spots) are chosen in the dashboard settings and
 * either stacked together or rotated one at a time.
 *
 * All data arrives through GET requests to bigscreen/server.js, which
 * proxies six read endpoints from Node-RED. Nothing here writes.
 * ============================================================ */

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

const LAYERS = {
    prop: {name: '传播场', en: 'PROP'},
    aurora: {name: '极光', en: 'AURORA'},
    weather: {name: '天气', en: 'WX'},
    qso: {name: 'QSO', en: 'QSO'},
    myspot: {name: '我方 SPOT', en: 'MY SPOT'},
    dxspot: {name: '对手 SPOT', en: 'DX SPOT'}
};
const LAYER_ORDER = ['prop', 'aurora', 'weather', 'qso', 'myspot', 'dxspot'];

const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0', dxspot: '#ff6b6b'};
const BAND_COLORS = {
    '160M': '#b565d8', '80M': '#e67e22', '60M': '#fd79a8', '40M': '#f1c40f',
    '30M': '#1abc9c', '20M': '#00e5ff', '17M': '#3498db', '15M': '#9b59b6',
    '12M': '#e84393', '10M': '#e17055', '6M': '#dfe6e9', '2M': '#55efc4'
};
const MUF_STOPS = [
    [1.5, [24, 34, 88]], [4, [30, 82, 148]], [6.5, [38, 170, 150]],
    [9, [110, 205, 90]], [11.5, [240, 200, 70]], [14, [235, 90, 50]]
];
const WORLD_BOUNDS = [[-85, -180], [85, 180]];
/* The panel is wider than the Mercator world is tall, so a fit has to leave
 * side margins rather than crop: the band below runs from the Antarctic
 * peninsula up past Greenland and Franz Josef Land, which keeps every
 * continent whole (only the polar cap of Antarctica is cut) while still
 * being the largest band that fits the panel height. */
const WORLD_FIT = [[-62, -180], [85, 180]];

const state = {
    settings: {wallTitle: 'DX-COMPASS', wallLayers: ['prop', 'qso', 'myspot', 'dxspot'],
        wallMode: 'all'},
    prop: null,
    vis: {},
    selected: [],
    cycleTimer: null,
    mufOverlay: null, nightOverlay: null,
    views: {},
    spotRows: [], qsoRows: [], station: null
};

const api = p => fetch(p, {cache: 'no-store'}).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
});
const num = (v, d) => v === null || v === undefined || !isFinite(v) ? '—'
    : (d === undefined ? String(v) : Number(v).toFixed(d));
const last = list => list && list.length ? list[list.length - 1] : null;
const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- clock ---------- */
function tickClock() {
    const d = new Date();
    $('#utcClock').textContent = d.toISOString().slice(11, 19);
    $('#utcDate').textContent = d.toISOString().slice(0, 10) + ' · ' +
        ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getUTCDay()];
    renderTimer();
}

/* Contest countdown in the header. The settings page stores a start and an
 * end time as datetime-local strings; they are read as UTC, the same clock
 * the header shows. The header counts down to the start first, then to the
 * end, then reports it ended. With only the end time filled in it simply
 * counts down to the end. */
function renderTimer() {
    const box = $('#wallTimer');
    if (!box) return;
    const s = state.settings || {};
    const stamp = v => {
        const t = String(v || '');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return NaN;
        return new Date(t.length === 16 ? t + ':00Z' : t + 'Z').getTime();
    };
    const start = stamp(s.wallTimerStart), end = stamp(s.wallTimerEnd);
    const now = Date.now();
    let label = '', target = 0, ended = false;
    if (s.wallTimerOn) {
        if (isFinite(start) && now < start) { label = '距开始'; target = start; }
        else if (isFinite(end) && now >= end) { label = '已结束'; ended = true; }
        else if (isFinite(end)) { label = '距结束'; target = end; }
    }
    box.hidden = !label;
    box.classList.toggle('ended', ended);
    if (!label) return;
    const sec = ended ? 0 : Math.max(0, Math.floor((target - now) / 1000));
    const p = n => String(n).padStart(2, '0');
    $('#timerLabel').textContent = label;
    $('#timerValue').textContent = p(Math.floor(sec / 3600)) + ':' +
        p(Math.floor(sec % 3600 / 60)) + ':' + p(sec % 60);
}
setInterval(tickClock, 1000);
tickClock();

/* ---------- map: propagation-page base in Mercator ---------- */
const map = L.map('map', {
    zoomControl: false, attributionControl: false,
    dragging: false, touchZoom: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false,
    zoomSnap: 0, minZoom: 1, maxZoom: 6,
    maxBounds: WORLD_BOUNDS, maxBoundsViscosity: 1
});

/* Raster overlays (land base, MUF field, night shading) get their own pane
 * under Leaflet's overlay pane. Image overlays default to z-index 1 inside
 * that pane, which paints them *above* the SVG QSO/spot lines: the field
 * washed the lines out and the night shading cut them at the terminator.
 * With a lower pane the tracks always stay on top of the field. */
map.createPane('raster');
map.getPane('raster').style.zIndex = 250;

function mercY(lat) {
    const p = rad(clamp(lat, -85, 85));
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + p / 2)) / (2 * Math.PI);
}

/* Rings arrive as flat [lon, lat, ...]; unwrap the longitude so a ring that
 * crosses the antimeridian does not fold back, then draw it three times
 * (base, -360, +360). Only the copies that leave the world edge are kept, so
 * the seam is covered without tripling every path in the middle of the map. */
function ringPoints(flat) {
    const out = [];
    let prev = null;
    for (let i = 0; i < flat.length; i += 2) {
        let lon = flat[i];
        if (prev !== null) {
            while (lon - prev > 180) lon -= 360;
            while (prev - lon > 180) lon += 360;
        }
        prev = lon;
        out.push([lon, flat[i + 1]]);
    }
    return out;
}

function drawBase() {
    const W = 2048, H = 1024;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const xOf = lon => (lon + 180) / 360 * W;
    const yOf = lat => mercY(lat) * H;

    const paint = (rings, fill, stroke, width) => {
        rings.forEach(flat => {
            const pts = ringPoints(flat);
            if (pts.length < 3) return;
            let minLon = Infinity, maxLon = -Infinity;
            pts.forEach(p => { if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0]; });
            const offsets = [0];
            if (maxLon > 180) offsets.push(-360);
            if (minLon < -180) offsets.push(360);
            offsets.forEach(off => {
                ctx.beginPath();
                pts.forEach((p, i) => {
                    const x = xOf(p[0] + off), y = yOf(p[1]);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.closePath();
                if (fill) { ctx.fillStyle = fill; ctx.fill(); }
                if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
            });
        });
    };

    ctx.fillStyle = '#08111c';
    ctx.fillRect(0, 0, W, H);
    /* Coastlines only. The 110m country-border rings were drawn here too, but
     * at wall size they shrink into a web of hairlines all over the
     * continents, which read as stray lines rather than as borders. */
    paint(window.LAND || [], '#0d1a29', '#1b3550', 1);

    L.imageOverlay(cv.toDataURL('image/png'), WORLD_BOUNDS,
        {opacity: 1, interactive: false, pane: 'raster'}).addTo(map);
}

drawBase();
map.fitBounds(WORLD_FIT, {animate: false});
window.addEventListener('resize', () => {
    map.invalidateSize();
    map.fitBounds(WORLD_FIT, {animate: false});
});

/* layer groups: created empty, added/removed by applyWallSettings() */
['aurora', 'weather', 'qso', 'myspot', 'dxspot'].forEach(k => {
    state.views[k] = L.layerGroup();
});

/* ---------- great circle ---------- */
/* Great-circle path in canonical longitudes.
 *
 * The longitudes are unwrapped while sampling: consecutive samples would
 * otherwise jump over 180 degrees whenever the step between them skips the
 * antimeridian (a 40-sample Beijing-Honolulu path does exactly that), which
 * drew a single straight line all the way across the map. Unwrapped values
 * advance past 180 instead, so the path is then cut at each meridian
 * boundary and each piece shifted back into [-180, 180]: it leaves one map
 * edge and re-enters from the opposite one. */
function gcSegments(lat1, lon1, lat2, lon2, samples) {
    samples = samples || 40;
    const f1 = rad(lat1), l1 = rad(lon1), f2 = rad(lat2), l2 = rad(lon2);
    const d = 2 * Math.asin(Math.sqrt(
        Math.sin((f2 - f1) / 2) ** 2 +
        Math.cos(f1) * Math.cos(f2) * Math.sin((l2 - l1) / 2) ** 2));
    if (d < 1e-9) return [];
    const sd = Math.sin(d), pts = [];
    for (let i = 0; i <= samples; i++) {
        const f = i / samples;
        const A = Math.sin((1 - f) * d) / sd, B = Math.sin(f * d) / sd;
        const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
        const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
        const z = A * Math.sin(f1) + B * Math.sin(f2);
        let lon = deg(Math.atan2(y, x));
        if (pts.length) {
            const prev = pts[pts.length - 1][1];
            lon = prev + ((lon - prev + 540) % 360) - 180;
        }
        pts.push([deg(Math.atan2(z, Math.hypot(x, y))), lon]);
    }
    const worldOf = lon => Math.floor((lon + 180) / 360);
    const out = [];
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
        const edge = c > copy ? 180 + 360 * copy : -180 + 360 * copy;
        const cl = la + (lb - la) * ((edge - lo) / (ln - lo));
        seg.push([cl, edge - 360 * copy]);
        out.push(seg);
        seg = [[cl, edge - 360 * c], [lb, ln - 360 * c]];
        copy = c;
    }
    out.push(seg);
    return out;
}

/* Leaflet clamps latitudes at +/-85.05 while projecting, so a great circle
 * that runs over the pole flattens into a line glued to the top edge of the
 * map — the stray line that appeared whenever a route passed near the pole.
 * Cut the sampled path at the fitted top latitude instead (85, still below
 * the clamp): a polar route then runs up to the top edge and stops there,
 * which reads as "continues off the map" rather than as a floating stub. */
const TRACK_LAT = 85;

function clipLat(pts, lo, hi) {
    const cross = (a, b, lat) => {
        const d = b[0] - a[0];
        return [lat, a[1] + (b[1] - a[1]) * (d ? (lat - a[0]) / d : 0)];
    };
    const inside = p => p[0] >= lo && p[0] <= hi;
    const out = [];
    let cur = null;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!inside(p)) {
            if (cur) {
                cur.push(cross(pts[i - 1], p, p[0] > hi ? hi : lo));
                out.push(cur);
                cur = null;
            }
            continue;
        }
        if (!cur) {
            const prev = pts[i - 1];
            cur = prev && !inside(prev) ? [cross(prev, p, prev[0] > hi ? hi : lo)] : [];
            out.push(cur);
        }
        cur.push(p);
    }
    return out.filter(s => s.length > 1);
}

/* Segments ready for the map: seam-cut and clipped at the Mercator limit. */
function trackPaths(lat1, lon1, lat2, lon2, samples) {
    const out = [];
    gcSegments(lat1, lon1, lat2, lon2, samples)
        .forEach(seg => clipLat(seg, -TRACK_LAT, TRACK_LAT).forEach(s => out.push(s)));
    return out;
}

function bearing(lat1, lon1, lat2, lon2) {
    const f1 = rad(lat1), f2 = rad(lat2), dl = rad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const compass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 45) % 8];

/* ---------- GAMBIT field -> MUF ---------- */
function gambitSlice(g, vals, lat, lon) {
    const lats = g.lats, nLat = lats.length;
    if (lat < lats[0] || lat > lats[nLat - 1]) return null;
    const stepLat = (lats[nLat - 1] - lats[0]) / (nLat - 1);
    const fy = (lat - lats[0]) / stepLat;
    const y0 = Math.min(Math.floor(fy), nLat - 2), ty = fy - y0;
    const nLon = g.lons.length, stepLon = 360 / nLon;
    const fx = (((lon + 180) % 360 + 360) % 360) / stepLon;
    const x0 = Math.floor(fx) % nLon, x1 = (x0 + 1) % nLon, tx = fx - Math.floor(fx);
    const r0 = vals[y0], r1 = vals[y0 + 1];
    const a = r0[x0] + (r0[x1] - r0[x0]) * tx;
    const b = r1[x0] + (r1[x1] - r1[x0]) * tx;
    return a + (b - a) * ty;
}

function fof2At(g, lat, lon, when) {
    const t = when || new Date();
    const ut = t.getUTCHours() + t.getUTCMinutes() / 60;
    const uts = g.uts, n = uts.length;
    let a = 0;
    for (let i = 0; i < n; i++) if (uts[i] <= ut) a = i;
    const b = (a + 1) % n;
    const span = n === 1 ? 24 : ((uts[b] - uts[a] + 24) % 24);
    const f = span ? (((ut - uts[a]) + 24) % 24) / span : 0;
    const va = gambitSlice(g, g.values[a], lat, lon);
    if (va === null) return null;
    const vb = gambitSlice(g, g.values[b], lat, lon);
    return vb === null ? va : va * (1 - f) + vb * f;
}

function sunCos(lat, lon, when) {
    const d = when;
    const doy = Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1)) + 864e5) / 864e5);
    const decl = rad(23.44 * Math.sin(rad(360 * (doy - 81) / 365)));
    const h = rad(15 * (d.getUTCHours() + d.getUTCMinutes() / 60 + lon / 15 - 12));
    return Math.sin(rad(lat)) * Math.sin(decl) +
        Math.cos(rad(lat)) * Math.cos(decl) * Math.cos(h);
}

function mufAt(g, lat, lon, when) {
    const f = fof2At(g, lat, lon, when);
    if (f === null) return null;
    return f * (2.45 + 0.55 * clamp(sunCos(lat, lon, when), 0, 1));
}

function rampMuf(v) {
    const s = MUF_STOPS;
    if (v <= s[0][0]) return s[0][1];
    if (v >= s[s.length - 1][0]) return s[s.length - 1][1];
    for (let i = 1; i < s.length; i++) {
        if (v > s[i][0]) continue;
        const [v0, c0] = s[i - 1], [v1, c1] = s[i];
        const t = (v - v0) / (v1 - v0);
        return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t,
            c0[2] + (c1[2] - c0[2]) * t].map(Math.round);
    }
    return s[s.length - 1][1];
}

const FIELD_W = 200, FIELD_H = 100;

function fieldCanvas(g, when, night) {
    const cv = document.createElement('canvas');
    cv.width = FIELD_W;
    cv.height = FIELD_H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(FIELD_W, FIELD_H);
    const px = img.data;
    for (let y = 0; y < FIELD_H; y++) {
        const lat = 85 - (y + 0.5) * 170 / FIELD_H;
        for (let x = 0; x < FIELD_W; x++) {
            const lon = -180 + (x + 0.5) * 360 / FIELD_W;
            const i = (y * FIELD_W + x) * 4;
            if (night) {
                px[i] = 2; px[i + 1] = 6; px[i + 2] = 12;
                px[i + 3] = Math.round(150 * clamp((0.12 - sunCos(lat, lon, when)) / 0.24, 0, 1));
                continue;
            }
            const v = mufAt(g, lat, lon, when);
            if (v === null) { px[i + 3] = 0; continue; }
            const c = rampMuf(v);
            px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
            px[i + 3] = 150;
        }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
}

let fieldNow = new Date();

function renderPropField(g) {
    const now = fieldNow;
    const urlMuf = fieldCanvas(g, now, false);
    const urlNight = fieldCanvas(g, now, true);
    if (state.mufOverlay) map.removeLayer(state.mufOverlay);
    if (state.nightOverlay) map.removeLayer(state.nightOverlay);
    state.mufOverlay = L.imageOverlay(urlMuf, WORLD_BOUNDS,
        {opacity: 0.72, interactive: false, pane: 'raster'});
    state.nightOverlay = L.imageOverlay(urlNight, WORLD_BOUNDS,
        {opacity: 0.9, interactive: false, pane: 'raster'});
    if (state.vis.prop) {
        state.mufOverlay.addTo(map);
        state.nightOverlay.addTo(map);
    }
}

/* ---------- layer visibility (stack or rotate) ---------- */
function setVisible(k, on) {
    state.vis[k] = on;
    if (k === 'prop') {
        [state.mufOverlay, state.nightOverlay].forEach(o => {
            if (!o) return;
            if (on) { if (!map.hasLayer(o)) map.addLayer(o); }
            else if (map.hasLayer(o)) map.removeLayer(o);
        });
        return;
    }
    const g = state.views[k];
    if (!g) return;
    if (on) { if (!map.hasLayer(g)) map.addLayer(g); }
    else if (map.hasLayer(g)) map.removeLayer(g);
}

/* The legend mirrors what is on the map right now: every selected layer in
 * stack mode, only the one currently raised in rotate mode. */
function renderLegend(shown) {
    const parts = [];
    if (shown.includes('prop')) {
        const stops = MUF_STOPS.map(([, c], i) =>
            'rgb(' + c.join(',') + ') ' + Math.round(i * 100 / (MUF_STOPS.length - 1)) + '%');
        parts.push('<span>MUF</span><i class="grad" style="background:linear-gradient(90deg,' +
            stops.join(',') + ')"></i>');
    }
    if (shown.includes('aurora')) {
        parts.push('<span><i class="dot" style="background:#5ce68a"></i>极光</span>');
    }
    if (shown.includes('weather')) {
        parts.push('<span><i class="dot" style="background:#7bc4ff"></i>天气</span>');
    }
    if (shown.includes('qso')) {
        parts.push('<span><i class="dot" style="background:' + COLORS.qso + '"></i>QSO</span>');
    }
    if (shown.includes('myspot')) {
        parts.push('<span><i class="dot" style="background:' + COLORS.myspot + '"></i>我方 SPOT</span>');
    }
    if (shown.includes('dxspot')) {
        parts.push('<span><i class="dot" style="background:' + COLORS.dxspot + '"></i>对手 SPOT</span>');
    }
    $('#mapLegend').innerHTML = parts.join('');
}

function applyWallSettings() {
    const st = state.settings;
    $('#wallName').textContent = st.wallTitle || 'DX-COMPASS';

    const layers = Array.isArray(st.wallLayers) ? st.wallLayers : [];
    const sel = LAYER_ORDER.filter(k => layers.includes(k));
    state.selected = sel.length ? sel : ['prop'];

    if (state.cycleTimer) { clearInterval(state.cycleTimer); state.cycleTimer = null; }

    LAYER_ORDER.forEach(k => setVisible(k, false));

    if (st.wallMode === 'cycle' && state.selected.length > 1) {
        let i = 0;
        const show = () => {
            LAYER_ORDER.forEach(k => setVisible(k, false));
            setVisible(state.selected[i], true);
            $('#layerTag').textContent = LAYERS[state.selected[i]].en +
                ' · ' + (i + 1) + '/' + state.selected.length;
            renderLegend([state.selected[i]]);
        };
        show();
        state.cycleTimer = setInterval(() => {
            i = (i + 1) % state.selected.length;
            show();
        }, 10000);
    } else {
        state.selected.forEach(k => setVisible(k, true));
        $('#layerTag').textContent = 'ALL LAYERS · ' + state.selected.length;
        renderLegend(state.selected);
    }
}

/* ---------- space weather ---------- */
function xrayClass(f) {
    if (!f || f <= 0) return '—';
    const order = ['A', 'B', 'C', 'M', 'X'];
    const e = Math.floor(Math.log10(f));
    const mant = f / Math.pow(10, e);
    return order[clamp(e + 8, 0, 4)] + (mant >= 1 ? mant.toFixed(1) : '1.0');
}

function renderSpaceWeather(d) {
    const sfi = last(d.sfi && d.sfi.list), kp = last(d.kp && d.kp.list),
        dst = last(d.dst && d.dst.list), xr = last(d.xray && d.xray.list),
        ssn = last(d.ssn && d.ssn.list), mag = last(d.mag && d.mag.list),
        wind = last(d.wind && d.wind.list);
    const ham = d.ham || {};
    const cells = [
        ['SFI', sfi ? num(sfi[1]) : num(ham.sfi), ''],
        ['SSN', ssn ? num(ssn[1]) : num(ham.ssn), ''],
        ['KP', kp ? num(kp[1], 1) : num(ham.kp, 1), kp && kp[1] >= 5 ? 'bad' : ''],
        ['DST', dst ? num(dst[1], 0) : '—', dst && dst[1] <= -50 ? 'bad' : ''],
        ['BZ', mag && mag[2] !== null ? num(mag[2], 1) : num(ham.bz, 1),
            mag && mag[2] <= -10 ? 'bad' : ''],
        ['BT', mag && mag[1] !== null ? num(mag[1], 1) : '—', ''],
        ['WIND', wind ? num(wind[1], 0) : '—', ''],
        ['XRAY', xr ? xrayClass(xr[1]) : (ham.xray || '—'), '']
    ];
    $('#swGrid').innerHTML = cells.map(([k, v, c]) =>
        '<div><label>' + k + '</label><b class="' + c + '">' + esc(v) + '</b></div>').join('');
}

/* ---------- band conditions ---------- */
function renderBands(d) {
    const bands = d && d.ham && d.ham.bands || [];
    if (!bands.length) {
        $('#bandBar').innerHTML = '<div class="band closed"><b>—</b></div>';
        return;
    }
    const home = gridToLatLon(state.settings.grid);
    const now = new Date();
    const h = ((now.getUTCHours() + now.getUTCMinutes() / 60 +
        (home ? home[1] / 15 : 0)) % 24 + 24) % 24;
    const day = h >= 6 && h < 18;
    const seen = new Set();
    const pick = want => bands.filter(b => {
        if (want && /day|night/i.test(b.time) &&
            !(want === 'day' ? /day/i.test(b.time) : /night/i.test(b.time))) return false;
        const k = String(b.name).toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    /* A feed that only publishes one of the two tables leaves the card blank,
     * so fall back to whatever it does publish. */
    let list = pick(day ? 'day' : 'night');
    if (!list.length) {
        seen.clear();
        list = pick(null);
    }
    $('#bandBar').innerHTML = list.map(b => {
        const c = String(b.cond || '').toLowerCase();
        const cls = c === 'good' ? 'good' : c === 'fair' ? 'fair' : c === 'poor' ? 'poor' : 'closed';
        /* A three-step meter under the word: full for good, two for fair,
         * one for poor, none for closed. */
        const lvl = cls === 'good' ? 3 : cls === 'fair' ? 2 : cls === 'poor' ? 1 : 0;
        return '<div class="band ' + cls + '"><b>' + esc(String(b.name).toUpperCase()) +
            '</b><span>' + esc(b.cond || '—') + '</span><div class="meter">' +
            [0, 1, 2].map(i => '<u' + (i < lvl ? ' class="on"' : '') + '></u>').join('') +
            '</div></div>';
    }).join('');
}

/* ---------- radio cards ---------- */
function bandOf(freqKhz) {
    const f = freqKhz / 1000;
    if (!isFinite(f)) return '';
    if (f < 2) return '160M';
    if (f < 4.5) return '80M';
    if (f < 6) return '60M';
    if (f < 8.5) return '40M';
    if (f < 11.5) return '30M';
    if (f < 16) return '20M';
    if (f < 19.5) return '17M';
    if (f < 22.5) return '15M';
    if (f < 26.5) return '12M';
    if (f < 30) return '10M';
    return 'VHF';
}

function renderRadios() {
    const st = state.station || {};
    const radios = st.radios || {};
    const ids = Object.keys(radios);
    if (!ids.length) {
        $('#radioCards').innerHTML = '<div class="opp-empty">等待电台数据…</div>';
        return;
    }
    $('#radioCards').innerHTML = ids.map(id => {
        const r = radios[id] || {};
        const tx = r.isTransmitting ? ' tx' : '';
        const mhz = r.freqKhz ? num(r.freqKhz / 1000, 3) + ' MHz' : '—';
        const band = bandOf(r.freqKhz);
        const nm = r.radioName || ('RADIO ' + id);
        return '<div class="radio' + tx + '"><label>' + esc(nm) +
            (tx ? ' · TX' : '') + '</label><b>' + esc(mhz) + '</b><span>' +
            esc(band + (r.mode ? ' · ' + r.mode : '') +
                (r.opCall ? ' · ' + r.opCall : '')) + '</span></div>';
    }).join('');
}

/* ---------- QSO stats ---------- */
function renderQsoStats() {
    const rows = state.qsoRows;
    const now = Date.now();
    const within = ms => rows.filter(q => {
        const t = new Date(q.timestamp).getTime();
        return isFinite(t) && now - t <= ms;
    }).length;
    const hour = within(60 * 60 * 1000);
    const ten = within(10 * 60 * 1000);
    $('#rateHour').textContent = hour;
    $('#rateMin').textContent = (ten / 10).toFixed(1);

    const byOp = new Map(), byBand = new Map();
    rows.forEach(q => {
        const op = q.operator || q.op || '—';
        byOp.set(op, (byOp.get(op) || 0) + 1);
        const b = String(q.band || '').toUpperCase() || '—';
        byBand.set(b, (byBand.get(b) || 0) + 1);
    });
    renderRank('#opList', byOp, 6, v => v);
    renderRank('#bandList', byBand, 8, v => v, true);
}

function renderRank(sel, map, limit, fmt, bandColor) {
    const list = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const max = list.length ? list[0][1] : 0;
    $(sel).innerHTML = list.length ? list.map(([k, v]) => {
        const color = bandColor ? (BAND_COLORS[k] || '#35d6a4') : COLORS.qso;
        return '<div class="hbar"><span class="k">' + esc(fmt(k)) + '</span>' +
            '<i class="track"><i style="width:' + Math.round(v / (max || 1) * 100) +
            '%;background:' + color + '"></i></i><em>' + v + '</em></div>';
    }).join('') : '<div class="opp-empty">—</div>';
}

/* ---------- trend charts ---------- */
/* Bars are per-minute counts over the last hour; canvases are sized from
 * their CSS box so the lines stay sharp on HiDPI wall screens. */
function canvasBox(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, cv.clientWidth), h = Math.max(20, cv.clientHeight);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return {ctx, w, h};
}

function perMinute(rows, minutes) {
    const now = Date.now();
    const bins = new Array(minutes).fill(0);
    rows.forEach(r => {
        const t = new Date(r.timestamp).getTime();
        if (!isFinite(t)) return;
        const age = Math.floor((now - t) / 60000);
        if (age >= 0 && age < minutes) bins[minutes - 1 - age]++;
    });
    return bins;
}

/* Same binning one octave up: the rate card reads the last twelve hours as
 * a line, so the hourly totals need their own pass. */
function perHour(rows, hours) {
    const now = Date.now();
    const bins = new Array(hours).fill(0);
    rows.forEach(r => {
        const t = new Date(r.timestamp).getTime();
        if (!isFinite(t)) return;
        const age = Math.floor((now - t) / 3600000);
        if (age >= 0 && age < hours) bins[hours - 1 - age]++;
    });
    return bins;
}

function drawBars(sel, bins, color) {
    const cv = $(sel);
    if (!cv) return 0;
    const {ctx, w, h} = canvasBox(cv);
    ctx.clearRect(0, 0, w, h);
    const peak = Math.max(0, ...bins);
    const max = Math.max(1, peak);
    const bw = w / bins.length;
    ctx.fillStyle = 'rgba(122,168,255,0.14)';
    ctx.fillRect(0, h - 1, w, 1);
    bins.forEach((v, i) => {
        const bh = (v / max) * (h - 6);
        if (bh <= 0) return;
        /* older minutes fade out so the recent edge reads as "now" */
        ctx.globalAlpha = 0.3 + 0.7 * (i + 1) / bins.length;
        ctx.fillStyle = color;
        ctx.fillRect(i * bw + 0.5, h - 1 - bh, Math.max(1, bw - 1.2), bh);
    });
    ctx.globalAlpha = 1;
    return peak;
}

function drawLine(sel, values, color) {
    const cv = $(sel);
    if (!cv || values.length < 2) return;
    const {ctx, w, h} = canvasBox(cv);
    ctx.clearRect(0, 0, w, h);
    const lo = Math.min(...values), hi = Math.max(...values);
    const span = hi - lo || 1;
    const px = i => 1 + (i / (values.length - 1)) * (w - 2);
    const py = v => h - 3 - ((v - lo) / span) * (h - 7);
    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.lineTo(px(values.length - 1), h - 1);
    ctx.lineTo(px(0), h - 1);
    ctx.closePath();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
}

function renderQsoTrend() {
    $('#qsoPeak').textContent = drawBars('#qsoTrend', perMinute(state.qsoRows, 60), COLORS.qso);
}

/* The rate card keeps one headline figure and shows the twelve hourly totals
 * as a line, so the pace reads as a shape rather than a pair of numbers. */
function renderRateTrend() {
    drawLine('#rateTrend', perHour(state.qsoRows, 12), COLORS.qso);
}

function renderSpotTrend() {
    $('#spotPeak').textContent = drawBars('#spotTrend', perMinute(state.spotRows, 60), COLORS.myspot);
}

/* SFI runs at one value per day, so the sunspot-cycle feed is read as a
 * 30-day line rather than per-minute bars. */
function renderSpaceTrend(d) {
    const list = d && d.sfi && d.sfi.list || [];
    const vals = list.map(r => num(r[1])).filter(v => v !== null).slice(-30);
    $('#sfiNow').textContent = vals.length ? Math.round(vals[vals.length - 1]) : '—';
    drawLine('#swTrend', vals, '#e8c547');
}

/* ---------- opponent table (grows with each monitored call) ---------- */
/* An opponent is rarely on one band only: SO2R and multi-multi stations get
 * spotted on several bands at the same time, and keeping just the newest spot
 * hid the others. Each call therefore keeps one slot per band (newest spot
 * wins) and the row shows the whole set instead of a single frequency. */
function buildOpponents(rows) {
    const my = String(state.settings.myCall || '').toUpperCase();
    const by = new Map();
    rows.forEach(r => {
        const call = String(r.monitored_call || r.dx_call || '').toUpperCase();
        if (!call || call === my) return;
        let o = by.get(call);
        if (!o) {
            o = {call, n: 0, sin: 0, cos: 0, bands: new Map()};
            by.set(call, o);
        }
        o.n++;
        const t = new Date(r.timestamp).getTime();
        const band = String(r.band || '').toUpperCase();
        /* Without a band field fall back to the frequency, so two different
         * spot frequencies still count as two simultaneous slots. */
        const key = band || (r.freq ? 'F' + r.freq : '');
        const seen = key ? o.bands.get(key) : null;
        if (key && (!seen || (isFinite(t) && t > seen.ts))) {
            o.bands.set(key, {band, freq: r.freq, ts: isFinite(t) ? t : 0});
        }
        if (r.lat !== null && r.lat !== undefined && r.dx_lat !== null && r.dx_lat !== undefined) {
            const b = bearing(r.dx_lat, r.dx_lon, r.lat, r.lon);
            o.sin += Math.sin(rad(b));
            o.cos += Math.cos(rad(b));
        }
    });
    return [...by.values()].sort((a, b) => b.n - a.n).map(o => {
        o.dir = Math.atan2(o.sin, o.cos) * 180 / Math.PI;
        o.dir = (o.dir + 360) % 360;
        o.bands = [...o.bands.values()].sort((a, b) => b.ts - a.ts);
        return o;
    });
}

function oppRowHtml(o) {
    const named = (o.bands || []).filter(b => b.band);
    const shown = named.slice(0, 3);
    const extra = named.length - shown.length;
    /* Band chips rather than one frequency: a station working two bands has
     * two frequencies and neither is "the" one. The exact kHz is still shown
     * when there is only one band, where it cannot be misread. Spots that
     * never carried a band field fall back to that frequency on its own. */
    const chips = shown.map(b => {
        const col = BAND_COLORS[b.band] || 'var(--dim)';
        return '<i style="color:' + col + '">' + esc(b.band.replace(/M$/, '')) + '</i>';
    }).join('');
    const more = extra > 0 ? '<em>+' + extra + '</em>' : '';
    const newest = (o.bands || [])[0];
    const fq = newest && newest.freq ? num(newest.freq / 1000, 3) : '';
    const cell = chips
        ? chips + more + (named.length === 1 && fq ? '<u>' + fq + '</u>' : '')
        : (fq || '—');
    const hasDir = o.sin !== 0 || o.cos !== 0;
    const dir = hasDir ? compass(o.dir) + ' ' + Math.round(o.dir) + '°' : '—';
    return '<div class="opp-row"><b>' + esc(o.call) + '</b><span class="cnt">' +
        o.n + '</span><span class="dir">' + dir + '</span><span class="freq">' +
        cell + '</span></div>';
}

/* The card takes whatever height the viewport leaves, and that height also
 * moves whenever an upper card reflows. Measure one row and keep as many as
 * fit plus the "+N more" footer, so a short screen still says how many are
 * off-screen instead of clipping silently. */
let oppList = [];
function trimOppRows() {
    const box = $('#oppRows');
    if (!box || !oppList.length) return;
    box.innerHTML = oppList.slice(0, 12).map(oppRowHtml).join('');
    const first = box.firstElementChild;
    const rowH = first ? first.getBoundingClientRect().height : 0;
    const avail = box.clientHeight;
    if (!rowH || !avail) return;
    let cap = Math.max(1, Math.floor(avail / rowH));
    if (cap >= oppList.length) return;
    cap = Math.max(1, Math.floor((avail - 14) / rowH));
    const shown = Math.min(cap, oppList.length);
    box.innerHTML = oppList.slice(0, shown).map(oppRowHtml).join('') +
        '<div class="opp-empty">+' + (oppList.length - shown) + ' more</div>';
}

function renderOpponents() {
    oppList = buildOpponents(state.spotRows);
    const box = $('#oppRows');
    if (!oppList.length) {
        box.innerHTML = '<div class="opp-empty">等待对手 SPOT…</div>';
        return;
    }
    trimOppRows();
}

/* ---------- map layers: spots ---------- */
function drawSpots() {
    const my = String(state.settings.myCall || '').toUpperCase();
    const cutoff = Date.now() - 30 * 60 * 1000;
    state.views.myspot.clearLayers();
    state.views.dxspot.clearLayers();
    state.spotRows.forEach(r => {
        const t = new Date(r.timestamp).getTime();
        if (!isFinite(t) || t < cutoff) return;
        const isMine = String(r.monitored_call || '').toUpperCase() === my;
        const color = isMine ? COLORS.myspot : COLORS.dxspot;
        const grp = isMine ? state.views.myspot : state.views.dxspot;
        const hasDe = r.lat !== null && r.lat !== undefined && r.lon !== null && r.lon !== undefined;
        const hasDx = r.dx_lat !== null && r.dx_lat !== undefined &&
            r.dx_lon !== null && r.dx_lon !== undefined;
        if (hasDx) {
            L.circleMarker([r.dx_lat, r.dx_lon], {
                radius: 3, color, weight: 1, fillColor: color, fillOpacity: 0.85,
                interactive: false
            }).addTo(grp);
        }
        if (hasDe) {
            L.circleMarker([r.lat, r.lon], {
                radius: 2.4, color, weight: 1, fillColor: color, fillOpacity: 0.55,
                interactive: false
            }).addTo(grp);
        }
        if (hasDe && hasDx) {
            trackPaths(r.dx_lat, r.dx_lon, r.lat, r.lon, 64).forEach(seg => {
                L.polyline(seg, {color, weight: 1.1, opacity: 0.45, interactive: false})
                    .addTo(grp);
            });
        }
    });
}

/* ---------- map layers: QSO ---------- */
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

function drawQso() {
    const grp = state.views.qso;
    grp.clearLayers();
    const home = gridToLatLon(state.settings.grid);
    state.qsoRows.forEach(q => {
        if (q.lat === null || q.lat === undefined || q.lon === null || q.lon === undefined) return;
        L.circleMarker([q.lat, q.lon], {
            radius: 2.6, color: COLORS.qso, weight: 1,
            fillColor: COLORS.qso, fillOpacity: 0.8, interactive: false
        }).addTo(grp);
        if (home) {
            trackPaths(home[0], home[1], q.lat, q.lon, 64).forEach(seg => {
                L.polyline(seg, {color: COLORS.qso, weight: 1, opacity: 0.35, interactive: false})
                    .addTo(grp);
            });
        }
    });
    if (home) {
        L.circleMarker(home, {
            radius: 6, color: '#ffffff', weight: 2,
            fillColor: COLORS.qso, fillOpacity: 1, interactive: false
        }).addTo(grp);
    }
}

/* ---------- map layers: aurora + weather ---------- */
function drawAurora(d) {
    const grp = state.views.aurora;
    grp.clearLayers();
    const pts = d && d.aurora && d.aurora.grid || [];
    pts.forEach(p => {
        const prob = p[2];
        L.circleMarker([p[1], p[0]], {
            radius: 2 + prob / 22,
            color: 'hsla(' + (140 + prob * 1.5) + ',85%,62%,0.9)',
            weight: 0, fillColor: 'hsla(' + (140 + prob * 1.5) + ',85%,62%,0.55)',
            fillOpacity: 0.55, interactive: false
        }).addTo(grp);
    });
}

function drawWeather(d) {
    const grp = state.views.weather;
    grp.clearLayers();
    const pts = d && d.wx && d.wx.pts || [];
    pts.forEach(p => {
        const t = p[2];
        if (t === null || !isFinite(t)) return;
        const hue = clamp(210 - t * 6, 0, 210);
        L.circleMarker([p[0], p[1]], {
            radius: 5, color: 'transparent', weight: 0,
            fillColor: 'hsl(' + hue + ',80%,60%)', fillOpacity: 0.7, interactive: false
        }).addTo(grp);
    });
}

/* ---------- polling ---------- */
async function refreshSettings() {
    try {
        const d = await api('/api/settings');
        if (d && d.settings) state.settings = Object.assign(state.settings, d.settings);
    } catch (e) { /* keep defaults */ }
    const key = JSON.stringify([state.settings.wallTitle, state.settings.wallLayers,
        state.settings.wallMode, state.settings.myCall, state.settings.grid]);
    if (key !== state.settingsKey) {
        state.settingsKey = key;
        applyWallSettings();
        drawQso();
    }
    renderBands(state.prop || {});
}

async function refreshProp() {
    try {
        const d = await api('/api/prop');
        state.prop = d;
        fieldNow = new Date();
        if (d.gambit && d.gambit.values) renderPropField(d.gambit);
        renderSpaceWeather(d);
        renderSpaceTrend(d);
        renderBands(d);
        drawAurora(d);
        drawWeather(d);
    } catch (e) { /* keep the previous field */ }
}

async function refreshSpots() {
    try {
        const rows = await api('/api/spots?limit=400');
        state.spotRows = Array.isArray(rows) ? rows : [];
    } catch (e) { /* keep the previous spots */ }
    drawSpots();
    renderSpotTrend();
    renderOpponents();
}

async function refreshQso() {
    try {
        const rows = await api('/api/qsos?limit=2000');
        state.qsoRows = Array.isArray(rows) ? rows : [];
    } catch (e) { /* keep the previous QSOs */ }
    drawQso();
    renderQsoStats();
    renderQsoTrend();
    renderRateTrend();
}

async function refreshStation() {
    try {
        state.station = await api('/api/station/state');
    } catch (e) { /* keep the previous radios */ }
    renderRadios();
}

async function boot() {
    await refreshSettings();
    await Promise.all([refreshProp(), refreshSpots(), refreshQso(), refreshStation(),
        refreshSettings()]);
}
boot();
setInterval(refreshProp, 60 * 1000);
setInterval(refreshSpots, 30 * 1000);
setInterval(refreshQso, 30 * 1000);
setInterval(refreshStation, 15 * 1000);
setInterval(refreshSettings, 60 * 1000);

/* Canvases are sized from their CSS box, so a window change needs a redraw;
 * Leaflet also has to re-measure its container after the rail width moved. */
let resizeTimer = null;
window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        resizeTimer = null;
        map.invalidateSize();
        renderQsoTrend();
        renderRateTrend();
        renderSpotTrend();
        renderSpaceTrend(state.prop || {});
    }, 200);
});

/* The cards above reflow when bands wrap or a chart redraws, which moves the
 * space left for the opponent table: re-trim whenever its box changes. */
if (window.ResizeObserver) {
    new ResizeObserver(() => trimOppRows()).observe($('#oppRows'));
}
