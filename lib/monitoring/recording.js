'use strict';

function emptyState() {
    return {active: false, manual: false, startedAt: null, schedule: null};
}

function status(global) {
    return global.get('recording') || emptyState();
}

function control(global, body, now = new Date()) {
    body = body || {};
    const rec = global.get('recording') || emptyState();
    const fmt = s => /^\d{1,2}-\d{1,2}\s+\d{1,2}:\d{1,2}$/.test(String(s || '').trim());
    if (body.action === 'start') {
        rec.active = true;
        rec.manual = true;
        rec.startedAt = now.toISOString();
    } else if (body.action === 'stop') {
        rec.active = false;
        rec.manual = false;
        rec.schedule = null;
    } else if (body.action === 'schedule') {
        if (!fmt(body.start) || !fmt(body.end)) {
            return {statusCode: 400,
                payload: {success: false, error: 'start/end must be "MM-DD HH:mm" (UTC)'}};
        }
        rec.schedule = {start: String(body.start).trim(), end: String(body.end).trim()};
    } else if (body.action === 'unschedule') {
        rec.schedule = null;
    } else {
        return {statusCode: 400, payload: {success: false, error: 'unknown action'}};
    }
    global.set('recording', rec);
    return {payload: {success: true, recording: rec}};
}

function tick(global, now = new Date()) {
    const rec = global.get('recording') || emptyState();
    if (!rec.schedule) return {warnings: []};
    const parse = s => {
        const m = String(s).match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/);
        if (!m) return null;
        return new Date(Date.UTC(now.getUTCFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]));
    };
    const start = parse(rec.schedule.start);
    let end = parse(rec.schedule.end);
    const warnings = [];
    if (!start || !end) {
        rec.schedule = null;
        global.set('recording', rec);
        return {warnings};
    }
    if (end <= start) end = new Date(end.getTime() + 365 * 86400000);
    if (!rec.active && now >= start && now < end) {
        rec.active = true;
        rec.manual = false;
        rec.startedAt = now.toISOString();
        warnings.push('Recording started (scheduled)');
    } else if (rec.active && !rec.manual && now >= end) {
        rec.active = false;
        rec.schedule = null;
        warnings.push('Recording stopped (scheduled end)');
    } else if (!rec.active && now >= end) {
        rec.schedule = null;
    }
    global.set('recording', rec);
    return {warnings};
}

function shouldRecord(global) {
    const rec = global.get('recording');
    return !!(rec && rec.active);
}

function prepareSpot(s, rec) {
    if (!rec || !rec.active) return null;
    if (!s || !s.timestamp) return null;
    const iso = new Date(s.timestamp).toISOString();
    const date = iso.substring(0, 10);
    const time = iso.substring(11, 19);
    let detail = null;
    const comment = String(s.comment || '');
    if (s.mode === 'CW') {
        const m = comment.match(/(\d+)\s*WPM/i);
        if (m) detail = m[1] + ' WPM';
    } else if (s.mode === 'DIGI') {
        const m = comment.toUpperCase().match(/CONTESTIA|DOMINO|OLIVIA|THROB|MFSK\d*|FT8|FT4|RTTY|PSK\d+|JT65|JT9|JS8|HELL|THOR/);
        if (m) detail = m[0];
    }
    return {...s, date, time, detail};
}

module.exports = {emptyState, status, control, tick, shouldRecord, prepareSpot};
