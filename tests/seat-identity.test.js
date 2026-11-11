'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ingestApi = require('../lib/qsos/ingest.js');
const seatIdentity = require('../lib/qsos/seat-identity.js');
const service = require('../lib/qsos/service.js');

const NOW = new Date('2026-11-12T08:00:00.000Z');

class Context {
    constructor() { this.values = {}; }
    get(k) { return this.values[k]; }
    set(k, v) { this.values[k] = v; }
}

function contact(computerName, radioNr, id) {
    const payload = {
        ID: [id || '{1}'], call: 'K1ABC', band: '20', mode: 'CW', rxfreq: '14025000',
        timestamp: '2026-11-12 07:59:00', mycall: 'N0CALL', points: '1', radionr: [radioNr],
        StationName: ['']
    };
    if (computerName) payload.ComputerName = [computerName];
    return {contactinfo: payload};
}

function radio(radioName, radioNr, opCall) {
    return {RadioInfo: {
        RadioNr: [radioNr], RadioName: [radioName], Freq: ['14025000'], Mode: ['CW'],
        IsRunning: ['True'], OpCall: [opCall || 'OP1'], StationName: ['']
    }};
}

function feed(ctx, computerName, radioName, radioNr, source, id) {
    ingestApi.ingest(ctx, contact(computerName, radioNr, id), NOW, source);
    return ingestApi.ingest(ctx, radio(radioName, radioNr), NOW, source);
}

function seats(ctx) {
    return service.stationState(ctx).seats.map(item => item.seat);
}

test('验收：两个不同 ComputerName 的实例分成两个席位', () => {
    const ctx = new Context();
    const a = feed(ctx, 'PC-ALPHA', 'ICOM', '1', {ip: '10.0.0.10', port: '50001'}, '{A}');
    const b = feed(ctx, 'PC-BRAVO', 'YAESU', '1', {ip: '10.0.0.11', port: '50002'}, '{B}');
    assert.equal(a.event.seat, 'PC-ALPHA:1');
    assert.equal(b.event.seat, 'PC-BRAVO:1');
    assert.equal(a.event.seatRule, 'computer');
    assert.equal(b.event.seatRule, 'computer');
    assert.deepEqual(seats(ctx).sort(), ['PC-ALPHA:1', 'PC-BRAVO:1']);
    assert.equal(seatIdentity.summary(ctx).seats.length, 2);
});

test('验收：同一 ComputerName 下两个 RadioNr 不会被合并', () => {
    const ctx = new Context();
    // SO2R：同一台机器、同一 ComputerName，两个 N1MM 实例，源端口不同。
    const one = feed(ctx, 'PC-SO2R', 'Radio1', '1', {ip: '10.0.0.20', port: '50001'}, '{1}');
    const two = feed(ctx, 'PC-SO2R', 'Radio2', '2', {ip: '10.0.0.20', port: '50002'}, '{2}');
    assert.equal(one.event.seat, 'PC-SO2R:1');
    assert.equal(two.event.seat, 'PC-SO2R:2');
    assert.deepEqual(seats(ctx).sort(), ['PC-SO2R:1', 'PC-SO2R:2']);
});

test('验收：重连后沿用既有绑定，席位不跳变', () => {
    const ctx = new Context();
    const first = feed(ctx, 'PC-STABLE', 'ICOM', '1', {ip: '10.0.0.30', port: '50001'}, '{1}');
    const initialKey = first.event.seat;
    // 模拟前端/状态重建：只清实时电台状态，绑定留在 global 里。
    ctx.set('radioStates', {});
    ctx.set('radioState', null);
    const afterReconnect = feed(ctx, 'PC-STABLE', 'ICOM', '1', {ip: '10.0.0.30', port: '50001'}, '{2}');
    assert.equal(afterReconnect.event.seat, initialKey);
    assert.equal(seatIdentity.summary(ctx).seats.length, 1);
});

