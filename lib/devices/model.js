'use strict';

/**
 * 统一节点模型的纯函数：单父、无环、删除保护、天线波段与安装偏移。
 *
 * 类型不做白名单：任何类型都可以当父，也可以当子；校验只保留
 * “单父（字段天然保证）+ 无环 + 有子节点禁止删除”三条。
 */

const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const BAND_PATTERN = /^\d{1,3}m$/;
const MAX_NAME = 60;
const MAX_BANDS = 16;
const MAX_NOTES = 200;
const MAX_PASSWORD = 200;
const MAX_PORT = 32;
const DEFAULT_TRAVEL_TIMEOUT_SEC = 120;

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function fail(status, error, detail) {
    return {ok: false, status, error, detail: detail || ''};
}

/** 0–359 整数；空值按 0 处理，越界拒绝。 */
function parseOffset(value) {
    if (value === undefined || value === null || value === '') return {ok: true, value: 0};
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 359) return {ok: false};
    return {ok: true, value: n};
}

/** 实际指向 =（物理角度 + 安装偏移）mod 360。 */
function actualAzimuth(physical, offset) {
    if (physical === null || physical === undefined || physical === '') return null;
    const p = Number(physical);
    if (!Number.isFinite(p)) return null;
    const o = Number(offset);
    const shift = Number.isFinite(o) ? o : 0;
    return Math.round((((p + shift) % 360) + 360) % 360 * 10) / 10;
}

/** 指令去重用的角度归一化：360 与 0 视为同一角度。 */
function normalizeAngle(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round((((n % 360) + 360) % 360)) % 360;
}

function parseBands(value) {
    const raw = Array.isArray(value) ? value : String(value === undefined || value === null ? '' : value)
        .split(/[,;\s]+/);
    const bands = [];
    const invalid = [];
    for (const item of raw) {
        const band = text(item).toLowerCase();
        if (!band) continue;
        if (!BAND_PATTERN.test(band)) {
            if (!invalid.includes(band)) invalid.push(band);
            continue;
        }
        if (!bands.includes(band)) bands.push(band);
    }
    return {bands: bands.slice(0, MAX_BANDS), invalid};
}

function normalizeType(value) {
    const type = text(value).toLowerCase();
    return TYPE_PATTERN.test(type) ? type : '';
}

function nextId(devices, type) {
    const prefix = (type || 'device') + '-';
    let max = 0;
    for (const device of devices || []) {
        const id = text(device && device.id);
        if (!id.startsWith(prefix)) continue;
        const suffix = parseInt(id.slice(prefix.length), 10);
        if (Number.isFinite(suffix) && suffix > max) max = suffix;
    }
    return prefix + (max + 1);
}

function indexById(devices) {
    const map = new Map();
    for (const device of devices || []) {
        if (device && device.id) map.set(device.id, device);
    }
    return map;
}

/** 从 parentId 沿父链上溯，遇到 id 本身即判定成环。 */
function wouldCycle(devices, id, parentId) {
    const map = indexById(devices);
    const seen = new Set();
    let cursor = parentId || null;
    while (cursor) {
        if (cursor === id) return true;
        if (seen.has(cursor)) return true;
        seen.add(cursor);
        const parent = map.get(cursor);
        if (!parent) return false;
        cursor = parent.parent_id || null;
    }
    return false;
}

function childrenOf(devices, id) {
    return (devices || []).filter(device => device && device.parent_id === id);
}

/** 一期策略：禁止删除有子节点的设备，先移走或删除子树。 */
function deleteBlockReason(devices, id) {
    const node = indexById(devices).get(id);
    if (!node) return fail(404, 'unknown-device');
    const children = childrenOf(devices, id);
    if (children.length) return fail(409, 'has-children', children.map(child => child.id).join(','));
    return {ok: true, device: node};
}

/** 某副天线由哪台旋转器控制：沿父链找最近的 rotator 祖先。 */
function resolveRotator(devices, id) {
    const map = indexById(devices);
    const self = map.get(id);
    if (!self) return null;
    const seen = new Set([id]);
    let cursor = self.parent_id || null;
    while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const node = map.get(cursor);
        if (!node) return null;
        if (node.type === 'rotator') return node;
        cursor = node.parent_id || null;
    }
    return null;
}

/** 树形输出：roots 与已按 name 排序的子节点。 */
function buildTree(devices) {
    const map = indexById(devices);
    const children = new Map();
    const roots = [];
    for (const device of devices || []) {
        const key = device.parent_id && map.has(device.parent_id) ? device.parent_id : null;
        if (key === null) roots.push(device);
        else {
            if (!children.has(key)) children.set(key, []);
            children.get(key).push(device);
        }
    }
    const byName = (a, b) => text(a.name).localeCompare(text(b.name)) || text(a.id).localeCompare(text(b.id));
    const seen = new Set();
    const build = (device, depth) => {
        if (seen.has(device.id)) return null;
        seen.add(device.id);
        const kids = (children.get(device.id) || []).slice().sort(byName);
        return {
            id: device.id,
            name: device.name,
            type: device.type,
            parent_id: device.parent_id,
            depth,
            children: kids.map(child => build(child, depth + 1)).filter(Boolean)
        };
    };
    return roots.slice().sort(byName).map(root => build(root, 0));
}

