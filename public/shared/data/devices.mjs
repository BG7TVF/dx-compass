/**
 * Device repository for /api/devices.
 * Input: JSON-compatible device payloads. Output: the unchanged server DTO.
 * The page never caches device state: every refresh re-reads this endpoint.
 */
import {getJson, postJson} from '../core/transport.mjs';

const defaultTransport = {getJson, postJson};

export function getDevicesSnapshot({transport = defaultTransport, ...options} = {}) {
    return transport.getJson('/api/devices', options);
}

/** Create or update one device (configuration, not a device command). */
export function saveDevice(device, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'save', device}, options);
}

export function deleteDevice(id, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'delete', id}, options);
}

/** Create or update one TX status source. */
export function saveTxSource(source, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'tx-source', source}, options);
}

export function deleteTxSource(id, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'tx-source-delete', id}, options);
}
