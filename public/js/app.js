/* ============================================================
 * DX-Compass - Frontend application
 * DVR-style multi-map DX spot monitor
 * ============================================================ */

const MARKER_TTL_MS = 60 * 60 * 1000; // 1 hour marker survival
const MAX_CELLS = 9;

const state = {
    layout: '1x1',
    cells: [],          // array of {index, call, map, markers:[], count}
    ws: null,
    wsConnected: false,
    totalSpots: 0,
    config: {}
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

function signalColor(spot) {
    if (spot.snr !== null && spot.snr !== undefined) {
        if (spot.snr >= 0) return '#2ecc71';
        if (spot.snr >= -10) return '#f1c40f';
        return '#e74c3c';
    }
    if (spot.signal) {
        const n = parseInt(spot.signal.charAt(1));
        if (n >= 9) return '#2ecc71';
        if (n >= 7) return '#f1c40f';
        return '#e74c3c';
    }
    return '#00e5ff';
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
    // Rebuild cells array preserving existing callsigns; destroy old maps
    const oldCalls = state.cells.map(c => c.call);
    state.cells.forEach(c => { if (c.map) c.map.remove(); });
    state.cells = [];
    grid.innerHTML = '';

    for (let i = 0; i < count; i++) {
        const cell = createCell(i, oldCalls[i] || '');
        state.cells.push(cell);
        grid.appendChild(cell.el);
        setTimeout(() => { if (cell.map) cell.map.invalidateSize(); }, 50);
    }
    // Highlight active layout button
    $all('.layout-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layout === layout);
    });
}

function createCell(index, call) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.index = index;
    el.innerHTML = `
        <div class="cell-header">
            <input type="text" class="call-input" placeholder="Enter callsign..." maxlength="16">
            <span class="spot-count">0</span>
            <button class="clear-cell-btn" title="Clear map">&times;</button>
        </div>
        <div class="map"></div>
        <div class="cell-empty-hint"><span class="hint-icon">📡</span>Enter a callsign to monitor</div>
    `;
    const mapEl = el.querySelector('.map');
    const input = el.querySelector('.call-input');
    const countEl = el.querySelector('.spot-count');
    const clearBtn = el.querySelector('.clear-cell-btn');
    const hint = el.querySelector('.cell-empty-hint');

    const map = L.map(mapEl, {
        zoomControl: true,
        attributionControl: true,
        worldCopyJump: true
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 18
    }).addTo(map);

    const cell = {
        index, call: call || '', map, markers: [], count: 0,
        el, input, countEl, clearBtn, hint
    };

    input.value = call || '';
    input.addEventListener('change', () => onCallChange(cell));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    clearBtn.addEventListener('click', () => clearCell(cell));

    if (call) hint.style.display = 'none';
    return cell;
}

function onCallChange(cell) {
    const call = cell.input.value.trim().toUpperCase();
    cell.call = call;
    if (call) {
        cell.hint.style.display = 'none';
        cell.countEl.textContent = cell.count;
    } else {
        cell.hint.style.display = '';
        clearCell(cell, false);
    }
    syncCallsigns();
}

function syncCallsigns() {
    const calls = state.cells.map(c => c.call).filter(Boolean);
    fetch('/api/callsigns', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(calls)
    }).then(r => r.json()).then(data => {
        if (data.calls) {
            // nothing to do
        }
    }).catch(() => showToast('Failed to save callsigns'));
}

function clearCell(cell, resetInput = true) {
    cell.markers.forEach(m => {
        clearTimeout(m._ttl);
        cell.map.removeLayer(m);
    });
    cell.markers = [];
    cell.count = 0;
    cell.countEl.textContent = '0';
    cell.countEl.classList.remove('has-spots');
    if (resetInput) {
        cell.call = '';
        cell.input.value = '';
        cell.hint.style.display = '';
        syncCallsigns();
    }
}

