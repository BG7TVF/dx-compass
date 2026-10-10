/* ============================================================
 * DX-Compass - Frontend application
 * DVR-style multi-map DX spot monitor
 * ============================================================ */

const MARKER_TTL_MS = 30 * 60 * 1000; // 30 min marker / info-chip / heat survival
const NO_RUNING_MS = 10 * 60 * 1000;  // no spot for 10 min -> NO RUNING
const QRT_MS = 30 * 60 * 1000;        // no spot for 30 min -> QRT
const HISTORY_LIMIT = 500;            // rows fetched per call after a page reload
const MAX_CELLS = 9;

const state = {
    layout: '1x1',
    cells: [],          // array of {index, call, map, markers:[], count}
    ws: null,
    wsConnected: false,
    totalSpots: 0,
    config: {},
    monitoring: localStorage.getItem('dxcompass-monitoring') === '1'
};

/* ---------- Utilities ---------- */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

function showToast(msg, ms = 2500) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

function setConnState(state) {
    const dot = $('#connDot');
    const txt = $('#connText');
    dot.className = 'conn-dot ' + state;
    txt.textContent = state === 'connected' ? 'connected' :
                       state === 'connecting' ? 'connecting...' : 'disconnected';
}

function renderCellInfo(cell) {
    const chips = [];
    for (const band of Object.keys(cell.bandInfo)) {
        const s = cell.bandInfo[band].spot;
        const bandColor = BAND_COLORS[band] || '#00e5ff';
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
    if (sec < 30) return '现在';
    if (sec < 90) return '1分钟前';
    if (sec < 180) return '2分钟前';
    if (sec < 300) return '5分钟前';
    if (sec < 600) return '10分钟前';
    if (sec < 1800) return '30分钟前';
    if (sec < 3600) return '1小时前';
    return Math.floor(sec / 3600) + '小时前';
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
            fitToMarkers(c);   // re-fit to the new cell size
        }
    }), 50);
    // Highlight active layout button
    $all('.layout-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === layout);
    });
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
        <div class="cell-empty-hint"><span class="hint-icon">📡</span>Set callsigns in Config</div>
    `;
    const mapEl = el.querySelector('.map');
    const callLabel = el.querySelector('.call-label');
    const countEl = el.querySelector('.spot-count');
    const clearBtn = el.querySelector('.clear-cell-btn');
    const hint = el.querySelector('.cell-empty-hint');
    const info = el.querySelector('.cell-info');

    const map = L.map(mapEl, {
        zoomControl: false,      // buttons removed; scroll-wheel zoom stays on
        scrollWheelZoom: true,
        attributionControl: true,
        worldCopyJump: true
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 18
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
 * Drawn in 3 world copies so no seam is visible when a zoomed-out view
 * (width > 360 deg) shows areas beyond +/-180 longitude. */
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
        // One copy per world (-360 / 0 / +360 longitude shift)
        for (const shift of [-360, 0, 360]) {
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
    // Slot i of the Config list owns cell i. A changed/removed call
    // clears that cell's markers; maps and other cells are untouched.
    for (let i = 0; i < MAX_CELLS; i++) {
        const cell = state.cells[i];
        if (!cell) continue;
        const call = (calls[i] || '').toUpperCase();
        if (call === cell.call) continue;
        if (cell.call) clearCell(cell);          // old call's spots no longer wanted
        cell.call = call;
        cell.callLabel.textContent = call || '\u2014';
        cell.hint.style.display = call ? 'none' : '';
        cell.lastSpotAt = null;
        updateStale(cell);
    }
    if (typeof updateMonitorBtn === 'function') updateMonitorBtn();
}

function syncCallsigns() {
    const calls = state.cells.map(c => c.call);
    fetch('/api/callsigns', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(calls.filter(Boolean))
    }).catch(() => showToast('Failed to save callsigns'));
}

function clearCell(cell) {
    clearTimeout(cell._fitTimer);
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
    updateStale(cell);
}

/* Auto zoom: zoom in to the HIGHEST level that still shows every marker */
function fitToMarkers(cell) {
    if (!cell.markers.length || cell.el.style.display === 'none') return;
    cell.map.invalidateSize();
    const bounds = L.latLngBounds([]);
    cell.markers.forEach(g => {
        const s = g._spot;
        if (s.lat !== null && s.lat !== undefined && s.lon !== null && s.lon !== undefined)
            bounds.extend([s.lat, s.lon]);
        if (s.dx_lat !== null && s.dx_lat !== undefined && s.dx_lon !== null && s.dx_lon !== undefined)
            bounds.extend([s.dx_lat, s.dx_lon]);
    });
    if (!bounds.isValid()) return;
    // No low zoom cap: fitBounds picks the largest zoom that contains
    // every marker. maxZoom only bounds the degenerate single-point case.
    cell.map.fitBounds(bounds, {padding: [40, 40], maxZoom: 12, animate: true});
}

function scheduleFit(cell) {
    clearTimeout(cell._fitTimer);
    cell._fitTimer = setTimeout(() => fitToMarkers(cell), 400);
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
const BAND_COLORS = {
    '160m': '#b565d8', '80m': '#e67e22', '60m': '#fd79a8', '40m': '#f1c40f',
    '30m': '#1abc9c', '20m': '#00e5ff', '17m': '#3498db', '15m': '#9b59b6',
    '12m': '#e84393', '10m': '#e17055', '6m': '#dfe6e9', '2m': '#55efc4'
};

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

function addMarkerToCell(cell, spot, ttlMs = MARKER_TTL_MS) {
    const hasDe = spot.lat !== null && spot.lat !== undefined &&
                  spot.lon !== null && spot.lon !== undefined;
    const hasDx = spot.dx_lat !== null && spot.dx_lat !== undefined &&
                  spot.dx_lon !== null && spot.dx_lon !== undefined;
    if (!hasDe && !hasDx) return;

    // Deduplicate: replayed history and live WS can carry the same spot
    const key = spotHeatKey(spot);
    if (cell.seen.has(key)) return;
    cell.seen.add(key);

    const bandColor = BAND_COLORS[spot.band] || '#00e5ff';
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

    // Link line between monitored station and spotter (band colored, RBN style)
    if (hasDe && hasDx) {
        layers.push(L.polyline(
            [[spot.dx_lat, spot.dx_lon], [spot.lat, spot.lon]],
            {color: bandColor, weight: 2, opacity: 0.85}
        ).addTo(cell.map));
    }

    const group = {layers, _spot: spot, _addedAt: Date.now()};
    group._ttl = setTimeout(() => removeMarker(cell, group), ttlMs);

    cell.markers.push(group);
    cell.count++;
    cell.countEl.textContent = cell.count;
    cell.countEl.classList.add('has-spots');
    // For replayed spots ttlMs < full TTL; effective time keeps NO RUNING
    // timing and chip expiry aligned to the spot's real timestamp.
    const effectiveNow = Date.now() - (MARKER_TTL_MS - ttlMs);
    const spotTs = new Date(spot.timestamp).getTime();
    cell.lastSpotAt = Math.max(cell.lastSpotAt || 0, isNaN(spotTs) ? effectiveNow : spotTs);
    updateStale(cell);

    // Info bar: one chip per band with the same TTL as markers
    cell.bandInfo[spot.band || '?'] = {spot, addedAt: effectiveNow};
    // Heat layers (CW/DIGI only); active band = most reports by default
    refreshActiveBand(cell);
    renderCellInfo(cell);

    // Auto zoom to include the new marker: immediate on the first one,
    // debounced afterwards to absorb spot bursts.
    if (cell.markers.length === 1) fitToMarkers(cell);
    else scheduleFit(cell);

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
    scheduleFit(cell);
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

    state.ws.onopen = () => { setConnState('connected'); };
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
    $('#spotCount').textContent = state.totalSpots + ' spots';
    // Find the cell monitoring this call
    const call = (spot.monitored_call || spot.call || '').toUpperCase();
    const cell = state.cells.find(c => c.call && c.call.toUpperCase() === call);
    if (cell) {
        addMarkerToCell(cell, spot);
        // If records panel is open for this call, refresh
        if (!$('#recordsPanel').classList.contains('hidden')) {
            const sel = $('#recordCallSelect');
            if (sel.value === call || sel.value === '') refreshRecords();
        }
    }
}

/* ---------- Monitoring start/stop + post-refresh recovery ---------- */
function hasAnyCallsign() {
    return state.cells.some(c => c.call);
}

function updateMonitorBtn() {
    const btn = $('#btnMonitor');
    btn.classList.toggle('running', state.monitoring);
    btn.textContent = state.monitoring ? '■ 停止监控' : '▶ 开始监控';
    btn.disabled = !state.monitoring && !hasAnyCallsign();
    btn.title = hasAnyCallsign() || state.monitoring ? '' :
        'Set at least one callsign in Config first';
}

function setMonitoring(on) {
    if (on && !hasAnyCallsign()) return;
    state.monitoring = on;
    localStorage.setItem('dxcompass-monitoring', on ? '1' : '0');
    updateMonitorBtn();
    if (on) {
        replayHistory();
    }
    // On stop the current display is kept frozen; live spots are just ignored.
}

/* Reload spots from the last TTL window so a browser refresh does not
 * wipe markers, band chips and heat layers. */
async function replayHistory() {
    const cutoff = Date.now() - MARKER_TTL_MS;
    const calls = state.cells.map(c => c.call).filter(Boolean);
    for (const call of calls) {
        let rows = [];
        try {
            rows = await fetch(`/api/spots?call=${encodeURIComponent(call)}&limit=${HISTORY_LIMIT}`)
                .then(r => r.json());
        } catch (e) { continue; }
        const cell = state.cells.find(c => c.call === call);
        if (!cell || !state.monitoring) continue;
        // API returns newest first; replay oldest first for sane fitBounds
        rows.reverse().forEach(r => {
            const t = new Date(r.timestamp).getTime();
            if (isNaN(t) || t < cutoff) return;
            addMarkerToCell(cell, r, MARKER_TTL_MS - (Date.now() - t));
        });
        fitToMarkers(cell);
    }
}

/* ---------- Records ---------- */
function openRecords() {
    $('#recordsPanel').classList.remove('hidden');
    populateCallSelect();
    refreshRecords();
}

function closeRecords() {
    $('#recordsPanel').classList.add('hidden');
}

function populateCallSelect() {
    const sel = $('#recordCallSelect');
    const current = sel.value;
    sel.innerHTML = '<option value="">-- All monitored calls --</option>';
    state.cells.forEach(c => {
        if (c.call) {
            const opt = document.createElement('option');
            opt.value = c.call;
            opt.textContent = c.call;
            sel.appendChild(opt);
        }
    });
    sel.value = current;
}

function refreshRecords() {
    const call = $('#recordCallSelect').value;
    const url = call ? `/api/spots?call=${encodeURIComponent(call)}` : '/api/spots';
    fetch(url).then(r => r.json()).then(rows => {
        const body = $('#recordsBody');
        body.innerHTML = '';
        rows.forEach(r => {
            const tr = document.createElement('tr');
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
            body.appendChild(tr);
        });
        $('#recordsFooter').textContent = rows.length + ' records';
    }).catch(() => showToast('Failed to load records'));
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

function exportCsv() {
    const call = $('#recordCallSelect').value;
    const url = call ? `/api/spots?call=${encodeURIComponent(call)}&limit=10000` : '/api/spots?limit=10000';
    fetch(url).then(r => r.json()).then(rows => {
        const headers = ['timestamp','monitored_call','de','freq','spot_call','mode','signal','snr','distance_km','distance_miles','comment'];
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
        a.download = `dxcompass-spots-${call || 'all'}-${Date.now()}.csv`;
        a.click();
        showToast('CSV exported');
    });
}

/* ---------- Config ---------- */
function openConfig() {
    $('#configPanel').classList.remove('hidden');
    loadConfig();
}
function closeConfig() { $('#configPanel').classList.add('hidden'); }

function loadConfig() {
    fetch('/api/config').then(r => r.json()).then(cfg => {
        state.config = cfg;
        $('#cfgHomeLat').value = cfg.homelat || '';
        $('#cfgHomeLon').value = cfg.homelon || '';
    });
    fetch('/api/callsigns').then(r => r.json()).then(calls => {
        if (Array.isArray(calls)) {
            applyCallsigns(calls);
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
    const cfg = {
        homelat: $('#cfgHomeLat').value.trim(),
        homelon: $('#cfgHomeLon').value.trim()
    };
    const calls = Array.from(document.querySelectorAll('.cfg-call'))
        .map(inp => inp.value.trim().toUpperCase());

    // Save coordinates
    fetch('/api/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(cfg)
    }).then(r => r.json()).catch(() => showToast('Failed to save config'));

    // Save callsigns (slot order matters)
    fetch('/api/callsigns', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(calls)
    }).then(r => r.json()).then(() => {
        applyCallsigns(calls);
        updateMonitorBtn();
        if (state.monitoring) replayHistory(); // backfill newly added slots
        showToast('Configuration saved');
        closeConfig();
    }).catch(() => showToast('Failed to save callsigns'));
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

    $('#btnRecords').addEventListener('click', openRecords);
    $('#btnConfig').addEventListener('click', openConfig);
    $('#btnMonitor').addEventListener('click', () => setMonitoring(!state.monitoring));
    $('#btnRefreshRecords').addEventListener('click', refreshRecords);
    $('#btnExportCsv').addEventListener('click', exportCsv);
    $('#recordCallSelect').addEventListener('change', refreshRecords);
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

    // Load config + callsigns
    loadConfig();

    // WebSocket
    connectWS();

    // UTC clock
    setInterval(() => {
        const d = new Date();
        $('#utcClock').textContent = d.toISOString().substring(11, 19) + 'Z';
    }, 1000);

    // Every 30s: refresh chip ages, expire chips together with markers,
    // and update the NO RUNING / QRT status overlays.
    setInterval(() => state.cells.forEach(c => {
        const now = Date.now();
        let pruned = false;
        Object.keys(c.bandInfo).forEach(band => {
            if (now - c.bandInfo[band].addedAt > MARKER_TTL_MS) {
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
