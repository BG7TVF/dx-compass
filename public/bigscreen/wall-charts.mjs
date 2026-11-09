/* Wall-only canvas charts. Input rows come from shared repositories; this
 * module owns binning and drawing only, never transport or business lookups. */

const $ = selector => document.querySelector(selector);
const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0'};

/* Space-weather carousel: one canvas cycles through the same series the
 * readout table shows. Dwell time is mirrored into CSS through --sw-dwell so
 * the progress tick under the header always matches the JS timer. */
const SPACE_DWELL = 8000;
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
    {key: 'sfi', label: 'SFI', span: '30 日趋势', color: '#e8c547', digits: 0,
        values: data => spaceColumn(data.sfi && data.sfi.list, 1)},
    {key: 'ssn', label: 'SSN', span: '24 月趋势', color: '#f0a35e', digits: 0,
        values: data => spaceColumn(data.ssn && data.ssn.list, 1)},
    {key: 'kp', label: 'KP', span: '近 5 日趋势', color: '#f1c40f', digits: 1,
        values: data => spaceColumn(data.kp && data.kp.list, 1)},
    {key: 'dst', label: 'DST', span: '近 3 日趋势', color: '#e4572e', digits: 0,
        values: data => spaceColumn(data.dst && data.dst.list, 1)},
    {key: 'bz', label: 'BZ', span: '近 2 小时趋势', color: '#4cc9f0', digits: 1,
        values: data => spaceColumn(data.mag && data.mag.list, 2)},
    {key: 'bt', label: 'BT', span: '近 2 小时趋势', color: '#8f7fff', digits: 1,
        values: data => spaceColumn(data.mag && data.mag.list, 1)},
    {key: 'wind', label: 'WIND', span: '近 2 小时趋势', color: '#35d6a4', digits: 0,
        values: data => spaceColumn(data.wind && data.wind.list, 1)},
    {key: 'xray', label: 'XRAY', span: '近 24 小时趋势', color: '#ff9f43', log: true,
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
    dots.style.setProperty('--sw-dwell', SPACE_DWELL + 'ms');
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
        label.textContent = '趋势等待数据';
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
        label.textContent = metric.label + ' ' + metric.span;
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
    }, SPACE_DWELL);
}

export function renderSpaceTrend(data) {
    if (data && Object.keys(data).length) spaceData = data;
    startSpaceCarousel();
    paintSpace(false);
}
