'use strict';

/**
 * TX 状态上报源（用户自研检测装置的通用入口）。
 *
 * 本项目不内置任何硬件协议：只接收 source_id + tx_active 的二元上报，
 * 维护 last_seen / health / latency，并按用户配置的 priority 选源。
 *
 * 降级（O6）：超时即不可用；全部不可用等同“未接入发射状态源”，
 * 不阻断、不沿用旧值、不把 unknown 当作正在发射。
 */

const RUNTIME_KEY = 'txRuntime';
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_PRIORITY = 1000;
const MAX_SOURCE_ID = 64;
const MAX_NAME = 60;
const MAX_TOKEN = 200;

function runtime(global) {
    const value = global && typeof global.get === 'function' ? global.get(RUNTIME_KEY) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function saveRuntime(global, value) {
    if (global && typeof global.set === 'function') global.set(RUNTIME_KEY, value);
}

function headerValue(headers, name) {
    const h = headers || {};
    const want = String(name).toLowerCase();
    for (const key of Object.keys(h)) {
        if (String(key).toLowerCase() === want) {
            const value = h[key];
            return String(value === undefined || value === null ? '' : value);
        }
    }
    return '';
}

function timeoutOf(source) {
    const value = Number(source && source.timeout_ms);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** 超过 timeout 记 stale；超过 3×timeout 记 offline（两者都不可用）。 */
function healthOf(lastSeenMs, nowMs, timeoutMs) {
    if (!Number.isFinite(lastSeenMs)) return 'offline';
    const age = nowMs - lastSeenMs;
    if (age < 0) return 'ok';
    if (age <= timeoutMs) return 'ok';
    if (age <= timeoutMs * 3) return 'stale';
    return 'offline';
}

function parseTs(value, nowMs) {
    if (value === undefined || value === null || value === '') return nowMs;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : nowMs;
}

function normalizeSourceId(value) {
    const id = String(value === undefined || value === null ? '' : value).trim();
    return id && id.length <= MAX_SOURCE_ID ? id : '';
}

/**
 * 收到一帧上报。未知 source_id 自动登记为最低优先级源（优先级 1000），
 * 后续可在配置里调整；已配置 token 的源必须带 X-DX-TX-Token。
 */
function ingest(global, sources, report, headers, now) {
    const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
    const nowMs = at.getTime();
    const body = report && typeof report === 'object' ? report : {};
    const sourceId = normalizeSourceId(body.source_id);
    if (!sourceId) return {status: 400, payload: {ok: false, error: 'source-id-required'}};
    if (typeof body.tx_active !== 'boolean') {
        return {status: 400, payload: {ok: false, error: 'tx-active-required'}};
    }
    let seq = null;
    if (body.seq !== undefined && body.seq !== null) {
        const value = Number(body.seq);
        if (!Number.isFinite(value)) return {status: 400, payload: {ok: false, error: 'invalid-seq'}};
        seq = value;
    }

    const list = Array.isArray(sources) ? sources : [];
    const source = list.find(item => item && item.source_id === sourceId) || null;
    let newSource = null;

    if (source) {
        const token = String(source.token || '');
        if (token) {
            const given = headerValue(headers, 'x-dx-tx-token') || String(body.token || '');
            if (given !== token) return {status: 403, payload: {ok: false, error: 'invalid-token'}};
        }
    }

    const all = runtime(global);
    const prev = all[sourceId] || null;
    if (seq !== null && prev && prev.seq !== null && prev.seq !== undefined && seq <= prev.seq) {
        return {
            status: 200,
            payload: {
                ok: true,
                ignored: 'stale-seq',
                source_id: sourceId,
                seq,
                last_seq: prev.seq
            },
            newSource: null
        };
    }

    const reportedAt = parseTs(body.ts, nowMs);
    const entry = {
        source_id: sourceId,
        tx_active: body.tx_active,
        last_seen: at.toISOString(),
        last_seen_ms: nowMs,
        seq: seq === null ? (prev ? prev.seq : null) : seq,
        latency_ms: reportedAt ? Math.max(0, nowMs - reportedAt) : 0
    };
    all[sourceId] = entry;
    saveRuntime(global, all);

    if (!source) {
        const iso = at.toISOString();
        newSource = {
            source_id: sourceId,
            name: sourceId,
            priority: DEFAULT_PRIORITY,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            token: '',
            enabled: true,
            created_ts: iso,
            updated_ts: iso
        };
    }

    return {
        status: 200,
        payload: {
            ok: true,
            source_id: sourceId,
            tx_active: body.tx_active,
            received_ts: at.toISOString(),
            registered: !source,
            health: healthOf(nowMs, nowMs, timeoutOf(source))
        },
        newSource
    };
}

/**
 * 只读快照：每个源的优先级/健康/最近上报，以及当前生效源。
 * state: none = 未接入；interrupted = 有源但全部通信中断；ok = 有可用源。
 */
function snapshot(global, sources, now) {
    const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
    const nowMs = at.getTime();
    const all = runtime(global);
    const list = (Array.isArray(sources) ? sources : []).map(source => {
        const runtimeEntry = all[source.source_id] || null;
        const timeoutMs = timeoutOf(source);
        const health = runtimeEntry ? healthOf(runtimeEntry.last_seen_ms, nowMs, timeoutMs) : 'offline';
        return {
            source_id: source.source_id,
            name: source.name || source.source_id,
            priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : DEFAULT_PRIORITY,
            timeout_ms: timeoutMs,
            enabled: source.enabled !== false,
            has_token: !!source.token,
            health,
            tx_active: runtimeEntry ? !!runtimeEntry.tx_active : null,
            last_seen: runtimeEntry ? runtimeEntry.last_seen : null,
            age_ms: runtimeEntry && Number.isFinite(runtimeEntry.last_seen_ms)
                ? Math.max(0, nowMs - runtimeEntry.last_seen_ms) : null,
            latency_ms: runtimeEntry && Number.isFinite(runtimeEntry.latency_ms)
                ? runtimeEntry.latency_ms : null,
            seq: runtimeEntry ? runtimeEntry.seq : null
        };
    }).sort((a, b) => a.priority - b.priority || a.source_id.localeCompare(b.source_id));

    const enabled = list.filter(item => item.enabled);
    const usable = enabled.filter(item => item.health === 'ok');
    const current = usable.length ? usable[0] : null;
    const state = !enabled.length ? 'none' : (current ? 'ok' : 'interrupted');

    return {
        state,
        current,
        sources: list,
        default_timeout_ms: DEFAULT_TIMEOUT_MS,
        tx_active: current ? current.tx_active : null
    };
}

/** 天线切换互锁的准入判定（本阶段没有写操作，接口留给后续阶段复用）。 */
function selectSource(global, sources, now) {
    const snap = snapshot(global, sources, now);
    return {
        available: !!snap.current,
        tx_active: snap.current ? snap.current.tx_active : null,
        source: snap.current,
        state: snap.state
    };
}

function reset(global) {
    saveRuntime(global, {});
}

/** 删除某个源的内存状态（配置删除时调用）。 */
function forget(global, sourceId) {
    const all = runtime(global);
    if (!Object.prototype.hasOwnProperty.call(all, sourceId)) return false;
    delete all[sourceId];
    saveRuntime(global, all);
    return true;
}

module.exports = {
    RUNTIME_KEY,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_PRIORITY,
    MAX_SOURCE_ID,
    MAX_NAME,
    MAX_TOKEN,
    healthOf,
    ingest,
    snapshot,
    selectSource,
    reset,
    forget
};
