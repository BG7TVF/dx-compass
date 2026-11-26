import {
    clockOptions,
    clockWeekday,
    formatDuration,
    formatClock,
    formatClockDate,
    parseUtcDateTime
} from '../shared/core/clock.mjs';
import {WALL_BAND_COLORS} from '../shared/opponents/opponents.mjs';
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

/* 席位铭牌：优先用服务端已经剔除离线席位的 seats（带操作员与电台名），
 * 没有席位数据时退回原始 radioStates，保证大屏永远有东西可看。 */
export function renderRadios(station) {
    const box = $('#radioCards');
    if (!box) return;
    const seats = (station && Array.isArray(station.seats) ? station.seats : [])
        .filter(seat => seat && seat.seat);
    const radios = station && station.radios || {};
    if (!seats.length && !Object.keys(radios).length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.empty.waitingStation')) + '</div>';
        return;
    }
    if (!seats.length) {
        box.innerHTML = Object.keys(radios).map(id => {
            const radio = radios[id] || {};
            const tx = radio.isTransmitting ? ' tx' : '';
            const mhz = radio.freqKhz ? num(radio.freqKhz / 1000, 3) + ' MHz' : '—';
            const bandKey = bandOf(radio.freqKhz);
            const band = bandKey === 'VHF' ? t('wall.band.vhf') : bandKey;
            const name = radio.radioName || t('wall.station.radio', {n: id});
            return '<div class="radio' + tx + '"><label>' + esc(name) +
                (tx ? ' · TX' : '') + '</label><b>' + esc(mhz) + '</b><span>' +
                esc(band + (radio.mode ? ' · ' + radio.mode : '')) + '</span></div>';
        }).join('');
        return;
    }
    const number = seat => Number(String(seat).replace(/\D/g, '')) || 0;
    const plates = [...seats]
        .sort((a, b) => number(a.seat) - number(b.seat))
        .map(seat => {
            const index = number(seat.seat) || seat.seat;
            const tx = seat.isTransmitting ? ' tx' : '';
            const idle = seat.isRunning === false ? ' idle' : '';
            const mhz = seat.freqKhz ? num(seat.freqKhz / 1000, 3) : '—';
            const bandKey = bandOf(seat.freqKhz);
            const band = bandKey === 'VHF' ? t('wall.band.vhf') : bandKey;
            const color = WALL_BAND_COLORS[bandKey] || COLORS.qso;
            const title = seat.stationName || seat.radioName || t('wall.station.radio', {n: index});
            const operator = String(seat.operator || '').trim();
            return '<div class="radio plate' + tx + idle + '" style="--c:' + color + '">' +
                '<label>' + esc(title) + '<em>' + esc(band) + '</em></label>' +
                '<div class="plate-freq"><b>' + esc(mhz) + '</b><span>MHz</span>' +
                '<i class="mode">' + esc(seat.mode || '—') + '</i>' +
                '<i class="op">' + esc(operator || '—') + '</i></div>' +
                '</div>';
        }).join('');
    box.innerHTML = plates + '<div class="rows-more" hidden></div>';
    // 铭牌行高一律按内容给（见 .radios），装不下就删掉最后几台并标 "+N"，
    // 而不是把两行文字压成半截。
    trimRows(box, {rowClass: 'radio', marker: box.querySelector('.rows-more')});
}

/* 头部 KPI 条：总分优先取 N1MM 的 Score 报文，缺报文时用日志自行累加，
 * 保证大屏在 N1MM 没发分数的竞赛里也不会空着。 */
export function renderKpi(station, rows) {
    const box = $('#kpiStrip');
    if (!box) return;
    const score = station && station.score || {};
    const logged = rows.reduce((total, qso) => total + (Number(qso.points) || 0), 0);
    const mults = rows.reduce((total, qso) => total + (qso.is_mult ? 1 : 0), 0);
    const now = Date.now();
    const hour = rows.filter(qso => {
        const time = new Date(qso.timestamp).getTime();
        return isFinite(time) && now - time <= 60 * 60 * 1000;
    }).length;
    const pick = (value, fallback) => {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : fallback;
    };
    const cells = [
        {key: 'score', label: t('wall.kpi.score'), value: pick(score.points, logged), tone: 'amber'},
        {key: 'qsos', label: t('wall.kpi.qsos'), value: pick(score.qsos, rows.length), tone: 'mint'},
        {key: 'mults', label: t('wall.kpi.mults'), value: pick(score.mults, mults), tone: 'cyan'},
        {key: 'rate', label: t('wall.kpi.rate'), value: hour, tone: 'violet', suffix: '/h'}
    ];
    box.innerHTML = cells.map(cell => '<div class="kpi ' + cell.tone + '"><span>' +
        esc(cell.label) + '</span><b>' + cell.value +
        (cell.suffix ? '<i>' + esc(cell.suffix) + '</i>' : '') + '</b></div>').join('');
}

