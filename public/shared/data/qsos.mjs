/**
 * QSO repository and store for /api/qsos rows plus live qso/qsoDelete WS DTOs.
 * Raw snake_case DB rows and camelCase live records are both retained unchanged.
 * n1mmId/n1mm_id unifies replay, live contactreplace and deletion.
 */
import {getJson} from '../core/transport.mjs';
import {createEmitter} from '../core/events.mjs';

const defaultTransport = {getJson};

export async function fetchQsos({transport = defaultTransport, limit = 200, ...options} = {}) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString();
    const rows = await transport.getJson(`/api/qsos${suffix ? `?${suffix}` : ''}`, options);
    if (!Array.isArray(rows)) throw new TypeError('/api/qsos returned a non-array DTO');
    return rows;
}

export function qsoKey(qso) {
    if (!qso || typeof qso !== 'object') return null;
    const id = qso.n1mmId !== undefined ? qso.n1mmId : qso.n1mm_id;
    if (id !== null && id !== undefined && id !== '') return `id${id}`;
    const timestamp = qsoTimestamp(qso);
    if (!timestamp || !qso.call) return null;
    return ['fallback', timestamp, qso.call, qso.band || '', qso.freqKhz || qso.freq_khz || ''].join('|');
}

export const qsoTimestamp = qso => qso && (qso.ts !== undefined ? qso.ts : qso.timestamp);
const timeOf = qso => new Date(qsoTimestamp(qso)).getTime();

function compareEntries(a, b) {
    const ta = timeOf(a.value), tb = timeOf(b.value);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (Number.isFinite(ta) !== Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : 1;
    return a.seq - b.seq;
}

export function createQsoStore() {
    const entries = new Map();
    const events = createEmitter();
    let sequence = 0;

    const put = (qso, replace) => {
        const key = qsoKey(qso);
        if (!key) return false;
        const old = entries.get(key);
        if (old && !replace) return false;
        entries.set(key, {value: qso, seq: old ? old.seq : sequence++});
        const type = old ? 'update' : 'add';
        events.emit(type, qso, old && old.value);
        events.emit('change', {type, items: [qso]});
        return true;
    };
    const ingest = qso => put(qso, true);
    const merge = (rows, {newestFirst = false, replace = false} = {}) => {
        if (!Array.isArray(rows)) throw new TypeError('QSO history must be an array');
        const changed = [];
        const source = newestFirst ? [...rows].reverse() : rows;
        source.forEach(qso => {
            if (put(qso, replace)) changed.push(qso);
        });
        return changed;
    };
    const remove = idOrMessage => {
        const id = idOrMessage && typeof idOrMessage === 'object'
            ? (idOrMessage.n1mmId !== undefined ? idOrMessage.n1mmId : idOrMessage.n1mm_id)
            : idOrMessage;
        const key = id !== null && id !== undefined && id !== '' ? `id${id}` : qsoKey(idOrMessage);
        if (!key || !entries.has(key)) return false;
        const old = entries.get(key).value;
        entries.delete(key);
        events.emit('delete', old);
        events.emit('change', {type: 'delete', items: [old]});
        return true;
    };
    const select = ({call, band, operator, since, until, newestFirst = false, limit} = {}) => {
        const start = since === undefined ? NaN : new Date(since).getTime();
        const end = until === undefined ? NaN : new Date(until).getTime();
        let rows = [...entries.values()].sort(compareEntries).map(entry => entry.value);
        rows = rows.filter(qso => {
            if (call && String(qso.call || '').toUpperCase() !== String(call).toUpperCase()) return false;
            if (band && String(qso.band || '').toUpperCase() !== String(band).toUpperCase()) return false;
            const op = qso.operator || qso.op || '';
            if (operator && String(op).toUpperCase() !== String(operator).toUpperCase()) return false;
            const time = timeOf(qso);
            if (Number.isFinite(start) && (!Number.isFinite(time) || time < start)) return false;
            if (Number.isFinite(end) && (!Number.isFinite(time) || time > end)) return false;
            return true;
        });
        if (newestFirst) rows.reverse();
        if (limit !== undefined) rows = rows.slice(0, Math.max(0, limit));
        return rows;
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
        remove,
        select,
        all: options => select(options),
        latest() { return select({newestFirst: true, limit: 1})[0] || null; },
        clear,
        on: events.on,
        get size() { return entries.size; }
    };
}

export async function replayQsos(store, options = {}) {
    const rows = await fetchQsos(options);
    return store.replay(rows);
}
