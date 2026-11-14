'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const model = require('../lib/devices/model.js');
const rf = require('../lib/devices/rf.js');
const control = require('../lib/devices/control.js');
const ownership = require('../lib/devices/ownership.js');
const runtime = require('../lib/devices/runtime.js');
const tower = require('../lib/devices/tower.js');
const tx = require('../lib/devices/tx.js');
const commands = require('../lib/devices/commands.js');
const rotatorLink = require('../lib/devices/rotator-link.js');
const ampLink = require('../lib/devices/amp-link.js');
const ampModels = require('../lib/devices/amp-models.js');
const service = require('../lib/devices/service.js');

function fakeTransports() {
    commands.resetForTests();
    commands.setTransports({
        rotate: async () => ({ok: true}),
        stop: async () => ({ok: true}),
        select: async () => ({ok: true}),
        towerHold: async () => ({ok: true}),
        towerRelease: async () => ({ok: true}),
        ampSet: async () => ({ok: true, dispatched: true})
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
        token: '',
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
    // 塔有状态源（继电器/限位上报），只是还没上报 → 等待上报；旋转器未配地址 → 无状态源。
    assert.equal(empty.status['tower-1'].state, 'awaiting');
    assert.equal(empty.towers['tower-1'].state, 'unknown');
    assert.equal(empty.status['rotator-1'].state, 'no-source');
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

    const secured = [storage.devices.toTxSource(sourceRow({id: 'src-s', timeout_ms: 2000, token: 's3cret'}))];
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

    // 运行态只在服务端内存里；重启后为空，且天线本来就没有状态源。
    runtime.reset(globalCtx);
    assert.equal(service.snapshot(globalCtx, rows, now).status['ant-20'].state, 'no-source');
});

test('device writes keep only type-owned fields and never expose relay tokens', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [];

    const created = service.handle(globalCtx, rows, {
        action: 'save',
        device: {
            name: 'Antenna', type: 'antenna', bands: '20m',
            // 旧字段即使被提交也不再落库。
            password: 'plain-secret', exclusive: true, port_label: 'P1', seat: 'OP-A'
        }
    }, now);
    assert.equal(created.status, 201);
    const pub = created.payload.device;
    for (const key of ['password', 'has_password', 'exclusive', 'port_label', 'seat']) {
        assert.equal(Object.prototype.hasOwnProperty.call(pub, key), false, key + ' must be gone');
    }
    assert.doesNotMatch(created.sql[0], /plain-secret/);
    assert.doesNotMatch(created.sql[0], /exclusive/);

    const deviceId = pub.id;
    const updated = service.handle(globalCtx, [device({id: deviceId, type: 'antenna', bands: '20m'})], {
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

test('storage creates every table and migrates missing columns idempotently', () => {
    const schema = storage.devices.createSchema();
    assert.equal(schema.length, 8);
    assert.match(schema[0], /CREATE TABLE IF NOT EXISTS devices/);
    assert.match(schema[1], /CREATE TABLE IF NOT EXISTS tx_sources/);
    assert.match(schema[2], /CREATE TABLE IF NOT EXISTS device_commands/);
    assert.match(schema[3], /CREATE TABLE IF NOT EXISTS device_layout/);
    assert.match(schema[4], /CREATE TABLE IF NOT EXISTS rf_links/);
    assert.match(schema[5], /CREATE UNIQUE INDEX IF NOT EXISTS rf_links_pair/);
    assert.match(schema[6], /CREATE TABLE IF NOT EXISTS control_links/);
    assert.match(schema[7], /CREATE UNIQUE INDEX IF NOT EXISTS control_links_pair/);
    assert.match(storage.devices.snapshotQuery(), /UNION ALL/);
    assert.match(storage.devices.snapshotQuery(), /LEFT JOIN device_layout/);
    assert.match(storage.devices.snapshotQuery(), /FROM rf_links/);
    assert.match(storage.devices.snapshotQuery(), /FROM control_links/);
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

    const poll = byName('Run device polls');
    assert.ok(poll, 'device poll node exists');
    assert.match(poll.func, /dx\.devices\.pollRotators/);
    assert.match(poll.func, /dx\.devices\.pollAmps/);

    assert.match(byName('Run tower watchdog').func, /dx\.devices\.towerWatchdog/);
    assert.match(byName('Run tower release on start').func, /dx\.devices\.towerReleaseAll/);
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

test('command channel requires seat identity and rejects malformed requests', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: ''})];

    let result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 45}, {}, now);
    assert.equal(result.status, 401);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, 'seat-required');
    assert.match(result.sql[0], /INSERT INTO device_commands/);

    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'rotate', azimuth: 45},
        {'X-DX-Seat': 'OP-A', 'X-DX-Operator': 'Alice'}, now);
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
        config_json: JSON.stringify({relay_url: 'http://relay.local/out', channels: {'in1:out1': 3}})
    });
    const source = sourceRow({id: 'src-a', name: 'A', priority: 10, timeout_ms: 2000});
    const rows = [matrix, source];
    const headers = {'X-DX-Seat': 'OP-A'};

    // 未接入任何源：互锁不启用，正常放行。
    let result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in1', outlet: 'out1'}, headers, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.interlock, 'not-enabled');

    // 源上报发射中 → 423 TX_ACTIVE，且不产生下发。
    service.ingestTx(globalCtx, [storage.devices.toTxSource(source)],
        {source_id: 'src-a', tx_active: true}, {}, now);
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in1', outlet: 'out1'}, headers, now);
    assert.equal(result.status, 423);
    assert.equal(result.payload.error, 'tx-active');
    assert.equal(result.payload.interlock, 'tx-active');

    // 源上报未发射 → 放行，互锁启用。
    service.ingestTx(globalCtx, [storage.devices.toTxSource(source)],
        {source_id: 'src-a', tx_active: false, seq: 2}, {}, now);
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in1', outlet: 'out1'}, headers, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.interlock, 'enabled');

    // 源超时 → 互锁不启用，正常放行。
    const stale = new Date(now.getTime() + 7000);
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in1', outlet: 'out1'}, headers, stale);
    assert.equal(result.status, 202);
    assert.equal(result.payload.interlock, 'not-enabled');

    // 未知通道 / 端口不存在 / 缺参数。
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in1', outlet: 'out2'}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'unknown-channel');
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'IN1', outlet: 'out1'}, headers, now);
    assert.equal(result.payload.error, 'unknown-port');
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
        name: 'M', type: 'matrix', config: {relay_url: 'ftp://x'}
    }, {devices: []}).error, 'invalid-config-relay-url');
    assert.equal(model.normalizeDevice({
        name: 'R', type: 'rotator', config: {port: 70000}
    }, {devices: []}).error, 'invalid-config-port');
    assert.equal(model.normalizeDevice({
        name: 'R', type: 'matrix', config: {channels: {'IN1:1': 300}}
    }, {devices: []}).error, 'invalid-config-channel');
});

const relay = require('../lib/devices/relay.js');

test('relay dry contacts post channel actions as JSON', async () => {
    const calls = [];
    relay.setFetchFactory(async (url, init) => {
        calls.push({url, init});
        return {ok: true, status: 200};
    });
    const matrix = {
        id: 'matrix-1',
        type: 'matrix',
        config: {relay_url: 'http://relay.local/out', relay_token: 'tok', pulse_ms: 250}
    };

    let result = await relay.pulse(matrix, 3);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://relay.local/out');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-Relay-Token'], 'tok');
    assert.deepEqual(JSON.parse(calls[0].init.body), {channel: 3, action: 'pulse', pulse_ms: 250});

    await relay.on(matrix, 1);
    assert.deepEqual(JSON.parse(calls[1].init.body), {channel: 1, action: 'on'});
    await relay.off(matrix, 2);
    assert.deepEqual(JSON.parse(calls[2].init.body), {channel: 2, action: 'off'});

    // 未配置端点与非法通道都不发请求。
    result = await relay.pulse({id: 'm2', type: 'matrix', config: {}}, 1);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'transport-not-configured');
    result = await relay.pulse(matrix, 300);
    assert.equal(result.error, 'unknown-channel');

    // 非 2xx 视为通信失败。
    relay.setFetchFactory(async () => ({ok: false, status: 503}));
    result = await relay.pulse(matrix, 3);
    assert.equal(result.status, 502);
    assert.equal(result.error, 'transport-error');
    relay.reset();
});

test('relay request times out instead of hanging', async () => {
    relay.setFetchFactory((url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = await relay.pulse({id: 'm1', type: 'matrix', config: {relay_url: 'http://relay.local/out'}}, 1);
    assert.equal(result.status, 504);
    assert.equal(result.error, 'transport-timeout');
    relay.reset();
});

test('select drives the relay with the mapped channel and records the port', async () => {
    commands.resetForTests();
    commands.setTransports({select: context => relay.pulse(context.device, context.channel, context.pulseMs)});
    const calls = [];
    relay.setFetchFactory(async (url, init) => {
        calls.push(JSON.parse(init.body));
        return {ok: true, status: 200};
    });
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({
        id: 'matrix-1', name: 'Matrix', type: 'matrix', bands: '',
        config_json: JSON.stringify({
            relay_url: 'http://relay.local/out',
            pulse_ms: 300,
            channels: {'in1:out1': 4, 'out1': 5}
        })
    })];
    const headers = {'X-DX-Seat': 'OP-A'};

    const result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in1', outlet: 'out1'}, headers, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.channel, 4);
    assert.deepEqual(calls, [{channel: 4, action: 'pulse', pulse_ms: 300}]);
    assert.equal(runtime.stateOf(globalCtx, 'matrix-1').ports.in1, 'out1');

    // 未配置端口映射时只按出口号回退。
    const fallback = commands.channelFor(storage.devices.toDevice(rows[0]), 'in2', 'out1');
    assert.equal(fallback, 5);
    // 完全没有映射的出口被拒绝。
    assert.equal(commands.channelFor(storage.devices.toDevice(rows[0]), 'in2', 'out9'), null);
    relay.reset();
});

test('commands only apply to matching device types', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [
        deviceRow({id: 'rotator-1', type: 'rotator', bands: ''}),
        deviceRow({id: 'matrix-1', type: 'matrix', bands: ''})
    ];
    const headers = {'X-DX-Seat': 'OP-A'};

    let result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'rotate', azimuth: 45}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'invalid-device-type');

    result = await service.handleCommand(globalCtx, rows, 'rotator-1',
        {command: 'select', port: 'IN1', outlet: '1'}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'invalid-device-type');
});

const towerHold = require('../lib/devices/tower-hold.js');

function towerDevice(overrides) {
    return device(Object.assign({
        id: 'tower-1',
        name: 'Tower',
        type: 'tower',
        bands: '',
        config_json: JSON.stringify({
            relay_url: 'http://relay.local/out',
            up_channel: 1,
            down_channel: 2
        })
    }, overrides || {}));
}

test('tower hold keeps the output closed, renews on heartbeat and times out at 1500ms', async () => {
    const calls = [];
    relay.setFetchFactory(async (url, init) => {
        calls.push(JSON.parse(init.body));
        return {ok: true, status: 200};
    });
    const globalCtx = makeContext();
    const deviceItem = towerDevice();
    const start = new Date('2026-03-01T12:00:00.000Z');

    let result = await towerHold.hold(globalCtx, deviceItem, 'up', 'OP-A', start);
    assert.equal(result.ok, true);
    assert.equal(result.renewed, false);
    assert.deepEqual(calls, [
        {channel: 2, action: 'off'},
        {channel: 1, action: 'on'}
    ]);
    assert.equal(towerHold.stateOf(globalCtx, 'tower-1').direction, 'up');

    // 同方向心跳只续期，不再重复吸合。
    const beat = new Date(start.getTime() + 400);
    result = await towerHold.hold(globalCtx, deviceItem, 'up', 'OP-A', beat);
    assert.equal(result.renewed, true);
    assert.equal(result.dispatched, false);
    assert.equal(calls.length, 2);
    assert.equal(result.expires_ms, beat.getTime() + 1500);

    // 未到 1500ms 不释放。
    let dog = await towerHold.watchdog(globalCtx, [deviceItem], new Date(beat.getTime() + 1499));
    assert.deepEqual(dog.released, []);
    // 超过 1500ms 无心跳 → 断开输出。
    dog = await towerHold.watchdog(globalCtx, [deviceItem], new Date(beat.getTime() + 1501));
    assert.deepEqual(dog.released, [{device_id: 'tower-1', direction: 'up', channel: 1}]);
    assert.deepEqual(calls[calls.length - 1], {channel: 1, action: 'off'});
    assert.ok(towerHold.stateOf(globalCtx, 'tower-1').released_ms);

    relay.reset();
});

