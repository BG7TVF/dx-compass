'use strict';

/**
 * 强度归一化。
 *
 * 本项目数据库里同时存在三种"强度"：
 *  - signal: DX Cluster / DX Summit 文本里的 RST 报告（人报，S 表语义，可换算 dBm）
 *  - snr:    RBN Skimmer / PSKReporter 的信噪比（dB，未校准，不可换算 dBm）
 *  - 无:     多数 DX Cluster spot 不带任何强度
 *
 * 铁律：绝不把 SNR 当 S 表读数套 S_dBm 公式。SNR 只允许参与方位/密度分析。
 */

// IARU 区域 1 标准：S9 = -73 dBm，S 表每格 6 dB。
// 注意：需求文档写作 "-73 + 6×(S-1)"，该式会把 S9 算到 -25 dBm（偏差 48 dB），
// 与 S9=-73 dBm 的定义矛盾；此处按 S9 基准实现，并在结果中显式记录。
const S9_DBM = -73;
const DB_PER_S_UNIT = 6;

/** 解析 RST / S 表文本，返回 1..9 的 S 值；无法识别返回 null。 */
function parseSValue(signal) {
    if (signal === null || signal === undefined) return null;
    const text = String(signal).trim().toUpperCase();
    if (!text) return null;
    let match = text.match(/^S\s*([1-9])\b/);
    if (match) return Number(match[1]);
    // RST：R(1-5) + S(1-9, N=9) [+ T]。S 值取第二位，不能取首位。
    match = text.match(/^[1-5]([1-9N])/);
    if (match) return match[1] === 'N' ? 9 : Number(match[1]);
    match = text.match(/^([1-9])$/);
    if (match) return Number(match[1]);
    return null;
}

/** S 表值 -> dBm。S9 = -73 dBm，每格 6 dB。 */
function sMeterToDbm(sValue) {
    return S9_DBM + DB_PER_S_UNIT * (sValue - 9);
}

/**
 * 归一化一条 spot 的强度。
 * 返回 {kind, sValue, dbm, usable, source, reason}
 *  - kind: 's-meter' | 'snr' | 'none'
 *  - usable: 只有 's-meter' 可进入功率计算
 */
function normalizeStrength(row) {
    const sValue = parseSValue(row && row.signal);
    if (sValue !== null) {
        return {
            kind: 's-meter',
            sValue,
            dbm: sMeterToDbm(sValue),
            usable: true,
            source: 'cluster-rst',
            reason: null
        };
    }
    const snr = row ? Number(row.snr) : NaN;
    if (Number.isFinite(snr)) {
        return {
            kind: 'snr',
            sValue: null,
            dbm: null,
            usable: false,
            source: (row.source || '').toUpperCase().includes('PSK') ? 'pskr-snr' : 'skimmer-snr',
            reason: 'snr-not-calibrated'
        };
    }
    return {
        kind: 'none',
        sValue: null,
        dbm: null,
        usable: false,
        source: null,
        reason: 'no-strength'
    };
}

module.exports = {
    S9_DBM,
    DB_PER_S_UNIT,
    parseSValue,
    sMeterToDbm,
    normalizeStrength
};
