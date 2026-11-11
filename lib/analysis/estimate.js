'use strict';

const {propBearing, propDistance} = require('../propagation/model.js');
const {normalizeStrength} = require('./strength.js');

/**
 * 天线类型与主朝向研判。
 *
 * 本模块只回答两个问题：目标台用的是定向 / 偶极 / 全向中的哪一类，
 * 以及（定向或偶极时）主朝向落在哪个方位。它不推断发射功率、EIRP
 * 或绝对场强，也不做任何路径损耗反算。
 *
 * 约定：
 *  1. 方位密度与扇区分布是主证据；强度只允许做「同一报告站内不同方位
 *     之间的相对差」这一项辅助证据，且序列号（SNR）类数据不参与。
 *  2. 样本不足时输出 unknown，而不是给出弱结论。
 *  3. 置信度就是三分类概率中的最高项，不额外包装。
 */

const GROUP_SECONDS = 7200;          // 2 小时分组，只用于样本量追溯
const MIN_ANTENNA_POINTS = 6;        // 三分类所需的最少方位点
const MIN_RELATIVE_POINTS = 3;       // 单站相对电平证据的最少点数
const MIN_RELATIVE_RECEIVERS = 2;    // 至少两个站才给相对电平结论
const RELATIVE_LOBE_DEG = 45;        // 主瓣内
const RELATIVE_OUTSIDE_DEG = 75;     // 主瓣外
const MAX_WINDOW_HOURS = 168;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function median(values) {
    const arr = values.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function mad(values) {
    const med = median(values);
    if (med === null) return null;
    return median(values.filter(Number.isFinite).map(v => Math.abs(v - med)));
}

/** 1.4826×MAD 的稳健离散度；不随样本量收缩。 */
function robustSigma(values) {
    const m = mad(values);
    return m === null ? null : 1.4826 * m;
}

function angularDiff(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.abs(((a - b + 540) % 360) - 180);
}

function circularMedian(values) {
    const arr = values.filter(Number.isFinite);
    if (!arr.length) return null;
    let best = 0;
    let bestCost = Infinity;
    for (let deg = 0; deg < 360; deg += 1) {
        let cost = 0;
        for (const value of arr) cost += angularDiff(deg, value);
        if (cost < bestCost) {
            bestCost = cost;
            best = deg;
        }
    }
    return best;
}

function toEpoch(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : value;
    const text = String(value).trim();
    if (!text) return null;
    const iso = /Z$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function positionOf(row, latKey, lonKey) {
    const lat = numberOrNull(row[latKey]);
    const lon = numberOrNull(row[lonKey]);
    if (lat === null || lon === null) return null;
    return {lat, lon};
}

/** 方位分布统计：12 个 30° 扇区 + 滑动 90° 主窗。 */
function sectorStats(bearings) {
    const bins = new Array(12).fill(0);
    for (const bearing of bearings) {
        const normalized = ((bearing % 360) + 360) % 360;
        bins[Math.min(11, Math.floor(normalized / 30))] += 1;
    }
    const n = bearings.length;
    let start = 0;
    let best = -1;
    for (let i = 0; i < 12; i += 1) {
        const count = bins[i] + bins[(i + 1) % 12] + bins[(i + 2) % 12];
        if (count > best) {
            best = count;
            start = i;
        }
    }
    const back = bins[(start + 6) % 12] + bins[(start + 7) % 12] + bins[(start + 8) % 12];
    const lobeA = bins[start] + bins[(start + 1) % 12] + bins[(start + 11) % 12];
    const lobeB = bins[(start + 6) % 12] + bins[(start + 5) % 12] + bins[(start + 7) % 12];
    const side = bins[(start + 3) % 12] + bins[(start + 9) % 12];
    return {
        bins,
        n,
        start,
        centerDeg: start * 30 + 45,
        main: best,
        back,
        lobeA,
        lobeB,
        side,
        share: n ? best / n : 0,
        backShare: n ? back / n : 0,
        sideShare: n ? side / n : 0
    };
}

function classifyAntenna(points) {
    const bearings = points.map(p => p.bearing).filter(Number.isFinite);
    const distances = points.map(p => p.distanceKm).filter(Number.isFinite);
    const n = bearings.length;
    const result = {
        ok: n >= MIN_ANTENNA_POINTS,
        type: 'unknown',
        probabilities: null,
        azimuthDeg: null,
        mainSectorDeg: null,
        points: n,
        medianDistanceKm: median(distances),
        evidence: null,
        notes: []
    };
    if (!n) {
        result.notes.push('no-bearing');
        return result;
    }
    const stats = sectorStats(bearings);
    const medianDistance = result.medianDistanceKm;
    const distanceFactor = medianDistance === null ? 0.3
        : medianDistance <= 2000 ? 1
            : medianDistance <= 4000 ? 0.5 : 0.15;

    const dirScore = clamp((stats.share - 0.4) / 0.45, 0, 1) * (1 - 0.5 * clamp(stats.backShare, 0, 1));
    const omniScore = clamp(1 - Math.abs(stats.share - 0.25) / 0.3, 0, 1)
        * clamp(1 - Math.abs(stats.backShare - 0.25) / 0.3, 0, 1)
        * clamp(1 - Math.abs(stats.sideShare - 0.17) / 0.35, 0, 1);
    const balance = (stats.lobeA + stats.lobeB) > 0
        ? Math.min(stats.lobeA, stats.lobeB) / Math.max(1, (stats.lobeA + stats.lobeB) / 2)
        : 0;
    const dipoleScore = balance * (1 - clamp(stats.sideShare / 0.4, 0, 1)) * distanceFactor;

    const raw = {directional: dirScore, dipole: dipoleScore, omni: omniScore};
    const sum = raw.directional + raw.dipole + raw.omni + 1e-9;
    const probabilities = {
        directional: raw.directional / sum,
        dipole: raw.dipole / sum,
        omni: raw.omni / sum
    };
    const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    result.probabilities = probabilities;
    result.mainSectorDeg = stats.centerDeg;
    result.evidence = {
        sectors: stats.bins.map((count, index) => ({
            fromDeg: index * 30,
            toDeg: index * 30 + 30,
            count,
            share: n ? count / n : 0
        })),
        mainWindowDeg: [stats.start * 30, stats.start * 30 + 90],
        mainShare: stats.share,
        backShare: stats.backShare,
        sideShare: stats.sideShare,
        lobeShareA: stats.lobeA / n,
        lobeShareB: stats.lobeB / n,
        distanceFactor,
        medianDistanceKm: medianDistance
    };

    if (!result.ok) {
        result.type = 'unknown';
        result.notes.push('insufficient-points');
        return result;
    }
    if (top[1] < 0.45) {
        result.type = 'unknown';
        result.notes.push('low-confidence');
        return result;
    }
    result.type = top[0];
    if (top[0] === 'directional') {
        const inLobe = bearings.filter(b => angularDiff(b, stats.centerDeg) <= 45);
        result.azimuthDeg = circularMedian(inLobe);
    } else if (top[0] === 'dipole') {
        const primary = stats.lobeA >= stats.lobeB ? stats.centerDeg : (stats.centerDeg + 180) % 360;
        const inLobe = bearings.filter(b => angularDiff(b, primary) <= 45);
        result.azimuthDeg = circularMedian(inLobe);
        if (medianDistance !== null && medianDistance > 2000) {
            result.notes.push('dipole-distance-limited');
        }
    }
    return result;
}

/* Per-band wavelength for ordering: "160m" -> 160. Unknown bands sink last. */
function bandWeight(band) {
    const match = /(\d+(?:\.\d+)?)\s*m/i.exec(String(band || ''));
    return match ? Number(match[1]) : -1;
}

function freqKhzOf(value) {
    const freq = numberOrNull(value);
    if (freq === null || freq <= 0) return null;
    /* Spot tables store kHz; tolerate MHz input from ad-hoc imports. */
    return freq >= 1000 ? Math.round(freq) : Math.round(freq * 1000);
}

/**
 * Per-band antenna picture for one opponent: the same classifyAntenna pipeline
 * run on each band's positioned spots, plus the latest frequency seen there.
 * Ordered longest wavelength first so 160m/80m lead the card.
 */
function analyzeBands(observations) {
    const groups = new Map();
    for (const point of observations) {
        const band = point.band ? String(point.band) : null;
        if (!band) continue;
        if (!groups.has(band)) groups.set(band, []);
        groups.get(band).push(point);
    }
    const bands = [];
    for (const [band, list] of groups) {
        const positioned = list.filter(point =>
            Number.isFinite(point.bearing) && Number.isFinite(point.distanceKm));
        const antenna = classifyAntenna(positioned);
        let latest = null;
        for (const point of list) {
            if (latest === null || (point.epoch || 0) >= (latest.epoch || 0)) latest = point;
        }
        bands.push({
            band,
            freqKhz: latest ? freqKhzOf(latest.row && latest.row.freq) : null,
            samples: list.length,
            positioned: positioned.length,
            antenna: {
                ok: antenna.ok,
                type: antenna.type,
                probabilities: antenna.probabilities,
                azimuthDeg: antenna.azimuthDeg,
                points: antenna.points,
                confidence: antenna.probabilities
                    ? antenna.probabilities[antenna.type] ?? 0
                    : 0,
                notes: antenna.notes
            }
        });
    }
    return bands.sort((a, b) => bandWeight(b.band) - bandWeight(a.band) ||
        a.band.localeCompare(b.band));
}

function buildObservations(rows, target) {
    const observations = [];
    const targetVariants = callVariants(target);
    const excluded = {
        noSpotterPosition: 0,
        noFrequency: 0,
        invalidDistance: 0,
        otherCall: 0
    };
    const sources = {rst: 0, snrOnly: 0, none: 0};
    for (const row of rows) {
        const spotterPos = positionOf(row, 'lat', 'lon');
        const targetPos = positionOf(row, 'dx_lat', 'dx_lon');
        const strength = normalizeStrength(row);
        const epoch = toEpoch(row.timestamp || row.time);
        const distanceKm = spotterPos && targetPos ? propDistance(targetPos, spotterPos) : numberOrNull(row.distance_km);
        const bearing = spotterPos && targetPos ? propBearing(targetPos, spotterPos) : null;
        const freqMhz = numberOrNull(row.freq);
        const isTarget = targetVariants.includes(String(row.spot_call || '').trim().toUpperCase());

        if (!spotterPos) excluded.noSpotterPosition += 1;
        if (freqMhz === null || freqMhz <= 0) excluded.noFrequency += 1;
        if (!Number.isFinite(distanceKm) || distanceKm <= 0) excluded.invalidDistance += 1;
        if (!isTarget) excluded.otherCall += 1;
        if (strength.usable) sources.rst += 1;
        else if (strength.kind === 'snr') sources.snrOnly += 1;
        else sources.none += 1;

        observations.push({
            row,
            spotter: String(row.de || '').trim().toUpperCase(),
            epoch,
            band: row.band || null,
            spotterPos,
            distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
            bearing: Number.isFinite(bearing) ? bearing : null,
            strength,
            isTarget
        });
    }
    return {observations, excluded, sources};
}

/** 呼号变体：原样 → 去 -# → 去 SSID。 */
function callVariants(call) {
    const base = String(call || '').trim().toUpperCase();
    if (!base) return [];
    const variants = [base];
    const withoutHash = base.replace(/-#+$/, '');
    if (withoutHash && !variants.includes(withoutHash)) variants.push(withoutHash);
    const withoutSsid = base.replace(/-\d+$/, '');
    if (withoutSsid && !variants.includes(withoutSsid)) variants.push(withoutSsid);
    return variants;
}

function groupByPeriod(points) {
    const groups = new Map();
    for (const point of points) {
        if (!Number.isFinite(point.epoch)) continue;
        const bucket = Math.floor(point.epoch / GROUP_SECONDS) * GROUP_SECONDS;
        const key = `${point.band || '?'}|${bucket}`;
        if (!groups.has(key)) {
            groups.set(key, {band: point.band || null, startEpoch: bucket, n: 0});
        }
        groups.get(key).n += 1;
    }
    return [...groups.values()]
        .map(group => ({...group, endEpoch: group.startEpoch + GROUP_SECONDS}))
        .sort((a, b) => a.startEpoch - b.startEpoch);
}

/**
 * 相对电平辅助证据：只在同一报告站内部比较不同方位的电平差。
 * 结果永远不换算成功率、EIRP 或绝对场强；SNR 类数据不参与。
 */
function relativeLevelEvidence(points, referenceAzimuthDeg) {
    const bySpotter = new Map();
    for (const point of points) {
        if (!point.strength.usable || !Number.isFinite(point.bearing)) continue;
        if (!bySpotter.has(point.spotter)) bySpotter.set(point.spotter, []);
        bySpotter.get(point.spotter).push(point);
    }
    const perReceiver = [];
    for (const [spotter, list] of bySpotter) {
        if (list.length < MIN_RELATIVE_POINTS) continue;
        const sectors = new Set(list.map(point => Math.floor(((point.bearing % 360) + 360) % 360 / 30)));
        if (sectors.size < 2) continue;
        const inside = [];
        const outside = [];
        for (const point of list) {
            const offset = angularDiff(point.bearing, referenceAzimuthDeg);
            if (offset === null) continue;
            if (offset <= RELATIVE_LOBE_DEG) inside.push(point.strength.dbm);
            else if (offset >= RELATIVE_OUTSIDE_DEG) outside.push(point.strength.dbm);
        }
        const inMedian = median(inside);
        const outMedian = median(outside);
        if (inMedian === null || outMedian === null) continue;
        perReceiver.push({spotter, n: list.length, inside: inside.length, outside: outside.length,
            deltaDb: inMedian - outMedian});
    }
    if (perReceiver.length < MIN_RELATIVE_RECEIVERS) {
        return {
            available: false,
            reason: perReceiver.length ? 'too-few-receivers' : 'no-usable-strength',
            receivers: perReceiver.length,
            usablePoints: perReceiver.reduce((sum, item) => sum + item.n, 0),
            deltaDb: null,
            perReceiver: perReceiver.slice(0, 10),
            usage: 'auxiliary-only'
        };
    }
    return {
        available: true,
        reason: null,
        receivers: perReceiver.length,
        usablePoints: perReceiver.reduce((sum, item) => sum + item.n, 0),
        deltaDb: median(perReceiver.map(item => item.deltaDb)),
        perReceiver: perReceiver.slice(0, 10),
        usage: 'auxiliary-only'
    };
}

function analyzeTarget(input) {
    const rows = Array.isArray(input && input.rows) ? input.rows : [];
    const call = String((input && input.call) || '').trim().toUpperCase();
    const from = toEpoch(input && input.from);
    const to = toEpoch(input && input.to);
    const warnings = [];

    const {observations, excluded, sources} = buildObservations(rows, call);
    const targetObs = observations.filter(obs => obs.isTarget);
    /* The OP "opponent" is the monitored station, which PSKR and RBN expose on
     * different sides of the row; accept both when grouping per band so the
     * card can show the rival's own activity even when spot_call is the peer. */
    const rivalObs = observations.filter(obs => obs.isTarget ||
        String((obs.row && obs.row.monitored_call) || '').trim().toUpperCase() === call);
    const positioned = targetObs.filter(obs => Number.isFinite(obs.bearing) && Number.isFinite(obs.distanceKm));
    const antenna = classifyAntenna(positioned);

    const groups = groupByPeriod(targetObs);
    const coverage = (() => {
        const occupied = (antenna.evidence && antenna.evidence.sectors) || [];
        return occupied.filter(sector => sector.count > 0).length;
    })();

    if (!antenna.ok) warnings.push('antenna-insufficient');
    if (antenna.notes.includes('dipole-distance-limited')) warnings.push('dipole-distance-limited');
    if (from !== null && to !== null && (to - from) > MAX_WINDOW_HOURS * 3600) warnings.push('window-too-long');
    if (!rows.length) warnings.push('no-spots');

    const referenceAzimuth = Number.isFinite(antenna.azimuthDeg)
        ? antenna.azimuthDeg
        : (antenna.mainSectorDeg === null ? null : antenna.mainSectorDeg);
    const relative = referenceAzimuth === null
        ? {available: false, reason: 'no-bearing', receivers: 0, usablePoints: 0, deltaDb: null, perReceiver: [], usage: 'auxiliary-only'}
        : relativeLevelEvidence(positioned, referenceAzimuth);

    return {
        version: 2,
        target: call,
        window: {
            from: from === null ? null : new Date(from * 1000).toISOString().slice(0, 19).replace('T', ' '),
            to: to === null ? null : new Date(to * 1000).toISOString().slice(0, 19).replace('T', ' '),
            hours: from !== null && to !== null ? Math.round((to - from) / 3600) : null
        },
        method: 'bearing-distribution',
        antenna: {
            ok: antenna.ok,
            type: antenna.type,
            probabilities: antenna.probabilities,
            azimuthDeg: antenna.azimuthDeg,
            mainSectorDeg: antenna.mainSectorDeg,
            points: antenna.points,
            medianDistanceKm: antenna.medianDistanceKm,
            evidence: antenna.evidence,
            notes: antenna.notes,
            confidence: antenna.probabilities ? antenna.probabilities[antenna.type] ?? 0 : 0
        },
        relative,
        bands: analyzeBands(rivalObs),
        observations: {
            totalRows: rows.length,
            targetRows: targetObs.length,
            positioned: positioned.length,
            excluded,
            groups,
            groupCount: groups.length,
            sectorCoverage: coverage,
            strengthSources: sources
        },
        warnings,
        disclaimer: {noPower: 'antenna-only', strengthUsage: 'relative-only'}
    };
}

module.exports = {
    GROUP_SECONDS,
    MIN_ANTENNA_POINTS,
    MAX_WINDOW_HOURS,
    median,
    mad,
    robustSigma,
    angularDiff,
    circularMedian,
    sectorStats,
    classifyAntenna,
    analyzeBands,
    relativeLevelEvidence,
    callVariants,
    groupByPeriod,
    analyzeTarget
};
