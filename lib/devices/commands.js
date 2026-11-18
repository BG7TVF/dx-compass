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
const rotatorModels = require('./rotator-models.js');
const ownership = require('./ownership.js');

/** 停止/到位后的静默期：给桅杆与刹车留出稳定时间，再放行新方向。 */
const ROTATOR_SETTLE_MS = 2000;

function angleDelta(a, b) {
    const delta = Math.abs(Number(a) - Number(b));
    return Math.min(delta, 360 - delta);
}

/**
 * 换向前必须先停止：运动中的旋转器拒绝新方向，操作员要先发 stop；
 * stop 或到位后 2 秒内仍然拒绝，避免刹车/桅杆尚未稳定就反向。
 */
function rotatorBlock(entry, device, nowMs) {
    if (!entry) return null;
    const commanded = Number(entry.last_command_ms);
    const travelMs = (Number(device && device.travel_timeout_sec) || 120) * 1000;
    const withinTravel = !Number.isFinite(commanded) || nowMs - commanded <= travelMs;
    const physical = Number.isFinite(entry.azimuth) ? entry.azimuth : null;
    const target = Number.isFinite(entry.target_azimuth) ? entry.target_azimuth : null;
    const moving = entry.moving === true ||
        (target !== null && physical !== null && angleDelta(physical, target) > 1 && withinTravel);
    if (moving && withinTravel) return 'rotator-moving';
    if (Number.isFinite(Number(entry.arrived_ms)) && nowMs - Number(entry.arrived_ms) < ROTATOR_SETTLE_MS) {
        return 'rotator-settling';
    }
    if (entry.last_command === 'stop' && Number.isFinite(commanded) &&
        nowMs - commanded < ROTATOR_SETTLE_MS) {
        return 'rotator-settling';
    }
    return null;
}

const LEASE_MS = runtime.LEASE_MS;
const SEAT_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
const MAX_ARG_TEXT = 32;
/** 每条指令只对特定设备类型有意义，其余类型直接拒绝。 */
const COMMAND_TYPES = {
    rotate: ['rotator'],
    stop: ['rotator'],
    select: ['matrix', 'switch'],
    // 天线切换：目标是天线，由服务端反推链路上要拨的切换器。
    route: ['antenna'],
    tower_hold: ['tower'],
    tower_release: ['tower'],
    tower_stop: ['tower'],
    amp_set: ['amp']
};

const ampModels = require('./amp-models.js');
const switchModels = require('./switch-models.js');

/**
 * 功放常规操作白名单（国赫 AMP1000 remote_control delta）。
 * 刻意不含 §5.9 工程参数/保护阈值/校准写入字段：校准数据不允许远程改动。
 */
const AMP_FIELD_CHECKS = {
    pa_switch: value => [0, 1].includes(Number(value)),
    tune_mode: value => [0, 1].includes(Number(value)),
    trigger_mode: value => [0, 1, 3].includes(Number(value)),
    work_freq: value => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 1800000 && n <= 1300000000;
    },
    in_antenna_sel: value => [1, 2].includes(Number(value)),
    out_antenna_sel: value => [1, 2, 3, 4].includes(Number(value)),
    attenuator_sel: value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 15,
    freq_band_select: value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 15,
    clear_alarm: value => typeof value === 'boolean'
};
function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

const AMP_IGNORED_ARGS = new Set(['command']);
/** 串口/ASCII 型号只接受这些面板等效动作，具体线命令由型号描述表决定。 */
const AMP_ACTIONS = new Set([
    'power_on', 'power_off', 'operate', 'standby', 'clear_fault', 'autotune',
    'manual_tune', 'tune_step'
]);

/** 只接受白名单字段；出现任何未知字段直接拒绝，避免误下发到设备。 */
function ampDelta(input) {
    const source = input && typeof input === 'object' ? input : {};
    const delta = {};
    for (const key of Object.keys(source)) {
        if (AMP_IGNORED_ARGS.has(key)) continue;
        if (key === 'action') {
            if (!AMP_ACTIONS.has(text(source[key]))) return {ok: false, error: 'invalid-arg'};
            delta.action = text(source[key]);
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(AMP_FIELD_CHECKS, key)) return {ok: false, error: 'invalid-arg'};
        const value = source[key];
        if (!AMP_FIELD_CHECKS[key](value)) return {ok: false, error: 'invalid-arg'};
        delta[key] = key === 'clear_alarm' ? value === true
            : key === 'work_freq' ? Number(value)
            : Number(value);
    }
    if (!Object.keys(delta).length) return {ok: false, error: 'empty-command'};
    return {ok: true, delta};
}

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

