'use strict';

/**
 * 手动比赛窗口：用户自行填写名称与 UTC 起止时间。
 * 结束时间到点后由服务端统一清空，客户端不做判断。
 */

const logger = require('../logger');
const settingsService = require('../settings/service.js');

const CONTEST_KEYS = [
    'contestName', 'contestStart', 'contestEnd',
    'contestModes', 'contestBands', 'contestRulesUrl'
];

/** Parse an ISO/UTC `datetime` value; naive values are interpreted as UTC. */
function parseUtc(value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return null;
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text) ? `${text}:00Z`
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) ? `${text}Z` : text;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
}

/** Contest window in epoch milliseconds, for the multiplier matrix and alerts. */
function windowFor(settings) {
    const cfg = settings && typeof settings === 'object' ? settings : {};
    const from = parseUtc(cfg.contestStart);
    const to = parseUtc(cfg.contestEnd);
    return {from, to};
}

/**
 * Server-side expiry: once the current contest has ended, clear every contest
 * field and broadcast the new settings. Clients never decide this themselves.
 */
function expire(global, now) {
    let settings = null;
    try {
        settings = settingsService.runtime(global);
    } catch (error) {
        return {changed: false};
    }
    const end = parseUtc(settings.contestEnd);
    const current = Number.isFinite(now) ? now : Date.now();
    if (end === null || current < end) return {changed: false};

    const patch = {};
    for (const key of CONTEST_KEYS) patch[key] = '';
    patch.wallTimerStart = '';
    patch.wallTimerEnd = '';

    const saved = settingsService.save(global, {__patch: patch});
    logger.info(`[contest] auto-cleared "${settings.contestName || 'unnamed'}" at end time`);
    return {changed: true, settings: saved.payload.settings, broadcast: saved.broadcast};
}

module.exports = {expire, windowFor, parseUtc};
