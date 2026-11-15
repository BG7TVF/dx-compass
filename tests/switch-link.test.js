'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const switchLink = require('../lib/devices/switch-link.js');
const switchModels = require('../lib/devices/switch-models.js');
const model = require('../lib/devices/model.js');
const rf = require('../lib/devices/rf.js');
const runtime = require('../lib/devices/runtime.js');
const commands = require('../lib/devices/commands.js');
const service = require('../lib/devices/service.js');
const storage = require('../lib/storage');

function makeContext(initial) {
    const store = Object.assign({}, initial || {});
    return {
        store,
        get(key) { return store[key]; },
        set(key, value) { store[key] = value; }
    };
}

function deviceRow(overrides) {
    return Object.assign({
        kind: 'device',
        id: 'dev-1',
        name: 'Device 1',
        type: 'switch',
        parent_id: null,
        bands: '',
        install_offset_deg: 0,
        enabled: 1,
        travel_timeout_sec: 120,
        notes: '',
        created_ts: '2026-01-01T00:00:00.000Z',
        updated_ts: '2026-01-01T00:00:00.000Z'
    }, overrides || {});
}

// ---- Antenna Genius：旧二进制帧 ----

test('AG legacy frame encodes length, header and payload', () => {
    assert.equal(switchLink.agFrame(0x415, '1;3'), '!0003!020A80!1;3');
    assert.equal(switchLink.agFrame(0x401, ''), '!0000!020080!');
    assert.equal(switchLink.agFrame(0x082, ''), '!0000!004100!');
    assert.equal(switchLink.agHeader(0x401, {method: 1}).toString(16).toUpperCase(), 'A0080');
});

test('AG legacy stream parser keeps incomplete tails', () => {
    const buffer = '!0003!020A80!1;3!0000!0A0080!' + '!0000!0200';
    const parsed = switchLink.parseAgFrames(buffer);
    assert.equal(parsed.frames.length, 2);
    assert.equal(parsed.frames[0].command, 0x415);
    assert.equal(parsed.frames[0].payload, '1;3');
    assert.equal(parsed.frames[1].method, 1);
    assert.equal(parsed.frames[1].command, 0x401);
    assert.equal(parsed.rest, '!0000!0200');
});

test('AG 0x401 ports tolerate one or two seven-field blocks', () => {
    assert.deepEqual(switchLink.parseAgPortStatus('1;0;3;0;5;0;0;2;0;7;0;8;0;0'),
        {in1: 'out5', in2: 'out8'});
    assert.deepEqual(switchLink.parseAgPortStatus('2;0;7;0;3;0;0'), {in2: 'out3'});
    assert.deepEqual(switchLink.parseAgPortStatus(''), {});
});

test('AG 0x412 and 0x082 payloads become antenna and band rows', () => {
    const antennas = switchLink.parseAgAntennaPayload('3;EFHW;3;0007|4;Dipole;1;0100');
    assert.equal(antennas.length, 2);
    assert.equal(antennas[0].index, 3);
    assert.equal(antennas[0].name, 'EFHW');
    assert.equal(antennas[0].mask, '0007');
    const bands = switchLink.parseAgBandPayload('2;80m;3300000;4000000\n3;40m;6800000;7400000');
    assert.equal(bands.length, 2);
    assert.equal(bands[1].name, '40m');
    assert.equal(bands[1].lowerHz, 6800000);
});

test('AG band masks expand to band names', () => {
    const bands = [
        {index: 0, name: '160m'},
        {index: 1, name: '80m'},
        {index: 2, name: '40m'}
    ];
    assert.deepEqual(switchLink.maskBands('0007', bands), ['160m', '80m', '40m']);
    assert.deepEqual(switchLink.maskBands('0004', bands), ['40m']);
});

// ---- Antenna Genius：v4 ASCII ----

test('AG v4 list and port lines parse into the same shape', () => {
    const band = switchLink.parseAgV4Band('band 2 name=80m freq_start=3.300000 freq_stop=4.000000');
    assert.deepEqual(band, {index: 2, name: '80m', lowerHz: 3300000, upperHz: 4000000});
    const antenna = switchLink.parseAgV4Antenna('antenna 3 name=EFHW tx=0007 rx=0007 inband=0000');
    assert.equal(antenna.index, 3);
    assert.equal(antenna.name, 'EFHW');
    assert.equal(antenna.tx, '0007');
    assert.deepEqual(switchLink.parseAgV4Port('port 1 auto=1 source=AUTO band=3 rxant=3 txant=3 tx=0 inhibit=0'),
        {port: 1, antenna: 3});
    assert.equal(switchLink.agV4Command(7, 'port get 1'), 'C7|port get 1\r');
});

