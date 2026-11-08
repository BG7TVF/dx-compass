'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {fetchGeo, resolveGeo, GEO_TTL, GEO_CONTEXT_KEY} = require('../lib/propagation/geo.js');

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const DE = {lat: 35.5, lon: 139.5};

class Context {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key); }
    async set(key, value) { this.values.set(key, value); }
}

function payload(start, count) {
    return {values: [{values: Array.from({length: count}, (_, i) => start + i)}]};
}

test('USGS parser selects a reporting station and derives local K without network', async () => {
    const urls = [];
    const geo = await fetchGeo(DE, {now: NOW, request: async url => {
        urls.push(url);
        return payload(100, 60);
    }});
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/geomag\.usgs\.gov\/ws\/data\/\?id=/);
    assert.match(urls[0], /elements=H/);
    assert.equal(geo.k, 3);
    assert.equal(geo.amp, 59);
    assert.ok(Number.isInteger(geo.distance));
    assert.ok(geo.code);
});

test('USGS resolver caches per HOME for ten minutes and degrades to last value', async () => {
    const ctx = new Context();
    let calls = 0;
    let fail = false;
    const request = async () => {
        calls++;
        if (fail) throw new Error('offline fixture');
        return payload(0, 40);
    };
    const first = await resolveGeo(ctx, DE, {now: NOW, request});
    assert.equal(first.geo.k, 2);
    assert.equal(calls, 1);
    const cached = await resolveGeo(ctx, DE, {now: NOW + GEO_TTL / 2, request});
    assert.deepStrictEqual(cached, first);
    assert.equal(calls, 1);

    fail = true;
    const fallback = await resolveGeo(ctx, DE, {now: NOW + GEO_TTL + 1, request});
    assert.deepStrictEqual(fallback.geo, first.geo);
    assert.equal(fallback.geoAt, NOW + GEO_TTL + 1);
    assert.equal(calls, 4); // one initial success + three failed nearest stations
    assert.equal(ctx.values.get(GEO_CONTEXT_KEY).geo.k, 2);

    const otherHome = await resolveGeo(ctx, {lat: 40, lon: -105},
        {now: NOW + GEO_TTL + 2, request});
    assert.equal(otherHome.geo, null);
    assert.equal(calls, 7);
});

test('initial USGS outage is neutral and does not throw', async () => {
    const ctx = new Context();
    const result = await resolveGeo(ctx, DE, {now: NOW, request: async () => {
        throw new Error('offline fixture');
    }});
    assert.equal(result.geo, null);
    assert.equal(result.geoAt, NOW);
});
