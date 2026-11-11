'use strict';

/**
 * 设备接入第一阶段的读层服务。
 *
 * 只做三件事：
 *   1. 设备树/天线波段/安装偏移的配置读写（配置本身不是设备写操作）；
 *   2. 只读状态投影：设备在线状态、TX 上报源、席位→天线归属三色、塔二态；
 *   3. 通用 TX / 设备状态上报入口（用户自研装置 → 本项目，只接收不驱动）。
 *
 * 明确不做：任何设备控制指令、自动归属写回、型号/厂商适配。
 */

const storage = require('../storage');
const settingsService = require('../settings/service.js');
const model = require('./model.js');
const ownership = require('./ownership.js');
const runtime = require('./runtime.js');
const tower = require('./tower.js');
const tx = require('./tx.js');
const commands = require('./commands.js');

const DEVICE_REPORT_TIMEOUT_MS = 10000;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function asRows(rows) {
    return Array.isArray(rows) ? rows : [];
}

function splitRows(rows) {
    const devices = [];
    const sources = [];
    for (const row of asRows(rows)) {
        if (!row || typeof row !== 'object') continue;
        const kind = String(row.kind === undefined || row.kind === null ? 'device' : row.kind).toLowerCase();
        if (kind === 'tx') sources.push(storage.devices.toTxSource(row));
        else devices.push(storage.devices.toDevice(row));
    }
    return {devices, sources};
}

function nowDate(value) {
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
}

function deviceStatus(entry, nowMs) {
    if (!entry || !Number.isFinite(entry.last_report_ms)) {
        return {state: 'unknown', online: false, last_report: null, age_ms: null};
    }
    const age = Math.max(0, nowMs - entry.last_report_ms);
    return {
        state: age <= DEVICE_REPORT_TIMEOUT_MS ? 'online' : 'offline',
        online: age <= DEVICE_REPORT_TIMEOUT_MS,
        last_report: entry.last_report || null,
        age_ms: age
    };
}

function rotatorView(device, entry, nowMs) {
    if (!entry) {
        return {
            state: 'unknown',
            physical_azimuth: null,
            target_azimuth: null,
            last_report: null,
            age_ms: null
        };
    }
    const status = deviceStatus(entry, nowMs);
    const physical = Number.isFinite(entry.azimuth) ? entry.azimuth : null;
    const target = Number.isFinite(entry.target_azimuth) ? entry.target_azimuth : null;
    let motion = 'unknown';
    if (entry.moving) motion = 'moving';
    else if (physical !== null && target !== null) {
        motion = model.normalizeAngle(physical) === model.normalizeAngle(target) ? 'settled' : 'unknown';
    }
    return {
        state: status.state,
        physical_azimuth: physical,
        target_azimuth: target,
        motion_state: motion,
        last_commander: entry.last_commander || null,
        last_report: status.last_report,
        age_ms: status.age_ms
    };
}

function deviceConfig(global) {
    const settings = settingsService.runtime(global);
    return {
        limit_switch_type: settings.towerLimitType === 'NC' ? 'NC' : tower.DEFAULT_LIMIT_SWITCH_TYPE,
        pulse_width_ms: Number.isFinite(Number(settings.towerPulseWidthMs))
            ? Number(settings.towerPulseWidthMs) : 400,
        seat_heartbeat_timeout_ms: ownership.SEAT_HEARTBEAT_TIMEOUT_MS,
        device_report_timeout_ms: DEVICE_REPORT_TIMEOUT_MS,
        tx_source_timeout_ms: tx.DEFAULT_TIMEOUT_MS
    };
}

function snapshot(global, rows, now) {
    const at = nowDate(now);
    const nowMs = at.getTime();
    const {devices, sources} = splitRows(rows);
    const entries = runtime.read(global);
    const leases = runtime.pruneLeases(global, nowMs);
    const config = deviceConfig(global);

    const statuses = {};
    const towers = {};
    const rotators = {};
    const controls = {};
    const rotatorAzimuths = {};
    for (const device of devices) {
        const entry = entries[device.id] || null;
        statuses[device.id] = deviceStatus(entry, nowMs);
        const lease = leases[device.id] || null;
        controls[device.id] = {
            lease: lease ? {seat: lease.seat, expires_ms: lease.expires_ms} : null,
            last_commander: (entry && entry.last_commander) || null,
            last_command: (entry && entry.last_command) || null,
            last_command_id: (entry && entry.last_command_id) || null,
            target_azimuth: entry && Number.isFinite(entry.target_azimuth) ? entry.target_azimuth : null,
            ports: (entry && entry.ports) || null,
            tower_direction: (entry && entry.tower_direction) || null
        };
        if (device.type === 'rotator') {
            rotators[device.id] = rotatorView(device, entry, nowMs);
            // 旋转器离线后不再把旧角度当作当前位置传给天线。
            if (statuses[device.id].online && Number.isFinite(entry && entry.azimuth)) {
                rotatorAzimuths[device.id] = entry.azimuth;
            }
        } else if (device.type === 'tower') {
            towers[device.id] = tower.resolve({
                device,
                entry,
                now: at,
                limitSwitchType: config.limit_switch_type,
                offlineTimeoutMs: DEVICE_REPORT_TIMEOUT_MS
            });
        }
    }

    const radioStates = (global && typeof global.get === 'function' ? global.get('radioStates') : null) || {};
    const ownershipView = ownership.project({
        devices,
        radioStates,
        now: at,
        heartbeatTimeoutMs: config.seat_heartbeat_timeout_ms,
        rotatorAzimuths
    });

    return {
        ok: true,
        server_ts: at.toISOString(),
        config,
        devices: devices.map(model.publicDevice),
        tree: model.buildTree(devices),
        status: statuses,
        towers,
        rotators,
        controls,
        ownership: ownershipView,
        tx: tx.snapshot(global, sources, at)
    };
}

