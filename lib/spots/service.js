'use strict';

const {bandOf, hav, gridToLatLng} = require('../radio');
const {unesc, modeOf, pskrModeOf, monitoredCalls, unslash, infoCoords,
    dedupKey, pruneDedup} = require('./normalize.js');

const DX_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': 'https://dxwatch.com/',
    'X-Requested-With': 'XMLHttpRequest'
};
const RBN_HEADERS = {
    'User-Agent': DX_HEADERS['User-Agent'],
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': 'https://www.reversebeacon.net/main.php',
    'X-Requested-With': 'XMLHttpRequest'
};

function nowMs(env) {
    if (typeof env.now === 'function') return env.now();
    return Number.isFinite(env.now) ? env.now : Date.now();
}

function intakeEnabled(global) {
    const rec = global.get('recording') || {};
    return global.get('monitoring') === true || rec.active === true;
}

function liveRequest(env) {
    if (!intakeEnabled(env.global)) return null;
    const lastId = env.flow.get('lastSpotId') || 0;
    return {
        url: 'https://dxwatch.com/dxsd1/s.php?s=' + lastId + '&r=200&d=1',
        headers: {...DX_HEADERS}
    };
}

function backfillRequest(call) {
    const normalized = String(call || '').toUpperCase();
    return {
        backfillCall: normalized,
        payload: '',
        url: 'https://dxwatch.com/dxsd1/s.php?s=0&r=200&d=1&cdx=' + encodeURIComponent(normalized),
        headers: {...DX_HEADERS}
    };
}

function mainPageRequest() {
    return {
        url: 'https://www.reversebeacon.net/main.php',
        headers: {
            'User-Agent': DX_HEADERS['User-Agent'],
            'Accept': 'text/html,*/*;q=0.8'
        }
    };
}

function rbnRequest(env) {
    if (!intakeEnabled(env.global)) return null;
    const h = env.flow.get('rbnH');
    if (!h) return null;
    const lastId = env.flow.get('lastRbnId') || 0;
    return {
        url: 'https://www.reversebeacon.net/spots.php?h=' + h + '&ma=36000&s=' + lastId + '&r=200',
        headers: {...RBN_HEADERS}
    };
}

function extractRbnHash(payload) {
    const m = String(payload || '').match(/RBN_version_hash\s*=\s*"([0-9a-f]+)"/);
    return m ? m[1] : null;
}

function processDxwatch(raw, env) {
    let json = raw;
    if (typeof json === 'string') {
        try { json = JSON.parse(json); }
        catch (e) {
            return {records: [], fresh: [], warning: 'dxwatch: response is not valid JSON'};
        }
    }
    if (!json || !json.s) return {records: [], fresh: []};

    const monitored = monitoredCalls(env.global);
    const isBackfill = !!env.backfillCall;
    const nowSec = nowMs(env) / 1000;
    const seen = env.flow.get('seenIds') || {};
    const dedup = env.flow.get('dedupKeys') || {};
    let lastId = env.flow.get('lastSpotId') || 0;
    const records = [];
    const fresh = [];
    let added = 0;

    for (const idStr of Object.keys(json.s)) {
        const id = parseInt(idStr, 10);
        if (!id || seen[id]) continue;
        const row = json.s[idStr];
        if (!Array.isArray(row)) continue;

        const de = String(row[0] || '').trim().toUpperCase();
        const freq = parseFloat(row[1]);
        const target = String(row[2] || '').trim().toUpperCase();
        const comment = unesc(row[3] == null ? '' : row[3]);
        const spotTime = String(row[4] || '');
        const ageSec = parseInt(row[5], 10);

        if (!de || !target || isNaN(ageSec) || ageSec < 0) continue;
        if (!monitored.includes(target)) continue;
        if (isBackfill && (ageSec / 86400 > 7 || added >= 150)) continue;

        const ci = json.ci || {};
        const dePos = infoCoords(ci[de] || []);
        const dxPos = infoCoords(ci[target] || []);
        let distKm = null;
        if (dePos.lat !== null && dePos.lon !== null && dxPos.lat !== null && dxPos.lon !== null) {
            distKm = hav(dxPos.lat, dxPos.lon, dePos.lat, dePos.lon);
        }

        let snr = null;
        const rcvd = comment.match(/Rcvd:\s*([+-]?\d+)/i);
        const dbm = comment.match(/([+-]?\d+)\s*dB/i);
        const sm = rcvd || dbm;
        if (sm) snr = parseInt(sm[1], 10);
        let signal = null;
        const rst = comment.match(/\b([1-5][1-9]{2})\b/);
        if (rst) signal = rst[1];

        const dKey = dedupKey(target, de, freq, nowSec - ageSec);
        if (dedup[dKey]) {
            seen[id] = 1;
            if (!isBackfill && id > lastId) lastId = id;
            continue;
        }
        records.push({
            spot_id: id,
            timestamp: new Date((nowSec - ageSec) * 1000).toISOString(),
            monitored_call: target,
            de,
            freq: isNaN(freq) ? null : freq,
            spot_call: target,
            comment,
            spot_time: spotTime,
            mode: modeOf(comment),
            signal,
            snr,
            lat: dePos.lat,
            lon: dePos.lon,
            dx_lat: dxPos.lat,
            dx_lon: dxPos.lon,
            band: bandOf(freq),
            distance_km: distKm === null ? null : Math.round(distKm),
            distance_miles: distKm === null ? null : Math.round(distKm * 0.62137)
        });
        if (ageSec <= 3600) fresh.push(records[records.length - 1]);
        seen[id] = 1;
        dedup[dKey] = nowSec;
        added++;
        if (!isBackfill && id > lastId) lastId = id;
    }

    const idList = Object.keys(seen).map(Number);
    if (idList.length > 2000) {
        idList.sort((a, b) => a - b);
        const keep = new Set(idList.slice(-2000));
        idList.forEach(k => { if (!keep.has(k)) delete seen[k]; });
    }
    env.flow.set('seenIds', seen);
    pruneDedup(dedup, nowSec);
    env.flow.set('dedupKeys', dedup);
    if (!isBackfill) env.flow.set('lastSpotId', lastId);
    return {records, fresh, state: {seenIds: seen, dedupKeys: dedup, lastSpotId: lastId}};
}

