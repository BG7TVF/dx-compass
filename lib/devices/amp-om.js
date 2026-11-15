'use strict';

/**
 * OM Power 2501A / 3501A / 4001A 原生 TCP 适配。
 *
 * 协议以官方 RCM PA+ HF v3.41（AmpMan.exe）的文本行为为准：
 *   - Lantronix XPort TCP 10001；
 *   - 连上先发 `^`，等 `^OK;`，再发 `C`，`CON;` 表示会话建立；
 *   - 命令是单个 ASCII 字符，回包是以 `;` 结尾的可读 token；
 *   - 遥测用 `#`（1 秒），发射中可加 `I`（250 毫秒）取快速功率，频率用 `F`（60 秒）。
 *
 * 官方软件没有 10 字节二进制测量帧。这里把二进制 `0x3D…0x3B` 保留为
 * 降级兜底：`^` 超时收不到 `^OK;` 才启用，并在运行态标记为未验证协议。
 *
 * 本模块只做遥测回读与常规操作。管理员口令、天线配置写入、风扇模式写入，
 * 以及任何校准、偏置、保护阈值、工程参数都不在此模块出现。
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
const OM_QUICK_MS = 250;
const OM_FREQ_MS = 60000;
const OM_DATA_TIMEOUT_MS = 10000;
const OM_COMMAND_TIMEOUT_MS = 5000;
const OM_COMMAND_GAP_MS = 2000;
const OM_PROBE_TIMEOUT_MS = 2000;
const OM_CONNECT_RETRY_MS = 2000;
const OM_CONNECT_RETRIES = 3;

const ACTIONS = new Set([
    'power_on', 'power_off', 'operate', 'standby', 'autotune', 'manual_tune', 'tune_step'
]);

const ACTION_BYTES = {
    power_on: 'Y',
    power_off: 'Z',
    operate: 'O',
    standby: 'O',
    autotune: 'L',
    manual_tune: 'M',
    tune_step: '&'
};

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function nowDate(value) {
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
}

function blankOm() {
    return {
        // 协议路径：unknown → text（官方）或 binary-legacy（降级兜底）
        protocol: 'unknown',
        protocol_verified: null,
        status_text: 'Unknown',
        transmitting: false,
        tuning: false,
        manual_tune: false,
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
        grid_current: null,
        heater_a_voltage: null,
        heater_b_voltage: null,
        mains_voltage: null,
        // 官方 TE 是原始值；型号多项式属于校准数据，本实现不抄，因此只保留原始值。
        current_temperature: null,
        current_temperature_raw: null,
        temperature_calibrated: false,
        // IG 的单位在官方文本中没有写明，按 0.1 mA 处理并标记为推断。
        ig_unit_inferred: true,
        frequency_khz: null,
        work_freq: null,
        frequency_source: '',
        antenna_number: null,
        antenna_name: '',
        serial: '',
        tube_serial: '',
        tube_serial2: '',
        firmware: '',
        runtime_minutes: null,
        runtime_minutes_valid: true,
        model: '',
        warning_count: null,
        fault_code: null,
        blower_mode: '',
        autotune_phase: 'idle'
    };
}

/** 官方 SWR 公式：仅在 PO > PR > 0 时成立；不满足时不出数。 */
function omSwr(forward, reflected) {
    if (!Number.isFinite(forward) || !Number.isFinite(reflected)) return null;
    if (!(forward > reflected && reflected > 0)) return null;
    const ratio = Math.sqrt(reflected / forward);
    return (1 + ratio) / (1 - ratio);
}

function is4001Oh(model) {
    const value = text(model).toUpperCase();
    return value.includes('OM4001') && value.includes('OH');
}

/** 10 字节二进制测量帧（仅降级路径使用）。 */
function applyOmMeasurement(state, bytes) {
    const forward = bytes[0] + bytes[1] * 256;
    const reflected = bytes[2] * 2;
    const input = bytes[3];
    const screen = bytes[4] > 127 ? bytes[4] - 256 : bytes[4];
    state.out_fwd_power = forward;
    state.out_rev_power = reflected;
    state.drive_power = input;
    state.screen_current = screen;
    state.out_swr = omSwr(forward, reflected);
    state.transmitting = state.transmitting || forward > 0 || input > 0;
    return true;
}

