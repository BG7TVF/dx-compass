'use strict';

/**
 * 天线切换器 / 矩阵切换器型号描述表（唯一数据源）。
 *
 * 只登记调研中确认过协议或帧格式的型号：
 *   第一批（可回读）：4O3A Antenna Genius、Hamation/ZSERVER、Green Heron Everyware、
 *                    Amplitec SW3000-6（仅回读）、wa4mcm 1×4；
 *   第二批（只写）：Array Solutions RCS-4、4O3A Station Genius、
 *                  RemoteQTH Six2Two、通用继电器板。
 *
 * 明确不做：microHAM Station Master Deluxe、DXE 系列、M2、HamPlus MBD-62 直连、
 * EA4TX；Stack Match 只登记为不支持（多路同开与现有互斥模型相反）。
 */

const rf = require('./rf.js');

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

const HOST_FIELD = {
    key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100, required: true
};

function portField(defaultPort) {
    const field = {
        key: 'port', type: 'number', label: 'dev.config.port',
        min: 1, max: 65535, step: 1
    };
    if (defaultPort) field.default = defaultPort;
    return field;
}

const SWITCH_ID_FIELD = {
    key: 'switch_id', type: 'text', label: 'dev.config.switchId', maxlength: 32
};

const RADIO_FIELD = {
    key: 'radio', type: 'number', label: 'dev.config.radio', min: 1, max: 4, step: 1, default: 1
};

const MQTT_FIELDS = [
    HOST_FIELD,
    portField(1883),
    {key: 'topic_prefix', type: 'text', label: 'dev.config.topicPrefix', maxlength: 200, default: 'remoteqth'},
    {key: 'username', type: 'text', label: 'dev.config.username', maxlength: 100, autocomplete: 'off'},
    {
        key: 'password', type: 'password', label: 'dev.config.password',
        maxlength: 200, placeholder: 'dev.config.keepPassword'
    }
];

const RELAY_FIELDS = [
    {key: 'relay_url', type: 'text', label: 'dev.config.relayUrl', maxlength: 300},
    {key: 'relay_token', type: 'password', label: 'dev.config.relayToken', maxlength: 200},
    {
        key: 'pulse_ms', type: 'number', label: 'dev.config.pulseMs',
        min: 50, max: 5000, step: 1, default: 400
    }
];

function model(input) {
    return Object.assign({
        type: 'switch',
        supported: true,
        control: true,
        readback: false,
        verified: true,
        defaults: {},
        fields: [HOST_FIELD],
        hint: ''
    }, input);
}