test('AG v4 response envelope is decoded', () => {
    const parsed = switchLink.parseAgV4Line('R22|0|port 1 auto=0 source=MANUAL band=3 rxant=3 txant=3');
    assert.equal(parsed.kind, 'response');
    assert.equal(parsed.error, 0);
    assert.match(parsed.message, /^port 1/);
    const status = switchLink.parseAgV4Line('S0|band 3 name=40m freq_start=6.8 freq_stop=7.4');
    assert.equal(status.kind, 'status');
});

// ---- ZSERVER ----

test('ZSERVER command is JSON and status is matched by id/host', () => {
    const payload = JSON.parse(switchLink.zserverCommand('sw1', 2, 5));
    assert.deepEqual(payload, {name: 'zserver', command: 'set_antenna', id: 'sw1', radio: 2, antenna: 5});
    assert.deepEqual(switchLink.parseZserverStatus('{"id":"sw1","HOST":"10.0.0.5","radio":2,"antenna":5}'),
        {id: 'sw1', host: '10.0.0.5', radio: 2, antenna: 5});
    assert.deepEqual(switchLink.parseZserverStatus('{"id":"sw1","antennas":{"1":3,"2":4}}').entries,
        [{radio: 1, antenna: 3}, {radio: 2, antenna: 4}]);
    assert.equal(switchLink.parseZserverStatus('not-json'), null);
});

// ---- Green Heron ----

test('Green Heron frame carries radio and antenna after US separator', () => {
    const frame = switchLink.greenHeronFrame('SW1', 1, 3);
    assert.ok(frame.includes(Buffer.from('SET_SWITCH')));
    assert.ok(frame.includes(Buffer.from('Radio-1')));
    assert.ok(frame.includes(Buffer.from([0x1F])));
    assert.ok(frame.includes(Buffer.from('3')));
    assert.deepEqual(switchLink.parseGreenHeronStatus('SWITCHUPDATE Radio-1 antenna=3'),
        {radio: 1, antenna: 3});
});

// ---- wa4mcm ----

test('wa4mcm ASCII select/query and replies', () => {
    assert.equal(switchLink.wa4mcmFrame('select', 3), 'A3\r\n');
    assert.equal(switchLink.wa4mcmFrame('query'), 'A?\r\n');
    assert.deepEqual(switchLink.parseWa4mcmLine('A3'), {antenna: 3});
    assert.deepEqual(switchLink.parseWa4mcmLine('MM'), {mode: 'manual'});
    assert.equal(switchLink.parseWa4mcmLine('A9'), null);
});

// ---- Amplitec ----

test('Amplitec status frame exposes remote/manual and position', () => {
    assert.deepEqual(switchLink.parseAmplitecStatus(Buffer.from([0x01, 0x01, 0x52, 0x0D, 0x00, 0x03, 0x0D])),
        {mode: 'remote', position: 3});
    assert.deepEqual(switchLink.parseAmplitecStatus(Buffer.from([0x01, 0x01, 0x52, 0x0D, 0x01, 0x06, 0x0D])),
        {mode: 'manual', position: 6});
    assert.equal(switchLink.parseAmplitecStatus(Buffer.from([0x01, 0x01, 0x44, 0x0D])), null);
});

// ---- 只写型号的帧 ----

test('RCS-4 frame checksums the four bytes', () => {
    assert.deepEqual([...switchLink.rcs4Frame(2, true)], [0xA0, 2, 1, 0xA3]);
    assert.deepEqual([...switchLink.rcs4Frame(4, false)], [0xA0, 4, 0, 0xA4]);
});

test('Station Genius frames are fixed 64 bytes with key codes', () => {
    const frame = switchLink.stationGeniusFrame('7');
    assert.equal(frame.length, 64);
    assert.equal(frame[0], 0x80);
    assert.equal(frame[1], 0x37);
    assert.equal(switchLink.stationGeniusConnectFrame()[0], 0x89);
    assert.equal(switchLink.stationGeniusKeepaliveFrame()[0], 0x84);
});

