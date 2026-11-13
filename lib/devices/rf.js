'use strict';

/**
 * 射频链路：端口派生、无向连线、TX 方向可达判定与配置校验。
 *
 * 与机械挂载（devices.parent_id）完全独立：
 *   - 机械关系决定“谁装在谁上”，单父、无环；
 *   - 射频关系是一根同轴线，存成无向边，方向由端口能力决定。
 *
 * 端口不单独建表：按设备类型默认值 + 实例配置即时派生。
 * 遍历一律用 BFS + visited 防重，不复用 parent 链。
 */

const BAND_PATTERN = /^\d{1,3}m$/;
const PORT_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,32}$/;
const PORT_DIRS = ['in', 'out', 'bidir'];
const MAX_PORTS = 32;
const MAX_PORT_COUNT = 16;

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function countOf(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const int = Math.floor(n);
    if (int < 1) return 1;
    return int > MAX_PORT_COUNT ? MAX_PORT_COUNT : int;
}

function bandList(device) {
    const raw = device && Array.isArray(device.bands) ? device.bands : [];
    return raw.map(band => String(band).toLowerCase()).filter(Boolean);
}

function roleOf(dir) {
    return dir === 'bidir' ? 'bidir' : dir;
}

/** 高级覆盖：config.ports = [{key,dir,band?}]；不合法返回 null 交给默认值。 */
function overridePorts(device) {
    const config = device && device.config && typeof device.config === 'object' ? device.config : {};
    if (!Array.isArray(config.ports) || !config.ports.length) return null;
    const ports = [];
    for (const item of config.ports) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const key = text(item.key);
        const dir = text(item.dir).toLowerCase();
        if (!PORT_KEY_PATTERN.test(key) || !PORT_DIRS.includes(dir)) continue;
        if (ports.some(port => port.key === key)) continue;
        const port = {key, dir, role: roleOf(dir)};
        const band = text(item.band).toLowerCase();
        if (band && BAND_PATTERN.test(band)) port.band = band;
        ports.push(port);
        if (ports.length >= MAX_PORTS) break;
    }
    return ports.length ? ports : null;
}

/** 校验 config.ports 覆盖（保存时使用，失败即拒绝而不是静默丢弃）。 */
function normalizePortOverride(input) {
    if (!Array.isArray(input)) return {ok: false, error: 'invalid-config-ports'};
    if (input.length > MAX_PORTS) return {ok: false, error: 'invalid-config-ports'};
    const ports = [];
    for (const item of input) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return {ok: false, error: 'invalid-config-ports'};
        }
        const key = text(item.key);
        const dir = text(item.dir).toLowerCase();
        if (!PORT_KEY_PATTERN.test(key)) return {ok: false, error: 'invalid-config-port-key'};
        if (!PORT_DIRS.includes(dir)) return {ok: false, error: 'invalid-config-port-dir'};
        if (ports.some(port => port.key === key)) return {ok: false, error: 'invalid-config-port-key'};
        const port = {key, dir};
        const band = text(item.band).toLowerCase();
        if (band) {
            if (!BAND_PATTERN.test(band)) return {ok: false, error: 'invalid-config-port-band'};
            port.band = band;
        }
        ports.push(port);
    }
    return {ok: true, ports};
}

/**
 * 某台设备当前拥有的 RF 端口。
 * 合路器的 in 口由 bands 派生：一个波段一个 in 口，没有独立的输入数量。
 */
