'use strict';

const storage = require('../storage');
const {parseRadio, parseScore} = require('./n1mm.js');
const seat = require('./seat.js');

function saveRadio(global, payload, now, meta) {
    const radio = parseRadio(payload, now, meta);
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
    const seats = Object.keys(radios).sort().map(key => {
        const radio = radios[key] || {};
        const session = sessions[key];
        return {
            seat: key,
            radioNr: radio.radioNr || '',
            stationName: radio.stationName || '',
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
        score: global.get('scoreState') || null
    };
}

module.exports = {saveRadio, saveScore, coordinateRoute, coordinateTopic, applySpotCoords, stationState};
