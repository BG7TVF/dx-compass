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
import {$, cssVar, escapeHtml as esc} from '../ui.mjs';
import {CONTEST_CATEGORIES, bandLabel, dbRowToQso} from '../settings-model.mjs';
import {fetchQsos} from '../../shared/data/qsos.mjs';
import {fetchSpots} from '../../shared/data/spots.mjs';
import {getPropSnapshot, selectForecast} from '../../shared/data/propagation.mjs';
import {fetchPaths} from '../../shared/data/analysis.mjs';
import {fetchMultipliers} from '../../shared/data/multipliers.mjs';
import {fetchCallsigns, checkCallsign} from '../../shared/data/callsigns.mjs';
import {getStationState} from '../../shared/data/station.mjs';
import {drawBars, perMinute} from '../../bigscreen/wall-charts.mjs';
import {fetchAdvice} from '../../shared/data/advice.mjs';
import {createOpponentRenderer} from '../../shared/opponents/opponents.mjs';
import {bandConditionCells, spaceWeatherCells, bandOf} from '../../bigscreen/wall-cards.mjs';
import {bearing} from '../../shared/geo/coordinates.mjs';
import {gridToLatLon} from '../../shared/geo/maidenhead.mjs';
import {createOpMap} from '../op/op-map.mjs';
import {getDevicesSnapshot, sendDeviceCommand, setBandLink} from '../../shared/data/devices.mjs';
import {changeFrequencyClaim} from '../../shared/data/station.mjs';

const REVIEW_KEY = 'dxcompass-op-call-review';
const SEAT_KEY = 'dxcompass-op-seat';
const RADIO_THEME = {1: 'r1', 2: 'r2', 3: 'r3', 4: 'r4', 5: 'r5', 6: 'r6'};
/* Printed ruler of the amplifier bay: the bar is a meter with a fixed scale,
 * the exact value is always the numeral beside it. */
const AMP_POWER_MAX = 2000;
const AMP_SWR_MIN = 1;
const AMP_SWR_MAX = 3;
const AMP_SWR_LIMIT = 2;
/* Fixed ruler of the band-occupancy strip: the ten HF bands, in band order.
 * VHF and above are out of scope, exactly like the operator's draft. */
const HF_BANDS = ['160M', '80M', '60M', '40M', '30M', '20M', '17M', '15M', '12M', '10M'];

const timeOf = value => {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
};
/* 波段键统一走米波归一化：QSO 行可能带 N1MM 的 14/21，不能原样当波段名。 */
const bandKey = value => bandLabel(value) || '';
const mini = value => (value === null || value === undefined || value === '' ? '—' : value);

