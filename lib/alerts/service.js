'use strict';

const {modeGroup, loadResolver, parseBound} = require('../multipliers/service.js');
const {stateFor, dedupeKey, isDuplicate, PRIORITY, epochOf} = require('./rank.js');

let resolverPromise = null;

/** 复用 multipliers 的 callsign 解析器（CJS 动态 import ESM，只加载一次）。 */
function resolver() {
    if (!resolverPromise) {
        resolverPromise = loadResolver().then(mod => call => mod.resolveCall(call));
    }
    return resolverPromise;
}

/**
 * 条件组合告警。
 *
 * 一条规则内的正向条件全部 AND；同一字段的逗号列表内部 OR。
 * 负向条件（notCall / notDxcc / notBand / notMode / notSource）命中任意一条即排除。
 * 规则至少要有一个正向条件，避免空规则匹配所有 SPOT。
 */

function text(value) {
    return String(value === null || value === undefined ? '' : value).trim();
}

function list(value) {
    return text(value).split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function upperList(value) {
    return [...new Set(list(value).map(item => item.toUpperCase()))].join(',');
}

function lowerList(value) {
    return [...new Set(list(value).map(item => item.toLowerCase()))].join(',');
}

function numberList(value) {
    return [...new Set(list(value).map(Number).filter(Number.isFinite))].join(',');
}

function intOrNull(value, min, max) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(max, Math.max(min, parsed));
}

function realOrNull(value, min, max) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(max, Math.max(min, parsed));
}

function bool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function timeOrNull(value) {
    const raw = text(value);
    if (!raw) return null;
    const epoch = epochOf(raw);
    return epoch === null ? null : new Date(epoch * 1000).toISOString();
}

function hasPositiveCondition(rule) {
    return Boolean(rule.call || rule.prefix || rule.dxcc || rule.cqZone || rule.ituZone ||
        rule.band || rule.mode || rule.source || rule.from || rule.to ||
        rule.snrMin !== null || rule.snrMax !== null ||
        rule.wpmMin !== null || rule.wpmMax !== null);
}

