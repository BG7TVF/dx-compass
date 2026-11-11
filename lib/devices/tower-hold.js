'use strict';

/**
 * 天线塔「按住运行」状态机（Phase 5）。
 *
 * 二态模型：只有展开/收回两个方向，运动中属于暂态。客户端按住按钮时
 * 每 500ms 续一次心跳，服务端 1500ms 收不到心跳就断开输出；任何时刻
 * 两个方向通道不允许同时闭合，方向切换有 1000ms 最小间隔。
 *
 * 输出全部走 relay.js 的干接点抽象，不绑定任何继电器型号。
 */

const relay = require('./relay.js');

const RUNTIME_KEY = 'deviceTowerHolds';
const HEARTBEAT_MS = 500;
const HOLD_TIMEOUT_MS = 1500;
const DIRECTION_SWITCH_MS = 1000;

function nowDate(value) {
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
}

function holds(global) {
    const value = global && typeof global.get === 'function' ? global.get(RUNTIME_KEY) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function save(global, value) {
    if (global && typeof global.set === 'function') global.set(RUNTIME_KEY, value);
}

function channelFor(device, direction) {
    const config = (device && device.config) || {};
    const channel = direction === 'up' ? config.up_channel : config.down_channel;
    return Number.isInteger(channel) ? channel : null;
}

function stateOf(global, deviceId) {
    const hold = holds(global)[deviceId];
    return hold ? Object.assign({}, hold) : null;
}

function expiresFor(nowMs) {
    return nowMs + HOLD_TIMEOUT_MS;
}

async function offChannel(device, channel) {
    return relay.off(device, channel);
}

/**
 * 按下 / 心跳续期。
 * 同方向重复调用只续期，不重复吸合；换方向会先断开所有其他通道。
 */
async function hold(global, device, direction, seat, now) {
    const at = nowDate(now);
    const nowMs = at.getTime();
    const channel = channelFor(device, direction);
    if (channel === null) return {ok: false, status: 400, error: 'unknown-channel'};

    const map = holds(global);
    const existing = map[device.id] || null;

    if (existing && existing.direction !== direction) {
        const lastSwitch = Number.isFinite(existing.released_ms)
            ? existing.released_ms
            : (Number.isFinite(existing.switched_ms) ? existing.switched_ms : existing.started_ms);
        if (nowMs - lastSwitch < DIRECTION_SWITCH_MS) {
            return {ok: false, status: 409, error: 'direction-switch-too-fast'};
        }
    }

    if (existing && existing.direction === direction && !existing.released_ms && nowMs < existing.expires_ms) {
        existing.expires_ms = expiresFor(nowMs);
        existing.seat = seat;
        save(global, map);
        return {
            ok: true,
            dispatched: false,
            renewed: true,
            channel,
            direction,
            expires_ms: existing.expires_ms
        };
    }

    // 先断开另一路与上一路，保证任何时刻只有一路闭合。
    const targets = new Set();
    const opposite = channelFor(device, direction === 'up' ? 'down' : 'up');
    if (opposite !== null) targets.add(opposite);
    if (existing && Number.isInteger(existing.channel) && existing.channel !== channel) {
        targets.add(existing.channel);
    }
    targets.delete(channel);
    for (const target of targets) {
        const off = await offChannel(device, target);
        if (!off.ok) return off;
    }

    const on = await relay.on(device, channel);
    if (!on.ok) return on;

    map[device.id] = {
        direction,
        channel,
        seat,
        started_ms: nowMs,
        switched_ms: nowMs,
        expires_ms: expiresFor(nowMs),
        released_ms: null
    };
    save(global, map);
    return {ok: true, dispatched: true, renewed: false, channel, direction, expires_ms: expiresFor(nowMs)};
}

/** 松手 / 停止：立即断开当前通道。 */
async function release(global, device, now) {
    const at = nowDate(now);
    const map = holds(global);
    const existing = map[device.id];
    if (!existing) return {ok: true, dispatched: false, released: false};
    if (existing.released_ms) return {ok: true, dispatched: false, released: false};

    const off = await offChannel(device, existing.channel);
    if (!off.ok) return off;

    existing.released_ms = at.getTime();
    existing.expires_ms = at.getTime();
    save(global, map);
    return {ok: true, dispatched: true, released: true, direction: existing.direction};
}

/**
 * 看门狗：超过 1500ms 没有续期就断开输出。
 * 返回被释放的设备，调用方负责同步运行态与广播。
 */
async function watchdog(global, devices, now) {
    const at = nowDate(now);
    const nowMs = at.getTime();
    const map = holds(global);
    const released = [];
    for (const device of Array.isArray(devices) ? devices : []) {
        const entry = map[device.id];
        if (!entry || entry.released_ms) continue;
        if (nowMs < entry.expires_ms) continue;
        const off = await offChannel(device, entry.channel);
        if (!off.ok) continue;
        entry.released_ms = nowMs;
        entry.expires_ms = nowMs;
        released.push({device_id: device.id, direction: entry.direction, channel: entry.channel});
    }
    if (released.length) save(global, map);
    return {ok: true, released};
}

/** 删除设备或改配置时释放其输出（尽力而为，不阻塞配置写入）。 */
async function releaseDevice(global, device, now) {
    const map = holds(global);
    const entry = map[device.id];
    for (const channel of [entry && entry.channel, channelFor(device, 'up'), channelFor(device, 'down')]) {
        if (Number.isInteger(channel)) {
            const off = await offChannel(device, channel);
            if (!off.ok) return off;
        }
    }
    if (entry) {
        entry.released_ms = nowDate(now).getTime();
        entry.expires_ms = entry.released_ms;
        save(global, map);
    }
    return {ok: true, dispatched: true};
}

/** 启动 / 重载默认释放：把所有已配置塔的两路输出都断一次。 */
async function releaseAll(global, devices, now) {
    const at = nowDate(now);
    const released = [];
    const towers = (Array.isArray(devices) ? devices : []).filter(device =>
        device && device.type === 'tower' && device.enabled !== false);
    await Promise.all(towers.map(async device => {
        for (const direction of ['up', 'down']) {
            const channel = channelFor(device, direction);
            if (channel === null) continue;
            const off = await offChannel(device, channel);
            if (off.ok) released.push({device_id: device.id, direction, channel});
        }
    }));
    const map = holds(global);
    for (const device of towers) {
        if (map[device.id]) {
            map[device.id].released_ms = at.getTime();
            map[device.id].expires_ms = at.getTime();
        }
    }
    save(global, map);
    return {ok: true, released};
}

function reset(global) {
    save(global, {});
}

/** 丢弃某台塔的运行态（改类型或删除时用）。 */
function forget(global, deviceId) {
    const map = holds(global);
    if (!Object.prototype.hasOwnProperty.call(map, deviceId)) return false;
    delete map[deviceId];
    save(global, map);
    return true;
}

module.exports = {
    RUNTIME_KEY,
    HEARTBEAT_MS,
    HOLD_TIMEOUT_MS,
    DIRECTION_SWITCH_MS,
    channelFor,
    stateOf,
    expiresFor,
    hold,
    release,
    watchdog,
    releaseDevice,
    releaseAll,
    forget,
    reset
};