test('tower release is immediate and two channels never close together', async () => {
    const calls = [];
    relay.setFetchFactory(async (url, init) => {
        calls.push(JSON.parse(init.body));
        return {ok: true, status: 200};
    });
    const globalCtx = makeContext();
    const deviceItem = towerDevice();
    const start = new Date('2026-03-01T12:00:00.000Z');

    await towerHold.hold(globalCtx, deviceItem, 'up', 'OP-A', start);
    calls.length = 0;

    // 直接反向：宽限期内拒绝，且不输出。
    let result = await towerHold.hold(globalCtx, deviceItem, 'down', 'OP-A', start);
    assert.equal(result.status, 409);
    assert.equal(result.error, 'direction-switch-too-fast');
    assert.deepEqual(calls, []);

    // 松手立即断开。
    result = await towerHold.release(globalCtx, deviceItem, start);
    assert.equal(result.released, true);
    assert.deepEqual(calls, [{channel: 1, action: 'off'}]);

    // 释放后 1000ms 内仍禁止反向。
    calls.length = 0;
    result = await towerHold.hold(globalCtx, deviceItem, 'down', 'OP-A', new Date(start.getTime() + 500));
    assert.equal(result.error, 'direction-switch-too-fast');
    assert.deepEqual(calls, []);

    // 超过最小间隔后允许反向，先断另一路再合。
    result = await towerHold.hold(globalCtx, deviceItem, 'down', 'OP-A', new Date(start.getTime() + 1000));
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
        {channel: 1, action: 'off'},
        {channel: 2, action: 'on'}
    ]);

    relay.reset();
});

test('tower hold needs a configured channel and startup releases every output', async () => {
    const calls = [];
    relay.setFetchFactory(async (url, init) => {
        calls.push(JSON.parse(init.body));
        return {ok: true, status: 200};
    });
    const globalCtx = makeContext();
    const now = new Date('2026-03-01T12:00:00.000Z');

    const bare = towerDevice({id: 'tower-2', config_json: JSON.stringify({relay_url: 'http://relay.local/out'})});
    const result = await towerHold.hold(globalCtx, bare, 'up', 'OP-A', now);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'unknown-channel');

    calls.length = 0;
    const second = towerDevice({id: 'tower-3'});
    const all = await towerHold.releaseAll(globalCtx, [towerDevice(), second], now);
    assert.equal(all.released.length, 4);
    assert.deepEqual(calls.sort((a, b) => a.channel - b.channel), [
        {channel: 1, action: 'off'},
        {channel: 1, action: 'off'},
        {channel: 2, action: 'off'},
        {channel: 2, action: 'off'}
    ]);
    relay.reset();
});

test('tower commands go through the command channel with heartbeats and audit', async () => {
    commands.resetForTests();
    commands.setTransports({
        towerHold: context => towerHold.hold(context.global, context.device, context.direction, context.seat, context.now),
        towerRelease: context => towerHold.release(context.global, context.device, context.now)
    });
    const calls = [];
    relay.setFetchFactory(async (url, init) => {
        calls.push(JSON.parse(init.body));
        return {ok: true, status: 200};
    });
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({
        id: 'tower-1', name: 'Tower', type: 'tower', bands: '',
        config_json: JSON.stringify({relay_url: 'http://relay.local/out', up_channel: 1, down_channel: 2})
    })];
    const headers = {'X-DX-Seat': 'OP-A'};

    let result = await service.handleCommand(globalCtx, rows, 'tower-1',
        {command: 'tower_hold', direction: 'up'}, headers, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.dispatched, true);
    assert.match(result.sql[0], /tower_hold/);

    const beat = new Date(now.getTime() + 500);
    result = await service.handleCommand(globalCtx, rows, 'tower-1',
        {command: 'tower_hold', direction: 'up'}, headers, beat);
    assert.equal(result.status, 202);
    assert.equal(result.payload.dispatched, false);

    // 来不及换向 → 409，审计为 rejected。
    result = await service.handleCommand(globalCtx, rows, 'tower-1',
        {command: 'tower_hold', direction: 'down'}, headers, beat);
    assert.equal(result.status, 409);
    assert.equal(result.payload.error, 'direction-switch-too-fast');

    result = await service.handleCommand(globalCtx, rows, 'tower-1',
        {command: 'tower_release'}, headers, new Date(beat.getTime() + 100));
    assert.equal(result.status, 202);
    assert.equal(runtime.stateOf(globalCtx, 'tower-1').tower_direction, null);

    relay.reset();
});

const layout = require('../lib/devices/layout.js');

test('auto layout is deterministic and keeps every device on the canvas', () => {
    const devices = [
        device({id: 'tower-1', name: 'Tower', type: 'tower', bands: ''}),
        device({id: 'rotator-1', name: 'Rotator', type: 'rotator', bands: '', parent_id: 'tower-1'}),
        device({id: 'ant-20', name: '20m', type: 'antenna', bands: '20m', parent_id: 'rotator-1'}),
        device({id: 'ant-15', name: '15m', type: 'antenna', bands: '15m', parent_id: 'tower-1'}),
        device({id: 'loose-1', name: 'Loose', type: 'switch', bands: ''})
    ];
    const first = layout.autoLayout(devices);
    assert.equal(first['tower-1'].x, layout.ORIGIN);
    assert.equal(first['rotator-1'].x, layout.ORIGIN + layout.X_GAP);
    assert.equal(first['ant-20'].x, layout.ORIGIN + layout.X_GAP * 2);
    assert.equal(first['ant-15'].x, layout.ORIGIN + layout.X_GAP);
    assert.notEqual(first['rotator-1'].y, first['ant-15'].y);
    // 输入顺序打乱后布局不变。
    const shuffled = layout.autoLayout(devices.slice().reverse());
    assert.deepEqual(shuffled, first);
    // 环内节点也有坐标，不会渲染丢失。
    const cyclic = [
        device({id: 'a', name: 'A', type: 'other', bands: '', parent_id: 'b'}),
        device({id: 'b', name: 'B', type: 'other', bands: '', parent_id: 'a'})
    ];
    const positions = layout.autoLayout(cyclic);
    assert.ok(positions.a && positions.b);
});

test('layout writes validate coordinates and device ids', () => {
    const devices = [
        device({id: 'tower-1', name: 'Tower', type: 'tower', bands: ''}),
        device({id: 'ant-20', name: '20m', type: 'antenna', bands: '20m', parent_id: 'tower-1'})
    ];
    const ok = layout.normalizeLayouts([{id: 'tower-1', x: 120, y: 340}, {id: 'tower-1', x: 1, y: 2}], devices);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.layouts, [{id: 'tower-1', x: 120, y: 340}]);

    assert.equal(layout.normalizeLayouts(null, devices).status, 400);
    assert.equal(layout.normalizeLayouts([{id: 'nope', x: 1, y: 2}], devices).status, 404);
    assert.equal(layout.normalizeLayouts([{id: 'tower-1', x: -1, y: 2}], devices).error, 'invalid-layout');
    assert.equal(layout.normalizeLayouts([{id: 'tower-1', x: 1.5, y: 2}], devices).error, 'invalid-layout');
    assert.equal(layout.normalizeLayouts([{id: 'tower-1', x: 1, y: 2}].concat(
        Array.from({length: 200}, () => ({id: 'tower-1', x: 1, y: 2}))), devices).error, 'too-many-layouts');
});

test('layout action writes separate rows and delete cleans them up', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({id: 'tower-1', name: 'Tower', type: 'tower', bands: ''})];

    const saved = service.handle(globalCtx, rows, {
        action: 'layout',
        layouts: [{id: 'tower-1', x: 120, y: 340}]
    }, now);
    assert.equal(saved.status, 200);
    assert.equal(saved.sql.length, 1);
    assert.match(saved.sql[0], /INSERT OR REPLACE INTO device_layout/);
    assert.match(saved.sql[0], /'tower-1', 120, 340/);
    assert.deepEqual(saved.broadcast, {type: 'devices', action: 'layout'});

    const unknown = service.handle(globalCtx, rows, {
        action: 'layout', layouts: [{id: 'nope', x: 1, y: 2}]
    }, now);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.payload.error, 'unknown-device');

    const removed = service.handle(globalCtx, rows, {action: 'delete', id: 'tower-1'}, now);
    assert.equal(removed.status, 200);
    assert.equal(removed.sql.length, 4);
    assert.match(removed.sql[1], /DELETE FROM device_layout WHERE device_id = 'tower-1'/);
    assert.match(removed.sql[2], /DELETE FROM rf_links/);
    assert.match(removed.sql[3], /DELETE FROM control_links/);
});

test('snapshot prefers saved layout and falls back to auto layout', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [
        deviceRow({id: 'tower-1', name: 'Tower', type: 'tower', bands: '', layout_x: 500, layout_y: 260}),
        deviceRow({id: 'ant-20', name: '20m', type: 'antenna', bands: '20m', parent_id: 'tower-1'})
    ];
    const snap = service.snapshot(globalCtx, rows, now);
    const tower = snap.devices.find(item => item.id === 'tower-1');
    const antenna = snap.devices.find(item => item.id === 'ant-20');
    assert.deepEqual(tower.layout, {x: 500, y: 260});
    assert.equal(tower.layout_saved, true);
    assert.equal(antenna.layout_saved, false);
    assert.equal(antenna.layout.x, layout.ORIGIN + layout.X_GAP);
    assert.ok(Number.isFinite(antenna.layout.y));
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
    // 失败原因要留在状态里，界面显示「通信中断（响应超时）」，而不是「状态未知」。
    assert.equal(offline.status['rotator-1'].error, 'transport-timeout');

    rotatorLink.resetLinks();
    rotatorLink.setSocketFactory(null);
});

