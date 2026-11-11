'use strict';

/**
 * 规则引擎入口（纯函数）。
 *
 * 输入是“已取好的快照”，不碰数据库、不碰网络，方便单测与回放。
 * 服务层（service.js）负责把 SQL 行、全局状态和设置拼成这个快照。
 */

const envBuilder = require('./environment.js');
const rules = require('./rules.js');
const {thresholds, BANDS} = require('./config.js');
const {wpxPrefix} = require('../wpx/prefix.js');
const seat = require('../qsos/seat.js');
const contestRules = require('../contest/rules.js');

const CONFIDENCE_RANK = {low: 0, medium: 1, high: 2};

const BAND_RANGES = [
    ['160', 1800, 2000], ['80', 3500, 4000], ['60', 5330, 5410], ['40', 7000, 7300],
    ['30', 10100, 10150], ['20', 14000, 14350], ['17', 18068, 18168], ['15', 21000, 21450],
    ['12', 24890, 24990], ['10', 28000, 29700], ['6', 50000, 54000], ['2', 144000, 148000]
];

function freqToBand(freqKhz) {
    const freq = Number(freqKhz);
    if (!Number.isFinite(freq) || freq <= 0) return null;
    for (const [band, low, high] of BAND_RANGES) {
        if (freq >= low && freq <= high) return band;
    }
    return null;
}

function contestTypeOf(settings) {
    const explicit = String((settings && settings.contestType) || 'AUTO').toUpperCase();
    if (explicit !== 'AUTO') return explicit;
    const name = String((settings && settings.contestName) || '').toUpperCase();
    if (/WPX/.test(name)) return 'CQWPX';
    if (/160/.test(name)) return 'CQ160';
    if (/ARRL/.test(name)) return 'ARRL_DX';
    if (/RTTY/.test(name)) return 'CQWW_RTTY';
    if (/CQ\s*WW|CQWW|CQ WORLD/.test(name)) return 'CQWW';
    if (/WAE/.test(name)) return 'WAE';
    if (/IARU/.test(name)) return 'IARU';
    return 'OTHER';
}

function powerClassOf(settings) {
    const explicit = String((settings && settings.powerClass) || 'UNKNOWN').toUpperCase();
    if (explicit !== 'UNKNOWN') return explicit;
    const watts = Number(settings && settings.txPowerW);
    if (!Number.isFinite(watts) || watts <= 0) return 'UNKNOWN';
    if (watts <= 5) return 'QRP';
    if (watts <= 100) return 'LP';
    return 'HP';
}

function parseTs(value) {
    const ms = Date.parse(String(value || ''));
    return Number.isFinite(ms) ? ms : null;
}

function buildStats(rows, multMode) {
    const bands = {};
    let totalQso = 0;
    let totalPoints = 0;
    const wpx = new Set();
    const seq = [];

    const ensure = band => {
        if (!bands[band]) {
            bands[band] = {
                q: 0, points: 0, mults: 0, firstTs: null, lastTs: null,
                bucketMap: new Map(), pointMap: new Map(), wpx: new Set()
            };
        }
        return bands[band];
    };

    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.kind) continue;
        const band = row.band || '';
        const q = Number(row.qsos) || 0;
        const points = Number(row.points) || 0;
        const mults = Number(row.mults) || 0;

        if (row.kind === 'band' && band) {
            const entry = ensure(band);
            entry.q += q;
            entry.points += points;
            entry.mults += mults;
            if (row.first_ts && (!entry.firstTs || row.first_ts < entry.firstTs)) entry.firstTs = row.first_ts;
            if (row.last_ts && (!entry.lastTs || row.last_ts > entry.lastTs)) entry.lastTs = row.last_ts;
            totalQso += q;
            totalPoints += points;
        } else if (row.kind === 'bucket' && band && row.bucket) {
            const entry = ensure(band);
            entry.bucketMap.set(row.bucket, (entry.bucketMap.get(row.bucket) || 0) + q);
            entry.pointMap.set(row.bucket, (entry.pointMap.get(row.bucket) || 0) + points);
        } else if (row.kind === 'call' && band && row.bucket) {
            const prefix = wpxPrefix(row.bucket);
            if (prefix) {
                ensure(band).wpx.add(prefix);
                wpx.add(prefix);
            }
        } else if (row.kind === 'seq' && band && row.bucket) {
            seq.push({band, ts: row.bucket, seat: seat.seatOfRow(row)});
        }
    }

    if (!totalQso) {
        for (const entry of Object.values(bands)) totalQso += entry.q;
    }

    seq.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    return {
        bands,
        totalQso,
        totalPoints,
        pAvg: totalQso > 0 ? totalPoints / totalQso : 0,
        wpx,
        wpxTotal: wpx.size,
        multMode
    };
}