function publicSource(source) {
    return {
        source_id: source.source_id,
        name: source.name || source.source_id,
        priority: source.priority,
        timeout_ms: source.timeout_ms,
        enabled: source.enabled !== false,
        has_token: !!source.token,
        created_ts: source.created_ts || null,
        updated_ts: source.updated_ts || null
    };
}

function normalizeSource(input, existing, now) {
    const body = input && typeof input === 'object' ? input : {};
    const id = String(body.source_id === undefined && existing ? existing.source_id : body.source_id || '')
        .trim();
    if (!id) return {ok: false, status: 400, error: 'source-id-required'};
    if (!SOURCE_ID_PATTERN.test(id)) return {ok: false, status: 400, error: 'invalid-source-id'};

    const name = String(body.name === undefined && existing
        ? existing.name : body.name || id).trim().slice(0, tx.MAX_NAME) || id;

    const priorityRaw = body.priority === undefined && existing ? existing.priority : body.priority;
    const priority = priorityRaw === undefined || priorityRaw === null || priorityRaw === ''
        ? 100 : Number(priorityRaw);
    if (!Number.isFinite(priority) || !Number.isInteger(priority) || priority < 0 || priority > 10000) {
        return {ok: false, status: 400, error: 'invalid-priority'};
    }

    const timeoutRaw = body.timeout_ms === undefined && existing ? existing.timeout_ms : body.timeout_ms;
    const timeoutMs = timeoutRaw === undefined || timeoutRaw === null || timeoutRaw === ''
        ? tx.DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) ||
        timeoutMs < 100 || timeoutMs > 60000) {
        return {ok: false, status: 400, error: 'invalid-timeout'};
    }

    let token = existing ? existing.token || '' : '';
    if (Object.prototype.hasOwnProperty.call(body, 'token')) {
        token = String(body.token === undefined || body.token === null ? '' : body.token)
            .slice(0, tx.MAX_TOKEN);
    }

    const enabledRaw = body.enabled === undefined && existing ? existing.enabled : body.enabled;
    const enabled = enabledRaw === undefined || enabledRaw === null ? true : enabledRaw !== false;

    const iso = nowDate(now).toISOString();
    return {
        ok: true,
        created: !existing,
        source: {
            source_id: id,
            name,
            priority,
            timeout_ms: timeoutMs,
            token,
            enabled,
            created_ts: existing ? existing.created_ts || iso : iso,
            updated_ts: iso
        }
    };
}

function validateReport(device, body) {
    if (body.online !== undefined && typeof body.online !== 'boolean') {
        return {ok: false, error: 'invalid-online'};
    }
    if (body.seq !== undefined && body.seq !== null && !Number.isFinite(Number(body.seq))) {
        return {ok: false, error: 'invalid-seq'};
    }
    if (body.tower !== undefined) {
        if (!body.tower || typeof body.tower !== 'object' || Array.isArray(body.tower)) {
            return {ok: false, error: 'invalid-tower-payload'};
        }
        for (const key of ['limit_top', 'limit_bottom', 'moving']) {
            if (body.tower[key] !== undefined && typeof body.tower[key] !== 'boolean') {
                return {ok: false, error: 'invalid-tower-' + key.replace('_', '-')};
            }
        }
    }
    for (const key of ['azimuth', 'target_azimuth']) {
        const value = body[key];
        if (value === undefined || value === null) continue;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 360) return {ok: false, error: 'invalid-' + key};
    }
    if (body.port !== undefined && body.port !== null && typeof body.port !== 'string') {
        return {ok: false, error: 'invalid-port'};
    }
    if (device && device.type === 'tower' && body.tower === undefined && body.moving === undefined) {
        return {ok: true};
    }
    return {ok: true};
}

function fail(status, error, detail) {
    return {
        status,
        payload: {ok: false, error, detail: detail || ''},
        sql: [],
        broadcast: null
    };
}

/**
 * POST /api/devices 的统一分发：配置增删改、TX 源配置、设备遥测上报。
 * 返回 sql 由 flow 的 sqlite 节点执行；响应体与广播消息分开返回。
 */
