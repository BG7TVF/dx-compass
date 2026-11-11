/**
 * Browser-side settings facade. All defaults, ranges, scopes and migration
 * rules live in ../../shared/settings/schema.js so the Node-RED backend and
 * the browser validate against exactly the same table.
 */
import '../shared/settings/schema.js';

export const SETTINGS_SCHEMA = globalThis.DXSettingsSchema;

export const DEFAULT_BAND_COLORS = SETTINGS_SCHEMA.DEFAULT_BAND_COLORS;
export const DEFAULT_TTL_MIN = SETTINGS_SCHEMA.DEFAULT_TTL_MIN;
export const CONTEST_CATEGORIES = SETTINGS_SCHEMA.CONTEST_CATEGORIES;
export const THEMES = SETTINGS_SCHEMA.THEMES;
export const WALL_LAYERS = SETTINGS_SCHEMA.WALL_LAYERS;
export const UI_LANGUAGES = SETTINGS_SCHEMA.UI_LANGUAGES;
export const SETTINGS_FIELDS = SETTINGS_SCHEMA.FIELDS;
export const SETTINGS_DOMAINS = SETTINGS_SCHEMA.DOMAINS;
export const SETTINGS_VERSION = SETTINGS_SCHEMA.SCHEMA_VERSION;
export const WALL_CHECKS = {
    prop: '#setWallProp', aurora: '#setWallAurora', weather: '#setWallWeather',
    qso: '#setWallQso', myspot: '#setWallMySpot', dxspot: '#setWallDxSpot'
};

/** Browser-local keys that intentionally stay outside /api/settings. */
export const LOCAL_SETTING_KEYS = {
    rotationSec: {storageKey: 'dxcompass-rot-sec', type: 'int'}
};

export function defaultSettings() {
    return SETTINGS_SCHEMA.defaultSettings();
}

export function defaultsForDomain(domain) {
    return SETTINGS_SCHEMA.defaultsForDomain(domain);
}

/** Whitelist local-cache and server settings; invalid values fall back to defaults. */
export function sanitizeSettings(input, {languages = UI_LANGUAGES} = {}) {
    return SETTINGS_SCHEMA.sanitize(input, {enums: {lang: languages}}).settings;
}

/** Validate a partial patch: only the supplied keys are checked and returned. */
export function validateSettingsPatch(patch, {languages = UI_LANGUAGES} = {}) {
    return SETTINGS_SCHEMA.validatePatch(patch, {enums: {lang: languages}});
}

export function mergeSettings(base, patch) {
    return SETTINGS_SCHEMA.mergeDeep(base || {}, patch || {});
}

export function loadLocalSettings(storage = globalThis.localStorage, languages) {
    try {
        return sanitizeSettings(JSON.parse(storage.getItem('dxcompass-settings') || '{}'), {languages});
    } catch {
        return defaultSettings();
    }
}

/** Read the settings that are deliberately browser-local (rotation). */
export function readLocalExtras(storage = globalThis.localStorage) {
    const field = SETTINGS_SCHEMA.FIELD_MAP.rotationSec;
    const rotationRaw = parseInt(storage.getItem(LOCAL_SETTING_KEYS.rotationSec.storageKey), 10);
    const checked = SETTINGS_SCHEMA.validateValue(field, rotationRaw);
    return {
        rotationSec: checked.ok ? checked.value : field.default
    };
}

/** Write only the local extras that were provided; other keys are left untouched. */
export function writeLocalExtras(values, storage = globalThis.localStorage) {
    if (!values || typeof values !== 'object') return;
    if (Number.isInteger(values.rotationSec)) {
        storage.setItem(LOCAL_SETTING_KEYS.rotationSec.storageKey, String(values.rotationSec));
    }
}

export function ttlForMode(settings, mode) {
    const key = String(mode || '').toUpperCase();
    const minutes = settings.ttl[key] !== undefined ? settings.ttl[key] : settings.ttl.SSB;
    return minutes * 60000;
}

export function bandColorOf(settings, band) {
    let key = String(band || '').toLowerCase();
    if (/^\d+$/.test(key)) key += 'm';
    return settings.bandColors[key] || '#00e5ff';
}

export function bandLabel(band, freqKhz) {
    let value = parseFloat(String(band || '').replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
        value = typeof freqKhz === 'number' ? freqKhz / 1000 : 0;
        if (!value) return '';
    }
    if (SETTINGS_SCHEMA.BAND_METERS.includes(Math.round(value))) return `${Math.round(value)}M`;
    const meters = 300 / value;
    const best = SETTINGS_SCHEMA.BAND_METERS.reduce((a, b) => Math.abs(b - meters) < Math.abs(a - meters) ? b : a);
    return `${best}M`;
}

export function dbRowToQso(row) {
    return {
        type: 'qso', n1mmId: row.n1mm_id, ts: row.timestamp, mycall: row.mycall,
        operator: row.operator, call: row.call, band: row.band, freqKhz: row.freq_khz,
        mode: row.mode, rstSnt: row.rst_snt, rstRcv: row.rst_rcv, exchange: row.exchange,
        points: row.points, isMult: Boolean(row.is_mult), lat: row.lat, lon: row.lon,
        radioNr: row.radionr === undefined ? null : row.radionr,
        stationName: row.stationname === undefined ? null : row.stationname
    };
}
