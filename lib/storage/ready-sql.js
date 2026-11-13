'use strict';

/**
 * 启动就绪探针的 schema 期望与查询语句。
 *
 * 单独放在 storage 层：探针本身就是“查 sqlite 实际状态”，
 * SQL 必须和其他 schema 语句住在同一处，而 lib/ready.js 只负责门闩状态机。
 */

const devicesSql = require('./devices-sql.js');

const TABLES = [
    'spots',
    'recording_spots',
    'qsos',
    'neighbors',
    'band_activity',
    'band_activity_call',
    'radio_state',
    'score_state',
    'operator_sessions',
    'alert_rules',
    'devices',
    'tx_sources',
    'device_commands',
    'device_layout',
    'rf_links'
];

const INDEXES = ['idx_spots_spotid', 'rf_links_pair'];

const TRIGGERS = [
    'trg_spots_neighbor_tx',
    'trg_spots_neighbor_rx',
    'trg_spots_band_activity'
];

const COLUMNS = {
    spots: ['spot_id', 'sender_grid', 'receiver_grid', 'dxcc_sender', 'dxcc_receiver'],
    devices: devicesSql.COLUMNS.devices.map(column => column[0]),
    tx_sources: devicesSql.COLUMNS.tx_sources.map(column => column[0]),
    alert_rules: ['seat']
};

function quoted(values) {
    return values.map(value => "'" + String(value).replace(/'/g, "''") + "'").join(', ');
}

/** 一次查询同时覆盖表、索引、触发器与关键列。 */
function probeQuery() {
    const parts = [
        "SELECT 'table' AS kind, name AS value FROM sqlite_master WHERE type='table' AND name IN (" +
            quoted(TABLES) + ')',
        "SELECT 'index' AS kind, name AS value FROM sqlite_master WHERE type='index' AND name IN (" +
            quoted(INDEXES) + ')',
        "SELECT 'trigger' AS kind, name AS value FROM sqlite_master WHERE type='trigger' AND name IN (" +
            quoted(TRIGGERS) + ')'
    ];
    for (const table of Object.keys(COLUMNS)) {
        parts.push("SELECT 'column' AS kind, '" + table + ".' || name AS value FROM pragma_table_info('" +
            table + "')");
    }
    return parts.join(' UNION ALL ');
}

module.exports = {
    TABLES,
    INDEXES,
    TRIGGERS,
    COLUMNS,
    probeQuery
};
