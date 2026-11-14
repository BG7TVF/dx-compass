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
    transport: 'mqtt',
    fields: MQTT_FIELDS,
    controls: COMMON_CONTROLS,
    status: COMMON_STATUS
};

/** Elecraft KPA500：官方 Programmer's Reference 的 ASCII 命令，`;` 结尾。 */
const KPA500_FIELDS = [
    {key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100},
    {key: 'port', type: 'number', label: 'dev.config.port', min: 1, max: 65535, step: 1}
];

const KPA500_CONTROLS = [
    // 只开放面板上等效的常规操作；^PJ/^AL 等调整与阈值类命令刻意不出现。
    {action: 'power_on', label: 'dev.amp.powerOn', delta: {action: 'power_on'}, primary: true},
    {action: 'power_off', label: 'dev.amp.powerOff', delta: {action: 'power_off'}},
    {action: 'operate', label: 'dev.amp.operate', delta: {action: 'operate'}},
    {action: 'standby', label: 'dev.amp.standby', delta: {action: 'standby'}},
    {action: 'clear_fault', label: 'dev.amp.clearFault', delta: {action: 'clear_fault'}}
];

const KPA500_STATUS = [
    {key: 'power_on', kind: 'state', on: 'dev.amp.powerOn', off: 'dev.amp.powerOff', card: true},
    {key: 'operating', kind: 'state', on: 'dev.amp.operate', off: 'dev.amp.standby', card: true},
    {key: 'band', kind: 'band', card: true},
    {
        key: 'out_fwd_power', kind: 'metric', label: 'dev.amp.field.power',
        unit: 'W', digits: 0, card: true
    },
    {
        key: 'out_swr', kind: 'metric', label: 'dev.amp.field.swr',
        unit: '', digits: 2, card: true
    },
    {
        key: 'current_temperature', kind: 'metric', label: 'dev.amp.field.temp',
        unit: '°C', digits: 0, card: true
    },
    {
        key: 'current_voltage', kind: 'metric', label: 'dev.amp.field.voltage',
        unit: 'V', digits: 1
    },
    {
        key: 'current_current', kind: 'metric', label: 'dev.amp.field.current',
        unit: 'A', digits: 1
    },
    {key: 'alarm_active', kind: 'fault', label: 'dev.amp.fault', card: true},
    {key: 'firmware_version', kind: 'text', label: 'dev.amp.firmware'}
];

/**
 * KPA1500：官方 Programming Reference（rev 1.47）的只读状态集。
 * 本轮只做轮询回读，动作表留空；等状态在真机稳定后再开。
 */
const KPA1500_FIELDS = [
    {key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100},
    {
        key: 'port', type: 'number', label: 'dev.config.port',
        min: 1, max: 65535, step: 1, default: 1500
    }
];

const KPA1500_STATUS = [
    {key: 'operating', kind: 'state', on: 'dev.amp.operate', off: 'dev.amp.standby', card: true},
    {key: 'band', kind: 'band', card: true},
    {
        key: 'out_fwd_power', kind: 'metric', label: 'dev.amp.field.power',
        unit: 'W', digits: 0, card: true
    },
    {
        key: 'out_swr', kind: 'metric', label: 'dev.amp.field.swr',
        unit: '', digits: 2, card: true
    },
    {
        key: 'current_temperature', kind: 'metric', label: 'dev.amp.field.temp',
        unit: '°C', digits: 0, card: true
    },
    {
        key: 'current_voltage', kind: 'metric', label: 'dev.amp.field.voltage',
        unit: 'V', digits: 1
    },
    {
        key: 'current_current', kind: 'metric', label: 'dev.amp.field.current',
        unit: 'A', digits: 1
    },
    {
        key: 'fan_speed', kind: 'metric', label: 'dev.amp.field.fan',
        unit: '', digits: 0
    },
    {key: 'alarm_active', kind: 'fault', label: 'dev.amp.fault', card: true},
    {key: 'firmware_version', kind: 'text', label: 'dev.amp.firmware'}
];

/** ACOM：仓库 ACOM-Controller 的二进制遥测与三个常规动作。 */
const ACOM_FIELDS = [
    {key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100},
    {key: 'port', type: 'number', label: 'dev.config.port', min: 1, max: 65535, step: 1}
];

const ACOM_CONTROLS = [
    {action: 'operate', label: 'dev.amp.operate', delta: {action: 'operate'}, primary: true},
    {action: 'standby', label: 'dev.amp.standby', delta: {action: 'standby'}},
    // 仓库只有 Off 命令，没有串口开机命令，因此不提供 power_on。
    {action: 'power_off', label: 'dev.amp.powerOff', delta: {action: 'power_off'}}
];

