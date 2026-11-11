#!/usr/bin/env node
/**
 * N1MM+ UDP → HTTP relay（Windows / macOS / Linux 通用）。
 * 监听本机 UDP 12060，把 N1MM 广播的 XML 原样转发到服务器 /api/n1mm/ingest。
 * 用法见 `node scripts/n1mm-relay.mjs --help`。
 */
import dgram from 'node:dgram';
import {
    BoundedQueue, buildRequest, errorMessage, helpText, parseArgs, retryDelay, validate
} from './n1mm-relay-core.mjs';

const config = parseArgs(process.argv.slice(2), process.env);
if (config.help) {
    console.log(helpText());
    process.exit(0);
}
const problem = validate(config);
if (problem) {
    console.error('配置错误：' + problem + '\n\n' + helpText());
    process.exit(2);
}

const queue = new BoundedQueue(config.maxQueue);
const stats = {received: 0, sent: 0, failed: 0, bytes: 0};
let running = true;
let attempt = 0;
let sending = false;
let lastPacketAt = Date.now();
let idleWarned = false;

const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});

socket.on('error', error => {
    console.error(`UDP 监听失败（${config.udpHost}:${config.udpPort}）：${error.message}`);
    if (error.code === 'EADDRINUSE') {
        console.error('端口已被占用：确认没有第二个 relay 在运行，或 N1MM 的广播端口被别的程序占用。');
    } else if (error.code === 'EACCES') {
        console.error('权限不足：换一个端口，或用管理员权限运行。');
    }
    stop(1);
});

socket.on('message', (packet, rinfo) => {
    stats.received += 1;
    stats.bytes += packet.length;
    lastPacketAt = Date.now();
    idleWarned = false;
    const source = rinfo && rinfo.address ? rinfo.address + ':' + rinfo.port : '';
    queue.push({body: packet.toString('utf8'), source});
    if (!sending) void drain();
});

async function post(body, source) {
    const request = buildRequest(config, body, source);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const res = await fetch(request.url, Object.assign({}, request.init, {signal: controller.signal}));
        const text = await res.text();
        return {ok: res.ok, status: res.status, text};
    } catch (error) {
        const reason = error && error.name === 'AbortError'
            ? `超时（>${config.timeoutMs}ms）`
            : String(error && error.message || error);
        return {ok: false, status: 0, text: reason};
    } finally {
        clearTimeout(timer);
    }
}

async function drain() {
    if (sending) return;
    sending = true;
    while (running && queue.size) {
        const item = queue.peek();
        const result = await post(item.body, item.source);
        if (result.ok) {
            queue.pop();
            stats.sent += 1;
            attempt = 0;
            continue;
        }
        stats.failed += 1;
        attempt += 1;
        const message = result.status
            ? errorMessage(result.status, result.text)
            : `无法连接服务器：${result.text}`;
        console.error(`[${new Date().toISOString()}] 转发失败（第 ${attempt} 次）：${message}；待发 ${queue.size} 包`);
        await sleep(retryDelay(attempt));
    }
    sending = false;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

setInterval(() => {
    if (!running) return;
    const quiet = Math.round((Date.now() - lastPacketAt) / 1000);
    if (!idleWarned && quiet >= config.idleWarnSec) {
        idleWarned = true;
        console.warn(
            `已有 ${quiet} 秒没有收到 UDP 包。请确认 N1MM 的 Config → Configure Ports… → ` +
            `Broadcast Data 已启用，并把目标 IP 指向本机、端口设为 ${config.udpPort}。`
        );
    }
    if (queue.dropped) {
        console.warn(`队列已满，累计丢弃 ${queue.dropped} 个旧包（服务器可能长时间不可达）。`);
    }
}, 5000);

function stop(code) {
    if (!running) return;
    running = false;
    try { socket.close(); } catch (error) { /* already closed */ }
    console.log(
        `relay 退出：收到 ${stats.received} 包，成功 ${stats.sent}，失败重试 ${stats.failed}，` +
        `丢弃 ${queue.dropped}，待发 ${queue.size}。`
    );
    process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

socket.bind(config.udpPort, config.udpHost, () => {
    console.log(`N1MM relay 已启动：UDP ${config.udpHost}:${config.udpPort} → ${config.url}`);
});
