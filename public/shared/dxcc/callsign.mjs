/**
 * 呼号 → DXCC 实体解析（前后端共用，纯函数）。
 *
 * 数据来源：./prefixes.mjs（ARRL DXCC List 2026-01 edition，经 k0swe/dxcc-json
 * 的 dxcc-2026-01.csv 提取 prefix 列，抓取日期 2026-11-11）。
 *
 * 规则：
 *  1. 先匹配特殊字头（这些后缀本身决定实体，不能被当作移动标识剥掉）：
 *       KH8/S  → Swains Island (515)
 *       3D2/C  → Conway Reef (489)
 *       3D2/R  → Rotuma Island (460)
 *       FT5/W  → Crozet Islands (41)
 *       FT5/X  → Kerguelen Islands (131)
 *       FT5/Z  → Amsterdam and Saint-Paul Islands (10)
 *  2. 剥离移动/便携标识：/P、/M、/MM、/AM、/QRP、/A、/T、/LH 与 /数字。
 *  3. 按 ARRL 前缀表做最长前缀匹配；带斜杠的形式（DL/EA1ABC、K1ABC/KH8）
 *     同时比较“整串”和“各段”，取命中前缀最长的一段，长度相同取靠前的。
 *  4. 无法判定时返回 dxcc:null 且不编造国家名。
 */

import {PREFIX_ENTRIES} from './prefixes.mjs';

const PORTABLE = new Set(['P', 'M', 'MM', 'AM', 'QRP', 'A', 'T', 'LH']);

const SPECIAL = [
    [/^KH8\/S/, 515],
    [/^3D2\/?C/, 489],
    [/^3D2\/?R/, 460],
    [/^FT5\/?W/, 41],
    [/^FT5\/?X/, 131],
    [/^FT5\/?Z/, 10],
    [/^FT\/W/, 41],
    [/^FT\/X/, 131],
    [/^FT\/Z/, 10]
];

const ENTITIES = new Map(PREFIX_ENTRIES.map(entry => [entry.dxcc, entry]));

/** 前缀索引：长前缀优先；同长度时编号小的实体优先（3D2→Fiji、KH8→American Samoa）。 */
const PREFIX_INDEX = [];
for (const entry of PREFIX_ENTRIES) {
    for (const prefix of entry.prefixes) {
        PREFIX_INDEX.push({prefix, dxcc: entry.dxcc, deleted: entry.deleted});
    }
}
// 长前缀优先；同长度时现行实体优先（DL 归德国而非已删除的西德），再按编号。
PREFIX_INDEX.sort((a, b) => b.prefix.length - a.prefix.length ||
    Number(a.deleted) - Number(b.deleted) || a.dxcc - b.dxcc);

function matchPrefix(text) {
    if (!text) return null;
    for (const item of PREFIX_INDEX) {
        if (text.startsWith(item.prefix)) return item;
    }
    return null;
}

function stripPortable(segments) {
    return segments.filter(segment => segment && !PORTABLE.has(segment) && !/^\d{1,2}$/.test(segment));
}

function resultOf(raw, baseCall, dxcc) {
    const entry = dxcc === null ? null : ENTITIES.get(dxcc);
    return {
        call: raw,
        baseCall,
        dxcc: entry ? entry.dxcc : null,
        country: entry ? entry.name : '',
        prefix: entry ? entry.prefix : '',
        deleted: entry ? entry.deleted : false
    };
}

/** 解析呼号；空输入或无法判定时 dxcc 为 null。 */
export function resolveCall(raw) {
    const call = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!call) return null;
    const segments = stripPortable(call.split('/'));
    if (!segments.length) return null;
    const baseCall = segments.join('/');

    for (const [pattern, dxcc] of SPECIAL) {
        if (pattern.test(call)) return resultOf(call, baseCall, dxcc);
    }

    // 整串优先（处理 FT/W、DL/EA 这类带斜杠前缀），再逐段比较，取命中前缀最长者。
    const candidates = [baseCall].concat(segments);
    let best = null;
    let bestLength = -1;
    for (const text of candidates) {
        const match = matchPrefix(text);
        if (match && match.prefix.length > bestLength) {
            best = match;
            bestLength = match.prefix.length;
        }
    }
    return resultOf(call, baseCall, best ? best.dxcc : null);
}

export function normalizeCall(raw) {
    const call = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!call) return '';
    const segments = stripPortable(call.split('/'));
    return segments.length ? segments.join('/') : '';
}

export {PREFIX_ENTRIES};
