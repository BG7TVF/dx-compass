import {
    clockOptions,
    clockWeekday,
    formatDuration,
    formatClock,
    formatClockDate,
    parseUtcDateTime
} from '../shared/core/clock.mjs';
import {WALL_BAND_COLORS} from './wall-opponents.mjs';
import {getLanguage, t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
const locale = () => {
    const lang = getLanguage();
    return lang === 'zh' ? 'zh-CN' : lang;
};
const timeZoneOf = options => options.timeZone === 'local' ? undefined : 'UTC';
const upper = text => String(text || '').toUpperCase();
const COLORS = {qso: '#35d6a4'};
const num = (value, digits) => value === null || value === undefined || !isFinite(value)
    ? '—' : (digits === undefined ? String(value) : Number(value).toFixed(digits));
const last = list => list && list.length ? list[list.length - 1] : null;
const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dateLabel(now, options) {
    try {
        return new Intl.DateTimeFormat(locale(), {
            year: 'numeric', month: '2-digit', day: '2-digit',
            weekday: 'short', timeZone: timeZoneOf(options)
        }).format(now);
    } catch (error) {
        return formatClockDate(now, options) + ' · ' +
            ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][clockWeekday(now, options)];
    }
}

export function tickClock(settings, now = new Date()) {
    const options = clockOptions(settings);
    $('#utcClock').textContent = formatClock(now, options);
    $('#utcDate').textContent = upper(dateLabel(now, options));
    renderTimer(settings, now);
}

function renderTimer(settings, now) {
    const box = $('#wallTimer');
    if (!box) return;
    /* A selected contest wins over the legacy wall countdown; when it ends the
     * server clears it on the next sync, so hide it meanwhile. */
    const contestStart = parseUtcDateTime(settings.contestStart);
    const contestEnd = parseUtcDateTime(settings.contestEnd);
    const contestOn = isFinite(contestStart) && isFinite(contestEnd) && contestEnd > contestStart;
    const start = contestOn ? contestStart : parseUtcDateTime(settings.wallTimerStart);
    const end = contestOn ? contestEnd : parseUtcDateTime(settings.wallTimerEnd);
    const time = now.getTime();
    let label = '', target = 0, ended = false;
    if (contestOn) {
        if (time < start) {
            label = t('wall.timer.toStart');
            target = start;
        } else if (time < end) {
            label = t('wall.timer.toEnd');
            target = end;
        }
    } else if (settings.wallTimerOn) {
        if (isFinite(start) && time < start) {
            label = t('wall.timer.toStart');
            target = start;
        } else if (isFinite(end) && time >= end) {
            label = t('wall.timer.ended');
            ended = true;
        } else if (isFinite(end)) {
            label = t('wall.timer.toEnd');
            target = end;
        }
    }
    box.hidden = !label;
    box.classList.toggle('ended', ended);
    if (!label) return;
    $('#timerLabel').textContent = label;
    $('#timerValue').textContent = formatDuration(ended ? 0 : target - time);
}

function xrayClass(flux) {
    if (!flux || flux <= 0) return '—';
    const order = ['A', 'B', 'C', 'M', 'X'];
    const exponent = Math.floor(Math.log10(flux));
    const mantissa = flux / Math.pow(10, exponent);
    return order[Math.max(0, Math.min(4, exponent + 8))] +
        (mantissa >= 1 ? mantissa.toFixed(1) : '1.0');
}