/* 各 OP 数据：按日志里的 operator 汇总 QSO 数与分数，同一呼号配色稳定。 */
const OP_COLORS = ['#35d6a4', '#ffb347', '#4cc9f0', '#ff6b6b', '#a78bfa',
    '#f472b6', '#5ce68a', '#facc15', '#60a5fa'];
const opColor = name => {
    let hash = 0;
    for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
    return OP_COLORS[hash % OP_COLORS.length];
};

export function renderOperators(rows) {
    const box = $('#opBars');
    if (!box) return;
    const stats = new Map();
    rows.forEach(qso => {
        const name = String(qso.operator || '').trim() || '—';
        const entry = stats.get(name) || {qsos: 0, points: 0, mults: 0, last: 0};
        entry.qsos += 1;
        entry.points += Number(qso.points) || 0;
        if (qso.is_mult) entry.mults += 1;
        const time = new Date(qso.timestamp).getTime();
        if (isFinite(time) && time > entry.last) entry.last = time;
        stats.set(name, entry);
    });
    stats.delete('—');
    const list = [...stats.entries()].sort((a, b) => b[1].qsos - a[1].qsos).slice(0, 7);
    if (!list.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.op.empty')) + '</div>';
        return;
    }
    const max = list[0][1].qsos || 1;
    const minutes = since => {
        if (!since) return '—';
        const gap = Math.max(0, Date.now() - since) / 60000;
        return gap < 60 ? Math.round(gap) + '′' : (gap / 60).toFixed(1) + 'h';
    };
    box.innerHTML = list.map(([name, entry]) => {
        const color = opColor(name);
        return '<div class="opbar" style="--c:' + color + '">' +
            '<span class="k">' + esc(name) + '</span>' +
            '<i class="track"><i style="width:' + Math.round(entry.qsos / max * 100) +
            '%;background:' + color + '"></i></i>' +
            '<em>' + entry.qsos + '</em>' +
            '<b class="pts">+' + entry.points + '</b>' +
            '<u class="ago">' + esc(minutes(entry.last)) + '</u>' +
            '</div>';
    }).join('') + '<div class="rows-more" hidden></div>';
    trimRows(box, {rowClass: 'opbar', extra: stats.size - list.length});
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

    const byBand = new Map();
    rows.forEach(qso => {
        const band = String(qso.band || '').toUpperCase() || '—';
        byBand.set(band, (byBand.get(band) || 0) + 1);
    });
    renderRank('#bandList', byBand, 8, true);
}

/**
 * 行数自适应：大屏的行高由字号决定，不参与压缩，所以一屏放不下的行必须显式
 * 删掉，并在容器里标出还剩多少条。矮视口（笔记本预览、带工具栏的浏览器）靠
 * 这一步保证不会出现两行文字叠在一起；4K 墙上则一行都不少。
 *
 * @param {HTMLElement} box 行容器
 * @param {object} options rowClass 行类名；marker 显示 "+N" 的元素（缺省在容器
 *   内建一个 .rows-more）；extra 渲染前已经被截掉的条数；min 至少保留的行数
 */
export function trimRows(box, options) {
    if (!box) return;
    const opts = options || {};
    const min = Math.max(1, opts.min === undefined ? 1 : opts.min);
    const rows = [...box.children].filter(child =>
        child.classList && child.classList.contains(opts.rowClass || 'trim-row'));
    let marker = opts.marker;
    if (!marker) {
        marker = box.querySelector('.rows-more');
        if (!marker) {
            marker = document.createElement('div');
            marker.className = 'rows-more';
            box.appendChild(marker);
        }
    }
    const extra = Number(opts.extra) || 0;
    let dropped = 0;
    marker.hidden = true;
    const spill = () => box.scrollHeight > box.clientHeight + 1;
    while (rows.length > min && spill()) {
        rows.pop().remove();
        dropped += 1;
    }
    if (!extra && !dropped) return;
    marker.textContent = '+' + (extra + dropped);
    marker.hidden = false;
    while (rows.length > min && spill()) {
        rows.pop().remove();
        dropped += 1;
        marker.textContent = '+' + (extra + dropped);
    }
}

function renderRank(selector, values, limit, bandColor) {
    const box = $(selector);
    const list = [...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const max = list.length ? list[0][1] : 0;
    box.innerHTML = list.length ? list.map(([key, value]) => {
        const color = bandColor ? (WALL_BAND_COLORS[key] || '#35d6a4') : COLORS.qso;
        return '<div class="hbar"><span class="k">' + esc(key) + '</span>' +
            '<i class="track"><i style="width:' + Math.round(value / (max || 1) * 100) +
            '%;background:' + color + '"></i></i><em>' + value + '</em></div>';
    }).join('') + '<div class="rows-more" hidden></div>'
        : '<div class="opp-empty">—</div>';
    if (list.length) trimRows(box, {rowClass: 'hbar', extra: values.size - list.length});
}