test('radio status comes from the bound seat instead of device reports', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [deviceRow({
        id: 'radio-1', name: 'Radio', type: 'radio', bands: '',
        config_json: JSON.stringify({computer: 'BG7TVF-2', model: 'FT-817'})
    })];
    globalCtx.set('radioStates', {
        'BG7TVF-2:1': {
            seat: 'BG7TVF-2:1', ts: now.toISOString(), freqKhz: 14025, mode: 'CW',
            isTransmitting: true, opCall: 'BG7TVF', radioNr: '1',
            stationName: 'BG7TVF-2', radioName: 'FT-817'
        }
    });

    const view = service.snapshot(globalCtx, rows, now);
    assert.equal(view.devices[0].seat, 'BG7TVF-2:1');
    const status = view.status['radio-1'];
    assert.equal(status.state, 'online');
    assert.equal(status.radio.freq_khz, 14025);
    assert.equal(status.radio.mode, 'CW');
    assert.equal(status.radio.band, '20m');
    assert.equal(status.radio.is_transmitting, true);
    assert.equal(status.radio.operator, 'BG7TVF');

    // 60 秒无心跳 → 通信中断，但最后已知频率仍可展示。
    const stale = service.snapshot(globalCtx, rows, new Date(now.getTime() + 61000));
    assert.equal(stale.status['radio-1'].state, 'offline');
    assert.equal(stale.status['radio-1'].radio.freq_khz, 14025);

    // 没配席位 → 未绑定席位；切换器/天线这类无源部件 → 无状态源。
    const unbound = [deviceRow({id: 'radio-2', name: 'Radio 2', type: 'radio', bands: '', config_json: '{}'})];
    assert.equal(service.snapshot(globalCtx, unbound, now).status['radio-2'].state, 'unbound');
    const passive = [
        deviceRow({id: 'sw-1', name: 'Switch', type: 'switch', bands: '', config_json: '{}'}),
        deviceRow({id: 'ant-1', name: '20m', type: 'antenna', bands: '20m'})
    ];
    const passiveView = service.snapshot(globalCtx, passive, now);
    assert.equal(passiveView.status['sw-1'].state, 'no-source');
    assert.equal(passiveView.status['ant-1'].state, 'no-source');
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

function rfRow(aDevice, aPort, bDevice, bPort) {
    const swap = aDevice > bDevice || (aDevice === bDevice && aPort > bPort);
    const link = swap
        ? {a_device: bDevice, a_port: bPort, b_device: aDevice, b_port: aPort}
        : {a_device: aDevice, a_port: aPort, b_device: bDevice, b_port: bPort};
    link.link_id = 'rf:' + link.a_device + ':' + link.a_port + '~' + link.b_device + ':' + link.b_port;
    link.created_ts = '2026-01-01T00:00:00.000Z';
    return {
        kind: 'rf',
        id: link.link_id,
        link_id: link.link_id,
        a_device: link.a_device,
        a_port: link.a_port,
        b_device: link.b_device,
        b_port: link.b_port,
        created_ts: link.created_ts
    };
}

test('RF ports are derived from type, counts and combiner bands', () => {
    assert.deepEqual(rf.portsFor(device({id: 'radio-1', type: 'radio', bands: ''})),
        [{key: 'out', dir: 'out', role: 'out'}]);
    assert.deepEqual(rf.portsFor(device({id: 'swr-1', type: 'swr', bands: ''})).map(port => port.key),
        ['in', 'out']);
    const swr = rf.portsFor(device({id: 'swr-1', type: 'swr', bands: ''}));
    assert.equal(swr[1].dir, 'out');

    const switchPorts = rf.portsFor(device({
        id: 'switch-1', type: 'switch', bands: '', config_json: '{"out_count":4}'
    })).map(port => port.key);
    assert.deepEqual(switchPorts, ['in', 'ant1', 'ant2', 'ant3', 'ant4']);

    const matrixPorts = rf.portsFor(device({
        id: 'matrix-1', type: 'matrix', bands: '', config_json: '{"in_count":3,"out_count":5}'
    })).map(port => port.key);
    assert.deepEqual(matrixPorts, ['in1', 'in2', 'in3', 'out1', 'out2', 'out3', 'out4', 'out5']);

    const combiner = rf.portsFor(device({id: 'combiner-1', type: 'combiner', bands: '20m,15m'}));
    assert.deepEqual(combiner.map(port => port.key), ['in:20m', 'in:15m', 'out']);
    assert.equal(combiner[0].band, '20m');
    assert.equal(combiner[0].dir, 'in');
    assert.equal(combiner[2].dir, 'out');

    assert.deepEqual(rf.portsFor(device({id: 'tower-1', type: 'tower', bands: ''})), []);
    assert.deepEqual(rf.portsFor(device({id: 'rotator-1', type: 'rotator', bands: ''})), []);

    // 自定义端口覆盖已废弃：未知类型没有射频口。
    const custom = device({
        id: 'other-1', type: 'other', bands: '',
        config_json: JSON.stringify({ports: [{key: 'a', dir: 'bidir'}, {key: 'b', dir: 'out'}]})
    });
    assert.deepEqual(rf.portsFor(custom), []);

    // 控制 / 状态口是圆形、不可连射频；串口服务器没有射频口。
    const serial = device({id: 'serial-1', type: 'serial', bands: '', config_json: '{"port_count":2}'});
    assert.deepEqual(rf.portsFor(serial), []);
    assert.deepEqual(rf.controlPorts(serial).map(port => port.key), ['net', 'serial1', 'serial2']);
});

test('RF links are undirected, canonical and reject unknown ports', () => {
    const devices = [
        device({id: 'radio-1', type: 'radio', bands: ''}),
        device({id: 'bpf-1', type: 'bpf', bands: '20m'}),
        device({id: 'other-1', type: 'other', bands: ''})
    ];
    const first = rf.normalizeLink({
        a_device: 'radio-1', a_port: 'out', b_device: 'bpf-1', b_port: 'in'
    }, {devices, links: []});
    assert.equal(first.ok, true);
    assert.equal(first.existing, false);
    const link = Object.assign({created_ts: '2026-01-01T00:00:00.000Z'}, first.link);

    // 反向插入视为同一条，不产生第二条记录。
    const reverse = rf.normalizeLink({
        a: {device: 'bpf-1', port: 'in'}, b: {device: 'radio-1', port: 'out'}
    }, {devices, links: [link]});
    assert.equal(reverse.ok, true);
    assert.equal(reverse.existing, true);
    assert.equal(reverse.link.link_id, link.link_id);

    assert.equal(rf.normalizeLink({
        a_device: 'radio-1', a_port: 'nope', b_device: 'bpf-1', b_port: 'in'
    }, {devices, links: []}).error, 'unknown-port');
    assert.equal(rf.normalizeLink({
        a_device: 'radio-1', a_port: 'out', b_device: 'missing', b_port: 'in'
    }, {devices, links: []}).status, 404);
    assert.equal(rf.normalizeLink({
        a_device: 'radio-1', a_port: 'out', b_device: 'radio-1', b_port: 'out'
    }, {devices, links: []}).error, 'invalid-link');
});

test('TX reachability follows port direction and prunes bands per device', () => {
    const devices = [
        device({id: 'radio-1', type: 'radio', bands: ''}),
        device({id: 'amp-1', type: 'amp', bands: ''}),
        device({id: 'bpf-20', type: 'bpf', bands: '20m'}),
        device({id: 'switch-1', type: 'switch', bands: '', config_json: '{"out_count":2}'}),
        device({id: 'ant-20', type: 'antenna', bands: '20m'}),
        device({id: 'ant-15', type: 'antenna', bands: '15m'})
    ];
    const links = [
        rfRow('radio-1', 'out', 'amp-1', 'in'),
        rfRow('amp-1', 'out', 'bpf-20', 'in'),
        rfRow('bpf-20', 'out', 'switch-1', 'in'),
        rfRow('switch-1', 'ant1', 'ant-20', 'in'),
        rfRow('switch-1', 'ant2', 'ant-15', 'in')
    ];
    const reach = (band, selection) => rf.reachableAntennas({
        devices,
        links,
        band,
        startDeviceId: 'radio-1',
        selections: selection ? {'switch-1': selection} : {}
    }).map(hit => hit.device.id);

    assert.deepEqual(reach('20m', {in: 'ant1'}), ['ant-20']);
    // 波段不匹配 BPF：20m BPF 会剪掉 15m 的整条路径。
    assert.deepEqual(reach('15m', {in: 'ant2'}), []);
    assert.deepEqual(reach('15m', {in: 'ant1'}), []);

    // 去掉 BPF 后，波段剪枝仍然发生在天线自身。
    const noBpf = devices.filter(item => item.id !== 'bpf-20');
    const noBpfLinks = [
        rfRow('radio-1', 'out', 'amp-1', 'in'),
        rfRow('amp-1', 'out', 'switch-1', 'in'),
        rfRow('switch-1', 'ant1', 'ant-20', 'in'),
        rfRow('switch-1', 'ant2', 'ant-15', 'in')
    ];
    const reachNoBpf = (band, selection) => rf.reachableAntennas({
        devices: noBpf,
        links: noBpfLinks,
        band,
        startDeviceId: 'radio-1',
        selections: {'switch-1': selection}
    }).map(hit => hit.device.id);
    assert.deepEqual(reachNoBpf('15m', {in: 'ant2'}), ['ant-15']);
    assert.deepEqual(reachNoBpf('15m', {in: 'ant1'}), []);
    // 切换器没有选定输出时不假装导通。
    assert.deepEqual(reach('20m', null), []);
    // 只有一个输出时选择唯一，不依赖运行态。
    const single = devices.map(item => item.id === 'switch-1'
        ? device({id: 'switch-1', type: 'switch', bands: '', config_json: '{"out_count":1}'})
        : item);
    assert.deepEqual(rf.reachableAntennas({
        devices: single,
        links: links.filter(link => link.a_port !== 'out2' && link.b_port !== 'out2'),
        band: '20m',
        startDeviceId: 'radio-1'
    }).map(hit => hit.device.id), ['ant-20']);

    // 端口方向：从电台直接接到功放的输出端，TX 不应倒灌。
    const wrong = rf.reachableAntennas({
        devices: [devices[0], devices[1]],
        links: [rfRow('radio-1', 'out', 'amp-1', 'out')],
        band: '20m',
        startDeviceId: 'radio-1'
    });
    assert.deepEqual(wrong, []);
});

test('combiner matches the band at its in port and still lands on one antenna', () => {
    const devices = [
        device({id: 'radio-20', type: 'radio', bands: ''}),
        device({id: 'radio-15', type: 'radio', bands: ''}),
        device({id: 'combiner-1', type: 'combiner', bands: '20m,15m'}),
        device({id: 'ant-multi', type: 'antenna', bands: '20m,15m'})
    ];
    const links = [
        rfRow('radio-20', 'out', 'combiner-1', 'in:20m'),
        rfRow('radio-15', 'out', 'combiner-1', 'in:15m'),
        rfRow('combiner-1', 'out', 'ant-multi', 'in')
    ];
    const reach = (start, band) => rf.reachableAntennas({
        devices, links, band, startDeviceId: start
    }).map(hit => hit.device.id);

    assert.deepEqual(reach('radio-20', '20m'), ['ant-multi']);
    // 20m 电台不能从 15m 的 in 口进入：波段剪枝下沉到端口。
    assert.deepEqual(reach('radio-20', '15m'), []);
    assert.deepEqual(reach('radio-15', '15m'), ['ant-multi']);

    // 方向接反（电台接到 out 口）不导通。
    const reversed = rf.reachableAntennas({
        devices,
        links: [rfRow('radio-20', 'out', 'combiner-1', 'out'), rfRow('combiner-1', 'out', 'ant-multi', 'in')],
        band: '20m',
        startDeviceId: 'radio-20'
    });
    assert.deepEqual(reversed, []);
});

test('RF warnings flag multi-upstream antennas, combiner coverage and orphan links', () => {
    const devices = [
        device({id: 'radio-1', type: 'radio', bands: ''}),
        device({id: 'switch-1', type: 'switch', bands: '', config_json: '{"out_count":1}'}),
        device({id: 'ant-20', type: 'antenna', bands: '20m'}),
        device({id: 'combiner-1', type: 'combiner', bands: '20m,15m'}),
        device({id: 'ant-multi', type: 'antenna', bands: '20m'})
    ];
    const links = [
        rfRow('radio-1', 'out', 'switch-1', 'in'),
        rfRow('switch-1', 'ant1', 'ant-20', 'in'),
        // 同一副天线再接第二个上游：配置错误，只提示不仲裁。
        rfRow('radio-1', 'out', 'ant-20', 'in'),
        rfRow('combiner-1', 'out', 'ant-multi', 'in'),
        // 端口已不存在：孤立连线。
        {kind: 'rf', link_id: 'rf:switch-1:ant2~ant-20:in', a_device: 'switch-1',
            a_port: 'ant2', b_device: 'ant-20', b_port: 'in', created_ts: '2026-01-01T00:00:00.000Z'}
    ];
    const codes = rf.warnings(devices, links).map(item => item.code);
    assert.ok(codes.includes('antenna-multi-upstream'));
    assert.ok(codes.includes('combiner-antenna-band-uncovered'));
    assert.ok(codes.includes('rf-link-orphan'));
});

test('ownership follows RF reachability and falls back to band matching', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const devices = [
        device({
            id: 'radio-1', type: 'radio', bands: '',
            config_json: JSON.stringify({computer: 'PC-A', model: 'IC-7610'})
        }),
        device({id: 'amp-1', type: 'amp', bands: ''}),
        device({id: 'ant-20', type: 'antenna', bands: '20m'}),
        device({id: 'ant-other', type: 'antenna', bands: '20m'})
    ];
    const links = [
        rfRow('radio-1', 'out', 'amp-1', 'in'),
        rfRow('amp-1', 'out', 'ant-20', 'in')
    ];
    const radioStates = {
        'OP-A': {
            ts: now.toISOString(), freqKhz: 14020,
            computerName: 'pc-a', radioName: 'IC-7610'
        }
    };

    const linked = ownership.project({devices, links, radioStates, now});
    assert.equal(linked.by_seat['OP-A'].source, 'rf');
    assert.deepEqual(linked.by_seat['OP-A'].candidates, ['ant-20']);
    assert.deepEqual(linked.by_seat['OP-A'].radios, ['radio-1']);
    assert.equal(linked.by_seat['OP-A'].colors['ant-20'], 'red');
    assert.equal(linked.by_seat['OP-A'].colors['ant-other'], 'green');
    assert.deepEqual(linked.antennas.find(item => item.id === 'ant-20').owners, ['OP-A']);

    // 没有 RF 连线时保持旧的波段归属，并标记来源。
    const fallback = ownership.project({devices, links: [], radioStates, now});
    assert.equal(fallback.by_seat['OP-A'].source, 'band-fallback');
    assert.deepEqual(fallback.by_seat['OP-A'].candidates.sort(), ['ant-20', 'ant-other']);
    assert.equal(fallback.by_seat['OP-A'].ambiguous, true);

    // 席位切换波段后，RF 路径重新按当前波段判定。
    const switched = ownership.project({
        devices,
        links,
        radioStates: {'OP-A': {ts: now.toISOString(), freqKhz: 21020}},
        now
    });
    assert.deepEqual(switched.by_seat['OP-A'].candidates, []);
    assert.equal(switched.by_seat['OP-A'].colors['ant-20'], 'green');
});

test('combiner and BPF require bands; radio stores only its addressing identity', () => {
    const combiner = model.normalizeDevice({type: 'combiner', name: 'Combiner'}, {devices: []});
    assert.equal(combiner.status, 400);
    assert.equal(combiner.error, 'combiner-band-required');

    const bpf = model.normalizeDevice({type: 'bpf', name: 'BPF'}, {devices: []});
    assert.equal(bpf.error, 'bpf-band-required');

    const radio = model.normalizeDevice({
        type: 'radio', name: 'Radio', seat: 'OP-A',
        config: {computer: 'PC-A', model: 'IC-7610'}
    }, {devices: []});
    assert.equal(radio.ok, true);
    assert.equal(radio.device.seat, undefined);
    assert.equal(radio.device.config.computer, 'PC-A');
    assert.equal(radio.device.config.model, 'IC-7610');

    // 不属于电台的字段即使提交也不落库。
    const stray = model.normalizeDevice({
        type: 'radio', name: 'Radio', bands: '20m', install_offset_deg: 90,
        travel_timeout_sec: 300, config: {host: 'x'}
    }, {devices: []});
    assert.deepEqual(stray.device.bands, []);
    assert.equal(stray.device.install_offset_deg, 0);
    assert.equal(stray.device.travel_timeout_sec, 0);
    assert.deepEqual(stray.device.config, {});

    const saved = model.normalizeDevice({
        type: 'combiner', name: 'Combiner', bands: '20m,15m'
    }, {devices: []});
    assert.equal(saved.ok, true);
    assert.deepEqual(rf.portsFor(saved.device).map(port => port.key), ['in:20m', 'in:15m', 'out']);
});

