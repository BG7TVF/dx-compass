'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');

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
    assert.equal(switchModels.transportOf({brand: 'amplitec', model: 'sw3000-6'}, 'switch'), 'amplitec-tcp');
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

    // 已保存的路数不能被型号默认值静默覆盖。
    const custom = model.normalizeConfig({
        brand: '4o3a', model: 'antenna-genius', in_count: '1', out_count: '4'
    }, {}, 'matrix');
    assert.equal(custom.ok, true);
    assert.equal(custom.config.in_count, 1);
    assert.equal(custom.config.out_count, 4);
});

test('mapping derives port bands from the RF topology and follows changes immediately', () => {
    const sw = storage.devices.toDevice(deviceRow({
        id: 'sw-1', type: 'switch', config_json: JSON.stringify({out_count: 4})
    }));
    const a1 = storage.devices.toDevice(deviceRow({
        id: 'ant-1', name: 'EFHW', type: 'antenna', bands: '20m,15m'
    }));
    const links = [{link_id: 'rf:1', a_device: 'sw-1', a_port: 'ant1', b_device: 'ant-1', b_port: 'in'}];

    const first = switchModels.mappingFor(sw, {}, {devices: [sw, a1], links});
    assert.equal(first.ports.ant1.source, 'topology');
    assert.deepEqual(first.ports.ant1.bands, ['20m', '15m']);
    assert.deepEqual(first.ports.ant1.antennas.map(item => item.name), ['EFHW']);
    assert.deepEqual(first.conflicts, []);

    // 改天线波段：下一次计算立即跟随，不需要重新配置。
    const a1b = Object.assign({}, a1, {bands: ['40m']});
    const changed = switchModels.mappingFor(sw, {}, {devices: [sw, a1b], links});
    assert.deepEqual(changed.ports.ant1.bands, ['40m']);

    // 换端口：映射跟着连线走，旧端口回到无映射。
    const moved = [{link_id: 'rf:2', a_device: 'sw-1', a_port: 'ant3', b_device: 'ant-1', b_port: 'in'}];
    const movedView = switchModels.mappingFor(sw, {}, {devices: [sw, a1b], links: moved});
    assert.equal(movedView.ports.ant1.source, 'none');
    assert.equal(movedView.ports.ant3.source, 'topology');
    assert.deepEqual(movedView.ports.ant3.bands, ['40m']);

    // 删连线：端口回到无映射。
    const removed = switchModels.mappingFor(sw, {}, {devices: [sw, a1b], links: []});
    assert.equal(removed.ports.ant3.source, 'none');
    assert.deepEqual(removed.ports.ant3.bands, []);
    assert.equal(removed.source, 'none');
});

test('parallel antennas behind one port are unioned, not first-link-wins', () => {
    const sw = storage.devices.toDevice(deviceRow({
        id: 'sw-1', type: 'switch', config_json: JSON.stringify({out_count: 4})
    }));
    const div = storage.devices.toDevice(deviceRow({
        id: 'div-1', type: 'divider', config_json: JSON.stringify({out_count: 2})
    }));
    const a1 = storage.devices.toDevice(deviceRow({
        id: 'ant-1', name: 'Vertical', type: 'antenna', bands: '20m'
    }));
    const a2 = storage.devices.toDevice(deviceRow({
        id: 'ant-2', name: 'Dipole', type: 'antenna', bands: '40m,20m'
    }));
    const links = [
        {link_id: 'rf:1', a_device: 'sw-1', a_port: 'ant1', b_device: 'div-1', b_port: 'in'},
        {link_id: 'rf:2', a_device: 'div-1', a_port: 'out1', b_device: 'ant-1', b_port: 'in'},
        {link_id: 'rf:3', a_device: 'div-1', a_port: 'out2', b_device: 'ant-2', b_port: 'in'}
    ];
    const mapping = switchModels.mappingFor(sw, {}, {devices: [sw, div, a1, a2], links});
    assert.deepEqual(mapping.ports.ant1.bands, ['20m', '40m']);
    assert.deepEqual(mapping.ports.ant1.antennas.map(item => item.name), ['Vertical', 'Dipole']);
});

