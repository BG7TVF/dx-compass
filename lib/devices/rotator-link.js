'use strict';

/**
 * 旋转器接入：rotctld（Hamlib 代理）与 Yaesu GS-232 文本两种传输。
 *
 * rotctld（默认 TCP 4533）：
 *   P <az> <el>\n  设定目标
 *   p\n            回读当前位置（"az el"）
 *   S\n            停止
 *
 * GS-232（TCP 串口服务器或直连）：
 *   C2;            回读方位/仰角（"+0aaa+0eee" 或 "AZ=aaa EL=eee"）
 *   Mxxx;          转向到方位 xxx
 *   S;             停止
 *
 * 连接按 协议@host:port 复用；断线后下次请求自动重连。没有配置 host
 * （或 GS-232 没有端口）时返回 transport-not-configured，不静默假装成功。
 */

const net = require('net');
const rotatorModels = require('./rotator-models.js');

const DEFAULT_PORT = 4533;
const DEFAULT_TIMEOUT_MS = 2000;
const GS232_QUIET_MS = 120;

let socketFactory = options => net.createConnection({host: options.host, port: options.port});
const links = new Map();

function setSocketFactory(factory) {
    socketFactory = typeof factory === 'function' ? factory : ((options) => net.createConnection({
        host: options.host,
        port: options.port
    }));
}

/** "45.0 0.0\n" → {azimuth, elevation}；非法响应返回 null。 */
function parsePosition(text) {
    const parts = String(text === undefined || text === null ? '' : text).trim().split(/\s+/);
    if (!parts.length || parts[0] === '') return null;
    const azimuth = Number(parts[0]);
    if (!Number.isFinite(azimuth)) return null;
    const elevation = Number(parts[1]);
    return {
        azimuth: ((azimuth % 360) + 360) % 360,
        elevation: Number.isFinite(elevation) ? elevation : 0
    };
}

function formatSet(azimuth, elevation) {
    const az = Number(azimuth);
    const el = Number.isFinite(Number(elevation)) ? Number(elevation) : 0;
    return 'P ' + az.toFixed(1) + ' ' + el.toFixed(1) + '\n';
}

/** GS-232 方位回读：兼容 "+0aaa+0eee"、"AZ=aaa EL=eee" 与 "aaa eee"。 */
function parseGs232Position(text) {
    const raw = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!raw) return null;
    let azimuth = null;
    let elevation = null;
    const az = raw.match(/\bAZ(?:IMUTH)?\s*[=:]?\s*([+-]?\d+(?:\.\d+)?)/i);
    const el = raw.match(/\bEL(?:EVATION)?\s*[=:]?\s*([+-]?\d+(?:\.\d+)?)/i);
    if (az) {
        azimuth = Number(az[1]);
        if (el) elevation = Number(el[1]);
    } else {
        const numbers = raw.match(/[+-]?\d+(?:\.\d+)?/g) || [];
        if (!numbers.length) return null;
        azimuth = Number(numbers[0]);
        if (numbers.length > 1) elevation = Number(numbers[1]);
    }
    if (!Number.isFinite(azimuth)) return null;
    return {
        azimuth: ((azimuth % 360) + 360) % 360,
        elevation: Number.isFinite(elevation) ? elevation : 0
    };
}

/** GS-232 转向：0–359 整数，360 归 0，固定三位。 */
function formatGs232Set(azimuth) {
    const value = Number(azimuth);
    if (!Number.isFinite(value)) throw new Error('invalid-azimuth');
    const normalized = ((Math.round(value) % 360) + 360) % 360;
    return 'M' + String(normalized).padStart(3, '0') + ';';
}

class RotctldLink {
    constructor(options) {
        const opts = options || {};
        this.host = opts.host;
        this.port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : DEFAULT_PORT;
        this.timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
        this.socket = null;
        this.pending = null;
        this.queue = Promise.resolve();
    }

    connect() {
        if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
        if (this.pending) return this.pending;
        this.pending = new Promise((resolve, reject) => {
            let settled = false;
            let socket;
            const fail = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.pending = null;
                try { if (socket) socket.destroy(); } catch (error) { /* ignore */ }
                reject(new Error('transport-connect'));
            };
            const timer = setTimeout(fail, this.timeoutMs);
            try {
                socket = socketFactory({host: this.host, port: this.port});
            } catch (error) {
                fail();
                return;
            }
            if (!socket || typeof socket.once !== 'function') {
                fail();
                return;
            }
            socket.setEncoding('utf8');
            socket.once('error', fail);
            socket.once('connect', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.pending = null;
                this.socket = socket;
                socket.on('error', () => this.reset());
                socket.on('close', () => this.reset());
                resolve(socket);
            });
        });
        return this.pending;
    }

    reset() {
        this.socket = null;
    }

    request(line) {
        const run = () => this.perform(line);
        this.queue = this.queue.then(run, run);
        return this.queue;
    }

    async perform(line) {
        const socket = await this.connect();
        return new Promise((resolve, reject) => {
            let buffer = '';
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                socket.removeListener('close', onClose);
                if (error) reject(error);
                else resolve(value);
            };
            const onData = chunk => {
                buffer += chunk;
                const index = buffer.indexOf('\n');
                if (index < 0) return;
                finish(null, buffer.slice(0, index).trim());
            };
            const onError = () => finish(new Error('transport-error'));
            const onClose = () => {
                this.reset();
                finish(new Error('transport-error'));
            };
            const timer = setTimeout(() => finish(new Error('transport-timeout')), this.timeoutMs);
            socket.on('data', onData);
            socket.once('error', onError);
            socket.once('close', onClose);
            try {
                socket.write(String(line));
            } catch (error) {
                finish(new Error('transport-error'));
            }
        });
    }

    async setPosition(azimuth, elevation) {
        await this.request(formatSet(azimuth, elevation));
    }

    async getPosition() {
        const text = await this.request('p\n');
        const position = parsePosition(text);
        if (!position) throw new Error('transport-protocol');
        return position;
    }

    async stop() {
        await this.request('S\n');
    }

    close() {
        const socket = this.socket;
        this.socket = null;
        if (socket && typeof socket.destroy === 'function') {
            try { socket.destroy(); } catch (error) { /* ignore */ }
        }
    }
}

