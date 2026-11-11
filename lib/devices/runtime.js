'use strict';

/**
 * 设备运行态（服务端唯一状态源）。
 *
 * 只存内存、只由设备上报驱动：没有上报就是 unknown，绝不从配置或
 * 上一次会话里补一个“看起来合理”的值。服务重启后运行态为空，
 * 设备重新上报前一律 unknown。
 */

const KEY = 'deviceRuntime';

function read(global) {
    const value = global && typeof global.get === 'function' ? global.get(KEY) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function write(global, value) {
    if (global && typeof global.set === 'function') global.set(KEY, value);
}

function toMs(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function clear(global, deviceId) {
    const all = read(global);
    if (!Object.prototype.hasOwnProperty.call(all, deviceId)) return false;
    delete all[deviceId];
    write(global, all);
    return true;
}

/** 最近一次上报（无则为 null）。 */
function stateOf(global, deviceId) {
    return read(global)[deviceId] || null;
}

/**
 * 写入一帧设备上报。整帧替换，不做字段合并：
 * 上报方声明的是当前完整状态，旧值不得残留。
 */
function record(global, deviceId, report, now) {
    const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
    const atMs = at.getTime();
    const body = report && typeof report === 'object' ? report : {};
    const all = read(global);
    const prev = all[deviceId] || null;

    const entry = {
        device_id: deviceId,
        reported_ts: at.toISOString(),
        reported_ms: atMs,
        last_report: at.toISOString(),
        last_report_ms: atMs,
        seq: Number.isFinite(Number(body.seq)) ? Number(body.seq) : prev ? prev.seq : null,
        online: body.online !== false,
        tower: null,
        azimuth: null,
        target_azimuth: null,
        port: null,
        moving: body.moving === true,
        motion_started_ms: prev ? prev.motion_started_ms || null : null
    };

    if (body.tower && typeof body.tower === 'object') {
        entry.tower = {
            limit_top: typeof body.tower.limit_top === 'boolean' ? body.tower.limit_top : null,
            limit_bottom: typeof body.tower.limit_bottom === 'boolean' ? body.tower.limit_bottom : null,
            moving: body.tower.moving === true || entry.moving
        };
        entry.moving = entry.tower.moving;
        if (entry.moving) {
            if (!entry.motion_started_ms) entry.motion_started_ms = atMs;
        } else {
            entry.motion_started_ms = null;
        }
    }

    if (body.azimuth !== undefined && body.azimuth !== null) {
        const value = Number(body.azimuth);
        if (Number.isFinite(value)) entry.azimuth = ((value % 360) + 360) % 360;
    }
    if (body.target_azimuth !== undefined && body.target_azimuth !== null) {
        const value = Number(body.target_azimuth);
        if (Number.isFinite(value)) entry.target_azimuth = ((value % 360) + 360) % 360;
    }
    if (body.port !== undefined && body.port !== null) entry.port = String(body.port);

    all[deviceId] = entry;
    write(global, all);
    return entry;
}

/** 测试与配置删除时清空。 */
function reset(global) {
    write(global, {});
}

module.exports = {KEY, read, write, toMs, clear, stateOf, record, reset};
