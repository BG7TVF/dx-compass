'use strict';

/**
 * 中位路径损耗模型（最小实现）。
 *
 * 缺口说明：lib/propagation/model.js 提供的是 MUF/频段条件/可用度评分，
 * 没有绝对 dB 路径损耗输出，无法直接复用。此处只补一个"中位数"量级的
 * HF 路径损耗：自由空间 + 随距离缓慢增长的经验余量（含地波/多跳/吸收的
 * 中位效果），不做逐时/逐路径精细预测。
 *
 * 该模型的系统误差由 estimate.js 里固定的 σ_model = 5 dB 覆盖。
 */

const FSPL_CONST = 32.45; // dB，f 用 MHz、d 用 km

function fsplDb(freqMhz, distanceKm) {
    const f = Number(freqMhz);
    const d = Number(distanceKm);
    if (!Number.isFinite(f) || !Number.isFinite(d) || f <= 0 || d <= 0) return null;
    return FSPL_CONST + 20 * Math.log10(f) + 20 * Math.log10(d);
}

/**
 * HF 中位路径损耗：FSPL + 10 dB 基础余量 + 0.003 dB/km（上限 40 dB 余量）。
 * 3000 km @ 14 MHz ≈ 125 + 19 = 144 dB。
 */
function medianPathLossDb(freqMhz, distanceKm) {
    const fspl = fsplDb(freqMhz, distanceKm);
    if (fspl === null) return null;
    const excess = Math.min(40, 10 + 0.003 * Number(distanceKm));
    return fspl + excess;
}

module.exports = {
    FSPL_CONST,
    fsplDb,
    medianPathLossDb
};
