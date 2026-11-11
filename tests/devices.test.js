'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../lib/devices/model.js');
const ownership = require('../lib/devices/ownership.js');
const runtime = require('../lib/devices/runtime.js');
const tower = require('../lib/devices/tower.js');
const tx = require('../lib/devices/tx.js');
const commands = require('../lib/devices/commands.js');
const rotatorLink = require('../lib/devices/rotator-link.js');
const service = require('../lib/devices/service.js');

function fakeTransports() {
    commands.resetForTests();
    commands.setTransports({
        rotate: async () => ({ok: true}),
        stop: async () => ({ok: true}),
        select: async () => ({ok: true}),
        towerHold: async () => ({ok: true}),
        towerRelease: async () => ({ok: true})
    });
}
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
    const base = {
        kind: 'device',
        id: 'dev-1',
        name: 'Device 1',
        type: 'antenna',
        parent_id: null,
        bands: '20m',
        install_offset_deg: 0,
        exclusive: 0,
        port_label: '',
        password: '',
        enabled: 1,
        travel_timeout_sec: 120,
        notes: '',
        created_ts: '2026-01-01T00:00:00.000Z',
        updated_ts: '2026-01-01T00:00:00.000Z'
    };
    return Object.assign(base, overrides || {});
}

function device(overrides) {
    return storage.devices.toDevice(deviceRow(overrides));
}

function sourceRow(overrides) {
    const base = {
        kind: 'tx',
        id: 'src-a',
        name: 'Source A',
        priority: 10,
        timeout_ms: 2000,
        password: '',
        enabled: 1,
        created_ts: '2026-01-01T00:00:00.000Z',
        updated_ts: '2026-01-01T00:00:00.000Z'
    };
    return Object.assign(base, overrides || {});
}

test('unified node model keeps one parent and rejects cycles', () => {
    const devices = [
        device({id: 'tower-1', name: 'Tower', type: 'tower', bands: '', parent_id: null}),
        device({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: '', parent_id: 'tower-1'}),
        device({id: 'ant-1', name: '20m Yagi', type: 'antenna', bands: '20m', parent_id: 'rotator-1'}),
        device({id: 'ant-2', name: '15m Yagi', type: 'antenna', bands: '15m', parent_id: 'tower-1'})
    ];

    // 单父：一个 parent_id 字段，保存时覆盖而不是追加。
    const moved = model.normalizeDevice({id: 'ant-2', parent_id: 'rotator-1'}, {devices});
    assert.equal(moved.ok, true);
    assert.equal(moved.device.parent_id, 'rotator-1');

    // 无环：把塔挂到自己孙子下面必须拒绝。
    const cycle = model.normalizeDevice({id: 'tower-1', parent_id: 'ant-1'}, {devices});
    assert.equal(cycle.ok, false);
    assert.equal(cycle.status, 409);
    assert.equal(cycle.error, 'cycle');

    const self = model.normalizeDevice({id: 'tower-1', parent_id: 'tower-1'}, {devices});
    assert.equal(self.error, 'cycle');

    // 父节点必须存在，且不做类型白名单：塔可以挂到“切换器”下面。
    const missing = model.normalizeDevice(
        {id: 'ant-3', name: 'Ant 3', type: 'antenna', bands: '20m', parent_id: 'nope'},
        {devices}
    );
    assert.equal(missing.status, 404);
    const anyParent = model.normalizeDevice(
        {id: 'tower-1', parent_id: 'ant-2'},
        {devices: devices.concat([device({id: 'ant-2', name: '15m', type: 'antenna', bands: '15m'})])}
    );
    assert.equal(anyParent.ok, true);

    // 有子节点时禁止删除。
    const blocked = model.deleteBlockReason(devices, 'tower-1');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.error, 'has-children');
    assert.equal(model.deleteBlockReason(devices, 'ant-1').ok, true);

    // 树形输出保留父子层级。
    const tree = model.buildTree(devices);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, 'tower-1');
    assert.equal(tree[0].children.length, 2);
    assert.equal(tree[0].children.find(node => node.id === 'rotator-1').children[0].id, 'ant-1');
});

test('antenna bands are required and install offset maps physical to actual azimuth', () => {
    const missingBand = model.normalizeDevice({type: 'antenna', name: 'No band'}, {devices: []});
    assert.equal(missingBand.status, 400);
    assert.equal(missingBand.error, 'antenna-band-required');

    const badBand = model.normalizeDevice(
        {type: 'antenna', name: 'Bad', bands: '20 meters'},
        {devices: []}
    );
    assert.equal(badBand.error, 'invalid-band');

    const parsed = model.parseBands('20m, 15m;20M');
    assert.deepEqual(parsed.bands, ['20m', '15m']);
    assert.deepEqual(parsed.invalid, []);

    assert.equal(model.actualAzimuth(45, 180), 225);
    assert.equal(model.actualAzimuth(350, 20), 10);
    assert.equal(model.actualAzimuth(0, 0), 0);
    assert.equal(model.actualAzimuth(-10, 20), 10);
    assert.equal(model.actualAzimuth(359, 1), 0);
    assert.equal(model.actualAzimuth(null, 0), null);

    assert.equal(model.parseOffset(0).value, 0);
    assert.equal(model.parseOffset('359').value, 359);
    assert.equal(model.parseOffset(360).ok, false);
    assert.equal(model.parseOffset(-1).ok, false);
    assert.equal(model.parseOffset(1.5).ok, false);

    const saved = model.normalizeDevice(
        {type: 'antenna', name: 'Offset antenna', bands: '20m', install_offset_deg: 30},
        {devices: []}
    );
    assert.equal(saved.ok, true);
    assert.equal(saved.device.install_offset_deg, 30);
});

