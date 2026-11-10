import {parseUtcDateTime} from '../core/clock.mjs';

/** Selected contest window from settings; null when either bound is missing/invalid. */
export function contestWindow(settings = {}) {
    const start = parseUtcDateTime(settings.contestStart);
    const end = parseUtcDateTime(settings.contestEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return {start, end, name: String(settings.contestName || '').trim()};
}

export function contestCountdown(settings = {}, now = Date.now()) {
    const window = contestWindow(settings);
    if (!window) return {phase: 'none'};
    if (now >= window.end) return {phase: 'ended', window};
    const target = now < window.start ? window.start : window.end;
    const remaining = target - now;
    return {
        phase: now < window.start ? 'before' : 'running',
        window,
        days: Math.floor(remaining / 86400000),
        hours: Math.floor(remaining % 86400000 / 3600000),
        minutes: Math.floor(remaining % 3600000 / 60000),
        seconds: Math.floor(remaining % 60000 / 1000)
    };
}
