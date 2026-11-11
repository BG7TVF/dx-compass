/**
 * OP view controller.
 *
 * One page serves every category:
 *   SO1R / SO2R — one radio or two radios on the same page (two visual lanes).
 *   MS / MM     — station tabs at the top switch the radio shown by the page.
 *
 * The centre map is always one fixed, offline Leaflet instance. All numbers
 * come from the existing repositories; nothing is recalculated locally except
 * trivial per-radio rates over the same QSO rows.
 */
import {$, escapeHtml as esc} from '../ui.mjs';
import {CONTEST_CATEGORIES, bandLabel, dbRowToQso} from '../settings-model.mjs';
import {fetchQsos} from '../../shared/data/qsos.mjs';
import {fetchSpots} from '../../shared/data/spots.mjs';
import {getPropSnapshot, selectForecast} from '../../shared/data/propagation.mjs';
import {fetchPaths, fetchEstimate} from '../../shared/data/analysis.mjs';
import {fetchMultipliers} from '../../shared/data/multipliers.mjs';
import {fetchCallsigns, checkCallsign} from '../../shared/data/callsigns.mjs';
import {fetchAdvice} from '../../shared/data/advice.mjs';
import {buildOpponents} from '../../bigscreen/wall-opponents.mjs';
import {bandConditionCells, spaceWeatherCells, bandOf} from '../../bigscreen/wall-cards.mjs';
import {bearing} from '../../shared/geo/coordinates.mjs';
import {gridToLatLon} from '../../shared/geo/maidenhead.mjs';
import {resolveCall} from '../../shared/dxcc/callsign.mjs';
import {createOpMap} from '../op/op-map.mjs';
import {createPeripheralHub, deviceDefinitions} from '../op/peripherals.mjs';
import {changeFrequencyClaim} from '../../shared/data/station.mjs';

const REVIEW_KEY = 'dxcompass-op-call-review';
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const RADIO_THEME = {1: 'r1', 2: 'r2', 3: 'r3', 4: 'r4', 5: 'r5', 6: 'r6'};

const timeOf = value => {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
};
const compass = deg => COMPASS[Math.round((((Number(deg) || 0) % 360) + 360) % 360 / 45) % 8];
const bandKey = value => String(value || '').toUpperCase();
const mini = value => (value === null || value === undefined || value === '' ? '—' : value);

