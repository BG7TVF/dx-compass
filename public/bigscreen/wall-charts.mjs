/* Wall-only canvas charts. Input rows come from shared repositories; this
 * module owns binning and drawing only, never transport or business lookups. */

import {t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0', score: '#ffb347'};

/* Space-weather carousel: one canvas cycles through the same series the
 * readout table shows. Dwell time is mirrored into CSS through --sw-dwell so
 * the progress tick under the header always matches the JS timer. */
let spaceDwell = 8000;
const spaceColumn = (list, index) => (list || [])
    .map(row => row && row[index])
    .filter(value => value !== null && value !== undefined && isFinite(value))
    .map(Number);
const xrayClass = flux => {
    if (!isFinite(flux) || flux <= 0) return '—';
    const order = ['A', 'B', 'C', 'M', 'X'];
    const exponent = Math.floor(Math.log10(flux));
    const mantissa = flux / Math.pow(10, exponent);
    return order[Math.max(0, Math.min(4, exponent + 8))] +
        (mantissa >= 1 ? mantissa.toFixed(1) : '1.0');
};
const SPACE_METRICS = [
    {key: 'sfi', label: 'SFI', color: '#e8c547', digits: 0,
        values: data => spaceColumn(data.sfi && data.sfi.list, 1)},
    {key: 'ssn', label: 'SSN', color: '#f0a35e', digits: 0,
        values: data => spaceColumn(data.ssn && data.ssn.list, 1)},
    {key: 'kp', label: 'KP', color: '#f1c40f', digits: 1,
        values: data => spaceColumn(data.kp && data.kp.list, 1)},
    {key: 'dst', label: 'DST', color: '#e4572e', digits: 0,
        values: data => spaceColumn(data.dst && data.dst.list, 1)},
    {key: 'bz', label: 'BZ', color: '#4cc9f0', digits: 1,
        values: data => spaceColumn(data.mag && data.mag.list, 2)},
    {key: 'bt', label: 'BT', color: '#8f7fff', digits: 1,
        values: data => spaceColumn(data.mag && data.mag.list, 1)},
    {key: 'wind', label: 'WIND', color: '#35d6a4', digits: 0,
        values: data => spaceColumn(data.wind && data.wind.list, 1)},
    {key: 'xray', label: 'XRAY', color: '#ff9f43', log: true,
        display: value => xrayClass(value),
        values: data => spaceColumn(data.xray && data.xray.list, 1)}
];

let spaceData = null;
let spaceIndex = 0;
let spaceTimer = null;
let spaceSwapTimer = null;
let spaceDotsKey = '';

export function canvasBox(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, cv.clientWidth);
    const h = Math.max(20, cv.clientHeight);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return {ctx, w, h};
}

export function perMinute(rows, minutes, now = Date.now()) {
    const bins = new Array(minutes).fill(0);
    rows.forEach(row => {
        const t = new Date(row.timestamp).getTime();
        if (!isFinite(t)) return;
        const age = Math.floor((now - t) / 60000);
        if (age >= 0 && age < minutes) bins[minutes - 1 - age]++;
    });
    return bins;
}

export function perHour(rows, hours, now = Date.now()) {
    const bins = new Array(hours).fill(0);
    rows.forEach(row => {
        const t = new Date(row.timestamp).getTime();
        if (!isFinite(t)) return;
        const age = Math.floor((now - t) / 3600000);
        if (age >= 0 && age < hours) bins[hours - 1 - age]++;
    });
    return bins;
}

export function drawBars(selector, bins, color) {
    const cv = $(selector);
    if (!cv) return 0;
    const {ctx, w, h} = canvasBox(cv);
    ctx.clearRect(0, 0, w, h);
    const peak = Math.max(0, ...bins);
    const max = Math.max(1, peak);
    const bw = w / bins.length;
    ctx.fillStyle = 'rgba(122,168,255,0.14)';
    ctx.fillRect(0, h - 1, w, 1);
    bins.forEach((value, i) => {
        const bh = (value / max) * (h - 6);
        if (bh <= 0) return;
        ctx.globalAlpha = 0.3 + 0.7 * (i + 1) / bins.length;
        ctx.fillStyle = color;
        ctx.fillRect(i * bw + 0.5, h - 1 - bh, Math.max(1, bw - 1.2), bh);
    });
    ctx.globalAlpha = 1;
    return peak;
}

