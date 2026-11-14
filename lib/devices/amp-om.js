'use strict';

/**
 * OM Power 2501A / 3501A / 4001A（rev.4，固件 ≥3.16）原生 TCP 适配。
 *
 * 协议依据：github.com/grmi64/OM-Power-Control（MIT）的 decoder.py /
 * session_protocol.py / controls.py。传输是 Lantronix XPort 上的原生 TCP，
 * 默认端口 10001；命令是单字节 ASCII，测量是 10 字节二进制帧
 * `0x3D + 8 字节 + 0x3B`，状态是 `;` 结尾的 ASCII token。
 *
 * 本模块只做遥测回读与仓库真实存在的动作（开机/关机、Operate/Standby、
 * 自动调谐）。校准、偏置、阈值、工程参数不在此模块出现。
 */

const net = require('node:net');
const runtime = require('./runtime.js');

/** 测试可注入的 TCP socket 工厂。 */
let socketFactory = null;
/** deviceId → client */
const clients = new Map();

const OM_MEASUREMENT_LEN = 10;
const OM_MEASUREMENT_START = 0x3d;
const OM_MEASUREMENT_END = 0x3b;
const OM_POLL_MS = 1000;
const OM_DATA_TIMEOUT_MS = 10000;
const OM_COMMAND_TIMEOUT_MS = 5000;
const OM_COMMAND_GAP_MS = 2000;

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function nowDate(value) {
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
}

function blankOm() {
    return {
        status_text: 'Unknown',
        transmitting: false,
        out_fwd_power: null,
        out_rev_power: null,
        out_swr: null,
        drive_power: null,
        plate_current: null,
        plate_voltage: null,
        screen_voltage: null,
        screen_current: null,
        grid_a_voltage: null,
        grid_b_voltage: null,
        heater_a_voltage: null,
        heater_b_voltage: null,
        mains_voltage: null,
        current_temperature: null,
        frequency_khz: null,
        work_freq: null,
        antenna_name: '',
        autotune_phase: 'idle'
    };
}

/** 10 字节测量帧：正向、反射、输入、屏流；SWR 用仓库同一公式。 */
function applyOmMeasurement(state, bytes) {
    const forward = bytes[0] + bytes[1] * 256;
    const reflected = bytes[2] * 2;
    const input = bytes[3];
    const screen = bytes[4] > 127 ? bytes[4] - 256 : bytes[4];
    const ratio = forward > reflected && forward > 0 ? Math.sqrt(reflected / forward) : null;
    state.out_fwd_power = forward;
    state.out_rev_power = reflected;
    state.drive_power = input;
    state.screen_current = screen;
    state.out_swr = ratio === null ? null : (1 + ratio) / (1 - ratio);
    // 仓库把发射态保持到 PTTOFF：PTT 已按下但还没出功率时不能误判为接收。
    state.transmitting = state.transmitting || forward > 0 || input > 0;
    return true;
}

const OM_STATUS_FIELDS = {
    IP: ['plate_current', 0.001],
    UP: ['plate_voltage', 1],
    US: ['screen_voltage', 1],
    UHA: ['heater_a_voltage', 1],
    UHB: ['heater_b_voltage', 1],
    UM: ['mains_voltage', 1],
    TE: ['current_temperature', 0.5],
    UGA: ['grid_a_voltage', 1],
    UGB: ['grid_b_voltage', 1]
};