const ACOM_STATUS = [
    {
        key: 'status_code', kind: 'enum', card: true,
        values: {
            1: 'dev.amp.state.reset',
            2: 'dev.amp.state.init',
            3: 'dev.amp.state.debug',
            4: 'dev.amp.state.service',
            5: 'dev.amp.standby',
            6: 'dev.amp.receive',
            7: 'dev.amp.transmit',
            9: 'dev.amp.state.system',
            10: 'dev.amp.powerOff'
        }
    },
    {key: 'band', kind: 'band', card: true},
    {
        key: 'out_fwd_power', kind: 'metric', label: 'dev.amp.field.power',
        unit: 'W', digits: 0, card: true
    },
    {
        key: 'out_swr', kind: 'metric', label: 'dev.amp.field.swr',
        unit: '', digits: 2, card: true
    },
    {
        key: 'current_temperature', kind: 'metric', label: 'dev.amp.field.temp',
        unit: '°C', digits: 0, card: true
    },
    {
        key: 'drive_power', kind: 'metric', label: 'dev.amp.field.drive',
        unit: 'W', digits: 0
    },
    {
        key: 'out_rev_power', kind: 'metric', label: 'dev.amp.field.rev',
        unit: 'W', digits: 0
    },
    {
        key: 'dc_power', kind: 'metric', label: 'dev.amp.field.dc',
        unit: 'W', digits: 0
    },
    {
        key: 'fan_state', kind: 'metric', label: 'dev.amp.field.fan',
        unit: '', digits: 0
    },
    {key: 'alarm_active', kind: 'fault', label: 'dev.amp.fault', card: true}
];

function acomModel(id, name, temperatureOffset) {
    return {
        id,
        name,
        protocol: 'serial',
        transport: 'acom-binary',
        supported: true,
        hint: 'dev.amp.serialHint',
        fields: ACOM_FIELDS,
        controls: ACOM_CONTROLS,
        status: ACOM_STATUS,
        // 仓库只按型号换算温度；协议帧结构完全一致。
        parser: {temperature_offset: temperatureOffset}
    };
}

const SPE_FIELDS = [
    {key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100},
    {key: 'port', type: 'number', label: 'dev.config.port', min: 1, max: 65535, step: 1}
];

/** SPE 状态串的共用显示项；2K-FA 额外有下层散热器与合成器温度。 */
function speStatus(extraTemps) {
    const items = [
        {key: 'operating', kind: 'state', on: 'dev.amp.operate', off: 'dev.amp.standby', card: true},
        {key: 'transmitting', kind: 'flag', when: 1, label: 'dev.amp.transmitting', card: true},
        {key: 'band', kind: 'band', card: true},
        {
            key: 'out_fwd_power', kind: 'metric', label: 'dev.amp.field.power',
            unit: 'W', digits: 0, card: true
        },
        {
            key: 'out_swr', kind: 'metric', label: 'dev.amp.field.swr',
            unit: '', digits: 2, card: true
        },
        {
            key: 'swr_atu', kind: 'metric', label: 'dev.amp.field.swrAtu',
            unit: '', digits: 2
        },
        {
            key: 'current_voltage', kind: 'metric', label: 'dev.amp.field.voltage',
            unit: 'V', digits: 1
        },
        {
            key: 'current_current', kind: 'metric', label: 'dev.amp.field.current',
            unit: 'A', digits: 1
        },
        {
            key: 'current_temperature', kind: 'metric', label: 'dev.amp.field.temp',
            unit: '°C', digits: 0, card: true
        }
    ];
    if (extraTemps) {
        items.push(
            {
                key: 'temp_lower', kind: 'metric', label: 'dev.amp.field.tempLower',
                unit: '°C', digits: 0
            },
            {
                key: 'temp_combiner', kind: 'metric', label: 'dev.amp.field.tempCombiner',
                unit: '°C', digits: 0
            }
        );
    }
    items.push({key: 'alarm_active', kind: 'fault', label: 'dev.amp.fault', card: true});
    return items;
}

function speModel(id, name, extraTemps) {
    return {
        id,
        name,
        protocol: 'serial',
        transport: 'spe-binary',
        supported: true,
        hint: 'dev.amp.serialHint',
        fields: SPE_FIELDS,
        // 本轮只读：先验证状态串稳定，动作表留空。
        controls: [],
        status: speStatus(extraTemps)
    };
}

/**
 * OM Power 2501A / 3501A / 4001A：rev.4 原生 TCP（XPort，默认 10001）。
 * 依据 github.com/grmi64/OM-Power-Control（MIT）的实际解析与命令表；
 * 动作只有仓库里真实存在的开机/关机、Operate/Standby 切换与自动调谐。
 */
const OM_FIELDS = [
    {key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100, required: true},
    {
        key: 'port', type: 'number', label: 'dev.config.port',
        min: 1, max: 65535, step: 1, default: 10001
    }
];

