/* ============================================================
 * DX-Compass - Frontend application
 * DVR-style multi-map DX spot monitor
 * ============================================================ */

/* ---------- Global settings (persisted to localStorage) ---------- */
const DEFAULT_BAND_COLORS = {
    '160m': '#b565d8', '80m': '#e67e22', '60m': '#fd79a8', '40m': '#f1c40f',
    '30m': '#1abc9c', '20m': '#00e5ff', '17m': '#3498db', '15m': '#9b59b6',
    '12m': '#e84393', '10m': '#e17055', '6m': '#dfe6e9', '2m': '#55efc4'
};
const DEFAULT_TTL_MIN = { CW: 30, SSB: 30, DIGI: 30 };

/* UI translations (LANGS / LANG_NAMES / I18N) live in js/i18n.js so
 * new languages can be added without touching the application code. */

/* Contest entry categories supported on the QSO map (BY7WZ parity):
 * single-op one/two radio, multi-single, multi-multi. */
const CONTESTS_CATEGORIES = ['SO1R', 'SO2R', 'MS', 'MM'];

/* Base map tile providers. 'amap' (AutoNavi/高德) stays reachable from
 * mainland China where tile.openstreetmap.org is blocked. Note: AMap raster
 * tiles use the GCJ-02 datum, so WGS-84 spot coordinates can shift by up to
 * a few hundred meters - invisible at this app's zoom range (auto-fit caps
 * at zoom 7, where one pixel is ~1.2 km). */
const TILE_PROVIDERS = {
    osm: {
        name: 'OpenStreetMap',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { attribution: '&copy; OpenStreetMap', maxZoom: 18 }
    },
    amap: {
        name: '高德地图 (AMap)',
        url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        options: { attribution: '&copy; AutoNavi 高德地图', maxZoom: 18, subdomains: ['1', '2', '3', '4'] }
    }
};

const settings = loadSettings();

function loadSettings() {
    const d = {
        lang: 'zh', tiles: 'osm', grid: '',
        category: 'SO1R', qsoMax: 1500, qsoLines: true, qsoAutoFit: true,
        qsoSpotAlert: true, qsoVoiceAlert: true,
        ttl: {...DEFAULT_TTL_MIN}, bandColors: {...DEFAULT_BAND_COLORS}
    };
    try {
        const raw = JSON.parse(localStorage.getItem('dxcompass-settings') || '{}');
        if (LANGS.includes(raw.lang)) d.lang = raw.lang;
        if (TILE_PROVIDERS[raw.tiles]) d.tiles = raw.tiles;
        if (/^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2})?$/.test(raw.grid || '')) d.grid = raw.grid.toUpperCase();
        if (CONTESTS_CATEGORIES.includes(raw.category)) d.category = raw.category;
        const qm = parseInt(raw.qsoMax, 10);
        if (qm >= 200 && qm <= 4000) d.qsoMax = qm;
        if (typeof raw.qsoLines === 'boolean') d.qsoLines = raw.qsoLines;
        if (typeof raw.qsoAutoFit === 'boolean') d.qsoAutoFit = raw.qsoAutoFit;
        if (typeof raw.qsoSpotAlert === 'boolean') d.qsoSpotAlert = raw.qsoSpotAlert;
        if (typeof raw.qsoVoiceAlert === 'boolean') d.qsoVoiceAlert = raw.qsoVoiceAlert;
        for (const m of Object.keys(d.ttl)) {
            const v = parseInt(raw.ttl && raw.ttl[m], 10);
            if (v >= 1 && v <= 180) d.ttl[m] = v;
        }
        if (raw.bandColors && typeof raw.bandColors === 'object') {
            for (const b of Object.keys(d.bandColors)) {
                if (/^#[0-9a-fA-F]{6}$/.test(raw.bandColors[b] || '')) d.bandColors[b] = raw.bandColors[b];
            }
        }
    } catch (e) { /* keep defaults */ }
    return d;
}
function saveSettings() {
    localStorage.setItem('dxcompass-settings', JSON.stringify(settings));
}

/* Marker / info-chip / heat survival per mode (minutes, configurable in Settings) */
function ttlForMode(mode) {
    const m = (mode || '').toUpperCase();
    const mins = settings.ttl[m] !== undefined ? settings.ttl[m] : settings.ttl.SSB;
    return mins * 60 * 1000;
}
function bandColorOf(band) {
    return settings.bandColors[band] || '#00e5ff';
}

/* Base map tiles are built per map so the provider can be swapped live.
 * noWrap + WORLD_BOUNDS keep the single-world convention on every provider. */
function makeTileLayer() {
    const p = TILE_PROVIDERS[settings.tiles] || TILE_PROVIDERS.osm;
    return L.tileLayer(p.url, { ...p.options, noWrap: true, bounds: WORLD_BOUNDS });
}
/* Swap the base map on every cell. Markers/links/heat/terminator live in
 * separate panes and view/minZoom/maxBounds are map options, so all map
 * display conventions survive the switch untouched. */
function setTileProvider(key) {
    if (!TILE_PROVIDERS[key] || settings.tiles === key) return;
    settings.tiles = key;
    saveSettings();
    state.cells.forEach(c => {
        if (c.tile) c.map.removeLayer(c.tile);
        c.tile = makeTileLayer().addTo(c.map);
    });
    if (qsoState.tile) {
        qsoState.map.removeLayer(qsoState.tile);
        qsoState.tile = makeTileLayer().addTo(qsoState.map);
    }
}

function t(key) {
    const v = I18N[settings.lang][key];
    return v !== undefined ? v : (I18N.en[key] !== undefined ? I18N.en[key] : key);
}

const HISTORY_LIMIT = 500;            // rows fetched per call after a page reload
const MAX_CELLS = 9;

/* Single-world bounds: tiles and panning are confined to one world map;
 * the minimum zoom is computed so exactly one whole world is visible. */
const WORLD_BOUNDS = [[-85.06, -180], [85.06, 180]];
const AUTO_FIT_MAX_ZOOM = 7; // cap for marker auto-fit (single tight cluster)

const state = {
    layout: '1x1',
    cells: [],          // array of {index, call, map, markers:[], count}
    ws: null,
    wsConnected: false,
    connState: 'disconnected',
    totalSpots: 0,
    config: {},
    callsigns: [],      // configured callsign slots (source of truth)
    monitoring: localStorage.getItem('dxcompass-monitoring') === '1',
    recView: 'all',     // records panel view: 'all' spots | 'rec' recorded session spots
    recStatus: null,    // last known recording state from the backend
    rotation: {
        offset: 0,      // paging offset into the callsign list
        timer: null,
        running: false,
        intervalSec: parseInt(localStorage.getItem('dxcompass-rot-sec'), 10) || 15
    }
};

/* ---------- Utilities ---------- */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

function showToast(msg, ms = 2500) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), ms);
}

/* Custom dark-theme confirm modal; resolves true (OK) / false (Cancel). */
function showConfirm(msg, opts = {}) {
    return new Promise(resolve => {
        const ov = $('#modalOverlay');
        const okBtn = $('#modalOk');
        const cancelBtn = $('#modalCancel');
        $('#modalTitle').textContent = opts.title || t('confirmTitle');
        $('#modalMsg').textContent = msg;
        okBtn.textContent = opts.okText || t('ok');
        cancelBtn.textContent = opts.cancelText || t('cancel');
        okBtn.classList.toggle('danger', !!opts.danger);
        ov.classList.remove('hidden');
        const done = val => {
            ov.classList.add('hidden');
            okBtn.onclick = cancelBtn.onclick = ov.onclick = null;
            document.removeEventListener('keydown', onKey);
            resolve(val);
        };
        const onKey = e => {
            if (e.key === 'Escape') done(false);
            else if (e.key === 'Enter') done(true);
        };
        okBtn.onclick = () => done(true);
        cancelBtn.onclick = () => done(false);
        ov.onclick = e => { if (e.target === ov) done(false); };
        document.addEventListener('keydown', onKey);
        okBtn.focus();
    });
}

function setConnState(cs) {
    state.connState = cs;
    const dot = $('#connDot');
    const txt = $('#connText');
    dot.className = 'conn-dot ' + cs;
    txt.textContent = cs === 'connected' ? t('connected') :
                      cs === 'connecting' ? t('connecting') : t('disconnected');
}

function renderCellInfo(cell) {
    const chips = [];
    for (const band of Object.keys(cell.bandInfo)) {
        const s = cell.bandInfo[band].spot;
        const bandColor = bandColorOf(band);
        const sig = s.snr !== null && s.snr !== undefined ? s.snr + ' dB' :
                    (s.signal || '');
        const heatable = heatCounts(cell)[band] > 0;
        const cls = 'ci-chip' +
            (heatable ? ' heat-on' : '') +
            (cell.activeBand === band && heatable ? ' active' : '');
        chips.push(`<div class="${cls}" data-band="${band}" style="border-color:${bandColor}">
            <span class="ci-band" style="color:${bandColor}">${band}</span>
            <span class="ci-freq">${s.freq ? s.freq + ' kHz' : ''}</span>
            <span class="ci-mode">${s.mode || ''}</span>
            <span class="ci-sig">${sig}</span>
            <span class="ci-age">${timeAgo(new Date(s.timestamp))}</span>
        </div>`);
    }
    cell.info.innerHTML = chips.join('');
}

function timeAgo(dt) {
    const sec = Math.floor((Date.now() - dt.getTime()) / 1000);
    if (sec < 30) return t('now');
    if (sec < 90) return t('mAgo')(1);
    if (sec < 180) return t('mAgo')(2);
    if (sec < 300) return t('mAgo')(5);
    if (sec < 600) return t('mAgo')(10);
    if (sec < 1800) return t('mAgo')(30);
    if (sec < 3600) return t('h1');
    return t('hAgo')(Math.floor(sec / 3600));
}

function modeBadge(mode) {
    if (!mode) return '';
    const cls = mode === 'CW' ? 'mode-cw' : mode === 'DIGI' ? 'mode-digi' : 'mode-phone';
    return `<span class="${cls}">${mode}</span>`;
}

function formatTime(ts) {
    try {
        const d = new Date(ts);
        return d.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
    } catch (e) { return ts; }
}

/* ---------- Grid / Cells ---------- */
function cellCountForLayout(layout) {
    const [r, c] = layout.split('x').map(Number);
    return r * c;
}

