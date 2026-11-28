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

/* 按模式的标记存活时长只有一个实现，放在 shared/map/marker-life.mjs：
 * OP 视图和大屏的地图也要问同一个地方要 TTL，不能各算各的。 */
export {ttlForMode} from '../shared/map/marker-life.mjs';

export function bandColorOf(settings, band) {
    const key = normalizeBand(band).toLowerCase();
    return settings.bandColors[key] || '#00e5ff';
}

/* 频率 → 米波名（kHz）。与后端 lib/radio/bands.js 保持同一张表。 */
const KHZ_BANDS = [
    [1800, 2000, '160M'], [3500, 4000, '80M'], [5330, 5410, '60M'],
    [6900, 7300, '40M'], [10000, 10200, '30M'], [13950, 14350, '20M'],
    [18068, 18200, '17M'], [20950, 21450, '15M'], [24800, 25000, '12M'],
    [27900, 29700, '10M'], [49000, 54000, '6M'], [70000, 71000, '4M'],
    [143000, 148000, '2M'], [420000, 450000, '70CM']
];
const METER_BANDS = [160, 80, 60, 40, 30, 20, 17, 15, 12, 10, 6, 4, 2];
/* N1MM 的 band 字段是兆赫数值（20m=14、15m=21），这些整数必须先按 MHz 解释。 */
const MHZ_BANDS = [7, 10, 14, 18, 21, 24, 28, 50, 70, 144];
const MHZ_RANGES = [
    [0, 2, '160M'], [2, 4.6, '80M'], [4.6, 6.5, '60M'], [6.5, 8.6, '40M'],
    [8.6, 11.6, '30M'], [11.6, 16, '20M'], [16, 19.6, '17M'], [19.6, 22.6, '15M'],
    [22.6, 26.6, '12M'], [26.6, 30, '10M'], [30, 54, '6M'], [54, 76, '4M'],
    [76, 148, '2M'], [148, 470, '70CM']
];

function bandFromKhz(freqKhz) {
    const freq = Number(freqKhz);
    if (!Number.isFinite(freq) || freq <= 0) return '';
    for (const [low, high, name] of KHZ_BANDS) {
        if (freq >= low && freq <= high) return name;
    }
    return '';
}

function metersFromMhz(mhz) {
    if (!Number.isFinite(mhz) || mhz <= 0) return '';
    for (const [low, high, name] of MHZ_RANGES) {
        if (mhz >= low && mhz < high) return name;
    }
    return '';
}

/**
 * 统一波段写法，输出「米波」大写展示名（20M / 15M / 70CM）。
 * 频率可用时以频率为准；否则把 N1MM 的兆赫数值（14/21）换算成米波，
 * 纯数字米波（20/40）仍按米波解释。所有页面共用这一处，避免 15M 与 21m 并存。
 */
export function normalizeBand(band, freqKhz) {
    const byFreq = bandFromKhz(freqKhz);
    if (byFreq) return byFreq;
    const text = String(band === null || band === undefined ? '' : band).trim().toLowerCase();
    if (!text) return '';
    const cm = /^(\d+(?:\.\d+)?)\s*(?:cm|厘米)$/.exec(text);
    if (cm) return `${parseFloat(cm[1])}CM`;
    const meter = /^(\d+(?:\.\d+)?)\s*(?:m|米|meter|meters)$/.exec(text);
    if (meter) return `${parseFloat(meter[1])}M`;
    const numeric = /^(\d+(?:\.\d+)?)$/.exec(text);
    if (numeric) {
        const value = parseFloat(numeric[1]);
        if (numeric[1].includes('.')) return metersFromMhz(value) || `${value}M`;
        if (value > 160 || MHZ_BANDS.includes(value)) return metersFromMhz(value) || text.toUpperCase();
        if (METER_BANDS.includes(value)) return `${value}M`;
        return text.toUpperCase();
    }
    return text.toUpperCase();
}

export function bandLabel(band, freqKhz) {
    return normalizeBand(band, freqKhz);
}

export function dbRowToQso(row) {
    return {
        type: 'qso', n1mmId: row.n1mm_id, ts: row.timestamp, mycall: row.mycall,
        operator: row.operator, call: row.call, band: normalizeBand(row.band, row.freq_khz),
        freqKhz: row.freq_khz,
        mode: row.mode, rstSnt: row.rst_snt, rstRcv: row.rst_rcv, exchange: row.exchange,
        points: row.points, isMult: Boolean(row.is_mult), lat: row.lat, lon: row.lon,
        radioNr: row.radionr === undefined ? null : row.radionr,
        stationName: row.stationname === undefined ? null : row.stationname
    };
}
