'use strict';

const {matrixQuery} = require('../storage/qso-sql.js');
const {parseTime} = require('../analysis/service.js');

/**
 * DXCC × 波段倍率矩阵。
 *
 * 数据只来自 qsos 表：呼号在读取时解析成 DXCC 实体（与前端共用
 * public/shared/dxcc/callsign.mjs），QSO 表本身不新增 DXCC 列。
 * 赛事窗口取现有设置 wallTimerStart / wallTimerEnd（UTC）；没有设置时
 * 退化为“最近一届赛事”（按最新 QSO 的 contestname 推断），绝不写死日期。
 *
 * 三种状态：
 *   new     —— 该实体在该波段的首个 QSO 发生在当前窗口内（本届新增波段格）
 *   worked  —— 窗口内有 QSO（本届已通）
 *   pending —— 历史通过，但当前窗口内还没有（本届待补）
 */

const BAND_ORDER = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m', '70cm'];
const MODE_GROUPS = ['ALL', 'CW', 'SSB', 'DIGI'];
const DEFAULT_LIMIT = 20000;
const MAX_LIMIT = 50000;
const CALLS_PER_CELL = 5;

let resolverPromise = null;

/** Node 18 的 CJS 不能 require ESM，缓存一次动态 import。 */
function loadResolver() {
    if (!resolverPromise) resolverPromise = import('../../public/shared/dxcc/callsign.mjs');
    return resolverPromise;
}

