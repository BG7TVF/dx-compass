import {
    clockOptions,
    clockWeekday,
    formatDuration,
    formatClock,
    formatClockDate,
    parseUtcDateTime
} from '../shared/core/clock.mjs';
import {getLanguage, t} from './wall-i18n.mjs';
import {OPPONENT_SHAPES, shapeSvg} from '../shared/map/markers.mjs';
import {WALL_BAND_COLORS} from '../shared/opponents/opponents.mjs';

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

/** Pure space-weather cells, shared by the wall and the OP view.
 * 返回 [标签, 读数, 档位, 缩写] 四元组：标签是 4 字以内的中文短名（观众读不懂
 * SFI/KP/DST 这类缩写，但格子只有 58px 内容宽，写全称会折行撑爆卡片；新文案
 * 一律走 tr 兜底，不往 11 语种字典里加键）；档位是
 * 'good' | 'fair' | 'poor'，无数据时为 ''（渲染端不画状态点、不加底色）；
 * 缩写是国际通用短名，留给标签位很窄的 OP 视图用。
 * 旧版只有 kp/dst/bz 的单档 'bad' 红色提示，「还行」与「很糟」分不开，
 * 这里在原有阈值基础上扩成三档，物理含义逐条写在 pick() 上方的注释里。 */
export function spaceWeatherCells(data) {
    const sfi = last(data.sfi && data.sfi.list);
    const kp = last(data.kp && data.kp.list);
    const dst = last(data.dst && data.dst.list);
    const xr = last(data.xray && data.xray.list);
    const ssn = last(data.ssn && data.ssn.list);
    const mag = last(data.mag && data.mag.list);
    const wind = last(data.wind && data.wind.list);
    const ham = data.ham || {};
    /* 数值化：序列最新值优先，缺序列时退回 ham 快照；非有限数一律 null。 */
    const n = value => typeof value === 'number' && isFinite(value) ? value : null;
    const sfiVal = n(sfi ? sfi[1] : (ham.sfi ?? ham.solar_flux));
    const ssnVal = n(ssn ? ssn[1] : ham.ssn);
    const kpVal = n(kp ? kp[1] : (ham.kp ?? ham.k_index));
    const dstVal = n(dst ? dst[1] : ham.dst);
    const bzVal = n(mag && mag[2] !== null ? mag[2] : ham.bz);
    const btVal = n(mag && mag[1] !== null ? mag[1] : (ham.bt ?? ham.btotal));
    const windVal = n(wind ? wind[1] : (ham.wind ?? ham.wind_speed ?? ham.windKmps));
    /* X 射线：序列值是通量，xrayClass 把它换成 A/B/C/M/X 等级字；ham 兜底
     * 本身就是等级字符串。等级字直接决定档位。 */
    const xrayText = xr ? xrayClass(xr[1]) : (ham.xray || '—');
    const xrayLetter = (String(xrayText).match(/[ABCMX]/) || [''])[0];
    /* 三档判档器：无数据（null）返回 ''，否则 poorIf 命中为 poor、
     * fairIf 命中为 fair、都不命中为 good。各档阈值按对短波传播的物理影响划定：
     *  SFI（10.7cm 太阳射电通量，与 F 层电离度成正比）：
     *      ≥150 太阳活动旺盛，高端波段开通充沛（good）；100~149 中等（fair）；
     *      <100 电离弱，高端波段难开（poor）。
     *  SSN（太阳黑子数，与 SFI 同源）：≥100 good；40~99 fair；<40 poor。
     *  KP（行星地磁指数）：≤3 地磁平静（good）；4~5 扰动，极区吸收增大、
     *      高纬路径变差（fair）；≥6 磁暴，全路径吸收与衰落严重（poor）。
     *  DST（赤道环电流指数）：>-25 平静（good）；-50~-25 磁暴初起、
     *      F 层开始受扰（fair）；≤-50 磁暴主相，扰动强烈（poor）。
     *  BZ（行星际磁场南北分量）：>-4 基本北向/持平，磁层平静（good）；
     *      -10~-4 南向分量偏强，极盖吸收增大（fair）；≤-10 强南向，
     *      磁重联剧烈，短波易中断（poor）。
     *  BT（行星际磁场总强度）：<10 平静（good）；10~20 偏压缩（fair）；
     *      ≥20 强压缩，常伴随行星际激波（poor）。
     *  WIND（太阳风速度）：<450 慢风平静（good）；450~600 快速风，可能出现
     *      复发地磁扰动（fair）；>600 高速流冲击，磁暴风险高（poor）。
     *  XRAY（X 射线耀斑等级）：A/B/C 级对短波无明显影响（good）；
     *      M 级造成日照面衰落（fair）；X 级造成大范围短波中断（poor）。 */
    const pick = (value, poorIf, fairIf) =>
        value === null ? '' : (poorIf ? 'poor' : (fairIf ? 'fair' : 'good'));
    const xrayTier = !xrayLetter ? ''
        : (xrayLetter === 'X' ? 'poor' : (xrayLetter === 'M' ? 'fair' : 'good'));
    /* 第 4 项是国际通用缩写：OP 视图的空间天气格只有 9px 的标签位，塞不进
     * 一长串中文全称，继续吃这个短名。观众墙用第 1 项的中文全称。 */
    /* 标签长度是被实测卡死的：4 列网格里每格只有 ~58px 的内容宽，标签超过
     * 4 个汉字就会折成两行——两行高度撑爆 .sw-card（它是 overflow:hidden，
     * 折线图被静默切掉），横向超出则被 .sw-grid 裁字。所以这里全部压到
     * 4 个汉字以内：观众看到的是中文，不是 SFI/KP/DST 这类黑话。 */
    return [
        [tr('wall.sw.sfi', '太阳活动'), num(sfiVal, 0), pick(sfiVal, sfiVal < 100, sfiVal < 150), 'SFI'],
        [tr('wall.sw.ssn', '黑子数'), num(ssnVal, 0), pick(ssnVal, ssnVal < 40, ssnVal < 100), 'SSN'],
        [tr('wall.sw.kp', '地磁指数'), num(kpVal, 1), pick(kpVal, kpVal >= 6, kpVal >= 4), 'KP'],
        [tr('wall.sw.dst', '地磁暴'), dstVal === null ? '—' : num(dstVal, 0),
            pick(dstVal, dstVal <= -50, dstVal <= -25), 'DST'],
        [tr('wall.sw.bz', '磁场 Bz'), num(bzVal, 1), pick(bzVal, bzVal <= -10, bzVal <= -4), 'BZ'],
        [tr('wall.sw.bt', '磁场强度'), num(btVal, 1), pick(btVal, btVal >= 20, btVal >= 10), 'BT'],
        [tr('wall.sw.wind', '太阳风'), num(windVal, 0), pick(windVal, windVal > 600, windVal >= 450), 'WIND'],
        [tr('wall.sw.xray', 'X 射线'), xrayText, xrayTier, 'XRAY']
    ];
}