test('seat lease releases immediately on band change and after 60s without heartbeat', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const devices = [
        device({id: 'ant-20', name: '20m', type: 'antenna', bands: '20m'}),
        device({id: 'ant-15', name: '15m', type: 'antenna', bands: '15m'}),
        device({id: 'ant-20b', name: '20m backup', type: 'antenna', bands: '20m'})
    ];
    const radioStates = {
        'OP-A': {ts: now.toISOString(), freqKhz: 14020},
        'OP-B': {ts: now.toISOString(), freqKhz: 21020}
    };

    const view = ownership.project({devices, radioStates, now, heartbeatTimeoutMs: 60000});
    assert.equal(view.by_seat['OP-A'].band, '20m');
    assert.equal(view.by_seat['OP-A'].colors['ant-20'], 'red');
    assert.equal(view.by_seat['OP-B'].colors['ant-20'], 'yellow');
    assert.equal(view.by_seat['OP-B'].colors['ant-15'], 'red');
    assert.equal(view.by_seat['OP-A'].ambiguous, true);

    // 席位切走波段：立刻释放旧天线，不需要等租约到期。
    radioStates['OP-A'] = {ts: now.toISOString(), freqKhz: 21025};
    const switched = ownership.project({devices, radioStates, now, heartbeatTimeoutMs: 60000});
    assert.equal(switched.by_seat['OP-A'].colors['ant-20'], 'green');
    assert.equal(switched.by_seat['OP-A'].colors['ant-15'], 'red');
    assert.equal(switched.by_seat['OP-A'].ambiguous, false);

    // 60 秒无心跳 → 席位离线，占用全部释放，天线回到空闲。
    const stale = new Date(now.getTime() + 60001);
    const offline = ownership.project({devices, radioStates, now: stale, heartbeatTimeoutMs: 60000});
    assert.equal(offline.seats.find(seat => seat.seat === 'OP-A').online, false);
    assert.equal(offline.by_seat['OP-A'].colors['ant-15'], 'green');
    assert.deepEqual(offline.antennas.find(item => item.id === 'ant-15').owners, []);

    // 恰好 60 秒仍算在线。
    const edge = new Date(now.getTime() + 60000);
    const online = ownership.project({devices, radioStates, now: edge, heartbeatTimeoutMs: 60000});
    assert.equal(online.seats.find(seat => seat.seat === 'OP-A').online, true);

    // 其他席位倒下后，本席的黄色回到绿色。
    const onlyA = ownership.project({
        devices,
        radioStates: {'OP-A': {ts: edge.toISOString(), freqKhz: 14020}},
        now: edge
    });
    assert.equal(onlyA.by_seat['OP-A'].colors['ant-20'], 'red');
});

test('1xN exclusive antennas never produce a yellow state', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const devices = [
        device({id: 'ant-20', name: '20m', type: 'antenna', bands: '20m', exclusive: 1})
    ];
    const radioStates = {
        'OP-A': {ts: now.toISOString(), freqKhz: 14020},
        'OP-B': {ts: now.toISOString(), freqKhz: 14020}
    };
    const view = ownership.project({devices, radioStates, now});
    assert.equal(view.by_seat['OP-A'].colors['ant-20'], 'red');
    assert.equal(view.by_seat['OP-B'].colors['ant-20'], 'red');
    assert.equal(view.by_seat['OP-B'].colors['ant-20'] === 'yellow', false);
});

test('rotator target dedup compares against the current target, 360 equals 0', () => {
    assert.equal(model.normalizeAngle(360), 0);
    assert.equal(model.normalizeAngle(0), 0);
    assert.equal(model.normalizeAngle(-1), 359);
    assert.equal(model.normalizeAngle(45.6), 46);

    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: ''})];

    assert.equal(service.duplicateTarget(globalCtx, 'rotator-1', 45), false);

    service.handle(globalCtx, rows, {
        action: 'report', device_id: 'rotator-1', target_azimuth: 45, azimuth: 45
    }, now);

    assert.equal(service.duplicateTarget(globalCtx, 'rotator-1', 45), true);
    assert.equal(service.duplicateTarget(globalCtx, 'rotator-1', 405), true);
    assert.equal(service.duplicateTarget(globalCtx, 'rotator-1', 360 + 45), true);
    assert.equal(service.duplicateTarget(globalCtx, 'rotator-1', 90), false);
});