const STATUS_FIELDS = {
    UP: ['plate_voltage', 1],
    UM: ['mains_voltage', 1],
    US: ['screen_voltage', 1],
    IP: ['plate_current', 0.001],
    IS: ['screen_current', 1],
    UH: ['heater_a_voltage', 1],
    UHA: ['heater_a_voltage', 1],
    UHB: ['heater_b_voltage', 1],
    UG: ['grid_a_voltage', -1],
    UGA: ['grid_a_voltage', -1],
    UGB: ['grid_b_voltage', -1],
    IG: ['grid_current', -0.1]
};

function applyInfo(amp, body) {
    const match = /^INFO:(\d+),([^,]+),(?:([^,]+),)?(\d+\.\d+)([A-Za-z]?),(-?\d+)(?:,([A-Z0-9 +]+))?$/
        .exec(body);
    if (!match) return false;
    amp.serial = match[1];
    amp.tube_serial = text(match[2]);
    amp.tube_serial2 = text(match[3]);
    amp.firmware = match[4] + (match[5] || '');
    const minutes = Number(match[6]);
    amp.runtime_minutes = Number.isFinite(minutes) ? minutes : null;
    amp.runtime_minutes_valid = !(Number.isFinite(minutes) && minutes < 0);
    amp.model = text(match[7]);
    return true;
}

/**
 * 解析一条 `;` 结尾的 token；返回是否被识别。
 * 入参可以是带 `^` 前缀的原始 token，也可以是裸 token。
 */
