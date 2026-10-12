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

const settings = loadSettings();

function loadSettings() {
    const d = { lang: 'zh', ttl: {...DEFAULT_TTL_MIN}, bandColors: {...DEFAULT_BAND_COLORS} };
    try {
        const raw = JSON.parse(localStorage.getItem('dxcompass-settings') || '{}');
        if (raw.lang === 'en' || raw.lang === 'zh') d.lang = raw.lang;
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

/* ---------- i18n ---------- */
const I18N = {
    zh: {
        subtitle: '多呼号 Spot 监视器',
        settings: '设置',
        startMon: '▶ 开始监控', stopMon: '■ 停止监控',
        needCall: '请先在设置中配置至少一个呼号',
        startRot: '🔁 开始轮询', stopRot: '⏸ 停止轮询',
        nextPage: '下一页', rotSecTitle: '轮询间隔（秒）',
        connected: '已连接', connecting: '连接中...', disconnected: '未连接',
        records: 'Spot Records',
        allCalls: '-- 全部监听呼号 --',
        refresh: '刷新', exportCsv: '导出 CSV', clearDb: '清空数据库',
        record: '● 录制', stopRec: '■ 停止', schedule: '定时', download: '⬇ 下载',
        set: '设定', clear: '清除', recTz: 'UTC，一次性',
        tabAll: '全部 Spot', tabRec: '录制记录',
        notRecording: '未在录制',
        recManual: '录制中（手动）', recSched: '录制中（定时）',
        scheduled: '已设定时', since: '始于',
        cfgSection: '监听呼号', globalSection: '全局设置',
        langLabel: '语言 / Language', ttlTitle: '标记点存活时间（分钟）', bandTitle: '频段颜色',
        save: '保存',
        cfgHint: '呼号按顺序分配到地图窗口，空槽位在仪表盘上保持空白。<br>距离为被监听台与监听台之间计算得出。<br>Spot 自动获取：CW 来自 reversebeacon.net RBN（10 秒），其他模式来自 dxwatch.com（30 秒）——无需集群登录或连接设置。',
        cellHint: '在设置中配置呼号',
        askClearMarks: '是否清空全部标记？\n\n确定 = 清空所有地图的标记、连线、频段框和热力图\n取消 = 保留当前显示（冻结）',
        askClearDb: '确定要清空数据库中的全部 Spot 记录吗？\n\n录制数据（recording_spots）会保留。\n此操作不可恢复！',
        danger: '清空', ok: '确定', cancel: '取消', confirmTitle: '确认',
        cleared: '数据库已清空', clearFail: '清空数据库失败',
        csvOk: 'CSV 已导出',
        saved: '设置已保存', saveFail: '保存呼号失败',
        loadFail: '加载记录失败',
        recStarted: '录制已开始', recStopped: '录制已停止',
        schedOk: '定时录制已设定', schedCleared: '定时已清除',
        pickDt: '请先选择起止日期时间',
        now: '现在',
        headAll: ['时间 (UTC)', '被监听', '监听站 (DE)', '频率', '模式', '信号', 'SNR', '距离 (km)', '备注'],
        headRec: ['日期', '时间 (UTC)', '被监听', '监听站 (DE)', '频段', '频率', '模式', '详情', 'SNR', '距离 (km)', '备注'],
        recordsN: n => n + ' 条记录',
        spotsN: n => n + ' spots'
    },
    en: {
        subtitle: 'Multi-Call Spot Monitor',
        settings: 'Settings',
        startMon: '▶ Start Monitor', stopMon: '■ Stop Monitor',
        needCall: 'Set at least one callsign in Settings first',
        startRot: '🔁 Rotate', stopRot: '⏸ Stop',
        nextPage: 'Next page', rotSecTitle: 'Rotation interval (seconds)',
        connected: 'connected', connecting: 'connecting...', disconnected: 'disconnected',
        records: 'Spot Records',
        allCalls: '-- All monitored calls --',
        refresh: 'Refresh', exportCsv: 'Export CSV', clearDb: 'Clear DB',
        record: '● Record', stopRec: '■ Stop', schedule: 'Schedule', download: '⬇ Download',
        set: 'Set', clear: 'Clear', recTz: 'UTC, one-shot',
        tabAll: 'All Spots', tabRec: 'Recorded',
        notRecording: 'Not recording',
        recManual: 'Recording (manual)', recSched: 'Recording (scheduled)',
        scheduled: 'Scheduled', since: 'since',
        cfgSection: 'Monitored Callsigns', globalSection: 'Global Settings',
        langLabel: 'Language / 语言', ttlTitle: 'Marker lifetime (minutes)', bandTitle: 'Band colors',
        save: 'Save',
        cfgHint: 'Callsigns are assigned to map slots in order. Empty slots stay blank on the dashboard.<br>Distance is computed between the monitored station and the spotting station.<br>Spots are provided automatically: CW by reversebeacon.net RBN (10s), other modes by dxwatch.com (30s) - no cluster login or connection setup is needed.',
        cellHint: 'Set callsigns in Settings',
        askClearMarks: 'Clear all markers?\n\nOK = wipe markers, link lines, band chips and heat maps from every map\nCancel = keep the current display (frozen)',
        askClearDb: 'Delete ALL spot records from the database?\n\nRecorded sessions (recording_spots) are kept.\nThis cannot be undone!',
        danger: 'Delete', ok: 'OK', cancel: 'Cancel', confirmTitle: 'Confirm',
        cleared: 'Database cleared', clearFail: 'Failed to clear database',
        csvOk: 'CSV exported',
        saved: 'Settings saved', saveFail: 'Failed to save callsigns',
        loadFail: 'Failed to load records',
        recStarted: 'Recording started', recStopped: 'Recording stopped',
        schedOk: 'Recording scheduled', schedCleared: 'Schedule cleared',
        pickDt: 'Pick start and end date/time first',
        now: 'now',
        headAll: ['Time (UTC)', 'Monitored', 'Spotter (DE)', 'Freq', 'Mode', 'Signal', 'SNR', 'Dist (km)', 'Comment'],
        headRec: ['Date', 'Time (UTC)', 'Monitored', 'Spotter (DE)', 'Band', 'Freq', 'Mode', 'Detail', 'SNR', 'Dist (km)', 'Comment'],
        recordsN: n => n + ' records',
        spotsN: n => n + ' spots'
    }
};
function t(key) {
    const v = I18N[settings.lang][key];
    return v !== undefined ? v : (I18N.en[key] !== undefined ? I18N.en[key] : key);
}

const NO_RUNING_MS = 10 * 60 * 1000;  // no spot for 10 min -> NO RUNING
const QRT_MS = 30 * 60 * 1000;        // no spot for 30 min -> QRT
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
    const zh = settings.lang === 'zh';
    const m = v => zh ? v + '分钟前' : v + 'm ago';
    if (sec < 30) return t('now');
    if (sec < 90) return m(1);
    if (sec < 180) return m(2);
    if (sec < 300) return m(5);
    if (sec < 600) return m(10);
    if (sec < 1800) return m(30);
    if (sec < 3600) return zh ? '1小时前' : '1h ago';
    const h = Math.floor(sec / 3600);
    return zh ? h + '小时前' : h + 'h ago';
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
        <div class="stale-overlay">NO RUNING</div>
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

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 18,
        noWrap: true,
        bounds: WORLD_BOUNDS
    }).addTo(map);

    addTerminator(map);

    const cell = {
        index, call: '', map, markers: [], count: 0,
        bandInfo: {},    // band -> {spot, addedAt}
        heat: {},        // band -> L.heatLayer
        activeBand: null,// band whose heat layer is visible
        bandPinned: false, // user clicked a chip: keep its band selected
        seen: new Set(), // dedup keys (live WS vs replayed history)
        lastSpotAt: null,
        el, callLabel, countEl, clearBtn, hint, info,
        stale: el.querySelector('.stale-overlay')
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
    cell.lastSpotAt = null;
    updateStale(cell);
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
    cell.lastSpotAt = null;
    clearTimeout(cell._fitTimer);
    if (cell.map) fitWorld(cell.map);  // back to the world-cover view
    updateStale(cell);
}

