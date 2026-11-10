'use strict';

const CREATE_SPOTS = `CREATE TABLE IF NOT EXISTS spots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spot_id INTEGER UNIQUE,
    timestamp TEXT NOT NULL,
    monitored_call TEXT NOT NULL,
    de TEXT NOT NULL,
    freq REAL,
    spot_call TEXT NOT NULL,
    comment TEXT,
    spot_time TEXT,
    mode TEXT,
    signal TEXT,
    snr REAL,
    lat REAL,
    lon REAL,
    distance_km REAL,
    distance_miles REAL,
    band TEXT,
    dx_lat REAL,
    dx_lon REAL,
    sender_grid TEXT,
    receiver_grid TEXT,
    dxcc_sender INTEGER,
    dxcc_receiver INTEGER
);`;

const CREATE_RECORDING = `CREATE TABLE IF NOT EXISTS recording_spots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    time TEXT,
    call TEXT,
    de TEXT,
    band TEXT,
    freq REAL,
    mode TEXT,
    detail TEXT,
    snr INTEGER,
    signal TEXT,
    distance_km INTEGER,
    comment TEXT
);`;

const CREATE_QSOS = "CREATE TABLE IF NOT EXISTS qsos(\n" +
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
    "  n1mm_id TEXT UNIQUE,\n" +
    "  timestamp TEXT,\n" +
    "  mycall TEXT,\n" +
    "  operator TEXT,\n" +
    "  call TEXT,\n" +
    "  band TEXT,\n" +
    "  freq_khz REAL,\n" +
    "  mode TEXT,\n" +
    "  rst_snt TEXT,\n" +
    "  rst_rcv TEXT,\n" +
    "  exchange TEXT,\n" +
    "  gridsquare TEXT,\n" +
    "  countryprefix TEXT,\n" +
    "  continent TEXT,\n" +
    "  zone TEXT,\n" +
    "  points INTEGER,\n" +
    "  is_mult INTEGER,\n" +
    "  contestname TEXT,\n" +
    "  radionr TEXT,\n" +
    "  stationname TEXT,\n" +
    "  lat REAL,\n" +
    "  lon REAL\n" +
    ");";

function migrateLegacyDb(rows) {
    const has = Array.isArray(rows) && rows.length > 0 && Number(rows[0].c) > 0;
    return has ? 'SELECT 1' : 'ALTER TABLE spots ADD COLUMN spot_id INTEGER';
}

function addMissingColumns(rows) {
    const cols = String((Array.isArray(rows) && rows[0] && rows[0].cols) || '').split(',');
    const wanted = [
        ['band', 'TEXT'], ['dx_lat', 'REAL'], ['dx_lon', 'REAL'],
        ['sender_grid', 'TEXT'], ['receiver_grid', 'TEXT'],
        ['dxcc_sender', 'INTEGER'], ['dxcc_receiver', 'INTEGER']
    ];
    return wanted.filter(([name]) => !cols.includes(name))
        .map(([name, type]) => 'ALTER TABLE spots ADD COLUMN ' + name + ' ' + type);
}

module.exports = {
    CREATE_SPOTS,
    CREATE_RECORDING,
    CREATE_QSOS,
    createSpotsTable: () => CREATE_SPOTS,
    createRecordingTable: () => CREATE_RECORDING,
    createQsosTable: () => CREATE_QSOS,
    checkSpotIdColumn: () => "SELECT COUNT(*) AS c FROM pragma_table_info('spots') WHERE name='spot_id'",
    migrateLegacyDb,
    uniqueSpotIndex: () => 'CREATE UNIQUE INDEX IF NOT EXISTS idx_spots_spotid ON spots(spot_id);',
    checkExtraColumns: () => "SELECT GROUP_CONCAT(name) AS cols FROM pragma_table_info('spots')",
    addMissingColumns
};