function applyOmToken(amp, token) {
    let line = text(token);
    if (!line) return false;
    if (line.startsWith('^')) line = line.slice(1);
    if (!line) return false;

    if (line === 'OK') return true;

    if (line === 'CON' || line === 'COFF') return true;

    // ST 固定布局：ST + 天线号(hex) + PA 开关 + 模式 + 发射 + 调谐 + 名称。
    if (line.startsWith('ST') && line.length >= 7) {
        const antenna = line[2];
        if (!/^[0-9A-Fa-f]$/.test(antenna)) return false;
        const power = line[3];
        const mode = line[4];
        const tx = line[5];
        const tune = line[6];
        if (!/^\d$/.test(power) || !/^\d$/.test(mode) || !/^\d$/.test(tx) || !/^[01-]$/.test(tune)) {
            return false;
        }
        amp.antenna_number = parseInt(antenna, 16);
        amp.antenna_name = line.slice(7, 58);
        amp.status_text = power === '1' ? (mode === '1' ? 'Operate' : 'Standby') : 'Off';
        amp.transmitting = tx === '1';
        amp.tuning = tune === '1';
        return true;
    }

    if (line === 'OPERATE' || line === 'STBY' || line === 'PAOFF' || line === 'PAON') {
        amp.status_text = {OPERATE: 'Operate', STBY: 'Standby', PAOFF: 'Off', PAON: 'On'}[line];
        return true;
    }
    if (line === 'COON') {
        amp.status_text = 'Cooling down';
        return true;
    }
    if (/^(WA|CO)\d+$/.test(line)) {
        amp.status_text = line.slice(0, 2) === 'WA' ? 'Warming up' : 'Cooling down';
        return true;
    }
    if (line === 'PTTON') {
        amp.transmitting = true;
        return true;
    }
    if (line === 'PTTOFF') {
        amp.transmitting = false;
        amp.out_fwd_power = 0;
        amp.out_rev_power = 0;
        amp.out_swr = null;
        amp.drive_power = 0;
        return true;
    }

    // FA：8–12 位是频率（Hz），1–2 位是故障号；先判频率。
    const faFrequency = /^FA(\d{8,12})$/.exec(line);
    if (faFrequency) {
        const khz = Number(faFrequency[1]) / 1000;
        amp.frequency_khz = khz;
        amp.work_freq = khz * 1000;
        return true;
    }
    const fr = /^FR:?(\d+(?:\.\d+)?)$/.exec(line);
    if (fr) {
        const khz = Number(fr[1]);
        amp.frequency_khz = khz;
        amp.work_freq = khz * 1000;
        return true;
    }

    const power = /^PO(\d+),PR(\d+),PI(\d+(?:\.\d+)?)$/.exec(line);
    if (power) {
        let forward = Number(power[1]);
        const reflected = Number(power[2]);
        amp.drive_power = Number(power[3]);
        // 官方对 OM4001* OH 的正向功率显示前除以 2。
        if (is4001Oh(amp.model)) forward /= 2;
        amp.out_fwd_power = forward;
        amp.out_rev_power = reflected;
        amp.out_swr = omSwr(forward, reflected);
        return true;
    }

    const telemetry = /^(UP|UM|US|IP|IS|UH|UHA|UHB|UG|UGA|UGB|IG)(-?\d+(?:\.\d+)?)$/.exec(line);
    if (telemetry) {
        const [key, scale] = STATUS_FIELDS[telemetry[1]];
        const value = Number(telemetry[2]);
        amp[key] = Number.isFinite(value) ? value * scale : null;
        if (telemetry[1] === 'IG') {
            amp.grid_current = Math.round(amp.grid_current * 10) / 10;
            amp.ig_unit_inferred = true;
        }
        return true;
    }

    const temp = /^TE(-?\d+)$/.exec(line);
    if (temp) {
        // 官方是「原始值 / 2 后按型号多项式」；多项式系数属校准数据，不抄。
        amp.current_temperature_raw = Number(temp[1]);
        amp.current_temperature = null;
        amp.temperature_calibrated = false;
        return true;
    }

    // AN：天线号与 ST 一样只有一位十六进制，后面直接跟名称。
    const antenna = /^AN([0-9A-Fa-f])(.*)$/.exec(line);
    if (antenna) {
        amp.antenna_number = parseInt(antenna[1], 16);
        amp.antenna_name = text(antenna[2]).slice(0, 51);
        return true;
    }

    if (line.startsWith('INFO:') && applyInfo(amp, line)) return true;

    const tcvr = /^TCVR:?(.+)$/.exec(line);
    if (tcvr) {
        amp.frequency_source = text(tcvr[1]);
        return true;
    }

    const warning = /^WG(\d{1,2})$/.exec(line);
    if (warning) {
        amp.warning_count = Number(warning[1]);
        return true;
    }
    const fault = /^FA(\d{1,2})$/.exec(line);
    if (fault) {
        const code = Number(fault[1]);
        amp.fault_code = code > 0 && code <= 15 ? code : 0;
        return true;
    }
    if (line === 'FERROR' || line === 'HVF' || line === 'HF') {
        amp.fault_code = line;
        return true;
    }
    const blower = /^BLOWER:(ALWAYS|PTT|TEMP)$/.exec(line);
    if (blower) {
        amp.blower_mode = blower[1];
        return true;
    }

    if (line === 'MAN') {
        amp.status_text = 'Operate';
        amp.manual_tune = true;
        amp.autotune_phase = 'idle';
        return true;
    }
    if (line === 'AUTO' || line.startsWith('AUTO:') || line === 'AUTOESC' ||
        line === 'STOP' || line === 'SAVE USER' || line === 'SAVE DEFAULT' ||
        /^(LO|TU|OT)-?\d+$/.test(line)) {
        if (line === 'AUTO') {
            amp.manual_tune = false;
            amp.autotune_phase = 'entered';
        } else if (line === 'AUTOESC') {
            amp.autotune_phase = 'cancelled';
        } else if (line === 'AUTO:WAITING FOR INPUT POWER') {
            amp.autotune_phase = 'waiting';
        } else if (line === 'AUTO:AUTOTUNE IN PROGRESS') {
            amp.autotune_phase = 'tuning';
        } else if (line === 'AUTO:AUTOTUNE DONE') {
            amp.autotune_phase = 'succeeded';
        } else if (line === 'AUTO:AUTOTUNE ABORTED') {
            amp.autotune_phase = 'aborted';
        } else if (line === 'STOP') {
            amp.autotune_phase = 'stopped';
        }
        if (/^(LO|TU|OT)/.test(line)) amp.tuning = true;
        return true;
    }
    if (line === 'BADPSW') return true;

    return false;
}