function toEpoch(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return null;
    const isoText = /^\d{4}-\d{2}-\d{2} \d/.test(text) ? text.replace(' ', 'T') + 'Z' : text;
    const ms = Date.parse(isoText);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** 统一成 epoch 秒；'YYYY-MM-DD HH:MM:SS'（UTC）与 ISO 都接受。 */
function parseBound(value) {
    const text = parseTime(value);
    return text ? toEpoch(text) : null;
}

function iso(epochSeconds) {
    return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null;
}

/** CW / SSB / DIGI 三组；未识别模式归入 OTHER，不进入这三组的统计。 */
function modeGroup(raw) {
    const mode = String(raw === null || raw === undefined ? '' : raw).trim().toUpperCase();
    if (!mode) return 'OTHER';
    if (/^CW/.test(mode)) return 'CW';
    if (/^(SSB|USB|LSB|AM|FM|PHONE)$/.test(mode) || /SSB/.test(mode)) return 'SSB';
    if (/^(RTTY|FT[248]|JT|Q65|PSK|MFSK|DIGI|DIGITAL|OLIVIA|CONTESTIA|HELL|THOR|DOMINO)/.test(mode)) {
        return 'DIGI';
    }
    return 'OTHER';
}

function normalizeBand(raw) {
    const band = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
    return band || '?';
}

function bandRank(band) {
    const index = BAND_ORDER.indexOf(band);
    return index === -1 ? BAND_ORDER.length : index;
}

function sortBands(bands) {
    return bands.slice().sort((a, b) => bandRank(a) - bandRank(b) || a.localeCompare(b));
}

/**
 * 组装 SQL 与请求元数据。窗口优先级：查询参数 > 设置（wallTimerStart/End）。
 * 没有可用窗口时仍返回 SQL，由 buildMatrix() 退化为“最近一届赛事”。
 */
function prepare(query, settings) {
    const q = query || {};
    const rawMode = String(q.mode || 'ALL').trim().toUpperCase();
    const mode = MODE_GROUPS.includes(rawMode) ? rawMode : 'ALL';
    const scope = String(q.scope || 'contest').trim().toLowerCase() === 'all' ? 'all' : 'contest';
    const contest = q.contest ? String(q.contest).trim().toUpperCase() : null;
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    let from = parseBound(q.from);
    let to = parseBound(q.to);
    let windowSource = from !== null || to !== null ? 'query' : 'none';
    if (from === null && to === null && settings && typeof settings === 'object') {
        from = parseBound(settings.wallTimerStart);
        to = parseBound(settings.wallTimerEnd);
        if (from !== null || to !== null) windowSource = 'settings';
    }

    return {
        ok: true,
        error: null,
        sql: matrixQuery(limit),
        request: {
            mode,
            scope,
            contest,
            from,
            to,
            limit,
            perBand: !(settings && typeof settings === 'object' && settings.multPerBand === false),
            windowSource
        }
    };
}

function emptyCell() {
    return {count: 0, first: null, last: null, calls: new Map()};
}

function addRow(cells, band, row) {
    let cell = cells.get(band);
    if (!cell) {
        cell = emptyCell();
        cells.set(band, cell);
    }
    cell.count += 1;
    if (cell.first === null || row.ts < cell.first) cell.first = row.ts;
    if (cell.last === null || row.ts > cell.last) cell.last = row.ts;
    const entry = cell.calls.get(row.call) || {call: row.call, count: 0, last: null};
    entry.count += 1;
    if (entry.last === null || row.ts > entry.last) entry.last = row.ts;
    cell.calls.set(row.call, entry);
}

function finishCell(cell, inScope, windowFrom) {
    let status = 'pending';
    if (inScope) {
        status = Number.isFinite(windowFrom) && cell.first !== null && cell.first >= windowFrom
            ? 'new' : 'worked';
    }
    return {
        status,
        count: cell.count,
        inScope,
        first: iso(cell.first),
        last: iso(cell.last),
        calls: [...cell.calls.values()]
            .sort((a, b) => b.last - a.last)
            .slice(0, CALLS_PER_CELL)
            .map(item => ({call: item.call, count: item.count, last: iso(item.last)})),
        callCount: cell.calls.size
    };
}

function entityStatus(cells) {
    let worked = false;
    let fresh = false;
    for (const cell of cells) {
        if (cell.status === 'new') fresh = true;
        else if (cell.status === 'worked') worked = true;
    }
    if (fresh) return 'new';
    return worked ? 'worked' : 'pending';
}

function topCalls(calls) {
    return [...calls.values()]
        .sort((a, b) => b.last - a.last)
        .slice(0, CALLS_PER_CELL)
        .map(item => ({call: item.call, count: item.count, last: iso(item.last)}));
}

const STATUS_RANK = {new: 0, pending: 1, worked: 2};

/** 纯计算：把 qsos 行折叠成矩阵。resolveCall 由调用方注入，便于单测。 */
function buildMatrix(request, rows, resolveCall, activeEntities) {
    const req = request || {};
    const perBand = req.perBand !== false;
    const bandOf = row => (perBand ? row.band : 'ALL');
    const parsed = [];
    let skipped = 0;

    for (const row of Array.isArray(rows) ? rows : []) {
        const call = String((row && row.call) || '').trim().toUpperCase();
        const ts = toEpoch(row && row.timestamp);
        if (!call || ts === null) {
            skipped += 1;
            continue;
        }
        const group = modeGroup(row.mode);
        if (req.mode && req.mode !== 'ALL' && group !== req.mode) continue;
        const resolved = typeof resolveCall === 'function' ? resolveCall(call) : null;
        parsed.push({
            call,
            ts,
            band: normalizeBand(row.band),
            contest: String((row && row.contestname) || '').trim().toUpperCase(),
            dxcc: resolved && Number.isFinite(resolved.dxcc) ? resolved.dxcc : null
        });
    }
    parsed.sort((a, b) => a.ts - b.ts);

    const contestName = req.contest || null;
    const history = contestName ? parsed.filter(row => row.contest === contestName) : parsed;

    let windowFrom = req.from === undefined ? null : req.from;
    let windowTo = req.to === undefined ? null : req.to;
    let windowSource = req.windowSource || 'none';
    let inScope = history;
    let scopeContest = contestName;

    if (req.scope === 'all') {
        windowFrom = null;
        windowTo = null;
        windowSource = 'none';
    } else if (windowFrom === null && windowTo === null) {
        // 没有显式窗口：用最新一条 QSO 的赛事名推断“本届”，窗口取该赛事首末时间。
        const latest = history[history.length - 1];
        if (latest && latest.contest) {
            scopeContest = scopeContest || latest.contest;
            const sameContest = history.filter(row => row.contest === scopeContest);
            if (sameContest.length) {
                inScope = sameContest;
                windowFrom = sameContest[0].ts;
                windowTo = sameContest[sameContest.length - 1].ts;
                windowSource = 'derived';
            }
        }
    } else {
        inScope = history.filter(row =>
            (windowFrom === null || row.ts >= windowFrom) &&
            (windowTo === null || row.ts <= windowTo));
    }

    // 每个“实体 × 波段”在窗口内的 QSO 数：决定 worked / pending。
    const scopeCount = new Map();
    for (const row of inScope) {
        const key = `${row.dxcc === null ? 'unknown' : row.dxcc}|${bandOf(row)}`;
        scopeCount.set(key, (scopeCount.get(key) || 0) + 1);
    }

    const bands = perBand ? sortBands([...new Set(history.map(row => row.band))]) : ['ALL'];
    const entities = new Map();
    const unknown = {cells: new Map(), calls: new Map()};

    for (const row of history) {
        const band = bandOf(row);
        if (row.dxcc === null) {
            addRow(unknown.cells, band, row);
            const entry = unknown.calls.get(row.call) || {call: row.call, count: 0, last: null};
            entry.count += 1;
            if (entry.last === null || row.ts > entry.last) entry.last = row.ts;
            unknown.calls.set(row.call, entry);
            continue;
        }
        let entity = entities.get(row.dxcc);
        if (!entity) {
            const meta = typeof resolveCall === 'function' ? resolveCall(row.call) : null;
            entity = {
                country: (meta && meta.country) || '',
                prefix: (meta && meta.prefix) || '',
                deleted: Boolean(meta && meta.deleted),
                cells: new Map(),
                calls: new Map()
            };
            entities.set(row.dxcc, entity);
        }
        addRow(entity.cells, band, row);
        const entry = entity.calls.get(row.call) || {call: row.call, count: 0, last: null};
        entry.count += 1;
        if (entry.last === null || row.ts > entry.last) entry.last = row.ts;
        entity.calls.set(row.call, entry);
    }

    const totals = {entities: 0, worked: 0, pending: 0, new: 0,
        slotsWorked: 0, slotsPending: 0, slotsNew: 0, qsos: history.length};
    const rowsOut = [];

    for (const [dxcc, record] of entities) {
        const cells = {};
        for (const [band, cell] of record.cells) {
            const inScopeCell = (scopeCount.get(`${dxcc}|${band}`) || 0) > 0;
            cells[band] = finishCell(cell, inScopeCell, windowFrom);
        }
        const list = Object.values(cells);
        for (const cell of list) {
            if (cell.status === 'new') totals.slotsNew += 1;
            else if (cell.status === 'worked') totals.slotsWorked += 1;
            else totals.slotsPending += 1;
        }
        const status = entityStatus(list);
        totals.entities += 1;
        totals[status] += 1;
        rowsOut.push({
            dxcc,
            country: record.country,
            prefix: record.prefix,
            deleted: record.deleted,
            status,
            cells,
            calls: topCalls(record.calls),
            callCount: record.calls.size
        });
    }

    rowsOut.sort((a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        String(a.country || a.dxcc).localeCompare(String(b.country || b.dxcc)));

    const unknownBands = perBand ? sortBands([...new Set(unknown.cells.keys())]) : ['ALL'];
    const unknownCells = {};
    for (const band of unknownBands) {
        const cell = unknown.cells.get(band);
        if (!cell) continue;
        unknownCells[band] = finishCell(cell, (scopeCount.get(`unknown|${band}`) || 0) > 0, windowFrom);
    }

    const warnings = [];
    if (req.scope !== 'all' && !Number.isFinite(windowFrom)) warnings.push('no-window');
    if (parsed.length >= (req.limit || DEFAULT_LIMIT)) warnings.push('truncated');

    const workedEntities = totals.worked + totals.new;
    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        scope: req.scope === 'all' ? 'all' : 'contest',
        mode: req.mode || 'ALL',
        perBand,
        window: {from: iso(windowFrom), to: iso(windowTo), source: windowSource},
        contest: scopeContest || null,
        bands,
        activeEntities: Number.isFinite(activeEntities) ? activeEntities : null,
        totals: {
            ...totals,
            completed: workedEntities,
            completion: Number.isFinite(activeEntities) && activeEntities > 0
                ? Number((workedEntities / activeEntities).toFixed(4)) : null
        },
        rows: rowsOut,
        unknown: {
            calls: [...unknown.calls.values()].sort((a, b) => b.last - a.last)
                .slice(0, 20)
                .map(item => ({call: item.call, count: item.count, last: iso(item.last)})),
            callCount: unknown.calls.size,
            cells: unknownCells
        },
        warnings,
        skipped
    };
}

async function complete(prepared, rows) {
    if (!prepared || !prepared.ok) {
        return {ok: false, error: (prepared && prepared.error) || 'invalid-request'};
    }
    const {resolveCall, PREFIX_ENTRIES} = await loadResolver();
    const active = new Set();
    for (const entry of PREFIX_ENTRIES) {
        if (!entry.deleted) active.add(entry.dxcc);
    }
    return buildMatrix(prepared.request, rows, resolveCall, active.size);
}

module.exports = {
    BAND_ORDER,
    MODE_GROUPS,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    modeGroup,
    normalizeBand,
    sortBands,
    parseBound,
    prepare,
    buildMatrix,
    complete
};
