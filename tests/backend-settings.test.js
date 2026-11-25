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

test('changing myCall queues a self-spot backfill', () => {
    const ctx = new Context();
    settings.save(ctx, {myCall: 'K1ABC'});
    assert.deepEqual(ctx.get('pendingMyCallBackfill'), {call: 'K1ABC', attempts: 0, next_ms: 0});

    // 只改其它字段不重排回填。
    ctx.set('pendingMyCallBackfill', null);
    settings.save(ctx, {__patch: {theme: 'light'}});
    assert.equal(ctx.get('pendingMyCallBackfill'), null);

    settings.save(ctx, {__patch: {myCall: 'N0CALL'}});
    assert.equal(ctx.get('pendingMyCallBackfill').call, 'N0CALL');
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

test('reset clears the operator history so the records page shows nothing', () => {
    const ctx = new Context({
        operatorSessions: {'OP-A': {operator: 'N0CALL'}},
        operatorHistory: [{seat: 'OP-A', operator: 'N0CALL', start_ts: '2026-01-01T00:00:00Z'}]
    });
    settings.reset(ctx, ctx);
    assert.deepEqual(ctx.get('operatorSessions'), {});
    assert.deepEqual(ctx.get('operatorHistory'), []);
});

test('reset clears the seat identity, device runtime and advice state left over from a contest', () => {
    const ctx = new Context({
        seatRegistry: {'CN:BG7TVF': {seatKey: 'BG7TVF-2:1', computerName: 'BG7TVF-2', radioName: 'IC-7300'}},
        seatSources: {'10.0.0.5:1': {computerName: 'BG7TVF-2'}},
        seatHistory: [{at: '2026-01-01T00:00:00Z', action: 'identified'}],
        seatUnidentified: {count: 3},
        deviceRuntime: {rotor: {azimuth: 123}},
        deviceLeases: {rotor: {seat: 'OP-A'}},
        txRuntime: {s1: {tx_active: true}},
        deviceTowerHolds: {tower: {direction: 'up'}},
        frequencyClaims: {'14000.000': {seat: 'OP-A', freqKhz: 14000}},
        bandLink: {version: 1, seats: {'OP-A': {enabled: true}}},
        lastContest: 'CQ WW DX',
        pendingMyCallBackfill: {call: 'N0CALL', attempts: 2, next_ms: 1},
        adviceCooldown: {R2: 123}
    });
    const flow = new Context({qrzkeyexpire: 999});
    settings.reset(ctx, flow);
    // 计算机名称/电台型号残留的根因：席位识别表必须清空。
    assert.deepEqual(ctx.get('seatRegistry'), {});
    assert.deepEqual(ctx.get('seatSources'), {});
    assert.deepEqual(ctx.get('seatHistory'), []);
    assert.deepEqual(ctx.get('seatUnidentified'), {});
    // 设备/链路运行态回到空态。
    assert.deepEqual(ctx.get('deviceRuntime'), {});
    assert.deepEqual(ctx.get('deviceLeases'), {});
    assert.deepEqual(ctx.get('txRuntime'), {});
    assert.deepEqual(ctx.get('deviceTowerHolds'), {});
    assert.deepEqual(ctx.get('frequencyClaims'), {});
    assert.deepEqual(ctx.get('bandLink'), {version: 1, seats: {}});
    // 比赛名与待回填、建议冷却、QRZ 过期。
    assert.equal(ctx.get('lastContest'), '');
    assert.equal(ctx.get('pendingMyCallBackfill'), null);
    assert.deepEqual(ctx.get('adviceCooldown'), {});
    assert.equal(flow.get('qrzkeyexpire'), null);
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