function setLayout(layout) {
    state.layout = layout;
    const grid = $('#grid');
    grid.className = 'grid layout-' + layout;

    const count = cellCountForLayout(layout);
    // Cells are created once and kept alive; only visibility changes,
    // so maps and markers survive every layout switch.
    state.cells.forEach((c, i) => {
        c.el.style.display = i < count ? '' : 'none';
    });
    setTimeout(() => state.cells.forEach(c => {
        if (c.el.style.display !== 'none' && c.map) {
            c.map.invalidateSize();
            fitCellView(c);  // re-fit markers (or world view when empty)
        }
    }), 50);
    // Highlight active layout button
    $all('.layout-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === layout);
    });
    // Cell count changed -> re-deal the callsigns across visible cells
    if (!rotationNeeded()) {
        state.rotation.offset = 0;
        stopRotation();
    }
    assignCalls();
    updateRotateUI();
}

function createCell(index) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.index = index;
    el.innerHTML = `
        <div class="cell-header">
            <span class="call-label">&mdash;</span>
            <span class="spot-count">0</span>
            <button class="clear-cell-btn" title="Clear map">&times;</button>
        </div>
        <div class="cell-info"></div>
        <div class="map"></div>
        <div class="cell-empty-hint"><span class="hint-icon">📡</span>${t('cellHint')}</div>
    `;
    const mapEl = el.querySelector('.map');
    const callLabel = el.querySelector('.call-label');
    const countEl = el.querySelector('.spot-count');
    const clearBtn = el.querySelector('.clear-cell-btn');
    const hint = el.querySelector('.cell-empty-hint');
    const info = el.querySelector('.cell-info');

    // Single world: tiles never repeat, panning is clamped to +/-180 and
    // zoomSnap 0 lets "fit whole world" land on an exact fractional zoom.
    const map = L.map(mapEl, {
        zoomControl: false,      // buttons removed; scroll-wheel zoom stays on
        scrollWheelZoom: true,
        attributionControl: true,
        zoomSnap: 0,
        maxBounds: [[-90, -180], [90, 180]],
        maxBoundsViscosity: 1.0
    });

    const tile = makeTileLayer();
    tile.addTo(map);

    addTerminator(map);

    const cell = {
        index, call: '', map, markers: [], count: 0,
        bandInfo: {},    // band -> {spot, addedAt}
        heat: {},        // band -> L.heatLayer
        activeBand: null,// band whose heat layer is visible
        bandPinned: false, // user clicked a chip: keep its band selected
        seen: new Set(), // dedup keys (live WS vs replayed history)
        tile,
        el, callLabel, countEl, clearBtn, hint, info
    };

    clearBtn.addEventListener('click', () => clearCell(cell));
    // Click a band chip to switch its heat layer (only CW/DIGI bands)
    info.addEventListener('click', (e) => {
        const chip = e.target.closest('.ci-chip');
        if (chip) selectBand(cell, chip.dataset.band);
    });

    return cell;
}

/* Day/night gray line (terminator) + night shading, like the RBN map.
 * Single world copy: the map is confined to +/-180 longitude. */
function addTerminator(map) {
    function compute() {
        const now = new Date();
        const start = Date.UTC(now.getUTCFullYear(), 0, 0);
        const doy = (now - start) / 86400000;
        // Solar declination (good approximation, degrees -> rad)
        const dec = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365.25) * Math.PI / 180;
        // Subsolar longitude from UTC hour
        const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
        const lonSun = 180 - utcH * 15;
        const base = [];
        // Terminator: tan(lat) = -cos(H)/tan(declination). Plain atan is
        // required (output stays within +/-90 deg); atan2 would emit
        // latitudes beyond the poles and corrupt the Mercator projection.
        let prevLat = 0;
        for (let lon = -180; lon <= 180; lon += 1) {
            const H = (lon - lonSun) * Math.PI / 180;
            let lat = Math.atan(-Math.cos(H) / Math.tan(dec)) * 180 / Math.PI;
            if (!isFinite(lat)) lat = prevLat; // singular only at exact equinox, H=+/-90
            base.push([lat, lon]);
            prevLat = lat;
        }
        // Night-side shading: terminator + the pole away from the sun
        const nightPole = dec > 0 ? -89.9 : 89.9;
        return {base, nightPole};
    }
    function draw() {
        if (map._termLayers) map._termLayers.forEach(l => map.removeLayer(l));
        const {base, nightPole} = compute();
        map._termLayers = [];
        for (const shift of [0]) {
            const line = base.map(p => [p[0], p[1] + shift]);
            // Ordering must follow the curve, then close via the pole cap
            const shade = line.concat([
                [nightPole, 180 + shift],
                [nightPole, -180 + shift]
            ]);
            map._termLayers.push(L.polygon(shade, {
                stroke: false, fillColor: '#000', fillOpacity: 0.28,
                interactive: false
            }).addTo(map));
            map._termLayers.push(L.polyline(line, {
                color: '#aaa', weight: 1.5, opacity: 0.8, interactive: false
            }).addTo(map));
        }
    }
    draw();
    map._termTimer = setInterval(draw, 60000);
}

function applyCallsigns(calls) {
    // The Config list is the source of truth; cells only display a
    // rotating window of it when there are more calls than visible cells.
    const next = (calls || []).map(c => (c || '').toUpperCase());
    const changed = next.length !== state.callsigns.length ||
                    next.some((c, i) => c !== state.callsigns[i]);
    state.callsigns = next;
    if (changed) {
        // Config actually changed: restart paging from page 1
        state.rotation.offset = 0;
        if (!rotationNeeded()) stopRotation();
        assignCalls();
    }
    updateRotateUI();
    if (typeof updateMonitorBtn === 'function') updateMonitorBtn();
}

/* ---------- Callsign rotation ----------
 * When more callsigns are monitored than the current layout can show,
 * the visible cells page through the call list (auto and/or manually). */
function visibleCells() {
    return state.cells.filter(c => c.el.style.display !== 'none');
}

function setCellCall(cell, call) {
    if (cell.call === call) return;
    if (cell.call) clearCell(cell);          // old call's spots no longer wanted
    cell.call = call;
    cell.callLabel.textContent = call || '\u2014';
    cell.hint.style.display = call ? 'none' : '';
    // Reset to the shared whole-world view so the previous call's
    // manual zoom/pan never lingers on this cell.
    fitWorld(cell.map);
    if (call && state.monitoring) replayCellHistory(cell);
}

/* Assign configured calls to the currently visible cells, shifted by the
 * rotation offset. Hidden cells always show nothing. */
function assignCalls() {
    const calls = state.callsigns.filter(Boolean);
    const n = calls.length;
    visibleCells().forEach((cell, k) => {
        // Fewer calls than cells: leave the extra cells blank (no wraparound)
        setCellCall(cell, k < n ? calls[(k + state.rotation.offset) % n] : '');
    });
    state.cells.forEach(c => {
        if (c.el.style.display === 'none') setCellCall(c, '');
    });
}

function rotationPages() {
    const calls = state.callsigns.filter(Boolean).length;
    const vis = visibleCells().length || 1;
    return Math.max(1, Math.ceil(calls / vis));
}

function rotationNeeded() { return rotationPages() > 1; }

function rotateStep() {
    if (!rotationNeeded()) return;
    state.rotation.offset++;
    assignCalls();
    updateRotateUI();
}

function startRotation() {
    if (!rotationNeeded() || state.rotation.running) return;
    state.rotation.running = true;
    state.rotation.timer = setInterval(rotateStep,
        Math.max(3, state.rotation.intervalSec) * 1000);
    updateRotateUI();
}

function stopRotation() {
    state.rotation.running = false;
    clearInterval(state.rotation.timer);
    state.rotation.timer = null;
}

function updateRotateUI() {
    const btn = $('#btnRotate');
    if (!btn) return;
    const pages = rotationPages();
    const need = pages > 1;
    btn.disabled = !need;
    $('#btnRotateNext').disabled = !need;
    btn.classList.toggle('running', state.rotation.running);
    btn.textContent = state.rotation.running ? t('stopRot') : t('startRot');
    $('#rotPage').textContent = need
        ? ((state.rotation.offset % pages) + 1) + '/' + pages
        : '';
}

function syncCallsigns() {
    const calls = state.cells.map(c => c.call);
    fetch('/api/callsigns', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(calls.filter(Boolean))
    }).catch(() => showToast(t('saveFail')));
}

function clearCell(cell) {
    cell.markers.forEach(m => {
        clearTimeout(m._ttl);
        (m.layers || [m]).forEach(l => cell.map.removeLayer(l));
    });
    cell.markers = [];
    cell.count = 0;
    cell.countEl.textContent = '0';
    cell.countEl.classList.remove('has-spots');
    cell.info.innerHTML = '';
    cell.bandInfo = {};
    Object.values(cell.heat).forEach(l => cell.map.removeLayer(l));
    cell.heat = {};
    cell.activeBand = null;
    cell.bandPinned = false;
    cell.seen.clear();
    clearTimeout(cell._fitTimer);
    if (cell.map) fitWorld(cell.map);  // back to the world-cover view
}

/* Minimum zoom = the level at which the world map COVERS the whole cell
 * (getBoundsZoom with inside=true): the map always fills the window and
 * polar overflow is cropped instead of leaving letterboxed black edges.
 * Must be re-applied after every container resize (zoom depends on size). */
function setWorldMinZoom(map) {
    // getBoundsZoom() floors its result at the CURRENT minZoom, so the floor
    // must be cleared first: otherwise the minimum zoom can only ever grow
    // and stays stuck at a larger cell's value after switching to a denser
    // layout (smaller cells), which breaks the marker auto-fit there.
    map.setMinZoom(0);
    map.setMinZoom(map.getBoundsZoom(WORLD_BOUNDS, true));
    if (map.getZoom() !== undefined && map.getZoom() < map.getMinZoom()) {
        map.setZoom(map.getMinZoom());
    }
}

/* World-cover view: the complete world map filling the cell exactly
 * (no black bars). Used for empty cells and as the auto-fit floor. */
function fitWorld(map) {
    setWorldMinZoom(map);
    map.setView([0, 0], map.getMinZoom(), {animate: false});
}

/* Auto-fit: zoom in as far as possible while every marker of the cell is
 * still visible. The zoom never drops below the world-cover minimum, so the
 * map always fills the window and black bars can never appear. */