test('RF link actions attach, dedupe and remove links; port edits clean stale links', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const devices = [
        device({id: 'radio-1', type: 'radio', bands: ''}),
        device({id: 'amp-1', type: 'amp', bands: ''}),
        device({id: 'combiner-1', type: 'combiner', bands: '20m,15m'}),
        device({id: 'ant-multi', type: 'antenna', bands: '20m,15m'})
    ];

    const created = service.handle(globalCtx, devices, {
        action: 'rf-link', link: {a_device: 'radio-1', a_port: 'out', b_device: 'amp-1', b_port: 'in'}
    }, now);
    assert.equal(created.status, 201);
    assert.match(created.sql[0], /INSERT OR REPLACE INTO rf_links/);
    const link = created.payload.link;

    const duplicate = service.handle(globalCtx, devices.concat([Object.assign({kind: 'rf'}, link)]), {
        action: 'rf-link', link: {a_device: 'amp-1', a_port: 'in', b_device: 'radio-1', b_port: 'out'}
    }, now);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.payload.duplicate, true);
    assert.deepEqual(duplicate.sql, []);

    const linkRow = Object.assign({kind: 'rf'}, link);
    const removed = service.handle(globalCtx, devices.concat([linkRow]),
        {action: 'rf-unlink', link_id: link.link_id}, now);
    assert.equal(removed.status, 200);
    assert.match(removed.sql[0], /DELETE FROM rf_links/);

    // 合路器波段从 20m,15m 改为 20m：in:15m 的连线随保存清理。
    const linkRows = [
        rfRow('combiner-1', 'in:15m', 'ant-multi', 'in'),
        rfRow('combiner-1', 'out', 'ant-multi', 'in')
    ];
    const saved = service.handle(globalCtx, devices.concat(linkRows), {
        action: 'save', device: {id: 'combiner-1', bands: '20m'}
    }, now);
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.removed_links, 1);
    assert.ok(saved.sql.some(sql => /DELETE FROM rf_links/.test(sql)));
});

test('control addressing resolves direct network devices and serial-server proxies', () => {
    const devices = [
        device({
            id: 'serial-1', type: 'serial', bands: '',
            config_json: JSON.stringify({
                host: '192.168.1.50', port: 4001, port_count: 2,
                baud: 9600, data_bits: 8, stop_bits: 1, parity: 'none'
            })
        }),
        device({id: 'rotator-1', type: 'rotator', bands: ''}),
        device({
            id: 'rotator-2', type: 'rotator', bands: '',
            config_json: JSON.stringify({host: '192.168.1.60', port: 4533})
        }),
        device({
            id: 'matrix-1', type: 'matrix', bands: '',
            config_json: JSON.stringify({relay_url: 'http://relay.local/out'})
        }),
        device({id: 'amp-1', type: 'amp', bands: ''})
    ];
    const links = [
        control.normalizeLink({a: {device: 'rotator-1', port: 'rotctld'},
            b: {device: 'serial-1', port: 'serial2'}}, {devices, links: []}).link
    ];

    assert.deepEqual(control.resolveFor(devices[1], {devices, links}), {
        mode: 'serial',
        host: '192.168.1.50',
        port: 4001,
        serial_port: 2,
        serial: {baud: 9600, data_bits: 8, stop_bits: 1, parity: 'none'},
        via: 'serial-1'
    });
    assert.deepEqual(control.resolveFor(devices[2], {devices, links}),
        {mode: 'direct', host: '192.168.1.60', port: 4533});
    assert.deepEqual(control.resolveFor(devices[3], {devices, links}),
        {mode: 'direct', url: 'http://relay.local/out'});
    assert.deepEqual(control.resolveFor(devices[4], {devices, links}), {mode: 'unconfigured'});

    const map = control.addressMap(devices, links);
    assert.equal(map['serial-1'].mode, 'direct');
    assert.equal(map['rotator-1'].mode, 'serial');
    assert.equal(map['amp-1'].mode, 'unconfigured');
    // 天线/电台没有控制口，不进入寻址表。
    assert.equal(map['radio-1'], undefined);

    const codes = control.warnings(devices, links).map(item => item.code);
    assert.ok(codes.includes('control-address-unconfigured'));
});

test('control links only join serial-server ports to device control ports', () => {
    const devices = [
        device({id: 'serial-1', type: 'serial', bands: '', config_json: '{"port_count":2}'}),
        device({id: 'serial-2', type: 'serial', bands: ''}),
        device({id: 'rotator-1', type: 'rotator', bands: ''}),
        device({id: 'rotator-2', type: 'rotator', bands: ''})
    ];
    const first = control.normalizeLink(
        {a: {device: 'rotator-1', port: 'rotctld'}, b: {device: 'serial-1', port: 'serial1'}},
        {devices, links: []}
    );
    assert.equal(first.ok, true);
    assert.equal(first.link.link_id, 'ctl:rotator-1:rotctld~serial-1:serial1');
    const links = [first.link];

    const duplicate = control.normalizeLink(
        {a: {device: 'serial-1', port: 'serial1'}, b: {device: 'rotator-1', port: 'rotctld'}},
        {devices, links}
    );
    assert.equal(duplicate.existing, true);

    assert.equal(control.normalizeLink(
        {a: {device: 'rotator-1', port: 'rotctld'}, b: {device: 'rotator-2', port: 'rotctld'}},
        {devices, links}
    ).error, 'serial-server-required');
    assert.equal(control.normalizeLink(
        {a: {device: 'serial-1', port: 'serial2'}, b: {device: 'serial-2', port: 'serial1'}},
        {devices, links}
    ).error, 'invalid-link');
    assert.equal(control.normalizeLink(
        {a: {device: 'serial-1', port: 'net'}, b: {device: 'rotator-1', port: 'rotctld'}},
        {devices, links}
    ).error, 'invalid-control-port');
    assert.equal(control.normalizeLink(
        {a: {device: 'rotator-2', port: 'rotctld'}, b: {device: 'serial-1', port: 'serial1'}},
        {devices, links}
    ).error, 'control-port-busy');
    assert.equal(control.normalizeLink(
        {a: {device: 'rotator-1', port: 'nope'}, b: {device: 'serial-1', port: 'serial2'}},
        {devices, links}
    ).error, 'unknown-control-port');

    // 控制线不进入射频图。
    assert.deepEqual(rf.reachableAntennas({
        devices, links, band: '20m', startDeviceId: 'rotator-1'
    }), []);
});

test('control link actions persist, dedupe and remove independently of RF links', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const devices = [
        deviceRow({
            id: 'serial-1', type: 'serial', bands: '',
            config_json: JSON.stringify({host: '192.168.1.50', port: 4001, port_count: 2})
        }),
        deviceRow({id: 'rotator-1', type: 'rotator', bands: ''})
    ];
    const created = service.handle(globalCtx, devices, {
        action: 'ctl-link',
        link: {a: {device: 'rotator-1', port: 'rotctld'}, b: {device: 'serial-1', port: 'serial1'}}
    }, now);
    assert.equal(created.status, 201);
    assert.match(created.sql[0], /INSERT OR REPLACE INTO control_links/);
    const link = created.payload.link;

    const duplicate = service.handle(globalCtx, devices.concat([Object.assign({kind: 'ctl'}, link)]), {
        action: 'ctl-link',
        link: {a: {device: 'serial-1', port: 'serial1'}, b: {device: 'rotator-1', port: 'rotctld'}}
    }, now);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.payload.duplicate, true);
    assert.deepEqual(duplicate.sql, []);

    const view = service.snapshot(globalCtx, devices.concat([Object.assign({kind: 'ctl'}, link)]), now);
    assert.equal(view.control_links.length, 1);
    assert.equal(view.control_addresses['rotator-1'].mode, 'serial');
    assert.equal(view.control_addresses['rotator-1'].serial_port, 1);

    const removed = service.handle(globalCtx,
        devices.concat([Object.assign({kind: 'ctl'}, link)]),
        {action: 'ctl-unlink', link_id: link.link_id}, now);
    assert.equal(removed.status, 200);
    assert.match(removed.sql[0], /DELETE FROM control_links/);
});

test('serial server form fields reject free-form serial parameters', () => {
    const ok = model.normalizeDevice({
        type: 'serial', name: 'Serial',
        config: {
            host: '192.168.1.50', port: 4001, port_count: 4,
            baud: 115200, data_bits: 8, stop_bits: 1, parity: 'even'
        }
    }, {devices: []});
    assert.equal(ok.ok, true);
    assert.equal(ok.device.config.baud, 115200);
    assert.equal(ok.device.config.parity, 'even');
    assert.deepEqual(rf.portsFor(ok.device), []);

    assert.equal(model.normalizeDevice({
        type: 'serial', name: 'S', config: {baud: 12345}
    }, {devices: []}).error, 'invalid-config-baud');
    assert.equal(model.normalizeDevice({
        type: 'serial', name: 'S', config: {data_bits: 9}
    }, {devices: []}).error, 'invalid-config-databits');
    assert.equal(model.normalizeDevice({
        type: 'serial', name: 'S', config: {stop_bits: 3}
    }, {devices: []}).error, 'invalid-config-stopbits');
    assert.equal(model.normalizeDevice({
        type: 'serial', name: 'S', config: {parity: 'weird'}
    }, {devices: []}).error, 'invalid-config-parity');
});

test('TX interlock only locks the switches on the transmitting path', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [
        deviceRow({id: 'radio-a', name: 'Radio A', type: 'radio', bands: ''}),
        deviceRow({id: 'amp-a', name: 'Amp A', type: 'amp', bands: ''}),
        deviceRow({id: 'switch-a', name: 'Switch A', type: 'switch', bands: '',
            config_json: JSON.stringify({out_count: 1, channels: {'in:ant1': 1}})}),
        deviceRow({id: 'ant-a', name: 'Ant A', type: 'antenna', bands: '20m'}),
        deviceRow({id: 'radio-b', name: 'Radio B', type: 'radio', bands: ''}),
        deviceRow({id: 'amp-b', name: 'Amp B', type: 'amp', bands: ''}),
        deviceRow({id: 'switch-b', name: 'Switch B', type: 'switch', bands: '',
            config_json: JSON.stringify({out_count: 1, channels: {'in:ant1': 2}})}),
        deviceRow({id: 'ant-b', name: 'Ant B', type: 'antenna', bands: '20m'}),
        sourceRow({id: 'src-a', name: 'Amp A TX', priority: 1, timeout_ms: 2000, device_id: 'amp-a'}),
        rfRow('radio-a', 'out', 'amp-a', 'in'),
        rfRow('amp-a', 'out', 'switch-a', 'in'),
        rfRow('switch-a', 'ant1', 'ant-a', 'in'),
        rfRow('radio-b', 'out', 'amp-b', 'in'),
        rfRow('amp-b', 'out', 'switch-b', 'in'),
        rfRow('switch-b', 'ant1', 'ant-b', 'in')
    ];
    const headers = {'X-DX-Seat': 'OP-A'};
    service.ingestTx(globalCtx, [storage.devices.toTxSource(sourceRow({
        id: 'src-a', name: 'Amp A TX', priority: 1, timeout_ms: 2000, device_id: 'amp-a'
    }))], {source_id: 'src-a', tx_active: true}, {}, now);

    // 同一台设备、不同链路：不在 TX 路径上的切换器照常放行。
    let result = await service.handleCommand(globalCtx, rows, 'switch-b',
        {command: 'select', port: 'in', outlet: 'ant1'}, headers, now);
    assert.equal(result.status, 202);

    result = await service.handleCommand(globalCtx, rows, 'switch-a',
        {command: 'select', port: 'in', outlet: 'ant1'}, headers, now);
    assert.equal(result.status, 423);
    assert.equal(result.payload.scope, 'path');
});

