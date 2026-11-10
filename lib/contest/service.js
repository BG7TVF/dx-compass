'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const logger = require('../logger');
const settingsService = require('../settings/service.js');
const ics = require('./ics.js');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const USER_AGENT = 'DX-Compass/1.0 (amateur radio dashboard; WA7BNM ICS feed)';
const DEFAULT_REFRESH_HOURS = 168;

const CONTEST_KEYS = [
    'contestId', 'contestName', 'contestStart', 'contestEnd',
    'contestModes', 'contestBands', 'contestRulesUrl', 'contestUpdatedAt'
];

function livePath() {
    return process.env.DX_CONTEST_SNAPSHOT ||
        path.join(process.cwd(), 'var', 'contest-calendar.json');
}

function fallbackPath() {
    return path.join(__dirname, '..', '..', 'public', 'data', 'contest-calendar.json');
}

function baseMeta() {
    return {
        source: ics.SOURCE,
        sourceUrl: ics.FEED_URL,
        homeUrl: ics.HOME_URL,
        termsUrl: ics.TERMS_URL,
        format: 'ics',
        fetchedAt: '',
        count: 0,
        attribution: 'WA7BNM Contest Calendar'
    };
}

function normalizeMeta(raw, bundled) {
    const meta = Object.assign(baseMeta(), raw || {});
    meta.count = Number.isFinite(Number(meta.count)) ? Number(meta.count) : 0;
    meta.fetchedAt = String(meta.fetchedAt || '');
    meta.bundled = Boolean(bundled);
    return meta;
}

/** Fetch a small HTTPS text document with a hard size/time limit. */
function httpsGet(url, redirects = 3) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1', 'User-Agent': USER_AGENT}
        }, response => {
            const status = response.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects > 0) {
                response.resume();
                const next = new URL(response.headers.location, url).href;
                resolve(httpsGet(next, redirects - 1));
                return;
            }
            if (status !== 200) {
                response.resume();
                reject(new Error(`HTTP ${status}`));
                return;
            }
            let size = 0;
            const chunks = [];
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_BYTES) {
                    request.destroy(new Error('feed too large'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.on('error', reject);
        request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('feed timeout')));
    });
}

function writeSnapshot(snapshot) {
    const target = livePath();
    fs.mkdirSync(path.dirname(target), {recursive: true});
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(temp, target);
}

/** Read the local snapshot; fall back to the bundled copy, then to an empty list. */
function readSnapshot() {
    const candidates = [{file: livePath(), bundled: false}, {file: fallbackPath(), bundled: true}];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate.file, 'utf8'));
            if (parsed && Array.isArray(parsed.contests)) {
                return {meta: normalizeMeta(parsed.meta, candidate.bundled), contests: parsed.contests};
            }
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                logger.warn(`[contest] snapshot read failed (${candidate.file}): ${error.message}`);
            }
        }
    }
    return {meta: normalizeMeta({}, true), contests: []};
}

/** Download the ICS feed and replace the local snapshot. */
async function refresh() {
    try {
        const body = await httpsGet(ics.FEED_URL);
        const contests = ics.parseIcs(body);
        if (!contests.length) throw new Error('feed contained no contests');
        const meta = normalizeMeta({
            fetchedAt: new Date().toISOString(),
            count: contests.length
        }, false);
        const stamped = contests.map(contest => Object.assign({}, contest, {rulesCheckedAt: meta.fetchedAt}));
        writeSnapshot({meta, contests: stamped});
        logger.info(`[contest] refreshed ${meta.count} contests from WA7BNM ICS`);
        return {ok: true, meta};
    } catch (error) {
        const message = String((error && error.message) || error);
        logger.warn(`[contest] refresh failed: ${message}`);
        return {ok: false, error: message};
    }
}

function refreshHours(settings) {
    const value = Number(settings && settings.contestRefreshHours);
    if (!Number.isFinite(value)) return DEFAULT_REFRESH_HOURS;
    return Math.min(720, Math.max(1, Math.round(value)));
}

/** Refresh only when the configured interval has elapsed (default once a week). */
async function maybeRefresh(settings, now) {
    const snapshot = readSnapshot();
    const fetchedAt = Date.parse(snapshot.meta.fetchedAt);
    const current = Number.isFinite(now) ? now : Date.now();
    const hours = refreshHours(settings);
    if (Number.isFinite(fetchedAt) && current - fetchedAt < hours * 3600 * 1000) {
        return {ok: true, skipped: true, meta: snapshot.meta};
    }
    return refresh();
}

/** Parse an ISO/UTC `datetime` value; naive values are interpreted as UTC. */
function parseUtc(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return null;
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text) ? `${text}:00Z`
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) ? `${text}Z` : text;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
}

/** Contest window in epoch milliseconds, for the multiplier matrix and alerts. */
function windowFor(settings) {
    const cfg = settings && typeof settings === 'object' ? settings : {};
    const from = parseUtc(cfg.contestStart);
    const to = parseUtc(cfg.contestEnd);
    return {from, to};
}

/**
 * Server-side expiry: once the selected contest has ended, clear every contest
 * field and broadcast the new settings. Clients never decide this themselves.
 */
function expire(global, now) {
    let settings = null;
    try {
        settings = settingsService.runtime(global);
    } catch (error) {
        return {changed: false};
    }
    const end = parseUtc(settings.contestEnd);
    const current = Number.isFinite(now) ? now : Date.now();
    if (end === null || current < end) return {changed: false};

    const patch = {};
    for (const key of CONTEST_KEYS) patch[key] = '';
    patch.wallTimerStart = '';
    patch.wallTimerEnd = '';

    const saved = settingsService.save(global, {__patch: patch});
    logger.info(`[contest] auto-cleared "${settings.contestName || settings.contestId || 'unnamed'}" at end time`);
    return {changed: true, settings: saved.payload.settings, broadcast: saved.broadcast};
}

module.exports = {
    readSnapshot,
    refresh,
    maybeRefresh,
    expire,
    windowFor,
    parseUtc,
    refreshHours,
    livePath,
    fallbackPath,
    normalizeMeta,
    DEFAULT_REFRESH_HOURS
};
