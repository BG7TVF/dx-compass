'use strict';

const {propBearing, propDistance} = require('../propagation/model.js');
const {normalizeStrength, S9_DBM, DB_PER_S_UNIT} = require('./strength.js');
const {medianPathLossDb} = require('./path-loss.js');
const {
    loadReferences, receiverFor, gainForAntennaType, callVariants
} = require('./references.js');

/**
 * 发射台功率档位 / 天线研判。
 *
 * 三条铁律：
 *  1. 信号强度一律取中位数，绝不取平均。
 *  2. 方位热力/密度只用于判天线类型与朝向，绝不用于提取强度。
 *  3. 输出始终是「主判档 + 相邻档 + 置信度 + 误差带」，误差地板不随样本量收缩。
 */

const GROUP_SECONDS = 7200;          // 2 小时分组
const CROSS_POL_DB = 3;              // 跨极化保守惩罚
const SIGMA_MODEL = 5;               // 路径损耗模型系统误差
const SIGMA_GAIN = 3;                // 发射端增益/方向图假设误差
const SIGMA_RX = 6;                  // 接收端未知型号误差
const SIGMA_BETWEEN_FLOOR = 2.5;     // 绝对法组间误差地板
const SIGMA_GAIN_DIFF = 2;           // 线路 A 增益差
const SIGMA_ANCHOR = 2.5;            // 线路 A 参照台锚定
const SIGMA_BETWEEN_LINEA_FLOOR = 1.5;
const OUTLIER_DB = 3;
const MIN_ANTENNA_POINTS = 6;
const MIN_POWER_POINTS = 4;
const MIN_GROUPS = 2;
const MAX_MAIN_LOBE_OFFSET = 60;
const PATTERN_LOSS_DB = 6;           // 主瓣边缘相对中心的衰减
const MAX_WINDOW_HOURS = 168;

const POWER_CLASSES = [
    {id: 'D1', label: '10 W', watts: 10, dbm: 40},
    {id: 'D2', label: '100 W', watts: 100, dbm: 50},
    {id: 'D3', label: '500 W', watts: 500, dbm: 10 * Math.log10(500 * 1000)},
    {id: 'D4', label: '1 kW', watts: 1000, dbm: 60},
    {id: 'D5', label: '2 kW', watts: 2000, dbm: 10 * Math.log10(2000 * 1000)}
];
const HIGH_GROUP = {id: 'D3-D5', label: 'D3–D5 (500 W 以上)'};

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

function freqMhzOf(row) {
    const khz = numberOrNull(row.freq);
    return khz && khz > 0 ? khz / 1000 : null;
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
    if (medianDistance !== null && medianDistance > 2000 && top[0] === 'dipole') {
        result.notes.push('dipole-low-confidence');
    }
    return result;
}

function receiverGain(meta, bearingToTarget) {
    if (!meta) return {gain: 0, known: false};
    const gain = Number.isFinite(meta.gainDbi) ? meta.gainDbi : 0;
    if (meta.antennaType === 'directional' && Number.isFinite(meta.azimuthDeg) && Number.isFinite(bearingToTarget)) {
        const off = angularDiff(bearingToTarget, meta.azimuthDeg);
        const loss = off <= 60 ? PATTERN_LOSS_DB * (off / 60) ** 2
            : PATTERN_LOSS_DB + 6 * Math.min(1, (off - 60) / 60);
        return {gain: gain - loss, known: true};
    }
    return {gain, known: meta.antennaType !== 'unknown' || Number.isFinite(meta.gainDbi)};
}

/** 主瓣方向图相对中心衰减（正数，单位 dB）。 */
function patternOffsetLoss(offsetDeg) {
    if (!Number.isFinite(offsetDeg)) return 0;
    return PATTERN_LOSS_DB * (Math.min(offsetDeg, MAX_MAIN_LOBE_OFFSET) / 60) ** 2;
}