function handle(global, rows, body, now) {
    const at = nowDate(now);
    const {devices, sources} = splitRows(rows);
    const input = body && typeof body === 'object' ? body : {};
    const action = String(input.action || '').trim().toLowerCase();

    if (action === 'save') {
        const result = model.normalizeDevice(input.device, {devices, now: at});
        if (!result.ok) return fail(result.status, result.error, result.detail);
        const sql = [result.created
            ? storage.devices.insertDevice(result.device)
            : storage.devices.updateDevice(result.device)];
        const previous = devices.find(device => device.id === result.device.id);
        if (previous && previous.type !== result.device.type) runtime.clear(global, result.device.id);
        return {
            status: result.created ? 201 : 200,
            payload: {ok: true, created: result.created, device: model.publicDevice(result.device)},
            sql,
            broadcast: {type: 'devices', action: 'save', id: result.device.id}
        };
    }

    if (action === 'delete') {
        const id = String(input.id || '').trim();
        if (!id) return fail(400, 'id-required');
        const guard = model.deleteBlockReason(devices, id);
        if (!guard.ok) return fail(guard.status, guard.error, guard.detail);
        runtime.clear(global, id);
        return {
            status: 200,
            payload: {ok: true, deleted: id},
            sql: [storage.devices.deleteDevice(id)],
            broadcast: {type: 'devices', action: 'delete', id}
        };
    }

    if (action === 'tx-source') {
        const existing = sources.find(source => source.source_id === String(
            (input.source && input.source.source_id) || input.source_id || ''
        ).trim()) || null;
        const result = normalizeSource(input.source || input, existing, at);
        if (!result.ok) return fail(result.status, result.error);
        const sql = [result.created
            ? storage.devices.insertTxSource(result.source)
            : storage.devices.updateTxSource(result.source)];
        return {
            status: result.created ? 201 : 200,
            payload: {ok: true, created: result.created, source: publicSource(result.source)},
            sql,
            broadcast: {type: 'devices', action: 'tx-source', source_id: result.source.source_id}
        };
    }

    if (action === 'tx-source-delete') {
        const id = String(input.id || input.source_id || '').trim();
        if (!id) return fail(400, 'source-id-required');
        if (!sources.some(source => source.source_id === id)) return fail(404, 'unknown-source');
        tx.forget(global, id);
        return {
            status: 200,
            payload: {ok: true, deleted: id},
            sql: [storage.devices.deleteTxSource(id)],
            broadcast: {type: 'devices', action: 'tx-source-delete', source_id: id}
        };
    }

    if (action === 'report') {
        const id = String(input.device_id || '').trim();
        if (!id) return fail(400, 'device-id-required');
        const device = devices.find(item => item.id === id);
        if (!device) return fail(404, 'unknown-device');
        if (!device.enabled) return fail(409, 'device-disabled');
        const check = validateReport(device, input);
        if (!check.ok) return fail(400, check.error);
        const previous = runtime.stateOf(global, id);
        const seq = input.seq === undefined || input.seq === null ? null : Number(input.seq);
        if (seq !== null && previous && Number.isFinite(previous.seq) && seq <= previous.seq) {
            return {
                status: 200,
                payload: {ok: true, ignored: 'stale-seq', device_id: id, last_seq: previous.seq},
                sql: [],
                broadcast: null
            };
        }
        const entry = runtime.record(global, id, input, at);
        return {
            status: 200,
            payload: {
                ok: true,
                device_id: id,
                status: deviceStatus(entry, at.getTime()).state,
                last_report: entry.last_report
            },
            sql: [],
            broadcast: null
        };
    }

    return fail(400, 'unknown-action', action);
}

/** TX 上报入口：校验、记录、未知源自动登记（低优先级，后续可改）。 */
function ingestTx(global, sources, body, headers, now) {
    const result = tx.ingest(global, sources, body, headers, now);
    const sql = result.newSource ? [storage.devices.insertTxSourceIfMissing(result.newSource)] : [];
    return {status: result.status, payload: result.payload, sql, broadcast: null};
}

/** 统一指令入口：鉴权、租约、幂等、审计与 transport 下发。 */
function handleCommand(global, rows, deviceId, body, headers, now) {
    const {devices, sources} = splitRows(rows);
    return commands.execute({global, devices, sources, deviceId, body, headers, now});
}

/**
 * 旋转器指令去重的判定入口（本阶段没有写指令，供后续阶段直接复用）：
 * 新目标角度与“当前目标角度”相同即丢弃，360 与 0 视为同一角度。
 */
function duplicateTarget(global, deviceId, angle) {
    const entry = runtime.stateOf(global, deviceId);
    const current = entry && entry.target_azimuth;
    if (current === undefined || current === null) return false;
    const a = model.normalizeAngle(current);
    const b = model.normalizeAngle(angle);
    return a !== null && b !== null && a === b;
}

module.exports = {
    DEVICE_REPORT_TIMEOUT_MS,
    SOURCE_ID_PATTERN,
    splitRows,
    deviceStatus,
    deviceConfig,
    snapshot,
    publicSource,
    normalizeSource,
    handle,
    handleCommand,
    ingestTx,
    duplicateTarget,
    commands
};
