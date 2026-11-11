/**
 * N1MM UDP → HTTP relay 的可测试核心。
 * 真正的进程入口在 n1mm-relay.mjs；这里只放无 IO 的纯逻辑，便于单测。
 */

export const DEFAULTS = {
    udpHost: '0.0.0.0',
    udpPort: 12060,
    httpPort: 5758,
    path: '/api/n1mm/ingest',
    timeoutMs: 8000,
    maxQueue: 2000,
    idleWarnSec: 60
};

function intOf(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseArgs(argv, env = {}) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const get = name => {
        const i = args.indexOf(name);
        if (i < 0) return undefined;
        const value = args[i + 1];
        args.splice(i, 2);
        return value;
    };
    const flag = name => {
        const i = args.indexOf(name);
        if (i < 0) return false;
        args.splice(i, 1);
        return true;
    };

    if (flag('--help') || flag('-h')) return {help: true};

    const host = get('--host') || env.DX_N1MM_HOST || '';
    const httpPort = intOf(get('--port') || env.DX_N1MM_PORT, DEFAULTS.httpPort);
    const protocol = (get('--protocol') || env.DX_N1MM_PROTOCOL || 'http').toLowerCase();
    const path = get('--path') || env.DX_N1MM_PATH || DEFAULTS.path;
    const token = get('--token') || env.DX_N1MM_TOKEN || '';
    const station = get('--station') || env.DX_N1MM_STATION || '';
    const udpPort = intOf(get('--udp-port') || env.DX_N1MM_UDP_PORT, DEFAULTS.udpPort);
    const udpHost = get('--udp-host') || env.DX_N1MM_UDP_HOST || DEFAULTS.udpHost;
    const timeoutMs = intOf(get('--timeout'), DEFAULTS.timeoutMs);
    const maxQueue = intOf(get('--max-queue'), DEFAULTS.maxQueue);
    const idleWarnSec = intOf(get('--idle-warn'), DEFAULTS.idleWarnSec);

    const url = get('--url') || env.DX_N1MM_URL ||
        (host ? `${protocol}://${host}:${httpPort}${path.startsWith('/') ? path : '/' + path}` : '');

    return {help: false, url, token, station, udpHost, udpPort, timeoutMs, maxQueue, idleWarnSec};
}

export function validate(config) {
    if (!config || config.help) return 'help';
    if (!config.url) return 'missing --host/--url';
    if (!/^https?:\/\//i.test(config.url)) return 'url must start with http:// or https://';
    if (!config.token) return 'missing --token or DX_N1MM_TOKEN';
    return '';
}

/** 指数退避，封顶 30 秒；带一点抖动，避免多实例同时重连。 */
export function retryDelay(attempt, baseMs = 500, maxMs = 30000, random = Math.random) {
    const capped = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.round(capped * (0.8 + random() * 0.4));
}

/** 有界 FIFO：服务器长时间不可达时丢最旧的包，而不是把内存吃光。 */
export class BoundedQueue {
    constructor(limit) {
        this.limit = Math.max(1, parseInt(limit, 10) || DEFAULTS.maxQueue);
        this.items = [];
        this.dropped = 0;
    }

    push(item) {
        if (this.items.length >= this.limit) {
            this.items.shift();
            this.dropped += 1;
        }
        this.items.push(item);
        return this.items.length;
    }

    peek() {
        return this.items[0] || null;
    }

    pop() {
        return this.items.shift() || null;
    }

    get size() {
        return this.items.length;
    }
}

export function buildRequest(config, body) {
    const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-DX-Token': config.token,
        'User-Agent': 'dx-compass-n1mm-relay'
    };
    // 多台 N1MM 实例走同一个服务器时，用 --station 给每台一个稳定身份，
    // 服务器据此区分席位；不填则回退报文的 StationName / 来源 IP。
    if (config.station) headers['X-DX-Station'] = config.station;
    return {
        url: config.url,
        init: {method: 'POST', headers, body}
    };
}

export function errorMessage(status, text) {
    const detail = String(text || '').trim().slice(0, 200);
    if (status === 401) return '服务器拒绝令牌（401）：检查 --token 与设置里的 n1mmToken 是否一致';
    if (status === 503) return '服务器未配置接入令牌（503）：先在设置里填写 n1mmToken 或设置 DX_N1MM_TOKEN';
    if (status === 404) return '接入端点不存在（404）：检查 --host/--port/--path（默认 /api/n1mm/ingest）';
    return `HTTP ${status}${detail ? '：' + detail : ''}`;
}

export function helpText() {
    return [
        'N1MM+ UDP → HTTP relay',
        '',
        '用法：node scripts/n1mm-relay.mjs --host <服务器> --token <令牌> [选项]',
        '',
        '选项：',
        '  --host <ip>        服务器地址（必填，或 DX_N1MM_HOST）',
        '  --port <n>         服务器 HTTP 端口，默认 5758',
        '  --protocol <p>     http | https，默认 http',
        '  --path <p>         默认 /api/n1mm/ingest',
        '  --url <url>        直接给出完整端点（优先于 host/port）',
        '  --token <t>        接入令牌（或 DX_N1MM_TOKEN）',
        '  --station <name>   本实例的席位名（或 DX_N1MM_STATION）；多台 N1MM 必须不同',
        '  --udp-host <ip>    本机监听地址，默认 0.0.0.0（接收广播）',
        '  --udp-port <n>     本机监听端口，默认 12060',
        '  --timeout <ms>     单次 HTTP 超时，默认 8000',
        '  --max-queue <n>    断线时缓存包数，默认 2000',
        '  --idle-warn <s>    无包提示间隔，默认 60 秒',
        '',
        'N1MM Logger+ 里把广播目标指到本机：',
        '  1. Config → Configure Ports… → Broadcast Data 选项卡',
        '  2. 勾选 Enable Broadcast Data',
        '  3. 在目标列表加入 127.0.0.1（N1MM 与 relay 同机）或 relay 所在电脑的局域网 IP，端口 12060',
        '  4. 确认三个数据源（Contact / Radio / Score）都已勾选',
        '',
        '多台 N1MM 实例：每台用不同的 --station（如 RUN / MULT），否则服务器只能靠',
        'StationName 或来源 IP 区分，可能出现席位合并。',
        '',
        'Windows 首次运行需在防火墙提示中允许 node.exe 监听 UDP 12060。'
    ].join('\n');
}
