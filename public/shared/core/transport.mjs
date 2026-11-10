/**
 * Browser network boundary. Input: URLs, JSON-compatible values and WS handlers.
 * Output: parsed JSON, a reconnecting subscription, or a beacon success flag.
 * No DOM state is read or changed; implementations can be injected for tests.
 */

export class HttpError extends Error {
    constructor(response, url, body) {
        super(`HTTP ${response.status} ${response.statusText || ''}`.trim() + `: ${url}`);
        this.name = 'HttpError';
        this.status = response.status;
        this.statusText = response.statusText;
        this.url = url;
        this.body = body;
    }
}

async function requestJson(method, url, body, hasBody, options = {}) {
    const {
        timeoutMs = 15000,
        fetchImpl = globalThis.fetch,
        signal,
        headers: inputHeaders,
        ...init
    } = options;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const abort = () => controller && controller.abort(signal && signal.reason);
    if (signal && signal.aborted) abort();
    else if (signal && controller) signal.addEventListener('abort', abort, {once: true});

    let timedOut = false;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs) : null;
    const headers = new Headers(inputHeaders || {});
    const request = {...init, method, headers, cache: init.cache || 'no-store'};
    if (controller) request.signal = controller.signal;
    else if (signal) request.signal = signal;
    if (hasBody) {
        headers.set('Content-Type', 'application/json');
        request.body = JSON.stringify(body);
    }

    try {
        const response = await fetchImpl(url, request);
        const text = await response.text();
        let data = null;
        let parseError = null;
        if (text.trim()) {
            try { data = JSON.parse(text); }
            catch (error) { parseError = error; }
        }
        if (!response.ok) throw new HttpError(response, url, data === null ? text : data);
        if (parseError) {
            const error = new SyntaxError(`Invalid JSON response from ${url}`);
            error.cause = parseError;
            error.body = text;
            throw error;
        }
        return data;
    } catch (error) {
        if (timedOut) {
            const timeout = new Error(`Request timed out after ${timeoutMs} ms: ${url}`);
            timeout.name = 'TimeoutError';
            timeout.cause = error;
            throw timeout;
        }
        throw error;
    } finally {
        if (timer !== null) clearTimeout(timer);
        if (signal && controller) signal.removeEventListener('abort', abort);
    }
}

/** GET a JSON endpoint. Request options may include signal, timeoutMs and fetchImpl. */
export function getJson(url, options = {}) {
    return requestJson('GET', url, undefined, false, options);
}

/** POST a JSON value. An undefined body sends no body (for action endpoints). */
export function postJson(url, body, options = {}) {
    return requestJson('POST', url, body, body !== undefined, options);
}

/** PUT a JSON value. */
export function putJson(url, body, options = {}) {
    return requestJson('PUT', url, body, body !== undefined, options);
}

/** DELETE a resource; returns the parsed JSON body when the server sends one. */
export function deleteJson(url, options = {}) {
    return requestJson('DELETE', url, undefined, false, options);
}

/** Resolve /ws against the current page, preserving an absolute ws(s) URL. */
export function resolveWebSocketUrl(url = '/ws', locationImpl = globalThis.location) {
    if (/^wss?:\/\//i.test(url)) return url;
    if (/^https?:\/\//i.test(url)) return url.replace(/^http/i, 'ws');
    if (!locationImpl || !locationImpl.host) return url;
    const protocol = locationImpl.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${locationImpl.host}${url.startsWith('/') ? url : `/${url}`}`;
}

/**
 * Subscribe to JSON WebSocket messages with exponential reconnect.
 * Input: subscribeWS({url, onMessage, onOpen, onClose, onError, onState, ...}).
 * Output: {send, close, state, socket}; close() permanently stops reconnecting.
 */
export function subscribeWS(urlOrOptions = '/ws', handlers = {}) {
    const options = typeof urlOrOptions === 'string'
        ? {...handlers, url: urlOrOptions}
        : {...urlOrOptions};
    const {
        url = '/ws',
        protocols,
        json = true,
        reconnectDelay = 3000,
        maxReconnectDelay = 30000,
        WebSocketImpl = globalThis.WebSocket,
        locationImpl = globalThis.location,
        setTimeoutImpl = globalThis.setTimeout,
        clearTimeoutImpl = globalThis.clearTimeout,
        onMessage = () => {},
        onOpen = () => {},
        onClose = () => {},
        onError = () => {},
        onState = () => {}
    } = options;
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable');

    let active = true;
    let socket = null;
    let timer = null;
    let failures = 0;
    let state = 'disconnected';

    const setState = value => {
        state = value;
        onState(value);
    };
    const schedule = () => {
        if (!active || timer !== null) return;
        const delay = Math.min(maxReconnectDelay, reconnectDelay * (2 ** failures));
        failures += 1;
        timer = setTimeoutImpl(() => {
            timer = null;
            connect();
        }, delay);
    };
    const connect = () => {
        if (!active) return;
        setState('connecting');
        let ws;
        try {
            ws = protocols === undefined
                ? new WebSocketImpl(resolveWebSocketUrl(url, locationImpl))
                : new WebSocketImpl(resolveWebSocketUrl(url, locationImpl), protocols);
        } catch (error) {
            onError(error);
            setState('disconnected');
            schedule();
            return;
        }
        socket = ws;
        ws.onopen = event => {
            if (!active || ws !== socket) return;
            failures = 0;
            setState('connected');
            onOpen(event);
        };
        ws.onmessage = event => {
            if (!active || ws !== socket) return;
            if (!json) {
                onMessage(event.data, event);
                return;
            }
            try { onMessage(JSON.parse(event.data), event); }
            catch (error) { onError(error, event); }
        };
        ws.onerror = event => {
            if (active && ws === socket) onError(event);
        };
        ws.onclose = event => {
            if (ws !== socket) return;
            socket = null;
            onClose(event);
            if (!active) return;
            setState('disconnected');
            schedule();
        };
    };

    connect();
    return {
        send(value) {
            if (!socket || socket.readyState !== 1) return false;
            socket.send(typeof value === 'string' ? value : JSON.stringify(value));
            return true;
        },
        close(code, reason) {
            if (!active) return;
            active = false;
            if (timer !== null) clearTimeoutImpl(timer);
            timer = null;
            const ws = socket;
            socket = null;
            if (ws) {
                ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
                ws.close(code, reason);
            }
            setState('closed');
        },
        get state() { return state; },
        get socket() { return socket; }
    };
}

/** Send a JSON/plain value through navigator.sendBeacon; returns false if unavailable. */
export function sendBeacon(url, data, options = {}) {
    const {
        navigatorImpl = globalThis.navigator,
        BlobImpl = globalThis.Blob,
        contentType = 'application/json'
    } = options;
    if (!navigatorImpl || typeof navigatorImpl.sendBeacon !== 'function') return false;
    let payload = data;
    const plain = data !== null && typeof data === 'object' &&
        (Array.isArray(data) || Object.getPrototypeOf(data) === Object.prototype);
    if (plain) {
        const text = JSON.stringify(data);
        payload = typeof BlobImpl === 'function' ? new BlobImpl([text], {type: contentType}) : text;
    }
    try { return navigatorImpl.sendBeacon(url, payload); }
    catch { return false; }
}
