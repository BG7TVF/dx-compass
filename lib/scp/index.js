'use strict';

const fs = require('fs');
const path = require('path');
const {parseMaster, candidates} = require('./parse.js');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'var', 'scp');
const SOURCE = 'https://www.supercheckpartial.com/MASTER.SCP';
const USER_AGENT = 'DX-Compass/2.1 (+https://supercheckpartial.com)';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const MIN_CALLS = 30000;
const MAX_CALLS = 80000;
const CREDIT = 'Super Check Partial Database (W9KKN) — supercheckpartial.com';

function createStore({dir = DEFAULT_DIR, source = SOURCE, fetchImpl = null} = {}) {
    const dataFile = path.join(dir, 'MASTER.SCP');
    const stateFile = path.join(dir, 'state.json');
    const state = {
        loaded: false,
        release: '',
        count: 0,
        fetchedAt: null,
        lastModified: '',
        stale: true,
        error: null,
        calls: new Set()
    };

    function readJson(file) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            return null;
        }
    }

    function apply(text, meta) {
        const parsed = parseMaster(text);
        if (parsed.calls.size < MIN_CALLS || parsed.calls.size > MAX_CALLS) {
            throw new Error('unexpected SCP size: ' + parsed.calls.size);
        }
        state.calls = parsed.calls;
        state.count = parsed.calls.size;
        state.release = parsed.release || (meta && meta.release) || '';
        state.fetchedAt = (meta && meta.fetchedAt) || null;
        state.lastModified = (meta && meta.lastModified) || '';
        state.loaded = true;
        state.stale = !state.fetchedAt || (Date.now() - Date.parse(state.fetchedAt)) > REFRESH_MS * 2;
        state.error = null;
    }

    /** Load the cached copy; a missing or damaged cache just leaves SCP unavailable. */
    function init() {
        const meta = readJson(stateFile);
        try {
            const text = fs.readFileSync(dataFile, 'utf8');
            apply(text, meta);
        } catch (error) {
            state.loaded = false;
            state.error = String(error && error.message || error);
        }
        return status();
    }

    function status() {
        return {
            loaded: state.loaded,
            release: state.release,
            count: state.count,
            fetchedAt: state.fetchedAt,
            stale: state.stale,
            error: state.error,
            credit: CREDIT,
            source
        };
    }

    function lookup(call) {
        if (!state.loaded) return {status: 'unavailable', release: state.release};
        for (const candidate of candidates(call)) {
            if (state.calls.has(candidate)) {
                return {status: 'hit', matched: candidate, release: state.release};
            }
        }
        return {status: 'miss', release: state.release};
    }

    /**
     * Conditional daily refresh. Failures keep the previous copy, so a network
     * outage never silently empties the check.
     */
    async function refresh({force = false} = {}) {
        if (state.loaded && !force && state.fetchedAt &&
            Date.now() - Date.parse(state.fetchedAt) < REFRESH_MS) {
            return {ok: true, skipped: true, reason: 'fresh', status: status()};
        }
        const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
        if (!doFetch) return {ok: false, skipped: true, reason: 'no-fetch', status: status()};
        const headers = {'User-Agent': USER_AGENT};
        if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
        try {
            const response = await doFetch(source, {headers});
            if (response.status === 304) {
                state.fetchedAt = new Date().toISOString();
                saveState();
                return {ok: true, skipped: true, reason: 'not-modified', status: status()};
            }
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const text = await response.text();
            const parsed = parseMaster(text);
            apply(text, {
                release: parsed.release,
                fetchedAt: new Date().toISOString(),
                lastModified: response.headers && response.headers.get
                    ? (response.headers.get('last-modified') || '') : ''
            });
            fs.mkdirSync(dir, {recursive: true});
            const tmp = dataFile + '.tmp';
            fs.writeFileSync(tmp, text, 'utf8');
            fs.renameSync(tmp, dataFile);
            saveState();
            return {ok: true, skipped: false, status: status()};
        } catch (error) {
            state.error = String(error && error.message || error);
            state.stale = true;
            return {ok: false, skipped: false, reason: 'fetch-failed', error: state.error, status: status()};
        }
    }

    function saveState() {
        try {
            fs.mkdirSync(dir, {recursive: true});
            fs.writeFileSync(stateFile, JSON.stringify({
                release: state.release,
                count: state.count,
                fetchedAt: state.fetchedAt,
                lastModified: state.lastModified
            }, null, 2), 'utf8');
        } catch (error) {
            /* cache metadata is best-effort; the data file is the source of truth */
        }
    }

    return {init, status, lookup, refresh, dir};
}

const store = createStore();
store.init();

module.exports = Object.assign({createStore, CREDIT}, {
    init: store.init,
    status: store.status,
    lookup: store.lookup,
    refresh: store.refresh
});
