'use strict';

/**
 * 国赫 AMP1000 功放（MQTT JSON 协议）适配。
 *
 * 协议要点（见 docs/JSON 通信协议文档 v1.5.3）：
 *   - 传输：MQTT，一条 PUBLISH = 一个 JSON 对象；
 *   - 设备 → 服务器：`amplifier/device/{device_id}/heartbeat`，
 *     `cmd=remote_control`，data 为完整状态快照（含实时测量）；
 *   - 服务器 → 设备：`amplifier/device/{device_id}/json_command`，
 *     `cmd=remote_control`，data 为 delta（未提供的字段设备保持原值）。
 *
 * 只做状态回读与常规操作：不实现、不下发 §5.9 工程参数（校准/保护阈值/
 * 偏置增益等），任何可能写入设备校准数据的指令都不在本模块中出现。
 *
 * 连接状态是“在线/通信中断”的依据：协议心跳按变化去重，长时间静默是正常的，
 * 因此不能用“最近上报时间”判断离线，必须看 MQTT 连接本身。
 */

const runtime = require('./runtime.js');
const {bandOf} = require('../radio');

const DEFAULT_PREFIX = 'amplifier/device';
const DEFAULT_TOPIC_DEVICE = 'device_id';

/** 测试可注入的 MQTT 客户端工厂。 */
let clientFactory = null;
/** deviceId → {client, signature, connected} */
const clients = new Map();

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function int(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
}

function configOf(device) {
    return device && device.config && typeof device.config === 'object' ? device.config : {};
}

/** 地址、端口、设备 ID 齐全且协议为 MQTT 才算配置完整。 */
function configured(device) {
    if (!device || device.type !== 'amp') return false;
    const config = configOf(device);
    const protocol = text(config.protocol) || 'mqtt';
    return protocol === 'mqtt' && !!text(config.host) && Number.isFinite(Number(config.port)) &&
        !!text(config.device_id);
}

function prefixOf(device) {
    return text(configOf(device).topic_prefix) || DEFAULT_PREFIX;
}

/** 只有设备 ID 出现在主题里；缺 ID 时退回设备记录 id，避免订阅到通配主题。 */
function topicsFor(device) {
    const config = configOf(device);
    const id = text(config.device_id) || text(device && device.id) || DEFAULT_TOPIC_DEVICE;
    const prefix = prefixOf(device);
    return {command: `${prefix}/${id}/json_command`, heartbeat: `${prefix}/${id}/heartbeat`};
}

function signatureOf(device) {
    const config = configOf(device);
    return JSON.stringify([
        text(config.host), Number(config.port), text(config.device_id),
        prefixOf(device), text(config.username), text(config.password)
    ]);
}

function errorCode(error) {
    const code = text(error && error.code);
    if (code === 'ETIMEDOUT') return 'transport-timeout';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' ||
        code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'transport-connect';
    return 'transport-error';
}

/**
 * 把心跳 data 归一化成设备卡片要用的读数。
 * 数值按协议已是物理值；Pd c 由电压 × 电流计算。
 */
function normalizeAmp(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const voltage = num(data.current_voltage);
    const current = num(data.current_current);
    const workFreq = num(data.work_freq);
    const alarmWord = int(data.alarm_word);
    return {
        device_id: text(data.device_id),
        device_type: int(data.device_type),
        pa_switch: int(data.pa_switch),
        ptt_status: int(data.ptt_status),
        work_freq: workFreq,
        band: workFreq ? (bandOf(workFreq / 1000) || '') : '',
        tune_mode: int(data.tune_mode),
        trigger_mode: int(data.trigger_mode),
        freq_mode: int(data.freq_mode),
        freq_band_select: int(data.freq_band_select),
        in_antenna_sel: int(data.in_antenna_sel),
        out_antenna_sel: int(data.out_antenna_sel),
        output_ant_auto: data.output_ant_auto === true,
        attenuator_sel: int(data.attenuator_sel),
        attenuator_list: Array.isArray(data.attenuator_list)
            ? data.attenuator_list.map(Number).filter(Number.isFinite) : [],
        filter_sel: text(data.filter_sel),
        load_resistor: int(data.load_resistor),
        current_voltage: voltage,
        current_current: current,
        current_temperature: num(data.current_temperature),
        pdc: voltage !== null && current !== null ? Math.round(voltage * current * 100) / 100 : null,
        in_fwd_power: num(data.in_fwd_power),
        in_rev_power: num(data.in_rev_power),
        in_swr: num(data.in_swr),
        out_fwd_power: num(data.out_fwd_power),
        out_rev_power: num(data.out_rev_power),
        out_swr: num(data.out_swr),
        alarm_word: alarmWord,
        alarm_active: (alarmWord || 0) > 0,
        serial_connection: data.serial_connection === true,
        mqtt_connection: data.mqtt_connection === true,
        hamlib_connection: data.hamlib_connection === true,
        firmware_version: text(data.firmware_version),
        software_version: text(data.software_version)
    };
}

function nowDate(value) {
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
}

