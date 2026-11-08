/**
 * Spot repository and in-memory store for /api/spots and live WS spot DTOs.
 * Records are returned unchanged. History replay accepts newest-first API rows;
 * selectors return oldest-first by default and live/history duplicates share one key.
 */
import {getJson, postJson} from '../core/transport.mjs';
import {createEmitter} from '../core/events.mjs';

const defaultTransport = {getJson, postJson};

function spotUrl(path, {call, limit} = {}) {
    const query = new URLSearchParams();
    if (call) query.set('call', String(call));
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString();
    return `${path}${suffix ? `?${suffix}` : ''}`;
}

export async function fetchSpots({transport = defaultTransport, call, limit = 1000, ...options} = {}) {
    const rows = await transport.getJson(spotUrl('/api/spots', {call, limit}), options);
    if (!Array.isArray(rows)) throw new TypeError('/api/spots returned a non-array DTO');
    return rows;
}

export function clearSpots({transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/spots/clear', undefined, options);
}

/** Preserve the existing marker/history dedup key. */
export function spotKey(spot) {
    if (!spot || typeof spot !== 'object') return null;
    if (spot.spot_id !== null && spot.spot_id !== undefined) return `id${spot.spot_id}`;
    if (spot.de === undefined && spot.freq === undefined && spot.timestamp === undefined) return null;
    return [spot.de, spot.freq, spot.timestamp].join('|');
}

const timeOf = spot => new Date(spot && spot.timestamp).getTime();
const callOf = spot => String(spot.monitored_call || spot.call || '').toUpperCase();

function compareEntries(a, b) {
    const ta = timeOf(a.value), tb = timeOf(b.value);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
    return a.seq - b.seq;
}

export function createSpotStore() {
    const entries = new Map();
    const events = createEmitter();
    let sequence = 0;

    const ingest = spot => {
        const key = spotKey(spot);
        if (!key || entries.has(key)) return false;
        entries.set(key, {value: spot, seq: sequence++});
        events.emit('add', spot);
        events.emit('change', {type: 'add', items: [spot]});
        return true;
    };
    const merge = (rows, {newestFirst = false} = {}) => {
        if (!Array.isArray(rows)) throw new TypeError('spot history must be an array');
        const added = [];
        const source = newestFirst ? [...rows].reverse() : rows;
        source.forEach(spot => {
            const key = spotKey(spot);
            if (!key || entries.has(key)) return;
            entries.set(key, {value: spot, seq: sequence++});
            added.push(spot);
            events.emit('add', spot);
        });
        if (added.length) events.emit('change', {type: 'merge', items: added});
        return added;
    };
    const select = ({call, band, mode, since, until, newestFirst = false, limit} = {}) => {
        const wantedCall = call ? String(call).toUpperCase() : '';
        const start = since === undefined ? NaN : new Date(since).getTime();
        const end = until === undefined ? NaN : new Date(until).getTime();
        let rows = [...entries.values()].sort(compareEntries).map(entry => entry.value);
        rows = rows.filter(spot => {
            if (wantedCall && callOf(spot) !== wantedCall &&
                String(spot.spot_call || '').toUpperCase() !== wantedCall) return false;
            if (band && String(spot.band || '').toUpperCase() !== String(band).toUpperCase()) return false;
            if (mode && String(spot.mode || '').toUpperCase() !== String(mode).toUpperCase()) return false;
            const time = timeOf(spot);
            if (Number.isFinite(start) && (!Number.isFinite(time) || time < start)) return false;
            if (Number.isFinite(end) && (!Number.isFinite(time) || time > end)) return false;
            return true;
        });
        if (newestFirst) rows.reverse();
        if (limit !== undefined) rows = rows.slice(0, Math.max(0, limit));
        return rows;
    };
    const active = (ttlForSpot, now = Date.now(), options = {}) => {
        if (typeof ttlForSpot !== 'function') throw new TypeError('ttlForSpot must be a function');
        return select(options).filter(spot => {
            const time = timeOf(spot);
            return Number.isFinite(time) && now - time <= ttlForSpot(spot);
        });
    };
    const prune = (ttlForSpot, now = Date.now()) => {
        const removed = [];
        entries.forEach((entry, key) => {
            const time = timeOf(entry.value);
            if (Number.isFinite(time) && now - time > ttlForSpot(entry.value)) {
                entries.delete(key);
                removed.push(entry.value);
            }
        });
        if (removed.length) events.emit('change', {type: 'prune', items: removed});
        return removed;
    };
    const clear = () => {
        if (!entries.size) return;
        entries.clear();
        events.emit('change', {type: 'clear', items: []});
    };
    return {
        ingest,
        merge,
        replay: rows => merge(rows, {newestFirst: true}),
        select,
        all: options => select(options),
        byCall: (call, options = {}) => select({...options, call}),
        active,
        prune,
        clear,
        on: events.on,
        get size() { return entries.size; }
    };
}

/** Fetch newest-first history and merge it into a store; returns newly added raw rows. */
export async function replaySpots(store, options = {}) {
    const rows = await fetchSpots(options);
    return store.replay(rows);
}
