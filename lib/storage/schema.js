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

/**
 * 波段活跃度聚合：5 分钟桶 × 波段。
 * 只统计已经通过现有过滤、真正写入 spots 的行——不放开 monitoredCalls，
 * 也不额外落盘原始 spot。独立呼号数由 band_activity_call 去重后回填。
 */
const CREATE_BAND_ACTIVITY = `CREATE TABLE IF NOT EXISTS band_activity (
    bucket TEXT NOT NULL,
    band TEXT NOT NULL,
    spots INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bucket, band)
);`;

const CREATE_BAND_ACTIVITY_CALL = `CREATE TABLE IF NOT EXISTS band_activity_call (
    bucket TEXT NOT NULL,
    band TEXT NOT NULL,
    call TEXT NOT NULL,
    PRIMARY KEY (bucket, band, call)
);`;

const CREATE_BAND_ACTIVITY_TRIGGER = `CREATE TRIGGER IF NOT EXISTS trg_spots_band_activity
AFTER INSERT ON spots
WHEN NEW.band IS NOT NULL AND NEW.band <> '' AND NEW.spot_call IS NOT NULL AND NEW.spot_call <> ''
BEGIN
    INSERT OR IGNORE INTO band_activity_call (bucket, band, call)
    VALUES (substr(NEW.timestamp, 1, 14) || printf('%02d', (CAST(substr(NEW.timestamp, 15, 2) AS INTEGER) / 5) * 5),
            NEW.band, upper(NEW.spot_call));
    INSERT OR IGNORE INTO band_activity (bucket, band, spots, calls, updated_at)
    VALUES (substr(NEW.timestamp, 1, 14) || printf('%02d', (CAST(substr(NEW.timestamp, 15, 2) AS INTEGER) / 5) * 5),
            NEW.band, 0, 0, NEW.timestamp);
    UPDATE band_activity
    SET spots = spots + 1,
        calls = (SELECT COUNT(*) FROM band_activity_call
                 WHERE bucket = band_activity.bucket AND band = band_activity.band),
        updated_at = NEW.timestamp
    WHERE bucket = substr(NEW.timestamp, 1, 14) || printf('%02d', (CAST(substr(NEW.timestamp, 15, 2) AS INTEGER) / 5) * 5)
      AND band = NEW.band;
END;`;

function createActivity() {
    return [
        CREATE_BAND_ACTIVITY,
        CREATE_BAND_ACTIVITY_CALL,
        'DROP TRIGGER IF EXISTS trg_spots_band_activity;',
        CREATE_BAND_ACTIVITY_TRIGGER
    ];
}

/** 保留 N 天；0 表示永久保留。返回空数组表示不清理。 */
function purgeActivity(days, nowIso) {
    const n = parseInt(days, 10);
    if (!Number.isFinite(n) || n <= 0) return [];
    const cutoff = new Date(Date.parse(nowIso || new Date().toISOString()) - n * 86400000)
        .toISOString().slice(0, 16);
    return [
        "DELETE FROM band_activity_call WHERE bucket < '" + cutoff + "'",
        "DELETE FROM band_activity WHERE bucket < '" + cutoff + "'"
    ];
}

function migrateLegacyDb(rows) {
    const has = Array.isArray(rows) && rows.length > 0 && Number(rows[0].c) > 0;
    return has ? 'SELECT 1' : 'ALTER TABLE spots ADD COLUMN spot_id INTEGER';
}

/** 统一小写去重，避免大小写或空白导致误判“缺列”。 */
function normalizeColumns(names) {
    const out = [];
    for (const name of names) {
        const value = String(name == null ? '' : name).trim().toLowerCase();
        if (value && !out.includes(value)) out.push(value);
    }
    return out;
}

/** 按列名取值（忽略大小写），只接受字符串。 */
function readString(row, key) {
    if (!row || typeof row !== 'object') return null;
    const actual = Object.keys(row).find(name => name.toLowerCase() === key);
    if (actual === undefined) return null;
    return typeof row[actual] === 'string' ? row[actual] : null;
}

