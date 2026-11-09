import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpponentBands, opponentBandHtml} from '../public/bigscreen/wall-opponents.mjs';

const bearing = () => 90;
const now = Date.parse('2026-11-08T12:00:00Z');
const spot = (call, band, freq, timestamp, overrides = {}) => ({
    monitored_call: call, band, freq, timestamp,
    lat: 30, lon: 120, dx_lat: 40, dx_lon: -100, ...overrides
});

test('opponent bands keep recent spots, newest frequency per call, exclude our own call', () => {
    const rows = [
        spot('K1ABC', '20m', 14020, '2026-11-08T11:31:00Z'),
        spot('K1ABC', '20m', 14025, '2026-11-08T11:34:00Z'),
        spot('K1ABC', '40m', 7025, '2026-11-08T11:50:00Z'),
        spot('DL1ABC', '20m', 14030, '2026-11-08T11:40:00Z'),
        spot('MYCALL', '20m', 14020, '2026-11-08T11:55:00Z'),
        spot('K1ABC', '15m', 21020, '2026-11-08T09:00:00Z')
    ];
    const bands = buildOpponentBands(rows, 'mycall', bearing, {now});
    assert.deepEqual(bands.map(band => band.band), ['20M', '40M']);
    const twenty = bands[0];
    assert.equal(twenty.n, 3);
    assert.deepEqual(twenty.calls.map(item => item.call), ['K1ABC', 'DL1ABC']);
    assert.equal(twenty.calls[0].freq, 14025);
    assert.equal(twenty.calls[0].n, 2);
    assert.equal(Math.round(twenty.dir), 90);
    assert.equal(twenty.spread, false);
});

test('band tiles show band, direction, calls and MHz frequencies', () => {
    const [band] = buildOpponentBands([
        spot('K1ABC', '20m', 14025, '2026-11-08T11:30:00Z')
    ], '', bearing, {now});
    const html = opponentBandHtml(band, false);
    assert.match(html, /20M/);
    assert.match(html, /东 90°/);
    assert.match(html, /K1ABC/);
    assert.match(html, /14\.025/);
});

test('a band whose spotters are all around reports multi-directional', () => {
    const flat = (lat1, lon1, lat2) => lat2;
    const rows = [0, 90, 180, 270].map((degrees, index) => spot(
        'K1ABC', '20m', 14025, `2026-11-08T11:3${index}:00Z`, {lat: degrees}
    ));
    const [band] = buildOpponentBands(rows, '', flat, {now});
    assert.equal(band.spread, true);
    assert.match(opponentBandHtml(band, false), /多向/);
});
