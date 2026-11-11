'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ingestApi = require('../lib/qsos/ingest.js');
const engine = require('../lib/advice/engine.js');
const adviceService = require('../lib/advice/service.js');
const adviceSql = require('../lib/storage/advice-sql.js');
const seatApi = require('../lib/qsos/seat.js');

const NOW = new Date('2026-11-08T12:40:00.000Z');

class Context {
    constructor() { this.values = {}; }
    get(k) { return this.values[k]; }
    set(k, v) { this.values[k] = v; }
}

function contact(station, id) {
    return {contactinfo: {
        ID: id, call: 'K1ABC', band: '20', mode: 'CW', rxfreq: '14025000',
        timestamp: '2026-11-08 12:30:00', mycall: 'N0CALL', points: '3',
        StationName: station
    }};
}

function radioInfo(station, opCall) {
    return {RadioInfo: {
        RadioNr: '1', Freq: '14025000', Mode: 'CW', IsRunning: 'True',
        StationName: station, OpCall: opCall
    }};
}

function seqRows() {
    return [
        {kind: 'band', band: '20', qsos: 30, points: 90, mults: 10,
            first_ts: '2026-11-08T12:01:00.000Z', last_ts: '2026-11-08T12:20:00.000Z'},
        {kind: 'band', band: '40', qsos: 10, points: 30, mults: 5,
            first_ts: '2026-11-08T12:10:00.000Z', last_ts: '2026-11-08T12:10:00.000Z'},
        {kind: 'band', band: '15', qsos: 8, points: 24, mults: 4,
            first_ts: '2026-11-08T12:02:00.000Z', last_ts: '2026-11-08T12:30:00.000Z'},
        // RUN 席：20 → 40 → 20，计 2 次换波段
        {kind: 'seq', band: '20', bucket: '2026-11-08T12:01:00.000Z',
            ref: 'DXI|RUN|1', radio: '1', station: 'RUN'},
        {kind: 'seq', band: '40', bucket: '2026-11-08T12:10:00.000Z',
            ref: 'DXI|RUN|2', radio: '1', station: 'RUN'},
        {kind: 'seq', band: '20', bucket: '2026-11-08T12:20:00.000Z',
            ref: 'DXI|RUN|3', radio: '1', station: 'RUN'},
        // MULT 席：一直守 15m，0 次
        {kind: 'seq', band: '15', bucket: '2026-11-08T12:02:00.000Z',
            ref: 'DXI|MULT|1', radio: '1', station: 'MULT'},
        {kind: 'seq', band: '15', bucket: '2026-11-08T12:30:00.000Z',
            ref: 'DXI|MULT|2', radio: '1', station: 'MULT'}
    ];
}

const RADIOS = {
    'RUN:1': {seat: 'RUN:1', radioNr: '1', stationName: 'RUN', freqKhz: 14025,
        mode: 'CW', isRunning: true},
    'MULT:1': {seat: 'MULT:1', radioNr: '1', stationName: 'MULT', freqKhz: 21025,
        mode: 'CW', isRunning: false}
};

function settings(overrides) {
    return Object.assign({
        category: 'M2',
        contestType: 'CQWW',
        contestName: 'CQ WW DX CW',
        grid: 'EM12',
        contestStart: '2026-11-08T00:00',
        contestEnd: '2026-11-09T00:00',
        multMode: 'dxcc-per-band',
        txPowerW: 100,
        adviceMinConfidence: 'low'
    }, overrides || {});
}

function run(seat, overrides) {
    return engine.buildAdvice({
        settings: settings(overrides),
        rows: seqRows(),
        prop: {},
        radio: RADIOS['RUN:1'],
        radios: RADIOS,
        seat,
        activeEntities: 342,
        cooldown: {},
        now: NOW
    });
}

test('同一 ID 的多个 N1MM 实例写入不同命名空间，不互相覆盖', () => {
    const ctx = new Context();
    const one = ingestApi.ingest(ctx, contact('RUN', '7'), NOW);
    const two = ingestApi.ingest(ctx, contact('MULT', '7'), NOW);
    assert.equal(one.event.n1mmId, 'DXI|RUN|7');
    assert.equal(two.event.n1mmId, 'DXI|MULT|7');
    assert.notEqual(one.sql, two.sql);
});

test('两台 RadioNr 都是 1 时按 station 分开保存状态', () => {
    const ctx = new Context();
    ingestApi.ingest(ctx, radioInfo('RUN', 'OP1'), NOW);
    ingestApi.ingest(ctx, radioInfo('MULT', 'OP2'), NOW);
    assert.deepEqual(Object.keys(ctx.get('radioStates')).sort(), ['MULT:1', 'RUN:1']);
    const seats = ctx.get('radioStates');
    assert.equal(seats['RUN:1'].seat, 'RUN:1');
    assert.equal(seats['MULT:1'].seat, 'MULT:1');
});

