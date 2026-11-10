'use strict';

const {analyzePaths, DEFAULT_WINDOW_MINUTES} = require('./paths.js');
const {pathQuery, emptyQuery} = require('../storage/spot-sql.js');
const {runtime, getCallsigns} = require('../settings/service.js');
const {largeGridFrom} = require('../radio/maidenhead.js');
const {formatUtc, parseTime} = require('./service.js');

/**
 * CW/SSB 可通性接口的服务层。
 *
 * 查询范围收敛在 SQL 里（本台 / 监控呼号 / 本台大网格），主体分类与双向口径
 * 全部在 paths.js 的 analyzePaths 内，Node-RED function 节点只做转发。
 * 默认回看 6 小时：足以覆盖多个 15 分钟窗口，又不至于把不同传播时段混在一起。
 */

const DEFAULT_HOURS = 6;
const MAX_HOURS = 24;
const DEFAULT_LIMIT = 50000;

function prepare(query, global) {
    const cfg = runtime(global);
    const myCall = String(cfg.myCall || '').trim().toUpperCase();
    const myGrid = String(cfg.grid || '').trim().toUpperCase();
    const grid4 = largeGridFrom(myGrid);
    if (!myCall) {
        return {ok: false, error: 'call-required', sql: emptyQuery(), request: null};
    }
    if (!grid4) {
        return {ok: false, error: 'grid-required', sql: emptyQuery(), request: null};
    }
    const now = Math.floor(Date.now() / 1000);
    const to = parseTime(query && query.to) || formatUtc(now);
    const from = parseTime(query && query.from) || formatUtc(now - DEFAULT_HOURS * 3600);
    const limit = Number(query && query.limit) || DEFAULT_LIMIT;
    const windowMinutes = String(cfg.pskWindowMin) === '30' ? 30 : DEFAULT_WINDOW_MINUTES;
    const monitored = getCallsigns(global)
        .map(c => String(c).trim().toUpperCase()).filter(Boolean);
    return {
        ok: true,
        error: null,
        sql: pathQuery({myCall, monitored, grid4, from, to, rawLimit: limit}),
        request: {
            myCall, myGrid, grid4, monitored, from, to, limit,
            windowMinutes,
            txPowerW: cfg.txPowerW,
            txPowerOverrides: cfg.txPowerOverrides
        }
    };
}

function complete(prepared, rows) {
    if (!prepared || !prepared.ok) {
        return {ok: false, error: (prepared && prepared.error) || 'invalid-request'};
    }
    const request = prepared.request;
    return analyzePaths({
        rows: Array.isArray(rows) ? rows : [],
        myCall: request.myCall,
        myGrid: request.myGrid,
        monitored: request.monitored,
        txPowerW: request.txPowerW,
        txPowerOverrides: request.txPowerOverrides,
        windowMinutes: request.windowMinutes
    });
}

function allowedWindowHours() {
    return {defaultHours: DEFAULT_HOURS, maxHours: MAX_HOURS};
}

module.exports = {
    DEFAULT_HOURS, MAX_HOURS, DEFAULT_LIMIT,
    prepare, complete, allowedWindowHours
};
