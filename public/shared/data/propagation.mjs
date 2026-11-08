/**
 * Propagation repository for GET /api/prop. Output is the exact server snapshot,
 * including its raw measurements and server-computed forecast; no formulas or rewrites.
 */
import {getJson} from '../core/transport.mjs';

const defaultTransport = {getJson};

export function getPropSnapshot({transport = defaultTransport, ...options} = {}) {
    return transport.getJson('/api/prop', options);
}

/** Select (never calculate) the forecast embedded in a snapshot. */
export function selectForecast(snapshot) {
    return snapshot && snapshot.forecast !== undefined ? snapshot.forecast : null;
}