/**
 * 流式解析。
 * 文本模式按 `;` 切 token；二进制降级模式优先识别 `0x3D…0x3B` 测量帧。
 * 返回 {recognized, tokens, measurements, protocol}。
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
        if (state.protocol === 'binary-legacy' && state.buffer[0] === OM_MEASUREMENT_START) {
            if (state.buffer.length < OM_MEASUREMENT_LEN) break;
            if (state.buffer[OM_MEASUREMENT_LEN - 1] !== OM_MEASUREMENT_END) {
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
            if (state.buffer.length > 1024) state.buffer = Buffer.alloc(0);
            break;
        }
        const raw = state.buffer.slice(0, end).toString('ascii');
        state.buffer = state.buffer.slice(end + 1);
        const token = raw.startsWith('^') ? raw.slice(1) : raw;
        if (!token) continue;
        tokens.push(token);
        if (applyOmToken(state.amp, token)) recognized = true;
    }
    return {recognized, tokens, measurements, protocol: state.protocol};
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
    if (state.quickTimer) clearInterval(state.quickTimer);
    state.timer = null;
    state.quickTimer = null;
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

function startPolling(global, device, state) {
    stopPolling(state);
    state.ready = true;
    state.tick = 0;
    state.last_freq_ms = 0;
    // 官方在连接时各发一次：状态、型号信息、频率控制源。
    writeText(state, '?');
    writeText(state, '1');
    writeText(state, 'J');
    state.timer = setInterval(() => {
        if (!state.ready || !state.connected || !state.socket) return;
        state.tick += 1;
        writeText(state, '#');
        if (Date.now() - state.last_freq_ms >= OM_FREQ_MS) {
            state.last_freq_ms = Date.now();
            writeText(state, 'F');
        }
        const nowMs = Date.now();
        if (state.last_rx_ms && nowMs - state.last_rx_ms > OM_DATA_TIMEOUT_MS) {
            markFailure(state, 'transport-timeout');
            return;
        }
        if (state.pending && nowMs - state.pending.sent_ms > OM_COMMAND_TIMEOUT_MS) {
            // 单条不重试；超时转「不确定」，等匹配的状态 token 才清除。
            state.uncertain = true;
            state.uncertain_action = state.pending.action;
            state.pending = null;
        }
    }, OM_POLL_MS);
    // `I` 只在发射中启用，避免空闲时刷屏。
    state.quickTimer = setInterval(() => {
        if (!state.ready || !state.connected || !state.socket) return;
        if (!state.amp.transmitting || state.pending || state.uncertain) return;
        writeText(state, 'I');
    }, OM_QUICK_MS);
}

function markFailure(state, error) {
    state.connected = false;
    state.ready = false;
    stopPolling(state);
    if (state.probeTimer) clearTimeout(state.probeTimer);
    if (state.connectTimer) clearTimeout(state.connectTimer);
    state.probeTimer = null;
    state.connectTimer = null;
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
    if (state.probeTimer) clearTimeout(state.probeTimer);
    if (state.connectTimer) clearTimeout(state.connectTimer);
    try { state.socket && state.socket.destroy(); } catch (ignored) { /* ignore */ }
    state.socket = null;
    state.connected = false;
    state.ready = false;
    if (clients.get(state.deviceId) === state) clients.delete(state.deviceId);
}

function confirmWanted(action, tokens) {
    const has = predicate => tokens.some(predicate);
    if (action === 'power_on') {
        return has(token => token === 'PAON' || /^WA\d+$/.test(token));
    }
    if (action === 'power_off') {
        return has(token => token === 'PAOFF' || token === 'COON' || /^CO\d+$/.test(token));
    }
    if (action === 'operate') return tokens.includes('OPERATE');
    if (action === 'standby') return tokens.includes('STBY');
    if (action === 'manual_tune') return tokens.includes('MAN');
    if (action === 'tune_step') {
        return has(token => /^(LO|TU|OT)-?\d+$/.test(token) || token === 'AUTO');
    }
    if (action === 'autotune') {
        return has(token => token === 'AUTO' || token.startsWith('AUTO:'));
    }
    return false;
}

