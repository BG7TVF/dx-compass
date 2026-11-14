'use strict';

/**
 * N1MM 原始报文最近的环形缓冲（进程内存，不落库、不写上下文）。
 *
 * 目的：排查“报文里缺字段”这类问题——保留最近若干条原始报文、来源与关键字段。
 * 上限同时按条数与总字符数收缩，旧报文滚动淘汰，内存不会无限增长。
 */

const MAX_PACKETS = 40;
const MAX_RAW_CHARS = 4096;
const MAX_TOTAL_CHARS = 128 * 1024;
const MAX_FIELD_CHARS = 120;

const KIND_PATTERNS = [
    ['RadioInfo', /<\s*RadioInfo[\s>]/i],
    ['ContactReplace', /<\s*contactreplace[\s>]/i],
    ['ContactInfo', /<\s*contactinfo[\s>]/i],
    ['ContactDelete', /<\s*contactdelete[\s>]/i],
    ['Score', /<\s*score[\s>]/i]
];

const FIELD_PATTERNS = {
    computerName: /<\s*ComputerName\s*>([^<]*)<\s*\/\s*ComputerName\s*>/i,
    radioName: /<\s*RadioName\s*>([^<]*)<\s*\/\s*RadioName\s*>/i,
    radioNr: /<\s*RadioNr\s*>([^<]*)<\s*\/\s*RadioNr\s*>/i,
    call: /<\s*call\s*>([^<]*)<\s*\/\s*call\s*>/i,
    stationName: /<\s*StationName\s*>([^<]*)<\s*\/\s*StationName\s*>/i,
    opCall: /<\s*OpCall\s*>([^<]*)<\s*\/\s*OpCall\s*>/i
};

let packets = [];
let totalChars = 0;
let received = 0;
let dropped = 0;

function text(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && typeof value.toString === 'function' && Buffer.isBuffer(value)) {
        return value.toString('utf8');
    }
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch (error) { return String(value); }
    }
    return String(value);
}

function clip(value, max) {
    return value.length > max ? value.slice(0, max) : value;
}

function sourceOf(ip, port) {
    const host = String(ip || '').trim();
    const number = String(port || '').trim();
    if (host && number) return `${host}:${number}`;
    return host || '—';
}

function detectKind(raw) {
    for (const [kind, pattern] of KIND_PATTERNS) {
        if (pattern.test(raw)) return kind;
    }
    return '';
}

function extractFields(raw, extra) {
    const fields = {};
    for (const [key, pattern] of Object.entries(FIELD_PATTERNS)) {
        const match = pattern.exec(raw);
        const value = match ? match[1].trim() : '';
        if (value) fields[key] = clip(value, MAX_FIELD_CHARS);
    }
    if (extra && typeof extra === 'object') {
        for (const [key, value] of Object.entries(extra)) {
            const clean = clip(text(value).trim(), MAX_FIELD_CHARS);
            if (clean) fields[key] = clean;
        }
    }
    return fields;
}

/**
 * 记一条原始报文。kind 可留空，会按 XML 根标签自动识别。
 * input: {raw, ip, port, kind, fields, at}
 */
function record(input) {
    const source = text(input && input.raw);
    const raw = clip(source, MAX_RAW_CHARS);
    const kind = detectKind(raw) || clip(String((input && input.kind) || ''), 40) || 'unknown';
    const at = input && input.at ? new Date(input.at) : new Date();
    const entry = {
        at: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
        source: sourceOf(input && input.ip, input && input.port),
        kind,
        bytes: source.length,
        truncated: source.length > MAX_RAW_CHARS,
        fields: extractFields(raw, input && input.fields),
        raw
    };
    packets.unshift(entry);
    totalChars += raw.length;
    received += 1;
    while (packets.length > MAX_PACKETS || (totalChars > MAX_TOTAL_CHARS && packets.length > 1)) {
        const removed = packets.pop();
        totalChars -= removed.raw.length;
        dropped += 1;
    }
    return entry;
}

/** 最近的报文，新的在前；同时给出上限与丢弃计数，便于判断是否滚掉了。 */
function list() {
    return {
        limit: MAX_PACKETS,
        limitChars: MAX_TOTAL_CHARS,
        received,
        dropped,
        kept: packets.length,
        updatedAt: packets.length ? packets[0].at : null,
        packets: packets.map(entry => Object.assign({}, entry, {fields: Object.assign({}, entry.fields)}))
    };
}

function clear() {
    packets = [];
    totalChars = 0;
    received = 0;
    dropped = 0;
}

module.exports = {
    MAX_PACKETS,
    MAX_RAW_CHARS,
    MAX_TOTAL_CHARS,
    record,
    list,
    clear,
    text,
    detectKind
};
