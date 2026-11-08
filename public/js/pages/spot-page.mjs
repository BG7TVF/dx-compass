import {getLeaflet} from '../../shared/map/leaflet.mjs';
import {
    AUTO_FIT_MAX_ZOOM, createBaseMap, fitPoints, fitWorld, setWorldMinZoom
} from '../../shared/map/base-map.mjs';
import {createTerminator} from '../../shared/map/terminator.mjs';
import {addTrackPaths} from '../../shared/map/layers.mjs';
import {greatCirclePaths} from '../../shared/geo/great-circle.mjs';
import {createSpotStore, fetchSpots, spotKey} from '../../shared/data/spots.mjs';
import {bandColorOf, ttlForMode} from '../settings-model.mjs';
import {$, $$, formatTime, showConfirm, timeAgo} from '../ui.mjs';

const MAX_CELLS = 9;
const HISTORY_LIMIT = 500;

export function createSpotPage(ctx) {
    const L = getLeaflet();
    const store = createSpotStore();
    const state = {
        layout: '1x1', cells: [], callsigns: [], totalSpots: 0,
        monitoring: localStorage.getItem('dxcompass-monitoring') === '1',
        connState: 'disconnected',
        rotation: {
            offset: 0, timer: null, running: false,
            intervalSec: parseInt(localStorage.getItem('dxcompass-rot-sec'), 10) || 15
        }
    };

    const ttl = spot => ttlForMode(ctx.settings, spot.mode);
    const color = band => bandColorOf(ctx.settings, band);
    const visibleCells = () => state.cells.filter(cell => cell.el.style.display !== 'none');
    const rotationPages = () => Math.max(1, Math.ceil(
        state.callsigns.filter(Boolean).length / (visibleCells().length || 1)));
    const rotationNeeded = () => rotationPages() > 1;

    function setConnState(value) {
        state.connState = value === 'closed' ? 'disconnected' : value;
        $('#connDot').className = `conn-dot ${state.connState}`;
        $('#connText').textContent = state.connState === 'connected' ? ctx.t('connected') :
            state.connState === 'connecting' ? ctx.t('connecting') : ctx.t('disconnected');
    }

    function heatCounts(cell) {
        const counts = {};
        for (const group of cell.markers) {
            const spot = group._spot;
            if (!isHeatSpot(spot)) continue;
            const band = spot.band || '?';
            counts[band] = (counts[band] || 0) + 1;
        }
        return counts;
    }

    function renderCellInfo(cell) {
        const chips = [];
        const counts = heatCounts(cell);
        for (const band of Object.keys(cell.bandInfo)) {
            const spot = cell.bandInfo[band].spot;
            const bandColor = color(band);
            const signal = spot.snr !== null && spot.snr !== undefined
                ? `${spot.snr} dB` : (spot.signal || '');
            const heatable = counts[band] > 0;
            const className = `ci-chip${heatable ? ' heat-on' : ''}` +
                `${cell.activeBand === band && heatable ? ' active' : ''}`;
            chips.push(`<div class="${className}" data-band="${band}" style="border-color:${bandColor}">
                <span class="ci-band" style="color:${bandColor}">${band}</span>
                <span class="ci-freq">${spot.freq ? `${spot.freq} kHz` : ''}</span>
                <span class="ci-mode">${spot.mode || ''}</span>
                <span class="ci-sig">${signal}</span>
                <span class="ci-age">${timeAgo(ctx, new Date(spot.timestamp))}</span>
            </div>`);
        }
        cell.info.innerHTML = chips.join('');
    }

    function isHeatSpot(spot) {
        return (spot.mode === 'CW' || spot.mode === 'DIGI') &&
            typeof spot.snr === 'number' && Number.isFinite(spot.snr) &&
            spot.lat !== null && spot.lat !== undefined &&
            spot.lon !== null && spot.lon !== undefined;
    }

    function updateHeat(cell, band, now = Date.now()) {
        const points = [];
        for (const group of cell.markers) {
            const spot = group._spot;
            if ((spot.band || '?') !== band || !isHeatSpot(spot)) continue;
            const total = group._dieAt - group._bornAt;
            const opacity = total > 0 ? Math.max(0, Math.min(1, (group._dieAt - now) / total)) : 1;
            const weight = Math.max(0.1, Math.min(1, (spot.snr + 25) / 40));
            points.push([spot.lat, spot.lon, weight * opacity]);
        }
        let layer = cell.heat[band];
        if (!points.length && !layer) return;
        if (!layer) {
            layer = L.heatLayer([], {
                radius: 38, blur: 28, minOpacity: 0.3, maxZoom: 7,
                gradient: {0.2: '#2b4bff', 0.4: '#00e5ff', 0.6: '#2ecc71',
                    0.75: '#f1c40f', 0.9: '#e67e22', 1: '#e74c3c'}
            });
            cell.heat[band] = layer;
        }
        layer.setLatLngs(points);
        const show = cell.activeBand === band && points.length > 0;
        const onMap = cell.map.hasLayer(layer);
        if (show && !onMap) cell.map.addLayer(layer);
        if (!show && onMap) cell.map.removeLayer(layer);
    }

    function refreshActiveBand(cell) {
        const counts = heatCounts(cell), bands = Object.keys(counts);
        if (cell.activeBand && !counts[cell.activeBand]) {
            cell.activeBand = null;
            cell.bandPinned = false;
        }
        if (!cell.activeBand && bands.length) {
            cell.activeBand = bands.reduce((best, band) => counts[band] > counts[best] ? band : best, bands[0]);
        } else if (!cell.bandPinned && cell.activeBand && bands.length) {
            cell.activeBand = bands.reduce((best, band) => counts[band] > counts[best] ? band : best, cell.activeBand);
        }
        new Set([...Object.keys(cell.heat), ...bands]).forEach(band => updateHeat(cell, band));
    }

    function selectBand(cell, band) {
        if (heatCounts(cell)[band] === undefined) return;
        cell.activeBand = band;
        cell.bandPinned = true;
        Object.keys(cell.heat).forEach(key => updateHeat(cell, key));
        renderCellInfo(cell);
    }

    function fitCellView(cell) {
        if (!cell.map) return;
        const points = [];
        for (const group of cell.markers) {
            const spot = group._spot;
            if (spot.lat !== null && spot.lat !== undefined && spot.lon !== null && spot.lon !== undefined) {
                points.push([spot.lat, spot.lon]);
            }
            if (spot.dx_lat !== null && spot.dx_lat !== undefined &&
                spot.dx_lon !== null && spot.dx_lon !== undefined) {
                points.push([spot.dx_lat, spot.dx_lon]);
            }
        }
        fitPoints(cell.map, points, {L, maxZoom: AUTO_FIT_MAX_ZOOM});
    }

    function scheduleFit(cell) {
        clearTimeout(cell._fitTimer);
        cell._fitTimer = setTimeout(() => fitCellView(cell), 150);
    }

    function clearCell(cell) {
        for (const group of cell.markers) {
            clearTimeout(group._ttl);
            for (const layer of group.layers || [group]) {
                if (cell.map.hasLayer(layer)) cell.map.removeLayer(layer);
            }
        }
        cell.markers = [];
        cell.count = 0;
        cell.countEl.textContent = '0';
        cell.countEl.classList.remove('has-spots');
        cell.info.innerHTML = '';
        cell.bandInfo = {};
        Object.values(cell.heat).forEach(layer => {
            if (cell.map.hasLayer(layer)) cell.map.removeLayer(layer);
        });
        cell.heat = {};
        cell.activeBand = null;
        cell.bandPinned = false;
        cell.seen.clear();
        clearTimeout(cell._fitTimer);
        if (cell.map) fitWorld(cell.map);
    }

    function dotIcon(hex, size) {
        return L.divIcon({
            className: 'fresh-marker',
            html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${hex};border:2px solid #fff;box-shadow:0 0 6px ${hex};"></div>`,
            iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        });
    }

    function applyMarkerFade(group, now) {
        const total = group._dieAt - group._bornAt;
        if (total <= 0) return;
        const opacity = Math.max(0, Math.min(1, (group._dieAt - now) / total));
        for (const layer of group.layers) {
            if (layer instanceof L.Polyline) layer.setStyle({opacity: 0.85 * opacity});
            else {
                const element = layer.getElement && layer.getElement();
                if (element) element.style.opacity = opacity;
            }
        }
    }

    function removeMarker(cell, group) {
        const index = cell.markers.indexOf(group);
        if (index >= 0) cell.markers.splice(index, 1);
        group.layers.forEach(layer => {
            if (cell.map.hasLayer(layer)) cell.map.removeLayer(layer);
        });
        refreshActiveBand(cell);
        renderCellInfo(cell);
        scheduleFit(cell);
    }

    function addMarkerToCell(cell, spot, ttlMs) {
        const hasDe = spot.lat !== null && spot.lat !== undefined && spot.lon !== null && spot.lon !== undefined;
        const hasDx = spot.dx_lat !== null && spot.dx_lat !== undefined &&
            spot.dx_lon !== null && spot.dx_lon !== undefined;
        if (!hasDe && !hasDx) return;
        const key = spotKey(spot);
        if (!key || cell.seen.has(key)) return;
        cell.seen.add(key);
        const fullTtl = ttl(spot);
        if (ttlMs === undefined) ttlMs = fullTtl;
        if (ttlMs <= 0) return;
        const layers = [];
        if (hasDx) {
            const marker = L.marker([spot.dx_lat, spot.dx_lon], {icon: dotIcon('#2ecc71', 14)}).addTo(cell.map);
            marker.bindPopup(`<b>${spot.monitored_call || spot.spot_call}</b> (monitored)<br>${spot.dx_lat.toFixed(4)}, ${spot.dx_lon.toFixed(4)}`);
            layers.push(marker);
        }
        if (hasDe) {
            const signal = spot.signal ? `Signal: ${spot.signal}` :
                spot.snr !== null && spot.snr !== undefined ? `SNR: ${spot.snr} dB` : '';
            const marker = L.marker([spot.lat, spot.lon], {icon: dotIcon('#e74c3c', 12)}).addTo(cell.map);
            marker.bindPopup(`<b>${spot.de}</b> (spotter)<br>Freq: ${spot.freq} kHz ${spot.band ? `(${spot.band})` : ''}<br>${signal}<br>Mode: ${spot.mode || '—'}<br>Distance: ${spot.distance_km} km (${spot.distance_miles} mi)<br>Time: ${formatTime(spot.timestamp)}<br><i>${spot.comment || ''}</i>`);
            layers.push(marker);
        }
        if (hasDe && hasDx) {
            const paths = greatCirclePaths(spot.dx_lat, spot.dx_lon, spot.lat, spot.lon, 64);
            layers.push(...addTrackPaths(cell.map, paths, {
                L, color: color(spot.band), weight: 2, opacity: 0.85
            }));
        }
        const now = Date.now();
        const group = {layers, _spot: spot, _addedAt: now, _dieAt: now + ttlMs};
        group._bornAt = group._dieAt - fullTtl;
        group._ttl = setTimeout(() => removeMarker(cell, group), ttlMs);
        applyMarkerFade(group, now);
        cell.markers.push(group);
        cell.count++;
        cell.countEl.textContent = cell.count;
        cell.countEl.classList.add('has-spots');
        cell.bandInfo[spot.band || '?'] = {spot, addedAt: now - (fullTtl - ttlMs)};
        refreshActiveBand(cell);
        renderCellInfo(cell);
        scheduleFit(cell);
        if (cell.markers.length > 500) {
            const old = cell.markers.shift();
            clearTimeout(old._ttl);
            old.layers.forEach(layer => {
                if (cell.map.hasLayer(layer)) cell.map.removeLayer(layer);
            });
            refreshActiveBand(cell);
            renderCellInfo(cell);
        }
    }

    async function replayCellHistory(cell) {
        const call = cell.call;
        if (!call) return;
        try {
            const rows = await fetchSpots({call, limit: HISTORY_LIMIT});
            store.replay(rows);
            if (cell.call !== call || !state.monitoring) return;
            const now = Date.now();
            for (const spot of store.byCall(call)) {
                const timestamp = new Date(spot.timestamp).getTime();
                if (!Number.isFinite(timestamp)) continue;
                const survival = ttl(spot);
                if (timestamp < now - survival) continue;
                addMarkerToCell(cell, spot, survival - (now - timestamp));
            }
        } catch {
            // A rotated cell simply retries on its next history/manual refresh.
        }
    }

    async function replayHistory() {
        for (const cell of visibleCells()) {
            if (cell.call && state.monitoring) await replayCellHistory(cell);
        }
    }

    function setCellCall(cell, call) {
        if (cell.call === call) return;
        if (cell.call) clearCell(cell);
        cell.call = call;
        cell.callLabel.textContent = call || '—';
        cell.hint.style.display = call ? 'none' : '';
        fitWorld(cell.map);
        if (call && state.monitoring) void replayCellHistory(cell);
    }

    function assignCalls() {
        const calls = state.callsigns.filter(Boolean);
        visibleCells().forEach((cell, index) => {
            setCellCall(cell, index < calls.length ? calls[(index + state.rotation.offset) % calls.length] : '');
        });
        state.cells.forEach(cell => {
            if (cell.el.style.display === 'none') setCellCall(cell, '');
        });
    }

    function updateRotateUI() {
        const button = $('#btnRotate');
        if (!button) return;
        const pages = rotationPages(), needed = pages > 1;
        button.disabled = !needed;
        $('#btnRotateNext').disabled = !needed;
        button.classList.toggle('running', state.rotation.running);
        button.textContent = state.rotation.running ? ctx.t('stopRot') : ctx.t('startRot');
        $('#rotPage').textContent = needed ? `${state.rotation.offset % pages + 1}/${pages}` : '';
    }

    function stopRotation() {
        state.rotation.running = false;
        clearInterval(state.rotation.timer);
        state.rotation.timer = null;
    }

    function rotateStep() {
        if (!rotationNeeded()) return;
        state.rotation.offset++;
        assignCalls();
        updateRotateUI();
    }

    function startRotation() {
        if (!rotationNeeded() || state.rotation.running) return;
        state.rotation.running = true;
        state.rotation.timer = setInterval(rotateStep, Math.max(3, state.rotation.intervalSec) * 1000);
        updateRotateUI();
    }

    function restartRotationTimer() {
        if (!state.rotation.running) return;
        clearInterval(state.rotation.timer);
        state.rotation.timer = setInterval(rotateStep, Math.max(3, state.rotation.intervalSec) * 1000);
    }

    function setLayout(layout, persist = true) {
        state.layout = layout;
        if (persist && ctx.settings.layout !== layout) {
            ctx.settings.layout = layout;
            ctx.saveSettings();
        }
        $('#grid').className = `grid layout-${layout}`;
        const count = Number(layout[0]) * Number(layout[2]);
        state.cells.forEach((cell, index) => { cell.el.style.display = index < count ? '' : 'none'; });
        setTimeout(() => state.cells.forEach(cell => {
            if (cell.el.style.display !== 'none' && cell.map) {
                cell.map.invalidateSize();
                fitCellView(cell);
            }
        }), 50);
        $$('.layout-btn').forEach(button => button.classList.toggle('active', button.dataset.layout === layout));
        if (!rotationNeeded()) {
            state.rotation.offset = 0;
            stopRotation();
        }
        assignCalls();
        updateRotateUI();
    }

    function createCell(index) {
        const element = document.createElement('div');
        element.className = 'cell';
        element.dataset.index = index;
        element.innerHTML = `<div class="cell-header"><span class="call-label">—</span><span class="spot-count">0</span><button class="clear-cell-btn" title="Clear map">×</button></div><div class="cell-info"></div><div class="map"></div><div class="cell-empty-hint"><span class="hint-icon">📡</span>${ctx.t('cellHint')}</div>`;
        const base = createBaseMap(element.querySelector('.map'), {L, provider: ctx.settings.tiles});
        const terminator = createTerminator(base.map, {L, shifts: [0]});
        const cell = {
            index, call: '', map: base.map, base, terminator, markers: [], count: 0,
            bandInfo: {}, heat: {}, activeBand: null, bandPinned: false, seen: new Set(),
            el: element, callLabel: element.querySelector('.call-label'),
            countEl: element.querySelector('.spot-count'), hint: element.querySelector('.cell-empty-hint'),
            info: element.querySelector('.cell-info')
        };
        element.querySelector('.clear-cell-btn').addEventListener('click', () => clearCell(cell));
        cell.info.addEventListener('click', event => {
            const chip = event.target.closest('.ci-chip');
            if (chip) selectBand(cell, chip.dataset.band);
        });
        return cell;
    }

    function applyCallsigns(calls) {
        const next = (calls || []).map(call => String(call || '').toUpperCase());
        const changed = next.length !== state.callsigns.length || next.some((call, i) => call !== state.callsigns[i]);
        state.callsigns = next;
        if (changed) {
            state.rotation.offset = 0;
            if (!rotationNeeded()) stopRotation();
            assignCalls();
        }
        updateRotateUI();
        updateMonitorBtn();
        ctx.records?.populateCallSelect();
    }

    function hasAnyCallsign() {
        return state.callsigns.some(Boolean);
    }

    function updateMonitorBtn() {
        const button = $('#btnMonitor');
        button.classList.toggle('running', state.monitoring);
        button.textContent = state.monitoring ? ctx.t('stopMon') : ctx.t('startMon');
        button.disabled = !state.monitoring && !hasAnyCallsign();
        button.title = hasAnyCallsign() || state.monitoring ? '' : ctx.t('needCall');
    }

    async function setMonitoring(on) {
        if (on && !hasAnyCallsign()) return;
        if (!on && state.cells.some(cell => cell.markers.length)) {
            const clear = await showConfirm(ctx, ctx.t('askClearMarks'), {title: ctx.t('stopMon')});
            if (clear) state.cells.forEach(clearCell);
        }
        state.monitoring = Boolean(on);
        localStorage.setItem('dxcompass-monitoring', on ? '1' : '0');
        await ctx.monitoring.set(on);
        updateMonitorBtn();
        if (on) void replayHistory();
    }

    function handleSpot(spot) {
        if (!spot || (!spot.monitored_call && !spot.call) || !state.monitoring) return;
        if (!store.ingest(spot)) return;
        const call = String(spot.monitored_call || spot.call || '').toUpperCase();
        const isMySpot = ctx.settings.myCall && call === ctx.settings.myCall;
        if (isMySpot) ctx.qso?.addMySpot(spot);
        state.totalSpots++;
        $('#spotCount').textContent = ctx.t('spotsN')(state.totalSpots);
        const cell = state.cells.find(item => item.call && item.call.toUpperCase() === call);
        if (cell) {
            addMarkerToCell(cell, spot);
            const selected = $('#recordCallSelect').value;
            if (selected === call || selected === '') ctx.records?.refreshSoon();
        }
        ctx.qso?.showSpotAlert(spot, call, isMySpot);
    }

    function setTileProvider(key) {
        state.cells.forEach(cell => cell.base.setTileProvider(key));
    }

    function applyBandColors() {
        for (const cell of state.cells) {
            for (const group of cell.markers) {
                for (const layer of group.layers) {
                    if (layer instanceof L.Polyline) layer.setStyle({color: color(group._spot.band)});
                }
            }
            if (Object.keys(cell.bandInfo).length) renderCellInfo(cell);
        }
    }

    function refreshMaps() {
        visibleCells().forEach(cell => {
            cell.map.invalidateSize();
            fitCellView(cell);
        });
    }

    function applyLang() {
        state.cells.forEach(cell => {
            cell.hint.innerHTML = `<span class="hint-icon">📡</span>${ctx.t('cellHint')}`;
            if (Object.keys(cell.bandInfo).length) renderCellInfo(cell);
        });
        setConnState(state.connState);
        updateMonitorBtn();
        updateRotateUI();
    }

    function tick(now = Date.now()) {
        state.cells.forEach(cell => {
            cell.markers.forEach(group => applyMarkerFade(group, now));
            Object.keys(cell.heat).forEach(band => updateHeat(cell, band, now));
        });
    }

    function prune(now = Date.now()) {
        state.cells.forEach(cell => {
            let changed = false;
            Object.keys(cell.bandInfo).forEach(band => {
                if (now - cell.bandInfo[band].addedAt > ttl(cell.bandInfo[band].spot)) {
                    delete cell.bandInfo[band];
                    changed = true;
                }
            });
            if (Object.keys(cell.bandInfo).length) renderCellInfo(cell);
            else if (changed) cell.info.innerHTML = '';
            if (changed) refreshActiveBand(cell);
        });
    }

    function init() {
        const grid = $('#grid');
        for (let index = 0; index < MAX_CELLS; index++) {
            const cell = createCell(index);
            state.cells.push(cell);
            grid.appendChild(cell.el);
        }
        setLayout(ctx.settings.layout, false);
        $('#rotSec').value = state.rotation.intervalSec;
    }

    return {
        state, store, init, applyCallsigns, applyLang, applyBandColors, setConnState,
        setLayout, setMonitoring, updateMonitorBtn, handleSpot, replayHistory,
        setTileProvider, refreshMaps, fitCellView, visibleCells, clearCell,
        startRotation, stopRotation, rotateStep, restartRotationTimer, updateRotateUI,
        tick, prune, dotIcon, applyMarkerFade,
        setRotationInterval(value) {
            state.rotation.intervalSec = Math.min(600, Math.max(3, value || 3));
            $('#rotSec').value = state.rotation.intervalSec;
            localStorage.setItem('dxcompass-rot-sec', String(state.rotation.intervalSec));
            restartRotationTimer();
        }
    };
}
