'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {bandOf, hav, gridToLatLng, gridToLatLon} = require('../lib/radio');

test('band table preserves inclusive boundaries and rejects unknown frequencies', () => {
    assert.equal(bandOf(1800), '160m');
    assert.equal(bandOf(14074), '20m');
    assert.equal(bandOf(29700), '10m');
    assert.equal(bandOf(420000), '70cm');
    assert.equal(bandOf(6100), null);
    assert.equal(bandOf(NaN), null);
});

test('haversine uses the original earth radius and coordinate order', () => {
    assert.equal(hav(0, 0, 0, 0), 0);
    assert.ok(Math.abs(hav(0, 0, 0, 1) - 111.19492664455873) < 1e-9);
    assert.ok(Math.abs(hav(51.5, -0.1, 40.7, -74) - 5570) < 10);
});

test('maidenhead conversions retain PSKR arrays and N1MM objects', () => {
    assert.deepEqual(gridToLatLng('PM95'), [35.5, 139]);
    assert.deepEqual(gridToLatLon('PM95'), {lat: 40, lon: 149});
    assert.deepEqual(gridToLatLng('jj00aa'), [0.020833333333333332, 0.041666666666666666]);
    assert.equal(gridToLatLng('bad'), null);
    assert.equal(gridToLatLon('ZZ99'), null);
});
