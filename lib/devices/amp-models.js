'use strict';

/**
 * 功放品牌 / 型号描述表（唯一数据源）。
 *
 * 这里集中定义每个型号真正需要的东西：协议、属性面板字段（含单位、取值范围、
 * 选项与默认值）、可控制的按钮与下发 delta、以及状态回读项的显示映射。
 * 前端只按这张表渲染，不再把型号差异写死在页面里；新增型号只需要加一条定义。
 *
 * 明确约束：与校准/工程参数相关的指令不在此表中出现，也不可能通过本表下发。
 */

/** 属性字段：type 决定控件，数字字段的 min/max/step 就是设备允许的取值范围。 */
const MQTT_FIELDS = [
    {key: 'host', type: 'text', label: 'dev.config.brokerHost', maxlength: 100, required: true},
    {
        key: 'port', type: 'number', label: 'dev.config.port',
        min: 1, max: 65535, step: 1, default: 1883
    },
    {key: 'device_id', type: 'text', label: 'dev.config.deviceId', maxlength: 100, required: true},
    {
        key: 'topic_prefix', type: 'text', label: 'dev.config.topicPrefix',
        maxlength: 200, default: 'amplifier/device'
    },
    {key: 'username', type: 'text', label: 'dev.config.username', maxlength: 100, autocomplete: 'off'},
    {
        key: 'password', type: 'password', label: 'dev.config.password',
        maxlength: 200, placeholder: 'dev.config.keepPassword'
    }
];

const COMMON_CONTROLS = [
    {action: 'pa_on', label: 'dev.amp.paOn', delta: {pa_switch: 1}, primary: true},
    {action: 'pa_off', label: 'dev.amp.paOff', delta: {pa_switch: 0}},
    {action: 'tune_on', label: 'dev.amp.tuneOn', delta: {tune_mode: 1}},
    {action: 'tune_off', label: 'dev.amp.tuneOff', delta: {tune_mode: 0}},
    {action: 'clear_alarm', label: 'dev.amp.clearAlarm', delta: {clear_alarm: true}}
];

/**
 * 状态回读映射：kind 决定怎么读、怎么显示。
 *   metric  → 数值 + 单位（digits 为小数位）
 *   freq    → Hz 转 MHz
 *   state   → 1/0 映射到 on/off 文案
 *   flag    → 等于 when 时显示 label
 *   alarm   → 告警字非零时显示十六进制码
 * card 表示设备卡片上也显示这一项。
 */
const COMMON_STATUS = [
    {key: 'pa_switch', kind: 'state', on: 'dev.amp.paOn', off: 'dev.amp.paOff', card: true},
    {key: 'work_freq', kind: 'freq', card: true},
    {key: 'band', kind: 'band'},
    {key: 'tune_mode', kind: 'state', on: 'dev.amp.tuneOn', off: 'dev.amp.tuneOff'},
    {key: 'ptt_status', kind: 'flag', when: 1, label: 'dev.amp.transmitting', card: true},
    {
        key: 'out_fwd_power', kind: 'metric', label: 'dev.amp.field.power',
        unit: 'W', digits: 1, card: true
    },
    {
        key: 'out_swr', kind: 'metric', label: 'dev.amp.field.swr',
        unit: '', digits: 2, card: true
    },
    {
        key: 'current_temperature', kind: 'metric', label: 'dev.amp.field.temp',
        unit: '°C', digits: 1, card: true
    },
    {
        key: 'current_voltage', kind: 'metric', label: 'dev.amp.field.voltage',
        unit: 'V', digits: 1
    },
    {
        key: 'current_current', kind: 'metric', label: 'dev.amp.field.current',
        unit: 'A', digits: 2
    },
    {key: 'alarm_active', kind: 'alarm', label: 'dev.amp.alarm', card: true}
];

/** 型号未选 / 选了「其他」：沿用现有可手工填写的 MQTT 方式。 */
const GENERIC = {
    id: 'other',
    name: 'dev.config.modelOther',
    protocol: 'mqtt',
    fields: MQTT_FIELDS,
    controls: COMMON_CONTROLS,
    status: COMMON_STATUS
};

const BRANDS = [
    {
        id: 'guohe',
        name: '国赫',
        models: [
            {
                id: 'amp1000',
                name: 'AMP1000',
                protocol: 'mqtt',
                fields: MQTT_FIELDS,
                controls: COMMON_CONTROLS,
                status: COMMON_STATUS
            }
        ]
    }
];

function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
}

function brandById(id) {
    const key = text(id);
    if (!key) return null;
    return BRANDS.find(brand => brand.id === key) || null;
}

/** 先按品牌定位型号；没有品牌时在全表里找，兼容只存型号的旧配置。 */
function resolve(brandId, modelId) {
    const model = text(modelId);
    if (!model || model === 'other') return null;
    const brand = brandById(brandId);
    if (brand) return brand.models.find(item => item.id === model) || null;
    for (const item of BRANDS) {
        const found = item.models.find(modelItem => modelItem.id === model);
        if (found) return found;
    }
    return null;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** 描述表里出现过的协议集合：新增品牌/型号时不需要再改别处的白名单。 */
function protocols() {
    const seen = new Set([GENERIC.protocol]);
    for (const brand of BRANDS) {
        for (const model of brand.models) seen.add(model.protocol);
    }
    return [...seen];
}

/** 给前端的完整描述表：品牌/型号/通用兜底，全部是纯数据。 */
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
    protocols,
    catalog
};
