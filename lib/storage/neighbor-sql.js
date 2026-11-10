'use strict';

const {esc} = require('./sql.js');

/**
 * 邻台注册表查询。表由 spots 的 AFTER INSERT 触发器维护，
 * 这里只负责按本台大网格与时效取出“仍然有效”的邻台。
 */

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_LIMIT = 240;

function freshQuery(grid4, rawDays, rawLimit) {
    const g = String(grid4 || '').trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}$/.test(g)) return 'SELECT * FROM neighbors WHERE 1=0;';
    const days = Math.min(365, Math.max(1, parseInt(rawDays, 10) || DEFAULT_TTL_DAYS));
    const limit = Math.min(500, Math.max(1, parseInt(rawLimit, 10) || DEFAULT_LIMIT));
    return 'SELECT call, grid4, first_seen, last_seen, reports FROM neighbors' +
        ' WHERE grid4 = ' + esc(g) +
        " AND datetime(last_seen) >= datetime('now', '-" + days + " days')" +
        ' ORDER BY datetime(last_seen) DESC LIMIT ' + limit + ';';
}

/** 清理长期未出现的邻台，防止表无限增长。 */
function purge(rawDays) {
    const days = Math.min(3650, Math.max(1, parseInt(rawDays, 10) || DEFAULT_TTL_DAYS));
    return "DELETE FROM neighbors WHERE datetime(last_seen) < datetime('now', '-" +
        days + " days');";
}

function clear() {
    return 'DELETE FROM neighbors;';
}

module.exports = {DEFAULT_TTL_DAYS, DEFAULT_LIMIT, freshQuery, purge, clear};
