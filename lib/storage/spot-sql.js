'use strict';

const {esc, num} = require('./sql.js');

function insert(s) {
    return `INSERT OR IGNORE INTO spots (spot_id, timestamp, monitored_call, de, freq, spot_call, comment, spot_time, mode, signal, snr, lat, lon, distance_km, distance_miles, band, dx_lat, dx_lon) VALUES (${num(s.spot_id)}, ${esc(s.timestamp)}, ${esc(s.monitored_call)}, ${esc(s.de)}, ${num(s.freq)}, ${esc(s.spot_call)}, ${esc(s.comment)}, ${esc(s.spot_time)}, ${esc(s.mode)}, ${esc(s.signal)}, ${num(s.snr)}, ${num(s.lat)}, ${num(s.lon)}, ${num(s.distance_km)}, ${num(s.distance_miles)}, ${esc(s.band)}, ${num(s.dx_lat)}, ${num(s.dx_lon)});`;
}

function query(call, rawLimit) {
    const limit = parseInt(rawLimit) || 1000;
    let sql = 'SELECT * FROM spots';
    if (call) {
        const c = String(call).toUpperCase();
        sql += ' WHERE monitored_call = ' + esc(c) + ' OR spot_call = ' + esc(c);
    }
    return sql + ' ORDER BY id DESC LIMIT ' + limit;
}

function clear() {
    return 'DELETE FROM spots;';
}

function purge(rawDays) {
    const days = parseInt(rawDays, 10);
    if (!Number.isFinite(days) || days <= 0) return null;
    return "DELETE FROM spots WHERE datetime(timestamp) < datetime('now', '-" +
        Math.min(days, 3650) + " days');";
}

function coordinatesForCall(call) {
    const c = String(call).replace(/'/g, "''");
    return "SELECT dx_lat, dx_lon FROM spots WHERE spot_call = '" + c +
        "' AND dx_lat IS NOT NULL ORDER BY id DESC LIMIT 1;";
}

/**
 * 分析研判用的范围查询：目标台 + 参照台在时间窗内的全部 spot。
 * 参照台的 spot 必须一起取回，否则线路 A 的"同一接收站配对"无从构建。
 */
function analysisQuery(call, from, to, rawLimit, refCalls) {
    const limit = Math.min(20000, Math.max(1, parseInt(rawLimit, 10) || 20000));
    const calls = [...new Set([call].concat(refCalls || [])
        .map(value => String(value || '').trim().toUpperCase())
        .filter(Boolean))];
    if (!calls.length) return emptyQuery();
    const inList = calls.map(esc).join(', ');
    let sql = 'SELECT * FROM spots WHERE (monitored_call IN (' + inList +
        ') OR spot_call IN (' + inList + '))';
    if (from) sql += ' AND datetime(timestamp) >= datetime(' + esc(from) + ')';
    if (to) sql += ' AND datetime(timestamp) <= datetime(' + esc(to) + ')';
    return sql + ' ORDER BY id ASC LIMIT ' + limit;
}

function emptyQuery() {
    return 'SELECT * FROM spots WHERE 1=0;';
}

module.exports = {insert, query, analysisQuery, emptyQuery, clear, purge, coordinatesForCall};
