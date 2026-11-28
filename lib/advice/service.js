'use strict';

/**
 * /api/advice 服务层。
 *
 * 定位：消费者 + 纯函数规则引擎。
 *   - QSO / 波段活跃度走一次 UNION ALL 查询，不重算乘数矩阵、不重写可通性；
 *   - 乘数分母来自 public/shared/dxcc/entities.json（与 /api/multipliers 同源，342）；
 *   - 传播、电台、比分直接读 Node-RED 全局快照。
 */

const engine = require('./engine.js');
const {thresholds} = require('./config.js');
const adviceSql = require('../storage/advice-sql.js');
const {bandMeters} = require('../radio');
const ENTITIES = require('../../public/shared/dxcc/entities.json').entities;

const ACTIVE_ENTITIES = new Set(
    (ENTITIES || []).filter(entry => entry && !entry.deleted).map(entry => entry.dxcc)
).size;

const {iso, parseBound} = adviceSql;

/**
 * @param {object} query
 * @param {object} settings sanitize 后的设置
 * @param {Date}   nowOverride 回放/测试用
 */
function prepare(query, settings, nowOverride) {
    const cfgSettings = settings && typeof settings === 'object' ? settings : {};
    const now = nowOverride instanceof Date ? nowOverride : new Date(nowOverride || Date.now());
    const minutes = thresholds(cfgSettings).bucketMinutes;
    const multMode = adviceSql.MULTI_CALL_MODES.has(cfgSettings.multMode)
        ? cfgSettings.multMode : 'dxcc-per-band';
    const recent3h = iso(now.getTime() - 3 * 3600000);
    const activitySince = new Date(Math.floor((now.getTime() - 3600000) / 300000) * 300000)
        .toISOString().slice(0, 16);

    const {sql} = adviceSql.adviceQuery({
        settings: cfgSettings, now, minutes, multMode, recent3h, activitySince
    });

    const wantedSeat = query && query.seat ? String(query.seat).slice(0, 80) : null;
    return {
        ok: true,
        error: null,
        sql,
        request: {
            now: now.toISOString(),
            from: parseBound(cfgSettings.contestStart),
            to: parseBound(cfgSettings.contestEnd),
            multMode,
            activeEntities: ACTIVE_ENTITIES,
            seat: wantedSeat,
            settings: cfgSettings
        }
    };
}

function buildScore(score) {
    if (!score || typeof score !== 'object') return null;
    return {
        qsos: Number(score.qsos) || 0,
        points: Number(score.points) || 0,
        mults: Number(score.mults) || 0,
        score: Number(score.score) || 0,
        ts: score.ts || null
    };
}

/**
 * @param {object} prepared  prepare() 的返回值
 * @param {Array}  rows      sqlite 结果
 * @param {object} extras    {prop, radio, score, cooldown, now, settings}
 */
function complete(prepared, rows, extras) {
    if (!prepared || !prepared.ok) {
        return {ok: false, error: (prepared && prepared.error) || 'invalid-request'};
    }
    const request = prepared.request || {};
    const extra = extras || {};
    const settings = extra.settings || request.settings || {};
    const now = extra.now instanceof Date ? extra.now : new Date(request.now || Date.now());

    /* 规则引擎内部只认数字米波（'20'/'15'）：QSO 行可能是 N1MM 的 14/21，
     * 波段活跃度行是 20m/15m。这里一次性归一，否则 currentBand 与
     * stats.bands 的键永远对不上，所有按波段统计的规则都拿不到数据。 */
    const normalizedRows = (Array.isArray(rows) ? rows : []).map(row => {
        if (!row || typeof row !== 'object' || row.band === undefined || row.band === null || row.band === '') {
            return row;
        }
        return Object.assign({}, row, {band: bandMeters(row.band)});
    });

    const result = engine.buildAdvice({
        settings,
        rows: normalizedRows,
        prop: extra.prop || {},
        radio: extra.radio || {},
        radios: extra.radios || {},
        seat: extra.seat || request.seat || null,
        score: buildScore(extra.score),
        activeEntities: request.activeEntities,
        cooldown: extra.cooldown || {},
        now
    });

    return {
        ...result,
        request: {from: request.from, to: request.to, multMode: request.multMode, seat: request.seat || null},
        thresholds: {
            bucketMinutes: thresholds(settings).bucketMinutes,
            stayRate: thresholds(settings).stayRate,
            tau: thresholds(settings).tau
        }
    };
}

module.exports = {
    ACTIVE_ENTITIES,
    prepare,
    complete
};
