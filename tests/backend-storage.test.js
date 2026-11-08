'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../lib/storage');

test('spot SQL retains column order, escaping and numeric NULL handling', () => {
    const sql = storage.spots.insert({spot_id: 7, timestamp: '2026-01-01', monitored_call: "O'CALL",
        de: 'DE1', freq: 14074, spot_call: "O'CALL", comment: "5'9", spot_time: '', mode: 'CW',
        signal: null, snr: null, lat: 1, lon: 2, distance_km: 3, distance_miles: 2,
        band: '20m', dx_lat: null, dx_lon: null});
    assert.match(sql, /^INSERT OR IGNORE INTO spots \(spot_id, timestamp, monitored_call,/);
    assert.match(sql, /'O''CALL'/);
    assert.match(sql, /NULL, NULL, 1, 2, 3, 2, '20m', NULL, NULL\);$/);
    assert.equal(storage.spots.query("k'1", '25'),
        "SELECT * FROM spots WHERE monitored_call = 'K''1' OR spot_call = 'K''1' ORDER BY id DESC LIMIT 25");
});

test('schema migration emits only missing columns in original order', () => {
    assert.match(storage.schema.createSpotsTable(), /spot_id INTEGER UNIQUE/);
    assert.equal(storage.schema.migrateLegacyDb([{c: 1}]), 'SELECT 1');
    assert.equal(storage.schema.migrateLegacyDb([{c: 0}]), 'ALTER TABLE spots ADD COLUMN spot_id INTEGER');
    assert.deepEqual(storage.schema.addMissingColumns([{cols: 'id,band'}]), [
        'ALTER TABLE spots ADD COLUMN dx_lat REAL',
        'ALTER TABLE spots ADD COLUMN dx_lon REAL'
    ]);
});

test('recording and QSO SQL constructors remain centralized', () => {
    assert.equal(storage.recording.purge(), "DELETE FROM recording_spots WHERE date < date('now', '-2 months');");
    assert.equal(storage.qso.query('10'), 'SELECT * FROM qsos ORDER BY id DESC LIMIT 10;');
    assert.equal(storage.qso.remove('abc', '', ''), "DELETE FROM qsos WHERE n1mm_id = 'abc';");
    assert.match(storage.qso.upsert({n1mmId: '1', ts: 't', mycall: '', operator: '', call: 'K1',
        band: '20', freqKhz: 14074, mode: 'CW', rstSnt: '', rstRcv: '', exchange: '', grid: '',
        country: '', continent: '', zone: '', points: 1, isMult: true, contest: '', radioNr: '2',
        stationName: '', lat: null, lon: null}), /, 1, '', '2', '', NULL, NULL\);$/);
});