/** 型号决定是否需要继电器通道，以及下发后能否声称“已切换”。 */
function switchSemantics(device) {
    const config = (device && device.config) || {};
    const definition = switchModels.resolve(device.type, config.brand, config.model);
    const transport = switchModels.transportOf(config, device.type);
    return {
        definition,
        transport,
        relay: transport === 'relay',
        readback: !!(definition && definition.readback),
        control: !definition || definition.control !== false
    };
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
 * 归属口径的切换器选择：回读确认的通路优先，没有确认时退回已经下发的通路。
 * 必须与快照投影那份同口径——界面显示、占用判定、指令冲突检查用的是同一张图，
 * 否则会出现“按钮显示空闲、服务端却说被谁占着”这种对不上的情况。
 */
function intentSelections(globalCtx) {
    const entries = runtime.read(globalCtx) || {};
    const out = {};
    for (const id of Object.keys(entries)) {
        const sw = entries[id] && entries[id].switch;
        if (!sw || typeof sw !== 'object') continue;
        const verified = sw.state === 'verified' && sw.ports && typeof sw.ports === 'object'
            ? sw.ports : null;
        const commanded = sw.commanded && typeof sw.commanded === 'object' ? sw.commanded : null;
        if (verified || commanded) out[id] = Object.assign({}, commanded, verified);
    }
    return out;
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
    // 控制连线（串口服务器 ↔ 设备）与 RF 连线分开，旋转器等靠它继承地址。
    const controlLinks = Array.isArray(opts.controlLinks) ? opts.controlLinks : [];
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
    // 手动设备由人操作，系统不下发：这是设计约束，不是暂时故障。
    if (device.access_mode === 'manual') return reject(context, 409, 'device-manual');
    if (!seat) return reject(context, 401, 'seat-required');

    const allowedTypes = COMMAND_TYPES[command];
    if (allowedTypes && !allowedTypes.includes(device.type)) {
        return reject(context, 400, 'invalid-device-type');
    }

    // 旋转器动作以型号描述表的 controls 为准；未选型号时用通用定义。
    if (device.type === 'rotator' && (command === 'rotate' || command === 'stop')) {
        const config = device.config || {};
        const definition = rotatorModels.resolve(config.brand, config.model) || rotatorModels.GENERIC;
        const controls = definition.controls || [];
        if (!controls.some(item => item.action === command)) {
            return reject(context, 400, 'invalid-action');
        }
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

        // 转向中屏蔽新方向；stop 或到位后还要等静默期结束。
        const blocked = rotatorBlock(runtimeEntry, device, nowMs);
        if (blocked) return reject(context, 409, blocked);

        const sent = await dispatch('rotate', {
            global: globalCtx,
            device,
            devices,
            links: controlLinks,
            seat,
            commandId,
            azimuth: target,
            now: at
        });
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});

        runtime.updateEntry(globalCtx, deviceId, {
            target_azimuth: target,
            moving: true,
            arrived_ms: null,
            arrived_target: null,
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
        const sent = await dispatch('stop', {
            global: globalCtx,
            device,
            devices,
            links: controlLinks,
            seat,
            commandId,
            now: at
        });
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});
        runtime.updateEntry(globalCtx, deviceId, {
            target_azimuth: null,
            moving: false,
            arrived_ms: null,
            arrived_target: null,
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

    if (command === 'route') {
        /* 天线切换：把本席位的电台接到这副天线上。
         * 界面只交出一个目标天线，中间该拨哪几档由这条同轴走线自己算——
         * 端口名、矩阵路数、共享输入口都不该让操作员背。
         * 判定与界面同口径：通路用“回读确认 ∪ 已下发”，
         * 所以没有读回的矩阵照样切得动，切完邻座立刻看到黄色。 */
        const selections = intentSelections(globalCtx);
        const radioStates = (globalCtx && typeof globalCtx.get === 'function'
            ? globalCtx.get('radioStates') : null) || {};
        const view = ownership.project({
            devices, links, selections, intentSelections: selections, radioStates, now: at
        });
        const mine = view.by_seat[seat];
        if (!mine) return reject(context, 409, 'radio-unbound');
        if (!mine.ant_switch) return reject(context, 409, 'rf-graph-missing');
        if (!mine.ant_switch.reachable.includes(device.id)) {
            return reject(context, 409, 'antenna-unreachable');
        }
        const target = view.antennas.find(item => item.id === device.id) || null;
        const holder = ((target && target.routed_by) || []).find(owner => owner !== seat);
        if (holder) return reject(context, 409, 'antenna-occupied', {owner: holder});

        // 一台席位可能绑了多个电台节点，取第一个真能通到这天线的走线。
        let steps = null;
        for (const radioId of mine.radios) {
            const found = rf.routeToAntenna({
                devices, links, selections, startDeviceId: radioId, antennaId: device.id
            });
            if (found.ok) { steps = found.steps; break; }
        }
        if (!steps) return reject(context, 409, 'antenna-unreachable');

        const applied = [];
        for (const hop of steps) {
            const step = await execute(Object.assign({}, opts, {
                deviceId: hop.device_id,
                body: {command: 'select', port: hop.port, outlet: hop.outlet}
            }));
            // 逐跳的成败看下发响应本身：respond() 只在 accepted/duplicate 时置 ok。
            if (!step.payload || step.payload.ok !== true) {
                // 半途失败不做“回滚”：矩阵已经拨过去的档位不能假设还能倒回去，
                // 把已经生效的档位原样报出来，让操作员知道链路停在哪一台。
                return respond(context, {
                    status: step.status,
                    result: 'rejected',
                    payload: {
                        ok: false,
                        error: (step.payload && step.payload.error) || 'select-failed',
                        failed_device_id: hop.device_id,
                        applied: applied
                    },
                    broadcast: {
                        type: 'deviceCommand',
                        device_id: deviceId,
                        command: 'route',
                        command_id: commandId,
                        ok: false
                    }
                });
            }
            applied.push({
                device_id: hop.device_id, port: hop.port, outlet: hop.outlet, status: step.status
            });
        }
        return respond(context, {
            status: 202,
            result: 'accepted',
            payload: {
                ok: true,
                target_antenna_id: device.id,
                // steps 为空表示这台天线就挂在电台后面，本来就不需要拨任何切换器。
                steps: applied
            },
            broadcast: {
                type: 'deviceCommand',
                device_id: deviceId,
                command: 'route',
                command_id: commandId,
                ok: true
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

        const semantics = switchSemantics(device);
        if (semantics.definition && semantics.definition.supported === false) {
            return reject(context, 501, 'unsupported-switch-model');
        }
        if (!semantics.control) return reject(context, 501, 'unsupported-control');
        const channel = semantics.relay ? channelFor(device, port, outlet) : null;
        if (semantics.relay && channel === null) return reject(context, 400, 'unknown-channel');

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

        const sent = semantics.relay
            ? await dispatch('select', {
                global: globalCtx,
                device,
                seat,
                commandId,
                port,
                outlet,
                channel,
                pulseMs: device.config && device.config.pulse_ms,
                now: at
            })
            : await dispatch('switchSelect', {
                global: globalCtx,
                device,
                devices,
                links: controlLinks,
                seat,
                commandId,
                port,
                outlet,
                now: at
            });
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});

        // 只写型号永远不写 ports；有回读的型号也要等回读确认后才写。
        const state = semantics.readback ? 'pending' : 'unverified';
        const previousSwitch = runtimeEntry && runtimeEntry.switch && typeof runtimeEntry.switch === 'object'
            ? runtimeEntry.switch : {};
        const switchPatch = Object.assign({}, previousSwitch, {
            model: (device.config && device.config.model) || '',
            protocol: semantics.definition ? semantics.definition.protocol : 'relay',
            readback: semantics.readback,
            state,
            stale: false,
            error: null,
            commanded: Object.assign({}, previousSwitch.commanded || {}, {[port]: outlet})
        });

        runtime.updateEntry(globalCtx, deviceId, {
            switch: switchPatch,
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
                verified: false,
                state,
                protocol_verified: sent.protocol_verified !== false,
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
                state,
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

    if (command === 'amp_set') {
        const raw = body.args && typeof body.args === 'object' ? body.args : body;
        const parsed = ampDelta(raw);
        if (!parsed.ok) return reject(context, 400, parsed.error);
        // 型号决定可用动作：串口型号只接受描述表里列出的动作，MQTT 型号不接受动作。
        const ampConfig = (device && device.config) || {};
        const transport = ampModels.transportOf(ampConfig);
        const definition = ampModels.resolve(ampConfig.brand, ampConfig.model);
        const actions = ((definition && definition.controls) || [])
            .map(control => control.delta && control.delta.action)
            .filter(Boolean);
        if (transport === 'mqtt') {
            if (parsed.delta.action) return reject(context, 400, 'invalid-arg');
        } else if (!actions.includes(parsed.delta.action) ||
            Object.keys(parsed.delta).some(key => key !== 'action')) {
            return reject(context, 400, 'invalid-arg');
        }
        const sent = await dispatch('ampSet', {
            global: globalCtx,
            device,
            seat,
            commandId,
            delta: parsed.delta,
            now: at
        });
        if (!sent.ok) return reject(context, sent.status, sent.error, {detail: sent.detail});
        runtime.updateEntry(globalCtx, deviceId, {
            last_commander: seat,
            last_command: 'amp_set',
            last_command_id: commandId,
            last_command_ms: nowMs
        }, at);
        return respond(context, {
            status: 202,
            result: 'accepted',
            payload: {duplicate: false, command_id: commandId, dispatched: sent.dispatched, delta: parsed.delta},
            broadcast: {
                type: 'deviceCommand',
                action: 'accepted',
                device_id: deviceId,
                command,
                seat,
                command_id: commandId,
                dispatched: sent.dispatched,
                delta: parsed.delta
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
    ampDelta,
    execute
};
