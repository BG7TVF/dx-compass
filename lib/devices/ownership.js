'use strict';

/**
 * 席位与天线的归属投影（只计算，不写回）。
 *
 * 归属不是静态绑定：它由“席位当前波段 + 天线波段 + 席位是否在线”派生。
 * 席位心跳 = N1MM 上行报文（经 relay）；60 秒收不到就判定离线，
 * 离线席位不再占用任何天线，天线立刻回到空闲（绿）。
 *
 * 电台属于哪个席位由设备属性里的 seat 编号直接绑定（多台同号即共用一席）；
 * seatPlan 据此派生连续的席位列表，并实时上报（N1MM）回填每席的波段与在线状态。
 * 天线归属仍按 live seat 键（station:nr）投影，project 口径不变。
 *
 * 灯色相对当前席位：红 = 本席可达；黄 = 他席可达；绿 = 无人可达。
 *
 * 同一套连线还派生“本席位链路上的功放”（by_seat[seat].amps）：
 * 功放属于谁不靠手工绑定，只看射频同轴从这台电台走出去能穿过哪些功放；
 * 走到选择未知的共享切换器就停住，绝不越过它去认领邻座的功放。
 * 没有电台节点或没有任何 RF 连线时投影给不出结论，amps 为 null，
 * 由界面自己决定退回什么，而不是假装“这条链路上没有功放”。
 */

const seatModel = require('../radio/bands.js');
const rf = require('./rf.js');
const {actualAzimuth} = require('./model.js');

const SEAT_HEARTBEAT_TIMEOUT_MS = 60000;
const UNIDENTIFIED = 'UNIDENTIFIED';
// 席位号上限：与 model.js 电台 config.seat 校验一致。
const SEAT_PLAN_MAX = 99;

