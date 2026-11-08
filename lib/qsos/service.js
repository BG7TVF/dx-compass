'use strict';

const storage = require('../storage');
const {parseRadio, parseScore} = require('./n1mm.js');

function saveRadio(global, payload, now) {
    const radio = parseRadio(payload, now);
    if (!radio) return null;
    global.set('radioState', radio);
    if (radio.radioNr) {
        const states = global.get('radioStates') || {};
        states[radio.radioNr] = radio;
        global.set('radioStates', states);
    }
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
    return {
        radio: global.get('radioState') || null,
        radios: global.get('radioStates') || {},
        score: global.get('scoreState') || null
    };
}

module.exports = {saveRadio, saveScore, coordinateRoute, coordinateTopic, applySpotCoords, stationState};
