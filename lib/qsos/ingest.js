'use strict';

const n1mm = require('./n1mm.js');
const storage = require('../storage');
const {saveRadio, saveScore} = require('./service.js');

const TOKEN_HEADER = 'x-dx-token';
const MAX_TOKEN_LEN = 200;

function headerValue(headers, name) {
    const h = headers || {};
    const want = String(name).toLowerCase();
    for (const key of Object.keys(h)) {
        if (String(key).toLowerCase() === want) return String(h[key] === undefined || h[key] === null ? '' : h[key]);
    }
    return '';
}

/** HTTP relay 的令牌：优先 X-DX-Token 头，其次 ?token=。 */
function tokenFrom(req) {
    const q = (req && req.query) || {};
    return headerValue(req && req.headers, TOKEN_HEADER) || String(q.token || '');
}

/** 定长比较，避免按字符提前返回泄露令牌长度。 */
function authorized(given, expected) {
    const a = String(given === undefined || given === null ? '' : given);
    const b = String(expected === undefined || expected === null ? '' : expected);
    if (!b || !a || a.length > MAX_TOKEN_LEN || b.length > MAX_TOKEN_LEN) return false;
    let diff = a.length ^ b.length;
    for (let i = 0; i < b.length; i++) {
        diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function qsoKey(qso) {
    if (qso.n1mmId) return qso;
    // 缺 ID 的包仍要能落库：用可重复计算的键，重发不会新增一行。
    qso.n1mmId = [qso.call, qso.ts, qso.band, qso.mode].join('|');
    return qso;
}

/**
 * 归一化 + 落库 SQL。UDP 与 HTTP 都调用这一个函数。
 * 电台/分数同时写内存状态，前端与规则引擎无需等到下一次轮询。
 */
function ingest(global, payload, now) {
    const result = n1mm.normalize(payload, now || new Date());
    if (result.kind === 'qso') {
        const qso = qsoKey(result.event);
        return {ok: true, kind: 'qso', event: qso, sql: storage.qso.upsert(qso)};
    }
    if (result.kind === 'delete') {
        const removed = result.event;
        return {
            ok: true,
            kind: 'delete',
            event: removed.qso,
            sql: storage.qso.remove(removed.id, removed.call, removed.timestamp)
        };
    }
    if (result.kind === 'radio') {
        const radio = saveRadio(global, payload, now || new Date());
        return {ok: true, kind: 'radio', event: radio, sql: storage.n1mm.radioUpsert(radio)};
    }
    if (result.kind === 'score') {
        const score = saveScore(global, payload, now || new Date());
        return {ok: true, kind: 'score', event: score, sql: storage.n1mm.scoreUpsert(score)};
    }
    return {ok: false, statusCode: 400, error: result.error || 'unrecognized-packet'};
}

/** 重启后把落库的电台/分数恢复到 global（已有实时状态时不覆盖）。 */
function restore(global, rows) {
    const list = Array.isArray(rows) ? rows : [];
    const radios = {};
    let score = null;
    for (const row of list) {
        if (!row || typeof row !== 'object') continue;
        if (row.kind === 'radio') {
            radios[row.id || '1'] = {
                type: 'radio',
                ts: row.ts,
                radioNr: row.id,
                freqKhz: row.freq_khz === null ? null : Number(row.freq_khz),
                txFreqKhz: row.tx_freq_khz === null ? null : Number(row.tx_freq_khz),
                mode: row.mode || '',
                isRunning: !!row.is_running,
                isTransmitting: !!row.is_transmitting,
                isSplit: !!row.is_split,
                opCall: row.op_call || '',
                radioName: row.radio_name || '',
                stationName: row.station_name || ''
            };
        } else if (row.kind === 'score') {
            score = {
                type: 'score',
                ts: row.ts,
                contest: row.contest || '',
                qsos: Number(row.qsos) || 0,
                mults: Number(row.mults) || 0,
                points: Number(row.points) || 0,
                score: Number(row.score) || 0
            };
        }
    }

    let changed = false;
    const current = global.get('radioStates');
    if (!current || !Object.keys(current).length) {
        const keys = Object.keys(radios);
        if (keys.length) {
            keys.sort();
            global.set('radioStates', radios);
            global.set('radioState', radios[keys[0]]);
            changed = true;
        }
    }
    if (score && !global.get('scoreState')) {
        global.set('scoreState', score);
        changed = true;
    }
    return changed;
}

module.exports = {TOKEN_HEADER, headerValue, tokenFrom, authorized, ingest, restore};
