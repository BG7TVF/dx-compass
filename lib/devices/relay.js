'use strict';

/**
 * 继电器干接点输出（Phase 4/5）。
 *
 * 不绑定任何品牌或型号：每个设备自己配置一个 HTTP 端点，软件只按
 * 通道号发出「脉冲 / 吸合 / 释放」三种抽象动作，具体接线由现场决定。
 *
 * 请求契约（POST <relay_url>，JSON）：
 *   {"channel": 3, "action": "pulse", "pulse_ms": 400}
 *   {"channel": 3, "action": "on"}
 *   {"channel": 3, "action": "off"}
 * 可选请求头：X-Relay-Token: <relay_token>
 */

const DEFAULT_PULSE_MS = 400;
const REQUEST_TIMEOUT_MS = 2000;
const MIN_PULSE_MS = 50;
const MAX_PULSE_MS = 5000;

function defaultFetch(...args) {
    return globalThis.fetch(...args);
}

let fetchImpl = defaultFetch;

function setFetchFactory(fn) {
    fetchImpl = typeof fn === 'function' ? fn : defaultFetch;
}

function reset() {
    fetchImpl = defaultFetch;
}

function relayUrl(device) {
    const url = device && device.config ? device.config.relay_url : '';
    return typeof url === 'string' ? url.trim() : '';
}

function channelOk(channel) {
    return Number.isInteger(channel) && channel >= 0 && channel <= 255;
}

function pulseMsOf(device, override) {
    const candidate = Number(override !== undefined && override !== null && override !== ''
        ? override
        : (device && device.config ? device.config.pulse_ms : NaN));
    if (!Number.isFinite(candidate)) return DEFAULT_PULSE_MS;
    return Math.min(MAX_PULSE_MS, Math.max(MIN_PULSE_MS, Math.round(candidate)));
}

async function post(device, payload) {
    const url = relayUrl(device);
    if (!url) return {ok: false, status: 400, error: 'transport-not-configured'};
    if (/^http:\/\//i.test(url) === false && /^https:\/\//i.test(url) === false) {
        return {ok: false, status: 400, error: 'transport-not-configured'};
    }

    const headers = {'Content-Type': 'application/json'};
    const token = device && device.config ? device.config.relay_token : '';
    if (token) headers['X-Relay-Token'] = String(token);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = controller
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, REQUEST_TIMEOUT_MS)
        : null;

    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller ? controller.signal : undefined
        });
        if (!response || response.ok === false) {
            return {
                ok: false,
                status: 502,
                error: 'transport-error',
                detail: 'HTTP ' + (response && response.status)
            };
        }
        return {ok: true, dispatched: true};
    } catch (error) {
        if (timedOut) return {ok: false, status: 504, error: 'transport-timeout'};
        return {
            ok: false,
            status: 502,
            error: 'transport-connect',
            detail: String((error && error.message) || error)
        };
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

/** 点动脉冲：切换器与塔启动都走这里。 */
function pulse(device, channel, overrideMs) {
    if (!channelOk(channel)) return Promise.resolve({ok: false, status: 400, error: 'unknown-channel'});
    return post(device, {channel, action: 'pulse', pulse_ms: pulseMsOf(device, overrideMs)});
}

/** 持续吸合 / 释放：塔的按住运行用。 */
function setState(device, channel, on) {
    if (!channelOk(channel)) {
        return Promise.resolve({ok: false, status: 400, error: 'unknown-channel'});
    }
    return post(device, {channel, action: on ? 'on' : 'off'});
}

function on(device, channel) {
    return setState(device, channel, true);
}

function off(device, channel) {
    return setState(device, channel, false);
}

module.exports = {
    DEFAULT_PULSE_MS,
    REQUEST_TIMEOUT_MS,
    MIN_PULSE_MS,
    MAX_PULSE_MS,
    setFetchFactory,
    reset,
    pulseMsOf,
    pulse,
    setState,
    on,
    off
};