export function drawLine(selector, values, color, options) {
    const cv = $(selector);
    if (!cv || values.length < 2) return;
    const {ctx, w, h} = canvasBox(cv);
    ctx.clearRect(0, 0, w, h);
    /* X-ray flux spans several orders of magnitude, so that series is drawn
     * against log10 while every other metric keeps the plain linear scale. */
    const series = options && options.log
        ? values.map(value => Math.log10(Math.max(value, 1e-9))) : values;
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const span = hi - lo || 1;
    const px = i => 1 + (i / (series.length - 1)) * (w - 2);
    const py = value => h - 3 - ((value - lo) / span) * (h - 7);
    ctx.beginPath();
    series.forEach((value, i) => {
        if (i) ctx.lineTo(px(i), py(value));
        else ctx.moveTo(px(i), py(value));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.lineTo(px(values.length - 1), h - 1);
    ctx.lineTo(px(0), h - 1);
    ctx.closePath();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
}

export function renderQsoTrend(rows) {
    $('#qsoPeak').textContent = drawBars('#qsoTrend', perMinute(rows, 60), COLORS.qso);
}

export function renderRateTrend(rows) {
    drawLine('#rateTrend', perHour(rows, 12), COLORS.qso);
}

export function renderSpotTrend(rows) {
    $('#spotPeak').textContent = drawBars('#spotTrend', perMinute(rows, 60), COLORS.myspot);
}

/* 分数曲线：把日志按时间累加成「累计分数」与「累计 QSO」两条曲线，
 * 各自归一到自己的最大值——竞赛大屏看的是势头（曲线凹凸）而不是绝对刻度，
 * 因此末端直接标出真实数值，另画一条从原点到终点的虚线作为均速参照。 */
export function renderScoreCurve(rows) {
    const cv = $('#scoreCurve');
    if (!cv) return;
    const box = canvasBox(cv);
    if (!box) return;
    const {ctx, w, h} = box;
    ctx.clearRect(0, 0, w, h);
    const now = Date.now();
    const log = rows.map(qso => {
        const time = new Date(qso.timestamp).getTime();
        return {time, points: Number(qso.points) || 0};
    }).filter(qso => isFinite(qso.time) && qso.time <= now + 60000)
        .sort((a, b) => a.time - b.time);
    if (log.length < 2) {
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.fillStyle = 'rgba(119,143,176,.5)';
        ctx.textAlign = 'center';
        ctx.fillText('—', w / 2, h / 2);
        return;
    }
    const start = log[0].time;
    const span = Math.max(3600000, now - start);
    const buckets = Math.max(16, Math.min(80, Math.round(span / 300000)));
    const step = span / buckets;
    const scoreLine = [];
    const qsoLine = [];
    let index = 0;
    let score = 0;
    for (let bucket = 1; bucket <= buckets; bucket += 1) {
        const edge = start + bucket * step;
        while (index < log.length && log[index].time <= edge) {
            score += log[index].points;
            index += 1;
        }
        scoreLine.push(score);
        qsoLine.push(index);
    }
    if (index < log.length) {
        scoreLine[buckets - 1] = score + log.slice(index).reduce((total, qso) => total + qso.points, 0);
        qsoLine[buckets - 1] = log.length;
    }
    const maxScore = Math.max(1, scoreLine[buckets - 1]);
    const maxQso = Math.max(1, qsoLine[buckets - 1]);
    const padX = 3;
    const padTop = 7;
    const padBottom = 11;
    const plot = height => padTop + (1 - height) * (h - padTop - padBottom);
    const plotX = position => padX + position / (buckets - 1) * (w - padX * 2);

    ctx.strokeStyle = 'rgba(24,44,72,.9)';
    ctx.lineWidth = 1;
    for (let line = 0; line <= 3; line += 1) {
        const y = Math.round(padTop + line / 3 * (h - padTop - padBottom)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }
    /* 均速虚线：真实曲线跑在它上面就是超前，跑在下面就是落后。 */
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,179,71,.32)';
    ctx.beginPath();
    ctx.moveTo(padX, plot(0));
    ctx.lineTo(w - padX, plot(1));
    ctx.stroke();
    ctx.setLineDash([]);

    const trace = (values, max) => {
        ctx.beginPath();
        values.forEach((value, position) => {
            const x = plotX(position);
            const y = plot(value / max);
            if (position) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
        });
    };
    trace(scoreLine, maxScore);
    ctx.lineTo(w - padX, h - padBottom);
    ctx.lineTo(padX, h - padBottom);
    ctx.closePath();
    const fade = ctx.createLinearGradient(0, padTop, 0, h - padBottom);
    fade.addColorStop(0, 'rgba(255,179,71,.34)');
    fade.addColorStop(1, 'rgba(255,179,71,0)');
    ctx.fillStyle = fade;
    ctx.fill();

    trace(scoreLine, maxScore);
    ctx.strokeStyle = COLORS.score;
    ctx.lineWidth = 2;
    ctx.shadowColor = COLORS.score;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    trace(qsoLine, maxQso);
    ctx.strokeStyle = COLORS.qso;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(119,143,176,.78)';
    ctx.textAlign = 'left';
    ctx.fillText(utcLabel(start, now), padX, h - 2);
    ctx.textAlign = 'center';
    ctx.fillText(utcLabel(start + span / 2, now), w / 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(utcLabel(now, now), w - padX, h - 2);
    [['#scoreNow', scoreLine[buckets - 1], COLORS.score],
        ['#scoreQso', qsoLine[buckets - 1], COLORS.qso]].forEach(([selector, value, color]) => {
        const label = $(selector);
        if (label) {
            label.textContent = value;
            label.style.color = color;
        }
    });
}

/* 时间刻度：跨天竞赛要带上日期，否则大屏上看不出这是哪一天的分数。 */
function utcLabel(time, now) {
    const date = new Date(time);
    const clock = String(date.getUTCHours()).padStart(2, '0') + ':' +
        String(date.getUTCMinutes()).padStart(2, '0');
    const sameDay = new Date(now).getUTCDate() === date.getUTCDate();
    return sameDay ? clock : String(date.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(date.getUTCDate()).padStart(2, '0') + ' ' + clock;
}

function spaceAvailable() {
    return spaceData ? SPACE_METRICS.filter(metric => metric.values(spaceData).length >= 2) : [];
}

function renderSpaceDots(active) {
    const dots = $('#swDots');
    if (!dots) return;
    const key = active.key + '|' + SPACE_METRICS.map(metric =>
        metric.key + (metric.values(spaceData).length >= 2 ? '1' : '0')).join('');
    if (key === spaceDotsKey) return;
    spaceDotsKey = key;
    dots.style.setProperty('--sw-dwell', spaceDwell + 'ms');
    dots.innerHTML = SPACE_METRICS.map(metric => {
        const hasData = metric.values(spaceData).length >= 2;
        const className = metric.key === active.key ? ' class="on"' :
            hasData ? '' : ' class="off"';
        return '<i' + className + ' style="--dot:' + metric.color +
            '" title="' + metric.label + '"></i>';
    }).join('');
}

function paintSpace(animate) {
    const cv = $('#swTrend'), label = $('#swLabel'), now = $('#swNow'), dots = $('#swDots');
    if (!cv || !label || !now || !dots) return;
    const metrics = spaceAvailable();
    if (!metrics.length) {
        label.textContent = t('wall.chart.waiting');
        now.textContent = '—';
        dots.innerHTML = '';
        spaceDotsKey = '';
        drawLine('#swTrend', [], '#e8c547');
        return;
    }
    spaceIndex = Math.min(spaceIndex, metrics.length - 1);
    const metric = metrics[spaceIndex];
    const values = metric.values(spaceData);
    const draw = () => {
        label.textContent = t('wall.chart.subtitle.' + metric.key);
        const latest = values[values.length - 1];
        now.textContent = metric.display ? metric.display(latest) :
            metric.digits ? latest.toFixed(metric.digits) : String(Math.round(latest));
        renderSpaceDots(metric);
        drawLine('#swTrend', values, metric.color, metric);
        cv.classList.remove('switching');
    };
    if (!animate) {
        draw();
        return;
    }
    /* Cross-fade through the canvas opacity only: the canvas box keeps its
     * size, so rotating metrics never reflows the card. */
    cv.classList.add('switching');
    clearTimeout(spaceSwapTimer);
    spaceSwapTimer = setTimeout(draw, 220);
}

function startSpaceCarousel() {
    if (spaceTimer) return;
    spaceTimer = setInterval(() => {
        const metrics = spaceAvailable();
        if (metrics.length < 2) return;
        spaceIndex = (spaceIndex + 1) % metrics.length;
        paintSpace(true);
    }, spaceDwell);
}

/** Change the carousel dwell; the running interval is restarted so a shorter
 *  value takes effect immediately. Invalid values keep the current setting. */
export function setSpaceDwell(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return;
    const next = Math.min(30000, Math.max(3000, Math.round(value)));
    if (next === spaceDwell) return;
    spaceDwell = next;
    spaceDotsKey = '';
    if (spaceTimer) {
        clearInterval(spaceTimer);
        spaceTimer = null;
        startSpaceCarousel();
    }
    const dots = $('#swDots');
    if (dots) dots.style.setProperty('--sw-dwell', spaceDwell + 'ms');
}

export function renderSpaceTrend(data) {
    if (data && Object.keys(data).length) spaceData = data;
    startSpaceCarousel();
    paintSpace(false);
}
