import {getLeaflet} from '../../shared/map/leaflet.mjs';
import {AUTO_FIT_MAX_ZOOM, createBaseMap, fitPoints, fitWorld, setWorldMinZoom} from '../../shared/map/base-map.mjs';
import {createTerminator} from '../../shared/map/terminator.mjs';
import {addTrackPaths} from '../../shared/map/layers.mjs';
import {greatCirclePaths} from '../../shared/geo/great-circle.mjs';
import {gridToLatLon} from '../../shared/geo/maidenhead.mjs';
import {createQsoStore, fetchQsos} from '../../shared/data/qsos.mjs';
import {applyStationMessage, getStationState} from '../../shared/data/station.mjs';
import {bandColorOf, bandLabel, dbRowToQso} from '../settings-model.mjs';
import {formatDuration} from '../../shared/core/clock.mjs';
import {$, $$, escapeHtml, timeAgo} from '../ui.mjs';

const SPOT_ALERT_MS = 8000;
const QSO_RATE_BUCKET_MS = 5 * 60000;
const QSO_RATE_BUCKETS = 12;
const QSO_MIN_BUCKETS = 30;
const VOICE_LANGS = {
    zh: 'zh-CN', en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES',
    pt: 'pt-PT', ru: 'ru-RU', it: 'it-IT', ar: 'ar-SA', ko: 'ko-KR', ja: 'ja-JP'
};
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
        radios: {}, station: {radio: null, radios: {}, score: null}
    };
    let alertTimer = null;
    const lastSpotByCall = new Map();
    const home = () => gridToLatLon(ctx.settings.grid);
    const color = band => bandColorOf(ctx.settings, band);

    function init() {
        const element = document.createElement('div');
        element.className = 'qso-map';
        $('#qsoView').appendChild(element);
        state.base = createBaseMap(element, {L, provider: ctx.settings.tiles});
        state.map = state.base.map;
        state.terminator = createTerminator(state.map, {L, shifts: [0]});
        fitWorld(state.map);
        rebuildHome();
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
        fitPoints(state.map, points, {L, maxZoom: AUTO_FIT_MAX_ZOOM});
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
            const paths = greatCirclePaths(point[0], point[1], qso.lat, qso.lon, 64);
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

    function addMySpot(spot) {
        if (!state.map) return;
        const lat = Number(spot.lat), lon = Number(spot.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const key = mySpotKey(spot), old = state.mySpots.get(key);
        if (old) old.layers.forEach(layer => state.map.removeLayer(layer));
        const layers = [], point = home();
        if (point) {
            layers.push(...addTrackPaths(state.map,
                greatCirclePaths(point[0], point[1], lat, lon, 64),
                {L, color: '#e74c3c', weight: 2, opacity: 0.9, interactive: false}));
        }
        const marker = L.marker([lat, lon], {icon: ctx.spot.dotIcon('#e74c3c', 12)}).addTo(state.map);
        marker.bindTooltip([spot.spot_call, bandLabel(spot.band, Number(spot.freq)), spot.mode]
            .filter(Boolean).join(' · '), {direction: 'top'});
        layers.push(marker);
        const now = Date.now(), survival = ctx.settings.mySpotTtl * 60000;
        const entry = {layers, spot, _dieAt: now + survival, _bornAt: now};
        state.mySpots.set(key, entry);
        ctx.spot.applyMarkerFade(entry, now);
        trimMySpots();
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
            ts: qso.ts, operator: qso.operator || '', band: bandLabel(qso.band, qso.freqKhz)
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
        const slot = Math.floor(Date.now() / QSO_RATE_BUCKET_MS);
        const counts = new Array(QSO_RATE_BUCKETS).fill(0);
        let total = 0;
        state.allTs.forEach(timestamp => {
            if (!Number.isFinite(timestamp)) return;
            const index = QSO_RATE_BUCKETS - 1 - (slot - Math.floor(timestamp / QSO_RATE_BUCKET_MS));
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
            bar.title = `${(QSO_RATE_BUCKETS - 1 - index) * 5}–${(QSO_RATE_BUCKETS - index) * 5} min: ${count}`;
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
        const slot = Math.floor(Date.now() / 60000), counts = new Array(QSO_MIN_BUCKETS).fill(0);
        let total = 0;
        state.allTs.forEach(timestamp => {
            if (!Number.isFinite(timestamp)) return;
            const index = QSO_MIN_BUCKETS - 1 - (slot - Math.floor(timestamp / 60000));
            if (index >= 0 && index < QSO_MIN_BUCKETS) {
                counts[index]++;
                total++;
            }
        });
        const max = Math.max(1, ...counts), chart = $('#qMinChart');
        chart.textContent = '';
        counts.forEach((count, index) => {
            const bar = document.createElement('div');
            bar.className = 'qso-min-bar';
            bar.title = `${QSO_MIN_BUCKETS - 1 - index} min: ${count}`;
            const fill = document.createElement('div');
            fill.className = 'qso-min-fill';
            fill.style.height = `${Math.max(count ? 6 : 1, count / max * 100)}%`;
            if (count) fill.classList.add('has-qso');
            bar.appendChild(fill);
            chart.appendChild(bar);
        });
        $('#qMinSum').textContent = `${total} QSO · ${(total / QSO_MIN_BUCKETS).toFixed(1)}/min`;
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
        const operators = new Map(), bands = new Map();
        state.all.forEach(value => {
            const operator = value.operator || '—', band = value.band || '—';
            operators.set(operator, (operators.get(operator) || 0) + 1);
            bands.set(band, (bands.get(band) || 0) + 1);
        });
        renderDist($('#qOpDist'), operators, false);
        renderDist($('#qBandDist'), bands, true);
    }

    function radioNumbers(active) {
        const numbers = Object.keys(state.radios).map(Number).filter(number => number > 0).sort((a, b) => a - b);
        const current = active && active.radioNr ? active.radioNr : 0;
        if (current && !numbers.includes(current)) numbers.push(current);
        if (!numbers.length) numbers.push(1);
        return numbers.sort((a, b) => a - b);
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
        $('#qtOp').textContent = qso && qso.operator || radio && radio.opCall || '—';
        let text = '';
        if (ctx.settings.category !== 'SO1R') {
            text = radioNumbers(radio).map(number => {
                const item = state.radios[number];
                return item && typeof item.freqKhz === 'number' ? `R${number} ${item.freqKhz.toFixed(2)}` : '';
            }).filter(Boolean).join(' / ');
            if (text) text = `${ctx.settings.category} · ${text}`;
        }
        $('#qtRadios').textContent = text;
        updateQsoAge();
    }

    function renderQsoHero(active) {
        const multi = ctx.settings.category !== 'SO1R';
        $('#qsoHero').innerHTML = radioNumbers(active).map(number => {
            const radio = state.radios[number] ||
                (active && number === (active.radioNr || 0) ? active : null) || {};
            const frequency = typeof radio.freqKhz === 'number' && Number.isFinite(radio.freqKhz)
                ? radio.freqKhz.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '--.--';
            const subtitle = [radio.opCall, radio.radioName].filter(Boolean).join(' · ');
            return `<div class="qso-radio-card"><div class="qso-freq-row">${multi ? `<span class="qr-badge">R${number}</span>` : ''}<span class="qso-freq">${frequency}</span><span class="qso-unit">kHz</span><span class="st-mode">${escapeHtml(radio.mode || '---')}</span><span class="st-tx${radio.isTransmitting ? '' : ' hidden'}">${escapeHtml(ctx.t('stTx'))}</span></div><div class="qso-opcall">${escapeHtml(subtitle)}</div></div>`;
        }).join('');
    }

    function renderQsoPanel() {
        renderQsoTopbar();
        renderQsoHero(state.radio);
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
        }
        renderQsoPanel();
    }

    async function loadStation() {
        try {
            const station = await getStationState();
            if (station && station.radios) state.radios = station.radios;
            if (station && station.radio) state.radio = station.radio;
            if (station && station.score) state.score = station.score;
            state.station = station || state.station;
            renderQsoPanel();
        } catch {
            // Station state is optional while N1MM has not sent anything.
        }
        try {
            const rows = await fetchQsos({limit: 500});
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
        if (!text || !('speechSynthesis' in window)) return;
        try {
            speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = VOICE_LANGS[ctx.settings.lang] || 'en-US';
            utterance.rate = 1.05;
            utterance.volume = 1;
            speechSynthesis.speak(utterance);
        } catch {
            // Speech is optional and can be disabled by the browser.
        }
    }

    function hideSpotAlert() {
        clearTimeout(alertTimer);
        alertTimer = null;
        $('#spotAlert').classList.add('hidden');
    }

    function hideSpotAlertAndVoice() {
        hideSpotAlert();
        if ('speechSynthesis' in window) speechSynthesis.cancel();
    }

    function fillAlert(spot, call, own) {
        const box = $('#spotAlert');
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
        alertTimer = setTimeout(hideSpotAlert, SPOT_ALERT_MS);
    }

    function showSpotAlert(spot, call, own) {
        if (state.view !== 'qso') return;
        if (own) {
            if (ctx.settings.mySpotVoice) speakAlert(String(ctx.t('voiceMySpot')));
            if (ctx.settings.mySpotPopup) fillAlert(spot, call, true);
            return;
        }
        if (!ctx.settings.qsoSpotAlert) return;
        fillAlert(spot, call, false);
        const previous = lastSpotByCall.get(call), frequency = Number(spot.freq);
        let phrase = ctx.t('voiceNewSpot');
        if (previous) {
            if (previous.band && spot.band && previous.band !== spot.band) phrase = ctx.t('voiceChangeBand');
            else if (Number.isFinite(previous.freq) && Number.isFinite(frequency) && Math.abs(frequency - previous.freq) > 1) {
                phrase = ctx.t('voiceNewFreq');
                lastSpotByCall.set(call, {band: spot.band, freq: frequency});
            }
        }
        if (!previous || phrase === ctx.t('voiceChangeBand')) {
            lastSpotByCall.set(call, {band: spot.band, freq: frequency});
        }
        if (ctx.settings.qsoVoiceAlert) speakAlert(String(phrase).replace(/\{call\}/g, spellCall(call)));
    }

    function setViewMode(mode) {
        if (state.view === mode) return;
        const leaving = state.view;
        state.view = mode;
        const isQso = mode === 'qso', isProp = mode === 'prop';
        $('#grid').classList.toggle('hidden', isQso || isProp);
        $('#qsoView').classList.toggle('hidden', !isQso);
        $('#propView').classList.toggle('hidden', !isProp);
        $('#recordsPanel').classList.toggle('hidden', isQso || isProp);
        $('#qsoPanel').classList.toggle('hidden', !isQso);
        $('#btnSpotView').classList.toggle('active', mode === 'spots');
        $('#btnQsoView').classList.toggle('active', isQso);
        $('#btnPropView').classList.toggle('active', isProp);
        document.body.classList.toggle('qso-mode', isQso);
        document.body.classList.toggle('prop-mode', isProp);
        if (leaving === 'prop' && !isProp) ctx.prop?.hide();
        if (isQso) {
            state.map.invalidateSize();
            fitQsoMap();
            renderQsoPanel();
        } else if (isProp) {
            ctx.prop?.show();
        } else {
            hideSpotAlertAndVoice();
            ctx.spot.refreshMaps();
        }
        ctx.settingsPage?.closeAppMenu();
    }

    function refreshMap() {
        if (state.map) {
            state.map.invalidateSize();
            fitQsoMap();
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
        addMySpot, clearMySpots, applyMySpotLimits, showSpotAlert,
        hideSpotAlert, hideSpotAlertAndVoice, tick
    };
}
