'use strict';

/**
 * 画布布局：纯展示坐标，不参与任何设备语义。
 *
 * 库里的 device_layout 只保存用户拖动过的位置；没有布局行的设备
 * （包括从旧版本升级上来的全部设备）按 parent_id 森林做确定性自动布局，
 * 保证第一次打开画布就能看到完整的树和连线。
 */

const model = require('./model.js');

const ORIGIN = 80;
const X_GAP = 280;
const Y_GAP = 120;
const MAX_COORD = 10000;
const MAX_BATCH = 200;

function byName(a, b) {
    const an = String((a && a.name) || '');
    const bn = String((b && b.name) || '');
    return an.localeCompare(bn) || String(a && a.id).localeCompare(String(b && b.id));
}

function parseCoord(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_COORD) return null;
    return n;
}

/**
 * 批量布局写入校验：只接受已存在的设备与 0–10000 的整数坐标。
 * 同一请求内重复 id 只保留第一次。
 */
function normalizeLayouts(input, devices) {
    if (!Array.isArray(input)) return {ok: false, status: 400, error: 'invalid-layouts'};
    if (input.length > MAX_BATCH) return {ok: false, status: 400, error: 'too-many-layouts'};
    const known = model.indexById(devices);
    const seen = new Set();
    const layouts = [];
    for (const item of input) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return {ok: false, status: 400, error: 'invalid-layout'};
        }
        const id = String(item.id === undefined || item.id === null ? '' : item.id).trim();
        if (!id) return {ok: false, status: 400, error: 'invalid-layout'};
        if (!known.has(id)) return {ok: false, status: 404, error: 'unknown-device'};
        const x = parseCoord(item.x);
        const y = parseCoord(item.y);
        if (x === null || y === null) return {ok: false, status: 400, error: 'invalid-layout'};
        if (seen.has(id)) continue;
        seen.add(id);
        layouts.push({id, x, y});
    }
    return {ok: true, layouts};
}

/**
 * 确定性自动布局：深度决定列，先序遍历决定行；根与兄弟节点按名称排序。
 * 环或孤立节点兜底到最后一列，保证每个设备都有坐标。
 */
function autoLayout(devices) {
    const list = Array.isArray(devices) ? devices : [];
    const known = model.indexById(list);
    const children = new Map();
    const roots = [];
    for (const device of list) {
        const parentId = device.parent_id && known.has(device.parent_id) ? device.parent_id : null;
        if (parentId) {
            if (!children.has(parentId)) children.set(parentId, []);
            children.get(parentId).push(device);
        } else {
            roots.push(device);
        }
    }
    for (const kids of children.values()) kids.sort(byName);
    roots.sort(byName);

    const positions = {};
    const visited = new Set();
    const rowByDepth = [];

    function walk(device, depth) {
        if (visited.has(device.id)) return;
        visited.add(device.id);
        const row = rowByDepth[depth] || 0;
        rowByDepth[depth] = row + 1;
        positions[device.id] = {x: ORIGIN + depth * X_GAP, y: ORIGIN + row * Y_GAP};
        for (const child of children.get(device.id) || []) walk(child, depth + 1);
    }

    for (const root of roots) walk(root, 0);

    // 环内节点不可达：按 id 顺序放到最后一列，保证一定渲染得出来。
    const stray = list.filter(device => !visited.has(device.id)).sort(byName);
    let row = 0;
    for (const device of stray) {
        positions[device.id] = {
            x: ORIGIN + (rowByDepth.length + 1) * X_GAP,
            y: ORIGIN + row * Y_GAP
        };
        row += 1;
    }
    return positions;
}

/** 快照输出：库里的位置优先，否则用自动布局补位。 */
function withLayouts(devices) {
    const list = Array.isArray(devices) ? devices : [];
    const auto = autoLayout(list);
    return list.map(device => {
        const saved = !!device.layout_saved && device.layout !== null && device.layout !== undefined;
        const layout = saved ? device.layout : (auto[device.id] || {x: ORIGIN, y: ORIGIN});
        return Object.assign({}, device, {layout, layout_saved: saved});
    });
}

module.exports = {
    ORIGIN,
    X_GAP,
    Y_GAP,
    MAX_COORD,
    MAX_BATCH,
    parseCoord,
    normalizeLayouts,
    autoLayout,
    withLayouts
};