test('manual fallback is silent when it agrees and explicit when it conflicts', () => {
    const sw = storage.devices.toDevice(deviceRow({
        id: 'sw-1', type: 'switch',
        config_json: JSON.stringify({out_count: 4, antenna_bands: {'1': ['20m']}})
    }));
    const a1 = storage.devices.toDevice(deviceRow({
        id: 'ant-1', name: 'EFHW', type: 'antenna', bands: '20m'
    }));
    const links = [{link_id: 'rf:1', a_device: 'sw-1', a_port: 'ant1', b_device: 'ant-1', b_port: 'in'}];

    const agrees = switchModels.mappingFor(sw, {}, {devices: [sw, a1], links});
    assert.equal(agrees.ports.ant1.source, 'topology');
    assert.equal(agrees.ports.ant1.manual_agrees, true);
    assert.deepEqual(agrees.conflicts, []);

    const a1b = Object.assign({}, a1, {bands: ['40m']});
    const conflict = switchModels.mappingFor(sw, {}, {devices: [sw, a1b], links});
    assert.equal(conflict.ports.ant1.source, 'topology');
    assert.deepEqual(conflict.ports.ant1.bands, ['40m']);
    assert.deepEqual(conflict.ports.ant1.manual_bands, ['20m']);
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.conflicts[0].port, 'ant1');
    assert.deepEqual(conflict.conflicts[0].topology_bands, ['40m']);
    assert.deepEqual(conflict.conflicts[0].manual_bands, ['20m']);
    assert.equal(conflict.conflicts[0].antennas[0].name, 'EFHW');

    // 没有拓扑时手工兜底才是来源。
    const onlyManual = switchModels.mappingFor(sw, {}, {devices: [sw, a1], links: []});
    assert.equal(onlyManual.ports.ant1.source, 'manual');
    assert.deepEqual(onlyManual.ports.ant1.bands, ['20m']);

    // 天线接了但波段为空：拓扑没有结论，手工兜底且不算冲突。
    const blank = Object.assign({}, a1, {bands: []});
    const blankTopology = switchModels.mappingFor(sw, {}, {devices: [sw, blank], links});
    assert.equal(blankTopology.ports.ant1.source, 'manual');
    assert.deepEqual(blankTopology.ports.ant1.bands, ['20m']);
    assert.deepEqual(blankTopology.conflicts, []);
});

test('device readback still wins over topology and manual', () => {
    const sw = storage.devices.toDevice(deviceRow({
        id: 'sw-1', type: 'switch',
        config_json: JSON.stringify({out_count: 4, antenna_bands: {'1': ['20m']}})
    }));
    const a1 = storage.devices.toDevice(deviceRow({
        id: 'ant-1', name: 'EFHW', type: 'antenna', bands: '20m'
    }));
    const links = [{link_id: 'rf:1', a_device: 'sw-1', a_port: 'ant1', b_device: 'ant-1', b_port: 'in'}];
    const mapping = switchModels.mappingFor(sw, {
        switch: {antennas: [{index: 1, name: 'AG port 1', bands: ['40m']}]}
    }, {devices: [sw, a1], links});
    assert.equal(mapping.ports.ant1.source, 'device');
    assert.deepEqual(mapping.ports.ant1.bands, ['40m']);
    assert.deepEqual(mapping.conflicts, []);
});

test('snapshot exposes topology mapping per port without manual configuration', () => {
    const rows = [
        deviceRow({
            id: 'sw-1', name: 'Switch', type: 'switch', bands: '',
            config_json: JSON.stringify({out_count: 4})
        }),
        deviceRow({
            id: 'ant-1', name: 'EFHW', type: 'antenna', bands: '20m,15m'
        }),
        {
            kind: 'rf', id: 'rf:1', link_id: 'rf:1',
            a_device: 'sw-1', a_port: 'ant1', b_device: 'ant-1', b_port: 'in'
        }
    ];
    const snapshot = service.snapshot(makeContext(), rows, new Date());
    const view = snapshot.switches['sw-1'];
    assert.equal(view.port_mapping.ant1.source, 'topology');
    assert.deepEqual(view.port_mapping.ant1.bands, ['20m', '15m']);
    assert.deepEqual(view.port_mapping.ant1.antennas.map(item => item.name), ['EFHW']);
    assert.deepEqual(view.conflicts, []);
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

// ---- 下发链路：RCS-4 先全断、Six2Two 按输入分键、AG 主动判定协议 ----

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
        this.destroyed = false;
    }
    write(chunk, callback) {
        this.writes.push(Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk));
        if (typeof callback === 'function') callback();
        return true;
    }
    connect() { return this; }
    destroy() {
        this.destroyed = true;
        return this;
    }
    removeAllListeners(event) {
        super.removeAllListeners(event);
        return this;
    }
}

class FakeMqtt extends EventEmitter {
    constructor() {
        super();
        this.published = [];
    }
    on(event, handler) {
        super.on(event, handler);
        if (event === 'connect') handler();
        return this;
    }
    publish(topic, payload, options, callback) {
        this.published.push({topic, payload});
        if (typeof callback === 'function') callback(null);
        return true;
    }
    end() { return this; }
}

