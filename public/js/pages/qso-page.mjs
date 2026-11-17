import {getLeaflet} from '../../shared/map/leaflet.mjs';
import {createBaseMap, fitPoints, fitWorld, setWorldMinZoom} from '../../shared/map/base-map.mjs';
import {createTerminator} from '../../shared/map/terminator.mjs';
import {addTrackPaths} from '../../shared/map/layers.mjs';
import {greatCirclePaths} from '../../shared/geo/great-circle.mjs';
import {gridToLatLon} from '../../shared/geo/maidenhead.mjs';
import {createQsoStore, fetchQsos} from '../../shared/data/qsos.mjs';
import {fetchSpots} from '../../shared/data/spots.mjs';
import {applyStationMessage, getStationState} from '../../shared/data/station.mjs';
import {bandColorOf, bandLabel, dbRowToQso} from '../settings-model.mjs';
import {formatDuration} from '../../shared/core/clock.mjs';
import {quietHoursActive} from '../../shared/monitoring/quiet-hours.mjs';
import {MySpotBatcher, MY_SPOT_WINDOW_MS} from '../../shared/alerts/my-spot-batch.mjs';
import {$, $$, escapeHtml, timeAgo} from '../ui.mjs';

const QSO_RATE_BUCKETS = 12;
const ICAO_ALPHABET = {
    A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot',
    G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima',
    M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
    S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey',
    X: 'X-ray', Y: 'Yankee', Z: 'Zulu', '0': 'Zero', '1': 'One', '2': 'Two',
    '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine'
};

