/**
 * Station repository for /api/station/state. Input: optional transport/request options
 * and raw radio/score WS messages. Output: the unchanged server state DTO.
 */
import {getJson, postJson} from '../core/transport.mjs';

const defaultTransport = {getJson, postJson};

export function getStationState({transport = defaultTransport, ...options} = {}) {
    return transport.getJson('/api/station/state', options);
}

export function changeFrequencyClaim(action, claim, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/frequency-claims/' + encodeURIComponent(action), claim, options);
}

/** Auto-identified seats with evidence, history and the unidentified bucket. */
export function getSeatIdentities({transport = defaultTransport, ...options} = {}) {
    return transport.getJson('/api/seats', options);
}

/** name / override / unbind / bind one identified seat. */
export function changeSeatIdentity(change, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/seats', change, options);
}

/** Purely merge one live radio/score/claim message into a station snapshot. */
export function applyStationMessage(state, message) {
    const current = state && typeof state === 'object' ? state : {radio: null, radios: {}, claims: [], score: null};
    if (!message) return current;
    if (message.type === 'frequencyClaims') {
        return {...current, claims: Array.isArray(message.claims) ? message.claims : []};
    }
    if (message.type !== 'radio' && message.type !== 'score') return current;
    if (message.type === 'score') return {...current, score: message};
    const radios = {...(current.radios || {})};
    const key = message.seat || message.radioNr;
    if (key !== null && key !== undefined && key !== '') radios[key] = message;
    return {...current, radio: message, radios};
}
