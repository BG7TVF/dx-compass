/**
 * Callsign repositories: the monitored-call list and the OP view's call
 * sanity check. Both are read-only wrappers around the existing endpoints.
 */
import {getJson, postJson} from '../core/transport.mjs';

const defaultTransport = {getJson, postJson};

export async function fetchCallsigns({transport = defaultTransport, ...options} = {}) {
    const data = await transport.getJson('/api/callsigns', options);
    return Array.isArray(data) ? data : [];
}

/**
 * SCP first, then QRZ. `exclude` is the N1MM id of the QSO under review.
 * A miss in either layer is never treated as proof that the call is invalid.
 */
export async function checkCallsign(call, exclude, {transport = defaultTransport, qrz = true, scp = true, ...options} = {}) {
    const query = new URLSearchParams();
    query.set('call', String(call || '').trim().toUpperCase());
    if (exclude !== null && exclude !== undefined && String(exclude) !== '') {
        query.set('exclude', String(exclude));
    }
    if (qrz === false) query.set('qrz', '0');
    if (scp === false) query.set('scp', '0');
    return transport.getJson(`/api/callsign/check?${query.toString()}`, options);
}