test('TX interlock follows the selected matrix input instead of the whole matrix', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [
        deviceRow({id: 'radio-a', name: 'Radio A', type: 'radio', bands: ''}),
        deviceRow({id: 'radio-b', name: 'Radio B', type: 'radio', bands: ''}),
        deviceRow({id: 'matrix-1', name: 'Matrix', type: 'matrix', bands: '',
            config_json: JSON.stringify({in_count: 2, out_count: 2, channels: {'in1:out1': 1, 'in2:out2': 2}})}),
        deviceRow({id: 'ant-a', name: 'Ant A', type: 'antenna', bands: '20m'}),
        deviceRow({id: 'ant-b', name: 'Ant B', type: 'antenna', bands: '20m'}),
        sourceRow({id: 'src-a', name: 'Radio A TX', priority: 1, timeout_ms: 2000, device_id: 'radio-a'}),
        rfRow('radio-a', 'out', 'matrix-1', 'in1'),
        rfRow('radio-b', 'out', 'matrix-1', 'in2'),
        rfRow('matrix-1', 'out1', 'ant-a', 'in'),
        rfRow('matrix-1', 'out2', 'ant-b', 'in')
    ];
    runtime.updateEntry(globalCtx, 'matrix-1', {ports: {in1: 'out1', in2: 'out2'}}, now);
    service.ingestTx(globalCtx, [storage.devices.toTxSource(sourceRow({
        id: 'src-a', name: 'Radio A TX', priority: 1, timeout_ms: 2000, device_id: 'radio-a'
    }))], {source_id: 'src-a', tx_active: true}, {}, now);
    const headers = {'X-DX-Seat': 'OP-B'};

    // 另一个输入口的切换与发射链路无关，应放行。
    let result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in2', outlet: 'out2'}, headers, now);
    assert.equal(result.status, 202);

    // 正在发射的输入口必须锁定。
    result = await service.handleCommand(globalCtx, rows, 'matrix-1',
        {command: 'select', port: 'in1', outlet: 'out1'}, headers, now);
    assert.equal(result.status, 423);
});

test('RF port occupancy rejects a second link on the same connector', () => {
    const devices = [
        device({id: 'radio-1', type: 'radio', bands: ''}),
        device({id: 'amp-1', type: 'amp', bands: ''}),
        device({id: 'amp-2', type: 'amp', bands: ''})
    ];
    const links = [rfRow('radio-1', 'out', 'amp-1', 'in')];

    const second = rf.normalizeLink(
        {a_device: 'radio-1', a_port: 'out', b_device: 'amp-2', b_port: 'in'}, {devices, links});
    assert.equal(second.ok, false);
    assert.equal(second.error, 'rf-port-busy');

    // 另一端换到功放的 out 口就与已有连线无关，可以建立。
    const other = rf.normalizeLink(
        {a_device: 'amp-1', a_port: 'out', b_device: 'amp-2', b_port: 'in'}, {devices, links});
    assert.equal(other.ok, true);
});

test('draft preview exposes draft ports and validates draft links', () => {
    const globalCtx = makeContext();
    const devices = [device({id: 'antenna-1', type: 'antenna', bands: '20m'})];
    const drafts = [
        {id: 'draft-1', name: 'PA 1', type: 'amp'},
        {id: 'draft-2', name: 'PA 2', type: 'amp'}
    ];

    const ok = service.handle(globalCtx, devices, {
        action: 'preview',
        devices: drafts,
        rf_links: [{a_device: 'draft-1', a_port: 'out', b_device: 'antenna-1', b_port: 'in'}],
        control_links: []
    }, new Date('2026-03-01T12:00:00.000Z'));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.payload.ports['draft-1'].map(port => port.key), ['in', 'out']);
    assert.equal(ok.payload.rf_links.length, 1);
    assert.deepEqual(ok.sql, []);

    // 同一副天线的 in 口再连第二台：草稿阶段就要拒绝。
    const busy = service.handle(globalCtx, devices, {
        action: 'preview',
        devices: drafts,
        rf_links: [
            {a_device: 'draft-1', a_port: 'out', b_device: 'antenna-1', b_port: 'in'},
            {a_device: 'draft-2', a_port: 'out', b_device: 'antenna-1', b_port: 'in'}
        ],
        control_links: []
    }, new Date('2026-03-01T12:00:00.000Z'));
    assert.equal(busy.status, 409);
    assert.equal(busy.payload.error, 'rf-port-busy');
});

test('draft preview resolves serial addressing before anything is saved', () => {
    const globalCtx = makeContext();
    const devices = [device({id: 'tower-1', type: 'tower', bands: ''})];
    const drafts = [
        {id: 'draft-1', name: 'Serial Server', type: 'serial', config: {
            host: '192.168.1.50', port: 4001, port_count: 2,
            baud: 9600, data_bits: 8, stop_bits: 1, parity: 'none'
        }},
        {id: 'draft-2', name: 'Rotator', type: 'rotator'}
    ];
    const result = service.handle(globalCtx, devices, {
        action: 'preview',
        devices: drafts,
        rf_links: [],
        control_links: [{a_device: 'draft-2', a_port: 'rotctld', b_device: 'draft-1', b_port: 'serial2'}]
    }, new Date('2026-03-01T12:00:00.000Z'));

    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.control_links.map(link => link.link_id),
        ['ctl:draft-1:serial2~draft-2:rotctld']);
    assert.equal(result.payload.addresses['draft-2'].mode, 'serial');
    assert.equal(result.payload.addresses['draft-2'].serial_port, 2);
    assert.equal(result.payload.addresses['draft-2'].host, '192.168.1.50');
});

test('save-batch assigns ids and writes devices, layouts and draft links together', () => {
    const globalCtx = makeContext();
    const devices = [device({id: 'antenna-1', type: 'antenna', bands: '20m'})];
    const result = service.handle(globalCtx, devices, {
        action: 'save-batch',
        devices: [
            {id: 'draft-1', name: 'PA 1', type: 'amp'},
            {id: 'draft-2', name: 'Ant Switch', type: 'switch', config: {out_count: 2}}
        ],
        layouts: [{id: 'draft-1', x: 120, y: 80}, {id: 'draft-2', x: 360, y: 80}],
        rf_links: [
            {a_device: 'draft-1', a_port: 'out', b_device: 'draft-2', b_port: 'in'},
            {a_device: 'draft-2', a_port: 'ant1', b_device: 'antenna-1', b_port: 'in'}
        ],
        control_links: []
    }, new Date('2026-03-01T12:00:00.000Z'));

    assert.equal(result.status, 201);
    assert.deepEqual(result.payload.id_map, {'draft-1': 'amp-1', 'draft-2': 'switch-1'});
    assert.equal(result.sql[0], 'BEGIN IMMEDIATE;');
    assert.equal(result.sql[result.sql.length - 1], 'COMMIT;');
    assert.equal(result.sql.filter(sql => /INSERT INTO devices/.test(sql)).length, 2);
    assert.equal(result.sql.filter(sql => /INSERT OR REPLACE INTO device_layout/.test(sql)).length, 2);
    assert.equal(result.sql.filter(sql => /INSERT OR REPLACE INTO rf_links/.test(sql)).length, 2);
    assert.ok(result.payload.rf_links.some(link =>
        link.a_device === 'amp-1' && link.b_device === 'switch-1'));
    assert.ok(result.sql.some(sql => /'amp-1'/.test(sql) && /device_layout/.test(sql)));
});

test('save-batch rejects the whole batch when a draft link conflicts', () => {
    const globalCtx = makeContext();
    const devices = [device({id: 'antenna-1', type: 'antenna', bands: '20m'})];
    const result = service.handle(globalCtx, devices, {
        action: 'save-batch',
        devices: [
            {id: 'draft-1', name: 'PA 1', type: 'amp'},
            {id: 'draft-2', name: 'PA 2', type: 'amp'}
        ],
        layouts: [],
        rf_links: [
            {a_device: 'draft-1', a_port: 'out', b_device: 'antenna-1', b_port: 'in'},
            {a_device: 'draft-2', a_port: 'out', b_device: 'antenna-1', b_port: 'in'}
        ],
        control_links: []
    }, new Date('2026-03-01T12:00:00.000Z'));

    assert.equal(result.status, 409);
    assert.equal(result.payload.error, 'rf-port-busy');
    assert.deepEqual(result.sql, []);
});

test('save-batch carries draft control links onto the assigned device ids', () => {
    const globalCtx = makeContext();
    const result = service.handle(globalCtx, [], {
        action: 'save-batch',
        devices: [
            {id: 'draft-1', name: 'Serial Server', type: 'serial', config: {
                host: '192.168.1.50', port: 4001, port_count: 4,
                baud: 19200, data_bits: 8, stop_bits: 1, parity: 'even'
            }},
            {id: 'draft-2', name: 'Rotator', type: 'rotator'}
        ],
        layouts: [],
        rf_links: [],
        control_links: [{a_device: 'draft-2', a_port: 'rotctld', b_device: 'draft-1', b_port: 'serial3'}]
    }, new Date('2026-03-01T12:00:00.000Z'));

    assert.equal(result.status, 201);
    assert.equal(result.payload.control_links.length, 1);
    assert.equal(result.payload.control_links[0].link_id, 'ctl:rotator-1:rotctld~serial-1:serial3');
    assert.equal(result.sql.filter(sql => /INSERT OR REPLACE INTO control_links/.test(sql)).length, 1);
});


test('seat binding matches StationName when packets carry no ComputerName', () => {
    const now = new Date('2026-03-01T12:00:00.000Z');
    const radio = device({
        id: 'radio-station', name: 'FT-817 seat', type: 'radio', bands: '',
        config_json: JSON.stringify({computer: 'bg7tvf-2', model: 'FT-817'})
    });
    const radioStates = {
        'BG7TVF-2:1': {
            seat: 'BG7TVF-2:1', ts: now.toISOString(), freqKhz: 14020, radioNr: '1',
            stationName: 'BG7TVF-2', computerName: '', radioName: 'FT-817'
        }
    };
    const views = ownership.seatViews(radioStates, now.getTime(), 60000);
    assert.equal(ownership.seatForRadio(radio, views), 'BG7TVF-2:1');

    const unbound = device({
        id: 'radio-unbound', name: 'Unbound', type: 'radio', bands: '',
        config_json: JSON.stringify({computer: 'PC-NOT-SEEN', model: ''})
    });
    assert.equal(ownership.seatForRadio(unbound, views), '');
});

const EventEmitter = require('node:events');

class FakeMqttClient extends EventEmitter {
    constructor() {
        super();
        this.published = [];
        this.subscribed = [];
        this.ended = false;
        this.connected = false;
    }
    subscribe(topic, options, callback) {
        this.subscribed.push(topic);
        if (callback) callback(null);
    }
    publish(topic, payload, options, callback) {
        this.published.push({topic, message: JSON.parse(payload)});
        if (callback) callback(null);
    }
    end() { this.ended = true; }
}

function ampRow(overrides) {
    return deviceRow(Object.assign({
        id: 'amp-1', name: 'AMP1000', type: 'amp', bands: '',
        config_json: JSON.stringify({
            host: '127.0.0.1', port: 1883, protocol: 'mqtt', device_id: 'AMP1000-A'
        })
    }, overrides || {}));
}

test('AMP1000 心跳驱动设备状态：连接、读数、告警与通信中断', async () => {
    ampLink.resetForTests();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [ampRow()];
    const client = new FakeMqttClient();
    ampLink.setClientFactory(() => client);

    const polled = service.pollAmps(globalCtx, rows, now);
    assert.equal(polled.connected, 0);
    assert.equal(polled.errors[0].error, 'transport-connect');
    // 尚未连上、也没收到错误事件 → 等待上报，而不是 unknown。
    assert.equal(service.snapshot(globalCtx, rows, now).status['amp-1'].state, 'awaiting');

    client.emit('connect');
    assert.deepEqual(client.subscribed, ['amplifier/device/AMP1000-A/heartbeat']);
    let view = service.snapshot(globalCtx, rows, now);
    assert.equal(view.status['amp-1'].state, 'online');
    assert.equal(view.status['amp-1'].amp, null);

    client.emit('message', 'amplifier/device/AMP1000-A/heartbeat', Buffer.from(JSON.stringify({
        msg_id: 'hb-1', cmd: 'remote_control', timestamp: 1772366400,
        data: {
            device_id: 'AMP1000-A', pa_switch: 1, ptt_status: 1, work_freq: 14025000,
            tune_mode: 1, trigger_mode: 1, attenuator_sel: 3, attenuator_list: [0, 3, 6, 9],
            filter_sel: '5', in_antenna_sel: 1, out_antenna_sel: 2, freq_band_select: 1,
            out_fwd_power: 95.4, out_rev_power: 2.5, out_swr: 1.8,
            in_fwd_power: 1.2, current_voltage: 48.2, current_current: 1.25,
            current_temperature: 42.5, alarm_word: 0,
            serial_connection: true, mqtt_connection: true,
            firmware_version: '1.5.3', software_version: '1.0.0'
        }
    })));
    view = service.snapshot(globalCtx, rows, now);
    const status = view.status['amp-1'];
    assert.equal(status.state, 'online');
    assert.equal(status.amp.pa_switch, 1);
    assert.equal(status.amp.ptt_status, 1);
    assert.equal(status.amp.band, '20m');
    assert.equal(status.amp.out_fwd_power, 95.4);
    assert.equal(status.amp.out_swr, 1.8);
    assert.equal(status.amp.current_voltage, 48.2);
    assert.equal(status.amp.current_temperature, 42.5);
    assert.equal(status.amp.alarm_active, false);
    assert.equal(status.amp.pdc, 60.25);
    assert.equal(status.amp.attenuator_list.length, 4);

    // 只认主题对应的设备；串台的载荷丢弃。
    const foreign = client.emit('message', 'amplifier/device/AMP1000-A/heartbeat',
        Buffer.from(JSON.stringify({cmd: 'remote_control', data: {device_id: 'OTHER', pa_switch: 0}})));
    assert.equal(foreign, true);
    assert.equal(service.snapshot(globalCtx, rows, now).status['amp-1'].amp.pa_switch, 1);

    client.emit('close');
    view = service.snapshot(globalCtx, rows, new Date(now.getTime() + 1000));
    assert.equal(view.status['amp-1'].state, 'offline');
    assert.equal(view.status['amp-1'].error, 'transport-connect');
    // 断线后仍保留最后一次读数，界面可以提示最后状态。
    assert.equal(view.status['amp-1'].amp.out_fwd_power, 95.4);

    // 重连后下发只包含调用方给的 delta，并带上设备 ID。
    client.emit('connect');
    const sent = await ampLink.publish(storage.devices.toDevice(rows[0]), {pa_switch: 0});
    assert.equal(sent.ok, true);
    const published = client.published[client.published.length - 1];
    assert.equal(published.topic, 'amplifier/device/AMP1000-A/json_command');
    assert.equal(published.message.cmd, 'remote_control');
    assert.equal(published.message.data.pa_switch, 0);
    assert.equal(published.message.data.device_id, 'AMP1000-A');

    ampLink.resetForTests();
});

