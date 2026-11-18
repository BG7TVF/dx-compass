'use strict';

const {esc, num} = require('./sql.js');

function upsert(qso) {
    return 'INSERT OR REPLACE INTO qsos (n1mm_id, timestamp, mycall, operator, call, band, freq_khz, mode, rst_snt, rst_rcv, exchange, gridsquare, countryprefix, continent, zone, points, is_mult, contestname, radionr, stationname, lat, lon) VALUES (' +
        esc(qso.n1mmId) + ', ' + esc(qso.ts) + ', ' + esc(qso.mycall) + ', ' + esc(qso.operator) + ', ' +
        esc(qso.call) + ', ' + esc(qso.band) + ', ' + num(qso.freqKhz) + ', ' + esc(qso.mode) + ', ' +
        esc(qso.rstSnt) + ', ' + esc(qso.rstRcv) + ', ' + esc(qso.exchange) + ', ' + esc(qso.grid) + ', ' +
        esc(qso.country) + ', ' + esc(qso.continent) + ', ' + esc(qso.zone) + ', ' + num(qso.points) + ', ' +
        (qso.isMult ? 1 : 0) + ', ' + esc(qso.contest) + ', ' + esc(qso.radioNr) + ', ' +
        esc(qso.stationName) + ', ' + num(qso.lat) + ', ' + num(qso.lon) + ');';
}

function remove(id, call, timestamp) {
    if (id) return "DELETE FROM qsos WHERE n1mm_id = '" + String(id).replace(/'/g, "''") + "';";
    return "DELETE FROM qsos WHERE call = '" + String(call).toUpperCase().replace(/'/g, "''") +
        "' AND timestamp = '" + timestamp + "';";
}

function query(rawLimit) {
    const limit = parseInt(rawLimit, 10) || 200;
    return 'SELECT * FROM qsos ORDER BY id DESC LIMIT ' + limit + ';';
}

function updateCoords(qso) {
    const id = String(qso.n1mmId).replace(/'/g, "''");
    return 'UPDATE qsos SET lat=' + qso.lat + ', lon=' + qso.lon + " WHERE n1mm_id='" + id + "';";
}

/** 倍率矩阵读取：只取矩阵需要的列，按时间升序，窗口与分组在服务层判定。 */
function matrixQuery(rawLimit) {
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 20000, 1), 50000);
    return 'SELECT timestamp, call, band, mode, contestname, countryprefix ' +
        'FROM qsos ORDER BY timestamp ASC LIMIT ' + limit + ';';
}

/** Count other QSOs already using this call, excluding the row being reviewed. */
function checkCall(call, excludeId) {
    const target = String(call || '').trim().toUpperCase().replace(/'/g, "''");
    if (!target) return null;
    let sql = "SELECT COUNT(*) AS n FROM qsos WHERE UPPER(call) = '" + target + "'";
    if (excludeId !== null && excludeId !== undefined && String(excludeId) !== '') {
        sql += " AND n1mm_id <> '" + String(excludeId).replace(/'/g, "''") + "'";
    }
    return sql + ';';
}

/**
 * 历史坐标一次性回填：把 qsos 里 lat 为空的行，用 spots 中该呼号最近一条
 * 有坐标的播报补上。QRZ 优先（已有坐标不参与），EXISTS 保证只更新确实能
 * 取到坐标的行，绝不把 lat 写成 NULL。SQLite 默认没启用 UPDATE ... LIMIT，
 * 批量上限只能走 id IN (SELECT ... LIMIT n)。
 */
function backfillCoords(rawLimit) {
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 5000, 1), 50000);
    /* 经纬度必须成对，所以三处子查询用的是同一个「两列都非空」的条件。 */
    const usable = ' AND s.dx_lat IS NOT NULL AND s.dx_lon IS NOT NULL';
    return 'UPDATE qsos SET lat = (SELECT s.dx_lat FROM spots s WHERE s.spot_call = qsos.call' +
        usable + ' ORDER BY s.id DESC LIMIT 1),' +
        ' lon = (SELECT s.dx_lon FROM spots s WHERE s.spot_call = qsos.call' +
        usable + ' ORDER BY s.id DESC LIMIT 1)' +
        ' WHERE id IN (SELECT q.id FROM qsos q WHERE q.lat IS NULL' +
        ' AND EXISTS (SELECT 1 FROM spots s WHERE s.spot_call = q.call' + usable + ')' +
        ' ORDER BY q.id DESC LIMIT ' + limit + ');';
}

function clear() {
    return 'DELETE FROM qsos;';
}

function purge(rawDays) {
    const days = parseInt(rawDays, 10);
    if (!Number.isFinite(days) || days <= 0) return null;
    return "DELETE FROM qsos WHERE datetime(timestamp) < datetime('now', '-" +
        Math.min(days, 3650) + " days');";
}

module.exports = {upsert, remove, query, matrixQuery, updateCoords, backfillCoords, checkCall, clear, purge};
