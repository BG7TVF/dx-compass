'use strict';

const seat = require('./seat.js');

/**
 * N1MM 席位自动识别。
 *
 * 依据分属两类报文，必须按 UDP 源（IP + 端口）关联后再判定：
 *   ContactInfo → ComputerName
 *   RadioInfo   → RadioName、RadioNr
 *
 * 四级降级链，逐级独立，先命中先返回：
 *   1 explicit   显式配置：relay --station 或设置页手工绑定
 *   2 computer   ComputerName + RadioName + RadioNr
 *   3 source     源 IP + RadioNr
 *   4 single     只有一个已识别实例时默认匹配
 * 都不命中 → 未识别席位桶，绝不硬塞给现成席位。
 *
 * 状态写 global（localfilesystem 上下文），重启后沿用既有绑定，席位不跳变。
 * RadioName 是自由文本，只作识别键，不当作型号或设备能力。
 */

const UNIDENTIFIED = 'UNIDENTIFIED';
const HISTORY_CAP = 200;
const SOURCE_CAP = 200;
const RECENT_CAP = 20;
const TEXT_MAX = 80;

function clean(value, max) {
    return String(value === null || value === undefined ? '' : value)
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, max || TEXT_MAX);
}

function keyOf(value) {
    return seat.normalizeKey(value);
}