const OM_CONTROLS = [
    {action: 'power_on', label: 'dev.amp.powerOn', delta: {action: 'power_on'}, primary: true},
    {action: 'power_off', label: 'dev.amp.powerOff', delta: {action: 'power_off'}},
    {action: 'operate', label: 'dev.amp.operate', delta: {action: 'operate'}},
    {action: 'standby', label: 'dev.amp.standby', delta: {action: 'standby'}},
    {action: 'autotune', label: 'dev.amp.autotune', delta: {action: 'autotune'}}
];

const OM_STATUS = [
    {
        key: 'status_text', kind: 'enum', card: true,
        values: {
            Unknown: 'dev.amp.state.unknown',
            Off: 'dev.amp.powerOff',
            On: 'dev.amp.powerOn',
            Standby: 'dev.amp.standby',
            Operate: 'dev.amp.operate',
            'Warming up': 'dev.amp.state.warming',
            'Cooling down': 'dev.amp.state.cooling'
        }
    },
    {key: 'transmitting', kind: 'flag', when: true, label: 'dev.amp.transmitting', card: true},
    {key: 'antenna_name', kind: 'text', label: 'dev.amp.field.antenna', card: true},
    {key: 'work_freq', kind: 'freq', card: true},
    {
        key: 'out_fwd_power', kind: 'metric', label: 'dev.amp.field.power',
        unit: 'W', digits: 0, card: true
    },
    {
        key: 'out_swr', kind: 'metric', label: 'dev.amp.field.swr',
        unit: '', digits: 2, card: true
    },
    {
        key: 'out_rev_power', kind: 'metric', label: 'dev.amp.field.rev',
        unit: 'W', digits: 0
    },
    {
        key: 'drive_power', kind: 'metric', label: 'dev.amp.field.inputPower',
        unit: 'W', digits: 0
    },
    {
        key: 'plate_current', kind: 'metric', label: 'dev.amp.field.plateCurrent',
        unit: 'A', digits: 2
    },
    {
        key: 'plate_voltage', kind: 'metric', label: 'dev.amp.field.plateVoltage',
        unit: 'V', digits: 0
    },
    {
        key: 'screen_current', kind: 'metric', label: 'dev.amp.field.screenCurrent',
        unit: 'mA', digits: 0
    },
    {
        key: 'screen_voltage', kind: 'metric', label: 'dev.amp.field.screenVoltage',
        unit: 'V', digits: 0
    },
    {
        key: 'grid_a_voltage', kind: 'metric', label: 'dev.amp.field.gridA',
        unit: 'V', digits: 0
    },
    {
        key: 'grid_b_voltage', kind: 'metric', label: 'dev.amp.field.gridB',
        unit: 'V', digits: 0
    },
    {
        key: 'heater_a_voltage', kind: 'metric', label: 'dev.amp.field.heaterA',
        unit: 'V', digits: 1
    },
    {
        key: 'heater_b_voltage', kind: 'metric', label: 'dev.amp.field.heaterB',
        unit: 'V', digits: 1
    },
    {
        key: 'mains_voltage', kind: 'metric', label: 'dev.amp.field.mains',
        unit: 'V', digits: 0
    },
    {
        key: 'current_temperature', kind: 'metric', label: 'dev.amp.field.temp',
        unit: '°C', digits: 1, card: true
    }
];

function omModel(id, name) {
    return {
        id,
        name,
        protocol: 'tcp',
        transport: 'om-tcp',
        supported: true,
        fields: OM_FIELDS,
        controls: OM_CONTROLS,
        status: OM_STATUS
    };
}

/** RF-Kit RF2K-S：官方手册未公开 HTTP API，只按公开实现确认 /info 的身份字段。 */
const RFKIT_FIELDS = [
    {key: 'host', type: 'text', label: 'dev.config.host', maxlength: 100},
    {
        key: 'port', type: 'number', label: 'dev.config.port',
        min: 1, max: 65535, step: 1, default: 8080
    }
];

const RFKIT_STATUS = [
    {key: 'device_name', kind: 'text', label: 'dev.amp.field.deviceName', card: true},
    {key: 'device_model', kind: 'text', label: 'dev.amp.field.model'},
    {key: 'software_version', kind: 'text', label: 'dev.amp.firmware', card: true}
];

/**
 * 社区有实践、但本阶段没有可靠公开命令表的型号：只留记录，下拉中禁选。
 * 不凭猜测补协议，也不把它们的逆向命令写进传输层。
 */
function record(id, name, evidence) {
    return {id, name, supported: false, protocol: null, transport: null, fields: [], controls: [], status: [], evidence};
}

