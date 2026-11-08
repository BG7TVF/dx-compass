/**
 * UTC-only clock helpers. Input: Date, epoch milliseconds or ISO-like strings.
 * Output: epoch milliseconds, UTC labels and stable hour keys; invalid dates yield NaN/''.
 */
export function toDate(value = new Date()) {
    return value instanceof Date ? value : new Date(value);
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
