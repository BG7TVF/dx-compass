'use strict';

/**
 * 启动就绪门闩。
 *
 * 不能在请求入口猜“初始化大概跑完了”：表、列、索引、触发器多一个，
 * 或机器慢一点，固定延时就会重新露头。这里的做法是：
 *   1. 启动后由一个 probe 反复查询 sqlite_master / pragma_table_info；
 *   2. 只有全部预期对象真实存在时才 markReady()；
 *   3. HTTP 中间件、MQTT/UDP 回调、定时任务统一 await whenReady()。
 *
 * probe 是“验证实际状态”，不是延时兜底；重试间隔只决定探测频率。
 * schema 期望与 SQL 在 lib/storage/ready-sql.js。
 */

const readySql = require('./storage/ready-sql.js');

const {TABLES, INDEXES, TRIGGERS, COLUMNS, probeQuery} = readySql;

const PROBE_TIMEOUT_MS = 30000;

function cell(row, key) {
    if (!row || typeof row !== 'object') return '';
    const actual = Object.keys(row).find(name => name.toLowerCase() === key);
    return actual === undefined ? '' : String(row[actual] === null || row[actual] === undefined ? '' : row[actual]);
}

/** 返回仍然缺失的对象；空数组即 schema 完整。 */
function missing(rows) {
    const present = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
        const kind = cell(row, 'kind').toLowerCase();
        const value = cell(row, 'value').toLowerCase();
        if (kind && value) present.add(kind + ':' + value);
    }
    const result = [];
    for (const table of TABLES) {
        if (!present.has('table:' + table)) result.push('table ' + table);
    }
    for (const index of INDEXES) {
        if (!present.has('index:' + index)) result.push('index ' + index);
    }
    for (const trigger of TRIGGERS) {
        if (!present.has('trigger:' + trigger)) result.push('trigger ' + trigger);
    }
    for (const table of Object.keys(COLUMNS)) {
        for (const column of COLUMNS[table]) {
            const key = 'column:' + (table + '.' + column).toLowerCase();
            if (!present.has(key)) result.push('column ' + table + '.' + column);
        }
    }
    return result;
}

function summary(rows) {
    return {
        tables: TABLES.length,
        indexes: INDEXES.length,
        triggers: TRIGGERS.length,
        columns: Object.keys(COLUMNS).reduce((sum, table) => sum + COLUMNS[table].length, 0),
        rows: Array.isArray(rows) ? rows.length : 0
    };
}

function createGate() {
    let state = 'pending';
    let lastError = null;
    let resolvePending;
    const pending = new Promise(resolve => {
        resolvePending = resolve;
    });

    function markReady() {
        if (state !== 'pending') return state;
        state = 'ready';
        resolvePending();
        return state;
    }

    function markFailed(error) {
        if (state !== 'pending') return state;
        state = 'failed';
        lastError = error instanceof Error ? error : new Error(String(error || 'schema-init-failed'));
        resolvePending();
        return state;
    }

    /** 等待初始化；真正失败时抛出，而不是假装就绪。 */
    function whenReady() {
        return pending.then(() => {
            if (state !== 'ready') throw lastError || new Error('schema-init-failed');
        });
    }

    function status() {
        return {state, error: lastError ? lastError.message : null};
    }

    return {markReady, markFailed, whenReady, status};
}

const gate = createGate();

module.exports = {
    PROBE_TIMEOUT_MS,
    TABLES,
    INDEXES,
    TRIGGERS,
    COLUMNS,
    probeQuery,
    missing,
    summary,
    createGate,
    whenReady: gate.whenReady,
    markReady: gate.markReady,
    markFailed: gate.markFailed,
    status: gate.status
};