class FakeUdp extends EventEmitter {
    constructor() {
        super();
        this.sent = [];
        this.bound = null;
    }
    bind(port) { this.bound = port; }
    send(buffer, port, host, callback) {
        this.sent.push({buffer: Buffer.from(buffer), port, host});
        if (typeof callback === 'function') callback(null);
    }
    close() {}
}

test('RCS-4 select opens every port before setting the target', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = storage.devices.toDevice(deviceRow({
        id: 'rcs-1', type: 'switch',
        config_json: JSON.stringify({
            brand: 'arraysolutions', model: 'rcs-4',
            host: '127.0.0.1', port: 8080, out_count: 4
        })
    }));
    const at = new Date('2026-03-01T12:00:00.000Z');
    switchLink.poll(makeContext(), [device], at, {devices: [device], links: []});
    socket.emit('connect');
    const result = await switchLink.select(makeContext(), device, 'in', 'ant2', at,
        {devices: [device], links: []});
    assert.equal(result.ok, true);
    assert.equal(result.protocol_verified, false);
    assert.equal(socket.writes.length, 5);
    assert.deepEqual([...switchLink.rcs4Frame(1, false)], [...Buffer.from(socket.writes[0], 'latin1')]);
    assert.deepEqual([...switchLink.rcs4Frame(4, false)], [...Buffer.from(socket.writes[3], 'latin1')]);
    assert.deepEqual([...switchLink.rcs4Frame(2, true)], [...Buffer.from(socket.writes[4], 'latin1')]);
    switchLink.resetForTests();
});

test('Six2Two remembers the previous topic per input, not per device', async () => {
    switchLink.resetForTests();
    const client = new FakeMqtt();
    switchLink.setMqttFactory(() => client);
    const device = storage.devices.toDevice(deviceRow({
        id: 'six-1', type: 'matrix',
        config_json: JSON.stringify({
            brand: 'remoteqth', model: 'six2two',
            host: '127.0.0.1', port: 1883, topic_prefix: 'remoteqth'
        })
    }));
    const at = new Date('2026-03-01T12:00:00.000Z');
    const options = {devices: [device], links: []};
    await switchLink.select(makeContext(), device, 'in1', 'out2', at, options);
    await switchLink.select(makeContext(), device, 'in1', 'out5', at, options);
    assert.deepEqual(client.published.slice(-2), [
        {topic: 'remoteqth/1_2', payload: '0'},
        {topic: 'remoteqth/1_5', payload: '1'}
    ]);
    const before = client.published.length;
    await switchLink.select(makeContext(), device, 'in2', 'out3', at, options);
    const after = client.published.slice(before);
    // 切 in2 只能清 in2 自己的旧 topic，不能把 in1 的 1_5 关掉。
    assert.deepEqual(after, [{topic: 'remoteqth/2_3', payload: '1'}]);
    switchLink.resetForTests();
});

test('AG uses an active probe and refuses to guess while mode is unknown', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = storage.devices.toDevice(deviceRow({
        id: 'ag-2', type: 'matrix',
        config_json: JSON.stringify({
            brand: '4o3a', model: 'antenna-genius',
            host: '127.0.0.1', port: 9007, in_count: 2, out_count: 8
        })
    }));
    const globalCtx = makeContext();
    const at = new Date('2026-03-01T12:00:00.000Z');
    const options = {devices: [device], links: []};
    switchLink.poll(globalCtx, [device], at, options);
    socket.emit('connect');
    // 连上主动发 v4 探测，而不是干等 banner。
    assert.ok(socket.writes.some(line => /^C\d+\|band list\r$/.test(line)));
    const undetermined = await switchLink.select(globalCtx, device, 'in1', 'out3', at, options);
    assert.equal(undetermined.status, 409);
    assert.equal(undetermined.error, 'protocol-undetermined');

    socket.emit('data', Buffer.from('R2|0|band 3 name=40m freq_start=6.8 freq_stop=7.4\r'));
    assert.equal(runtime.stateOf(globalCtx, 'ag-2').switch.bands[0].name, '40m');
    const v4 = await switchLink.select(globalCtx, device, 'in1', 'out3', at, options);
    assert.equal(v4.ok, true);
    assert.ok(socket.writes.some(line => /^C\d+\|port set 1 rxant=3 txant=3\r$/.test(line)));
    switchLink.resetForTests();
});

