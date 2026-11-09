/**
 * Settings repository for /api/settings.
 * - Full writes stay compatible with older clients (plain settings object).
 * - Partial writes send {__patch} so one field change never wipes another domain.
 * - Browser-local layout is excluded from writes unless explicitly requested.
 */
import {getJson, postJson} from '../core/transport.mjs';

const defaultTransport = {getJson, postJson};

export async function getSettings({transport = defaultTransport, ...options} = {}) {
    const data = await transport.getJson('/api/settings', options);
    return data && data.settings && typeof data.settings === 'object' ? data.settings : null;
}

export async function saveSettings(settings, {
    transport = defaultTransport,
    includeLayout = false,
    ...options
} = {}) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new TypeError('settings must be an object');
    }
    const body = {...settings};
    if (!includeLayout) delete body.layout;
    return transport.postJson('/api/settings', body, options);
}

/** Send only the changed keys; the server merges them into the stored settings. */
export async function saveSettingsPatch(patch, {
    transport = defaultTransport,
    includeLayout = false,
    ...options
} = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('settings patch must be an object');
    }
    const body = {...patch};
    if (!includeLayout) delete body.layout;
    return transport.postJson('/api/settings/patch', {__patch: body}, options);
}

/** Reset one domain (ui/map/qso/wall/data/prop) or all of them. */
export async function resetSettingsDomain(domain, {transport = defaultTransport, ...options} = {}) {
    return transport.postJson('/api/settings/reset', {domain}, options);
}

/** Return a settings broadcast unchanged, or null for another WS message type. */
export function settingsFromMessage(message) {
    return message && message.type === 'settings' && message.settings &&
        typeof message.settings === 'object' ? message.settings : null;
}