function publicDevice(device) {
    const d = device || {};
    return {
        id: d.id,
        name: d.name,
        type: d.type,
        parent_id: d.parent_id || null,
        bands: (d.bands || []).slice(),
        install_offset_deg: d.install_offset_deg || 0,
        exclusive: !!d.exclusive,
        port_label: d.port_label || '',
        enabled: d.enabled !== false,
        travel_timeout_sec: d.travel_timeout_sec || DEFAULT_TRAVEL_TIMEOUT_SEC,
        notes: d.notes || '',
        has_password: !!d.password,
        created_ts: d.created_ts || null,
        updated_ts: d.updated_ts || null
    };
}

/**
 * 归一化 + 校验一条设备配置。
 * 更新时以现有行为底，未提供的字段保持不变；password 不传 = 不改，传空串 = 清除。
 */
function normalizeDevice(input, options) {
    const opts = options || {};
    const devices = opts.devices || [];
    const now = opts.now instanceof Date ? opts.now : new Date();
    const iso = now.toISOString();
    const body = input && typeof input === 'object' ? input : {};
    const existing = body.id ? indexById(devices).get(text(body.id)) : null;
    const isUpdate = !!existing;

    const type = normalizeType(body.type === undefined && existing ? existing.type : body.type);
    if (!type) return fail(400, 'invalid-type');

    const id = existing ? existing.id : (text(body.id) || nextId(devices, type));
    if (!isUpdate && devices.some(device => device.id === id)) return fail(409, 'duplicate-id');

    const name = text(body.name === undefined && existing ? existing.name : body.name).slice(0, MAX_NAME);
    if (!name) return fail(400, 'name-required');

    const parentRaw = body.parent_id === undefined && existing
        ? existing.parent_id
        : body.parent_id;
    const parentId = text(parentRaw) || null;
    if (parentId) {
        if (parentId === id) return fail(409, 'cycle', 'self');
        if (!indexById(devices).has(parentId)) return fail(404, 'unknown-parent', parentId);
        if (wouldCycle(devices, id, parentId)) return fail(409, 'cycle', parentId);
    }

    const parsedBands = parseBands(body.bands === undefined && existing ? existing.bands : body.bands);
    if (parsedBands.invalid.length) return fail(400, 'invalid-band', parsedBands.invalid.join(','));
    if (type === 'antenna' && !parsedBands.bands.length) return fail(400, 'antenna-band-required');

    const offsetInput = body.install_offset_deg === undefined && existing
        ? existing.install_offset_deg : body.install_offset_deg;
    const offset = parseOffset(offsetInput);
    if (!offset.ok) return fail(400, 'invalid-offset');

    const exclusiveRaw = body.exclusive === undefined && existing ? existing.exclusive : body.exclusive;
    const travelRaw = body.travel_timeout_sec === undefined && existing
        ? existing.travel_timeout_sec : body.travel_timeout_sec;
    const travel = travelRaw === undefined || travelRaw === null || travelRaw === ''
        ? DEFAULT_TRAVEL_TIMEOUT_SEC : Number(travelRaw);
    if (!Number.isFinite(travel) || !Number.isInteger(travel) || travel < 5 || travel > 3600) {
        return fail(400, 'invalid-travel-timeout');
    }

    const notes = text(body.notes === undefined && existing ? existing.notes : body.notes).slice(0, MAX_NOTES);
    const port = text(body.port_label === undefined && existing ? existing.port_label : body.port_label)
        .slice(0, MAX_PORT);
    const enabledRaw = body.enabled === undefined && existing ? existing.enabled : body.enabled;
    const enabled = enabledRaw === undefined || enabledRaw === null ? true : enabledRaw !== false;

    let password = existing ? existing.password : '';
    if (Object.prototype.hasOwnProperty.call(body, 'password')) {
        password = text(body.password).slice(0, MAX_PASSWORD);
    }

    return {
        ok: true,
        created: !isUpdate,
        device: {
            id,
            name,
            type,
            parent_id: parentId,
            bands: parsedBands.bands,
            install_offset_deg: offset.value,
            exclusive: exclusiveRaw === true || exclusiveRaw === 1 || exclusiveRaw === '1',
            port_label: port,
            password: password || '',
            enabled,
            travel_timeout_sec: travel,
            notes,
            created_ts: existing ? existing.created_ts || iso : iso,
            updated_ts: iso
        }
    };
}

module.exports = {
    TYPE_PATTERN,
    BAND_PATTERN,
    DEFAULT_TRAVEL_TIMEOUT_SEC,
    parseOffset,
    actualAzimuth,
    normalizeAngle,
    parseBands,
    normalizeType,
    nextId,
    indexById,
    wouldCycle,
    childrenOf,
    deleteBlockReason,
    resolveRotator,
    buildTree,
    publicDevice,
    normalizeDevice
};