/* ---------- Markers ---------- */
function addMarkerToCell(cell, spot) {
    if (!spot.lat || !spot.lon) return;
    const color = signalColor(spot);
    const icon = L.divIcon({
        className: 'fresh-marker',
        html: `<div style="
            width:14px;height:14px;border-radius:50%;
            background:${color};border:2px solid #fff;
            box-shadow:0 0 6px ${color};"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
    });

    const sigText = spot.signal ? `Signal: ${spot.signal}` :
                    spot.snr !== null ? `SNR: ${spot.snr} dB` : '';
    const popup = `
        <b>${spot.de}</b><br>
        Freq: ${spot.freq} kHz<br>
        ${sigText}<br>
        Mode: ${spot.mode || '—'}<br>
        Distance: ${spot.distance_km} km (${spot.distance_miles} mi)<br>
        Time: ${formatTime(spot.timestamp)}<br>
        <i>${spot.comment || ''}</i>
    `;

    const marker = L.marker([spot.lat, spot.lon], {icon}).addTo(cell.map);
    marker.bindPopup(popup);
    marker._spot = spot;
    marker._ttl = setTimeout(() => removeMarker(cell, marker), MARKER_TTL_MS);

    cell.markers.push(marker);
    cell.count++;
    cell.countEl.textContent = cell.count;
    cell.countEl.classList.add('has-spots');

    // Remove old markers beyond a reasonable limit
    if (cell.markers.length > 500) {
        const old = cell.markers.shift();
        clearTimeout(old._ttl);
        cell.map.removeLayer(old);
    }
}

function removeMarker(cell, marker) {
    const i = cell.markers.indexOf(marker);
    if (i >= 0) cell.markers.splice(i, 1);
    cell.map.removeLayer(marker);
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
        $('#cfgSkimmerCall').value = cfg.skimmerCall || '';
        $('#cfgClusterServer').value = cfg.clusterServer || '';
        $('#cfgClusterPort').value = cfg.clusterPort || '';
        $('#cfgHomeLat').value = cfg.homelat || '';
        $('#cfgHomeLon').value = cfg.homelon || '';
    });
}

function saveConfig(e) {
    e.preventDefault();
    const cfg = {
        skimmerCall: $('#cfgSkimmerCall').value.trim().toUpperCase(),
        clusterServer: $('#cfgClusterServer').value.trim(),
        clusterPort: $('#cfgClusterPort').value.trim(),
        homelat: $('#cfgHomeLat').value.trim(),
        homelon: $('#cfgHomeLon').value.trim()
    };
    fetch('/api/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(cfg)
    }).then(r => r.json()).then(() => {
        showToast('Configuration saved');
        closeConfig();
    }).catch(() => showToast('Failed to save config'));
}

function connectCluster() {
    fetch('/api/connect', {method: 'POST'})
        .then(r => r.json())
        .then(() => showToast('Connecting to cluster...'))
        .catch(() => showToast('Connect command failed'));
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
    $('#btnConnect').addEventListener('click', connectCluster);
    $('#btnRefreshRecords').addEventListener('click', refreshRecords);
    $('#btnExportCsv').addEventListener('click', exportCsv);
    $('#recordCallSelect').addEventListener('change', refreshRecords);
    $('#configForm').addEventListener('submit', saveConfig);
    $('#btnTestConnect').addEventListener('click', () => { saveConfig({preventDefault:()=>{}}); connectCluster(); });

    // Initial layout
    setLayout('1x1');

    // Load config + callsigns
    loadConfig();
    fetch('/api/callsigns').then(r => r.json()).then(calls => {
        if (Array.isArray(calls) && calls.length) {
            // Distribute calls into cells
            calls.forEach((call, i) => {
                if (state.cells[i]) {
                    state.cells[i].call = call;
                    state.cells[i].input.value = call;
                    state.cells[i].hint.style.display = 'none';
                }
            });
        }
    });

    // WebSocket
    connectWS();

    // UTC clock
    setInterval(() => {
        const d = new Date();
        $('#utcClock').textContent = d.toISOString().substring(11, 19) + 'Z';
    }, 1000);
}

document.addEventListener('DOMContentLoaded', init);