test('AG recognises legacy frames and keeps a re-probe path', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = storage.devices.toDevice(deviceRow({
        id: 'ag-3', type: 'matrix',
        config_json: JSON.stringify({
            brand: '4o3a', model: 'antenna-genius',
            host: '127.0.0.1', port: 9007, in_count: 2, out_count: 8
        })
    }));
    const globalCtx = makeContext();
    const at = new Date('2026-03-01T12:00:00.000Z');
    const options = {devices: [device], links: []};
    switchLink.poll(globalCtx, [device], at, options);
    socket.emit('connect');
    socket.emit('data', Buffer.from('!0000!0A0080!'));
    const legacy = await switchLink.select(globalCtx, device, 'in1', 'out3', at, options);
    assert.equal(legacy.ok, true);
    assert.ok(socket.writes.includes('!0003!020A80!1;3'));

    // 迟到的 v4 回包应把模式重判为 v4。
    socket.emit('data', Buffer.from('R1|0|band 1 name=20m freq_start=3.5 freq_stop=4.0\r'));
    const v4 = await switchLink.select(globalCtx, device, 'in1', 'out5', at, options);
    assert.equal(v4.ok, true);
    assert.ok(socket.writes.some(line => /^C\d+\|port set 1 rxant=5 txant=5\r$/.test(line)));
    switchLink.resetForTests();
});

// ---- 真实下发路径：UDP / TCP / MQTT 与回读转 verified ----

function switchDevice(id, type, brand, model, config) {
    return storage.devices.toDevice(deviceRow({
        id, type,
        config_json: JSON.stringify(Object.assign({brand, model, host: '127.0.0.1'}, config || {}))
    }));
}

test('ZSERVER select leaves over UDP and a status broadcast flips the port to verified', async () => {
    switchLink.resetForTests();
    let udp = null;
    switchLink.setUdpFactory(() => { udp = new FakeUdp(); return udp; });
    const device = switchDevice('zs-1', 'matrix', 'hamation', 'zserver', {
        port: 50333, status_port: 50334, switch_id: 'SW1', in_count: 4, out_count: 8
    });
    const globalCtx = makeContext();
    const options = {devices: [device], links: []};
    const at = new Date('2026-03-01T12:00:00.000Z');

    const result = await switchLink.select(globalCtx, device, 'in1', 'out3', at, options);
    assert.equal(result.ok, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.status_error, null);
    assert.equal(udp.bound, 50334);
    assert.equal(udp.sent.length, 1);
    assert.equal(udp.sent[0].port, 50333);
    assert.equal(udp.sent[0].host, '127.0.0.1');
    assert.deepEqual(JSON.parse(udp.sent[0].buffer.toString()), {
        name: 'zserver', command: 'set_antenna', id: 'SW1', radio: 1, antenna: 3
    });

    udp.emit('message', Buffer.from(JSON.stringify({id: 'SW1', radio: 1, antenna: 3})));
    const state = runtime.stateOf(globalCtx, device.id).switch;
    assert.equal(state.state, 'verified');
    assert.equal(state.ports.in1, 'out3');
    switchLink.resetForTests();
});

test('ZSERVER status port binding failure is reported instead of silently losing readback', async () => {
    switchLink.resetForTests();
    const udp = new FakeUdp();
    udp.bind = () => { throw Object.assign(new Error('address in use'), {code: 'EADDRINUSE'}); };
    switchLink.setUdpFactory(() => udp);
    const device = switchDevice('zs-2', 'matrix', 'hamation', 'zserver', {
        port: 50333, status_port: 50335, in_count: 4, out_count: 8
    });
    const result = await switchLink.select(makeContext(), device, 'in1', 'out2',
        new Date('2026-03-01T12:00:00.000Z'), {devices: [device], links: []});
    assert.equal(result.ok, true);
    assert.equal(result.status_error, 'EADDRINUSE');
    switchLink.resetForTests();
});

test('Green Heron select writes the SET_SWITCH frame and SWITCHUPDATE verifies the port', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = switchDevice('gh-1', 'matrix', 'greenheron', 'everyware', {
        port: 10000, switch_id: 'SW1', in_count: 4, out_count: 8
    });
    const globalCtx = makeContext();
    const options = {devices: [device], links: []};
    const at = new Date('2026-03-01T12:00:00.000Z');
    switchLink.poll(globalCtx, [device], at, options);
    socket.emit('connect');

    const result = await switchLink.select(globalCtx, device, 'in2', 'out5', at, options);
    assert.equal(result.ok, true);
    assert.equal(socket.writes.at(-1), 'SET_SWITCHSW1Radio-2\u001F5\r\n');

    socket.emit('data', Buffer.from('SWITCHUPDATE Radio-2 Antenna 5\r\n'));
    const state = runtime.stateOf(globalCtx, device.id).switch;
    assert.equal(state.state, 'verified');
    assert.equal(state.ports.in2, 'out5');
    switchLink.resetForTests();
});

