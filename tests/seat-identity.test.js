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

test('候选集汇聚 ComputerName 与 RadioName，并保留最近出现时间', () => {
    const ctx = new Context();
    feed(ctx, 'PC-ALPHA', 'ICOM', '1', {ip: '10.0.0.90', port: '50001'}, '{A}');
    feed(ctx, 'PC-ALPHA', 'YAESU', '2', {ip: '10.0.0.90', port: '50002'}, '{B}');
    const later = new Date('2026-11-12T08:05:00.000Z');
    ingestApi.ingest(ctx, radio('ICOM', '1'), later, {ip: '10.0.0.90', port: '50001'});

    const view = seatIdentity.candidates(ctx);
    assert.deepEqual(view.computers.map(item => item.name), ['PC-ALPHA']);
    assert.deepEqual(view.radios.map(item => item.name).sort(), ['ICOM', 'YAESU']);
    const icom = view.pairs.find(item => item.radioName === 'ICOM');
    assert.equal(icom.computerName, 'PC-ALPHA');
    assert.equal(icom.lastSeen, later.toISOString());
    assert.equal(view.updatedAt, later.toISOString());
    assert.equal(seatIdentity.list(ctx).candidates.computers.length, 1);
});

test('候选集只收到 ComputerName 时保留计算机名，型号为空', () => {
    const ctx = new Context();
    ingestApi.ingest(ctx, contact('PC-ONLY', '1', '{C}'), NOW, {ip: '10.0.0.91', port: '50001'});
    const view = seatIdentity.candidates(ctx);
    assert.deepEqual(view.computers.map(item => item.name), ['PC-ONLY']);
    assert.deepEqual(view.radios, []);
    assert.equal(view.pairs.length, 1);
    assert.equal(view.pairs[0].radioName, '');
});

test('候选集按大小写不敏感去重，并采用最近一次的写法', () => {
    const ctx = new Context();
    ingestApi.ingest(ctx, contact('PC-Case', '1', '{D}'), NOW, {ip: '10.0.0.92', port: '50001'});
    const later = new Date('2026-11-12T08:06:00.000Z');
    ingestApi.ingest(ctx, contact('pc-case', '1', '{E}'), later, {ip: '10.0.0.92', port: '50001'});
    const view = seatIdentity.candidates(ctx);
    assert.equal(view.computers.length, 1);
    assert.equal(view.computers[0].name, 'pc-case');
    assert.equal(view.updatedAt, later.toISOString());
});


function contactStation(stationName, radioNr, id, computerName) {
    const payload = {
        ID: [id || '{S1}'], call: 'K1ABC', band: '20', mode: 'CW', rxfreq: '14025000',
        timestamp: '2026-11-12 07:59:00', mycall: 'N0CALL', points: '1', radionr: [radioNr],
        StationName: [stationName]
    };
    if (computerName) payload.ComputerName = [computerName];
    return {contactinfo: payload};
}

function radioStation(radioName, radioNr, stationName, computerName) {
    const payload = {
        RadioNr: [radioNr], RadioName: [radioName], Freq: ['14025000'], Mode: ['CW'],
        IsRunning: ['True'], OpCall: ['OP1'], StationName: [stationName]
    };
    if (computerName) payload.ComputerName = [computerName];
    return {RadioInfo: payload};
}

test('验收：StationName 就是计算机标识，席位按 BG7TVF-2 匹配', () => {
    const ctx = new Context();
    const source = {ip: '10.0.0.80', port: '50001'};
    const first = ingestApi.ingest(ctx, contactStation('BG7TVF-2', '1', '{S1}'), NOW, source);
    assert.equal(first.event.seatRule, 'computer');
    assert.equal(first.event.computerName, '');
    const second = ingestApi.ingest(ctx, radioStation('FT-817', '1', 'BG7TVF-2'), NOW, source);
    assert.equal(second.event.seat, 'BG7TVF-2:1');
    assert.equal(second.event.seatRule, 'computer');
    assert.equal(second.event.radioName, 'FT-817');
    assert.deepEqual(seats(ctx), ['BG7TVF-2:1']);
    const record = seatIdentity.summary(ctx).seats[0];
    assert.equal(record.stationName, 'BG7TVF-2');
    assert.equal(record.computerName, '');
    assert.equal(record.seatKey, 'BG7TVF-2:1');
});

