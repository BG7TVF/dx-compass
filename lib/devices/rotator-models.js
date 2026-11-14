'use strict';

/**
 * 旋转器型号描述表。
 *
 * 与功放型号表同一套结构：型号决定协议、地址字段与可控制项。
 * 新增型号只加一条定义，不在传输层按品牌写分支。
 *
 * 协议只有两种，都有公开依据：
 *   rotctld  Hamlib 标准代理（TCP 4533，p / P az el / S），覆盖绝大多数品牌；
 *   gs232    Yaesu GS-232 文本（C2 查询、Mxxx 转向、S 停止）。
 *
 * 明确不做：Yaesu 二进制、AlfaSpid 私有文本、Green Heron DCU-1、PST Rotator UDP。
 * 依据见 docs/rf-component-spec.md §15。
 */

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

const HOST_FIELD = {
    key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100, required: true
};

const PORT_FIELD = {
    key: 'port', type: 'number', label: 'dev.config.port', min: 1, max: 65535, step: 1
};

const CONTROLS = [
    {action: 'rotate', label: 'dev.control.rotate'},
    {action: 'stop', label: 'dev.control.stop'}
];

function fieldsFor(protocol) {
    const port = Object.assign({}, PORT_FIELD);
    if (protocol === 'rotctld') port.default = 4533;
    return [HOST_FIELD, port];
}

function model(id, name, protocols, defaultProtocol, hint) {
    return {
        id,
        name,
        protocol: defaultProtocol,
        protocols,
        supported: true,
        hint,
        fields: fieldsFor(defaultProtocol),
        controls: CONTROLS,
        // 方位限位：0–359.999；转向超时使用设备属性 travel_timeout_sec。
        limits: {azimuth: [0, 360]}
    };
}

function gs232(id, name) {
    return model(id, name, ['gs232', 'rotctld'], 'gs232', 'dev.config.rotatorGs232Hint');
}

function proxy(id, name) {
    return model(id, name, ['rotctld'], 'rotctld', 'dev.config.rotatorProxyHint');
}

const BRANDS = [
    {
        id: 'yaesu',
        name: 'Yaesu',
        models: [
            // GS-232A/B 选件；也可经 rotctld 使用 Hamlib 的 Yaesu 后端。
            gs232('g-800dxa', 'G-800DXA'),
            gs232('g-1000dxa', 'G-1000DXA'),
            gs232('g-2800dxa', 'G-2800DXA'),
            gs232('g-450a', 'G-450A / G-650A')
        ]
    },
    {
        id: 'k3ng',
        name: 'K3NG',
        models: [
            gs232('gs232', 'Arduino（GS-232 模拟）')
        ]
    },
    {
        id: 'greenheron',
        name: 'Green Heron',
        models: [
            proxy('rt-21', 'RT-21')
        ]
    },
    {
        id: 'm2',
        name: 'M2',
        models: [
            proxy('orion-2800', 'Orion 2800')
        ]
    },
    {
        id: 'prosistel',
        name: 'Prosistel',
        models: [
            proxy('d', 'D 系列'),
            proxy('pro', 'PRO 系列')
        ]
    },
    {
        id: 'alfaspid',
        name: 'AlfaSpid',
        models: [
            proxy('ras', 'RAK / RAS')
        ]
    },
    {
        id: 'hygain',
        name: 'Hy-Gain',
        models: [
            proxy('ham-iv', 'HAM IV'),
            proxy('t2x', 'T2X')
        ]
    },
    {
        id: 'erc',
        name: 'ERC',
        models: [
            proxy('erc-4', 'ERC-4')
        ]
    }
];

const GENERIC = {
    id: 'generic',
    name: '通用',
    protocol: 'rotctld',
    protocols: ['rotctld', 'gs232'],
    supported: true,
    fields: [HOST_FIELD, PORT_FIELD],
    controls: CONTROLS,
    limits: {azimuth: [0, 360]}
};

function brandById(brandId) {
    const id = text(brandId);
    if (!id) return null;
    return BRANDS.find(brand => brand.id === id) || null;
}

function resolve(brandId, modelId) {
    const brand = brandById(brandId);
    const id = text(modelId);
    if (!brand || !id || id === 'other') return null;
    return brand.models.find(item => item.id === id) || null;
}

function supported(definition) {
    return !!(definition && definition.supported !== false && definition.protocol);
}

/** 型号允许的协议集合；未选型号时两种都允许，默认 rotctld。 */
function protocolsOf(config) {
    const definition = resolve(config && config.brand, config && config.model);
    if (definition) return definition.protocols || [definition.protocol];
    return GENERIC.protocols;
}

/** 实际使用的协议：显式选择优先，否则用型号默认值。 */
function transportOf(config) {
    const source = config || {};
    const definition = resolve(source.brand, source.model);
    const allowed = definition ? (definition.protocols || [definition.protocol]) : GENERIC.protocols;
    const protocol = text(source.protocol).toLowerCase();
    if (protocol && allowed.includes(protocol)) return protocol;
    return definition ? definition.protocol : GENERIC.protocol;
}

function protocols() {
    const list = new Set(GENERIC.protocols);
    for (const brand of BRANDS) {
        for (const item of brand.models) {
            for (const protocol of item.protocols || [item.protocol]) list.add(protocol);
        }
    }
    return [...list];
}

function catalog() {
    return {
        brands: BRANDS.map(brand => ({
            id: brand.id,
            name: brand.name,
            models: brand.models.map(item => ({
                id: item.id,
                name: item.name,
                protocol: item.protocol,
                protocols: item.protocols,
                supported: item.supported,
                hint: item.hint,
                fields: item.fields,
                controls: item.controls,
                limits: item.limits
            }))
        })),
        generic: GENERIC
    };
}

module.exports = {
    GENERIC,
    brandById,
    resolve,
    supported,
    protocolsOf,
    transportOf,
    protocols,
    catalog
};
