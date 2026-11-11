'use strict';

const {esc, num} = require('./sql.js');

/**
 * 告警规则的独立存储层。
 *
 * 规则故意不放进 uiSettings：uiSettings 是整包读写 + 广播的设置树，
 * 而规则需要逐条新增/编辑/启停/删除，放进设置既会放大冲突，也会让
 * 规则历史不可审计。这里单独一张 alert_rules 表，配套独立 CRUD 接口。
 */

const COLUMNS = [
    'name', 'enabled', 'seat', 'call', 'prefix', 'dxcc', 'cq_zone', 'itu_zone',
    'band', 'mode', 'source', 'from_ts', 'to_ts', 'snr_min', 'snr_max',
    'wpm_min', 'wpm_max', 'not_call', 'not_dxcc', 'not_band', 'not_mode',
    'not_source', 'popup', 'voice', 'sound'
];

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    seat TEXT,
    call TEXT,
    prefix TEXT,
    dxcc TEXT,
    cq_zone TEXT,
    itu_zone TEXT,
    band TEXT,
    mode TEXT,
    source TEXT,
    from_ts TEXT,
    to_ts TEXT,
    snr_min REAL,
    snr_max REAL,
    wpm_min INTEGER,
    wpm_max INTEGER,
    not_call TEXT,
    not_dxcc TEXT,
    not_band TEXT,
    not_mode TEXT,
    not_source TEXT,
    popup INTEGER NOT NULL DEFAULT 1,
    voice INTEGER NOT NULL DEFAULT 0,
    sound INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);`;

function createTable() {
    return CREATE_TABLE;
}

function seatColumnQuery() {
    return "SELECT name FROM pragma_table_info('alert_rules') WHERE name = 'seat';";
}

function migrateSeat(rows) {
    if (!Array.isArray(rows) || rows.length) return null;
    return 'ALTER TABLE alert_rules ADD COLUMN seat TEXT;';
}

function list() {
    return 'SELECT * FROM alert_rules ORDER BY id ASC;';
}

function get(rawId) {
    const id = parseInt(rawId, 10);
    if (!Number.isFinite(id) || id <= 0) return null;
    return 'SELECT * FROM alert_rules WHERE id = ' + id + ';';
}

function quoteList(value) {
    const items = (Array.isArray(value) ? value : String(value === null || value === undefined ? '' : value).split(','))
        .map(item => String(item).trim())
        .filter(Boolean);
    return items.length ? esc(items.join(',')) : 'NULL';
}

function numeric(value) {
    return value === null || value === undefined || value === '' || isNaN(Number(value)) ? 'NULL' : Number(value);
}

function valuesOf(rule) {
    return [
        esc(rule.name),
        numeric(rule.enabled),
        quoteList(rule.seat),
        quoteList(rule.call),
        quoteList(rule.prefix),
        quoteList(rule.dxcc),
        quoteList(rule.cqZone),
        quoteList(rule.ituZone),
        quoteList(rule.band),
        quoteList(rule.mode),
        quoteList(rule.source),
        rule.from ? esc(rule.from) : 'NULL',
        rule.to ? esc(rule.to) : 'NULL',
        numeric(rule.snrMin),
        numeric(rule.snrMax),
        numeric(rule.wpmMin),
        numeric(rule.wpmMax),
        quoteList(rule.notCall),
        quoteList(rule.notDxcc),
        quoteList(rule.notBand),
        quoteList(rule.notMode),
        quoteList(rule.notSource),
        numeric(rule.popup),
        numeric(rule.voice),
        numeric(rule.sound)
    ];
}

function insert(rule) {
    if (!rule || !rule.name) return null;
    const now = new Date().toISOString();
    return 'INSERT INTO alert_rules (' + COLUMNS.join(', ') + ', created_at, updated_at) VALUES (' +
        valuesOf(rule).join(', ') + ', ' + esc(now) + ', ' + esc(now) + ');';
}

function update(rule) {
    if (!rule || !rule.id) return null;
    const values = valuesOf(rule);
    const assignments = COLUMNS.map((column, index) => column + ' = ' + values[index]);
    assignments.push('updated_at = ' + esc(new Date().toISOString()));
    return 'UPDATE alert_rules SET ' + assignments.join(', ') + ' WHERE id = ' + numeric(rule.id) + ';';
}

function remove(rawId) {
    const id = parseInt(rawId, 10);
    if (!Number.isFinite(id) || id <= 0) return null;
    return 'DELETE FROM alert_rules WHERE id = ' + id + ';';
}

/** QSO 快照：只取告警索引需要的列，按时间升序，便于一次扫描建索引。 */
function qsoSnapshot(rawLimit) {
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 20000, 1), 50000);
    return 'SELECT timestamp, call, band, contestname FROM qsos ORDER BY timestamp ASC LIMIT ' + limit + ';';
}

module.exports = {
    COLUMNS,
    createTable,
    seatColumnQuery,
    migrateSeat,
    list,
    get,
    insert,
    update,
    remove,
    qsoSnapshot
};
