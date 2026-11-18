'use strict';

/**
 * TX 状态上报源（用户自研检测装置的通用入口 + 平台内部发射信号）。
 *
 * 两条轨道：
 *   1. 外部上报：source_id + tx_active 的通用入口，维护 last_seen / health / latency；
 *      source_id 命中台账里的设备 id 时自动绑到该设备，零配置获得路径级互锁。
 *   2. 内部推断：功放 transmitting、驻波表正向功率/tx_active、N1MM is_transmitting，
 *      这些信号平台本来就收得到，不需要再登记一遍。
 *
 * 选源不再看人工优先级，而是按设备类型降级：功放 > 驻波表 > 外部/其它 > 电台（N1MM）。
 * priority 退化成同一档内的人工越权位（默认为 0，越小越优先）。
 *
 * 降级：超时即不可用；全部不可用等同“无源正在报发射”，
 * 不阻断、不沿用旧值、不把 unknown 当作正在发射。
 */

const runtime = require('./runtime.js');

const RUNTIME_KEY = 'txRuntime';
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_PRIORITY = 0;
const MAX_SOURCE_ID = 64;
const MAX_NAME = 60;
const MAX_TOKEN = 200;
/** 内部信号只在这么旧之前就认定发射结束：设备侧本来就是这个量级的心跳。 */
const INTERNAL_TIMEOUT_MS = 10000;

/** 类型名次：数字越小越优先，决定降级顺序。 */
const TYPE_RANK = {amp: 1, swr: 2, other: 3, radio: 4};

function typeRankOf(type) {
    if (type === 'amp') return TYPE_RANK.amp;
    if (type === 'swr') return TYPE_RANK.swr;
    if (type === 'radio') return TYPE_RANK.radio;
    return TYPE_RANK.other;
}