test('unknown is the default device state and is never back-filled from old values', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [
        deviceRow({id: 'tower-1', name: 'Tower', type: 'tower', bands: ''}),
        deviceRow({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: ''})
    ];

    const empty = service.snapshot(globalCtx, rows, now);
    assert.equal(empty.status['tower-1'].state, 'unknown');
    assert.equal(empty.towers['tower-1'].state, 'unknown');
    assert.equal(empty.rotators['rotator-1'].state, 'unknown');
    assert.equal(empty.rotators['rotator-1'].physical_azimuth, null);

    service.handle(globalCtx, rows, {
        action: 'report', device_id: 'tower-1', tower: {limit_top: true, limit_bottom: false}
    }, now);
    const erected = service.snapshot(globalCtx, rows, now);
    assert.equal(erected.towers['tower-1'].state, 'erected');
    assert.equal(erected.status['tower-1'].state, 'online');

    // 10 秒无上报 → 通信中断；保留最后状态与时间，但不当作当前位置。
    const later = new Date(now.getTime() + 10001);
    const offline = service.snapshot(globalCtx, rows, later);
    assert.equal(offline.status['tower-1'].state, 'offline');
    assert.equal(offline.towers['tower-1'].state, 'offline');
    assert.equal(offline.towers['tower-1'].last_state, 'erected');

    // 新一帧不带限位反馈 → 回到 unknown，不沿用 erected。
    service.handle(globalCtx, rows, {action: 'report', device_id: 'tower-1'}, later);
    const reset = service.snapshot(globalCtx, rows, later);
    assert.equal(reset.towers['tower-1'].state, 'unknown');
});

test('offline rotator never leaks a stale azimuth into antenna ownership', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [
        deviceRow({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: ''}),
        deviceRow({id: 'ant-1', name: '20m', type: 'antenna', bands: '20m',
            parent_id: 'rotator-1', install_offset_deg: 180})
    ];

    service.handle(globalCtx, rows, {
        action: 'report', device_id: 'rotator-1', azimuth: 45, target_azimuth: 45
    }, now);
    const fresh = service.snapshot(globalCtx, rows, now);
    assert.equal(fresh.ownership.antennas[0].actual_azimuth, 225);

    // 10 秒无上报 → 旋转器离线，天线不再显示旧角度。
    const stale = service.snapshot(globalCtx, rows, new Date(now.getTime() + 10001));
    assert.equal(stale.rotators['rotator-1'].state, 'offline');
    assert.equal(stale.ownership.antennas[0].actual_azimuth, null);
});

test('tower resolves NO/NC wiring, faults and travel timeouts', () => {    const now = new Date('2026-03-01T12:00:00.000Z');
    const deviceCfg = device({id: 'tower-1', type: 'tower', travel_timeout_sec: 10});

    const normalOpen = tower.resolve({
        device: deviceCfg,
        entry: {last_report_ms: now.getTime(), last_report: now.toISOString(), tower: {limit_top: true, limit_bottom: false}},
        now,
        limitSwitchType: 'NO'
    });
    assert.equal(normalOpen.state, 'erected');

    // NC 接法：电平为 false 才代表到位。
    const normallyClosed = tower.resolve({
        device: deviceCfg,
        entry: {last_report_ms: now.getTime(), tower: {limit_top: false, limit_bottom: true}},
        now,
        limitSwitchType: 'NC'
    });
    assert.equal(normallyClosed.state, 'erected');

    const fault = tower.resolve({
        device: deviceCfg,
        entry: {last_report_ms: now.getTime(), tower: {limit_top: true, limit_bottom: true}},
        now,
        limitSwitchType: 'NO'
    });
    assert.equal(fault.state, 'fault');
    assert.equal(fault.alert, 'limit-conflict');

    const travel = tower.resolve({
        device: deviceCfg,
        entry: {
            last_report_ms: now.getTime(),
            moving: true,
            motion_started_ms: now.getTime() - 11000,
            tower: {limit_top: false, limit_bottom: false, moving: true}
        },
        now,
        limitSwitchType: 'NO'
    });
    assert.equal(travel.state, 'unknown');
    assert.equal(travel.alert, 'travel-timeout');

    const retracted = tower.resolve({
        device: deviceCfg,
        entry: {last_report_ms: now.getTime(), tower: {limit_top: false, limit_bottom: true}},
        now
    });
    assert.equal(retracted.state, 'retracted');

    const noFeedback = tower.resolve({
        device: deviceCfg,
        entry: {last_report_ms: now.getTime()},
        now
    });
    assert.equal(noFeedback.state, 'unknown');
    assert.equal(noFeedback.reason, 'no-limit-feedback');
});