export function renderSpaceWeather(data) {
    const box = $('#swGrid');
    if (!box) return;
    /* 格结构：上排中文全称（占整行宽，CJK 按整字换行，绝不裁半字），下排
     * 读数 + 状态点。状态点是「颜色 + 形状」双编码：good=圆点、fair=方点、
     * poor=菱形点，灰度打印下也能凭形状分出三档；无数据的格没有点也没有底色。 */
    box.innerHTML = spaceWeatherCells(data).map(([label, value, tier]) =>
        '<div class="sw-cell' + (tier ? ' ' + tier : '') + '"><label>' + esc(label) +
        '</label><span class="sw-val"><b>' + esc(value) + '</b>' +
        (tier ? '<i class="sw-dot"></i>' : '') + '</span></div>').join('');
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
        /* 状态词最长 8 个字符（如「轻微干扰」/ 'minor disturb'）：格宽不够时靠
         * bigscreen.css 里 .band 的整字换行兜住，这里不截字、不写省略号。 */
        return {band: label, className, level, condition: t('wall.condition.' + className)};
    });
}

/** Render only the server forecast, selecting its HOME-local day or night table. */
export function renderBands(forecast, now = new Date()) {
    const bar = $('#bandBar');
    if (!bar) return;
    const cells = bandConditionCells(forecast, now);
    const tiles = cells.length ? cells.map(cell => {
        return '<div class="band ' + cell.className + '"><b>' + esc(cell.band) +
            '</b><span>' + esc(cell.condition) + '</span><div class="meter">' +
            [0, 1, 2].map(index => '<u' + (index < cell.level ? ' class="on"' : '') + '></u>').join('') +
            '</div></div>';
    }).join('') : '<div class="band closed"><b>—</b></div>';
    /* 列数先按格子总数取最接近正方形的排布（16 格 → 4x4，11 格 → 3x4，
     * 3 格 → 2x2），再逐格回读一次实际渲染：只要还有格子横向放不下
     * （scrollWidth > clientWidth）就减一列重来。写死四列时「甚高频」加状态词
     * 会被切掉 8 个像素，就是靠这个回读循环退回三列消掉的——裁字不是解法，
     * 减列才是（格子既没有省略号也没有 overflow: hidden）。
     * 行数交给 CSS 的 minmax(0,1fr) 平分卡高，纵向余量同样由探针逐格量过。 */
    const start = Math.max(1, Math.min(4, Math.round(Math.sqrt(cells.length || 1))));
    for (let cols = start; cols >= 1; cols -= 1) {
        bar.style.setProperty('--band-cols', String(cols));
        bar.classList.toggle('wrap-names', cols === 1);
        bar.innerHTML = tiles;
        if (cols === 1) break;
        const clipped = [...bar.children].some(tile => tile.scrollWidth > tile.clientWidth + 1);
        if (!clipped) break;
    }
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

/* 与 lib/radio/bands.js、settings-model.mjs 同一套米波归一化。
 * N1MM 的 QSO 行是 14/21（兆赫），席位表是 15M，两者必须落到同一个键，
 * 否则大屏会把 15 米波拆成「15M」和「21」两行。 */
const KHZ_BANDS = [
    [1800, 2000, '160M'], [3500, 4000, '80M'], [5330, 5410, '60M'],
    [6900, 7300, '40M'], [10000, 10200, '30M'], [13950, 14350, '20M'],
    [18068, 18200, '17M'], [20950, 21450, '15M'], [24800, 25000, '12M'],
    [27900, 29700, '10M'], [49000, 54000, '6M'], [70000, 71000, '4M'],
    [143000, 148000, '2M'], [420000, 450000, '70CM']
];
const METER_BANDS = [160, 80, 60, 40, 30, 20, 17, 15, 12, 10, 6, 4, 2];
const MHZ_BANDS = [7, 10, 14, 18, 21, 24, 28, 50, 70, 144];
const MHZ_RANGES = [
    [0, 2, '160M'], [2, 4.6, '80M'], [4.6, 6.5, '60M'], [6.5, 8.6, '40M'],
    [8.6, 11.6, '30M'], [11.6, 16, '20M'], [16, 19.6, '17M'], [19.6, 22.6, '15M'],
    [22.6, 26.6, '12M'], [26.6, 30, '10M'], [30, 54, '6M'], [54, 76, '4M'],
    [76, 148, '2M'], [148, 470, '70CM']
];

function bandFromKhz(freqKhz) {
    const freq = Number(freqKhz);
    if (!Number.isFinite(freq) || freq <= 0) return '';
    for (const [low, high, name] of KHZ_BANDS) {
        if (freq >= low && freq <= high) return name;
    }
    return '';
}

function metersFromMhz(mhz) {
    if (!Number.isFinite(mhz) || mhz <= 0) return '';
    for (const [low, high, name] of MHZ_RANGES) {
        if (mhz >= low && mhz < high) return name;
    }
    return '';
}

export function normalizeBand(band, freqKhz) {
    const byFreq = bandFromKhz(freqKhz);
    if (byFreq) return byFreq;
    const text = String(band === null || band === undefined ? '' : band).trim().toLowerCase();
    if (!text) return '';
    const cm = /^(\d+(?:\.\d+)?)\s*(?:cm|厘米)$/.exec(text);
    if (cm) return `${parseFloat(cm[1])}CM`;
    const meter = /^(\d+(?:\.\d+)?)\s*(?:m|米|meter|meters)$/.exec(text);
    if (meter) return `${parseFloat(meter[1])}M`;
    const numeric = /^(\d+(?:\.\d+)?)$/.exec(text);
    if (numeric) {
        const value = parseFloat(numeric[1]);
        if (numeric[1].includes('.')) return metersFromMhz(value) || `${value}M`;
        if (value > 160 || MHZ_BANDS.includes(value)) return metersFromMhz(value) || text.toUpperCase();
        if (METER_BANDS.includes(value)) return `${value}M`;
        return text.toUpperCase();
    }
    return text.toUpperCase();
}

/* ---------- 席位配色：观众墙唯一的身份系统 ----------
 * 席位身份用「色 + 形」双编码：颜色回答「这是第几号席位」，形状在同一席位
 * 色相被环境吃掉（远距离、色弱、黑白投影）时补一层保险。席位卡、天线徽章、
 * 波段徽章、操作员条、QSO 流水席位列与行首色条、地图 dial 弧段、地图点位和大
 * 圆线共用这一张色表，观众凭颜色或形状就能把同一台机器在所有面板上串起来。
 * 这里没有「本席/他席」——观众不存在“我的席位”这个视角。
 *
 * 全墙的色相预算只有三类，别处不再拿颜色当语义：
 *  1. 席位身份 = 色 + 形（下面的 SEAT_COLORS / SEAT_SHAPES）；
 *  2. 波段 = 只出现在「天线归属」行首的那根竖条与天线/电台状态表的波段徽章，
 *     走 WALL_BAND_COLORS（本阶段有意保留）；
 *  3. 传播好坏 = --good / --fair / --poor（波段预测格的底色档位属于这一类）。
 * KPI 数字与「波段通联占用」条不参与用色：KPI 只做中性读数，占用条统一用
 * accent，靠宽度和文字表达占比。 */
/* 席位色板：8 席 8 色，与下面的 8 形组成「色 + 形」双编码。
 *
 * 为什么不再按色轮等间隔 45° 排布：
 *  1. 等间隔把色轮平均切成八份，相邻两份必然落在同一色族。浏览器实测旧板
 *     3 席 #70d039 rgb(112,208,57) 与 4 席 #81d9a3 rgb(129,217,163) 欧氏色距
 *     只有约 113（CIE ΔE00 仅 15.2），是全板最弱的一对，三米外就是同一个绿；
 *     新板 1-6 席两两最小 ΔE00 提升到 29.2，红/黄/绿/青/蓝/品红分属六个色族。
 *  2. 色轮的大半弧度已被语义色占用（波段 12 个色相、--good 161°、--fair 47°、
 *     --poor 14°、--amber 35°、--cyan/--my 194°、--dx 0°），数学上的均匀分布
 *     根本做不到，只能优先把「这座台会同时点亮的前 6 席」拉开。
 *  3. 明度刻意按 亮 亮 中 暗 亮 亮 交替，色相被抽掉（黑白投影、色弱）时仍然
 *     分得开；第 7、8 席允许贴近前席（与 3 席最小 ΔE00 17.9），因为这两席很少
 *     同时点亮，靠形状（正方形 / 靶心）兜底区分。
 *  4. 逐字节检查过：与 --good #35d6a4、--fair #e8c547、--poor #e4572e、
 *     --amber #ffb347、--cyan #4cc9f0、--dx #ff6b6b 以及 OPPONENT_COLORS 的
 *     六个色值都不重合。天线归属行的竖条仍走波段色（20M #00e5ff 与 4 席、
 *     12M #e84393 与 6 席色相接近），但那是「行首竖条」这一独立通道，位置和
 *     形状都与席位标记不同，不会被读成席位身份。
 *
 * 对深色底 --panel #0a121d 的对比度依次 6.14 / 13.02 / 10.53 / 8.63 / 5.87 /
 * 7.48 / 5.41 / 12.31：前 6 席全部 ≥ 5:1，8 席全部 ≥ 4.5:1（WCAG AA）。 */
export const SEAT_COLORS = ['#ff5c43', /* 1 红    hue   8 亮 6.14:1 */
    '#ffd23f', /* 2 黄    hue  46 亮 13.02:1 */
    '#3ddc84', /* 3 绿    hue 147 中 10.53:1 */
    '#00c2d1', /* 4 青    hue 184 暗 8.63:1 */
    '#4c8dff', /* 5 蓝    hue 218 亮 5.87:1 */
    '#ff6fc8', /* 6 品红  hue 323 亮 7.48:1 */
    '#a06bff', /* 7 紫    hue 261 中 5.41:1 */
    '#b6e04a' /* 8 黄绿  hue  77 中 12.31:1 */];

export function seatColor(no) {
    const value = Math.round(Number(no));
    const index = (isFinite(value) && value > 0 ? value : 1) - 1;
    return SEAT_COLORS[index % SEAT_COLORS.length];
}

/* 席位第二编码：形状。直接复用地图对手模块导出的形状表（同一套图形语言，
 * 也省一份实现），server.js 的 STATIC 白名单里已有 /shared/map/markers.mjs。
 * 席位超过 8 个按取模循环，取模行为与 seatColor 完全一致。 */
export const SEAT_SHAPES = OPPONENT_SHAPES;

/** 席位形状：非法或 0 号席位回退到第 1 席，与 seatColor 同规则。 */
export function seatShape(no) {
    const value = Math.round(Number(no));
    const index = (isFinite(value) && value > 0 ? value : 1) - 1;
    return SEAT_SHAPES[index % SEAT_SHAPES.length] || 'disc';
}

/**
 * 席位形状标记（内联 SVG）。画成 currentColor：颜色由所在元素的 CSS color 决定
 * （徽章、席位卡、流水席位列都是 var(--seat)），徽章进入「发射中」反色态
 * （席位色底 + 深色字）时形状自动转深，不会糊在底色里。
 * width/height=12 只是 CSS 失效时的兜底，实际尺寸由 .seat-mark svg 的 em
 * 跟随 --fs-* 阶梯，不写死大像素值。 */
export function seatMark(no, cls) {
    return '<i class="seat-mark' + (cls ? ' ' + cls : '') + '">' +
        shapeSvg(seatShape(no), 'currentColor', 12) + '</i>';
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

/* ---------- QSO 流水：观众墙的主角面板 ----------
 * 一条通联一行，把日志里有的字段全部摊开：时间、席位、操作员、被通呼号、波段、
 * 频率、模式、信号报告、交换、网格、实体、分数（倍率那条加 ★）。
 *
 * 零裁切的做法不是省略号，而是「先量后钉」：栅格先按 max-content 自适应，读回
 * 浏览器实际算出的列宽；总宽超出卡片时按 操作员 → 交换 → 网格 → 频率 的顺序
 * 整列删掉，再不够就缩字号（下限 15px，见 QSO_MIN_FONT，与 CSS 里 .qso-row 的
 * max(15px, …) 同值），最后才由 trimRows 整行删并标 "+N"。
 * 屏幕上任何时刻都不会出现半个呼号——宁可少一行，也不少一个字符。
 * 丢弃顺序把「操作员」排在最前：它和席位卡重复，而频率是观众判断台子停在
 * 哪个频点的核心信息，排在最后，1920 宽下 12 列全显。 */
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
    {key: 'entity', label: 'wall.qso.col.entity', fallback: 'Entity', cls: 'entity'},
    {key: 'points', label: 'wall.qso.col.points', fallback: 'Pts', cls: 'num score'}
];
/* 可选列的丢弃顺序：操作员排在最前（它与席位卡、顶部操作员条重复），
 * 频率固定排在最后——观众要看台子停在哪个频点，1920 宽下 12 列必须全显。 */
const QSO_DROP_ORDER = ['operator', 'exchange', 'grid', 'freq'];
const QSO_MAX_ROWS = 140;
const QSO_GAP = 6;
/* .qso-row 的水平占用合计 = 行首席位色条 3 + 左内边距 2 + 右内边距 3 = 8。
 * 这根 3px 色条是新增的横向占用，必须计进 need，否则整表会比实测需求窄，
 * 最后一列又要开始截字；表头改用 padding-inline: 5px 3px 让出同样的 8px，
 * 两者的内容起点都是 5px，列才会逐列对齐（改动这三处时一起对齐）。 */
const QSO_PAD = 8;
/* 流水表是全页主角，字号硬下限从 10.5px 抬到 15px，与 bigscreen.css 里
 * .qso-row 的 max(15px, …) 保持同一个值——两边任一方先动就会互相打架。 */
const QSO_MIN_FONT = 15;
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
            return normalizeBand(row.band, row.freq_khz) || '—';
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
                /* 席位号 = 色条之外的第二处身份：数字左边再画一枚席位形状。
                 * 它是 .seat-cell（flex 项）里的普通流内元素，measureTracks 用
                 * max-content 实测这一列时会把 SVG 的宽度一并算进去，所以不
                 * 可能挤掉后面的数字——形状越宽，列就钉得越宽。 */
                return '<span class="seat-cell">' +
                    (seat ? seatMark(seat.no) : '') + esc(value) + '</span>';
            }
            if (col.key === 'points') {
                return '<span class="num score">' + esc(value) +
                    (entry.row.is_mult ? '<i>★</i>' : '') + '</span>';
            }
            return '<span' + (col.cls ? ' class="' + col.cls + '"' : '') + '>' +
                esc(value) + '</span>';
        }).join('');
        /* 席位色挂到行上：行首那 3px 实条和席位列的字色共用同一个 var(--seat)。 */
        return '<div class="qso-row' + (entry.fresh ? ' fresh' : '') + '"' +
            (seat ? ' style="--seat:' + seat.color + '"' : '') + '>' + cells + '</div>';
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
    /* KPI 不再按卡片换色相：这类装饰性用色会和席位色抢同一个视觉变量——旧的
     * --mint/--amber/--cyan/--violet/#f472b6 五个值逐字节就是旧色板的席位
     * 1/2/3/5/6，观众会把「已通国家 29」的粉色读成 6 号席位的数据。数值统一
     * 用 --text，左侧强调条与内阴影统一 --accent（见 bigscreen.css .kpi）。 */
    const cells = [
        {key: 'score', label: t('wall.kpi.score'), value: pick(score.points, logged)},
        {key: 'qsos', label: t('wall.kpi.qsos'), value: pick(score.qsos, rows.length)},
        {key: 'mults', label: t('wall.kpi.mults'), value: pick(score.mults, mults)},
        {key: 'countries', label: tr('wall.kpi.countries', 'Entities'),
            value: entities.size, extra: 'countries'},
        {key: 'rate', label: t('wall.kpi.rate'), value: hour, suffix: '/h'}
    ];
    box.innerHTML = cells.map(cell => '<div class="kpi' +
        (cell.extra ? ' ' + cell.extra : '') + '"><span>' +
        esc(cell.label) + '</span><b>' + cell.value +
        (cell.suffix ? '<i>' + esc(cell.suffix) + '</i>' : '') + '</b></div>').join('');
}

