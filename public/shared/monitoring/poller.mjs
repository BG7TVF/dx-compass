/**
 * Non-reentrant async poller. Input: an async callback and interval in ms.
 * Output: {start, stop, run, running, pending}; runs share one in-flight promise
 * and the next automatic run is scheduled only after the previous one settles.
 */
export function createPoller(callback, {
    intervalMs = 30000,
    immediate = true,
    onError = () => {},
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout
} = {}) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be positive');
    let active = false;
    let timer = null;
    let inFlight = null;

    const clear = () => {
        if (timer !== null) clearTimeoutImpl(timer);
        timer = null;
    };
    const schedule = () => {
        if (!active || timer !== null) return;
        timer = setTimeoutImpl(() => {
            timer = null;
            void run();
        }, intervalMs);
    };
    const run = () => {
        if (inFlight) return inFlight;
        inFlight = Promise.resolve()
            .then(callback)
            .catch(error => {
                onError(error);
                return undefined;
            })
            .finally(() => {
                inFlight = null;
                schedule();
            });
        return inFlight;
    };
    const start = () => {
        if (active) return;
        active = true;
        if (immediate) void run();
        else schedule();
    };
    const stop = () => {
        active = false;
        clear();
    };
    return {
        start,
        stop,
        run,
        get running() { return active; },
        get pending() { return inFlight !== null; }
    };
}
