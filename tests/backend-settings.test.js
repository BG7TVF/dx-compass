'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../lib/settings');
const schema = require('../public/shared/settings/schema.js');

class Context {
    constructor(values = {}) { this.values = {...values}; }
    get(k) { return this.values[k]; }
    set(k, v) { this.values[k] = v; }
}

test('settings save sanitizes, defaults and broadcasts the stored object', () => {
    const ctx = new Context();
    const saved = settings.save(ctx, {myCall: 'n0call', grid: 'pm95', theme: 'ocean'});
    assert.equal(saved.payload.success, true);
    assert.equal(saved.payload.settings.myCall, 'N0CALL');
    assert.equal(saved.payload.settings.theme, 'ocean');
    // Missing keys are filled from the schema instead of leaking through.
    assert.equal(saved.payload.settings.qsoMax, 1500);
    assert.equal(saved.payload.settings.layout, undefined);
    assert.equal(saved.payload.rev, 1);
    assert.strictEqual(saved.broadcast.settings, saved.payload.settings);
    assert.deepEqual(settings.get(ctx).settings, saved.payload.settings);
    assert.equal(settings.save(ctx, []).statusCode, 400);
});

test('settings save rejects out-of-range values and reports them', () => {
    const ctx = new Context();
    const saved = settings.save(ctx, {qsoMax: 5, theme: 'neon', wallTitle: ''});
    assert.equal(saved.payload.settings.qsoMax, 1500);
    assert.equal(saved.payload.settings.theme, 'dark');
    assert.equal(saved.payload.settings.wallTitle, 'DX-COMPASS');
    assert.deepEqual(saved.payload.rejected.sort(), ['qsoMax', 'theme', 'wallTitle']);
    assert.ok(saved.payload.warnings.length >= 3);
});

test('settings save merges partial patches without dropping another domain', () => {
    const ctx = new Context();
    settings.save(ctx, {__patch: {theme: 'light', wallTitle: 'CQ WW'}});
    const patched = settings.save(ctx, {__patch: {qsoMax: 2600}});
    assert.equal(patched.payload.partial, true);
    assert.equal(patched.payload.settings.theme, 'light');
    assert.equal(patched.payload.settings.wallTitle, 'CQ WW');
    assert.equal(patched.payload.settings.qsoMax, 2600);
    assert.equal(patched.payload.rev, 2);
});

test('settings keep unknown keys in the bounded _ext area', () => {
    const ctx = new Context();
    const saved = settings.save(ctx, {__patch: {futureKnob: 7}});
    assert.equal(saved.payload.settings.futureKnob, undefined);
    assert.equal(saved.payload.settings._ext.futureKnob, 7);
});

test('resetDomain restores only the requested group and keeps other groups', () => {
    const ctx = new Context();
    settings.save(ctx, {__patch: {theme: 'ocean', qsoMax: 2600, wallTitle: 'CQ WW'}});
    const reset = settings.resetDomain(ctx, 'qso');
    assert.equal(reset.payload.domain, 'qso');
    assert.equal(reset.payload.settings.qsoMax, 1500);
    assert.equal(reset.payload.settings.theme, 'ocean');
    assert.equal(reset.payload.settings.wallTitle, 'CQ WW');
    assert.equal(settings.resetDomain(ctx, 'nope').statusCode, 400);
});

test('migration moves legacy Mercator data to Robinson exactly once', () => {
    const ctx = new Context({uiSettings: {cfgV: 1, propProj: 'mercator'}});
    assert.equal(settings.get(ctx).settings.propProj, 'robinson');
    ctx.set('uiSettings', {cfgV: 2, propProj: 'mercator'});
    assert.equal(settings.get(ctx).settings.propProj, 'mercator');
});

test('schema field table is internally consistent', () => {
    assert.ok(schema.FIELDS.length >= 80);
    assert.equal(new Set(schema.FIELDS.map(field => field.key)).size, schema.FIELDS.length);
    for (const domain of schema.DOMAINS) {
        assert.ok(schema.DOMAIN_FIELDS[domain.key].length > 0, domain.key);
    }
    const roundTrip = schema.sanitize(schema.defaultSettings());
    assert.deepEqual(roundTrip.warnings, []);
    assert.deepEqual(roundTrip.settings, schema.defaultSettings());
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