export function createQsoPage(ctx) {
    const L = getLeaflet();
    const store = createQsoStore();
    const state = {
        view: 'spots', map: null, base: null, terminator: null, homeLayer: null,
        qsos: [], byId: new Map(), latestId: null, mySpots: new Map(),
        allTs: new Map(), all: new Map(), radio: null, score: null, lastQso: null,
        radios: {}, seats: [], station: {radio: null, radios: {}, seats: [], score: null}
    };
    let alertTimer = null;
    /* 「我的 SPOT」在 30 秒窗口内合并为一次告警。 */
    const mySpotBatcher = new MySpotBatcher(MY_SPOT_WINDOW_MS);
    let mySpotTimer = null;
    let mySpotLatest = null;
    const home = () => gridToLatLon(ctx.settings.grid);
    const color = band => bandColorOf(ctx.settings, band);
    const settingNumber = (key, fallback, min, max) => {
        const value = Number(ctx.settings && ctx.settings[key]);
        if (!Number.isFinite(value)) return fallback;
        return Math.min(max, Math.max(min, value));
    };
    const rateBucketMin = () => settingNumber('rateBucketMin', 5, 1, 30);
    const minBuckets = () => Math.round(settingNumber('minBuckets', 30, 6, 120));
    const gcSamples = () => settingNumber('gcSamples', 64, 16, 128);
    const fitMaxZoom = () => settingNumber('autoFitMaxZoom', 7, 3, 10);
    const fitPadding = () => settingNumber('fitPad', 0.08, 0, 0.3);
    const historyLimit = () => Math.round(settingNumber('qsoHistoryLimit', 500, 100, 2000));
    const terminatorOptions = () => ({
        L,
        shifts: [0],
        intervalMs: settingNumber('terminatorSec', 60, 30, 600) * 1000,
        visible: ctx.settings.terminatorShow !== false
    });

    function alertAllowed(spot) {
        const minSnr = settingNumber('alertSnrMin', -30, -30, 30);
        const minDistance = settingNumber('alertDistanceKmMin', 0, 0, 20000);
        if (minSnr > -30 && typeof spot.snr === 'number' && spot.snr < minSnr) return false;
        const distance = Number(spot.distance_km);
        if (minDistance > 0 && Number.isFinite(distance) && distance < minDistance) return false;
        return true;
    }

    /* Quiet hours use the browser's local clock; the helper treats an end
     * before the start as a window across midnight. */
    function inQuietHours(now = new Date()) {
        return quietHoursActive(ctx.settings.quietFrom, ctx.settings.quietTo, now);
    }

    let toneContext = null;
    function playAlertTone() {
        if (!ctx.settings.alertSound) return;
        const volume = settingNumber('alertSoundVolume', 0.5, 0, 1);
        if (!volume) return;
        try {
            const AudioCtor = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtor) return;
            toneContext = toneContext || new AudioCtor();
            if (toneContext.state === 'suspended') void toneContext.resume();
            const oscillator = toneContext.createOscillator();
            const gain = toneContext.createGain();
            const start = toneContext.currentTime;
            oscillator.type = 'sine';
            oscillator.frequency.value = 880;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * 0.3), start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
            oscillator.connect(gain);
            gain.connect(toneContext.destination);
            oscillator.start(start);
            oscillator.stop(start + 0.2);
        } catch {
            // Optional tone; blocked or unsupported audio is ignored.
        }
    }

    function init() {
        const element = document.createElement('div');
        element.className = 'qso-map';
        $('#qsoView').appendChild(element);
        state.base = createBaseMap(element, {L, provider: ctx.settings.tiles});
        state.map = state.base.map;
        state.terminator = createTerminator(state.map, terminatorOptions());
        fitWorld(state.map);
        rebuildHome();
        void loadMySpots();
    }

    function rebuildHome() {
        if (!state.map) return;
        if (state.homeLayer) state.map.removeLayer(state.homeLayer);
        state.homeLayer = null;
        const point = home();
        if (point) {
            state.homeLayer = L.marker(point, {
                interactive: false,
                icon: L.divIcon({
                    className: 'qso-home',
                    html: '<span style="color:#00e5ff;font-size:16px;text-shadow:0 0 6px #00e5ff">✦</span>',
                    iconSize: [16, 16], iconAnchor: [8, 8]
                })
            }).addTo(state.map);
        }
    }

    function fitQsoMap() {
        if (!state.map) return;
        setWorldMinZoom(state.map);
        if (!ctx.settings.qsoAutoFit) return;
        const points = state.qsos.filter(q => q.lat !== null && q.lat !== undefined &&
            q.lon !== null && q.lon !== undefined).map(q => [q.lat, q.lon]);
        const point = home();
        if (point) points.push(point);
        fitPoints(state.map, points, {L, maxZoom: fitMaxZoom(), pad: fitPadding()});
    }

    function scheduleQsoFit() {
        if (state.view !== 'qso') return;
        clearTimeout(state._fitTimer);
        state._fitTimer = setTimeout(fitQsoMap, 150);
    }

    function qsoTooltip(qso) {
        const timestamp = new Date(qso.ts);
        return [qso.call, [bandLabel(qso.band, qso.freqKhz), qso.mode].filter(Boolean).join(' '),
            Number.isNaN(timestamp.getTime()) ? '' : timeAgo(ctx, timestamp),
            qso.isMult ? 'MULT' : ''].filter(Boolean).join(' · ');
    }

    function removeQsoMarker(id) {
        const entry = state.byId.get(id);
        if (!entry || !state.map) return;
        entry.layers.forEach(layer => {
            if (state.map.hasLayer(layer)) state.map.removeLayer(layer);
        });
        state.byId.delete(id);
        if (state.latestId === id) state.latestId = null;
    }

    function addQsoMarker(qso) {
        if (!state.map || qso.lat === null || qso.lat === undefined ||
            qso.lon === null || qso.lon === undefined) return;
        removeQsoMarker(qso.n1mmId);
        state.qsos = state.qsos.filter(item => item.n1mmId !== qso.n1mmId);
        const hex = color(qso.band), layers = [], lines = [];
        const point = home();
        if (point && ctx.settings.qsoLines) {
            const paths = greatCirclePaths(point[0], point[1], qso.lat, qso.lon, gcSamples());
            const track = addTrackPaths(state.map, paths, {
                L, color: hex, weight: 1.5, opacity: 0.55, interactive: false
            });
            layers.push(...track);
            lines.push(...track);
        }
        const marker = L.marker([qso.lat, qso.lon], {
            icon: L.divIcon({
                className: 'qso-dot-wrap',
                html: `<div class="qso-dot" style="background:${hex}">${qso.isMult ? '<span class="qso-mult-badge">M</span>' : ''}</div>`,
                iconSize: [12, 12], iconAnchor: [6, 6]
            })
        }).addTo(state.map);
        marker.bindTooltip(qsoTooltip(qso), {direction: 'top'});
        layers.push(marker);
        state.byId.set(qso.n1mmId, {layers, lines, color: hex});
        state.qsos.push(qso);
        while (state.qsos.length > ctx.settings.qsoMax) removeQsoMarker(state.qsos.shift().n1mmId);
        scheduleQsoFit();
    }

    function markLatestQso(id) {
        if (!id || state.latestId === id) return;
        const old = state.byId.get(state.latestId);
        if (old) old.lines.forEach(line => line.setStyle({color: old.color, weight: 1.5, opacity: 0.55}));
        state.latestId = id;
        const current = state.byId.get(id);
        if (current) current.lines.forEach(line => line.setStyle({color: '#2ecc71', weight: 2.5, opacity: 0.95}));
    }

    function mySpotKey(spot) {
        if (spot.spot_id !== null && spot.spot_id !== undefined) return `id${spot.spot_id}`;
        return [spot.spot_call || '?', spot.band || '', spot.freq || '', spot.timestamp || ''].join('|');
    }

    /* bornAt lets history/backfill restore the spot's real age so a reloaded
     * page keeps the remaining part of mySpotTtl instead of extending it. */
    function addMySpot(spot, bornAt) {
        if (!state.map) return;
        const lat = Number(spot.lat), lon = Number(spot.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const now = Date.now(), survival = ctx.settings.mySpotTtl * 60000;
        const born = Number.isFinite(bornAt) ? Math.min(now, bornAt) : now;
        if (now - born >= survival) return;
        const key = mySpotKey(spot), old = state.mySpots.get(key);
        if (old) old.layers.forEach(layer => state.map.removeLayer(layer));
        const layers = [], point = home();
        if (point) {
            layers.push(...addTrackPaths(state.map,
                greatCirclePaths(point[0], point[1], lat, lon, gcSamples()),
                {L, color: '#e74c3c', weight: 2, opacity: 0.9, interactive: false}));
        }
        const marker = L.marker([lat, lon], {icon: ctx.spot.dotIcon('#e74c3c', 12)}).addTo(state.map);
        marker.bindTooltip([spot.spot_call, bandLabel(spot.band, Number(spot.freq)), spot.mode]
            .filter(Boolean).join(' · '), {direction: 'top'});
        layers.push(marker);
        const entry = {layers, spot, _dieAt: born + survival, _bornAt: born};
        state.mySpots.set(key, entry);
        ctx.spot.applyMarkerFade(entry, now);
        trimMySpots();
    }

    /* 本台被播报的记录不随页面刷新消失：按当前呼号补一次历史，只保留
     * 仍在 mySpotTtl 内的行（与大屏「我的 SPOT」层同一数据源）。 */
    async function loadMySpots() {
        const my = String(ctx.settings.myCall || '').trim().toUpperCase();
        if (!my) return;
        let rows;
        try {
            rows = await fetchSpots({call: my, limit: 100});
        } catch {
            return;
        }
        if (!Array.isArray(rows) || !state.map) return;
        if (String(ctx.settings.myCall || '').trim().toUpperCase() !== my) return;
        rows.forEach(row => {
            const born = new Date(row.timestamp).getTime();
            if (Number.isFinite(born)) addMySpot(row, born);
        });
    }

    function trimMySpots() {
        if (!state.map) {
            state.mySpots.clear();
            return;
        }
        while (state.mySpots.size > ctx.settings.mySpotMax) {
            const key = state.mySpots.keys().next().value;
            state.mySpots.get(key).layers.forEach(layer => state.map.removeLayer(layer));
            state.mySpots.delete(key);
        }
    }

    function applyMySpotLimits() {
        const survival = ctx.settings.mySpotTtl * 60000;
        state.mySpots.forEach(entry => { entry._dieAt = entry._bornAt + survival; });
        trimMySpots();
        fadeMySpots(Date.now());
    }

    function clearMySpots() {
        if (state.map) state.mySpots.forEach(entry => entry.layers.forEach(layer => state.map.removeLayer(layer)));
        state.mySpots.clear();
    }

    function fadeMySpots(now) {
        if (!state.map) return;
        state.mySpots.forEach((entry, key) => {
            if (now >= entry._dieAt) {
                entry.layers.forEach(layer => state.map.removeLayer(layer));
                state.mySpots.delete(key);
            } else ctx.spot.applyMarkerFade(entry, now);
        });
    }

    function rebuildQsoMap() {
        if (!state.map) return;
        const qsos = state.qsos.slice(), latest = state.latestId;
        [...state.byId.keys()].forEach(removeQsoMarker);
        state.qsos = [];
        qsos.forEach(addQsoMarker);
        state.latestId = null;
        if (latest) markLatestQso(latest);
        const spots = [...state.mySpots.values()].filter(entry => Date.now() < entry._dieAt);
        clearMySpots();
        for (const old of spots) {
            addMySpot(old.spot);
            const current = state.mySpots.get(mySpotKey(old.spot));
            if (current) {
                current._dieAt = old._dieAt;
                current._bornAt = old._bornAt;
                ctx.spot.applyMarkerFade(current, Date.now());
            }
        }
        rebuildHome();
        fitQsoMap();
    }

    function rememberQso(qso) {
        if (!qso.n1mmId) return;
        state.allTs.set(qso.n1mmId, new Date(qso.ts).getTime());
        state.all.set(qso.n1mmId, {
            ts: qso.ts, band: bandLabel(qso.band, qso.freqKhz)
        });
    }

    function handleQso(qso) {
        store.ingest(qso);
        state.lastQso = qso;
        rememberQso(qso);
        renderLastQso();
        addQsoMarker(qso);
        if (qso.n1mmId) markLatestQso(qso.n1mmId);
        renderQsoPanel();
    }

    function handleQsoDelete(message) {
        store.remove(message);
        removeQsoMarker(message.n1mmId);
        state.allTs.delete(message.n1mmId);
        state.all.delete(message.n1mmId);
        const index = state.qsos.findIndex(qso => qso.n1mmId === message.n1mmId);
        if (index >= 0) state.qsos.splice(index, 1);
        renderQsoPanel();
    }

    function renderLastQso() {
        const qso = state.lastQso;
        if (!qso) return;
        const timestamp = new Date(qso.ts);
        $('#qLastCall').textContent = qso.call || '—';
        $('#qLastInfo').textContent = [bandLabel(qso.band, qso.freqKhz), qso.mode,
            Number.isNaN(timestamp.getTime()) ? '' : timeAgo(ctx, timestamp)].filter(Boolean).join(' · ');
    }

    function renderQsoRate() {
        const bucketMin = rateBucketMin(), bucketMs = bucketMin * 60000;
        const slot = Math.floor(Date.now() / bucketMs);
        const counts = new Array(QSO_RATE_BUCKETS).fill(0);
        let total = 0;
        state.allTs.forEach(timestamp => {
            if (!Number.isFinite(timestamp)) return;
            const index = QSO_RATE_BUCKETS - 1 - (slot - Math.floor(timestamp / bucketMs));
            if (index >= 0 && index < QSO_RATE_BUCKETS) {
                counts[index]++;
                total++;
            }
        });
        const max = Math.max(1, ...counts), chart = $('#qRateChart');
        chart.textContent = '';
        counts.forEach((count, index) => {
            const bar = document.createElement('div');
            bar.className = 'qso-rate-bar';
            bar.title = `${(QSO_RATE_BUCKETS - 1 - index) * bucketMin}–${(QSO_RATE_BUCKETS - index) * bucketMin} min: ${count}`;
            const fill = document.createElement('div');
            fill.className = 'qso-rate-fill';
            fill.style.height = `${Math.max(count ? 6 : 1, count / max * 100)}%`;
            if (count) fill.classList.add('has-qso');
            bar.appendChild(fill);
            chart.appendChild(bar);
        });
        $('#qRateSum').textContent = `${total} QSO · ${total}/h`;
    }

    function renderQsoMinute() {
        const buckets = minBuckets();
        const slot = Math.floor(Date.now() / 60000), counts = new Array(buckets).fill(0);
        let total = 0;
        state.allTs.forEach(timestamp => {
            if (!Number.isFinite(timestamp)) return;
            const index = buckets - 1 - (slot - Math.floor(timestamp / 60000));
            if (index >= 0 && index < buckets) {
                counts[index]++;
                total++;
            }
        });
        const max = Math.max(1, ...counts), chart = $('#qMinChart');
        chart.textContent = '';
        counts.forEach((count, index) => {
            const bar = document.createElement('div');
            bar.className = 'qso-min-bar';
            bar.title = `${buckets - 1 - index} min: ${count}`;
            const fill = document.createElement('div');
            fill.className = 'qso-min-fill';
            fill.style.height = `${Math.max(count ? 6 : 1, count / max * 100)}%`;
            if (count) fill.classList.add('has-qso');
            bar.appendChild(fill);
            chart.appendChild(bar);
        });
        $('#qMinSum').textContent = `${total} QSO · ${(total / buckets).toFixed(1)}/min`;
    }

    function renderDist(element, values, vertical) {
        element.textContent = '';
        const rows = [...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        if (!rows.length) {
            element.innerHTML = '<div class="qso-dist-empty">—</div>';
            return;
        }
        const max = Math.max(1, ...rows.map(row => row[1]));
        for (const [label, count] of rows) {
            if (!vertical) {
                const row = document.createElement('div');
                row.className = 'qso-dist-row';
                row.title = `${label}: ${count}`;
                const text = document.createElement('span');
                text.className = 'qso-dist-label';
                text.textContent = label;
                const bar = document.createElement('div');
                bar.className = 'qso-dist-bar';
                const fill = document.createElement('div');
                fill.className = 'qso-dist-fill';
                fill.style.width = `${Math.max(3, count / max * 100)}%`;
                bar.appendChild(fill);
                const number = document.createElement('span');
                number.className = 'qso-dist-count';
                number.textContent = count;
                row.append(text, bar, number);
                element.appendChild(row);
            } else {
                const column = document.createElement('div');
                column.className = 'qso-col';
                column.title = `${label}: ${count}`;
                const value = document.createElement('span');
                value.className = 'qso-col-val';
                value.textContent = count;
                const bar = document.createElement('div');
                bar.className = 'qso-col-bar';
                const fill = document.createElement('div');
                fill.className = 'qso-col-fill';
                fill.style.height = `${Math.max(4, count / max * 100)}%`;
                bar.appendChild(fill);
                const text = document.createElement('span');
                text.className = 'qso-col-label';
                text.textContent = label;
                column.append(value, bar, text);
                element.appendChild(column);
            }
        }
    }

    function renderQsoDist() {
        const bands = new Map();
        state.all.forEach(value => {
            const band = value.band || '—';
            bands.set(band, (bands.get(band) || 0) + 1);
        });
        renderDist($('#qBandDist'), bands, true);
    }

    /* 与 lib/devices/ownership.js 的 SEAT_HEARTBEAT_TIMEOUT_MS 一致：60 秒无报文即离线。 */
    const RADIO_HEARTBEAT_TIMEOUT_MS = 60000;

    function normalizeRadio(source, seat) {
        return {
            seat: String(seat || ''),
            radioNr: source && source.radioNr !== undefined ? String(source.radioNr || '') : '',
            freqKhz: Number(source && source.freqKhz),
            mode: source && source.mode ? String(source.mode) : '',
            isTransmitting: !!(source && source.isTransmitting === true),
            ts: (source && source.ts) || null,
            stationName: (source && source.stationName) || '',
            radioName: (source && source.radioName) || ''
        };
    }

    /**
     * 本台状态栏的数据源：服务端 /api/station/state 的 seats（N1MM RadioInfo
     * 按席位/RadioNr 区分）+ 实时 WS 报文，按 RadioNr 稳定排序，报文到达顺序不影响。
     */
    function liveRadios() {
        const bySeat = new Map();
        const merge = radio => {
            if (!radio.seat) return;
            const previous = bySeat.get(radio.seat) || {};
            bySeat.set(radio.seat, Object.assign({}, previous, radio));
        };
        for (const seat of Array.isArray(state.seats) ? state.seats : []) {
            if (seat && seat.seat) merge(normalizeRadio(seat, seat.seat));
        }
        for (const [key, message] of Object.entries(state.radios || {})) {
            if (!message || typeof message !== 'object') continue;
            merge(normalizeRadio(message, message.seat || key));
        }
        return [...bySeat.values()].sort((a, b) => {
            const an = Number(a.radioNr), bn = Number(b.radioNr);
            const av = Number.isFinite(an) ? an : Number.MAX_SAFE_INTEGER;
            const bv = Number.isFinite(bn) ? bn : Number.MAX_SAFE_INTEGER;
            if (av !== bv) return av - bv;
            return String(a.seat).localeCompare(String(b.seat));
        });
    }

    function radioOnline(radio) {
        const ts = radio && radio.ts ? Date.parse(radio.ts) : NaN;
        return Number.isFinite(ts) && Date.now() - ts <= RADIO_HEARTBEAT_TIMEOUT_MS;
    }

    function updateQsoAge() {
        const timestamp = state.lastQso ? new Date(state.lastQso.ts) : null;
        $('#qtAge').textContent = timestamp && !Number.isNaN(timestamp.getTime())
            ? formatDuration(Date.now() - timestamp.getTime()) : '--:--:--';
    }

    function renderQsoTopbar() {
        const qso = state.lastQso, radio = state.radio;
        const running = radio && typeof radio.isRunning === 'boolean' ? radio.isRunning : null;
        const badge = $('#qtRun');
        badge.textContent = running === null ? '—' : running ? 'RUN' : 'S&P';
        badge.className = `qt-run${running === null ? '' : running ? ' is-run' : ' is-sp'}`;
        const frequency = qso && typeof qso.freqKhz === 'number' ? qso.freqKhz :
            radio && typeof radio.freqKhz === 'number' ? radio.freqKhz : null;
        $('#qtFreq').textContent = frequency === null ? '--.--' : frequency.toFixed(2);
        $('#qtCall').textContent = qso && qso.call || '—';
        $('#qtRst').textContent = qso ? `${qso.rstSnt || '--'}/${qso.rstRcv || '--'}` : '--/--';
        $('#qtExch').textContent = qso && qso.exchange || '—';
        $('#qtBand').textContent = bandLabel(qso && qso.band, qso && qso.freqKhz) || '—';
        $('#qtMode').textContent = qso && qso.mode || radio && radio.mode || '—';
        let text = '';
        if (ctx.settings.category !== 'SO1R') {
            text = liveRadios()
                .filter(item => Number.isFinite(item.freqKhz))
                .map(item => `R${item.radioNr || '?'} ${item.freqKhz.toFixed(2)}`)
                .join(' / ');
            if (text) text = `${ctx.settings.category} · ${text}`;
        }
        $('#qtRadios').textContent = text;
        updateQsoAge();
    }

    function renderQsoHero() {
        const radios = liveRadios();
        if (!radios.length) {
            $('#qsoHero').innerHTML = '<div class="qso-radio-card"><div class="qso-freq-row">' +
                '<span class="qso-freq">--.--</span><span class="qso-unit">kHz</span>' +
                '<span class="st-mode">---</span></div><div class="qso-opcall"></div></div>';
            return;
        }
        $('#qsoHero').innerHTML = radios.map(radio => {
            const online = radioOnline(radio);
            const frequency = Number.isFinite(radio.freqKhz)
                ? radio.freqKhz.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})
                : '--.--';
            // 能区分是哪部电台：RadioNr 徽标 + 席位名/电台号 + 电台型号；不显示原始 seatKey。
            const identity = [
                radio.stationName || (radio.radioNr ? 'R' + radio.radioNr : ''),
                radio.radioName
            ].filter(Boolean).join(' · ');
            const classes = ['qso-radio-card'];
            if (radio.isTransmitting) classes.push('is-tx');
            if (!online) classes.push('is-offline');
            return '<div class="' + classes.join(' ') + '">' +
                '<div class="qso-freq-row">' +
                '<span class="qr-badge">R' + escapeHtml(radio.radioNr || '?') + '</span>' +
                '<span class="qso-freq">' + frequency + '</span>' +
                '<span class="qso-unit">kHz</span>' +
                '<span class="st-mode">' + escapeHtml(radio.mode || '---') + '</span>' +
                (radio.isTransmitting
                    ? '<span class="st-tx">' + escapeHtml(ctx.t('stTx')) + '</span>' : '') +
                '</div>' +
                '<div class="qso-opcall">' + escapeHtml(identity) + '</div>' +
                (online ? '' : '<div class="qso-radio-offline">' +
                    escapeHtml(ctx.t('dev.status.offline')) + '</div>') +
                '</div>';
        }).join('');
    }

    function renderQsoPanel() {
        renderQsoTopbar();
        renderQsoHero();
        const score = state.score, qso = state.lastQso;
        if (score) {
            $('#qQsos').textContent = score.qsos || 0;
            $('#qMults').textContent = score.mults || 0;
            $('#qPoints').textContent = score.points || 0;
            $('#qScore').textContent = score.score || 0;
        }
        if (qso) {
            $('#qLastCall').textContent = qso.call || '—';
            const timestamp = new Date(qso.ts);
            $('#qLastInfo').textContent = [bandLabel(qso.band, qso.freqKhz), qso.mode,
                qso.freqKhz ? qso.freqKhz.toFixed(2) : '',
                Number.isNaN(timestamp.getTime()) ? '' : timeAgo(ctx, timestamp)].filter(Boolean).join(' · ');
        }
        renderQsoRate();
        renderQsoMinute();
        renderQsoDist();
    }

    function handleStationMessage(message) {
        state.station = applyStationMessage(state.station, message);
        if (message.type === 'score') state.score = state.station.score;
        if (message.type === 'radio') {
            state.radio = state.station.radio;
            state.radios = state.station.radios;
            // 实时报文同样写进 seats，状态栏不依赖报文到达顺序。
            const key = String(message.seat || message.radioNr || '');
            if (key) {
                const list = (Array.isArray(state.seats) ? state.seats : []).slice();
                const index = list.findIndex(item => item && String(item.seat) === key);
                const entry = normalizeRadio(message, key);
                if (index >= 0) list[index] = Object.assign({}, list[index], entry);
                else list.push(entry);
                state.seats = list;
            }
        }
        renderQsoPanel();
    }

    async function loadStation() {
        try {
            const station = await getStationState();
            if (station && station.radios) state.radios = station.radios;
            if (station && Array.isArray(station.seats)) state.seats = station.seats;
            if (station && station.radio) state.radio = station.radio;
            if (station && station.score) state.score = station.score;
            state.station = station || state.station;
            renderQsoPanel();
        } catch {
            // Station state is optional while N1MM has not sent anything.
        }
        try {
            const rows = await fetchQsos({limit: historyLimit()});
            store.replay(rows);
            const qsos = store.all().map(dbRowToQso);
            for (const qso of qsos) {
                rememberQso(qso);
                if (qso.lat !== null && qso.lat !== undefined) addQsoMarker(qso);
            }
            if (rows.length) {
                state.lastQso = dbRowToQso(rows[0]);
                renderLastQso();
                renderQsoPanel();
                if (state.lastQso.n1mmId) markLatestQso(state.lastQso.n1mmId);
            }
        } catch {
            // Keep the waiting state if history is unavailable.
        }
    }

    function spellCall(call) {
        return String(call || '').toUpperCase().split('').map(character => {
            if (ICAO_ALPHABET[character]) return ICAO_ALPHABET[character];
            return character === '/' ? 'slash' : '';
        }).filter(Boolean).join(' ');
    }

    function speakAlert(text) {
        return ctx.voice ? ctx.voice.speak(text) : false;
    }

    function hideSpotAlert() {
        clearTimeout(alertTimer);
        alertTimer = null;
        $('#spotAlert').classList.add('hidden');
    }

    function hideSpotAlertAndVoice() {
        hideSpotAlert();
        clearMySpotBatch();
        if ('speechSynthesis' in window) speechSynthesis.cancel();
    }

    function fillAlert(spot, call, own, ruleNames) {
        const box = $('#spotAlert');
        const rules = $('#saRules');
        if (rules) {
            rules.textContent = ruleNames ? `${ctx.t('alTriggeredBy')}: ${ruleNames}` : '';
            rules.classList.toggle('hidden', !ruleNames);
        }
        $('#saCall').textContent = own ? ctx.settings.myCall || '—' : call || spot.call || '—';
        $('#saBand').textContent = spot.band || '';
        $('#saMode').textContent = spot.mode || '';
        $('#saFreq').textContent = spot.freq ? `${spot.freq} kHz` : '';
        const de = own ? spot.spot_call || spot.de || '' : spot.de || '';
        $('#saDe').textContent = de ? `DE ${de}` : '';
        $('#saSnr').textContent = spot.snr !== null && spot.snr !== undefined
            ? `SNR ${spot.snr} dB` : spot.signal || '';
        const timestamp = new Date(spot.timestamp);
        $('#saTime').textContent = Number.isNaN(timestamp.getTime()) ? '' : timeAgo(ctx, timestamp);
        box.style.borderLeftColor = own ? '#e74c3c' : color(spot.band);
        box.classList.remove('alert-in', 'hidden');
        void box.offsetWidth;
        box.classList.add('alert-in');
        clearTimeout(alertTimer);
        alertTimer = setTimeout(hideSpotAlert, settingNumber('alertPopupMs', 8000, 2000, 30000));
    }

    /* 「我的 SPOT」批量播报：30 秒窗口内只告警一次，N≥2 时播报「你有 N 条新 SPOT」。 */
    function mySpotsPhrase(count) {
        const text = String(ctx.t('voiceMySpots', {n: count}));
        return text === 'voiceMySpots' ? `You have ${count} new spots` : text;
    }

    function clearMySpotBatch() {
        if (mySpotTimer) clearTimeout(mySpotTimer);
        mySpotTimer = null;
        mySpotLatest = null;
        mySpotBatcher.take();
    }

    function flushMySpots() {
        if (mySpotTimer) clearTimeout(mySpotTimer);
        mySpotTimer = null;
        const batch = mySpotBatcher.take();
        const spot = mySpotLatest;
        mySpotLatest = null;
        if (!batch || !spot) return;
        /* 本台被播报与视图无关：Spot / 传播 / OP 视图都要弹窗+播报，
         * 否则停在各自主视图的操作员收不到自己被打点的提醒。 */
        if (inQuietHours() || !alertAllowed(spot)) return;
        if (ctx.settings.mySpotPopup || ctx.settings.mySpotVoice) playAlertTone();
        if (ctx.settings.mySpotPopup) fillAlert(spot, ctx.settings.myCall, true);
        if (ctx.settings.mySpotVoice) {
            speakAlert(batch.count > 1 ? mySpotsPhrase(batch.count)
                : String(ctx.t('voiceMySpot')));
        }
    }

    function queueMySpot(spot) {
        const {started} = mySpotBatcher.push(Date.now());
        mySpotLatest = spot;
        if (started) mySpotTimer = setTimeout(flushMySpots, MY_SPOT_WINDOW_MS);
    }

    /* 对手提醒已统一由服务端告警模块按 新频率 / 新频段 / 换频段 判定后下发；
     * 这里只负责「我的 SPOT」，不再对对手的新 SPOT 弹窗或播报。 */
    function showSpotAlert(spot, _call, own) {
        if (!own) return;
        queueMySpot(spot);
    }

    /* Server-side rule alert: reuses the existing card, tone, speech and quiet
     * hours. The server already applied the dedupe window and minimum interval,
     * so this only renders what it decided to deliver. */
    function showRuleAlert(alert, options) {
        const allowOp = Boolean(options && options.allowOp);
        const targeted = Array.isArray(alert && alert.seats) && alert.seats.length > 0;
        if (!alert || (!allowOp && targeted)) return;
        if (state.view !== 'qso' && !(allowOp && state.view === 'op')) return;
        if (inQuietHours()) return;
        const notify = alert.notify || {};
        if (notify.sound) playAlertTone();
        if (notify.popup !== false) {
            fillAlert({
                band: alert.band,
                mode: alert.mode,
                freq: alert.freq,
                de: alert.de,
                snr: alert.snr,
                timestamp: alert.at
            }, alert.call, false, alert.ruleNames);
        }
        if (notify.voice) {
            const key = alert.kind === 'newFreq' ? 'voiceNewFreq'
                : alert.kind === 'bandChange' ? 'voiceChangeBand'
                    : alert.kind === 'newBand' ? 'voiceAlertNewBand'
                        : alert.state === 'newMultiplier' ? 'voiceAlertNewMult' : 'voiceAlertRule';
            speakAlert(String(ctx.t(key)).replace(/\{call\}/g, spellCall(alert.call)));
        }
    }

    function setViewMode(mode) {
        if (state.view === mode) return;
        const leaving = state.view;
        state.view = mode;
        const isQso = mode === 'qso', isProp = mode === 'prop', isOp = mode === 'op', isDev = mode === 'dev';
        const isFull = isQso || isProp || isOp || isDev;
        $('#grid').classList.toggle('hidden', isFull);
        $('#qsoView').classList.toggle('hidden', !isQso);
        $('#propView').classList.toggle('hidden', !isProp);
        $('#opView').classList.toggle('hidden', !isOp);
        $('#devView').classList.toggle('hidden', !isDev);
        $('#recordsPanel').classList.toggle('hidden', isFull);
        $('#qsoPanel').classList.toggle('hidden', !isQso);
        $('#btnSpotView').classList.toggle('active', mode === 'spots');
        $('#btnQsoView').classList.toggle('active', isQso);
        $('#btnPropView').classList.toggle('active', isProp);
        $('#btnOpView').classList.toggle('active', isOp);
        $('#btnDevView').classList.toggle('active', isDev);
        document.body.classList.toggle('qso-mode', isQso);
        document.body.classList.toggle('prop-mode', isProp);
        document.body.classList.toggle('op-mode', isOp);
        document.body.classList.toggle('dev-mode', isDev);
        if (leaving === 'prop' && !isProp) ctx.prop?.hide();
        if (leaving === 'op' && !isOp) ctx.op?.hide();
        if (leaving === 'dev' && !isDev) ctx.devices?.hide();
        if (isQso) {
            state.map.invalidateSize();
            fitQsoMap();
            renderQsoPanel();
        } else if (isProp) {
            ctx.prop?.show();
        } else if (isOp) {
            hideSpotAlertAndVoice();
            ctx.op?.show();
        } else if (isDev) {
            hideSpotAlertAndVoice();
            ctx.devices?.show();
        } else {
            hideSpotAlertAndVoice();
            ctx.spot.refreshMaps();
            ctx.spot.resync();
        }
        ctx.settingsPage?.closeAppMenu();
    }

    function refreshMap() {
        if (state.map) {
            state.map.invalidateSize();
            fitQsoMap();
        }
    }

    function applyDisplaySettings() {
        state.terminator?.setVisible(ctx.settings.terminatorShow !== false);
        state.terminator?.setIntervalMs(settingNumber('terminatorSec', 60, 30, 600) * 1000);
        if (state.view === 'qso') {
            rebuildQsoMap();
            renderQsoPanel();
        }
    }

    function tick(now = Date.now()) {
        fadeMySpots(now);
        if (state.lastQso) {
            renderLastQso();
            if (state.view === 'qso') renderQsoPanel();
        }
    }

    return {
        state, store, init, loadStation, handleQso, handleQsoDelete, handleStationMessage,
        renderQsoPanel, renderLastQso, updateQsoAge, rebuildQsoMap, rebuildHome,
        fitQsoMap, refreshMap, setViewMode, setTileProvider: key => state.base.setTileProvider(key),
        addMySpot, clearMySpots, applyMySpotLimits, showSpotAlert, showRuleAlert, applyDisplaySettings,
        hideSpotAlert, hideSpotAlertAndVoice, tick
    };
}
