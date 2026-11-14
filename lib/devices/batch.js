'use strict';

/**
 * 草稿设备与草稿连线。
 *
 * 画布允许先把设备摆出来、先连线，最后一起保存。草稿本身只存在于页面内存，
 * 但连线是否合法必须在拖动当下就判定，所以这里提供两个纯函数：
 *
 *   preview()：把“已保存设备 + 草稿设备 + 待保存连线”拼成一份临时拓扑，
 *              复用 rf.normalizeLink / control.normalizeLink 做与落库完全一致
 *              的校验，返回草稿端口、规范化后的草稿连线与串口寻址结果；
 *   save()   ：把草稿设备按类型分配正式 id，重写连线端点后一次性校验，
 *              校验通过才生成 SQL，并在同一事务里写设备、布局与两类连线。
 *
 * 任何一条设备或连线不合法，都不会产生半截写入。
 */

const model = require('./model.js');
const rf = require('./rf.js');
const control = require('./control.js');
const storage = require('../storage');

const MAX_BATCH_DEVICES = 64;

function fail(status, error, detail) {
    return {ok: false, status, error, detail: detail || ''};
}

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function asList(value) {
    return Array.isArray(value) ? value : [];
}

/** 草稿设备统一成设备模型的最小形状，端口派生只依赖 type / config / bands。 */
function draftDevices(list) {
    const out = [];
    for (const raw of asList(list)) {
        if (!raw || typeof raw !== 'object') continue;
        const id = text(raw.id);
        if (!id) continue;
        out.push({
            id,
            name: text(raw.name),
            type: text(raw.type).toLowerCase(),
            parent_id: text(raw.parent_id) || null,
            bands: asList(raw.bands).map(band => text(band)).filter(Boolean),
            install_offset_deg: Number(raw.install_offset_deg) || 0,
            enabled: raw.enabled !== false,
            travel_timeout_sec: Number(raw.travel_timeout_sec) || 0,
            notes: text(raw.notes),
            config: raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? raw.config : {},
            draft: true
        });
    }
    return out;
}

/**
 * 逐条校验待保存连线。
 * 已保存的连线先占位，待保存的连线叠加在上面，因此端口占用判断与最终落库一致。
 */
function acceptLinks(saved, pending, normalize, devices) {
    const accepted = asList(saved).slice();
    const added = [];
    for (const raw of asList(pending)) {
        if (!raw || typeof raw !== 'object') return fail(400, 'invalid-link');
        const result = normalize(raw, {devices, links: accepted});
        if (!result.ok) return result;
        if (result.existing) continue;
        accepted.push(result.link);
        added.push(result.link);
    }
    return {ok: true, added};
}

/**
 * 草稿拓扑预览：不写库，只回答“这些端口长什么样、这些连线合不合法”。
 * @returns {{ok: boolean, ports?: object, control?: object, addresses?: object,
 *   rf_links?: Array, control_links?: Array, error?: string, detail?: string}}
 */
function preview(options) {
    const opts = options || {};
    const saved = asList(opts.devices);
    const drafts = draftDevices(opts.drafts);
    const all = saved.concat(drafts);

    const rfResult = acceptLinks(opts.links, opts.rfLinks, rf.normalizeLink, all);
    if (!rfResult.ok) return rfResult;
    const ctlResult = acceptLinks(opts.controlLinks, opts.ctlLinks, control.normalizeLink, all);
    if (!ctlResult.ok) return ctlResult;

    return {
        ok: true,
        ports: rf.portMap(drafts),
        control: rf.controlPortMap(drafts),
        addresses: control.addressMap(drafts, asList(opts.controlLinks).concat(ctlResult.added)),
        rf_links: rfResult.added.map(rf.publicLink),
        control_links: ctlResult.added.map(control.publicLink)
    };
}

function layoutOf(list) {
    const map = new Map();
    for (const item of asList(list)) {
        if (!item) continue;
        const id = text(item.id);
        const x = Number(item.x);
        const y = Number(item.y);
        if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        map.set(id, {x: Math.round(x), y: Math.round(y)});
    }
    return map;
}