function processRbn(raw, env) {
    if (env.statusCode !== 200) {
        env.flow.set('rbnH', null);
        return {records: [], fresh: [], refreshHash: true};
    }
    let json = raw;
    if (typeof json === 'string') {
        try { json = JSON.parse(json); }
        catch (e) { return {records: [], fresh: [], warning: 'RBN: response is not valid JSON'}; }
    }
    if (!json || !json.spots) return {records: [], fresh: []};

    const monitored = monitoredCalls(env.global);
    const nowSec = nowMs(env) / 1000;
    const ci = json.call_info || {};
    const dedup = env.flow.get('dedupKeys') || {};
    let lastId = env.flow.get('lastRbnId') || 0;
    if (json.lastid_c && json.lastid_c > lastId) lastId = json.lastid_c;
    const records = [];
    const fresh = [];

    for (const idStr of Object.keys(json.spots)) {
        const id = parseInt(idStr, 10);
        if (!id) continue;
        if (id > lastId) lastId = id;
        const row = json.spots[idStr];
        if (!Array.isArray(row)) continue;

        const de = String(row[0] || '').trim().toUpperCase();
        const freq = parseFloat(row[1]);
        const target = String(row[2] || '').trim().toUpperCase();
        const snr = parseInt(row[3], 10);
        const wpm = parseInt(row[4], 10);
        const spotTime = String(row[5] || '');
        const epoch = parseInt(row[10], 10);

        if (!de || !target || isNaN(epoch)) continue;
        if (!monitored.includes(target)) continue;
        const dKey = dedupKey(target, de, freq, epoch);
        if (dedup[dKey]) continue;

        const dePos = infoCoords(ci[de] || ci[de.replace(/-\d+$/, '')] || []);
        const dxPos = infoCoords(ci[target] || []);
        let distKm = null;
        if (dePos.lat !== null && dePos.lon !== null && dxPos.lat !== null && dxPos.lon !== null) {
            distKm = hav(dxPos.lat, dxPos.lon, dePos.lat, dePos.lon);
        }
        records.push({
            spot_id: -id,
            timestamp: new Date(epoch * 1000).toISOString(),
            monitored_call: target,
            de,
            freq: isNaN(freq) ? null : freq,
            spot_call: target,
            comment: 'CW' + (isNaN(wpm) ? '' : ' ' + wpm + ' WPM'),
            spot_time: spotTime,
            mode: 'CW',
            signal: null,
            snr: isNaN(snr) ? null : snr,
            lat: dePos.lat,
            lon: dePos.lon,
            dx_lat: dxPos.lat,
            dx_lon: dxPos.lon,
            band: bandOf(freq),
            distance_km: distKm === null ? null : Math.round(distKm),
            distance_miles: distKm === null ? null : Math.round(distKm * 0.62137)
        });
        if (nowSec - epoch <= 3600) fresh.push(records[records.length - 1]);
        dedup[dKey] = nowSec;
    }

    env.flow.set('lastRbnId', lastId);
    pruneDedup(dedup, nowSec);
    env.flow.set('dedupKeys', dedup);
    return {records, fresh, state: {dedupKeys: dedup, lastRbnId: lastId}};
}

