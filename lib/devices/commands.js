'use strict';

/**
 * 指令骨架：唯一写入口。
 *
 * 负责身份校验、设备租约、按角度幂等、审计与广播；具体下发交给
 * 可插拔 transport（Phase 3 旋转器、Phase 4 切换器、Phase 5 塔）。
 * 本阶段没有 transport 时返回 accepted + dispatched:false，不产生物理输出。
 */

const storage = require('../storage');
const model = require('./model.js');
const rf = require('./rf.js');
const runtime = require('./runtime.js');
const tx = require('./tx.js');

const LEASE_MS = runtime.LEASE_MS;
const SEAT_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const MAX_ARG_TEXT = 32;
/** 每条指令只对特定设备类型有意义，其余类型直接拒绝。 */
const COMMAND_TYPES = {
    rotate: ['rotator'],
    stop: ['rotator'],
    select: ['matrix', 'switch'],
    tower_hold: ['tower'],
    tower_release: ['tower'],
    tower_stop: ['tower']
};

let counter = 0;
let transports = {};

function setTransports(next) {
    transports = Object.assign({}, transports, next || {});
}

function resetForTests() {
    counter = 0;
    transports = {};
}

function headerValue(headers, name) {
    const source = headers || {};
    const want = String(name).toLowerCase();
    for (const key of Object.keys(source)) {
        if (String(key).toLowerCase() === want) {
            const value = source[key];
            return String(value === undefined || value === null ? '' : value);
        }
    }
    return '';
}

function parseSeat(headers) {
    const raw = headerValue(headers, 'x-dx-seat').trim();
    return SEAT_PATTERN.test(raw) ? raw : '';
}

function parseOperator(headers) {
    return headerValue(headers, 'x-dx-operator').trim().slice(0, 40);
}

function parseIp(headers) {
    const forwarded = headerValue(headers, 'x-forwarded-for').split(',')[0].trim();
    const value = forwarded || headerValue(headers, 'x-real-ip');
    return value.slice(0, 64);
}

function nextCommandId(nowMs) {
    counter = (counter + 1) % 100000;
    return 'cmd-' + nowMs.toString(36) + '-' + counter.toString(36);
}

function textArg(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    return text && text.length <= MAX_ARG_TEXT ? text : '';
}

function respond(context, options) {
    const sql = [storage.devices.insertCommandAudit({
        ts: context.at.toISOString(),
        device_id: context.deviceId,
        seat: context.seat,
        operator: context.operator,
        command: context.command,
        args: JSON.stringify(context.args || {}),
        result: options.result,
        error: options.error || '',
        ip: context.ip
    })];
    const payload = Object.assign({
        ok: options.result === 'accepted' || options.result === 'duplicate',
        command_id: context.commandId || null
    }, options.payload || {});
    if (options.error) payload.error = options.error;
    return {
        status: options.status,
        payload,
        sql,
        broadcast: options.broadcast || null
    };
}

function reject(context, status, error, extra) {
    return respond(context, {
        status,
        result: error === 'tx-active' ? 'rejected_tx' : 'rejected',
        error,
        payload: Object.assign({duplicate: false}, extra || {}),
        broadcast: {
            type: 'deviceCommand',
            action: 'rejected',
            device_id: context.deviceId,
            command: context.command,
            seat: context.seat,
            error
        }
    });
}

function channelFor(device, port, outlet) {
    const channels = (device.config && device.config.channels) || {};
    const byPair = channels[port + ':' + outlet];
    if (byPair !== undefined) return byPair;
    const byOutlet = channels[outlet];
    return byOutlet === undefined ? null : byOutlet;
}

function towerChannel(device, direction) {
    const config = device.config || {};
    const channel = direction === 'up' ? config.up_channel : config.down_channel;
    return Number.isInteger(channel) ? channel : null;
}

async function dispatch(kind, payload) {
    const fn = transports[kind];
    if (typeof fn !== 'function') return {ok: true, dispatched: false};
    try {
        const result = await fn(payload);
        if (result && result.ok === false) {
            return {ok: false, status: result.status || 502, error: result.error || 'transport-error'};
        }
        // 心跳续期等场景 transport 会明确回报“没有产生新的物理输出”。
        const dispatched = result && result.dispatched === false ? false : true;
        return {ok: true, dispatched, detail: result && result.detail};
    } catch (error) {
        return {ok: false, status: 502, error: 'transport-error', detail: String(error && error.message || error)};
    }
}

/** 取当前所有“可用且正在发射”的源；未绑定设备的旧源仍按全局互锁处理。 */
function activeTxSources(globalCtx, sources, at) {
    const snapshot = tx.snapshot(globalCtx, sources, at);
    return snapshot.sources.filter(source =>
        source.enabled && source.health === 'ok' && source.tx_active === true);
}

function selectionsOf(globalCtx) {
    const entries = runtime.read(globalCtx);
    const selections = {};
    for (const id of Object.keys(entries)) {
        const ports = entries[id] && entries[id].ports;
        if (ports && typeof ports === 'object') selections[id] = ports;
    }
    return selections;
}