function toMs(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function isUnidentified(key) {
    return key === UNIDENTIFIED || String(key).startsWith(UNIDENTIFIED + ':');
}

function bandOfRadio(radio) {
    const raw = radio && radio.band;
    if (raw) return String(raw).toLowerCase();
    const freq = Number(radio && radio.freqKhz);
    return Number.isFinite(freq) ? (seatModel.bandOf(freq) || '') : '';
}

function seatViews(radioStates, nowMs, heartbeatTimeoutMs) {
    const map = radioStates && typeof radioStates === 'object' ? radioStates : {};
    return Object.keys(map).sort().map(key => {
        const radio = map[key] || {};
        const lastSeen = toMs(radio.ts);
        const age = lastSeen === null ? null : nowMs - lastSeen;
        const online = age !== null && age <= heartbeatTimeoutMs && age >= -5000;
        return {
            seat: key,
            band: bandOfRadio(radio),
            online,
            last_seen: radio.ts || null,
            age_ms: age === null ? null : Math.max(0, age),
            operator: radio.opCall || '',
            radio_nr: radio.radioNr || '',
            station_name: radio.stationName || '',
            computer_name: radio.computerName || '',
            radio_name: radio.radioName || ''
        };
    }).filter(view => !isUnidentified(view.seat));
}

function norm(value) {
    return String(value === undefined || value === null ? '' : value)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/**
 * 电台节点 → 席位键。
 * 依据设备属性里的计算机标识（ComputerName 或 StationName）与电台型号，
 * 与实时上报记录逐项匹配；两项都为空则不归属任何席位（宁可显式未绑定，也不猜）。
 */
function seatForRadio(radio, seats) {
    const config = radio && radio.config && typeof radio.config === 'object' ? radio.config : {};
    const computer = norm(config.computer);
    const model = norm(config.model);
    if (!computer && !model) return '';
    const hit = (seats || []).find(view => {
        if (computer) {
            const names = [norm(view.computer_name), norm(view.station_name)].filter(Boolean);
            if (!names.includes(computer)) return false;
        }
        if (model && norm(view.radio_name) !== model) return false;
        return true;
    });
    return hit ? hit.seat : '';
}

function colorFor(owners, seat) {
    const list = Array.isArray(owners) ? owners : [];
    if (seat && list.includes(seat)) return 'red';
    return list.length ? 'yellow' : 'green';
}

function rotatorAzimuthFor(devices, antenna, rotatorAzimuths) {
    const byId = new Map((devices || []).map(device => [device.id, device]));
    const seen = new Set([antenna.id]);
    let cursor = antenna.parent_id || null;
    while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const node = byId.get(cursor);
        if (!node) break;
        if (node.type === 'rotator') {
            const raw = rotatorAzimuths && rotatorAzimuths[node.id];
            return {rotator_id: node.id, physical: Number.isFinite(Number(raw)) ? Number(raw) : null};
        }
        cursor = node.parent_id || null;
    }
    return {rotator_id: null, physical: null};
}

/**
 * @param {object} input
 * @param {Array} input.devices 全部设备
 * @param {object} input.radioStates global.radioStates
 * @param {Date} input.now
 * @param {number} [input.heartbeatTimeoutMs]
 * @param {object} [input.rotatorAzimuths] {rotatorId: physical_azimuth}
 */
function project(input) {
    const opts = input || {};
    const at = opts.now instanceof Date ? opts.now : new Date(opts.now === undefined ? Date.now() : opts.now);
    const nowMs = at.getTime();
    const timeout = Number.isFinite(Number(opts.heartbeatTimeoutMs))
        ? Number(opts.heartbeatTimeoutMs) : SEAT_HEARTBEAT_TIMEOUT_MS;
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const links = Array.isArray(opts.links) ? opts.links : [];
    const selections = opts.selections && typeof opts.selections === 'object' ? opts.selections : {};
    /* 天线切换看的是“操作员要把哪一路接通”：设备没有读回时，
     * 已经下发的通路（commanded）照样参与归属，否则共享矩阵永远切不动。
     * 互锁不看这里，只看设备回读确认的通路。 */
    const intent = opts.intentSelections && typeof opts.intentSelections === 'object'
        ? opts.intentSelections : selections;
    const seats = seatViews(opts.radioStates, nowMs, timeout);
    const onlineSeats = seats.filter(view => view.online && view.band);
    const antennas = devices.filter(device => device && device.type === 'antenna');
    const radios = devices.filter(device => device && device.type === 'radio');
    const deviceById = new Map(devices.filter(device => device && device.id).map(device => [device.id, device]));

    // 配置了电台节点与 RF 连线的席位走链路可达；否则逐席位回退到旧的波段匹配。
    const reach = new Map();
    const ampReach = new Map();
    const topoReach = new Map();
    const routedReach = new Map();
    const confirmedReach = new Map();
    const boundRadios = new Map();
    for (const view of seats) {
        const bound = radios.filter(radio => seatForRadio(radio, seats) === view.seat);
        boundRadios.set(view.seat, bound);
        if (!bound.length || !links.length) continue;
        const set = new Set();
        if (view.band) {
            for (const radio of bound) {
                for (const hit of rf.reachableAntennas({
                    devices,
                    links,
                    selections,
                    startDeviceId: radio.id,
                    band: view.band
                })) {
                    set.add(hit.device.id);
                }
            }
        }
        reach.set(view.seat, set);
        /* 功放归属看的是同轴走线，不是当前波段是否已配好天线：从本席位的
         * 电台出发沿 TX 方向走这条链路，只留功放。
         * 这里刻意不用 txLockPorts：那是互锁口径，切换器/矩阵选择未知时
         * 铺满全部端口（宁可多锁），于是会跨过共享矩阵倒着把邻座的功放
         * 认领成本席位在用。归属要求唯一，链路走到选择未知的多输出切换器
         * 就停住——越过它之后这台功放归谁都说不准，不如不认。
         * 功放自己声明了波段却不覆盖当前波段的，不算这条链路在用。 */
        const amps = new Set();
        for (const radio of bound) {
            const chain = rf.chainDevices({devices, links, selections, startDeviceId: radio.id});
            for (const id of chain) {
                const device = deviceById.get(id);
                if (!device || String(device.type || '').toLowerCase() !== 'amp') continue;
                if (!rf.deviceAllowsBand(device, view.band)) continue;
                amps.add(device.id);
            }
        }
        ampReach.set(view.seat, amps);

        /* 天线切换容器一次算出三个集合，口径各管一件事：
         *   物理可达 = 忽略切换器当前指向、也不按波段筛，同轴接得到就算，
         *              这就是能点的那些按钮；
         *   已接通   = 按“回读确认 ∪ 已下发”的通路走一遍、不筛波段，
         *              这一路归本席位，别的席位据此显示黄色；
         *   已确认   = 只看设备回读确认的通路，用来告诉界面
         *              “接通是命令推出来的，还没被硬件证实”。 */
        const topo = new Set();
        const routed = new Set();
        const confirmed = new Set();
        for (const radio of bound) {
            for (const hit of rf.reachableAntennas({
                devices, links, startDeviceId: radio.id, topology: true
            })) topo.add(hit.device.id);
            for (const hit of rf.reachableAntennas({
                devices, links, startDeviceId: radio.id, selections: intent
            })) routed.add(hit.device.id);
            for (const hit of rf.reachableAntennas({
                devices, links, startDeviceId: radio.id, selections
            })) confirmed.add(hit.device.id);
        }
        topoReach.set(view.seat, topo);
        routedReach.set(view.seat, routed);
        confirmedReach.set(view.seat, confirmed);
    }

    const ownersOf = antenna => onlineSeats.filter(view => {
        const reachable = reach.get(view.seat);
        if (reachable) return reachable.has(antenna.id);
        const bands = (antenna.bands || []).map(band => String(band).toLowerCase());
        return bands.includes(view.band);
    }).map(view => view.seat);

    const routedOwnersOf = antenna => onlineSeats.filter(view => {
        const routed = routedReach.get(view.seat);
        return !!routed && routed.has(antenna.id);
    }).map(view => view.seat);

    const antennaViews = antennas.map(antenna => {
        const bands = (antenna.bands || []).map(band => String(band).toLowerCase());
        const owners = ownersOf(antenna);
        const rotator = rotatorAzimuthFor(devices, antenna, opts.rotatorAzimuths || {});
        const actual = rotator.physical === null || rotator.physical === undefined
            ? null
            : actualAzimuth(rotator.physical, antenna.install_offset_deg || 0);
        const colors = {};
        for (const view of seats) {
            colors[view.seat] = colorFor(owners, view.seat);
        }
        /* 天线切换按钮的配色：谁把通路切到这天线上就是它的占用者，
         * 判色规则与波段占用完全一致（红=本席、黄=他席、绿=无人），
         * 差别只在“可达”换成了“已接通”。 */
        const routedBy = routedOwnersOf(antenna);
        const switchColors = {};
        for (const view of seats) {
            switchColors[view.seat] = colorFor(routedBy, view.seat);
        }
        return {
            id: antenna.id,
            name: antenna.name,
            bands,
            /* 优先天线（天线属性里的开关）：频率联动在同频段有多副可选天线时按它裁决。 */
            preferred: !!(antenna.config && antenna.config.preferred === true),
            owners,
            color_by_seat: colors,
            routed_by: routedBy,
            switch_color_by_seat: switchColors,
            rotator_id: rotator.rotator_id,
            install_offset_deg: antenna.install_offset_deg || 0,
            physical_azimuth: rotator.physical,
            actual_azimuth: actual
        };
    });

    const bySeat = {};
    for (const view of seats) {
        const colors = {};
        const assigned = [];
        for (const antenna of antennaViews) {
            const color = antenna.color_by_seat[view.seat] || 'green';
            colors[antenna.id] = color;
            if (color === 'red') assigned.push(antenna.id);
        }
        const reachable = reach.get(view.seat);
        const candidates = reachable
            ? antennaViews.filter(antenna => reachable.has(antenna.id)).map(antenna => antenna.id)
            : (view.band
                ? antennaViews.filter(antenna => antenna.bands.includes(view.band)).map(antenna => antenna.id)
                : []);
        /* 天线切换面板的数据源。reachable=null 表示投影给不出结论
         * （席位没绑电台节点、或整张图没有 RF 连线），界面据此退回提示，
         * 而不是假装“这个席位一副天线都接不到”。
         * unconfirmed=通路只来自下发的命令，设备还没有回读证实。 */
        const topoSet = topoReach.get(view.seat);
        const routedSet = routedReach.get(view.seat);
        const confirmedSet = confirmedReach.get(view.seat);
        const sortIds = set => antennaViews
            .filter(antenna => set.has(antenna.id))
            .map(antenna => antenna.id)
            .sort((a, b) => String(a).localeCompare(String(b)));
        bySeat[view.seat] = {
            seat: view.seat,
            band: view.band,
            online: view.online,
            last_seen: view.last_seen,
            age_ms: view.age_ms,
            source: reachable ? 'rf' : 'band-fallback',
            radios: (boundRadios.get(view.seat) || []).map(radio => radio.id),
            // 本席位链路上的功放；null = 投影无结论（未配电台节点或没有 RF 连线）。
            amps: ampReach.has(view.seat)
                ? [...ampReach.get(view.seat)].sort((a, b) => String(a).localeCompare(String(b)))
                : null,
            colors,
            ant_switch: topoSet ? {
                reachable: sortIds(topoSet),
                routed: routedSet ? sortIds(routedSet) : [],
                confirmed: confirmedSet ? sortIds(confirmedSet) : [],
                unconfirmed: !!routedSet && routedSet.size > 0
                    && (!confirmedSet || confirmedSet.size === 0)
            } : null,
            assigned,
            candidates,
            // 该波段没有配置任何天线：保持无归属，界面明确提示。
            unassigned: !!view.band && candidates.length === 0,
            // 仅旧回退模式下有“多副天线覆盖同一波段”的提示意义；RF 可达是操作员自己的集合。
            ambiguous: !reachable && candidates.length > 1
        };
    }

    return {
        heartbeat_timeout_ms: timeout,
        seats,
        antennas: antennaViews,
        by_seat: bySeat
    };
}

/**
 * 席位号归一：只接受 1..SEAT_PLAN_MAX 的整数，其余（含空值、非法）返回 null（未绑定）。
 */
function seatNumber(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > SEAT_PLAN_MAX) return null;
    return n;
}