/** 规范化 API 输入；返回 {ok, error, rule}。 */
function normalizeRule(input) {
    const source = input && typeof input === 'object' ? input : {};
    const rule = {
        id: intOrNull(source.id, 1, 999999),
        name: text(source.name).slice(0, 60),
        enabled: bool(source.enabled, 1),
        call: upperList(source.call),
        prefix: upperList(source.prefix),
        dxcc: numberList(source.dxcc),
        cqZone: numberList(source.cqZone),
        ituZone: numberList(source.ituZone),
        band: lowerList(source.band),
        mode: upperList(source.mode),
        source: lowerList(source.source),
        from: timeOrNull(source.from),
        to: timeOrNull(source.to),
        snrMin: realOrNull(source.snrMin, -40, 60),
        snrMax: realOrNull(source.snrMax, -40, 60),
        wpmMin: intOrNull(source.wpmMin, 1, 100),
        wpmMax: intOrNull(source.wpmMax, 1, 100),
        notCall: upperList(source.notCall),
        notDxcc: numberList(source.notDxcc),
        notBand: lowerList(source.notBand),
        notMode: upperList(source.notMode),
        notSource: lowerList(source.notSource),
        popup: bool(source.popup, 1),
        voice: bool(source.voice, 0),
        sound: bool(source.sound, 1)
    };
    if (!rule.name) return {ok: false, error: 'name-required', rule};
    if (!hasPositiveCondition(rule)) return {ok: false, error: 'condition-required', rule};
    return {ok: true, error: null, rule};
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** alert_rules 行（snake_case）→ 规则对象（camelCase），供匹配与 API 复用。 */
function fromRow(row) {
    if (!row || typeof row !== 'object') return null;
    return {
        id: Number(row.id) || null,
        name: text(row.name),
        enabled: Number(row.enabled) === 0 ? 0 : 1,
        call: text(row.call),
        prefix: text(row.prefix),
        dxcc: text(row.dxcc),
        cqZone: text(row.cq_zone),
        ituZone: text(row.itu_zone),
        band: text(row.band),
        mode: text(row.mode),
        source: text(row.source),
        from: text(row.from_ts),
        to: text(row.to_ts),
        snrMin: numberOrNull(row.snr_min),
        snrMax: numberOrNull(row.snr_max),
        wpmMin: numberOrNull(row.wpm_min),
        wpmMax: numberOrNull(row.wpm_max),
        notCall: text(row.not_call),
        notDxcc: text(row.not_dxcc),
        notBand: text(row.not_band),
        notMode: text(row.not_mode),
        notSource: text(row.not_source),
        popup: Number(row.popup) === 0 ? 0 : 1,
        voice: Number(row.voice) === 1 ? 1 : 0,
        sound: Number(row.sound) === 0 ? 0 : 1
    };
}

/**
 * 赛事窗口：优先使用现有设置（wallTimerStart/End，UTC），
 * 未设置时按 QSO 日志中最近一届赛事的首条/末条 QSO 推断。
 */
function windowFor(rows, settings) {
    const cfg = settings && typeof settings === 'object' ? settings : {};
    let from = parseBound(cfg.wallTimerStart);
    let to = parseBound(cfg.wallTimerEnd);
    let source = from !== null || to !== null ? 'settings' : 'none';
    let contest = null;
    if (from === null && to === null) {
        let latest = null;
        for (const row of Array.isArray(rows) ? rows : []) {
            const ts = epochOf(row && row.timestamp);
            const name = text(row && row.contestname).toUpperCase();
            if (ts === null || !name) continue;
            if (!latest || ts > latest.ts) latest = {ts, name};
        }
        if (latest) {
            contest = latest.name;
            for (const row of rows) {
                if (text(row && row.contestname).toUpperCase() !== contest) continue;
                const ts = epochOf(row && row.timestamp);
                if (ts === null) continue;
                if (from === null || ts < from) from = ts;
                if (to === null || ts > to) to = ts;
            }
            source = 'derived';
        }
    }
    return {from, to, contest, source};
}

function listMatch(rawList, value, transform) {
    const items = list(rawList);
    if (!items.length) return true;
    if (value === null || value === undefined || value === '') return false;
    const target = transform ? transform(value) : String(value);
    return items.some(item => {
        const expected = transform ? transform(item) : item;
        if (expected.endsWith('*')) return target.startsWith(expected.slice(0, -1));
        return target === expected;
    });
}

function callMatch(rawList, call) {
    const items = list(rawList);
    if (!items.length) return true;
    if (!call) return false;
    return items.some(item => {
        const expected = item.toUpperCase();
        return expected.endsWith('*') ? call.startsWith(expected.slice(0, -1)) : call === expected;
    });
}

function prefixMatch(rawList, call, prefix) {
    const items = list(rawList);
    if (!items.length) return true;
    if (!call) return false;
    return items.some(item => {
        const expected = item.toUpperCase();
        return call.startsWith(expected) || String(prefix || '').toUpperCase() === expected;
    });
}

function numberMatch(rawList, value) {
    const items = list(rawList).map(Number).filter(Number.isFinite);
    if (!items.length) return true;
    return Number.isFinite(Number(value)) && items.includes(Number(value));
}

function spotWpm(spot) {
    const match = String((spot && spot.comment) || '').match(/CW\s+(\d+)\s*WPM/i);
    return match ? parseInt(match[1], 10) : null;
}

function inTimeWindow(rule, now) {
    if (rule.from) {
        const from = epochOf(rule.from);
        if (from !== null && now < from) return false;
    }
    if (rule.to) {
        const to = epochOf(rule.to);
        if (to !== null && now > to) return false;
    }
    return true;
}

/** 单条规则的匹配；返回 true 表示命中。 */
function matchRule(rule, context) {
    if (!rule || Number(rule.enabled) === 0) return false;
    if (!inTimeWindow(rule, context.now)) return false;

    if (!callMatch(rule.call, context.call)) return false;
    if (!prefixMatch(rule.prefix, context.call, context.prefix)) return false;
    if (!numberMatch(rule.dxcc, context.dxcc)) return false;
    if (!numberMatch(rule.cqZone, context.cqZone)) return false;
    if (!numberMatch(rule.ituZone, context.ituZone)) return false;
    if (!listMatch(rule.band, context.band, value => String(value).toLowerCase())) return false;
    if (!listMatch(rule.mode, context.mode, value => String(value).toUpperCase())) return false;
    if (!listMatch(rule.source, context.source, value => String(value).toLowerCase())) return false;

    if (rule.snrMin !== null) {
        if (!Number.isFinite(context.snr) || context.snr < rule.snrMin) return false;
    }
    if (rule.snrMax !== null) {
        if (!Number.isFinite(context.snr) || context.snr > rule.snrMax) return false;
    }
    if (rule.wpmMin !== null) {
        if (!Number.isFinite(context.wpm) || context.wpm < rule.wpmMin) return false;
    }
    if (rule.wpmMax !== null) {
        if (!Number.isFinite(context.wpm) || context.wpm > rule.wpmMax) return false;
    }

    // 负向条件：命中任意一条即排除。
    if (rule.notCall && callMatch(rule.notCall, context.call)) return false;
    if (rule.notDxcc && numberMatch(rule.notDxcc, context.dxcc)) return false;
    if (rule.notBand && listMatch(rule.notBand, context.band, value => String(value).toLowerCase())) return false;
    if (rule.notMode && listMatch(rule.notMode, context.mode, value => String(value).toUpperCase())) return false;
    if (rule.notSource && listMatch(rule.notSource, context.source, value => String(value).toLowerCase())) return false;
    return true;
}

function iso(epochSeconds) {
    return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null;
}

/**
 * 评估一个 SPOT。
 * state = {now, dedupe, lastAlertAt}；返回新的 dedupe / lastAlertAt，便于 flow 上下文回写。
 */
function evaluate(spot, options) {
    const opts = options || {};
    const settings = opts.settings || {};
    const state = opts.state || {};
    const now = Number.isFinite(state.now) ? state.now : Math.floor(Date.now() / 1000);
    const dedupe = state.dedupe && typeof state.dedupe === 'object' ? state.dedupe : {};
    const lastAlertAt = Number(state.lastAlertAt) || 0;
    const base = {alert: null, dedupe, lastAlertAt, reason: null};

    if (settings.alertsEnabled !== true) return {...base, reason: 'disabled'};
    const call = String((spot && (spot.spot_call || spot.monitored_call || spot.call)) || '').trim().toUpperCase();
    if (!call) return {...base, reason: 'no-call'};

    const resolved = typeof opts.resolve === 'function' ? opts.resolve(call) : null;
    const freqRaw = spot && spot.freq;
    const snrRaw = spot && spot.snr;
    const context = {
        now,
        call,
        band: String((spot && spot.band) || '').trim().toLowerCase(),
        mode: String((spot && spot.mode) || '').trim().toUpperCase(),
        source: String((spot && spot.source) || '').trim().toLowerCase(),
        freq: freqRaw === null || freqRaw === undefined || freqRaw === '' ? NaN : Number(freqRaw),
        snr: snrRaw === null || snrRaw === undefined || snrRaw === '' ? NaN : Number(snrRaw),
        wpm: spotWpm(spot),
        dxcc: resolved && Number.isFinite(resolved.dxcc) ? resolved.dxcc : null,
        prefix: (resolved && resolved.prefix) || ''
    };
    if (!Number.isFinite(context.freq)) context.freq = null;
    if (!Number.isFinite(context.snr)) context.snr = null;

    const rules = Array.isArray(opts.rules) ? opts.rules : [];
    const matched = rules.filter(rule => matchRule(rule, context));
    if (!matched.length) return {...base, reason: 'no-match'};

    const windowSec = Math.max(60, (Number(settings.alertDedupeMin) || 10) * 60);
    const key = dedupeKey(call, context.band);
    const previous = dedupe[key];
    if (previous && now - Number(previous.at || 0) < windowSec &&
        isDuplicate(previous, context.freq, settings.freqDeltaKhz)) {
        return {...base, reason: 'duplicate'};
    }

    const minInterval = Math.max(0, Number(settings.alertMinIntervalSec) || 0);
    if (lastAlertAt && now - lastAlertAt < minInterval) {
        return {...base, reason: 'throttled'};
    }

    const slot = stateFor(context.dxcc, context.band, opts.index);
    const voiceGate = settings.qsoVoiceAlert === true &&
        (slot.state === 'newMultiplier' || slot.state === 'newBand' || settings.alertVoiceRepeats === true);
    const notify = {
        popup: matched.some(rule => Number(rule.popup) === 1) && settings.alertPopup !== false,
        voice: matched.some(rule => Number(rule.voice) === 1) && voiceGate,
        sound: matched.some(rule => Number(rule.sound) === 1) && settings.alertSound === true
    };

    const alert = {
        type: 'alert',
        at: iso(now),
        call,
        band: context.band,
        mode: context.mode,
        freq: context.freq,
        snr: context.snr,
        de: String((spot && spot.de) || '').trim().toUpperCase(),
        source: context.source,
        dxcc: context.dxcc,
        country: (resolved && resolved.country) || '',
        state: slot.state,
        priority: slot.priority,
        rules: matched.map(rule => ({id: rule.id, name: rule.name})),
        ruleNames: matched.map(rule => rule.name).join(', '),
        notify
    };

    const nextDedupe = {...dedupe};
    nextDedupe[key] = {at: now, freq: context.freq};
    return {alert, dedupe: nextDedupe, lastAlertAt: now, reason: 'alert'};
}

function pruneDedupe(dedupe, now, windowSec) {
    const out = {};
    const ttl = Math.max(3600, Number(windowSec) || 3600);
    for (const [key, value] of Object.entries(dedupe || {})) {
        if (Number(value && value.at) >= now - ttl) out[key] = value;
    }
    return out;
}

module.exports = {
    PRIORITY,
    normalizeRule,
    fromRow,
    windowFor,
    resolver,
    matchRule,
    evaluate,
    pruneDedupe,
    spotWpm,
    modeGroup
};