export function createOpPage(ctx) {
    const hub = createPeripheralHub();
    const state = {
        active: false,
        map: null,
        selectedSeat: 'all',
        qsos: new Map(),
        mySpots: [],
        allSpots: [],
        spotKeys: new Set(),
        monitoredCalls: null,
        opponents: [],
        prop: null,
        paths: null,
        multipliers: null,
        multBand: '',
        multExpanded: false,
        suspects: new Map(),
        review: loadReview(),
        opponentCache: new Map(),
        adviceDismissed: new Set(),
        adviceEngine: null,
        checking: null,
        multTimer: null,
        adviceTimer: null,
        rotorTarget: null,
        claimFeedback: null,
        timers: []
    };

    function t(key, params) {
        const value = ctx.t(key, params);
        return value === undefined || value === null ? key : value;
    }

    function category() {
        const value = String(ctx.settings.category || 'SO1R').toUpperCase();
        return CONTEST_CATEGORIES.includes(value) ? value : 'SO1R';
    }

    function radios() {
        return ctx.qso && ctx.qso.state && ctx.qso.state.radios || {};
    }

    function radioKeys() {
        const keys = Object.keys(radios()).sort((a, b) => {
            const an = radioNrOfKey(a);
            const bn = radioNrOfKey(b);
            return an - bn || a.localeCompare(b);
        });
        if (keys.length) return keys;
        // 还没有电台状态时保留旧占位：双 lane 组别给两个，其余给一个。
        const cat = category();
        return cat === 'SO2R' || cat === 'M2' ? ['1', '2'] : ['1'];
    }

    function radioNrOfKey(key) {
        const value = String(key || '');
        const suffix = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
        const n = Number(suffix);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    function radioOf(key) {
        return radios()[String(key)] || null;
    }

    /* 席位来自服务端 seats DTO；没有实时数据时按设置席位数与
       seatRadios 绑定生成占位，保证 M2/MM 在 N1MM 接入前也能选席位。 */
    function liveSeats() {
        const station = ctx.qso && ctx.qso.state && ctx.qso.state.station;
        return station && Array.isArray(station.seats) ? station.seats : [];
    }

    function configuredSeatRadios() {
        const bound = String(ctx.settings.seatRadios || '')
            .split(',').map(value => value.trim()).filter(Boolean);
        const count = Math.max(1, Math.min(12, Number(ctx.settings.seatCount) || 1));
        const out = [];
        for (let i = 0; i < count; i += 1) out.push(bound[i] || String(i + 1));
        return out;
    }

    function operatorRoster() {
        return String(ctx.settings.operators || '')
            .split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    }

    function seatChoices() {
        const live = liveSeats();
        if (live.length) {
            return live.map((item, index) => ({
                value: String(item.seat || item.radioNr || index + 1),
                radioNr: item.radioNr || '',
                stationName: item.stationName || '',
                operator: item.operator || '',
                index
            }));
        }
        const roster = operatorRoster();
        return configuredSeatRadios().map((radioNr, index) => ({
            value: String(radioNr), radioNr, stationName: '',
            operator: roster[index] || '', index
        }));
    }

    function seatLabel(choice) {
        if (!choice) return '';
        const parts = [choice.stationName || t('op.seat.n', {n: choice.index + 1})];
        if (choice.radioNr) parts.push(t('op.seat.radio', {n: choice.radioNr}));
        if (choice.operator) parts.push(choice.operator);
        return parts.join(' · ');
    }

    function seatNameOf(key) {
        const choice = seatChoices().find(item => item.value === String(key));
        return choice ? seatLabel(choice) : t('op.radio.n', {n: radioNrOfKey(key)});
    }

    function currentSeat() {
        const choices = seatChoices();
        if (!choices.length) return '1';
        if (state.selectedSeat === 'all' && choices.length > 1) return 'all';
        const values = choices.map(choice => choice.value);
        return values.includes(String(state.selectedSeat))
            ? String(state.selectedSeat) : values[0];
    }

    function visibleSeats() {
        const key = currentSeat();
        return key === 'all' ? seatChoices().map(choice => choice.value) : [key];
    }

    /* Empty targets are global alerts and retain the original QSO-page path.
       Seat-targeted alerts are shown only in the matching OP position. */
    function showRuleAlert(alert) {
        const targets = Array.isArray(alert && alert.seats) ? alert.seats.map(String) : [];
        if (!state.active || !targets.length) return false;
        const visible = new Set(visibleSeats());
        if (!targets.some(target => visible.has(target))) return false;
        ctx.qso.showRuleAlert(alert, {allowOp: true});
        return true;
    }

    function frequencyClaims() {
        const station = ctx.qso && ctx.qso.state && ctx.qso.state.station;
        return station && Array.isArray(station.claims) ? station.claims : [];
    }

    function radioTheme(key) {
        // M2/MM 多台实例可能都报 RadioNr=1，主题色按席位顺序分配才分得清。
        const index = seatChoices().findIndex(choice => choice.value === String(key));
        if (index >= 0) return RADIO_THEME[index + 1] || 'r6';
        return RADIO_THEME[radioNrOfKey(key)] || 'r1';
    }

    function radioName(key) {
        const radio = radioOf(key);
        if (radio && (radio.radioName || radio.name)) return radio.radioName || radio.name;
        if (radio && radio.stationName) return radio.stationName;
        return seatNameOf(key);
    }

    /* 与服务端 seatOfRow 同口径：优先 n1mm_id 命名空间，回退 stationname。 */
    function seatOfQso(qso) {
        const id = String(qso && qso.n1mmId || '');
        let instance = '';
        if (id.startsWith('DXI|')) {
            const rest = id.slice(4);
            const cut = rest.indexOf('|');
            if (cut >= 0) instance = rest.slice(0, cut);
        }
        if (!instance) {
            instance = String(qso && qso.stationName || '').trim().toUpperCase()
                .replace(/[|:]/g, '_').slice(0, 64) || 'LOCAL';
        }
        const nr = String(qso && qso.radioNr !== null && qso.radioNr !== undefined ? qso.radioNr : '1');
        return instance + ':' + nr;
    }

    function myCall() {
        return String(ctx.settings.myCall || '').trim().toUpperCase();
    }

    function homeLatLon() {
        const grid = String(ctx.settings.grid || '').trim();
        return grid ? gridToLatLon(grid) : null;
    }

    function qsoKey(qso) {
        if (qso.n1mmId !== null && qso.n1mmId !== undefined) return 'id' + qso.n1mmId;
        return [qso.call, qso.freqKhz, qso.ts].join('|');
    }

    function sortQsos() {
        state.qsos = new Map([...state.qsos.entries()]
            .sort((a, b) => timeOf(a[1].ts) - timeOf(b[1].ts)));
    }

    function addQso(raw) {
        const source = raw && raw.qso ? raw.qso : raw;
        if (!source || !source.call) return;
        const qso = source.n1mm_id !== undefined || source.radionr !== undefined
            ? dbRowToQso(source) : source;
        if (qso.radioNr === null || qso.radioNr === undefined) {
            qso.radioNr = qso.radionr === undefined ? null : qso.radionr;
        }
        state.qsos.set(qsoKey(qso), qso);
        sortQsos();
    }

    function timeOf(value) {
        const time = new Date(value).getTime();
        return Number.isFinite(time) ? time : 0;
    }

    function spotKeyOf(spot) {
        if (!spot) return '';
        return [spot.de, spot.freq, spot.timestamp].join('|');
    }

    /* Every WS spot is kept in memory: opponents are recomputed from this
       stream every few seconds instead of waiting for a one-minute poll. */
    function ingestSpot(spot) {
        const key = spotKeyOf(spot);
        if (!key || state.spotKeys.has(key)) return false;
        state.spotKeys.add(key);
        state.allSpots.push(spot);
        if (state.allSpots.length > 4000) {
            const dropped = state.allSpots.splice(0, state.allSpots.length - 4000);
            dropped.forEach(row => state.spotKeys.delete(spotKeyOf(row)));
        }
        return true;
    }

    async function loadQsos() {
        try {
            const limit = Math.min(4000, Math.max(300, Number(ctx.settings.qsoMax) || 1500));
            const rows = await fetchQsos({limit});
            state.qsos.clear();
            rows.forEach(addQso);
        } catch (error) {
            // Keep live rows; the QSO page already holds a capped local history.
            const fallback = ctx.qso && ctx.qso.state && ctx.qso.state.qsos || [];
            fallback.forEach(addQso);
            console.warn('op view: qso history unavailable', error);
        }
        renderTop();
        renderMap();
        scheduleSuspects();
    }

    function qsosFor(key) {
        const list = [...state.qsos.values()];
        if (key === 'all') return list;
        if (String(key).includes(':')) return list.filter(qso => seatOfQso(qso) === String(key));
        return list.filter(qso => String(qso.radioNr) === String(key));
    }

    function rateFor(key, minutes = 60) {
        const since = Date.now() - minutes * 60000;
        const count = qsosFor(key).filter(qso => timeOf(qso.ts) >= since).length;
        return Math.round(count * 60 / minutes);
    }

    function lastQsoFor(key) {
        const list = qsosFor(key);
        return list.length ? list[list.length - 1] : null;
    }

    function renderTop() {
        const keys = visibleSeats();
        const globalRate = rateFor('all');
        const parts = [];
        for (const key of keys) {
            const radio = radioOf(key);
            const lane = seatLane(key);
            const laneState = lane
                ? ((lane.radio && lane.radio.isRunning === false) ? 'S&P' : 'RUN') +
                    (lane.gates && lane.gates.quota
                        ? ' · chg ' + lane.changesThisHour + '/' + lane.gates.quota : '')
                : '';
            parts.push('<div class="op-metric ' + radioTheme(key) + '"><label>' +
                esc(radioName(key)) + (laneState ? ' · ' + esc(laneState) : '') +
                ' · ' + esc(t('op.top.rateNow')) +
                '</label><b>' + rateFor(key) + '</b><small>' + esc(t('op.top.perHour')) +
                '</small></div>');
            if (radio && radio.isTransmitting) {
                parts.push('<div class="op-metric ' + radioTheme(key) + '"><label>' +
                    esc(radio.freqKhz ? (bandOf(radio.freqKhz) + ' ' + mini(radio.mode)) : '') +
                    '</label><b>' + esc(t('op.radio.tx')) + '</b></div>');
            }
        }
        parts.push('<div class="op-metric"><label>' + esc(t('op.top.rateGlobal')) +
            '</label><b>' + globalRate + '</b><small>' + esc(t('op.top.perHour')) + '</small></div>');
        const lasts = keys.map(key => ({key, qso: lastQsoFor(key)}));
        const lastHtml = lasts.filter(item => item.qso).map(item =>
            '<div class="op-metric op-last ' + radioTheme(item.key) + '"><label>' +
            esc(radioName(item.key) + ' · ' + t('op.top.lastQso')) +
            '</label><b>' + esc(item.qso.call) + '</b><small>' +
            esc([bandLabel(item.qso.freqKhz || item.qso.band), item.qso.mode,
                new Date(item.qso.ts).toISOString().slice(11, 16) + 'Z'].filter(Boolean).join(' · ')) +
            '</small></div>').join('');
        parts.push(lastHtml || '<div class="op-metric op-last"><label>' +
            esc(t('op.top.lastQso')) + '</label><b>—</b><small>' + esc(t('op.top.noQso')) + '</small></div>');
        const bands = new Map();
        for (const qso of state.qsos.values()) {
            const key = bandKey(qso.band || bandLabel(qso.freqKhz));
            bands.set(key, (bands.get(key) || 0) + 1);
        }
        parts.push('<div class="op-metric op-bands-metric"><label>' + esc(t('op.top.bandCounts')) +
            '</label><div class="op-bands">' + ([...bands.entries()]
                .sort((a, b) => b[1] - a[1]).map(([band, n]) =>
                    '<span class="op-band-chip"><b>' + esc(band) + '</b>' + n + '</span>').join('') ||
                '<span class="op-band-chip">—</span>') + '</div></div>');
        $('#opMetrics').innerHTML = parts.join('');
        $('#opKicker').textContent = t('op.title');
        $('#opSubtitle').textContent = t('op.subtitle');
        renderSeatOptions();
    }

    function renderSeatOptions() {
        const select = $('#opSeat');
        const label = $('#opSeatLabel');
        if (!select) return;
        const choices = seatChoices();
        const show = choices.length > 1;
        select.classList.toggle('hidden', !show);
        if (label) {
            label.classList.toggle('hidden', !show);
            label.textContent = t('op.seat');
        }
        const current = currentSeat();
        select.innerHTML = (show ? '<option value="all">' + esc(t('op.seat.all')) + '</option>' : '') +
            choices.map(choice => '<option value="' + esc(choice.value) + '">' +
                esc(seatLabel(choice)) + '</option>').join('');
        select.value = current === 'all' && show ? 'all' : current;
    }

    function renderBands() {
        const host = $('#opBandGrid');
        if (!state.prop) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.empty.waiting')) + '</div>';
            return;
        }
        const cells = bandConditionCells(selectForecast(state.prop), new Date());
        host.innerHTML = cells.map(cell =>
            '<div class="op-band ' + cell.className + '"><b>' + esc(cell.band) + '</b>' +
            '<i>' + esc(t('wall.condition.' + cell.className)) + '</i>' +
            '<span class="op-meter">' + [0, 1, 2].map(index =>
                '<u' + (index < cell.level ? ' class="on"' : '') + '></u>').join('') +
            '</span></div>').join('') || '<div class="op-empty">' + esc(t('op.empty.waiting')) + '</div>';
    }

    function renderSpace() {
        const host = $('#opSpaceGrid');
        if (!state.prop) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.empty.waiting')) + '</div>';
            return;
        }
        host.innerHTML = spaceWeatherCells(state.prop).map(([key, value, className]) =>
            '<div><label>' + esc(key) + '</label><b class="' + esc(className) + '">' +
            esc(value) + '</b></div>').join('');
    }

    function formatKhz(value) {
        if (!isFinite(value) || !value) return '—';
        return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' kHz';
    }

    function antennaLine(antenna) {
        if (!antenna || !antenna.ok) {
            const points = antenna && antenna.points || 0;
            return {
                kind: 'insufficient',
                text: points < 6 ? t('op.opp.insufficient', {n: 6}) : t('op.opp.unknown')
            };
        }
        const probs = antenna.probabilities || {};
        const prob = Math.round(Number(probs[antenna.type] || 0) * 100);
        return {
            kind: 'inferred',
            text: t('op.antenna.' + (antenna.type || 'unknown')) + ' · ' + prob + '% · ' +
                t('op.opp.samples', {n: antenna.points || 0})
        };
    }

    /* Per-band rows: band name, latest frequency and the antenna verdict for
     * that band. The estimate endpoint computes them; the page only formats. */
    function bandLines(call) {
        const cached = state.opponentCache.get(call);
        if (!cached || cached.status === 'loading') {
            return [{band: '', freq: null, kind: 'loading', text: t('op.suspect.checking')}];
        }
        if (cached.status === 'error') {
            return [{band: '', freq: null, kind: 'unknown', text: t('op.opp.unknown')}];
        }
        const data = cached.data || {};
        const bands = Array.isArray(data.bands) ? data.bands : [];
        if (bands.length) {
            return bands.map(item => {
                const line = {band: item.band || '', freq: item.freqKhz, ...antennaLine(item.antenna)};
                if (line.kind !== 'inferred' && item.samples) {
                    line.text = t('op.opp.samples', {n: item.samples}) + ' · ' + line.text;
                }
                return line;
            });
        }
        return [{band: '', freq: null, ...antennaLine(data.antenna)}];
    }

    function renderOpponents() {
        const host = $('#opOpponents');
        const list = state.opponents.slice(0, 6);
        if (!list.length) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.left.opponents.empty')) + '</div>';
            return;
        }
        host.innerHTML = list.map(opponent => {
            const identity = resolveCall(opponent.call);
            const grid = String(opponent.grid || '').trim();
            const location = [grid || t('op.opp.unknown'), identity && identity.country ||
                (opponent.dxcc ? t('op.opp.dxcc', {name: opponent.dxcc}) : '')]
                .filter(Boolean).join(' · ');
            const targetIdentity = resolveCall(opponent.targetCall);
            const target = [
                opponent.targetCall || '',
                opponent.targetGrid || (targetIdentity && targetIdentity.country) || '',
                isFinite(opponent.bearing) ? t('op.opp.targetBearing', {deg: Math.round(opponent.bearing)}) +
                    ' ' + compass(opponent.bearing) : ''
            ].filter(Boolean).join(' · ') || t('op.opp.noData');
            const bands = bandLines(opponent.call).map(line =>
                '<div class="op-opp-band">' +
                    '<b>' + esc(line.band || '—') + '</b>' +
                    '<span class="op-opp-khz">' + esc(line.freq ? formatKhz(line.freq) : '—') + '</span>' +
                    '<span class="op-opp-ant' + (line.kind === 'insufficient' ? ' op-opp-dim' : '') + '">' +
                        (line.kind === 'inferred'
                            ? '<em class="op-inferred">' + esc(t('op.opp.inferred')) + '</em>' : '') +
                        '<span>' + esc(line.text) + '</span></span>' +
                '</div>').join('');
            return '<div class="op-opp">' +
                '<div class="op-opp-head"><b>' + esc(opponent.call) + '</b><span>' +
                    esc(t('op.opp.samples', {n: opponent.n})) + '</span></div>' +
                '<div class="op-opp-row"><label>' + esc(t('op.opp.location')) + '</label><span>' +
                    esc(location) + '</span></div>' +
                '<div class="op-opp-bands">' + bands + '</div>' +
                '<div class="op-opp-row op-opp-secondary"><label>' + esc(t('op.opp.target')) +
                    '</label><span>' + esc(target) + '</span></div>' +
            '</div>';
        }).join('');
    }

    function contestModes() {
        const declared = String(ctx.settings.contestModes || '').toUpperCase();
        const hasCw = /CW/.test(declared);
        const hasSsb = /SSB|PHONE|SSB\/?/.test(declared);
        if (hasCw && !hasSsb) return ['CW'];
        if (hasSsb && !hasCw) return ['SSB'];
        if (hasCw && hasSsb) return ['CW', 'SSB'];
        const latest = [...state.qsos.values()].slice(-40).map(qso => String(qso.mode || '').toUpperCase());
        if (latest.some(mode => /CW/.test(mode)) && !latest.some(mode => /SSB|PHONE/.test(mode))) return ['CW'];
        if (latest.some(mode => /SSB|PHONE/.test(mode)) && !latest.some(mode => /CW/.test(mode))) return ['SSB'];
        return ['CW', 'SSB'];
    }

    function renderWorkability() {
        const host = $('#opWorkability');
        const modes = contestModes();
        $('#opWorkMode').textContent = modes.length === 1 ? modes[0] : t('op.mode.mixed');
        if (!state.paths) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.work.loading')) + '</div>';
            return;
        }
        const rows = Array.isArray(state.paths.rows) ? state.paths.rows : [];
        const entries = [];
        for (const row of rows) {
            for (const mode of modes) {
                const summary = row.modes && row.modes[mode];
                if (!summary) continue;
                const a = summary.aToB, b = summary.bToA;
                if (!a && !b) continue;
                // Keep rows without a usable verdict: the operator sees the
                // sample shortage instead of an empty panel.
                if (!(a && a.available) && !(b && b.available) &&
                    !(row.self && row.self.aToB && row.self.bToA)) continue;
                entries.push({row, mode, summary, a, b});
            }
        }
        const bandNow = String(currentBand() || '').toLowerCase();
        entries.sort((x, y) => rank(y.summary.advice) - rank(x.summary.advice) ||
            Number(String(y.row.band || '').toLowerCase() === bandNow) -
            Number(String(x.row.band || '').toLowerCase() === bandNow));
        const top = entries.slice(0, 5);
        host.innerHTML = (top.map(entry => {
            const {row, mode, a, b} = entry;
            const both = Boolean(a && b && a.available && b.available);
            const dirs = [a, b].filter(dir => dir && dir.available);
            const evidence = row.evidence || {};
            const evidenceLevel = evidence.level || (both
                ? 'single-station' : dirs.length ? 'single-direction' : 'none');
            const minStations = dirs.length
                ? Math.min(...dirs.map(dir => Number(dir.stations) || 0)) : 0;
            const single = evidenceLevel === 'single-station';
            const conf = (row.confidence && row.confidence.level) || 'low';
            const samples = evidence.reports
                ? Number(evidence.reports.aToB || 0) + Number(evidence.reports.bToA || 0)
                : Number(a && a.samples || 0) + Number(b && b.samples || 0);
            const tags = [];
            if (evidenceLevel === 'multi-station') tags.push(workTag('multi', t('op.work.multi')));
            else if (evidenceLevel === 'single-station') tags.push(workTag('single', t('op.work.single')));
            else if (evidenceLevel === 'single-direction') tags.push(workTag('single', t('op.work.oneWay')));
            else tags.push(workTag('low', t('op.work.noVerdict')));
            tags.push(workTag(conf, t('op.work.conf.' + conf)));
            return '<div class="op-work-row' + (single ? ' single' : '') +
                (evidenceLevel === 'multi-station' ? '' : ' weak') + '">' +
                '<div><span class="op-work-region">' + esc(row.region.label || row.region.key) + '</span>' +
                '<span class="op-work-band' +
                (String(row.band || '').toLowerCase() === bandNow ? ' current' : '') + '">' +
                esc(String(row.band || '').toUpperCase()) + ' · ' + mode + '</span>' +
                '<span class="op-work-tags">' + tags.join('') + '</span>' +
                '<div class="op-verdict">' +
                verdictChip(t('op.work.aToB'), a) +
                verdictChip(t('op.work.bToA'), b) +
                '</div></div>' +
                '<div class="op-work-dir">' + esc(t('op.work.samples', {n: samples})) +
                (minStations ? '<br>' + esc(t('op.work.stations', {n: minStations})) : '') + '</div>' +
            '</div>';
        }).join('') || '<div class="op-empty">' + esc(t('op.work.empty')) + '</div>') +
        '<div class="op-work-foot">' + esc(t('op.work.footer')) + '</div>';
    }

    function workTag(kind, text) {
        return '<span class="op-work-tag ' + kind + '">' + esc(text) + '</span>';
    }

    function verdictChip(label, dir) {
        if (!dir) return '<span class="unworkable">' + esc(label) + ' —</span>';
        if (!dir.available) {
            return '<span class="unworkable">' + esc(label) + ' ' +
                esc(t('op.work.insufficient')) + '</span>';
        }
        const verdict = dir.verdict;
        const key = ['workable', 'marginal', 'unworkable'].includes(verdict) ? verdict : 'unworkable';
        return '<span class="' + key + '">' + esc(label) + ' ' +
            esc(t('op.work.verdict.' + key)) + '</span>';
    }

    function rank(value) {
        return {workable: 3, marginal: 2, unworkable: 1}[value] || 0;
    }

    function currentBand() {
        const key = currentSeat();
        const radio = key === 'all' ? radioOf(visibleSeats()[0]) : radioOf(key);
        const band = radio && radio.freqKhz ? bandOf(radio.freqKhz) : '';
        if (band) return band.toLowerCase();
        const latest = lastQsoFor(key);
        return latest ? bandKey(latest.band || bandLabel(latest.freqKhz)).toLowerCase() : '';
    }

    function renderMultipliers() {
        const host = $('#opMultipliers');
        const modeLabel = contestModes().length === 1 ? contestModes()[0] : 'ALL';
        $('#opMultTitle').textContent = t('op.right.multipliers');
        $('#opMultExpand').textContent = state.multExpanded ? t('op.mult.collapse') : t('op.mult.expand');
        $('#opMultExpand').disabled = !state.multipliers;
        if (!state.multipliers) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.empty.waiting')) + '</div>';
            $('#opMultBand').textContent = '';
            return;
        }
        const data = state.multipliers;
        const rawBands = Array.isArray(data.bands)
            ? data.bands.map(String)
            : Object.keys((data.rows && data.rows[0] && data.rows[0].cells) || {});
        const bandMap = new Map(rawBands.map(item => [item.toLowerCase(), item]));
        const wanted = String(currentBand() || '').toLowerCase();
        const band = bandMap.get(wanted) || rawBands[0] || '';
        state.multBand = band;
        const rows = (data.rows || []).map(row => {
            const key = Object.keys(row.cells || {})
                .find(item => item.toLowerCase() === String(band).toLowerCase());
            return key ? {row, cell: row.cells[key]} : null;
        }).filter(Boolean);
        rows.sort((a, b) => statusRank(a.cell.status) - statusRank(b.cell.status) ||
            String(a.row.country || a.row.entity || '').localeCompare(String(b.row.country || b.row.entity || '')));
        const pending = rows.filter(item => item.cell.status === 'pending').length;
        const worked = rows.filter(item => item.cell.status === 'worked' || item.cell.status === 'new').length;
        const summary = t('op.mult.summary', {pending, worked});
        $('#opMultBand').textContent = [
            band ? band.toUpperCase() : '',
            modeLabel === 'ALL' ? t('op.mode.mixed') : modeLabel,
            summary
        ].filter(Boolean).join(' · ');
        $('#opMultExpand').textContent = state.multExpanded
            ? t('op.mult.collapse') : t('op.mult.expand');
        const visible = state.multExpanded ? rows : rows.slice(0, 8);
        host.innerHTML = (visible.map(item =>
            '<div class="op-mult-row"><b>' + esc(item.row.country || item.row.entity || item.row.call || '—') +
            '</b><span class="op-mult-status status-' + esc(item.cell.status) + '">' +
            esc(t('op.mult.status.' + item.cell.status)) + '</span></div>').join('') ||
            '<div class="op-empty">' + esc(t('op.mult.empty')) + '</div>');
    }

    function sameEntity(region, row) {
        if (!region || !row) return false;
        if (region.dxcc !== null && region.dxcc !== undefined &&
            row.dxcc !== null && row.dxcc !== undefined) {
            return String(region.dxcc) === String(row.dxcc);
        }
        const a = String(region.prefix || region.country || '').toUpperCase();
        const b = String(row.prefix || row.country || row.entity || '').toUpperCase();
        return Boolean(a) && a === b;
    }

    /* A multiplier prompt is only raised when the matrix still shows the
       entity as pending on that band AND the path is workable in BOTH
       directions for the current contest mode. It never tunes the radio. */
    function multiplierAdvice() {
        const data = state.multipliers;
        const paths = state.paths;
        if (!data || !paths || !Array.isArray(paths.rows)) return [];
        const modes = contestModes();
        const out = [];
        for (const row of data.rows || []) {
            for (const [band, cell] of Object.entries(row.cells || {})) {
                if (!cell || cell.status !== 'pending') continue;
                const key = (row.dxcc !== null && row.dxcc !== undefined
                    ? 'd' + row.dxcc : 'p' + String(row.prefix || row.country || '')) +
                    '|' + String(band).toLowerCase();
                if (state.adviceDismissed.has(key)) continue;
                const path = paths.rows.find(item =>
                    String(item.band || '').toLowerCase() === String(band).toLowerCase() &&
                    sameEntity(item.region, row));
                if (!path) continue;
                const workable = modes.some(mode => {
                    const summary = path.modes && path.modes[mode];
                    return summary && summary.aToB && summary.bToA &&
                        summary.aToB.available && summary.bToA.available &&
                        summary.aToB.verdict === 'workable' &&
                        summary.bToA.verdict === 'workable';
                });
                if (!workable) continue;
                out.push({
                    kind: 'mult',
                    key,
                    text: t('op.advice.multiplier', {
                        entity: row.country || row.entity || row.prefix || '',
                        band: String(band).toUpperCase()
                    })
                });
                if (out.length >= 3) return out;
            }
        }
        return out;
    }

    function runIdleAdvice() {
        const limit = Math.max(2, Number(ctx.settings.opRunIdleMin) || 10);
        const now = Date.now();
        const out = [];
        for (const key of visibleSeats()) {
            const radio = radioOf(key);
            if (!radio || radio.isRunning !== true) continue;
            const last = lastQsoFor(key);
            if (!last) continue;
            const minutes = (now - timeOf(last.ts)) / 60000;
            if (minutes < limit) continue;
            out.push({
                kind: 'run',
                key: 'run|' + key,
                text: t('op.advice.runIdle', {
                    radio: seatNameOf(key),
                    min: Math.floor(minutes)
                })
            });
        }
        return out;
    }

    function adviceLang() {
        return ctx.i18n && ctx.i18n.language === 'en' ? 'en' : 'zh';
    }

    function pickText(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        return value[adviceLang()] || value.zh || value.en || '';
    }

    /* Server-side rule engine output. When it is live it replaces the local
       RUN-idle reminder, so there is only one reminder path in the OP view. */
    function seatLane(key) {
        const data = state.adviceEngine;
        if (!data || !Array.isArray(data.seats)) return null;
        return data.seats.find(item => item.seat === String(key)) || null;
    }

    function laneLabel(lane) {
        const radio = lane && lane.radio || {};
        const seatValue = String(lane && lane.seat || '');
        const nr = radio.radioNr ||
            (seatValue.includes(':') ? seatValue.slice(seatValue.lastIndexOf(':') + 1) : seatValue);
        return radio.stationName || radio.radioName || t('op.radio.n', {n: nr || 1});
    }

    function engineAdvice() {
        const data = state.adviceEngine;
        if (!data || !data.ok) return [];
        let lanes = Array.isArray(data.seats) && data.seats.length > 1
            ? data.seats
            : [{seat: data.seat, radio: null, gates: data.gates, advice: data.advice}];
        const selected = currentSeat();
        if (selected !== 'all') {
            const matched = lanes.filter(lane => String(lane.seat) === selected);
            if (matched.length) lanes = matched;
        }
        const multi = lanes.length > 1;
        const out = [];
        for (const lane of lanes) {
            const prefix = multi && lane.seat ? lane.seat + '|' : '';
            const label = multi ? laneLabel(lane) + ' · ' : '';
            const gate = lane.gates || {};
            if (gate.blockReason) {
                const key = prefix + 'gate|' + (gate.blockBandChange || 'lock');
                if (!state.adviceDismissed.has(key)) {
                    out.push({
                        kind: 'run', key, text: label + pickText(gate.blockReason),
                        why: '', missing: []
                    });
                }
            }
            for (const advice of lane.advice || []) {
                const key = prefix + 'adv|' + advice.id + '|' +
                    String((advice.evidence && advice.evidence.band) || '');
                if (state.adviceDismissed.has(key)) continue;
                out.push({
                    kind: advice.group === 'G' ? 'run' : (advice.group === 'B' ? 'mult' : 'run'),
                    key,
                    text: label + (pickText(advice.title) || advice.action),
                    why: pickText(advice.detail),
                    missing: Array.isArray(advice.missing) ? advice.missing : [],
                    confidence: advice.confidence
                });
                if (out.length >= 6) break;
            }
            if (out.length >= 6) break;
        }
        return out;
    }

    function engineLive() {
        return !!(state.adviceEngine && state.adviceEngine.ok && !state.adviceEngine.degraded);
    }

    function renderAdvice() {
        const host = $('#opAdvice');
        if (!host) return;
        const list = engineAdvice().concat(multiplierAdvice())
            .concat(engineLive() ? [] : runIdleAdvice());
        if (!list.length) {
            host.classList.add('hidden');
            host.innerHTML = '';
            return;
        }
        host.classList.remove('hidden');
        host.innerHTML = '<span class="op-advice-title">' + esc(t('op.advice.title')) + '</span>' +
            list.map(item => '<span class="op-advice-item ' + item.kind + '">' +
                '<span class="op-advice-text">' + esc(item.text) + '</span>' +
                (item.why ? '<i class="op-advice-why">' + esc(item.why) + '</i>' : '') +
                (item.missing && item.missing.length
                    ? '<i class="op-advice-missing">⚠ ' + esc(item.missing.join(',')) + '</i>' : '') +
                '<button type="button" class="op-advice-close" ' +
                'data-op-advice="' + esc(item.key) + '" title="' + esc(t('op.advice.dismiss')) +
                '">×</button></span>').join('');
    }

    async function loadAdvice() {
        if (ctx.settings.adviceEnabled === false) {
            state.adviceEngine = null;
            renderAdvice();
            return;
        }
        try {
            const seat = currentSeat();
            // 只有服务端真实席位键（DXI 复合键）才按席位请求；占位电台号
            // 传过去会凭空多出一个 lane。
            state.adviceEngine = await fetchAdvice({
                seat: seat !== 'all' && seat.includes(':') ? seat : ''
            });
        } catch (error) {
            state.adviceEngine = null;
        }
        renderAdvice();
    }

    function statusRank(status) {
        return {pending: 0, new: 1, worked: 2}[status] || 3;
    }

    function renderSuspects() {
        const host = $('#opSuspicious');
        const credit = '<div class="op-scp-credit">' + esc(t('op.suspect.scpCredit')) + '</div>';
        if (!ctx.settings.opSuspiciousCheck) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.suspect.empty')) + '</div>' + credit;
            return;
        }
        const list = [...state.suspects.values()].filter(item => item.visible);
        if (!list.length) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.suspect.empty')) + '</div>' + credit;
            return;
        }
        host.innerHTML = list.map(item => {
            const radio = radioTheme(item.radioNr);
            const reason = item.status === 'checking'
                ? t('op.suspect.checking')
                : [item.scp && item.scp.status === 'miss'
                    ? t('op.suspect.scpMiss', {release: item.scp.release || '—'}) : '',
                    t('op.suspect.qrzNotFound')].filter(Boolean).join(' · ');
            return '<div class="op-suspect ' + radio + '">' +
                '<div class="op-suspect-head"><b>' + esc(item.call) + '</b><span>' +
                esc(t('op.suspect.radio', {n: item.radioNr})) + ' · ' +
                esc(bandKey(item.band || bandLabel(item.freqKhz))) + ' · ' +
                esc(new Date(item.ts).toISOString().slice(11, 16) + 'Z') + '</span></div>' +
                '<div class="op-suspect-reason">' + esc(reason) + '</div>' +
                '<div class="op-suspect-note">' + esc(t('op.suspect.note')) + '</div>' +
                '<div class="op-suspect-actions">' +
                '<button type="button" class="primary" data-op-ok="' + esc(item.key) + '">' +
                esc(t('op.suspect.ok')) + '</button>' +
                '<button type="button" class="warn" data-op-fixed="' + esc(item.key) + '">' +
                esc(t('op.suspect.fixed')) + '</button></div>' +
            '</div>';
        }).join('') + credit;
    }

    function renderMapLegend() {
        const keys = visibleSeats();
        const parts = ['<span><i style="background:var(--op-r1)"></i>' + esc(t('op.map.legend.radio1')) + '</span>'];
        if (category() === 'SO2R') {
            parts.push('<span><i style="background:var(--op-r2);border-radius:1px"></i>' +
                esc(t('op.map.legend.radio2')) + '</span>');
        } else if (keys.length && keys[0] !== '1') {
            parts[0] = '<span><i style="background:var(--op-r1)"></i>' +
                esc(seatNameOf(keys[0])) + '</span>';
        }
        parts.push('<span><i style="background:#00e08a"></i>' + esc(t('op.map.legend.home')) + '</span>');
        parts.push('<span><i style="background:#8fe3ff;border-radius:1px"></i>' +
            esc(t('op.map.legend.spot')) + '</span>');
        $('#opMapLegend').innerHTML = parts.join('');
        $('#opMapCredit').textContent = t('op.map.fixedBorders');
    }

    function renderMap() {
        if (!state.map) return;
        const home = homeLatLon();
        state.map.setHome(home);
        const cutoff = Date.now() - (Number(ctx.settings.mySpotTtl) || 30) * 60000;
        const spots = state.mySpots.filter(spot => timeOf(spot.timestamp) >= cutoff);
        const limit = Math.min(600, Math.max(60, Number(ctx.settings.qsoMax) || 1500));
        const all = [...state.qsos.values()].slice(-limit);
        const key = currentSeat();
        state.map.setData({
            qsos: all,
            spots,
            radioFilter: key === 'all' ? 'all' : String(radioNrOfKey(key))
        });
        renderMapLegend();
    }

    function updateMapHint() {
        const parts = [t('op.map.hintNoZoom')];
        if (ctx.settings.opRotatorConfigured) parts.push(t('op.map.hintClick'));
        $('#opMapHint').textContent = parts.join(' · ');
    }

    function showMapFlag(text) {
        let flag = document.getElementById('opMapFlag');
        if (!flag) {
            flag = document.createElement('div');
            flag.id = 'opMapFlag';
            flag.className = 'op-map-flag';
            $('.op-map-wrap').appendChild(flag);
        }
        flag.textContent = text;
        flag.classList.add('show');
        clearTimeout(flag._timer);
        flag._timer = setTimeout(() => flag.classList.remove('show'), 2600);
    }

    function handleMapBearing(deg, info) {
        if (!ctx.settings.opRotatorConfigured || info && info.blocked) {
            showMapFlag(t('op.map.rotatorOff'));
            return;
        }
        state.rotorTarget = Math.round(deg);
        const result = hub.command('rotator', 'bearing', deg);
        showMapFlag(result.ok
            ? t('op.device.rotator.target', {deg: state.rotorTarget})
            : t('op.device.rotator.target', {deg: state.rotorTarget}) + ' · ' + t('op.device.rotator.previewOnly'));
        renderBottom();
    }

    function claimControls(key, radio) {
        const claims = frequencyClaims();
        const own = claims.find(claim => String(claim.seat) === String(key));
        const freqKhz = Number(radio && radio.freqKhz);
        const occupied = claims.find(claim => Number.isFinite(freqKhz) &&
            Number(claim.freqKhz).toFixed(3) === freqKhz.toFixed(3));
        let note;
        let button;
        if (own) {
            note = t('op.claim.owned', {freq: own.freqKhz});
            button = '<button type="button" class="op-mini op-claim-btn" data-op-claim="release" data-seat="' +
                esc(key) + '" data-freq="' + own.freqKhz + '">' + esc(t('op.claim.release')) + '</button>';
        } else {
            note = occupied
                ? t('op.claim.occupiedBy', {seat: occupied.operator || seatNameOf(occupied.seat)})
                : t('op.claim.free');
            button = '<button type="button" class="op-mini op-claim-btn" data-op-claim="claim" data-seat="' +
                esc(key) + '" data-freq="' + (Number.isFinite(freqKhz) ? freqKhz : '') + '"' +
                (occupied || !Number.isFinite(freqKhz) || freqKhz <= 0 ? ' disabled' : '') + '>' +
                esc(t('op.claim.claim')) + '</button>';
        }
        const feedback = state.claimFeedback && state.claimFeedback.seat === String(key)
            ? '<span class="op-claim-feedback' + (state.claimFeedback.bad ? ' bad' : '') + '">' +
                esc(state.claimFeedback.text) + '</span>' : '';
        return '<div class="op-claim"><span>' + esc(note) + '</span>' + button + '</div>' + feedback;
    }

    function renderBottom() {
        const host = $('#opBottom');
        const devices = deviceDefinitions(ctx.settings);
        $('#opBottomNote').textContent = devices.length ? '' : t('op.bottom.none');
        renderAddMenu(devices);
        if (devices.length) {
            host.innerHTML = devices.map(device => deviceCard(device)).join('');
            return;
        }
        const keys = visibleSeats();
        const cards = keys.map(key => {
            const radio = radioOf(key);
            return '<div class="op-radio-card ' + radioTheme(key) + '"><b>' +
                esc(radioName(key)) + '</b><span>' +
                esc(radio && radio.freqKhz ? bandOf(radio.freqKhz) + ' ' + mini(radio.mode) : t('op.radio.waiting')) +
                '</span><span>' + esc(radio && radio.opCall || '') + '</span>' + claimControls(key, radio) + '</div>';
        }).join('');
        const recent = [...state.qsos.values()].slice(-6).reverse().map(qso =>
            '<div class="op-recent-row"><span>' + esc(new Date(qso.ts).toISOString().slice(11, 16)) + 'Z</span>' +
            '<b>' + esc(qso.call) + '</b><span>' + esc(bandKey(qso.band || bandLabel(qso.freqKhz))) +
            '</span><span>' + esc(qso.mode || '') + '</span></div>').join('') ||
            '<div class="op-empty">' + esc(t('op.top.noQso')) + '</div>';
        host.innerHTML = '<div class="op-filler">' + cards +
            '<div class="op-recent"><div class="op-recent-row"><span></span><b>' +
            esc(t('op.bottom.recent')) + '</b><span></span><span></span></div>' + recent +
            '</div></div>';
    }

    function deviceCard(device) {
        const ready = hub.status(device.type) === 'ready';
        const badge = ready
            ? '<span class="ok">' + esc(t('op.device.ready')) + '</span>'
            : '<span>' + esc(t('op.device.noDriver')) + '</span>';
        let controls = '';
        if (device.type === 'antenna') {
            controls = '<select data-op-antenna="1"' + (ready ? '' : ' disabled') + '><option>' +
                esc(t('op.device.antenna.ports')) + '</option>' + [1, 2, 3, 4, 5, 6].map(port =>
                    '<option value="' + port + '">' + port + '</option>').join('') + '</select>';
        } else if (device.type === 'tower') {
            controls = [
                ['up', 'op.device.tower.up'],
                ['down', 'op.device.tower.down'],
                ['stop', 'op.device.tower.stop']
            ].map(([direction, key]) => '<button type="button" data-op-direction="' + direction + '"' +
                (ready ? '' : ' disabled') + '>' + esc(t(key)) + '</button>').join('');
        } else {
            const deg = state.rotorTarget === null ? '—' : state.rotorTarget;
            controls = '<span class="op-device-note">' + esc(ready
                ? t('op.device.rotator.target', {deg})
                : t('op.device.rotator.previewOnly')) + '</span>';
        }
        const note = ready ? '' : '<span class="op-device-note">' + esc(t('op.device.unconfigured')) +
            ' · ' + esc(t('op.device.settingsHint')) + '</span>';
        return '<div class="op-device' + (ready ? ' ready' : '') + '"><div class="op-device-head"><b>' +
            esc(device.name) + '</b>' + badge + '</div><div class="op-device-controls">' + controls +
            '</div>' + note +
            '<button type="button" class="op-link-btn" data-op-remove="' + esc(device.type) + '">' +
            esc(t('op.device.remove')) + '</button></div>';
    }

    function deviceFeedback(target, ok) {
        const card = target.closest('.op-device');
        if (!card) return;
        let note = card.querySelector('.op-device-result');
        if (!note) {
            note = document.createElement('span');
            note.className = 'op-device-result';
            card.appendChild(note);
        }
        note.textContent = ok ? t('op.device.commandSent') : t('op.device.commandFailed');
        note.classList.toggle('bad', !ok);
    }

    function renderAddMenu(devices) {
        const menu = $('#opAddMenu');
        const have = new Set(devices.map(device => device.type));
        const options = ['antenna', 'tower', 'rotator'].filter(type => !have.has(type));
        menu.innerHTML = options.map(type =>
            '<button type="button" data-op-add="' + type + '">+ ' + esc(t('op.device.' + type)) + '</button>'
        ).join('');
        menu.classList.toggle('hidden', !options.length);
    }

    function configureDevice(type, enabled) {
        const map = {
            antenna: 'opAntennaSwitchConfigured',
            tower: 'opTowerConfigured',
            rotator: 'opRotatorConfigured'
        };
        if (!map[type]) return;
        ctx.settings[map[type]] = enabled;
        if (ctx.saveSettings) ctx.saveSettings();
        renderBottom();
        updateMapHint();
        renderMap();
    }

    // ---- async data -------------------------------------------------------
    async function loadPropagation() {
        try {
            state.prop = await getPropSnapshot();
            renderBands();
            renderSpace();
        } catch (error) {
            console.warn('op view: propagation unavailable', error);
        }
    }

    async function loadPaths() {
        try {
            state.paths = await fetchPaths({hours: 2});
            renderWorkability();
        } catch (error) {
            state.paths = {rows: []};
            renderWorkability();
        }
        renderAdvice();
    }

    async function loadMultipliers() {
        try {
            const mode = contestModes().length === 1 ? contestModes()[0] : 'ALL';
            state.multipliers = await fetchMultipliers({mode, scope: 'contest'});
        } catch (error) {
            state.multipliers = null;
        }
        renderMultipliers();
        renderAdvice();
    }

    function scheduleAdviceRefresh() {
        clearTimeout(state.adviceTimer);
        state.adviceTimer = setTimeout(() => {
            if (state.active) loadAdvice();
        }, 3000);
    }

    function scheduleMultiplierRefresh() {
        clearTimeout(state.multTimer);
        state.multTimer = setTimeout(() => {
            if (state.active) loadMultipliers();
        }, 10000);
    }

    async function loadMySpots() {
        if (!myCall()) {
            state.mySpots = [];
            renderMap();
            return;
        }
        try {
            const rows = await fetchSpots({call: myCall(), limit: 300});
            for (const row of rows) {
                if (String(row.monitored_call || '').toUpperCase() !== myCall()) continue;
                ingestSpot(row);
                if (!state.mySpots.some(item => spotKeyOf(item) === spotKeyOf(row))) {
                    state.mySpots.push(row);
                }
            }
            state.mySpots.sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp));
            state.mySpots = state.mySpots.slice(-300);
        } catch (error) {
            console.warn('op view: my spots unavailable', error);
        }
        renderMap();
    }

    /* Bootstrap the WS stream once, then let live spots drive the opponent
       panel. The callsign list is a filter, never a blocker: if it fails the
       panel still shows every rival seen on the bands. */
    async function loadOpponents() {
        if (!myCall()) {
            state.opponents = [];
            renderOpponents();
            return;
        }
        try {
            const rows = await fetchSpots({limit: 1500});
            rows.forEach(ingestSpot);
        } catch (error) {
            console.warn('op view: opponent bootstrap unavailable', error);
        }
        if (state.monitoredCalls === null) {
            try {
                state.monitoredCalls = await fetchCallsigns();
            } catch {
                // Keep null and retry on the next bootstrap; do not drop rivals.
            }
        }
        recomputeOpponents();
    }

    function recomputeOpponents() {
        if (!myCall()) {
            state.opponents = [];
            renderOpponents();
            return;
        }
        const list = buildOpponents(state.allSpots, myCall(), bearing, {now: Date.now()});
        const calls = state.monitoredCalls;
        state.opponents = Array.isArray(calls) && calls.length
            ? list.filter(opponent => calls.some(call =>
                String(call).toUpperCase() === opponent.call))
            : list;
        renderOpponents();
        for (const opponent of state.opponents.slice(0, 6)) loadAntenna(opponent.call);
    }

    async function loadAntenna(call) {
        const cached = state.opponentCache.get(call);
        if (cached && Date.now() - cached.at < 5 * 60000) return;
        state.opponentCache.set(call, {status: 'loading', at: Date.now()});
        renderOpponents();
        try {
            const data = await fetchEstimate(call);
            state.opponentCache.set(call, {status: 'ready', at: Date.now(), data});
        } catch (error) {
            state.opponentCache.set(call, {status: 'error', at: Date.now()});
        }
        renderOpponents();
    }

    // ---- call sanity check ------------------------------------------------
    function loadReview() {
        try {
            const raw = JSON.parse(localStorage.getItem(REVIEW_KEY) || '{}');
            const cutoff = Date.now() - 7 * 24 * 3600000;
            const clean = {};
            for (const [key, value] of Object.entries(raw || {})) {
                if (value && Number(value.at) >= cutoff) clean[key] = value;
            }
            return clean;
        } catch {
            return {};
        }
    }

    function saveReview() {
        try {
            localStorage.setItem(REVIEW_KEY, JSON.stringify(state.review));
        } catch {
            // Review state is a convenience only; failing to persist is harmless.
        }
    }

    function reviewKey(qso) {
        return String(qso.n1mmId || '') + '|' + String(qso.call || '').toUpperCase();
    }

    function scheduleSuspects() {
        if (!ctx.settings.opSuspiciousCheck) return;
        const keys = radioKeys();
        const candidates = [];
        for (const key of keys) {
            const latest = lastQsoFor(key);
            if (latest) candidates.push(latest);
        }
        // Only the newest QSO per radio is relevant; clear stale items so a
        // new contact cannot leave an older warning behind.
        const latestKeys = new Set(candidates.map(reviewKey));
        for (const key of [...state.suspects.keys()]) {
            if (!latestKeys.has(key)) state.suspects.delete(key);
        }
        for (const qso of candidates) {
            const key = reviewKey(qso);
            if (state.review[key] || state.suspects.has(key)) continue;
            state.suspects.set(key, {
                key,
                call: String(qso.call || '').toUpperCase(),
                radioNr: qso.radioNr || 1,
                ts: qso.ts,
                band: qso.band,
                freqKhz: qso.freqKhz,
                status: 'checking',
                visible: true
            });
        }
        renderSuspects();
        if (candidates.length) queueChecks(candidates);
    }

    function queueChecks(candidates) {
        const pending = candidates.filter(qso => {
            const item = state.suspects.get(reviewKey(qso));
            return item && item.status === 'checking';
        });
        if (!pending.length) return;
        if (state.checking) return;
        state.checking = (async () => {
            for (const qso of pending) {
                if (!state.active) break;
                await checkOne(qso);
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
        })().finally(() => {
            state.checking = null;
            // New QSOs may have arrived while the queue was busy.
            const waiting = [...state.suspects.values()].some(item => item.status === 'checking');
            if (waiting && state.active) scheduleSuspects();
        });
    }

    async function checkOne(qso) {
        const key = reviewKey(qso);
        const item = state.suspects.get(key);
        if (!item) return;
        try {
            const result = await checkCallsign(qso.call, qso.n1mmId, {
                qrz: Boolean(ctx.settings.opSuspiciousQrz),
                scp: Boolean(ctx.settings.opScpCheck)
            });
            // SCP hit or QRZ match is a confirmation: drop the row.
            if (result.status === 'scp' || result.status === 'qrz-found') {
                state.suspects.delete(key);
                renderSuspects();
                return;
            }
            // Only an explicit "QRZ has no record" is shown. A disabled or
            // failed QRZ lookup stays silent instead of accusing the call.
            if (result.status === 'qrz-not-found') {
                item.status = 'not-found';
                item.scp = result.scp || null;
                item.visible = true;
                renderSuspects();
                return;
            }
            state.suspects.delete(key);
            renderSuspects();
        } catch (error) {
            // Network failure is not evidence against the call: stay silent.
            state.suspects.delete(key);
            renderSuspects();
        }
    }

    function acceptSuspect(key, status) {
        state.review[key] = {status, at: Date.now()};
        saveReview();
        state.suspects.delete(key);
        renderSuspects();
        if (status === 'fixed' && ctx.qso && ctx.qso.loadStation) {
            ctx.qso.loadStation();
        }
    }

    // ---- lifecycle --------------------------------------------------------
    function ensureMap() {
        if (state.map) return;
        state.map = createOpMap($('#opMap'), {
            onBearing: handleMapBearing,
            canRotate: () => Boolean(ctx.settings.opRotatorConfigured)
        });
        state.map.resize();
        renderMap();
    }

    function refreshAll() {
        renderTop();
        renderBands();
        renderSpace();
        renderOpponents();
        renderWorkability();
        renderSuspects();
        renderMultipliers();
        renderBottom();
        updateMapHint();
        renderAdvice();
        renderMap();
    }

    async function show() {
        state.active = true;
        document.querySelector('.main')?.classList.add('op-active');
        $('#opView').classList.remove('hidden');
        ensureMap();
        requestAnimationFrame(() => state.map && state.map.resize());
        refreshAll();
        loadQsos();
        loadPropagation();
        loadPaths();
        loadMultipliers();
        loadAdvice();
        loadMySpots();
        loadOpponents();
        state.timers.forEach(timer => clearInterval(timer));
        state.timers = [
            // Numbers and advice: 2 s local recompute, WS updates are instant.
            setInterval(() => {
                if (!state.active) return;
                renderTop();
                renderAdvice();
            }, 2000),
            // Map markers are heavier; the WS handlers redraw immediately.
            setInterval(() => {
                if (!state.active) return;
                renderMap();
                renderBottom();
            }, 10000),
            // Opponents come from the WS spot stream; this is only recompute.
            setInterval(() => { if (state.active) recomputeOpponents(); }, 5000),
            setInterval(() => { if (state.active) loadMySpots(); }, 15000),
            setInterval(() => { if (state.active) loadPaths(); }, 10000),
            setInterval(() => { if (state.active) loadOpponents(); }, 60000),
            setInterval(() => { if (state.active) loadPropagation(); }, 120000),
            setInterval(() => { if (state.active) loadMultipliers(); }, 60000),
            setInterval(() => { if (state.active) loadAdvice(); },
                Math.max(15, Number(ctx.settings.adviceRefreshSec) || 60) * 1000)
        ];
    }

    function hide() {
        state.active = false;
        document.querySelector('.main')?.classList.remove('op-active');
        $('#opView').classList.add('hidden');
        state.timers.forEach(timer => clearInterval(timer));
        state.timers = [];
        clearTimeout(state.multTimer);
        clearTimeout(state.adviceTimer);
    }

    function handleStation() {
        if (!state.active) return;
        renderTop();
        renderBottom();
        renderMultipliers();
        renderAdvice();
    }

    function handleQso(message) {
        if (!state.active) return;
        addQso(message.payload || message);
        // A new contact ends any ignored RUN reminder, so the next idle streak
        // can warn again instead of staying silent for the session.
        for (const key of [...state.adviceDismissed]) {
            if (key.startsWith('run|')) state.adviceDismissed.delete(key);
        }
        renderTop();
        renderMap();
        renderBottom();
        renderAdvice();
        scheduleSuspects();
        scheduleMultiplierRefresh();
        scheduleAdviceRefresh();
    }

    function handleDelete(message) {
        if (!state.active) return;
        const payload = message.payload || message;
        const id = payload && (payload.n1mmId || payload.n1mm_id || payload.id);
        if (id === undefined) return;
        for (const [key, qso] of state.qsos.entries()) {
            if (String(qso.n1mmId) === String(id)) state.qsos.delete(key);
        }
        renderTop();
        renderMap();
        renderBottom();
        renderAdvice();
        scheduleMultiplierRefresh();
        scheduleAdviceRefresh();
    }

    function handleSpot(message) {
        if (!state.active) return;
        const payload = message.payload || message;
        const rows = Array.isArray(payload) ? payload : [payload];
        // Keep every rival spot in memory for the 5 s opponent recompute.
        rows.forEach(ingestSpot);
        if (!myCall()) return;
        let mine = false;
        for (const spot of rows) {
            if (String(spot.monitored_call || spot.monitoredCall || '').toUpperCase() !== myCall()) continue;
            const key = spotKeyOf(spot);
            if (state.mySpots.some(item => spotKeyOf(item) === key)) continue;
            state.mySpots.push(spot);
            mine = true;
        }
        if (!mine) return;
        state.mySpots = state.mySpots.slice(-300);
        renderMap();
    }

    function resize() {
        if (state.map) state.map.resize();
    }

    function applyLang() {
        renderTitles();
        renderSeatOptions();
        if (state.active) refreshAll();
    }

    function renderTitles() {
        $('#opBandsTitle').textContent = t('op.left.bands');
        $('#opSpaceTitle').textContent = t('op.left.space');
        $('#opOppTitle').textContent = t('op.left.opponents');
        $('#opMapTitle').textContent = t('op.map.title');
        $('#opWorkTitle').textContent = t('op.right.workability');
        $('#opSuspectTitle').textContent = t('op.right.suspicious');
        $('#opMultTitle').textContent = t('op.right.multipliers');
        $('#opMultExpand').textContent = state.multExpanded ? t('op.mult.collapse') : t('op.mult.expand');
        $('#opBottomTitle').textContent = t('op.bottom.devices');
        $('#opAddPeripheral').title = t('op.bottom.add');
    }

    function bind() {
        $('#opAdvice')?.addEventListener('click', event => {
            const close = event.target.closest('[data-op-advice]');
            if (!close) return;
            state.adviceDismissed.add(close.dataset.opAdvice);
            renderAdvice();
        });
        $('#opSeat')?.addEventListener('change', event => {
            state.selectedSeat = event.target.value;
            refreshAll();
            renderMap();
            renderMultipliers();
            loadAdvice();
        });
        $('#opAddPeripheral')?.addEventListener('click', event => {
            event.stopPropagation();
            $('#opAddMenu').classList.toggle('hidden');
        });
        document.addEventListener('click', event => {
            if (!event.target.closest('.op-add-wrap')) $('#opAddMenu')?.classList.add('hidden');
        });
        $('#opAddMenu')?.addEventListener('click', event => {
            const button = event.target.closest('[data-op-add]');
            if (!button) return;
            configureDevice(button.dataset.opAdd, true);
            $('#opAddMenu').classList.add('hidden');
        });
        $('#opBottom')?.addEventListener('click', async event => {
            const claimButton = event.target.closest('[data-op-claim]');
            if (claimButton) {
                const action = claimButton.dataset.opClaim;
                const seat = String(claimButton.dataset.seat || '');
                const freqKhz = Number(claimButton.dataset.freq);
                claimButton.disabled = true;
                try {
                    const result = await changeFrequencyClaim(action, {seat, freqKhz});
                    if (result && Array.isArray(result.claims)) {
                        ctx.qso.handleStationMessage({type: 'frequencyClaims', claims: result.claims});
                    }
                    state.claimFeedback = {seat, bad: false,
                        text: t(action === 'claim' ? 'op.claim.success' : 'op.claim.released')};
                } catch (error) {
                    const body = error && error.body || {};
                    if (Array.isArray(body.claims)) {
                        ctx.qso.handleStationMessage({type: 'frequencyClaims', claims: body.claims});
                    }
                    const owner = body.owner && (body.owner.operator || seatNameOf(body.owner.seat));
                    const key = body.error === 'frequency-claimed' ? 'op.claim.conflict'
                        : body.error === 'not-claim-owner' ? 'op.claim.notOwner' : 'op.claim.failed';
                    state.claimFeedback = {seat, bad: true, text: t(key, {seat: owner || ''})};
                }
                renderBottom();
                return;
            }
            const remove = event.target.closest('[data-op-remove]');
            if (remove) {
                configureDevice(remove.dataset.opRemove, false);
                return;
            }
            const direction = event.target.closest('[data-op-direction]');
            if (direction) {
                const result = hub.command('tower', 'direction', direction.dataset.opDirection);
                deviceFeedback(direction, result.ok);
            }
        });
        $('#opBottom')?.addEventListener('change', event => {
            const select = event.target.closest('[data-op-antenna]');
            if (!select) return;
            const result = hub.command('antenna', 'antenna', Number(select.value));
            deviceFeedback(select, result.ok);
        });
        $('#opSuspicious')?.addEventListener('click', event => {
            const ok = event.target.closest('[data-op-ok]');
            if (ok) acceptSuspect(ok.dataset.opOk, 'ok');
            const fixed = event.target.closest('[data-op-fixed]');
            if (fixed) acceptSuspect(fixed.dataset.opFixed, 'fixed');
        });
        $('#opMultExpand')?.addEventListener('click', () => {
            state.multExpanded = !state.multExpanded;
            renderMultipliers();
        });
    }

    function init() {
        renderTitles();
        renderSeatOptions();
        bind();
    }

    return {
        init,
        show,
        hide,
        resize,
        applyLang,
        handleQso,
        handleDelete,
        handleStation,
        handleSpot,
        showRuleAlert
    };
}