class Gs232Link extends RotctldLink {
    /**
     * GS-232 的回复不一定带换行，按“数据停止 120ms”判定一帧结束，
     * 收到换行则立即结束；其余连接复用、队列与超时行为与 rotctld 一致。
     */
    async perform(line) {
        const socket = await this.connect();
        return new Promise((resolve, reject) => {
            let buffer = '';
            let settled = false;
            let idle = null;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (idle) clearTimeout(idle);
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                socket.removeListener('close', onClose);
                if (error) reject(error);
                else resolve(value);
            };
            const onData = chunk => {
                buffer += chunk;
                if (/[\r\n]/.test(buffer)) {
                    finish(null, buffer.trim());
                    return;
                }
                if (idle) clearTimeout(idle);
                idle = setTimeout(() => finish(null, buffer.trim()), GS232_QUIET_MS);
            };
            const onError = () => finish(new Error('transport-error'));
            const onClose = () => {
                this.reset();
                finish(new Error('transport-error'));
            };
            const timer = setTimeout(() => finish(new Error('transport-timeout')), this.timeoutMs);
            socket.on('data', onData);
            socket.once('error', onError);
            socket.once('close', onClose);
            try {
                socket.write(String(line));
            } catch (error) {
                finish(new Error('transport-error'));
            }
        });
    }

    async setPosition(azimuth) {
        await this.request(formatGs232Set(azimuth));
    }

    async getPosition() {
        const text = await this.request('C2;');
        const position = parseGs232Position(text);
        if (!position) throw new Error('transport-protocol');
        return position;
    }

    async stop() {
        await this.request('S;');
    }
}

function configOf(device) {
    return (device && device.config) || {};
}

function linkFor(device) {
    const config = configOf(device);
    if (!config.host) return null;
    const protocol = rotatorModels.transportOf(config);
    const configuredPort = Number(config.port);
    const port = Number.isFinite(configuredPort) && configuredPort > 0
        ? configuredPort
        : (protocol === 'rotctld' ? DEFAULT_PORT : null);
    // GS-232 经串口服务器/直连时必须显式给端口，不猜 23 或 4001。
    if (!port) return null;
    const key = protocol + '@' + config.host + ':' + port;
    if (!links.has(key)) {
        links.set(key, protocol === 'gs232'
            ? new Gs232Link({host: config.host, port, timeoutMs: DEFAULT_TIMEOUT_MS})
            : new RotctldLink({host: config.host, port, timeoutMs: DEFAULT_TIMEOUT_MS}));
    }
    return links.get(key);
}

async function rotate(device, azimuth) {
    const link = linkFor(device);
    if (!link) return {ok: false, status: 400, error: 'transport-not-configured'};
    try {
        await link.setPosition(azimuth, 0);
        return {ok: true};
    } catch (error) {
        return {ok: false, status: 502, error: error.message || 'transport-error'};
    }
}

async function stop(device) {
    const link = linkFor(device);
    if (!link) return {ok: false, status: 400, error: 'transport-not-configured'};
    try {
        await link.stop();
        return {ok: true};
    } catch (error) {
        return {ok: false, status: 502, error: error.message || 'transport-error'};
    }
}

/** 轮询当前位置；失败返回 ok:false，由调用方保留 unknown/离线语义。 */
async function read(device) {
    const link = linkFor(device);
    if (!link) return {ok: false, error: 'transport-not-configured'};
    try {
        const position = await link.getPosition();
        return {ok: true, azimuth: position.azimuth, elevation: position.elevation};
    } catch (error) {
        return {ok: false, error: error.message || 'transport-error'};
    }
}

function resetLinks() {
    for (const link of links.values()) link.close();
    links.clear();
}

module.exports = {
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_MS,
    GS232_QUIET_MS,
    RotctldLink,
    Gs232Link,
    parsePosition,
    formatSet,
    parseGs232Position,
    formatGs232Set,
    setSocketFactory,
    linkFor,
    rotate,
    stop,
    read,
    resetLinks
};
