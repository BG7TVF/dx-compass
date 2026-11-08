/**
 * Station repository for /api/station/state. Input: optional transport/request options
 * and raw radio/score WS messages. Output: the unchanged server state DTO.
 */
import {getJson} from '../core/transport.mjs';

const defaultTransport = {getJson};

export function getStationState({transport = defaultTransport, ...options} = {}) {
    return transport.getJson('/api/station/state', options);
}

/** Purely merge one live radio/score message into a station snapshot. */
export function applyStationMessage(state, message) {
    const current = state && typeof state === 'object' ? state : {radio: null, radios: {}, score: null};
    if (!message || (message.type !== 'radio' && message.type !== 'score')) return current;
    if (message.type === 'score') return {...current, score: message};
    const radios = {...(current.radios || {})};
    if (message.radioNr !== null && message.radioNr !== undefined) radios[message.radioNr] = message;
    return {...current, radio: message, radios};
}