function bandChangeInfo(seq, now) {
    const hourStart = new Date(now);
    hourStart.setUTCMinutes(0, 0, 0);
    const hourMs = hourStart.getTime();
    let count = 0;
    let lastAt = null;
    let prev = null;
    for (const row of seq) {
        if (prev && row.band !== prev) {
            const ts = parseTs(row.ts);
            if (ts !== null) {
                lastAt = ts;
                if (ts >= hourMs) count += 1;
            }
        }
        prev = row.band;
    }
    return {count, lastAt};
}

/** 按席位分别计换波段：M2 两台交替记录不再互相污染。 */
function bandChangeInfoBySeat(seq, now) {
    const groups = new Map();
    for (const row of Array.isArray(seq) ? seq : []) {
        if (!row) continue;
        const key = row.seat || 'LOCAL:1';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    const out = {};
    for (const [key, list] of groups) out[key] = bandChangeInfo(list, now);
    return out;
}

function activitySnapshot(rows) {
    const series = {};
    const totals = {};
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || row.kind !== 'activity' || !row.band || !row.bucket) continue;
        const band = row.band;
        (series[band] = series[band] || []).push({
            bucket: row.bucket,
            spots: Number(row.qsos) || 0,
            calls: Number(row.points) || 0
        });
        const total = totals[band] || (totals[band] = {spots: 0, calls: 0});
        total.spots += Number(row.qsos) || 0;
        total.calls = Math.max(total.calls, Number(row.points) || 0);
    }
    for (const list of Object.values(series)) {
        list.sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
    }
    return {series, totals};
}

/**
 * @param {object} input
 * @param {object} input.settings  服务端已 sanitize 的设置
 * @param {Array}  input.rows      SQL union 行（kind=band|bucket|call|seq|activity）
 * @param {object} input.prop      propagation snapshot
 * @param {object} input.radio     {freqKhz, mode, isRunning, radioNr}
 * @param {object} input.score     {qsos, points, score, ts} 可选
 * @param {number} input.activeEntities 有效 DXCC 实体数
 * @param {object} input.cooldown  {ruleId: lastShownMs}
 * @param {Date}   input.now
 */
