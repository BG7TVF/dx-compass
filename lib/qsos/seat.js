'use strict';

/**
 * 席位（seat）身份：station + radio。
 *
 * N1MM 的 RadioNr 只在一台机器内部唯一；MM 的多台独立实例通常都上报
 * RadioNr=1，所以状态与换波段计数必须用复合键，不能只用 radioNr。
 *
 * 纯函数，不碰数据库。
 */

const PREFIX = 'DXI';
const MAX_KEY = 64;

function normalizeKey(value) {
    return String(value === undefined || value === null ? '' : value)
        .trim()
        .toUpperCase()
        .replace(/[|:]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, MAX_KEY);
}

/**
 * 实例身份优先级：relay 显式 --station → 报文 StationName → RadioName →
 * 来源 IP → LOCAL。HTTP relay 可通过 X-DX-Station 提供稳定身份。
 */
function stationKeyFrom(source) {
    const s = source || {};
    const candidates = [s.station, s.stationName, s.radioName, s.ip];
    for (const value of candidates) {
        const key = normalizeKey(value);
        if (key) return key;
    }
    return 'LOCAL';
}

function seatKeyFrom(station, radioNr) {
    const base = normalizeKey(station) || 'LOCAL';
    const nr = normalizeKey(radioNr) || '1';
    return base + ':' + nr;
}

/** QSO 主键命名空间：DXI|<instance>|<rawId>。 */
function namespaceId(instance, rawId) {
    const base = normalizeKey(instance) || 'LOCAL';
    return PREFIX + '|' + base + '|' + String(rawId === undefined || rawId === null ? '' : rawId);
}

/** 只认我们写进去的命名空间；老数据的裸 ID 返回 null。 */
function parseInstance(n1mmId) {
    const value = String(n1mmId === undefined || n1mmId === null ? '' : n1mmId);
    if (!value.startsWith(PREFIX + '|')) return null;
    const rest = value.slice(PREFIX.length + 1);
    const cut = rest.indexOf('|');
    return cut < 0 ? null : rest.slice(0, cut);
}

/**
 * 从 /api/advice 的 seq 行还原 seat。
 * row.ref = n1mm_id；row.station / row.radio 为 qsos 的 stationname/radionr。
 */
function seatOfRow(row) {
    const r = row || {};
    const instance = parseInstance(r.ref) || normalizeKey(r.station) || 'LOCAL';
    return seatKeyFrom(instance, r.radio);
}

module.exports = {
    PREFIX,
    normalizeKey,
    stationKeyFrom,
    seatKeyFrom,
    namespaceId,
    parseInstance,
    seatOfRow
};
