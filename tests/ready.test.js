'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ready = require('../lib/ready.js');

/** 构造一次“完整 schema”的 probe 返回，便于逐项删除验证检测能力。 */
function completeRows() {
    const rows = [];
    for (const table of ready.TABLES) rows.push({kind: 'table', value: table});
    for (const index of ready.INDEXES) rows.push({kind: 'index', value: index});
    for (const trigger of ready.TRIGGERS) rows.push({kind: 'trigger', value: trigger});
    for (const table of Object.keys(ready.COLUMNS)) {
        for (const column of ready.COLUMNS[table]) rows.push({kind: 'column', value: table + '.' + column});
    }
    return rows;
}

test('probeQuery covers every expected schema object', () => {
    const sql = ready.probeQuery();
    assert.match(sql, /sqlite_master/);
    assert.match(sql, /pragma_table_info/);
    for (const table of ready.TABLES) assert.ok(sql.includes("'" + table + "'"), table);
    for (const index of ready.INDEXES) assert.ok(sql.includes("'" + index + "'"), index);
    for (const trigger of ready.TRIGGERS) assert.ok(sql.includes("'" + trigger + "'"), trigger);
    for (const table of Object.keys(ready.COLUMNS)) {
        assert.ok(sql.includes("pragma_table_info('" + table + "')"), table);
    }
});

test('missing returns nothing for a complete schema', () => {
    assert.deepEqual(ready.missing(completeRows()), []);
});

test('missing reports absent tables, indexes, triggers and columns', () => {
    const rows = completeRows()
        .filter(row => !(row.kind === 'table' && row.value === 'rf_links'))
        .filter(row => !(row.kind === 'index' && row.value === 'rf_links_pair'))
        .filter(row => !(row.kind === 'trigger' && row.value === 'trg_spots_band_activity'))
        .filter(row => !(row.kind === 'column' && row.value === 'devices.travel_timeout_sec'));
    const result = ready.missing(rows);
    assert.deepEqual(result, [
        'table rf_links',
        'index rf_links_pair',
        'trigger trg_spots_band_activity',
        'column devices.travel_timeout_sec'
    ]);
});

test('missing tolerates column casing and non-array payloads', () => {
    const rows = completeRows().map(row => ({
        KIND: row.kind.toUpperCase(),
        Value: row.value.toUpperCase()
    }));
    assert.deepEqual(ready.missing(rows), []);
    assert.equal(ready.missing(null).length, ready.TABLES.length + ready.INDEXES.length +
        ready.TRIGGERS.length + Object.keys(ready.COLUMNS)
        .reduce((sum, table) => sum + ready.COLUMNS[table].length, 0));
});

test('gate stays pending until markReady', async () => {
    const gate = ready.createGate();
    let settled = false;
    const waiting = gate.whenReady().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false);
    assert.equal(gate.status().state, 'pending');
    gate.markReady();
    await waiting;
    assert.equal(settled, true);
    assert.equal(gate.status().state, 'ready');
    // 已就绪后重复标记不会回退状态
    assert.equal(gate.markFailed(new Error('late')), 'ready');
});

test('gate rejects waiters when schema init fails', async () => {
    const gate = ready.createGate();
    gate.markFailed(new Error('schema init timeout: table rf_links'));
    await assert.rejects(gate.whenReady(), /schema init timeout: table rf_links/);
    assert.equal(gate.status().state, 'failed');
    // 失败后迟到的 ready 不应把状态改回去
    assert.equal(gate.markReady(), 'failed');
});

test('gate accepts non-error rejection reasons as text', async () => {
    const gate = ready.createGate();
    gate.markFailed('boom');
    await assert.rejects(gate.whenReady(), /boom/);
});
