/**
 * Clock helpers. UTC-only helpers stay for the wire format; the settings-aware
 * formatters below honour timeZone/hour12/showSeconds and fall back to UTC.
 * Input: Date, epoch milliseconds or ISO-like strings.
 * Output: epoch milliseconds, labels and stable hour keys; invalid dates yield NaN/''.
 */
export function toDate(value = new Date()) {
    return value instanceof Date ? value : new Date(value);
}

export const DEFAULT_CLOCK_OPTIONS = Object.freeze({timeZone: 'utc', hour12: false, seconds: true});

/** Normalise a settings object (or partial options) into clock display options. */
export function clockOptions(source = {}) {
    const settings = source || {};
    return {
        timeZone: settings.timeZone === 'local' ? 'local' : 'utc',
        hour12: Boolean(settings.hour12),
        seconds: settings.showSeconds !== false && settings.seconds !== false
    };
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function displayParts(date, options) {
    const local = (options && options.timeZone) === 'local';
    return {
        year: local ? date.getFullYear() : date.getUTCFullYear(),
        month: (local ? date.getMonth() : date.getUTCMonth()) + 1,
        day: local ? date.getDate() : date.getUTCDate(),
        hour: local ? date.getHours() : date.getUTCHours(),
        minute: local ? date.getMinutes() : date.getUTCMinutes(),
        second: local ? date.getSeconds() : date.getUTCSeconds(),
        weekday: local ? date.getDay() : date.getUTCDay()
    };
}

/** HH:MM[:SS] in UTC or local time, with an optional AM/PM suffix. */
export function formatClock(value = new Date(), options = {}) {
    const date = toDate(value);
    if (Number.isNaN(date.getTime())) return '';
    const resolved = Object.assign({}, DEFAULT_CLOCK_OPTIONS, options);
    const parts = displayParts(date, resolved);
    let hour = parts.hour;
    let suffix = '';
    if (resolved.hour12) {
        suffix = hour < 12 ? ' AM' : ' PM';
        hour = hour % 12 || 12;
    }
    const hh = pad2(hour);
    return `${hh}:${pad2(parts.minute)}${resolved.seconds !== false ? `:${pad2(parts.second)}` : ''}${suffix}`;
}

/** YYYY-MM-DD in UTC or local time. */
export function formatClockDate(value = new Date(), options = {}) {
    const date = toDate(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = displayParts(date, Object.assign({}, DEFAULT_CLOCK_OPTIONS, options));
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Date + clock; UTC keeps the trailing Z so wire timestamps stay unambiguous. */
export function formatClockDateTime(value = new Date(), options = {}) {
    const resolved = Object.assign({}, DEFAULT_CLOCK_OPTIONS, options);
    const date = formatClockDate(value, resolved);
    if (!date) return '';
    return `${date} ${formatClock(value, resolved)}${resolved.timeZone === 'local' ? '' : 'Z'}`;
}

export function clockWeekday(value = new Date(), options = {}) {
    const date = toDate(value);
    if (Number.isNaN(date.getTime())) return -1;
    return displayParts(date, Object.assign({}, DEFAULT_CLOCK_OPTIONS, options)).weekday;
}

export function toEpochMs(value) {
    return toDate(value).getTime();
}

export function formatUtcTime(value = new Date(), {seconds = true} = {}) {
    const date = toDate(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, seconds ? 19 : 16);
}

export function formatUtcDate(value = new Date()) {
    const date = toDate(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

export function formatUtcDateTime(value = new Date()) {
    const date = toDate(value);
    return Number.isNaN(date.getTime()) ? '' : `${formatUtcDate(date)} ${formatUtcTime(date)}`;
}

/** Interpret datetime-local values without a zone as UTC, matching wall countdowns. */
export function parseUtcDateTime(value) {
    const text = String(value || '').trim();
    if (!text) return NaN;
    const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)
        ? `${text}Z`
        : text;
    return new Date(zoned).getTime();
}

export function startOfUtcHour(value = new Date()) {
    const date = toDate(value);
    if (Number.isNaN(date.getTime())) return new Date(NaN);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));
}

export function utcHourKey(value = new Date()) {
    const date = startOfUtcHour(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 13);
}

/** Format a non-negative duration as HH:MM:SS; invalid/negative input returns 00:00:00. */
export function formatDuration(milliseconds) {
    const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
    const pad = value => String(value).padStart(2, '0');
    return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds % 3600 / 60))}:${pad(seconds % 60)}`;
}