test('AMP1000 下发命令只走白名单，校准/工程参数一律拒绝', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const rows = [ampRow()];
    const headers = {'X-DX-Seat': 'OP-A'};

    let result = await service.handleCommand(globalCtx, rows, 'amp-1',
        {command: 'amp_set', args: {pa_switch: 0, tune_mode: 1}}, headers, now);
    assert.equal(result.status, 202);
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.delta, {pa_switch: 0, tune_mode: 1});

    result = await service.handleCommand(globalCtx, rows, 'amp-1',
        {command: 'amp_set', args: {eng_params: {}}}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'invalid-arg');

    result = await service.handleCommand(globalCtx, rows, 'amp-1',
        {command: 'amp_set', args: {calibration_gain: 12}}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'invalid-arg');

    result = await service.handleCommand(globalCtx, rows, 'amp-1',
        {command: 'amp_set', args: {tune_mode: 2}}, headers, now);
    assert.equal(result.status, 400);

    result = await service.handleCommand(globalCtx, rows, 'amp-1',
        {command: 'amp_set', args: {}}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'empty-command');

    result = await service.handleCommand(globalCtx, rows, 'amp-1',
        {command: 'amp_calibrate'}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'unknown-command');
});

test('Elecraft KPA500：ASCII 状态解析与串口动作白名单', async () => {
    const definition = ampModels.resolve('elecraft', 'kpa500');
    assert.ok(definition, 'KPA500 definition must exist');
    assert.equal(definition.transport, 'elecraft-ascii');
    assert.equal(definition.protocol, 'serial');
    assert.equal(ampModels.transportOf({brand: 'elecraft', model: 'kpa500'}), 'elecraft-ascii');
    assert.equal(ampModels.transportOf({brand: 'guohe', model: 'amp1000'}), 'mqtt');
    // 描述表里只有面板等效动作，没有 ^PJ/^AL 等调整与阈值命令。
    assert.deepEqual(definition.controls.map(item => item.delta.action),
        ['power_on', 'power_off', 'operate', 'standby', 'clear_fault']);

    const state = {};
    assert.equal(ampLink.applyElecraftFrame(state, '^OS1'), true);
    assert.equal(state.operating, 1);
    assert.equal(state.power_on, 1);
    assert.equal(ampLink.applyElecraftFrame(state, '^BN05'), true);
    assert.equal(state.band, '20m');
    assert.equal(ampLink.applyElecraftFrame(state, '^WS100 018'), true);
    assert.equal(state.out_fwd_power, 100);
    assert.equal(state.out_swr, 1.8);
    assert.equal(ampLink.applyElecraftFrame(state, '^TM045'), true);
    assert.equal(state.current_temperature, 45);
    assert.equal(ampLink.applyElecraftFrame(state, '^VI480 012'), true);
    assert.equal(state.current_voltage, 48);
    assert.equal(state.current_current, 1.2);
    assert.equal(ampLink.applyElecraftFrame(state, '^FL03'), true);
    assert.equal(state.alarm_active, true);
    assert.equal(state.fault_code, '0x03');
    assert.equal(ampLink.applyElecraftFrame(state, '^RVM01.20'), true);
    assert.equal(state.firmware_version, '01.20');

    // 串口服务器寻址：KPA500 不填 host/port 时，经控制连线继承串口服务器地址。
    const serialServer = device({
        id: 'serial-1', name: 'Serial', type: 'serial', bands: '',
        config_json: JSON.stringify({host: '127.0.0.1', port: 5001, port_count: 1})
    });
    const linkedAmp = device({
        id: 'kpa-2', name: 'KPA500 linked', type: 'amp', bands: '',
        config_json: JSON.stringify({brand: 'elecraft', model: 'kpa500', protocol: 'serial'})
    });
    const link = control.normalizeLink({
        a: {device: 'kpa-2', port: 'keying'},
        b: {device: 'serial-1', port: 'serial1'}
    }, {devices: [serialServer, linkedAmp], links: []}).link;
    const address = control.resolveFor(linkedAmp, {devices: [serialServer, linkedAmp], links: [link]});
    assert.equal(address.mode, 'serial');
    assert.equal(address.host, '127.0.0.1');
    assert.equal(address.port, 5001);
    assert.equal(address.serial_port, 1);

    // 模拟串口服务器：socket 工厂注入，验证连接后轮询与动作下发。
    class FakeSocket extends require('node:events') {
        constructor() {
            super();
            this.writes = [];
        }
        write(chunk, callback) {
            this.writes.push(String(chunk));
            if (typeof callback === 'function') callback();
            return true;
        }
        removeAllListeners() { super.removeAllListeners(); return this; }
        destroy() { return this; }
    }
    ampLink.resetForTests();
    let fake = null;
    ampLink.setSocketFactory(() => { fake = new FakeSocket(); return fake; });
    const globalCtx = makeContext();
    const kpa = storage.devices.toDevice(deviceRow({
        id: 'kpa-1', name: 'KPA500', type: 'amp', bands: '',
        config_json: JSON.stringify({
            brand: 'elecraft', model: 'kpa500', protocol: 'serial', host: '10.0.0.5', port: 4001
        })
    }));
    ampLink.pollAmps(globalCtx, [kpa], new Date(), {devices: [kpa], links: []});
    assert.ok(fake, 'socket must be created for a configured serial model');
    fake.emit('connect');
    fake.emit('data', Buffer.from('^OS1;^WS100 018;^VI480 012;^FL00;'));
    const entry = runtime.stateOf(globalCtx, 'kpa-1');
    assert.equal(entry.amp_connected, true);
    assert.equal(entry.amp.operating, 1);
    assert.equal(entry.amp.band, '');
    assert.equal(entry.amp.out_fwd_power, 100);
    assert.equal(entry.amp.out_swr, 1.8);
    assert.equal(entry.amp.current_voltage, 48);
    assert.equal(entry.amp.current_current, 1.2);

    const sent = await ampLink.publish(kpa, {action: 'standby'}, new Date(), globalCtx);
    assert.equal(sent.ok, true);
    assert.ok(fake.writes.includes('^OS0;'));
    assert.equal(runtime.stateOf(globalCtx, 'kpa-1').amp.operating, 0);

    const denied = await ampLink.publish(kpa, {action: 'calibrate'}, new Date(), globalCtx);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 400);

    ampLink.resetForTests();
    let linkedSocket = null;
    ampLink.setSocketFactory(() => { linkedSocket = new FakeSocket(); return linkedSocket; });
    ampLink.pollAmps(globalCtx, [linkedAmp], new Date(), {devices: [serialServer, linkedAmp], links: [link]});
    assert.ok(linkedSocket, 'linked serial amp must connect through the serial server address');
    ampLink.resetForTests();
});

test('KPA500 命令入口：只接受型号描述表里的动作', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const kpaRow = deviceRow({
        id: 'kpa-1', name: 'KPA500', type: 'amp', bands: '',
        config_json: JSON.stringify({brand: 'elecraft', model: 'kpa500', protocol: 'serial'})
    });
    const headers = {'X-DX-Seat': 'OP-A'};
    let result = await service.handleCommand(globalCtx, [kpaRow], 'kpa-1',
        {command: 'amp_set', args: {action: 'operate'}}, headers, now);
    assert.equal(result.status, 202);
    assert.deepEqual(result.payload.delta, {action: 'operate'});

    result = await service.handleCommand(globalCtx, [kpaRow], 'kpa-1',
        {command: 'amp_set', args: {action: 'calibrate'}}, headers, now);
    assert.equal(result.status, 400);
    assert.equal(result.payload.error, 'invalid-arg');

    // 串口型号不接受 MQTT 的 delta 字段，避免把字段写到错误协议上。
    result = await service.handleCommand(globalCtx, [kpaRow], 'kpa-1',
        {command: 'amp_set', args: {pa_switch: 0}}, headers, now);
    assert.equal(result.status, 400);

    // 反过来，MQTT 型号也不接受串口动作。
    result = await service.handleCommand(globalCtx, [ampRow()], 'amp-1',
        {command: 'amp_set', args: {action: 'operate'}}, headers, now);
    assert.equal(result.status, 400);

    // 未公开协议/未实现的型号只能留记录，不能保存。
    const unsupported = model.normalizeDevice({
        type: 'amp', name: 'LUX', config: {brand: 'mercury', model: 'lux'}
    }, {devices: []});
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.error, 'invalid-amp-model');
});

/** 构造一条合法的 ACOM 遥测帧：固定 72 字节，末字节补足和校验。 */
function acomFrame(fields) {
    const frame = new Array(72).fill(0);
    frame[0] = 0x55;
    frame[1] = 0x2f;
    frame[2] = 0x45;
    for (const pair of fields || []) frame[pair[0]] = pair[1];
    let sum = 0;
    for (let i = 0; i < 71; i += 1) sum += frame[i];
    frame[71] = (-sum) & 0xff;
    return frame;
}

class AcomSocket extends require('node:events') {
    constructor() {
        super();
        this.writes = [];
    }
    write(chunk, callback) {
        this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
        if (typeof callback === 'function') callback();
        return true;
    }
    removeAllListeners() { super.removeAllListeners(); return this; }
    destroy() { return this; }
}

test('ACOM：五个型号共用二进制帧，温度偏移与动作表按型号', () => {
    const models = [['500s', 282], ['600s', 273], ['700s', 282], ['1200s', 281], ['2020s', 282]];
    for (const [id, offset] of models) {
        const definition = ampModels.resolve('acom', id);
        assert.ok(definition, `ACOM ${id} definition must exist`);
        assert.equal(definition.supported, true);
        assert.equal(definition.transport, 'acom-binary');
        assert.equal(definition.protocol, 'serial');
        assert.equal(definition.parser.temperature_offset, offset);
        // 只有 Operate / Standby / Off：仓库没有串口开机命令。
        assert.deepEqual(definition.controls.map(item => item.delta.action),
            ['operate', 'standby', 'power_off']);
        assert.equal(ampModels.transportOf({brand: 'acom', model: id}), 'acom-binary');
    }
    // 帧结构与解析共用一套，型号之间只差温度换算偏移。
    assert.deepEqual(ampModels.resolve('acom', '500s').status,
        ampModels.resolve('acom', '2020s').status);
});

