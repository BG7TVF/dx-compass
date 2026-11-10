'use strict';

/**
 * 告警优先级与去重键。
 *
 * 排序（数值越小越优先）：
 *   0 newMultiplier —— 本届赛事窗口内还没通过该 DXCC
 *   1 newBand        —— 本届已通 DXCC，但该波段尚未通
 *   2 rare/unknown   —— 已通联的旧格，但实体已删除；或呼号无法解析（保守视为稀有）
 *   3 other          —— 往届旧格
 *
 * 去重键：call|band（同一条 SPOT 在不同来源重复出现时折叠为一条）。
 * 频率容差：同一 call|band 下，|新频率 - 上次频率| <= freqDeltaKhz 视为同一格；
 * 超出容差则允许再次提醒（换频）。
 */

const PRIORITY = {newMultiplier: 0, newBand: 1, rare: 2, unknown: 2, other: 3};

function normalizeBand(raw) {
    return String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase() || '?';
}

function epochOf(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function emptyIndex() {
    return {loaded: false, window: null, windowDxcc: new Set(), windowSlots: new Set(), deleted: new Set()};
}

/** 用 qsos 快照构建“本届已通”索引；windowFrom / windowTo 为 epoch 秒。 */
function buildIndex(rows, resolveCall, windowFrom, windowTo) {
    const index = emptyIndex();
    index.loaded = true;
    index.window = Number.isFinite(windowFrom) ? windowFrom : null;
    const until = Number.isFinite(windowTo) ? windowTo : null;
    for (const row of Array.isArray(rows) ? rows : []) {
        const call = String((row && row.call) || '').trim().toUpperCase();
        const ts = epochOf(row && row.timestamp);
        if (!call || ts === null) continue;
        if (index.window !== null && ts < index.window) continue;
        if (until !== null && ts > until) continue;
        const resolved = typeof resolveCall === 'function' ? resolveCall(call) : null;
        if (!resolved || !Number.isFinite(resolved.dxcc)) continue;
        const band = normalizeBand(row.band);
        index.windowDxcc.add(resolved.dxcc);
        index.windowSlots.add(`${resolved.dxcc}|${band}`);
        if (resolved.deleted === true) index.deleted.add(resolved.dxcc);
    }
    return index;
}

function stateFor(dxcc, band, index) {
    if (!Number.isFinite(dxcc)) return {state: 'unknown', priority: PRIORITY.unknown};
    if (!index || !index.loaded) return {state: 'unknown', priority: PRIORITY.unknown};
    if (!index.windowDxcc.has(dxcc)) return {state: 'newMultiplier', priority: PRIORITY.newMultiplier};
    if (!index.windowSlots.has(`${dxcc}|${normalizeBand(band)}`)) {
        return {state: 'newBand', priority: PRIORITY.newBand};
    }
    if (index.deleted.has(dxcc)) return {state: 'rare', priority: PRIORITY.rare};
    return {state: 'other', priority: PRIORITY.other};
}

function dedupeKey(call, band) {
    return `${String(call || '').trim().toUpperCase()}|${normalizeBand(band)}`;
}

/** 同一 call|band 且频率差在容差内视为重复；任一方没有频率时按重复处理。 */
function isDuplicate(previous, freq, toleranceKhz) {
    if (!previous) return false;
    const previousFreq = previous.freq === null || previous.freq === undefined || previous.freq === ''
        ? NaN : Number(previous.freq);
    const nextFreq = freq === null || freq === undefined || freq === '' ? NaN : Number(freq);
    if (!Number.isFinite(previousFreq) || !Number.isFinite(nextFreq)) return true;
    return Math.abs(nextFreq - previousFreq) <= Math.max(0, Number(toleranceKhz) || 0);
}

/** 排序规则（固定，便于调参）：优先级升序，其次时间新者在前。 */
function priorityOf(value) {
    const number = Number(value && value.priority);
    return Number.isFinite(number) ? number : PRIORITY.other;
}

function compareAlerts(a, b) {
    const priority = priorityOf(a) - priorityOf(b);
    if (priority) return priority;
    return (epochOf(b && b.at) || 0) - (epochOf(a && a.at) || 0);
}

function rankAlerts(alerts) {
    return (Array.isArray(alerts) ? alerts : []).slice().sort(compareAlerts);
}

/**
 * 写入一条命中：同一 call|band 在窗口内合并为一条，累计上报次数与来源。
 * 去重窗口内只有第一条（notified=true）真正通知，后续作为 suppressed 统计。
 */
function recordHit(hits, entry, cap, windowSec, now) {
    const list = Array.isArray(hits) ? hits.slice() : [];
    if (!entry) return list;
    const ttl = Math.max(60, Number(windowSec) || 600);
    const current = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
    const key = dedupeKey(entry.call, entry.band);
    const at = epochOf(entry.at);
    const index = list.findIndex(item => dedupeKey(item.call, item.band) === key &&
        at !== null && current - (epochOf(item.at) || 0) <= ttl);
    if (index < 0) {
        list.unshift(Object.assign({}, entry, {
            reports: 1,
            sources: entry.source ? [entry.source] : []
        }));
        return list.slice(0, Math.max(1, Number(cap) || 50));
    }
    const group = list[index];
    group.reports = (Number(group.reports) || 1) + 1;
    const source = String(entry.source || '').trim().toLowerCase();
    if (source && !group.sources.includes(source)) group.sources.push(source);
    group.notified = Boolean(group.notified) || Boolean(entry.notified);
    for (const rule of Array.isArray(entry.rules) ? entry.rules : []) {
        if (!group.rules.some(item => item.id === rule.id && item.name === rule.name)) group.rules.push(rule);
    }
    group.ruleNames = group.rules.map(rule => rule.name).join(', ');
    if ((epochOf(entry.at) || 0) >= (epochOf(group.at) || 0)) {
        group.at = entry.at;
        group.freq = entry.freq;
        group.snr = entry.snr;
        group.state = entry.state;
        group.mode = entry.mode;
    }
    if (priorityOf(entry) < priorityOf(group)) group.priority = priorityOf(entry);
    return list.slice(0, Math.max(1, Number(cap) || 50));
}

module.exports = {
    PRIORITY,
    buildIndex,
    stateFor,
    dedupeKey,
    isDuplicate,
    compareAlerts,
    rankAlerts,
    recordHit,
    normalizeBand,
    epochOf
};
