'use strict';

/**
 * 太阳几何（纯函数，无外部依赖）。
 *
 * 用途：灰线窗口、日照/夜侧判定、季节档位。公式为 NOAA Solar Calculator
 * 的常用近似（赤纬与均时差误差 < 0.5°），足够竞赛规则使用。
 * 地磁纬（CGM）不在本文件：复用 lib/irtam.js 的 modip()。
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function asDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value > 1e12 ? value : value * 1000);
    }
    const ms = Date.parse(String(value || ''));
    return Number.isFinite(ms) ? new Date(ms) : new Date(0);
}

function dayOfYear(date) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    return Math.floor((date.getTime() - start) / 86400000);
}

function utcHours(date) {
    return date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
}

/** 归一化到 [-180, 180)。 */
function wrapLon(lon) {
    let value = ((Number(lon) + 180) % 360 + 360) % 360 - 180;
    if (value === -180) value = 180;
    return value;
}

function solarParams(value) {
    const date = asDate(value);
    const n = dayOfYear(date) + (utcHours(date) - 12) / 24;
    const gamma = 2 * Math.PI * n / 365;

    const declination = (
        0.006918 -
        0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) -
        0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) -
        0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)
    ) * DEG;

    const eotMinutes = 229.18 * (
        0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) -
        0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)
    );

    const subsolarLon = wrapLon(-15 * (utcHours(date) + eotMinutes / 60 - 12));
    return {
        declination,
        eotMinutes,
        subsolarLat: declination,
        subsolarLon,
        dayOfYear: dayOfYear(date)
    };
}

/** 太阳高度角（度，地平线上为正）。 */
function solarElevation(lat, lon, value) {
    const p = solarParams(value);
    const phi = Number(lat) * RAD;
    const decl = p.declination * RAD;
    const hourAngle = (15 * (utcHours(asDate(value)) + Number(lon) / 15 + p.eotMinutes / 60 - 12)) * RAD;
    const sinElev = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle);
    return Math.asin(Math.max(-1, Math.min(1, sinElev))) * DEG;
}

/** 本台地方太阳时（0–24 小时）。 */
function localSolarHour(lon, value) {
    const p = solarParams(value);
    const hours = utcHours(asDate(value)) + Number(lon) / 15 + p.eotMinutes / 60;
    return ((hours % 24) + 24) % 24;
}

/**
 * 灰线窗口：路径两端都处于晨昏带内。
 * 报告采用 [-12°, +3°]；调用方可覆盖。
 */
function grayline(latA, lonA, latB, lonB, value, options) {
    const opts = options || {};
    const low = Number.isFinite(opts.low) ? opts.low : -12;
    const high = Number.isFinite(opts.high) ? opts.high : 3;
    const elevA = solarElevation(latA, lonA, value);
    const elevB = solarElevation(latB, lonB, value);
    return {
        ok: elevA >= low && elevA <= high && elevB >= low && elevB <= high,
        elevA,
        elevB,
        low,
        high
    };
}

/**
 * 季节档：以赤纬绝对值与符号划分，供“春秋分 / 夏至 / 冬至”门控使用。
 * 北半球：赤纬 > +15° 夏季，< -15° 冬季；南半球相反。
 */
function season(value, lat) {
    const decl = solarParams(value).declination;
    const abs = Math.abs(decl);
    if (abs < 12) return 'equinox';
    const northern = decl > 0;
    const summer = northern === (Number(lat) >= 0);
    return summer ? 'summer' : 'winter';
}

/** 是否处于当地夜间（太阳高度 < -6°，民用暮光以下）。 */
function isNight(lat, lon, value) {
    return solarElevation(lat, lon, value) < -6;
}

module.exports = {
    asDate,
    dayOfYear,
    solarParams,
    solarElevation,
    localSolarHour,
    grayline,
    season,
    isNight,
    wrapLon
};
