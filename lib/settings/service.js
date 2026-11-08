'use strict';

function get(global) {
    const settings = global.get('uiSettings');
    return {settings: settings && typeof settings === 'object' ? settings : null};
}

function save(global, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {statusCode: 400, payload: {success: false, error: 'invalid settings body'}};
    }
    global.set('uiSettings', body);
    return {payload: {success: true}, broadcast: {type: 'settings', settings: body}};
}

function getCallsigns(global) {
    return global.get('monitoredCalls') || [];
}

function saveCallsigns(global, input) {
    let calls = input;
    if (typeof calls === 'string') {
        try { calls = JSON.parse(calls); }
        catch (e) { calls = calls.split(',').map(c => c.trim()).filter(Boolean); }
    }
    if (!Array.isArray(calls)) calls = [];
    calls = calls.map(c => String(c).toUpperCase().trim()).filter(Boolean).slice(0, 9);
    const prev = (global.get('monitoredCalls') || []).map(c => String(c).toUpperCase());
    const fresh = calls.filter(c => !prev.includes(c));
    global.set('monitoredCalls', calls);
    return {calls, fresh, payload: {success: true, calls, backfill: fresh}};
}

function saveQrz(flow, body) {
    body = body || {};
    const user = String(body.username || '').trim();
    const pass = String(body.password || '').trim();
    if (!user || !pass) {
        return {statusCode: 400, payload: {ok: false, error: 'username and password required'}};
    }
    flow.set('qrzuser', user);
    flow.set('qrzpass', pass);
    flow.set('qrzkey', null);
    return {payload: {ok: true, configured: true}, login: true};
}

function qrzState(flow) {
    return {
        configured: !!flow.get('qrzuser'),
        username: flow.get('qrzuser') || '',
        session: !!flow.get('qrzkey')
    };
}

function reset(global, flow) {
    global.set('recording', {active: false, manual: false, startedAt: null, schedule: null});
    global.set('monitoring', false);
    global.set('monitorClients', {});
    global.set('uiSettings', null);
    flow.set('lastSpotId', 0);
    flow.set('seenIds', {});
    flow.set('dedupKeys', {});
    global.set('radioState', null);
    global.set('radioStates', {});
    global.set('scoreState', null);
    flow.set('qrzuser', null);
    flow.set('qrzpass', null);
    flow.set('qrzkey', null);
}

module.exports = {get, save, getCallsigns, saveCallsigns, saveQrz, qrzState, reset};
