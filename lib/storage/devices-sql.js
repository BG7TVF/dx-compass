'use strict';

const {esc, num} = require('./sql.js');

/**
 * 设备树与 TX 状态源。
 *
 * 所有设备共用一张表，父子关系只靠一个 parent_id：
 * 单父由字段天然保证，环在应用层保存时检测（lib/devices/model.js）。
 *
 * 属性按设备类型收敛后，表里只保留跨类型共用的列：
 * 波段、安装偏移、运行超时与协议配置都只在拥有的类型上写值。
 * 席位不是设备列：电台的席位由 ComputerName + 电台型号实时派生。
 */
const CREATE_DEVICES = `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    parent_id TEXT,
    bands TEXT NOT NULL DEFAULT '',
    install_offset_deg INTEGER NOT NULL DEFAULT 0,
    access_mode TEXT NOT NULL DEFAULT 'auto',
    travel_timeout_sec INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_ts TEXT NOT NULL,
    updated_ts TEXT NOT NULL
);`;

const CREATE_TX_SOURCES = `CREATE TABLE IF NOT EXISTS tx_sources (
    source_id TEXT PRIMARY KEY,
    name TEXT,
    priority INTEGER NOT NULL DEFAULT 100,
    timeout_ms INTEGER NOT NULL DEFAULT 2000,
    device_id TEXT,
    token TEXT,
    created_ts TEXT NOT NULL,
    updated_ts TEXT NOT NULL
);`;

const CREATE_DEVICE_COMMANDS = `CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    device_id TEXT NOT NULL,
    seat TEXT,
    operator TEXT,
    command TEXT NOT NULL,
    args TEXT,
    result TEXT NOT NULL,
    error TEXT,
    ip TEXT
);`;

/**
 * 画布布局：纯展示数据，与设备功能列分开存放。
 * 设备删除时同步删除对应行，避免孤儿布局。
 */
const CREATE_DEVICE_LAYOUT = `CREATE TABLE IF NOT EXISTS device_layout (
    device_id TEXT PRIMARY KEY,
    x INTEGER NOT NULL DEFAULT 0,
    y INTEGER NOT NULL DEFAULT 0,
    updated_ts TEXT NOT NULL
);`;

/**
 * 射频链路：一根同轴线一条无向边，方向由端口能力决定，不在库里拆成两条。
 * 反向重复由应用层按规范化端点去重（link_id 本身就是规范化端点）。
 */
const CREATE_RF_LINKS = `CREATE TABLE IF NOT EXISTS rf_links (
    link_id TEXT PRIMARY KEY,
    a_device TEXT NOT NULL,
    a_port TEXT NOT NULL,
    b_device TEXT NOT NULL,
    b_port TEXT NOT NULL,
    created_ts TEXT NOT NULL
);`;

const CREATE_RF_LINKS_PAIR = `CREATE UNIQUE INDEX IF NOT EXISTS rf_links_pair
    ON rf_links (a_device, a_port, b_device, b_port);`;

/**
 * 控制链路：圆形控制口之间的连线，与射频链路完全独立。
 * 当前唯一用途是表达“串口设备 → 串口服务器”的从属关系；
 * 不参与 TX 可达、波段剪枝或互锁。
 */
const CREATE_CONTROL_LINKS = `CREATE TABLE IF NOT EXISTS control_links (
    link_id TEXT PRIMARY KEY,
    a_device TEXT NOT NULL,
    a_port TEXT NOT NULL,
    b_device TEXT NOT NULL,
    b_port TEXT NOT NULL,
    created_ts TEXT NOT NULL
);`;

const CREATE_CONTROL_LINKS_PAIR = `CREATE UNIQUE INDEX IF NOT EXISTS control_links_pair
    ON control_links (a_device, a_port, b_device, b_port);`;

