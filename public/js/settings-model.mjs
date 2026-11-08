import {TILE_PROVIDERS} from '../shared/map/base-map.mjs';
import {isValidMaidenhead} from '../shared/geo/maidenhead.mjs';

export const DEFAULT_BAND_COLORS = {
    '160m': '#b565d8', '80m': '#e67e22', '60m': '#fd79a8', '40m': '#f1c40f',
    '30m': '#1abc9c', '20m': '#00e5ff', '17m': '#3498db', '15m': '#9b59b6',
    '12m': '#e84393', '10m': '#e17055', '6m': '#dfe6e9', '2m': '#55efc4'
};
export const DEFAULT_TTL_MIN = {CW: 30, SSB: 30, DIGI: 30};
export const CONTEST_CATEGORIES = ['SO1R', 'SO2R', 'MS', 'MM'];
export const THEMES = ['dark', 'light', 'ocean', 'amber'];
export const WALL_LAYERS = ['prop', 'aurora', 'weather', 'qso', 'myspot', 'dxspot'];
export const WALL_CHECKS = {
    prop: '#setWallProp', aurora: '#setWallAurora', weather: '#setWallWeather',
    qso: '#setWallQso', myspot: '#setWallMySpot', dxspot: '#setWallDxSpot'
};
export const UI_LANGUAGES = ['zh', 'en', 'de', 'fr', 'es', 'pt', 'ru', 'it', 'ar', 'ko', 'ja'];
const BAND_METERS = [160, 80, 60, 40, 30, 20, 17, 15, 12, 10, 6, 4, 2];

export function defaultSettings() {
    return {
        lang: 'zh', theme: 'dark', tiles: 'osm', grid: '', layout: '1x1', myCall: '',
        wallTitle: 'DX-COMPASS', wallMode: 'all',
        wallLayers: ['prop', 'qso', 'myspot', 'dxspot'],
        wallTimerOn: false, wallTimerStart: '', wallTimerEnd: '',
        category: 'SO1R', qsoMax: 1500, qsoLines: true, qsoAutoFit: true,
        qsoSpotAlert: true, qsoVoiceAlert: true,
        mySpotTtl: 30, mySpotMax: 300, mySpotPopup: true, mySpotVoice: true,
        propProj: 'robinson', propLayer: 'muf', propDxLat: 40, propDxLon: -100,
        cfgV: 2,
        ttl: {...DEFAULT_TTL_MIN}, bandColors: {...DEFAULT_BAND_COLORS}
    };
}

/** Whitelist both local-cache and server settings; unknown or invalid values use defaults. */
export function sanitizeSettings(input, {languages = UI_LANGUAGES} = {}) {
    const d = defaultSettings();
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (languages.includes(raw.lang)) d.lang = raw.lang;
    if (THEMES.includes(raw.theme)) d.theme = raw.theme;
    if (TILE_PROVIDERS[raw.tiles]) d.tiles = raw.tiles;
    if (isValidMaidenhead(raw.grid)) d.grid = String(raw.grid).toUpperCase();
    if (typeof raw.myCall === 'string') {
        const call = raw.myCall.trim().toUpperCase();
        if (call === '' || /^[A-Z0-9/]{3,12}$/.test(call)) d.myCall = call;
    }
    if (['1x1', '2x2', '3x3'].includes(raw.layout)) d.layout = raw.layout;
    if (CONTEST_CATEGORIES.includes(raw.category)) d.category = raw.category;
    const qsoMax = parseInt(raw.qsoMax, 10);
    if (qsoMax >= 200 && qsoMax <= 4000) d.qsoMax = qsoMax;
    for (const key of ['qsoLines', 'qsoAutoFit', 'qsoSpotAlert', 'qsoVoiceAlert',
        'mySpotPopup', 'mySpotVoice', 'wallTimerOn']) {
        if (typeof raw[key] === 'boolean') d[key] = raw[key];
    }
    const mySpotTtl = parseInt(raw.mySpotTtl, 10);
    if (mySpotTtl >= 1 && mySpotTtl <= 180) d.mySpotTtl = mySpotTtl;
    const mySpotMax = parseInt(raw.mySpotMax, 10);
    if (mySpotMax >= 10 && mySpotMax <= 2000) d.mySpotMax = mySpotMax;
    if (['mercator', 'azimuthal', 'robinson'].includes(raw.propProj)) d.propProj = raw.propProj;
    d.cfgV = 2;
    if (parseInt(raw.cfgV, 10) !== 2 && d.propProj === 'mercator') d.propProj = 'robinson';
    if (['muf', 'weather', 'aurora'].includes(raw.propLayer)) d.propLayer = raw.propLayer;
    if (typeof raw.wallTitle === 'string') {
        d.wallTitle = raw.wallTitle.trim().slice(0, 24) || 'DX-COMPASS';
    }
    if (Array.isArray(raw.wallLayers)) {
        d.wallLayers = WALL_LAYERS.filter(key => raw.wallLayers.includes(key));
    }
    if (['all', 'cycle'].includes(raw.wallMode)) d.wallMode = raw.wallMode;
    const dateTime = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(value || '')) ? value : '';
    d.wallTimerStart = dateTime(raw.wallTimerStart);
    d.wallTimerEnd = dateTime(raw.wallTimerEnd);
    const dxLat = parseFloat(raw.propDxLat), dxLon = parseFloat(raw.propDxLon);
    if (Number.isFinite(dxLat) && Math.abs(dxLat) <= 85) d.propDxLat = dxLat;
    if (Number.isFinite(dxLon) && Math.abs(dxLon) <= 180) d.propDxLon = dxLon;
    for (const mode of Object.keys(d.ttl)) {
        const value = parseInt(raw.ttl && raw.ttl[mode], 10);
        if (value >= 1 && value <= 180) d.ttl[mode] = value;
    }
    if (raw.bandColors && typeof raw.bandColors === 'object') {
        for (const band of Object.keys(d.bandColors)) {
            if (/^#[0-9a-fA-F]{6}$/.test(raw.bandColors[band] || '')) {
                d.bandColors[band] = raw.bandColors[band];
            }
        }
    }
    return d;
}

export function loadLocalSettings(storage = globalThis.localStorage, languages) {
    try {
        return sanitizeSettings(JSON.parse(storage.getItem('dxcompass-settings') || '{}'), {languages});
    } catch {
        return defaultSettings();
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
    if (BAND_METERS.includes(Math.round(value))) return `${Math.round(value)}M`;
    const meters = 300 / value;
    const best = BAND_METERS.reduce((a, b) => Math.abs(b - meters) < Math.abs(a - meters) ? b : a);
    return `${best}M`;
}

export function dbRowToQso(row) {
    return {
        type: 'qso', n1mmId: row.n1mm_id, ts: row.timestamp, mycall: row.mycall,
        operator: row.operator, call: row.call, band: row.band, freqKhz: row.freq_khz,
        mode: row.mode, rstSnt: row.rst_snt, rstRcv: row.rst_rcv, exchange: row.exchange,
        points: row.points, isMult: Boolean(row.is_mult), lat: row.lat, lon: row.lon
    };
}
