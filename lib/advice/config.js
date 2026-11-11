'use strict';

/**
 * 规则引擎阈值与默认值。
 *
 * 依据 docs/contesting-tactics-research.md：所有 D 级数字都是“默认值 + 校准位”，
 * 必须可通过 settings.adviceConfig(JSON) 覆盖。A 级内容（规则条款、公式、NOAA 标度）
 * 不是阈值，不应出现在这里。
 */

const BANDS = ['160', '80', '60', '40', '30', '20', '17', '15', '12', '10', '6', '2'];

const DEFAULTS = {
    // 1.3 跑台去留（QSO/hr）
    stayRate: {
        'CW|HP': 45, 'CW|LP': 30, 'CW|QRP': 12, 'CW|UNKNOWN': 38,
        'SSB|HP': 35, 'SSB|LP': 22, 'SSB|QRP': 10, 'SSB|UNKNOWN': 28,
        'MS': 60
    },
    stayConfirmBuckets: 2,
    // 2.2 S&P 基准（QSO/hr）
    spRate: {CW: 40, SSB: 30, CW_noSpot: 25, SSB_noSpot: 20},
    spTriggerRatio: 0.7,
    runKeepRatio: 0.8,
    altBandRatio: 1.3,
    // 3.3 换波段门槛
    multGapSpots: 2,
    multGap30min: 3,
    tau: {SO1R: 2.0, SO2R: 0.5, MS: 0.3, M2: 0.3, MM: 0.3},
    deltaIn: {SO1R: 20, SO2R: 10, MS: 10, M2: 10, MM: 10},
    deltaOut: 15,
    newBandDiscountMin: 10,
    // 1.3 现场信号
    idleCqWarn: 5,
    idleCqAction: 8,
    dupeRatio: 0.25,
    qsyConflict: 3,
    // 1.4 / B12
    endgameNoChangeMin: 30,
    endgameFreezeExploreMin: 90,
    // 4.1 纬度门控
    polarCgm: 58,
    highLatCgm: 55,
    lowLatCgm: 30,
    kpStorm: 5,
    rLevelPause: 2,
    sLevelPolarBlock: 3,
    // 5.1 配额
    quota: {MS: 10, M2: 8, M2_ARRL: 6},
    quotaReserve: 1,
    // 生效率
    minBucketsForRate: 2,
    bucketMinutes: 10,
    // P3：缺这些输入时，对应规则组降级而不是消失
    degradeConfidence: 'low'
};

const ENV_TABLE = {
    // 4.4 波段优先级先验（D 级）
    'mid|winter|low': {160: 3, 80: 4, 40: 5, 20: 5, 15: 4, 10: 2},
    'mid|winter|mid': {160: 3, 80: 4, 40: 5, 20: 5, 15: 4, 10: 2},
    'mid|winter|high': {160: 2, 80: 3, 40: 4, 20: 5, 15: 5, 10: 4},
    'mid|summer|low': {160: 1, 80: 2, 40: 4, 20: 5, 15: 4, 10: 3},
    'mid|summer|mid': {160: 1, 80: 2, 40: 4, 20: 5, 15: 4, 10: 3},
    'mid|summer|high': {160: 0, 80: 1, 40: 3, 20: 5, 15: 5, 10: 5},
    'mid|equinox|low': {160: 3, 80: 4, 40: 5, 20: 5, 15: 5, 10: 4},
    'mid|equinox|mid': {160: 3, 80: 4, 40: 5, 20: 5, 15: 5, 10: 4},
    'mid|equinox|high': {160: 3, 80: 4, 40: 5, 20: 5, 15: 5, 10: 4},
    'polar|winter|low': {160: 3, 80: 4, 40: 4, 20: 4, 15: 3, 10: 2},
    'polar|winter|mid': {160: 3, 80: 4, 40: 4, 20: 4, 15: 3, 10: 2},
    'polar|winter|high': {160: 3, 80: 4, 40: 4, 20: 4, 15: 3, 10: 2},
    'polar|summer|low': {160: 0, 80: 1, 40: 3, 20: 5, 15: 4, 10: 4},
    'polar|summer|mid': {160: 0, 80: 1, 40: 3, 20: 5, 15: 4, 10: 4},
    'polar|summer|high': {160: 0, 80: 1, 40: 3, 20: 5, 15: 4, 10: 4},
    'low|winter|low': {160: 1, 80: 2, 40: 5, 20: 5, 15: 4, 10: 3},
    'low|winter|mid': {160: 1, 80: 2, 40: 5, 20: 5, 15: 4, 10: 3},
    'low|winter|high': {160: 1, 80: 2, 40: 5, 20: 5, 15: 4, 10: 3},
    'low|summer|low': {160: 0, 80: 1, 40: 4, 20: 5, 15: 4, 10: 4},
    'low|summer|mid': {160: 0, 80: 1, 40: 4, 20: 5, 15: 4, 10: 4},
    'low|summer|high': {160: 0, 80: 1, 40: 4, 20: 5, 15: 4, 10: 4},
    'low|equinox|low': {160: 2, 80: 3, 40: 5, 20: 5, 15: 4, 10: 3},
    'low|equinox|mid': {160: 2, 80: 3, 40: 5, 20: 5, 15: 4, 10: 3},
    'low|equinox|high': {160: 2, 80: 3, 40: 5, 20: 5, 15: 4, 10: 3}
};

/** 安全解析 settings.adviceConfig；任何异常都回退默认值。 */
function parseOverrides(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(String(raw));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

function mergeDeep(base, patch) {
    const out = Array.isArray(base) ? base.slice() : {...base};
    for (const [key, value] of Object.entries(patch || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) &&
            out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
            out[key] = mergeDeep(out[key], value);
        } else if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

function thresholds(settings) {
    return mergeDeep(DEFAULTS, parseOverrides(settings && settings.adviceConfig));
}

module.exports = {BANDS, DEFAULTS, ENV_TABLE, thresholds, parseOverrides, mergeDeep};