/**
 * 席位计划：按电台设备属性里的 seat 编号归组，派生连续的席位列表。
 *
 * 规则（对应需求「席位数根据电台数量生成」）：
 *   - 电台在属性里绑定席位号（config.seat），多台同号 = 共用一席；
 *   - 未绑席位号的电台按「最小未用号」自动新建席位，于是有未绑定电台就多一席；
 *   - 席位只在这些号被电台用到时存在，没电台占用的空号自然消失 = 自动删除空白席位。
 *
 * 每个席位再用既有匹配（seatForRadio：ComputerName/StationName + 电台型号）
 * 找到它对应的实时上报键（live seat 键），任一在线即在线，波段/操作员/电台号取首个有值者。
 *
 * @param {object} input {devices, radioStates?, seats?, now?, heartbeatTimeoutMs?}
 * @returns {{seats: Array, key_to_no: object, radio_to_no: object}}
 */
function seatPlan(input) {
    const opts = input || {};
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const at = opts.now instanceof Date ? opts.now : new Date(opts.now === undefined ? Date.now() : opts.now);
    const nowMs = at.getTime();
    const timeout = Number.isFinite(Number(opts.heartbeatTimeoutMs))
        ? Number(opts.heartbeatTimeoutMs) : SEAT_HEARTBEAT_TIMEOUT_MS;
    const liveSeats = Array.isArray(opts.seats)
        ? opts.seats : seatViews(opts.radioStates, nowMs, timeout);
    const liveByKey = new Map(liveSeats.map(view => [view.seat, view]));
    const radios = devices
        .filter(device => device && device.type === 'radio')
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)));

    const groups = new Map(); // no -> {radio_ids, keys}
    const usedNos = new Set();
    const unbound = [];
    for (const radio of radios) {
        const config = radio.config && typeof radio.config === 'object' ? radio.config : {};
        const no = seatNumber(config.seat);
        if (no === null) {
            unbound.push(radio);
            continue;
        }
        if (!groups.has(no)) groups.set(no, {radio_ids: [], keys: []});
        const group = groups.get(no);
        group.radio_ids.push(radio.id);
        const key = seatForRadio(radio, liveSeats);
        if (key && !group.keys.includes(key)) group.keys.push(key);
        usedNos.add(no);
    }
    // 未绑席位号的电台：依次取最小未用号，自动新建席位。
    for (const radio of unbound) {
        let no = 1;
        while (usedNos.has(no)) no++;
        usedNos.add(no);
        const group = {radio_ids: [radio.id], keys: []};
        const key = seatForRadio(radio, liveSeats);
        if (key) group.keys.push(key);
        groups.set(no, group);
    }

    const seats = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([no, group]) => {
        const views = group.keys.map(key => liveByKey.get(key)).filter(Boolean);
        let band = '';
        let operator = '';
        let radio_nr = '';
        let station_name = '';
        let computer_name = '';
        let radio_name = '';
        let online = false;
        let lastSeenMs = null;
        for (const view of views) {
            if (view.online) online = true;
            if (!band && view.band) band = view.band;
            if (!operator && view.operator) operator = view.operator;
            if (!radio_nr && view.radio_nr) radio_nr = view.radio_nr;
            if (!station_name && view.station_name) station_name = view.station_name;
            if (!computer_name && view.computer_name) computer_name = view.computer_name;
            if (!radio_name && view.radio_name) radio_name = view.radio_name;
            const seen = toMs(view.last_seen);
            if (seen !== null && (lastSeenMs === null || seen > lastSeenMs)) lastSeenMs = seen;
        }
        return {
            no,
            radio_ids: group.radio_ids,
            keys: group.keys,
            online,
            band,
            operator,
            radio_nr,
            station_name,
            computer_name,
            radio_name,
            last_seen: lastSeenMs === null ? null : new Date(lastSeenMs).toISOString(),
            age_ms: lastSeenMs === null ? null : Math.max(0, nowMs - lastSeenMs)
        };
    });

    const keyToNo = {};
    const radioToNo = {};
    for (const seat of seats) {
        for (const key of seat.keys) keyToNo[key] = seat.no;
        for (const id of seat.radio_ids) radioToNo[id] = seat.no;
    }
    return {seats, key_to_no: keyToNo, radio_to_no: radioToNo, heartbeat_timeout_ms: timeout};
}

module.exports = {
    SEAT_HEARTBEAT_TIMEOUT_MS,
    UNIDENTIFIED,
    toMs,
    seatViews,
    seatForRadio,
    seatPlan,
    seatNumber,
    colorFor,
    project
};
