'use strict';

/**
 * 基于 PSKReporter FT8 报告的 CW/SSB 可通性研判。
 *
 * 边界（必须同时成立）：
 *  1. 只用 FT8 报告。FT8 解码成功 ≠ CW/SSB 可通，门限差 12/27 dB 是工程惯例值。
 *  2. PSKReporter 的 SNR 由 WSJT-X 家族按 2500 Hz 参考带宽上报，载荷没有带宽字段，
 *     因此**不做任何带宽换算**（尤其不能套用 50 Hz→2500 Hz 的 −17 dB）。
 *  3. 不跨接收站比较绝对 SNR：先按“接收站 × 窗口 × 频段”取中位数，再对接收站中位数
 *     取中位数；跨站离散度单独输出，不参与抬升结论。
 *  4. 功率按 10–70 W 假设：取常见值 50 W 为标称，归一到 100 W 加 3 dB；区间相对标称
 *     不对称（10 W 为 −7.0 dB、70 W 为 +1.5 dB），只有本台显式填写功率时才视为实测。
 *     功率是假设时，置信度最高只能到“中”。
 *  5. 双向分别计算；不一致时以较优方向为上限、较差方向为下限，并按较差方向建议。
 *  6. 研判范围自动覆盖本台大网格内的全部邻台，不需要指定目标呼号。
 */

const {largeGridFrom, latLngToGrid} = require('../radio/maidenhead.js');

const DEFAULT_WINDOW_MINUTES = 15;
const BASE_POWER_W = 100;
const NOMINAL_POWER_W = 50;
const POWER_ASSUMPTION_MIN_W = 10;
const POWER_ASSUMPTION_MAX_W = 70;
/** 相对 50 W 标称的不对称区间：10 W → −7.0 dB，70 W → +1.5 dB。 */
const POWER_UNCERTAINTY_DB = {minus: -7, plus: 1.5};
const NOMINAL_POWER_OFFSET_DB = 10 * Math.log10(BASE_POWER_W / NOMINAL_POWER_W);
const SNR_REFERENCE_HZ = 2500;
const MODE_MARGIN_DB = {CW: 9, SSB: -6};
const MODE_THRESHOLD_DB = {FT8: -21, CW: -9, SSB: 6};
const VERDICT_BAND_DB = 3;
const HIGH_SAMPLES = 10;
const LOW_SAMPLES = 5;
const MIN_LOCAL_STATIONS = 3;
const MIN_LOCAL_REPORTS = 5;
const MAX_BUCKETS = 5000;
const MAX_ROWS = 60;
const MAX_CONTRIBUTORS = 12;
const MAX_NEIGHBORS = 240;
/** 邻台只在实时数据上成立：最近 30 分钟内有过报告，过期即失效。 */
const NEIGHBOR_TTL_MINUTES = 30;

const VERDICT_RANK = {unknown: -1, unworkable: 0, marginal: 1, workable: 2};
const CONFIDENCE_RANK = {high: 0, medium: 1, low: 2};

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

function robustSigma(values) {
    const m = mad(values);
    return m === null ? null : 1.4826 * m;
}

/** 同组内按 3σ 剔除离群点；σ 为 0 时只保留等于中位数的点。 */
function pruneOutliers(values) {
    const med = median(values);
    if (med === null) return [];
    const sigma = robustSigma(values);
    if (!sigma || sigma <= 0) return values.filter(v => v === med);
    return values.filter(v => Math.abs(v - med) <= 3 * sigma);
}

