'use strict';

const storage = require('../storage');

function txt(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? (v._ || '') : String(v);
}

function callsignQuery(qso, key) {
    if (!qso || !key) return null;
    return {
        url: 'https://xmldata.qrz.com/xml/current/?s=' + encodeURIComponent(key) +
            ';callsign=' + encodeURIComponent(qso.call),
        headers: {'User-Agent': 'dx-compass/1.0'}
    };
}

function login(user, pass) {
    if (!user || !pass) return null;
    return {
        url: 'https://xmldata.qrz.com/xml/current/?username=' + encodeURIComponent(user) +
            ';password=' + encodeURIComponent(pass) + ';agent=dxcompass10',
        headers: {'User-Agent': 'dx-compass/1.0'}
    };
}

function parseResult(payload, qso) {
    if (!qso) return null;
    const db = payload && payload.QRZDatabase;
    const cs = db && db.Callsign && db.Callsign[0];
    const sess = db && db.Session && db.Session[0];
    if (cs) {
        const lat = parseFloat(txt(cs.lat && cs.lat[0]));
        const lon = parseFloat(txt(cs.lon && cs.lon[0]));
        if (isFinite(lat) && isFinite(lon)) {
            qso.lat = lat;
            qso.lon = lon;
            return {kind: 'coords', qso, topic: storage.qso.updateCoords(qso)};
        }
    }
    const error = sess ? txt(sess.Error && sess.Error[0]) : '';
    if (/session|timeout|invalid/i.test(error)) return {kind: 'sessionError', error};
    return {kind: 'fallback'};
}

function parseKey(payload) {
    const db = payload && payload.QRZDatabase;
    const sess = db && db.Session && db.Session[0];
    if (sess) {
        const key = txt(sess.Key && sess.Key[0]);
        const error = txt(sess.Error && sess.Error[0]);
        if (key) return {key, expire: txt(sess.SubExp && sess.SubExp[0]), error: ''};
        return {key: null, expire: null, error: error || 'login failed'};
    }
    return {key: null, expire: null, error: ''};
}

module.exports = {txt, callsignQuery, login, parseResult, parseKey};