function portsFor(device) {
    if (!device || !device.id) return [];
    const override = overridePorts(device);
    if (override) return override;
    const config = device.config && typeof device.config === 'object' ? device.config : {};
    switch (String(device.type || '').toLowerCase()) {
        case 'radio':
            return [{key: 'ant', dir: 'bidir', role: 'bidir'}];
        case 'swr':
        case 'bpf':
        case 'amp':
            return [
                {key: 'in', dir: 'in', role: 'in'},
                {key: 'out', dir: 'out', role: 'out'}
            ];
        case 'antenna':
            return [{key: 'feed', dir: 'bidir', role: 'bidir'}];
        case 'switch': {
            const outputs = countOf(config.out_count, 2);
            const ports = [{key: 'common', dir: 'in', role: 'in'}];
            for (let i = 1; i <= outputs; i += 1) {
                ports.push({key: 'out' + i, dir: 'out', role: 'out'});
            }
            return ports;
        }
        case 'matrix': {
            const inputs = countOf(config.in_count, 2);
            const outputs = countOf(config.out_count, 4);
            const ports = [];
            for (let i = 1; i <= inputs; i += 1) {
                ports.push({key: 'in' + i, dir: 'in', role: 'in'});
            }
            for (let i = 1; i <= outputs; i += 1) {
                ports.push({key: 'out' + i, dir: 'out', role: 'out'});
            }
            return ports;
        }
        case 'combiner': {
            const ports = bandList(device).map(band => ({
                key: 'in:' + band,
                dir: 'in',
                role: 'in',
                band
            }));
            ports.push({key: 'out', dir: 'out', role: 'out'});
            return ports;
        }
        default:
            // 塔、旋转器、旧兜底类型没有 RF 端口。
            return [];
    }
}

function portMap(devices) {
    const map = {};
    for (const device of devices || []) {
        if (!device || !device.id) continue;
        map[device.id] = portsFor(device);
    }
    return map;
}

function findPort(device, key) {
    const want = text(key);
    return portsFor(device).find(port => port.key === want) || null;
}

function canEnter(port) {
    return !!port && port.dir !== 'out';
}

function canLeave(port) {
    return !!port && port.dir !== 'in';
}

function deviceAllowsBand(device, band) {
    const bands = bandList(device);
    if (!band || !bands.length) return true;
    return bands.includes(String(band).toLowerCase());
}

/**
 * 图结构：邻接表按 (device, port) 建，孤立/失效连线单独收集。
 */
function graphOf(devices, links) {
    const byId = new Map();
    for (const device of devices || []) {
        if (device && device.id) byId.set(device.id, device);
    }
    const portMaps = new Map();
    for (const [id, device] of byId) {
        const map = new Map();
        for (const port of portsFor(device)) map.set(port.key, port);
        portMaps.set(id, map);
    }
    const adjacency = new Map();
    const orphans = [];
    const push = (deviceId, portKey, other) => {
        const key = deviceId + '\u0000' + portKey;
        if (!adjacency.has(key)) adjacency.set(key, []);
        adjacency.get(key).push(other);
    };
    for (const link of links || []) {
        if (!link) continue;
        const aDevice = byId.get(link.a_device);
        const bDevice = byId.get(link.b_device);
        const aPort = aDevice ? portMaps.get(aDevice.id).get(link.a_port) : null;
        const bPort = bDevice ? portMaps.get(bDevice.id).get(link.b_port) : null;
        if (!aDevice || !bDevice || !aPort || !bPort) {
            orphans.push(link);
            continue;
        }
        push(aDevice.id, aPort.key, {deviceId: bDevice.id, port: bPort.key});
        push(bDevice.id, bPort.key, {deviceId: aDevice.id, port: aPort.key});
    }
    return {byId, portMaps, adjacency, orphans};
}

