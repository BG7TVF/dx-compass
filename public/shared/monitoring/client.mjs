/**
 * Per-tab monitoring client compatible with the 30 s heartbeat / 120 s pruning protocol.
 * Input: initial on/off state and optional browser adapters. Output: server monitoring
 * responses, idempotent lifecycle methods and pagehide JSON beacons. No DOM rendering.
 */
import {postJson, sendBeacon} from '../core/transport.mjs';

export const CLIENT_STORAGE_KEY = 'dxcompass-client-id';
export const HEARTBEAT_MS = 30000;
export const SERVER_PRUNE_MS = 120000;
const defaultTransport = {postJson, sendBeacon};

export function createClientId(storage = globalThis.sessionStorage) {
    try {
        const saved = storage && storage.getItem(CLIENT_STORAGE_KEY);
        if (saved) return saved;
        const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        if (storage) storage.setItem(CLIENT_STORAGE_KEY, id);
        return id;
    } catch {
        return `c${Math.random().toString(36).slice(2)}`;
    }
}

export function createMonitoringClient({
    transport = defaultTransport,
    storage = globalThis.sessionStorage,
    clientId = createClientId(storage),
    eventTarget = globalThis.window,
    heartbeatMs = HEARTBEAT_MS,
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
    onError = () => {}
} = {}) {
    let monitoring = false;
    let started = false;
    let timer = null;

    const release = () => {
        if (!monitoring) return false;
        return transport.sendBeacon('/api/monitoring', {on: false, client: clientId});
    };
    const sync = async () => {
        try {
            return await transport.postJson('/api/monitoring', {on: monitoring, client: clientId});
        } catch (error) {
            onError(error);
            return null;
        }
    };
    const start = (initialOn = false) => {
        if (started) return Promise.resolve(null);
        started = true;
        monitoring = Boolean(initialOn);
        if (eventTarget && typeof eventTarget.addEventListener === 'function') {
            eventTarget.addEventListener('pagehide', release);
        }
        timer = setIntervalImpl(() => {
            if (monitoring) void sync();
        }, heartbeatMs);
        return sync();
    };
    const set = on => {
        monitoring = Boolean(on);
        return sync();
    };
    const stop = ({beacon = false} = {}) => {
        if (timer !== null) clearIntervalImpl(timer);
        timer = null;
        if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
            eventTarget.removeEventListener('pagehide', release);
        }
        started = false;
        return beacon ? release() : false;
    };
    return {
        clientId,
        start,
        set,
        sync,
        handleOpen: sync,
        stop,
        destroy: () => stop({beacon: true}),
        get monitoring() { return monitoring; },
        get started() { return started; }
    };
}
