'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ingestApi = require('../lib/qsos/ingest.js');
const schema = require('../lib/storage/schema.js');

const NOW = new Date('2026-11-08T12:34:00.000Z');

class Context {
    constructor() { this.values = {}; }
    get(k) { return this.values[k]; }
    set(k, v) { this.values[k] = v; }
}

test('建表清单包含 N1MM 状态表，启动时与其它 schema 一起下发', () => {
    assert.equal(typeof schema.createN1mm, 'function');
    const statements = schema.createN1mm();
    assert.equal(statements.length, 3);
    assert.match(statements[0], /CREATE TABLE IF NOT EXISTS radio_state/);
    assert.match(statements[0], /seat TEXT PRIMARY KEY/);
    assert.match(statements[1], /CREATE TABLE IF NOT EXISTS score_state/);
    assert.match(statements[2], /CREATE TABLE IF NOT EXISTS operator_sessions/);
});

test('令牌比较与提取：头优先、查询兜底、空值拒绝', () => {
    assert.equal(ingestApi.tokenFrom({headers: {'X-DX-Token': 'abc'}}), 'abc');
    assert.equal(ingestApi.tokenFrom({headers: {'x-dx-token': 'abc'}}), 'abc');
    assert.equal(ingestApi.tokenFrom({headers: {}, query: {token: 'q'}}), 'q');
    assert.equal(ingestApi.tokenFrom({}), '');
    assert.equal(ingestApi.authorized('secret', 'secret'), true);
    assert.equal(ingestApi.authorized('secre', 'secret'), false);
    assert.equal(ingestApi.authorized('', 'secret'), false);
    assert.equal(ingestApi.authorized('secret', ''), false);
    assert.equal(ingestApi.authorized('x'.repeat(201), 'x'.repeat(201)), false);
});

test('QSO 包落库到 qsos，并写内存广播事件', () => {
    const ctx = new Context();
    const result = ingestApi.ingest(ctx, {contactinfo: {
        ID: '{1}', call: 'k1abc', band: '20', mode: 'CW', rxfreq: '14025000',
        timestamp: '2026-11-08 12:30:00', mycall: 'N0CALL', points: '3',
        ismultiplier1: '1'
    }}, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'qso');
    assert.equal(result.event.call, 'K1ABC');
    assert.match(result.sql, /^INSERT OR REPLACE INTO qsos/);
    assert.match(result.sql, /K1ABC/);
    assert.match(result.sql, /14025/);
});

test('缺 ID 的 QSO 生成稳定键，重复投递不会新增行', () => {
    const ctx = new Context();
    const payload = {contactinfo: {call: 'K1ABC', band: '20', mode: 'CW',
        timestamp: '2026-11-08 12:30:00'}};
    const first = ingestApi.ingest(ctx, payload, NOW);
    const second = ingestApi.ingest(ctx, payload, NOW);
    assert.equal(first.event.n1mmId, second.event.n1mmId);
    assert.match(first.event.n1mmId, /^DXI\|UNIDENTIFIED\|K1ABC\|/);
});

test('电台状态包按席位更新 global 与 radio_state', () => {
    const ctx = new Context();
    const result = ingestApi.ingest(ctx, {RadioInfo: {RadioNr: '1', Freq: '14025000',
        Mode: 'CW', IsRunning: 'True'}}, NOW);
    assert.equal(result.kind, 'radio');
    assert.match(result.sql, /^INSERT OR REPLACE INTO radio_state/);
    assert.match(result.sql, /'UNIDENTIFIED'/);
    assert.equal(ctx.get('radioState').isRunning, true);
    assert.equal(ctx.get('radioStates').UNIDENTIFIED.freqKhz, 14025);
});

test('分数包写入 score_state', () => {
    const ctx = new Context();
    const result = ingestApi.ingest(ctx, {dynamicresults: {contest: ['CQWW'],
        score: ['1234'], breakdown: [{$: {band: 'total'},
            qso: [{$: {band: 'total', mode: 'ALL'}, _: '10'}],
            mult: [{$: {band: 'total', mode: 'ALL'}, _: '4'}]}]}}, NOW);
    assert.equal(result.kind, 'score');
    assert.match(result.sql, /^INSERT OR REPLACE INTO score_state/);
    assert.equal(ctx.get('scoreState').qsos, 10);
});

test('删除包按 n1mm_id 删除', () => {
    const result = ingestApi.ingest(new Context(), {contactdelete: {ID: '{9}', call: 'K1ABC'}}, NOW);
    assert.equal(result.kind, 'delete');
    assert.match(result.sql, /^DELETE FROM qsos WHERE n1mm_id = 'DXI\|UNIDENTIFIED\|\{9\}'/);
});

test('未识别包返回 400，不写库', () => {
    const result = ingestApi.ingest(new Context(), {mystery: true}, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.sql, undefined);
});

test('重启恢复只在内存为空时生效', () => {
    const rows = [
        {kind: 'radio', id: 'LOCAL:1', radio_nr: '1', instance: 'LOCAL', ts: NOW.toISOString(),
            freq_khz: 14025, tx_freq_khz: 14025, mode: 'CW', is_running: 1,
            is_transmitting: 0, is_split: 0, op_call: 'OP', radio_name: 'R1', station_name: ''},
        {kind: 'score', id: 'live', ts: NOW.toISOString(), contest: 'CQWW',
            qsos: 10, mults: 4, points: 30, score: 120}
    ];
    const ctx = new Context();
    assert.equal(ingestApi.restore(ctx, rows), true);
    assert.equal(ctx.get('radioState').freqKhz, 14025);
    assert.equal(ctx.get('scoreState').qsos, 10);

    const live = new Context();
    live.set('radioState', {type: 'radio', freqKhz: 21025});
    live.set('radioStates', {'LOCAL:1': {type: 'radio', freqKhz: 21025}});
    live.set('scoreState', {qsos: 99});
    assert.equal(ingestApi.restore(live, rows), false);
    assert.equal(live.get('radioState').freqKhz, 21025);
    assert.equal(live.get('scoreState').qsos, 99);
});