function fitCellView(cell) {
    const map = cell.map;
    if (!map) return;
    setWorldMinZoom(map);
    const pts = [];
    cell.markers.forEach(g => {
        const s = g._spot;
        if (s.lat !== null && s.lat !== undefined &&
            s.lon !== null && s.lon !== undefined) pts.push([s.lat, s.lon]);
        if (s.dx_lat !== null && s.dx_lat !== undefined &&
            s.dx_lon !== null && s.dx_lon !== undefined) pts.push([s.dx_lat, s.dx_lon]);
    });
    if (!pts.length) {
        map.setView([0, 0], map.getMinZoom(), {animate: false});
        return;
    }
    const zb = L.latLngBounds(pts).pad(0.08);
    const z = Math.min(Math.max(map.getBoundsZoom(zb), map.getMinZoom()),
        AUTO_FIT_MAX_ZOOM);
    map.setView(zb.getCenter(), z, {animate: false});
}

/* Debounced re-fit (marker add/remove bursts, e.g. history replay). */
function scheduleFit(cell) {
    clearTimeout(cell._fitTimer);
    cell._fitTimer = setTimeout(() => fitCellView(cell), 150);
}

/* ---------- Heat maps (CW / DIGI only, weighted by SNR) ---------- */
function spotHeatKey(s) {
    return (s.spot_id !== null && s.spot_id !== undefined)
        ? 'id' + s.spot_id
        : [s.de, s.freq, s.timestamp].join('|');
}

function isHeatSpot(s) {
    return (s.mode === 'CW' || s.mode === 'DIGI') &&
           typeof s.snr === 'number' && isFinite(s.snr) &&
           s.lat !== null && s.lat !== undefined &&
           s.lon !== null && s.lon !== undefined;
}

/* band -> number of alive heat-eligible markers */
function heatCounts(cell) {
    const counts = {};
    cell.markers.forEach(g => {
        const s = g._spot;
        if (isHeatSpot(s)) {
            const band = s.band || '?';
            counts[band] = (counts[band] || 0) + 1;
        }
    });
    return counts;
}

/* SNR -> heat intensity: -25 dB -> ~0, +15 dB -> 1 */
function heatWeight(snr) {
    return Math.max(0.1, Math.min(1, (snr + 25) / 40));
}

function updateHeat(cell, band, now = Date.now()) {
    // Heat intensity follows the marker fade: a spot's contribution weakens
    // linearly with its remaining lifetime, just like its dots/link lines.
    const points = [];
    cell.markers.forEach(g => {
        const s = g._spot;
        if ((s.band || '?') !== band || !isHeatSpot(s)) return;
        const total = g._dieAt - g._bornAt;
        const op = total > 0 ? Math.max(0, Math.min(1, (g._dieAt - now) / total)) : 1;
        points.push([s.lat, s.lon, heatWeight(s.snr) * op]);
    });

    let layer = cell.heat[band];
    if (!points.length && !layer) return;
    if (!layer) {
        layer = L.heatLayer([], {
            radius: 38, blur: 28, minOpacity: 0.3, maxZoom: 7,
            // blue(cold/weak) -> green -> yellow -> red(hot/strong)
            gradient: {0.2: '#2b4bff', 0.4: '#00e5ff', 0.6: '#2ecc71',
                       0.75: '#f1c40f', 0.9: '#e67e22', 1.0: '#e74c3c'}
        });
        cell.heat[band] = layer;
    }
    layer.setLatLngs(points);

    const show = cell.activeBand === band && points.length > 0;
    const onMap = cell.map.hasLayer(layer);
    if (show && !onMap) cell.map.addLayer(layer);
    if (!show && onMap) cell.map.removeLayer(layer);
}

/* Pick / maintain the visible heat band.
 * Default: the band with the most live heat spots. A chip click pins it. */
function refreshActiveBand(cell) {
    const counts = heatCounts(cell);
    const bands = Object.keys(counts);

    if (cell.activeBand && !counts[cell.activeBand]) {
        // Pinned/default band expired -> release and re-choose
        cell.activeBand = null;
        cell.bandPinned = false;
    }
    if (!cell.activeBand && bands.length) {
        cell.activeBand = bands.reduce(
            (best, b) => counts[b] > counts[best] ? b : best, bands[0]);
    } else if (!cell.bandPinned && cell.activeBand) {
        // Auto mode: follow whichever band currently has the most reports
        const best = bands.reduce(
            (b2, b) => counts[b] > counts[b2] ? b : b2, cell.activeBand);
        cell.activeBand = best;
    }

    new Set([...Object.keys(cell.heat), ...bands])
        .forEach(b => updateHeat(cell, b));
}

function selectBand(cell, band) {
    if (heatCounts(cell)[band] === undefined) return; // no heat for this band
    cell.activeBand = band;
    cell.bandPinned = true;
    Object.keys(cell.heat).forEach(b => updateHeat(cell, b));
    renderCellInfo(cell);
}

