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
const batch = require('./batch.js');
const layout = require('./layout.js');
const rf = require('./rf.js');
const control = require('./control.js');
const ownership = require('./ownership.js');
const runtime = require('./runtime.js');
const tower = require('./tower.js');
const tx = require('./tx.js');
const commands = require('./commands.js');
const rotatorLink = require('./rotator-link.js');
const ampLink = require('./amp-link.js');
const ampModels = require('./amp-models.js');
const rotatorModels = require('./rotator-models.js');
const relay = require('./relay.js');
const towerHold = require('./tower-hold.js');
const switchModels = require('./switch-models.js');
const switchLink = require('./switch-link.js');

commands.setTransports({
    rotate: context => rotatorLink.rotate(context.device, context.azimuth),
    stop: context => rotatorLink.stop(context.device),
    select: context => relay.pulse(context.device, context.channel, context.pulseMs),
    switchSelect: context => switchLink.select(context.global, context.device, context.port,
        context.outlet, context.now, {devices: context.devices, links: context.links}),
    towerHold: context => towerHold.hold(context.global, context.device, context.direction, context.seat, context.now),
    towerRelease: context => towerHold.release(context.global, context.device, context.now),
    ampSet: context => ampLink.publish(context.device, context.delta, context.now, context.global)
});

const DEVICE_REPORT_TIMEOUT_MS = 10000;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function asRows(rows) {
    return Array.isArray(rows) ? rows : [];
}

function splitRows(rows) {
    const devices = [];
    const sources = [];
    const links = [];
    const controlLinks = [];
    for (const row of asRows(rows)) {
        if (!row || typeof row !== 'object') continue;
        const kind = String(row.kind === undefined || row.kind === null ? 'device' : row.kind).toLowerCase();
        if (kind === 'tx') sources.push(storage.devices.toTxSource(row));
        else if (kind === 'rf') links.push(storage.devices.toRfLink(row));
        else if (kind === 'ctl') controlLinks.push(storage.devices.toControlLink(row));
        else devices.push(storage.devices.toDevice(row));
    }
    return {devices, sources, links, controlLinks};
}

function nowDate(value) {
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
}

/**
 * 哪些类型根本没有状态源：纯 RF 无源部件、没有回读的切换器/矩阵。
 * 这些设备永远不会有遥测，界面应显示「无状态源」而不是「状态未知」。
 */
const NO_STATE_SOURCE_TYPES = new Set([
    'antenna', 'bpf', 'combiner', 'serial',
    'tuner', 'notch', 'lna', 'balun', 'spd', 'coupler', 'dummy', 'divider'
]);

/** 通过通用上报接口（POST /api/devices action=report）拿状态的类型。 */
const REPORT_STATE_TYPES = new Set(['swr', 'tower']);

function hasAddress(device) {
    const config = device && device.config && typeof device.config === 'object' ? device.config : {};
    return !!String(config.host || '').trim();
}

function deviceStatus(entry, nowMs) {
    if (!entry) return {state: 'unknown', online: false, last_report: null, age_ms: null};
    const reported = Number.isFinite(entry.last_report_ms) ? entry.last_report_ms : null;
    const attempted = Number.isFinite(entry.comm_error_ms) ? entry.comm_error_ms : null;
    // 最近一次轮询失败且之后没有再成功上报：明确是通信问题，带上原因。
    if (entry.comm_error && (reported === null || attempted > reported)) {
        return {
            state: 'offline',
            online: false,
            last_report: entry.last_report || null,
            age_ms: reported === null ? null : Math.max(0, nowMs - reported),
            error: entry.comm_error
        };
    }
    if (reported === null) return {state: 'unknown', online: false, last_report: null, age_ms: null};
    const age = Math.max(0, nowMs - reported);
    return {
        state: age <= DEVICE_REPORT_TIMEOUT_MS ? 'online' : 'offline',
        online: age <= DEVICE_REPORT_TIMEOUT_MS,
        last_report: entry.last_report || null,
        age_ms: age
    };
}