function buildObservations(rows, target, table) {
    const observations = [];
    const targetVariants = callVariants(target);
    const excluded = {
        noSpotterPosition: 0,
        noStrength: 0,
        snrOnly: 0,
        noFrequency: 0,
        invalidDistance: 0
    };
    for (const row of rows) {
        const spotterPos = positionOf(row, 'lat', 'lon');
        const targetPos = positionOf(row, 'dx_lat', 'dx_lon');
        const strength = normalizeStrength(row);
        const epoch = toEpoch(row.timestamp || row.time);
        const distanceKm = spotterPos && targetPos ? propDistance(targetPos, spotterPos) : numberOrNull(row.distance_km);
        const bearing = spotterPos && targetPos ? propBearing(targetPos, spotterPos) : null;
        const bearingToTarget = spotterPos && targetPos ? propBearing(spotterPos, targetPos) : null;
        const freqMhz = freqMhzOf(row);
        if (!spotterPos) excluded.noSpotterPosition += 1;
        if (strength.kind === 'none') excluded.noStrength += 1;
        else if (strength.kind === 'snr') excluded.snrOnly += 1;
        if (freqMhz === null) excluded.noFrequency += 1;
        if (!Number.isFinite(distanceKm) || distanceKm <= 0) excluded.invalidDistance += 1;
        observations.push({
            row,
            spotter: String(row.de || '').trim().toUpperCase(),
            epoch,
            band: row.band || null,
            freqMhz,
            spotterPos,
            targetPos,
            distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
            bearing: Number.isFinite(bearing) ? bearing : null,
            bearingToTarget: Number.isFinite(bearingToTarget) ? bearingToTarget : null,
            strength,
            receiver: receiverFor(table, row.de),
            isTarget: targetVariants.includes(String(row.spot_call || '').trim().toUpperCase())
        });
    }
    return {observations, excluded};
}

function groupAbsolute(points) {
    const groups = new Map();
    for (const point of points) {
        const bucket = Math.floor(point.epoch / GROUP_SECONDS) * GROUP_SECONDS;
        const key = `${point.band || '?'}|${bucket}`;
        if (!groups.has(key)) {
            groups.set(key, {key, band: point.band || null, startEpoch: bucket, points: []});
        }
        groups.get(key).points.push(point);
    }
    return [...groups.values()].map(group => ({
        band: group.band,
        startEpoch: group.startEpoch,
        endEpoch: group.startEpoch + GROUP_SECONDS,
        n: group.points.length,
        medianDbm: median(group.points.map(p => p.ptDbm)),
        dispersionDb: robustSigma(group.points.map(p => p.ptDbm))
    })).filter(g => g.medianDbm !== null).sort((a, b) => a.startEpoch - b.startEpoch);
}

function absoluteMethod(observations, antenna, table) {
    const gainT = gainForAntennaType(antenna.type, null);
    const points = [];
    const excluded = {offMainLobe: 0, noFrequency: 0, noGeometry: 0, noReceiverModel: 0};
    for (const obs of observations) {
        if (!obs.strength.usable) continue;
        if (obs.freqMhz === null) { excluded.noFrequency += 1; continue; }
        if (obs.distanceKm === null || obs.epoch === null) { excluded.noGeometry += 1; continue; }
        let offset = 0;
        if (antenna.type === 'directional' && Number.isFinite(antenna.azimuthDeg) && Number.isFinite(obs.bearing)) {
            offset = angularDiff(obs.bearing, antenna.azimuthDeg);
            if (offset > MAX_MAIN_LOBE_OFFSET) { excluded.offMainLobe += 1; continue; }
        }
        const rx = receiverGain(obs.receiver, obs.bearingToTarget);
        if (!obs.receiver || obs.receiver.antennaType === 'unknown') excluded.noReceiverModel += 1;
        const pathLoss = medianPathLossDb(obs.freqMhz, obs.distanceKm);
        if (pathLoss === null) { excluded.noGeometry += 1; continue; }
        const normalized = obs.strength.dbm - rx.gain - CROSS_POL_DB - patternOffsetLoss(offset);
        points.push({
            obs,
            epoch: obs.epoch,
            band: obs.band,
            ptDbm: normalized + pathLoss - gainT,
            pathLossDb: pathLoss,
            rxGainDb: rx.gain,
            patternLossDb: patternOffsetLoss(offset),
            offsetDeg: offset
        });
    }
    const groups = groupAbsolute(points.filter(p => Number.isFinite(p.ptDbm)));
    const usable = points.length;
    if (usable < MIN_POWER_POINTS || groups.length < MIN_GROUPS) {
        return {
            ok: false,
            reason: 'insufficient-samples',
            method: 'absolute',
            points: usable,
            groups,
            excluded,
            gainT,
            sigma: null
        };
    }
    const groupMedians = groups.map(g => g.medianDbm);
    const estimate = median(groupMedians);
    const between = Math.max(robustSigma(groupMedians) || 0, SIGMA_BETWEEN_FLOOR);
    const sigma = Math.sqrt(between ** 2 + SIGMA_MODEL ** 2 + SIGMA_GAIN ** 2 + SIGMA_RX ** 2);
    return {
        ok: true,
        method: 'absolute',
        points: usable,
        groups,
        excluded,
        gainT,
        estimateDbm: estimate,
        medianReceivedDbm: median(points.map(p => p.obs.strength.dbm)),
        sigma,
        breakdown: {
            between: {value: between, source: 'between-groups'},
            model: {value: SIGMA_MODEL, source: 'path-loss-model'},
            gain: {value: SIGMA_GAIN, source: 'tx-gain'},
            rx: {value: SIGMA_RX, source: 'rx-unknown'}
        },
        params: {
            groupSeconds: GROUP_SECONDS,
            crossPolDb: CROSS_POL_DB,
            patternLossDb: PATTERN_LOSS_DB,
            gainT,
            pathLoss: 'FSPL + 10 dB + 0.003 dB/km (cap 40 dB)',
            sMeter: {s9Dbm: S9_DBM, perUnit: DB_PER_S_UNIT}
        }
    };
}

