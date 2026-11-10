'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const maintenance = require('../lib/maintenance');
const schema = require('../public/shared/settings/schema.js');

class Context {
    constructor(values = {}) { this.values = {...values}; }
    get(key) { return this.values[key]; }
    set(key, value) { this.values[key] = value; }
}

test('retention purge follows settings and skips disabled scopes', () => {
    const ctx = new Context({uiSettings: {
        autoPurge: true, retentionSpotsDays: 7, retentionQsoDays: 3,
        retentionRecordingMonths: 6
    }});
    const {statements} = maintenance.purge(ctx);
    const scopes = statements.map(s => s.scope);
    assert.deepEqual(scopes, ['spots', 'qsos', 'recordings', 'neighbors']);
    assert.match(statements[0].topic, /-7 days/);
    assert.match(statements[1].topic, /-3 days/);
    assert.match(statements[2].topic, /-6 months/);
    assert.match(statements[3].topic, /DELETE FROM neighbors/);
    assert.match(statements[3].topic, /-60 minutes/);

    const off = new Context({uiSettings: {autoPurge: false}});
    assert.deepEqual(maintenance.purge(off), {statements: []});

    /* invalid values are rejected by the schema and fall back to "keep all" */
    const bad = new Context({uiSettings: {
        autoPurge: true, retentionSpotsDays: 'many', retentionQsoDays: -5
    }});
    const fallback = maintenance.purge(bad);
    assert.deepEqual(fallback.statements.map(s => s.scope), ['recordings', 'neighbors']);
});

test('disk check honours the alert switch and its own check interval', () => {
    const ctx = new Context({uiSettings: {diskAlert: false}});
    assert.deepEqual(maintenance.diskCheck(ctx), {enabled: false});

    const live = new Context({uiSettings: {diskAlert: true, diskCheckSec: 300}});
    const first = maintenance.diskCheck(live, {now: 1000000, path: process.cwd()});
    assert.equal(first.enabled, true);
    assert.equal(typeof first.usedPct, 'number');
    assert.equal(first.threshold, 90);
    const again = maintenance.diskCheck(live, {now: 1000000 + 1000, path: process.cwd()});
    assert.deepEqual(again, {skipped: true});
});

test('settings-driven runtime keys are marked wired', () => {
    const keys = ['pollDxwatchSec', 'pollRbnSec', 'pollPskrSyncSec', 'sourceDxwatch',
        'sourceRbn', 'sourcePskr', 'freshSec', 'retentionSpotsDays',
        'retentionRecordingMonths', 'retentionQsoDays', 'autoPurge', 'maxCallsigns',
        'httpProxy', 'fetchTimeoutMs', 'upstreamBase', 'recordingRepeat',
        'diskWarnPct', 'diskCheckSec', 'diskAlert', 'collectSec',
        'condClosed', 'condGood', 'condFair'];
    for (const key of keys) {
        const field = schema.FIELD_MAP[key];
        assert.ok(field, key + ' missing from schema');
        assert.equal(field.wired, true, key + ' should be wired');
        assert.ok(['server', 'both'].includes(field.scope), key + ' should reach the server');
    }
});
