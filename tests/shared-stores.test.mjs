import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSpotStore,
    fetchSpots,
    replaySpots,
    spotKey
} from '../public/shared/data/spots.mjs';
import {
    createQsoStore,
    fetchQsos,
    qsoKey
} from '../public/shared/data/qsos.mjs';

test('spot store replays newest-first history, merges live data and preserves DTO identity', () => {
    const older = {
        spot_id: 1, monitored_call: 'K1ABC', spot_call: 'DE1', de: 'DE1',
        freq: 14000, band: '20m', mode: 'CW', timestamp: '2026-01-01T00:00:00Z'
    };
    const live = {
        spot_id: 2, monitored_call: 'K1ABC', spot_call: 'DE2', de: 'DE2',
        freq: 14020, band: '20m', mode: 'CW', timestamp: '2026-01-01T00:09:00Z'
    };
    const store = createSpotStore();
    assert.equal(store.ingest(live), true);
    assert.equal(store.ingest(live), false);
    const added = store.replay([live, older]);
    assert.deepEqual(added, [older]);
    assert.equal(store.size, 2);
    assert.deepEqual(store.all(), [older, live]);
    assert.strictEqual(store.all()[0], older);
    assert.deepEqual(store.byCall('de1'), [older]);
    assert.deepEqual(store.select({newestFirst: true, limit: 1}), [live]);

    const now = Date.parse('2026-01-01T00:10:00Z');
    const ttl = () => 5 * 60 * 1000;
    assert.deepEqual(store.active(ttl, now), [live]);
    assert.deepEqual(store.prune(ttl, now), [older]);
    assert.equal(store.size, 1);
    store.clear();
    assert.equal(store.size, 0);
});

test('spot fallback key and repository query remain compatible', async () => {
    const raw = [{de: 'DE/A', freq: 7000, timestamp: '2026-01-01T00:00:00Z'}];
    assert.equal(spotKey(raw[0]), 'DE/A|7000|2026-01-01T00:00:00Z');
    let requested;
    const transport = {
        async getJson(url, options) {
            requested = {url, options};
            return raw;
        }
    };
    const rows = await fetchSpots({transport, call: 'A/B', limit: 50, cache: 'no-store'});
    assert.strictEqual(rows, raw);
    assert.equal(requested.url, '/api/spots?call=A%2FB&limit=50');
    assert.deepEqual(requested.options, {cache: 'no-store'});

    const store = createSpotStore();
    assert.deepEqual(await replaySpots(store, {transport, limit: 1}), raw);
    assert.equal(store.size, 1);
});

test('QSO store unifies snake_case history and camelCase live contactreplace/delete', () => {
    const raw = {
        n1mm_id: 'a', timestamp: '2026-01-01T00:01:00Z', call: 'AAA',
        band: '20', operator: 'OP1', freq_khz: 14000, is_mult: 1
    };
    const live = {
        type: 'qso', n1mmId: 'b', ts: '2026-01-01T00:02:00Z', call: 'BBB',
        band: '40', operator: 'OP2', freqKhz: 7000, isMult: false
    };
    assert.equal(qsoKey(raw), qsoKey({n1mmId: 'a'}));
    const store = createQsoStore();
    store.replay([raw]);
    store.ingest(live);
    assert.equal(store.size, 2);
    assert.deepEqual(store.all(), [raw, live]);
    assert.strictEqual(store.latest(), live);

    const replacement = {...live, call: 'BB2'};
    store.ingest(replacement);
    assert.equal(store.size, 2);
    assert.strictEqual(store.latest(), replacement);
    store.replay([{n1mm_id: 'b', timestamp: live.ts, call: 'SHOULD_NOT_REPLACE'}]);
    assert.strictEqual(store.latest(), replacement);
    assert.deepEqual(store.select({operator: 'op1'}), [raw]);
    assert.equal(store.remove({type: 'qsoDelete', n1mmId: 'b'}), true);
    assert.equal(store.remove('b'), false);
    assert.strictEqual(store.latest(), raw);
    assert.strictEqual(store.all()[0], raw);
});

test('QSO repository only adds the existing limit query', async () => {
    const raw = [{n1mm_id: 1}];
    let requested;
    const transport = {
        async getJson(url, options) {
            requested = {url, options};
            return raw;
        }
    };
    const result = await fetchQsos({transport, limit: 500, signal: undefined});
    assert.strictEqual(result, raw);
    assert.equal(requested.url, '/api/qsos?limit=500');
    assert.deepEqual(Object.keys(requested.options), ['signal']);
});