/* ---------- Markers ---------- */
function dotIcon(color, size) {
    return L.divIcon({
        className: 'fresh-marker',
        html: `<div style="
            width:${size}px;height:${size}px;border-radius:50%;
            background:${color};border:2px solid #fff;
            box-shadow:0 0 6px ${color};"></div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

/* Great-circle path between two points, sampled into [lat, lon] pairs.
 * Longitudes are unwrapped so consecutive samples never jump across the
 * antimeridian. */
function greatCirclePoints(lat1, lon1, lat2, lon2, samples = 64) {
    const r = d => d * Math.PI / 180;
    const deg = x => x * 180 / Math.PI;
    const f1 = r(lat1), l1 = r(lon1), f2 = r(lat2), l2 = r(lon2);
    const dist = 2 * Math.asin(Math.sqrt(
        Math.sin((f2 - f1) / 2) ** 2 +
        Math.cos(f1) * Math.cos(f2) * Math.sin((l2 - l1) / 2) ** 2
    ));
    if (dist < 1e-9) return [[lat1, lon1]];
    const sinD = Math.sin(dist);
    const pts = [];
    for (let i = 0; i <= samples; i++) {
        const f = i / samples;
        const A = Math.sin((1 - f) * dist) / sinD;
        const B = Math.sin(f * dist) / sinD;
        const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
        const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
        const z = A * Math.sin(f1) + B * Math.sin(f2);
        const lat = deg(Math.atan2(z, Math.sqrt(x * x + y * y)));
        let lon = deg(Math.atan2(y, x));
        if (pts.length) {
            const prev = pts[pts.length - 1][1];
            lon = prev + ((lon - prev + 540) % 360) - 180;
        }
        pts.push([lat, lon]);
    }
    return pts;
}

/* Great-circle path as drawable segments in canonical longitudes.
 * The unwrapped path is cut wherever it crosses the antimeridian and
 * each piece is shifted back into [-180, 180], so a path crossing the
 * date line exits one map edge and re-enters from the opposite edge.
 * Both endpoints therefore always sit on the same world copy as their
 * markers (which are placed at canonical longitudes). */
function greatCirclePaths(lat1, lon1, lat2, lon2, samples = 64) {
    const pts = greatCirclePoints(lat1, lon1, lat2, lon2, samples);
    const worldOf = lon => Math.floor((lon + 180) / 360);
    const segments = [];
    let copy = worldOf(pts[0][1]);
    let seg = [[pts[0][0], pts[0][1] - 360 * copy]];
    for (let i = 1; i < pts.length; i++) {
        const c = worldOf(pts[i][1]);
        if (c === copy) {
            seg.push([pts[i][0], pts[i][1] - 360 * copy]);
            continue;
        }
        // Crossing the boundary between the old and new world copy:
        // interpolate the crossing latitude and split the segment there.
        const [la, lo] = pts[i - 1];
        const [lb, ln] = pts[i];
        const boundary = c > copy ? 180 + 360 * copy : -180 + 360 * copy;
        const crossLat = la + (lb - la) * ((boundary - lo) / (ln - lo));
        seg.push([crossLat, boundary - 360 * copy]);   // close at the edge
        segments.push(seg);
        seg = [[crossLat, boundary - 360 * c]];        // re-enter from the other edge
        seg.push([pts[i][0], pts[i][1] - 360 * c]);
        copy = c;
    }
    segments.push(seg);
    return segments;
}

function addMarkerToCell(cell, spot, ttlMs) {
    const hasDe = spot.lat !== null && spot.lat !== undefined &&
                  spot.lon !== null && spot.lon !== undefined;
    const hasDx = spot.dx_lat !== null && spot.dx_lat !== undefined &&
                  spot.dx_lon !== null && spot.dx_lon !== undefined;
    if (!hasDe && !hasDx) return;

    // Deduplicate: replayed history and live WS can carry the same spot
    const key = spotHeatKey(spot);
    if (cell.seen.has(key)) return;
    cell.seen.add(key);

    const fullTtl = ttlForMode(spot.mode);
    if (ttlMs === undefined) ttlMs = fullTtl;
    const bandColor = bandColorOf(spot.band);
    const layers = [];

    // Green dot: monitored (DX) station
    if (hasDx) {
        const dxMarker = L.marker([spot.dx_lat, spot.dx_lon],
            {icon: dotIcon('#2ecc71', 14)}).addTo(cell.map);
        dxMarker.bindPopup(`<b>${spot.monitored_call || spot.spot_call}</b> (monitored)<br>` +
            `${spot.dx_lat.toFixed(4)}, ${spot.dx_lon.toFixed(4)}`);
        layers.push(dxMarker);
    }

    // Red dot: spotter (DE)
    if (hasDe) {
        const sigText = spot.signal ? `Signal: ${spot.signal}` :
                        spot.snr !== null && spot.snr !== undefined ? `SNR: ${spot.snr} dB` : '';
        const popup = `
            <b>${spot.de}</b> (spotter)<br>
            Freq: ${spot.freq} kHz ${spot.band ? '(' + spot.band + ')' : ''}<br>
            ${sigText}<br>
            Mode: ${spot.mode || '—'}<br>
            Distance: ${spot.distance_km} km (${spot.distance_miles} mi)<br>
            Time: ${formatTime(spot.timestamp)}<br>
            <i>${spot.comment || ''}</i>
        `;
        const deMarker = L.marker([spot.lat, spot.lon],
            {icon: dotIcon('#e74c3c', 12)}).addTo(cell.map);
        deMarker.bindPopup(popup);
        layers.push(deMarker);
    }

    // Link line: great-circle path between monitored station and spotter
    if (hasDe && hasDx) {
        for (const seg of greatCirclePaths(spot.dx_lat, spot.dx_lon, spot.lat, spot.lon)) {
            layers.push(L.polyline(seg,
                {color: bandColor, weight: 2, opacity: 0.85}
            ).addTo(cell.map));
        }
    }

    const group = {layers, _spot: spot, _addedAt: Date.now()};
    group._ttl = setTimeout(() => removeMarker(cell, group), ttlMs);
    // Effective lifespan (replayed spots are born already aged) — the fade
    // runs linearly from birth to death, regardless of when it was drawn.
    group._dieAt = Date.now() + ttlMs;
    group._bornAt = group._dieAt - fullTtl;
    applyMarkerFade(group, Date.now());

    cell.markers.push(group);
    cell.count++;
    cell.countEl.textContent = cell.count;
    cell.countEl.classList.add('has-spots');
    // For replayed spots ttlMs < full TTL; effective time keeps chip
    // expiry aligned to the spot's real timestamp.
    const effectiveNow = Date.now() - (fullTtl - ttlMs);

    // Info bar: one chip per band with the same TTL as markers
    cell.bandInfo[spot.band || '?'] = {spot, addedAt: effectiveNow};
    // Heat layers (CW/DIGI only); active band = most reports by default
    refreshActiveBand(cell);
    renderCellInfo(cell);
    scheduleFit(cell);   // keep every marker inside the view, max zoom

    // Remove old groups beyond a reasonable limit
    if (cell.markers.length > 500) {
        const old = cell.markers.shift();
        clearTimeout(old._ttl);
        old.layers.forEach(l => cell.map.removeLayer(l));
        refreshActiveBand(cell);
        renderCellInfo(cell);
    }
}

function removeMarker(cell, group) {
    const i = cell.markers.indexOf(group);
    if (i >= 0) cell.markers.splice(i, 1);
    group.layers.forEach(l => cell.map.removeLayer(l));
    refreshActiveBand(cell);
    renderCellInfo(cell);
    scheduleFit(cell);   // remaining markers may allow a tighter view
}

/* Fade a marker group with age: opacity 1 at birth, 0 at TTL expiry.
 * Dots fade via the icon element, link lines via their stroke opacity. */
function applyMarkerFade(group, now) {
    const total = group._dieAt - group._bornAt;
    if (total <= 0) return;
    const op = Math.max(0, Math.min(1, (group._dieAt - now) / total));
    group.layers.forEach(l => {
        if (l instanceof L.Polyline) {
            l.setStyle({opacity: 0.85 * op});
        } else {
            const el = l.getElement && l.getElement();
            if (el) el.style.opacity = op;
        }
    });
}

/* ---------- WebSocket ---------- */
function connectWS() {
    setConnState('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    try {
        state.ws = new WebSocket(url);
    } catch (e) {
        setConnState('disconnected');
        return;
    }

    state.ws.onopen = () => {
        setConnState('connected');
        syncMonitoring();   // re-sync after a server restart / reconnect
    };
    state.ws.onclose = () => {
        setConnState('disconnected');
        setTimeout(connectWS, 3000);
    };
    state.ws.onerror = () => { /* close will fire */ };

    state.ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); }
        catch (e) { return; }
        // N1MM station messages carry a type; spot messages do not.
        switch (msg.type) {
            case 'radio': updateStationRadio(msg); break;
            case 'score': updateStationScore(msg); break;
            case 'qso': handleQso(msg); break;
            case 'qsoDelete': handleQsoDelete(msg); break;
            default: handleSpot(msg);
        }
    };
}

function handleSpot(spot) {
    if (!state.monitoring) return; // nothing is rendered until monitoring starts
    state.totalSpots++;
    $('#spotCount').textContent = t('spotsN')(state.totalSpots);
    // Find the cell monitoring this call
    const call = (spot.monitored_call || spot.call || '').toUpperCase();
    const cell = state.cells.find(c => c.call && c.call.toUpperCase() === call);
    if (cell) {
        addMarkerToCell(cell, spot);
        // Records panel is docked and always visible: refresh it live
        const sel = $('#recordCallSelect');
        if (sel.value === call || sel.value === '') refreshRecords();
    }
    showSpotAlert(spot, call);
}

/* ---------- New-spot alert on the QSO map ---------- */
/* Exactly one alert element: when a spot arrives while the alert is still
 * visible, its content is replaced and the dismiss timer restarts, so
 * alerts can never stack. Toggle in Settings > QSO Map. */
const SPOT_ALERT_MS = 8000;
let spotAlertTimer = null;

/* Per-callsign last spot (band + frequency), used by the voice alert to
 * decide between "new spot", "change band" and "new frequency". */
const lastSpotByCall = new Map();
const VOICE_LANGS = {
    zh: 'zh-CN', en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES',
    pt: 'pt-PT', ru: 'ru-RU', it: 'it-IT', ar: 'ar-SA', ko: 'ko-KR', ja: 'ja-JP'
};

/* ICAO/NATO phonetic alphabet: callsigns are spelled out letter by letter
 * so the TTS engine never reads "BG5WKP" as one ambiguous word. */
const ICAO_ALPHABET = {
    A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot',
    G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima',
    M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
    S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey',
    X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
    '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four',
    '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine'
};

function spellCall(call) {
    return String(call || '').toUpperCase().split('').map(ch => {
        if (ICAO_ALPHABET[ch]) return ICAO_ALPHABET[ch];
        if (ch === '/') return 'slash';
        return ''; // separators and punctuation are not spoken
    }).filter(Boolean).join(' ');
}

/* Web Speech API: the newest announcement always wins (cancel + speak), so
 * alerts can never queue up and overlap each other. */
function speakAlert(text) {
    if (!text || !('speechSynthesis' in window)) return;
    try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = VOICE_LANGS[settings.lang] || 'en-US';
        u.rate = 1.05;
        u.volume = 1;
        speechSynthesis.speak(u);
    } catch (e) { /* speech unavailable: stay silent */ }
}

function hideSpotAlert() {
    clearTimeout(spotAlertTimer);
    spotAlertTimer = null;
    $('#spotAlert').classList.add('hidden');
}

/* Also stop any pending announcement when the alert is dismissed. */
function hideSpotAlertAndVoice() {
    hideSpotAlert();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function showSpotAlert(spot, call) {
    if (qsoState.view !== 'qso' || !settings.qsoSpotAlert) return;
    const box = $('#spotAlert');
    $('#saCall').textContent = (call || spot.call || '—');
    $('#saBand').textContent = spot.band || '';
    $('#saMode').textContent = spot.mode || '';
    $('#saFreq').textContent = spot.freq ? spot.freq + ' kHz' : '';
    $('#saDe').textContent = spot.de ? 'DE ' + spot.de : '';
    $('#saSnr').textContent = spot.snr !== null && spot.snr !== undefined
        ? 'SNR ' + spot.snr + ' dB' : (spot.signal || '');
    const ts = new Date(spot.timestamp);
    $('#saTime').textContent = isNaN(ts) ? '' : timeAgo(ts);
    box.style.borderLeftColor = bandColorOf(spot.band);
    // restart the slide-in animation even when reusing a visible alert
    box.classList.remove('alert-in');
    box.classList.remove('hidden');
    void box.offsetWidth;
    box.classList.add('alert-in');

    // Voice alert: first report of a call -> "new spot"; a different band
    // -> "change band" (and "new frequency" is suppressed); same band but
    // another frequency -> "new frequency".
    const prev = lastSpotByCall.get(call);
    const curFreq = Number(spot.freq);
    let phrase = t('voiceNewSpot');
    if (prev) {
        if (prev.band && spot.band && prev.band !== spot.band) {
            phrase = t('voiceChangeBand');
        } else if (prev.freq !== curFreq) {
            phrase = t('voiceNewFreq');
        }
    }
    lastSpotByCall.set(call, { band: spot.band, freq: curFreq });
    if (settings.qsoVoiceAlert) {
        speakAlert(String(phrase).replace(/\{call\}/g, spellCall(call)));
    }

    clearTimeout(spotAlertTimer);
    spotAlertTimer = setTimeout(hideSpotAlert, SPOT_ALERT_MS);
}

/* ---------- Monitoring start/stop + post-refresh recovery ---------- */
function hasAnyCallsign() {
    return state.callsigns.some(Boolean);
}

function updateMonitorBtn() {
    const btn = $('#btnMonitor');
    btn.classList.toggle('running', state.monitoring);
    btn.textContent = state.monitoring ? t('stopMon') : t('startMon');
    btn.disabled = !state.monitoring && !hasAnyCallsign();
    btn.title = hasAnyCallsign() || state.monitoring ? '' : t('needCall');
}

/* Tell the backend whether to accept spots; the poll chains and the
 * PSKR feed are gated on this flag (recording sessions keep it open). */
function syncMonitoring() {
    fetch('/api/monitoring', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({on: state.monitoring})
    }).catch(() => {});
}

async function setMonitoring(on) {
    if (on && !hasAnyCallsign()) return;
    // Stopping: offer to wipe everything; Cancel keeps the frozen display.
    if (!on && state.cells.some(c => c.markers.length)) {
        const ok = await showConfirm(t('askClearMarks'), {title: t('stopMon')});
        if (ok) state.cells.forEach(clearCell);
    }
    state.monitoring = on;
    localStorage.setItem('dxcompass-monitoring', on ? '1' : '0');
    syncMonitoring();   // backend starts/stops accepting spots too
    updateMonitorBtn();
    if (on) {
        replayHistory();
    }
}

/* Reload spots from the last TTL window so a browser refresh (or a
 * rotation page flip) does not wipe markers, band chips and heat layers. */
async function replayCellHistory(cell) {
    const call = cell.call;
    if (!call) return;
    let rows = [];
    try {
        rows = await fetch(`/api/spots?call=${encodeURIComponent(call)}&limit=${HISTORY_LIMIT}`)
            .then(r => r.json());
    } catch (e) { return; }
    // Rotated away or monitoring stopped while the fetch was in flight
    if (cell.call !== call || !state.monitoring) return;
    const now = Date.now();
    // API returns newest first; replay oldest first for a stable display.
    // Each spot uses the survival time configured for its own mode.
    rows.reverse().forEach(r => {
        const ts = new Date(r.timestamp).getTime();
        if (isNaN(ts)) return;
        const ttl = ttlForMode(r.mode);
        if (ts < now - ttl) return;
        addMarkerToCell(cell, r, ttl - (now - ts));
    });
}

async function replayHistory() {
    for (const cell of visibleCells()) {
        if (!cell.call || !state.monitoring) continue;
        await replayCellHistory(cell);
    }
}

/* ---------- Records ---------- */
function populateCallSelect() {
    const sel = $('#recordCallSelect');
    const current = sel.value;
    sel.innerHTML = '<option value="">' + t('allCalls') + '</option>';
    state.callsigns.filter(Boolean).forEach(call => {
        const opt = document.createElement('option');
        opt.value = call;
        opt.textContent = call;
        sel.appendChild(opt);
    });
    sel.value = current;
}

function recHeadHtml(rec) {
    return t(rec ? 'headRec' : 'headAll').map(h => `<th>${h}</th>`).join('');
}

function refreshRecords() {
    const call = $('#recordCallSelect').value;
    const rec = state.recView === 'rec';
    const base = rec ? '/api/recording/spots' : '/api/spots';
    const url = call ? `${base}?call=${encodeURIComponent(call)}` : base;
    $('#recordsHead').innerHTML = recHeadHtml(rec);
    fetch(url).then(r => r.json()).then(rows => {
        const body = $('#recordsBody');
        body.innerHTML = '';
        rows.forEach(r => {
            const tr = document.createElement('tr');
            if (rec) {
                tr.innerHTML = `
                    <td>${r.date || ''}</td>
                    <td>${r.time || ''}</td>
                    <td>${r.call || ''}</td>
                    <td>${r.de}</td>
                    <td>${r.band || ''}</td>
                    <td>${r.freq || ''}</td>
                    <td>${modeBadge(r.mode)}</td>
                    <td>${r.detail || ''}</td>
                    <td class="${snrClass(r)}">${r.snr !== null && r.snr !== undefined ? r.snr : ''}</td>
                    <td>${r.distance_km || ''}</td>
                    <td title="${r.comment || ''}">${(r.comment || '').substring(0, 30)}</td>
                `;
            } else {
                tr.innerHTML = `
                    <td>${formatTime(r.timestamp)}</td>
                    <td>${r.monitored_call}</td>
                    <td>${r.de}</td>
                    <td>${r.freq || ''}</td>
                    <td>${modeBadge(r.mode)}</td>
                    <td class="${signalClass(r)}">${r.signal || ''}</td>
                    <td class="${snrClass(r)}">${r.snr !== null && r.snr !== undefined ? r.snr : ''}</td>
                    <td>${r.distance_km || ''}</td>
                    <td title="${r.comment || ''}">${(r.comment || '').substring(0, 30)}</td>
                `;
            }
            body.appendChild(tr);
        });
        $('#recordsFooter').textContent = t('recordsN')(rows.length);
    }).catch(() => showToast(t('loadFail')));
}

/* ---------- Recording (timed / manual capture into recording_spots) ---------- */
// datetime-local value ('YYYY-MM-DDTHH:mm') <-> backend schedule form ('M-D H:mm', UTC this year)
function dtLocalToMdHm(v) {
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    return `${parseInt(m[2], 10)}-${parseInt(m[3], 10)} ${parseInt(m[4], 10)}:${m[5]}`;
}
function mdHmToDtLocal(s) {
    const m = String(s || '').match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/);
    if (!m) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${new Date().getUTCFullYear()}-${pad(m[1])}-${pad(m[2])}T${pad(m[3])}:${pad(m[4])}`;
}

function refreshRecStatus(syncInputs) {
    fetch('/api/recording').then(r => r.json()).then(rec => {
        state.recStatus = rec;
        const dot = $('#recDot');
        const txt = $('#recStatus');
        const btn = $('#btnRecToggle');
        if (rec.active) {
            dot.className = 'rec-dot active';
            const since = rec.startedAt ? rec.startedAt.substring(5, 16).replace('T', ' ') + 'Z' : '';
            txt.textContent = (rec.manual ? t('recManual') : t('recSched')) +
                (since ? ' ' + t('since') + ' ' + since : '');
            btn.textContent = t('stopRec');
            btn.classList.add('recording');
        } else {
            dot.className = rec.schedule ? 'rec-dot scheduled' : 'rec-dot idle';
            txt.textContent = rec.schedule ?
                `${t('scheduled')}: ${rec.schedule.start} → ${rec.schedule.end} UTC` : t('notRecording');
            btn.textContent = t('record');
            btn.classList.remove('recording');
        }
        // Fill the pickers from the stored schedule only when explicitly
        // asked (panel open / after Set/Clear) so the 15s poll never
        // clobbers a value the user is editing.
        if (syncInputs && rec.schedule) {
            $('#recStart').value = mdHmToDtLocal(rec.schedule.start);
            $('#recEnd').value = mdHmToDtLocal(rec.schedule.end);
        }
    }).catch(() => {});
}

function recAction(body) {
    return fetch('/api/recording', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    }).then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'request failed');
        return j;
    });
}