test('TX sources pick by priority, degrade on timeout and ignore duplicate seq', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const sourceRows = [
        sourceRow({id: 'src-a', name: 'A', priority: 10, timeout_ms: 1000}),
        sourceRow({id: 'src-b', name: 'B', priority: 20, timeout_ms: 5000})
    ];
    const sources = sourceRows.map(storage.devices.toTxSource);

    const empty = service.snapshot(globalCtx, [], now);
    assert.equal(empty.tx.state, 'none');
    assert.equal(empty.tx.current, null);

    let result = service.ingestTx(globalCtx, sources, {source_id: 'src-a', tx_active: true, seq: 10}, {}, now);
    assert.equal(result.status, 200);
    result = service.ingestTx(globalCtx, sources, {source_id: 'src-b', tx_active: false, seq: 1}, {}, now);
    assert.equal(result.status, 200);

    let view = service.snapshot(globalCtx, sourceRows, now).tx;
    assert.equal(view.state, 'ok');
    assert.equal(view.current.source_id, 'src-a');
    assert.equal(view.tx_active, true);

    // A 超时 → stale，自动降级到下一个可用源。
    const stale = new Date(now.getTime() + 1500);
    view = service.snapshot(globalCtx, sourceRows, stale).tx;
    assert.equal(view.sources.find(item => item.source_id === 'src-a').health, 'stale');
    assert.equal(view.current.source_id, 'src-b');
    assert.equal(view.tx_active, false);

    // 全部超时 → interrupted，界面显示通信中断，不沿用发射中。
    const down = new Date(now.getTime() + 6000);
    view = service.snapshot(globalCtx, sourceRows, down).tx;
    assert.equal(view.state, 'interrupted');
    assert.equal(view.current, null);
    assert.equal(view.tx_active, null);

    // 同一 seq / 更旧 seq 直接丢弃，不刷新 last_seen。
    const t1 = new Date(now.getTime() + 7000);
    service.ingestTx(globalCtx, sources, {source_id: 'src-a', tx_active: true, seq: 11}, {}, t1);
    const t2 = new Date(t1.getTime() + 500);
    const duplicate = service.ingestTx(globalCtx, sources, {source_id: 'src-a', tx_active: false, seq: 11}, {}, t2);
    assert.equal(duplicate.payload.ignored, 'stale-seq');
    assert.equal(globalCtx.get('txRuntime')['src-a'].tx_active, true);

    // 未配置的源自动登记为最低优先级，后续可人工调整。
    const registered = service.ingestTx(globalCtx, sources, {source_id: 'src-new', tx_active: true}, {}, t1);
    assert.equal(registered.payload.registered, true);
    assert.match(registered.sql[0], /INSERT OR IGNORE INTO tx_sources/);
    assert.match(registered.sql[0], /src-new/);
});

test('TX ingest validates payload, token and source id', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const sources = [storage.devices.toTxSource(sourceRow({id: 'src-a', timeout_ms: 2000}))];

    assert.equal(tx.ingest(globalCtx, sources, {tx_active: true}, {}, now).status, 400);
    assert.equal(tx.ingest(globalCtx, sources, {source_id: 'src-a'}, {}, now).status, 400);
    assert.equal(tx.ingest(globalCtx, sources, {source_id: 'src-a', tx_active: 'yes'}, {}, now).status, 400);
    assert.equal(tx.ingest(globalCtx, sources, {source_id: 'src-a', tx_active: true, seq: 'x'}, {}, now).status, 400);

    const secured = [storage.devices.toTxSource(sourceRow({id: 'src-s', timeout_ms: 2000, password: 's3cret'}))];
    assert.equal(tx.ingest(globalCtx, secured, {source_id: 'src-s', tx_active: true}, {}, now).status, 403);
    assert.equal(tx.ingest(globalCtx, secured, {source_id: 'src-s', tx_active: true}, {'X-DX-TX-Token': 's3cret'}, now).status, 200);

    const created = tx.ingest(globalCtx, [], {source_id: 'auto', tx_active: false}, {}, now);
    assert.equal(created.newSource.priority, tx.DEFAULT_PRIORITY);
    assert.equal(created.newSource.timeout_ms, tx.DEFAULT_TIMEOUT_MS);
});

test('device reports validate type-specific fields and are stored server-side only', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [
        deviceRow({id: 'ant-20', name: '20m', type: 'antenna', bands: '20m'}),
        deviceRow({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: ''}),
        deviceRow({id: 'tower-1', name: 'Tower', type: 'tower', bands: ''})
    ];

    assert.equal(service.handle(globalCtx, rows, {action: 'report', device_id: 'nope'}, now).status, 404);
    assert.equal(service.handle(globalCtx, rows, {
        action: 'report', device_id: 'tower-1', tower: {limit_top: 'yes'}
    }, now).status, 400);
    assert.equal(service.handle(globalCtx, rows, {
        action: 'report', device_id: 'rotator-1', azimuth: 400
    }, now).status, 400);
    assert.equal(service.handle(globalCtx, rows, {
        action: 'report', device_id: 'ant-20', port: 2
    }, now).status, 400);

    const ok = service.handle(globalCtx, rows, {
        action: 'report', device_id: 'ant-20', port: '3', online: true
    }, now);
    assert.equal(ok.status, 200);
    assert.equal(globalCtx.get('deviceRuntime')['ant-20'].port, '3');

    // 运行态只在服务端内存里；重启后为空 → unknown。
    runtime.reset(globalCtx);
    assert.equal(service.snapshot(globalCtx, rows, now).status['ant-20'].state, 'unknown');
});

