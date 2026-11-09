/* Quiet-hours window used to mute spot popups and voice alerts.
 *
 * Both ends are local "HH:MM" strings. An end earlier than the start means the
 * window crosses midnight (22:30-06:30); equal or invalid ends disable the
 * window, so a missing/partial setting never silences alerts. */

export function quietMinutes(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function quietHoursActive(from, to, now = new Date()) {
    const start = quietMinutes(from);
    const end = quietMinutes(to);
    if (start === null || end === null || start === end) return false;
    const minute = now.getHours() * 60 + now.getMinutes();
    return start < end
        ? minute >= start && minute < end
        : minute >= start || minute < end;
}
