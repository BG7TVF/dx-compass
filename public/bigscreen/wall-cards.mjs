import {
    clockOptions,
    clockWeekday,
    formatDuration,
    formatClock,
    formatClockDate,
    parseUtcDateTime
} from '../shared/core/clock.mjs';
import {getLanguage, t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
const locale = () => {
    const lang = getLanguage();
    return lang === 'zh' ? 'zh-CN' : lang;
};
const timeZoneOf = options => options.timeZone === 'local' ? undefined : 'UTC';
const upper = text => String(text || '').toUpperCase();
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

/* ---------- 席位配色：观众墙唯一的身份系统 ----------
 * 颜色只回答「这是第几号席位」。席位卡、天线徽章、波段徽章、操作员条、QSO
 * 流水和地图大圆线共用这一张色表，观众凭颜色就能把同一台机器在所有面板上串
 * 起来。这里没有「本席/他席」——观众不存在“我的席位”这个视角。 */
export const SEAT_COLORS = ['#35d6a4', '#ffb347', '#4cc9f0', '#ff6b6b', '#a78bfa',
    '#f472b6', '#5ce68a', '#facc15', '#60a5fa', '#e8c547', '#22d3ee', '#fb923c',
    '#c084fc', '#4ade80', '#f87171', '#38bdf8'];

export function seatColor(no) {
    const value = Math.round(Number(no));
    const index = (isFinite(value) && value > 0 ? value : 1) - 1;
    return SEAT_COLORS[index % SEAT_COLORS.length];
}

/** 词条兜底：字典缺键时 t() 会原样返回键名，屏幕上出现键名比出现英文更糟。 */
export function tr(key, fallback, params) {
    const text = t(key, params);
    return text === key ? fallback : text;
}

/** 元素当前真正生效的字号（px）：clamp() 的字号要落地后才能拿去量宽度。 */
export function fontPx(element, fallback = 12) {
    if (!element || typeof getComputedStyle !== 'function') return fallback;
    const size = parseFloat(getComputedStyle(element).fontSize);
    return isFinite(size) && size > 0 ? size : fallback;
}

/**
 * 名称列对齐：先把 --label-w 放开成 max-content，量出本卡最长的标签，再写回固定
 * 像素。标签因此既不裁字，也不会压到右边的占比条上；万一长到超过半张卡，就让它
 * 折行（见 .oprows.long），而不是切掉一半。
 */
export function alignLabelColumn(box, rowClass, labelSelector, capRatio = 0.55) {
    if (!box) return;
    const rows = [...box.children].filter(node =>
        node.classList && node.classList.contains(rowClass));
    if (!rows.length) return;
    box.style.setProperty('--label-w', 'max-content');
    let natural = 0;
    rows.forEach(row => {
        const label = row.querySelector(labelSelector);
        if (label) natural = Math.max(natural, label.getBoundingClientRect().width);
    });
    if (!isFinite(natural) || natural <= 0) {
        box.style.removeProperty('--label-w');
        return;
    }
    const cap = Math.max(48, Math.floor(box.clientWidth * capRatio));
    box.classList.toggle('long', natural > cap);
    box.style.setProperty('--label-w', Math.round(Math.min(natural, cap)) + 'px');
}

/* ---------- QSO 流水：观众墙的主角面板 ----------
 * 一条通联一行，把日志里有的字段全部摊开：时间、席位、操作员、被通呼号、波段、
 * 频率、模式、信号报告、交换、网格、实体、分数（倍率那条加 ★）。
 *
 * 零裁切的做法不是省略号，而是「先量后钉」：栅格先按 max-content 自适应，读回
 * 浏览器实际算出的列宽；总宽超出卡片时按 频率 → 网格 → 交换 → 操作员 的顺序整列
 * 删掉，再不够就缩字号（下限 10.5px），最后才由 trimRows 整行删并标 "+N"。
 * 屏幕上任何时刻都不会出现半个呼号——宁可少一行，也不少一个字符。 */
const QSO_COLUMNS = [
    {key: 'time', label: 'wall.qso.col.time', fallback: 'Time', cls: 'dim'},
    {key: 'seat', label: 'wall.qso.col.seat', fallback: 'Seat', cls: 'seat-cell'},
    {key: 'operator', label: 'wall.qso.col.operator', fallback: 'OP', cls: 'op', optional: true},
    {key: 'call', label: 'wall.qso.col.call', fallback: 'Call', cls: 'call'},
    {key: 'band', label: 'wall.qso.col.band', fallback: 'Band', cls: 'band'},
    {key: 'freq', label: 'wall.qso.col.freq', fallback: 'MHz', cls: 'num', optional: true},
    {key: 'mode', label: 'wall.qso.col.mode', fallback: 'Mode', cls: 'mode'},
    {key: 'rst', label: 'wall.qso.col.rst', fallback: 'RST', cls: 'dim'},
    {key: 'exchange', label: 'wall.qso.col.exchange', fallback: 'Exch', cls: 'dim', optional: true},
    {key: 'grid', label: 'wall.qso.col.grid', fallback: 'Grid', cls: 'dim', optional: true},
    {key: 'entity', label: 'wall.qso.col.entity', fallback: 'Entity', cls: ''},
    {key: 'points', label: 'wall.qso.col.points', fallback: 'Pts', cls: 'num score'}
];
/* 可选列的丢弃顺序：先丢对观众最没信息量的。 */
const QSO_DROP_ORDER = ['freq', 'grid', 'exchange', 'operator'];
const QSO_MAX_ROWS = 140;
const QSO_GAP = 6;
const QSO_PAD = 6;
const QSO_MIN_FONT = 10.5;
/* 已经上过屏的 QSO：只有第一次出现的那一帧才闪绿，避免每次轮询重放动画。 */
let flashed = null;

function qsoMs(row) {
    const time = new Date(row && row.timestamp).getTime();
    return isFinite(time) ? time : 0;
}

function qsoIdentity(row, index) {
    return String((row && row.n1mm_id) ||
        (qsoMs(row) + '|' + (row && row.call) + '|' + (row && row.radionr) + '|' + index));
}

function qsoCell(row, key, model) {
    switch (key) {
        case 'time': {
            const ms = qsoMs(row);
            return ms ? new Date(ms).toISOString().slice(11, 19) : '—';
        }
        case 'seat': {
            const seat = model ? model.seatOfRow(row) : null;
            return seat && seat.no ? String(seat.no) : '—';
        }
        case 'operator': return String(row.operator || '').trim() || '—';
        case 'call': return String(row.call || '—').trim() || '—';
        case 'band':
            return String(row.band || (row.freq_khz ? bandOf(row.freq_khz) : '') || '—').toUpperCase();
        case 'freq': return row.freq_khz ? (Number(row.freq_khz) / 1000).toFixed(3) : '—';
        case 'mode': return String(row.mode || '—').trim().toUpperCase() || '—';
        case 'rst': {
            const sent = String(row.rst_snt || '').trim();
            const rcv = String(row.rst_rcv || '').trim();
            return sent || rcv ? (sent || '—') + '/' + (rcv || '—') : '—';
        }
        case 'exchange': return String(row.exchange || '').trim() || '·';
        case 'grid': return String(row.gridsquare || '').trim().toUpperCase() || '·';
        case 'entity':
            return String(row.countryprefix || row.continent || row.zone || '').trim().toUpperCase() || '—';
        case 'points': return String(Number(row.points) || 0);
        default: return '';
    }
}

function qsoMarkup(columns, entries, model) {
    const head = '<div class="qso-head">' + columns.map(col => '<span' +
        (col.cls.indexOf('num') >= 0 ? ' class="num"' : '') +
        '>' + esc(tr(col.label, col.fallback)) + '</span>').join('') + '</div>';
    const body = entries.map(entry => {
        const seat = model ? model.seatOfRow(entry.row) : null;
        const cells = columns.map(col => {
            const value = qsoCell(entry.row, col.key, model);
            if (col.key === 'seat') {
                return '<span class="seat-cell" style="--seat:' +
                    (seat ? seat.color : 'var(--dim)') + '">' + esc(value) + '</span>';
            }
            if (col.key === 'points') {
                return '<span class="num score">' + esc(value) +
                    (entry.row.is_mult ? '<i>★</i>' : '') + '</span>';
            }
            return '<span' + (col.cls ? ' class="' + col.cls + '"' : '') + '>' +
                esc(value) + '</span>';
        }).join('');
        return '<div class="qso-row' + (entry.fresh ? ' fresh' : '') + '">' + cells + '</div>';
    }).join('');
    return head + body + '<div class="rows-more" hidden></div>';
}

/** 读回浏览器实际算出的栅格轨道宽度，逐列取所有采样行的最大值。
 *  每行都是独立的 grid，只量第一行会踩坑：带 ★ 的倍率行比普通的宽，列一旦
 *  钉窄，那条 ★ 就被挤到第二行，一行变两行，整屏少掉十几条通联。 */
function measureTracks(box, count) {
    const widths = new Array(count).fill(0);
    const nodes = [box.querySelector('.qso-head'),
        ...[...box.querySelectorAll('.qso-row')].slice(0, 60)];
    nodes.forEach(node => {
        if (!node) return;
        const tracks = String(getComputedStyle(node).gridTemplateColumns).split(/\s+/);
        for (let i = 0; i < count; i += 1) {
            const px = parseFloat(tracks[i]);
            if (isFinite(px) && px > widths[i]) widths[i] = px;
        }
    });
    return widths;
}

export function renderQsoLog(box, rows, model) {
    if (!box) return;
    const source = Array.isArray(rows) ? rows : [];
    if (!source.length) {
        box.style.removeProperty('--cols');
        box.innerHTML = '<div class="qso-empty">' + esc(t('wall.qso.empty')) + '</div>';
        flashed = null;
        return;
    }
    /* 最新的一条排在最上面：观众站在墙前，最先看到的就该是刚打进来的那一条。 */
    const sorted = source.map((row, index) => ({row, index, ms: qsoMs(row)}))
        .sort((a, b) => b.ms - a.ms || b.index - a.index)
        .slice(0, QSO_MAX_ROWS);
    const seen = flashed || new Set();
    const firstPaint = !flashed;
    flashed = seen;
    const entries = sorted.map(item => {
        const id = qsoIdentity(item.row, item.index);
        const fresh = !firstPaint && !seen.has(id);
        seen.add(id);
        if (seen.size > 6000) seen.clear();
        return {row: item.row, fresh};
    });

    const available = box.clientWidth;
    let columns = QSO_COLUMNS.slice();
    box.style.removeProperty('--fs-row');
    box.innerHTML = qsoMarkup(columns, entries, model);
    box.style.setProperty('--cols', 'repeat(' + columns.length + ', max-content)');
    let rowPx = fontPx(box.querySelector('.qso-row'), 13);
    let guard = 0;
    while (guard < 24) {
        guard += 1;
        if (!available || available <= 0) break;
        const widths = measureTracks(box, columns.length);
        const need = widths.reduce((sum, w) => sum + Math.ceil(w), 0) +
            QSO_GAP * (columns.length - 1) + QSO_PAD;
        if (need <= available) {
            box.style.setProperty('--cols',
                widths.map(w => Math.ceil(w) + 'px').join(' '));
            break;
        }
        const droppable = QSO_DROP_ORDER.find(key => columns.some(col => col.key === key));
        if (droppable) {
            columns = columns.filter(col => col.key !== droppable);
            box.innerHTML = qsoMarkup(columns, entries, model);
            box.style.setProperty('--cols', 'repeat(' + columns.length + ', max-content)');
            continue;
        }
        if (rowPx > QSO_MIN_FONT) {
            rowPx = Math.max(QSO_MIN_FONT, rowPx - 0.5);
            box.style.setProperty('--fs-row', rowPx.toFixed(1) + 'px');
            continue;
        }
        box.style.setProperty('--cols',
            widths.map(w => Math.ceil(w) + 'px').join(' '));
        break;
    }
    /* 横向定下来之后才处理纵向：装不下的整行删掉并标剩余条数。 */
    trimRows(box, {rowClass: 'qso-row', extra: Math.max(0, source.length - entries.length)});
}

/* 头部 KPI 条：总分优先取 N1MM 的 Score 报文，缺报文时用日志自行累加，
 * 保证大屏在 N1MM 没发分数的竞赛里也不会空着。
 * 「已通国家」是给观众看的一格：不懂竞赛规则也能看出这台机器已经打到了
 * 多少个不同的地方，所以它紧挨着倍率排在速率之前。 */
export function renderKpi(station, rows) {
    const box = $('#kpiStrip');
    if (!box) return;
    const score = station && station.score || {};
    const logged = rows.reduce((total, qso) => total + (Number(qso.points) || 0), 0);
    const mults = rows.reduce((total, qso) => total + (qso.is_mult ? 1 : 0), 0);
    const entities = new Set();
    rows.forEach(qso => {
        const entity = String(qso.countryprefix || '').trim().toUpperCase();
        if (entity) entities.add(entity);
    });
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
        {key: 'countries', label: tr('wall.kpi.countries', 'Entities'),
            value: entities.size, tone: 'pink', extra: 'countries'},
        {key: 'rate', label: t('wall.kpi.rate'), value: hour, tone: 'violet', suffix: '/h'}
    ];
    box.innerHTML = cells.map(cell => '<div class="kpi ' + cell.tone +
        (cell.extra ? ' ' + cell.extra : '') + '"><span>' +
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

/* 各 OP 数据：按日志里的 operator 汇总 QSO 数与分数。
 * 颜色一律取该操作员当前主用的席位色，并且标签前带上「席位 N」——观众不需要
 * 认识呼号，也能把他和席位卡、QSO 流水、地图上的线对上。没有席位数据时退回
 * 按呼号哈希取色，保证条子永远有颜色。 */
export function renderOperators(rows, model) {
    const box = $('#opBars');
    if (!box) return;
    const stats = new Map();
    rows.forEach(qso => {
        const name = String(qso.operator || '').trim() || '—';
        const entry = stats.get(name) || {qsos: 0, points: 0, mults: 0, last: 0, seats: new Map()};
        entry.qsos += 1;
        entry.points += Number(qso.points) || 0;
        if (qso.is_mult) entry.mults += 1;
        const time = new Date(qso.timestamp).getTime();
        if (isFinite(time) && time > entry.last) entry.last = time;
        const seat = model ? model.seatOfRow(qso) : null;
        if (seat && seat.no) entry.seats.set(seat.no, (entry.seats.get(seat.no) || 0) + 1);
        stats.set(name, entry);
    });
    stats.delete('—');
    const list = [...stats.entries()].sort((a, b) => b[1].qsos - a[1].qsos).slice(0, 7);
    if (!list.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.op.empty')) + '</div>';
        box.classList.remove('long');
        box.style.removeProperty('--label-w');
        return;
    }
    const max = list[0][1].qsos || 1;
    const minutes = since => {
        if (!since) return '—';
        const gap = Math.max(0, Date.now() - since) / 60000;
        return gap < 60 ? Math.round(gap) + '′' : (gap / 60).toFixed(1) + 'h';
    };
    const dominant = entry => {
        let best = null;
        entry.seats.forEach((count, no) => {
            if (!best || count > best.count) best = {no, count};
        });
        return best;
    };
    box.innerHTML = list.map(([name, entry]) => {
        const seat = dominant(entry);
        const color = seat ? seatColor(seat.no) : opColor(name);
        const tag = seat ? tr('wall.rig.seatNo', 'Seat {n}', {n: seat.no}) + ' ' : '';
        return '<div class="opbar" style="--c:' + color + '">' +
            '<span class="k">' + esc(tag + name) + '</span>' +
            '<i class="track"><i style="width:' + Math.round(entry.qsos / max * 100) +
            '%;background:' + color + '"></i></i>' +
            '<em>' + entry.qsos + '</em>' +
            '<b class="pts">+' + entry.points + '</b>' +
            '<u class="ago">' + esc(minutes(entry.last)) + '</u>' +
            '</div>';
    }).join('') + '<div class="rows-more" hidden></div>';
    alignLabelColumn(box, 'opbar', '.k', 0.5);
    trimRows(box, {rowClass: 'opbar', extra: stats.size - list.length});
}


export function renderQsoStats(rows) {
    const now = Date.now();
    const within = milliseconds => rows.filter(qso => {
        const time = new Date(qso.timestamp).getTime();
        return isFinite(time) && now - time <= milliseconds;
    }).length;
    $('#rateHour').textContent = within(60 * 60 * 1000);
    $('#rateMin').textContent = (within(10 * 60 * 1000) / 10).toFixed(1);
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

