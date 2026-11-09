'use strict';

/* Minimal level-aware logger for the DX-Compass server modules.
 *
 * Node-RED owns its own logging configuration (settings.js), so this only
 * gates the messages these modules emit. Levels follow the usual order:
 * error < warn < info < debug. The default keeps the historical behaviour
 * (everything printed). */

const LEVELS = {error: 0, warn: 1, info: 2, debug: 3};
let current = 'info';

function setLevel(level) {
    if (Object.prototype.hasOwnProperty.call(LEVELS, level)) current = level;
}

function getLevel() {
    return current;
}

function enabled(level) {
    return Object.prototype.hasOwnProperty.call(LEVELS, level) && LEVELS[level] <= LEVELS[current];
}

function write(level, args) {
    if (!enabled(level)) return;
    const target = level === 'error' ? console.error
        : level === 'warn' ? console.warn
            : console.log;
    target.apply(console, args);
}

module.exports = {
    LEVELS,
    setLevel,
    getLevel,
    enabled,
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args)
};