function selectionFor(selections, deviceId) {
    const value = selections && selections[deviceId];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * TX 方向上，信号从该设备的哪些端口继续前进。
 * 切换器/矩阵是选择性导通：已知选择只走选中的输出；未知选择时保守处理。
 */
function departurePorts(device, arrival, selections) {
    const ports = portsFor(device);
    const others = ports.filter(port => port.key !== arrival.key && canLeave(port));
    const type = String(device.type || '').toLowerCase();
    if (type !== 'switch' && type !== 'matrix') return others;

    const selection = selectionFor(selections, device.id);
    if (arrival.role === 'in') {
        const chosen = text(selection[arrival.key]);
        if (chosen) return others.filter(port => port.key === chosen);
        const outputs = others.filter(port => port.role === 'out');
        // 只有一个输出时选择是唯一的，不需要运行态。
        if (outputs.length === 1) return outputs;
        return [];
    }
    if (arrival.role === 'out') {
        const inputs = ports.filter(port => port.role === 'in' && text(selection[port.key]) === arrival.key);
        return inputs;
    }
    return [];
}

/**
 * 从某台电台（或任意起点设备）沿 TX 方向做 BFS，返回可达天线。
 * @returns {Array<{device: object, path: Array<{device_id: string, port: string}>}>}
 */
function reachableAntennas(input) {
    const opts = input || {};
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const links = Array.isArray(opts.links) ? opts.links : [];
    const band = text(opts.band).toLowerCase();
    const selections = opts.selections || {};
    const graph = graphOf(devices, links);
    const start = graph.byId.get(text(opts.startDeviceId));
    if (!start || start.enabled === false) return [];

    const results = [];
    const seenAntennas = new Set();
    const visited = new Set();
    // 队列元素是“从该设备的该端口离开”。起点是电台的所有可出端口。
    const queue = [];
    for (const port of portsFor(start)) {
        if (!canLeave(port)) continue;
        queue.push({
            deviceId: start.id,
            port: port.key,
            path: [{device_id: start.id, port: port.key}]
        });
    }

    while (queue.length) {
        const node = queue.shift();
        const key = node.deviceId + '\u0000' + node.port;
        if (visited.has(key)) continue;
        visited.add(key);
        const device = graph.byId.get(node.deviceId);
        const port = graph.portMaps.get(node.deviceId).get(node.port);
        if (!device || !port || device.enabled === false) continue;

        for (const neighbor of graph.adjacency.get(key) || []) {
            const nextDevice = graph.byId.get(neighbor.deviceId);
            if (!nextDevice || nextDevice.enabled === false) continue;
            const nextPort = graph.portMaps.get(nextDevice.id).get(neighbor.port);
            if (!nextPort || !canEnter(nextPort)) continue;
            if (!deviceAllowsBand(nextDevice, band)) continue;
            // 合路器特例：进入端口必须与当前波段精确匹配。
            if (nextPort.band && nextPort.band !== band) continue;
            const path = node.path.concat([{device_id: nextDevice.id, port: nextPort.key}]);
            if (String(nextDevice.type || '').toLowerCase() === 'antenna') {
                if (!seenAntennas.has(nextDevice.id)) {
                    seenAntennas.add(nextDevice.id);
                    results.push({device: nextDevice, path});
                }
                continue;
            }
            for (const exit of departurePorts(nextDevice, nextPort, selections)) {
                queue.push({deviceId: nextDevice.id, port: exit.key, path});
            }
        }
    }
    return results;
}

function endpoint(input, side) {
    const body = input && typeof input === 'object' ? input : {};
    const nested = body[side] && typeof body[side] === 'object' && !Array.isArray(body[side])
        ? body[side] : null;
    const suffix = side === 'a' ? ['a_device', 'from_device'] : ['b_device', 'to_device'];
    const portSuffix = side === 'a' ? ['a_port', 'from_port'] : ['b_port', 'to_port'];
    let device = nested ? nested.device || nested.device_id || nested.id : '';
    let port = nested ? nested.port || nested.port_key : '';
    for (const name of suffix) if (!text(device) && body[name] !== undefined) device = body[name];
    for (const name of portSuffix) if (!text(port) && body[name] !== undefined) port = body[name];
    return {device: text(device), port: text(port)};
}

function canonical(aDevice, aPort, bDevice, bPort) {
    const swap = aDevice > bDevice || (aDevice === bDevice && aPort > bPort);
    return swap
        ? {a_device: bDevice, a_port: bPort, b_device: aDevice, b_port: aPort}
        : {a_device: aDevice, a_port: aPort, b_device: bDevice, b_port: bPort};
}

function linkId(pair) {
    return 'rf:' + pair.a_device + ':' + pair.a_port + '~' + pair.b_device + ':' + pair.b_port;
}

/**
 * 校验一条 RF 连线。反向重复视为同一条，返回 existing=true。
 */
function normalizeLink(input, options) {
    const opts = options || {};
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const links = Array.isArray(opts.links) ? opts.links : [];
    const a = endpoint(input, 'a');
    const b = endpoint(input, 'b');
    if (!a.device || !a.port || !b.device || !b.port) {
        return {ok: false, status: 400, error: 'invalid-link'};
    }
    if (a.device === b.device && a.port === b.port) {
        return {ok: false, status: 400, error: 'invalid-link'};
    }
    const byId = new Map(devices.filter(device => device && device.id).map(device => [device.id, device]));
    for (const side of [a, b]) {
        const device = byId.get(side.device);
        if (!device) return {ok: false, status: 404, error: 'unknown-device', detail: side.device};
        if (!findPort(device, side.port)) {
            return {ok: false, status: 400, error: 'unknown-port', detail: side.device + ':' + side.port};
        }
    }
    const pair = canonical(a.device, a.port, b.device, b.port);
    const id = linkId(pair);
    const existing = links.find(link => link && link.link_id === id) || null;
    if (existing) return {ok: true, existing: true, link: existing};
    return {
        ok: true,
        existing: false,
        link: Object.assign({link_id: id}, pair)
    };
}

function publicLink(link) {
    const value = link || {};
    return {
        link_id: value.link_id || '',
        a_device: value.a_device || '',
        a_port: value.a_port || '',
        b_device: value.b_device || '',
        b_port: value.b_port || '',
        created_ts: value.created_ts || null
    };
}

function warn(list, code, extra) {
    list.push(Object.assign({code}, extra || {}));
}

/**
 * 配置校验（只提示，不在运行时仲裁）：
 *   - 同一副天线接了多个上游；
 *   - 合路器下游天线的波段未覆盖 in 口波段集合；
 *   - 连线引用了已被删除的端口或设备。
 */
function warnings(devices, links) {
    const list = [];
    const graph = graphOf(devices, links);
    for (const link of graph.orphans) {
        warn(list, 'rf-link-orphan', {link_id: link.link_id || ''});
    }

    const upstream = new Map();
    const addUpstream = device => {
        if (!device || String(device.type || '').toLowerCase() !== 'antenna') return;
        upstream.set(device.id, (upstream.get(device.id) || 0) + 1);
    };
    for (const link of links || []) {
        if (!link || graph.orphans.includes(link)) continue;
        addUpstream(graph.byId.get(link.a_device));
        addUpstream(graph.byId.get(link.b_device));
    }
    for (const [deviceId, count] of upstream) {
        if (count <= 1) continue;
        const device = graph.byId.get(deviceId);
        warn(list, 'antenna-multi-upstream', {
            device_id: deviceId,
            name: device ? device.name : deviceId,
            count
        });
    }

    for (const device of devices || []) {
        if (!device || String(device.type || '').toLowerCase() !== 'combiner') continue;
        const bands = bandList(device);
        if (!bands.length) continue;
        const out = portsFor(device).find(port => port.role === 'out');
        if (!out) continue;
        for (const link of links || []) {
            if (!link || graph.orphans.includes(link)) continue;
            let otherId = '';
            if (link.a_device === device.id && link.a_port === out.key) otherId = link.b_device;
            else if (link.b_device === device.id && link.b_port === out.key) otherId = link.a_device;
            if (!otherId) continue;
            const antenna = graph.byId.get(otherId);
            if (!antenna || String(antenna.type || '').toLowerCase() !== 'antenna') continue;
            const covered = bandList(antenna);
            const missing = bands.filter(band => !covered.includes(band));
            if (missing.length) {
                warn(list, 'combiner-antenna-band-uncovered', {
                    combiner_id: device.id,
                    antenna_id: antenna.id,
                    missing
                });
            }
        }
    }
    return list;
}

/**
 * TX 互锁范围：从发射状态源绑定的设备出发，沿 RF 链路双向找出
 * 同一物理通路上的设备与端口。切换器/矩阵按当前选择精确跟随；
 * 选择未知时保守地覆盖全部端口，宁可多锁不可漏锁。
 */
function txLockPorts(input) {
    const opts = input || {};
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const links = Array.isArray(opts.links) ? opts.links : [];
    const selections = opts.selections || {};
    const graph = graphOf(devices, links);
    const source = graph.byId.get(text(opts.sourceDeviceId));
    const devicesSet = new Set();
    const ports = new Map();
    if (!source) return {devices: devicesSet, ports};

    const addPort = (deviceId, key) => {
        if (!ports.has(deviceId)) ports.set(deviceId, new Set());
        ports.get(deviceId).add(key);
    };
    const visited = new Set();
    const queue = [];
    devicesSet.add(source.id);
    for (const port of portsFor(source)) {
        addPort(source.id, port.key);
        queue.push({deviceId: source.id, port: port.key});
    }

    while (queue.length) {
        const node = queue.shift();
        const key = node.deviceId + '\u0000' + node.port;
        if (visited.has(key)) continue;
        visited.add(key);
        const device = graph.byId.get(node.deviceId);
        const arrival = graph.portMaps.get(node.deviceId).get(node.port);
        if (!device || !arrival) continue;

        // 源设备本身没有“到达”动作：直接从它的每个端口沿连线走出去。
        if (device.id === source.id) {
            for (const neighbor of graph.adjacency.get(key) || []) {
                const nextDevice = graph.byId.get(neighbor.deviceId);
                if (!nextDevice) continue;
                const nextPort = graph.portMaps.get(nextDevice.id).get(neighbor.port);
                if (!nextPort) continue;
                devicesSet.add(nextDevice.id);
                addPort(nextDevice.id, nextPort.key);
                queue.push({deviceId: nextDevice.id, port: nextPort.key});
            }
            continue;
        }

        const type = String(device.type || '').toLowerCase();
        const selection = selectionFor(selections, device.id);
        let nextPorts;
        if (type === 'switch' || type === 'matrix') {
            const others = portsFor(device).filter(port => port.key !== arrival.key);
            if (arrival.role === 'in') {
                const chosen = text(selection[arrival.key]);
                nextPorts = chosen
                    ? others.filter(port => port.key === chosen)
                    : others;
            } else if (arrival.role === 'out') {
                const inputs = portsFor(device).filter(port =>
                    port.role === 'in' && text(selection[port.key]) === arrival.key);
                nextPorts = inputs.length ? inputs : portsFor(device).filter(port => port.role === 'in');
            } else {
                nextPorts = others;
            }
        } else {
            nextPorts = portsFor(device).filter(port => port.key !== arrival.key);
        }

        for (const next of nextPorts) {
            addPort(device.id, next.key);
            const neighbors = graph.adjacency.get(device.id + '\u0000' + next.key) || [];
            for (const neighbor of neighbors) {
                const nextDevice = graph.byId.get(neighbor.deviceId);
                if (!nextDevice) continue;
                const nextPort = graph.portMaps.get(nextDevice.id).get(neighbor.port);
                if (!nextPort) continue;
                devicesSet.add(nextDevice.id);
                addPort(nextDevice.id, nextPort.key);
                queue.push({deviceId: nextDevice.id, port: nextPort.key});
            }
        }
    }

    return {devices: devicesSet, ports};
}

module.exports = {
    BAND_PATTERN,
    PORT_KEY_PATTERN,
    PORT_DIRS,
    MAX_PORTS,
    MAX_PORT_COUNT,
    bandList,
    overridePorts,
    normalizePortOverride,
    portsFor,
    portMap,
    findPort,
    deviceAllowsBand,
    graphOf,
    departurePorts,
    reachableAntennas,
    normalizeLink,
    publicLink,
    warnings,
    txLockPorts
};
