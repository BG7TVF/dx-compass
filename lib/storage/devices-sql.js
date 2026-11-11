'use strict';

const {esc, num} = require('./sql.js');

/**
 * 设备树与 TX 状态源。
 *
 * 所有设备共用一张表，父子关系只靠一个 parent_id：
 * 单父由字段天然保证，环在应用层保存时检测（lib/devices/model.js）。
 * 设备口令明文存放，不进 settings，也不出现在任何读接口的响应里。
 */
const CREATE_DEVICES = `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_id TEXT,
    bands TEXT NOT NULL DEFAULT '',
    install_offset_deg INTEGER NOT NULL DEFAULT 0,
    exclusive INTEGER NOT NULL DEFAULT 0,
    port_label TEXT,
    password TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    travel_timeout_sec INTEGER NOT NULL DEFAULT 120,
    notes TEXT,
    created_ts TEXT NOT NULL,
    updated_ts TEXT NOT NULL
);`;

const CREATE_TX_SOURCES = `CREATE TABLE IF NOT EXISTS tx_sources (
    source_id TEXT PRIMARY KEY,
    name TEXT,
    priority INTEGER NOT NULL DEFAULT 100,
    timeout_ms INTEGER NOT NULL DEFAULT 2000,
    token TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_ts TEXT NOT NULL,
    updated_ts TEXT NOT NULL
);`;

/** 列迁移清单：新版本若新增列，旧库在启动时按 PRAGMA 结果补齐。 */
const COLUMNS = {
    devices: [
        ['id', 'TEXT'],
        ['name', 'TEXT'],
        ['type', 'TEXT'],
        ['parent_id', 'TEXT'],
        ['bands', "TEXT NOT NULL DEFAULT ''"],
        ['install_offset_deg', 'INTEGER NOT NULL DEFAULT 0'],
        ['exclusive', 'INTEGER NOT NULL DEFAULT 0'],
        ['port_label', 'TEXT'],
        ['password', 'TEXT'],
        ['enabled', 'INTEGER NOT NULL DEFAULT 1'],
        ['travel_timeout_sec', 'INTEGER NOT NULL DEFAULT 120'],
        ['notes', 'TEXT'],
        ['created_ts', 'TEXT'],
        ['updated_ts', 'TEXT']
    ],
    tx_sources: [
        ['source_id', 'TEXT'],
        ['name', 'TEXT'],
        ['priority', 'INTEGER NOT NULL DEFAULT 100'],
        ['timeout_ms', 'INTEGER NOT NULL DEFAULT 2000'],
        ['token', 'TEXT'],
        ['enabled', 'INTEGER NOT NULL DEFAULT 1'],
        ['created_ts', 'TEXT'],
        ['updated_ts', 'TEXT']
    ]
};

function createSchema() {
    return [CREATE_DEVICES, CREATE_TX_SOURCES];
}

/** 一次取回两张表的列名；sqlite 节点只允许一条语句。 */
function columnsQuery() {
    return "SELECT 'devices' AS tbl, name AS col FROM pragma_table_info('devices')" +
        " UNION ALL SELECT 'tx_sources', name FROM pragma_table_info('tx_sources')";
}

function readCell(row, key) {
    if (!row || typeof row !== 'object') return '';
    const actual = Object.keys(row).find(name => name.toLowerCase() === key);
    return actual === undefined ? '' : String(row[actual] === null || row[actual] === undefined ? '' : row[actual]);
}

/** 兼容 [{tbl,col}]、[[tbl,col]]、['tbl|col'] 三种返回形态。 */
function columnPairs(rows) {
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    const out = {};
    for (const row of list) {
        let tbl = '';
        let col = '';
        if (Array.isArray(row)) {
            tbl = String(row[0] === null || row[0] === undefined ? '' : row[0]).toLowerCase();
            col = String(row[1] === null || row[1] === undefined ? '' : row[1]).toLowerCase();
        } else if (row && typeof row === 'object') {
            tbl = readCell(row, 'tbl').toLowerCase();
            col = readCell(row, 'col').toLowerCase();
        } else if (typeof row === 'string' && row.includes('|')) {
            const parts = row.split('|');
            tbl = parts[0].toLowerCase();
            col = parts[1].toLowerCase();
        }
        if (!tbl || !col) continue;
        (out[tbl] = out[tbl] || new Set()).add(col.trim());
    }
    return out;
}

/**
 * 幂等列迁移：只对已存在、且确实缺列的表发 ALTER。
 * 读不到列名时返回空数组，绝不盲改；duplicate column 由 flow 的 catch 归为已迁移。
 */
