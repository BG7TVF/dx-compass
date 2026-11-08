import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoller} from '../public/shared/monitoring/poller.mjs';
import {
    createMonitoringClient,
    HEARTBEAT_MS,
    SERVER_PRUNE_MS
} from '../public/shared/monitoring/client.mjs';

function fakeTimers() {
    let nextId = 0;
    const jobs = new Map();
    return {
        jobs,
        set(fn) { jobs.set(++nextId, fn); return nextId; },
        clear(id) { jobs.delete(id); }
    };
}

test('poller is idempotent, non-reentrant and schedules after settlement', async () => {
    const timers = fakeTimers();
    let calls = 0;
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const poller = createPoller(() => {
        calls += 1;
        return waiting;
    }, {
        intervalMs: 1000,
        setTimeoutImpl: timers.set,
        clearTimeoutImpl: timers.clear
    });
    poller.start();
    poller.start();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(poller.pending, true);
    const first = poller.run();
    assert.strictEqual(poller.run(), first);
    assert.equal(timers.jobs.size, 0);
    release('done');
    assert.equal(await first, 'done');
    assert.equal(poller.pending, false);
    assert.equal(timers.jobs.size, 1);
    poller.stop();
    assert.equal(timers.jobs.size, 0);
    assert.equal(poller.running, false);
});

test('poller reports callback errors and can run again', async () => {
    let calls = 0;
    const errors = [];
    const poller = createPoller(() => {
        calls += 1;
        if (calls === 1) throw new Error('expected');
        return 'ok';
    }, {immediate: false, onError: error => errors.push(error.message)});
    poller.start();
    assert.equal(poller.running, true);
    poller.stop();
    assert.equal(await poller.run(), undefined);
    assert.equal(await poller.run(), 'ok');
    assert.deepEqual(errors, ['expected']);
});

test('monitoring client sends 30 s heartbeat, reconnect sync and pagehide beacon', async () => {
    assert.equal(HEARTBEAT_MS, 30000);
    assert.equal(SERVER_PRUNE_MS, 120000);
    let heartbeat;
    let cleared = null;
    const listeners = new Map();
    const posts = [];
    const beacons = [];
    const transport = {
        async postJson(url, body) {
            posts.push({url, body});
            return {success: true};
        },
        sendBeacon(url, body) {
            beacons.push({url, body});
            return true;
        }
    };
    const client = createMonitoringClient({
        transport,
        clientId: 'tab-1',
        storage: null,
        eventTarget: {
            addEventListener: (name, fn) => listeners.set(name, fn),
            removeEventListener: name => listeners.delete(name)
        },
        setIntervalImpl: fn => { heartbeat = fn; return 9; },
        clearIntervalImpl: id => { cleared = id; }
    });
    await client.start(true);
    assert.deepEqual(posts[0], {
        url: '/api/monitoring', body: {on: true, client: 'tab-1'}
    });
    heartbeat();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posts.length, 2);
    await client.handleOpen();
    assert.equal(posts.length, 3);
    assert.equal(listeners.get('pagehide')(), true);
    assert.deepEqual(beacons[0], {
        url: '/api/monitoring', body: {on: false, client: 'tab-1'}
    });
    await client.set(false);
    assert.equal(posts.at(-1).body.on, false);
    client.destroy();
    assert.equal(cleared, 9);
    assert.equal(listeners.has('pagehide'), false);
    assert.equal(beacons.length, 1);
});