/** 解析一条 `;` 结尾的 ASCII token；返回是否被识别。 */
function applyOmToken(state, token) {
    const line = text(token);
    if (!line) return false;

    const antenna = /^ST(\d{4})-\s*(.*)$/.exec(line);
    if (antenna) {
        const code = antenna[1];
        state.antenna_name = text(antenna[2]).slice(0, 80);
        // 仓库把 1xxx/2xxx 拆成两段：后三位 100=Standby、110=Operate；
        // 1000/2000 才是关机，其余保持 Unknown。
        if ((code[0] === '1' || code[0] === '2') && (code.slice(1) === '100' || code.slice(1) === '110')) {
            state.status_text = code.slice(1) === '110' ? 'Operate' : 'Standby';
        } else if (code === '1000' || code === '2000') {
            state.status_text = 'Off';
        } else {
            state.status_text = 'Unknown';
        }
        return true;
    }

    if (line === 'OPERATE' || line === 'STBY' || line === 'PAOFF' || line === 'PAON') {
        state.status_text = {OPERATE: 'Operate', STBY: 'Standby', PAOFF: 'Off', PAON: 'On'}[line];
        return true;
    }
    if (line === 'COON') {
        state.status_text = 'Cooling down';
        return true;
    }
    if (/^(WA|CO)\d+$/.test(line)) {
        state.status_text = line.slice(0, 2) === 'WA' ? 'Warming up' : 'Cooling down';
        return true;
    }
    if (line === 'PTTON') {
        state.transmitting = true;
        return true;
    }
    if (line === 'PTTOFF') {
        state.transmitting = false;
        state.out_fwd_power = 0;
        state.out_rev_power = 0;
        state.out_swr = null;
        state.drive_power = 0;
        return true;
    }

    const frequency = /^FR(\d+)$/.exec(line);
    if (frequency) {
        const khz = Number(frequency[1]);
        state.frequency_khz = khz;
        state.work_freq = khz * 1000;
        return true;
    }

    const field = /^(IP|UP|US|UHA|UHB|UM|TE|UGA|UGB)(-?\d+(?:\.\d+)?)$/.exec(line);
    if (field) {
        const [key, scale] = OM_STATUS_FIELDS[field[1]];
        const value = Number(field[2]);
        state[key] = Number.isFinite(value) ? value * scale : null;
        return true;
    }

    if (line === 'AUTO' || line.startsWith('AUTO:') || line === 'AUTOESC' ||
        line === 'STOP' || line === 'SAVE USER' || line === 'SAVE DEFAULT' ||
        /^(LO|TU|OT)-?\d+$/.test(line)) {
        // 自动调谐过程 token；具体阶段由命令层解释，这里只记录。
        if (line === 'AUTO') state.autotune_phase = 'entered';
        else if (line === 'AUTOESC') state.autotune_phase = 'cancelled';
        else if (line === 'AUTO:WAITING FOR INPUT POWER') state.autotune_phase = 'waiting';
        else if (line === 'AUTO:AUTOTUNE IN PROGRESS') state.autotune_phase = 'tuning';
        else if (line === 'AUTO:AUTOTUNE DONE') state.autotune_phase = 'succeeded';
        else if (line === 'AUTO:AUTOTUNE ABORTED') state.autotune_phase = 'aborted';
        return true;
    }

    return line === 'CON' || line === 'COFF' || line === 'CON;' || line === 'COFF;';
}

/**
 * 流式解析。测量帧必须先于 ASCII 查找；token 跨包时保留缓冲。
 * 返回 {recognized, tokens, measurements}，便于命令层做确认。
 */
function feedOm(state, chunk) {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    let recognized = false;
    let measurements = 0;
    const tokens = [];
    while (state.buffer.length) {
        if (state.buffer[0] === 0) {
            let index = 0;
            while (index < state.buffer.length && state.buffer[index] === 0) index += 1;
            state.buffer = state.buffer.slice(index);
            if (!state.buffer.length) break;
        }
        if (state.buffer[0] === OM_MEASUREMENT_START) {
            if (state.buffer.length < OM_MEASUREMENT_LEN) break;
            if (state.buffer[OM_MEASUREMENT_LEN - 1] !== OM_MEASUREMENT_END) {
                // 假起始字节：丢掉一个字节重新找同步。
                state.buffer = state.buffer.slice(1);
                continue;
            }
            applyOmMeasurement(state.amp, state.buffer.slice(1, 9));
            state.buffer = state.buffer.slice(OM_MEASUREMENT_LEN);
            measurements += 1;
            recognized = true;
            continue;
        }
        const end = state.buffer.indexOf(0x3b);
        if (end < 0) {
            if (state.buffer.length > 512) state.buffer = Buffer.alloc(0);
            break;
        }
        const token = state.buffer.slice(0, end).toString('ascii');
        state.buffer = state.buffer.slice(end + 1);
        tokens.push(token);
        if (applyOmToken(state.amp, token)) recognized = true;
    }
    return {recognized, tokens, measurements};
}

function writeText(state, value) {
    if (!state.socket || !state.connected) return false;
    try {
        state.socket.write(value);
        return true;
    } catch (error) {
        return false;
    }
}

function stopPolling(state) {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
}

function startPolling(global, device, state) {
    stopPolling(state);
    state.tick = 0;
    state.ready = true;
    writeText(state, '?');
    state.timer = setInterval(() => {
        if (!state.connected || !state.socket) return;
        state.tick += 1;
        writeText(state, '#');
        const amp = state.amp;
        const idle = !amp.transmitting &&
            !['Warming up', 'Cooling down', 'Off', 'Unknown'].includes(amp.status_text) &&
            !['entered', 'waiting', 'tuning', 'unknown', 'aborted'].includes(amp.autotune_phase);
        if (state.tick % 2 === 0 && idle && !state.pending) writeText(state, '?');
        if (state.tick % 5 === 0 && idle && !state.pending) writeText(state, 'F');
        const nowMs = Date.now();
        if (state.last_rx_ms && nowMs - state.last_rx_ms > OM_DATA_TIMEOUT_MS) {
            markFailure(state, 'transport-timeout');
        }
        if (state.pending && nowMs - state.pending.sent_ms > OM_COMMAND_TIMEOUT_MS) {
            // 仓库原则：超时不重发，结果不确定，等新的状态/测量刷新后再允许操作。
            state.pending = null;
            state.uncertain = true;
        }
    }, OM_POLL_MS);
}

