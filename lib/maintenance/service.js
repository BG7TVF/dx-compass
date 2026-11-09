'use strict';

const fs = require('fs');
const {runtime} = require('../settings/service.js');
const spotSql = require('../storage/spot-sql.js');
const qsoSql = require('../storage/qso-sql.js');
const recordingSql = require('../storage/recording-sql.js');

/** Build the hourly retention statements from settings; never throws. */
function purge(global) {
    const cfg = runtime(global);
    if (!cfg.autoPurge) return {statements: []};
    const statements = [];
    const spots = spotSql.purge(cfg.retentionSpotsDays);
    if (spots) statements.push({scope: 'spots', topic: spots});
    const qsos = qsoSql.purge(cfg.retentionQsoDays);
    if (qsos) statements.push({scope: 'qsos', topic: qsos});
    statements.push({scope: 'recordings', topic: recordingSql.purge(cfg.retentionRecordingMonths)});
    return {statements};
}

/** Gated disk usage check; returns warn/cleared transitions for the flow logger. */
function diskCheck(global, options) {
    const cfg = runtime(global);
    if (!cfg.diskAlert) return {enabled: false};
    const now = options && Number.isFinite(options.now) ? options.now : Date.now();
    const last = Number(global.get('diskCheckAt')) || 0;
    if (last && now - last < cfg.diskCheckSec * 1000 - 500) return {skipped: true};
    global.set('diskCheckAt', now);

    let stat;
    try {
        stat = fs.statfsSync((options && options.path) || process.cwd());
    } catch (e) {
        return {error: e.message};
    }
    const total = stat.blocks * stat.bsize;
    const free = stat.bfree * stat.bsize;
    const usedPct = total ? Math.round((1 - free / total) * 1000) / 10 : 0;
    const warn = usedPct >= cfg.diskWarnPct;
    const result = {
        enabled: true, usedPct, freeGb: Math.round(free / 1073741824 * 10) / 10,
        threshold: cfg.diskWarnPct, warn
    };
    const wasWarn = global.get('diskWarnActive') === true;
    if (warn && !wasWarn) {
        global.set('diskWarnActive', true);
        result.transition = 'raised';
    } else if (!warn && wasWarn) {
        global.set('diskWarnActive', false);
        result.transition = 'cleared';
    }
    return result;
}

module.exports = {purge, diskCheck};
