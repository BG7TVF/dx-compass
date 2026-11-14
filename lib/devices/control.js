'use strict';

/**
 * 控制链路与寻址解析。
 *
 * 所有设备控制都走网络，但只有一部分设备自己带网口：
 *   1. 网络设备（旋转器、网络继电器、带网口的功放/驻波表、串口服务器）
 *      在属性里直接配置 host / port（或 relay_url），本模块原样返回；
 *   2. RS-232/485 设备先接串口服务器：设备自己的控制口与串口服务器的
 *      serialN 口之间画一条控制连线，地址从上游服务器继承，串口号来自连线。
 *
 * 控制连线是圆形的控制口之间的边，与 RF 链路互不影响：
 * 不参与 TX 可达、波段剪枝、席位归属或发射互锁。
 */

const rf = require('./rf.js');
const MAX_LINKS = 256;
const MAX_SERIAL_PORT = 16;

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function fail(status, error, detail) {
    return {ok: false, status, error, detail: detail || ''};
}

function controlPortsOf(device) {
    return rf.controlPorts(device).filter(port => port.kind === 'control');
}

function findControlPort(device, key) {
    return controlPortsOf(device).find(port => port.key === text(key)) || null;
}

function serialPortNumber(device, key) {
    if (!device || device.type !== 'serial') return null;
    const match = /^serial(\d{1,2})$/.exec(text(key));
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) && n >= 1 && n <= MAX_SERIAL_PORT ? n : null;
}

function endpointOf(link, deviceId) {
    if (!link) return null;
    if (link.a_device === deviceId) return {deviceId: link.a_device, port: link.a_port};
    if (link.b_device === deviceId) return {deviceId: link.b_device, port: link.b_port};
    return null;
}

function otherEndOf(link, deviceId) {
    if (!link) return null;
    if (link.a_device === deviceId) return {deviceId: link.b_device, port: link.b_port};
    if (link.b_device === deviceId) return {deviceId: link.a_device, port: link.a_port};
    return null;
}

function canonicalPair(a, b) {
    const first = {device: text(a.device), port: text(a.port)};
    const second = {device: text(b.device), port: text(b.port)};
    const swap = first.device > second.device ||
        (first.device === second.device && first.port > second.port);
    const left = swap ? second : first;
    const right = swap ? first : second;
    return {
        a_device: left.device,
        a_port: left.port,
        b_device: right.device,
        b_port: right.port,
        link_id: 'ctl:' + left.device + ':' + left.port + '~' + right.device + ':' + right.port
    };
}

/**
 * 校验并规范化一条控制连线。
 * 唯一合法形状：串口服务器的 serialN ↔ 另一台设备的控制口；
 * 每个控制口、每个串口只允许一条连线。
 */
function normalizeLink(input, options) {
    const body = input && typeof input === 'object' ? input : {};
    const devices = Array.isArray(options && options.devices) ? options.devices : [];
    const links = Array.isArray(options && options.links) ? options.links : [];
    const endpoints = body.a
        ? {a: body.a, b: body.b}
        : {a: {device: body.a_device, port: body.a_port}, b: {device: body.b_device, port: body.b_port}};
    const aDeviceId = text(endpoints.a && endpoints.a.device);
    const aPortKey = text(endpoints.a && endpoints.a.port);
    const bDeviceId = text(endpoints.b && endpoints.b.device);
    const bPortKey = text(endpoints.b && endpoints.b.port);
    if (!aDeviceId || !aPortKey || !bDeviceId || !bPortKey) return fail(400, 'invalid-link');
    if (aDeviceId === bDeviceId) return fail(409, 'invalid-link', 'same-device');

    const byId = new Map();
    for (const device of devices) {
        if (device && device.id) byId.set(device.id, device);
    }
    const aDevice = byId.get(aDeviceId);
    const bDevice = byId.get(bDeviceId);
    if (!aDevice || !bDevice) return fail(404, 'unknown-device');
    const aPort = findControlPort(aDevice, aPortKey);
    const bPort = findControlPort(bDevice, bPortKey);
    if (!aPort || !bPort) return fail(400, 'unknown-control-port');

    // 只允许“串口服务器 ↔ 串口设备”，两端不能都是串口服务器。
    const aSerial = aDevice.type === 'serial' ? serialPortNumber(aDevice, aPortKey) : null;
    const bSerial = bDevice.type === 'serial' ? serialPortNumber(bDevice, bPortKey) : null;
    if (aDevice.type === 'serial' && !aSerial) return fail(400, 'invalid-control-port');
    if (bDevice.type === 'serial' && !bSerial) return fail(400, 'invalid-control-port');
    if (!aSerial && !bSerial) return fail(400, 'serial-server-required');
    if (aSerial && bSerial) return fail(409, 'invalid-link', 'two-servers');

    const canonical = canonicalPair(
        {device: aDeviceId, port: aPortKey},
        {device: bDeviceId, port: bPortKey}
    );
    const existing = links.find(link => {
        if (!link) return false;
        return (link.a_device === canonical.a_device && link.a_port === canonical.a_port &&
            link.b_device === canonical.b_device && link.b_port === canonical.b_port) ||
            (link.a_device === canonical.b_device && link.a_port === canonical.b_port &&
                link.b_device === canonical.a_device && link.b_port === canonical.a_port);
    });
    if (existing) {
        return {ok: true, existing: true, link: Object.assign({}, canonical, {created_ts: existing.created_ts})};
    }
    if (links.length >= MAX_LINKS) return fail(409, 'too-many-links');

    // 一个控制口只能挂一条连线，一个串口也只能接一台设备。
    for (const link of links) {
        for (const endpoint of [endpoints.a, endpoints.b]) {
            const id = text(endpoint && endpoint.device);
            const port = text(endpoint && endpoint.port);
            if ((link.a_device === id && link.a_port === port) || (link.b_device === id && link.b_port === port)) {
                return fail(409, 'control-port-busy', id + ':' + port);
            }
        }
    }

    return {ok: true, existing: false, link: canonical};
}

