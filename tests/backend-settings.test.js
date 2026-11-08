'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../lib/settings');

class Context {
    constructor(values = {}) { this.values = {...values}; }
    get(k) { return this.values[k]; }
    set(k, v) { this.values[k] = v; }
}

test('settings save validates body and emits the original WS DTO', () => {
    const ctx = new Context();
    const body = {myCall: 'N0CALL', grid: 'PM95'};
    const saved = settings.save(ctx, body);
    assert.deepEqual(saved.payload, {success: true});
    assert.deepEqual(saved.broadcast, {type: 'settings', settings: body});
    assert.deepEqual(settings.get(ctx), {settings: body});
    assert.equal(settings.save(ctx, []).statusCode, 400);
    assert.deepEqual(ctx.get('uiSettings'), body);
});

test('Node-RED exposes only the unified dx facade', () => {
    const exposed = require('../settings').functionGlobalContext;
    assert.strictEqual(exposed.dx, require('../lib'));
    assert.equal(exposed.prop, undefined);
    assert.equal(typeof exposed.dx.propagation.collect, 'function');
    assert.equal(typeof exposed.dx.propagation.getSnapshot, 'function');
    assert.strictEqual(exposed.dx.callsigns.get, settings.getCallsigns);
    assert.strictEqual(exposed.dx.callsigns.save, settings.saveCallsigns);
});

test('callsign save normalizes, limits to nine and backfills only new calls', () => {
    const ctx = new Context({monitoredCalls: ['K1', 'K2']});
    const saved = settings.saveCallsigns(ctx, ' k2, k3, n0call ');
    assert.deepEqual(saved.calls, ['K2', 'K3', 'N0CALL']);
    assert.deepEqual(saved.fresh, ['K3', 'N0CALL']);
    const many = settings.saveCallsigns(ctx, Array.from({length: 12}, (_, i) => 'K' + i));
    assert.equal(many.calls.length, 9);
});