/** 列迁移清单：新版本若新增列，旧库在启动时按 PRAGMA 结果补齐。 */
const COLUMNS = {
    devices: [
        ['id', 'TEXT'],
        ['name', 'TEXT'],
        ['type', 'TEXT'],
        ['parent_id', 'TEXT'],
        ['bands', "TEXT NOT NULL DEFAULT ''"],
        ['install_offset_deg', 'INTEGER NOT NULL DEFAULT 0'],
        ['access_mode', "TEXT NOT NULL DEFAULT 'auto'"],
        ['travel_timeout_sec', 'INTEGER NOT NULL DEFAULT 0'],
        ['notes', 'TEXT'],
        ['config_json', "TEXT NOT NULL DEFAULT '{}'"],
        ['created_ts', 'TEXT'],
        ['updated_ts', 'TEXT']
    ],
    tx_sources: [
        ['source_id', 'TEXT'],
        ['name', 'TEXT'],
        ['priority', 'INTEGER NOT NULL DEFAULT 100'],
        ['timeout_ms', 'INTEGER NOT NULL DEFAULT 2000'],
        ['device_id', 'TEXT'],
        ['token', 'TEXT'],
        ['created_ts', 'TEXT'],
        ['updated_ts', 'TEXT']
    ]
};

function createSchema() {
    return [
        CREATE_DEVICES,
        CREATE_TX_SOURCES,
        CREATE_DEVICE_COMMANDS,
        CREATE_DEVICE_LAYOUT,
        CREATE_RF_LINKS,
        CREATE_RF_LINKS_PAIR,
        CREATE_CONTROL_LINKS,
        CREATE_CONTROL_LINKS_PAIR
    ];
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

/**
 * 旧库遗留迁移（幂等）：
 *   1. 删除已废弃的设备列（seat / exclusive / port_label / password / enabled）；
 *   2. 删除 TX 源的启用列（enabled）—— 源是否参与判定只由上报时效决定；
 *   3. 端口 key 按设备类型改名：radio.ant→out、antenna.feed→in、switch.common→in。
 *
 * 只处理存在对应列时才发 DROP，避免重复启动报 duplicate/unknown column。
 * 端口改名按设备类型过滤，不会误伤自定义端口。
 */
function legacyMigrations(rows) {
    const present = columnPairs(rows);
    const deviceCols = present.devices || new Set();
    const sourceCols = present.tx_sources || new Set();
    const statements = [];
    for (const column of ['seat', 'exclusive', 'port_label', 'password', 'enabled']) {
        if (deviceCols.has(column)) statements.push('ALTER TABLE devices DROP COLUMN ' + column + ';');
    }
    if (sourceCols.has('enabled')) statements.push('ALTER TABLE tx_sources DROP COLUMN enabled;');
    const renames = [
        ['radio', 'ant', 'out'],
        ['antenna', 'feed', 'in'],
        ['switch', 'common', 'in']
    ];
    for (const [type, from, to] of renames) {
        const filter = " AND a_device IN (SELECT id FROM devices WHERE lower(type) = '" + type + "')";
        statements.push("UPDATE rf_links SET a_port = '" + to + "' WHERE a_port = '" + from + "'" + filter + ';');
        const filterB = " AND b_device IN (SELECT id FROM devices WHERE lower(type) = '" + type + "')";
        statements.push("UPDATE rf_links SET b_port = '" + to + "' WHERE b_port = '" + from + "'" + filterB + ';');
    }
    return statements;
}

/** 接入模式只有两档；未设置或非法一律按自动，避免升级后已配好的设备变成离线。 */
function accessModeOf(device) {
    return device && device.access_mode === 'manual' ? 'manual' : 'auto';
}

function insertDevice(device) {
    const d = device || {};
    return 'INSERT INTO devices (id, name, type, parent_id, bands, install_offset_deg, ' +
        'access_mode, travel_timeout_sec, notes, config_json, created_ts, updated_ts) VALUES (' +
        esc(d.id) + ', ' + esc(d.name) + ', ' + esc(d.type) + ', ' + esc(d.parent_id) + ', ' +
        esc((d.bands || []).join(',')) + ', ' + num(d.install_offset_deg) + ', ' +
        esc(accessModeOf(d)) + ', ' + num(d.travel_timeout_sec) + ', ' + esc(d.notes) + ', ' +
        esc(JSON.stringify(d.config || {})) + ', ' +
        esc(d.created_ts) + ', ' + esc(d.updated_ts) + ');';
}

function updateDevice(device) {
    const d = device || {};
    return 'UPDATE devices SET name = ' + esc(d.name) + ', type = ' + esc(d.type) +
        ', parent_id = ' + esc(d.parent_id) +
        ', bands = ' + esc((d.bands || []).join(',')) +
        ', install_offset_deg = ' + num(d.install_offset_deg) +
        ", access_mode = '" + accessModeOf(d) + "'" +
        ', travel_timeout_sec = ' + num(d.travel_timeout_sec) +
        ', notes = ' + esc(d.notes) + ', config_json = ' + esc(JSON.stringify(d.config || {})) +
        ', updated_ts = ' + esc(d.updated_ts) +
        ' WHERE id = ' + esc(d.id) + ';';
}

function deleteDevice(id) {
    return 'DELETE FROM devices WHERE id = ' + esc(id) + ';';
}

function insertTxSource(source) {
    const s = source || {};
    return 'INSERT INTO tx_sources (source_id, name, priority, timeout_ms, device_id, token, ' +
        'created_ts, updated_ts) VALUES (' + esc(s.source_id) + ', ' + esc(s.name) + ', ' +
        num(s.priority) + ', ' + num(s.timeout_ms) + ', ' + esc(s.device_id) + ', ' + esc(s.token) + ', ' +
        esc(s.created_ts) + ', ' + esc(s.updated_ts) + ');';
}

function insertTxSourceIfMissing(source) {
    return insertTxSource(source).replace('INSERT INTO tx_sources', 'INSERT OR IGNORE INTO tx_sources');
}

function updateTxSource(source) {
    const s = source || {};
    return 'UPDATE tx_sources SET name = ' + esc(s.name) + ', priority = ' + num(s.priority) +
        ', timeout_ms = ' + num(s.timeout_ms) + ', device_id = ' + esc(s.device_id) +
        ', token = ' + esc(s.token) +
        ', updated_ts = ' + esc(s.updated_ts) +
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
 * 设备、TX 源与 RF 连线一次取回，并左连接画布布局。
 * TX 源的 token 单独走 `token` 列，不再借用设备口令列。
 */
function snapshotQuery() {
    return "SELECT 'device' AS kind, d.id, d.name, d.type, d.parent_id, d.bands, d.install_offset_deg, " +
        'd.travel_timeout_sec, d.notes, d.config_json, ' +
        'd.created_ts, d.updated_ts, NULL AS priority, NULL AS timeout_ms, ' +
        'l.x AS layout_x, l.y AS layout_y, NULL AS source_id, NULL AS tx_device_id, NULL AS token, ' +
        'NULL AS a_device, NULL AS a_port, NULL AS b_device, NULL AS b_port, NULL AS link_id, ' +
        'NULL AS link_created_ts, d.access_mode' +
        ' FROM devices d LEFT JOIN device_layout l ON l.device_id = d.id' +
        " UNION ALL SELECT 'tx', source_id, name, NULL, NULL, '', 0, 0, NULL, '{}', " +
        'created_ts, updated_ts, priority, timeout_ms, NULL, NULL, source_id, device_id, token, ' +
        'NULL, NULL, NULL, NULL, NULL, NULL, NULL' +
        ' FROM tx_sources' +
        " UNION ALL SELECT 'rf', link_id, NULL, NULL, NULL, '', 0, 0, NULL, '{}', " +
        'created_ts, created_ts, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ' +
        'a_device, a_port, b_device, b_port, link_id, created_ts, NULL' +
        ' FROM rf_links' +
        " UNION ALL SELECT 'ctl', link_id, NULL, NULL, NULL, '', 0, 0, NULL, '{}', " +
        'created_ts, created_ts, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ' +
        'a_device, a_port, b_device, b_port, link_id, created_ts, NULL' +
        ' FROM control_links;';
}

function upsertLayout(id, x, y, updatedTs) {
    return 'INSERT OR REPLACE INTO device_layout (device_id, x, y, updated_ts) VALUES (' +
        esc(id) + ', ' + num(x) + ', ' + num(y) + ', ' + esc(updatedTs) + ');';
}

function deleteLayout(id) {
    return 'DELETE FROM device_layout WHERE device_id = ' + esc(id) + ';';
}

function insertRfLink(link) {
    const l = link || {};
    return 'INSERT OR REPLACE INTO rf_links (link_id, a_device, a_port, b_device, b_port, created_ts) VALUES (' +
        esc(l.link_id) + ', ' + esc(l.a_device) + ', ' + esc(l.a_port) + ', ' +
        esc(l.b_device) + ', ' + esc(l.b_port) + ', ' + esc(l.created_ts) + ');';
}

function deleteRfLink(linkId) {
    return 'DELETE FROM rf_links WHERE link_id = ' + esc(linkId) + ';';
}

function deleteRfLinksForDevice(deviceId) {
    return 'DELETE FROM rf_links WHERE a_device = ' + esc(deviceId) +
        ' OR b_device = ' + esc(deviceId) + ';';
}

function insertControlLink(link) {
    const l = link || {};
    return 'INSERT OR REPLACE INTO control_links (link_id, a_device, a_port, b_device, b_port, created_ts) VALUES (' +
        esc(l.link_id) + ', ' + esc(l.a_device) + ', ' + esc(l.a_port) + ', ' +
        esc(l.b_device) + ', ' + esc(l.b_port) + ', ' + esc(l.created_ts) + ');';
}

function deleteControlLink(linkId) {
    return 'DELETE FROM control_links WHERE link_id = ' + esc(linkId) + ';';
}

function deleteControlLinksForDevice(deviceId) {
    return 'DELETE FROM control_links WHERE a_device = ' + esc(deviceId) +
        ' OR b_device = ' + esc(deviceId) + ';';
}

function insertCommandAudit(row) {
    const r = row || {};
    return 'INSERT INTO device_commands (ts, device_id, seat, operator, command, args, result, error, ip) VALUES (' +
        esc(r.ts) + ', ' + esc(r.device_id) + ', ' + esc(r.seat) + ', ' + esc(r.operator) + ', ' +
        esc(r.command) + ', ' + esc(r.args) + ', ' + esc(r.result) + ', ' + esc(r.error) + ', ' +
        esc(r.ip) + ');';
}

function recentCommandsQuery(limit) {
    const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    return 'SELECT * FROM device_commands ORDER BY id DESC LIMIT ' + n + ';';
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

function readOptionalInt(row, key) {
    const raw = readString(row, key);
    if (raw === '') return null;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
}

function toDevice(row) {
    const bands = readString(row, 'bands');
    const layoutX = readOptionalInt(row, 'layout_x');
    const layoutY = readOptionalInt(row, 'layout_y');
    return {
        id: readString(row, 'id'),
        name: readString(row, 'name'),
        type: readString(row, 'type').toLowerCase(),
        parent_id: readString(row, 'parent_id') || null,
        bands: bands ? bands.split(',').map(v => v.trim()).filter(Boolean) : [],
        install_offset_deg: readInt(row, 'install_offset_deg', 0),
        access_mode: readString(row, 'access_mode') === 'manual' ? 'manual' : 'auto',
        travel_timeout_sec: readInt(row, 'travel_timeout_sec', 0),
        notes: readString(row, 'notes'),
        config: parseConfig(row),
        layout: layoutX !== null && layoutY !== null ? {x: layoutX, y: layoutY} : null,
        layout_saved: layoutX !== null && layoutY !== null,
        created_ts: readString(row, 'created_ts'),
        updated_ts: readString(row, 'updated_ts')
    };
}

function toRfLink(row) {
    return {
        link_id: readString(row, 'link_id') || readString(row, 'id'),
        a_device: readString(row, 'a_device'),
        a_port: readString(row, 'a_port'),
        b_device: readString(row, 'b_device'),
        b_port: readString(row, 'b_port'),
        created_ts: readString(row, 'link_created_ts') || readString(row, 'created_ts')
    };
}

function toControlLink(row) {
    return toRfLink(row);
}

function parseConfig(row) {
    const raw = readString(row, 'config_json');
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
}

function toTxSource(row) {
    return {
        source_id: readString(row, 'source_id') || readString(row, 'id'),
        name: readString(row, 'name'),
        priority: readInt(row, 'priority', 100),
        timeout_ms: readInt(row, 'timeout_ms', 2000),
        device_id: readString(row, 'tx_device_id') || readString(row, 'device_id'),
        token: readString(row, 'token'),
        created_ts: readString(row, 'created_ts'),
        updated_ts: readString(row, 'updated_ts')
    };
}

/**
 * 一次性幂等迁移：塔的限位开关类型与脉冲宽度从全局设置下沉到设备实例。
 *
 * 只补设备 config 里缺的键，已有值一律不动；读 settings 的原始对象
 * （不能走 sanitize，旧键已经从 schema 删除）。失败逐条计数并返回 id，
 * 由 flow 写日志，不静默。
 */
function towerSeedQuery() {    return "SELECT id, config_json FROM devices WHERE lower(type) = 'tower'";
}

function towerSeedMigrations(rows, settings, nowIso) {
    const result = {
        statements: [], written: 0, skipped: 0, failed: 0, failedIds: [],
        source: {limit_switch_type: null, pulse_ms: null}
    };
    if (!settings || typeof settings !== 'object') {
        result.reason = 'settings-unavailable';
        return result;
    }
    const limit = String(settings.towerLimitType || 'NO').toUpperCase() === 'NC' ? 'NC' : 'NO';
    const pulseRaw = Number(settings.towerPulseWidthMs);
    const pulse = Number.isFinite(pulseRaw) && pulseRaw >= 50 && pulseRaw <= 5000 ? Math.round(pulseRaw) : 400;
    result.source = {limit_switch_type: limit, pulse_ms: pulse};
    const at = nowIso || new Date().toISOString();
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = readCell(row, 'id');
        if (!id) {
            result.failed++;
            continue;
        }
        const raw = readCell(row, 'config_json');
        let config;
        try {
            config = raw ? JSON.parse(raw) : {};
        } catch {
            result.failed++;
            result.failedIds.push(id);
            continue;
        }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            result.failed++;
            result.failedIds.push(id);
            continue;
        }
        let changed = false;
        if (config.limit_switch_type !== 'NO' && config.limit_switch_type !== 'NC') {
            config.limit_switch_type = limit;
            changed = true;
        }
        const currentPulse = Number(config.pulse_ms);
        if (!Number.isFinite(currentPulse) || !Number.isInteger(currentPulse) ||
            currentPulse < 50 || currentPulse > 5000) {
            config.pulse_ms = pulse;
            changed = true;
        }
        if (!changed) {
            result.skipped++;
            continue;
        }
        result.statements.push('UPDATE devices SET config_json = ' + esc(JSON.stringify(config)) +
            ', updated_ts = ' + esc(at) + ' WHERE id = ' + esc(id) + ';');
        result.written++;
    }
    return result;
}

/**
 * 全部重置：整表清空设备、TX 源、画布布局与链路。用户确认重置连设备配置一起删，
 * 只清内存运行态不够——启动时会从 devices 表把配置加载回来。审计流水一并清空。
 * 交给 batch 模式一次 exec。
 */
function clearAll() {
    return 'DELETE FROM device_commands; DELETE FROM rf_links; DELETE FROM control_links;' +
        ' DELETE FROM device_layout; DELETE FROM tx_sources; DELETE FROM devices;';
}

module.exports = {
    CREATE_DEVICES,
    CREATE_TX_SOURCES,
    CREATE_DEVICE_COMMANDS,
    CREATE_DEVICE_LAYOUT,
    CREATE_RF_LINKS,
    CREATE_RF_LINKS_PAIR,
    CREATE_CONTROL_LINKS,
    CREATE_CONTROL_LINKS_PAIR,
    COLUMNS,
    createSchema,
    columnsQuery,
    columnPairs,
    addMissingColumns,
    legacyMigrations,
    towerSeedQuery,
    towerSeedMigrations,
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
    upsertLayout,
    deleteLayout,
    insertRfLink,
    deleteRfLink,
    deleteRfLinksForDevice,
    insertControlLink,
    deleteControlLink,
    deleteControlLinksForDevice,
    insertCommandAudit,
    recentCommandsQuery,
    clearAll,
    toDevice,
    toTxSource,
    toRfLink,
    toControlLink
};