function writeAmp(global, device, state) {
    const stamp = new Date();
    runtime.updateEntry(global, device.id, {
        amp: state.amp,
        amp_connected: true,
        last_report: stamp.toISOString(),
        last_report_ms: stamp.getTime(),
        reported_ms: stamp.getTime(),
        last_attempt_ms: stamp.getTime(),
        comm_error: null,
        comm_error_ms: null
    }, stamp);
}

function markFailure(state, error) {
    state.connected = false;
    stopPolling(state);
    const stamp = new Date();
    runtime.updateEntry(state.global, state.deviceId, {
        amp_connected: false,
        last_attempt_ms: stamp.getTime(),
        comm_error: error,
        comm_error_ms: stamp.getTime()
    }, stamp);
    try { state.socket && state.socket.destroy(); } catch (ignored) { /* ignore */ }
}

function destroy(state) {
    stopPolling(state);
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    try { state.socket && state.socket.destroy(); } catch (ignored) { /* ignore */ }
    state.socket = null;
    state.connected = false;
    if (clients.get(state.deviceId) === state) clients.delete(state.deviceId);
}

function handlePending(state, tokens, nowMs) {
    if (!state.pending) return;
    const pending = state.pending;
    const has = wanted => tokens.some(token => token === wanted);
    if (pending.action === 'autotune') {
        if (pending.stage === 0) {
            if (has('AUTO')) {
                // 仓库的两步流程：先 L 进入自动模式，再 & 准备调谐。
                if (writeText(state, '&')) {
                    pending.stage = 1;
                    pending.sent_ms = nowMs;
                }
            } else if (tokens.some(token => token.startsWith('AUTO'))) {
                state.pending = null;
                state.uncertain = true;
            }
            return;
        }
        if (has('AUTO:WAITING FOR INPUT POWER') || has('AUTO:AUTOTUNE DONE')) {
            state.pending = null;
            state.uncertain = false;
        } else if (has('AUTO:AUTOTUNE ABORTED') || has('STOP')) {
            state.pending = null;
            state.uncertain = false;
        }
        return;
    }
    const wanted = pending.action === 'power_on' ? ['PAON']
        : pending.action === 'power_off' ? ['PAOFF', 'COON']
            : pending.action === 'operate' ? ['OPERATE'] : ['STBY'];
    if (tokens.some(token => wanted.includes(token) ||
        (token.startsWith('WA') && pending.action === 'power_on') ||
        (token.startsWith('CO') && pending.action === 'power_off'))) {
        state.pending = null;
        state.uncertain = false;
    }
}

function connect(global, device, address) {
    const socket = socketFactory
        ? socketFactory({host: address.host, port: address.port})
        : net.createConnection({host: address.host, port: address.port});
    const state = {
        socket,
        deviceId: device.id,
        global,
        connected: false,
        ready: false,
        buffer: Buffer.alloc(0),
        amp: blankOm(),
        tick: 0,
        timer: null,
        handshakeTimer: null,
        handshake: 'waiting',
        pending: null,
        uncertain: false,
        last_cmd_ms: 0,
        last_rx_ms: Date.now()
    };
    clients.set(device.id, state);

    socket.on('connect', () => {
        state.connected = true;
        // 仓库在 TCP 连上后等 0.6 秒再发 C，避免与 XPort 的启动竞争。
        state.handshakeTimer = setTimeout(() => {
            if (state.connected && writeText(state, 'C')) state.last_rx_ms = Date.now();
        }, 600);
    });
    socket.on('data', chunk => {
        state.last_rx_ms = Date.now();
        const result = feedOm(state, chunk);
        if (result.recognized) writeAmp(global, device, state);
        if (state.handshake !== 'ready') {
            if (result.tokens.includes('CON')) {
                state.handshake = 'ready';
                startPolling(global, device, state);
            } else if (result.tokens.includes('COFF')) {
                // 已有远程会话被清除；再发一次 C 建立。
                writeText(state, 'C');
            }
            return;
        }
        if (state.pending) {
            handlePending(state, result.tokens, Date.now());
            if (!state.pending) state.last_cmd_ms = Date.now();
        }
        if (result.tokens.includes('COFF')) markFailure(state, 'transport-connect');
        if (state.uncertain && result.measurements > 0) state.uncertain = false;
    });
    socket.on('error', error => {
        markFailure(state, error && error.code === 'ETIMEDOUT'
            ? 'transport-timeout' : 'transport-connect');
        destroy(state);
    });
    socket.on('close', () => {
        if (state.connected) {
            const stamp = new Date();
            runtime.updateEntry(global, device.id, {
                amp_connected: false,
                last_attempt_ms: stamp.getTime(),
                comm_error: 'transport-connect',
                comm_error_ms: stamp.getTime()
            }, stamp);
        }
        destroy(state);
    });
    return state;
}