/* 原先这里是一张「各操作员」战果卡（renderOperators + opColor + alignLabelColumn）。
 * 席位卡右侧已经挂了同一位操作员的四个短读数，重复的卡和它的专用工具函数一起删掉。 */

/* 头栏 KPI 已经给了「速率 /h」，底部那张速率卡删掉后这里只留十分钟平滑值：
 * 它写在逐分钟节奏卡的表头上，和 30 分钟分组柱对着看——柱子是「哪一分钟猛」，
 * 这个数是「这十分钟平均多快」。 */
export function renderQsoStats(rows) {
    const now = Date.now();
    const within = milliseconds => rows.filter(qso => {
        const time = new Date(qso.timestamp).getTime();
        return isFinite(time) && now - time <= milliseconds;
    }).length;
    const min = $('#rateMin');
    if (min) min.textContent = (within(10 * 60 * 1000) / 10).toFixed(1);
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

/* ---------- 对手矩阵：对手很少时的紧凑排布 ----------
 * 对手不足 4 家时，共享渲染器的「一家一张横条大卡」会让两三家占满整栏高度，
 * 几乎没有信息量；wall-page 数出家数后就切到这张矩阵：行 = 波段，列 = 对手，
 * 每格是该对手在该波段活动窗口内的 SPOT 条数，0 条显示「—」，整行全 0 的
 * 波段不输出行。只有 1 家对手时矩阵退化成单列，仍然比横条大卡省地方。
 *
 * 行序直接复用页面既有的波段顺序：WALL_BAND_COLORS 键序（160M→2M）再补
 * VHF（bandOf 会产出 VHF，色表里没有这个键），表外波段排最后——与上方
 * 「波段通联占用」表同一个行序，观众刚看完哪些波段在用，往下能对着读
 * 每家对手活跃在哪些波段。
 *
 * 活跃度用页面中性亮色的 alpha 阶梯（lv1/lv2/lv3）表达，不引入新色相：
 * 全墙色相预算只有席位身份（色+形）、天线归属竖条与 --good/--fair/--poor
 * 三档状态色；格子里的数字读数本身就是权威信息，底色深浅只帮快速扫视。
 *
 * 宽度不够时的解法是「减列」与整词换行：列数 = 对手家数（本来就只有 1~3
 * 列），呼号与波段名允许整词/整字折行，绝不裁字、绝不用省略号；高度不够
 * 由 trimRows 整行删除并标 +N，列头行不参与删除。 */
const MATRIX_BAND_ORDER = [...Object.keys(WALL_BAND_COLORS), 'VHF'];

export function renderOpponentMatrix(box, rivals) {
    if (!box) return;
    box.classList.add('opp-matrix');
    /* 共享渲染器可能在对手 ≥4 家时留下过密度类，矩阵接手时清掉，
     * 免得旧类名把矩阵行的样式带偏。 */
    box.classList.remove('dense', 'dense-2', 'compact');
    const list = (Array.isArray(rivals) ? rivals : []).filter(rival => rival && rival.call);
    if (!list.length) {
        box.innerHTML = '';
        return;
    }
    /* 先按波段聚合出格子，同时记下全场最大条数，给 alpha 阶梯分级用。 */
    const byBand = new Map();
    let max = 1;
    list.forEach(rival => (Array.isArray(rival.bands) ? rival.bands : []).forEach(entry => {
        const key = String((entry && entry.band) || '').toUpperCase();
        const count = Number(entry && entry.n) || 0;
        if (!key || count <= 0) return;
        const row = byBand.get(key) || {total: 0, cells: new Map()};
        row.total += count;
        row.cells.set(rival.call, count);
        byBand.set(key, row);
        if (count > max) max = count;
    }));
    const rank = key => {
        const index = MATRIX_BAND_ORDER.indexOf(key);
        return index < 0 ? MATRIX_BAND_ORDER.length : index;
    };
    const rows = [...byBand.entries()]
        .filter(([, row]) => row.total > 0)
        .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
    if (!rows.length) {
        box.innerHTML = '';
        return;
    }
    /* 三档阶梯：占最大格的比例，≥2/3 为 lv3，≥1/3 为 lv2，其余有数为 lv1。 */
    const level = count => count <= 0 ? 0
        : (count >= max * 2 / 3 ? 3 : (count >= max / 3 ? 2 : 1));
    /* 列头的形状 + 颜色与地图上对手标记同源同序（shapeSvg 手法与 oc-head 一致）。 */
    const head = '<div class="opp-mx-head"><span class="opp-mx-band">' +
        esc(tr('wall.opp.mxHead', '波段')) + '</span>' +
        list.map(rival => {
            const color = rival.color || '#8aa0bd';
            const shape = OPPONENT_SHAPES.includes(rival.shape) ? rival.shape : 'disc';
            return '<span class="opp-mx-call" style="--rival:' + esc(color) + '">' +
                '<i class="opp-mx-shape">' + shapeSvg(shape, color, 12) + '</i>' +
                esc(rival.call) + '</span>';
        }).join('') + '</div>';
    const body = rows.map(([key, row]) =>
        '<div class="opp-mx-row"><span class="opp-mx-band">' +
        esc(key === 'VHF' ? t('wall.band.vhf') : key) + '</span>' +
        list.map(rival => {
            const count = row.cells.get(rival.call) || 0;
            const lv = level(count);
            return '<i class="opp-mx-cell' + (lv ? ' lv' + lv : ' off') + '">' +
                (count ? String(count) : '—') + '</i>';
        }).join('') + '</div>').join('');
    box.style.setProperty('--mx-cols',
        'minmax(0, auto) repeat(' + list.length + ', minmax(0, 1fr))');
    box.innerHTML = head + body + '<div class="rows-more" hidden></div>';
    trimRows(box, {rowClass: 'opp-mx-row'});
}