const BRANDS = [
    {
        id: 'guohe',
        name: '国赫',
        models: [
            {
                id: 'amp1000',
                name: 'AMP1000',
                protocol: 'mqtt',
                transport: 'mqtt',
                supported: true,
                fields: MQTT_FIELDS,
                controls: COMMON_CONTROLS,
                status: COMMON_STATUS
            }
        ]
    },
    {
        id: 'elecraft',
        name: 'Elecraft',
        models: [
            {
                id: 'kpa500',
                name: 'KPA500',
                protocol: 'serial',
                transport: 'elecraft-ascii',
                supported: true,
                hint: 'dev.amp.serialHint',
                fields: KPA500_FIELDS,
                controls: KPA500_CONTROLS,
                status: KPA500_STATUS
            },
            {
                id: 'kpa1500',
                name: 'KPA1500',
                protocol: 'serial',
                transport: 'elecraft-ascii',
                supported: true,
                hint: 'dev.amp.serialHint',
                fields: KPA1500_FIELDS,
                // 只读阶段：不暴露任何动作，commands.js 会直接拒绝 amp_set。
                controls: [],
                status: KPA1500_STATUS,
                parser: {
                    poll: ['^OS;', '^BN;', '^WS;', '^TM;', '^VI;', '^FS;', '^FL;', '^RVM;'],
                    // KPA1500 的 ^VI 返回整安，KPA500 是十分之一安。
                    current_divisor: 1
                }
            }
        ]
    },
    {
        id: 'spe',
        name: 'SPE',
        models: [
            // 协议来自 SPE 官方 Application Programmer's Guide Rev 1.1：
            // 1.3K / 1.5K / 2K 共用状态串，只有 2K 的下层与合成器温度有效。
            speModel('expert-13k', 'Expert 1.3K-FA', false),
            speModel('expert-15k', 'Expert 1.5K-FA', false),
            speModel('expert-2k', 'Expert 2K-FA', true)
        ]
    },
    {
        id: 'acom',
        name: 'ACOM',
        models: [
            // 协议帧一致，差异只在铭牌功率与温度换算偏移（来自 ACOM-Controller）。
            acomModel('500s', '500S', 282),
            acomModel('600s', '600S', 273),
            acomModel('700s', '700S', 282),
            acomModel('1200s', '1200S', 281),
            acomModel('2020s', '2020S', 282)
        ]
    },
    {
        id: 'palstar',
        name: 'Palstar',
        models: [
            record('la-1k', 'LA-1K（仅 Kenwood 频率跟随）',
                'wo2x LA-1K flow; Kenwood/Icom band port + RS-232. The amplifier only follows the ' +
                'exciter frequency; no independent status readback (power/SWR/temperature unavailable)')
        ]
    },
    {
        id: 'rfkit',
        name: 'RF-Kit',
        models: [
            {
                id: 'rf2k-s',
                name: 'RF2K-S / RF2K+',
                protocol: 'http',
                transport: 'rfkit-http',
                supported: true,
                fields: RFKIT_FIELDS,
                // 官方手册没有可读功率/驻波的 HTTP 接口，只做身份与版本。
                controls: [],
                status: RFKIT_STATUS
            }
        ]
    },
    {
        id: 'ompower',
        name: 'OM Power',
        models: [
            // rev.4（固件 ≥3.16）只覆盖这三型；证据见 docs/rf-component-spec.md §15。
            omModel('2501a', 'OM2501A'),
            omModel('3501a', 'OM3501A'),
            omModel('4001a', 'OM4001A'),
            record('2500a', '2500A（无协议依据，暂不支持）',
                'grmi64/OM-Power-Control (MIT) rev.4 covers 2501A/3501A/4001A (firmware >=3.16) only. ' +
                'The 2500A rear panel exposes only a REMOTE analog port and a TCVR CAT input; no capture ' +
                'or vendor document shows this TCP protocol on the 2500A. Kept unsupported until a real ' +
                'unit is captured')
        ]
    },
    {
        id: 'flexradio',
        name: 'FlexRadio',
        models: [
            record('powergenius-xl', 'PowerGenius XL',
                'Scott Dupuie and others integrate through Flex/SmartSDR ecosystem')
        ]
    },
    {
        id: 'mercury',
        name: 'Mercury',
        models: [
            record('lux', 'LUX',
                'Multiple reverse-engineering attempts; no command structure found, panel-only')
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
        for (const model of brand.models) {
            if (model.supported !== false && model.protocol) seen.add(model.protocol);
        }
    }
    return [...seen];
}

function supported(definition) {
    return !!definition && definition.supported !== false;
}

/** 传输实现由型号决定；未知/未选型号退回 MQTT 兼容路径。 */
function transportOf(config) {
    const source = config && typeof config === 'object' ? config : {};
    const definition = resolve(source.brand, source.model);
    return (definition && definition.transport) || GENERIC.transport;
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
    supported,
    transportOf,
    protocols,
    catalog
};
