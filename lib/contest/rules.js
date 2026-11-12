'use strict';

/**
 * Read the shared contest rules JSON produced by scripts/fetch-contest-rules.mjs.
 * The file is the default source for contest constraints; user settings remain
 * the higher-priority override in lib/advice/engine.js.
 */

const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, '..', '..', 'public', 'shared', 'contest', 'rules.json');

const FAMILY_BY_TYPE = {
    CQWW: 'CQWW',
    CQWPX: 'CQWPX',
    CQWW_RTTY: 'CQWW_RTTY',
    ARRL_DX: 'ARRL_DX',
    IARU: 'IARU',
    CQ160: 'CQ160',
    WAE: 'WAE'
};

/* Contest types without a structured rules entry. The decision engine must fall
 * back to the operator's settings and config defaults for these, and callers can
 * see that explicitly through describe() instead of guessing from null values. */
const UNSTRUCTURED_TYPES = new Set(['OTHER', 'AUTO']);

let cache = null;

function load() {
    if (cache) return cache;
    try {
        const raw = fs.readFileSync(RULES_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        cache = parsed && typeof parsed === 'object' ? parsed : {schemaVersion: 1, contests: {}};
    } catch (error) {
        cache = {schemaVersion: 1, contests: {}, error: error.message};
    }
    return cache;
}

function reload() {
    cache = null;
    return load();
}

function familyOf(type) {
    return FAMILY_BY_TYPE[String(type || '').toUpperCase()] || null;
}

function known(value) {
    return value !== undefined && value !== null && value !== 'unknown';
}

/**
 * Explain how a contest type is resolved. `structured: false` means there is no
 * rules.json entry and the caller must use settings + config defaults; it is
 * never a silent fallback.
 */
function describe(type) {
    const normalized = String(type || '').toUpperCase();
    if (UNSTRUCTURED_TYPES.has(normalized)) {
        return {
            type: normalized,
            family: null,
            structured: false,
            fallback: 'settings-config',
            reason: normalized === 'AUTO'
                ? 'automatic contest detection has no structured rule set'
                : 'generic contest has no structured rule set'
        };
    }
    const family = familyOf(normalized);
    if (!family) {
        return {
            type: normalized,
            family: null,
            structured: false,
            fallback: 'settings-config',
            reason: 'contest type is not mapped to a rules family'
        };
    }
    const entry = load().contests ? load().contests[family] : null;
    if (!entry) {
        return {
            type: normalized,
            family,
            structured: false,
            fallback: 'settings-config',
            reason: `rules.json has no entry for ${family}`
        };
    }
    return {
        type: normalized,
        family,
        structured: true,
        fallback: null,
        reason: null,
        generatedAt: entry.generatedAt || null
    };
}

function constraintsFor(settings, type) {
    const contest = load();
    const family = familyOf(type);
    const entry = family && contest.contests ? contest.contests[family] : null;
    const categoryKey = String((settings && settings.category) || 'SO1R').toUpperCase();
    const category = entry && entry.categories ? entry.categories[categoryKey] : null;
    return {
        family,
        available: Boolean(entry),
        structured: Boolean(entry),
        fallback: entry ? null : 'settings-config',
        multiplierCounting: entry && known(entry.multiplierCounting) ? entry.multiplierCounting : null,
        bands: entry && Array.isArray(entry.bands) ? entry.bands : null,
        modes: entry && Array.isArray(entry.modes) ? entry.modes : null,
        simultaneousSignals: category && known(category.simultaneousSignals) ? category.simultaneousSignals : null,
        category: category || null,
        bandChange: category && known(category.bandChange) ? category.bandChange : null,
        multiplierStationRole: category && known(category.multiplierStationRole)
            ? category.multiplierStationRole : null,
        source: entry && Array.isArray(entry.sources) && entry.sources[0] ? entry.sources[0].url : null,
        generatedAt: entry ? entry.generatedAt || null : null
    };
}

module.exports = {
    RULES_PATH,
    UNSTRUCTURED_TYPES,
    load,
    reload,
    familyOf,
    describe,
    constraintsFor
};
