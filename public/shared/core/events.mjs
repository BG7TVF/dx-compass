/**
 * Lightweight event emitter. Input: event names and listeners.
 * Output: unsubscribe functions and listener counts; emits synchronously.
 */
export function createEmitter() {
    const listeners = new Map();
    const on = (name, listener) => {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function');
        let set = listeners.get(name);
        if (!set) listeners.set(name, set = new Set());
        set.add(listener);
        return () => off(name, listener);
    };
    const off = (name, listener) => {
        const set = listeners.get(name);
        if (!set) return false;
        const removed = set.delete(listener);
        if (!set.size) listeners.delete(name);
        return removed;
    };
    const once = (name, listener) => {
        let unsubscribe;
        unsubscribe = on(name, (...args) => {
            unsubscribe();
            listener(...args);
        });
        return unsubscribe;
    };
    const emit = (name, ...args) => {
        const set = listeners.get(name);
        if (!set) return 0;
        const snapshot = [...set];
        snapshot.forEach(listener => listener(...args));
        return snapshot.length;
    };
    const clear = name => {
        if (name === undefined) listeners.clear();
        else listeners.delete(name);
    };
    return {on, off, once, emit, clear};
}