test('ACOM：72 字节和校验、状态/读数解析与温度偏移', () => {
    const frame = acomFrame([
        [3, 0x60],                 // status 高半字节 6 = RECEIVE
        [8, 10], [9, 2],           // 直流功率 10*0.1 + 2*25.6 = 52.2 W
        [16, 0x47], [17, 0x01],    // 温度原值 327
        [20, 0xdc], [21, 0x05],    // 推动 1500 → 150.0 W
        [22, 0xf4], [23, 0x01],    // 正向 500 W
        [24, 20], [25, 0],         // 反射 20 W
        [26, 125], [27, 0],        // SWR 1.25
        [66, 0xff],                // 0xFF = 无错误
        [69, 0x25]                 // 风扇 2，波段索引 5 = 20m
    ]);
    assert.equal(frame.length, 72);
    let sum = 0;
    for (const byte of frame) sum = (sum + byte) & 0xff;
    assert.equal(sum, 0);

    const state = {amp: {}};
    assert.equal(ampLink.applyAcomFrame(state, frame, 282), true);
    assert.equal(state.amp.status_code, 6);
    assert.equal(state.amp.power_on, 1);
    assert.equal(state.amp.operating, 1);
    assert.equal(state.amp.transmitting, 0);
    assert.equal(state.amp.current_temperature, 45);
    assert.equal(state.amp.drive_power, 150);
    assert.equal(state.amp.out_fwd_power, 500);
    assert.equal(state.amp.out_rev_power, 20);
    assert.equal(state.amp.out_swr, 1.25);
    assert.ok(Math.abs(state.amp.dc_power - 52.2) < 1e-9);
    assert.equal(state.amp.fan_state, 2);
    assert.equal(state.amp.band, '20m');
    assert.equal(state.amp.alarm_active, false);
    assert.equal(state.amp.fault_code, '');

    // 同一帧，不同型号只有温度不同。
    for (const [offset, temperature] of [[273, 54], [281, 46]]) {
        const other = {amp: {}};
        assert.equal(ampLink.applyAcomFrame(other, frame, offset), true);
        assert.equal(other.amp.current_temperature, temperature);
    }

    // 发射与关机状态。
    const txState = {amp: {}};
    assert.equal(ampLink.applyAcomFrame(txState, acomFrame([[3, 0x70]]), 282), true);
    assert.equal(txState.amp.transmitting, 1);
    assert.equal(txState.amp.operating, 1);
    const offState = {amp: {}};
    assert.equal(ampLink.applyAcomFrame(offState, acomFrame([[3, 0xa0], [66, 0x08]]), 282), true);
    assert.equal(offState.amp.status_code, 10);
    assert.equal(offState.amp.power_on, 0);
    assert.equal(offState.amp.operating, 0);
    assert.equal(offState.amp.alarm_active, true);
    assert.equal(offState.amp.fault_code, '0x08');

    // 和校验不为零的帧整帧丢弃，不能污染已有读数。
    const broken = frame.slice();
    broken[40] = 1;
    const untouched = {amp: {status_code: 99}};
    assert.equal(ampLink.applyAcomFrame(untouched, broken, 282), false);
    assert.equal(untouched.amp.status_code, 99);

    // 流式解析：假起始字节被丢弃，跨多次 data 事件也能拼回整帧。
    const stream = {frame: [], parsing: false, amp: {}};
    const payload = Buffer.from([0x00, 0x55, 0x00].concat(frame));
    assert.equal(ampLink.feedAcom(stream, payload.slice(0, 20), 282), false);
    assert.equal(ampLink.feedAcom(stream, payload.slice(20, 45), 282), false);
    assert.equal(ampLink.feedAcom(stream, payload.slice(45), 282), true);
    assert.equal(stream.parsing, false);
    assert.equal(stream.amp.out_fwd_power, 500);
});

test('ACOM：遥测启停、状态上卡与三个动作下发', async () => {
    ampLink.resetForTests();
    let socket = null;
    ampLink.setSocketFactory(() => { socket = new AcomSocket(); return socket; });
    const globalCtx = makeContext();
    const acom = storage.devices.toDevice(deviceRow({
        id: 'acom-1', name: 'ACOM 1200S', type: 'amp', bands: '',
        config_json: JSON.stringify({
            brand: 'acom', model: '1200s', protocol: 'serial', host: '10.0.0.7', port: 4002
        })
    }));
    ampLink.pollAmps(globalCtx, [acom], new Date(), {devices: [acom], links: []});
    assert.ok(socket, 'ACOM 型号必须建立串口链路');

    // 连接成功立刻发 Start Telemetry。
    socket.emit('connect');
    assert.equal(socket.writes.length, 1);
    assert.deepEqual([...socket.writes[0]], ampLink.ACOM_ENABLE_TELEMETRY);

    // 收到遥测后状态上卡；仓库不实现 0x86 ACK，因此不能多写任何字节。
    socket.emit('data', Buffer.from(acomFrame([
        [3, 0x70], [16, 0x47], [17, 0x01], [22, 0xf4], [23, 0x01],
        [26, 125], [27, 0], [66, 0xff], [69, 0x25]
    ])));
    const entry = runtime.stateOf(globalCtx, 'acom-1');
    assert.equal(entry.amp_connected, true);
    assert.equal(entry.amp.out_fwd_power, 500);
    assert.equal(entry.amp.out_swr, 1.25);
    assert.equal(entry.amp.current_temperature, 46);
    assert.equal(entry.amp.band, '20m');
    assert.equal(entry.amp.transmitting, 1);
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.writes.some(buf => buf.includes(0x86)), false);

    // 三个动作按仓库字节下发；不乐观改状态，等下一帧遥测。
    const sent = await ampLink.publish(acom, {action: 'operate'}, new Date(), globalCtx);
    assert.equal(sent.ok, true);
    assert.deepEqual([...socket.writes[1]], ampLink.acomCommand('operate'));
    assert.equal(runtime.stateOf(globalCtx, 'acom-1').amp.status_code, 7);

    const off = await ampLink.publish(acom, {action: 'power_off'}, new Date(), globalCtx);
    assert.equal(off.ok, true);
    assert.deepEqual([...socket.writes[2]], ampLink.acomCommand('power_off'));

    const denied = await ampLink.publish(acom, {action: 'calibrate'}, new Date(), globalCtx);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 400);
    assert.equal(socket.writes.length, 3);

    // 断开前发 Stop Telemetry，避免设备继续推送。
    ampLink.resetForTests();
    assert.equal(socket.writes.length, 4);
    assert.deepEqual([...socket.writes[3]], ampLink.ACOM_DISABLE_TELEMETRY);
});

test('ACOM 命令入口：只接受三个动作，拒绝校准与 MQTT 字段', async () => {
    fakeTransports();
    const now = new Date('2026-03-01T12:00:00.000Z');
    const globalCtx = makeContext();
    const row = deviceRow({
        id: 'acom-1', name: 'ACOM 700S', type: 'amp', bands: '',
        config_json: JSON.stringify({brand: 'acom', model: '700s', protocol: 'serial'})
    });
    const headers = {'X-DX-Seat': 'OP-A'};
    for (const action of ['operate', 'standby', 'power_off']) {
        const result = await service.handleCommand(globalCtx, [row], 'acom-1',
            {command: 'amp_set', args: {action}}, headers, now);
        assert.equal(result.status, 202);
        assert.deepEqual(result.payload.delta, {action});
    }
    for (const action of ['power_on', 'calibrate', 'clear_fault']) {
        const result = await service.handleCommand(globalCtx, [row], 'acom-1',
            {command: 'amp_set', args: {action}}, headers, now);
        assert.equal(result.status, 400);
    }
    const mqttDelta = await service.handleCommand(globalCtx, [row], 'acom-1',
        {command: 'amp_set', args: {pa_switch: 0}}, headers, now);
    assert.equal(mqttDelta.status, 400);
});

test('Elecraft KPA1500：只读轮询的型号表与 ASCII 解析', async () => {
    const definition = ampModels.resolve('elecraft', 'kpa1500');
    assert.ok(definition, 'KPA1500 definition must exist');
    assert.equal(definition.supported, true);
    assert.equal(definition.transport, 'elecraft-ascii');
    assert.equal(definition.protocol, 'serial');
    assert.equal(ampModels.transportOf({brand: 'elecraft', model: 'kpa1500'}), 'elecraft-ascii');
    // 本轮只读：动作表为空，命令入口会拒绝所有 amp_set。
    assert.deepEqual(definition.controls, []);
    assert.equal(definition.fields.find(field => field.key === 'port').default, 1500);
    assert.deepEqual(definition.parser.poll,
        ['^OS;', '^BN;', '^WS;', '^TM;', '^VI;', '^FS;', '^FL;', '^RVM;']);

    const state = {};
    assert.equal(ampLink.applyElecraftFrame(state, '^OS1'), true);
    assert.equal(state.operating, 1);
    assert.equal(ampLink.applyElecraftFrame(state, '^BN05'), true);
    assert.equal(state.band, '20m');
    // KPA1500 的 ^WS 用四位瓦数；SWR 仍以十分之一为单位。
    assert.equal(ampLink.applyElecraftFrame(state, '^WS1204 014'), true);
    assert.equal(state.out_fwd_power, 1204);
    assert.equal(state.out_swr, 1.4);
    assert.equal(ampLink.applyElecraftFrame(state, '^PWF1204'), true);
    assert.equal(state.out_fwd_power, 1204);
    assert.equal(ampLink.applyElecraftFrame(state, '^PWR018'), true);
    assert.equal(state.out_rev_power, 18);
    assert.equal(ampLink.applyElecraftFrame(state, '^PWI045'), true);
    assert.equal(state.in_fwd_power, 45);
    assert.equal(ampLink.applyElecraftFrame(state, '^TM055'), true);
    assert.equal(state.current_temperature, 55);
    assert.equal(ampLink.applyElecraftFrame(state, '^VI513 061', {current_divisor: 1}), true);
    assert.equal(state.current_voltage, 51.3);
    assert.equal(state.current_current, 61);
    assert.equal(ampLink.applyElecraftFrame(state, '^FS3'), true);
    assert.equal(state.fan_speed, 3);
    assert.equal(ampLink.applyElecraftFrame(state, '^FL20'), true);
    assert.equal(state.alarm_active, true);
    assert.equal(state.fault_code, '0x20');
    assert.equal(ampLink.applyElecraftFrame(state, '^RVM01.47'), true);
    assert.equal(state.firmware_version, '01.47');

    // 串口链路：连接后按 KPA1500 的命令表轮询，状态能上卡。
    class FakeSocket extends require('node:events') {
        constructor() {
            super();
            this.writes = [];
        }
        write(chunk, callback) {
            this.writes.push(String(chunk));
            if (typeof callback === 'function') callback();
            return true;
        }
        removeAllListeners() { super.removeAllListeners(); return this; }
        destroy() { return this; }
    }
    ampLink.resetForTests();
    let fake = null;
    ampLink.setSocketFactory(() => { fake = new FakeSocket(); return fake; });
    const globalCtx = makeContext();
    const kpa = storage.devices.toDevice(deviceRow({
        id: 'kpa1500-1', name: 'KPA1500', type: 'amp', bands: '',
        config_json: JSON.stringify({
            brand: 'elecraft', model: 'kpa1500', protocol: 'serial', host: '10.0.0.9', port: 1500
        })
    }));
    ampLink.pollAmps(globalCtx, [kpa], new Date(), {devices: [kpa], links: []});
    assert.ok(fake, 'KPA1500 must create a serial link');
    fake.emit('connect');
    assert.equal(fake.writes[0], '^OS;');
    fake.emit('data', Buffer.from('^OS1;^WS1204 014;^TM055;^FL00;^FS2;'));
    const entry = runtime.stateOf(globalCtx, 'kpa1500-1');
    assert.equal(entry.amp_connected, true);
    assert.equal(entry.amp.operating, 1);
    assert.equal(entry.amp.out_fwd_power, 1204);
    assert.equal(entry.amp.out_swr, 1.4);
    assert.equal(entry.amp.current_temperature, 55);
    assert.equal(entry.amp.fan_speed, 2);
    assert.equal(entry.amp.alarm_active, false);
    ampLink.resetForTests();

    // 只读阶段：动作一律拒绝，MQTT 字段也拒绝。
    fakeTransports();
    const row = deviceRow({
        id: 'kpa1500-1', name: 'KPA1500', type: 'amp', bands: '',
        config_json: JSON.stringify({brand: 'elecraft', model: 'kpa1500', protocol: 'serial'})
    });
    const headers = {'X-DX-Seat': 'OP-A'};
    let result = await service.handleCommand(globalCtx, [row], 'kpa1500-1',
        {command: 'amp_set', args: {action: 'operate'}}, headers, new Date());
    assert.equal(result.status, 400);
    result = await service.handleCommand(globalCtx, [row], 'kpa1500-1',
        {command: 'amp_set', args: {pa_switch: 0}}, headers, new Date());
    assert.equal(result.status, 400);
});

/** 构造一条 SPE 状态响应：AA AA AA | CNT | CSV | CHK0 CHK1 | CR LF。 */
function speFrame(csv) {
    const payload = Buffer.from(csv, 'ascii');
    let sum = 0;
    for (const byte of payload) sum += byte;
    return Buffer.concat([
        Buffer.from([0xaa, 0xaa, 0xaa, payload.length]),
        payload,
        Buffer.from([sum & 0xff, (sum >> 8) & 0xff, 0x0d, 0x0a])
    ]);
}

test('SPE Expert：三个型号共用状态串，2K 额外两层温度', () => {
    const models = [['expert-13k', false], ['expert-15k', false], ['expert-2k', true]];
    for (const [id, extraTemps] of models) {
        const definition = ampModels.resolve('spe', id);
        assert.ok(definition, `SPE ${id} definition must exist`);
        assert.equal(definition.supported, true);
        assert.equal(definition.transport, 'spe-binary');
        assert.equal(definition.protocol, 'serial');
        // 只读阶段：动作表为空。
        assert.deepEqual(definition.controls, []);
        assert.equal(ampModels.transportOf({brand: 'spe', model: id}), 'spe-binary');
        const hasLower = definition.status.some(item => item.key === 'temp_lower');
        assert.equal(hasLower, extraTemps);
    }
});