/** Pure space-weather cells, shared by the wall and the OP view. */
export function spaceWeatherCells(data) {
    const sfi = last(data.sfi && data.sfi.list);
    const kp = last(data.kp && data.kp.list);
    const dst = last(data.dst && data.dst.list);
    const xr = last(data.xray && data.xray.list);
    const ssn = last(data.ssn && data.ssn.list);
    const mag = last(data.mag && data.mag.list);
    const wind = last(data.wind && data.wind.list);
    const ham = data.ham || {};
    return [
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
}

export function renderSpaceWeather(data) {
    $('#swGrid').innerHTML = spaceWeatherCells(data).map(([key, value, className]) =>
        '<div><label>' + key + '</label><b class="' + className + '">' + esc(value) +
        '</b></div>').join('');
}

/** Pure band-condition cells (server forecast only, day/night selected by noon). */
export function bandConditionCells(forecast, now = new Date()) {
    const conditions = forecast && forecast.bandConditions;
    const bands = conditions && conditions.bands;
    if (!bands || typeof bands !== 'object' || !Object.keys(bands).length) return [];
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    const sinceNoon = ((utcHour - conditions.noon + 12) % 24 + 24) % 24 - 12;
    const period = sinceNoon >= -6 && sinceNoon < 6 ? 'day' : 'night';
    return Object.entries(bands).map(([name, entry]) => {
        const condition = entry && entry[period] || 'Closed';
        const value = String(condition).toLowerCase();
        const label = String(name).toUpperCase() === 'VHF' ? t('wall.band.vhf') : name.toUpperCase();
        const className = value === 'good' ? 'good' : value === 'fair' ? 'fair' :
            value === 'poor' ? 'poor' : 'closed';
        const level = className === 'good' ? 3 : className === 'fair' ? 2 :
            className === 'poor' ? 1 : 0;
        return {band: label, className, level, condition: t('wall.condition.' + className)};
    });
}

/** Render only the server forecast, selecting its HOME-local day or night table. */
export function renderBands(forecast, now = new Date()) {
    const cells = bandConditionCells(forecast, now);
    if (!cells.length) {
        $('#bandBar').innerHTML = '<div class="band closed"><b>—</b></div>';
        return;
    }
    $('#bandBar').innerHTML = cells.map(cell => {
        return '<div class="band ' + cell.className + '"><b>' + esc(cell.band) +
            '</b><span>' + esc(cell.condition) + '</span><div class="meter">' +
            [0, 1, 2].map(index => '<u' + (index < cell.level ? ' class="on"' : '') + '></u>').join('') +
            '</div></div>';
    }).join('');
}

export function bandOf(freqKhz) {
    const frequency = freqKhz / 1000;
    if (!isFinite(frequency)) return '';
    if (frequency < 2) return '160M';
    if (frequency < 4.5) return '80M';
    if (frequency < 6) return '60M';
    if (frequency < 8.5) return '40M';
    if (frequency < 11.5) return '30M';
    if (frequency < 16) return '20M';
    if (frequency < 19.5) return '17M';
    if (frequency < 22.5) return '15M';
    if (frequency < 26.5) return '12M';
    if (frequency < 30) return '10M';
    return 'VHF';
}

export function renderRadios(station) {
    const radios = station && station.radios || {};
    const ids = Object.keys(radios);
    if (!ids.length) {
        $('#radioCards').innerHTML = '<div class="opp-empty">' +
            esc(t('wall.empty.waitingStation')) + '</div>';
        return;
    }
    $('#radioCards').innerHTML = ids.map(id => {
        const radio = radios[id] || {};
        const tx = radio.isTransmitting ? ' tx' : '';
        const mhz = radio.freqKhz ? num(radio.freqKhz / 1000, 3) + ' MHz' : '—';
        const bandKey = bandOf(radio.freqKhz);
        const band = bandKey === 'VHF' ? t('wall.band.vhf') : bandKey;
        const name = radio.radioName || t('wall.station.radio', {n: id});
        return '<div class="radio' + tx + '"><label>' + esc(name) +
            (tx ? ' · TX' : '') + '</label><b>' + esc(mhz) + '</b><span>' +
            esc(band + (radio.mode ? ' · ' + radio.mode : '') +
                (radio.opCall ? ' · ' + radio.opCall : '')) + '</span></div>';
    }).join('');
}

export function renderQsoStats(rows) {
    const now = Date.now();
    const within = milliseconds => rows.filter(qso => {
        const time = new Date(qso.timestamp).getTime();
        return isFinite(time) && now - time <= milliseconds;
    }).length;
    const hour = within(60 * 60 * 1000);
    const ten = within(10 * 60 * 1000);
    $('#rateHour').textContent = hour;
    $('#rateMin').textContent = (ten / 10).toFixed(1);

    const byOperator = new Map();
    const byBand = new Map();
    rows.forEach(qso => {
        const operator = qso.operator || qso.op || '—';
        byOperator.set(operator, (byOperator.get(operator) || 0) + 1);
        const band = String(qso.band || '').toUpperCase() || '—';
        byBand.set(band, (byBand.get(band) || 0) + 1);
    });
    renderRank('#opList', byOperator, 6, false);
    renderRank('#bandList', byBand, 8, true);
}

function renderRank(selector, values, limit, bandColor) {
    const list = [...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const max = list.length ? list[0][1] : 0;
    $(selector).innerHTML = list.length ? list.map(([key, value]) => {
        const color = bandColor ? (WALL_BAND_COLORS[key] || '#35d6a4') : COLORS.qso;
        return '<div class="hbar"><span class="k">' + esc(key) + '</span>' +
            '<i class="track"><i style="width:' + Math.round(value / (max || 1) * 100) +
            '%;background:' + color + '"></i></i><em>' + value + '</em></div>';
    }).join('') : '<div class="opp-empty">—</div>';
}
