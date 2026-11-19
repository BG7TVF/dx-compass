'use strict';

const storage = require('../storage');
const n1mm = require('./n1mm.js');
const {parseRadio, parseScore} = n1mm;
const seat = require('./seat.js');
const seatIdentity = require('./seat-identity.js');
const n1mmLog = require('./n1mm-log.js');
const {listFrequencyClaims} = require('./frequency-claims.js');

/** UDP 入口只做原始报文留存，解析失败也不影响记录，便于排查缺字段。 */
function logRawN1mm(global, input) {
    try {
        return n1mmLog.record(input);
    } catch (error) {
        return null;
    }
}

function n1mmPackets() {
    return n1mmLog.list();
}

function clearN1mmPackets() {
    n1mmLog.clear();
}

/**
 * 直收 UDP 的报文不经过 resolveSeat，这里补记 ComputerName / RadioName，
 * 否则设备表单的下拉候选只能看到 HTTP relay 进来的报文。
 */
function learnPacket(global, fields, now) {
    if (!global || typeof global.get !== 'function') return null;
    return seatIdentity.learn(global, fields, now);
}

/**
 * 直收 UDP 的报文也要走席位识别，否则设置页看不到席位、注册表永远为空。
 * 调用方没给 resolveSeat 时按当前 global 补一个。
 */
function withSeatResolver(global, meta, now) {
    const out = Object.assign({}, meta || {});
    if (!out.resolveSeat && global && typeof global.get === 'function') {
        out.resolveSeat = input => seatIdentity.resolveSeat(global, input, now || new Date());
    }
    return out;
}

/** 供 UDP 入口使用：解析 ContactInfo 的同时把候选记进席位缓存。
 *  兼容旧的 parseContact(payload, now, meta) 调用（没有 global 时只解析）。 */
function parseContact(first, second, third, fourth) {
    if (first && typeof first.get === 'function' && typeof first.set === 'function') {
        const global = first;
        const now = third || new Date();
        const meta = withSeatResolver(global, fourth || {}, now);
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
    const resolvedMeta = withSeatResolver(global, meta, now);
    const radio = parseRadio(payload, now, resolvedMeta);
    if (!radio) return null;
    learnPacket(global, {
        computerName: radio.computerName,
        radioName: radio.radioName,
        radioNr: radio.radioNr,
        ip: resolvedMeta.ip,
        port: resolvedMeta.port,
        stationName: radio.stationName
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

/**
 * spots 兜底命中的坐标也要落库，否则只是内存里补了一下，
 * 刷新页面或重新加载历史后这些 QSO 在地图上仍然没有位置。
 * 只处理数据库里本来没有坐标的行，QRZ/网格已有坐标一律不覆盖。
 */
function spotCoordsUpdate(qso, rows) {
    if (!qso || !qso.n1mmId) return null;
    if (qso.lat !== null && qso.lat !== undefined) return null;
    rows = Array.isArray(rows) ? rows : [];
    const spot = rows[0] || {};
    /* 经纬度必须成对，只补一半会让这一行永远画不到地图上。 */
    if (spot.dx_lat === null || spot.dx_lat === undefined) return null;
    if (spot.dx_lon === null || spot.dx_lon === undefined) return null;
    return storage.qso.updateCoords({
        n1mmId: qso.n1mmId,
        lat: spot.dx_lat,
        lon: spot.dx_lon
    });
}

/* N1MM 每 10 秒重发一次 RadioInfo（生产实测），超过 5 分钟没有任何报文就说明这台
 * 计算机已经掉线，或者是重连抖动留下的旧键。radioStates 只增不删，旧键会永久变成
 * 多出来的席位，因此读取站点状态前先把它们请出去。席位身份登记表 seatRegistry 保持
 * 不动：机器回来时仍然落回原来的 seatKey，不会因为我们清理过而换编号。 */
const SEAT_STALE_MS = 5 * 60 * 1000;

function pruneStaleSeats(global, now) {
    const at = now instanceof Date ? now.getTime() :
        (Number.isNaN(Date.parse(String(now || ''))) ? Date.now() : Date.parse(String(now)));
    const radios = global.get('radioStates') || {};
    const sessions = global.get('operatorSessions') || {};
    const removed = [];
    for (const [key, radio] of Object.entries(radios)) {
        const ts = Date.parse(String((radio && radio.ts) || ''));
        /* 时间戳缺失或格式异常一律保留：宁可多留一个席位，也不误删正在用的那个。 */
        if (Number.isNaN(ts) || at - ts <= SEAT_STALE_MS) continue;
        removed.push(key);
    }
    if (!removed.length) return {removed, staleMs: SEAT_STALE_MS};
    for (const key of removed) {
        delete radios[key];
        delete sessions[key];
    }
    global.set('radioStates', radios);
    global.set('operatorSessions', sessions);
    return {removed, staleMs: SEAT_STALE_MS};
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

module.exports = {parseContact, saveRadio, saveRadioState, saveScore, coordinateRoute, coordinateTopic, applySpotCoords, spotCoordsUpdate, stationState, pruneStaleSeats, SEAT_STALE_MS, logRawN1mm, n1mmPackets, clearN1mmPackets};