function lineAMethod(observations, antenna, table) {
    const gainT = gainForAntennaType(antenna.type, null);
    // 只以目标台的 spot 作为配对主体；参照台自己的 spot 不能自配对。
    const usableTarget = observations.filter(o => o.isTarget && o.strength.usable);
    const pairs = [];
    const rejected = [];
    const refsSeen = new Set();
    for (const ref of table.references || []) {
        refsSeen.add(ref.call);
        const refGain = gainForAntennaType(ref.antennaType, ref.gainDbi);
        for (const targetObs of usableTarget) {
            if (!targetObs.spotter || targetObs.epoch === null) continue;
            const refVariants = callVariants(ref.call);
            const refObsList = observations.filter(o => o.spotter === targetObs.spotter
                && o.strength.usable
                && refVariants.includes(String(o.row.spot_call || '').trim().toUpperCase())
                && o.band === targetObs.band);
            for (const refObs of refObsList) {
                const dt = Math.abs((targetObs.epoch || 0) - (refObs.epoch || 0));
                if (dt >= 3600) { rejected.push({reason: 'time-gap', dt}); continue; }
                if (targetObs.receiver && targetObs.receiver.agcCompressed) {
                    rejected.push({reason: 'agc-compressed'});
                    continue;
                }
                if (!Number.isFinite(targetObs.bearingToTarget) || !Number.isFinite(refObs.bearingToTarget)) {
                    rejected.push({reason: 'no-bearing'});
                    continue;
                }
                const bearingDelta = angularDiff(targetObs.bearingToTarget, refObs.bearingToTarget);
                if (bearingDelta === null || bearingDelta >= 20) {
                    rejected.push({reason: 'bearing-gap', bearingDelta});
                    continue;
                }
                if (!Number.isFinite(targetObs.distanceKm) || !Number.isFinite(refObs.distanceKm)) {
                    rejected.push({reason: 'no-distance'});
                    continue;
                }
                const distanceRatio = Math.abs(targetObs.distanceKm - refObs.distanceKm)
                    / Math.max(targetObs.distanceKm, refObs.distanceKm);
                if (distanceRatio >= 0.15) {
                    rejected.push({reason: 'distance-gap', distanceRatio});
                    continue;
                }
                const deltaPr = targetObs.strength.dbm - refObs.strength.dbm;
                const deltaPt = deltaPr + (refGain - gainT);
                pairs.push({
                    receiver: targetObs.spotter,
                    reference: ref.call,
                    band: targetObs.band,
                    dtSec: dt,
                    bearingDeltaDeg: bearingDelta,
                    distanceRatio,
                    deltaPrDb: deltaPr,
                    deltaPtDb: deltaPt,
                    targetDbm: targetObs.strength.dbm,
                    ptDbm: ref.powerDbm + deltaPt
                });
            }
        }
    }
    if (!pairs.length) {
        return {
            ok: false,
            reason: 'no-qualified-pairs',
            method: 'lineA',
            points: 0,
            pairs: [],
            rejected,
            gainT,
            refsSeen: [...refsSeen]
        };
    }
    let kept = pairs.slice();
    const outliers = [];
    if (kept.length >= 3) {
        const med = median(kept.map(p => p.ptDbm));
        const filtered = kept.filter(p => Math.abs(p.ptDbm - med) <= OUTLIER_DB);
        for (const pair of kept) {
            if (!filtered.includes(pair)) outliers.push(pair);
        }
        kept = filtered;
    }
    const values = kept.map(p => p.ptDbm);
    const estimate = median(values);
    const between = Math.max(robustSigma(values) || 0, SIGMA_BETWEEN_LINEA_FLOOR);
    const sigma = Math.sqrt(between ** 2 + SIGMA_GAIN_DIFF ** 2 + SIGMA_ANCHOR ** 2);
    return {
        ok: true,
        method: 'lineA',
        points: kept.length,
        pairs: kept,
        outliers,
        rejected,
        gainT,
        refsUsed: [...new Set(kept.map(p => p.reference))],
        estimateDbm: estimate,
        medianReceivedDbm: median(kept.map(p => p.targetDbm)),
        signalDeltaMedianDb: median(kept.map(p => p.deltaPrDb)),
        sigma,
        breakdown: {
            between: {value: between, source: 'pair-dispersion'},
            gainDiff: {value: SIGMA_GAIN_DIFF, source: 'gain-difference'},
            anchor: {value: SIGMA_ANCHOR, source: 'reference-anchor'}
        },
        params: {
            gainT,
            outlierDb: OUTLIER_DB,
            pairLimits: {timeSec: 3600, bearingDeg: 20, distanceRatio: 0.15}
        }
    };
}

