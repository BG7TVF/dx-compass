'use strict';

/**
 * 旋转器接入：rotctld（Hamlib 标准协议，GS-232 语义）。
 *
 * 只做标准文本协议，不认型号：
 *   P <az> <el>\n  设定目标
 *   p\n            回读当前位置（"az el"）
 *   S\n            停止
 *
 * 连接按 host:port 复用；断线后下次请求自动重连。没有配置 host 的旋转器
 * 返回 transport-not-configured，不会静默假装下发成功。
 */

const net = require('net');

const DEFAULT_PORT = 4533;
const DEFAULT_TIMEOUT_MS = 2000;

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

function configOf(device) {
    return (device && device.config) || {};
}

function linkFor(device) {
    const config = configOf(device);
    if (!config.host) return null;
    const port = Number.isFinite(Number(config.port)) ? Number(config.port) : DEFAULT_PORT;
    const key = config.host + ':' + port;
    if (!links.has(key)) links.set(key, new RotctldLink({host: config.host, port, timeoutMs: DEFAULT_TIMEOUT_MS}));
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
    RotctldLink,
    parsePosition,
    formatSet,
    setSocketFactory,
    linkFor,
    rotate,
    stop,
    read,
    resetLinks
};
