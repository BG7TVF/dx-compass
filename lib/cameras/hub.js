'use strict';

/**
 * 摄像头内存 fan-out 中心。
 *
 * 职责边界：hub 只管登记、订阅、引用计数、帧率闸门、最新帧缓存与降级；
 * 真正的网络/进程动作交给 ingest-snapshot / ingest-rtsp（由 hub 持有句柄）。
 *
 * 懒启动：sync 不摄取；第一个 subscribe 才起任务，最后一个订阅者断开后
 * 延迟 IDLE_STOP_MS 才停（期间重新订阅取消这个定时器），避免频繁切换。
 *
 * configure() 是给测试用的内部开关（idleStopMs / factories），不是运行期 API。
 */

const ingestSnapshot = require('./ingest-snapshot.js');
const ingestRtsp = require('./ingest-rtsp.js');

let IDLE_STOP_MS = 15000;
let factories = {snapshot: ingestSnapshot.start, rtsp: ingestRtsp.start};
const MAX_RTSP = 2;

/** id -> entry */
const entries = new Map();
let rtspActive = 0;

function defaultFps(protocol) {
    return protocol === 'rtsp' ? 5 : 2;
}

function normalize(device) {
    const c = device.config || {};
    const protocol = c.protocol || 'snapshot';
    return {
        id: String(device.id),
        name: device.name || c.name || String(device.id),
        host: c.host,
        port: c.port || 80,
        protocol: protocol,
        username: c.username || '',
        password: c.password || '',
        snapshot_url: c.snapshot_url || '',
        stream_url: c.stream_url || '',
        fps: c.fps || defaultFps(protocol)
    };
}

function fingerprint(cfg) {
    return [cfg.protocol, cfg.host, cfg.port, cfg.snapshot_url, cfg.stream_url,
        cfg.fps, cfg.username, cfg.password].join('|');
}

function makeCtx(entry) {
    return {
        cfg: entry.cfg,
        publish: function(buffer) {
            publish(entry.id, buffer);
        },
        note: function(code) {
            note(entry.id, code);
        },
        fallback: function() {
            fallbackToSnapshot(entry);
        }
    };
}

function startIngest(entry) {
    if (entry.stopFn) return;                 // 已在摄取
    entry.gen += 1;
    const cfg = entry.cfg;
    if (cfg.protocol === 'rtsp' && rtspActive < MAX_RTSP) {
        rtspActive += 1;
        entry.rtspSlot = true;
        entry.mode = 'rtsp';
        const rawStop = factories.rtsp(makeCtx(entry));
        entry.stopFn = function() {
            if (entry.rtspSlot) { rtspActive -= 1; entry.rtspSlot = false; }
            if (typeof rawStop === 'function') rawStop();
        };
    } else {
        // rtsp 超并发：记一条日志并降级为快照轮询；其它协议直接快照。
        if (cfg.protocol === 'rtsp') note(entry.id, 'rtsp-busy');
        entry.mode = 'snapshot';
        const rawStop = factories.snapshot(makeCtx(entry));
        entry.stopFn = function() {
            if (typeof rawStop === 'function') rawStop();
        };
    }
}

function stopIngest(entry) {
    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
    if (entry.stopFn) {
        const stop = entry.stopFn;
        entry.stopFn = null;
        try {
            stop();
        } catch (e) {
            note(entry.id, 'stop-failed');
        }
    }
}

/** rtsp 致命（如 ffmpeg 未安装）时由 ingest-rtsp 回调进来，换成快照轮询。 */
function fallbackToSnapshot(entry) {
    if (entry.rtspSlot) { rtspActive -= 1; entry.rtspSlot = false; }
    entry.stopFn = null;                      // 旧 rtsp 句柄已自行终止
    if (entry.subscribers.size === 0) return; // 已无人订阅，不必再起
    entry.gen += 1;
    entry.mode = 'snapshot';
    const rawStop = factories.snapshot(makeCtx(entry));
    entry.stopFn = function() {
        if (typeof rawStop === 'function') rawStop();
    };
}