function processPskr(raw, env) {
    if (!intakeEnabled(env.global)) return {records: [], fresh: []};
    let json = raw;
    if (typeof json === 'string') {
        try { json = JSON.parse(json); }
        catch (e) { return {records: [], fresh: []}; }
    }
    if (!json || typeof json !== 'object') return {records: [], fresh: []};

    const monitored = monitoredCalls(env.global);
    if (!monitored.length) return {records: [], fresh: []};
    const target = unslash(json.sc);
    const de = unslash(json.rc);
    if (!target || !de) return {records: [], fresh: []};
    if (!monitored.includes(target)) return {records: [], fresh: []};

    const nowSec = nowMs(env) / 1000;
    const epoch = parseInt(json.t, 10) || Math.floor(nowSec);
    if (nowSec - epoch < -120) return {records: [], fresh: []};
    const tooOld = nowSec - epoch > 3600;
    const freqHz = parseFloat(json.f);
    const freq = isFinite(freqHz) && freqHz > 0 ? Math.round(freqHz / 10) / 100 : null;
    const snr = parseInt(json.rp, 10);
    const sq = parseInt(json.sq, 10);
    if (!sq) return {records: [], fresh: []};

    const dedup = env.flow.get('dedupKeys') || {};
    const dKey = dedupKey(target, de, freq, epoch);
    if (dedup[dKey]) return {records: [], fresh: []};
    dedup[dKey] = nowSec;
    pruneDedup(dedup, nowSec);
    env.flow.set('dedupKeys', dedup);

    const dePos = gridToLatLng(json.rl);
    const dxPos = gridToLatLng(json.sl);
    let distKm = null;
    if (dePos && dxPos) distKm = hav(dxPos[0], dxPos[1], dePos[0], dePos[1]);
    const iso = new Date(epoch * 1000).toISOString();
    const record = {
        spot_id: -sq,
        timestamp: iso,
        monitored_call: target,
        de,
        freq,
        spot_call: target,
        comment: 'PSKR ' + String(json.md || '').toUpperCase() + (isNaN(snr) ? '' : ' ' + snr + ' dB'),
        spot_time: iso.replace('T', ' ').substring(0, 19),
        mode: pskrModeOf(json.md),
        signal: null,
        snr: isNaN(snr) ? null : snr,
        lat: dePos ? dePos[0] : null,
        lon: dePos ? dePos[1] : null,
        dx_lat: dxPos ? dxPos[0] : null,
        dx_lon: dxPos ? dxPos[1] : null,
        band: bandOf(freq),
        distance_km: distKm === null ? null : Math.round(distKm),
        distance_miles: distKm === null ? null : Math.round(distKm * 0.62137)
    };
    return {records: [record], fresh: tooOld ? [] : [record], state: {dedupKeys: dedup}};
}

function ingest(source, raw, env) {
    if (source === 'dxwatch') return processDxwatch(raw, env);
    if (source === 'rbn') return processRbn(raw, env);
    if (source === 'pskr') return processPskr(raw, env);
    throw new Error('unknown spot source: ' + source);
}

function syncPskrSubscriptions(env) {
    const calls = monitoredCalls(env.global).map(c => String(c).trim().toUpperCase()).filter(Boolean);
    const wanted = {};
    for (const c of calls) {
        wanted['pskr/filter/v2/+/+/' + c.replace(/\//g, '.') + '/#'] = {qos: 0};
    }
    const prev = env.flow.get('pskrSubs') || {};
    const actions = [];
    for (const topic of Object.keys(prev)) {
        if (!wanted[topic]) actions.push({action: 'unsubscribe', topic});
    }
    for (const topic of Object.keys(wanted)) {
        actions.push({action: 'subscribe', topic, qos: 0});
    }
    const changed = JSON.stringify(prev) !== JSON.stringify(wanted);
    if (changed) env.flow.set('pskrSubs', wanted);
    return {
        actions,
        warning: changed ? 'PSKR subscriptions: ' + (Object.keys(wanted).join(' | ') || '(none)') : null
    };
}

module.exports = {ingest, processDxwatch, processRbn, processPskr, intakeEnabled,
    liveRequest, backfillRequest, mainPageRequest, rbnRequest, extractRbnHash,
    syncPskrSubscriptions};
