'use strict';

const {gridToLatLon} = require('../radio');

function first(v) {
    return Array.isArray(v) ? v[0] : v;
}

function g(source, k) {
    const v = source[k];
    if (v === undefined || v === null) return '';
    return String(Array.isArray(v) ? v[0] : v);
}

function toKhz(s) {
    const n = parseFloat(String(s).trim());
    if (!isFinite(n) || n <= 0) return null;
    if (n >= 100000) return n / 100;
    if (n >= 1000) return n;
    return n * 1000;
}

function routeContact(payload) {
    const p = payload || {};
    if (p.contactinfo) return 'contactinfo';
    if (p.contactreplace) return 'contactreplace';
    if (p.contactdelete) return 'contactdelete';
    return null;
}

function parseContact(payload, now = new Date()) {
    const p = payload || {};
    const ci = p.contactinfo || p.contactreplace;
    if (!ci) return null;
    const grid = g(ci, 'gridsquare');
    const ll = grid ? gridToLatLon(grid) : null;
    const m = (parseInt(g(ci, 'ismultiplier1'), 10) || 0) +
        (parseInt(g(ci, 'ismultiplier2'), 10) || 0) +
        (parseInt(g(ci, 'ismultiplier3'), 10) || 0);
    const rawTs = g(ci, 'timestamp');
    const d = new Date(rawTs.replace(' ', 'T') + 'Z');
    const qso = {
        type: 'qso',
        n1mmId: g(ci, 'ID'),
        ts: isNaN(d.getTime()) ? now.toISOString() : d.toISOString(),
        mycall: g(ci, 'mycall'),
        operator: g(ci, 'operator'),
        call: g(ci, 'call').toUpperCase(),
        band: g(ci, 'band'),
        freqKhz: toKhz(g(ci, 'rxfreq')),
        mode: g(ci, 'mode'),
        rstSnt: g(ci, 'snt'),
        rstRcv: g(ci, 'rcv'),
        exchange: g(ci, 'exchange1') || g(ci, 'section') || g(ci, 'zone') || g(ci, 'rcvnr'),
        grid,
        country: g(ci, 'countryprefix'),
        continent: g(ci, 'continent'),
        zone: g(ci, 'zone'),
        points: parseInt(g(ci, 'points'), 10) || 0,
        isMult: m > 0,
        contest: g(ci, 'contestname'),
        radioNr: g(ci, 'radionr'),
        stationName: g(ci, 'StationName'),
        lat: ll ? ll.lat : null,
        lon: ll ? ll.lon : null
    };
    return qso.call ? qso : null;
}

function parseDelete(payload) {
    const cd = payload && payload.contactdelete;
    if (!cd) return null;
    const id = g(cd, 'ID');
    const call = g(cd, 'call').toUpperCase();
    if (!id && !call) return null;
    const timestamp = g(cd, 'timestamp');
    return {
        id,
        call,
        timestamp,
        qso: {type: 'qsoDelete', n1mmId: id, call: call.replace(/'/g, "''")}
    };
}

function parseRadio(payload, now = new Date()) {
    const ri = payload && payload.RadioInfo;
    if (!ri) return null;
    const radio = {
        type: 'radio',
        ts: now.toISOString(),
        radioNr: g(ri, 'RadioNr'),
        freqKhz: toKhz(g(ri, 'Freq')),
        txFreqKhz: toKhz(g(ri, 'TXFreq')),
        mode: g(ri, 'Mode'),
        opCall: g(ri, 'OpCall'),
        isRunning: g(ri, 'IsRunning') === 'True',
        isTransmitting: g(ri, 'IsTransmitting') === 'True',
        isSplit: g(ri, 'IsSplit') === 'True',
        activeRadioNr: g(ri, 'ActiveRadioNr'),
        radioName: g(ri, 'RadioName'),
        stationName: g(ri, 'StationName')
    };
    return radio;
}

function parseScore(payload, now = new Date()) {
    const dr = payload && payload.dynamicresults;
    if (!dr) return null;
    const arr = v => Array.isArray(v) ? v : (v ? [v] : []);
    const bd = first(dr.breakdown) || {};
    const totalOf = list => {
        for (const e of arr(list)) {
            if (e && e.$ && e.$.band === 'total' && String(e.$.mode).toUpperCase() === 'ALL') {
                return parseInt(e._, 10) || 0;
            }
        }
        return 0;
    };
    return {
        type: 'score',
        ts: now.toISOString(),
        contest: String(first(dr.contest) || ''),
        qsos: totalOf(bd.qso),
        mults: totalOf(bd.mult),
        points: totalOf(bd.points),
        score: parseFloat(first(dr.score)) || 0
    };
}

module.exports = {first, g, toKhz, routeContact, parseContact, parseDelete, parseRadio, parseScore};