test('device config writes never expose passwords in the public DTO', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [];

    const created = service.handle(globalCtx, rows, {
        action: 'save',
        device: {name: 'Antenna', type: 'antenna', bands: '20m', password: 'plain-secret'}
    }, now);
    assert.equal(created.status, 201);
    assert.equal(created.payload.device.has_password, true);
    assert.equal(Object.prototype.hasOwnProperty.call(created.payload.device, 'password'), false);
    assert.match(created.sql[0], /plain-secret/);
    assert.doesNotMatch(created.sql[0], /log/i);

    const deviceId = created.payload.device.id;
    const updated = service.handle(globalCtx, [device({id: deviceId, type: 'antenna', bands: '20m', password: 'plain-secret'})], {
        action: 'save', device: {id: deviceId, name: 'Renamed'}
    }, now);
    assert.equal(updated.status, 200);
    assert.equal(updated.payload.device.name, 'Renamed');

    // 有子节点删除 → 409；叶子删除 → 成功。
    const parentRows = [
        device({id: 'tower-1', type: 'tower', bands: ''}),
        device({id: 'ant-1', type: 'antenna', bands: '20m', parent_id: 'tower-1'})
    ];
    assert.equal(service.handle(globalCtx, parentRows, {action: 'delete', id: 'tower-1'}, now).status, 409);
    assert.equal(service.handle(globalCtx, parentRows, {action: 'delete', id: 'ant-1'}, now).status, 200);
});

test('TX source configuration keeps the token private and validates ranges', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [];

    const created = service.handle(globalCtx, rows, {
        action: 'tx-source',
        source: {source_id: 'radio-a', name: 'Radio A', priority: 5, token: 'abc'}
    }, now);
    assert.equal(created.status, 201);
    assert.equal(created.payload.source.has_token, true);
    assert.equal(Object.prototype.hasOwnProperty.call(created.payload.source, 'token'), false);
    assert.match(created.sql[0], /INSERT INTO tx_sources/);

    assert.equal(service.handle(globalCtx, rows, {
        action: 'tx-source', source: {source_id: 'bad id'}
    }, now).status, 400);
    assert.equal(service.handle(globalCtx, rows, {
        action: 'tx-source', source: {source_id: 'radio-b', priority: 99999}
    }, now).status, 400);

    const updated = service.handle(globalCtx, [sourceRow({
        id: 'radio-a', name: 'Radio A', priority: 5, timeout_ms: 2000, password: 'abc', enabled: 1
    })], {action: 'tx-source', source: {source_id: 'radio-a', priority: 7}}, now);
    assert.equal(updated.status, 200);
    assert.equal(updated.payload.source.priority, 7);
});

test('storage creates both tables and migrates missing columns idempotently', () => {
    const schema = storage.devices.createSchema();
    assert.equal(schema.length, 3);
    assert.match(schema[0], /CREATE TABLE IF NOT EXISTS devices/);
    assert.match(schema[1], /CREATE TABLE IF NOT EXISTS tx_sources/);
    assert.match(schema[2], /CREATE TABLE IF NOT EXISTS device_commands/);
    assert.match(storage.devices.snapshotQuery(), /UNION ALL/);
    assert.match(storage.devices.columnsQuery(), /pragma_table_info\('devices'\)/);

    assert.deepEqual(storage.devices.addMissingColumns([]), []);
    assert.deepEqual(storage.devices.addMissingColumns([{tbl: 'unknown', col: 'x'}]), []);

    const partial = [];
    for (const name of ['id', 'name', 'type', 'parent_id', 'bands']) {
        partial.push({tbl: 'devices', col: name});
    }
    for (const name of ['source_id', 'name', 'priority']) {
        partial.push({tbl: 'tx_sources', col: name});
    }
    const statements = storage.devices.addMissingColumns(partial);
    assert.ok(statements.some(sql => /ALTER TABLE devices ADD COLUMN install_offset_deg/.test(sql)));
    assert.ok(statements.some(sql => /ALTER TABLE tx_sources ADD COLUMN timeout_ms/.test(sql)));
    assert.equal(statements.some(sql => /ADD COLUMN id /.test(sql)), false);
});

test('device SQL escapes text values and keeps created_ts on update', () => {
    const dev = device({id: 'ant-1', name: "O'Hare antenna", type: 'antenna', bands: '20m'});
    assert.match(storage.devices.insertDevice(dev), /O''Hare antenna/);
    assert.match(storage.devices.updateDevice(dev), /WHERE id = 'ant-1'/);
    assert.match(storage.devices.deleteDevice("a'1"), /'a''1'/);
    assert.match(storage.devices.insertTxSource({source_id: 's1', name: "it's", timeout_ms: 2000, priority: 1}),
        /it''s/);
});

