'use strict';

const storage = require('../storage');

function txt(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? (v._ || '') : String(v);
}

/* QRZ 查询结果缓存：QSO 地图的坐标回填和 OP 视图的呼号复核查的是同一个
 * 呼号，没必要打两次接口。地图侧写完缓存后，复核请求直接复用；如果复核
 * 先到，会等地图侧这一条查询完成（见 waitForLookup）。只缓存明确的
 * found/not-found，会话或网络错误不缓存，避免把临时故障记成结论。
 * 同一份结论同时落库（见 storage.qrz），进程重启后由 primeCache 读回内存。
 * 呼号的国家和坐标与波段无关，一场比赛内不会变，命中给 12 小时；
 * not-found 只留 30 分钟，新登记的呼号还能及时查到。 */
const FOUND_TTL_MS = 12 * 60 * 60 * 1000;
const MISS_TTL_MS = 30 * 60 * 1000;
const LOOKUP_CACHE_MAX = 2000;
const lookupCache = new Map();
const lookupWaiters = new Map();

function cacheKey(call) {
    return String(call || '').trim().toUpperCase();
}

function ttlFor(result) {
    return result && result.status === 'found' ? FOUND_TTL_MS : MISS_TTL_MS;
}

function normalizeLookup(payload) {
    const db = payload && payload.QRZDatabase;
    const cs = db && db.Callsign && db.Callsign[0];
    const sess = db && db.Session && db.Session[0];
    if (cs) {
        return {
            status: 'found',
            callsign: {
                call: txt(cs.call && cs.call[0]),
                fname: txt(cs.fname && cs.fname[0]),
                name: txt(cs.name && cs.name[0]),
                country: txt(cs.country && cs.country[0]),
                grid: txt(cs.grid && cs.grid[0]),
                dxcc: txt(cs.dxcc && cs.dxcc[0]),
                cqzone: txt(cs.cqzone && cs.cqzone[0]),
                ituzone: txt(cs.ituzone && cs.ituzone[0]),
                class: txt(cs.class && cs.class[0]),
                aliases: txt(cs.aliases && cs.aliases[0]),
                lat: txt(cs.lat && cs.lat[0]),
                lon: txt(cs.lon && cs.lon[0]),
                qslmgr: txt(cs.qslmgr && cs.qslmgr[0])
            }
        };
    }
    const error = sess ? txt(sess.Error && sess.Error[0]) : '';
    if (/not found|no match|no such/i.test(error)) {
        return {status: 'not-found', error};
    }
    if (/session|timeout|invalid|denied|alert/i.test(error) || !db) {
        return {status: 'error', error: error || 'invalid QRZ response'};
    }
    return {status: 'not-found', error};
}

function rememberLookup(call, result, at) {
    const key = cacheKey(call);
    if (!key || !result || result.status === 'error') return;
    lookupCache.delete(key);
    lookupCache.set(key, {result, at: isFinite(Number(at)) ? Number(at) : Date.now()});
    while (lookupCache.size > LOOKUP_CACHE_MAX) {
        lookupCache.delete(lookupCache.keys().next().value);
    }
    const waiters = lookupWaiters.get(key);
    if (waiters) {
        lookupWaiters.delete(key);
        waiters.forEach(resolve => resolve(result));
    }
}

/** 结论的入库语句；flow 侧交给 SQLite 节点执行，同一呼号换波段不用再查。 */
function upsertSql(call, result) {
    return storage.qrz.upsert(call, result);
}

/** Fresh cached QRZ result for one call, or null. */
function cachedLookup(call) {
    const key = cacheKey(call);
    if (!key) return null;
    const hit = lookupCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > ttlFor(hit.result)) {
        lookupCache.delete(key);
        return null;
    }
    return hit.result;
}

