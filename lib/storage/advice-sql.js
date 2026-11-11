'use strict';

/**
 * /api/advice 的读侧 SQL：一次 UNION ALL 取齐 QSO、10 分钟桶、波段序列、
 * 波段活跃度（WPX 计法时再取呼号）。服务层只做拼装与纯函数计算。
 */

const MULTI_CALL_MODES = new Set(['wpx']);

function iso(ms) {
    return new Date(ms).toISOString();
}

function parseBound(value) {
    if (!value) return null;
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
}

function escapeLiteral(value) {
    return String(value).replace(/'/g, "''");
}

function bucketExpr(minutes) {
    return "substr(timestamp, 1, 14) || printf('%02d', " +
        `(CAST(substr(timestamp, 15, 2) AS INTEGER) / ${minutes}) * ${minutes})`;
}

function buildWhere(settings, now) {
    const start = parseBound(settings && settings.contestStart);
    const end = parseBound(settings && settings.contestEnd);
    const clauses = [];
    if (start !== null) clauses.push(`timestamp >= '${iso(start)}'`);
    if (end !== null) clauses.push(`timestamp <= '${iso(end)}'`);
    if (!clauses.length) {
        // 未配置比赛窗口时只取最近 6 小时，避免把历史日志当成当前状态。
        clauses.push(`timestamp >= '${iso(now - 6 * 3600000)}'`);
    }
    return clauses.join(' AND ');
}

/**
 * @param {object} options {settings, now, minutes, multMode, recent3h, activitySince}
 * @returns {{sql: string, where: string}}
 */
function adviceQuery(options) {
    const settings = options.settings || {};
    const now = options.now instanceof Date ? options.now : new Date(options.now);
    const minutes = options.minutes || 10;
    const multMode = options.multMode || 'dxcc-per-band';
    const where = buildWhere(settings, now);
    const multId = "COALESCE(SUM(CASE WHEN is_mult <> 0 THEN 1 ELSE 0 END), 0)";

    const parts = [
        "SELECT 'band' AS kind, band, '' AS bucket, COUNT(*) AS qsos, " +
        `COALESCE(SUM(points), 0) AS points, ${multId} AS mults, ` +
        `MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts FROM qsos WHERE ${where} GROUP BY band`,

        "SELECT 'bucket', band, " + bucketExpr(minutes) + ", COUNT(*), " +
        `COALESCE(SUM(points), 0), ${multId}, MIN(timestamp), MAX(timestamp) ` +
        `FROM qsos WHERE ${where} AND timestamp >= '${options.recent3h}' GROUP BY band, ${bucketExpr(minutes)}`,

        `SELECT 'seq', band, timestamp, 1, 0, 0, timestamp, timestamp FROM qsos ` +
        `WHERE ${where} AND timestamp >= '${options.recent3h}'`,

        "SELECT 'activity', band, bucket, spots, calls, 0, bucket, bucket FROM band_activity " +
        `WHERE bucket >= '${options.activitySince}'`
    ];

    if (MULTI_CALL_MODES.has(multMode)) {
        parts.push("SELECT 'call', band, call, COUNT(*), 0, 0, MIN(timestamp), MAX(timestamp) " +
            `FROM qsos WHERE ${where} GROUP BY band, call`);
    }

    return {sql: parts.join(' UNION ALL '), where};
}

module.exports = {MULTI_CALL_MODES, iso, parseBound, escapeLiteral, bucketExpr, buildWhere, adviceQuery};