test('操作员只在 OpCall 变化时写轮换记录', () => {
    const ctx = new Context();
    const first = ingestApi.ingest(ctx, radioInfo('RUN', 'OP1'), NOW);
    assert.match(first.sessionSql, /INSERT INTO operator_sessions/);
    const same = ingestApi.ingest(ctx, radioInfo('RUN', 'OP1'),
        new Date('2026-11-08T12:41:00.000Z'));
    assert.equal(same.sessionSql, null);
    const next = ingestApi.ingest(ctx, radioInfo('RUN', 'OP2'),
        new Date('2026-11-08T12:42:00.000Z'));
    assert.match(next.sessionSql, /'OP2'/);
    assert.equal(ctx.get('operatorSessions')['RUN:1'].operator, 'OP2');
});

test('M2 换波段按席位分别计数，20→40→20 计 2 次', () => {
    const runSeat = run('RUN:1');
    assert.equal(runSeat.seat, 'RUN:1');
    assert.equal(runSeat.gates.changesThisHour, 2);
    assert.equal(runSeat.gates.quota, 8);
    assert.equal(runSeat.gates.quotaRemaining, 6);

    const multSeat = run('MULT:1');
    assert.equal(multSeat.gates.changesThisHour, 0);
    assert.equal(multSeat.gates.quotaRemaining, 8);

    assert.equal(runSeat.seats.length, 2);
    const lanes = Object.fromEntries(runSeat.seats.map(item => [item.seat, item]));
    assert.equal(lanes['RUN:1'].changesThisHour, 2);
    assert.equal(lanes['MULT:1'].changesThisHour, 0);
});

test('ARRL DX 的 M2 配额是 6，CQ WW / WPX 是 8', () => {
    assert.equal(run('RUN:1', {contestType: 'ARRL_DX'}).gates.quota, 6);
    assert.equal(run('RUN:1', {contestType: 'CQWPX'}).gates.quota, 8);
});

test('M2 没有乘数台身份，不生成 G3/S3；CQ WW MS 才生成', () => {
    const m2 = run('RUN:1', {msRole: 'mult'});
    const ids = m2.advice.map(item => item.id);
    assert.equal(ids.includes('G3'), false);
    assert.equal(ids.includes('S3'), false);

    const ms = engine.buildAdvice({
        settings: settings({category: 'MS', msRole: 'mult'}),
        rows: seqRows(),
        prop: {},
        radio: {freqKhz: 14025, mode: 'CW', isRunning: true},
        activeEntities: 342,
        cooldown: {},
        now: NOW
    });
    const msIds = ms.advice.map(item => item.id);
    assert.ok(msIds.includes('G3'), msIds.join(','));
    assert.ok(msIds.includes('S3'), msIds.join(','));
});

test('MM 只评估波段开人，不生成换波段建议', () => {
    const result = run('RUN:1', {category: 'MM'});
    const ids = result.advice.map(item => item.id);
    assert.ok(ids.includes('G9'));
    assert.equal(ids.some(id => id.startsWith('B')), false);
    assert.equal(result.gates.blockBandChange, 'G9');
});

test('advice 的 seq 段携带 n1mm_id / radionr / stationname', () => {
    const {sql} = adviceSql.adviceQuery({
        settings: {}, now: NOW, minutes: 10, multMode: 'dxcc-per-band',
        recent3h: '2026-11-08T09:40:00.000Z', activitySince: '2026-11-08T11:40'
    });
    assert.match(sql, /'seq', band, timestamp/);
    assert.match(sql, /n1mm_id, radionr, stationname/);
    assert.equal(seatApi.seatOfRow({ref: 'DXI|RUN|9', radio: '1'}), 'RUN:1');
    assert.equal(seatApi.seatOfRow({station: 'MULT', radio: '1'}), 'MULT:1');
});

test('/api/advice?seat= 回显席位并返回双 lane', () => {
    const prepared = adviceService.prepare({seat: 'MULT:1'}, settings(), NOW);
    assert.equal(prepared.request.seat, 'MULT:1');
    const result = adviceService.complete(prepared, seqRows(), {
        prop: {}, radio: RADIOS['RUN:1'], radios: RADIOS
    });
    assert.equal(result.seat, 'MULT:1');
    assert.equal(result.gates.changesThisHour, 0);
    assert.equal(result.seats.length, 2);
    assert.equal(result.request.seat, 'MULT:1');
});
