'use strict';

/**
 * P 组：环境档位（纬度带 × 季节 × 太阳活动），产出 BPI 与阈值修正。
 * 全部为纯计算；输入缺失时返回 available=false，由引擎降级。
 */

const solar = require('../solar.js');
const {modip} = require('../irtam.js');
const {ENV_TABLE, BANDS} = require('./config.js');

function num(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (Array.isArray(value)) return num(value[value.length - 1]);
    if (value && typeof value === 'object') {
        return num(value.value !== undefined ? value.value : value.level);
    }
    return null;
}

/** 从 {list:[[ts,value],...]} 取最后一个数值。 */
function lastSeries(node) {
    if (!node) return null;
    if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
            const value = num(node[i]);
            if (value !== null) return value;
        }
        return null;
    }
    if (Array.isArray(node.list)) return lastSeries(node.list);
    if (node.list && typeof node.list === 'object') return lastSeries(Object.values(node.list));
    return num(node);
}

/** Maidenhead 4/6 位 -> {lat, lon}（取格子中心）。 */
function gridToLatLon(grid) {
    const g = String(grid || '').trim().toUpperCase();
    if (!/^[A-R]{2}\d{2}([A-X]{2})?$/.test(g)) return null;
    let lon = (g.charCodeAt(0) - 65) * 20 - 180;
    let lat = (g.charCodeAt(1) - 65) * 10 - 90;
    lon += parseInt(g[2], 10) * 2;
    lat += parseInt(g[3], 10) * 1;
    if (g.length >= 6) {
        lon += (g.charCodeAt(4) - 65) * (2 / 24) + (1 / 24);
        lat += (g.charCodeAt(5) - 65) * (1 / 24) + (1 / 48);
    } else {
        lon += 1;
        lat += 0.5;
    }
    return {lat, lon};
}

function sfiTier(sfi) {
    const value = num(sfi);
    if (value === null) return 'unknown';
    if (value < 100) return 'low';
    if (value <= 150) return 'mid';
    return 'high';
}

function protonLevel(flux) {
    const value = num(flux);
    if (value === null) return null;
    if (value >= 1e5) return 5;
    if (value >= 1e4) return 4;
    if (value >= 1e3) return 3;
    if (value >= 100) return 2;
    if (value >= 10) return 1;
    return 0;
}

function xrayLevel(flux) {
    const value = num(flux);
    if (value === null) return null;
    if (value >= 2e-3) return 5;
    if (value >= 1e-3) return 4;
    if (value >= 1e-4) return 3;
    if (value >= 5e-5) return 2;
    if (value >= 1e-5) return 1;
    return 0;
}

function latBandOf(cgmLat) {
    if (!Number.isFinite(cgmLat)) return 'unknown';
    if (cgmLat >= 58) return 'polar';
    if (cgmLat < 30) return 'low';
    return 'mid';
}

/** BPI(band)：4.4 先验表 + 4.4 修正项，钳制 0–5。 */
function buildBpi(env) {
    const table = ENV_TABLE[`${env.latBand}|${env.season}|${env.sfiTier}`] ||
        ENV_TABLE[`mid|${env.season}|mid`];
    const out = {};
    for (const band of BANDS) {
        let score = table[band];
        if (score === undefined) continue;
        if (env.kp !== null && env.kp >= 5 && env.cgmLat >= 55) {
            if (band === '10' || band === '15') score -= 2;
            if (band === '40' || band === '80') score += 1;
        }
        if (env.sLevel !== null && env.sLevel >= 1 && (band === '10' || band === '15')) score -= 1;
        if (env.latBand === 'low' && env.season === 'summer' && (band === '160' || band === '80')) score -= 1;
        if (env.latBand === 'polar' && env.season === 'summer') {
            if (band === '160') score = 0;
            if (band === '80') score = Math.min(score, 1);
        }
        if (env.sfiTier === 'low') {
            if (band === '10') score = Math.min(score, 1);
            if (band === '40' || band === '80') score += 1;
        }
        if (env.sfiTier === 'high') {
            if (band === '160' || band === '80') score -= 1;
            if (band === '10' || band === '15') score += 1;
        }
        out[band] = Math.max(0, Math.min(5, score));
    }
    return out;
}

