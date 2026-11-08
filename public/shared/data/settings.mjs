/**
 * Settings repository for /api/settings. Input: existing shared settings DTO.
 * Output: the inner settings object on load and the unchanged server response on save.
 * Browser-local layout is excluded from writes unless explicitly requested.
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

/** Return a settings broadcast unchanged, or null for another WS message type. */
export function settingsFromMessage(message) {
    return message && message.type === 'settings' && message.settings &&
        typeof message.settings === 'object' ? message.settings : null;
}
