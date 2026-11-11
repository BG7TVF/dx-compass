'use strict';

/**
 * 席位与天线的归属投影（只计算，不写回）。
 *
 * 归属不是静态绑定：它由“席位当前波段 + 天线波段 + 席位是否在线”派生。
 * 席位心跳 = N1MM 上行报文（经 relay）；60 秒收不到就判定离线，
 * 离线席位不再占用任何天线，天线立刻回到空闲（绿）。
 *
 * 灯色相对当前席位：红 = 本席占用；黄 = 他席占用；绿 = 空闲。
 * 1×n（exclusive）是独占通路，不产生黄灯。
 */

const seatModel = require('../radio/bands.js');
const {actualAzimuth} = require('./model.js');

const SEAT_HEARTBEAT_TIMEOUT_MS = 60000;
const UNIDENTIFIED = 'UNIDENTIFIED';

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
            station_name: radio.stationName || ''
        };
    }).filter(view => !isUnidentified(view.seat));
}

function colorFor(owners, seat, exclusive) {
    const list = Array.isArray(owners) ? owners : [];
    if (seat && list.includes(seat)) return 'red';
    if (exclusive) return 'green';
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
    const seats = seatViews(opts.radioStates, nowMs, timeout);
    const onlineSeats = seats.filter(view => view.online && view.band);
    const antennas = devices.filter(device => device && device.type === 'antenna' && device.enabled !== false);

    const antennaViews = antennas.map(antenna => {
        const bands = (antenna.bands || []).map(band => String(band).toLowerCase());
        const owners = onlineSeats.filter(view => bands.includes(view.band)).map(view => view.seat);
        const rotator = rotatorAzimuthFor(devices, antenna, opts.rotatorAzimuths || {});
        const actual = rotator.physical === null || rotator.physical === undefined
            ? null
            : actualAzimuth(rotator.physical, antenna.install_offset_deg || 0);
        const colors = {};
        for (const view of seats) {
            colors[view.seat] = colorFor(owners, view.seat, !!antenna.exclusive);
        }
        return {
            id: antenna.id,
            name: antenna.name,
            bands,
            exclusive: !!antenna.exclusive,
            owners,
            color_by_seat: colors,
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
        const candidates = view.band
            ? antennaViews.filter(antenna => antenna.bands.includes(view.band)).map(antenna => antenna.id)
            : [];
        bySeat[view.seat] = {
            seat: view.seat,
            band: view.band,
            online: view.online,
            last_seen: view.last_seen,
            age_ms: view.age_ms,
            colors,
            assigned,
            candidates,
            // 该波段没有配置任何天线：保持无归属，界面明确提示。
            unassigned: !!view.band && candidates.length === 0,
            ambiguous: candidates.length > 1
        };
    }

    return {
        heartbeat_timeout_ms: timeout,
        seats,
        antennas: antennaViews,
        by_seat: bySeat
    };
}

module.exports = {
    SEAT_HEARTBEAT_TIMEOUT_MS,
    UNIDENTIFIED,
    toMs,
    seatViews,
    colorFor,
    project
};
