'use strict';

/**
 * 切换器 / 矩阵切换器协议适配。
 *
 * 只实现调研中确认过帧格式的型号；帧构造与解析全部是纯函数，便于单测。
 * 状态语义：
 *   - readback 型号：下发后为 pending，轮询回读确认后才写 ports 并标 verified；
 *   - 只写型号：永远不写 ports，只记录 commanded，状态为 unverified；
 *   - 通信中断：保留最后一次回读，标 stale + unknown。
 *
 * Antenna Genius 同时兼容两种固件：
 *   - v4 ASCII API（C<seq>|port get/set、antenna list、band list）；
 *   - 调研 flow 中的旧二进制帧 !LLLL!BBBBBB!payload。
 */

const net = require('net');
const dgram = require('dgram');
const runtime = require('./runtime.js');
const control = require('./control.js');
const switchModels = require('./switch-models.js');

const AG_DEFAULT_PORT = 9007;
const ZSERVER_COMMAND_PORT = 50333;
const ZSERVER_STATUS_PORT = 50334;
const AG_PROLOGUE_MS = 500;
const AG_LEGACY_POLL = [0x401, 0x412, 0x082];
const AMPLITEC_QUERY = [Buffer.from([0x01, 0x01, 0x44, 0x0D]), Buffer.from([0x01, 0x01, 0x52, 0x0D])];
const STATION_GENIUS_KEYS = ['7', '8', '9', '/', '*', '-', '0'];

let socketFactory = null;
let udpFactory = null;
let mqttFactory = null;

/** deviceId → TCP 会话 */
const links = new Map();
/** deviceId → MQTT 会话 */
const mqttLinks = new Map();
/** deviceId → 最近一次 MQTT 输出，供 Six2Two 关闭旧通路 */
const six2twoState = new Map();

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function configOf(device) {
    return device && device.config && typeof device.config === 'object' ? device.config : {};
}

function nowDate(value) {
    return value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
}

function portNumber(key) {
    const value = text(key).toLowerCase();
    if (value === 'in') return 1;
    const match = /^(?:in|out|ant)(\d{1,2})$/.exec(value);
    return match ? Number(match[1]) : null;
}

function outletKey(device, number) {
    return String(device && device.type).toLowerCase() === 'switch' ? 'ant' + number : 'out' + number;
}

function inputKey(device, number) {
    return String(device && device.type).toLowerCase() === 'switch' ? 'in' : 'in' + number;
}

// ---- Antenna Genius 旧二进制帧 ----

/** 24 位头：protocol(3) | method(2) | command(12) | revision(5) | error(2)。 */
function agHeader(command, options) {
    const opts = options || {};
    const method = Number.isInteger(opts.method) ? opts.method : 0;
    const revision = Number.isInteger(opts.revision) ? opts.revision : 0;
    const error = Number.isInteger(opts.error) ? opts.error : 0;
    return ((opts.protocol || 0) << 21) | (method << 19) | ((command & 0xFFF) << 7) |
        ((revision & 0x1F) << 2) | (error & 0x03);
}

function agFrame(command, payload, options) {
    const body = payload === undefined || payload === null ? '' : String(payload);
    const length = Buffer.byteLength(body, 'ascii');
    return '!' + length.toString(16).toUpperCase().padStart(4, '0') + '!' +
        agHeader(command, options).toString(16).toUpperCase().padStart(6, '0') + '!' + body;
}

/**
 * 从流式缓冲中切出完整帧。
 * @returns {{frames: Array, rest: string}}
 */
function parseAgFrames(buffer) {
    let rest = String(buffer === undefined || buffer === null ? '' : buffer);
    const frames = [];
    while (rest.length) {
        const first = rest.indexOf('!');
        if (first < 0) break;
        if (first > 0) rest = rest.slice(first);
        const lengthMatch = /^!([0-9A-Fa-f]{4})!/.exec(rest);
        if (!lengthMatch) break;
        const headerMatch = /^![0-9A-Fa-f]{4}!([0-9A-Fa-f]{6})!/.exec(rest);
        if (!headerMatch) break;
        const length = parseInt(lengthMatch[1], 16);
        const header = parseInt(headerMatch[1], 16);
        const start = lengthMatch[0].length + headerMatch[1].length + 1;
        if (rest.length < start + length) break;
        frames.push({
            length,
            header,
            protocol: (header >> 21) & 0x07,
            method: (header >> 19) & 0x03,
            command: (header >> 7) & 0x0FFF,
            revision: (header >> 2) & 0x1F,
            error: header & 0x03,
            payload: rest.slice(start, start + length)
        });
        rest = rest.slice(start + length);
    }
    return {frames, rest};
}

/** 0x401 回读：按 7 字段块（端口/模式/波段/禁止/天线/配置/发射）容错解析。 */
function parseAgPortStatus(payload) {
    const parts = String(payload || '').split(';').map(text).filter(item => item !== '');
    const ports = {};
    const take = (offset) => {
        const port = Number(parts[offset]);
        const antenna = Number(parts[offset + 4]);
        if ((port === 1 || port === 2) && Number.isFinite(antenna) && antenna >= 0) {
            ports['in' + port] = antenna > 0 ? 'out' + antenna : null;
        }
    };
    if (parts.length >= 14) {
        take(0);
        take(7);
    } else if (parts.length >= 5) {
        take(0);
    }
    return ports;
}