const BRANDS = [
    {
        id: '4o3a',
        name: '4O3A',
        models: [
            model({
                id: 'antenna-genius',
                name: 'Antenna Genius 8×2',
                type: 'matrix',
                protocol: 'ag-tcp',
                transport: 'ag-tcp',
                readback: true,
                control: true,
                ports: {in: 2, out: 8},
                defaults: {in_count: 2, out_count: 8},
                fields: [HOST_FIELD, portField(9007)],
                hint: 'dev.switch.agHint'
            }),
            model({
                id: 'station-genius',
                name: 'Station Genius',
                type: 'switch',
                protocol: 'station-genius-tcp',
                transport: 'station-genius-tcp',
                readback: false,
                control: true,
                verified: false,
                ports: {in: 1, out: 7},
                defaults: {out_count: 7},
                fields: [HOST_FIELD, portField(8001)],
                hint: 'dev.switch.writeOnlyHint'
            })
        ]
    },
    {
        id: 'hamation',
        name: 'Hamation / ShackLan',
        models: [
            model({
                id: 'zserver',
                name: 'ZSERVER 4×8',
                type: 'matrix',
                protocol: 'zserver-udp',
                transport: 'zserver-udp',
                readback: true,
                control: true,
                ports: {in: 4, out: 8},
                defaults: {in_count: 4, out_count: 8, status_port: 50334},
                fields: [HOST_FIELD, portField(50333), {
                    key: 'status_port', type: 'number', label: 'dev.config.statusPort',
                    min: 1, max: 65535, step: 1, default: 50334
                }, SWITCH_ID_FIELD, RADIO_FIELD],
                hint: 'dev.switch.readbackHint'
            })
        ]
    },
    {
        id: 'greenheron',
        name: 'Green Heron',
        models: [
            model({
                id: 'everyware',
                name: 'Everyware 4×8',
                type: 'matrix',
                protocol: 'greenheron-tcp',
                transport: 'greenheron-tcp',
                readback: true,
                control: true,
                ports: {in: 4, out: 8},
                defaults: {in_count: 4, out_count: 8},
                fields: [HOST_FIELD, portField(10000), SWITCH_ID_FIELD],
                hint: 'dev.switch.readbackHint'
            })
        ]
    },
    {
        id: 'amplitec',
        name: 'Amplitec',
        models: [
            model({
                id: 'sw3000-6',
                name: 'SW3000-6',
                type: 'switch',
                protocol: 'amplitec-tcp',
                transport: 'amplitec-tcp',
                readback: true,
                // 调研只确认了读类型/读状态帧，没有确认切换命令：只回读，不下发。
                control: false,
                verified: false,
                ports: {in: 1, out: 6},
                defaults: {out_count: 6},
                fields: [HOST_FIELD, portField()],
                hint: 'dev.switch.amplitecHint'
            })
        ]
    },
    {
        id: 'wa4mcm',
        name: 'wa4mcm',
        models: [
            model({
                id: '1x4',
                name: '1×4 ASCII 切换器',
                type: 'switch',
                protocol: 'wa4mcm-tcp',
                transport: 'wa4mcm-tcp',
                readback: true,
                control: true,
                ports: {in: 1, out: 4},
                defaults: {out_count: 4},
                fields: [HOST_FIELD, portField(8008)],
                hint: 'dev.switch.readbackHint'
            })
        ]
    },
    {
        id: 'arraysolutions',
        name: 'Array Solutions',
        models: [
            model({
                id: 'rcs-4',
                name: 'RCS-4',
                type: 'switch',
                protocol: 'rcs4-tcp',
                transport: 'rcs4-tcp',
                readback: false,
                control: true,
                verified: false,
                ports: {in: 1, out: 4},
                defaults: {out_count: 4},
                fields: [HOST_FIELD, portField(8080)],
                hint: 'dev.switch.rcsUnverifiedHint'
            }),
            model({
                id: 'stack-match',
                name: 'Stack Match',
                type: 'switch',
                supported: false,
                control: false,
                readback: false,
                ports: {in: 1, out: 3},
                defaults: {out_count: 3},
                fields: [],
                hint: 'dev.switch.unsupportedHint'
            })
        ]
    },
    {
        id: 'remoteqth',
        name: 'RemoteQTH',
        models: [
            model({
                id: 'six2two',
                name: 'Six2Two 2×6',
                type: 'matrix',
                protocol: 'six2two-mqtt',
                transport: 'six2two-mqtt',
                readback: false,
                control: true,
                verified: false,
                ports: {in: 2, out: 6},
                defaults: {in_count: 2, out_count: 6},
                fields: MQTT_FIELDS,
                hint: 'dev.switch.writeOnlyHint'
            })
        ]
    }
];

/** 未选型号 / 选「其他」：沿用通用继电器板，任何切换都只能标为「未验证」。 */
const GENERIC = {
    switch: {
        id: 'relay-board',
        name: 'Generic relay board',
        type: 'switch',
        protocol: 'relay',
        transport: 'relay',
        supported: true,
        control: true,
        readback: false,
        defaults: {out_count: 2},
        fields: RELAY_FIELDS,
        hint: 'dev.switch.writeOnlyHint'
    },
    matrix: {
        id: 'relay-board',
        name: 'Generic relay board',
        type: 'matrix',
        protocol: 'relay',
        transport: 'relay',
        supported: true,
        control: true,
        readback: false,
        defaults: {in_count: 2, out_count: 4},
        fields: RELAY_FIELDS,
        hint: 'dev.switch.writeOnlyHint'
    }
};

function brandById(id) {
    const key = text(id);
    if (!key) return null;
    return BRANDS.find(brand => brand.id === key) || null;
}

/** 型号只在同类型内解析，避免 switch 与 matrix 共用同名 id 时串型。 */
function resolve(type, brandId, modelId) {
    const kind = text(type).toLowerCase();
    const id = text(modelId);
    if (!id || id === 'other') return null;
    const brand = brandById(brandId);
    const list = brand ? brand.models : BRANDS.reduce((all, item) => all.concat(item.models), []);
    return list.find(item => item.id === id && item.type === kind) || null;
}

function supported(definition) {
    return !!(definition && definition.supported !== false && definition.control !== false);
}

function known(definition) {
    return !!definition;
}

function readbackOf(config, type) {
    const definition = resolve(type, config && config.brand, config && config.model);
    return !!(definition && definition.readback);
}

function transportOf(config, type) {
    const definition = resolve(type, config && config.brand, config && config.model);
    if (definition) return definition.transport;
    return 'relay';
}

function protocolOf(config, type) {
    const definition = resolve(type, config && config.brand, config && config.model);
    return definition ? definition.protocol : 'relay';
}

function protocols(type) {
    const kind = text(type).toLowerCase();
    const set = new Set(['relay']);
    for (const brand of BRANDS) {
        for (const item of brand.models) {
            if (item.type === kind && item.protocol) set.add(item.protocol);
        }
    }
    return [...set];
}

/**
 * 型号定义的射频端口构成，是端口 key 生成、连线校验与波段剪枝的唯一依据。
 * 未选型号（或选「其他」）时返回 null，表示沿用配置里手填的路数。
 */
