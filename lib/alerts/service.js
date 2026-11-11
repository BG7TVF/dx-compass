'use strict';

const {modeGroup, loadResolver, parseBound} = require('../multipliers/service.js');
const {stateFor, PRIORITY, epochOf} = require('./rank.js');

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
        seat: upperList(source.seat !== undefined ? source.seat : source.seats),
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
        seat: text(row.seat).toUpperCase(),
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
 * 赛事窗口：当前比赛（contestStart/End）> 大屏计时器（wallTimerStart/End）>
 * 按 QSO 日志中最近一届赛事的首条/末条 QSO 推断。
 */
function windowFor(rows, settings) {
    const cfg = settings && typeof settings === 'object' ? settings : {};
    let from = parseBound(cfg.contestStart);
    let to = parseBound(cfg.contestEnd);
    let source = from !== null || to !== null ? 'contest' : 'none';
    if (from === null && to === null) {
        from = parseBound(cfg.wallTimerStart);
        to = parseBound(cfg.wallTimerEnd);
        if (from !== null || to !== null) source = 'settings';
    }
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

/* ---- 对手告警状态 -------------------------------------------------------
 * 每个对手按波段记录「最后一次 spot 的频率与时间」。新频率 / 新频段 / 换频段
 * 都相对这份记录判断，不再使用「新 SPOT」这种无状态提醒。
 * 记录保存在进程内存：Node-RED 单进程运行，重启后由实时 SPOT 重新建立。
 */
const DEFAULT_TTL_MIN = 30;
const HISTORY_RETENTION_SEC = 6 * 3600;
const historyByCall = new Map();

function resetHistory() {
    historyByCall.clear();
}

function ttlMinutes(settings, mode) {
    const raw = settings && settings.ttl;
    if (raw && typeof raw === 'object') {
        const value = Number(raw[modeGroup(mode)]);
        if (Number.isFinite(value)) return Math.min(180, Math.max(1, value));
        return DEFAULT_TTL_MIN;
    }
    const flat = Number(raw);
    return Number.isFinite(flat) ? Math.min(180, Math.max(1, flat)) : DEFAULT_TTL_MIN;
}

function ttlSeconds(settings, mode) {
    return ttlMinutes(settings, mode) * 60;
}

function expired(record, now, settings) {
    if (!record || !Number.isFinite(Number(record.at))) return true;
    return now - Number(record.at) > ttlSeconds(settings, record.mode);
}

function latestEntry(entries) {
    return entries.slice().sort((a, b) => Number(b.record.at || 0) - Number(a.record.at || 0))[0] || null;
}

/**
 * 对手告警分类。
 * - newFreq：同一波段，频率相对该波段的已有记录移动超过 freqDeltaKhz。
 * - newBand：换到另一波段，且原有波段记录仍在 TTL 内（多波段同时工作）。
 * - bandChange：换到另一波段，且原有（最近）波段记录已超出 TTL（真正离开旧波段）。
 * 同一波段、频率未超出阈值时返回 null（不提醒）。
 * 同一对手的「波段组合」在 alertDedupeMin 窗口内只提示一次，避免多波段来回跳。
 */
function classifyOpponent(history, context, settings) {
    const bands = history && history.bands && typeof history.bands === 'object' ? history.bands : {};
    const band = context.band || '?';
    const delta = Math.max(0, Number(settings && settings.freqDeltaKhz) || 0);
    const entries = Object.keys(bands)
        .filter(key => bands[key] && typeof bands[key] === 'object')
        .map(key => ({band: key, record: bands[key]}));
    const last = latestEntry(entries);
    let kind = null;
    let previous = null;
    if (last && last.band === band) {
        // 波段没变：只比较频率。
        previous = {band: last.band, freq: last.record.freq, at: iso(last.record.at),
            mode: last.record.mode || ''};
        const before = Number(last.record.freq);
        if (!Number.isFinite(before) || !Number.isFinite(context.freq) ||
            Math.abs(context.freq - before) > delta) kind = 'newFreq';
    } else if (!last) {
        // 从未记录过的对手：按新频段提示一次。
        kind = 'newBand';
    } else {
        // 波段变了：原有（最近）波段记录还在 TTL 内 → 新频段；已过期 → 换频段。
        previous = {band: last.band, freq: last.record.freq, at: iso(last.record.at),
            mode: last.record.mode || ''};
        kind = expired(last.record, context.now, settings) ? 'bandChange' : 'newBand';
    }
    const combo = [...new Set([
        ...entries.filter(entry => entry.band !== band &&
            !expired(entry.record, context.now, settings)).map(entry => entry.band),
        band
    ])].sort().join('+');
    if (kind && kind !== 'newFreq' && history && history.combo === combo) {
        const suppressSec = Math.max(60, (Number(settings && settings.alertDedupeMin) || 10) * 60);
        if (context.now - Number(history.comboAt || 0) < suppressSec) {
            return {kind: null, previous, combo, suppressed: 'band-combo'};
        }
    }
    return {kind, previous, combo, suppressed: null};
}

function rememberBand(history, context, settings) {
    const bands = Object.assign({}, history && history.bands);
    bands[context.band || '?'] = {
        freq: Number.isFinite(context.freq) ? context.freq : null,
        at: context.now,
        mode: context.mode || ''
    };
    const retention = Math.max(HISTORY_RETENTION_SEC, ttlSeconds(settings, context.mode) * 2);
    for (const [key, record] of Object.entries(bands)) {
        if (!record || !Number.isFinite(Number(record.at)) ||
            context.now - Number(record.at) > retention) {
            delete bands[key];
        }
    }
    return {
        bands,
        combo: history && history.combo ? history.combo : null,
        comboAt: history && Number(history.comboAt) ? Number(history.comboAt) : 0
    };
}

/**
 * 评估一个 SPOT。
 * state = {now, dedupe, lastAlertAt}；返回新的 dedupe / lastAlertAt，便于 flow 上下文回写。
 * opts.monitored 给出被监控呼号列表；opts.history 可注入对手状态（测试用）。
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

    // 我的 SPOT 由前端批量播报，服务端对手告警不重复处理。
    const myCall = String(settings.myCall || '').trim().toUpperCase();
    if (myCall && call === myCall) return {...base, reason: 'my-spot'};
    const monitored = Array.isArray(opts.monitored)
        ? opts.monitored.map(item => String(item || '').trim().toUpperCase()).filter(Boolean)
        : null;
    if (monitored && !monitored.includes(call)) return {...base, reason: 'not-monitored'};

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

    const injected = opts.history && typeof opts.history === 'object' ? opts.history : null;
    const history = (injected ? injected[call] : historyByCall.get(call)) || {};
    const classified = classifyOpponent(history, context, settings);
    const nextHistory = rememberBand(history, context, settings);
    if (classified.kind === 'newBand' || classified.kind === 'bandChange') {
        nextHistory.combo = classified.combo;
        nextHistory.comboAt = now;
    }
    if (injected) injected[call] = nextHistory;
    else historyByCall.set(call, nextHistory);
    if (!classified.kind) return {...base, reason: classified.suppressed || 'duplicate'};

    const rules = Array.isArray(opts.rules) ? opts.rules : [];
    const matched = rules.filter(rule => matchRule(rule, context));
    // 规则表只作为可选的附加过滤：没有规则时三类内置对手告警照常工作。
    if (rules.length && !matched.length) return {...base, reason: 'no-match'};

    const slot = stateFor(context.dxcc, context.band, opts.index);
    // 只要命中一条全局规则就保持全局广播；全部命中规则都有席位时才定向。
    const targeted = matched.length > 0 && matched.every(rule => Boolean(rule.seat));
    const seats = targeted ? [...new Set(matched.flatMap(rule => list(rule.seat).map(item => item.toUpperCase())))] : [];
    const candidate = {
        type: 'alert',
        kind: classified.kind,
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
        previous: classified.previous,
        seat: seats.join(','),
        seats,
        rules: matched.map(rule => ({id: rule.id, name: rule.name, seat: rule.seat || ''})),
        ruleNames: matched.map(rule => rule.name).join(', ')
    };
    // 被去重/节流的 SPOT 仍返回 hit（不通知），供命中原生聚合统计来源与次数。
    const suppressed = reason => Object.assign({}, candidate, {
        suppressed: reason,
        notified: false,
        notify: {popup: false, voice: false, sound: false}
    });

    const minInterval = Math.max(0, Number(settings.alertMinIntervalSec) || 0);
    if (lastAlertAt && now - lastAlertAt < minInterval) {
        return {...base, reason: 'throttled', hit: suppressed('throttled')};
    }

    // 没有规则行时使用设置里的通道开关；有规则行时由规则显式声明。
    const notify = {
        popup: (matched.length ? matched.some(rule => Number(rule.popup) === 1) : true) &&
            settings.alertPopup !== false,
        voice: (matched.length ? matched.some(rule => Number(rule.voice) === 1) : true) &&
            settings.qsoVoiceAlert !== false,
        sound: (matched.length ? matched.some(rule => Number(rule.sound) === 1) : false) &&
            settings.alertSound === true
    };
    const alert = Object.assign({}, candidate, {suppressed: null, notified: true, notify});
    return {alert, dedupe, lastAlertAt: now, reason: 'alert', history: nextHistory};
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
    classifyOpponent,
    resetHistory,
    evaluate,
    pruneDedupe,
    spotWpm,
    modeGroup
};
