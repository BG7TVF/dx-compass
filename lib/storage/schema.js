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

const CREATE_NEIGHBORS = `CREATE TABLE IF NOT EXISTS neighbors (
    call TEXT PRIMARY KEY,
    grid4 TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    reports INTEGER NOT NULL DEFAULT 0
);`;

/**
 * 邻台登记由 spots 的 AFTER INSERT 触发器维护：
 * 发送方/接收方的网格只要落在某个 4 位大网格内，就把该呼号登记为那个大网格的邻台。
 * 表里存的是“全局邻台”，查询时再按本台大网格与时效筛选。
 */
const CREATE_NEIGHBOR_TRIGGER_TX = `CREATE TRIGGER IF NOT EXISTS trg_spots_neighbor_tx
AFTER INSERT ON spots
WHEN upper(NEW.sender_grid) GLOB '[A-R][A-R][0-9][0-9]*' AND NEW.spot_call <> ''
BEGIN
    UPDATE neighbors
    SET last_seen = CASE WHEN NEW.timestamp > last_seen THEN NEW.timestamp ELSE last_seen END,
        grid4 = upper(substr(NEW.sender_grid, 1, 4)),
        reports = reports + 1
    WHERE call = NEW.spot_call;
    INSERT OR IGNORE INTO neighbors (call, grid4, first_seen, last_seen, reports)
    VALUES (NEW.spot_call, upper(substr(NEW.sender_grid, 1, 4)), NEW.timestamp, NEW.timestamp, 1);
END;`;

const CREATE_NEIGHBOR_TRIGGER_RX = `CREATE TRIGGER IF NOT EXISTS trg_spots_neighbor_rx
AFTER INSERT ON spots
WHEN upper(NEW.receiver_grid) GLOB '[A-R][A-R][0-9][0-9]*' AND NEW.de <> ''
BEGIN
    UPDATE neighbors
    SET last_seen = CASE WHEN NEW.timestamp > last_seen THEN NEW.timestamp ELSE last_seen END,
        grid4 = upper(substr(NEW.receiver_grid, 1, 4)),
        reports = reports + 1
    WHERE call = NEW.de;
    INSERT OR IGNORE INTO neighbors (call, grid4, first_seen, last_seen, reports)
    VALUES (NEW.de, upper(substr(NEW.receiver_grid, 1, 4)), NEW.timestamp, NEW.timestamp, 1);
END;`;

/**
 * 邻台建表 + 两条触发器。sqlite 节点一次只能执行一条语句，
 * 这里返回数组，由 function 节点拆成多条消息依次执行。
 * 触发器先 DROP 再建，保证重复启动时也能把旧定义替换掉。
 */
function createNeighbors() {
    return [
        CREATE_NEIGHBORS,
        'DROP TRIGGER IF EXISTS trg_spots_neighbor_tx;',
        CREATE_NEIGHBOR_TRIGGER_TX,
        'DROP TRIGGER IF EXISTS trg_spots_neighbor_rx;',
        CREATE_NEIGHBOR_TRIGGER_RX
    ];
}

function migrateLegacyDb(rows) {
    const has = Array.isArray(rows) && rows.length > 0 && Number(rows[0].c) > 0;
    return has ? 'SELECT 1' : 'ALTER TABLE spots ADD COLUMN spot_id INTEGER';
}

/** 兼容 sqlite 节点的三种返回形态：GROUP_CONCAT 单行、name 多行、纯字符串。 */
function columnNames(rows) {
    if (typeof rows === 'string') return rows.split(',').map(name => name.trim()).filter(Boolean);
    if (!Array.isArray(rows) || !rows.length) return [];
    const first = rows[0];
    if (first && typeof first === 'object') {
        if (typeof first.cols === 'string') return first.cols.split(',').map(name => name.trim());
        if (typeof first.name === 'string') return rows.map(row => String(row.name));
        if (typeof first === 'string') return rows.map(String);
    }
    return [];
}

/**
 * 幂等列迁移：按 PRAGMA table_info 的结果补齐缺失列。
 * 已存在的列不会重复 ALTER，多次启动不会报错。
 */
function addMissingColumns(rows) {
    const cols = columnNames(rows);
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
    CREATE_NEIGHBORS,
    createSpotsTable: () => CREATE_SPOTS,
    createRecordingTable: () => CREATE_RECORDING,
    createQsosTable: () => CREATE_QSOS,
    createNeighbors,
    checkSpotIdColumn: () => "SELECT COUNT(*) AS c FROM pragma_table_info('spots') WHERE name='spot_id'",
    migrateLegacyDb,
    uniqueSpotIndex: () => 'CREATE UNIQUE INDEX IF NOT EXISTS idx_spots_spotid ON spots(spot_id);',
    checkExtraColumns: () => "SELECT GROUP_CONCAT(name) AS cols FROM pragma_table_info('spots')",
    addMissingColumns
};