/** Wait briefly for the QSO map's in-flight QRZ lookup, avoiding a second request. */
function waitForLookup(call, timeoutMs = 2500) {
    const key = cacheKey(call);
    if (!key) return Promise.resolve(null);
    const cached = cachedLookup(key);
    if (cached) return Promise.resolve(cached);
    return new Promise(resolve => {
        let timer = null;
        const done = result => {
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        const waiters = lookupWaiters.get(key) || [];
        waiters.push(done);
        lookupWaiters.set(key, waiters);
        timer = setTimeout(() => {
            const current = lookupWaiters.get(key) || [];
            const next = current.filter(fn => fn !== done);
            if (next.length) lookupWaiters.set(key, next);
            else lookupWaiters.delete(key);
            resolve(null);
        }, Math.max(0, Number(timeoutMs) || 0));
    });
}

/** 库里的 qrz_calls 行还原成与 normalizeLookup 同形的结论。 */
function rowToResult(row) {
    if (!row || !row.status) return null;
    if (row.status === 'not-found') return {status: 'not-found', error: txt(row.error)};
    if (row.status !== 'found') return null;
    return {
        status: 'found',
        callsign: {
            call: txt(row.call), fname: txt(row.fname), name: txt(row.name),
            country: txt(row.country), grid: txt(row.grid), dxcc: txt(row.dxcc),
            cqzone: txt(row.cqzone), ituzone: txt(row.ituzone), class: txt(row.class),
            aliases: txt(row.aliases), lat: txt(row.lat), lon: txt(row.lon),
            qslmgr: txt(row.qslmgr)
        }
    };
}

/** 启动时把 qrz_calls 读回内存缓存，重启后同一批呼号不用再查 QRZ。 */
function primeCache(rows) {
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
        const result = rowToResult(row);
        if (!result) continue;
        const at = Date.parse(txt(row.last_seen) || txt(row.first_seen));
        if (!isFinite(at)) continue;
        rememberLookup(row.call, result, at);
    }
    return lookupCache.size;
}

/** 复用已有结论回填坐标；没有可用坐标时返回 null，让调用方继续查。 */
function applyCached(qso, result) {
    if (!qso || !result) return null;
    if (result.status === 'not-found') return {kind: 'fallback', qso};
    if (result.status !== 'found') return null;
    const lat = parseFloat(result.callsign && result.callsign.lat);
    const lon = parseFloat(result.callsign && result.callsign.lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    qso.lat = lat;
    qso.lon = lon;
    return {kind: 'coords', qso, topic: storage.qso.updateCoords(qso)};
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
    const result = normalizeLookup(payload);
    if (result.status === 'found') {
        rememberLookup(qso.call, result);
        const lat = parseFloat(result.callsign.lat);
        const lon = parseFloat(result.callsign.lon);
        if (isFinite(lat) && isFinite(lon)) {
            qso.lat = lat;
            qso.lon = lon;
            return {kind: 'coords', qso, topic: storage.qso.updateCoords(qso), result};
        }
        return {kind: 'fallback', result};
    }
    if (result.status === 'not-found') return {kind: 'fallback', result};
    if (/session|timeout|invalid/i.test(result.error || '')) {
        return {kind: 'sessionError', error: result.error, result};
    }
    return {kind: 'fallback', result};
}

/** QRZ callsign metadata lookup used by the OP view's call sanity check. */
function lookupQuery(call, key) {
    const target = String(call || '').trim().toUpperCase();
    if (!target || !key) return null;
    return {
        url: 'https://xmldata.qrz.com/xml/current/?s=' + encodeURIComponent(key) +
            ';callsign=' + encodeURIComponent(target),
        headers: {'User-Agent': 'dx-compass/1.0'}
    };
}

/** Parse one QRZ lookup without touching any QSO row; cache it for the map side. */
function parseLookup(payload, call) {
    const result = normalizeLookup(payload);
    const target = call || (result.status === 'found' && result.callsign.call) || '';
    rememberLookup(target, result);
    return result;
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

module.exports = {
    txt, callsignQuery, login, parseResult, parseKey,
    lookupQuery, parseLookup, cachedLookup, waitForLookup,
    applyCached, primeCache, upsertSql
};