function handlePending(state, tokens, nowMs) {
    if (!state.pending) return;
    const pending = state.pending;
    const has = wanted => tokens.some(token => token === wanted);

    if (pending.action === 'autotune') {
        if (pending.stage === 0) {
            if (has('AUTO')) {
                if (writeText(state, '&')) {
                    pending.stage = 1;
                    pending.sent_ms = nowMs;
                }
            } else if (tokens.some(token => token.startsWith('AUTO'))) {
                state.pending = null;
                state.uncertain = true;
                state.uncertain_action = 'autotune';
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

    if (confirmWanted(pending.action, tokens)) {
        state.pending = null;
        state.uncertain = false;
        state.uncertain_action = null;
    }
}

function beginConnect(state, global, device) {
    state.phase = 'connect';
    state.ready = false;
    state.connectAttempts = 0;
    const retry = () => {
        if (!state.connected || state.ready) return;
        if (state.connectAttempts >= OM_CONNECT_RETRIES) {
            markFailure(state, 'transport-connect');
            return;
        }
        state.connectAttempts += 1;
        writeText(state, 'C');
        state.connectTimer = setTimeout(retry, OM_CONNECT_RETRY_MS);
    };
    retry();
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
        phase: 'idle',
        protocol: 'unknown',
        buffer: Buffer.alloc(0),
        amp: blankOm(),
        tick: 0,
        timer: null,
        quickTimer: null,
        probeTimer: null,
        connectTimer: null,
        connectAttempts: 0,
        last_freq_ms: 0,
        pending: null,
        uncertain: false,
        uncertain_action: null,
        last_cmd_ms: 0,
        last_rx_ms: Date.now()
    };
    clients.set(device.id, state);

    socket.on('connect', () => {
        state.connected = true;
        state.last_rx_ms = Date.now();
        state.phase = 'probe';
        // 官方先发 `^` 探测文本协议；官方软件本身没有二进制帧。
        writeText(state, '^');
        state.probeTimer = setTimeout(() => {
            if (state.ready || !state.connected) return;
            if (state.protocol !== 'unknown') return;
            // 不是官方文本协议：降级到旧二进制实现，并明确标为未验证。
            state.protocol = 'binary-legacy';
            state.amp.protocol = 'binary-legacy';
            state.amp.protocol_verified = false;
            writeAmp(global, device, state);
            beginConnect(state, global, device);
        }, OM_PROBE_TIMEOUT_MS);
    });

    socket.on('data', chunk => {
        state.last_rx_ms = Date.now();
        const result = feedOm(state, chunk);
        if (result.recognized) writeAmp(global, device, state);

        if (result.tokens.includes('OK') && !state.ready) {
            if (state.probeTimer) clearTimeout(state.probeTimer);
            state.probeTimer = null;
            state.protocol = 'text';
            state.amp.protocol = 'text';
            state.amp.protocol_verified = true;
            writeAmp(global, device, state);
            if (state.phase === 'probe') beginConnect(state, global, device);
            return;
        }

        if (result.tokens.includes('COFF')) {
            if (state.ready) {
                // 已有远程会话被清除，先停下轮询，再补发 C 重建。
                stopPolling(state);
                state.ready = false;
                beginConnect(state, global, device);
            }
            return;
        }

        if (result.tokens.includes('CON')) {
            // 协议尚未判定时先记下 CON，等 `^` 探测超时后再决定走文本还是二进制。
            if (state.protocol === 'unknown') {
                state.saw_con = true;
                return;
            }
            if (state.connectTimer) clearTimeout(state.connectTimer);
            state.connectTimer = null;
            state.phase = 'ready';
            if (!state.ready) startPolling(global, device, state);
            return;
        }

        if (state.ready) {
            if (state.pending) handlePending(state, result.tokens, Date.now());
            if (state.uncertain && state.uncertain_action &&
                confirmWanted(state.uncertain_action, result.tokens)) {
                state.uncertain = false;
                state.uncertain_action = null;
            }
        }
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

function publish(global, device, delta, now) {
    const action = text(delta && delta.action);
    if (!ACTIONS.has(action)) {
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
    if (['entered', 'waiting', 'tuning', 'unknown'].includes(amp.autotune_phase)) {
        return Promise.resolve({ok: false, status: 409, error: 'device-busy'});
    }
    if (amp.manual_tune && !['tune_step', 'standby', 'power_off'].includes(action)) {
        return Promise.resolve({ok: false, status: 409, error: 'device-busy'});
    }
    // 命令必须建立在新鲜读数上，避免按过期状态误操作。
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
    if (action === 'autotune' && amp.status_text !== 'Operate') {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (action === 'manual_tune' && amp.status_text !== 'Operate') {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (action === 'tune_step' && !amp.manual_tune) {
        return Promise.resolve({ok: false, status: 409, error: 'invalid-state'});
    }
    if (nowMs - state.last_cmd_ms < OM_COMMAND_GAP_MS) {
        return Promise.resolve({ok: false, status: 409, error: 'rate-limited'});
    }
    if (!writeText(state, ACTION_BYTES[action])) {
        return Promise.resolve({ok: false, status: 502, error: 'transport-error'});
    }
    state.last_cmd_ms = nowMs;
    state.pending = {action, stage: 0, sent_ms: nowMs};
    return Promise.resolve({ok: true, dispatched: true, confirmed: false});
}

function resetForTests() {
    for (const state of clients.values()) {
        stopPolling(state);
        if (state.probeTimer) clearTimeout(state.probeTimer);
        if (state.connectTimer) clearTimeout(state.connectTimer);
        try { state.socket && state.socket.destroy(); } catch (ignored) { /* ignore */ }
    }
    clients.clear();
}

function setSocketFactory(factory) {
    socketFactory = typeof factory === 'function' ? factory : null;
}

module.exports = {
    OM_ACTIONS: ACTIONS,
    blankOm,
    omSwr,
    applyOmMeasurement,
    applyOmToken,
    feedOm,
    poll,
    retain,
    publish,
    resetForTests,
    setSocketFactory
};