function maskBands(mask, bands) {
    const value = parseInt(String(mask || '0'), 16);
    if (!Number.isFinite(value)) return [];
    const list = [];
    for (let i = 0; i < 16; i += 1) {
        if ((value >> i) & 1) {
            const band = bands.find(item => Number(item.index) === i);
            if (band && band.name) list.push(band.name);
        }
    }
    return list;
}

/** 0x412：index;name;mode;bands 位图（hex）。 */
function parseAgAntennaLine(line) {
    const parts = String(line || '').split(';').map(text);
    if (parts.length < 4) return null;
    const index = Number(parts[0]);
    if (!Number.isFinite(index) || index < 1) return null;
    return {index, name: parts[1], mode: Number(parts[2]) || 0, mask: parts[3]};
}

function parseAgAntennaPayload(payload) {
    return String(payload || '').split(/[\r\n|]+/)
        .map(parseAgAntennaLine)
        .filter(Boolean);
}

/** 0x082：index;name;lowerHz;upperHz。 */
function parseAgBandLine(line) {
    const parts = String(line || '').split(';').map(text);
    if (parts.length < 4) return null;
    const index = Number(parts[0]);
    if (!Number.isFinite(index)) return null;
    return {index, name: parts[1], lowerHz: Number(parts[2]), upperHz: Number(parts[3])};
}

function parseAgBandPayload(payload) {
    return String(payload || '').split(/[\r\n|]+/)
        .map(parseAgBandLine)
        .filter(Boolean);
}

// ---- Antenna Genius v4 ASCII ----

function agV4Command(seq, command) {
    return 'C' + seq + '|' + command + '\r';
}

function parseAgV4Line(line) {
    const value = text(line);
    let match = /^R\d+\|([0-9A-Fa-f]+)\|(.*)$/.exec(value);
    if (match) {
        return {kind: 'response', error: parseInt(match[1], 16) || 0, message: text(match[2])};
    }
    match = /^S\d+\|(.*)$/.exec(value);
    if (match) return {kind: 'status', message: text(match[1])};
    return null;
}

function parseAgV4Band(message) {
    const match = /^band\s+(\d+)\s+name=(\S*)\s+freq_start=([\d.]+)\s+freq_stop=([\d.]+)/i.exec(message);
    if (!match) return null;
    return {index: Number(match[1]), name: match[2], lowerHz: Math.round(Number(match[3]) * 1e6),
        upperHz: Math.round(Number(match[4]) * 1e6)};
}

function parseAgV4Antenna(message) {
    const match = /^antenna\s+(\d+)\s+name=(\S*)\s+tx=([0-9A-Fa-f]+)\s+rx=([0-9A-Fa-f]+)\s+inband=([0-9A-Fa-f]+)/i
        .exec(message);
    if (!match) return null;
    return {index: Number(match[1]), name: match[2], tx: match[3], rx: match[4], inband: match[5]};
}

function parseAgV4Port(message) {
    const match = /^port\s+(\d+)\b(.*)$/i.exec(message);
    if (!match) return null;
    const body = match[2];
    const rx = /rxant=(\d+)/i.exec(body);
    const tx = /txant=(\d+)/i.exec(body);
    const antenna = Number(rx ? rx[1] : (tx ? tx[1] : 0));
    return {port: Number(match[1]), antenna: Number.isFinite(antenna) ? antenna : 0};
}

// ---- ZSERVER ----

function zserverCommand(switchId, radio, antenna) {
    return JSON.stringify({
        name: 'zserver',
        command: 'set_antenna',
        id: switchId,
        radio,
        antenna
    });
}

/** 状态 JSON 容错解析：只接受能确定 radio/antenna 的形状。 */
function parseZserverStatus(payload) {
    let data = payload;
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
        try { data = JSON.parse(String(payload)); } catch (error) { return null; }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const id = data.id === undefined ? '' : text(data.id);
    const radio = Number(data.radio);
    const antenna = Number(data.antenna);
    if (Number.isFinite(radio) && radio >= 1 && Number.isFinite(antenna) && antenna >= 0) {
        return {id, host: text(data.HOST || data.host), radio, antenna};
    }
    const table = data.antennas || data.ports;
    if (table && typeof table === 'object' && !Array.isArray(table)) {
        const entries = Object.keys(table)
            .map(key => ({radio: Number(key), antenna: Number(table[key])}))
            .filter(item => Number.isFinite(item.radio) && item.radio >= 1 &&
                Number.isFinite(item.antenna) && item.antenna >= 0);
        if (entries.length) return {id, host: text(data.HOST || data.host), entries};
    }
    return null;
}

// ---- Green Heron ----

function greenHeronFrame(switchId, radio, antenna) {
    const parts = [Buffer.from('SET_SWITCH'), Buffer.from(text(switchId) || 'SW1'),
        Buffer.from('Radio-' + Number(radio)), Buffer.from([0x1F]),
        Buffer.from(String(Number(antenna))), Buffer.from('\r\n')];
    return Buffer.concat(parts);
}

function parseGreenHeronStatus(line) {
    const value = text(line);
    if (!/SWITCHUPDATE/i.test(value)) return null;
    const radio = /Radio-?(\d+)/i.exec(value);
    const antenna = /(?:ant|antenna)[ =:]?(\d+)/i.exec(value) || /(\d+)\s*$/.exec(value);
    if (!radio || !antenna) return null;
    return {radio: Number(radio[1]), antenna: Number(antenna[1])};
}

// ---- wa4mcm ----

