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

/** Persist canvas positions only; layout never mixes into device configuration. */
export function saveDeviceLayouts(layouts, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'layout', layouts}, options);
}

/** Attach one RF link between two device ports (undirected, reverse deduped). */
export function saveRfLink(link, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'rf-link', link}, options);
}

/** Remove one RF link by id or by its endpoint pair. */
export function deleteRfLink(link, {transport = defaultTransport, ...options} = {}) {
    const id = typeof link === 'string' ? link : (link && link.link_id);
    const payload = id ? {link_id: id} : {link};
    return transport.postJson('/api/devices', Object.assign({action: 'rf-unlink'}, payload), options);
}

/** Create or update one TX status source. */
export function saveTxSource(source, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'tx-source', source}, options);
}

export function deleteTxSource(id, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'tx-source-delete', id}, options);
}

/**
 * Send one device command through the single write channel.
 * Every command carries the seat identity; the device password is optional
 * and only sent when the device has one configured.
 */
export function sendDeviceCommand(deviceId, command, {
    seat,
    deviceToken,
    operator,
    transport = defaultTransport,
    ...options
} = {}) {
    const headers = Object.assign({}, options.headers, {'X-DX-Seat': String(seat || '')});
    if (operator) headers['X-DX-Operator'] = String(operator);
    if (deviceToken) headers['X-DX-Device-Token'] = String(deviceToken);
    return transport.postJson(
        `/api/devices/${encodeURIComponent(deviceId)}/command`,
        command,
        Object.assign({}, options, {headers})
    );
}