test('flow registers device routes and startup schema migration', () => {
    const flow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flow.json'), 'utf8'));
    const routes = flow
        .filter(node => node.type === 'http in' && node.url && node.url.startsWith('/api/devices'))
        .map(node => `${node.method.toUpperCase()} ${node.url}`);
    assert.deepEqual(routes.sort(), [
        'GET /api/devices',
        'POST /api/devices',
        'POST /api/devices/:id/command',
        'POST /api/devices/report',
        'POST /api/devices/tx'
    ]);

    const byName = name => flow.find(node => node.name === name);
    assert.match(byName('Build devices schema').func, /dx\.storage\.devices\.createSchema/);
    assert.match(byName('Build device migrations').func, /addMissingColumns/);
    assert.match(byName('Handle devices write').func, /dx\.devices\.handle/);
    assert.match(byName('Ingest TX report').func, /dx\.devices\.ingestTx/);
    assert.match(byName('Format devices snapshot').func, /dx\.devices\.snapshot/);

    const settings = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
    assert.match(settings, /httpAdminRoot:\s*false/);

    const poll = byName('Run rotator poll');
    assert.ok(poll, 'rotator poll node exists');
    assert.match(poll.func, /dx\.devices\.pollRotators/);
});

test('two new settings ship with the agreed defaults and no gating', () => {
    const schema = require('../public/shared/settings/schema.js');
    const defaults = schema.defaultSettings();
    assert.equal(defaults.towerLimitType, 'NO');
    assert.equal(defaults.towerPulseWidthMs, 400);
    assert.equal(defaults.towerLimitType, 'NO', 'limit switch defaults to normally open');

    const nc = schema.sanitize({towerLimitType: 'NC', towerPulseWidthMs: 600}).settings;
    assert.equal(nc.towerLimitType, 'NC');
    assert.equal(nc.towerPulseWidthMs, 600);

    const bounds = schema.sanitize({towerPulseWidthMs: 10}).settings;
    assert.equal(bounds.towerPulseWidthMs, 400);

    const limitField = schema.FIELDS.find(field => field.key === 'towerLimitType');
    assert.deepEqual(limitField.values, ['NO', 'NC']);
    assert.equal(limitField.wired, true);
    const pulseField = schema.FIELDS.find(field => field.key === 'towerPulseWidthMs');
    assert.equal(pulseField.wired, true);
    assert.equal(pulseField.default, 400);
});

test('command channel requires seat identity and the device password', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: '', password: 'pw'})];

    let result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 45}, {}, now);
    assert.equal(result.status, 401);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, 'seat-required');
    assert.match(result.sql[0], /INSERT INTO device_commands/);

    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 45}, {'X-DX-Seat': 'OP-A', 'X-DX-Device-Token': 'bad'}, now);
    assert.equal(result.status, 403);
    assert.equal(result.payload.error, 'invalid-device-token');

    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 45},
        {'X-DX-Seat': 'OP-A', 'X-DX-Device-Token': 'pw', 'X-DX-Operator': 'Alice'}, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.ok, true);
    assert.match(result.sql[0], /OP-A/);
    assert.match(result.sql[0], /Alice/);
    assert.match(result.sql[0], /accepted/);
});

test('device lease allows one seat, renews and expires after 30s', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({id: 'rotator-1', type: 'rotator', bands: ''})];

    let result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 45}, {'X-DX-Seat': 'OP-A'}, now);
    assert.equal(result.status, 202);

    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 90}, {'X-DX-Seat': 'OP-B'}, now);
    assert.equal(result.status, 409);
    assert.equal(result.payload.error, 'device-locked');
    assert.equal(result.payload.owner, 'OP-A');

    // 同席位继续操作会续租。
    const later = new Date(now.getTime() + 20000);
    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 90}, {'X-DX-Seat': 'OP-A'}, later);
    assert.equal(result.status, 202);

    // 续租后 30 秒内仍归 OP-A，超过 30 秒自动释放。
    const stillHeld = new Date(later.getTime() + 29000);
    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 120}, {'X-DX-Seat': 'OP-B'}, stillHeld);
    assert.equal(result.status, 409);

    const expired = new Date(later.getTime() + 30001);
    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 120}, {'X-DX-Seat': 'OP-B'}, expired);
    assert.equal(result.status, 202);
});

test('angle idempotency returns the first result and treats 360 as 0', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({id: 'rotator-1', type: 'rotator', bands: ''})];
    const headers = {'X-DX-Seat': 'OP-A'};

    let first = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 360}, headers, now);
    assert.equal(first.status, 202);
    assert.equal(first.payload.target_azimuth, 0);

    const duplicate = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 0}, headers, now);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.payload.duplicate, true);
    assert.equal(duplicate.payload.command_id, first.payload.command_id);

    const different = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 90}, headers, now);
    assert.equal(different.status, 202);
    assert.notEqual(different.payload.command_id, first.payload.command_id);

    // stop 清空目标，之后同角度会重新下发。
    const stopped = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'stop'}, {'X-DX-Seat': 'OP-B'}, now);
    assert.equal(stopped.status, 202);
    const again = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 90}, headers, now);
    assert.equal(again.status, 202);
});

