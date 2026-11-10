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

function clear() {
    return 'DELETE FROM qsos;';
}

function purge(rawDays) {
    const days = parseInt(rawDays, 10);
    if (!Number.isFinite(days) || days <= 0) return null;
    return "DELETE FROM qsos WHERE datetime(timestamp) < datetime('now', '-" +
        Math.min(days, 3650) + " days');";
}

module.exports = {upsert, remove, query, matrixQuery, updateCoords, clear, purge};