test('Six2Two topics address one relay per input/output pair', () => {
    assert.equal(switchLink.six2twoTopic('remoteqth', 2, 6), 'remoteqth/2_6');
    assert.equal(switchLink.six2twoTopic('', 1, 1), 'remoteqth/1_1');
});

// ---- 型号表与配置 ----

test('switch model catalog resolves by type and marks Stack Match unsupported', () => {
    const ag = switchModels.resolve('matrix', '4o3a', 'antenna-genius');
    assert.equal(ag.protocol, 'ag-tcp');
    assert.equal(ag.readback, true);
    assert.deepEqual(ag.defaults, {in_count: 2, out_count: 8});
    assert.equal(switchModels.resolve('switch', '4o3a', 'antenna-genius'), null);
    assert.equal(switchModels.supported(switchModels.resolve('switch', 'arraysolutions', 'stack-match')), false);
    assert.equal(switchModels.transportOf({brand: 'amplitec', model: 'sw3000-6'}, 'switch'), 'amplitec-serial');
    assert.equal(switchModels.transportOf({}, 'switch'), 'relay');
});

test('switch config normalizes protocol, counts and rejects unsupported models', () => {
    const ag = model.normalizeConfig({
        brand: '4o3a', model: 'antenna-genius', host: '10.0.0.9', port: '9007'
    }, {}, 'matrix');
    assert.equal(ag.ok, true);
    assert.equal(ag.config.protocol, 'ag-tcp');
    assert.equal(ag.config.in_count, 2);
    assert.equal(ag.config.out_count, 8);

    const stack = model.normalizeConfig({brand: 'arraysolutions', model: 'stack-match'}, {}, 'switch');
    assert.deepEqual(stack, {ok: false, error: 'unsupported-switch-model'});

    const relay = model.normalizeConfig({
        relay_url: 'http://relay.local/out', channels: {'ant2': 3}
    }, {}, 'switch');
    assert.equal(relay.ok, true);
    assert.equal(relay.config.protocol, 'relay');

    const badBands = model.normalizeConfig({
        brand: '4o3a', model: 'antenna-genius', antenna_bands: {'1': ['bogus']}
    }, {}, 'matrix');
    assert.deepEqual(badBands, {ok: false, error: 'invalid-config-antenna-bands'});
});

test('mapping prefers device readback and never merges with local config', () => {
    const device = deviceRow({
        type: 'matrix',
        config_json: JSON.stringify({antenna_bands: {'1': ['20m'], '2': ['40m']}})
    });
    const fromDevice = switchModels.mappingFor(storage.devices.toDevice(device), {
        switch: {
            antennas: [{index: 1, name: 'EFHW', bands: ['15m']}],
            bands: [{index: 1, name: '15m'}]
        }
    });
    assert.equal(fromDevice.source, 'device');
    assert.deepEqual(fromDevice.antennas, [{index: 1, name: 'EFHW', bands: ['15m']}]);

    const fromLocal = switchModels.mappingFor(storage.devices.toDevice(device), {switch: {}});
    assert.equal(fromLocal.source, 'local');
    assert.deepEqual(fromLocal.antennas.map(item => item.index), [1, 2]);

    const none = switchModels.mappingFor(storage.devices.toDevice(deviceRow({type: 'switch'})), {});
    assert.equal(none.source, 'none');
});

// ---- 状态语义 ----

test('AG select is pending until readback and never writes ports early', async () => {
    commands.resetForTests();
    commands.setTransports({switchSelect: async () => ({ok: true, dispatched: true, readback: true})});
    const globalCtx = makeContext();
    const rows = [deviceRow({
        id: 'ag-1',
        type: 'matrix',
        config_json: JSON.stringify({
            brand: '4o3a', model: 'antenna-genius', protocol: 'ag-tcp',
            host: '10.0.0.9', port: 9007, in_count: 2, out_count: 8
        })
    })];
    const at = new Date('2026-03-01T12:00:00.000Z');
    const result = await service.handleCommand(globalCtx, rows, 'ag-1',
        {command: 'select', port: 'in1', outlet: 'out3'}, {'X-DX-Seat': 'OP-A'}, at);
    assert.equal(result.status, 202);
    assert.equal(result.payload.state, 'pending');
    assert.equal(result.payload.verified, false);
    const entry = runtime.stateOf(globalCtx, 'ag-1');
    assert.equal(entry.ports, undefined);
    assert.equal(entry.switch.state, 'pending');
    assert.equal(entry.switch.commanded.in1, 'out3');
    assert.equal(entry.switch.readback, true);
});