function round1(value) {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/** 功率差 dB：100 W 基准。500 W → −6.99 dB，50 W → +3.01 dB。 */
function normalizeTo100(snrDb, watts) {
    if (!Number.isFinite(snrDb) || !Number.isFinite(watts) || watts <= 0) return null;
    return snrDb + 10 * Math.log10(BASE_POWER_W / watts);
}

/** 发射方功率未知时按 50 W 标称 +3.01 dB；有实测值时按实测归一。 */
function powerOffsetDb(watts) {
    if (Number.isFinite(watts) && watts > 0) return 10 * Math.log10(BASE_POWER_W / watts);
    return NOMINAL_POWER_OFFSET_DB;
}

function verdictOf(marginDb) {
    if (!Number.isFinite(marginDb)) return 'unknown';
    if (marginDb >= VERDICT_BAND_DB) return 'workable';
    if (marginDb <= -VERDICT_BAND_DB) return 'unworkable';
    return 'marginal';
}

function isFt8(row) {
    const comment = String(row.comment || '').toUpperCase();
    if (/^PSKR\s+FT8\b/.test(comment)) return true;
    return String(row.mode || '').toUpperCase() === 'FT8';
}

function gridOf(stored, lat, lon) {
    const raw = String(stored || '').trim().toUpperCase();
    if (/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(raw)) return raw;
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
    return latLngToGrid(la, lo, 4);
}

function epochOf(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const iso = /Z$|[+-]\d\d:?\d\d$/.test(text) ? text : text.replace(' ', 'T') + 'Z';
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** 邻台时效：最近一次出现超过 ttlMinutes 即视为失效，只保留实时活跃台站。 */
function isFreshNeighbor(lastSeen, ttlMinutes, nowSec) {
    const epoch = epochOf(lastSeen);
    if (epoch === null) return false;
    const ttl = (Number.isFinite(ttlMinutes) ? ttlMinutes : NEIGHBOR_TTL_MINUTES) * 60;
    return nowSec - epoch <= ttl;
}

function regionOf(dxcc, grid) {
    const code = Number(dxcc);
    if (Number.isFinite(code) && code > 0) {
        return {key: 'dxcc:' + code, dxcc: code, grid: grid || '', label: 'DXCC ' + code};
    }
    const g = grid ? largeGridFrom(grid) : '';
    return {key: 'grid:' + (g || '??'), dxcc: null, grid: g, label: g || '—'};
}

/** 功率口径：假设（50 W 标称，10–70 W 不对称区间）或实测覆盖值。 */
function powerBasis(powerKnown, watts) {
    if (powerKnown) {
        return {basis: 'override', watts: round1(watts), uncertainDb: {minus: 0, plus: 0}};
    }
    return {
        basis: 'assumption',
        watts: NOMINAL_POWER_W,
        rangeW: [POWER_ASSUMPTION_MIN_W, POWER_ASSUMPTION_MAX_W],
        uncertainDb: {...POWER_UNCERTAINTY_DB}
    };
}

/** 单站聚合：窗口先取中位，再对窗口取中位。 */
function stationMedian(list) {
    const byWindow = new Map();
    for (const point of list) {
        if (!byWindow.has(point.windowStart)) byWindow.set(point.windowStart, []);
        byWindow.get(point.windowStart).push(point.snrAdj);
    }
    const windowMedians = [];
    for (const values of byWindow.values()) {
        const med = median(pruneOutliers(values));
        if (med !== null) windowMedians.push(med);
    }
    return {median: median(windowMedians), windows: windowMedians.length, samples: list.length};
}

/**
 * 本台自身参考值：只用于界面展示，明确标记 includedInMedian:false。
 * 不做“台站数”门槛，样本少时由 samples 让界面自己提示。
 */
function summarizeSelf(points) {
    if (!points.length) return null;
    const windows = new Set();
    const remoteCalls = new Set();
    const powerKnown = points.every(p => p.powerKnown);
    let watts = null;
    for (const point of points) {
        windows.add(point.windowStart);
        remoteCalls.add(point.remote);
        if (point.powerKnown) watts = point.watts;
    }
    const stat = stationMedian(points);
    if (stat.median === null) return null;
    const snrDb = round1(stat.median);
    const margins = {
        CW: round1(snrDb + MODE_MARGIN_DB.CW),
        SSB: round1(snrDb + MODE_MARGIN_DB.SSB)
    };
    return {
        snrDb,
        margins,
        verdicts: {CW: verdictOf(margins.CW), SSB: verdictOf(margins.SSB)},
        samples: points.length,
        windows: windows.size,
        powerKnown,
        power: powerBasis(powerKnown, watts),
        remoteCalls: [...remoteCalls].sort(),
        includedInMedian: false
    };
}

/** 本地一侧台站清单：A→B 取接收站，B→A 取发射站；本台已被排除。 */
function summarizeDirection(points, direction, context) {
    if (!points.length) return null;
    const neighborMap = (context && context.neighborMap) || new Map();
    const monitored = (context && context.monitored) || new Set();
    const byReceiver = new Map();
    const byLocal = new Map();
    const windows = new Set();
    const transmitters = new Set();
    const remoteCalls = new Set();
    const powerKnown = points.every(p => p.powerKnown);
    let watts = null;
    for (const point of points) {
        windows.add(point.windowStart);
        transmitters.add(point.sender);
        remoteCalls.add(point.remote);
        if (!byReceiver.has(point.receiver)) byReceiver.set(point.receiver, []);
        byReceiver.get(point.receiver).push(point);
        const localCall = direction === 'aToB' ? point.receiver : point.sender;
        if (!byLocal.has(localCall)) byLocal.set(localCall, []);
        byLocal.get(localCall).push(point);
        if (point.powerKnown) watts = point.watts;
    }
    // 本地一侧的“台站数”：A→B 是本地接收站，B→A 是本地发射站。本台已被排除。
    const stations = direction === 'aToB' ? byReceiver.size : transmitters.size;
    const power = powerBasis(powerKnown, watts);
    if (stations < MIN_LOCAL_STATIONS || points.length < MIN_LOCAL_REPORTS) {
        return {
            direction,
            available: false,
            insufficient: true,
            reason: stations < MIN_LOCAL_STATIONS ? 'too-few-stations' : 'too-few-reports',
            samples: points.length,
            windows: windows.size,
            stations,
            receivers: byReceiver.size,
            powerKnown,
            power,
            contributors: [],
            remoteCalls: [...remoteCalls].sort()
        };
    }
    const receiverMedians = [];
    for (const list of byReceiver.values()) {
        const stat = stationMedian(list);
        if (stat.median !== null) receiverMedians.push(stat.median);
    }
    const snrDb = median(receiverMedians);
    if (snrDb === null) return null;
    const spanDb = receiverMedians.length > 1
        ? round1(Math.max(...receiverMedians) - Math.min(...receiverMedians)) : 0;
    const margins = {
        CW: round1(snrDb + MODE_MARGIN_DB.CW),
        SSB: round1(snrDb + MODE_MARGIN_DB.SSB)
    };
    const contributors = [...byLocal.entries()]
        .map(([call, list]) => {
            const stat = stationMedian(list);
            if (stat.median === null) return null;
            const med = round1(stat.median);
            const meta = neighborMap.get(call) || {};
            const grid4 = meta.grid4 || largeGridFrom(list[0].localGrid) || '';
            return {
                call,
                grid4,
                lastSeen: meta.lastSeen || null,
                reports: Number.isFinite(meta.reports) ? meta.reports : null,
                isOpponent: monitored.has(call),
                samples: stat.samples,
                windows: stat.windows,
                snrDb: med,
                margins: {
                    CW: round1(med + MODE_MARGIN_DB.CW),
                    SSB: round1(med + MODE_MARGIN_DB.SSB)
                },
                verdicts: {
                    CW: verdictOf(round1(med + MODE_MARGIN_DB.CW)),
                    SSB: verdictOf(round1(med + MODE_MARGIN_DB.SSB))
                }
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.samples - a.samples || a.call.localeCompare(b.call))
        .slice(0, MAX_CONTRIBUTORS);
    return {
        direction,
        available: true,
        snrDb: round1(snrDb),
        margins,
        verdicts: {CW: verdictOf(margins.CW), SSB: verdictOf(margins.SSB)},
        samples: points.length,
        windows: windows.size,
        receivers: byReceiver.size,
        transmitters: transmitters.size,
        stations,
        spanDb,
        powerKnown,
        power,
        contributors,
        remoteCalls: [...remoteCalls].sort()
    };
}

function modeSummary(aToB, bToA, mode) {
    const a = aToB && aToB.available ? aToB.verdicts[mode] : null;
    const b = bToA && bToA.available ? bToA.verdicts[mode] : null;
    if (!a && !b) return null;
    const rankA = VERDICT_RANK[a] === undefined ? -1 : VERDICT_RANK[a];
    const rankB = VERDICT_RANK[b] === undefined ? -1 : VERDICT_RANK[b];
    const upper = rankA >= rankB ? (a || b) : b;
    const lower = rankA <= rankB ? (a || b) : a;
    return {aToB: a, bToA: b, upper, lower, advice: lower};
}

/**
 * 置信度：样本数、双向一致性、功率是否为实测。
 * 功率是假设（50 W 标称）时最高只能到“中”，只有双向功率都实测才允许“高”。
 */
function confidenceOf(aToB, bToA) {
    const usable = direction => Boolean(direction && direction.available === true);
    const ua = usable(aToB);
    const ub = usable(bToA);
    if (!ua || !ub) {
        const notes = [];
        if (ua || ub) notes.push('single-direction');
        if (aToB && aToB.insufficient) notes.push('a-to-b-insufficient');
        if (bToA && bToA.insufficient) notes.push('b-to-a-insufficient');
        if (!notes.length) notes.push('insufficient-samples');
        return {level: 'low', notes};
    }
    const notes = [];
    const minSamples = Math.min(aToB.samples, bToA.samples);
    const consistent = ['CW', 'SSB'].every(mode =>
        aToB.verdicts[mode] === bToA.verdicts[mode]);
    const gap = ['CW', 'SSB'].reduce((max, mode) => Math.max(max,
        Math.abs((VERDICT_RANK[aToB.verdicts[mode]] || 0) -
            (VERDICT_RANK[bToA.verdicts[mode]] || 0))), 0);
    if (!consistent) notes.push('direction-mismatch');
    if (minSamples < HIGH_SAMPLES) notes.push('medium-samples');
    const powerAssumed = !(aToB.powerKnown && bToA.powerKnown);
    if (powerAssumed) notes.push('power-assumed');
    if (minSamples < LOW_SAMPLES || gap >= 2) {
        notes.push('low-samples');
        return {level: 'low', notes};
    }
    if (minSamples >= HIGH_SAMPLES && consistent && !powerAssumed) {
        return {level: 'high', notes: []};
    }
    return {level: 'medium', notes};
}

/** 邻台注册表：来自 neighbors 表，按本台大网格与 30 分钟时效过滤、去重、限量。 */
function normalizeNeighbors(input, local4, myCall, ttlMinutes, nowSec) {
    const list = Array.isArray(input) ? input : [];
    const map = new Map();
    for (const item of list) {
        const call = String((item && item.call) || '').trim().toUpperCase();
        if (!call || call === myCall) continue;
        const grid4 = String((item && item.grid4) || '').trim().toUpperCase();
        if (!/^[A-R]{2}[0-9]{2}$/.test(grid4) || grid4 !== local4) continue;
        const lastSeen = item.lastSeen || item.last_seen || null;
        if (!isFreshNeighbor(lastSeen, ttlMinutes, nowSec)) continue;
        map.set(call, {
            call,
            grid4,
            firstSeen: item.firstSeen || item.first_seen || null,
            lastSeen,
            reports: Number(item.reports) || 0
        });
    }
    return map;
}

function analyzePaths(input) {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const myCall = String(input.myCall || '').trim().toUpperCase();
    const myGrid = String(input.myGrid || '').trim().toUpperCase();
    const local4 = largeGridFrom(myGrid);
    const windowMinutes = Number(input.windowMinutes) === 30 ? 30 : DEFAULT_WINDOW_MINUTES;
    const windowSec = windowMinutes * 60;
    const txPowerW = Number(input.txPowerW);
    const selfWatts = Number.isFinite(txPowerW) && txPowerW > 0 ? txPowerW : null;
    const ttlMinutes = Number.isFinite(Number(input.neighborTtlMinutes))
        ? Number(input.neighborTtlMinutes) : NEIGHBOR_TTL_MINUTES;
    const nowSec = Number.isFinite(Number(input.now))
        ? Number(input.now) : Math.floor(Date.now() / 1000);
    const monitored = new Set((input.monitored || [])
        .map(c => String(c || '').trim().toUpperCase()).filter(Boolean));
    monitored.add(myCall);

    if (!myCall) return {version: 1, ok: false, error: 'call-required'};
    if (!local4) return {version: 1, ok: false, error: 'grid-required'};

    const hasRegistry = Array.isArray(input.neighbors);
    const neighborMap = normalizeNeighbors(input.neighbors, local4, myCall, ttlMinutes, nowSec);

    const excluded = {
        notFt8: 0, noSnr: 0, noTime: 0, noCall: 0, noGrid: 0, outOfScope: 0, selfReference: 0
    };
    const buckets = new Map();
    const selfBuckets = new Map();
    const observedNeighbors = new Map();

    /**
     * 本地邻近台：同大网格、不是本台、且在 30 分钟内活跃。
     * 有邻台注册表时以注册表为准——失效台站的历史报告也不进入统计与排序；
     * 没有注册表输入时（直接调用 / 旧数据）退回纯大网格判定。
     */
    const isLocalNeighbor = (call, grid) =>
        Boolean(call) && call !== myCall && Boolean(grid) && grid.startsWith(local4) &&
        (!hasRegistry || neighborMap.has(call));

    for (const row of rows) {
        if (!isFt8(row)) { excluded.notFt8 += 1; continue; }
        const rawSnr = row.snr;
        const snr = rawSnr === null || rawSnr === undefined || rawSnr === ''
            ? NaN : Number(rawSnr);
        if (!Number.isFinite(snr)) { excluded.noSnr += 1; continue; }
        const epoch = epochOf(row.timestamp);
        if (epoch === null) { excluded.noTime += 1; continue; }
        const sender = String(row.spot_call || '').trim().toUpperCase();
        const receiver = String(row.de || '').trim().toUpperCase();
        if (!sender || !receiver) { excluded.noCall += 1; continue; }
        const sGrid = gridOf(row.sender_grid, row.dx_lat, row.dx_lon);
        const rGrid = gridOf(row.receiver_grid, row.lat, row.lon);
        if (!sGrid || !rGrid) { excluded.noGrid += 1; continue; }
        const senderSelf = sender === myCall;
        const receiverSelf = receiver === myCall;
        const senderNeighbor = isLocalNeighbor(sender, sGrid);
        const receiverNeighbor = isLocalNeighbor(receiver, rGrid);
        const band = String(row.band || '—');
        const windowStart = Math.floor(epoch / windowSec) * windowSec;

        // 功率只作用在发射方：本台可用全局覆盖值，其它台没有数据来源，按 50 W 假设。
        const watts = senderSelf ? selfWatts : null;
        const powerKnown = Number.isFinite(watts) && watts > 0;
        const snrAdj = snr + powerOffsetDb(watts);

        if (senderNeighbor) {
            const meta = observedNeighbors.get(sender) || {
                call: sender, grid4: largeGridFrom(sGrid), reports: 0, lastSeen: null
            };
            meta.reports += 1;
            const iso = String(row.timestamp || '');
            if (!meta.lastSeen || iso > meta.lastSeen) meta.lastSeen = iso;
            observedNeighbors.set(sender, meta);
        }
        if (receiverNeighbor) {
            const meta = observedNeighbors.get(receiver) || {
                call: receiver, grid4: largeGridFrom(rGrid), reports: 0, lastSeen: null
            };
            meta.reports += 1;
            const iso = String(row.timestamp || '');
            if (!meta.lastSeen || iso > meta.lastSeen) meta.lastSeen = iso;
            observedNeighbors.set(receiver, meta);
        }

        // 本台报告单独留作参考，不参与任何区域中位数。
        if (senderSelf || receiverSelf) {
            // 本台 ↔ 本地邻近台 属于同侧，不构成“本地 ↔ 远方”，也不能当参考。
            if (receiverSelf ? senderNeighbor : receiverNeighbor) {
                excluded.outOfScope += 1;
                continue;
            }
            const direction = receiverSelf ? 'aToB' : 'bToA';
            const remote = receiverSelf ? sender : receiver;
            const remoteGrid = receiverSelf ? sGrid : rGrid;
            const remoteDxcc = receiverSelf ? row.dxcc_sender : row.dxcc_receiver;
            const region = regionOf(remoteDxcc, remoteGrid);
            const key = direction + '|' + region.key + '|' + band;
            if (!selfBuckets.has(key)) {
                selfBuckets.set(key, {direction, region, band, points: []});
            }
            selfBuckets.get(key).points.push({
                snr, snrAdj, watts, powerKnown, windowStart, remote
            });
            excluded.selfReference += 1;
            continue;
        }

        // 两端同为本地邻近台或同为远方台，不属于“本地 ↔ 远方”。
        if (senderNeighbor === receiverNeighbor) { excluded.outOfScope += 1; continue; }

        const direction = receiverNeighbor ? 'aToB' : 'bToA';
        const remote = receiverNeighbor ? sender : receiver;
        const remoteGrid = receiverNeighbor ? sGrid : rGrid;
        const remoteDxcc = receiverNeighbor ? row.dxcc_sender : row.dxcc_receiver;
        const region = regionOf(remoteDxcc, remoteGrid);
        const localGrid = receiverNeighbor ? rGrid : sGrid;

        const key = direction + '|' + region.key + '|' + band;
        if (!buckets.has(key)) {
            buckets.set(key, {
                direction, region, band,
                points: [],
                grids: new Map(),
                opponents: new Set()
            });
        }
        const bucket = buckets.get(key);
        if (bucket.points.length >= MAX_BUCKETS) continue;
        bucket.points.push({
            sender, receiver, remote, localGrid,
            snr, snrAdj, watts, powerKnown, windowStart
        });
        const g = largeGridFrom(remoteGrid);
        if (g) bucket.grids.set(g, (bucket.grids.get(g) || 0) + 1);
        if (monitored.has(remote) && remote !== myCall) bucket.opponents.add(remote);
    }

    // 邻台清单：注册表为准；没有注册表输入时，用本次报告里实际出现的本地台补齐。
    if (!hasRegistry) {
        for (const [call, meta] of observedNeighbors) {
            if (neighborMap.has(call)) continue;
            neighborMap.set(call, {...meta, firstSeen: meta.lastSeen, source: 'spots'});
        }
    }

    const byPair = new Map();
    for (const bucket of buckets.values()) {
        const pair = bucket.region.key + '|' + bucket.band;
        if (!byPair.has(pair)) byPair.set(pair, {region: bucket.region, band: bucket.band});
        const agg = byPair.get(pair);
        const context = {neighborMap, monitored};
        agg[bucket.direction] = summarizeDirection(bucket.points, bucket.direction, context);
        agg.opponents = agg.opponents || new Set();
        for (const call of bucket.opponents) agg.opponents.add(call);
        agg.grids = agg.grids || new Map();
        for (const [g, n] of bucket.grids) agg.grids.set(g, (agg.grids.get(g) || 0) + n);
    }
    // 只有本台参考、没有本地邻近台样本的区域也要出现，用于展示“样本不足 + 本台参考”。
    for (const bucket of selfBuckets.values()) {
        const pair = bucket.region.key + '|' + bucket.band;
        if (byPair.has(pair)) continue;
        byPair.set(pair, {
            region: bucket.region, band: bucket.band,
            opponents: new Set(), grids: new Map()
        });
    }

    const selfByPair = new Map();
    for (const bucket of selfBuckets.values()) {
        const pair = bucket.region.key + '|' + bucket.band;
        if (!selfByPair.has(pair)) selfByPair.set(pair, {});
        selfByPair.get(pair)[bucket.direction] = summarizeSelf(bucket.points);
    }

    const outputRows = [];
    for (const pair of byPair.values()) {
        const aToB = pair.aToB || null;
        const bToA = pair.bToA || null;
        const confidence = confidenceOf(aToB, bToA);
        const modes = {
            CW: modeSummary(aToB, bToA, 'CW'),
            SSB: modeSummary(aToB, bToA, 'SSB')
        };
        const grids = [...(pair.grids || new Map()).entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, 3).map(entry => entry[0]);
        const self = selfByPair.get(pair.region.key + '|' + pair.band) || {};
        const selfA = self.aToB || null;
        const selfB = self.bToA || null;
        const remoteCalls = new Set([
            ...(aToB ? aToB.remoteCalls : []),
            ...(bToA ? bToA.remoteCalls : []),
            ...(selfA ? selfA.remoteCalls : []),
            ...(selfB ? selfB.remoteCalls : [])
        ]);
        // 可利用性：优先展示“现在就能用”的区域（可通 > 边缘 > 不可通 > 未知）。
        const usability = Math.max(
            VERDICT_RANK[modes.CW && modes.CW.advice] ?? -1,
            VERDICT_RANK[modes.SSB && modes.SSB.advice] ?? -1
        );
        outputRows.push({
            region: {
                key: pair.region.key,
                label: pair.region.label,
                dxcc: pair.region.dxcc,
                grids
            },
            band: pair.band,
            usability,
            directions: {aToB, bToA},
            modes,
            confidence,
            // 本台自身参考：只展示，includedInMedian 恒为 false，不参与判定。
            self: {aToB: selfA, bToA: selfB},
            opponents: [...(pair.opponents || [])].sort(),
            remoteCalls: [...remoteCalls].sort()
        });
    }
    outputRows.sort((a, b) => {
        if (a.usability !== b.usability) return b.usability - a.usability;
        const ca = CONFIDENCE_RANK[a.confidence.level];
        const cb = CONFIDENCE_RANK[b.confidence.level];
        if (ca !== cb) return ca - cb;
        const sa = Math.max(a.directions.aToB?.samples || 0, a.directions.bToA?.samples || 0);
        const sb = Math.max(b.directions.aToB?.samples || 0, b.directions.bToA?.samples || 0);
        return sb - sa;
    });

    // 只保留 30 分钟内活跃的邻台；按最近出现时间排序，失效台站不参与任何统计。
    const neighborList = [...neighborMap.values()]
        .sort((a, b) => (epochOf(b.lastSeen) || 0) - (epochOf(a.lastSeen) || 0) ||
            (b.reports || 0) - (a.reports || 0) || a.call.localeCompare(b.call))
        .slice(0, MAX_NEIGHBORS);

    return {
        version: 1,
        ok: true,
        local: {
            call: myCall,
            grid: myGrid,
            largeGrid: local4,
            neighborCount: neighborList.length,
            neighbors: neighborList
        },
        windowMinutes,
        neighborTtlMinutes: ttlMinutes,
        snrReferenceHz: SNR_REFERENCE_HZ,
        bandwidthConversion: 'none',
        power: {
            baseWatts: BASE_POWER_W,
            nominalWatts: NOMINAL_POWER_W,
            assumptionRangeW: [POWER_ASSUMPTION_MIN_W, POWER_ASSUMPTION_MAX_W],
            uncertainDb: {...POWER_UNCERTAINTY_DB},
            selfWatts,
            selfPowerKnown: selfWatts !== null
        },
        thresholds: {
            snrDb: {...MODE_THRESHOLD_DB},
            marginDb: {...MODE_MARGIN_DB},
            verdictBandDb: VERDICT_BAND_DB
        },
        observations: {
            input: rows.length,
            used: outputRows.reduce((sum, row) =>
                sum + (row.directions.aToB?.samples || 0) + (row.directions.bToA?.samples || 0), 0),
            truncated: outputRows.length > MAX_ROWS,
            totalRows: outputRows.length,
            excluded
        },
        rows: outputRows.slice(0, MAX_ROWS),
        disclaimer: {
            ft8NotVoice: true,
            engineeringThresholds: true,
            noCrossReceiverAbsolute: true,
            powerAssumed: true,
            neighborScopeAutomatic: true
        }
    };
}

module.exports = {
    DEFAULT_WINDOW_MINUTES,
    BASE_POWER_W,
    NOMINAL_POWER_W,
    NOMINAL_POWER_OFFSET_DB,
    POWER_UNCERTAINTY_DB,
    NEIGHBOR_TTL_MINUTES,
    SNR_REFERENCE_HZ,
    MODE_MARGIN_DB,
    MODE_THRESHOLD_DB,
    VERDICT_BAND_DB,
    MAX_ROWS,
    median,
    pruneOutliers,
    normalizeTo100,
    powerOffsetDb,
    isFreshNeighbor,
    verdictOf,
    analyzePaths
};
