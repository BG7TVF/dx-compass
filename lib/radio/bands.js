'use strict';

const BANDS = [
    [1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'],
    [7000, 7300, '40m'], [10100, 10150, '30m'], [14000, 14350, '20m'],
    [18068, 18168, '17m'], [21000, 21450, '15m'], [24890, 24990, '12m'],
    [28000, 29700, '10m'], [50000, 54000, '6m'], [144000, 148000, '2m'],
    [420000, 450000, '70cm']
];

/* 频率 → 波段名（kHz，半开区间按现有频段表；表外返回 null）。 */
function bandOf(f) {
    if (isNaN(f)) return null;
    for (const b of BANDS) {
        if (f >= b[0] && f <= b[1]) return b[2];
    }
    return null;
}

/* 标准米波名，用于识别「20」「40」这类纯数字写法。 */
const METER_BANDS = [160, 80, 60, 40, 30, 20, 17, 15, 12, 10, 6, 4, 2];

/* N1MM 的 band 字段是兆赫数值（20m 报 14、15m 报 21），不是米波。
 * 这些整数兆赫值在业余波段内，必须先按 MHz 解释；不能先当成米波，
 * 否则 21 会被认成「21 米」而不是 15 米波。 */
const MHZ_BANDS = [7, 10, 14, 18, 21, 24, 28, 50, 70, 144];

/* 宽松的 MHz → 米波映射：只用于归一化入参，不用于精确频段判定。 */
const MHZ_RANGES = [
    [0, 2, '160m'], [2, 4.6, '80m'], [4.6, 6.5, '60m'], [6.5, 8.6, '40m'],
    [8.6, 11.6, '30m'], [11.6, 16, '20m'], [16, 19.6, '17m'], [19.6, 22.6, '15m'],
    [22.6, 26.6, '12m'], [26.6, 30, '10m'], [30, 54, '6m'], [54, 76, '4m'],
    [76, 148, '2m'], [148, 470, '70cm']
];

function metersFromMhz(mhz) {
    if (!Number.isFinite(mhz) || mhz <= 0) return '';
    for (const [low, high, name] of MHZ_RANGES) {
        if (mhz >= low && mhz < high) return name;
    }
    return '';
}

/**
 * 把各种来源的波段写法统一成「米波」小写名：
 *   - 带单位：'15m' / '15M' / '15 米' → '15m'；'70cm' → '70cm'
 *   - N1MM 数字：'14' → '20m'，'21' → '15m'，'3.5' → '80m'
 *   - 纯数字米波：'20'（非业余 MHz）→ '20m'，'40' → '40m'
 * 无法识别时返回小写原文，绝不静默丢值。
 */
function normalizeBand(value) {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    if (!text) return '';
    const lower = text.toLowerCase();

    const cm = /^(\d+(?:\.\d+)?)\s*(?:cm|厘米)$/.exec(lower);
    if (cm) return `${parseFloat(cm[1])}cm`;

    const meter = /^(\d+(?:\.\d+)?)\s*(?:m|米|meter|meters)$/.exec(lower);
    if (meter) return `${parseFloat(meter[1])}m`;

    const numeric = /^(\d+(?:\.\d+)?)$/.exec(lower);
    if (numeric) {
        const number = parseFloat(numeric[1]);
        if (!Number.isFinite(number) || number <= 0) return lower;
        // 小数（1.8 / 3.5 / 5.3 / 10.1）只可能是 MHz。
        if (numeric[1].includes('.')) return metersFromMhz(number) || lower;
        // 明确落在业余 MHz 上的整数按兆赫解释，其余按米波名解释。
        if (number > 160 || MHZ_BANDS.includes(number)) return metersFromMhz(number) || lower;
        if (METER_BANDS.includes(number)) return `${number}m`;
        return lower;
    }
    return lower;
}

/**
 * 建议引擎内部只认数字米波（'160'、'20'、'15'）。
 * 与 normalizeBand 共用同一套判别，避免 QSO 行和波段活跃度行各用一套命名。
 */
function bandMeters(value) {
    const band = normalizeBand(value);
    const meter = /^(\d+(?:\.\d+)?)m$/.exec(band);
    if (meter) return meter[1];
    const cm = /^(\d+(?:\.\d+)?)cm$/.exec(band);
    if (cm) return `${cm[1]}cm`;
    return band;
}

module.exports = {BANDS, bandOf, normalizeBand, bandMeters, metersFromMhz};