function portPlanOf(type, config) {
    const kind = text(type).toLowerCase();
    if (kind !== 'switch' && kind !== 'matrix') return null;
    const definition = resolve(kind, config && config.brand, config && config.model);
    if (!definition || !definition.ports) return null;
    const clamp = value => Math.max(1, Math.min(16, Math.round(Number(value) || 1)));
    return {
        model: definition.id,
        in: clamp(definition.ports.in),
        out: clamp(definition.ports.out)
    };
}

function manualCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * 设备的端口计划：有型号就以型号为准，并记录手填值是否与之不符。
 * 不符时不改写配置，只标记出来给界面与日志说明。
 */
function portPlanFor(device) {
    const config = device && device.config && typeof device.config === 'object' ? device.config : {};
    const plan = portPlanOf(device && device.type, config);
    const manualIn = manualCount(config.in_count);
    const manualOut = manualCount(config.out_count);
    if (!plan) return {source: 'manual', in: manualIn, out: manualOut, mismatch: false};
    return {
        source: 'model',
        model: plan.model,
        in: plan.in,
        out: plan.out,
        manual_in: manualIn,
        manual_out: manualOut,
        mismatch: (manualIn !== null && manualIn !== plan.in) ||
            (manualOut !== null && manualOut !== plan.out)
    };
}

function defaultPortCounts(type, config) {
    const definition = resolve(type, config && config.brand, config && config.model);
    const source = definition ? definition.defaults : (GENERIC[text(type).toLowerCase()] || {}).defaults;
    return Object.assign({}, source || {});
}

function outputPortKey(type, index) {
    return String(type).toLowerCase() === 'switch' ? 'ant' + index : 'out' + index;
}

function bandSetOf(device) {
    const bands = device && Array.isArray(device.bands) ? device.bands : [];
    return bands.map(band => text(band).toLowerCase()).filter(Boolean);
}

function uniqueBands(list) {
    return [...new Set((list || []).map(band => text(band).toLowerCase()).filter(Boolean))];
}

function sameBands(a, b) {
    const left = uniqueBands(a).sort();
    const right = uniqueBands(b).sort();
    return left.length === right.length && left.every((band, index) => band === right[index]);
}

/**
 * 从某个输出端口沿射频连线找实际接到的天线。
 *
 * 只穿过无源/串联设备（合路器、分配器、滤波器等），遇到下一台切换器/矩阵
 * 就停止：那一段的导通取决于对方的选择，不能在这里猜。
 * 一个端口经分配器并联多根天线时，按并集返回。
 */
function antennasBehindPort(device, portKey, devices, links) {
    const graph = rf.graphOf(devices, links);
    const start = graph.byId.get(device.id);
    if (!start) return [];
    const visited = new Set([device.id + '\u0000' + portKey]);
    const queue = [{deviceId: device.id, portKey}];
    const antennas = [];
    const seen = new Set();
    while (queue.length) {
        const node = queue.shift();
        const adjacency = graph.adjacency.get(node.deviceId + '\u0000' + node.portKey) || [];
        for (const neighbor of adjacency) {
            const nextDevice = graph.byId.get(neighbor.deviceId);
            if (!nextDevice) continue;
            const nextPort = graph.portMaps.get(nextDevice.id).get(neighbor.port);
            if (!nextPort || nextPort.dir === 'out') continue;
            const key = nextDevice.id + '\u0000' + nextPort.key;
            if (visited.has(key)) continue;
            visited.add(key);

            const type = String(nextDevice.type || '').toLowerCase();
            if (type === 'antenna') {
                if (!seen.has(nextDevice.id)) {
                    seen.add(nextDevice.id);
                    antennas.push({
                        id: nextDevice.id,
                        name: nextDevice.name || nextDevice.id,
                        bands: bandSetOf(nextDevice)
                    });
                }
                continue;
            }
            // 下游切换器/矩阵的导通由它自己的选择决定，不能在这里穿透。
            if (type === 'switch' || type === 'matrix') continue;
            for (const port of rf.portsFor(nextDevice)) {
                if (port.key === nextPort.key) continue;
                const nextKey = nextDevice.id + '\u0000' + port.key;
                if (visited.has(nextKey)) continue;
                queue.push({deviceId: nextDevice.id, portKey: port.key});
            }
        }
    }
    return antennas;
}

/**
 * 端口 → 天线 → 波段，按射频拓扑即时派生。
 * 不做缓存：每次快照都从当前天线 bands 与连线重算，改波段/换线/删线立即生效。
 */
function topologyPorts(device, devices, links) {
    const ports = {};
    for (const port of rf.portsFor(device)) {
        if (port.role !== 'out') continue;
        const antennas = antennasBehindPort(device, port.key, devices, links);
        ports[port.key] = {
            bands: uniqueBands(antennas.flatMap(antenna => antenna.bands)),
            antennas
        };
    }
    return ports;
}