function sync(devices) {
    const list = Array.isArray(devices) ? devices : [];
    const seen = new Set();

    for (const device of list) {
        if (!device || device.type !== 'camera') continue;
        if (!device.config || !device.config.host) continue;
        const cfg = normalize(device);
        seen.add(cfg.id);
        const fp = fingerprint(cfg);
        const existing = entries.get(cfg.id);
        if (existing) {
            if (existing.fingerprint === fp) continue;   // 幂等：不重启任务
            const hadSubs = existing.subscribers.size > 0;
            stopIngest(existing);
            existing.cfg = cfg;
            existing.fingerprint = fp;
            existing.failures = 0;
            existing.lastFrameTs = 0;
            existing.latest = null;
            existing.publishedTs = 0;
            if (hadSubs) startIngest(existing);          // 有订阅者才重建摄取
            continue;
        }
        entries.set(cfg.id, {
            id: cfg.id,
            cfg: cfg,
            fingerprint: fp,
            subscribers: new Set(),
            latest: null,
            lastFrameTs: 0,
            publishedTs: 0,
            failures: 0,
            mode: cfg.protocol,
            stopFn: null,
            idleTimer: null,
            rtspSlot: false,
            gen: 0
        });
    }

    for (const id of Array.from(entries.keys())) {
        if (seen.has(id)) continue;
        const entry = entries.get(id);
        stopIngest(entry);
        entries.delete(id);
    }
    return entries.size;
}

function subscribe(id, onFrame) {
    const key = String(id);
    const entry = entries.get(key);
    if (!entry) return function() {};
    const listener = onFrame;
    entry.subscribers.add(listener);

    if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
    if (entry.subscribers.size === 1) startIngest(entry);

    return function unsubscribe() {
        if (!entry.subscribers.delete(listener)) return;
        if (entry.subscribers.size === 0 && !entry.idleTimer) {
            entry.idleTimer = setTimeout(function() {
                entry.idleTimer = null;
                if (entry.subscribers.size === 0) stopIngest(entry);
            }, IDLE_STOP_MS);
            if (entry.idleTimer.unref) entry.idleTimer.unref();
        }
    };
}

function note(id, code) {
    const entry = entries.get(String(id));
    if (!entry) return;
    entry.failures += 1;
    entry.lastError = code;
}

function publish(id, buffer) {
    const entry = entries.get(String(id));
    if (!entry) return;
    const now = Date.now();
    entry.lastFrameTs = now;
    entry.latest = {buffer: buffer, ts: now};

    // 帧率闸门：按 1000/fps 丢弃过快帧，但最新帧始终保留（上面已覆盖）。
    const outFps = entry.cfg.fps;
    if (outFps && outFps > 0) {
        const minInterval = 1000 / outFps;
        if (entry.publishedTs && (now - entry.publishedTs) < minInterval) return;
    }
    entry.publishedTs = now;
    for (const listener of Array.from(entry.subscribers)) {
        try {
            listener(buffer);
        } catch (e) {
            // 订阅者（HTTP 连接）异常不该影响其它订阅者。
            entry.subscribers.delete(listener);
        }
    }
}

function latest(id) {
    const entry = entries.get(String(id));
    return entry && entry.latest ? entry.latest : null;
}

function has(id) {
    return entries.has(String(id));
}

function stats(id) {
    const entry = entries.get(String(id));
    if (!entry) return null;
    return {
        subscribers: entry.subscribers.size,
        fps: entry.cfg.fps,
        last_frame_ts: entry.lastFrameTs,
        failures: entry.failures,
        mode: entry.mode
    };
}

/** 仅供测试/可观测：列出登记与摄取代次。 */
function list() {
    return Array.from(entries.values()).map(function(entry) {
        return {
            id: entry.id,
            protocol: entry.cfg.protocol,
            subscribers: entry.subscribers.size,
            ingesting: !!entry.stopFn,
            gen: entry.gen
        };
    });
}

function configure(options) {
    const opts = options || {};
    if (typeof opts.idleStopMs === 'number' && isFinite(opts.idleStopMs)) {
        IDLE_STOP_MS = opts.idleStopMs;
    }
    if (opts.factories && typeof opts.factories === 'object') {
        if (typeof opts.factories.snapshot === 'function') factories.snapshot = opts.factories.snapshot;
        if (typeof opts.factories.rtsp === 'function') factories.rtsp = opts.factories.rtsp;
    }
    return {idleStopMs: IDLE_STOP_MS};
}

function stopAll() {
    for (const entry of entries.values()) {
        stopIngest(entry);
    }
    rtspActive = 0;
}

module.exports = {
    sync: sync,
    subscribe: subscribe,
    publish: publish,
    latest: latest,
    has: has,
    stats: stats,
    list: list,
    configure: configure,
    stopAll: stopAll,
    MAX_RTSP: MAX_RTSP,
    IDLE_STOP_MS: function() { return IDLE_STOP_MS; }
};