/** 4.5 的 R_stay 修正系数（只做乘性系数，绝对值表在 rules 里）。 */
function stayFactor(env, band) {
    let factor = 1;
    if (env.latBand === 'low' && (band === '160' || band === '80')) factor *= 0.6;
    if (env.season === 'summer' && (band === '160' || band === '80')) factor *= 0.8;
    if (env.sfiTier === 'high' && (band === '160' || band === '80')) factor *= 0.9;
    if (env.latBand === 'polar' && env.season === 'winter' && (band === '160' || band === '80')) factor *= 0.8;
    return factor;
}

/**
 * @param {object} settings
 * @param {object} prop  propagation snapshot（global.get('propData')）
 * @param {Date}   now
 */
function build(settings, prop, now) {
    const date = now instanceof Date ? now : new Date(now || Date.now());
    const grid = settings && settings.grid;
    const pos = gridToLatLon(grid);
    const year = date.getUTCFullYear();
    const cgmLat = pos ? modip(pos.lat, pos.lon, year) : null;

    const scales = (prop && prop.scales) || {};
    const sfi = lastSeries(prop && prop.sfi);
    const ssn = lastSeries(prop && prop.ssn);
    const kp = lastSeries(prop && prop.kp);
    const ap = lastSeries(prop && prop.a);
    const protonFlux = lastSeries(prop && prop.proton);
    const xrayFlux = lastSeries(prop && prop.xray);

    const sLevel = num(scales.s) !== null ? num(scales.s) : protonLevel(protonFlux);
    const rLevel = num(scales.r) !== null ? num(scales.r) : xrayLevel(xrayFlux);

    const env = {
        available: !!pos,
        at: date.toISOString(),
        grid: grid || '',
        lat: pos ? Number(pos.lat.toFixed(3)) : null,
        lon: pos ? Number(pos.lon.toFixed(3)) : null,
        cgmLat: Number.isFinite(cgmLat) ? Number(cgmLat.toFixed(1)) : null,
        latBand: latBandOf(cgmLat),
        season: pos ? solar.season(date, pos.lat) : 'equinox',
        sfi: sfi === null ? null : Number(sfi.toFixed(1)),
        ssn: ssn === null ? null : Number(ssn.toFixed(1)),
        sfiTier: sfiTier(sfi),
        kp: kp === null ? null : Number(kp.toFixed(2)),
        ap: ap === null ? null : Number(ap),
        sLevel,
        rLevel,
        solarElev: pos ? Number(solar.solarElevation(pos.lat, pos.lon, date).toFixed(2)) : null,
        localSolarHour: pos ? Number(solar.localSolarHour(pos.lon, date).toFixed(2)) : null,
        bpi: {},
        missing: []
    };
    if (!env.available) env.missing.push('grid');
    if (env.kp === null) env.missing.push('kp');
    if (env.sfi === null) env.missing.push('sfi');
    if (env.sLevel === null) env.missing.push('sLevel');
    if (env.rLevel === null) env.missing.push('rLevel');
    env.bpi = buildBpi(env);
    // 极昼/极夜：h_max = 90 - |lat - δ|, h_min = |lat + δ| - 90
    if (pos) {
        const decl = solar.solarParams(date).declination;
        env.solarDeclination = Number(decl.toFixed(2));
        env.maxElevation = Number((90 - Math.abs(pos.lat - decl)).toFixed(2));
        env.minElevation = Number((Math.abs(pos.lat + decl) - 90).toFixed(2));
    } else {
        env.solarDeclination = null;
        env.maxElevation = null;
        env.minElevation = null;
    }
    return env;
}

module.exports = {
    build,
    gridToLatLon,
    num,
    lastSeries,
    sfiTier,
    protonLevel,
    xrayLevel,
    latBandOf,
    buildBpi,
    stayFactor
};