function wa4mcmFrame(kind, value) {
    if (kind === 'select') return 'A' + value + '\r\n';
    if (kind === 'query') return 'A?\r\n';
    if (kind === 'mode') return 'MT\r\n';
    if (kind === 'modeQuery') return 'M?\r\n';
    return '';
}

function parseWa4mcmLine(line) {
    const value = text(line).toUpperCase();
    const match = /^A([1-4])$/.exec(value);
    if (match) return {antenna: Number(match[1])};
    if (value === 'MA' || value === 'MM') return {mode: value === 'MA' ? 'auto' : 'manual'};
    return null;
}

// ---- Amplitec ----

/**
 * Amplitec 状态帧解析。
 *
 * 调研只记录了「读状态 0101520D」和 remote/manual + 开关位置这两个语义，
 * 没有帧结构或厂商文档；下面的“0x52 0x0D 后取末尾两字节”是推断。
 * 因此该型号在型号表中标记为 verified:false，界面按协议未验证提示。
 */
function parseAmplitecStatus(buffer) {
    const bytes = Buffer.isBuffer(buffer) ? [...buffer] : Array.from(buffer || []);
    if (!bytes.length) return null;
    // 状态帧以 0x52 0x0D 标识；取末尾两个有效字节作为 mode / 位置。
    const marker = bytes.findIndex((byte, index) => byte === 0x52 && bytes[index + 1] === 0x0D);
    if (marker < 0) return null;
    const tail = bytes.slice(marker + 2).filter(byte => byte !== 0x0D && byte !== 0x0A);
    if (tail.length < 2) return null;
    const mode = tail[tail.length - 2];
    const position = tail[tail.length - 1];
    if (position < 1 || position > 6) return null;
    return {mode: mode === 0 ? 'remote' : 'manual', position};
}

// ---- Array Solutions RCS-4 ----

/**
 * Array Solutions RCS-4 的继电器帧。
 *
 * 注意：调研资料只给出「4 字节，0xA0/port/state/checksum」这一描述，
 * 没有厂商文档或抓包佐证；校验和按 (0xA0+port+state)&0xFF 计算同样是推断。
 * 因此该型号在型号表中标记为 protocol_verified:false，下发后状态只能是未验证。
 */
function rcs4Frame(port, on) {
    const state = on ? 1 : 0;
    return Buffer.from([0xA0, port & 0xFF, state, (0xA0 + (port & 0xFF) + state) & 0xFF]);
}

// ---- 4O3A Station Genius ----

function stationGeniusFrame(key) {
    const frame = Buffer.alloc(64, 0);
    frame[0] = 0x80;
    frame[1] = typeof key === 'number' ? key : String(key || '0').charCodeAt(0);
    return frame;
}

function stationGeniusConnectFrame() {
    const frame = Buffer.alloc(64, 0);
    frame[0] = 0x89;
    return frame;
}

function stationGeniusKeepaliveFrame() {
    const frame = Buffer.alloc(64, 0);
    frame[0] = 0x84;
    return frame;
}

function stationGeniusKey(device, outletNumber) {
    const map = configOf(device).key_map;
    const fallback = STATION_GENIUS_KEYS[outletNumber - 1] || '0';
    if (Array.isArray(map) && map[outletNumber - 1] !== undefined) return map[outletNumber - 1];
    return fallback;
}

// ---- RemoteQTH Six2Two ----

function six2twoTopic(prefix, inNumber, outNumber) {
    return text(prefix || 'remoteqth') + '/' + inNumber + '_' + outNumber;
}

// ---- 运行时状态 ----

function switchState(global, device) {
    const entry = runtime.stateOf(global, device.id);
    return {
        entry: entry || {},
        prev: entry && entry.switch && typeof entry.switch === 'object' ? entry.switch : {}
    };
}

function writeSwitch(global, device, patch, at) {
    const {prev} = switchState(global, device);
    const state = Object.assign({}, prev, patch);
    state.model = text(configOf(device).model);
    state.protocol = switchModels.protocolOf(configOf(device), device.type);
    state.readback = switchModels.readbackOf(configOf(device), device.type);
    const stamp = nowDate(at);
    runtime.updateEntry(global, device.id, {
        switch: state,
        last_report: stamp.toISOString(),
        last_report_ms: stamp.getTime(),
        last_attempt_ms: stamp.getTime()
    }, stamp);
    return state;
}

function writeVerifiedPorts(global, device, ports, patch, at) {
    const {prev} = switchState(global, device);
    const merged = Object.assign({}, prev.ports || {}, ports || {});
    return writeSwitch(global, device, Object.assign({
        state: 'verified',
        ports: merged,
        stale: false,
        error: null,
        last_readback_ms: nowDate(at).getTime()
    }, patch || {}), at);
}

function writeFailure(global, device, error, at) {
    const {prev} = switchState(global, device);
    const state = prev.state === 'unverified' ? 'unverified' : 'unknown';
    return writeSwitch(global, device, {
        state,
        stale: true,
        error: error || 'transport-error',
        online: false
    }, at);
}

function writeOnline(global, device, at, patch) {
    const stamp = nowDate(at);
    runtime.updateEntry(global, device.id, {
        last_report: stamp.toISOString(),
        last_report_ms: stamp.getTime(),
        last_attempt_ms: stamp.getTime(),
        comm_error: null,
        comm_error_ms: null
    }, stamp);
    return writeSwitch(global, device, Object.assign({online: true, error: null}, patch || {}), stamp);
}

