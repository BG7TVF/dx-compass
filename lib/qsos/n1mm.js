'use strict';

const {gridToLatLon, normalizeBand} = require('../radio');
const seat = require('./seat.js');

function first(v) {
    return Array.isArray(v) ? v[0] : v;
}

function g(source, k) {
    if (!source || typeof source !== 'object') return '';
    let v = source[k];
    // N1MM 的字段大小写并不统一（call/Call、RadioNr/radionr），按小写回退查找。
    if (v === undefined) {
        const lower = String(k).toLowerCase();
        for (const key of Object.keys(source)) {
            if (key.toLowerCase() === lower) {
                v = source[key];
                break;
            }
        }
    }
    if (v === undefined || v === null) return '';
    return String(Array.isArray(v) ? v[0] : v);
}

/** 根节点同样可能大小写不一致（RadioInfo / radioinfo）。 */
function root(source, name) {
    if (!source || typeof source !== 'object') return null;
    if (source[name] !== undefined) return source[name];
    const lower = String(name).toLowerCase();
    for (const key of Object.keys(source)) {
        if (key.toLowerCase() === lower) return source[key];
    }
    return null;
}

function isTrue(value) {
    return String(value).trim().toLowerCase() === 'true';
}


function toKhz(s) {
    const n = parseFloat(String(s).trim());
    if (!isFinite(n) || n <= 0) return null;
    // N1MM 不同报文/版本的频率单位不一致：Hz、10 Hz、kHz 都见过。
    if (n >= 10000000) return n / 1000;
    if (n >= 100000) return n / 100;
    if (n >= 1000) return n;
    return n * 1000;
}

function routeContact(payload) {
    if (root(payload, 'contactinfo')) return 'contactinfo';
    if (root(payload, 'contactreplace')) return 'contactreplace';
    if (root(payload, 'contactdelete')) return 'contactdelete';
    return null;
}

function parseContact(payload, now = new Date(), meta = {}) {
    const p = payload || {};
    const ci = root(p, 'contactinfo') || root(p, 'contactreplace');
    if (!ci) return null;
    const grid = g(ci, 'gridsquare');
    const ll = grid ? gridToLatLon(grid) : null;
    const m = (parseInt(g(ci, 'ismultiplier1'), 10) || 0) +
        (parseInt(g(ci, 'ismultiplier2'), 10) || 0) +
        (parseInt(g(ci, 'ismultiplier3'), 10) || 0);
    const rawTs = g(ci, 'timestamp');
    const d = new Date(rawTs.replace(' ', 'T') + 'Z');
    const ts = isNaN(d.getTime()) ? now.toISOString() : d.toISOString();
    const call = g(ci, 'call').toUpperCase();
    /* 报文里的 band 是兆赫数值（20m=14、15m=21），入库前统一成米波名，
     * 否则同一波段会和 spot 侧的 20m/15m 被当成两个波段。 */
    const rawBand = g(ci, 'band');
    const band = normalizeBand(rawBand) || rawBand;
    const mode = g(ci, 'mode');
    const stationName = g(ci, 'StationName');
    const computerName = g(ci, 'ComputerName');
    const radioName = g(ci, 'RadioName');
    const radioNr = g(ci, 'radionr');
    /* 计算机标识可能是 ComputerName，也可能只有 StationName（N1MM 单机部署
     * 常见）；ContactInfo 不一定带 RadioName/RadioNr，RadioInfo 才带，
     * 识别层按 UDP 源把两类报文关联起来，不要求单条报文信息齐全。 */
    const resolved = typeof meta.resolveSeat === 'function'
        ? meta.resolveSeat({
            station: meta.station,
            computerName,
            radioName,
            radioNr,
            ip: meta.ip,
            port: meta.port,
            stationName
        })
        : null;
    const instance = resolved ? resolved.instance : seat.stationKeyFrom({
        station: meta.station,
        stationName,
        radioName,
        ip: meta.ip
    });
    // N1MM 的 ID 只在单实例内唯一；多台独立 N1MM 会撞主键，必须加实例命名空间。
    // 缺 ID 时仍用可重复计算的原始键，保证重发不会新增一行。
    /* 原始 band 只参与兜底主键，保证同一报文重发时不因归一化而产生新行。 */
    const rawId = g(ci, 'ID') || [call, ts, rawBand, mode].join('|');
    const qso = {
        type: 'qso',
        n1mmId: seat.namespaceId(instance, rawId),
        instance,
        rawId,
        ts,
        mycall: g(ci, 'mycall'),
        operator: g(ci, 'operator'),
        call,
        band,
        freqKhz: toKhz(g(ci, 'rxfreq')),
        mode,
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
        stationName,
        computerName,
        radioName,
        seatRule: resolved ? resolved.rule : 'legacy',
        seatIdentity: resolved ? resolved.identity : '',
        lat: ll ? ll.lat : null,
        lon: ll ? ll.lon : null
    };
    return qso.call ? qso : null;
}