test('ComputerName 与 StationName 并存：优先 ComputerName，候选两者都在', () => {
    const ctx = new Context();
    const source = {ip: '10.0.0.81', port: '50001'};
    ingestApi.ingest(ctx, contactStation('BG7TVF-2', '1', '{S2}', 'PC-SHACK'), NOW, source);
    const radio = ingestApi.ingest(ctx, radioStation('FT-817', '1', 'BG7TVF-2', 'PC-SHACK'), NOW, source);
    assert.equal(radio.event.seat, 'PC-SHACK:1');
    const view = seatIdentity.candidates(ctx);
    assert.deepEqual(view.computers.map(item => item.name).sort(), ['BG7TVF-2', 'PC-SHACK']);
    assert.equal(view.pairs.length, 2);
});

test('候选集把 StationName 当作计算机名，大小写不敏感去重', () => {
    const ctx = new Context();
    ingestApi.ingest(ctx, contactStation('BG7TVF-2', '1', '{S3}'), NOW, {ip: '10.0.0.82', port: '50001'});
    ingestApi.ingest(ctx, radioStation('FT-817', '1', 'BG7TVF-2'), NOW, {ip: '10.0.0.82', port: '50001'});
    const later = new Date('2026-11-12T08:07:00.000Z');
    ingestApi.ingest(ctx, radioStation('FT-817', '2', 'bg7tvf-2'), later, {ip: '10.0.0.82', port: '50002'});
    const view = seatIdentity.candidates(ctx);
    assert.deepEqual(view.computers.map(item => item.name), ['bg7tvf-2']);
    assert.deepEqual(view.radios.map(item => item.name), ['FT-817']);
    assert.equal(view.pairs.length, 1);
    assert.equal(view.pairs[0].lastSeen, later.toISOString());
});

test('重连抖动：RadioName 回落成 Manual 不再开出第二个席位', () => {
    const ctx = new Context();
    const source = {ip: '10.0.0.90', port: '50001'};
    feed(ctx, 'BG7TVF-2', 'FT-817', '1', source, '{1}');
    assert.deepEqual(seats(ctx), ['BG7TVF-2:1']);
    // N1MM 重新连上服务器，但电台还没绑回 FT-817，RadioInfo 暂时报 Manual。
    const blip = ingestApi.ingest(ctx, radio('Manual', '1'), NOW, source);
    assert.equal(blip.event.seat, 'BG7TVF-2:1');
    assert.equal(blip.event.radioName, 'FT-817');
    assert.deepEqual(seats(ctx), ['BG7TVF-2:1']);
    assert.equal(ctx.get('radioStates')['BG7TVF-2:1'].radioName, 'FT-817');
    assert.equal(seatIdentity.summary(ctx).seats.length, 1);
    const back = ingestApi.ingest(ctx, radio('FT-817', '1'), NOW, source);
    assert.equal(back.event.seat, 'BG7TVF-2:1');
    assert.deepEqual(seats(ctx), ['BG7TVF-2:1']);
});

test('先报 Manual 再报真实型号，同样收敛到一个席位并升级型号', () => {
    const ctx = new Context();
    const source = {ip: '10.0.0.91', port: '50001'};
    feed(ctx, 'BG7TVF-THINKPAD', 'Manual', '1', source, '{1}');
    assert.equal(ctx.get('radioStates')['BG7TVF-THINKPAD:1'].radioName, 'Manual');
    const later = ingestApi.ingest(ctx, radio('IC-7300', '1'), NOW, source);
    assert.equal(later.event.seat, 'BG7TVF-THINKPAD:1');
    assert.deepEqual(seats(ctx), ['BG7TVF-THINKPAD:1']);
    assert.equal(ctx.get('radioStates')['BG7TVF-THINKPAD:1'].radioName, 'IC-7300');
});

test('陈旧席位在读取站点状态前被剔除，活席位与无时间戳的席位保留', () => {
    const ctx = new Context();
    ctx.set('radioStates', {
        'BG7TVF-2:1': {freqKhz: 21021, ts: NOW.toISOString()},
        'BG7TVF-2~MANUAL:1': {freqKhz: 14002.5, ts: new Date(NOW.getTime() - 6 * 60 * 1000).toISOString()},
        'BG7TVF-EDGE:1': {freqKhz: 7000, ts: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString()},
        'BG7TVF-NOTS:1': {freqKhz: 3600}
    });
    ctx.set('operatorSessions', {'BG7TVF-2~MANUAL:1': {seat: 'BG7TVF-2~MANUAL:1', operator: 'BG7TVF'}});
    assert.deepEqual(service.pruneStaleSeats(ctx, NOW).removed, ['BG7TVF-2~MANUAL:1']);
    assert.deepEqual(seats(ctx).sort(), ['BG7TVF-2:1', 'BG7TVF-EDGE:1', 'BG7TVF-NOTS:1']);
    assert.equal(ctx.get('operatorSessions')['BG7TVF-2~MANUAL:1'], undefined);
    assert.deepEqual(service.pruneStaleSeats(ctx, NOW).removed, []);
});