/* Minimum zoom = the level at which the world map COVERS the whole cell
 * (getBoundsZoom with inside=true): the map always fills the window and
 * polar overflow is cropped instead of leaving letterboxed black edges.
 * Must be re-applied after every container resize (zoom depends on size). */
function setWorldMinZoom(map) {
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

/* Status overlay: 10 min without a spot -> NO RUNING; 30 min -> QRT */
function updateStale(cell) {
    let status = null;
    if (cell.call && cell.lastSpotAt) {
        const age = Date.now() - cell.lastSpotAt;
        if (age >= QRT_MS) status = 'QRT';
        else if (age >= NO_RUNING_MS) status = 'NO RUNING';
    }
    if (!status) {
        cell.stale.classList.remove('show', 'qrt');
    } else {
        cell.stale.textContent = status;
        cell.stale.classList.toggle('qrt', status === 'QRT');
        cell.stale.classList.add('show');
    }
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

function updateHeat(cell, band) {
    const points = cell.markers
        .map(g => g._spot)
        .filter(s => (s.band || '?') === band && isHeatSpot(s))
        .map(s => [s.lat, s.lon, heatWeight(s.snr)]);

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
    // For replayed spots ttlMs < full TTL; effective time keeps NO RUNING
    // timing and chip expiry aligned to the spot's real timestamp.
    const effectiveNow = Date.now() - (fullTtl - ttlMs);
    const spotTs = new Date(spot.timestamp).getTime();
    cell.lastSpotAt = Math.max(cell.lastSpotAt || 0, isNaN(spotTs) ? effectiveNow : spotTs);
    updateStale(cell);

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
        let spot;
        try { spot = JSON.parse(evt.data); }
        catch (e) { return; }
        handleSpot(spot);
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
    document.documentElement.lang = settings.lang === 'zh' ? 'zh-CN' : 'en';
    $('.brand .subtitle').textContent = t('subtitle');
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
    $('#globalSectionTitle').textContent = t('globalSection');
    $('#langLabel').textContent = t('langLabel');
    $('#ttlTitle').textContent = t('ttlTitle');
    $('#bandTitle').textContent = t('bandTitle');
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
    $('#setLang').value = settings.lang;
    $('#setLang').addEventListener('change', () => {
        settings.lang = $('#setLang').value;
        saveSettings();
        applyLang();
    });
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
    updateMonitorBtn();
    applyLang();

    // Load config + callsigns
    loadConfig();

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
    });

    // WebSocket
    connectWS();

    // UTC clock
    setInterval(() => {
        const d = new Date();
        $('#utcClock').textContent = d.toISOString().substring(11, 19) + 'Z';
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

    // Every 10s: fade markers toward transparent as they approach expiry
    setInterval(() => {
        const now = Date.now();
        state.cells.forEach(c => c.markers.forEach(g => applyMarkerFade(g, now)));
    }, 10000);

    // Every 30s: refresh chip ages, expire chips together with markers,
    // and update the NO RUNING / QRT status overlays.
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
        updateStale(c);
    }), 30000);
}

document.addEventListener('DOMContentLoaded', init);
