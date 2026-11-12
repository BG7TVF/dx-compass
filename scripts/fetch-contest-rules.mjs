#!/usr/bin/env node
/**
 * Fetch the official rules pages for the contests the decision engine drives
 * and write one structured JSON file shared by the server and the browser.
 *
 * Contract:
 *   - Every extracted field is either a real value or the string "unknown".
 *   - Unknown fields are also listed in unknowns[] with a reason; nothing is
 *     filled from memory.
 *   - Validation failures never overwrite the previous file.
 *   - Re-running prints a diff against the previous file.
 *
 * Usage: npm run rules:fetch [-- --strict] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'public', 'shared', 'contest', 'rules.json');
const UNKNOWN = 'unknown';
const SCHEMA_VERSION = 1;
const USER_AGENT = 'DX-Compass rules fetcher (amateur radio contest dashboard)';

const FAMILIES = ['CQWW', 'CQWPX', 'CQWW_RTTY', 'ARRL_DX', 'IARU', 'CQ160', 'WAE'];

const SPECS = [
    {
        family: 'CQWW',
        name: 'CQ World-Wide DX Contest',
        sources: [
            {url: 'https://www.cqww.com/rules.htm', modes: ['CW', 'SSB']}
        ]
    },
    {
        family: 'CQWPX',
        name: 'CQ World-Wide WPX Contest',
        sources: [
            {url: 'https://www.cqwpx.com/rules.htm', modes: ['CW', 'SSB']},
            {url: 'https://www.cqwpxrtty.com/rules.htm', modes: ['RTTY']}
        ]
    },
    {
        family: 'ARRL_DX',
        name: 'ARRL International DX Contest',
        sources: [
            {url: 'https://www.arrl.org/arrl-dx', modes: ['CW', 'SSB']}
        ]
    },
    {
        family: 'IARU',
        name: 'IARU HF World Championship',
        sources: [
            {url: 'https://www.iaru.org/on-the-air/iaru-contests/rules/', modes: ['CW', 'SSB']}
        ]
    },
    {
        family: 'CQ160',
        name: 'CQ World Wide 160-Meter Contest',
        sources: [
            {url: 'https://www.cq160.com/rules.htm', modes: ['CW', 'SSB']}
        ]
    },
    {
        family: 'CQWW_RTTY',
        name: 'CQ World-Wide RTTY DX Contest',
        sources: [
            {url: 'https://www.cqwwrtty.com/rules.htm', modes: ['RTTY']}
        ]
    },
    {
        family: 'WAE',
        name: 'Worked All Europe DX Contest',
        sources: [
            {url: 'https://www.darc.de/der-club/referate/conteste/wae-dx-contest/en/wae-rules', modes: ['CW', 'SSB', 'RTTY']}
        ]
    }
];

// ---------------------------------------------------------------- text utils
export function decodeEntities(text) {
    const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
        ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…'
    };
    return String(text || '')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

export function htmlToText(html) {
    return decodeEntities(String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n');
}

function section(text, heading, length = 900) {
    const match = heading.exec(text);
    if (!match) return '';
    return text.slice(match.index, match.index + length);
}

function firstMatch(text, patterns) {
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match) return match;
    }
    return null;
}

// --------------------------------------------------------------- extraction
export function extractYear(text) {
    const years = [...String(text || '').matchAll(/\b(20\d{2})\b/g)].map(match => Number(match[1]));
    if (!years.length) return UNKNOWN;
    const current = new Date().getUTCFullYear();
    const usable = years.filter(year => year <= current + 1 && year >= current - 1);
    return usable.length ? Math.max(...usable) : UNKNOWN;
}

const NAME_PATTERNS = {
    CQWW: [/((?:The\s+)?20\d{2}\s+CQ\s+World[- ]Wide\s+DX\s+Contest)/i],
    CQWPX: [/((?:The\s+)?20\d{2}\s+CQ\s+World[- ]Wide\s+WPX\s+Contest)/i],
    CQWW_RTTY: [/((?:The\s+)?20\d{2}\s+CQ\s+World[- ]Wide\s+RTTY\s+DX\s+Contest)/i, /(CQ\s+World[- ]Wide\s+RTTY\s+DX\s+Contest)/i],
    CQ160: [/((?:The\s+)?20\d{2}\s+CQ\s+World\s+Wide\s+160[^\n]{0,40}Contest)/i],
    ARRL_DX: [/(ARRL\s+International\s+DX\s+Contest)/i],
    IARU: [/(IARU\s+HF\s+World\s+Championship)/i],
    WAE: [/(Worked\s+All\s+Europe(?:\s+DX)?\s+Contest)/i]
};

export function extractName(text, spec) {
    const patterns = (spec && NAME_PATTERNS[spec.family]) || [];
    const match = firstMatch(text, patterns);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
    return UNKNOWN;
}

const MHZ_TO_BAND = {
    '1.8': '160m', '3.5': '80m', '5.3': '60m', '7': '40m', '10.1': '30m',
    '14': '20m', '18.068': '17m', '21': '15m', '24.89': '12m', '28': '10m',
    '50': '6m', '144': '2m'
};
const METER_TO_BAND = {
    '160': '160m', '80': '80m', '60': '60m', '40': '40m', '30': '30m', '20': '20m',
    '17': '17m', '15': '15m', '12': '12m', '10': '10m', '6': '6m', '2': '2m'
};

export function extractBands(text, depth = 0) {
    const window = depth > 0
        ? text
        : (section(text, /\b(?:II\.\s*)?BANDS?\b/i, 900) ||
            section(text, /\bBAND\s+USE\b/i, 900) ||
            text.slice(0, 3000));
    const lineBands = line => {
        const list = [];
        for (const unit of line.matchAll(/\b(?:MHz|meters?|metres?|m\b)/gi)) {
            const before = line.slice(Math.max(0, unit.index - 160), unit.index);
            for (const token of before.matchAll(/\d+(?:\.\d+)?/g)) {
                const band = MHZ_TO_BAND[token[0]] || METER_TO_BAND[token[0]];
                if (band && !list.includes(band)) list.push(band);
            }
        }
        return list;
    };
    // Use the first line that actually lists bands; later mentions such as
    // "6 and 2 meters do not count" must not pollute the allowed list.
    let found = [];
    for (const line of window.split(/\n+/)) {
        const list = lineBands(line);
        if (list.length > found.length) found = list;
        if (found.length >= 2) break;
    }
    if (!found.length && depth < 1) {
        return extractBands(text.slice(0, 4000), depth + 1);
    }
    if (!found.length) return UNKNOWN;
    return found.sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
}

function monthNumber(name) {
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
        'august', 'september', 'october', 'november', 'december'];
    const index = months.indexOf(String(name || '').toLowerCase());
    return index < 0 ? null : index + 1;
}

function iso(year, month, day, hour = 0, minute = 0, second = 0) {
    if (!year || !month || !day) return null;
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second)).toISOString();
}

/** Parse the common "Month D-D" and "D Month" window shapes. */
export function extractPeriods(text, year, modeHint) {
    const periods = [];
    const month = '([A-Z][a-z]+)';
    const range = new RegExp(
        `(CW|SSB|RTTY|Phone)\\s*:\\s*${month}\\s+(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})(?:\\s*,?\\s*(20\\d{2}))?`, 'i'
    );
    for (const match of text.matchAll(new RegExp(range.source, 'gi'))) {
        const mo = monthNumber(match[2]);
        const y = Number(match[5]) || (Number.isFinite(year) ? year : null);
        const start = iso(y, mo, Number(match[3]), 0, 0, 0);
        const end = iso(y, mo, Number(match[4]), 23, 59, 59);
        if (start && end) {
            periods.push({mode: match[1].toUpperCase(), start, end, durationHours: 48});
        }
    }
    const clockRange = new RegExp(
        '(\\d{2})(\\d{2})Z\\s+' + month + '\\s+(\\d{1,2})\\s+to\\s+(\\d{2})(\\d{2})Z\\s+' + month + '\\s+(\\d{1,2})',
        'i'
    );
    const clock = clockRange.exec(text);
    if (clock) {
        const y = Number.isFinite(year) ? year : null;
        const start = iso(y, monthNumber(clock[3]), Number(clock[4]), Number(clock[1]), Number(clock[2]), 0);
        const end = iso(y, monthNumber(clock[7]), Number(clock[8]), Number(clock[5]), Number(clock[6]), 0);
        if (start && end) periods.push({mode: modeHint || 'CW', start, end, durationHours: 48});
    }
    // WAE states every leg twice: "CW: August, ... Saturday, August 8th 2026,
    // 00:00 UTC until Sunday, August 9th 2026, 23:59 UTC".
    const explicit = /[A-Z][a-z]+day,\s+([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(20\d{2}),?\s+(\d{2}):(\d{2})\s+UTC\s+until\s+[A-Z][a-z]+day,\s+([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(20\d{2}),?\s+(\d{2}):(\d{2})\s+UTC/gi;
    for (const match of text.matchAll(explicit)) {
        const start = iso(Number(match[3]), monthNumber(match[1]), Number(match[2]), Number(match[4]), Number(match[5]), 0);
        const end = iso(Number(match[8]), monthNumber(match[6]), Number(match[7]), Number(match[9]), Number(match[10]), 59);
        if (!start || !end) continue;
        const lead = text.slice(Math.max(0, match.index - 300), match.index);
        const modeMatch = [...lead.matchAll(/\b(CW|SSB|RTTY|Phone)\s*:/gi)].pop();
        periods.push({
            mode: modeMatch ? modeMatch[1].toUpperCase() : (modeHint || 'CW'),
            start,
            end,
            durationHours: Math.round((Date.parse(end) - Date.parse(start)) / 3600000)
        });
    }
    // Bare "September 26-27" on CQWW RTTY; the year comes from the page title.
    if (!periods.length && Number.isFinite(year)) {
        const bare = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})/i.exec(text);
        if (bare) {
            const start = iso(year, monthNumber(bare[1]), Number(bare[2]), 0, 0, 0);
            const end = iso(year, monthNumber(bare[1]), Number(bare[3]), 23, 59, 59);
            if (start && end) periods.push({mode: modeHint || 'CW', start, end, durationHours: 48});
        }
    }
    const weekend = /Begins?\s+0000\s+UTC\s+Saturday[^.]*2359\s+UTC\s+Sunday/i.test(text);
    if (!periods.length && weekend) return {periods: UNKNOWN, note: 'weekend anchor only; exact dates unknown'};
    if (!periods.length) return {periods: UNKNOWN, note: 'no explicit date range on the page'};
    return {periods: dedupePeriods(periods)};
}

function dedupePeriods(list) {
    const seen = new Set();
    return list.filter(item => {
        const key = `${item.mode}|${item.start}|${item.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function extractQsoPoints(text, family) {
    if (family === 'CQWW') {
        const different = /different continents?[^.]*?\b(three|3)\b/i.test(text);
        const same = /same continent[^.]*?\b(one|1)\b/i.test(text);
        const zero = /same country[^.]*?\bzero|zero\s*\(0\)\s*QSO/i.test(text);
        if (different && same && zero) {
            return {
                sameCountry: 0, sameContinent: 1, differentContinent: 3,
                northAmericaException: 2
            };
        }
    }
    if (family === 'CQWW_RTTY') {
        const different = /different continents?[^.]*?\b(three|3)\b/i.test(text);
        const same = /same continent[^.]*?\b(two|2)\b/i.test(text);
        const country = /same country[^.]*?\b(one|1)\b/i.test(text);
        if (different && same && country) {
            return {sameCountry: 1, sameContinent: 2, differentContinent: 3};
        }
    }
    if (family === 'CQWPX') {
        const high = /three\s*\(3\)\s*points[^.]*?(28|21|14)\s*MHz/i.test(text);
        const low = /six\s*\(6\)\s*points[^.]*?(7|3\.5|1\.8)\s*MHz/i.test(text);
        if (high && low) {
            return {
                high: {differentContinent: 3, sameContinent: 1, sameCountry: 1},
                low: {differentContinent: 6, sameContinent: 2, sameCountry: 1}
            };
        }
    }
    if (family === 'ARRL_DX') {
        const three = /\b(three|3)\s*points?\b/i.test(text);
        if (three) return {perQso: 3};
    }
    if (family === 'WAE' && /final score[^.]*total QSOs plus QTCs/i.test(text)) {
        return {perQso: 1};
    }
    if (family === 'CQ160') {
        const two = /\b(two|2)\s*points?\b/i.test(text);
        if (two) return {perQso: 2};
    }
    return UNKNOWN;
}

export function extractMultiplierCounting(text, family) {
    if (family === 'CQWPX' || /prefix multiplier[^.]*counted only once regardless of the band/i.test(text)) {
        if (/prefix/i.test(text) && /once regardless of (the )?band/i.test(text)) return 'wpx';
    }
    if (family === 'CQWW' && /zone[^.]*on each band/i.test(text) && /country[^.]*on each band/i.test(text)) {
        return 'dxcc-per-band';
    }
    if (family === 'CQWW_RTTY' && /(zone|country)[^.]*on each band/i.test(text)) {
        return 'dxcc-per-band';
    }
    if (family === 'WAE' && /(worked per band|countries?[^.]*per band)/i.test(text)) {
        return 'dxcc-per-band';
    }
    if (family === 'CQ160' && /(states?|provinces?)[^.]*countries?/i.test(text)) {
        return 'dxcc-per-band';
    }
    if (family === 'ARRL_DX' && /(states?|provinces?)[^.]*DXCC/i.test(text)) {
        return 'dxcc-per-band';
    }
    if (/multiplied by the number of different prefixes/i.test(text)) return 'wpx';
    return UNKNOWN;
}

function bandChangeFrom(text, category) {
    if (category === 'SO1R' || category === 'SO2R') {
        if (/no limit on[^.]*band changes/i.test(text)) return {rule: 'none'};
        return UNKNOWN;
    }
    const quota = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\(\d+\))?\s*band changes?[^.]*?(?:per|each|in any|in a)\s+(?:clock\s+)?hour/i.exec(text);
    if (quota) {
        const words = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
        const raw = quota[1].toLowerCase();
        const limit = words[raw] || parseInt(raw, 10);
        if (Number.isFinite(limit)) return {rule: 'hourly-quota', limitPerHour: limit};
    }
    if (/10[-\s]*minutes?/i.test(text) && /band/i.test(text)) {
        return {rule: 'time-lock', minutes: 10};
    }
    if (/no (?:band change )?limit/i.test(text) || /no limit[^.]*band changes/i.test(text)) {
        return {rule: 'none'};
    }
    return UNKNOWN;
}

function simultaneousSignalsFrom(text, category) {
    if (category === 'M2' && /two\s+(?:transmitted\s+)?signals/i.test(text)) return 2;
    if (category === 'MM' && /(six bands|(?:six|6)\s+(?:transmitted\s+)?signals|one signal on each band|one transmitted signal on each band)/i.test(text)) return 6;
    if ((category === 'MS' || category === 'SO1R' || category === 'SO2R') &&
        /(only )?one\s+(?:transmitted\s+)?signal/i.test(text)) return 1;
    return UNKNOWN;
}

const CATEGORY_PATTERNS = [
    ['SO1R', /Single Operator(?!\s+Assisted)/i],
    ['SO2R', /Single Operator[^.]{0,40}(?:Two|2)\s+Radio/i],
    ['MS', /Multi[-\s]?Single/i],
    ['M2', /Multi[-\s]?Two/i],
    ['MM', /Multi[-\s]?Multi/i]
];

export function extractCategories(text, family) {
    const categories = {};
    const unknowns = [];
    // Locate every category heading first and cut each block at the next one,
    // otherwise a Multi-Single block would borrow the Multi-Two quota.
    // WAE uses "SINGLE-OP / MULTI-OP" headings instead of "Single Operator".
    const patterns = family === 'WAE'
        ? [['SO1R', /SINGLE-OP(?:\s+(?:LOW|HIGH))?/i], ['MS', /MULTI-OP/i]]
        : CATEGORY_PATTERNS;
    const matches = [];
    for (const [key, pattern] of patterns) {
        const match = pattern.exec(text);
        if (match) matches.push({key, index: match.index, name: match[0]});
    }
    matches.sort((a, b) => a.index - b.index);
    matches.forEach((match, index) => {
        const key = match.key;
        const end = index + 1 < matches.length ? matches[index + 1].index : match.index + 1600;
        const block = text.slice(match.index, end);
        const signals = simultaneousSignalsFrom(block, key);
        let bandChange = bandChangeFrom(block, key);
        // CQ WW M/S: the 10-minute rule lives in a separate rule paragraph.
        if (key === 'MS' && family === 'CQWW' && bandChange === UNKNOWN &&
            /10[-\s]*minutes?/i.test(text) && /band/i.test(text)) {
            bandChange = {rule: 'time-lock', minutes: 10};
        }
        const role = key === 'MS' && family === 'CQWW' && /multiplier station/i.test(text)
            ? (/may not (?:call )?CQ|not (?:allowed|permitted) to CQ|no CQ/i.test(text) ? 'mult' : UNKNOWN)
            : 'none';
        categories[key] = {
            name: match.name.replace(/\s+/g, ' ').trim(),
            simultaneousSignals: signals,
            bandChange,
            multiplierStationRole: role
        };
        if (signals === UNKNOWN) unknowns.push({field: `categories.${key}.simultaneousSignals`, reason: 'not stated near the category heading'});
        if (bandChange === UNKNOWN) unknowns.push({field: `categories.${key}.bandChange`, reason: 'no quota or time lock found'});
        if (role === UNKNOWN) unknowns.push({field: `categories.${key}.multiplierStationRole`, reason: 'multiplier station mentioned without a clear CQ restriction'});
    });
    if (!Object.keys(categories).length) {
        unknowns.push({field: 'categories', reason: 'no category heading matched on the fetched page'});
    }
    return {categories, unknowns};
}

/** Extract one source document; unknown values are explicit. */
export function extractSource(spec, modes, html, url, fetchedAt) {
    const text = htmlToText(html);
    let year = extractYear(text);
    const name = extractName(text, spec);
    const bands = extractBands(text);
    const modeList = Array.isArray(modes) ? modes : [modes];
    const periodResult = extractPeriods(text, year, modeList[0]);
    const periodYear = Array.isArray(periodResult.periods) && periodResult.periods[0]
        ? Number(periodResult.periods[0].start.slice(0, 4)) : year;
    const qsoPoints = extractQsoPoints(text, spec.family);
    const multiplierCounting = extractMultiplierCounting(text, spec.family);
    const categoryResult = extractCategories(text, spec.family);
    const unknowns = [];
    const record = (field, reason) => unknowns.push({field, reason, source: url});
    if (year === UNKNOWN) record('year', 'no four-digit year on the page');
    else if (periodYear !== year) year = periodYear;
    if (bands === UNKNOWN) record('bands', 'no band list matched');
    if (qsoPoints === UNKNOWN) record('qsoPoints', 'point table not matched');
    if (multiplierCounting === UNKNOWN) record('multiplierCounting', 'multiplier rule not matched');
    for (const item of categoryResult.unknowns) {
        unknowns.push({...item, source: url});
    }
    return {
        family: spec.family,
        name,
        year,
        bands,
        modes: modeList,
        periods: periodResult.periods,
        periodNote: periodResult.note || null,
        qsoPoints,
        multiplierCounting,
        categories: categoryResult.categories,
        sourceUrl: url,
        fetchedAt,
        textLength: text.length,
        unknowns
    };
}

// -------------------------------------------------------------- aggregation
function isUnknown(value) {
    return value === UNKNOWN || (value && value.value === UNKNOWN);
}

export function mergeFamily(spec, results, fetchedAt) {
    const valid = results.filter(item => item && item.textLength > 200);
    const unknowns = [];
    const categories = {};
    const periods = [];
    const modes = new Set();
    let name = UNKNOWN;
    let year = UNKNOWN;
    let bands = UNKNOWN;
    let qsoPoints = UNKNOWN;
    let multiplierCounting = UNKNOWN;

    for (const item of valid) {
        for (const mode of item.modes || []) modes.add(mode);
        if (name === UNKNOWN && item.name !== UNKNOWN) name = item.name;
        if (year === UNKNOWN && item.year !== UNKNOWN) year = item.year;
        if (bands === UNKNOWN && item.bands !== UNKNOWN) bands = item.bands;
        if (qsoPoints === UNKNOWN && item.qsoPoints !== UNKNOWN) qsoPoints = item.qsoPoints;
        if (multiplierCounting === UNKNOWN && item.multiplierCounting !== UNKNOWN) {
            multiplierCounting = item.multiplierCounting;
        }
        if (Array.isArray(item.periods)) periods.push(...item.periods);
        for (const [key, value] of Object.entries(item.categories || {})) {
            if (!categories[key]) {
                categories[key] = value;
                continue;
            }
            const current = categories[key];
            // Prefer a value with fewer unknowns; never overwrite a known value
            // with an unknown one.
            if (isUnknown(current.simultaneousSignals) && !isUnknown(value.simultaneousSignals)) {
                current.simultaneousSignals = value.simultaneousSignals;
            }
            if (isUnknown(current.bandChange) && !isUnknown(value.bandChange)) {
                current.bandChange = value.bandChange;
            }
        }
        unknowns.push(...(item.unknowns || []));
    }

    if (!valid.length) {
        unknowns.push({field: '*', reason: 'all sources failed or returned no rules text'});
    }
    return {
        family: spec.family,
        name,
        year,
        modes: [...modes],
        bands,
        periods: periods.length ? periods : UNKNOWN,
        qsoPoints,
        multiplierCounting,
        categories,
        simultaneousSignals: categories.MM && categories.MM.simultaneousSignals !== UNKNOWN
            ? categories.MM.simultaneousSignals : UNKNOWN,
        sources: spec.sources.map((source, index) => ({
            url: source.url,
            modes: source.modes || [source.mode],
            fetchedAt: results[index] ? results[index].fetchedAt : fetchedAt,
            ok: Boolean(results[index] && results[index].textLength > 200)
        })),
        generatedAt: fetchedAt,
        unknowns
    };
}

// ---------------------------------------------------------------- validation
export function validateRules(doc) {
    const errors = [];
    if (!doc || typeof doc !== 'object') errors.push('document is not an object');
    if (!doc || doc.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
    const contests = doc && doc.contests;
    if (!contests || typeof contests !== 'object') errors.push('contests is missing');
    for (const family of FAMILIES) {
        const entry = contests && contests[family];
        if (!entry) {
            errors.push(`${family}: missing`);
            continue;
        }
        if (!Array.isArray(entry.sources) || !entry.sources.length) errors.push(`${family}: no sources`);
        if (!entry.name) errors.push(`${family}: no name`);
        if (!Array.isArray(entry.modes) || !entry.modes.length) errors.push(`${family}: no modes`);
        if (!entry.categories || typeof entry.categories !== 'object') errors.push(`${family}: no categories`);
        if (entry.bands !== UNKNOWN && !Array.isArray(entry.bands)) errors.push(`${family}: bands must be an array or unknown`);
        if (entry.periods !== UNKNOWN && !Array.isArray(entry.periods)) errors.push(`${family}: periods must be an array or unknown`);
    }
    const extra = Object.keys(contests || {}).filter(key => !FAMILIES.includes(key));
    if (extra.length) errors.push(`unexpected families: ${extra.join(',')}`);
    return errors;
}

export function diffRules(previous, next) {
    const out = [];
    const before = previous && previous.contests || {};
    const after = next && next.contests || {};
    for (const family of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!before[family]) out.push(`+ ${family}`);
        else if (!after[family]) out.push(`- ${family}`);
        else if (JSON.stringify(before[family]) !== JSON.stringify(after[family])) out.push(`~ ${family}`);
        else out.push(`= ${family}`);
    }
    const unknownCount = Object.values(after).reduce((sum, entry) =>
        sum + (Array.isArray(entry.unknowns) ? entry.unknowns.length : 0), 0);
    return {lines: out, unknownCount};
}

// -------------------------------------------------------------------- fetch
async function fetchText(url, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml'}
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
    } finally {
        clearTimeout(timer);
    }
}

function readPrevious() {
    try {
        return JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    } catch {
        return null;
    }
}

function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const strict = args.has('--strict');
    const dryRun = args.has('--dry-run');
    const fetchedAt = new Date().toISOString();
    const contests = {};

    for (const spec of SPECS) {
        const results = [];
        for (const source of spec.sources) {
            const sourceModes = source.modes || [source.mode];
            try {
                const html = await fetchText(source.url);
                results.push(extractSource(spec, sourceModes, html, source.url, fetchedAt));
                console.log(`fetched ${spec.family} ${sourceModes.join('/')}: ${source.url}`);
            } catch (error) {
                console.warn(`failed ${spec.family} ${sourceModes.join('/')}: ${source.url} (${error.message})`);
                results.push(null);
            }
        }
        contests[spec.family] = mergeFamily(spec, results, fetchedAt);
    }

    const next = {schemaVersion: SCHEMA_VERSION, generatedAt: fetchedAt, contests};
    const errors = validateRules(next);
    if (errors.length) {
        console.error('rules validation failed:');
        errors.forEach(error => console.error(`  - ${error}`));
        console.error('file not written');
        process.exitCode = 1;
        return;
    }

    const previous = readPrevious();
    const {lines, unknownCount} = diffRules(previous, next);
    console.log('diff:');
    lines.forEach(line => console.log(`  ${line}`));
    console.log(`unknown fields: ${unknownCount}`);

    if (strict && unknownCount > 0) {
        console.error('--strict: unknown fields present, file not written');
        process.exitCode = 2;
        return;
    }
    if (dryRun) {
        console.log('--dry-run: file not written');
        return;
    }
    writeAtomic(OUTPUT, JSON.stringify(next, null, 2) + '\n');
    console.log(`wrote ${path.relative(ROOT, OUTPUT)}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
