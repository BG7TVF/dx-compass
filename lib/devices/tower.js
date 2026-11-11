'use strict';

/**
 * 塔的二态模型（只读）。
 *
 * erected = 上限位有效；retracted = 下限位有效；moving 是暂态；
 * 两路同时有效 = fault；运行超时或反馈异常 = unknown；通信中断 = offline。
 * 没有“停在中途”的正常状态：自锁回路会一直运行到限位。
 *
 * 限位类型只有一个设置项（NO/NC，默认 NO）：选错只会让状态显示相反，
 * 不做自检、不做校验、不阻断。
 */

const DEFAULT_LIMIT_SWITCH_TYPE = 'NO';
const DEFAULT_TRAVEL_TIMEOUT_SEC = 120;

function isBoolean(value) {
    return typeof value === 'boolean';
}

/** 电平时 → 逻辑“到位”。NC 接法取反；无法识别返回 null。 */
function logicalLevel(raw, limitSwitchType) {
    if (!isBoolean(raw)) return null;
    return limitSwitchType === 'NC' ? !raw : raw;
}

function stateFromEntry(entry, limitSwitchType, nowMs, travelTimeoutSec) {
    const tower = (entry && entry.tower) || {};
    const top = logicalLevel(tower.limit_top, limitSwitchType);
    const bottom = logicalLevel(tower.limit_bottom, limitSwitchType);
    const moving = !!(entry && entry.moving);
    const base = {
        limit_top: top,
        limit_bottom: bottom,
        moving,
        alert: null,
        reason: ''
    };
    if (top === null || bottom === null) {
        return Object.assign(base, {state: 'unknown', reason: 'no-limit-feedback'});
    }
    if (top && bottom) {
        return Object.assign(base, {state: 'fault', alert: 'limit-conflict', reason: 'both-limits'});
    }
    if (top) return Object.assign(base, {state: 'erected'});
    if (bottom) return Object.assign(base, {state: 'retracted'});
    if (moving) {
        const started = Number(entry && entry.motion_started_ms);
        const timeoutMs = Math.max(1, Number(travelTimeoutSec) || DEFAULT_TRAVEL_TIMEOUT_SEC) * 1000;
        if (Number.isFinite(started) && nowMs - started > timeoutMs) {
            return Object.assign(base, {
                state: 'unknown',
                alert: 'travel-timeout',
                reason: 'travel-timeout'
            });
        }
        return Object.assign(base, {state: 'moving'});
    }
    return Object.assign(base, {state: 'unknown', reason: 'no-limit'});
}

/**
 * @param {object} input
 * @param {object} input.device 塔设备配置
 * @param {object|null} input.entry 运行态（runtime.stateOf）
 * @param {Date} input.now
 * @param {string} [input.limitSwitchType] 'NO' | 'NC'
 * @param {number} [input.offlineTimeoutMs]
 */
function resolve(input) {
    const opts = input || {};
    const at = opts.now instanceof Date ? opts.now : new Date(opts.now === undefined ? Date.now() : opts.now);
    const nowMs = at.getTime();
    const limitSwitchType = opts.limitSwitchType === 'NC' ? 'NC' : DEFAULT_LIMIT_SWITCH_TYPE;
    const travelTimeoutSec = Number(opts.device && opts.device.travel_timeout_sec) ||
        DEFAULT_TRAVEL_TIMEOUT_SEC;
    const entry = opts.entry || null;
    const lastReportMs = entry && Number.isFinite(entry.last_report_ms) ? entry.last_report_ms : null;
    if (!entry || lastReportMs === null) {
        return {
            state: 'unknown',
            reason: 'no-report',
            alert: null,
            limit_top: null,
            limit_bottom: null,
            moving: false,
            last_report: null,
            age_ms: null
        };
    }
    const age = Math.max(0, nowMs - lastReportMs);
    const resolved = stateFromEntry(entry, limitSwitchType, nowMs, travelTimeoutSec);
    const view = Object.assign({}, resolved, {
        last_report: entry.last_report || null,
        age_ms: age,
        offline: false
    });
    const offlineTimeoutMs = Number(opts.offlineTimeoutMs);
    if (Number.isFinite(offlineTimeoutMs) && offlineTimeoutMs > 0 && age > offlineTimeoutMs) {
        return Object.assign(view, {
            state: 'offline',
            last_state: resolved.state,
            offline: true
        });
    }
    return view;
}

module.exports = {
    DEFAULT_LIMIT_SWITCH_TYPE,
    DEFAULT_TRAVEL_TIMEOUT_SEC,
    logicalLevel,
    stateFromEntry,
    resolve
};