function publicLink(link) {
    if (!link) return null;
    return {
        link_id: link.link_id,
        a_device: link.a_device,
        a_port: link.a_port,
        b_device: link.b_device,
        b_port: link.b_port,
        created_ts: link.created_ts || null
    };
}

function serialSettings(device) {
    const config = device && device.config && typeof device.config === 'object' ? device.config : {};
    return {
        baud: Number.isFinite(Number(config.baud)) ? Number(config.baud) : 9600,
        data_bits: Number.isFinite(Number(config.data_bits)) ? Number(config.data_bits) : 8,
        stop_bits: Number.isFinite(Number(config.stop_bits)) ? Number(config.stop_bits) : 1,
        parity: text(config.parity) || 'none'
    };
}

/**
 * 单台设备的实际访问目标。
 * @returns {{mode: 'direct'|'serial'|'unconfigured', host?: string, port?: number,
 *   url?: string, serial_port?: number, serial?: object, via?: string}}
 */
function resolveFor(device, options) {
    if (!device) return {mode: 'unconfigured'};
    const config = device.config && typeof device.config === 'object' ? device.config : {};
    const host = text(config.host);
    const port = Number(config.port);
    const relayUrl = text(config.relay_url);

    if (device.type === 'serial') {
        if (!host || !Number.isFinite(port)) return {mode: 'unconfigured'};
        return {mode: 'direct', kind: 'serial-server', host, port, serial: serialSettings(device)};
    }
    if (host && Number.isFinite(port)) {
        return {mode: 'direct', host, port};
    }
    if (relayUrl) {
        return {mode: 'direct', url: relayUrl};
    }

    const links = Array.isArray(options && options.links) ? options.links : [];
    const byId = new Map();
    for (const item of (options && options.devices) || []) {
        if (item && item.id) byId.set(item.id, item);
    }
    for (const link of links) {
        const self = endpointOf(link, device.id);
        if (!self) continue;
        const other = otherEndOf(link, device.id);
        const server = other ? byId.get(other.deviceId) : null;
        if (!server || server.type !== 'serial') continue;
        const serialPort = serialPortNumber(server, other.port);
        if (!serialPort) continue;
        const serverConfig = server.config && typeof server.config === 'object' ? server.config : {};
        const serverHost = text(serverConfig.host);
        const serverPort = Number(serverConfig.port);
        if (!serverHost || !Number.isFinite(serverPort)) return {mode: 'unconfigured', via: server.id};
        return {
            mode: 'serial',
            host: serverHost,
            port: serverPort,
            serial_port: serialPort,
            serial: serialSettings(server),
            via: server.id
        };
    }
    return {mode: 'unconfigured'};
}

function addressMap(devices, controlLinks) {
    const map = {};
    for (const device of devices || []) {
        if (!device || !device.id) continue;
        if (!rf.controlPorts(device).length) continue;
        map[device.id] = resolveFor(device, {devices, links: controlLinks});
    }
    return map;
}

function warnings(devices, controlLinks) {
    const list = [];
    const byId = new Map();
    for (const device of devices || []) {
        if (device && device.id) byId.set(device.id, device);
    }
    for (const link of controlLinks || []) {
        if (!link) continue;
        const a = byId.get(link.a_device);
        const b = byId.get(link.b_device);
        const aPort = a ? findControlPort(a, link.a_port) : null;
        const bPort = b ? findControlPort(b, link.b_port) : null;
        if (!a || !b || !aPort || !bPort) {
            list.push({code: 'control-link-orphan', link_id: link.link_id});
            continue;
        }
        const aSerial = a.type === 'serial' && serialPortNumber(a, link.a_port);
        const bSerial = b.type === 'serial' && serialPortNumber(b, link.b_port);
        if (!aSerial && !bSerial) list.push({code: 'control-link-unbound', link_id: link.link_id});
    }
    for (const device of devices || []) {
        if (!device || !rf.controlPorts(device).length) continue;
        if (device.type === 'serial') continue;
        const address = resolveFor(device, {devices, links: controlLinks});
        if (address.mode === 'unconfigured') {
            list.push({code: 'control-address-unconfigured', device_id: device.id});
        }
    }
    return list;
}

module.exports = {
    MAX_SERIAL_PORT,
    controlPortsOf,
    findControlPort,
    serialPortNumber,
    normalizeLink,
    publicLink,
    resolveFor,
    addressMap,
    warnings
};
