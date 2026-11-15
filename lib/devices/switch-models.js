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
                defaults: {in_count: 4, out_count: 8},
                fields: [HOST_FIELD, portField(50333), SWITCH_ID_FIELD, RADIO_FIELD],
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
                protocol: 'amplitec-serial',
                transport: 'amplitec-serial',
                readback: true,
                // 调研只确认了读类型/读状态帧，没有确认切换命令：只回读，不下发。
                control: false,
                defaults: {out_count: 6},
                fields: [HOST_FIELD, portField()],
                hint: 'dev.switch.readOnlyHint'
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
                defaults: {out_count: 4},
                fields: [HOST_FIELD, portField(8080)],
                hint: 'dev.switch.writeOnlyHint'
            }),
            model({
                id: 'stack-match',
                name: 'Stack Match',
                type: 'switch',
                supported: false,
                control: false,
                readback: false,
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

function defaultPortCounts(type, config) {
    const definition = resolve(type, config && config.brand, config && config.model);
    const source = definition ? definition.defaults : (GENERIC[text(type).toLowerCase()] || {}).defaults;
    return Object.assign({}, source || {});
}

/**
 * 天线 ↔ 波段映射，单一真相：
 *   设备回读存在就只用设备数据；否则才用本地配置；都没有返回 none。
 * 不做两份数据合并。
 */
function mappingFor(device, entry) {
    const config = device && device.config && typeof device.config === 'object' ? device.config : {};
    const state = entry && entry.switch && typeof entry.switch === 'object' ? entry.switch : entry;
    const antennas = state && Array.isArray(state.antennas) ? state.antennas : [];
    const bands = state && Array.isArray(state.bands) ? state.bands : [];
    if (antennas.length) {
        return {
            source: 'device',
            bands,
            antennas: antennas.map(item => ({
                index: item.index,
                name: text(item.name),
                bands: Array.isArray(item.bands) ? item.bands.slice() : []
            }))
        };
    }
    const local = config.antenna_bands;
    if (local && typeof local === 'object' && !Array.isArray(local)) {
        const list = Object.keys(local)
            .filter(key => /^\d{1,2}$/.test(key))
            .sort((a, b) => Number(a) - Number(b))
            .map(key => ({
                index: Number(key),
                name: '',
                bands: Array.isArray(local[key]) ? local[key].map(text).filter(Boolean) : []
            }));
        if (list.length) return {source: 'local', bands: [], antennas: list};
    }
    return {source: 'none', bands: [], antennas: []};
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
    defaultPortCounts,
    mappingFor,
    catalog
};
