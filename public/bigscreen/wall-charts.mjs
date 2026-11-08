/* Wall-only canvas charts. Input rows come from shared repositories; this
 * module owns binning and drawing only, never transport or business lookups. */

const $ = selector => document.querySelector(selector);
const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0'};

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

export function drawLine(selector, values, color) {
    const cv = $(selector);
    if (!cv || values.length < 2) return;
    const {ctx, w, h} = canvasBox(cv);
    ctx.clearRect(0, 0, w, h);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const px = i => 1 + (i / (values.length - 1)) * (w - 2);
    const py = value => h - 3 - ((value - lo) / span) * (h - 7);
    ctx.beginPath();
    values.forEach((value, i) => {
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

export function renderSpaceTrend(data) {
    const list = data && data.sfi && data.sfi.list || [];
    const vals = list.map(row => row[1])
        .filter(value => value !== null && isFinite(value)).map(Number).slice(-30);
    $('#sfiNow').textContent = vals.length ? Math.round(vals[vals.length - 1]) : '—';
    drawLine('#swTrend', vals, '#e8c547');
}