function runtimeStates(global) {
    const value = global && typeof global.get === 'function' ? global.get(RUNTIME_KEY) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function saveRuntime(global, value) {
    if (global && typeof global.set === 'function') global.set(RUNTIME_KEY, value);
}

function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

function toMs(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSourceId(value) {
    const id = String(value === undefined || value === null ? '' : value).trim();
    return id && id.length <= MAX_SOURCE_ID ? id : '';
}

function truthyFlag(value) {
    return value === true || value === 1 || value === '1';
}

function norm(value) {
    return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function deviceTypeOf(devices, id) {
    if (!id) return '';
    const hit = (Array.isArray(devices) ? devices : []).find(item => item && item.id === id);
    return hit ? String(hit.type || '') : '';
}

/** source_id 命中设备 id 就绑到那台设备，互锁范围从全局收窄到该设备的 RF 路径。 */
function bindDeviceId(source, devices) {
    if (source.device_id) return source.device_id;
    const type = deviceTypeOf(devices, source.source_id);
    return type ? source.source_id : null;
}

/**
 * 收到一帧上报。未知 source_id 自动登记；已配置 token 的源必须带 X-DX-TX-Token。
 * 设备归属不再写入登记表，由 bindDeviceId 在读侧派生，存量数据无需迁移。
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

    const all = runtimeStates(global);
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
            device_id: '',
            token: '',
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

/** 内部源的统一形状，字段与登记源快照一致。 */
function internalEntry(id, type, name, device, seenMs, nowMs, timeoutMs) {
    return {
        source_id: id,
        name,
        priority: DEFAULT_PRIORITY,
        timeout_ms: timeoutMs,
        device_id: device || null,
        has_token: false,
        health: healthOf(seenMs, nowMs, timeoutMs),
        tx_active: true,
        last_seen: new Date(seenMs).toISOString(),
        age_ms: Math.max(0, nowMs - seenMs),
        latency_ms: null,
        seq: null,
        origin: 'internal',
        device_type: type,
        type_rank: typeRankOf(type)
    };
}

/** 电台台账里的 computer 命中席位键或 N1MM 上报的机名/台名就算同一台。 */
function radioDeviceFor(radioDevice, seat, view) {
    const config = asObject(radioDevice.config) || {};
    const computer = norm(config.computer);
    if (!computer) return false;
    return computer === norm(seat) || computer === norm(view.stationName) || computer === norm(view.radioName);
}

/**
 * 平台内部已有的发射证据，归一成与登记源同构的记录。
 * 只在“确实正在发射且信号未过期”时产出，空闲设备不进清单。
 */
function internalSources(global, devices, now) {
    const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
    const nowMs = at.getTime();
    const list = Array.isArray(devices) ? devices : [];
    const states = runtime.read(global);
    const out = [];

    for (const device of list) {
        if (!device || !device.id) continue;
        const type = String(device.type || '');
        if (type !== 'amp' && type !== 'swr') continue;
        const entry = asObject(states[device.id]);
        if (!entry) continue;
        // 功放走 updateEntry（只有 updated_ms），驻波表走 record（last_report_ms）。
        const seenMs = toMs(entry.updated_ms !== undefined && entry.updated_ms !== null
            ? entry.updated_ms : entry.last_report_ms);
        if (seenMs === null || nowMs - seenMs > INTERNAL_TIMEOUT_MS) continue;
        const amp = asObject(entry.amp);
        const active = type === 'amp'
            ? truthyFlag(amp && amp.transmitting)
            : entry.tx_active === true ||
                (Number.isFinite(Number(entry.fwd_power_w)) && Number(entry.fwd_power_w) > 0);
        if (!active) continue;
        out.push(internalEntry(device.id, type, device.name || device.id, device.id,
            seenMs, nowMs, INTERNAL_TIMEOUT_MS));
    }

    const radios = asObject(global && typeof global.get === 'function' ? global.get('radioStates') : null) || {};
    for (const seat of Object.keys(radios)) {
        const view = asObject(radios[seat]);
        if (!view || view.isTransmitting !== true) continue;
        const seenMs = toMs(view.ts);
        if (seenMs === null || nowMs - seenMs > INTERNAL_TIMEOUT_MS) continue;
        const hit = list.find(device => device && device.type === 'radio' && radioDeviceFor(device, seat, view));
        const radioNr = String(view.radioNr || '1');
        const label = 'N1MM ' + seat + (view.opCall ? ' / ' + view.opCall : '');
        out.push(internalEntry(('n1mm:' + seat + ':' + radioNr).slice(0, MAX_SOURCE_ID), 'radio', label,
            hit ? hit.id : null, seenMs, nowMs, INTERNAL_TIMEOUT_MS));
    }

    return out;
}

/**
 * 只读快照：每个源的降级名次/健康/最近上报，以及当前生效源。
 * state: none = 无人报发射；interrupted = 登记了源但全部通信中断；ok = 有可用源。
 * devices 用于 source_id 自动绑设备、类型名次与内部源，缺省不影响外部上报轨道。
 */
function snapshot(global, sources, now, devices) {
    const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
    const nowMs = at.getTime();
    const all = runtimeStates(global);
    const list = (Array.isArray(sources) ? sources : []).map(source => {
        const runtimeEntry = all[source.source_id] || null;
        const timeoutMs = timeoutOf(source);
        const health = runtimeEntry ? healthOf(runtimeEntry.last_seen_ms, nowMs, timeoutMs) : 'offline';
        const deviceId = bindDeviceId({device_id: source.device_id || null, source_id: source.source_id}, devices);
        const deviceType = deviceTypeOf(devices, deviceId);
        const priorityRaw = Number(source.priority);
        return {
            source_id: source.source_id,
            name: source.name || source.source_id,
            priority: Number.isFinite(priorityRaw) ? priorityRaw : DEFAULT_PRIORITY,
            timeout_ms: timeoutMs,
            device_id: deviceId,
            has_token: !!source.token,
            health,
            tx_active: runtimeEntry ? !!runtimeEntry.tx_active : null,
            last_seen: runtimeEntry ? runtimeEntry.last_seen : null,
            age_ms: runtimeEntry && Number.isFinite(runtimeEntry.last_seen_ms)
                ? Math.max(0, nowMs - runtimeEntry.last_seen_ms) : null,
            latency_ms: runtimeEntry && Number.isFinite(runtimeEntry.latency_ms)
                ? runtimeEntry.latency_ms : null,
            seq: runtimeEntry ? runtimeEntry.seq : null,
            origin: 'external',
            device_type: deviceType,
            type_rank: typeRankOf(deviceType)
        };
    });

    // 同一台设备上，仍然健康的外部上报优先，内部推断只兜底，避免一个设备两把锁。
    const claimed = new Set(list.filter(item => item.device_id && item.health === 'ok')
        .map(item => item.device_id));
    const internal = internalSources(global, devices, at)
        .filter(item => !item.device_id || !claimed.has(item.device_id));
    const merged = list.concat(internal).sort((a, b) => a.type_rank - b.type_rank ||
        a.priority - b.priority || String(a.source_id).localeCompare(String(b.source_id)));

    const usable = merged.filter(item => item.health === 'ok');
    const current = usable.length ? usable[0] : null;
    const state = !merged.length ? 'none' : (current ? 'ok' : 'interrupted');

    return {
        state,
        current,
        sources: merged,
        default_timeout_ms: DEFAULT_TIMEOUT_MS,
        internal_timeout_ms: INTERNAL_TIMEOUT_MS,
        tx_active: current ? current.tx_active : null
    };
}

/** 天线切换互锁的准入判定（本阶段没有写操作，接口留给后续阶段复用）。 */
function selectSource(global, sources, now, devices) {
    const snap = snapshot(global, sources, now, devices);
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
    const all = runtimeStates(global);
    if (!Object.prototype.hasOwnProperty.call(all, sourceId)) return false;
    delete all[sourceId];
    saveRuntime(global, all);
    return true;
}

module.exports = {
    RUNTIME_KEY,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_PRIORITY,
    INTERNAL_TIMEOUT_MS,
    MAX_SOURCE_ID,
    MAX_NAME,
    MAX_TOKEN,
    TYPE_RANK,
    typeRankOf,
    healthOf,
    ingest,
    internalSources,
    snapshot,
    selectSource,
    reset,
    forget
};
