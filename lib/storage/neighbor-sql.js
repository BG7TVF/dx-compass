'use strict';

const {esc} = require('./sql.js');

/**
 * 邻台注册表查询。表由 spots 的 AFTER INSERT 触发器实时维护，
 * 这里只负责按本台大网格取出“当前活跃”的邻台：最近 30 分钟内有过报告。
 * 不做任何历史回填，避免把几个月前的台当成当前邻台。
 */

const DEFAULT_TTL_MINUTES = 30;
/** 物理清理留一点边界余量，删 60 分钟前的行。 */
const PURGE_MINUTES = 60;
const DEFAULT_LIMIT = 240;

function freshQuery(grid4, rawMinutes, rawLimit) {
    const g = String(grid4 || '').trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}$/.test(g)) return 'SELECT * FROM neighbors WHERE 1=0;';
    const minutes = Math.min(1440, Math.max(1, parseInt(rawMinutes, 10) || DEFAULT_TTL_MINUTES));
    const limit = Math.min(500, Math.max(1, parseInt(rawLimit, 10) || DEFAULT_LIMIT));
    return 'SELECT call, grid4, first_seen, last_seen, reports FROM neighbors' +
        ' WHERE grid4 = ' + esc(g) +
        " AND datetime(last_seen) >= datetime('now', '-" + minutes + " minutes')" +
        ' ORDER BY datetime(last_seen) DESC LIMIT ' + limit + ';';
}

/** 清理长期未出现的邻台；由既有 retention/purge 任务调用，不另起定时器。 */
function purge(rawMinutes) {
    const minutes = Math.min(1440, Math.max(1, parseInt(rawMinutes, 10) || PURGE_MINUTES));
    return "DELETE FROM neighbors WHERE datetime(last_seen) < datetime('now', '-" +
        minutes + " minutes');";
}

function clear() {
    return 'DELETE FROM neighbors;';
}

module.exports = {
    DEFAULT_TTL_MINUTES, PURGE_MINUTES, DEFAULT_LIMIT,
    freshQuery, purge, clear
};