function poll(global, device, address, at) {
    if (!address || address.mode === 'unconfigured') {
        const existing = clients.get(device.id);
        if (existing) destroy(existing);
        return;
    }
    const existing = clients.get(device.id);
    const signature = JSON.stringify([address.host, address.port]);
    if (existing && existing.signature === signature) return;
    if (existing) destroy(existing);
    const state = connect(global, device, address);
    state.signature = signature;
    state.last_attempt = nowDate(at).getTime();
}

/** 清理不再需要连接的设备（停用、删除或改走其他传输）。 */
function retain(ids) {
    const wanted = ids instanceof Set ? ids : new Set(ids || []);
    for (const [deviceId, state] of [...clients.entries()]) {
        if (!wanted.has(deviceId)) destroy(state);
    }
}

const OM_ACTIONS = new Set(['power_on', 'power_off', 'operate', 'standby', 'autotune']);

function publish(global, device, delta, now) {
    const action = text(delta && delta.action);
    if (!OM_ACTIONS.has(action)) {
        return Promise.resolve({ok: false, status: 400, error: 'invalid-arg'});
    }
    const state = clients.get(device.id);
    if (!state || !state.ready || !state.connected) {
        return Promise.resolve({ok: false, status: 502, error: 'transport-connect'});
    }
    const nowMs = nowDate(now).getTime();
    if (state.pending || state.uncertain) {
        return Promise.resolve({ok: false, status: 409, error: 'device-busy'});
    }
    const amp = state.amp;
    if (amp.transmitting) return Promise.resolve({ok: false, status: 409, error: 'device-transmitting'});
    if (['Warming up', 'Cooling down'].includes(amp.status_text)) {
        return Promise.resolve({ok: false, status: 409, error: 'device-countdown'});
    }
    // 自动调谐进行中不允许其他动作；仓库要求先退出等待态。
    // 本实现不开放 `*` 退出命令，因此 ABORTED 视为已结束，避免把设备永久卡住。
    if (action !== 'autotune' && ['entered', 'waiting', 'tuning', 'unknown'].includes(amp.autotune_phase)) {
        return Promise.resolve({ok: false, status: 409, error: 'device-busy'});
    }
    // 命令必须建立在新鲜读数的前提上，避免按过期状态误操作。
    if (Date.now() - state.last_rx_ms > 3000) {
        return Promise.resolve({ok: false, status: 502, error: 'transport-timeout'});
    }
    if (action === 'operate' && amp.status_text !== 'Standby') {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (action === 'standby' && amp.status_text !== 'Operate') {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (action === 'power_on' && ['On', 'Operate', 'Standby'].includes(amp.status_text)) {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (action === 'power_off' && amp.status_text === 'Off') {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (action === 'autotune' && (amp.status_text !== 'Operate' ||
        ['entered', 'waiting', 'tuning', 'unknown'].includes(amp.autotune_phase))) {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (nowMs - state.last_cmd_ms < OM_COMMAND_GAP_MS) {
        return Promise.resolve({ok: false, status: 409, error: 'rate-limited'});
    }
    // Operate/Standby 是同一个 O 切换命令；上层已按当前状态校验。
    const bytes = {power_on: 'Y', power_off: 'Z', operate: 'O', standby: 'O', autotune: 'L'}[action];
    if (!writeText(state, bytes)) {
        return Promise.resolve({ok: false, status: 502, error: 'transport-error'});
    }
    state.last_cmd_ms = nowMs;
    state.pending = {action, stage: 0, sent_ms: nowMs};
    return Promise.resolve({ok: true, dispatched: true});
}

function resetForTests() {
    for (const state of clients.values()) {
        stopPolling(state);
        if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
        try { state.socket && state.socket.destroy(); } catch (ignored) { /* ignore */ }
    }
    clients.clear();
}

function setSocketFactory(factory) {
    socketFactory = typeof factory === 'function' ? factory : null;
}

module.exports = {
    OM_ACTIONS,
    blankOm,
    applyOmMeasurement,
    applyOmToken,
    feedOm,
    poll,
    retain,
    publish,
    resetForTests,
    setSocketFactory
};