/**
 * 互锁只锁这条 TX 链路上的天线切换动作。
 * 源绑定到设备实例时按 RF 链路反查端口；未绑定的旧源保持全局互锁。
 */
function interlockBlock(context, devices, links, active, port) {
    if (!active.length) return null;
    const selections = selectionsOf(context.global);
    for (const source of active) {
        if (!source.device_id) return {source, scope: 'global'};
        const lock = rf.txLockPorts({
            devices,
            links,
            selections,
            sourceDeviceId: source.device_id
        });
        if (!lock.devices.has(context.deviceId)) continue;
        const ports = lock.ports.get(context.deviceId);
        if (!ports || !ports.size || ports.has(port)) return {source, scope: 'path'};
    }
    return null;
}

function leaseFor(context) {
    const result = runtime.acquireLease(context.global, context.deviceId, context.seat, context.at.getTime(), LEASE_MS);
    if (!result.ok) {
        return {
            ok: false,
            response: reject(context, 409, 'device-locked', {
                owner: result.owner,
                lease_expires_ms: result.expires_ms
            })
        };
    }
    return {ok: true};
}

/**
 * @param {object} input
 * @param {object} input.global
 * @param {Array} input.devices
 * @param {Array} input.sources
 * @param {string} input.deviceId
 * @param {object} input.body
 * @param {object} input.headers
 * @param {Date} [input.now]
 */
