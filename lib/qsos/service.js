'use strict';

const storage = require('../storage');
const n1mm = require('./n1mm.js');
const {parseRadio, parseScore} = n1mm;
const seat = require('./seat.js');
const seatIdentity = require('./seat-identity.js');
const {listFrequencyClaims} = require('./frequency-claims.js');

/**
 * 直收 UDP 的报文不经过 resolveSeat，这里补记 ComputerName / RadioName，
 * 否则设备表单的下拉候选只能看到 HTTP relay 进来的报文。
 */
function learnPacket(global, fields, now) {
    if (!global || typeof global.get !== 'function') return null;
    return seatIdentity.learn(global, fields, now);
}

/** 供 UDP 入口使用：解析 ContactInfo 的同时把候选记进席位缓存。
 *  兼容旧的 parseContact(payload, now, meta) 调用（没有 global 时只解析）。 */
function parseContact(first, second, third, fourth) {
    if (first && typeof first.get === 'function' && typeof first.set === 'function') {
        const global = first;
        const now = third || new Date();
        const meta = fourth || {};
        const qso = n1mm.parseContact(second, now, meta);
        if (qso) {
            learnPacket(global, {
                computerName: qso.computerName,
                radioName: qso.radioName,
                radioNr: qso.radioNr,
                ip: meta.ip,
                port: meta.port,
                stationName: qso.stationName
            }, now);
        }
        return qso;
    }
    return n1mm.parseContact(first, second, third);
}

function saveRadio(global, payload, now, meta) {
    const radio = parseRadio(payload, now, meta);
    if (!radio) return null;
    learnPacket(global, {
        computerName: radio.computerName,
        radioName: radio.radioName,
        radioNr: radio.radioNr,
        ip: meta && meta.ip,
        port: meta && meta.port
    }, now);
    return saveRadioState(global, radio);
}

/** 已解析的电台事件入库：ingest 已解析一次，避免二次解析重复触发席位识别。 */
function saveRadioState(global, parsed) {
    const radio = parsed;
    if (!radio) return null;
    const key = radio.seat || seat.seatKeyFrom(radio.instance, radio.radioNr);
    radio.seat = key;
    global.set('radioState', radio);

    const states = global.get('radioStates') || {};
    states[key] = radio;
    global.set('radioStates', states);

    // 操作员轮换：只在 OpCall 变化时追加一条，历史不覆盖。
    const sessions = global.get('operatorSessions') || {};
    const current = sessions[key];
    const operator = String(radio.opCall || '').trim().toUpperCase();
    if (operator && (!current || current.operator !== operator)) {
        sessions[key] = {
            seat: key,
            operator,
            radioNr: radio.radioNr,
            startTs: radio.ts
        };
        global.set('operatorSessions', sessions);
        radio.operatorChangedAt = radio.ts;
    }
    radio.operatorSince = sessions[key] ? sessions[key].startTs : null;
    return radio;
}

function saveScore(global, payload, now) {
    const score = parseScore(payload, now);
    if (!score) return null;
    global.set('scoreState', score);
    return score;
}

function coordinateRoute(qso, hasQrzKey) {
    if (!qso) return null;
    if (qso.type === 'qsoDelete') return 'broadcast';
    if (hasQrzKey) return 'qrz';
    if (qso.lat !== null && qso.lat !== undefined) return 'broadcast';
    return 'spots';
}

function coordinateTopic(qso) {
    return storage.spots.coordinatesForCall(qso.call);
}

function applySpotCoords(qso, rows) {
    rows = Array.isArray(rows) ? rows : [];
    if (rows.length && rows[0].dx_lat !== null && rows[0].dx_lat !== undefined) {
        qso.lat = rows[0].dx_lat;
        qso.lon = rows[0].dx_lon;
    }
    return qso;
}

function stationState(global) {
    const radios = global.get('radioStates') || {};
    const sessions = global.get('operatorSessions') || {};
    // 未识别报文只进桶，不混进 seats，避免被当成一个真实席位。
    const seats = Object.keys(radios).filter(key => !seatIdentity.isUnidentifiedKey(key)).sort().map(key => {
        const radio = radios[key] || {};
        const session = sessions[key];
        return {
            seat: key,
            radioNr: radio.radioNr || '',
            stationName: radio.stationName || '',
            computerName: radio.computerName || '',
            radioName: radio.radioName || '',
            seatRule: radio.seatRule || '',
            operator: session ? session.operator : (radio.opCall || ''),
            operatorSince: session ? session.startTs : null,
            freqKhz: radio.freqKhz === null ? null : Number(radio.freqKhz) || null,
            txFreqKhz: radio.txFreqKhz === null ? null : Number(radio.txFreqKhz) || null,
            mode: radio.mode || '',
            isRunning: !!radio.isRunning,
            isTransmitting: !!radio.isTransmitting,
            ts: radio.ts || null
        };
    });
    return {
        radio: global.get('radioState') || null,
        radios,
        seats,
        operators: global.get('operatorSessions') || {},
        claims: listFrequencyClaims(global),
        seatIdentities: seatIdentity.summary(global),
        unidentifiedSeat: radios[seatIdentity.UNIDENTIFIED] || null,
        score: global.get('scoreState') || null
    };
}

module.exports = {parseContact, saveRadio, saveRadioState, saveScore, coordinateRoute, coordinateTopic, applySpotCoords, stationState};