test('SPE Expert：19 字段状态串解析、校验与流式拼帧', () => {
    const parsed = ampLink.parseSpeStatus(
        '13K,O,T,A,1,05,2a,0r,H,1204, 1.10, 1.25, 48.0, 32.5, 45,  0,  0,N,N');
    assert.ok(parsed);
    assert.equal(parsed.operating, 1);
    assert.equal(parsed.transmitting, 1);
    assert.equal(parsed.band, '20m');
    assert.equal(parsed.out_fwd_power, 1204);
    assert.equal(parsed.swr_atu, 1.1);
    assert.equal(parsed.out_swr, 1.25);
    assert.equal(parsed.current_voltage, 48);
    assert.equal(parsed.current_current, 32.5);
    assert.equal(parsed.current_temperature, 45);
    assert.equal(parsed.temp_lower, 0);
    assert.equal(parsed.temp_combiner, 0);
    assert.equal(parsed.alarm_active, false);
    assert.equal(parsed.fault_code, '');

    // 2K 的下层/合成器温度；波段 10 = 6m。
    const twoK = ampLink.parseSpeStatus(
        '20K,O,T,x,1,10,3a,0r,H,1500, 1.20, 1.30, 49.0, 35.0, 50, 38, 41,N,N');
    assert.equal(twoK.band, '6m');
    assert.equal(twoK.temp_lower, 38);
    assert.equal(twoK.temp_combiner, 41);

    // 报警与告警都要标出来。
    const faulted = ampLink.parseSpeStatus(
        '13K,O,T,A,1,05,2a,0r,H,1204, 1.10, 1.25, 48.0, 32.5, 45,  0,  0,S,A');
    assert.equal(faulted.alarm_active, true);
    assert.equal(faulted.fault_code, 'WS AA');

    // 兼容最前面多一个逗号的固件；字段不足则拒绝。
    const leading = ampLink.parseSpeStatus(
        ',13K,S,R,A,1,00,1a,0r,L,0000, 0.00, 0.00, 0.0, 0.0, 33,  0,  0,N,N');
    assert.equal(leading.operating, 0);
    assert.equal(leading.out_fwd_power, 0);
    assert.equal(ampLink.parseSpeStatus('13K,S,R'), null);

    // 流式解析：垃圾前缀 + 分两次到达；坏校验整帧丢弃。
    const state = {buffer: Buffer.alloc(0), amp: {out_fwd_power: null}};
    const frame = speFrame('13K,O,T,A,1,05,2a,0r,H,1204, 1.10, 1.25, 48.0, 32.5, 45,  0,  0,N,N');
    const broken = Buffer.from(frame);
    broken[broken.length - 4] = (broken[broken.length - 4] + 1) & 0xff;
    assert.equal(ampLink.feedSpe(state, Buffer.concat([Buffer.from([0x00, 0xaa]), broken])), false);
    assert.equal(state.amp.out_fwd_power, null);
    assert.equal(ampLink.feedSpe(state, frame.slice(0, 30)), false);
    assert.equal(ampLink.feedSpe(state, frame.slice(30)), true);
    assert.equal(state.amp.out_fwd_power, 1204);
    assert.equal(state.amp.out_swr, 1.25);
});

test('SPE Expert：串口只读轮询与动作拒绝', async () => {
    ampLink.resetForTests();
    let socket = null;
    ampLink.setSocketFactory(() => { socket = new AcomSocket(); return socket; });
    const globalCtx = makeContext();
    const spe = storage.devices.toDevice(deviceRow({
        id: 'spe-1', name: 'Expert 1.3K-FA', type: 'amp', bands: '',
        config_json: JSON.stringify({
            brand: 'spe', model: 'expert-13k', protocol: 'serial', host: '10.0.0.8', port: 4004
        })
    }));
    ampLink.pollAmps(globalCtx, [spe], new Date(), {devices: [spe], links: []});
    assert.ok(socket, 'SPE 型号必须建立串口链路');
    socket.emit('connect');
    assert.equal(socket.writes.length, 1);
    assert.deepEqual([...socket.writes[0]], ampLink.SPE_STATUS_REQUEST);

    // 状态串到达后上卡；SPE 是请求/应答，不额外写 ACK。
    socket.emit('data', speFrame(
        '13K,O,T,A,1,05,2a,0r,H,1204, 1.10, 1.25, 48.0, 32.5, 45,  0,  0,N,N'));
    const entry = runtime.stateOf(globalCtx, 'spe-1');
    assert.equal(entry.amp_connected, true);
    assert.equal(entry.amp.operating, 1);
    assert.equal(entry.amp.transmitting, 1);
    assert.equal(entry.amp.out_fwd_power, 1204);
    assert.equal(entry.amp.out_swr, 1.25);
    assert.equal(entry.amp.current_temperature, 45);
    assert.equal(entry.amp.band, '20m');
    assert.equal(socket.writes.length, 1);

    // 只读阶段：动作与 MQTT 字段都拒绝。
    const denied = await ampLink.publish(spe, {action: 'operate'}, new Date(), globalCtx);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 400);
    fakeTransports();
    const row = deviceRow({
        id: 'spe-1', name: 'Expert 1.3K-FA', type: 'amp', bands: '',
        config_json: JSON.stringify({brand: 'spe', model: 'expert-13k', protocol: 'serial'})
    });
    const result = await service.handleCommand(globalCtx, [row], 'spe-1',
        {command: 'amp_set', args: {action: 'operate'}}, {'X-DX-Seat': 'OP-A'}, new Date());
    assert.equal(result.status, 400);
    ampLink.resetForTests();
});

test('RF-Kit RF2K-S：只读 /info 身份与版本', async () => {
    const definition = ampModels.resolve('rfkit', 'rf2k-s');
    assert.ok(definition, 'RF2K-S definition must exist');
    assert.equal(definition.supported, true);
    assert.equal(definition.protocol, 'http');
    assert.equal(definition.transport, 'rfkit-http');
    assert.deepEqual(definition.controls, []);
    assert.equal(definition.fields.find(field => field.key === 'port').default, 8080);
    assert.ok(definition.status.some(item => item.key === 'device_name'));
    assert.equal(ampModels.transportOf({brand: 'rfkit', model: 'rf2k-s'}), 'rfkit-http');

    const parsed = ampLink.parseRfkitInfo({
        device: 'RF2K-S',
        custom_device_name: 'Shack PA',
        software_version: {GUI: '1.2.3', controller: '4.5.6'}
    });
    assert.deepEqual(parsed, {
        device_name: 'Shack PA', device_model: 'RF2K-S', software_version: '1.2.3 / 4.5.6'
    });
    assert.equal(ampLink.parseRfkitInfo({device: 'RF2K-S'}).device_name, 'RF2K-S');
    assert.equal(ampLink.parseRfkitInfo(null), null);

    // 真实 HTTP 轮询：/info 返回身份，错误时标记通信失败。
    let mode = 'ok';
    const server = require('node:http').createServer((request, response) => {
        if (mode === 'ok' && request.url === '/info') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
                device: 'RF2K-S',
                custom_device_name: 'Shack PA',
                software_version: {GUI: '1.2.3', controller: '4.5.6'}
            }));
            return;
        }
        response.statusCode = 500;
        response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const globalCtx = makeContext();
        const rfkit = storage.devices.toDevice(deviceRow({
            id: 'rfkit-1', name: 'RF2K-S', type: 'amp', bands: '',
            config_json: JSON.stringify({
                brand: 'rfkit', model: 'rf2k-s', protocol: 'http', host: '127.0.0.1', port
            })
        }));
        const waitFor = async predicate => {
            for (let i = 0; i < 40; i += 1) {
                if (predicate()) return true;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return false;
        };
        ampLink.pollAmps(globalCtx, [rfkit], new Date(), {devices: [rfkit], links: []});
        assert.ok(await waitFor(() => {
            const current = runtime.stateOf(globalCtx, 'rfkit-1');
            return !!current && current.amp_connected === true;
        }), 'RF2K-S /info must mark the amp online');
        const entry = runtime.stateOf(globalCtx, 'rfkit-1');
        assert.equal(entry.amp.device_name, 'Shack PA');
        assert.equal(entry.amp.device_model, 'RF2K-S');
        assert.equal(entry.amp.software_version, '1.2.3 / 4.5.6');

        mode = 'error';
        ampLink.pollAmps(globalCtx, [rfkit], new Date(), {devices: [rfkit], links: []});
        assert.ok(await waitFor(() => {
            const current = runtime.stateOf(globalCtx, 'rfkit-1');
            return !!current && current.amp_connected === false;
        }), 'RF2K-S HTTP error must mark the amp offline');
        assert.equal(runtime.stateOf(globalCtx, 'rfkit-1').comm_error, 'transport-connect');

        // 只读：不暴露动作。
        const denied = await ampLink.publish(rfkit, {action: 'operate'}, new Date(), globalCtx);
        assert.equal(denied.ok, false);
        assert.equal(denied.status, 400);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('AMP1000 配置：MQTT 字段白名单与口令隐藏', () => {
    const saved = model.normalizeDevice({
        type: 'amp', name: 'AMP1000',
        config: {
            host: '192.168.1.50', port: 1883, protocol: 'mqtt', device_id: 'AMP1000-1',
            topic_prefix: 'amplifier/device', username: 'dx', password: 'secret'
        }
    }, {devices: []});
    assert.equal(saved.ok, true);
    assert.equal(saved.device.config.protocol, 'mqtt');
    assert.equal(saved.device.config.device_id, 'AMP1000-1');
    const pub = model.publicDevice(saved.device);
    assert.equal(pub.config.password, undefined);
    assert.equal(pub.has_password, true);

    const bad = model.normalizeDevice({type: 'amp', name: 'X', config: {protocol: 'rotctld'}}, {devices: []});
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'invalid-config-protocol');
});

test('功放型号描述表：品牌/型号解析与协议派生', () => {
    const catalog = ampModels.catalog();
    const guohe = catalog.brands.find(brand => brand.id === 'guohe');
    assert.ok(guohe, 'guohe brand must exist');
    assert.ok(catalog.brands.length >= 2, 'brand catalog covers community amplifier brands');
    assert.ok(catalog.brands.some(brand => brand.models.some(item => item.supported === false)),
        'community-only models must be recorded as unsupported');
    const definition = ampModels.resolve('guohe', 'amp1000');
    assert.ok(definition, 'AMP1000 definition must exist');
    assert.equal(definition.protocol, 'mqtt');
    assert.ok(definition.fields.some(field => field.key === 'device_id'));
    assert.ok(definition.controls.some(control => control.delta && control.delta.pa_switch === 1));
    assert.ok(definition.status.some(item => item.key === 'out_fwd_power' && item.unit === 'W'));
    // 未选型号/其他：退回通用定义，不报错。
    assert.equal(ampModels.resolve('guohe', 'other'), null);
    assert.equal(catalog.generic.controls.length, definition.controls.length);

    const saved = model.normalizeDevice({
        type: 'amp', name: 'PA', config: {brand: 'guohe', model: 'amp1000', host: '10.0.0.9'}
    }, {devices: []});
    assert.equal(saved.ok, true);
    assert.equal(saved.device.config.protocol, 'mqtt');

    const unknownBrand = model.normalizeDevice({
        type: 'amp', name: 'PA', config: {brand: 'nope'}
    }, {devices: []});
    assert.equal(unknownBrand.ok, false);
    assert.equal(unknownBrand.error, 'invalid-amp-brand');

    const unknownModel = model.normalizeDevice({
        type: 'amp', name: 'PA', config: {brand: 'guohe', model: 'amp9999'}
    }, {devices: []});
    assert.equal(unknownModel.ok, false);
    assert.equal(unknownModel.error, 'invalid-amp-model');
});

test('功放切换型号保留已配置的地址与凭据', () => {
    const existing = device({
        id: 'amp-1', name: 'PA', type: 'amp',
        config_json: JSON.stringify({
            protocol: 'mqtt', host: '192.168.1.50', port: 1883, device_id: 'AMP1000-1',
            topic_prefix: 'amplifier/device', username: 'dx', password: 'secret'
        })
    });
    // 页面切型号时只提交 brand/model 与该型号显示的字段，其余键不出现。
    const switched = model.normalizeDevice({
        id: 'amp-1', config: {brand: 'guohe', model: 'amp1000', host: '192.168.1.50'}
    }, {devices: [existing]});
    assert.equal(switched.ok, true);
    assert.equal(switched.device.config.device_id, 'AMP1000-1');
    assert.equal(switched.device.config.username, 'dx');
    assert.equal(switched.device.config.password, 'secret');
    assert.equal(switched.device.config.topic_prefix, 'amplifier/device');
    assert.equal(switched.device.config.protocol, 'mqtt');

    // 设备快照把描述表一并下发，页面不需要自己维护一份型号数据。
    const view = service.snapshot(makeContext(), [deviceRow({
        id: 'amp-1', name: 'PA', type: 'amp', bands: '',
        config_json: JSON.stringify(switched.device.config)
    })], new Date());
    assert.equal(view.amp_models.brands[0].models[0].id, 'amp1000');
});