/**
 * 兼容 sqlite 节点可能返回的 PRAGMA 形态：
 * - GROUP_CONCAT 单行 [{cols: 'a,b,c'}]
 * - 多行对象 [{name: 'a'}, {name: 'b'}]
 * - 值数组 [[0, 'a', 'TEXT', ...], ...]
 * - 纯字符串数组 ['a', 'b'] 或直接字符串 'a,b'
 * 识别不出来时返回空数组，调用方据此放弃 ALTER，绝不盲改。
 */
function columnNames(rows) {
    if (typeof rows === 'string') return normalizeColumns(rows.split(','));
    const list = Array.isArray(rows) ? rows : (rows && typeof rows === 'object' ? [rows] : []);
    if (!list.length) return [];
    const first = list[0];
    if (Array.isArray(first)) {
        return normalizeColumns(list.map(row => (Array.isArray(row) ? row[1] : null)));
    }
    if (first && typeof first === 'object') {
        const keys = Object.keys(first).map(name => name.toLowerCase());
        if (keys.includes('cols')) {
            const cols = readString(first, 'cols');
            return cols === null ? [] : normalizeColumns(cols.split(','));
        }
        if (keys.includes('name')) {
            return normalizeColumns(list.map(row => readString(row, 'name')));
        }
        return normalizeColumns(Object.keys(first));
    }
    if (typeof first === 'string') return normalizeColumns(list);
    return [];
}

/**
 * 幂等列迁移：按 PRAGMA table_info 的结果补齐缺失列。
 * 已存在的列不会重复 ALTER，多次启动不会报错。
 * 读不到任何列名时返回空数组，宁可跳过并告警，也不盲改。
 */
function addMissingColumns(rows) {
    const cols = columnNames(rows);
    if (!cols.length) return [];
    const wanted = [
        ['band', 'TEXT'], ['dx_lat', 'REAL'], ['dx_lon', 'REAL'],
        ['sender_grid', 'TEXT'], ['receiver_grid', 'TEXT'],
        ['dxcc_sender', 'INTEGER'], ['dxcc_receiver', 'INTEGER']
    ];
    return wanted.filter(([name]) => !cols.includes(name))
        .map(([name, type]) => 'ALTER TABLE spots ADD COLUMN ' + name + ' ' + type);
}

/**
 * 多进程/重复执行时 ALTER 可能撞上已存在的列。
 * 这类错误视为“已经是目标状态”，只记 info，不算迁移失败。
 */
function isDuplicateColumnError(error) {
    return /duplicate column name/i.test(String((error && error.message) || error || ''));
}

/**
 * 启动自检（同时充当迁移后的复验）：一次查询返回 spots 的全部列、
 * 邻台表与两条触发器是否存在。由 flow 的 function 节点写入 msg.topic。
 */
function selfCheckQuery() {
    return "SELECT 'column' AS kind, name AS value FROM pragma_table_info('spots')" +
        " UNION ALL SELECT 'table', name FROM sqlite_master" +
        " WHERE type='table' AND name='neighbors'" +
        " UNION ALL SELECT 'trigger', name FROM sqlite_master" +
        " WHERE type='trigger' AND name LIKE 'trg_spots_neighbor_%'";
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
    CREATE_BAND_ACTIVITY,
    CREATE_BAND_ACTIVITY_CALL,
    CREATE_BAND_ACTIVITY_TRIGGER,
    createActivity,
    purgeActivity,
    createN1mm: require('./n1mm-sql.js').createN1mm,
    checkSpotIdColumn: () => "SELECT COUNT(*) AS c FROM pragma_table_info('spots') WHERE name='spot_id'",
    migrateLegacyDb,
    uniqueSpotIndex: () => 'CREATE UNIQUE INDEX IF NOT EXISTS idx_spots_spotid ON spots(spot_id);',
    checkExtraColumns: () => "SELECT GROUP_CONCAT(name) AS cols FROM pragma_table_info('spots')",
    columnNames,
    addMissingColumns,
    isDuplicateColumnError,
    selfCheckQuery
};