/** 电台在线状态来自绑定的席位（N1MM RadioInfo），不是设备上报。 */
function radioStatus(device, seat, seatView, radio, heartbeatTimeoutMs) {
    if (!seat || !seatView) {
        return {state: 'unbound', online: false, last_report: null, age_ms: null, seat: seat || '', radio: null};
    }
    const online = !!seatView.online;
    return {
        state: online ? 'online' : 'offline',
        online,
        last_report: seatView.last_seen || null,
        age_ms: seatView.age_ms === null || seatView.age_ms === undefined ? null : seatView.age_ms,
        seat,
        timeout_ms: heartbeatTimeoutMs,
        radio: radio ? {
            freq_khz: Number.isFinite(Number(radio.freqKhz)) ? Number(radio.freqKhz) : null,
            mode: radio.mode || '',
            band: seatView.band || '',
            is_transmitting: radio.isTransmitting === true,
            operator: radio.opCall || '',
            radio_nr: radio.radioNr || '',
            ts: radio.ts || null
        } : null
    };
}

/**
 * 功放：MQTT 型号看连接状态；串口/ASCII 型号看解析出的控制地址（直连或经串口服务器）。
 * 两者都不以“最近一次数据时间”判离线，避免心跳去重/低频轮询被误判。
 */
function ampStatus(device, entry, nowMs, address) {
    const transport = ampModels.transportOf((device && device.config) || {});
    const configuredAddress = transport === 'mqtt'
        ? ampLink.configured(device)
        : !!(address && address.mode !== 'unconfigured');
    if (!configuredAddress) {
        const config = (device && device.config) || {};
        const hasAddress = transport === 'mqtt'
            ? !!config.host
            : !!(config.host || (address && address.via));
        return {
            state: hasAddress ? 'awaiting' : 'no-source',
            online: false,
            last_report: null,
            age_ms: null,
            amp: entry && entry.amp ? entry.amp : null
        };
    }
    const reported = Number.isFinite(entry && entry.last_report_ms) ? entry.last_report_ms : null;
    if (entry && entry.amp_connected === true) {
        return {
            state: 'online',
            online: true,
            last_report: entry.last_report || null,
            age_ms: reported === null ? null : Math.max(0, nowMs - reported),
            amp: entry.amp || null
        };
    }
    if (entry && entry.comm_error) {
        return {
            state: 'offline',
            online: false,
            last_report: entry.last_report || null,
            age_ms: reported === null ? null : Math.max(0, nowMs - reported),
            error: entry.comm_error,
            amp: entry.amp || null
        };
    }
    return {state: 'awaiting', online: false, last_report: null, age_ms: null, amp: entry && entry.amp ? entry.amp : null};
}

/** 切换器/矩阵：状态源是型号协议的回读，不是通用上报。 */
function switchConfigured(device, address) {
    const config = (device && device.config) || {};
    if (switchModels.transportOf(config, device.type) === 'relay') return !!(config.relay_url || '').trim();
    return !!(address && address.mode !== 'unconfigured');
}

function switchStatus(device, entry, nowMs, address) {
    const state = entry && entry.switch && typeof entry.switch === 'object' ? entry.switch : null;
    const configured = switchConfigured(device, address);
    if (!state) {
        return {
            state: configured ? 'awaiting' : 'no-source',
            online: false,
            last_report: null,
            age_ms: null
        };
    }
    const reported = Number.isFinite(state.last_readback_ms) ? state.last_readback_ms : null;
    const age = reported === null ? null : Math.max(0, nowMs - reported);
    if (state.online === false && state.error) {
        return {
            state: 'offline',
            online: false,
            last_report: reported === null ? null : new Date(reported).toISOString(),
            age_ms: age,
            error: state.error
        };
    }
    return {
        state: state.state === 'verified' ? 'online' : (configured ? 'awaiting' : 'no-source'),
        online: state.online === true,
        last_report: reported === null ? null : new Date(reported).toISOString(),
        age_ms: age,
        switch_state: state.state || 'unknown'
    };
}