export function createOpPage(ctx) {
    const state = {
        active: false,
        map: null,
        selectedSeat: loadSeat(),
        qsos: new Map(),
        mySpots: [],
        allSpots: [],
        opponentRows: [],
        spotKeys: new Set(),
        monitoredCalls: null,
        stationScore: null,
        prop: null,
        paths: null,
        multipliers: null,
        multBand: '',
        multExpanded: false,
        suspects: new Map(),
        checked: new Set(),
        review: loadReview(),
        adviceDismissed: new Set(),
        adviceEngine: null,
        adviceStatus: 'idle',
        checking: null,
        multTimer: null,
        adviceTimer: null,
        rotorTarget: null,
        claimFeedback: null,
        devices: null,
        towerHold: null,
        towerTimer: null,
        timers: []
    };

    function t(key, params) {
        const value = ctx.t(key, params);
        return value === undefined || value === null ? key : value;
    }

    /* The wall's opponent panel, unchanged: same aggregation, same cards, same
     * stylesheet. Only the translator is injected so the panel follows the OP
     * page language; the rows come from the single watched-scope request. */
    const opponentPanel = createOpponentRenderer({
        t,
        bearing: (lat1, lon1, lat2, lon2) => bearing(
            {lat: lat1, lon: lon1},
            {lat: lat2, lon: lon2}
        )
    });

    function category() {
        const value = String(ctx.settings.category || 'SO1R').toUpperCase();
        return CONTEST_CATEGORIES.includes(value) ? value : 'SO1R';
    }

    function radios() {
        return ctx.qso && ctx.qso.state && ctx.qso.state.radios || {};
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

    /* 席位来自服务端 seats DTO；没有实时数据时按设备快照里的席位计划
       （seat_plan，由电台属性绑定的席位号派生）生成占位，
       保证 M2/MM 在 N1MM 接入前也能选席位。 */
    function liveSeats() {
        const station = ctx.qso && ctx.qso.state && ctx.qso.state.station;
        return station && Array.isArray(station.seats) ? station.seats : [];
    }

    function configuredSeatRadios() {
        const plan = deviceSnapshot() && deviceSnapshot().seat_plan;
        const seats = plan && Array.isArray(plan.seats) ? plan.seats : [];
        /* 占位仍要用实时席位键喂给下游（天线归属、功放、联动都按席位键走）；
         * 电台还没上报的席位退回按席位号。没有电台就没有席位：席位数由电台派生。 */
        return seats.map(seat => (Array.isArray(seat.keys) && seat.keys.length)
            ? String(seat.keys[0])
            : String(seat.no));
    }

    function operatorRoster() {
        /* 操作员名单不再来自设置：谁在用哪个席位由 N1MM 上报决定，
         * 上下线历史由 records 页读 operator_history。占位席位因此没有预设操作员。 */
        return [];
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

    /* Seat numbers: canonical order (radio number, then seat key), ranked over
     * the seats that exist right now. The rank never comes from the order N1MM
     * instances happened to report in, so a reconnect or a page reload prints
     * the same numbers for the same seats, and no number is skipped when an
     * earlier placeholder seat gives way to the real ones. The underlying seat
     * keys and every matching rule stay untouched. */
    const seatNumbers = new Map();

    function compareSeatKeys(a, b) {
        return radioNrOfKey(a) - radioNrOfKey(b) || a.localeCompare(b);
    }

    function ensureSeatNumbers(keys) {
        const list = [...new Set(keys.map(String))].sort(compareSeatKeys);
        seatNumbers.clear();
        list.forEach((key, index) => seatNumbers.set(key, index + 1));
    }

    function seatNumber(key) {
        const value = String(key);
        const known = seatNumbers.get(value);
        if (known) return known;
        /* A seat referenced outside the current list (a claim or a lane from
         * another instance): rank it against the seats that are listed. */
        const list = seatChoices().map(choice => String(choice.value));
        return (list.includes(value) ? list : list.concat(value))
            .sort(compareSeatKeys).indexOf(value) + 1;
    }

    /* Display order always follows the seat number, never the order in which
     * N1MM instances happened to come online. */
    function orderedSeatChoices() {
        const choices = seatChoices();
        ensureSeatNumbers(choices.map(choice => choice.value));
        return choices.slice().sort((a, b) => seatNumber(a.value) - seatNumber(b.value));
    }

    function seatLabel(choice) {
        if (!choice) return '';
        ensureSeatNumbers(seatChoices().map(item => item.value));
        return t('op.seat.n', {n: seatNumber(choice.value)});
    }

    function seatNameOf(key) {
        const choice = seatChoices().find(item => item.value === String(key));
        return choice ? seatLabel(choice) : t('op.seat.n', {n: seatNumber(key)});
    }

    function currentSeat() {
        const choices = orderedSeatChoices();
        /* No seat yet: keep the legacy radio-1 read key so history still has a
         * filter; the seat card itself shows the empty state. */
        if (!choices.length) return '1';
        const values = choices.map(choice => choice.value);
        return values.includes(String(state.selectedSeat))
            ? String(state.selectedSeat) : values[0];
    }

    function visibleSeats() {
        return [currentSeat()];
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
        const point = grid ? gridToLatLon(grid) : null;
        /* gridToLatLon 给出的是 [lat, lon] 数组，而 op-map 的 setHome 只认
         * {lat, lon}。把数组直接递过去等于告诉地图「本台没有位置」，于是本台
         * 标记、天线波束、每个席位的 QSO 线、本台 spot 一并消失，图上只剩陆地
         * 和国界——地图「什么都不显示」的根因就在这里。 */
        return point ? {lat: point[0], lon: point[1]} : null;
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
        renderMap();
        scheduleSuspects();
    }

    function qsosFor(key) {
        const list = [...state.qsos.values()];
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

    function renderSeatOptions() {
        const select = $('#opSeat');
        if (!select) return;
        const choices = orderedSeatChoices();
        ensureSeatNumbers(choices.map(choice => choice.value));
        const empty = !choices.length;
        /* One seat means no dropdown: the nameplate already carries the identity,
         * a picker that repeats it is noise. No seat at all gets an explicit hint
         * in the rig line instead of an empty dropdown. */
        const show = choices.length > 1;
        const current = currentSeat();
        select.classList.toggle('hidden', !show);
        select.setAttribute('aria-label', t('op.seat'));
        select.innerHTML = choices.map(choice => '<option value="' + esc(choice.value) + '">' +
            esc(seatLabel(choice)) + '</option>').join('');
        if (show) select.value = current;
        renderSeatPlate(choices.find(choice => choice.value === current) || null, empty);
    }

    /* opcall-exception:start */
    /* 席位铭牌第二处豁免：本席位的 OP 优先取 N1MM 实时上报的 OpCall；报文里没带
     * 操作员时退回席位名单里带出的 operator（seatChoices 的在线实例或席位计划）。
     * 两处都没有就留 "--"，宁缺毋滥，不拿本机 callsign 顶上。 */
    function seatOperator(active) {
        if (!active) return '';
        const radio = radioOf(active.value) || {};
        const live = String(radio.opCall || '').trim();
        if (live) return live.toUpperCase();
        return String(active.operator || '').trim().toUpperCase();
    }
    /* opcall-exception:end */

    function renderSeatPlate(active, empty) {
        const plate = $('#opSeatPlate');
        const index = $('#opSeatIndex');
        const op = $('#opSeatOp');
        const name = $('#opSeatName');
        const call = seatOperator(active);
        const radio = active ? (radioOf(active.value) || {}) : {};
        if (plate) {
            plate.className = 'op-seat-plate' + (active ? ' ' + radioTheme(active.value) : '');
            /* 席位在报活：电台有频率，或至少上报了操作员。 */
            if (Number(radio.freqKhz || 0) > 0 || call) plate.dataset.live = '1';
            else delete plate.dataset.live;
        }
        if (index) {
            index.textContent = active ? String(seatNumber(active.value)).padStart(2, '0') : '--';
        }
        if (op) {
            op.classList.toggle('on', !!call);
            op.textContent = call || '--';
        }
        if (name) {
            name.classList.toggle('empty', empty);
            name.textContent = empty ? t('op.seat.empty') : seatRigLine(active, radio);
        }
    }

    /** 铭牌下沿：席位台名 + 电台型号，两者相同就不重复。 */
    function seatRigLine(active, radio) {
        if (!active) return '';
        const station = String(active.stationName || '').trim();
        const bits = [station || t('op.seat.n', {n: seatNumber(active.value)})];
        const model = String(radio.radioName || radio.name || '').trim();
        if (model && model !== station) bits.push(model);
        return bits.join(' · ');
    }

    /** QSO total and contest score: the score comes from the station snapshot,
     *  the total from the shared QSO repository the rest of the page uses. */
    function renderScore() {
        const total = $('#opQsoTotal');
        if (total) total.textContent = state.qsos.size;
        const value = state.stationScore && Number(state.stationScore.score);
        const score = $('#opScore');
        if (score) score.textContent = Number.isFinite(value) ? value : '—';
    }

    /** Bottom data cells: last-hour rate bars and per-band QSO bars, both drawn
     *  with the wall's binning/drawing helpers so the charts match the wall. */
    function renderCharts() {
        const rows = [...state.qsos.values()];
        /* The shared binner reads row.timestamp; QSO rows carry ts. */
        const timed = rows.map(qso => ({timestamp: qso.timestamp || qso.ts}));
        if ($('#opRateChart')) drawBars('#opRateChart', perMinute(timed, 60), cssVar('--op-chart-rate', '#35d6a4'));
        const note = $('#opRateNote');
        if (note) {
            /* No seat bound yet: do not invent a "seat 1" rate line. */
            note.textContent = seatChoices().length
                ? visibleSeats().map(key => radioName(key) + ' ' + rateFor(key)).join(' · ')
                : '—';
        }
        const bands = new Map();
        rows.forEach(qso => {
            const key = bandKey(qso.band || bandLabel(qso.freqKhz));
            if (key) bands.set(key, (bands.get(key) || 0) + 1);
        });
        const entries = [...bands.entries()].sort((a, b) => b[1] - a[1]);
        if ($('#opBandChart')) drawBars('#opBandChart', entries.map(entry => entry[1]), cssVar('--op-chart-band', '#4cc9f0'));
        const labels = $('#opBandLabels');
        if (labels) {
            labels.innerHTML = entries.map(([band, count]) =>
                '<span>' + esc(band) + ' <b>' + count + '</b></span>').join('') ||
                '<span>—</span>';
        }
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
        /* spaceWeatherCells 的第 3 项已从单档 'bad' 扩成 good/fair/poor 三档，
         * 本视图沿用原有的红字语义（只有 poor 标红）；标签吃第 4 项的国际通用
         * 缩写——这里的标签位只有 9px，塞不进中文全称。 */
        host.innerHTML = spaceWeatherCells(state.prop).map(([key, value, tier, abbr]) =>
            '<div><label>' + esc(abbr || key) + '</label><b class="' +
            (tier === 'poor' ? 'bad' : '') + '">' +
            esc(value) + '</b></div>').join('');
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
        const radio = radioOf(key);
        const band = radio && radio.freqKhz ? bandOf(radio.freqKhz) : '';
        if (band) return band.toLowerCase();
        const latest = lastQsoFor(key);
        return latest ? bandKey(latest.band || bandLabel(latest.freqKhz)).toLowerCase() : '';
    }

    /* A switcher/matrix that is actually wired up is the only thing that can
     * move an antenna to a band the radio is not on, so the strip only shows
     * pre-emption when one exists. A manual switcher still counts: the operator
     * throws it by hand and the system records that as done for every seat. */
    function hasActiveSwitcher() {
        const snapshot = deviceSnapshot();
        if (!snapshot || !Array.isArray(snapshot.devices)) return false;
        return snapshot.devices.some(device => device.type === 'switch' || device.type === 'matrix');
    }

    /* Band-occupancy strip: one cell per HF band.
     *   occupied  — a seat's radio is on this band (bandOf(freqKhz)).
     *   preempted — a seat claimed a frequency on this band while its radio is
     *               still elsewhere; only meaningful with an active switcher.
     *   free      — neither. The operator callsign stacks under the band so the
     *               OP can see who holds it; multiple seats on the same band
     *               are listed together. This is the one sanctioned place where
     *               the operational UI surfaces a callsign (the opcall-exception
     *               markers below are whitelisted by tests/architecture.test.js). */
    /* opcall-exception:start */
    function renderBandOccupancy() {
        const body = $('#opBandOccBody');
        if (!body) return;
        const occupied = new Map();
        for (const key of Object.keys(radios())) {
            const radio = radios()[key] || {};
            const freq = Number(radio.freqKhz);
            if (!Number.isFinite(freq) || freq <= 0) continue;
            const band = bandOf(freq);
            if (!HF_BANDS.includes(band)) continue;
            const list = occupied.get(band) || [];
            const call = String(radio.opCall || '').trim();
            if (call && !list.includes(call)) list.push(call);
            occupied.set(band, list);
        }
        const preempted = new Map();
        if (hasActiveSwitcher()) {
            for (const claim of frequencyClaims()) {
                const freq = Number(claim && claim.freqKhz);
                if (!Number.isFinite(freq) || freq <= 0) continue;
                const band = bandOf(freq);
                if (!HF_BANDS.includes(band)) continue;
                const seatRadio = radioOf(claim.seat) || {};
                const seatFreq = Number(seatRadio.freqKhz);
                const seatBand = Number.isFinite(seatFreq) && seatFreq > 0 ? bandOf(seatFreq) : '';
                if (seatBand === band) continue; // radio already here → occupied, not pre-empted
                const list = preempted.get(band) || [];
                const call = String(claim.operator || seatRadio.opCall || '').trim();
                if (call && !list.includes(call)) list.push(call);
                preempted.set(band, list);
            }
        }
        body.innerHTML = HF_BANDS.map(band => {
            const occ = occupied.get(band);
            const pre = preempted.get(band);
            let cls = 'free';
            let calls = [];
            if (occ && occ.length) { cls = 'occupied'; calls = occ; }
            else if (pre && pre.length) { cls = 'preempted'; calls = pre; }
            return '<div class="op-bandocc-cell ' + cls + '">' +
                '<span class="op-bandocc-band">' + esc(band) + '</span>' +
                '<span class="op-bandocc-calls">' + calls.map(call => esc(call)).join('<br>') +
                '</span></div>';
        }).join('');
        const legend = $('#opBandOccLegend');
        if (legend) {
            legend.innerHTML = ['free', 'occupied', 'preempted'].map(item =>
                '<span><i class="' + item + '"></i>' + esc(t('op.bandocc.' + item)) + '</span>').join('');
        }
    }
    /* opcall-exception:end */

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
        return (ctx.settings && ctx.settings.lang) || (ctx.i18n && ctx.i18n.language) || 'en';
    }

    /* Prefer the UI language, then English. Chinese is only used when the UI
       itself is Chinese, so a non-Chinese operator never sees a Chinese card. */
    function pickText(value) {
        if (!value) return '';
        if (typeof value === 'string') return value;
        const lang = adviceLang();
        return value[lang] || value.en || (lang === 'zh' ? value.zh : '') || '';
    }

    /* Server-side rule engine output. When it is live it replaces the local
       RUN-idle reminder, so there is only one reminder path in the OP view. */
    function laneLabel(lane) {
        const radio = lane && lane.radio || {};
        const seatValue = String(lane && lane.seat || '');
        /* No computer name here either: the seat ordinal is the display name. */
        return radio.radioName || (seatValue ? seatNameOf(seatValue) : t('op.radio.n', {n: 1}));
    }

    function engineAdvice() {
        const data = state.adviceEngine;
        if (!data || !data.ok) return [];
        let lanes = Array.isArray(data.seats) && data.seats.length > 1
            ? data.seats
            : [{seat: data.seat, radio: null, gates: data.gates, advice: data.advice}];
        const selected = currentSeat();
        if (selected) {
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

    /* The advice card is never hidden: every category renders it, and when no
     * rule fires it explains why instead of leaving an empty strip. */
    function adviceGeneric() {
        const book = state.adviceEngine && state.adviceEngine.contest &&
            state.adviceEngine.contest.ruleBook;
        return !!(book && book.structured === false);
    }

    /* Two different silences: no data yet (loading, failed request, no QSO)
     * versus a category without structured rules feeding generic advice. */
    function adviceNote(list) {
        if (list.length) {
            if (state.adviceStatus === 'failed') return t('op.advice.failed');
            return adviceGeneric() ? t('op.advice.generic') : '';
        }
        if (state.adviceStatus === 'off') return t('op.advice.off');
        if (state.adviceStatus === 'failed') return t('op.advice.failed');
        if (state.adviceStatus === 'loading' || !state.adviceEngine) return t('op.advice.loading');
        if (state.adviceEngine.degraded === 'no-qsos') return t('op.advice.noQsos');
        return adviceGeneric() ? t('op.advice.generic') : t('op.advice.none');
    }

    function renderAdvice() {
        const host = $('#opAdvice');
        if (!host) return;
        const list = engineAdvice().concat(multiplierAdvice())
            .concat(engineLive() ? [] : runIdleAdvice());
        const note = adviceNote(list);
        host.classList.remove('hidden');
        host.innerHTML = '<span class="op-advice-title">' + esc(t('op.advice.title')) + '</span>' +
            list.map(item => '<span class="op-advice-item ' + item.kind + '">' +
                '<span class="op-advice-text">' + esc(item.text) + '</span>' +
                (item.why ? '<i class="op-advice-why">' + esc(item.why) + '</i>' : '') +
                (item.missing && item.missing.length
                    ? '<i class="op-advice-missing">⚠ ' + esc(item.missing.join(',')) + '</i>' : '') +
                '<button type="button" class="op-advice-close" ' +
                'data-op-advice="' + esc(item.key) + '" title="' + esc(t('op.advice.dismiss')) +
                '">×</button></span>').join('') +
            (note ? '<span class="op-advice-note">' + esc(note) + '</span>' : '');
    }

    async function loadAdvice() {
        if (ctx.settings.adviceEnabled === false) {
            state.adviceEngine = null;
            state.adviceStatus = 'off';
            renderAdvice();
            return;
        }
        /* Keep showing the previous answer while a refresh is in flight. */
        if (!state.adviceEngine) state.adviceStatus = 'loading';
        try {
            const seat = currentSeat();
            // 只有服务端真实席位键（DXI 复合键）才按席位请求；占位电台号
            // 传过去会凭空多出一个 lane。
            state.adviceEngine = await fetchAdvice({
                seat: seat.includes(':') ? seat : ''
            });
            state.adviceStatus = state.adviceEngine ? 'ready' : 'failed';
        } catch (error) {
            state.adviceEngine = null;
            state.adviceStatus = 'failed';
        }
        renderAdvice();
    }

    function statusRank(status) {
        return {pending: 0, new: 1, worked: 2}[status] || 3;
    }

    function suspectReason(item) {
        if (item.status === 'checking') return t('op.suspect.checking');
        if (!item.scp && !item.qrz) {
            if (item.status === 'passed') return t('op.suspect.passed');
            if (item.status === 'unverified') return t('op.suspect.unverified');
            return t('op.suspect.qrzNotFound');
        }
        // SCP 与 QRZ 各自给一句结果，不因其中一层未配置就省略另一层。
        const scpKey = {
            hit: 'scpPassed', miss: 'scpMissed', disabled: 'scpDisabled'
        }[item.scp && item.scp.status] || 'scpUnavailable';
        const qrzKey = {
            found: 'qrzPassed', 'not-found': 'qrzMissed',
            disabled: 'qrzDisabled', unavailable: 'qrzUnavailable'
        }[item.qrz && item.qrz.status] || 'qrzError';
        return t('op.suspect.' + scpKey) + t('op.suspect.sep') + t('op.suspect.' + qrzKey);
    }

    function renderSuspects() {
        const host = $('#opSuspicious');
        const credit = '<div class="op-scp-credit">' + esc(t('op.suspect.scpCredit')) + '</div>';
        if (!ctx.settings.opSuspiciousCheck) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.suspect.empty')) + '</div>' + credit;
            return;
        }
        // 只显示当前席位的记录：其他席位即使有待确认项也留在内存里，切回时再显示。
        const allowed = new Set(visibleSeats().map(String));
        const rank = item => item.status === 'failed' ? 0 : item.status === 'checking' ? 1 : 2;
        const list = [...state.suspects.values()]
            .filter(item => allowed.has(String(item.seat)))
            .sort((a, b) => rank(a) - rank(b) || timeOf(b.ts) - timeOf(a.ts));
        if (!list.length) {
            host.innerHTML = '<div class="op-empty">' + esc(t('op.suspect.empty')) + '</div>' + credit;
            return;
        }
        host.innerHTML = list.map(item => {
            const radio = radioTheme(item.radioNr);
            const failed = item.status === 'failed' || item.status === 'not-found';
            const statusClass = item.status === 'passed' ? ' passed'
                : failed ? ' failed'
                : item.status === 'checking' ? ' checking' : ' unverified';
            return '<div class="op-suspect ' + radio + statusClass + '">' +
                '<div class="op-suspect-head"><b>' + esc(item.call) + '</b><span>' +
                esc(t('op.suspect.radio', {n: item.radioNr})) + ' · ' +
                esc(bandKey(item.band || bandLabel(item.freqKhz))) + ' · ' +
                esc(new Date(item.ts).toISOString().slice(11, 16) + 'Z') + '</span></div>' +
                '<div class="op-suspect-reason">' + esc(suspectReason(item)) + '</div>' +
                (failed
                    ? '<div class="op-suspect-note">' + esc(t('op.suspect.note')) + '</div>' +
                        '<div class="op-suspect-actions">' +
                        '<button type="button" class="primary" data-op-ok="' + esc(item.key) + '">' +
                        esc(t('op.suspect.ok')) + '</button>' +
                        '<button type="button" class="warn" data-op-fixed="' + esc(item.key) + '">' +
                        esc(t('op.suspect.fixed')) + '</button></div>'
                    : '') +
            '</div>';
        }).join('') + credit;
    }

    /* 图例的一行：SO2R 说的是同一台机器上的两个电台，措辞保持「电台 1/2」；
     * 其余赛制按席位编号说话，和席位铭牌上的序号同一个口径。 */
    function mapLegendLabel(key) {
        const number = seatNumber(key);
        if (category() === 'SO2R' && (number === 1 || number === 2)) {
            return t(number === 1 ? 'op.map.legend.radio1' : 'op.map.legend.radio2');
        }
        return seatNameOf(key);
    }

    function renderMapLegend() {
        const current = String(currentSeat());
        /* 只列图上真的画了线的席位，一个都没有就退回本席位，图例不会空白。 */
        const keys = mapSeatKeys(current).filter(key => qsosFor(key).length);
        if (!keys.length) keys.push(current);
        const parts = keys.map(key => '<span' + (String(key) === current ? ' class="own"' : '') +
            '><i style="background:var(--op-r' + seatLane(key) + ')"></i>' +
            esc(mapLegendLabel(key)) + '</span>');
        parts.push('<span><i style="background:var(--map-open)"></i>' + esc(t('op.map.legend.home')) + '</span>');
        parts.push('<span><i style="background:var(--map-spot);border-radius:1px"></i>' +
            esc(t('op.map.legend.spot')) + '</span>');
        $('#opMapLegend').innerHTML = parts.join('');
        $('#opMapCredit').textContent = t('op.map.fixedBorders');
    }

    /* SPOT rows carry no seat field, so a seat owns the spots its own radio
     * could have produced: same band, same mode family. Both sides are read
     * with the same ruler (wall bandOf over kHz, one mode vocabulary), so the
     * labels can never disagree across a case or a VHF boundary. A side that
     * cannot be determined widens the match instead of hiding data. */
    function modeFamily(value) {
        const mode = String(value || '').trim().toUpperCase();
        if (!mode) return '';
        if (/\bCW\b/.test(mode)) return 'CW';
        if (/\b(SSB|USB|LSB|AM|FM|PHONE)\b/.test(mode)) return 'PHONE';
        if (/FT8|FT4|RTTY|PSK|JT65|JT9|JS8|MFSK|OLIVIA|CONTESTIA|DOMINO|HELL|THOR|THROB|DIGI/.test(mode)) return 'DIGI';
        return '';
    }

    function spotsForSeat(key) {
        const cutoff = Date.now() - (Number(ctx.settings.mySpotTtl) || 30) * 60000;
        const live = state.mySpots.filter(spot => timeOf(spot.timestamp) >= cutoff);
        const radio = radioOf(key);
        const freq = Number(radio && radio.freqKhz);
        /* No radio state for this seat yet: the whole station's spots stay on
         * the map rather than an empty one. */
        if (!freq) return live;
        const band = bandOf(freq);
        const mode = modeFamily(radio.mode);
        return live.filter(spot => {
            const spotFreq = Number(spot.freq);
            if (!spotFreq || bandOf(spotFreq) !== band) return false;
            const spotMode = modeFamily(spot.mode) || modeFamily(spot.comment);
            return !mode || !spotMode || spotMode === mode;
        });
    }

    /* 地图上的席位泳道：颜色按席位编号取 --op-r1..--op-r6，和席位铭牌上印的
     * 序号同一个口径；席位多于 6 个时循环复用，编号仍然分得开。 */
    const MAP_LANES = 6;

    function seatLane(key) {
        return ((seatNumber(key) - 1) % MAP_LANES) + 1;
    }

    /* 画进地图的席位 = 当前席位列表 ∪ QSO 里真实出现过的席位。
     * 席位被清理掉（掉线、重连抖动）之后它的历史 QSO 还得留在图上，
     * 所以不能只按 seatChoices 取，否则老席位的线会凭空消失。 */
    function mapSeatKeys(current) {
        const keys = orderedSeatChoices().map(choice => String(choice.value));
        const seen = new Set(keys);
        [...state.qsos.values()].forEach(qso => {
            const seat = seatOfQso(qso);
            if (!seen.has(seat)) {
                seen.add(seat);
                keys.push(seat);
            }
        });
        if (!seen.has(String(current))) keys.push(String(current));
        return keys;
    }

    /* 本席位与其他席位的 QSO 都要上图：每个席位各自截断，本席位不会被
     * 别的席位挤出画面；行上带 seatLane/ownSeat，由 op-map 决定线宽与颜色。 */
    function mapQsos(current, limit) {
        const keys = mapSeatKeys(current);
        const own = String(current);
        const perSeat = Math.max(20, Math.floor(limit / Math.max(1, keys.length)));
        const rows = [];
        keys.forEach(seat => {
            qsosFor(seat).slice(-perSeat).forEach(qso => {
                rows.push(Object.assign({}, qso, {
                    seatLane: seatLane(seat),
                    ownSeat: seat === own
                }));
            });
        });
        return rows;
    }

    function renderMap() {
        if (!state.map) return;
        const home = homeLatLon();
        state.map.setHome(home);
        state.map.setCoverage(activeAzimuth());
        const limit = Math.min(600, Math.max(60, Number(ctx.settings.qsoMax) || 1500));
        const key = currentSeat();
        state.map.setData({
            /* Seat ownership is decided here, by the same rule every other
             * seat-scoped number on this page uses. radioNr is not usable:
             * every M2 instance reports 1, and the column is often missing. */
            qsos: mapQsos(key, limit),
            spots: spotsForSeat(key),
            radioFilter: 'all'
        });
        renderMapLegend();
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
        const rotator = rotatorDevice();
        if (!rotator || info && info.blocked) {
            showMapFlag(t('op.map.rotatorOff'));
            return;
        }
        state.rotorTarget = Math.round(deg);
        /* 点击立即把覆盖扇区画到目标方位，不等命令往返；随后 loadDevices 轮询会
         * 用 activeAzimuth()（同样优先 rotorTarget）保持这个朝向不被刷回物理方位。 */
        if (state.map) state.map.setCoverage(state.rotorTarget);
        void sendDeviceCommand(rotator.id, {command: 'rotate', azimuth: state.rotorTarget}, {seat: commandSeat()})
            .then(result => {
                const ok = !!result && result.ok !== false;
                showMapFlag(t('op.device.rotator.target', {deg: state.rotorTarget}) +
                    (ok ? '' : ' · ' + t('op.device.commandFailed') + errorNote(result)));
                if (ok) void loadDevices();
                renderBottom();
            })
            .catch(error => showMapFlag(t('op.device.commandFailed') + errorNote(null, error)));
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
                ? t('op.claim.occupiedBy', {seat: seatNameOf(occupied.seat)})
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

    function deviceSnapshot() {
        return state.devices;
    }

    function controlDevices() {
        const snapshot = deviceSnapshot();
        if (!snapshot || !Array.isArray(snapshot.devices)) return [];
        return snapshot.devices.filter(device => ['rotator', 'switch', 'matrix', 'tower'].includes(device.type));
    }

    function commandSeat() {
        return currentSeat() || 'OP';
    }

    /* Accumulated (un-wrapped) needle angles so the compass always turns the
     * short way across the 0/360 seam instead of spinning a full circle. Reset
     * whenever the panel is rebuilt for a different rotator or seat. */
    let needleAngle = null;
    let targetAngle = null;

    function shortestDelta(from, to) {
        let d = (to - from) % 360;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        return d;
    }

    /* Operator-defined quick-turn presets: up to eight named absolute bearings.
     * A short click steers straight to the saved angle; a long press opens an
     * inline editor for that slot's name + bearing. Persisted only in the
     * browser — the rotator itself has no preset memory. */
    const PRESET_KEY = 'dxcompass-op-rotor-presets';
    const PRESET_COUNT = 8;
    let antennaDirty = false;
    // 当前天线控制面板所聚焦的旋转器 id，用于识别「换了一台旋转器」。
    let rotorFocusId = '';
    let presetEditing = null;
    let pressTimer = null;
    let pressLongFired = false;
    let pressIndex = null;
    let jogTimer = null;
    let jogRepeat = null;
    let jogLongFired = false;
    let jogRotator = null;
    let jogCurrent = null;
    let jogDir = 0;

    const normDeg = value => ((Math.round(Number(value)) % 360) + 360) % 360;

    function loadPresets() {
        try {
            const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
            return Array.isArray(raw) ? raw : [];
        } catch (error) {
            return [];
        }
    }

    function savePresets(list) {
        try {
            localStorage.setItem(PRESET_KEY, JSON.stringify(list.slice(0, PRESET_COUNT)));
        } catch (error) {
            // Private mode / quota: the in-memory view still works this session.
        }
    }

    function presetAt(index) {
        const item = loadPresets()[index];
        if (!item) return null;
        const azimuth = Number(item.azimuth);
        if (!Number.isFinite(azimuth)) return null;
        return {label: String(item.label || '').slice(0, 24), azimuth: normDeg(azimuth)};
    }

    function writePreset(index, value) {
        const list = loadPresets();
        while (list.length < PRESET_COUNT) list.push(null);
        list[index] = value;
        savePresets(list);
        antennaDirty = true;
        renderBottom();
    }

    /* The quick-turn editor opens as a modal popup on <body>, not as a panel
     * inside the narrow antenna card: an inline form had nowhere to grow and
     * shoved the dial around. Keeping it off the card also means the periodic
     * rotator poll (which never rebuilds this node) cannot disturb a half-typed
     * name or angle. */
    function presetOverlay() {
        let el = document.getElementById('opPresetOverlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'opPresetOverlay';
            el.className = 'op-preset-overlay hidden';
            document.body.appendChild(el);
        }
        return el;
    }

    function renderPresetEditor() {
        const el = presetOverlay();
        if (presetEditing === null) {
            el.classList.add('hidden');
            el.innerHTML = '';
            return;
        }
        const preset = presetAt(presetEditing);
        el.innerHTML =
            '<div class="op-preset-backdrop" data-op-preset-cancel></div>' +
            '<div class="op-ant-editor op-preset-dialog" role="dialog" aria-modal="true">' +
            '<div class="op-preset-title">' +
            esc(t('op.device.rotator.preset', {n: presetEditing + 1})) + '</div>' +
            '<div class="op-ant-editor-fields">' +
            '<label>' + esc(t('op.device.rotator.presetName')) +
            '<input data-op-preset-name type="text" maxlength="24" value="' + esc(preset ? preset.label : '') + '"></label>' +
            '<label>' + esc(t('op.device.rotator.presetAngle')) +
            '<input data-op-preset-angle type="number" min="0" max="360" step="1" inputmode="numeric" value="' +
            (preset ? preset.azimuth : '') + '"></label></div>' +
            '<div class="op-ant-editor-actions">' +
            '<button type="button" data-op-preset-save>' + esc(t('op.device.rotator.presetSave')) + '</button>' +
            '<button type="button" data-op-preset-clear>' + esc(t('op.device.rotator.presetClear')) + '</button>' +
            '<button type="button" data-op-preset-cancel>' + esc(t('op.device.rotator.presetCancel')) + '</button>' +
            '</div></div>';
        el.classList.remove('hidden');
        const nameEl = el.querySelector('[data-op-preset-name]');
        if (nameEl) nameEl.focus();
    }

    function openPresetEditor(index) {
        presetEditing = index;
        renderPresetEditor();
    }

    function closePresetEditor() {
        presetEditing = null;
        renderPresetEditor();
    }

    function savePresetFromForm(index) {
        const el = presetOverlay();
        const nameEl = el.querySelector('[data-op-preset-name]');
        const angleEl = el.querySelector('[data-op-preset-angle]');
        if (!nameEl || !angleEl) { closePresetEditor(); return; }
        const azimuth = Number(angleEl.value);
        if (!Number.isFinite(azimuth)) {
            angleEl.focus();
            return;
        }
        const name = String(nameEl.value).trim().slice(0, 24) ||
            t('op.device.rotator.preset', {n: index + 1});
        closePresetEditor();
        writePreset(index, {label: name, azimuth: normDeg(azimuth)});
    }

    function clearPreset(index) {
        closePresetEditor();
        writePreset(index, null);
    }

    /* Fire a preset. An empty slot long-presses into the editor; a short tap on
     * an empty slot also opens the editor so the first setup needs no hunting. */
    function activatePreset(index) {
        const rotator = rotatorDevice();
        const preset = presetAt(index);
        if (!preset) {
            openPresetEditor(index);
            return;
        }
        if (!rotator) return;
        state.rotorTarget = preset.azimuth;
        void sendDeviceCommand(rotator.id, {command: 'rotate', azimuth: preset.azimuth},
            {seat: commandSeat()})
            .then(() => loadDevices())
            .catch(() => null);
        renderBottom();
    }

    function presetDown(index) {
        pressIndex = index;
        pressLongFired = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
            pressLongFired = true;
            openPresetEditor(index);
        }, 500);
    }

    function presetUp() {
        clearTimeout(pressTimer);
        pressTimer = null;
        if (!pressLongFired && pressIndex !== null) activatePreset(pressIndex);
        pressLongFired = false;
        pressIndex = null;
    }

    /* Left / right trim: a tap nudges ±1°, holding repeats ±10° and accumulates
     * the commanded target so a run of presses actually travels. The rotator's
     * own interlock still refuses a new bearing mid-travel; those refusals land
     * in the command feedback like any other rotate. */
    function jogBaseValue(rotator) {
        const snap = deviceSnapshot();
        const view = (snap && (snap.rotators || {})[rotator.id]) || {};
        if (Number.isFinite(state.rotorTarget)) return normDeg(state.rotorTarget);
        const physical = Number(view.physical_azimuth);
        return Number.isFinite(physical) ? normDeg(physical) : null;
    }

    function jogSend(rotator, target) {
        state.rotorTarget = target;
        return sendDeviceCommand(rotator.id, {command: 'rotate', azimuth: target},
            {seat: commandSeat()}).catch(() => null);
    }

    function jogClearTimers() {
        clearTimeout(jogTimer);
        clearTimeout(jogRepeat);
        jogTimer = null;
        jogRepeat = null;
    }

    function jogHoldStep() {
        if (!jogRotator) return;
        jogCurrent = normDeg(jogCurrent + jogDir * 10);
        void jogSend(jogRotator, jogCurrent);
    }

    function jogStart(rotator, dir) {
        if (!rotator) return;
        jogClearTimers();
        const base = jogBaseValue(rotator);
        if (base === null) return;
        jogRotator = rotator;
        jogDir = dir;
        jogCurrent = base;
        jogLongFired = false;
        jogTimer = setTimeout(() => {
            jogLongFired = true;
            jogHoldStep();
            jogRepeat = setInterval(jogHoldStep, 350);
        }, 400);
    }

    function jogRelease() {
        if (!jogTimer && !jogRepeat) return;
        jogClearTimers();
        if (!jogLongFired && jogRotator) void jogSend(jogRotator, normDeg(jogCurrent + jogDir));
        jogRotator = null;
        jogLongFired = false;
        renderBottom();
    }

    /* Antenna control auto-picks the rotator that steers the antenna this seat
     * is actually routed to. The server's ownership projection links every
     * antenna to its rotator (`antennas[].rotator_id`, found by walking the
     * mechanical parent chain) and records which antennas this seat currently
     * has switched in (`by_seat[seat].ant_switch.routed`). Follow that routed
     * set FIRST: it is exactly what the 「切换天线」 button just changed, so the
     * rotor panel tracks the antenna the operator selected instead of staying
     * on the band-reachable `assigned` / `candidates` guess. */
    function rotatorDevice() {
        const snap = deviceSnapshot();
        if (!snap) return null;
        const rotators = controlDevices().filter(device => device.type === 'rotator');
        if (!rotators.length) return null;
        const byId = new Map(rotators.map(device => [String(device.id), device]));
        const own = snap.ownership || {};
        const antennas = Array.isArray(own.antennas) ? own.antennas : [];
        const antById = new Map(antennas.map(item => [String(item.id), item]));
        const rotatorForAntennas = ids => {
            for (const id of ids) {
                const antenna = antById.get(String(id));
                if (!antenna || !antenna.rotator_id) continue;
                const hit = byId.get(String(antenna.rotator_id));
                if (hit) return hit;
            }
            return null;
        };
        const bySeat = own.by_seat || {};
        const seat = String(currentSeat() || '');
        let view = bySeat[seat] || null;
        if (!view) {
            const keys = Object.keys(bySeat);
            const loose = keys.find(key =>
                key === seat || key.endsWith(':' + seat) || key.split(':').pop() === seat);
            view = (loose ? bySeat[loose] : null) ||
                keys.map(key => bySeat[key]).find(item => item && item.online) || null;
        }
        if (view) {
            // 「切换天线」写入的是 ant_switch.routed（含尚未回读证实的命令意图），
            // 它与波段无关：切到哪副天线就该控制那副天线底下的旋转器。
            const routed = (view.ant_switch || {}).routed;
            const chosen = rotatorForAntennas(Array.isArray(routed) ? routed : []) ||
                rotatorForAntennas(view.assigned || []) ||
                rotatorForAntennas(view.candidates || []);
            if (chosen) return chosen;
        }
        if (rotators.length === 1) return rotators[0];
        return rotatorForAntennas(antennas.map(item => item.id)) || rotators[0];
    }

    /** Live heading of the auto-selected rotator, or null when it has no fix. */
    function activeAzimuth() {
        const snap = deviceSnapshot();
        const rotator = rotatorDevice();
        if (!snap || !rotator) return null;
        const view = (snap.rotators || {})[rotator.id] || {};
        /* 覆盖扇区优先画到「已下达的目标方位」：点击地图/预设/微调一旦设定目标，
         * 扇区就指向目标；没有目标时才回退到天线当前的物理方位。物理实时指向仍由
         * 底部罗盘（updateAntenna）单独呈现。 */
        if (Number.isFinite(state.rotorTarget)) return normDeg(state.rotorTarget);
        const value = Number(view.physical_azimuth);
        return Number.isFinite(value) ? value : null;
    }

    async function loadDevices() {
        try {
            const data = await getDevicesSnapshot();
            state.devices = data && data.ok ? data : null;
        } catch (error) {
            state.devices = null;
        }
        renderBottom();
        renderAmps();
        renderBandOccupancy();
        renderAntSwitch();
        renderStationCard();
        renderCameraCard();
        if (state.map) state.map.setCoverage(activeAzimuth());
    }

    /* Antenna control: no device cards. The one rotator that steers the
     * antenna this seat is using drives a live bearing compass; the map wedge
     * (op-map.setCoverage) shares the same heading. */
    function renderBottom() {
        const host = $('#opBottom');
        if (!host) return;
        const note = $('#opBottomNote');
        const rotator = rotatorDevice();
        const focusId = rotator ? String(rotator.id) : '';
        if (focusId !== rotorFocusId) {
            rotorFocusId = focusId;
            /* 焦点换到另一台旋转器：上一台的目标方位角必须作废，否则 activeAzimuth()
             * 与 jogBaseValue() 都优先读 rotorTarget，会把旧天线的指向带到新天线上。 */
            state.rotorTarget = null;
        }
        if (rotator) {
            if (note) note.textContent = rotator.name || '';
            const view = ((deviceSnapshot() || {}).rotators || {})[rotator.id] || {};
            const key = String(rotator.id) + '|' + String(currentSeat());
            if (host.dataset.antennaKey !== key) closePresetEditor();
            if (host.dataset.antennaKey !== key || antennaDirty) {
                host.dataset.antennaKey = key;
                antennaDirty = false;
                needleAngle = null;
                targetAngle = null;
                host.innerHTML = antennaMarkup(rotator);
            }
            updateAntenna(view);
            return;
        }
        delete host.dataset.antennaKey;
        closePresetEditor();
        if (note) note.textContent = deviceSnapshot() ? t('op.map.rotatorOff') : t('op.bottom.none');
        const keys = visibleSeats();
        const cards = keys.map(key => {
            const radio = radioOf(key);
            return '<div class="op-radio-card ' + radioTheme(key) + '"><b>' +
                esc(radioName(key)) + '</b><span>' +
                esc(radio && radio.freqKhz ? bandOf(radio.freqKhz) + ' ' + mini(radio.mode) : t('op.radio.waiting')) +
                '</span>' + claimControls(key, radio) + '</div>';
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

    /* 天线切换：按钮集合取自服务端沿 RF 连线的拓扑投影
     * （ownership.by_seat[seat].ant_switch.reachable）——同轴物理可达就列入，
     * 忽略切换器当前指向、也不按波段过滤。配色直接用 antennas[].switch_color_by_seat，
     * 与波段占用同一套语义：红=本席位接通、黄=他席占用、绿=空闲；
     * 前端不重算走线、不显示端口，也不显示占用者。 */
    function antSwitchSeatHit() {
        const bySeat = ((deviceSnapshot() || {}).ownership || {}).by_seat || {};
        const seat = String(currentSeat() || '');
        const key = Object.keys(bySeat).find(item =>
            item === seat || item.endsWith(':' + seat) || item.split(':').pop() === seat);
        return key ? {key, view: bySeat[key]} : null;
    }

    function renderAntSwitch() {
        const host = $('#opAntSwitch');
        if (!host) return;
        const note = $('#opAntSwitchNote');
        const antEmpty = key => {
            if (note) {
                note.textContent = '';
                note.classList.remove('op-antswitch-pending');
            }
            host.innerHTML = '<div class="op-empty">' + esc(t(key)) + '</div>';
        };
        const snapshot = deviceSnapshot();
        if (!snapshot) {
            antEmpty('op.antswitch.loading');
            return;
        }
        const hit = antSwitchSeatHit();
        const info = hit ? hit.view.ant_switch : null;
        // 投影给不出结论（本席位没绑到电台节点，或整张图没有 RF 连线）时
        // 提示"未知"，不能显示成"一副天线都接不到"。
        if (!info || !Array.isArray(info.reachable)) {
            antEmpty('op.antswitch.unknown');
            return;
        }
        if (!info.reachable.length) {
            antEmpty('op.antswitch.none');
            return;
        }
        const antennas = new Map(((snapshot.ownership || {}).antennas || [])
            .map(item => [String(item.id), item]));
        const chips = info.reachable.map(id => {
            const antenna = antennas.get(String(id)) || {};
            const color = (antenna.switch_color_by_seat || {})[hit.key] || 'green';
            const cls = color === 'red' ? 'occupied' : color === 'yellow' ? 'preempted' : 'free';
            // 标签只显示天线名称，占用者与波段都不显示。
            const name = String(antenna.name || id);
            return '<button type="button" class="op-antswitch-btn ' + cls +
                '" data-op-ant-route="' + esc(id) + '" title="' + esc(name) + '">' +
                esc(name) + '</button>';
        }).join('');
        // 外壳带 .op-device，让既有的 deviceFeedback 能找到这条反馈栏。
        host.innerHTML = '<div class="op-antswitch-track op-device">' + chips +
            '<span class="op-device-result"></span></div>';
        // 接通只来自下发的命令、硬件还没回读证实：标题旁一个弱标记，不改按钮主色。
        if (note) {
            note.textContent = info.unconfirmed ? t('op.antswitch.unconfirmed') : '';
            note.classList.toggle('op-antswitch-pending', !!info.unconfirmed);
        }
    }

    /* 视频监控：显示本席位当前接通天线所绑定的摄像头（antenna.config.camera）。
     * 绑定关系和设备清单本来就在 /api/devices 快照里下发（publicDevice 原样带
     * config，只剥 password），所以这里只做一次查表，不再另开一条数据通道。
     * 画面由服务器拉取后按 MJPEG 分发（nodes/camera-hub.js），浏览器只负责
     * <img> 加载：既不碰 fetch，也不重复实现一路 WebSocket。 */
    let cameraShownId = '';

    function cameraEmpty(noteText, key) {
        const host = $('#opCameraBody');
        const note = $('#opCameraNote');
        if (note) note.textContent = noteText || '';
        cameraShownId = '';
        if (host) host.innerHTML = '<div class="op-camera-empty">' + esc(t(key)) + '</div>';
    }

    /** 接通的天线里第一副绑了现存摄像头的，就是要在屏幕上看到的那一路。 */
    function cameraForSeat(snapshot, routed) {
        const byId = new Map((Array.isArray(snapshot.devices) ? snapshot.devices : [])
            .map(item => [String(item.id), item]));
        for (const id of routed) {
            const antenna = byId.get(String(id));
            if (!antenna || antenna.type !== 'antenna') continue;
            const cameraId = String((antenna.config || {}).camera || '');
            if (!cameraId) continue;
            const camera = byId.get(cameraId);
            if (!camera || camera.type !== 'camera') continue;
            return {antenna, camera};
        }
        return null;
    }

    function renderCameraCard() {
        const host = $('#opCameraBody');
        if (!host) return;
        const snapshot = deviceSnapshot();
        if (!snapshot) {
            cameraEmpty('', 'op.camera.loading');
            return;
        }
        const hit = antSwitchSeatHit();
        const info = hit ? hit.view.ant_switch : null;
        const routed = info && Array.isArray(info.routed) ? info.routed : [];
        if (!routed.length) {
            cameraEmpty('', 'op.camera.idle');
            return;
        }
        const found = cameraForSeat(snapshot, routed);
        if (!found) {
            // 接通了天线但没人绑摄像头：把天线名写在标题旁，指明该去哪儿补。
            const names = routed.map(id => {
                const device = (snapshot.devices || []).find(item => String(item.id) === String(id));
                return device ? device.name : '';
            }).filter(Boolean).join('/');
            cameraEmpty(names, 'op.camera.unbound');
            return;
        }
        const id = String(found.camera.id);
        const note = [found.camera.name, found.antenna.name].filter(Boolean).join(' · ');
        // 同一路画面绝不重建 <img>：重建等于每次都重连 MJPEG。
        if (cameraShownId === id && host.querySelector('img')) {
            const noteEl = $('#opCameraNote');
            if (noteEl) noteEl.textContent = note;
            return;
        }
        cameraEmpty(note, '');
        const img = document.createElement('img');
        img.alt = '';
        img.addEventListener('error', () => {
            // 断流只显示"无信号"，不自动重连：换天线或刷新页面才会重建。
            if (cameraShownId !== id) return;
            cameraEmpty(note, 'op.camera.lost');
        });
        img.src = '/api/cameras/' + encodeURIComponent(id) + '/stream';
        host.appendChild(img);
        cameraShownId = id;
    }

    /* 电台卡片：收发状态、当前波段、当前频率、当前模式，加频率联动开关。
     * 联动在哪切、为什么没切，全由服务端判（lib/devices/band-link.js），
     * 这里只把结论摊开写明白——"没动作"也必须说得出原因。 */
    function stationSeatKey() {
        const hit = antSwitchSeatHit();
        return hit ? hit.key : '';
    }

    function bandLinkEntry() {
        const link = (deviceSnapshot() || {}).band_link || {};
        const seat = stationSeatKey();
        return seat && link.seats ? (link.seats[seat] || null) : null;
    }

    const LINK_NOTE_CLASS = {
        ok: ['single-band', 'only', 'preferred', 'already'],
        bad: ['route-failed']
    };

    function linkNoteClass(reason) {
        if (LINK_NOTE_CLASS.ok.includes(reason)) return 'ok';
        if (LINK_NOTE_CLASS.bad.includes(reason)) return 'bad';
        return 'warn';
    }

    function linkNoteText(entry) {
        if (!entry) return t('op.station.linkOff');
        if (!entry.enabled) return t('op.station.linkOff');
        const last = entry.last;
        if (!last || !last.reason) return t('op.station.linkWaiting');
        const key = 'op.station.reason.' + last.reason;
        const label = t(key);
        const reason = label === key ? last.reason : label;
        const band = last.band ? ' ' + String(last.band).toUpperCase() : '';
        const antenna = last.antenna_name || last.antenna_id || '';
        if (['single-band', 'only', 'preferred'].includes(last.reason)) {
            return reason + band + ' → ' + antenna;
        }
        if (last.reason === 'already') return reason + band + ' · ' + antenna;
        return reason + band + (antenna ? ' · ' + antenna : '');
    }

    function stationMetaCell(label, value, cls, title) {
        return '<div class="op-station-meta-cell' + (cls ? ' ' + cls : '') + '">' +
            '<span>' + esc(label) + '</span>' +
            '<b' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(value) + '</b></div>';
    }

    /* 心跳只报时长，判定在线/离线用服务端投影的 age_ms 与 online，
     * 前端不再自定一套超时门限。 */
    function stationAgeText(ms) {
        const value = Number(ms);
        if (!Number.isFinite(value) || value < 0) return '--';
        const seconds = Math.round(value / 1000);
        if (seconds < 60) return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'min';
        return Math.floor(minutes / 60) + 'h';
    }

    function stationHeartbeat(view, radio) {
        if (view) {
            return view.online === true
                ? {text: stationAgeText(view.age_ms), cls: ''}
                : {text: t('op.station.offline'), cls: 'offline'};
        }
        const ts = Date.parse(String((radio && radio.ts) || ''));
        return {text: Number.isFinite(ts) ? stationAgeText(Date.now() - ts) : '--',
            cls: Number.isFinite(ts) ? '' : 'none'};
    }

    /* 接通的天线来自拓扑投影，名字查 ownership.antennas；
     * 只下发未回读的用弱色标出，与天线切换面板同一口径。 */
    function stationAntennaRead(view) {
        const switcher = view ? view.ant_switch : null;
        if (!switcher) {
            return {text: '--', cls: 'none', title: t('op.antswitch.none'), count: null};
        }
        const antennas = new Map((((deviceSnapshot() || {}).ownership || {}).antennas || [])
            .map(item => [String(item.id), item]));
        const names = (switcher.routed || []).map(id => {
            const antenna = antennas.get(String(id)) || {};
            return String(antenna.name || id);
        });
        if (!names.length) {
            return {text: '--', cls: 'none', title: t('op.station.antennaIdle'),
                count: (switcher.reachable || []).length};
        }
        const extra = names.length > 1 ? ' +' + (names.length - 1) : '';
        let title = names.join(' / ');
        if (switcher.unconfirmed) title += ' · ' + t('op.antswitch.unconfirmed');
        return {text: names[0] + extra, cls: switcher.unconfirmed ? 'pending' : '',
            title, count: (switcher.reachable || []).length};
    }

    function renderStationCard() {
        const host = $('#opStationBody');
        const toggle = $('#opBandLink');
        if (!host) return;
        // 席位键就是电台状态的键（BG7TVF-2:1 这种），必须用 currentSeat()，
        // 写成别的值只会让整张卡片静默变成"未绑定"。
        const radio = radioOf(currentSeat());
        const seatHit = antSwitchSeatHit();
        const seat = currentSeat();
        const seatView = seatHit ? seatHit.view : null;
        const band = currentBand() || (radio && radio.freqKhz ? bandOf(radio.freqKhz) : '');
        const transmitting = !!(radio && radio.isTransmitting);
        const freqKhz = radio ? Number(radio.txFreqKhz || radio.freqKhz) : NaN;
        const hasFreq = Number.isFinite(freqKhz) && freqKhz > 0;
        const sendFreqKhz = radio && radio.isSplit ? Number(radio.freqKhz) : NaN;
        const antenna = stationAntennaRead(seatView);
        const heartbeat = stationHeartbeat(seatView, radio);
        const entry = bandLinkEntry();
        const seatKnown = Boolean(stationSeatKey());
        host.innerHTML =
            '<div class="op-station-read ' + radioTheme(seat) + (transmitting ? ' tx' : '') + '">' +
                '<span class="op-station-band" title="' + esc(t('op.station.band')) + '">' +
                    esc(band ? String(band).toUpperCase() : '--') + '</span>' +
                '<span class="op-station-hz" title="' +
                    esc(hasFreq ? t('op.station.freq') + ' · ' + freqKhz + ' kHz' : t('op.station.freq')) + '">' +
                    '<b>' + esc(hasFreq ? (freqKhz / 1000).toFixed(3) : '--') + '</b>' +
                    '<i>' + esc(t('op.station.mhz')) + '</i></span>' +
                '<span class="op-station-chip mode" title="' + esc(t('op.station.mode')) + '">' +
                    esc((radio && radio.mode) || '--') + '</span>' +
                (Number.isFinite(sendFreqKhz) && sendFreqKhz > 0
                    ? '<span class="op-station-chip split" title="' +
                        esc(t('op.station.split') + ' RX ' + sendFreqKhz + ' kHz') + '">' +
                        esc(t('op.station.split')) + '<b>' + esc((sendFreqKhz / 1000).toFixed(3)) + '</b></span>'
                    : '') +
                '<span class="op-station-lamp ' +
                    (!radio ? 'none' : transmitting ? 'tx' : 'rx') + '">' +
                    '<i></i>' + esc(!radio ? t('op.station.none')
                        : transmitting ? t('op.station.tx') : t('op.station.rx')) +
                '</span>' +
            '</div>' +
            '<div class="op-station-meta">' +
                stationMetaCell(t('op.station.radio'), radioName(seat), '', seatNameOf(seat)) +
                stationMetaCell(t('op.station.antenna'), antenna.text, antenna.cls, antenna.title) +
                stationMetaCell(t('op.station.reachable'),
                    antenna.count === null ? '--' : String(antenna.count),
                    antenna.count ? '' : 'none', t('op.station.reachableHint')) +
                stationMetaCell(t('op.station.heartbeat'), heartbeat.text, heartbeat.cls, '') +
            '</div>' +
            '<div class="op-station-note ' + (entry && entry.enabled ? linkNoteClass((entry.last || {}).reason) : '') +
            '" id="opStationNote">' + esc(seatKnown
                ? linkNoteText(entry)
                : t('op.station.linkUnbound')) + '</div>';
        const card = host.closest('.op-station-card');
        if (card) card.dataset.tx = transmitting ? '1' : '0';
        if (toggle) {
            /* 用户刚点下去、服务端还没回话时不要用旧快照把勾选改回去。 */
            if (host.dataset.busy !== '1') toggle.checked = !!(entry && entry.enabled);
            toggle.disabled = !seatKnown;
        }
    }

    async function applyBandLink(want) {
        const seat = stationSeatKey();
        const host = $('#opStationBody');
        const toggle = $('#opBandLink');
        if (!seat || !toggle) return;
        if (host) host.dataset.busy = '1';
        if (toggle.parentElement) toggle.parentElement.dataset.busy = '1';
        let ok = false;
        try {
            const result = await setBandLink(seat, want,
                {operator: state.station.operators[state.station.op] || ''});
            ok = !!result && result.ok !== false;
        } catch (error) {
            ok = false;
        }
        if (host) delete host.dataset.busy;
        if (toggle.parentElement) delete toggle.parentElement.dataset.busy;
        if (!ok) {
            toggle.checked = !want;
            const note = $('#opStationNote');
            if (note) {
                note.className = 'op-station-note bad';
                note.textContent = t('op.station.linkFailed');
            }
            return;
        }
        await loadDevices();
    }

    function compassTicks() {
        const cx = 60;
        const cy = 60;
        let out = '';
        for (let d = 0; d < 360; d += 5) {
            const major = d % 30 === 0;
            const mid = d % 10 === 0;
            const inner = major ? 46 : mid ? 49 : 52;
            const rad = d * Math.PI / 180;
            const sx = Math.sin(rad);
            const sy = -Math.cos(rad);
            out += '<line class="op-compass-tick' + (major ? ' major' : mid ? ' mid' : '') +
                '" x1="' + (cx + inner * sx).toFixed(2) + '" y1="' + (cy + inner * sy).toFixed(2) +
                '" x2="' + (cx + 56 * sx).toFixed(2) + '" y2="' + (cy + 56 * sy).toFixed(2) + '"/>';
            if (major && d % 30 === 0) {
                out += '<text class="op-compass-num" x="' + (cx + 38 * sx).toFixed(2) +
                    '" y="' + (cy + 38 * sy + 2.6).toFixed(2) + '" text-anchor="middle">' + d + '</text>';
            }
        }
        return out;
    }

    function presetCells() {
        let out = '';
        for (let i = 0; i < PRESET_COUNT; i += 1) {
            const preset = presetAt(i);
            if (preset) {
                out += '<button type="button" class="op-ant-preset" data-op-preset="' + i +
                    '" title="' + esc(t('op.device.rotator.presetGo', {deg: preset.azimuth})) + '">' +
                    '<b>' + esc(preset.label || t('op.device.rotator.preset', {n: i + 1})) + '</b></button>';
            } else {
                out += '<button type="button" class="op-ant-preset empty" data-op-preset="' + i +
                    '" title="' + esc(t('op.device.rotator.presetHint')) + '">' +
                    '<b>' + esc(t('op.device.rotator.preset', {n: i + 1})) + '</b></button>';
            }
        }
        return out;
    }

    function antennaMarkup(rotator) {
        return '<div class="op-antenna op-device" data-op-device="' + esc(rotator.id) + '">' +
            '<div class="op-compass"><svg class="op-compass-svg" viewBox="0 0 120 120" aria-hidden="true">' +
            '<circle class="op-compass-face" cx="60" cy="60" r="56"/>' +
            '<circle class="op-compass-ring" cx="60" cy="60" r="57"/>' +
            compassTicks() +
            '<text class="op-compass-cardinal" x="60" y="11" text-anchor="middle">N</text>' +
            '<g class="op-compass-target" data-compass-target opacity="0">' +
            '<line x1="60" y1="60" x2="60" y2="10"/><path d="M60 4 l4 8 h-8 z"/></g>' +
            '<g class="op-compass-needle" data-compass-needle>' +
            '<polygon class="op-compass-pointer" points="60,18 56,60 64,60"/></g>' +
            '<circle class="op-compass-hub" cx="60" cy="60" r="3.6"/></svg></div>' +
            '<div class="op-ant-turn">' +
            '<button type="button" class="op-ant-jog" data-op-jog="-1">' + esc(t('op.device.rotator.left')) + '</button>' +
            '<div class="op-ant-current"><b><span data-compass-az>—</span><i>°</i></b>' +
            '<small>' + esc(t('op.device.rotator.currentHeading')) + '</small>' +
            '<span class="op-ant-target" data-compass-target-label></span></div>' +
            '<button type="button" class="op-ant-jog" data-op-jog="1">' + esc(t('op.device.rotator.right')) + '</button>' +
            '</div>' +
            '<div class="op-ant-input">' +
            '<input data-op-azimuth type="number" min="0" max="360" step="1" inputmode="numeric" ' +
            'placeholder="' + esc(t('op.device.rotator.targetInput')) + '">' +
            '<button type="button" data-op-cmd="rotate">' + esc(t('op.device.rotator.rotate')) + '</button>' +
            '<button type="button" data-op-cmd="stop">' + esc(t('op.device.rotator.stop')) + '</button>' +
            '</div>' +
            '<div class="op-ant-quick">' + presetCells() + '</div>' +
            '<span class="op-device-result"></span></div>';
    }

    /* Only the needle, numbers and state text change between polls, so the DOM
     * is built once and nudged here; that keeps the CSS transition animating
     * smoothly as the rotator actually moves. */
    function updateAntenna(view) {
        const host = $('#opBottom');
        if (!host) return;
        const az = Number(view.physical_azimuth);
        const finite = Number.isFinite(az);
        const needle = host.querySelector('[data-compass-needle]');
        if (needle && finite) {
            needleAngle = needleAngle === null ? ((az % 360) + 360) % 360 : needleAngle + shortestDelta(needleAngle, az);
            needle.style.transform = 'rotate(' + needleAngle.toFixed(2) + 'deg)';
        }
        const azText = host.querySelector('[data-compass-az]');
        if (azText) azText.textContent = finite ? String(Math.round(az)) : '—';
        const tgt = Number(view.target_azimuth);
        const targetEl = host.querySelector('[data-compass-target]');
        if (targetEl) {
            if (Number.isFinite(tgt)) {
                targetAngle = targetAngle === null ? ((tgt % 360) + 360) % 360 : targetAngle + shortestDelta(targetAngle, tgt);
                targetEl.style.transform = 'rotate(' + targetAngle.toFixed(2) + 'deg)';
                targetEl.style.opacity = '1';
            } else {
                targetEl.style.opacity = '0';
            }
        }
        const targetLabel = host.querySelector('[data-compass-target-label]');
        if (targetLabel) {
            targetLabel.textContent = Number.isFinite(tgt)
                ? t('op.device.rotator.target', {deg: Math.round(tgt)}) : '';
        }
    }

    function handleDevices() {
        if (!state.active) return;
        void loadDevices();
    }

    /* ---- amplifier bay -------------------------------------------------- */

    /* 功放的归属由服务端沿 RF 连线投影（ownership.by_seat[seat].amps），
       本页只读结论，不在浏览器里重算走线。投影没有结论时（还没配电台节点
       或一条 RF 连线都没拉）退回全部功放：画面照旧有内容，但绝不臆造。 */
    function seatAmpIds() {
        const bySeat = ((deviceSnapshot() || {}).ownership || {}).by_seat || {};
        const seat = String(currentSeat() || '');
        if (Array.isArray((bySeat[seat] || {}).amps)) return bySeat[seat].amps;
        const loose = Object.keys(bySeat).find(key =>
            key === seat || key.endsWith(':' + seat) || key.split(':').pop() === seat);
        const view = loose ? bySeat[loose] : null;
        return view && Array.isArray(view.amps) ? view.amps : null;
    }

    function ampDevices() {
        const snapshot = deviceSnapshot();
        if (!snapshot || !Array.isArray(snapshot.devices)) return [];
        const owned = seatAmpIds();
        const allowed = owned ? new Set(owned.map(String)) : null;
        return snapshot.devices
            .filter(device => device.type === 'amp')
            .filter(device => !allowed || allowed.has(String(device.id)))
            .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    }

    function ampIdentity(device, manual) {
        /* 手动设备没有接入：config 里剩下的 brand/model 只是上一次接入时留下的
         * 配置，上报页面在手动模式下也把这两个字段一起收起来了。这里跟着不印
         * 型号，否则改成手动设备后，OP 的功放卡还挂着之前的型号。 */
        if (manual) return {brand: '', model: ''};
        const snapshot = deviceSnapshot() || {};
        const catalog = snapshot.amp_models || {};
        const config = (device && device.config) || {};
        const brand = (catalog.brands || []).find(item => item.id === config.brand) || null;
        const model = brand ? (brand.models || []).find(item => item.id === config.model) : null;
        return {
            brand: brand ? brand.name : '',
            model: model ? model.name : (config.model && config.model !== 'other' ? config.model : '')
        };
    }

    function ampValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function ampPower(power) {
        const watts = ampValue(power);
        if (watts === null) return null;
        return watts >= 1000
            ? {value: (watts / 1000).toFixed(2), unit: 'kW'}
            : {value: String(Math.round(watts)), unit: 'W'};
    }

    function ampPercent(value, min, max) {
        if (value === null) return 0;
        return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    }

    function ampTransmitting(amp) {
        if (!amp) return false;
        return amp.ptt_status === 1 || amp.transmitting === true || amp.transmitting === 1;
    }

    function ampPaChip(amp) {
        if (!amp) return null;
        const pa = ampValue(amp.pa_switch);
        if (pa !== null) return {text: t(pa ? 'op.amp.paOn' : 'op.amp.paOff'), on: pa === 1};
        const operating = ampValue(amp.operating);
        if (operating !== null) {
            return {text: t(operating ? 'op.amp.operate' : 'op.amp.standby'), on: operating === 1};
        }
        const power = ampValue(amp.power_on);
        if (power !== null) return {text: t(power ? 'op.amp.paOn' : 'op.amp.paOff'), on: power === 1};
        return null;
    }

    function ampAlarmCode(amp) {
        if (!amp) return '';
        if (amp.fault_code) return String(amp.fault_code);
        const word = ampValue(amp.alarm_word);
        if (word) return '0x' + word.toString(16).toUpperCase().padStart(2, '0');
        if (amp.alarm) return String(amp.alarm);
        if (amp.warning) return 'W' + amp.warning;
        return '';
    }

    /** Panel with readings; `stale` keeps the numbers but marks them as held.
     *  amp 为空也照样画：刻度条、数值位、参数行全部就位，数值位用短横占位。 */
    function ampReadings(amp, stale) {
        const data = amp || {};
        const power = ampPower(data.out_fwd_power);
        const swr = ampValue(data.out_swr);
        const powerWidth = ampValue(data.out_fwd_power) === null
            ? 0 : ampPercent(ampValue(data.out_fwd_power), 0, AMP_POWER_MAX);
        const swrWidth = swr === null ? 0 : ampPercent(swr, AMP_SWR_MIN, AMP_SWR_MAX);
        const swrKind = swr === null ? '' : swr >= 2.5 ? ' bad' : swr >= AMP_SWR_LIMIT ? ' warn' : '';
        const powerText = power ? '<b>' + esc(power.value) + '</b><small>' + esc(power.unit) + '</small>'
            : '<b>—</b>';
        const swrText = swr === null ? '<b>—</b>' : '<b>' + esc(swr.toFixed(2)) + '</b>';
        const metric = (label, value, unit, digits) => {
            const number = ampValue(value);
            return '<span><i>' + esc(label) + '</i><b>' +
                (number === null ? '—' : esc(number.toFixed(digits))) + '</b><u>' + esc(unit) + '</u></span>';
        };
        return '<div class="op-amp-gauges">' +
                '<div class="op-amp-gauge">' +
                    '<div class="op-amp-gauge-head"><span>' + esc(t('op.amp.forward')) + '</span>' +
                        '<em>FWD · W</em></div>' +
                    '<div class="op-amp-ruler"><span>0</span><span>1k</span><span>2k</span></div>' +
                    '<div class="op-amp-track"><i style="width:' + powerWidth.toFixed(1) + '%"></i></div>' +
                '</div>' +
                '<div class="op-amp-gauge">' +
                    '<div class="op-amp-gauge-head"><span>' + esc(t('op.amp.swr')) + '</span>' +
                        '<em>SWR</em></div>' +
                    '<div class="op-amp-ruler"><span>1.0</span><span>2.0</span><span>3.0</span></div>' +
                    '<div class="op-amp-track"><i class="' + swrKind.trim() +
                        '" style="width:' + swrWidth.toFixed(1) + '%"></i>' +
                        '<u class="limit" style="left:' +
                        ampPercent(AMP_SWR_LIMIT, AMP_SWR_MIN, AMP_SWR_MAX).toFixed(1) + '%"></u></div>' +
                '</div>' +
            '</div>' +
            '<div class="op-amp-reads">' +
                '<div class="op-amp-read' + (stale ? ' muted' : '') + '">' + powerText + '</div>' +
                '<div class="op-amp-read swr' + (stale ? ' muted' : '') + '">' + swrText + '</div>' +
            '</div>' +
            '<div class="op-amp-metrics">' +
                metric(t('op.amp.reflected'), data.out_rev_power, 'W', 0) +
                metric(t('op.amp.temp'), data.current_temperature, '°C', 0) +
                metric(t('op.amp.voltage'), data.current_voltage, 'V', 1) +
                metric(t('op.amp.current'), data.current_current, 'A', 1) +
            '</div>';
    }

    /* 空面板：与真实功放面板同尺寸，刻度画面照样画出来，
       只在标题位说明这台为什么还不存在（快照未到 / 本席位链路没有功放）。 */
    function ampSkeleton(headline, note) {
        return '<article class="op-amp" data-state="empty">' +
            '<div class="op-amp-id"><b>' + esc(headline) + '</b>' +
            (note ? '<span class="op-amp-flags">' +
                '<span class="op-amp-chip">' + esc(note) + '</span></span>' : '') +
            '</div>' + ampReadings(null, false) + '</article>';
    }

    function ampPanel(device) {
        const snapshot = deviceSnapshot() || {};
        const status = (snapshot.status || {})[device.id] || {state: 'unknown'};
        const amp = status.amp || null;
        const hasReading = !!amp;
        const offline = status.state === 'offline';
        /* 手动设备既可能由状态位给出，也可能只在设备行上标了 access_mode；
         * 两处任一说是手动，这张卡就不再有型号，也不再有读数。 */
        const manual = status.state === 'manual' || device.access_mode === 'manual';
        const stale = offline && hasReading;
        const transmitting = !stale && ampTransmitting(amp);
        const alarm = !!(amp && amp.alarm_active);
        const identity = ampIdentity(device, manual);
        const rawFrequency = ampValue(amp && amp.work_freq);
        /* 0 Hz means "not tuned", so it gets no readout rather than 0.000. */
        const frequency = rawFrequency !== null && rawFrequency > 0 ? rawFrequency : null;
        const band = (amp && amp.band) || (frequency === null ? '' : bandOf(frequency / 1000));
        const flags = [];
        if (transmitting) flags.push('<span class="op-amp-chip tx">TX</span>');
        const pa = ampPaChip(amp);
        if (pa && hasReading) {
            flags.push('<span class="op-amp-chip' + (pa.on ? ' pa-on' : '') + '">' + esc(pa.text) + '</span>');
        }
        if (alarm) {
            const code = ampAlarmCode(amp);
            flags.push('<span class="op-amp-chip alarm">' + esc(t('op.amp.alarm')) +
                (code ? ' ' + esc(code) : '') + '</span>');
        }
        if (stale) {
            const age = ampValue(status.age_ms);
            const text = age === null ? t('op.amp.stale') : t('op.amp.staleAge', {s: Math.round(age / 1000)});
            flags.push('<span class="op-amp-chip stale" title="' +
                esc(status.last_report || '') + '">' + esc(text) + '</span>');
        }
        /* 画面永远画出来：没有读数时刻度条与参数行照旧绘制，只把「为什么
         * 还没有数」压进右上角的标签，不再整块换成占位文字。 */
        if (!hasReading) {
            const reason = manual ? t('op.amp.manual')
                : status.state === 'no-source' ? t('op.amp.noSource')
                : offline ? t('op.amp.offline') : t('op.amp.waiting');
            flags.push('<span class="op-amp-chip">' + esc(reason) + '</span>');
        }
        const face = ampReadings(amp, stale);
        return '<article class="op-amp" data-state="' +
                (hasReading ? (stale ? 'stale' : 'live') : 'empty') +
                '" data-tx="' + (transmitting ? '1' : '0') + '" data-alarm="' + (alarm ? '1' : '0') +
                '" data-amp="' + esc(device.id) + '">' +
            (stale ? '<div class="op-amp-hatch"></div>' : '') +
            '<div class="op-amp-id"><b>' + esc(device.name || device.id) + '</b>' +
                (identity.brand ? '<span class="op-amp-model">' + esc(identity.brand) + '</span>' : '') +
                (identity.model && String(identity.model).toLowerCase() !==
                    String(device.name || '').toLowerCase()
                    ? '<span class="op-amp-model">' + esc(identity.model) + '</span>' : '') +
                (frequency === null ? '' : '<span class="op-amp-freq">' +
                    esc((frequency / 1e6).toFixed(3)) + ' <i>MHz</i></span>') +
                (band ? '<span class="op-amp-band">' + esc(band) + '</span>' : '') +
                (flags.length ? '<span class="op-amp-flags">' + flags.join('') + '</span>' : '') +
            '</div>' + face + '</article>';
    }

    function renderAmps() {
        const grid = $('#opAmpGrid');
        if (!grid) return;
        const host = $('#opAmpSum');
        /* 画面永远画出来：快照未到也先铺一台同尺寸的空面板，
         * 不再退回一条“正在读取设备快照”的文字。 */
        if (!deviceSnapshot()) {
            if (host) host.innerHTML = '';
            grid.innerHTML = ampSkeleton(t('op.amp.loading'), t('op.amp.loadingNote'));
            return;
        }
        const devices = ampDevices();
        const snapshot = deviceSnapshot() || {};
        const statuses = snapshot.status || {};
        const summary = [];
        let txCount = 0;
        let alarmCount = 0;
        let downCount = 0;
        for (const device of devices) {
            const status = statuses[device.id] || {};
            if (status.state === 'offline') downCount += 1;
            if (status.amp && status.amp.alarm_active) alarmCount += 1;
            if (status.state !== 'offline' && ampTransmitting(status.amp)) txCount += 1;
        }
        /* 功放只列本席位链路上的那几台，标题里必须说清是谁的链路。 */
        summary.push('<span>' + esc(seatNameOf(currentSeat())) + '</span>');
        summary.push('<span>' + esc(t('op.amp.count', {n: devices.length})) + '</span>');
        if (txCount) summary.push('<span class="live">TX ' + txCount + '</span>');
        if (alarmCount) summary.push('<span class="bad">' + esc(t('op.amp.alarm')) + ' ' + alarmCount + '</span>');
        if (downCount) summary.push('<span>' + esc(t('op.amp.down', {n: downCount})) + '</span>');
        if (host) host.innerHTML = summary.join('<i>·</i>');
        /* 本席位链路里没有功放：同样是一块画好的空面板，不是一条空白。 */
        grid.innerHTML = devices.length
            ? devices.map(device => ampPanel(device)).join('')
            : ampSkeleton(t('op.amp.none'), t('op.amp.noneHint'));
    }

    function deviceFeedback(target, ok, text) {
        const card = target && target.closest ? target.closest('.op-device') : null;
        if (!card) return;
        const note = card.querySelector('.op-device-result');
        if (!note) return;
        note.textContent = text || (ok ? t('op.device.commandSent') : t('op.device.commandFailed'));
        note.classList.toggle('bad', !ok);
    }

    function errorNote(result, error) {
        const code = result && result.error
            ? result.error
            : (error && error.body && error.body.error ? error.body.error : '');
        if (!code) return '';
        const key = 'dev.error.' + code;
        const text = t(key);
        return text === key ? '' : ' · ' + text;
    }

    async function runDeviceCommand(card, device, body) {
        try {
            const result = await sendDeviceCommand(device.id, body, {seat: commandSeat()});
            const ok = !!result && result.ok !== false;
            /* 手动设备的回执里没有“已下发”，只有“人工已确认生效”。
             * 文案必须分开，否则操作员会一直盯着界面等设备回报。 */
            const done = !ok ? t('op.device.commandFailed')
                : t(result.manual ? 'op.device.manualDone' : 'op.device.commandSent');
            deviceFeedback(card, ok, done + (ok ? '' : errorNote(result)));
            if (ok) {
                if (body.command === 'rotate') state.rotorTarget = body.azimuth;
                await loadDevices();
            }
            return ok;
        } catch (error) {
            deviceFeedback(card, false, t('op.device.commandFailed') + errorNote(null, error));
            return false;
        }
    }

    function stopTowerHold() {
        if (state.towerTimer) {
            clearInterval(state.towerTimer);
            state.towerTimer = null;
        }
        const id = state.towerHold;
        state.towerHold = null;
        if (id) void sendDeviceCommand(id, {command: 'tower_release'}, {seat: commandSeat()});
    }

    function startTowerHold(card, device, direction) {
        stopTowerHold();
        state.towerHold = device.id;
        state.towerTimer = setInterval(() => {
            if (state.towerHold !== device.id) {
                stopTowerHold();
                return;
            }
            void sendDeviceCommand(device.id, {command: 'tower_hold', direction}, {seat: commandSeat()});
        }, 500);
        void runDeviceCommand(card, device, {command: 'tower_hold', direction});
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

    /* Contest score comes from the station snapshot; the QSO total is counted
     * from the same repository rows the rest of the page uses. */
    async function loadScore() {
        try {
            const snapshot = await getStationState();
            state.stationScore = snapshot && snapshot.score || null;
        } catch (error) {
            state.stationScore = null;
        }
        renderScore();
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

    /* Opponent rows come from the server-side watched scope: the live callsign
       list and the opponent TTL are applied inside the query, so a call removed
       from the list stops coming back without waiting for any page state. */
    async function loadOpponents() {
        if (!myCall()) {
            opponentPanel.render([], '', []);
            return;
        }
        try {
            const rows = await fetchSpots({limit: 1500});
            rows.forEach(ingestSpot);
        } catch (error) {
            console.warn('op view: opponent bootstrap unavailable', error);
        }
        try {
            state.monitoredCalls = await fetchCallsigns();
        } catch {
            // Keep the previous list; the server side already filters.
        }
        await refreshOpponentRows();
    }

    async function refreshOpponentRows() {
        if (!myCall()) return;
        try {
            state.opponentRows = await fetchSpots({scope: 'watched', limit: 400});
        } catch (error) {
            // Network hiccup: keep the previous rows instead of blanking the panel.
            state.opponentRows = state.opponentRows || [];
        }
        recomputeOpponents();
    }

    function recomputeOpponents() {
        if (!myCall()) {
            opponentPanel.render([], '', []);
            return;
        }
        /* Allowlist inside the aggregation: PSKR regional rows carry the
         * receiving station in monitored_call, so an empty or failed callsign
         * fetch must hide the section instead of showing every row. */
        const calls = Array.isArray(state.monitoredCalls) ? state.monitoredCalls : [];
        const ttlMin = Math.min(180, Math.max(5, Number(ctx.settings && ctx.settings.opponentWindowMin) || 30));
        opponentPanel.setOptions({windowMin: ttlMin});
        opponentPanel.render(state.opponentRows, myCall(), calls);
    }

    // ---- selected seat -----------------------------------------------------
    /* The OP view has no "all seats" aggregate any more: one concrete seat is
     * always active and the choice survives a reload. */
    function loadSeat() {
        try {
            return localStorage.getItem(SEAT_KEY) || '';
        } catch {
            return '';
        }
    }

    function saveSeat(value) {
        try {
            localStorage.setItem(SEAT_KEY, String(value));
        } catch {
            // Remembering the seat is a convenience only.
        }
    }

    // ---- call sanity check ------------------------------------------------
    /* 操作员点「无误」= 这个呼号本身没有错。白名单存在服务端设置
       opConfirmedCalls 里，所以全部席位共享一份记忆，后续再录入同一
       呼号不再提示；「全部重置」把设置恢复默认，记忆随之清空。 */
    const CONFIRM_MAX_CHARS = 2000;

    function confirmedCalls() {
        return new Set(String(ctx.settings.opConfirmedCalls || '')
            .split(',').map(value => value.trim().toUpperCase()).filter(Boolean));
    }

    function rememberConfirmedCall(call) {
        const value = String(call || '').trim().toUpperCase();
        if (!value) return;
        const known = confirmedCalls();
        known.delete(value);
        const list = [...known, value];
        while (list.length > 1 && list.join(',').length > CONFIRM_MAX_CHARS) list.shift();
        ctx.settings.opConfirmedCalls = list.join(',');
        ctx.saveSettings({opConfirmedCalls: ctx.settings.opConfirmedCalls});
        // 同一呼号在其他席位/电台上的提醒也一并撤掉。
        for (const [key, item] of [...state.suspects.entries()]) {
            if (item.call === value) state.suspects.delete(key);
        }
    }

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
        // 只看当前席位的最新一条 QSO，其他席位的记录不参与检查也不显示。
        const candidates = [];
        for (const seat of visibleSeats()) {
            const latest = lastQsoFor(seat);
            if (latest) candidates.push({seat: String(seat), qso: latest});
        }
        const confirmed = confirmedCalls();
        // 同一条 QSO 被 N1MM 改了呼号时，旧呼号的提醒要跟着消失；
        // 但新 QSO 不会清掉任何尚未处理的提醒。
        const liveCallById = new Map();
        for (const qso of state.qsos.values()) {
            if (qso.n1mmId !== undefined && qso.n1mmId !== null) {
                liveCallById.set(String(qso.n1mmId), String(qso.call || '').trim().toUpperCase());
            }
        }
        const allowed = new Set(visibleSeats().map(String));
        for (const [key, item] of [...state.suspects.entries()]) {
            // 别的席位刚点过「无误」：这条提醒已经不该再挂着了。
            if (confirmed.has(item.call)) {
                state.suspects.delete(key);
                continue;
            }
            if (!allowed.has(String(item.seat))) continue;
            const liveCall = liveCallById.get(String(item.n1mmId));
            if (liveCall && liveCall !== item.call) state.suspects.delete(key);
        }
        for (const {seat, qso} of candidates) {
            const key = reviewKey(qso);
            const call = String(qso.call || '').trim().toUpperCase();
            // 「已确认无误」的呼号是全部席位共享的记忆；已核对过的 QSO 也不再重复请求。
            if (confirmed.has(call) || state.review[key] || state.checked.has(key) || state.suspects.has(key)) continue;
            state.suspects.set(key, {
                key,
                call,
                n1mmId: qso.n1mmId,
                seat,
                radioNr: qso.radioNr || 1,
                ts: qso.ts,
                band: qso.band,
                freqKhz: qso.freqKhz,
                status: 'checking'
            });
        }
        renderSuspects();
        queueChecks();
    }

    function queueChecks() {
        if (state.checking) return;
        const allowed = new Set(visibleSeats().map(String));
        const pending = [...state.suspects.values()]
            .filter(item => item.status === 'checking' && allowed.has(String(item.seat)))
            .sort((a, b) => timeOf(a.ts) - timeOf(b.ts));
        if (!pending.length) return;
        state.checking = (async () => {
            for (const item of pending) {
                if (!state.active) break;
                // 切到别的席位后，旧席位的待检项先让路；切回来会重新入队。
                if (!visibleSeats().map(String).includes(String(item.seat))) continue;
                await checkOne(item);
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
        })().finally(() => {
            state.checking = null;
            // 队列忙的时候可能又来了新 QSO，或切换了席位：按当前席位的待检项补一轮。
            const now = new Set(visibleSeats().map(String));
            const waiting = [...state.suspects.values()]
                .some(item => item.status === 'checking' && now.has(String(item.seat)));
            if (waiting && state.active) queueChecks();
        });
    }

    function settleSuspect(item, status, reason, result) {
        const live = state.suspects.get(item.key);
        if (!live) return;
        live.status = status;
        live.reason = reason || '';
        if (result) {
            live.scp = result.scp || live.scp || null;
            live.qrz = result.qrz || live.qrz || null;
        }
        state.checked.add(item.key);
        renderSuspects();
        // 「校验通过 / 未完成」只是过程反馈，留几秒让 OP 看到后自动收起；
        // 需要人工确认的失败项不会走这里，会一直保留到 OP 点按钮。
        setTimeout(() => {
            const current = state.suspects.get(item.key);
            if (current && current.status === status) {
                state.suspects.delete(item.key);
                renderSuspects();
            }
        }, 8000);
    }

    async function checkOne(item) {
        if (!state.suspects.has(item.key)) return;
        try {
            const result = await checkCallsign(item.call, item.n1mmId, {
                qrz: Boolean(ctx.settings.opSuspiciousQrz),
                scp: Boolean(ctx.settings.opScpCheck)
            });
            if (!state.suspects.has(item.key)) return;
            const scp = result.scp || {status: 'unavailable'};
            const qrz = result.qrz || {status: 'disabled'};
            // SCP 或 QRZ 任一命中都算通过；QRZ 没配置不影响 SCP 的结论。
            const passed = scp.status === 'hit' || qrz.status === 'found'
                || result.status === 'scp' || result.status === 'qrz-found';
            if (passed) {
                settleSuspect(item, 'passed', '', result);
                return;
            }
            // 只有 QRZ 明确查无此呼号才要求 OP 确认；SCP 未命中只是辅助信息。
            if (qrz.status === 'not-found' || result.status === 'qrz-not-found') {
                item.status = 'failed';
                item.scp = scp;
                item.qrz = qrz;
                renderSuspects();
                return;
            }
            settleSuspect(item, 'unverified', result.reason || '', result);
        } catch (error) {
            settleSuspect(item, 'unverified', 'qrz-error');
        }
    }

    function acceptSuspect(key, status) {
        const item = state.suspects.get(key);
        if (status === 'ok') {
            // 「无误」认的是呼号本身：写进服务端白名单，之后不再提示。
            if (item) rememberConfirmedCall(item.call);
        } else {
            // 「已修改」只认这一条 QSO，等 N1MM 把改好的呼号送上来。
            state.review[key] = {status, at: Date.now()};
            saveReview();
        }
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
            canRotate: () => Boolean(rotatorDevice())
        });
        state.map.resize();
        renderMap();
    }

    function refreshAll() {
        renderSeatOptions();
        renderBands();
        renderSpace();
        renderScore();
        renderCharts();
        /* The shared renderer paints #oppRows from the rows it already holds. */
        opponentPanel.trim();
        renderWorkability();
        renderSuspects();
        renderMultipliers();
        renderBottom();
        renderAmps();
        renderBandOccupancy();
        renderAntSwitch();
        renderStationCard();
        renderCameraCard();
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
        void loadDevices();
        loadQsos();
        loadScore();
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
                renderScore();
                renderAdvice();
            }, 2000),
            // Map markers are heavier; the WS handlers redraw immediately.
            setInterval(() => {
                if (!state.active) return;
                renderMap();
                renderBottom();
                renderCharts();
            }, 10000),
            // Device snapshot drives every OP control; never cache it locally.
            setInterval(() => { if (state.active) void loadDevices(); }, 3000),
            // Opponents come from the WS spot stream; this is only recompute.
            setInterval(() => { if (state.active) refreshOpponentRows(); }, 5000),
            setInterval(() => { if (state.active) loadMySpots(); }, 15000),
            setInterval(() => { if (state.active) loadPaths(); }, 10000),
            setInterval(() => { if (state.active) loadOpponents(); }, 60000),
            setInterval(() => { if (state.active) loadPropagation(); }, 120000),
            setInterval(() => { if (state.active) loadMultipliers(); }, 60000),
            setInterval(() => { if (state.active) loadScore(); }, 30000),
            setInterval(() => { if (state.active) loadAdvice(); },
                Math.max(15, Number(ctx.settings.adviceRefreshSec) || 60) * 1000)
        ];
    }

    function hide() {
        state.active = false;
        stopTowerHold();
        closePresetEditor();
        document.querySelector('.main')?.classList.remove('op-active');
        $('#opView').classList.add('hidden');
        state.timers.forEach(timer => clearInterval(timer));
        state.timers = [];
        clearTimeout(state.multTimer);
        clearTimeout(state.adviceTimer);
    }

    function handleStation() {
        if (!state.active) return;
        renderSeatOptions();
        renderBottom();
        renderMultipliers();
        renderBandOccupancy();
        renderAntSwitch();
        /* 电台卡片跟着 radio 报文重绘：收发灯、频率、波段、模式全在 radio 状态里，
         * 只靠 3 秒一轮的 loadDevices 轮询会滞后到实际状态之外，
         * 而 QSO 地图的本台状态就是在同一条报文里立刻重绘的。 */
        renderStationCard();
        renderCameraCard();
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
        renderScore();
        renderCharts();
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
        for (const [key, item] of [...state.suspects.entries()]) {
            if (String(item.n1mmId) === String(id)) state.suspects.delete(key);
        }
        renderSuspects();
        renderMap();
        renderBottom();
        renderAdvice();
        renderScore();
        renderCharts();
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
        if (state.active) renderCharts();
    }

    function applyLang() {
        renderTitles();
        renderSeatOptions();
        if (state.active) refreshAll();
    }

    function renderTitles() {
        $('#opSeatTitleText').textContent = t('op.seat');
        $('#opRateTitle').textContent = t('qsoRate');
        $('#opBandQsoTitle').textContent = t('op.top.bandCounts');
        $('#opQsoLabel').textContent = t('stQsos');
        $('#opScoreLabel').textContent = t('stScore');
        $('#opBandsTitle').textContent = t('op.left.bands');
        $('#opSpaceTitle').textContent = t('op.left.space');
        $('#opOppTitleText').textContent = t('op.left.opponents');
        $('#opMapTitle').textContent = t('op.map.title');
        $('#opWorkTitle').textContent = t('op.right.workability');
        $('#opSuspectTitle').textContent = t('op.right.suspicious');
        $('#opMultTitle').textContent = t('op.right.multipliers');
        $('#opMultExpand').textContent = state.multExpanded ? t('op.mult.collapse') : t('op.mult.expand');
        $('#opBottomTitle').textContent = t('op.bottom.devices');
        $('#opAntSwitchTitle').textContent = t('op.antswitch.title');
        $('#opAmpTitle').textContent = t('op.amp.title');
        $('#opBandOccTitle').textContent = t('op.bandocc.title');
    }

    function bind() {
        $('#opAdvice')?.addEventListener('click', event => {
            const close = event.target.closest('[data-op-advice]');
            if (!close) return;
            state.adviceDismissed.add(close.dataset.opAdvice);
            renderAdvice();
        });
        $('#opSeat')?.addEventListener('change', event => {
            stopTowerHold();
            state.selectedSeat = event.target.value;
            saveSeat(state.selectedSeat);
            refreshAll();
            renderMap();
            renderMultipliers();
            scheduleSuspects();
            loadAdvice();
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
                    const owner = body.owner && seatNameOf(body.owner.seat);
                    const key = body.error === 'frequency-claimed' ? 'op.claim.conflict'
                        : body.error === 'not-claim-owner' ? 'op.claim.notOwner' : 'op.claim.failed';
                    state.claimFeedback = {seat, bad: true, text: t(key, {seat: owner || ''})};
                }
                renderBottom();
                return;
            }
            const card = event.target.closest('.op-device');
            if (!card) return;
            const device = controlDevices().find(item => item.id === card.dataset.opDevice);
            if (!device) return;
            const towerStop = event.target.closest('[data-op-tower="stop"]');
            if (towerStop) {
                void runDeviceCommand(card, device, {command: 'tower_stop'});
                return;
            }
            const command = event.target.closest('[data-op-cmd]');
            if (!command) return;
            if (command.dataset.opCmd === 'rotate') {
                const input = card.querySelector('[data-op-azimuth]');
                const azimuth = input ? Number(input.value) : NaN;
                if (!Number.isFinite(azimuth)) return;
                void runDeviceCommand(card, device, {command: 'rotate', azimuth});
            } else if (command.dataset.opCmd === 'stop') {
                void runDeviceCommand(card, device, {command: 'stop'});
            } else if (command.dataset.opCmd === 'select') {
                const port = card.querySelector('[data-op-port]');
                const outlet = card.querySelector('[data-op-outlet]');
                void runDeviceCommand(card, device, {
                    command: 'select',
                    port: port ? port.value : '',
                    outlet: outlet ? outlet.value : ''
                });
            }
        });
        // 天线切换按钮：委托绑定，一副天线一个 chip。
        $('#opAntSwitch')?.addEventListener('click', event => {
            const chip = event.target.closest('[data-op-ant-route]');
            if (!chip) return;
            const antennaId = chip.dataset.opAntRoute;
            // 命令下发给天线设备本身：服务端沿 RF 连线自己反推链路上要拨哪几台
            // 切换器/矩阵，前端不需要知道端口名；成功后 loadDevices() 刷新，
            // 所有席位的按钮颜色都跟着快照走。
            void runDeviceCommand(chip, {id: antennaId},
                {command: 'route', device_id: antennaId});
        });
        /* 频率联动开关：勾选状态存服务端，按席位生效，换浏览器/关页面都继续联动。 */
        $('#opBandLink')?.addEventListener('change', event => {
            void applyBandLink(event.target.checked);
        });
        $('#opBottom')?.addEventListener('pointerdown', event => {
            const button = event.target.closest('[data-op-tower]');
            if (!button || button.dataset.opTower === 'stop') return;
            const card = event.target.closest('.op-device');
            if (!card) return;
            const device = controlDevices().find(item => item.id === card.dataset.opDevice);
            if (!device) return;
            event.preventDefault();
            startTowerHold(card, device, button.dataset.opTower);
        });
        document.addEventListener('pointerup', stopTowerHold);
        window.addEventListener('blur', stopTowerHold);
        $('#opBottom')?.addEventListener('pointerdown', event => {
            const jog = event.target.closest('[data-op-jog]');
            if (jog) {
                const rotator = rotatorDevice();
                if (!rotator) return;
                event.preventDefault();
                jogStart(rotator, Number(jog.dataset.opJog) < 0 ? -1 : 1);
                return;
            }
            const preset = event.target.closest('[data-op-preset]');
            if (preset) {
                event.preventDefault();
                presetDown(Number(preset.dataset.opPreset));
            }
        });
        const releaseAntennaPress = () => { jogRelease(); presetUp(); };
        document.addEventListener('pointerup', releaseAntennaPress);
        window.addEventListener('blur', releaseAntennaPress);
        document.addEventListener('pointercancel', () => {
            jogClearTimers();
            jogRotator = null;
            jogLongFired = false;
            clearTimeout(pressTimer);
            pressTimer = null;
            pressIndex = null;
            pressLongFired = false;
        });
        /* The preset dialog lives on <body>, so its handlers bind there, not on
         * #opBottom. Clicking the backdrop is a cancel; Esc closes; Enter in a
         * field saves. */
        const presetDialogHost = presetOverlay();
        presetDialogHost.addEventListener('click', event => {
            if (presetEditing === null) return;
            if (event.target.closest('[data-op-preset-save]')) { savePresetFromForm(presetEditing); return; }
            if (event.target.closest('[data-op-preset-clear]')) { clearPreset(presetEditing); return; }
            if (event.target.closest('[data-op-preset-cancel]')) { closePresetEditor(); return; }
        });
        presetDialogHost.addEventListener('keydown', event => {
            if (event.key === 'Escape') { closePresetEditor(); return; }
            if (event.key !== 'Enter') return;
            const el = event.target;
            if (el && el.matches && el.matches('[data-op-preset-name],[data-op-preset-angle]')) {
                event.preventDefault();
                if (presetEditing !== null) savePresetFromForm(presetEditing);
            }
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
        handleDevices,
        handleSpot,
        showRuleAlert
    };
}