// ---- TCP 会话 ----

function addressOf(device, options) {
    const opts = options || {};
    return control.resolveFor(device, {
        devices: Array.isArray(opts.devices) ? opts.devices : [device],
        links: Array.isArray(opts.links) ? opts.links : []
    });
}

function signatureOf(device) {
    const config = configOf(device);
    return JSON.stringify([text(config.host), Number(config.port), text(config.model)]);
}

function drop(deviceId) {
    const state = links.get(deviceId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    if (state.modeTimer) clearTimeout(state.modeTimer);
    if (state.reprobeTimer) clearTimeout(state.reprobeTimer);
    try { state.socket && state.socket.destroy(); } catch (error) { /* ignore */ }
    links.delete(deviceId);
}

function createSocket() {
    return socketFactory ? socketFactory() : new net.Socket();
}

function connect(global, device, options) {
    const address = addressOf(device, options);
    if (!address || !address.host || !Number.isFinite(Number(address.port))) return null;
    const signature = signatureOf(device);
    const existing = links.get(device.id);
    if (existing && existing.signature === signature) return existing;
    if (existing) drop(device.id);

    const socket = createSocket();
    const state = {
        socket,
        signature,
        connected: false,
        buffer: '',
        mode: null,
        seq: 0,
        pollIndex: 0,
        timer: null,
        kind: switchModels.transportOf(configOf(device), device.type)
    };
    links.set(device.id, state);

    socket.on('connect', () => {
        state.connected = true;
        writeOnline(global, device, new Date(), {state: 'unknown'});
        if (state.kind === 'ag-tcp') {
            // 主动发一条 v4 无害探测；按回包判定，而不是干等 banner 超时。
            agProbe(state);
            state.modeTimer = setTimeout(() => {
                if (!state.mode && state.connected) {
                    state.mode = 'legacy';
                    writeSwitch(global, device, {ag_mode: 'legacy'}, new Date());
                    // 判成 legacy 后保留一次探活重判机会，防止 v4 回包晚到。
                    state.reprobeTimer = setTimeout(() => {
                        if (state.mode === 'legacy' && state.connected && !state.reprobeDone) {
                            state.reprobeDone = true;
                            agProbe(state);
                        }
                    }, 5000);
                    if (state.reprobeTimer && typeof state.reprobeTimer.unref === 'function') {
                        state.reprobeTimer.unref();
                    }
                    agLegacyPoll(global, device, state);
                }
            }, AG_PROLOGUE_MS);
            if (state.modeTimer && typeof state.modeTimer.unref === 'function') state.modeTimer.unref();
        } else if (state.kind === 'station-genius-tcp') {
            try { socket.write(stationGeniusConnectFrame()); } catch (error) { /* ignore */ }
        } else if (state.kind === 'wa4mcm-tcp') {
            try { socket.write(wa4mcmFrame('query')); } catch (error) { /* ignore */ }
        } else if (state.kind === 'amplitec-tcp') {
            try { socket.write(AMPLITEC_QUERY[0]); } catch (error) { /* ignore */ }
        }
    });
    socket.on('data', chunk => {
        if (state.kind === 'amplitec-tcp') {
            // 二进制协议必须按字节累积，String/chunk + latin1 会破坏 >0x7F 的字节。
            const previous = Buffer.isBuffer(state.buffer) ? state.buffer : Buffer.alloc(0);
            state.buffer = Buffer.concat([previous, chunk]);
            if (state.buffer.length > 4096) state.buffer = state.buffer.slice(-256);
        } else {
            state.buffer += String(chunk);
            if (state.buffer.length > 65536) state.buffer = '';
        }
        handleData(global, device, state, new Date());
    });
    socket.on('error', error => {
        state.connected = false;
        writeFailure(global, device, error && error.code === 'ETIMEDOUT'
            ? 'transport-timeout' : 'transport-connect', new Date());
        drop(device.id);
    });
    socket.on('close', () => {
        state.connected = false;
        writeFailure(global, device, 'transport-connect', new Date());
        if (links.get(device.id) === state) links.delete(device.id);
    });
    try {
        socket.connect(Number(address.port), address.host);
    } catch (error) {
        try { socket.connect(Number(address.port), address.host); } catch (ignored) { /* ignore */ }
    }
    return state;
}

function handleData(global, device, state, at) {
    const kind = state.kind;
    if (kind === 'ag-tcp') {
        handleAgData(global, device, state, at);
        return;
    }
    if (kind === 'wa4mcm-tcp') {
        state.buffer = handleLines(state.buffer, line => {
            const parsed = parseWa4mcmLine(line);
            if (!parsed) return;
            if (parsed.antenna) {
                writeVerifiedPorts(global, device, {in: outletKey(device, parsed.antenna)}, {}, at);
            }
        });
        return;
    }
    if (kind === 'greenheron-tcp') {
        state.buffer = handleLines(state.buffer, line => {
            const parsed = parseGreenHeronStatus(line);
            if (!parsed) return;
            writeVerifiedPorts(global, device, {
                [inputKey(device, parsed.radio)]: outletKey(device, parsed.antenna)
            }, {}, at);
        });
        return;
    }
    if (kind === 'amplitec-tcp') {
        const buffer = Buffer.isBuffer(state.buffer) ? state.buffer : Buffer.from(state.buffer || '', 'latin1');
        const parsed = parseAmplitecStatus(buffer);
        if (parsed) {
            state.buffer = Buffer.alloc(0);
            writeVerifiedPorts(global, device, {in: outletKey(device, parsed.position)},
                {amplitec: parsed}, at);
        } else if (buffer.length > 128) {
            state.buffer = Buffer.alloc(0);
        }
    }
}

/** 按 \r/\n 切行；返回未完成的尾部。 */
function handleLines(buffer, onLine) {
    const parts = String(buffer || '').split(/[\r\n]+/);
    const rest = parts.pop() || '';
    for (const line of parts) {
        if (text(line)) onLine(line);
    }
    return rest;
}

function setAgMode(state, mode) {
    state.mode = mode;
    if (state.modeTimer) {
        clearTimeout(state.modeTimer);
        state.modeTimer = null;
    }
    if (state.reprobeTimer) {
        clearTimeout(state.reprobeTimer);
        state.reprobeTimer = null;
    }
}

function agProbe(state) {
    if (!state || !state.connected || !state.socket) return;
    state.seq = (state.seq % 255) + 1;
    try { state.socket.write(agV4Command(state.seq, 'band list')); } catch (error) { /* ignore */ }
}

function handleAgData(global, device, state, at) {
    const buffer = state.buffer;
    const looksV4 = /V\d+\.\d+\.\d+\s+AG/i.test(buffer) ||
        /(^|[\r\n])R\d+\|/.test(buffer) || /(^|[\r\n])S\d+\|/.test(buffer);
    const looksLegacy = /![0-9A-Fa-f]{4}![0-9A-Fa-f]{6}!/.test(buffer);
    if (!state.mode) {
        if (looksV4) {
            setAgMode(state, 'v4');
            writeSwitch(global, device, {ag_mode: 'v4'}, at);
            // 保留同一包里已经到达的 R/S 响应，只去掉 banner。
            state.buffer = state.buffer.replace(/^V\d+\.\d+\.\d+\s+AG\s*/i, '');
            if (!state.buffer.trim()) {
                agV4Poll(global, device, state);
                return;
            }
        } else if (looksLegacy) {
            setAgMode(state, 'legacy');
            writeSwitch(global, device, {ag_mode: 'legacy'}, at);
        }
    } else if (state.mode === 'legacy' && looksV4) {
        // 探活回包晚到：从 legacy 切回 v4，并保留这包响应。
        setAgMode(state, 'v4');
        writeSwitch(global, device, {ag_mode: 'v4'}, at);
        state.buffer = state.buffer.replace(/^V\d+\.\d+\.\d+\s+AG\s*/i, '');
        if (!state.buffer.trim()) {
            agV4Poll(global, device, state);
            return;
        }
    }
    if (!state.mode) return;
    if (state.mode === 'v4') {
        state.buffer = handleLines(state.buffer, line => {
            const parsed = parseAgV4Line(line);
            if (!parsed) return;
            const {prev} = switchState(global, device);
            const bands = (prev.bands || []).slice();
            const antennas = (prev.antennas || []).slice();
            const band = parseAgV4Band(parsed.message);
            if (band) {
                const index = bands.findIndex(item => item.index === band.index);
                if (index >= 0) bands[index] = band; else bands.push(band);
            }
            const antenna = parseAgV4Antenna(parsed.message);
            if (antenna) {
                const index = antennas.findIndex(item => item.index === antenna.index);
                if (index >= 0) antennas[index] = antenna; else antennas.push(antenna);
            }
            const port = parseAgV4Port(parsed.message);
            if (port) {
                const ports = {};
                if (port.antenna > 0) ports['in' + port.port] = 'out' + port.antenna;
                writeVerifiedPorts(global, device, ports, {v4: true}, at);
            }
            if (band || antenna) {
                const expanded = antennas.map(item => Object.assign({}, item, {
                    bands: maskBands(item.rx || item.tx || item.mask, bands)
                }));
                writeSwitch(global, device, {
                    bands: bands.sort((a, b) => a.index - b.index),
                    antennas: expanded.sort((a, b) => a.index - b.index),
                    source: 'device',
                    v4: true
                }, at);
            }
        });
        return;
    }
    const parsed = parseAgFrames(state.buffer);
    state.buffer = parsed.rest;
    if (!parsed.frames.length) return;
    const {prev} = switchState(global, device);
    const bands = (prev.bands || []).slice();
    const antennas = (prev.antennas || []).slice();
    let changed = false;
    for (const frame of parsed.frames) {
        if (frame.method !== 1) continue;
        if (frame.command === 0x401) {
            const ports = parseAgPortStatus(frame.payload);
            if (Object.keys(ports).length) writeVerifiedPorts(global, device, ports, {}, at);
        } else if (frame.command === 0x412) {
            for (const item of parseAgAntennaPayload(frame.payload)) {
                const index = antennas.findIndex(entry => entry.index === item.index);
                const row = {index: item.index, name: item.name, mode: item.mode, mask: item.mask};
                if (index >= 0) antennas[index] = row; else antennas.push(row);
                changed = true;
            }
        } else if (frame.command === 0x082) {
            for (const item of parseAgBandPayload(frame.payload)) {
                const index = bands.findIndex(entry => entry.index === item.index);
                if (index >= 0) bands[index] = item; else bands.push(item);
                changed = true;
            }
        }
    }
    if (changed) {
        const expanded = antennas.map(item => Object.assign({}, item, {
            bands: maskBands(item.mask || item.rx || item.tx, bands)
        }));
        writeSwitch(global, device, {
            bands: bands.sort((a, b) => a.index - b.index),
            antennas: expanded.sort((a, b) => a.index - b.index),
            source: 'device'
        }, at);
    }
}

function agLegacyPoll(global, device, state) {
    if (!state.connected) return;
    const command = AG_LEGACY_POLL[state.pollIndex % AG_LEGACY_POLL.length];
    state.pollIndex += 1;
    try { state.socket.write(agFrame(command, '')); } catch (error) { /* ignore */ }
}

function agV4Poll(global, device, state) {
    if (!state.connected) return;
    state.seq = (state.seq % 255) + 1;
    const seq = state.seq;
    const commands = ['band list', 'antenna list', 'port get 1', 'port get 2'];
    const command = commands[state.pollIndex % commands.length];
    state.pollIndex += 1;
    try { state.socket.write(agV4Command(seq, command)); } catch (error) { /* ignore */ }
}

// ---- ZSERVER UDP ----

/** 状态接收器按端口分组：不同设备可以用不同 status_port。 */
const udpReceivers = new Map();

function zserverStatusPort(device) {
    const value = Number(configOf(device).status_port);
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : ZSERVER_STATUS_PORT;
}

function ensureUdp(device, global) {
    const port = zserverStatusPort(device);
    let receiver = udpReceivers.get(port);
    if (!receiver) {
        const socket = udpFactory ? udpFactory() : dgram.createSocket('udp4');
        receiver = {socket, port, devices: new Map(), globals: new Map(), error: null};
        udpReceivers.set(port, receiver);
        socket.on('message', message => {
            const parsed = parseZserverStatus(message);
            if (!parsed) return;
            for (const [deviceId, registered] of receiver.devices) {
                const config = configOf(registered);
                if (parsed.id && text(config.switch_id) && parsed.id !== text(config.switch_id)) continue;
                if (parsed.host && text(config.host) && parsed.host !== text(config.host)) continue;
                const ports = {};
                if (parsed.entries) {
                    for (const entry of parsed.entries) {
                        if (entry.antenna > 0) ports['in' + entry.radio] = 'out' + entry.antenna;
                    }
                } else if (parsed.antenna > 0) {
                    ports['in' + parsed.radio] = 'out' + parsed.antenna;
                }
                const owner = receiver.globals.get(deviceId);
                if (owner) writeVerifiedPorts(owner, registered, ports, {}, new Date());
            }
        });
        socket.on('error', error => {
            receiver.error = (error && (error.code || error.message)) || 'udp-error';
            // 绑定失败必须留下排障线索，不能静默失去回读。
            console.warn('[switch] ZSERVER status port ' + port + ' unavailable: ' + receiver.error);
            for (const [deviceId, registered] of receiver.devices) {
                const owner = receiver.globals.get(deviceId);
                if (owner) writeFailure(owner, registered, 'zserver-status-port:' + receiver.error, new Date());
            }
        });
        try {
            socket.bind(port);
        } catch (error) {
            receiver.error = (error && (error.code || error.message)) || 'udp-bind-error';
            console.warn('[switch] ZSERVER status port ' + port + ' bind failed: ' + receiver.error);
        }
    }
    if (device) {
        receiver.devices.set(device.id, device);
        if (global) receiver.globals.set(device.id, global);
    }
    return receiver;
}

function zserverSend(device, payload, options) {
    const receiver = ensureUdp(device, options && options.global);
    const address = addressOf(device, options);
    if (!address || !address.host) return Promise.resolve({ok: false, status: 400, error: 'transport-not-configured'});
    return new Promise(resolve => {
        try {
            receiver.socket.send(Buffer.from(payload), Number(address.port) || ZSERVER_COMMAND_PORT, address.host,
                error => resolve(error
                    ? {ok: false, status: 502, error: 'transport-error'}
                    : {ok: true, dispatched: true, readback: true, status_error: receiver.error || null}));
        } catch (error) {
            resolve({ok: false, status: 502, error: 'transport-error'});
        }
    });
}

// ---- MQTT（RemoteQTH Six2Two） ----

function mqttConfig(device) {
    const config = configOf(device);
    return {
        host: text(config.host),
        port: Number(config.port) || 1883,
        prefix: text(config.topic_prefix) || 'remoteqth',
        username: text(config.username),
        password: text(config.password)
    };
}

function mqttClient(global, device) {
    const config = mqttConfig(device);
    if (!config.host) return null;
    const signature = JSON.stringify([config.host, config.port, config.prefix, config.username, config.password]);
    const existing = mqttLinks.get(device.id);
    if (existing && existing.signature === signature) return existing;
    if (existing) {
        try { existing.client.end(true); } catch (error) { /* ignore */ }
        mqttLinks.delete(device.id);
    }
    const options = {clientId: 'dxc-sw-' + device.id, clean: true, connectTimeout: 5000, reconnectPeriod: 5000};
    if (config.username) options.username = config.username;
    if (config.password) options.password = config.password;
    const url = `mqtt://${config.host}:${config.port}`;
    const client = mqttFactory ? mqttFactory(url, options) : require('mqtt').connect(url, options);
    const state = {client, signature, connected: false, global};
    mqttLinks.set(device.id, state);
    client.on('connect', () => {
        state.connected = true;
        writeOnline(global, device, new Date(), {state: 'unverified'});
    });
    client.on('error', () => { state.connected = false; });
    client.on('close', () => { state.connected = false; });
    return state;
}

function mqttPublish(state, topic, payload) {
    return new Promise(resolve => {
        try {
            state.client.publish(topic, String(payload), {qos: 0}, error => resolve(!error));
        } catch (error) {
            resolve(false);
        }
    });
}

// ---- 下发 ----

async function select(global, device, port, outlet, at, options) {
    const config = configOf(device);
    const definition = switchModels.resolve(device.type, config.brand, config.model);
    if (definition && definition.control === false) {
        return {ok: false, status: 501, error: 'unsupported-control'};
    }
    const transport = switchModels.transportOf(config, device.type);
    const inNumber = portNumber(port);
    const outNumber = portNumber(outlet);
    if (!inNumber || !outNumber) return {ok: false, status: 400, error: 'unknown-channel'};

    if (transport === 'ag-tcp') {
        const state = links.get(device.id) || connect(global, device, options);
        if (!state || !state.connected) return {ok: false, status: 502, error: 'transport-connect'};
        // 协议尚未判定时不能猜：宁可报错，也不把旧帧发进 v4 设备。
        if (!state.mode) return {ok: false, status: 409, error: 'protocol-undetermined'};
        const payload = state.mode === 'v4'
            ? agV4Command((state.seq = (state.seq % 255) + 1),
                `port set ${inNumber} rxant=${outNumber} txant=${outNumber}`)
            : agFrame(0x415, inNumber + ';' + outNumber);
        try {
            state.socket.write(payload);
            return {ok: true, dispatched: true, readback: true};
        } catch (error) {
            return {ok: false, status: 502, error: 'transport-error'};
        }
    }
    if (transport === 'wa4mcm-tcp') {
        const state = links.get(device.id) || connect(global, device, options);
        if (!state || !state.connected) return {ok: false, status: 502, error: 'transport-connect'};
        try {
            state.socket.write(wa4mcmFrame('select', outNumber));
            return {ok: true, dispatched: true, readback: true};
        } catch (error) {
            return {ok: false, status: 502, error: 'transport-error'};
        }
    }
    if (transport === 'zserver-udp') {
        const result = await zserverSend(device,
            zserverCommand(text(config.switch_id), inNumber, outNumber),
            Object.assign({}, options, {global}));
        return result;
    }
    if (transport === 'greenheron-tcp') {
        const state = links.get(device.id) || connect(global, device, options);
        if (!state || !state.connected) return {ok: false, status: 502, error: 'transport-connect'};
        try {
            state.socket.write(greenHeronFrame(config.switch_id, inNumber, outNumber));
            return {ok: true, dispatched: true, readback: true};
        } catch (error) {
            return {ok: false, status: 502, error: 'transport-error'};
        }
    }
    if (transport === 'amplitec-tcp') {
        return {ok: false, status: 501, error: 'unsupported-control'};
    }
    if (transport === 'rcs4-tcp') {
        const state = links.get(device.id) || connect(global, device, options);
        if (!state || !state.connected) return {ok: false, status: 502, error: 'transport-connect'};
        const count = Math.min(8, Math.max(1, Number(config.out_count) || 4));
        if (outNumber > count) return {ok: false, status: 400, error: 'unknown-channel'};
        try {
            // 1×4 必须先全断再置位，避免旧通路与目标通路同时闭合。
            for (let portNumber = 1; portNumber <= count; portNumber += 1) {
                state.socket.write(rcs4Frame(portNumber, false));
            }
            state.socket.write(rcs4Frame(outNumber, true));
            return {ok: true, dispatched: true, readback: false, protocol_verified: false};
        } catch (error) {
            return {ok: false, status: 502, error: 'transport-error'};
        }
    }
    if (transport === 'station-genius-tcp') {
        const state = links.get(device.id) || connect(global, device, options);
        if (!state || !state.connected) return {ok: false, status: 502, error: 'transport-connect'};
        try {
            state.socket.write(stationGeniusFrame(stationGeniusKey(device, outNumber)));
            return {ok: true, dispatched: true, readback: false};
        } catch (error) {
            return {ok: false, status: 502, error: 'transport-error'};
        }
    }
    if (transport === 'six2two-mqtt') {
        const state = mqttClient(global, device);
        if (!state || !state.connected) return {ok: false, status: 502, error: 'transport-connect'};
        const topic = six2twoTopic(mqttConfig(device).prefix, inNumber, outNumber);
        // 每个输入端口各自记旧通路，切 in2 不能把 in1 的 topic 关掉。
        const stateKey = device.id + '\u0000' + inNumber;
        const previous = six2twoState.get(stateKey);
        if (previous && previous.topic !== topic) {
            await mqttPublish(state, previous.topic, '0');
        }
        const sent = await mqttPublish(state, topic, '1');
        if (!sent) return {ok: false, status: 502, error: 'transport-error'};
        six2twoState.set(stateKey, {topic});
        return {ok: true, dispatched: true, readback: false};
    }
    return {ok: false, status: 400, error: 'transport-not-configured'};
}

// ---- 轮询 ----

/**
 * 切到手动：关掉这台设备的 TCP 链路、UDP 接收登记与 MQTT 会话，
 * 模拟量/回读都不再进来；地址与凭据留在配置里，切回自动即可重连。
 */
function release(device) {
    const id = device && device.id;
    if (!id) return;
    drop(id);
    for (const [port, receiver] of [...udpReceivers.entries()]) {
        if (!receiver.devices.has(id)) continue;
        receiver.devices.delete(id);
        receiver.globals.delete(id);
        if (!receiver.devices.size) {
            try { receiver.socket.close(); } catch (error) { /* ignore */ }
            udpReceivers.delete(port);
        }
    }
    const mqtt = mqttLinks.get(id);
    if (mqtt) {
        try { mqtt.client.end(true); } catch (error) { /* ignore */ }
        mqttLinks.delete(id);
    }
    for (const key of [...six2twoState.keys()]) {
        if (key.startsWith(id + '\u0000')) six2twoState.delete(key);
    }
}

function poll(global, devices, now, options) {
    const at = nowDate(now);
    const list = Array.isArray(devices) ? devices : [];
    const errors = [];
    let polled = 0;
    for (const device of list) {
        if (!device || (device.type !== 'switch' && device.type !== 'matrix') || !device.enabled) continue;
        // 手动切换器由人在面板上拧，不建链路、不发查询。
        if (device.access_mode === 'manual') {
            release(device);
            continue;
        }
        const config = configOf(device);
        const definition = switchModels.resolve(device.type, config.brand, config.model);
        if (!definition) continue;
        const transport = definition.transport;
        if (transport === 'ag-tcp') {
            const state = links.get(device.id) || connect(global, device, options);
            if (!state) continue;
            polled += 1;
            if (!state.connected) errors.push({device_id: device.id, error: 'transport-connect'});
            else if (state.mode === 'v4') agV4Poll(global, device, state);
            else if (state.mode === 'legacy') agLegacyPoll(global, device, state);
            continue;
        }
        if (transport === 'wa4mcm-tcp') {
            const state = links.get(device.id) || connect(global, device, options);
            if (!state) continue;
            polled += 1;
            if (!state.connected) errors.push({device_id: device.id, error: 'transport-connect'});
            else {
                try { state.socket.write(wa4mcmFrame('query')); } catch (error) { /* ignore */ }
            }
            continue;
        }
        if (transport === 'amplitec-tcp') {
            const state = links.get(device.id) || connect(global, device, options);
            if (!state) continue;
            polled += 1;
            if (!state.connected) errors.push({device_id: device.id, error: 'transport-connect'});
            else {
                try {
                    state.socket.write(AMPLITEC_QUERY[state.pollIndex % AMPLITEC_QUERY.length]);
                    state.pollIndex += 1;
                } catch (error) { /* ignore */ }
            }
            continue;
        }
        if (transport === 'zserver-udp') {
            ensureUdp(device, global);
            polled += 1;
            continue;
        }
        if (transport === 'greenheron-tcp' || transport === 'rcs4-tcp') {
            const state = links.get(device.id) || connect(global, device, options);
            if (!state) continue;
            polled += 1;
            if (!state.connected) errors.push({device_id: device.id, error: 'transport-connect'});
            continue;
        }
        if (transport === 'station-genius-tcp') {
            const state = links.get(device.id) || connect(global, device, options);
            if (!state) continue;
            polled += 1;
            if (!state.connected) errors.push({device_id: device.id, error: 'transport-connect'});
            else {
                try { state.socket.write(stationGeniusKeepaliveFrame()); } catch (error) { /* ignore */ }
            }
            continue;
        }
        if (transport === 'six2two-mqtt') {
            const state = mqttClient(global, device);
            if (!state) continue;
            polled += 1;
            if (!state.connected) errors.push({device_id: device.id, error: 'transport-connect'});
        }
    }
    return {ok: true, polled, errors, at: at.toISOString()};
}

function setSocketFactory(factory) {
    socketFactory = typeof factory === 'function' ? factory : null;
}

function setUdpFactory(factory) {
    udpFactory = typeof factory === 'function' ? factory : null;
}

function setMqttFactory(factory) {
    mqttFactory = typeof factory === 'function' ? factory : null;
}

function resetForTests() {
    for (const id of [...links.keys()]) drop(id);
    for (const [id, state] of [...mqttLinks.entries()]) {
        try { state.client.end(true); } catch (error) { /* ignore */ }
        mqttLinks.delete(id);
    }
    if (udpReceivers.size) {
        for (const receiver of udpReceivers.values()) {
            try { receiver.socket.close(); } catch (error) { /* ignore */ }
        }
        udpReceivers.clear();
    }
    six2twoState.clear();
    socketFactory = null;
    udpFactory = null;
    mqttFactory = null;
}

module.exports = {
    AG_DEFAULT_PORT,
    ZSERVER_COMMAND_PORT,
    ZSERVER_STATUS_PORT,
    agHeader,
    agFrame,
    parseAgFrames,
    parseAgPortStatus,
    parseAgAntennaLine,
    parseAgAntennaPayload,
    parseAgBandLine,
    parseAgBandPayload,
    agV4Command,
    parseAgV4Line,
    parseAgV4Band,
    parseAgV4Antenna,
    parseAgV4Port,
    zserverCommand,
    parseZserverStatus,
    greenHeronFrame,
    parseGreenHeronStatus,
    wa4mcmFrame,
    parseWa4mcmLine,
    parseAmplitecStatus,
    rcs4Frame,
    stationGeniusFrame,
    stationGeniusConnectFrame,
    stationGeniusKeepaliveFrame,
    six2twoTopic,
    maskBands,
    portNumber,
    select,
    poll,
    setSocketFactory,
    setUdpFactory,
    setMqttFactory,
    resetForTests
};