/** 按“有没有状态源”给出语义，而不是一律 unknown。 */
function statusForDevice(device, entry, nowMs, address) {
    if (device.type === 'amp') return ampStatus(device, entry, nowMs, address);
    if (device.type === 'switch' || device.type === 'matrix') {
        return switchStatus(device, entry, nowMs, address);
    }
    const base = deviceStatus(entry, nowMs);
    // 真有人上报过（在线、超时或通信失败）就按上报说话。
    if (base.state !== 'unknown') return base;
    if (NO_STATE_SOURCE_TYPES.has(device.type)) {
        return {state: 'no-source', online: false, last_report: null, age_ms: null};
    }
    if (device.type === 'rotator') {
        return hasAddress(device)
            ? {state: 'awaiting', online: false, last_report: null, age_ms: null}
            : {state: 'no-source', online: false, last_report: null, age_ms: null};
    }
    if (REPORT_STATE_TYPES.has(device.type)) {
        // 配置了地址的驻波表走通用上报；塔由继电器上报限位。
        if (device.type === 'swr' && !hasAddress(device)) {
            return {state: 'no-source', online: false, last_report: null, age_ms: null};
        }
        return {state: 'awaiting', online: false, last_report: null, age_ms: null};
    }
    return {state: 'no-source', online: false, last_report: null, age_ms: null};
}

