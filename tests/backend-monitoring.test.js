'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const monitoring = require('../lib/monitoring');
const recording = require('../lib/monitoring/recording.js');

class Context {
    constructor(values = {}) { this.values = {...values}; }
    get(key) { return this.values[key]; }
    set(key, value) { this.values[key] = value; }
}

test('monitoring aggregates tabs, prunes stale clients and retains __legacy heartbeat semantics', () => {
    const ctx = new Context();
    const now = Date.parse('2026-11-08T12:00:00Z');
    assert.equal(monitoring.setClient(ctx, {on: true, client: 'a'}, now).monitoring, true);
    assert.equal(monitoring.setClient(ctx, {on: true, client: 'b'}, now).clients, 2);
    assert.equal(monitoring.setClient(ctx, {on: false, client: 'a'}, now + 1000).monitoring, true);
    const legacy = monitoring.setClient(ctx, {on: true}, now + 2000);
    assert.equal(legacy.clients, 3);
    const pruned = monitoring.setClient(ctx, {on: false, client: 'b'}, now + 124000);
    assert.equal(pruned.monitoring, true);
    assert.equal(pruned.clients, 2);
    assert.ok(ctx.get('monitorClients').__legacy);
    assert.equal(ctx.get('monitorClients').a, undefined);
});

test('recording rejects malformed schedule input without changing state', () => {
    const ctx = new Context();
    const result = recording.control(ctx, {action: 'schedule', start: '2026-11-08', end: 'bad'});
    assert.equal(result.statusCode, 400);
    assert.equal(result.payload.success, false);
    assert.equal(ctx.get('recording'), undefined);
    assert.equal(recording.control(ctx, {action: 'unknown'}).payload.error, 'unknown action');
});

test('UTC scheduler starts in a window, recovers after restart and stops at end', () => {
    const ctx = new Context();
    recording.control(ctx, {action: 'schedule', start: '11-08 12:00', end: '11-08 13:00'},
        new Date('2026-11-08T10:00:00Z'));
    recording.tick(ctx, new Date('2026-11-08T12:30:00Z'));
    assert.equal(ctx.get('recording').active, true);
    assert.equal(ctx.get('recording').startedAt, '2026-11-08T12:30:00.000Z');
    const stopped = recording.tick(ctx, new Date('2026-11-08T13:01:00Z'));
    assert.deepEqual(stopped.warnings, ['Recording stopped (scheduled end)']);
    assert.equal(ctx.get('recording').active, false);
    assert.equal(ctx.get('recording').schedule, null);
});

test('UTC schedule rolls over year end and manual sessions are not auto-stopped', () => {
    const ctx = new Context();
    recording.control(ctx, {action: 'schedule', start: '12-31 23:50', end: '01-01 00:10'},
        new Date('2026-12-01T00:00:00Z'));
    recording.tick(ctx, new Date('2026-12-31T23:55:00Z'));
    assert.equal(ctx.get('recording').active, true);
    const manual = new Context({recording: {active: true, manual: true,
        schedule: {start: '11-08 10:00', end: '11-08 11:00'}}});
    recording.tick(manual, new Date('2026-11-08T12:00:00Z'));
    assert.equal(manual.get('recording').active, true);
});

test('recording rows use UTC date/time and retain CW and DIGI detail', () => {
    const base = {timestamp: '2026-11-08T23:01:02.000Z', monitored_call: 'K1', de: 'DE1',
        band: '20m', freq: 14074, mode: 'CW', comment: 'CW 27 WPM', snr: 10,
        signal: null, distance_km: 100};
    const cw = recording.prepareSpot(base, {active: true});
    assert.equal(cw.date, '2026-11-08');
    assert.equal(cw.time, '23:01:02');
    assert.equal(cw.detail, '27 WPM');
    const digi = recording.prepareSpot({...base, mode: 'DIGI', comment: 'PSKR FT8 -10 dB'}, {active: true});
    assert.equal(digi.detail, 'FT8');
    assert.equal(recording.prepareSpot(base, {active: false}), null);
});
