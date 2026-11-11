'use strict';

const schema = require('../../public/shared/settings/schema.js');
const logger = require('../logger');

const DOMAIN_KEYS = new Set(schema.DOMAINS.map(d => d.key));

function isPlain(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function logWarnings(scope, warnings) {
    if (!warnings || !warnings.length) return;
    logger.warn(`[settings] ${scope}: ${warnings.slice(0, 20).join(' | ')}`);
}

function nextRev(base) {
    const current = isPlain(base) && Number.isInteger(base._rev) ? base._rev : 0;
    return current + 1;
}

/** Browser-local keys must never be persisted or broadcast server-side. */
function stripLocalOnly(settings) {
    for (const field of schema.FIELDS) {
        if (field.storage !== 'shared') delete settings[field.key];
    }
    return settings;
}

function get(global) {
    const stored = global.get('uiSettings');
    if (!stored || typeof stored !== 'object') return {settings: null};
    const result = schema.sanitize(stored);
    logger.setLevel(result.settings.logLevel);
    logWarnings('read', result.warnings);
    return {settings: stripLocalOnly(result.settings)};
}

function save(global, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {statusCode: 400, payload: {success: false, error: 'invalid settings body'}};
    }
    const isPatch = isPlain(body.__patch);
    const patch = isPatch ? body.__patch : body;
    const current = global.get('uiSettings');
    const base = isPlain(current) ? current : {};
    const merged = schema.mergeDeep(base, patch);
    delete merged.__patch;
    delete merged.__domain;

    const result = schema.sanitize(merged);
    const settings = stripLocalOnly(result.settings);
    settings._rev = nextRev(base);
    global.set('uiSettings', settings);
    logger.setLevel(settings.logLevel);
    logWarnings('save', result.warnings);

    return {
        payload: {
            success: true,
            partial: isPatch,
            settings,
            rev: settings._rev,
            warnings: result.warnings,
            rejected: result.rejected
        },
        broadcast: {type: 'settings', settings, rev: settings._rev},
        warnings: result.warnings
    };
}

/** Reset one domain (or all) to schema defaults and broadcast the result. */
function resetDomain(global, domain, body) {
    const target = String(domain || (body && body.domain) || '').trim();
    if (target !== 'all' && !DOMAIN_KEYS.has(target)) {
        return {
            statusCode: 400,
            payload: {success: false, error: `unknown settings domain: ${target || '(empty)'}`}
        };
    }
    const current = global.get('uiSettings');
    const base = isPlain(current) ? current : {};
    const settings = target === 'all'
        ? schema.defaultSettings()
        : schema.sanitize(schema.mergeDeep(base, schema.defaultsForDomain(target))).settings;
    stripLocalOnly(settings);
    settings._rev = nextRev(base);
    global.set('uiSettings', settings);

    return {
        payload: {success: true, domain: target, settings, rev: settings._rev},
        broadcast: {type: 'settings', settings, rev: settings._rev}
    };
}

/** Sanitize an already-read settings bag; never throws and always fills defaults. */
function effective(stored) {
    if (!isPlain(stored)) return schema.defaultSettings();
    try {
        return schema.sanitize(stored).settings;
    } catch (e) {
        return schema.defaultSettings();
    }
}

/** Effective settings for runtime consumers; never throws and always fills defaults. */
function runtime(global) {
    let stored = null;
    try { stored = global.get('uiSettings'); } catch (e) { stored = null; }
    /* Async context mocks (tests, custom hosts) hand back a promise: fall back
     * to defaults rather than treating the promise as the settings object. */
    if (stored && typeof stored.then === 'function') return schema.defaultSettings();
    return effective(stored);
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
    const limit = runtime(global).maxCallsigns;
    calls = calls.map(c => String(c).toUpperCase().trim()).filter(Boolean).slice(0, limit);
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
    // 采集/监听固定常开：恢复出厂设置也不会关闭采集。
    global.set('monitoring', true);
    global.set('monitorClients', {});
    global.set('uiSettings', null);
    flow.set('lastSpotId', 0);
    flow.set('seenIds', {});
    flow.set('dedupKeys', {});
    global.set('radioState', null);
    global.set('radioStates', {});
    global.set('operatorSessions', {});
    global.set('scoreState', null);
    flow.set('qrzuser', null);
    flow.set('qrzpass', null);
    flow.set('qrzkey', null);
}

module.exports = {
    get,
    save,
    resetDomain,
    getCallsigns,
    saveCallsigns,
    saveQrz,
    qrzState,
    reset,
    runtime,
    effective,
    schema
};