function onMessage(global, device, payload, now) {
    let message = null;
    try {
        message = JSON.parse(String(payload || '').trim());
    } catch (error) {
        return false;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
    if (text(message.cmd) && text(message.cmd) !== 'remote_control') return false;
    const data = message.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    // 主题里已经带了设备 ID；载荷再带一份时校验，避免串台。
    const expected = text(configOf(device).device_id);
    if (expected && text(data.device_id) && text(data.device_id) !== expected) return false;
    if (data.result === 'error') return false;
    const amp = normalizeAmp(data);
    if (!amp) return false;
    const at = nowDate(now);
    runtime.updateEntry(global, device.id, {
        amp,
        amp_ts: num(message.timestamp),
        last_report: at.toISOString(),
        last_report_ms: at.getTime(),
        reported_ms: at.getTime(),
        last_attempt_ms: at.getTime(),
        amp_connected: true,
        comm_error: null,
        comm_error_ms: null
    }, at);
    return true;
}

function drop(deviceId, client) {
    if (client) {
        try { client.removeAllListeners(); } catch (error) { /* ignore */ }
        try { client.end(true); } catch (error) { /* ignore */ }
    }
    clients.delete(deviceId);
}

function createClient(global, device) {
    const config = configOf(device);
    const options = {
        clientId: 'dxc-' + device.id,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 5000,
        protocolVersion: 4
    };
    if (text(config.username)) options.username = text(config.username);
    if (text(config.password)) options.password = text(config.password);
    const url = `mqtt://${text(config.host)}:${Number(config.port)}`;
    const client = clientFactory ? clientFactory(url, options) : require('mqtt').connect(url, options);
    const state = {client, signature: signatureOf(device), connected: false};
    clients.set(device.id, state);

    const markFailure = error => {
        state.connected = false;
        const at = new Date();
        runtime.updateEntry(global, device.id, {
            amp_connected: false,
            last_attempt_ms: at.getTime(),
            comm_error: errorCode(error),
            comm_error_ms: at.getTime()
        }, at);
    };

    client.on('connect', () => {
        state.connected = true;
        const at = new Date();
        try { client.subscribe(topicsFor(device).heartbeat, {qos: 0}); } catch (error) { /* ignore */ }
        runtime.updateEntry(global, device.id, {
            amp_connected: true,
            last_attempt_ms: at.getTime(),
            comm_error: null,
            comm_error_ms: null
        }, at);
    });
    client.on('message', (topic, payload) => {
        if (topic !== topicsFor(device).heartbeat) return;
        onMessage(global, device, payload, new Date());
    });
    client.on('error', markFailure);
    client.on('close', () => markFailure({code: 'ECONNRESET'}));
    client.on('offline', () => markFailure({code: 'ECONNRESET'}));
    return state;
}

/**
 * 由现有 2 秒定时器调用：按设备配置建立/维持 MQTT 连接。
 * 协议本身是推送式，不需要轮询状态；这里只保证连接存在并清理失效连接。
 */
function pollAmps(global, devices, now) {
    const at = nowDate(now);
    const wanted = new Set();
    let connected = 0;
    const errors = [];
    for (const device of Array.isArray(devices) ? devices : []) {
        if (!device || device.type !== 'amp' || !device.enabled) continue;
        if (!configured(device)) {
            const existing = clients.get(device.id);
            if (existing) drop(device.id, existing.client);
            continue;
        }
        wanted.add(device.id);
        const signature = signatureOf(device);
        const existing = clients.get(device.id);
        if (existing && existing.signature !== signature) drop(device.id, existing.client);
        const state = clients.get(device.id) || createClient(global, device);
        if (state.connected) connected += 1;
        else errors.push({device_id: device.id, error: 'transport-connect'});
    }
    for (const [deviceId, state] of [...clients.entries()]) {
        if (wanted.has(deviceId)) continue;
        drop(deviceId, state.client);
    }
    return {ok: true, connected, errors, at: at.toISOString()};
}

/** 下发一条 remote_control delta；只允许调用方已经白名单校验过的字段。 */
function publish(device, delta, now) {
    const state = clients.get(device && device.id);
    if (!state || !state.connected) {
        return Promise.resolve({ok: false, status: 502, error: 'transport-connect'});
    }
    const at = nowDate(now);
    const data = Object.assign({}, delta || {});
    const deviceId = text(configOf(device).device_id);
    if (deviceId) data.device_id = deviceId;
    const message = {
        msg_id: 'dxc-' + at.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
        cmd: 'remote_control',
        timestamp: Math.floor(at.getTime() / 1000),
        data
    };
    return new Promise(resolve => {
        try {
            state.client.publish(topicsFor(device).command, JSON.stringify(message), {qos: 0}, error => {
                if (error) resolve({ok: false, status: 502, error: 'transport-error'});
                else resolve({ok: true, dispatched: true});
            });
        } catch (error) {
            resolve({ok: false, status: 502, error: 'transport-error'});
        }
    });
}

function setClientFactory(factory) {
    clientFactory = typeof factory === 'function' ? factory : null;
}

function resetForTests() {
    for (const [deviceId, state] of [...clients.entries()]) drop(deviceId, state.client);
    clientFactory = null;
}

module.exports = {
    DEFAULT_PREFIX,
    configured,
    topicsFor,
    normalizeAmp,
    pollAmps,
    publish,
    setClientFactory,
    resetForTests,
    onMessage
};