function toggleRecording() {
    const stopping = state.recStatus && state.recStatus.active;
    recAction({action: stopping ? 'stop' : 'start'}).then(() => {
        showToast(stopping ? t('recStopped') : t('recStarted'));
        refreshRecStatus();
        if (state.recView === 'rec') refreshRecords();
    }).catch(e => showToast('Recording: ' + e.message));
}

function setRecSchedule() {
    const start = dtLocalToMdHm($('#recStart').value);
    const end = dtLocalToMdHm($('#recEnd').value);
    if (!start || !end) { showToast(t('pickDt')); return; }
    recAction({action: 'schedule', start, end}).then(() => {
        showToast(t('schedOk'));
        refreshRecStatus(true);
    }).catch(e => showToast('Schedule: ' + e.message));
}

function clearRecSchedule() {
    recAction({action: 'unschedule'}).then(() => {
        $('#recStart').value = '';
        $('#recEnd').value = '';
        showToast(t('schedCleared'));
        refreshRecStatus(true);
    }).catch(e => showToast('Schedule: ' + e.message));
}

function signalClass(r) {
    if (!r.signal) return '';
    const n = parseInt(r.signal.charAt(1));
    if (n >= 9) return 'signal-strong';
    if (n >= 7) return 'signal-mid';
    return 'signal-weak';
}
function snrClass(r) {
    if (r.snr === null || r.snr === undefined) return '';
    if (r.snr >= 0) return 'signal-strong';
    if (r.snr >= -10) return 'signal-mid';
    return 'signal-weak';
}

/* Export CSV. forceRec=true always exports the recorded-session data
 * (Download button); otherwise the export follows the current view. */