function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * ax);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return sign * y;
}

function normalCdf(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
}

function classBounds(index, merged) {
    if (merged) {
        if (index === 0) return {low: -Infinity, high: (POWER_CLASSES[0].dbm + POWER_CLASSES[1].dbm) / 2};
        if (index === 1) {
            return {
                low: (POWER_CLASSES[0].dbm + POWER_CLASSES[1].dbm) / 2,
                high: (POWER_CLASSES[1].dbm + POWER_CLASSES[2].dbm) / 2
            };
        }
        return {
            low: (POWER_CLASSES[1].dbm + POWER_CLASSES[2].dbm) / 2,
            high: Infinity
        };
    }
    const low = index === 0 ? -Infinity : (POWER_CLASSES[index - 1].dbm + POWER_CLASSES[index].dbm) / 2;
    const high = index === POWER_CLASSES.length - 1
        ? Infinity
        : (POWER_CLASSES[index].dbm + POWER_CLASSES[index + 1].dbm) / 2;
    return {low, high};
}

function mapToClass(estimateDbm, sigma, method) {
    const merged = method === 'absolute' || sigma >= 4;
    let mainIndex = 0;
    let best = Infinity;
    POWER_CLASSES.forEach((cls, index) => {
        const d = Math.abs(cls.dbm - estimateDbm);
        if (d < best) {
            best = d;
            mainIndex = index;
        }
    });
    const mainMerged = merged && mainIndex >= 2;
    const main = mainMerged ? HIGH_GROUP : POWER_CLASSES[mainIndex];
    const possible = [];
    if (merged) {
        if (mainIndex < 2) {
            possible.push(POWER_CLASSES[mainIndex]);
            const neighbour = mainIndex === 0 ? 1 : 0;
            if (Math.abs(POWER_CLASSES[neighbour].dbm - estimateDbm) < sigma) {
                possible.push(POWER_CLASSES[neighbour]);
            }
            if (Math.abs(POWER_CLASSES[2].dbm - estimateDbm) < sigma) possible.push(HIGH_GROUP);
        } else {
            possible.push(HIGH_GROUP);
            if (Math.abs(POWER_CLASSES[1].dbm - estimateDbm) < sigma) possible.push(POWER_CLASSES[1]);
        }
    } else {
        const lo = Math.max(0, mainIndex - 1);
        const hi = Math.min(POWER_CLASSES.length - 1, mainIndex + 1);
        for (let i = lo; i <= hi; i += 1) {
            if (i === mainIndex || Math.abs(POWER_CLASSES[i].dbm - estimateDbm) < sigma) {
                possible.push(POWER_CLASSES[i]);
            }
        }
    }
    const bounds = classBounds(mainMerged ? 2 : mainIndex, merged);
    const confidence = normalCdf((bounds.high - estimateDbm) / sigma)
        - normalCdf((bounds.low - estimateDbm) / sigma);
    return {
        mergedHigh: merged,
        mainClass: main.id,
        mainLabel: main.label,
        possibleClasses: possible.map(cls => ({
            id: cls.id,
            label: cls.label,
            centerDbm: cls.dbm,
            distanceDb: Math.abs(cls.dbm - estimateDbm)
        })),
        confidence: clamp(confidence, 0, 1),
        separability: merged ? 'absolute-merged-high' : 'lineA-adjacent-only'
    };
}

/**
 * 主入口。
 * @param {object} input {call, rows, from, to, references?, now?}
 */