function addMissingColumns(rows) {
    const present = columnPairs(rows);
    const statements = [];
    for (const table of Object.keys(COLUMNS)) {
        const cols = present[table];
        if (!cols || !cols.size) continue;
        for (const [name, type] of COLUMNS[table]) {
            if (!cols.has(name.toLowerCase())) {
                statements.push('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + type);
            }
        }
    }
    return statements;
}

function insertDevice(device) {
    const d = device || {};
    return 'INSERT INTO devices (id, name, type, parent_id, bands, install_offset_deg, exclusive, ' +
        'port_label, password, enabled, travel_timeout_sec, notes, created_ts, updated_ts) VALUES (' +
        esc(d.id) + ', ' + esc(d.name) + ', ' + esc(d.type) + ', ' + esc(d.parent_id) + ', ' +
        esc((d.bands || []).join(',')) + ', ' + num(d.install_offset_deg) + ', ' +
        (d.exclusive ? 1 : 0) + ', ' + esc(d.port_label) + ', ' + esc(d.password) + ', ' +
        (d.enabled ? 1 : 0) + ', ' + num(d.travel_timeout_sec) + ', ' + esc(d.notes) + ', ' +
        esc(d.created_ts) + ', ' + esc(d.updated_ts) + ');';
}

function updateDevice(device) {
    const d = device || {};
    return 'UPDATE devices SET name = ' + esc(d.name) + ', type = ' + esc(d.type) +
        ', parent_id = ' + esc(d.parent_id) + ', bands = ' + esc((d.bands || []).join(',')) +
        ', install_offset_deg = ' + num(d.install_offset_deg) + ', exclusive = ' + (d.exclusive ? 1 : 0) +
        ', port_label = ' + esc(d.port_label) + ', password = ' + esc(d.password) +
        ', enabled = ' + (d.enabled ? 1 : 0) + ', travel_timeout_sec = ' + num(d.travel_timeout_sec) +
        ', notes = ' + esc(d.notes) + ', updated_ts = ' + esc(d.updated_ts) +
        ' WHERE id = ' + esc(d.id) + ';';
}

function deleteDevice(id) {
    return 'DELETE FROM devices WHERE id = ' + esc(id) + ';';
}

function insertTxSource(source) {
    const s = source || {};
    return 'INSERT INTO tx_sources (source_id, name, priority, timeout_ms, token, enabled, ' +
        'created_ts, updated_ts) VALUES (' + esc(s.source_id) + ', ' + esc(s.name) + ', ' +
        num(s.priority) + ', ' + num(s.timeout_ms) + ', ' + esc(s.token) + ', ' +
        (s.enabled ? 1 : 0) + ', ' + esc(s.created_ts) + ', ' + esc(s.updated_ts) + ');';
}

function insertTxSourceIfMissing(source) {
    return insertTxSource(source).replace('INSERT INTO tx_sources', 'INSERT OR IGNORE INTO tx_sources');
}

function updateTxSource(source) {
    const s = source || {};
    return 'UPDATE tx_sources SET name = ' + esc(s.name) + ', priority = ' + num(s.priority) +
        ', timeout_ms = ' + num(s.timeout_ms) + ', token = ' + esc(s.token) +
        ', enabled = ' + (s.enabled ? 1 : 0) + ', updated_ts = ' + esc(s.updated_ts) +
        ' WHERE source_id = ' + esc(s.source_id) + ';';
}

function deleteTxSource(sourceId) {
    return 'DELETE FROM tx_sources WHERE source_id = ' + esc(sourceId) + ';';
}

function devicesQuery() {
    return 'SELECT * FROM devices;';
}

function txSourcesQuery() {
    return 'SELECT * FROM tx_sources;';
}

/**
 * 设备与 TX 源一次取回。列名保持与表一致，便于行映射共用。
 * tx 行用 token 填 password 列不影响读接口：服务层在输出前统一剥离。
 */
function snapshotQuery() {
    return "SELECT 'device' AS kind, id, name, type, parent_id, bands, install_offset_deg, " +
        'exclusive, port_label, password, enabled, travel_timeout_sec, notes, created_ts, updated_ts, ' +
        'NULL AS priority, NULL AS timeout_ms' +
        ' FROM devices' +
        " UNION ALL SELECT 'tx', source_id, name, NULL, NULL, '', 0, 0, NULL, token, enabled, 0, " +
        'NULL, created_ts, updated_ts, priority, timeout_ms' +
        ' FROM tx_sources;';
}

function readString(row, key) {
    if (!row || typeof row !== 'object') return '';
    const actual = Object.keys(row).find(name => name.toLowerCase() === key.toLowerCase());
    if (actual === undefined || row[actual] === null || row[actual] === undefined) return '';
    return String(row[actual]);
}

function readInt(row, key, fallback) {
    const raw = readString(row, key);
    if (raw === '') return fallback;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : fallback;
}

function toDevice(row) {
    const bands = readString(row, 'bands');
    return {
        id: readString(row, 'id'),
        name: readString(row, 'name'),
        type: readString(row, 'type').toLowerCase(),
        parent_id: readString(row, 'parent_id') || null,
        bands: bands ? bands.split(',').map(v => v.trim()).filter(Boolean) : [],
        install_offset_deg: readInt(row, 'install_offset_deg', 0),
        exclusive: readInt(row, 'exclusive', 0) === 1,
        port_label: readString(row, 'port_label'),
        password: readString(row, 'password'),
        enabled: readInt(row, 'enabled', 1) === 1,
        travel_timeout_sec: readInt(row, 'travel_timeout_sec', 120),
        notes: readString(row, 'notes'),
        created_ts: readString(row, 'created_ts'),
        updated_ts: readString(row, 'updated_ts')
    };
}

function toTxSource(row) {
    return {
        source_id: readString(row, 'source_id') || readString(row, 'id'),
        name: readString(row, 'name'),
        priority: readInt(row, 'priority', 100),
        timeout_ms: readInt(row, 'timeout_ms', 2000),
        token: readString(row, 'token') || readString(row, 'password'),
        enabled: readInt(row, 'enabled', 1) === 1,
        created_ts: readString(row, 'created_ts'),
        updated_ts: readString(row, 'updated_ts')
    };
}

module.exports = {
    CREATE_DEVICES,
    CREATE_TX_SOURCES,
    COLUMNS,
    createSchema,
    columnsQuery,
    columnPairs,
    addMissingColumns,
    insertDevice,
    updateDevice,
    deleteDevice,
    insertTxSource,
    insertTxSourceIfMissing,
    updateTxSource,
    deleteTxSource,
    devicesQuery,
    txSourcesQuery,
    snapshotQuery,
    toDevice,
    toTxSource
};
