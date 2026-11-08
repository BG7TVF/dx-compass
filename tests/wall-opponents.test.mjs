import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpponents, opponentRowHtml} from '../public/bigscreen/wall-opponents.mjs';

const bearing = () => 90;
const spot = (call, band, freq, timestamp) => ({
    monitored_call: call, band, freq, timestamp,
    lat: 30, lon: 120, dx_lat: 40, dx_lon: -100
});

test('opponents keep one newest slot per band and exclude our own call', () => {
    const rows = [
        spot('K1ABC', '20M', 14020, '2026-11-08T10:00:00Z'),
        spot('K1ABC', '20M', 14025, '2026-11-08T11:00:00Z'),
        spot('K1ABC', '40M', 7025, '2026-11-08T11:01:00Z'),
        spot('MYCALL', '20M', 14020, '2026-11-08T11:02:00Z')
    ];
    const opponents = buildOpponents(rows, 'mycall', bearing);
    assert.equal(opponents.length, 1);
    assert.equal(opponents[0].call, 'K1ABC');
    assert.equal(opponents[0].n, 3);
    assert.deepEqual(opponents[0].bands.map(item => item.band), ['40M', '20M']);
    assert.equal(opponents[0].bands[1].freq, 14025);
    assert.equal(Math.round(opponents[0].dir), 90);
});

test('opponent rows cap band chips and keep exact frequency for one band', () => {
    const rows = ['160M', '80M', '40M', '20M'].map((band, i) =>
        spot('K1ABC', band, 1000 + i, `2026-11-08T11:0${i}:00Z`));
    const [opponent] = buildOpponents(rows, '', bearing);
    const html = opponentRowHtml(opponent);
    assert.match(html, /<em>\+1<\/em>/);
    assert.doesNotMatch(html, /<u>/);

    const [single] = buildOpponents([spot('K1ABC', '20M', 14020, '2026-11-08T11:00:00Z')], '', bearing);
    assert.match(opponentRowHtml(single), /<u>14.020<\/u>/);
});
