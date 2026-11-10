'use strict';

const {estimateTarget} = require('./estimate.js');
const {loadReferences} = require('./references.js');
const {analysisQuery, emptyQuery} = require('../storage/spot-sql.js');

/**
 * 分析研判接口的服务层。
 *
 * Node-RED 的 function 节点只做转发，SQL 组装与估算都在这里，便于单元测试。
 * 时间窗默认最近 24 小时；超过 7 天只告警不阻断（estimateTarget 会给出
 * window-too-long），避免用户把不同季节的数据混在一起。
 */

const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;

function pad(value) {
    return String(value).padStart(2, '0');
}

/** SQLite datetime() 接受的 'YYYY-MM-DD HH:MM:SS'（UTC）。 */
function formatUtc(epochSeconds) {
    const d = new Date(epochSeconds * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 接受 ISO / 'YYYY-MM-DD HH:MM' / 纯日期；非法值返回 null。 */
function parseTime(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? formatUtc(value > 1e12 ? Math.floor(value / 1000) : value) : null;
    }
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
    const iso = /Z$|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? formatUtc(Math.floor(ms / 1000)) : null;
}

function prepare(query, table) {
    const refs = table || loadReferences();
    const call = String((query && query.call) || '').trim().toUpperCase();
    if (!call) {
        return {
            ok: false,
            error: 'call-required',
            sql: emptyQuery(),
            request: null,
            table: refs
        };
    }
    const now = Math.floor(Date.now() / 1000);
    const to = parseTime(query.to) || formatUtc(now);
    const from = parseTime(query.from) || formatUtc(now - DEFAULT_HOURS * 3600);
    const limit = Number(query.limit) || 20000;
    const refCalls = (refs.references || []).map(ref => ref.call);
    const sql = analysisQuery(call, from, to, limit, refCalls);
    return {
        ok: true,
        error: null,
        sql,
        table: refs,
        request: {call, from, to, limit, refCalls}
    };
}

function complete(prepared, rows) {
    if (!prepared || !prepared.ok) {
        return {error: (prepared && prepared.error) || 'invalid-request'};
    }
    return estimateTarget({
        call: prepared.request.call,
        rows: Array.isArray(rows) ? rows : [],
        from: prepared.request.from,
        to: prepared.request.to,
        references: prepared.table
    });
}

function allowedWindowHours() {
    return {defaultHours: DEFAULT_HOURS, maxHours: MAX_HOURS};
}

module.exports = {DEFAULT_HOURS, MAX_HOURS, parseTime, formatUtc, prepare, complete, allowedWindowHours};
