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
const control = require('./control.js');
const ampModels = require('./amp-models.js');
const ampOm = require('./amp-om.js');
const net = require('net');
const http = require('node:http');
const {bandOf} = require('../radio');

const DEFAULT_PREFIX = 'amplifier/device';
const DEFAULT_TOPIC_DEVICE = 'device_id';
/** Elecraft KPA500 轮询顺序：状态类 GET，全部是只读命令。 */
const KPA_POLL = ['^OS;', '^BN;', '^WS;', '^TM;', '^VI;', '^FL;', '^RVM;'];
/**
 * KPA1500 只读轮询。命令来自官方 Programming Reference（rev 1.47）：
 * ^OS 模式、^BN 波段、^WS 正向功率与 SWR、^TM 温度、^VI 电压/电流、
 * ^FS 风扇档、^FL 故障码、^RVM 固件版本。
 */
const KPA1500_POLL = ['^OS;', '^BN;', '^WS;', '^TM;', '^VI;', '^FS;', '^FL;', '^RVM;'];
const KPA_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];

/** 测试可注入的 MQTT 客户端工厂。 */
let clientFactory = null;
/** 测试可注入的 TCP socket 工厂。 */
let socketFactory = null;
/** deviceId → {client, signature, connected} */
const clients = new Map();
/** deviceId → {socket, signature, connected, buffer, amp, awaiting, last_tx_ms, last_rx_ms} */
const serialClients = new Map();

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
    if (ampModels.transportOf(configOf(device)) !== 'mqtt') return false;
    const config = configOf(device);
    const protocol = text(config.protocol) || 'mqtt';
    return protocol === 'mqtt' && !!text(config.host) && Number.isFinite(Number(config.port)) &&
        !!text(config.device_id);
}

/** 串口/ASCII 型号的寻址：直连 host:port，或经串口服务器控制连线继承地址。 */
function serialAddress(device, options) {
    return control.resolveFor(device, {
        devices: (options && options.devices) || [device],
        links: (options && options.links) || []
    });
}