function exportCsv(forceRec) {
    const call = $('#recordCallSelect').value;
    const rec = forceRec === true || (forceRec === undefined && state.recView === 'rec');
    const base = rec ? '/api/recording/spots' : '/api/spots';
    const url = call ? `${base}?call=${encodeURIComponent(call)}&limit=10000` : `${base}?limit=10000`;
    const headers = rec ?
        ['date','time','call','de','band','freq','mode','detail','snr','signal','distance_km','comment'] :
        ['timestamp','monitored_call','de','freq','spot_call','mode','signal','snr','distance_km','distance_miles','comment'];
    fetch(url).then(r => r.json()).then(rows => {
        const csv = [headers.join(',')].concat(rows.map(r =>
            headers.map(h => {
                let v = r[h];
                if (v === null || v === undefined) v = '';
                v = String(v).replace(/"/g, '""');
                return `"${v}"`;
            }).join(',')
        )).join('\n');
        const blob = new Blob([csv], {type: 'text/csv'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dxcompass-${rec ? 'recording' : 'spots'}-${call || 'all'}-${Date.now()}.csv`;
        a.click();
        showToast(t('csvOk'));
    });
}

/* ---------- Global settings UI (language / TTL / band colors) ---------- */
/* Push the current language into every static label and re-render the
 * dynamic ones (buttons, table headers, statuses). */
function applyLang() {
    document.documentElement.lang = settings.lang;
    // Arabic text is right-to-left by Unicode bidi, but the dashboard layout
    // must stay LTR: mirroring the whole page breaks maps, panels and toolbar.
    document.documentElement.dir = 'ltr';
    document.body.classList.toggle('lang-ar', settings.lang === 'ar');
    const bc = $('#btnConfig');
    bc.textContent = t('settings');
    bc.title = t('settings');
    $('#recordsPanel .panel-title').textContent = t('records');
    $('#btnRefreshRecords').textContent = t('refresh');
    $('#btnExportCsv').textContent = t('exportCsv');
    $('#btnClearDb').textContent = t('clearDb');
    $('#btnRecSched').textContent = t('schedule');
    $('#btnRecDownload').textContent = t('download');
    $('#btnRecSchedSet').textContent = t('set');
    $('#btnRecSchedClear').textContent = t('clear');
    $('.rec-tz').textContent = t('recTz');
    $('.rec-tab[data-view="all"]').textContent = t('tabAll');
    $('.rec-tab[data-view="rec"]').textContent = t('tabRec');
    $('#configPanel .panel-title').textContent = t('settings');
    $('#cfgSectionTitle').textContent = t('cfgSection');
    $('#langLabel').textContent = t('langLabel');
    $('#tilesLabel').textContent = t('mapTiles');
    $('#ttlTitle').textContent = t('ttlTitle');
    $('#bandTitle').textContent = t('bandTitle');
    $('#gridLabel').textContent = t('myGrid');
    $('#qrzUserLabel').textContent = t('qrzUser');
    $('#qrzPassLabel').textContent = t('qrzPass');
    $('#tabGlobal').textContent = t('setGlobal');
    $('#tabSpot').textContent = t('setSpot');
    $('#tabQso').textContent = t('setQso');
    $('#spotSectionTitle').textContent = t('setSpot');
    $('#qsoSectionTitle').textContent = t('setQso');
    $('#catLabel').textContent = t('contestCat');
    $('#qsoAutoFitLabel').textContent = t('qsoAutoFit');
    $('#qsoLinesLabel').textContent = t('qsoLines');
    $('#qsoDoubleLabel').textContent = t('qsoMaxMarkers');
    $('#qsoSpotAlertLabel').textContent = t('qsoSpotAlert');
    $('#qsoVoiceLabel').textContent = t('qsoVoice');
    $('#resetAllLabel').textContent = t('resetAll');
    $('#btnResetAll').textContent = t('resetAll');
    $('#qtLFreq').textContent = t('lblFreq');
    $('#qtLCall').textContent = t('lblCall');
    $('#qtLRst').textContent = t('lblRst');
    $('#qtLExch').textContent = t('lblExch');
    $('#qtLBand').textContent = t('lblBand');
    $('#qtLMode').textContent = t('lblMode');
    $('#qtLOp').textContent = t('lblOp');
    $('#qtLAge').textContent = t('lblAge');
    $('#btnSpotView').textContent = t('spotView');
    $('#btnQsoView').textContent = t('qsoView');
    $('#qsoPanelTitle').textContent = t('stPanel');
    $('#qLastTitle').textContent = t('stLastQso');
    $('#qRateTitle').textContent = t('qsoRate');
    $('#qLQsos').textContent = t('stQsos');
    $('#qLMults').textContent = t('stMults');
    $('#qLPoints').textContent = t('stPoints');
    $('#qLScore').textContent = t('stScore');
    $('#qTx').textContent = t('stTx');
    renderLastQso();
    renderQsoPanel();
    $('#btnSaveCfg').textContent = t('save');
    $('#cfgHint').innerHTML = t('cfgHint');
    $('#btnRotateNext').title = t('nextPage');
    $('#rotSec').title = t('rotSecTitle');
    state.cells.forEach(c => {
        c.hint.innerHTML = '<span class="hint-icon">📡</span>' + t('cellHint');
    });
    setConnState(state.connState);
    populateCallSelect();
    updateMonitorBtn();
    updateRotateUI();
    refreshRecStatus();
    refreshRecords();
    state.cells.forEach(c => {
        if (Object.keys(c.bandInfo).length) renderCellInfo(c);
    });
}

/* Re-apply customized band colors to existing link lines and info chips. */
function applyBandColors() {
    state.cells.forEach(c => {
        c.markers.forEach(g => {
            const col = bandColorOf(g._spot.band);
            g.layers.forEach(l => {
                if (l instanceof L.Polyline) l.setStyle({color: col});
            });
        });
        if (Object.keys(c.bandInfo).length) renderCellInfo(c);
    });
}

function buildBandColorInputs() {
    const wrap = $('#bandColors');
    wrap.innerHTML = '';
    Object.keys(DEFAULT_BAND_COLORS).forEach(band => {
        const item = document.createElement('div');
        item.className = 'bc-item';
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = settings.bandColors[band];
        inp.title = band;
        inp.addEventListener('input', () => {
            settings.bandColors[band] = inp.value;
            saveSettings();
            applyBandColors();
        });
        const lbl = document.createElement('span');
        lbl.textContent = band;
        item.appendChild(inp);
        item.appendChild(lbl);
        wrap.appendChild(item);
    });
}

/* ---------- Own station (N1MM+ UDP broadcasts) ---------- */
/* QSO map: permanent markers (no fade/TTL), home grid from Settings,
 * one band-colored dot per QSO with a great-circle link back home. */
const qsoState = {
    view: 'spots',        // 'spots' | 'qso'
    map: null, tile: null, homeLayer: null,
    qsos: [],             // rendered QSO objects (only ones with coordinates)
    byId: new Map(),      // n1mmId -> {layers:[...]} (contactreplace/contactdelete)
    allTs: new Map(),     // n1mmId -> QSO time (ms) for every QSO, map or not
    radio: null, score: null, lastQso: null,
    radios: {}            // radioNr -> RadioInfo (SO2R / multi-op support)
};

/* Maidenhead 4/6-char grid -> center [lat, lon]. Null when empty/invalid. */
function gridToLatLon(grid) {
    const g = (grid || '').toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
    // 4-char: field 20°x10° + square 2°x1°, centered (+1° lon, +0.5° lat)
    let lon = (g.charCodeAt(0) - 65) * 20 - 180 + parseInt(g[2], 10) * 2 + 1;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90 + parseInt(g[3], 10) + 0.5;
    if (g.length === 6) {
        // re-center from square center to subsquare (5'x2.5') center
        lon += (g.charCodeAt(4) - 65) * (2 / 24) - 1 + (1 / 24);
        lat += (g.charCodeAt(5) - 65) * (1 / 24) - 0.5 + (1 / 48);
    }
    return [lat, lon];
}

function initQsoMap() {
    const el = document.createElement('div');
    el.className = 'qso-map';
    $('#qsoView').appendChild(el);
    const map = L.map(el, {
        zoomControl: false, scrollWheelZoom: true, attributionControl: true,
        zoomSnap: 0, maxBounds: [[-90, -180], [90, 180]], maxBoundsViscosity: 1.0
    });
    qsoState.map = map;
    qsoState.tile = makeTileLayer().addTo(map);
    addTerminator(map);
    fitWorld(map);
    rebuildHome();
}

/* Home station marker from the configured Maidenhead grid. */
function rebuildHome() {
    if (!qsoState.map) return;
    if (qsoState.homeLayer) { qsoState.map.removeLayer(qsoState.homeLayer); qsoState.homeLayer = null; }
    const home = gridToLatLon(settings.grid);
    if (home) {
        qsoState.homeLayer = L.marker(home, {
            interactive: false,
            icon: L.divIcon({
                className: 'qso-home',
                html: '<span style="color:#00e5ff;font-size:16px;text-shadow:0 0 6px #00e5ff">✦</span>',
                iconSize: [16, 16], iconAnchor: [8, 8]
            })
        }).addTo(qsoState.map);
    }
}

/* Full-screen switch: spot grid (+ Records panel) <-> QSO map (+ QSO panel). */
function setViewMode(mode) {
    if (qsoState.view === mode) return;
    qsoState.view = mode;
    const isQso = mode === 'qso';
    $('#grid').classList.toggle('hidden', isQso);
    $('#qsoView').classList.toggle('hidden', !isQso);
    $('#recordsPanel').classList.toggle('hidden', isQso);
    $('#qsoPanel').classList.toggle('hidden', !isQso);
    const spotBtn = $('#btnSpotView'), qsoBtn = $('#btnQsoView');
    spotBtn.classList.toggle('active', !isQso);
    qsoBtn.classList.toggle('active', isQso);
    spotBtn.textContent = t('spotView');
    qsoBtn.textContent = t('qsoView');
    // Spot-only toolbar controls (layout, rotation, start monitoring) are
    // irrelevant on the QSO map, so they are hidden via a body class.
    document.body.classList.toggle('qso-mode', isQso);
    if (isQso) {
        qsoState.map.invalidateSize();
        fitQsoMap();
        renderQsoPanel();
    } else {
        hideSpotAlertAndVoice();
        visibleCells().forEach(c => { c.map.invalidateSize(); fitCellView(c); });
    }
}

/* QSO map auto-fit: same convention as cells - zoom in as far as all
 * markers (plus home) stay visible, never below the world-cover floor. */
function fitQsoMap() {
    const map = qsoState.map;
    if (!map) return;
    setWorldMinZoom(map);
    if (!settings.qsoAutoFit) return;
    const pts = [];
    qsoState.qsos.forEach(q => {
        if (q.lat !== null && q.lat !== undefined &&
            q.lon !== null && q.lon !== undefined) pts.push([q.lat, q.lon]);
    });
    const home = gridToLatLon(settings.grid);
    if (home) pts.push(home);
    if (!pts.length) {
        map.setView([0, 0], map.getMinZoom(), {animate: false});
        return;
    }
    const zb = L.latLngBounds(pts).pad(0.08);
    const z = Math.min(Math.max(map.getBoundsZoom(zb), map.getMinZoom()),
        AUTO_FIT_MAX_ZOOM);
    map.setView(zb.getCenter(), z, {animate: false});
}
function scheduleQsoFit() {
    if (qsoState.view !== 'qso') return;
    clearTimeout(qsoState._fitTimer);
    qsoState._fitTimer = setTimeout(fitQsoMap, 150);
}

function qsoTooltip(q) {
    const ts = new Date(q.ts);
    return [q.call, [q.band, q.mode].filter(Boolean).join(' '),
        isNaN(ts) ? '' : timeAgo(ts),
        q.isMult ? 'MULT' : ''].filter(Boolean).join(' · ');
}

function removeQsoMarker(n1mmId) {
    const e = qsoState.byId.get(n1mmId);
    if (!e || !qsoState.map) return;
    e.layers.forEach(l => qsoState.map.removeLayer(l));
    qsoState.byId.delete(n1mmId);
}

function addQsoMarker(q) {
    if (!qsoState.map) return;
    if (q.lat === null || q.lat === undefined ||
        q.lon === null || q.lon === undefined) return;
    removeQsoMarker(q.n1mmId); // contactreplace carries the same id
    const col = bandColorOf(q.band);
    const layers = [];
    const home = gridToLatLon(settings.grid);
    if (home && settings.qsoLines) {
        greatCirclePaths(home[0], home[1], q.lat, q.lon).forEach(seg => {
            layers.push(L.polyline(seg, {
                color: col, weight: 1.5, opacity: 0.55, interactive: false
            }).addTo(qsoState.map));
        });
    }
    const m = L.marker([q.lat, q.lon], {
        icon: L.divIcon({
            className: 'qso-dot-wrap',
            html: `<div class="qso-dot" style="background:${col}">` +
                (q.isMult ? '<span class="qso-mult-badge">M</span>' : '') + '</div>',
            iconSize: [12, 12], iconAnchor: [6, 6]
        })
    }).addTo(qsoState.map);
    m.bindTooltip(qsoTooltip(q), {direction: 'top'});
    layers.push(m);
    qsoState.byId.set(q.n1mmId, {layers});
    qsoState.qsos.push(q);
    while (qsoState.qsos.length > settings.qsoMax) {
        removeQsoMarker(qsoState.qsos.shift().n1mmId);
    }
    scheduleQsoFit();
}

/* Grid changed: home moved, so every link line must be redrawn. */
function rebuildQsoMap() {
    if (!qsoState.map) return;
    const qsos = qsoState.qsos.slice();
    qsoState.byId.forEach((_, id) => removeQsoMarker(id));
    qsoState.qsos = [];
    qsos.forEach(addQsoMarker);
    rebuildHome();
    fitQsoMap();
}

function handleQso(q) {
    qsoState.lastQso = q;
    if (q.n1mmId) qsoState.allTs.set(q.n1mmId, new Date(q.ts).getTime());
    renderLastQso();
    addQsoMarker(q);
    renderQsoPanel();
}

function handleQsoDelete(d) {
    removeQsoMarker(d.n1mmId);
    qsoState.allTs.delete(d.n1mmId);
    const i = qsoState.qsos.findIndex(q => q.n1mmId === d.n1mmId);
    if (i >= 0) qsoState.qsos.splice(i, 1);
    renderQsoPanel();
}

function renderLastQso() {
    const q = qsoState.lastQso;
    if (!q) return;
    const ts = new Date(q.ts);
    const info = [q.band, q.mode, isNaN(ts) ? '' : timeAgo(ts)]
        .filter(Boolean).join(' · ');
    $('#qLastCall').textContent = q.call || '—';
    $('#qLastInfo').textContent = info;
}

/* ---------- QSO side panel (shown instead of Records on the QSO map) ---------- */
const QSO_RATE_BUCKET_MS = 5 * 60 * 1000;   // 5 minutes per bar
const QSO_RATE_BUCKETS = 12;                // -> rolling 60 minutes

/* Rolling QSO rate chart: one bar per 5-minute bucket, oldest to newest.
 * Counts come from qsoState.allTs (every QSO, live or backfilled, whether
 * it has coordinates or not). */
function renderQsoRate() {
    const now = Date.now();
    const counts = new Array(QSO_RATE_BUCKETS).fill(0);
    let total = 0;
    qsoState.allTs.forEach(t => {
        if (isNaN(t) || t > now) return;
        const idx = QSO_RATE_BUCKETS - 1 - Math.floor((now - t) / QSO_RATE_BUCKET_MS);
        if (idx >= 0) {
            counts[idx]++;
            total++;
        }
    });
    const max = Math.max(1, ...counts);
    const chart = $('#qRateChart');
    chart.textContent = '';
    counts.forEach((n, i) => {
        const bar = document.createElement('div');
        bar.className = 'qso-rate-bar';
        bar.title = (QSO_RATE_BUCKETS - 1 - i) * 5 + '–' +
            (QSO_RATE_BUCKETS - i) * 5 + ' min: ' + n;
        const fill = document.createElement('div');
        fill.className = 'qso-rate-fill';
        fill.style.height = Math.max(n ? 6 : 1, (n / max) * 100) + '%';
        if (n) fill.classList.add('has-qso');
        bar.appendChild(fill);
        chart.appendChild(bar);
    });
    $('#qRateSum').textContent = total + ' QSO · ' + total + '/h';
}

/* Latest-QSO banner above the QSO map: RUN / S&P, frequency, DX call,
 * RST sent/received and exchange - layout parity with BY7WZ's dashboard.
 * The live RadioInfo stream decides RUN vs S&P; the rest is the newest QSO. */
function renderQsoTopbar() {
    const q = qsoState.lastQso, r = qsoState.radio;
    const run = r && typeof r.isRunning === 'boolean' ? r.isRunning : null;
    const badge = $('#qtRun');
    badge.textContent = run === null ? '—' : (run ? 'RUN' : 'S&P');
    badge.className = 'qt-run' + (run === null ? '' : (run ? ' is-run' : ' is-sp'));

    const f = q && typeof q.freqKhz === 'number' ? q.freqKhz
        : (r && typeof r.freqKhz === 'number' ? r.freqKhz : null);
    $('#qtFreq').textContent = f === null ? '--.--' : f.toFixed(2);
    $('#qtCall').textContent = (q && q.call) || '—';
    $('#qtRst').textContent = q ? (q.rstSnt || '--') + '/' + (q.rstRcv || '--') : '--/--';
    $('#qtExch').textContent = (q && q.exchange) || '—';
    $('#qtBand').textContent = (q && q.band) || '—';
    $('#qtMode').textContent = (q && q.mode) || (r && r.mode) || '—';
    const op = (q && q.operator) || (r && r.opCall) || '';
    $('#qtOp').textContent = settings.category + (op ? ' · ' + op : '');
    // SO2R / MS / MM: show each radio's frequency so both VFOs stay visible
    let radioTxt = '';
    if (settings.category !== 'SO1R') {
        const nr = r && r.radioNr ? r.radioNr : 1;
        radioTxt = [1, 2].map(i => {
            const ri = qsoState.radios[i] || (nr === i ? r : null);
            return ri && typeof ri.freqKhz === 'number'
                ? 'R' + i + ' ' + ri.freqKhz.toFixed(2) : '';
        }).filter(Boolean).join(' / ');
    }
    $('#qtRadios').textContent = radioTxt;
    updateQsoAge();
}

/* Elapsed time since the newest QSO as HH:MM:SS (ticks once per second). */
function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = n => String(n).padStart(2, '0');
    return p(Math.floor(s / 3600)) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
}
function updateQsoAge() {
    const q = qsoState.lastQso;
    const ts = q ? new Date(q.ts) : null;
    $('#qtAge').textContent = ts && !isNaN(ts) ? fmtElapsed(Date.now() - ts.getTime()) : '--:--:--';
}

/* Refresh the QSO panel after the bar was removed from the page. */
function renderQsoPanel() {
    renderQsoTopbar();
    const r = qsoState.radio, s = qsoState.score, q = qsoState.lastQso;
    if (r) {
        if (typeof r.freqKhz === 'number' && isFinite(r.freqKhz)) {
            $('#qFreq').textContent = r.freqKhz.toLocaleString('en-US',
                {minimumFractionDigits: 2, maximumFractionDigits: 2});
        }
        if (r.mode) $('#qMode').textContent = r.mode;
        $('#qTx').classList.toggle('hidden', !r.isTransmitting);
        $('#qOpCall').textContent = [r.opCall, r.radioName].filter(Boolean).join(' · ');
    }
    if (s) {
        $('#qQsos').textContent = s.qsos || 0;
        $('#qMults').textContent = s.mults || 0;
        $('#qPoints').textContent = s.points || 0;
        $('#qScore').textContent = s.score || 0;
    }
    if (q) {
        $('#qLastCall').textContent = q.call || '—';
        const ts = new Date(q.ts);
        $('#qLastInfo').textContent = [q.band, q.mode, q.freqKhz ?
            q.freqKhz.toFixed(2) : '', isNaN(ts) ? '' : timeAgo(ts)]
            .filter(Boolean).join(' · ');
    }
    renderQsoRate();
}

function updateStationRadio(r) {
    qsoState.radio = r;
    if (r.radioNr) qsoState.radios[r.radioNr] = r;
    renderQsoPanel();
}

function updateStationScore(s) {
    qsoState.score = s;
    renderQsoPanel();
}

/* DB row (qsos table) -> the qso object shape used by live WS messages. */
function dbRowToQso(r) {
    return {
        type: 'qso', n1mmId: r.n1mm_id, ts: r.timestamp, mycall: r.mycall,
        call: r.call, band: r.band, freqKhz: r.freq_khz, mode: r.mode,
        points: r.points, isMult: !!r.is_mult, lat: r.lat, lon: r.lon
    };
}

/* Backfill on load: last radio/score state + recent QSOs from the DB,
 * so a browser refresh does not wipe the QSO map or the QSO panel. */
async function loadStation() {
    try {
        const st = await fetch('/api/station/state').then(r => r.json());
        if (st.radio1) qsoState.radios[1] = st.radio1;
        if (st.radio2) qsoState.radios[2] = st.radio2;
        if (st.radio) updateStationRadio(st.radio);
        if (st.score) updateStationScore(st.score);
    } catch (e) { /* no station data yet */ }
    try {
        const rows = await fetch('/api/qsos?limit=500').then(r => r.json());
        if (Array.isArray(rows) && rows.length) {
            // rows come newest-first; replay oldest-first so the marker
            // list and the rate chart stay chronologically ordered
            rows.slice().reverse().forEach(r => {
                const q = dbRowToQso(r);
                qsoState.allTs.set(q.n1mmId, new Date(q.ts).getTime());
                if (q.lat !== null && q.lat !== undefined) addQsoMarker(q);
            });
            qsoState.lastQso = dbRowToQso(rows[0]);
            renderLastQso();
            renderQsoPanel();
        }
    } catch (e) { /* keep the waiting hint */ }
}

/* ---------- Config ---------- */
function openConfig() {
    $('#configPanel').classList.remove('hidden');
    loadConfig();
}
function closeConfig() { $('#configPanel').classList.add('hidden'); }

function loadConfig() {
    fetch('/api/callsigns').then(r => r.json()).then(calls => {
        if (Array.isArray(calls)) {
            applyCallsigns(calls);
            populateCallSelect();
            // Fill the Config inputs
            const inputs = document.querySelectorAll('.cfg-call');
            inputs.forEach((inp, i) => { inp.value = calls[i] || ''; });
            updateMonitorBtn();
            // Was monitoring before the refresh? Restore markers/chips/heat
            if (state.monitoring) replayHistory();
        }
    });
}

function saveConfig(e) {
    e.preventDefault();
    const calls = Array.from(document.querySelectorAll('.cfg-call'))
        .map(inp => inp.value.trim().toUpperCase());

    // Save callsigns (slot order matters)
    fetch('/api/callsigns', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(calls)
    }).then(r => r.json()).then(() => {
        applyCallsigns(calls);
        populateCallSelect();
        updateMonitorBtn();
        if (state.monitoring) replayHistory(); // backfill newly added slots
        showToast(t('saved'));
        closeConfig();
    }).catch(() => showToast(t('saveFail')));
}

/* ---------- Init ---------- */
function init() {
    // Layout buttons
    $all('.layout-btn').forEach(b => {
        b.addEventListener('click', () => setLayout(b.dataset.layout));
    });

    // Panel close buttons
    $all('.panel-close').forEach(b => {
        b.addEventListener('click', () => {
            document.getElementById(b.dataset.close).classList.add('hidden');
        });
    });

    $('#btnConfig').addEventListener('click', openConfig);
    $('#btnMonitor').addEventListener('click', () => setMonitoring(!state.monitoring));

    // Callsign rotation controls
    $('#btnRotate').addEventListener('click', () => {
        if (state.rotation.running) {
            stopRotation();
            updateRotateUI();
        } else {
            startRotation();
        }
    });
    // Manual page flip; also resets the auto timer so a scheduled flip
    // does not fire right after the manual one.
    $('#btnRotateNext').addEventListener('click', () => {
        rotateStep();
        if (state.rotation.running) {
            clearInterval(state.rotation.timer);
            state.rotation.timer = setInterval(rotateStep,
                Math.max(3, state.rotation.intervalSec) * 1000);
        }
    });
    const rotSecInput = $('#rotSec');
    rotSecInput.value = state.rotation.intervalSec;
    rotSecInput.addEventListener('change', () => {
        let v = parseInt(rotSecInput.value, 10);
        if (isNaN(v) || v < 3) v = 3;
        if (v > 600) v = 600;
        state.rotation.intervalSec = v;
        rotSecInput.value = v;
        localStorage.setItem('dxcompass-rot-sec', String(v));
        if (state.rotation.running) {
            clearInterval(state.rotation.timer);
            state.rotation.timer = setInterval(rotateStep, v * 1000);
        }
    });
    $('#btnRefreshRecords').addEventListener('click', refreshRecords);
    $('#btnExportCsv').addEventListener('click', () => exportCsv());
    $('#btnRecDownload').addEventListener('click', () => exportCsv(true));
    $('#recordCallSelect').addEventListener('change', refreshRecords);
    // Manual database clear (spots table only; recording_spots is kept)
    $('#btnClearDb').addEventListener('click', async () => {
        const ok = await showConfirm(t('askClearDb'), {
            title: t('clearDb'), okText: t('danger'), danger: true
        });
        if (!ok) return;
        try {
            const r = await fetch('/api/spots/clear', {method: 'POST'});
            if (!r.ok) throw new Error('HTTP ' + r.status);
            showToast(t('cleared'));
            refreshRecords();
        } catch (e) {
            showToast(t('clearFail'));
        }
    });
    // Global settings: language / per-mode marker TTL / band colors
    // (language options are built from LANGS so new locales need no HTML edit)
    const langSel = $('#setLang');
    langSel.innerHTML = LANGS.map(l =>
        `<option value="${l}">${LANG_NAMES[l]}</option>`).join('');
    langSel.value = settings.lang;
    $('#setLang').addEventListener('change', () => {
        settings.lang = $('#setLang').value;
        saveSettings();
        applyLang();
    });
    // Base map provider (options built from TILE_PROVIDERS, like the language selector)
    const tilesSel = $('#setTiles');
    tilesSel.innerHTML = Object.keys(TILE_PROVIDERS).map(k =>
        `<option value="${k}">${TILE_PROVIDERS[k].name}</option>`).join('');
    tilesSel.value = settings.tiles;
    tilesSel.addEventListener('change', () => setTileProvider(tilesSel.value));
    // One-click factory reset: every UI setting, the monitored callsigns and
    // all database tables (spots, qsos, recording_spots), then a reload.
    $('#btnResetAll').addEventListener('click', async () => {
        const ok = await showConfirm(t('resetConfirm'), {
            title: t('resetAll'), okText: t('danger'), danger: true
        });
        if (!ok) return;
        try {
            const [r1, r2] = await Promise.all([
                fetch('/api/reset', {method: 'POST'}),
                fetch('/api/callsigns', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: '[]'
                })
            ]);
            if (!r1.ok || !r2.ok) throw new Error('HTTP');
            ['dxcompass-settings', 'dxcompass-monitoring', 'dxcompass-rot-sec']
                .forEach(k => localStorage.removeItem(k));
            location.reload();
        } catch (e) {
            showToast(t('resetFail'));
        }
    });
    // Own-station Maidenhead grid (QSO map home marker + link lines)
    const gridInp = $('#setGrid');
    gridInp.value = settings.grid;
    gridInp.addEventListener('change', () => {
        const v = gridInp.value.trim().toUpperCase();
        if (v && !/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(v)) {
            gridInp.value = settings.grid; // invalid: revert
            return;
        }
        gridInp.value = v;
        if (v !== settings.grid) {
            settings.grid = v;
            saveSettings();
            rebuildQsoMap();
        }
    });
    // Settings panes: Global / Spot map / QSO map
    $all('.cfg-tab').forEach(btn => btn.addEventListener('click', () => {
        $all('.cfg-tab').forEach(b => b.classList.toggle('active', b === btn));
        $all('.cfg-pane').forEach(p => p.classList.toggle('active',
            p.id === 'pane' + btn.dataset.pane.charAt(0).toUpperCase() +
                btn.dataset.pane.slice(1)));
    }));
    // QSO map options: contest category, marker limit, home links, auto-fit
    const catSel = $('#setCategory');
    catSel.value = settings.category;
    catSel.addEventListener('change', () => {
        settings.category = catSel.value;
        saveSettings();
        renderQsoPanel();
    });
    const qsoMaxInp = $('#setQsoMax');
    qsoMaxInp.value = settings.qsoMax;
    qsoMaxInp.addEventListener('change', () => {
        let v = parseInt(qsoMaxInp.value, 10);
        if (isNaN(v)) v = 1500;
        v = Math.min(4000, Math.max(200, v));
        qsoMaxInp.value = v;
        settings.qsoMax = v;
        saveSettings();
    });
    const qsoLinesChk = $('#setQsoLines');
    qsoLinesChk.checked = settings.qsoLines;
    qsoLinesChk.addEventListener('change', () => {
        settings.qsoLines = qsoLinesChk.checked;
        saveSettings();
        rebuildQsoMap();
    });
    const qsoFitChk = $('#setQsoAutoFit');
    qsoFitChk.checked = settings.qsoAutoFit;
    qsoFitChk.addEventListener('change', () => {
        settings.qsoAutoFit = qsoFitChk.checked;
        saveSettings();
        fitQsoMap();
    });
    const alertChk = $('#setQsoSpotAlert');
    alertChk.checked = settings.qsoSpotAlert;
    alertChk.addEventListener('change', () => {
        settings.qsoSpotAlert = alertChk.checked;
        saveSettings();
        if (!alertChk.checked) hideSpotAlert();
    });
    const voiceChk = $('#setQsoVoice');
    voiceChk.checked = settings.qsoVoiceAlert;
    voiceChk.addEventListener('change', () => {
        settings.qsoVoiceAlert = voiceChk.checked;
        saveSettings();
        if (!voiceChk.checked && 'speechSynthesis' in window) speechSynthesis.cancel();
    });
    $('#saClose').addEventListener('click', hideSpotAlertAndVoice);
    // Spot grid <-> QSO map switch (two independent buttons)
    $('#btnSpotView').addEventListener('click', () => setViewMode('spots'));
    $('#btnQsoView').addEventListener('click', () => setViewMode('qso'));
    // QRZ.com XML credentials (QSO coordinate lookups; needs a QRZ XML
    // subscription). Stored server-side in flow context; the password is
    // never read back into the form.
    const qrzUser = $('#setQrzUser'), qrzPass = $('#setQrzPass');
    fetch('/api/qrz/config').then(r => r.json()).then(c => {
        if (c && c.configured) qrzUser.value = c.username || '';
    }).catch(() => {});
    function saveQrzCreds() {
        const username = qrzUser.value.trim(), password = qrzPass.value.trim();
        if (!username || !password) return;
        fetch('/api/qrz/config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({username, password})
        }).then(r => r.json()).then(r => {
            if (r && r.ok) { qrzPass.value = ''; showToast(t('saved')); }
            else showToast(t('saveFail'));
        }).catch(() => showToast(t('saveFail')));
    }
    qrzPass.addEventListener('change', saveQrzCreds);
    [['ttlCw', 'CW'], ['ttlSsb', 'SSB'], ['ttlDigi', 'DIGI']].forEach(([id, mode]) => {
        const inp = $('#' + id);
        inp.value = settings.ttl[mode];
        inp.addEventListener('change', () => {
            let v = parseInt(inp.value, 10);
            if (isNaN(v) || v < 1) v = 1;
            if (v > 180) v = 180;
            inp.value = v;
            settings.ttl[mode] = v;
            saveSettings();
        });
    });
    buildBandColorInputs();
    // Recording controls
    $('#btnRecToggle').addEventListener('click', toggleRecording);
    $('#btnRecSched').addEventListener('click', () => $('#recSchedForm').classList.toggle('hidden'));
    $('#btnRecSchedSet').addEventListener('click', setRecSchedule);
    $('#btnRecSchedClear').addEventListener('click', clearRecSchedule);
    $all('.rec-tab').forEach(t => t.addEventListener('click', () => {
        state.recView = t.dataset.view;
        $all('.rec-tab').forEach(x => x.classList.toggle('active', x === t));
        refreshRecords();
    }));
    $('#configForm').addEventListener('submit', saveConfig);

    // Create all 9 cells once (never rebuilt; layout only toggles visibility)
    const grid = $('#grid');
    for (let i = 0; i < MAX_CELLS; i++) {
        const cell = createCell(i);
        state.cells.push(cell);
        grid.appendChild(cell.el);
    }

    // Initial layout
    setLayout('1x1');
    initQsoMap();
    updateMonitorBtn();
    applyLang();

    // Load config + callsigns
    loadConfig();

    // Own station: last radio/score state + QSO map backfill
    loadStation();

    // Docked records panel: initial data + recording status
    refreshRecStatus(true);
    refreshRecords();

    // Keep the marker auto-fit in sync with the window size
    window.addEventListener('resize', () => {
        visibleCells().forEach(c => {
            if (c.map) {
                c.map.invalidateSize();
                fitCellView(c);
            }
        });
        if (qsoState.view === 'qso' && qsoState.map) {
            qsoState.map.invalidateSize();
            fitQsoMap();
        }
    });

    // WebSocket
    connectWS();

    // UTC clock
    setInterval(() => {
        const d = new Date();
        $('#utcClock').textContent = d.toISOString().substring(11, 19) + 'Z';
        if (qsoState.view === 'qso') updateQsoAge();
    }, 1000);

    // Recording status: keep the panel indicator fresh, auto-refresh
    // the Recorded view while a session is active.
    setInterval(() => {
        refreshRecStatus();
        if (state.recStatus && state.recStatus.active &&
            state.recView === 'rec') {
            refreshRecords();
        }
    }, 15000);

    // Every 10s: fade markers toward transparent as they approach expiry,
    // and weaken their heat contributions along with the dots
    setInterval(() => {
        const now = Date.now();
        state.cells.forEach(c => {
            c.markers.forEach(g => applyMarkerFade(g, now));
            Object.keys(c.heat).forEach(b => updateHeat(c, b, now));
        });
        if (qsoState.lastQso) {
            renderLastQso(); // keep the age text fresh
            if (qsoState.view === 'qso') renderQsoPanel();
        }
    }, 10000);

    // Every 30s: expire chips together with their markers.
    setInterval(() => state.cells.forEach(c => {
        const now = Date.now();
        let pruned = false;
        Object.keys(c.bandInfo).forEach(band => {
            if (now - c.bandInfo[band].addedAt > ttlForMode(c.bandInfo[band].spot.mode)) {
                delete c.bandInfo[band];
                pruned = true;
            }
        });
        if (Object.keys(c.bandInfo).length) renderCellInfo(c);
        else if (pruned) c.info.innerHTML = '';
        if (pruned) refreshActiveBand(c);
    }), 30000);
}

document.addEventListener('DOMContentLoaded', init);