function rotatorView(device, entry, nowMs) {
    if (!entry) {
        return {
            state: 'unknown',
            physical_azimuth: null,
            target_azimuth: null,
            motion_state: 'unknown',
            last_commander: null,
            last_report: null,
            age_ms: null
        };
    }
    const status = deviceStatus(entry, nowMs);
    const physical = Number.isFinite(entry.azimuth) ? entry.azimuth : null;
    const target = Number.isFinite(entry.target_azimuth) ? entry.target_azimuth : null;
    let motion = 'unknown';
    if (entry.moving) {
        motion = 'moving';
    } else if (physical !== null && target !== null) {
        const delta = Math.abs(physical - target);
        const difference = Math.min(delta, 360 - delta);
        if (difference <= 1) {
            motion = 'settled';
        } else {
            const travelMs = (Number(device && device.travel_timeout_sec) || 120) * 1000;
            const commanded = Number(entry.last_command_ms);
            motion = Number.isFinite(commanded) && nowMs - commanded <= travelMs ? 'moving' : 'unknown';
        }
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

/** 切换器/矩阵视图：状态、已确认通路、已下发通路、映射来源与回读表。 */
function switchView(device, entry, nowMs, address, context) {
    const config = (device && device.config) || {};
    const definition = switchModels.resolve(device.type, config.brand, config.model);
    const state = entry && entry.switch && typeof entry.switch === 'object' ? entry.switch : null;
    const mapping = switchModels.mappingFor(device, entry, context);
    const lastReadback = state && Number.isFinite(state.last_readback_ms) ? state.last_readback_ms : null;
    return {
        model: (config.model || ''),
        brand: (config.brand || ''),
        protocol: switchModels.protocolOf(config, device.type),
        readback: !!(definition && definition.readback),
        protocol_verified: !definition || definition.protocol_verified !== false,
        control: !definition || definition.control !== false,
        supported: !definition || definition.supported !== false,
        configured: switchConfigured(device, address),
        state: state ? state.state || 'unknown' : (switchConfigured(device, address) ? 'waiting' : 'no-source'),
        verified: !!(state && state.state === 'verified'),
        stale: !!(state && state.stale === true),
        online: !!(state && state.online === true),
        ports: state && state.ports ? state.ports : null,
        commanded: state && state.commanded ? state.commanded : null,
        antenna_bands: mapping,
        port_mapping: mapping.ports,
        conflicts: mapping.conflicts,
        antennas: mapping.antennas,
        bands: mapping.bands,
        error: state && state.error ? state.error : null,
        last_readback: lastReadback === null ? null : new Date(lastReadback).toISOString(),
        age_ms: lastReadback === null ? null : Math.max(0, nowMs - lastReadback)
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
    const {devices, sources, links, controlLinks} = splitRows(rows);
    const entries = runtime.read(global);
    const leases = runtime.pruneLeases(global, nowMs);
    const config = deviceConfig(global);
    const selections = {};
    for (const id of Object.keys(entries)) {
        const state = entries[id] && entries[id].switch;
        // 只有设备回读确认的通路才参与 RF 可达与互锁；只写设备按“选择未知”处理。
        if (state && state.state === 'verified' && state.ports && typeof state.ports === 'object') {
            selections[id] = state.ports;
        }
    }

    const addresses = control.addressMap(devices, controlLinks);
    const statuses = {};
    const towers = {};
    const rotators = {};
    const switches = {};
    const controls = {};
    const rotatorAzimuths = {};
    for (const device of devices) {
        const entry = entries[device.id] || null;
        statuses[device.id] = statusForDevice(device, entry, nowMs, addresses[device.id]);
        const lease = leases[device.id] || null;
        const switchState = entry && entry.switch && typeof entry.switch === 'object' ? entry.switch : null;
        controls[device.id] = {
            lease: lease ? {seat: lease.seat, expires_ms: lease.expires_ms} : null,
            last_commander: (entry && entry.last_commander) || null,
            last_command: (entry && entry.last_command) || null,
            last_command_id: (entry && entry.last_command_id) || null,
            target_azimuth: entry && Number.isFinite(entry.target_azimuth) ? entry.target_azimuth : null,
            ports: switchState && switchState.state === 'verified' ? switchState.ports : null,
            commanded_ports: switchState ? switchState.commanded || null : null,
            switch_state: switchState ? switchState.state || null : null,
            tower_direction: (entry && entry.tower_direction) || null
        };
        if (device.type === 'switch' || device.type === 'matrix') {
            switches[device.id] = switchView(device, entry, nowMs, addresses[device.id],
                {devices, links});
        } else if (device.type === 'rotator') {
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
        links,
        selections,
        radioStates,
        now: at,
        heartbeatTimeoutMs: config.seat_heartbeat_timeout_ms,
        rotatorAzimuths
    });

    // 电台：状态源是绑定席位的 N1MM RadioInfo（频率/模式/发射），不是设备上报。
    const radioSeats = {};
    for (const device of devices) {
        if (device.type !== 'radio') continue;
        const seat = ownership.seatForRadio(device, ownershipView.seats);
        radioSeats[device.id] = seat;
        const view = seat ? ownershipView.seats.find(item => item.seat === seat) : null;
        statuses[device.id] = radioStatus(
            device, seat, view, seat ? radioStates[seat] || null : null,
            config.seat_heartbeat_timeout_ms
        );
    }

    // 电台归属席位由 ComputerName + 电台型号派生，只读展示，不写回设备表。
    const publicDevices = layout.withLayouts(devices).map(device => {
        const pub = model.publicDevice(device);
        if (pub.type === 'radio') pub.seat = radioSeats[device.id] || '';
        return pub;
    });

    return {
        ok: true,
        server_ts: at.toISOString(),
        config,
        devices: publicDevices,
        tree: model.buildTree(devices),
        status: statuses,
        towers,
        rotators,
        switches,
        controls,
        ownership: ownershipView,
        rf: {
            links: links.map(rf.publicLink),
            ports: rf.portMap(devices),
            control: rf.controlPortMap(devices),
            warnings: rf.warnings(devices, links)
        },
        control_links: controlLinks.map(control.publicLink),
        control_addresses: addresses,
        control_warnings: control.warnings(devices, controlLinks),
        // 功放品牌/型号描述表：页面按型号渲染字段、可控制项与状态映射。
        amp_models: ampModels.catalog(),
        // 旋转器品牌/型号描述表：协议、地址字段与可控制项。
        rotator_models: rotatorModels.catalog(),
        // 切换器/矩阵品牌/型号描述表：协议、回读能力与可控制项。
        switch_models: switchModels.catalog(),
        tx: tx.snapshot(global, sources, at)
    };
}

function publicSource(source) {
    return {
        source_id: source.source_id,
        name: source.name || source.source_id,
        priority: source.priority,
        timeout_ms: source.timeout_ms,
        device_id: source.device_id || null,
        enabled: source.enabled !== false,
        has_token: !!source.token,
        created_ts: source.created_ts || null,
        updated_ts: source.updated_ts || null
    };
}

function normalizeSource(input, existing, now, devices) {
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

    // 发射状态源绑定到具体设备实例；沿设备所在 RF 链路反查互锁范围。
    const deviceIdRaw = body.device_id === undefined && existing ? existing.device_id : body.device_id;
    const deviceId = String(deviceIdRaw === undefined || deviceIdRaw === null ? '' : deviceIdRaw).trim();
    if (deviceId && !(Array.isArray(devices) ? devices : []).some(device => device.id === deviceId)) {
        return {ok: false, status: 400, error: 'unknown-device', detail: deviceId};
    }

    const iso = nowDate(now).toISOString();
    return {
        ok: true,
        created: !existing,
        source: {
            source_id: id,
            name,
            priority,
            timeout_ms: timeoutMs,
            device_id: deviceId,
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

/** 删除或改配置时释放塔输出：尽力而为，不阻塞配置写入。 */
function releaseQuietly(global, device, at) {
    if (!device || device.type !== 'tower') return;
    towerHold.forget(global, device.id);
    towerHold.releaseDevice(global, device, at).catch(() => {});
}

/**
 * POST /api/devices 的统一分发：配置增删改、TX 源配置、设备遥测上报。
 * 返回 sql 由 flow 的 sqlite 节点执行；响应体与广播消息分开返回。
 */
function handle(global, rows, body, now) {
    const at = nowDate(now);
    const {devices, sources, links, controlLinks} = splitRows(rows);
    const input = body && typeof body === 'object' ? body : {};
    const action = String(input.action || '').trim().toLowerCase();

    if (action === 'save') {
        const result = model.normalizeDevice(input.device, {devices, now: at});
        if (!result.ok) return fail(result.status, result.error, result.detail);
        const sql = [result.created
            ? storage.devices.insertDevice(result.device)
            : storage.devices.updateDevice(result.device)];
        // 端口构成变化后，指向已不存在端口的连线不再有意义，随保存一起清掉。
        const ports = new Set(rf.portsFor(result.device).map(port => port.key));
        const staleLinks = links.filter(link =>
            (link.a_device === result.device.id && !ports.has(link.a_port)) ||
            (link.b_device === result.device.id && !ports.has(link.b_port)));
        for (const link of staleLinks) sql.push(storage.devices.deleteRfLink(link.link_id));
        const controlPorts = new Set(rf.controlPorts(result.device).map(port => port.key));
        const staleControlLinks = controlLinks.filter(link =>
            (link.a_device === result.device.id && !controlPorts.has(link.a_port)) ||
            (link.b_device === result.device.id && !controlPorts.has(link.b_port)));
        for (const link of staleControlLinks) sql.push(storage.devices.deleteControlLink(link.link_id));
        const previous = devices.find(device => device.id === result.device.id);
        if (previous && previous.type !== result.device.type) runtime.clear(global, result.device.id);
        if (previous && (previous.type !== result.device.type
            || JSON.stringify(previous.config || {}) !== JSON.stringify(result.device.config || {}))) {
            releaseQuietly(global, previous, at);
        }
        return {
            status: result.created ? 201 : 200,
            payload: {
                ok: true,
                created: result.created,
                device: model.publicDevice(result.device),
                removed_links: staleLinks.length,
                removed_control_links: staleControlLinks.length
            },
            sql,
            broadcast: {type: 'devices', action: 'save', id: result.device.id}
        };
    }

    if (action === 'delete') {
        const id = String(input.id || '').trim();
        if (!id) return fail(400, 'id-required');
        const guard = model.deleteBlockReason(devices, id);
        if (!guard.ok) return fail(guard.status, guard.error, guard.detail);
        releaseQuietly(global, devices.find(item => item.id === id), at);
        runtime.clear(global, id);
        return {
            status: 200,
            payload: {ok: true, deleted: id},
            sql: [
                storage.devices.deleteDevice(id),
                storage.devices.deleteLayout(id),
                storage.devices.deleteRfLinksForDevice(id),
                storage.devices.deleteControlLinksForDevice(id)
            ],
            broadcast: {type: 'devices', action: 'delete', id}
        };
    }

    if (action === 'layout') {
        const result = layout.normalizeLayouts(input.layouts, devices);
        if (!result.ok) return fail(result.status, result.error);
        const iso = at.toISOString();
        return {
            status: 200,
            payload: {ok: true, saved: result.layouts},
            sql: result.layouts.map(item => storage.devices.upsertLayout(item.id, item.x, item.y, iso)),
            broadcast: {type: 'devices', action: 'layout'}
        };
    }

    if (action === 'rf-link') {
        const result = rf.normalizeLink(input.link || input, {devices, links});
        if (!result.ok) return fail(result.status, result.error, result.detail);
        if (result.existing) {
            return {
                status: 200,
                payload: {ok: true, duplicate: true, link: rf.publicLink(result.link)},
                sql: [],
                broadcast: {type: 'devices', action: 'rf-link', link_id: result.link.link_id}
            };
        }
        const link = Object.assign({created_ts: at.toISOString()}, result.link);
        return {
            status: 201,
            payload: {ok: true, duplicate: false, link: rf.publicLink(link)},
            sql: [storage.devices.insertRfLink(link)],
            broadcast: {type: 'devices', action: 'rf-link', link_id: link.link_id}
        };
    }

    if (action === 'rf-unlink') {
        const id = String(input.link_id || '').trim();
        let linkId = id && links.some(link => link.link_id === id) ? id : '';
        if (!linkId) {
            const located = rf.normalizeLink(input.link || input, {devices, links});
            if (located.ok && links.some(link => link.link_id === located.link.link_id)) {
                linkId = located.link.link_id;
            }
        }
        if (!linkId) return fail(404, 'unknown-link');
        return {
            status: 200,
            payload: {ok: true, deleted: linkId},
            sql: [storage.devices.deleteRfLink(linkId)],
            broadcast: {type: 'devices', action: 'rf-unlink', link_id: linkId}
        };
    }

    if (action === 'ctl-link') {
        const result = control.normalizeLink(input.link || input, {devices, links: controlLinks});
        if (!result.ok) return fail(result.status, result.error, result.detail);
        if (result.existing) {
            return {
                status: 200,
                payload: {ok: true, duplicate: true, link: control.publicLink(result.link)},
                sql: [],
                broadcast: {type: 'devices', action: 'ctl-link', link_id: result.link.link_id}
            };
        }
        const link = Object.assign({created_ts: at.toISOString()}, result.link);
        return {
            status: 201,
            payload: {ok: true, duplicate: false, link: control.publicLink(link)},
            sql: [storage.devices.insertControlLink(link)],
            broadcast: {type: 'devices', action: 'ctl-link', link_id: link.link_id}
        };
    }

    if (action === 'ctl-unlink') {
        const id = String(input.link_id || '').trim();
        const linkId = id && controlLinks.some(link => link.link_id === id) ? id : '';
        if (!linkId) return fail(404, 'unknown-link');
        return {
            status: 200,
            payload: {ok: true, deleted: linkId},
            sql: [storage.devices.deleteControlLink(linkId)],
            broadcast: {type: 'devices', action: 'ctl-unlink', link_id: linkId}
        };
    }

    if (action === 'preview') {
        const result = batch.preview({
            devices,
            links,
            controlLinks,
            drafts: input.devices,
            rfLinks: input.rf_links,
            ctlLinks: input.control_links
        });
        if (!result.ok) return fail(result.status || 400, result.error, result.detail);
        return {
            status: 200,
            payload: Object.assign({ok: true}, result),
            sql: []
        };
    }

    if (action === 'save-batch') {
        const result = batch.save({
            devices,
            links,
            controlLinks,
            input,
            now: at
        });
        if (!result.ok) return fail(result.status || 400, result.error, result.detail);
        return {
            status: 201,
            payload: Object.assign({ok: true}, result.payload),
            sql: result.sql,
            broadcast: {type: 'devices', action: 'save-batch'}
        };
    }

    if (action === 'tx-source') {
        const existing = sources.find(source => source.source_id === String(
            (input.source && input.source.source_id) || input.source_id || ''
        ).trim()) || null;
        const result = normalizeSource(input.source || input, existing, at, devices);
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
        if (device.type === 'rotator') noteRotatorArrival(global, id, at);
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

/** 旋转器到位/离位的统一判定：到位打时间戳，界面与指令闸门共用。 */
function angleDelta(a, b) {
    const delta = Math.abs(Number(a) - Number(b));
    return Math.min(delta, 360 - delta);
}

function noteRotatorArrival(global, deviceId, at) {
    const entry = runtime.stateOf(global, deviceId);
    if (!entry) return null;
    const target = Number.isFinite(entry.target_azimuth) ? entry.target_azimuth : null;
    const physical = Number.isFinite(entry.azimuth) ? entry.azimuth : null;
    if (target === null || physical === null) return entry;
    if (angleDelta(physical, target) > 1) {
        if (entry.arrived_ms !== null && entry.arrived_ms !== undefined) {
            return runtime.updateEntry(global, deviceId, {arrived_ms: null, arrived_target: null}, at);
        }
        return entry;
    }
    if (entry.arrived_target === target && Number.isFinite(Number(entry.arrived_ms))) return entry;
    return runtime.updateEntry(global, deviceId, {
        moving: false,
        arrived_ms: at.getTime(),
        arrived_target: target
    }, at);
}

/** 轮询 rotctld 位置，成功即视为一次真实上报。 */
async function pollRotators(global, rows, now) {
    const at = nowDate(now);
    const {devices} = splitRows(rows);
    const errors = [];
    let polled = 0;
    for (const device of devices) {
        if (device.type !== 'rotator' || !device.enabled) continue;
        if (!device.config || !device.config.host) continue;
        const result = await rotatorLink.read(device);
        if (result.ok) {
            polled += 1;
            const previous = runtime.stateOf(global, device.id);
            const target = previous && Number.isFinite(previous.target_azimuth) ? previous.target_azimuth : null;
            const patch = {
                azimuth: result.azimuth,
                last_report: at.toISOString(),
                last_report_ms: at.getTime(),
                reported_ms: at.getTime(),
                last_attempt_ms: at.getTime(),
                comm_error: null,
                comm_error_ms: null
            };
            if (target !== null) patch.moving = angleDelta(result.azimuth, target) > 1;
            runtime.updateEntry(global, device.id, patch, at);
            noteRotatorArrival(global, device.id, at);
        } else {
            errors.push({device_id: device.id, error: result.error});
            // 轮询失败要留痕，界面才能显示「通信中断 + 原因」，而不是继续 unknown。
            runtime.updateEntry(global, device.id, {
                last_attempt_ms: at.getTime(),
                comm_error: result.error || 'transport-error',
                comm_error_ms: at.getTime()
            }, at);
        }
    }
    return {ok: true, polled, errors};
}

/** 维持功放链路：MQTT 订阅 + 串口/ASCII 型号的轮询；控制连线决定串口服务器地址。 */
function pollAmps(global, rows, now) {
    const at = nowDate(now);
    const {devices, controlLinks} = splitRows(rows);
    return ampLink.pollAmps(global, devices, at, {devices, links: controlLinks});
}

/** 维持切换器/矩阵链路：有回读的型号轮询状态，只写型号只维护连接。 */
function pollSwitches(global, rows, now) {
    const at = nowDate(now);
    const {devices, controlLinks} = splitRows(rows);
    return switchLink.poll(global, devices, at, {devices, links: controlLinks});
}

/** 统一指令入口：鉴权、租约、幂等、审计与 transport 下发。 */
function handleCommand(global, rows, deviceId, body, headers, now) {
    const {devices, sources, links, controlLinks} = splitRows(rows);
    return commands.execute({global, devices, sources, links, deviceId, body, headers, now});
}

/** 塔按住心跳看门狗：1500ms 未续期即断开输出。 */
async function towerWatchdog(global, rows, now) {
    const at = nowDate(now);
    const {devices} = splitRows(rows);
    const result = await towerHold.watchdog(global, devices, at);
    for (const item of result.released) {
        runtime.updateEntry(global, item.device_id, {
            tower_direction: null,
            moving: false,
            last_report: at.toISOString(),
            last_report_ms: at.getTime()
        }, at);
    }
    return result;
}

/** 启动 / 重载：默认释放所有塔输出。 */
function towerReleaseAll(global, rows, now) {
    const {devices} = splitRows(rows);
    return towerHold.releaseAll(global, devices, nowDate(now));
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
    pollRotators,
    pollAmps,
    pollSwitches,
    towerWatchdog,
    towerReleaseAll,
    ingestTx,
    duplicateTarget,
    commands
};