function serialSignature(address, device) {
    return JSON.stringify([
        address && address.mode, address && address.host, address && address.port,
        (address && address.serial_port) || 0,
        text(configOf(device).brand), text(configOf(device).model)
    ]);
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

/** KPA500 的 SWR 是三位数、隐含小数点在第二位之后（018 → 1.8）。 */
function swrOf(raw) {
    const digits = text(raw);
    if (digits.length < 3) return num(digits);
    return num(digits.slice(0, 2) + '.' + digits.slice(2));
}

function blankElecraft() {
    return {
        power_on: null,
        operating: null,
        band: '',
        out_fwd_power: null,
        out_swr: null,
        out_rev_power: null,
        in_fwd_power: null,
        current_temperature: null,
        current_voltage: null,
        current_current: null,
        fan_speed: null,
        alarm_word: 0,
        alarm_active: false,
        fault_code: '',
        firmware_version: '',
        serial_number: ''
    };
}

/**
 * 解析一条 KPA500 / KPA1500 ASCII 响应（已按 `;` 切开）。
 * 两个型号的命令多数同名，但 ^VI 的电流单位不同：KPA500 是十分之一安，
 * KPA1500 是整安。调用方用 options.current_divisor 指定，默认按 KPA500。
 * 只认识状态类 GET 的响应；未知帧忽略但不影响链路存活判断。
 */
function applyElecraftFrame(state, frame, options) {
    const line = text(frame).toUpperCase();
    const currentDivisor = options && Number.isFinite(options.current_divisor)
        ? options.current_divisor : 10;
    let match = /^\^OS([01])$/.exec(line);
    if (match) {
        state.operating = int(match[1]);
        state.power_on = 1;
        return true;
    }
    match = /^\^ON([01])$/.exec(line);
    if (match) {
        state.power_on = int(match[1]);
        return true;
    }
    match = /^\^BN(\d{2})$/.exec(line);
    if (match) {
        const index = int(match[1]);
        state.band = Number.isFinite(index) && KPA_BANDS[index] ? KPA_BANDS[index] : '';
        return true;
    }
    match = /^\^WS(\d{1,4})\s+(\d{1,3})$/.exec(line);
    if (match) {
        state.out_fwd_power = num(match[1]);
        state.out_swr = swrOf(match[2]);
        return true;
    }
    match = /^\^PWF(\d{1,4})$/.exec(line);
    if (match) {
        state.out_fwd_power = num(match[1]);
        return true;
    }
    match = /^\^PWR(\d{1,4})$/.exec(line);
    if (match) {
        state.out_rev_power = num(match[1]);
        return true;
    }
    match = /^\^PWI(\d{1,4})$/.exec(line);
    if (match) {
        state.in_fwd_power = num(match[1]);
        return true;
    }
    match = /^\^TM(\d{1,3})$/.exec(line);
    if (match) {
        state.current_temperature = num(match[1]);
        return true;
    }
    match = /^\^FS([0-5])$/.exec(line);
    if (match) {
        state.fan_speed = int(match[1]);
        return true;
    }
    match = /^\^VI(\d{1,3})\s+(\d{1,3})$/.exec(line);
    if (match) {
        state.current_voltage = num(match[1]) === null ? null : num(match[1]) / 10;
        state.current_current = num(match[2]) === null ? null : num(match[2]) / currentDivisor;
        return true;
    }
    match = /^\^FL([0-9A-F]{2})$/.exec(line);
    if (match) {
        const code = parseInt(match[1], 16);
        state.alarm_word = code;
        state.alarm_active = code > 0;
        state.fault_code = code > 0 ? '0x' + match[1] : '';
        return true;
    }
    match = /^\^RVM([\d.]+)$/.exec(line);
    if (match) {
        state.firmware_version = match[1];
        return true;
    }
    match = /^\^SN(\d+)$/.exec(line);
    if (match) {
        state.serial_number = match[1];
        return true;
    }
    return false;
}

/** 常规操作 → KPA500 线命令；刻意不含 ^PJ/^AL 等调整与阈值类命令。 */
const KPA_COMMANDS = {
    power_on: 'P;',
    power_off: '^ON0;',
    operate: '^OS1;',
    standby: '^OS0;',
    clear_fault: '^FLC;'
};

function elecraftCommand(action) {
    return KPA_COMMANDS[text(action)] || null;
}

// ---- ACOM 二进制遥测（以 github.com/bjornekelund/ACOM-Controller 为准） ----
// 仓库支持 500S/600S/700S/1200S/2020S：帧结构相同，仅温度换算偏移不同。
// 官方 v1.1 文档要求对设备消息回 0x86 ACK，但仓库没有实现 ACK；按仓库实现，
// 这里只解析遥测帧、不发送 ACK，避免凭空补一条协议分支。
const ACOM_FRAME_LEN = 72;
const ACOM_TELEMETRY_ADDRESS = 0x2F;
const ACOM_ENABLE_TELEMETRY = [0x55, 0x92, 0x04, 0x15];
const ACOM_DISABLE_TELEMETRY = [0x55, 0x91, 0x04, 0x16];
const ACOM_COMMANDS = {
    operate: [0x55, 0x81, 0x08, 0x02, 0x00, 0x06, 0x00, 0x1A],
    standby: [0x55, 0x81, 0x08, 0x02, 0x00, 0x05, 0x00, 0x1B],
    power_off: [0x55, 0x81, 0x08, 0x02, 0x00, 0x0A, 0x00, 0x16]
};
const ACOM_BANDS = ['', '160m', '80m', '40/60m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m'];

function acomCommand(action) {
    return ACOM_COMMANDS[text(action)] || null;
}

function blankAcom() {
    return {
        power_on: null,
        operating: null,
        transmitting: null,
        status_code: null,
        band: '',
        out_fwd_power: null,
        drive_power: null,
        out_rev_power: null,
        out_swr: null,
        current_temperature: null,
        dc_power: null,
        fan_state: null,
        alarm_word: 0xFF,
        alarm_active: false,
        fault_code: ''
    };
}

function acomOffset(device) {
    const definition = ampModels.resolve(configOf(device).brand, configOf(device).model);
    return definition && definition.parser && Number.isFinite(definition.parser.temperature_offset)
        ? definition.parser.temperature_offset : 0;
}

/** 72 字节遥测帧：所有字节相加（模 256）为零才有效。 */
function applyAcomFrame(state, frame, offset) {
    let sum = 0;
    for (const byte of frame) sum = (sum + byte) & 0xFF;
    if (sum !== 0) return false;
    const status = (frame[3] & 0xF0) >> 4;
    const uid = frame[69] & 0x0F;
    state.amp.status_code = status;
    state.amp.power_on = status === 10 ? 0 : 1;
    state.amp.operating = status === 6 || status === 7 ? 1 : 0;
    state.amp.transmitting = status === 7 ? 1 : 0;
    state.amp.band = ACOM_BANDS[uid] || '';
    state.amp.current_temperature = frame[16] + frame[17] * 256 - offset;
    state.amp.fan_state = (frame[69] & 0xF0) >> 4;
    state.amp.drive_power = (frame[20] + frame[21] * 256) / 10;
    state.amp.out_fwd_power = frame[22] + frame[23] * 256;
    state.amp.out_rev_power = frame[24] + frame[25] * 256;
    state.amp.out_swr = (frame[26] + frame[27] * 256) / 100;
    state.amp.dc_power = frame[8] * 0.1 + frame[9] * 25.6;
    const error = frame[66];
    state.amp.alarm_word = error;
    state.amp.alarm_active = error !== 0xFF;
    state.amp.fault_code = error !== 0xFF ? '0x' + error.toString(16).toUpperCase().padStart(2, '0') : '';
    return true;
}

/** 流式解析：0x55 起始、第二字节 0x2F、固定 72 字节、和校验为零。 */
function feedAcom(state, chunk, offset) {
    let recognized = false;
    for (const byte of chunk) {
        if (!state.parsing) {
            if (byte === 0x55) {
                state.frame = [0x55];
                state.parsing = true;
            }
            continue;
        }
        state.frame.push(byte);
        if (state.frame.length === 2 && state.frame[1] !== ACOM_TELEMETRY_ADDRESS) {
            state.frame = [];
            state.parsing = false;
            continue;
        }
        if (state.frame.length === ACOM_FRAME_LEN) {
            const frame = state.frame;
            state.frame = [];
            state.parsing = false;
            if (applyAcomFrame(state, frame, offset)) recognized = true;
        }
    }
    return recognized;
}

// ---- SPE Expert 二进制状态串（官方 Application Programmer's Guide Rev 1.1） ----
// 主机包：55 55 55 | CNT | DATA... | CHK；单字节命令时 CHK 等于命令本身。
// 放大器包：AA AA AA | CNT | DATA... | CHK0 CHK1 | CR LF；CHK 为数据字节和，
// CHK0 取低 8 位、CHK1 取高 8 位。STATUS(0x90) 的 DATA 是 67 字节 CSV。
const SPE_STATUS_REQUEST = [0x55, 0x55, 0x55, 0x01, 0x90, 0x90];
const SPE_BANDS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m'];

function blankSpe() {
    return {
        operating: null,
        transmitting: null,
        band: '',
        out_fwd_power: null,
        out_swr: null,
        swr_atu: null,
        current_voltage: null,
        current_current: null,
        current_temperature: null,
        temp_lower: null,
        temp_combiner: null,
        warning: '',
        alarm: '',
        alarm_active: false,
        fault_code: ''
    };
}

function speNumber(value) {
    const n = Number(text(value));
    return Number.isFinite(n) ? n : null;
}

/** 解析 19 字段状态串；字段定义见官方指南第 9 页。 */
function parseSpeStatus(csv) {
    let fields = String(csv || '').split(',').map(item => item.trim());
    // 部分固件会在最前面多一个逗号。
    if (fields[0] === '') fields = fields.slice(1);
    if (fields.length < 19) return null;
    const state = blankSpe();
    state.operating = fields[1] === 'O' ? 1 : 0;
    state.transmitting = fields[2] === 'T' ? 1 : 0;
    const bandIndex = Number(fields[5]);
    state.band = Number.isFinite(bandIndex) && SPE_BANDS[bandIndex] ? SPE_BANDS[bandIndex] : '';
    state.out_fwd_power = speNumber(fields[9]);
    state.swr_atu = speNumber(fields[10]);
    state.out_swr = speNumber(fields[11]);
    state.current_voltage = speNumber(fields[12]);
    state.current_current = speNumber(fields[13]);
    const temp = speNumber(fields[14]);
    state.current_temperature = temp === null ? null : Math.round(temp);
    const lower = speNumber(fields[15]);
    state.temp_lower = lower === null ? null : Math.round(lower);
    const combiner = speNumber(fields[16]);
    state.temp_combiner = combiner === null ? null : Math.round(combiner);
    state.warning = fields[17] && fields[17] !== 'N' ? fields[17] : '';
    state.alarm = fields[18] && fields[18] !== 'N' ? fields[18] : '';
    state.alarm_active = !!(state.warning || state.alarm);
    state.fault_code = [state.warning && 'W' + state.warning, state.alarm && 'A' + state.alarm]
        .filter(Boolean).join(' ');
    return state;
}

/** 流式解析 AA AA AA | CNT | DATA | CHK0 CHK1；校验失败则丢弃该帧继续找同步头。 */
function feedSpe(state, chunk) {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    let recognized = false;
    while (state.buffer.length >= 4) {
        let index = -1;
        for (let i = 0; i + 2 < state.buffer.length; i += 1) {
            if (state.buffer[i] === 0xAA && state.buffer[i + 1] === 0xAA &&
                state.buffer[i + 2] === 0xAA) {
                index = i;
                break;
            }
        }
        if (index < 0) {
            state.buffer = state.buffer.slice(Math.max(0, state.buffer.length - 2));
            break;
        }
        if (index > 0) state.buffer = state.buffer.slice(index);
        if (state.buffer.length < 4) break;
        const count = state.buffer[3];
        // 放大器只有 ACK(1 字节) 与 STATUS(67 字节) 两种响应；明显不合理的长度
        // 说明遇到的是假同步头，跳过这颗 0xAA 重新找，避免被垃圾数据卡住。
        if (count > 67) {
            state.buffer = state.buffer.slice(1);
            continue;
        }
        const total = 4 + count + 2;
        if (state.buffer.length < total) break;
        const payload = state.buffer.slice(4, 4 + count);
        const low = state.buffer[4 + count];
        const high = state.buffer[5 + count];
        let sum = 0;
        for (const byte of payload) sum += byte;
        if ((sum & 0xFF) === low && ((sum >> 8) & 0xFF) === high) {
            const parsed = parseSpeStatus(payload.toString('ascii'));
            if (parsed) {
                state.amp = parsed;
                recognized = true;
            }
            state.buffer = state.buffer.slice(total);
        } else {
            // 同步头不可信，跳过这颗 0xAA 重新找。
            state.buffer = state.buffer.slice(1);
        }
    }
    if (state.buffer.length > 512) state.buffer = Buffer.alloc(0);
    return recognized;
}

// ---- RF-Kit RF2K-S 只读身份（HTTP /info） ----
// 字段名来自公开项目 tnxqso/rf2k-trainer 的 rf2ks_client.py：device、
// custom_device_name、software_version.GUI / controller。只取身份与版本，
// 不根据 /power、/data 等未在官方手册中列出的端点猜功率或驻波。
const rfkitPending = new Set();

function parseRfkitInfo(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const version = payload.software_version;
    let firmware = '';
    if (version && typeof version === 'object' && !Array.isArray(version)) {
        firmware = [text(version.GUI), text(version.controller)].filter(Boolean).join(' / ');
    } else {
        firmware = text(version);
    }
    return {
        device_name: text(payload.custom_device_name) || text(payload.device),
        device_model: text(payload.device),
        software_version: firmware
    };
}

/** GET /info，返回 {ok, data} 或 {ok:false, error}；不抛异常。 */
function fetchRfkitInfo(address) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const request = http.get({
            host: address.host,
            port: Number(address.port) || 8080,
            path: '/info',
            headers: {accept: 'application/json'},
            timeout: 3000
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
                if (body.length > 65536) request.destroy(new Error('EMSGSIZE'));
            });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    finish({ok: false, error: 'transport-connect'});
                    return;
                }
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (error) { parsed = null; }
                const data = parseRfkitInfo(parsed);
                finish(data ? {ok: true, data} : {ok: false, error: 'transport-error'});
            });
        });
        request.on('timeout', () => request.destroy(new Error('ETIMEDOUT')));
        request.on('error', error => finish({
            ok: false,
            error: error && error.message === 'ETIMEDOUT' ? 'transport-timeout' : 'transport-connect'
        }));
    });
}