/** 本地手工兜底：只按输出端口号取，键是天线/端口序号。 */
function manualPorts(device, config) {
    const table = config && config.antenna_bands;
    if (!table || typeof table !== 'object' || Array.isArray(table)) return {};
    const ports = {};
    for (const key of Object.keys(table)) {
        if (!/^\d{1,2}$/.test(key)) continue;
        const index = Number(key);
        const bands = uniqueBands(Array.isArray(table[key]) ? table[key] : []);
        if (!bands.length) continue;
        ports[outputPortKey(device.type, index)] = {
            bands,
            antennas: [{id: '', name: '', bands}]
        };
    }
    return ports;
}

/**
 * 三级映射：设备回读 > 拓扑派生 > 本地手工兜底。
 *
 * 每个输出端口单独判定来源，并把手工配置与拓扑的冲突显式列出；
 * 冲突时仍按优先级使用拓扑结果，但绝不静默丢弃手工值。
 */
function mappingFor(device, entry, context) {
    const config = device && device.config && typeof device.config === 'object' ? device.config : {};
    const state = entry && entry.switch && typeof entry.switch === 'object' ? entry.switch : entry;
    const opts = context || {};
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const links = Array.isArray(opts.links) ? opts.links : [];
    const type = device && device.type;

    const readback = {};
    for (const antenna of (state && Array.isArray(state.antennas) ? state.antennas : [])) {
        const index = Number(antenna.index);
        if (!Number.isFinite(index) || index < 1) continue;
        const bands = uniqueBands(antenna.bands);
        readback[outputPortKey(type, index)] = {
            bands,
            antennas: [{id: '', name: text(antenna.name), bands}]
        };
    }

    const topology = topologyPorts(device, devices, links);
    const manual = manualPorts(device, config);
    const ports = {};
    const conflicts = [];
    const outputPorts = rf.portsFor(device).filter(port => port.role === 'out');

    for (const port of outputPorts) {
        const fromDevice = readback[port.key];
        const fromTopology = topology[port.key] || {bands: [], antennas: []};
        const fromManual = manual[port.key];
        const conflict = !!(fromTopology.bands.length && fromManual &&
            !sameBands(fromTopology.bands, fromManual.bands));

        let source = 'none';
        let bands = [];
        let antennas = [];
        if (fromDevice) {
            source = 'device';
            bands = fromDevice.bands;
            antennas = fromDevice.antennas;
        } else if (fromTopology.bands.length) {
            source = 'topology';
            bands = fromTopology.bands;
            antennas = fromTopology.antennas;
        } else if (fromManual) {
            // 天线已接上但还没填波段：拓扑没有可用结论，手工兜底。
            source = 'manual';
            bands = fromManual.bands;
            antennas = fromManual.antennas;
        } else if (fromTopology.antennas.length) {
            source = 'topology';
            antennas = fromTopology.antennas;
        }

        const item = {source, bands, antennas};
        if (fromManual) {
            item.manual_bands = fromManual.bands;
            item.manual_agrees = !conflict && !!fromTopology.bands.length &&
                sameBands(fromTopology.bands, fromManual.bands);
        }
        if (conflict) {
            item.conflict = true;
            item.topology_bands = fromTopology.bands;
            conflicts.push({
                port: port.key,
                manual_bands: fromManual.bands,
                topology_bands: fromTopology.bands,
                antennas: fromTopology.antennas.map(antenna => ({
                    id: antenna.id,
                    name: antenna.name
                }))
            });
        }
        ports[port.key] = item;
    }

    const sources = Object.keys(ports).map(key => ports[key].source);
    const overall = sources.includes('device') ? 'device'
        : sources.includes('topology') ? 'topology'
            : sources.includes('manual') ? 'manual' : 'none';
    const allAntennas = [];
    const seenAntennas = new Set();
    for (const key of Object.keys(ports)) {
        for (const antenna of ports[key].antennas || []) {
            const id = antenna.id || ('port:' + key);
            if (seenAntennas.has(id)) continue;
            seenAntennas.add(id);
            allAntennas.push(antenna);
        }
    }

    return {
        source: overall,
        bands: uniqueBands(Object.keys(ports).flatMap(key => ports[key].bands)),
        antennas: allAntennas,
        ports,
        conflicts
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function catalog() {
    return {
        brands: clone(BRANDS),
        generic: clone(GENERIC)
    };
}

module.exports = {
    BRANDS,
    GENERIC,
    brandById,
    resolve,
    supported,
    known,
    readbackOf,
    transportOf,
    protocolOf,
    protocols,
    portPlanOf,
    portPlanFor,
    defaultPortCounts,
    mappingFor,
    catalog
};