function parseDelete(payload, meta = {}) {
    const cd = root(payload, 'contactdelete');
    if (!cd) return null;
    const rawId = g(cd, 'ID');
    const call = g(cd, 'call').toUpperCase();
    if (!rawId && !call) return null;
    const timestamp = g(cd, 'timestamp');
    const stationName = g(cd, 'StationName');
    const computerName = g(cd, 'ComputerName');
    const radioName = g(cd, 'RadioName');
    const radioNr = g(cd, 'radionr');
    const resolved = typeof meta.resolveSeat === 'function'
        ? meta.resolveSeat({
            station: meta.station,
            computerName,
            radioName,
            radioNr,
            ip: meta.ip,
            port: meta.port,
            stationName
        })
        : null;
    const instance = resolved ? resolved.instance : seat.stationKeyFrom({
        station: meta.station,
        stationName,
        radioName,
        ip: meta.ip
    });
    const id = rawId ? seat.namespaceId(instance, rawId) : '';
    return {
        id,
        rawId,
        instance,
        call,
        timestamp,
        qso: {type: 'qsoDelete', n1mmId: id, call: call.replace(/'/g, "''")}
    };
}

function parseRadio(payload, now = new Date(), meta = {}) {
    const ri = root(payload, 'RadioInfo');
    if (!ri) return null;
    const stationName = g(ri, 'StationName');
    const radioNr = g(ri, 'RadioNr');
    const computerName = g(ri, 'ComputerName');
    const radioName = g(ri, 'RadioName');
    const resolved = typeof meta.resolveSeat === 'function'
        ? meta.resolveSeat({
            station: meta.station,
            computerName,
            radioName,
            radioNr,
            ip: meta.ip,
            port: meta.port,
            stationName
        })
        : null;
    const instance = resolved ? resolved.instance : seat.stationKeyFrom({
        station: meta.station,
        stationName,
        radioName,
        ip: meta.ip
    });
    const radio = {
        type: 'radio',
        ts: now.toISOString(),
        seat: resolved ? resolved.seatKey : seat.seatKeyFrom(instance, radioNr),
        seatRule: resolved ? resolved.rule : 'legacy',
        seatIdentity: resolved ? resolved.identity : '',
        instance,
        radioNr,
        freqKhz: toKhz(g(ri, 'Freq')),
        txFreqKhz: toKhz(g(ri, 'TXFreq')),
        mode: g(ri, 'Mode'),
        opCall: g(ri, 'OpCall'),
        isRunning: isTrue(g(ri, 'IsRunning')),
        isTransmitting: isTrue(g(ri, 'IsTransmitting')),
        isSplit: isTrue(g(ri, 'IsSplit')),
        activeRadioNr: g(ri, 'ActiveRadioNr'),
        radioName: resolved ? resolved.evidence.radioName : radioName,
        computerName: resolved ? resolved.evidence.computerName : computerName,
        stationName
    };
    return radio;
}

function parseScore(payload, now = new Date()) {
    const dr = root(payload, 'dynamicresults');
    if (!dr) return null;
    const arr = v => Array.isArray(v) ? v : (v ? [v] : []);
    const breakdowns = arr(root(dr, 'breakdown'));
    /* 只取 band=total / mode=ALL 的汇总项。字段名按 N1MM 实际报文：
     * 点数标签是单数 <point>，不是 <points>；乘数总量由 zone 与 country
     * 两个 type 相加（CQWW 的 26 分区 + 28 国家 = 54），取第一条会少一半。 */
    const totalEntries = key => {
        const out = [];
        for (const bd of breakdowns) {
            if (!bd || typeof bd !== 'object') continue;
            for (const e of arr(root(bd, key))) {
                if (e && e.$ && String(e.$.band).toLowerCase() === 'total' &&
                    String(e.$.mode).toUpperCase() === 'ALL') {
                    out.push(e);
                }
            }
        }
        return out;
    };
    const sumOf = list => list.reduce((sum, e) => sum + (parseInt(e._, 10) || 0), 0);
    const totalOf = key => {
        const entries = totalEntries(key);
        const plain = entries.filter(e => !e.$.type);
        return sumOf(plain.length ? plain : entries);
    };
    const pointEntries = () => {
        const singular = totalEntries('point');
        return singular.length ? singular : totalEntries('points');
    };
    return {
        type: 'score',
        ts: now.toISOString(),
        contest: String(first(root(dr, 'contest')) || ''),
        qsos: totalOf('qso'),
        mults: totalOf('mult'),
        points: sumOf(pointEntries()),
        score: parseFloat(first(root(dr, 'score'))) || 0
    };
}

/**
 * 统一入口：把任意一包 N1MM 数据归一化成同一套事件结构。
 * UDP 与 HTTP 两条输入都走这里，避免两份解析器。
 */
function normalize(payload, now = new Date(), meta = {}) {
    const route = routeContact(payload);
    if (route === 'contactdelete') {
        const removed = parseDelete(payload, meta);
        return removed ? {kind: 'delete', event: removed} : {kind: 'unknown', error: 'empty-delete'};
    }
    if (route) {
        const qso = parseContact(payload, now, meta);
        return qso ? {kind: 'qso', event: qso} : {kind: 'unknown', error: 'empty-contact'};
    }
    const radio = parseRadio(payload, now, meta);
    if (radio) return {kind: 'radio', event: radio};
    const score = parseScore(payload, now);
    if (score) return {kind: 'score', event: score};
    return {kind: 'unknown', error: 'unrecognized-packet'};
}

module.exports = {
    first, g, root, toKhz, routeContact, parseContact, parseDelete, parseRadio, parseScore, normalize
};