test('switches keep independent namespaces and verified/unverified state', () => {
    const globalCtx = makeContext();
    const rows = [
        deviceRow({
            id: 'sw-a', type: 'switch',
            config_json: JSON.stringify({brand: 'wa4mcm', model: '1x4', out_count: 4, channels: {}})
        }),
        deviceRow({
            id: 'sw-b', type: 'switch',
            config_json: JSON.stringify({relay_url: 'http://relay.local/out', channels: {}})
        })
    ];
    runtime.updateEntry(globalCtx, 'sw-a', {
        switch: {state: 'verified', ports: {in: 'ant2'}, commanded: {in: 'ant2'}, online: true,
            last_readback_ms: Date.now()}
    }, new Date());
    runtime.updateEntry(globalCtx, 'sw-b', {
        switch: {state: 'unverified', commanded: {in: 'ant3'}, ports: null, online: true}
    }, new Date());

    const snapshot = service.snapshot(globalCtx, rows, new Date());
    assert.equal(snapshot.switches['sw-a'].verified, true);
    assert.deepEqual(snapshot.switches['sw-a'].ports, {in: 'ant2'});
    assert.equal(snapshot.switches['sw-b'].state, 'unverified');
    assert.equal(snapshot.switches['sw-b'].ports, null);
    assert.deepEqual(snapshot.switches['sw-b'].commanded, {in: 'ant3'});
    assert.deepEqual(snapshot.controls['sw-a'].ports, {in: 'ant2'});
    assert.equal(snapshot.controls['sw-b'].ports, null);
    assert.deepEqual(snapshot.controls['sw-b'].commanded_ports, {in: 'ant3'});
});

test('unsupported model and read-only model are rejected before any transport', async () => {
    commands.resetForTests();
    let called = 0;
    commands.setTransports({switchSelect: async () => { called += 1; return {ok: true}; }});
    const globalCtx = makeContext();
    const rows = [
        deviceRow({
            id: 'stack-1', type: 'switch',
            config_json: JSON.stringify({brand: 'arraysolutions', model: 'stack-match', out_count: 3})
        }),
        deviceRow({
            id: 'amp-1', type: 'switch',
            config_json: JSON.stringify({brand: 'amplitec', model: 'sw3000-6', host: '10.0.0.7', out_count: 6})
        })
    ];
    const at = new Date('2026-03-01T12:00:00.000Z');
    const stack = await service.handleCommand(globalCtx, rows, 'stack-1',
        {command: 'select', port: 'in', outlet: 'ant2'}, {'X-DX-Seat': 'OP-A'}, at);
    assert.equal(stack.status, 501);
    assert.equal(stack.payload.error, 'unsupported-switch-model');
    const amplitec = await service.handleCommand(globalCtx, rows, 'amp-1',
        {command: 'select', port: 'in', outlet: 'ant2'}, {'X-DX-Seat': 'OP-A'}, at);
    assert.equal(amplitec.status, 501);
    assert.equal(amplitec.payload.error, 'unsupported-control');
    assert.equal(called, 0);
});

test('rf.findPort keeps switch in/ant and matrix in/out directions', () => {
    const sw = storage.devices.toDevice(deviceRow({
        type: 'switch', config_json: JSON.stringify({out_count: 4})
    }));
    assert.equal(rf.findPort(sw, 'in').role, 'in');
    assert.equal(rf.findPort(sw, 'ant3').role, 'out');
    assert.equal(rf.findPort(sw, 'out3'), null);
    const mx = storage.devices.toDevice(deviceRow({
        type: 'matrix', config_json: JSON.stringify({in_count: 2, out_count: 8})
    }));
    assert.equal(rf.findPort(mx, 'in2').role, 'in');
    assert.equal(rf.findPort(mx, 'out8').role, 'out');
});
