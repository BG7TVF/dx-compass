'use strict';

/**
 * Minimal iCalendar (RFC 5545) reader for the WA7BNM Contest Calendar ICS feed.
 *
 * The feed only carries what the site's Terms of Use allow us to consume:
 * contest name, UTC start/end and the contest detail link. Rule details
 * (modes, bands, exchange, multipliers, power) are NOT present and must be
 * shown as "not collected" rather than guessed.
 */

const FEED_URL = 'https://www.contestcalendar.com/weeklycontcustom.php';
const HOME_URL = 'https://www.contestcalendar.com/';
const TERMS_URL = 'https://www.contestcalendar.com/terms.php';
const SOURCE = 'WA7BNM Contest Calendar';

function unfold(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n[ \t]/g, '');
}

function unescapeText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\\n/gi, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\')
        .trim();
}

/** `20261107T210000Z` -> `2026-11-07T21:00:00Z`; unsupported forms return null. */
function utcStamp(value) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value || '').trim());
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

function splitLine(line) {
    const index = line.indexOf(':');
    if (index < 0) return null;
    const name = line.slice(0, index).split(';')[0].trim().toUpperCase();
    return name ? {name, value: line.slice(index + 1)} : null;
}

function eventId(uid, start) {
    const base = String(uid || '').replace(/@.*$/, '').replace(/[^A-Za-z0-9_-]/g, '').trim();
    return base ? `wa7bnm-${base}` : `wa7bnm-${String(start).replace(/[^0-9]/g, '').slice(0, 14)}`;
}

/**
 * Parse an ICS document into contest entries.
 * Missing fields stay empty; nothing is inferred.
 */
function parseIcs(text) {
    const events = [];
    let current = null;
    for (const line of unfold(text).split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'BEGIN:VEVENT') { current = {}; continue; }
        if (trimmed === 'END:VEVENT') {
            if (current) events.push(current);
            current = null;
            continue;
        }
        if (!current) continue;
        const part = splitLine(line);
        if (part) current[part.name] = part.value;
    }

    const contests = [];
    for (const event of events) {
        if (String(event.STATUS || '').toUpperCase() === 'CANCELLED') continue;
        const startUtc = utcStamp(event.DTSTART);
        const endUtc = utcStamp(event.DTEND);
        const name = unescapeText(event.SUMMARY);
        if (!startUtc || !endUtc || !name || Date.parse(endUtc) <= Date.parse(startUtc)) continue;
        const detailUrl = unescapeText(event.URL) || FEED_URL;
        contests.push({
            id: eventId(unescapeText(event.UID), startUtc),
            name,
            startUtc,
            endUtc,
            source: 'wa7bnm',
            sourceUrl: detailUrl,
            rulesUrl: '',
            modes: [],
            bands: [],
            exchange: '',
            multipliers: '',
            multPerBand: null,
            power: '',
            classes: '',
            rulesStatus: 'not-collected'
        });
    }

    contests.sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc) ||
        a.name.localeCompare(b.name));
    return contests;
}

module.exports = {
    FEED_URL,
    HOME_URL,
    TERMS_URL,
    SOURCE,
    parseIcs,
    utcStamp,
    unfold,
    unescapeText
};