function buildAdvice(input) {
    const settings = input.settings || {};
    const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
    const cfg = thresholds(settings);
    const env = envBuilder.build(settings, input.prop || {}, now);
    const type = contestTypeOf(settings);
    const category = String(settings.category || 'SO1R').toUpperCase();
    const book = contestRules.constraintsFor(settings, type);

    // 优先级：设置页显式值 > 共享规则文件 > config.js 兜底。
    let multMode = settings.multMode || 'dxcc-per-band';
    if (multMode === 'dxcc-per-band' && book.multiplierCounting) multMode = book.multiplierCounting;

    let bandChangeRule = settings.bandChangeRule || 'none';
    let limit = Number(settings.bandChangeLimit) || 0;
    if (limit > 0 && bandChangeRule === 'none') bandChangeRule = 'hourly-quota';
    if (bandChangeRule === 'none' && book.bandChange) {
        bandChangeRule = book.bandChange.rule;
        if (bandChangeRule === 'hourly-quota' && !limit) {
            limit = Number(book.bandChange.limitPerHour) || 0;
        }
    }
    if (bandChangeRule === 'none' && category === 'MS' && type !== 'CQWW' && type !== 'CQ160') {
        bandChangeRule = 'hourly-quota';
    }
    if (!limit && bandChangeRule === 'hourly-quota') {
        limit = type === 'ARRL_DX' ? (category === 'M2' ? 6 : 10) : (category === 'M2' ? 8 : 10);
    }
    let msRole = settings.msRole || 'none';
    if (msRole === 'none' && book.multiplierStationRole) msRole = book.multiplierStationRole;

    const stats = buildStats(input.rows, multMode);
    const activity = activitySnapshot(input.rows);
    const seq = (input.rows || [])
        .filter(r => r && r.kind === 'seq')
        .map(r => ({band: r.band, ts: r.bucket, seat: seat.seatOfRow(r)}))
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const changesBySeat = bandChangeInfoBySeat(seq, now);
    const allChanges = bandChangeInfo(seq, now);

    const radios = input.radios && typeof input.radios === 'object' ? input.radios : {};
    const seatKeys = [...new Set([...Object.keys(radios), ...Object.keys(changesBySeat)])].sort();
    const requestedSeat = input.seat ? String(input.seat) : null;
    if (requestedSeat && !seatKeys.includes(requestedSeat)) seatKeys.push(requestedSeat);

    const remainingMin = (() => {
        const end = parseTs(settings.contestEnd);
        if (end === null) return null;
        return Math.max(0, Math.round((end - now.getTime()) / 60000));
    })();

    const contest = {
        type,
        category,
        multMode,
        bandChangeRule,
        limit,
        msRole,
        singleBand: settings.contestSingleBand || '',
        bands: book.bands,
        modes: book.modes,
        simultaneousSignals: book.simultaneousSignals,
        seatCount: Number(settings.seatCount) || 1,
        seatRadios: settings.seatRadios || '',
        rulesSource: book.source || null,
        ruleBook: book
    };

    const fallbackBand = () => Object.keys(stats.bands).sort((a, b) =>
        (parseTs(stats.bands[b].lastTs) || 0) - (parseTs(stats.bands[a].lastTs) || 0))[0] || null;

    const shapedRadio = value => {
        const radio = value || {};
        return {
            band: freqToBand(radio.freqKhz) || null,
            mode: String(radio.mode || '').toUpperCase() || null,
            isRunning: radio.isRunning,
            freqKhz: Number(radio.freqKhz) || null,
            radioNr: radio.radioNr || null,
            stationName: radio.stationName || null,
            opCall: radio.opCall || null,
            seat: radio.seat || null
        };
    };

    const minConfidence = CONFIDENCE_RANK[settings.adviceMinConfidence] !== undefined
        ? settings.adviceMinConfidence : 'low';
    const minRank = CONFIDENCE_RANK[minConfidence];
    const cooldown = Object.assign({}, input.cooldown || {});
    const multiSeat = seatKeys.length > 1;

    function evaluate(evalSeat, radioValue, changes) {
        const shaped = shapedRadio(radioValue);
        const currentBand = shaped.band || fallbackBand();
        const ctx = {
            now,
            settings,
            cfg,
            env,
            radio: shaped,
            powerClass: powerClassOf(settings),
            contest,
            stats,
            activity,
            multipliers: {activeEntities: Number(input.activeEntities) || null},
            bandChanges: changes,
            lastBandChangeAt: changes.lastAt,
            currentBand,
            remainingMin,
            seat: evalSeat,
            tau: cfg.tau[category] !== undefined ? cfg.tau[category] : cfg.tau.SO1R,
            deltaIn: cfg.deltaIn[category] !== undefined ? cfg.deltaIn[category] : cfg.deltaIn.SO1R,
            spBaseline: {rate: null}
        };

        ctx.gates = rules.gateState(ctx);

        const degraded = !stats.totalQso ? 'no-qsos' : null;
        const suggestions = [];
        if (!degraded) {
            for (const group of [rules.groupG, rules.groupR, rules.groupS, rules.groupB]) {
                try {
                    suggestions.push(...group(ctx));
                } catch (error) {
                    suggestions.push({
                        id: 'ENGINE', group: 'X', priority: 0, action: 'error',
                        title: {zh: '规则计算异常', en: 'Rule evaluation error'},
                        detail: {zh: String(error && error.message || error), en: String(error && error.message || error)},
                        confidence: 'low', strength: 'D', evidence: {}, missing: [], cooldownSec: 600
                    });
                }
            }
        }

        const kept = [];
        const suppressed = [];
        for (const advice of suggestions) {
            const key = multiSeat && evalSeat ? evalSeat + '|' + advice.id : advice.id;
            if (CONFIDENCE_RANK[advice.confidence] < minRank) {
                suppressed.push({id: advice.id, seat: evalSeat, reason: 'confidence'});
                continue;
            }
            const last = cooldown[key];
            if (Number.isFinite(last) && now.getTime() - last < (advice.cooldownSec || 600) * 1000) {
                suppressed.push({id: advice.id, seat: evalSeat, reason: 'cooldown'});
                continue;
            }
            cooldown[key] = now.getTime();
            kept.push(evalSeat ? Object.assign({}, advice, {seat: evalSeat}) : advice);
        }

        kept.sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));

        return {
            seat: evalSeat,
            degraded,
            radio: shaped,
            currentBand,
            changesThisHour: changes.count,
            lastBandChangeAt: changes.lastAt,
            gates: ctx.gates,
            advice: kept,
            suppressed
        };
    }

    const lastSeat = (input.radio && input.radio.seat) || requestedSeat ||
        (seatKeys.length === 1 ? seatKeys[0] : null);
    const selectedSeat = requestedSeat || lastSeat || null;
    const selectedRadio = (selectedSeat && radios[selectedSeat]) || input.radio || {};
    const selectedChanges = selectedSeat && changesBySeat[selectedSeat]
        ? changesBySeat[selectedSeat] : allChanges;
    const primary = evaluate(selectedSeat, selectedRadio, selectedChanges);

    const includeSeats = seatKeys.length > 1 || !!requestedSeat;
    const lanes = includeSeats ? seatKeys.map(key => key === selectedSeat
        ? primary
        : evaluate(key, radios[key] || {}, changesBySeat[key] || {count: 0, lastAt: null})) : [];

    const dependencies = {
        qsos: !!stats.totalQso,
        activity: Object.keys(activity.series).length > 0,
        multipliers: Number(input.activeEntities) > 0,
        radio: !!primary.radio.band,
        prop: env.available && env.sfi !== null,
        score: !!(input.score && Number(input.score.qsos) >= 0),
        events: false
    };

    const unavailable = [
        {id: 'R3', reason: 'no-cq-no-answer-events'},
        {id: 'R4', reason: 'no-cq-no-answer-events'},
        {id: 'R5', reason: 'no-dupe-events'},
        {id: 'R6', reason: 'no-qsy-events'},
        {id: 'S7', reason: 'no-sp-session-history'},
        {id: 'S8', reason: 'no-sprint-events'},
        {id: 'B2', reason: 'no-directional-muf'},
        {id: 'B5', reason: 'no-muf-window'},
        {id: 'G8', reason: 'no-frequency-sequence'}
    ];

    return {
        ok: true,
        engine: 'rules-v1',
        generatedAt: now.toISOString(),
        degraded: primary.degraded,
        seat: primary.seat,
        window: {
            from: settings.contestStart || null,
            to: settings.contestEnd || null,
            remainingMin
        },
        contest,
        environment: env,
        dependencies,
        gates: {
            blockBandChange: primary.gates.blockBandChange,
            blockReason: primary.gates.blockReason,
            lockRemainingMin: primary.gates.lockRemainingMin,
            quota: primary.gates.quota,
            quotaRemaining: primary.gates.quotaRemaining,
            changesThisHour: primary.gates.changesThisHour
        },
        currentBand: primary.currentBand,
        advice: primary.advice,
        suppressed: primary.suppressed,
        seats: lanes,
        unavailable,
        cooldown,
        bandsAvailable: BANDS.filter(b => stats.bands[b])
    };
}

module.exports = {
    buildAdvice, buildStats, bandChangeInfo, bandChangeInfoBySeat,
    activitySnapshot, freqToBand, contestTypeOf, powerClassOf
};