test('wa4mcm select writes A<n> and an A<n> reply verifies the port', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = switchDevice('wa-1', 'switch', 'wa4mcm', '1x4', {port: 8008, out_count: 4});
    const globalCtx = makeContext();
    const options = {devices: [device], links: []};
    const at = new Date('2026-03-01T12:00:00.000Z');
    switchLink.poll(globalCtx, [device], at, options);
    socket.emit('connect');
    // 连上先查询一次，选型后按天线号下发。
    assert.equal(socket.writes[0], 'A?\r\n');

    const result = await switchLink.select(globalCtx, device, 'in', 'ant3', at, options);
    assert.equal(result.ok, true);
    assert.equal(socket.writes.at(-1), 'A3\r\n');

    socket.emit('data', Buffer.from('A3\r\n'));
    const state = runtime.stateOf(globalCtx, device.id).switch;
    assert.equal(state.state, 'verified');
    assert.equal(state.ports.in, 'ant3');
    switchLink.resetForTests();
});

test('Amplitec status frame verifies readback without ever sending a select', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = switchDevice('amp-1', 'switch', 'amplitec', 'sw3000-6', {port: 5000, out_count: 6});
    const globalCtx = makeContext();
    const options = {devices: [device], links: []};
    const at = new Date('2026-03-01T12:00:00.000Z');
    const polled = switchLink.poll(globalCtx, [device], at, options);
    assert.equal(polled.polled, 1);
    socket.emit('connect');
    assert.deepEqual([...socket.writes[0]].map(byte => byte.charCodeAt(0)), [0x01, 0x01, 0x44, 0x0D]);

    // 状态帧：0x52 0x0D 之后是 mode=0（remote）、position=3。
    socket.emit('data', Buffer.from([0x01, 0x01, 0x52, 0x0D, 0x00, 0x03]));
    const state = runtime.stateOf(globalCtx, device.id).switch;
    assert.equal(state.state, 'verified');
    assert.equal(state.ports.in, 'ant3');
    assert.deepEqual(state.amplitec, {mode: 'remote', position: 3});

    const denied = await switchLink.select(globalCtx, device, 'in', 'ant2', at, options);
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'unsupported-control');
    switchLink.resetForTests();
});

test('Station Genius connects with 0x89, keeps alive with 0x84 and selects a key frame', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = switchDevice('sg-1', 'switch', '4o3a', 'station-genius', {port: 8001, out_count: 7});
    const globalCtx = makeContext();
    const options = {devices: [device], links: []};
    const at = new Date('2026-03-01T12:00:00.000Z');
    switchLink.poll(globalCtx, [device], at, options);
    socket.emit('connect');
    assert.equal(Buffer.from(socket.writes[0], 'latin1')[0], 0x89);

    switchLink.poll(globalCtx, [device], new Date(at.getTime() + 1000), options);
    assert.equal(Buffer.from(socket.writes.at(-1), 'latin1')[0], 0x84);

    const result = await switchLink.select(globalCtx, device, 'in', 'ant3', at, options);
    assert.equal(result.ok, true);
    const frame = Buffer.from(socket.writes.at(-1), 'latin1');
    assert.equal(frame.length, 64);
    assert.equal(frame[0], 0x80);
    assert.equal(frame[1], '9'.charCodeAt(0));
    switchLink.resetForTests();
});

test('AG without any reply falls back to legacy and keeps polling', async () => {
    switchLink.resetForTests();
    let socket = null;
    switchLink.setSocketFactory(() => { socket = new FakeSocket(); return socket; });
    const device = switchDevice('ag-4', 'matrix', '4o3a', 'antenna-genius', {
        port: 9007, in_count: 2, out_count: 8
    });
    const globalCtx = makeContext();
    const at = new Date('2026-03-01T12:00:00.000Z');
    switchLink.poll(globalCtx, [device], at, {devices: [device], links: []});
    socket.emit('connect');
    assert.equal(runtime.stateOf(globalCtx, device.id).switch.ag_mode, undefined);
    await new Promise(resolve => setTimeout(resolve, 650));
    const state = runtime.stateOf(globalCtx, device.id).switch;
    assert.equal(state.ag_mode, 'legacy');
    assert.ok(socket.writes.some(line => /^![0-9A-F]{4}![0-9A-F]{6}!$/.test(line)));
    switchLink.resetForTests();
});
