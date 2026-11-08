'use strict';

const {esc, num} = require('./sql.js');

function insert(s) {
    return `INSERT INTO recording_spots (date, time, call, de, band, freq, mode, detail, snr, signal, distance_km, comment) VALUES (${esc(s.date)}, ${esc(s.time)}, ${esc(s.monitored_call)}, ${esc(s.de)}, ${esc(s.band)}, ${num(s.freq)}, ${esc(s.mode)}, ${esc(s.detail)}, ${num(s.snr)}, ${esc(s.signal)}, ${num(s.distance_km)}, ${esc(s.comment)});`;
}

function query(call, rawLimit) {
    const limit = parseInt(rawLimit) || 1000;
    let sql = 'SELECT * FROM recording_spots';
    if (call) sql += ' WHERE call = ' + esc(String(call).toUpperCase());
    return sql + ' ORDER BY id DESC LIMIT ' + limit;
}

function purge() {
    return "DELETE FROM recording_spots WHERE date < date('now', '-2 months');";
}

function clear() {
    return 'DELETE FROM recording_spots;';
}

module.exports = {insert, query, purge, clear};