function estimateTarget(input = {}) {
    const target = String(input.call || '').trim().toUpperCase();
    const table = input.references || loadReferences();
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const {observations, excluded} = buildObservations(rows, target, table);
    const targetObs = observations.filter(o => o.isTarget);
    const positioned = targetObs.filter(o => Number.isFinite(o.bearing) && Number.isFinite(o.distanceKm));
    const antenna = classifyAntenna(positioned);
    const usableTarget = targetObs.filter(o => o.strength.usable);

    const lineA = lineAMethod(observations, antenna, table);
    const method = lineA.ok ? 'lineA' : 'absolute';
    const power = lineA.ok ? lineA : absoluteMethod(targetObs, antenna, table);

    let classes = null;
    if (power.ok) {
        classes = mapToClass(power.estimateDbm, power.sigma, power.method);
    }

    const warnings = [];
    if (!table.loaded) warnings.push('reference-table-unavailable');
    if (!(table.references || []).length) warnings.push('reference-table-empty');
    if (method === 'absolute' && lineA.reason === 'no-qualified-pairs') warnings.push('no-qualified-pairs');
    if (power.reason === 'insufficient-samples') warnings.push('insufficient-samples');
    if (!antenna.ok) warnings.push('antenna-insufficient');
    if (antenna.type === 'dipole' && (antenna.medianDistanceKm || 0) > 2000) warnings.push('dipole-distance-limited');
    const fromEpoch = toEpoch(input.from);
    const toEpochValue = toEpoch(input.to);
    const span = fromEpoch !== null && toEpochValue !== null ? (toEpochValue - fromEpoch) / 3600 : null;
    if (span !== null && span > MAX_WINDOW_HOURS) warnings.push('window-too-long');

    const result = {
        version: 1,
        target,
        window: {from: input.from || null, to: input.to || null},
        method,
        methodDetail: {
            chosen: method,
            lineAReason: lineA.ok ? null : lineA.reason,
            hasReferences: (table.references || []).length > 0,
            refsSeen: lineA.refsSeen || [],
            gainAssumptionDbi: gainForAntennaType(antenna.type, null),
            pairLimits: {timeSec: 3600, bearingDeg: 20, distanceRatio: 0.15}
        },
        antenna: {
            ok: antenna.ok,
            type: antenna.type,
            probabilities: antenna.probabilities,
            azimuthDeg: antenna.azimuthDeg,
            mainSectorDeg: antenna.mainSectorDeg,
            points: antenna.points,
            medianDistanceKm: antenna.medianDistanceKm,
            evidence: antenna.evidence,
            notes: antenna.notes
        },
        observations: {
            totalRows: rows.length,
            positioned: positioned.length,
            strengthUsable: usableTarget.length,
            excluded,
            groups: power.groups || [],
            groupCount: (power.groups || []).length,
            pairs: power.pairs ? power.pairs.length : 0,
            powerExcluded: power.excluded || null,
            medianLevelDbm: power.medianReceivedDbm ?? null,
            totalPointsUsed: power.points || 0
        },
        power: {
            ok: Boolean(power.ok),
            insufficient: !power.ok,
            reason: power.reason || null,
            estimateDbm: power.estimateDbm ?? null,
            watts: power.estimateDbm === undefined || power.estimateDbm === null
                ? null
                : 10 ** (power.estimateDbm / 10) / 1000,
            intervalDbm: power.ok ? [power.estimateDbm - power.sigma, power.estimateDbm + power.sigma] : null,
            sigma: power.sigma ?? null,
            breakdown: power.breakdown || null,
            paramDetail: power.params || null,
            pairs: power.pairs || [],
            outliers: power.outliers || [],
            rejectedPairs: (power.rejected || []).slice(0, 50),
            classes
        },
        references: {
            loaded: table.loaded,
            path: table.path,
            error: table.error,
            referenceCount: (table.references || []).length,
            receiverCount: (table.receivers || []).length,
            used: power.refsUsed || []
        },
        warnings,
        disclaimer: {errorFloor: 'error-floor', threeDbBands: 'three-db-bands'}
    };
    return result;
}

module.exports = {
    GROUP_SECONDS,
    CROSS_POL_DB,
    SIGMA_MODEL,
    SIGMA_GAIN,
    SIGMA_RX,
    SIGMA_BETWEEN_FLOOR,
    SIGMA_GAIN_DIFF,
    SIGMA_ANCHOR,
    SIGMA_BETWEEN_LINEA_FLOOR,
    OUTLIER_DB,
    MIN_ANTENNA_POINTS,
    MIN_POWER_POINTS,
    MIN_GROUPS,
    MAX_MAIN_LOBE_OFFSET,
    PATTERN_LOSS_DB,
    POWER_CLASSES,
    HIGH_GROUP,
    median,
    mad,
    robustSigma,
    angularDiff,
    circularMedian,
    sectorStats,
    classifyAntenna,
    mapToClass,
    normalCdf,
    estimateTarget
};
