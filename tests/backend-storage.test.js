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
    assert.match(sql, /NULL, NULL, 1, 2, 3, 2, '20m', NULL, NULL, NULL, NULL, NULL, NULL\);$/);
    assert.equal(storage.spots.query("k'1", '25'),
        "SELECT * FROM spots WHERE monitored_call = 'K''1' OR spot_call = 'K''1' ORDER BY id DESC LIMIT 25");
});

test('schema migration emits only missing columns in original order', () => {
    assert.match(storage.schema.createSpotsTable(), /spot_id INTEGER UNIQUE/);
    assert.equal(storage.schema.migrateLegacyDb([{c: 1}]), 'SELECT 1');
    assert.equal(storage.schema.migrateLegacyDb([{c: 0}]), 'ALTER TABLE spots ADD COLUMN spot_id INTEGER');
    assert.deepEqual(storage.schema.addMissingColumns([{cols: 'id,band'}]), [
        'ALTER TABLE spots ADD COLUMN dx_lat REAL',
        'ALTER TABLE spots ADD COLUMN dx_lon REAL',
        'ALTER TABLE spots ADD COLUMN sender_grid TEXT',
        'ALTER TABLE spots ADD COLUMN receiver_grid TEXT',
        'ALTER TABLE spots ADD COLUMN dxcc_sender INTEGER',
        'ALTER TABLE spots ADD COLUMN dxcc_receiver INTEGER'
    ]);
});

test('spot column migration is idempotent across sqlite row shapes', () => {
    const all = 'id,spot_id,timestamp,monitored_call,de,freq,spot_call,comment,spot_time,mode,' +
        'signal,snr,lat,lon,distance_km,distance_miles,band,dx_lat,dx_lon,' +
        'sender_grid,receiver_grid,dxcc_sender,dxcc_receiver';
    assert.deepEqual(storage.schema.addMissingColumns([{cols: all}]), []);
    assert.deepEqual(storage.schema.addMissingColumns(all), []);
    assert.deepEqual(storage.schema.addMissingColumns([
        {name: 'id'}, {name: 'band'}, {name: 'sender_grid'}
    ]), [
        'ALTER TABLE spots ADD COLUMN dx_lat REAL',
        'ALTER TABLE spots ADD COLUMN dx_lon REAL',
        'ALTER TABLE spots ADD COLUMN receiver_grid TEXT',
        'ALTER TABLE spots ADD COLUMN dxcc_sender INTEGER',
        'ALTER TABLE spots ADD COLUMN dxcc_receiver INTEGER'
    ]);
    // 值数组形态：[cid, name, type, notnull, dflt_value, pk]
    assert.deepEqual(storage.schema.addMissingColumns([
        [0, 'id', 'INTEGER', 0, null, 0],
        [1, 'DXCC_SENDER', 'INTEGER', 0, null, 0],
        [2, ' dxcc_receiver ', 'INTEGER', 0, null, 0]
    ]), [
        'ALTER TABLE spots ADD COLUMN band TEXT',
        'ALTER TABLE spots ADD COLUMN dx_lat REAL',
        'ALTER TABLE spots ADD COLUMN dx_lon REAL',
        'ALTER TABLE spots ADD COLUMN sender_grid TEXT',
        'ALTER TABLE spots ADD COLUMN receiver_grid TEXT'
    ]);
});

test('column migration never guesses when the PRAGMA result is unreadable', () => {
    for (const rows of [[], null, undefined, '', [{cols: null}], [{}], [null], 42]) {
        assert.deepEqual(storage.schema.addMissingColumns(rows), [],
            'unreadable column list must not emit blind ALTERs: ' + JSON.stringify(rows));
    }
    assert.deepEqual(storage.schema.columnNames([{cols: 'id, BAND ,band'}]), ['id', 'band']);
    assert.deepEqual(storage.schema.columnNames([['0', 'Id'], ['1', 'band']]), ['id', 'band']);
    assert.deepEqual(storage.schema.columnNames({sender_grid: 'TEXT', dxcc_sender: 'INTEGER'}),
        ['sender_grid', 'dxcc_sender']);
    assert.equal(storage.schema.columnNames([]).length, 0);
});

test('duplicate column errors are treated as already-migrated, not failures', () => {
    assert.equal(storage.schema.isDuplicateColumnError(
        'SQLITE_ERROR: duplicate column name: dxcc_sender'), true);
    assert.equal(storage.schema.isDuplicateColumnError(
        new Error('SQLITE_ERROR: duplicate column name: receiver_grid')), true);
    assert.equal(storage.schema.isDuplicateColumnError('SQLITE_ERROR: no such table: neighbors'), false);
    assert.equal(storage.schema.isDuplicateColumnError(null), false);
});

test('neighbor schema rebuilds triggers idempotently', () => {
    const statements = storage.schema.createNeighbors();
    assert.equal(statements[0], storage.schema.CREATE_NEIGHBORS);
    assert.match(statements[1], /^DROP TRIGGER IF EXISTS trg_spots_neighbor_tx;/);
    assert.match(statements[3], /^DROP TRIGGER IF EXISTS trg_spots_neighbor_rx;/);
    assert.match(statements[2], /^CREATE TRIGGER IF NOT EXISTS trg_spots_neighbor_tx/);
    assert.match(statements[4], /^CREATE TRIGGER IF NOT EXISTS trg_spots_neighbor_rx/);
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