/**
 * 批量保存：草稿设备分配正式 id，草稿连线端点跟着重写，全部校验通过后才出 SQL。
 * SQL 带 BEGIN/COMMIT，设备、布局与连线要么一起生效，要么都不生效。
 */
function save(options) {
    const opts = options || {};
    const now = opts.now instanceof Date ? opts.now : new Date();
    const iso = now.toISOString();
    const saved = asList(opts.devices);
    const incoming = asList(opts.input && opts.input.devices);
    if (!incoming.length) return fail(400, 'no-drafts');
    if (incoming.length > MAX_BATCH_DEVICES) return fail(400, 'too-many-drafts');

    const layouts = layoutOf(opts.input && opts.input.layouts);
    const idMap = {};
    const planned = [];
    // 先按类型分配正式 id，保证同一批里多台同类型设备的编号连续且不冲突。
    const assigned = saved.map(device => ({id: device.id, type: device.type}));
    for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') return fail(400, 'invalid-type');
        const tempId = text(raw.id);
        if (!tempId) return fail(400, 'invalid-type');
        const type = text(raw.type).toLowerCase();
        const id = model.nextId(assigned, type);
        assigned.push({id, type});
        idMap[tempId] = id;
        planned.push({raw, tempId, id});
    }

    const working = saved.slice();
    const created = [];
    for (const item of planned) {
        const rawParent = text(item.raw.parent_id);
        const parentId = rawParent ? (idMap[rawParent] || rawParent) : null;
        const result = model.normalizeDevice(
            Object.assign({}, item.raw, {id: item.id, parent_id: parentId}),
            {devices: working, now}
        );
        if (!result.ok) return result;
        working.push(result.device);
        created.push({device: result.device, tempId: item.tempId});
    }

    const remap = link => {
        const item = link && typeof link === 'object' ? link : {};
        return {
            a_device: idMap[text(item.a_device)] || text(item.a_device),
            a_port: text(item.a_port),
            b_device: idMap[text(item.b_device)] || text(item.b_device),
            b_port: text(item.b_port)
        };
    };

    const rfResult = acceptLinks(savedLinksOf(opts.links), asList(opts.input && opts.input.rf_links).map(remap),
        rf.normalizeLink, working);
    if (!rfResult.ok) return rfResult;
    const ctlResult = acceptLinks(savedLinksOf(opts.controlLinks),
        asList(opts.input && opts.input.control_links).map(remap), control.normalizeLink, working);
    if (!ctlResult.ok) return ctlResult;

    const sql = ['BEGIN IMMEDIATE;'];
    for (const item of created) sql.push(storage.devices.insertDevice(item.device));
    for (const item of created) {
        const layout = layouts.get(item.tempId);
        if (layout) sql.push(storage.devices.upsertLayout(item.device.id, layout.x, layout.y, iso));
    }
    for (const link of rfResult.added) {
        sql.push(storage.devices.insertRfLink(Object.assign({created_ts: iso}, link)));
    }
    for (const link of ctlResult.added) {
        sql.push(storage.devices.insertControlLink(Object.assign({created_ts: iso}, link)));
    }
    sql.push('COMMIT;');

    return {
        ok: true,
        payload: {
            ok: true,
            devices: created.map(item => model.publicDevice(item.device)),
            id_map: idMap,
            rf_links: rfResult.added.map(link => rf.publicLink(Object.assign({created_ts: iso}, link))),
            control_links: ctlResult.added.map(link => control.publicLink(Object.assign({created_ts: iso}, link)))
        },
        sql
    };
}

/** 已落库的连线可能来自快照里的完整字段，只保留规范化端点。 */
function savedLinksOf(list) {
    return asList(list).filter(link => link && link.link_id).map(link => ({
        link_id: link.link_id,
        a_device: text(link.a_device),
        a_port: text(link.a_port),
        b_device: text(link.b_device),
        b_port: text(link.b_port),
        created_ts: link.created_ts || null
    }));
}

module.exports = {preview, save, draftDevices};