function iso(value) {
    const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
    return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function sourceKey(ip, port) {
    const host = clean(ip, 64);
    if (!host) return '';
    const p = clean(port, 10);
    return p ? host + ':' + p : host;
}

function observation(input) {
    const o = input && typeof input === 'object' ? input : {};
    return {
        station: clean(o.station),
        computerName: clean(o.computerName),
        radioName: clean(o.radioName),
        radioNr: clean(o.radioNr) || '1',
        ip: clean(o.ip, 64),
        port: clean(o.port, 10),
        stationName: clean(o.stationName)
    };
}

function readMap(global, key) {
    const value = global.get(key);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function writeMap(global, key, value) {
    global.set(key, value);
}

/** 按 UDP 源缓存报文里出现过的 ComputerName / RadioName，供另一类报文补齐。 */
function learnSource(global, obs, at) {
    const key = sourceKey(obs.ip, obs.port);
    if (!key) return null;
    const all = readMap(global, 'seatSources');
    const entry = all[key] || {
        key,
        ip: obs.ip,
        port: obs.port,
        computerName: '',
        radios: {},
        firstSeen: at,
        lastSeen: at
    };
    if (obs.computerName) entry.computerName = obs.computerName;
    if (obs.radioName || obs.radioNr) {
        const previous = entry.radios[obs.radioNr] || {};
        entry.radios[obs.radioNr] = {
            radioName: obs.radioName || previous.radioName || '',
            lastSeen: at
        };
    }
    entry.ip = obs.ip || entry.ip;
    entry.port = obs.port || entry.port;
    entry.lastSeen = at;
    all[key] = entry;
    const keys = Object.keys(all);
    if (keys.length > SOURCE_CAP) {
        keys.sort((a, b) => String(all[a].lastSeen || '').localeCompare(String(all[b].lastSeen || '')));
        while (keys.length > SOURCE_CAP) delete all[keys.shift()];
    }
    writeMap(global, 'seatSources', all);
    return entry;
}

function pushHistory(global, entry) {
    const list = Array.isArray(global.get('seatHistory')) ? global.get('seatHistory').slice() : [];
    list.unshift(entry);
    global.set('seatHistory', list.slice(0, HISTORY_CAP));
}

function activeIdentities(registry) {
    return Object.values(registry).filter(record => record && !record.unbound);
}

/**
 * ContactInfo 只有 ComputerName，RadioInfo 才有 RadioName；同一实例的两类报文
 * 必须收敛到同一条记录。RadioName 缺失时按 ComputerName + RadioNr 复用；
 * RadioName 明确不同则视为同一台机器上的另一个实例，绝不合并。
 */
function matchComputerIdentity(registry, computerName, radioName, radioNr) {
    const cn = keyOf(computerName);
    const nr = keyOf(radioNr);
    const rn = keyOf(radioName);
    return Object.values(registry).find(record => record &&
        record.rule === 'computer' &&
        keyOf(record.computerName) === cn &&
        keyOf(record.radioNr) === nr &&
        (!rn || !keyOf(record.radioName) || keyOf(record.radioName) === rn)) || null;
}

function singleInstance(registry) {
    const active = activeIdentities(registry);
    return active.length === 1 ? active[0] : null;
}

function seatKeyCollides(registry, identityKey, seatKey) {
    return Object.values(registry).some(record => record &&
        record.identity !== identityKey && record.seatKey === seatKey && !record.unbound);
}

function instanceOf(seatKey) {
    const value = String(seatKey || '');
    const cut = value.lastIndexOf(':');
    return cut > 0 ? value.slice(0, cut) : value;
}

/** 用户输入的席位名：带冒号时保留实例 + RadioNr 的分段，否则补齐 RadioNr。 */
function normalizeSeatKey(requested, fallbackRadioNr) {
    const value = clean(requested, 80);
    if (!value) return '';
    const cut = value.lastIndexOf(':');
    if (cut > 0) return seat.seatKeyFrom(value.slice(0, cut), value.slice(cut + 1));
    return seat.seatKeyFrom(value, fallbackRadioNr || '1');
}

function assignSeatKey(registry, record) {
    let instance;
    if (record.rule === 'explicit') instance = keyOf(record.station) || 'LOCAL';
    else if (record.rule === 'computer') instance = keyOf(record.computerName) || keyOf(record.radioName) || 'LOCAL';
    else if (record.rule === 'stationname') instance = keyOf(record.stationName) || 'LOCAL';
    else instance = keyOf(record.ip) || 'LOCAL';
    let key = seat.seatKeyFrom(instance, record.radioNr);
    if (seatKeyCollides(registry, record.identity, key)) {
        // 同一 ComputerName + 同一 RadioNr 但 RadioName 不同的两个实例；
        // RadioName 只在这里当区分键，不做任何型号推断。
        key = seat.seatKeyFrom(instance + '~' + keyOf(record.radioName || 'RADIO'), record.radioNr);
    }
    return key;
}

function unidentified(global, obs, at, reason) {
    const bucket = readMap(global, 'seatUnidentified');
    const source = sourceKey(obs.ip, obs.port);
    const next = {
        count: (Number(bucket.count) || 0) + 1,
        lastSeen: at,
        sources: Object.assign({}, bucket.sources),
        recent: Array.isArray(bucket.recent) ? bucket.recent.slice() : []
    };
    if (source) {
        const previous = next.sources[source] || {count: 0};
        next.sources[source] = {count: (Number(previous.count) || 0) + 1, lastSeen: at};
    }
    next.recent.unshift({
        at,
        source,
        ip: obs.ip,
        port: obs.port,
        radioNr: obs.radioNr,
        reason: reason || 'no-identity'
    });
    next.recent = next.recent.slice(0, RECENT_CAP);
    writeMap(global, 'seatUnidentified', next);
    if (next.count === 1) {
        pushHistory(global, {at, action: 'unidentified', rule: 'unidentified', identity: '', seatKey: UNIDENTIFIED, source});
    }
    return {
        seatKey: UNIDENTIFIED,
        instance: UNIDENTIFIED,
        identity: '',
        rule: 'unidentified',
        displayName: '',
        manual: false,
        unbound: false,
        evidence: {
            computerName: obs.computerName,
            radioName: obs.radioName,
            radioNr: obs.radioNr,
            ip: obs.ip,
            port: obs.port,
            source
        }
    };
}

/**
 * 单条报文的席位判定。obs 字段大小写由解析层统一。
 * 返回 {seatKey, instance, identity, rule, displayName, manual, unbound, evidence}。
 */
function resolveSeat(global, input, now) {
    const at = iso(now);
    const obs = observation(input);
    const learned = learnSource(global, obs, at) || {};
    const computerName = obs.computerName || learned.computerName || '';
    const radioLearned = learned.radios && learned.radios[obs.radioNr];
    const radioName = obs.radioName || (radioLearned && radioLearned.radioName) || '';
    const evidence = {
        computerName,
        radioName,
        radioNr: obs.radioNr,
        ip: obs.ip,
        port: obs.port,
        source: sourceKey(obs.ip, obs.port)
    };

    const registry = readMap(global, 'seatRegistry');
    let identity = '';
    let rule = '';
    if (obs.station) {
        identity = 'STATION:' + keyOf(obs.station);
        rule = 'explicit';
    } else if (computerName) {
        const matched = matchComputerIdentity(registry, computerName, radioName, obs.radioNr);
        identity = matched
            ? matched.identity
            : 'CN:' + keyOf(computerName) + '|RN:' + keyOf(radioName || '-') + '|NR:' + keyOf(obs.radioNr);
        rule = matched ? matched.rule : 'computer';
    } else if (obs.ip) {
        identity = 'IP:' + keyOf(obs.ip) + '|NR:' + keyOf(obs.radioNr);
        rule = 'source';
    }

    if (!identity) {
        if (obs.stationName) {
            // 兼容旧接入：既没有 ComputerName 也没有可用源地址时，保留 StationName，
            // 否则历史部署的席位会整体掉进未识别桶。
            identity = 'NAME:' + keyOf(obs.stationName);
            rule = 'stationname';
        } else {
            const only = singleInstance(registry);
            if (only) {
                identity = only.identity;
                rule = 'single';
            } else {
                return unidentified(global, obs, at, 'no-identity');
            }
        }
    }

    let record = registry[identity];
    if (!record) {
        record = {
            identity,
            rule,
            station: obs.station,
            computerName,
            radioName,
            radioNr: obs.radioNr,
            ip: obs.ip,
            port: obs.port,
            stationName: obs.stationName,
            seatKey: '',
            displayName: '',
            manual: false,
            unbound: false,
            firstSeen: at,
            lastSeen: at
        };
        record.seatKey = assignSeatKey(registry, record);
        registry[identity] = record;
        pushHistory(global, {
            at,
            identity,
            action: 'identified',
            rule,
            seatKey: record.seatKey,
            source: evidence.source
        });
    } else {
        record.lastSeen = at;
        if (computerName) record.computerName = computerName;
        if (radioName) record.radioName = radioName;
        if (obs.radioNr) record.radioNr = obs.radioNr;
        if (obs.ip) record.ip = obs.ip;
        if (obs.port) record.port = obs.port;
        if (obs.stationName) record.stationName = obs.stationName;
        if (!record.seatKey) record.seatKey = assignSeatKey(registry, record);
    }
    registry[identity] = record;
    writeMap(global, 'seatRegistry', registry);

    if (record.unbound) {
        return unidentified(global, obs, at, 'unbound');
    }

    return {
        seatKey: record.seatKey,
        instance: instanceOf(record.seatKey),
        identity: record.identity,
        rule: record.manual ? 'manual' : record.rule,
        displayName: record.displayName || '',
        manual: !!record.manual,
        unbound: false,
        evidence
    };
}

function summary(global) {
    const registry = readMap(global, 'seatRegistry');
    const seats = Object.values(registry).map(record => ({
        identity: record.identity,
        rule: record.rule,
        seatKey: record.seatKey,
        displayName: record.displayName || '',
        manual: !!record.manual,
        unbound: !!record.unbound,
        station: record.station || '',
        stationName: record.stationName || '',
        computerName: record.computerName || '',
        radioName: record.radioName || '',
        radioNr: record.radioNr || '',
        ip: record.ip || '',
        port: record.port || '',
        source: sourceKey(record.ip, record.port),
        firstSeen: record.firstSeen || null,
        lastSeen: record.lastSeen || null
    })).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || a.seatKey.localeCompare(b.seatKey));
    const bucket = readMap(global, 'seatUnidentified');
    return {
        seats,
        unidentified: {
            count: Number(bucket.count) || 0,
            lastSeen: bucket.lastSeen || null,
            sources: bucket.sources || {},
            recent: Array.isArray(bucket.recent) ? bucket.recent.slice(0, RECENT_CAP) : []
        }
    };
}

function list(global) {
    return Object.assign(summary(global), {
        history: Array.isArray(global.get('seatHistory')) ? global.get('seatHistory').slice(0, HISTORY_CAP) : []
    });
}

function moveSeatState(global, fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const radios = readMap(global, 'radioStates');
    if (radios[fromKey]) {
        radios[toKey] = Object.assign({}, radios[fromKey], {seat: toKey});
        delete radios[fromKey];
        writeMap(global, 'radioStates', radios);
    }
    const sessions = readMap(global, 'operatorSessions');
    if (sessions[fromKey]) {
        sessions[toKey] = Object.assign({}, sessions[fromKey], {seat: toKey});
        delete sessions[fromKey];
        writeMap(global, 'operatorSessions', sessions);
    }
}

/**
 * 设置页手工操作：rename / override / unbind / bind。
 * 手工结果写回 registry 并留痕；重连时按既有 seatKey 继续用，不重新分配。
 */
function changeIdentity(global, input, now) {
    const body = input && typeof input === 'object' ? input : {};
    const identity = clean(body.identity, 200);
    const action = clean(body.action).toLowerCase();
    const allowed = ['rename', 'override', 'unbind', 'bind'];
    if (!identity || !allowed.includes(action)) {
        return {ok: false, status: 400, error: 'identity-and-action-required'};
    }
    const registry = readMap(global, 'seatRegistry');
    const record = registry[identity];
    if (!record) return {ok: false, status: 404, error: 'unknown-seat-identity', ...summary(global)};

    const at = iso(now);
    const from = record.seatKey;
    let nextSeatKey = record.seatKey;
    if (action === 'rename') {
        record.displayName = clean(body.displayName, 40);
    } else if (action === 'override') {
        const requested = clean(body.seatKey, 80);
        if (!requested) return {ok: false, status: 400, error: 'seat-key-required', ...summary(global)};
        const normalized = normalizeSeatKey(requested, record.radioNr);
        record.seatKey = normalized;
        record.manual = true;
        nextSeatKey = normalized;
    } else if (action === 'unbind') {
        record.unbound = true;
        record.manual = true;
    } else {
        record.unbound = false;
        record.manual = true;
        if (body.seatKey) {
            const normalized = normalizeSeatKey(body.seatKey, record.radioNr);
            if (normalized) {
                record.seatKey = normalized;
                nextSeatKey = normalized;
            }
        }
    }
    record.updatedAt = at;
    registry[identity] = record;
    writeMap(global, 'seatRegistry', registry);
    if (nextSeatKey !== from) moveSeatState(global, from, nextSeatKey);
    pushHistory(global, {
        at,
        identity,
        action,
        rule: record.rule,
        from,
        to: record.seatKey,
        displayName: record.displayName || '',
        unbound: !!record.unbound,
        actor: 'user'
    });
    return {ok: true, status: 200, seat: summary(global).seats.find(item => item.identity === identity) || null, ...summary(global)};
}

function isUnidentifiedKey(value) {
    return String(value || '') === UNIDENTIFIED;
}

module.exports = {
    UNIDENTIFIED,
    sourceKey,
    resolveSeat,
    summary,
    list,
    changeIdentity,
    isUnidentifiedKey
};