async function execute(input) {
    const opts = input || {};
    const at = opts.now instanceof Date ? opts.now : new Date(opts.now === undefined ? Date.now() : opts.now);
    const nowMs = at.getTime();
    const globalCtx = opts.global;
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const sources = Array.isArray(opts.sources) ? opts.sources : [];
    const links = Array.isArray(opts.links) ? opts.links : [];
    const deviceId = String(opts.deviceId || '').trim();
    const body = opts.body && typeof opts.body === 'object' ? opts.body : {};
    const headers = opts.headers || {};
    const seat = parseSeat(headers);
    const command = String(body.command || '').trim().toLowerCase();
    const commandId = nextCommandId(nowMs);
    const context = {
        global: globalCtx,
        at,
        deviceId,
        seat,
        operator: parseOperator(headers),
        command,
        args: body.args && typeof body.args === 'object' ? body.args : body,
        ip: parseIp(headers),
        commandId
    };

    const device = devices.find(item => item.id === deviceId);
    if (!device) return reject(context, 404, 'unknown-device');
    if (!device.enabled) return reject(context, 409, 'device-disabled');
    if (!seat) return reject(context, 401, 'seat-required');

    const allowedTypes = COMMAND_TYPES[command];
    if (allowedTypes && !allowedTypes.includes(device.type)) {
        return reject(context, 400, 'invalid-device-type');
    }

    const runtimeEntry = runtime.stateOf(globalCtx, deviceId);

    if (command === 'rotate') {
        const azimuth = Number(body.azimuth !== undefined ? body.azimuth : (body.args && body.args.azimuth));
        if (!Number.isFinite(azimuth) || azimuth < 0 || azimuth > 360) {
            return reject(context, 400, 'invalid-azimuth');
        }
        const target = model.normalizeAngle(azimuth);
        if (target === null) return reject(context, 400, 'invalid-azimuth');

        const lease = leaseFor(context);
        if (!lease.ok) return lease.response;

        const currentTarget = runtimeEntry && runtimeEntry.target_azimuth !== undefined
            && runtimeEntry.target_azimuth !== null
            ? model.normalizeAngle(runtimeEntry.target_azimuth) : null;
        if (currentTarget !== null && currentTarget === target) {
            context.commandId = runtimeEntry.last_command_id || commandId;
            return respond(context, {
                status: 200,
                result: 'duplicate',
                payload: {
                    duplicate: true,
                    command_id: context.commandId,
                    target_azimuth: target
                },
                broadcast: {
                    type: 'deviceCommand',
                    action: 'duplicate',
                    device_id: deviceId,
                    command,
                    seat,
                    command_id: context.commandId,
                    target_azimuth: target
                }
            });
        }

        const sent = await dispatch('rotate', {
            global: globalCtx,
            device,
            seat,
            commandId,
            azimuth: target,
            now: at
        });
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});

        runtime.updateEntry(globalCtx, deviceId, {
            target_azimuth: target,
            last_commander: seat,
            last_command: 'rotate',
            last_command_id: commandId,
            last_command_ms: nowMs
        }, at);

        return respond(context, {
            status: 202,
            result: 'accepted',
            payload: {
                duplicate: false,
                command_id: commandId,
                dispatched: sent.dispatched,
                target_azimuth: target
            },
            broadcast: {
                type: 'deviceCommand',
                action: 'accepted',
                device_id: deviceId,
                command,
                seat,
                command_id: commandId,
                target_azimuth: target,
                dispatched: sent.dispatched
            }
        });
    }

    if (command === 'stop') {
        const sent = await dispatch('stop', {global: globalCtx, device, seat, commandId, now: at});
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});
        runtime.updateEntry(globalCtx, deviceId, {
            target_azimuth: null,
            moving: false,
            last_commander: seat,
            last_command: 'stop',
            last_command_id: commandId,
            last_command_ms: nowMs
        }, at);
        return respond(context, {
            status: 202,
            result: 'accepted',
            payload: {duplicate: false, command_id: commandId, dispatched: sent.dispatched},
            broadcast: {
                type: 'deviceCommand',
                action: 'accepted',
                device_id: deviceId,
                command,
                seat,
                command_id: commandId,
                dispatched: sent.dispatched
            }
        });
    }

    if (command === 'select') {
        const port = textArg(body.port !== undefined ? body.port : (body.args && body.args.port));
        const outlet = textArg(body.outlet !== undefined ? body.outlet : (body.args && body.args.outlet));
        if (!port) return reject(context, 400, 'invalid-port');
        if (!outlet) return reject(context, 400, 'invalid-outlet');
        // 端口必须真实存在且方向正确：切换器 in→antN，矩阵 inN→outM。
        const portDef = rf.findPort(device, port);
        const outletDef = rf.findPort(device, outlet);
        if (!portDef || !outletDef) return reject(context, 400, 'unknown-port');
        if (portDef.role !== 'in' || outletDef.role !== 'out') {
            return reject(context, 400, 'invalid-direction');
        }
        const channel = channelFor(device, port, outlet);
        if (channel === null) return reject(context, 400, 'unknown-channel');

        const interlockEnabled = tx.selectSource(globalCtx, sources, at).available;
        const active = activeTxSources(globalCtx, sources, at);
        const blocked = interlockBlock(context, devices, links, active, port);
        if (blocked) {
            return reject(context, 423, 'tx-active', {
                interlock: 'tx-active',
                scope: blocked.scope,
                source_id: blocked.source ? blocked.source.source_id : null
            });
        }

        const lease = leaseFor(context);
        if (!lease.ok) return lease.response;

        const sent = await dispatch('select', {
            global: globalCtx,
            device,
            seat,
            commandId,
            port,
            outlet,
            channel,
            pulseMs: device.config && device.config.pulse_ms,
            now: at
        });
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});

        const ports = Object.assign({}, runtimeEntry && runtimeEntry.ports, {[port]: outlet});
        runtime.updateEntry(globalCtx, deviceId, {
            ports,
            last_commander: seat,
            last_command: 'select',
            last_command_id: commandId,
            last_command_ms: nowMs
        }, at);

        return respond(context, {
            status: 202,
            result: 'accepted',
            payload: {
                duplicate: false,
                command_id: commandId,
                dispatched: sent.dispatched,
                port,
                outlet,
                channel,
                interlock: interlockEnabled ? 'enabled' : 'not-enabled'
            },
            broadcast: {
                type: 'deviceCommand',
                action: 'accepted',
                device_id: deviceId,
                command,
                seat,
                command_id: commandId,
                port,
                outlet,
                interlock: interlockEnabled ? 'enabled' : 'not-enabled'
            }
        });
    }

    if (command === 'tower_hold') {
        const direction = String(body.direction || '').trim().toLowerCase();
        if (direction !== 'up' && direction !== 'down') return reject(context, 400, 'invalid-direction');
        const channel = towerChannel(device, direction);
        if (channel === null) return reject(context, 400, 'unknown-channel');

        const lease = leaseFor(context);
        if (!lease.ok) return lease.response;

        const sent = await dispatch('towerHold', {
            global: globalCtx,
            device,
            seat,
            commandId,
            direction,
            channel,
            now: at
        });
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});

        runtime.updateEntry(globalCtx, deviceId, {
            tower_direction: direction,
            last_commander: seat,
            last_command: 'tower_hold',
            last_command_id: commandId,
            last_command_ms: nowMs
        }, at);

        return respond(context, {
            status: 202,
            result: 'accepted',
            payload: {duplicate: false, command_id: commandId, dispatched: sent.dispatched, direction},
            broadcast: {
                type: 'deviceCommand',
                action: 'accepted',
                device_id: deviceId,
                command,
                seat,
                command_id: commandId,
                direction,
                dispatched: sent.dispatched
            }
        });
    }

    if (command === 'tower_release' || command === 'tower_stop') {
        const sent = await dispatch('towerRelease', {global: globalCtx, device, seat, commandId, now: at});
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});
        runtime.updateEntry(globalCtx, deviceId, {
            tower_direction: null,
            moving: false,
            last_commander: seat,
            last_command: 'tower_release',
            last_command_id: commandId,
            last_command_ms: nowMs
        }, at);
        return respond(context, {
            status: 202,
            result: 'accepted',
            payload: {duplicate: false, command_id: commandId, dispatched: sent.dispatched},
            broadcast: {
                type: 'deviceCommand',
                action: 'accepted',
                device_id: deviceId,
                command: 'tower_release',
                seat,
                command_id: commandId,
                dispatched: sent.dispatched
            }
        });
    }

    return reject(context, 400, 'unknown-command');
}

module.exports = {
    LEASE_MS,
    SEAT_PATTERN,
    setTransports,
    resetForTests,
    parseSeat,
    parseIp,
    nextCommandId,
    channelFor,
    towerChannel,
    execute
};