async function pollRfkit(global, device, address, at) {
    if (rfkitPending.has(device.id)) return;
    rfkitPending.add(device.id);
    try {
        const result = await fetchRfkitInfo(address);
        const stamp = nowDate(at);
        if (!result.ok) {
            runtime.updateEntry(global, device.id, {
                amp_connected: false,
                last_attempt_ms: stamp.getTime(),
                comm_error: result.error,
                comm_error_ms: stamp.getTime()
            }, stamp);
            return;
        }
        runtime.updateEntry(global, device.id, {
            amp: result.data,
            amp_connected: true,
            last_report: stamp.toISOString(),
            last_report_ms: stamp.getTime(),
            reported_ms: stamp.getTime(),
            last_attempt_ms: stamp.getTime(),
            comm_error: null,
            comm_error_ms: null
        }, stamp);
    } finally {
        rfkitPending.delete(device.id);
    }
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

function dropSerial(deviceId, state) {
    if (state) {
        // 仓库在关闭串口前发 Stop Telemetry，避免断开后设备继续推送。
        if (state.kind === 'acom' && state.connected) {
            try { state.socket && state.socket.write(Buffer.from(ACOM_DISABLE_TELEMETRY)); } catch (error) { /* ignore */ }
        }
        if (state.timer) clearTimeout(state.timer);
        try { state.socket && state.socket.removeAllListeners(); } catch (error) { /* ignore */ }
        try { state.socket && state.socket.destroy(); } catch (error) { /* ignore */ }
    }
    serialClients.delete(deviceId);
}

function markSerialFailure(global, deviceId, error) {
    const at = new Date();
    runtime.updateEntry(global, deviceId, {
        amp_connected: false,
        last_attempt_ms: at.getTime(),
        comm_error: errorCode(error),
        comm_error_ms: at.getTime()
    }, at);
}

function serialConnect(global, device, address) {
    const socket = socketFactory
        ? socketFactory({host: address.host, port: address.port})
        : net.createConnection({host: address.host, port: address.port});
    const definition = ampModels.resolve(configOf(device).brand, configOf(device).model);
    const transport = ampModels.transportOf(configOf(device));
    const acom = transport === 'acom-binary';
    const spe = transport === 'spe-binary';
    const state = {
        socket,
        signature: serialSignature(address, device),
        connected: false,
        kind: acom ? 'acom' : (spe ? 'spe' : 'elecraft'),
        // 轮询命令由型号描述表给出；KPA500 / KPA1500 共用 ASCII 传输，但命令集不同。
        poll: definition && definition.parser && Array.isArray(definition.parser.poll)
            ? definition.parser.poll.slice() : KPA_POLL,
        current_divisor: definition && definition.parser &&
            Number.isFinite(definition.parser.current_divisor)
            ? definition.parser.current_divisor : 10,
        buffer: spe ? Buffer.alloc(0) : '',
        frame: [],
        parsing: false,
        offset: acom ? acomOffset(device) : 0,
        amp: acom ? blankAcom() : (spe ? blankSpe() : blankElecraft()),
        pumping: false,
        timer: null,
        last_tx_ms: 0,
        last_enable_ms: 0,
        last_rx_ms: Date.now()
    };
    serialClients.set(device.id, state);

    const writeAmp = () => {
        const at = new Date();
        runtime.updateEntry(global, device.id, {
            amp: state.amp,
            amp_connected: true,
            last_report: at.toISOString(),
            last_report_ms: at.getTime(),
            reported_ms: at.getTime(),
            last_attempt_ms: at.getTime(),
            comm_error: null,
            comm_error_ms: null
        }, at);
    };

    socket.on('connect', () => {
        state.connected = true;
        state.last_rx_ms = Date.now();
        if (acom) {
            // 仓库做法：连上就发 Start Telemetry；无遥测时定时重发。
            try { socket.write(Buffer.from(ACOM_ENABLE_TELEMETRY)); } catch (error) { /* ignore */ }
            state.last_enable_ms = Date.now();
            return;
        }
        if (spe) {
            // 状态串按需请求；连上先要一次，之后由 pollAmps 每 2 秒重发。
            try { socket.write(Buffer.from(SPE_STATUS_REQUEST)); } catch (error) { /* ignore */ }
            state.last_tx_ms = Date.now();
            return;
        }
        writeAmp();
        if (!state.pumping) {
            state.pumping = true;
            pumpSerial(global, device, state, 0);
        }
    });
    socket.on('data', chunk => {
        state.last_rx_ms = Date.now();
        if (acom) {
            if (feedAcom(state, chunk, state.offset)) writeAmp();
            return;
        }
        if (spe) {
            if (feedSpe(state, chunk)) writeAmp();
            return;
        }
        state.buffer += String(chunk);
        const parts = state.buffer.split(';');
        state.buffer = parts.pop() || '';
        if (state.buffer.length > 512) state.buffer = '';
        let recognized = false;
        for (const part of parts) {
            if (applyElecraftFrame(state.amp, part, {current_divisor: state.current_divisor})) {
                recognized = true;
            }
        }
        if (recognized) writeAmp();
    });
    socket.on('error', error => {
        state.connected = false;
        markSerialFailure(global, device.id, error);
        if (serialClients.get(device.id) === state) serialClients.delete(device.id);
    });
    socket.on('close', () => {
        state.connected = false;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        markSerialFailure(global, device.id, {code: 'ECONNRESET'});
        if (serialClients.get(device.id) === state) serialClients.delete(device.id);
    });
    return state;
}

/** 轮询命令逐条发送，给功放留出响应时间；一轮结束后等下一个 2 秒定时器。 */
function pumpSerial(global, device, state, index) {
    if (!state.connected || !state.socket) {
        state.pumping = false;
        return;
    }
    const poll = state.poll || KPA_POLL;
    if (index >= poll.length) {
        state.pumping = false;
        return;
    }
    try {
        state.socket.write(poll[index]);
    } catch (error) {
        state.pumping = false;
        return;
    }
    state.last_tx_ms = Date.now();
    state.timer = setTimeout(() => {
        state.timer = null;
        pumpSerial(global, device, state, index + 1);
    }, 180);
    if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
}

/**
 * 由现有 2 秒定时器调用：MQTT 型号维持订阅，串口/ASCII 型号建立 TCP 链路并轮询。
 * options.links 是控制连线；串口设备的地址从串口服务器继承。
 */
function pollAmps(global, devices, now, options) {
    const at = nowDate(now);
    const nowMs = at.getTime();
    const list = Array.isArray(devices) ? devices : [];
    const wanted = new Set();
    const wantedSerial = new Set();
    const wantedOm = new Set();
    let connected = 0;
    const errors = [];
    for (const device of list) {
        if (!device || device.type !== 'amp' || !device.enabled) continue;
        const transport = ampModels.transportOf(configOf(device));
        if (transport === 'rfkit-http') {
            const address = serialAddress(device, options);
            if (!address || address.mode === 'unconfigured') continue;
            void pollRfkit(global, device, address, at);
            continue;
        }
        if (transport === 'om-tcp') {
            // OM Power 自己维护 TCP 会话与轮询节奏，这里只提供解析后的地址。
            ampOm.poll(global, device, serialAddress(device, options), at);
            wantedOm.add(device.id);
            continue;
        }
        if (transport !== 'mqtt') {
            const address = serialAddress(device, options);
            if (!address || address.mode === 'unconfigured') {
                const existing = serialClients.get(device.id);
                if (existing) dropSerial(device.id, existing);
                continue;
            }
            wantedSerial.add(device.id);
            const signature = serialSignature(address, device);
            const current = serialClients.get(device.id);
            if (current && current.signature !== signature) dropSerial(device.id, current);
            const state = serialClients.get(device.id) || serialConnect(global, device, address);
            if (state.connected) {
                connected += 1;
                if (state.kind === 'acom') {
                    // 仓库做法：没有遥测就持续重发 Start Telemetry；6 秒仍无帧判通信中断。
                    if (state.last_enable_ms && nowMs - state.last_rx_ms > 2000 &&
                        nowMs - state.last_enable_ms >= 2000) {
                        try { state.socket.write(Buffer.from(ACOM_ENABLE_TELEMETRY)); } catch (error) { /* ignore */ }
                        state.last_enable_ms = nowMs;
                    }
                    if (state.last_enable_ms && nowMs - state.last_rx_ms > 6000) {
                        markSerialFailure(global, device.id, {code: 'ETIMEDOUT'});
                        errors.push({device_id: device.id, error: 'transport-timeout'});
                    }
                } else if (state.kind === 'spe') {
                    // 状态串按需请求，每 2 秒一次；6 秒没有有效帧判通信中断，保留 socket。
                    if (nowMs - state.last_tx_ms >= 2000) {
                        try { state.socket.write(Buffer.from(SPE_STATUS_REQUEST)); } catch (error) { /* ignore */ }
                        state.last_tx_ms = nowMs;
                    }
                    if (state.last_tx_ms && nowMs - state.last_rx_ms > 6000) {
                        markSerialFailure(global, device.id, {code: 'ETIMEDOUT'});
                        errors.push({device_id: device.id, error: 'transport-timeout'});
                    }
                } else if (state.last_tx_ms && nowMs - state.last_rx_ms > 12000) {
                    markSerialFailure(global, device.id, {code: 'ETIMEDOUT'});
                    dropSerial(device.id, state);
                    errors.push({device_id: device.id, error: 'transport-timeout'});
                } else if (!state.pumping) {
                    state.pumping = true;
                    pumpSerial(global, device, state, 0);
                }
            } else {
                errors.push({device_id: device.id, error: 'transport-connect'});
            }
            continue;
        }
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
    for (const [deviceId, state] of [...serialClients.entries()]) {
        if (wantedSerial.has(deviceId)) continue;
        dropSerial(deviceId, state);
    }
    ampOm.retain(wantedOm);
    return {ok: true, connected, errors, at: at.toISOString()};
}

/** 下发一条 MQTT remote_control delta；只允许调用方已经白名单校验过的字段。 */
function publishMqtt(device, delta, now) {
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

/** 串口型号：只接受型号描述表里列出的常规操作，逐条写线命令。 */
function publishSerial(global, device, delta, now) {
    const action = text(delta && delta.action);
    const transport = ampModels.transportOf(configOf(device));
    const state = serialClients.get(device && device.id);
    if (!state || !state.connected) {
        return Promise.resolve({ok: false, status: 502, error: 'transport-connect'});
    }
    if (transport === 'acom-binary') {
        const bytes = acomCommand(action);
        if (!bytes) return Promise.resolve({ok: false, status: 400, error: 'invalid-arg'});
        return new Promise(resolve => {
            try {
                // 仓库不下发 ACK，也不假设动作成功；状态完全靠下一帧遥测回读。
                state.socket.write(Buffer.from(bytes), () => resolve({ok: true, dispatched: true}));
            } catch (error) {
                resolve({ok: false, status: 502, error: 'transport-error'});
            }
        });
    }
    // SPE 本轮只读：型号表没有动作，这里也拒绝直接调用。
    if (transport === 'spe-binary') {
        return Promise.resolve({ok: false, status: 400, error: 'invalid-arg'});
    }
    const wire = elecraftCommand(action);
    if (!wire) return Promise.resolve({ok: false, status: 400, error: 'invalid-arg'});
    return new Promise(resolve => {
        try {
            state.socket.write(wire, () => {
                const patch = {};
                if (action === 'power_on') patch.power_on = 1;
                if (action === 'power_off') patch.power_on = 0;
                if (action === 'operate') patch.operating = 1;
                if (action === 'standby') patch.operating = 0;
                if (Object.keys(patch).length && global) {
                    state.amp = Object.assign({}, state.amp, patch);
                    runtime.updateEntry(global, device.id, {amp: state.amp}, nowDate(now));
                }
                resolve({ok: true, dispatched: true});
            });
        } catch (error) {
            resolve({ok: false, status: 502, error: 'transport-error'});
        }
    });
}

function publish(device, delta, now, global) {
    const transport = device ? ampModels.transportOf(configOf(device)) : 'mqtt';
    if (transport === 'rfkit-http') {
        return Promise.resolve({ok: false, status: 400, error: 'invalid-arg'});
    }
    if (transport === 'om-tcp') {
        return ampOm.publish(global, device, delta, now);
    }
    if (transport !== 'mqtt') {
        return publishSerial(global, device, delta, now);
    }
    return publishMqtt(device, delta, now);
}

function setClientFactory(factory) {
    clientFactory = typeof factory === 'function' ? factory : null;
}

function setSocketFactory(factory) {
    socketFactory = typeof factory === 'function' ? factory : null;
    // OM Power 的 TCP 会话在本模块外维护，测试注入同一个工厂。
    ampOm.setSocketFactory(factory);
}

function resetForTests() {
    for (const [deviceId, state] of [...clients.entries()]) drop(deviceId, state.client);
    for (const [deviceId, state] of [...serialClients.entries()]) dropSerial(deviceId, state);
    ampOm.resetForTests();
    clientFactory = null;
    socketFactory = null;
}

module.exports = {
    DEFAULT_PREFIX,
    ACOM_ENABLE_TELEMETRY,
    ACOM_DISABLE_TELEMETRY,
    SPE_STATUS_REQUEST,
    configured,
    topicsFor,
    normalizeAmp,
    applyElecraftFrame,
    elecraftCommand,
    applyAcomFrame,
    feedAcom,
    acomCommand,
    parseSpeStatus,
    feedSpe,
    parseRfkitInfo,
    blankOm: ampOm.blankOm,
    applyOmMeasurement: ampOm.applyOmMeasurement,
    applyOmToken: ampOm.applyOmToken,
    feedOm: ampOm.feedOm,
    pollAmps,
    publish,
    setClientFactory,
    setSocketFactory,
    resetForTests,
    onMessage
};
