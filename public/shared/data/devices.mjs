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

/**
 * Attach one control link (serial-server serialN ↔ a device control port).
 * Control links never touch the RF graph or the TX interlock.
 */
export function saveControlLink(link, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'ctl-link', link}, options);
}

export function deleteControlLink(link, {transport = defaultTransport, ...options} = {}) {
    const id = typeof link === 'string' ? link : (link && link.link_id);
    return transport.postJson('/api/devices', {action: 'ctl-unlink', link_id: id}, options);
}

/**
 * 草稿拓扑预览：带上草稿设备与页面内的草稿连线，服务端按落库同一套规则
 * 返回草稿端口、规范化后的草稿连线与控制寻址，不写库。
 */
export function previewDrafts(payload, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', Object.assign({action: 'preview'}, payload), options);
}

/**
 * 草稿一次性落库：设备、布局与草稿连线在同一事务里写入，
 * 任何一条不合法则整批拒绝。
 */
export function saveDraftBatch(payload, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', Object.assign({action: 'save-batch'}, payload), options);
}

/** Create or update one TX status source. */
export function saveTxSource(source, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'tx-source', source}, options);
}

export function deleteTxSource(id, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/devices', {action: 'tx-source-delete', id}, options);
}

/**
 * 频率联动开关：按席位存服务端（global），不是浏览器本地偏好。
 * 关掉联动不影响手动切天线，开着也不会在发射中途抢天线。
 */
export function setBandLink(seat, enabled, {transport = defaultTransport, operator = '', ...options} = {}) {
    return transport.postJson('/api/devices',
        {action: 'band-link', seat, enabled: enabled === true, operator}, options);
}

/**
 * Send one device command through the single write channel.
 * Every command carries the seat identity; control addressing is resolved
 * server-side from the device or its upstream serial server.
 */
export function sendDeviceCommand(deviceId, command, {
    seat,
    operator,
    transport = defaultTransport,
    ...options
} = {}) {
    const headers = Object.assign({}, options.headers, {'X-DX-Seat': String(seat || '')});
    if (operator) headers['X-DX-Operator'] = String(operator);
    return transport.postJson(
        `/api/devices/${encodeURIComponent(deviceId)}/command`,
        command,
        Object.assign({}, options, {headers})
    );
}

/**
 * 摄像头发现：不带 host 时服务端跑局域网 WS-Discovery，带 host 时跑 ONVIF
 * GetProfiles。组播应答要等几秒，超时比默认的 15s 放宽。
 */
export function discoverCameras(payload, {
    transport = defaultTransport,
    timeoutMs = 30000,
    ...options
} = {}) {
    return transport.postJson('/api/cameras/discover', payload || {}, Object.assign({timeoutMs}, options));
}
