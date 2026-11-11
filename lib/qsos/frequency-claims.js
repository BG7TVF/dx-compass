'use strict';

/* 频率协调是比赛进程内的实时状态，不写 QSO 数据库。
 * key 按 Hz 精度归一化，避免小数字符串形式造成同频不同键。 */
function normalizeSeat(value) {
    return String(value === null || value === undefined ? '' : value).trim().toUpperCase().slice(0, 80);
}

function normalizeFreq(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3000000) return null;
    return Number(parsed.toFixed(3));
}

function frequencyKey(value) {
    return Number(value).toFixed(3);
}

function claimsMap(global) {
    const value = global.get('frequencyClaims');
    return value && typeof value === 'object' ? value : {};
}

function listFrequencyClaims(global) {
    return Object.values(claimsMap(global)).map(claim => ({...claim}))
        .sort((a, b) => a.freqKhz - b.freqKhz || a.seat.localeCompare(b.seat));
}

function radioFor(global, seatKey) {
    const radios = global.get('radioStates') || {};
    return radios[seatKey] || Object.values(radios).find(radio => normalizeSeat(radio && radio.seat) === seatKey) || null;
}

function result(ok, status, error, global, extra) {
    return Object.assign({ok, status, error, claims: listFrequencyClaims(global)}, extra || {});
}

function changeFrequencyClaim(global, action, input, now = new Date()) {
    const body = input && typeof input === 'object' ? input : {};
    const operation = String(action || '').trim().toLowerCase();
    const seat = normalizeSeat(body.seat);
    const freqKhz = normalizeFreq(body.freqKhz);
    if (operation !== 'claim' && operation !== 'release') {
        return result(false, 400, 'invalid-action', global);
    }
    if (!seat || freqKhz === null) return result(false, 400, 'seat-and-frequency-required', global);

    const current = claimsMap(global);
    const key = frequencyKey(freqKhz);
    const existing = current[key];
    if (operation === 'claim') {
        if (existing && existing.seat !== seat) {
            return result(false, 409, 'frequency-claimed', global, {owner: {...existing}});
        }
        if (existing && existing.seat === seat) {
            return result(true, 200, null, global, {claim: {...existing}, changed: false});
        }
        const next = {};
        // 一个席位只协调一个频率；新 claim 自动替换该席位的旧 claim。
        for (const [oldKey, claim] of Object.entries(current)) {
            if (claim.seat !== seat) next[oldKey] = claim;
        }
        const radio = radioFor(global, seat);
        const claim = {
            freqKhz,
            seat,
            owner: seat,
            operator: String(radio && radio.opCall || '').trim().toUpperCase(),
            stationName: String(radio && radio.stationName || ''),
            claimedAt: now.toISOString()
        };
        next[key] = claim;
        global.set('frequencyClaims', next);
        return result(true, 200, null, global, {claim: {...claim}, changed: true});
    }

    if (existing && existing.seat !== seat) {
        return result(false, 403, 'not-claim-owner', global, {owner: {...existing}});
    }
    if (!existing) return result(true, 200, null, global, {changed: false});
    const next = {...current};
    delete next[key];
    global.set('frequencyClaims', next);
    return result(true, 200, null, global, {released: {...existing}, changed: true});
}

module.exports = {normalizeSeat, normalizeFreq, listFrequencyClaims, changeFrequencyClaim};
