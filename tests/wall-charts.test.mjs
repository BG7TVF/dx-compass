import test from 'node:test';
import assert from 'node:assert/strict';
import {perHour, perMinute} from '../public/bigscreen/wall-charts.mjs';

const NOW = Date.UTC(2026, 10, 8, 12, 30, 0);
const at = minutes => new Date(NOW - minutes * 60000).toISOString();

test('wall minute bins put the newest sample in the rightmost bucket', () => {
    const bins = perMinute([
        {timestamp: at(0)}, {timestamp: at(0)},
        {timestamp: at(59)}, {timestamp: at(60)},
        {timestamp: 'invalid'}
    ], 60, NOW);
    assert.equal(bins.length, 60);
    assert.equal(bins[59], 2);
    assert.equal(bins[0], 1);
    assert.equal(bins.reduce((a, b) => a + b, 0), 3);
});

test('wall hourly bins use whole UTC-age hours', () => {
    const bins = perHour([
        {timestamp: at(0)}, {timestamp: at(59)},
        {timestamp: at(60)}, {timestamp: at(12 * 60)}
    ], 12, NOW);
    assert.equal(bins.length, 12);
    assert.equal(bins[11], 2);
    assert.equal(bins[10], 1);
    assert.equal(bins.reduce((a, b) => a + b, 0), 3);
});