test('select is blocked with 423 when a TX source reports active', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const matrix = deviceRow({
        id: 'matrix-1', name: 'Matrix', type: 'matrix', bands: '',
        config_json: JSON.stringify({relay_url: 'http://relay.local/out', channels: {'IN1:1': 3}})
    });
    const source = sourceRow({id: 'src-a', name: 'A', priority: 10, timeout_ms: 2000});
    const rows = [matrix, source];
    const headers = {'X-DX-Seat': 'OP-A'};

    // 未接入任何源：互锁不启用，正常放行。
    let result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'IN1', outlet: '1'}, headers, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.interlock, 'not-enabled');

    // 源上报发射中 → 423 TX_ACTIVE，且不产生下发。
    service.ingestTx(globalCtx, [storage.devices.toTxSource(source)],
        {source_id: 'src-a', tx_active: true}, {}, now);
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'IN1', outlet: '1'}, headers, now);
    assert.equal(result.status, 423);
    assert.equal(result.payload.error, 'tx-active');
    assert.equal(result.payload.interlock, 'tx-active');

    // 源上报未发射 → 放行，互锁启用。
    service.ingestTx(globalCtx, [storage.devices.toTxSource(source)],
        {source_id: 'src-a', tx_active: false, seq: 2}, {}, now);
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'IN1', outlet: '1'}, headers, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.interlock, 'enabled');

    // 源超时 → 互锁不启用，正常放行。
    const stale = new Date(now.getTime() + 7000);
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'IN1', outlet: '1'}, headers, stale);
    assert.equal(result.status, 202);
    assert.equal(result.payload.interlock, 'not-enabled');

    // 未知通道 / 缺参数。
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'IN1', outlet: '9'}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'unknown-channel');
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select'}, headers, now);
    assert.equal(result.payload.error, 'invalid-port');
});

test('tower hold skeleton validates direction and channels', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const towerRow = deviceRow({
        id: 'tower-1', name: 'Tower', type: 'tower', bands: '',
        config_json: JSON.stringify({relay_url: 'http://relay.local/out', up_channel: 1, down_channel: 2})
    });
    const headers = {'X-DX-Seat': 'OP-A'};

    let result = await service.handleCommand(globalCtx, [towerRow], 'tower-1',
        {command: 'tower_hold', direction: 'left'}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'invalid-direction');

    result = await service.handleCommand(globalCtx, [towerRow], 'tower-1',
        {command: 'tower_hold', direction: 'up'}, headers, now);
    assert.equal(result.status, 202);

    result = await service.handleCommand(globalCtx, [towerRow], 'tower-1',
        {command: 'tower_release'}, headers, now);
    assert.equal(result.status, 202);

    const bare = deviceRow({id: 'tower-2', type: 'tower', bands: ''});
    result = await service.handleCommand(globalCtx, [bare], 'tower-2',
        {command: 'tower_hold', direction: 'up'}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'unknown-channel');
});

test('device protocol config is validated and secrets stay out of the DTO', () => {
    const ok = model.normalizeDevice({
        name: 'Matrix', type: 'matrix',
        config: {
            relay_url: 'http://relay.local/out',
            relay_token: 'relay-secret',
            channels: {'IN1:1': 2, 'IN1:2': 3},
            pulse_ms: 250
        }
    }, {devices: []});
    assert.equal(ok.ok, true);
    assert.equal(ok.device.config.relay_token, 'relay-secret');
    const pub = model.publicDevice(ok.device);
    assert.equal(pub.has_relay_token, true);
    assert.equal(pub.config.relay_token, undefined);
    assert.equal(pub.config.channels['IN1:1'], 2);

    const sql = storage.devices.insertDevice(ok.device);
    assert.match(sql, /config_json/);
    assert.match(sql, /relay-secret/);

    assert.equal(model.normalizeDevice({
        name: 'R', type: 'rotator', config: {protocol: 'modbus'}
    }, {devices: []}).status, 400);
    assert.equal(model.normalizeDevice({
        name: 'R', type: 'rotator', config: {relay_url: 'ftp://x'}
    }, {devices: []}).error, 'invalid-config-relay-url');
    assert.equal(model.normalizeDevice({
        name: 'R', type: 'rotator', config: {port: 70000}
    }, {devices: []}).error, 'invalid-config-port');
    assert.equal(model.normalizeDevice({
        name: 'R', type: 'matrix', config: {channels: {'IN1:1': 300}}
    }, {devices: []}).error, 'invalid-config-channel');
});