test('ContactInfo 与 RadioInfo 分报文时按 UDP 源关联', () => {
    const ctx = new Context();
    const source = {ip: '10.0.0.40', port: '50001'};
    // ContactInfo 只有 ComputerName。
    ingestApi.ingest(ctx, contact('PC-CORRELATE', '1', '{1}'), NOW, source);
    // RadioInfo 只有 RadioName / RadioNr。
    const result = ingestApi.ingest(ctx, radio('ICOM-7610', '1'), NOW, source);
    assert.equal(result.event.seat, 'PC-CORRELATE:1');
    assert.equal(result.event.seatRule, 'computer');
    assert.equal(result.event.computerName, 'PC-CORRELATE');
    assert.equal(result.event.radioName, 'ICOM-7610');
});

test('显式 --station 优先于自动识别', () => {
    const ctx = new Context();
    const result = ingestApi.ingest(ctx, radio('ICOM', '1'), NOW,
        {station: 'RUN', ip: '10.0.0.50', port: '50001'});
    assert.equal(result.event.seat, 'RUN:1');
    assert.equal(result.event.seatRule, 'explicit');
});

test('没有 ComputerName 时降到源 IP + RadioNr', () => {
    const ctx = new Context();
    const result = ingestApi.ingest(ctx, radio('ICOM', '2'), NOW, {ip: '10.0.0.60', port: '50001'});
    assert.equal(result.event.seat, '10.0.0.60:2');
    assert.equal(result.event.seatRule, 'source');
});

test('识别不到的报文进未识别席位桶，不进 seats', () => {
    const ctx = new Context();
    const result = ingestApi.ingest(ctx, radio('ICOM', '1'), NOW, {});
    assert.equal(result.event.seat, 'UNIDENTIFIED');
    const state = service.stationState(ctx);
    assert.deepEqual(state.seats, []);
    assert.equal(state.unidentifiedSeat.seat, 'UNIDENTIFIED');
    assert.equal(state.seatIdentities.unidentified.count, 1);
});

test('设置页可改名、覆盖席位名、解绑，改动留痕且解绑后进桶', () => {
    const ctx = new Context();
    feed(ctx, 'PC-MANUAL', 'ICOM', '1', {ip: '10.0.0.70', port: '50001'}, '{1}');
    const identity = seatIdentity.summary(ctx).seats[0].identity;

    const renamed = seatIdentity.changeIdentity(ctx, {identity, action: 'rename', displayName: '主台'}, NOW);
    assert.equal(renamed.ok, true);
    assert.equal(renamed.seat.displayName, '主台');

    const overridden = seatIdentity.changeIdentity(ctx, {identity, action: 'override', seatKey: 'RUN:1'}, NOW);
    assert.equal(overridden.ok, true);
    assert.equal(overridden.seat.seatKey, 'RUN:1');
    assert.equal(overridden.seat.manual, true);
    assert.equal(ctx.get('radioStates')['RUN:1'] !== undefined, true);

    const unbound = seatIdentity.changeIdentity(ctx, {identity, action: 'unbind'}, NOW);
    assert.equal(unbound.ok, true);
    assert.equal(unbound.seat.unbound, true);

    const afterUnbind = ingestApi.ingest(ctx, radio('ICOM', '1'), NOW, {ip: '10.0.0.70', port: '50001'});
    assert.equal(afterUnbind.event.seat, 'UNIDENTIFIED');

    const history = seatIdentity.list(ctx).history;
    assert.equal(history.some(item => item.action === 'identified'), true);
    assert.equal(history.some(item => item.action === 'rename' && item.actor === 'user'), true);
    assert.equal(history.some(item => item.action === 'unbind' && item.unbound === true), true);

    const rebound = seatIdentity.changeIdentity(ctx, {identity, action: 'bind', seatKey: 'RUN:1'}, NOW);
    assert.equal(rebound.ok, true);
    assert.equal(rebound.seat.unbound, false);
});

test('同一 ComputerName 与 RadioNr 但 RadioName 不同时仍分开', () => {
    const ctx = new Context();
    feed(ctx, 'PC-TWIN', 'Radio1', '1', {ip: '10.0.0.80', port: '50001'}, '{1}');
    const second = feed(ctx, 'PC-TWIN', 'Radio2', '1', {ip: '10.0.0.80', port: '50002'}, '{2}');
    assert.equal(seatIdentity.summary(ctx).seats.length, 2);
    assert.notEqual(second.event.seat, 'PC-TWIN:1');
});
