'use strict';

const {analyzePaths, NEIGHBOR_TTL_MINUTES, clampWindowMinutes} = require('./paths.js');
const {pathQuery, emptyQuery} = require('../storage/spot-sql.js');
const {freshQuery} = require('../storage/neighbor-sql.js');
const {runtime, getCallsigns} = require('../settings/service.js');
const {largeGridFrom} = require('../radio/maidenhead.js');
const {formatUtc, parseTime} = require('./service.js');

/**
 * CW/SSB 可通性接口的服务层（全自动，无目标呼号）。
 *
 * 两段查询：
 *  1. prepare  → 邻台注册表查询（neighbors，带时效）；
 *  2. prepareSpots → 报告查询（spots，限时间窗与大网格）。
 * 主体分类、双向口径、区域聚合全部在 paths.js 的 analyzePaths 内，
 * Node-RED function 节点只做转发。
 *
 * 默认回看 6 小时；调用方可用 ?hours=N 覆盖（OP 视图传 2 小时）。回看范围才是
 * 实时性的主开关，聚合窗口只决定分桶粒度。
 */

const DEFAULT_HOURS = 6;
const MAX_HOURS = 24;
const DEFAULT_LIMIT = 50000;
const MAX_NEIGHBORS = 240;

function prepare(query, global) {
    const cfg = runtime(global);
    const myCall = String(cfg.myCall || '').trim().toUpperCase();
    const myGrid = String(cfg.grid || '').trim().toUpperCase();
    const grid4 = largeGridFrom(myGrid);
    if (!myCall) {
        return {ok: false, error: 'call-required', neighborSql: emptyQuery(), sql: emptyQuery(),
            request: null};
    }
    if (!grid4) {
        return {ok: false, error: 'grid-required', neighborSql: emptyQuery(), sql: emptyQuery(),
            request: null};
    }
    const now = Math.floor(Date.now() / 1000);
    const to = parseTime(query && query.to) || formatUtc(now);
    // 回看范围按调用方传入的 hours 生效（OP 视图传 2 小时），缺省 6 小时。
    const hours = Math.min(MAX_HOURS, Math.max(1, Number(query && query.hours) || DEFAULT_HOURS));
    const from = parseTime(query && query.from) || formatUtc(now - hours * 3600);
    const limit = Number(query && query.limit) || DEFAULT_LIMIT;
    const windowMinutes = clampWindowMinutes(cfg.pskWindowMin);
    const monitored = getCallsigns(global)
        .map(c => String(c).trim().toUpperCase()).filter(Boolean);
    return {
        ok: true,
        error: null,
        neighborSql: freshQuery(grid4, NEIGHBOR_TTL_MINUTES, MAX_NEIGHBORS),
        sql: pathQuery({myCall, monitored, grid4, from, to, rawLimit: limit}),
        request: {
            myCall, myGrid, grid4, monitored, from, to, limit,
            windowMinutes,
            txPowerW: cfg.txPowerW,
            neighborTtlMinutes: NEIGHBOR_TTL_MINUTES
        }
    };
}

/** 把邻台查询结果并入请求，再产出报告查询。邻台为空时照常查询。 */
function prepareSpots(prepared, neighborRows) {
    if (!prepared || !prepared.ok) {
        return {sql: emptyQuery(), request: (prepared && prepared.request) || null};
    }
    const neighbors = (Array.isArray(neighborRows) ? neighborRows : []).map(item => ({
        call: item.call,
        grid4: item.grid4,
        firstSeen: item.first_seen || item.firstSeen || null,
        lastSeen: item.last_seen || item.lastSeen || null,
        reports: item.reports
    }));
    return {sql: prepared.sql, request: {...prepared.request, neighbors}};
}

function complete(prepared, rows) {
    if (!prepared || !prepared.ok) {
        return {ok: false, error: (prepared && prepared.error) || 'invalid-request'};
    }
    const request = prepared.request;
    const result = analyzePaths({
        rows: Array.isArray(rows) ? rows : [],
        myCall: request.myCall,
        myGrid: request.myGrid,
        monitored: request.monitored,
        txPowerW: request.txPowerW,
        windowMinutes: request.windowMinutes,
        neighbors: request.neighbors,
        neighborTtlMinutes: request.neighborTtlMinutes
    });
    if (result.ok) {
        result.window = {from: request.from, to: request.to, minutes: result.windowMinutes};
        result.generatedAt = new Date().toISOString();
        result.neighborTtlMinutes = request.neighborTtlMinutes || NEIGHBOR_TTL_MINUTES;
    }
    return result;
}

function allowedWindowHours() {
    return {defaultHours: DEFAULT_HOURS, maxHours: MAX_HOURS};
}

module.exports = {
    DEFAULT_HOURS, MAX_HOURS, DEFAULT_LIMIT,
    prepare, prepareSpots, complete, allowedWindowHours
};
