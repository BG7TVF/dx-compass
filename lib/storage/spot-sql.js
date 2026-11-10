'use strict';

const {esc, num} = require('./sql.js');

function insert(s) {
    return `INSERT OR IGNORE INTO spots (spot_id, timestamp, monitored_call, de, freq, spot_call, comment, spot_time, mode, signal, snr, lat, lon, distance_km, distance_miles, band, dx_lat, dx_lon, sender_grid, receiver_grid, dxcc_sender, dxcc_receiver) VALUES (${num(s.spot_id)}, ${esc(s.timestamp)}, ${esc(s.monitored_call)}, ${esc(s.de)}, ${num(s.freq)}, ${esc(s.spot_call)}, ${esc(s.comment)}, ${esc(s.spot_time)}, ${esc(s.mode)}, ${esc(s.signal)}, ${num(s.snr)}, ${num(s.lat)}, ${num(s.lon)}, ${num(s.distance_km)}, ${num(s.distance_miles)}, ${esc(s.band)}, ${num(s.dx_lat)}, ${num(s.dx_lon)}, ${esc(s.sender_grid)}, ${esc(s.receiver_grid)}, ${num(s.dxcc_sender)}, ${num(s.dxcc_receiver)});`;
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
 * 天线研判用的范围查询：目标台在时间窗内的全部 spot。
 */
function analysisQuery(call, from, to, rawLimit) {
    const limit = Math.min(20000, Math.max(1, parseInt(rawLimit, 10) || 20000));
    const c = String(call || '').trim().toUpperCase();
    if (!c) return emptyQuery();
    let sql = 'SELECT * FROM spots WHERE (monitored_call = ' + esc(c) +
        ' OR spot_call = ' + esc(c) + ')';
    if (from) sql += ' AND datetime(timestamp) >= datetime(' + esc(from) + ')';
    if (to) sql += ' AND datetime(timestamp) <= datetime(' + esc(to) + ')';
    return sql + ' ORDER BY id ASC LIMIT ' + limit;
}

/**
 * FT8 通路研判查询：只要与本台、监控呼号、本台大网格有关的 FT8 报告。
 * 方向由调用方按 sender/receiver 网格判定，这里只做数据收敛。
 */
function pathQuery({myCall, monitored, grid4, from, to, rawLimit}) {
    const limit = Math.min(50000, Math.max(1, parseInt(rawLimit, 10) || 50000));
    const self = String(myCall || '').trim().toUpperCase();
    if (!self) return emptyQuery();
    const calls = [...new Set([self, ...(monitored || []).map(c => String(c).trim().toUpperCase())])]
        .filter(Boolean).map(esc);
    let sql = "SELECT spot_call, de, freq, band, snr, comment, timestamp, lat, lon, " +
        "dx_lat, dx_lon, sender_grid, receiver_grid, dxcc_sender, dxcc_receiver " +
        "FROM spots WHERE comment LIKE 'PSKR FT8%'";
    const scope = ['spot_call IN (' + calls.join(',') + ')', 'de IN (' + calls.join(',') + ')'];
    const g = String(grid4 || '').trim().toUpperCase();
    if (/^[A-R]{2}[0-9]{2}$/.test(g)) {
        scope.push('sender_grid LIKE ' + esc(g + '%'), 'receiver_grid LIKE ' + esc(g + '%'));
    }
    sql += ' AND (' + scope.join(' OR ') + ')';
    if (from) sql += ' AND datetime(timestamp) >= datetime(' + esc(from) + ')';
    if (to) sql += ' AND datetime(timestamp) <= datetime(' + esc(to) + ')';
    return sql + ' ORDER BY id DESC LIMIT ' + limit;
}

function emptyQuery() {
    return 'SELECT * FROM spots WHERE 1=0;';
}

module.exports = {
    insert, query, analysisQuery, pathQuery, emptyQuery, clear, purge, coordinatesForCall
};