function fakeSocket(handler) {
    const {EventEmitter} = require('node:events');
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.setEncoding = () => {};
    socket.write = line => {
        const reply = handler(String(line));
        if (reply !== null && reply !== undefined) setImmediate(() => socket.emit('data', reply));
    };
    socket.destroy = () => {
        socket.destroyed = true;
    };
    setImmediate(() => socket.emit('connect'));
    return socket;
}

test('rotctld link formats GS-232 commands and parses the position reply', async () => {
    const writes = [];
    rotatorLink.setSocketFactory(() => fakeSocket(line => {
        writes.push(line);
        if (line.startsWith('P ')) return 'RPRT 0\n';
        if (line.trim() === 'p') return '45.0 0.0\n';
        if (line.trim() === 'S') return 'RPRT 0\n';
        return null;
    }));

    const link = new rotatorLink.RotctldLink({host: '127.0.0.1', port: 4533, timeoutMs: 200});
    await link.setPosition(45, 0);
    const position = await link.getPosition();
    await link.stop();

    assert.equal(writes[0], 'P 45.0 0.0\n');
    assert.equal(writes[1], 'p\n');
    assert.equal(writes[2], 'S\n');
    assert.equal(position.azimuth, 45);
    assert.ok(Math.abs(rotatorLink.parsePosition('359.8 12').azimuth - 359.8) < 1e-9);
    assert.equal(rotatorLink.parsePosition('nonsense'), null);
    assert.equal(rotatorLink.formatSet(0), 'P 0.0 0.0\n');

    link.close();
    rotatorLink.resetLinks();
    rotatorLink.setSocketFactory(null);
});

test('rotctld link reports timeouts and connection failures without faking success', async () => {
    rotatorLink.setSocketFactory(() => fakeSocket(() => null));
    const timeoutLink = new rotatorLink.RotctldLink({host: '127.0.0.1', port: 4533, timeoutMs: 20});
    await assert.rejects(() => timeoutLink.getPosition(), /transport-timeout/);
    timeoutLink.close();

    rotatorLink.setSocketFactory(() => {
        throw new Error('ECONNREFUSED');
    });
    const refused = new rotatorLink.RotctldLink({host: '127.0.0.1', port: 4533, timeoutMs: 50});
    await assert.rejects(() => refused.setPosition(10), /transport-connect/);

    rotatorLink.resetLinks();
    rotatorLink.setSocketFactory(null);
});

test('rotator polling turns a successful read into a real state report', async () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({
        id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: '',
        config_json: JSON.stringify({host: '10.0.0.9', port: 4533})
    })];

    rotatorLink.resetLinks();
    rotatorLink.setSocketFactory(() => fakeSocket(line => line.trim() === 'p' ? '45.0 0.0\n' : 'RPRT 0\n'));

    const result = await service.pollRotators(globalCtx, rows, now);
    assert.equal(result.polled, 1);
    assert.deepEqual(result.errors, []);

    const view = service.snapshot(globalCtx, rows, now);
    assert.equal(view.rotators['rotator-1'].physical_azimuth, 45);
    assert.equal(view.status['rotator-1'].state, 'online');

    // 读取失败不覆盖已有角度，也不假装在线；超过 10 秒自然转为通信中断。
    rotatorLink.resetLinks();
    rotatorLink.setSocketFactory(() => fakeSocket(() => null));
    const failed = await service.pollRotators(globalCtx, rows, new Date(now.getTime() + 1000));
    assert.equal(failed.polled, 0);
    assert.equal(failed.errors[0].error, 'transport-timeout');
    const offline = service.snapshot(globalCtx, rows, new Date(now.getTime() + 11000));
    assert.equal(offline.status['rotator-1'].state, 'offline');

    rotatorLink.resetLinks();
    rotatorLink.setSocketFactory(null);
});

test('rotator motion state follows the target and the travel window', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({id: 'rotator-1', type: 'rotator', bands: '', travel_timeout_sec: 60})];
    const headers = {'X-DX-Seat': 'OP-A'};

    await service.handleCommand(globalCtx, rows, 'rotator-1', {command: 'rotate', azimuth: 90}, headers, now);
    service.handle(globalCtx, rows, {action: 'report', device_id: 'rotator-1', azimuth: 10}, now);

    let view = service.snapshot(globalCtx, rows, now).rotators['rotator-1'];
    assert.equal(view.target_azimuth, 90);
    assert.equal(view.physical_azimuth, 10);
    assert.equal(view.motion_state, 'moving');
    assert.equal(view.last_commander, 'OP-A');

    service.handle(globalCtx, rows, {action: 'report', device_id: 'rotator-1', azimuth: 90}, now);
    view = service.snapshot(globalCtx, rows, now).rotators['rotator-1'];
    assert.equal(view.motion_state, 'settled');

    const late = new Date(now.getTime() + 61000);
    service.handle(globalCtx, rows, {action: 'report', device_id: 'rotator-1', azimuth: 10}, late);
    view = service.snapshot(globalCtx, rows, late).rotators['rotator-1'];
    assert.equal(view.motion_state, 'unknown');
});
