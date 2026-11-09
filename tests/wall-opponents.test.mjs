import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OPPONENT_COLORS, WALL_BAND_COLORS, assignOpponentColors, bandCellHtml,
    buildOpponents, callColorIndex, opponentCardHtml, opponentColorMap
} from '../public/bigscreen/wall-opponents.mjs';

const bearing = () => 90;
const now = Date.parse('2026-11-08T12:00:00Z');
const spot = (call, band, freq, timestamp, overrides = {}) => ({
    monitored_call: call, band, freq, timestamp,
    lat: 30, lon: 120, dx_lat: 40, dx_lon: -100, ...overrides
});

test('opponents are grouped by call, bands nested inside, recent spots only', () => {
    const rows = [
        spot('K1ABC', '20m', 14020, '2026-11-08T11:31:00Z'),
        spot('K1ABC', '20m', 14025, '2026-11-08T11:34:00Z'),
        spot('K1ABC', '40m', 7025, '2026-11-08T11:50:00Z'),
        spot('DL1ABC', '20m', 14030, '2026-11-08T11:40:00Z'),
        spot('MYCALL', '20m', 14020, '2026-11-08T11:55:00Z'),
        spot('K1ABC', '15m', 21020, '2026-11-08T09:00:00Z')
    ];
    const opponents = buildOpponents(rows, 'mycall', bearing, {now});
    assert.deepEqual(opponents.map(item => item.call), ['K1ABC', 'DL1ABC']);
    const k1 = opponents[0];
    assert.equal(k1.n, 3);
    assert.deepEqual(k1.bands.map(band => band.band), ['20M', '40M']);
    assert.equal(k1.bands[0].n, 2);
    assert.equal(k1.bands[0].freq, 14025);
    assert.equal(Math.round(k1.bands[0].dir), 90);
    assert.equal(k1.bands[0].spread, false);
});

test('each rival keeps its own per-band direction on the same band', () => {
    const flat = (lat1, lon1, lat2) => lat2;
    const rows = [
        spot('AA1AA', '20m', 14020, '2026-11-08T11:31:00Z', {lat: 90}),
        spot('AA1AA', '20m', 14021, '2026-11-08T11:32:00Z', {lat: 90}),
        spot('BB2BB', '20m', 14030, '2026-11-08T11:33:00Z', {lat: 180}),
        spot('BB2BB', '20m', 14031, '2026-11-08T11:34:00Z', {lat: 180})
    ];
    const opponents = buildOpponents(rows, '', flat, {now});
    const aa = opponents.find(item => item.call === 'AA1AA');
    const bb = opponents.find(item => item.call === 'BB2BB');
    assert.equal(Math.round(aa.bands[0].dir), 90);
    assert.equal(Math.round(bb.bands[0].dir), 180);
});

test('band cell shows frequency in MHz and the heading', () => {
    const [opponent] = buildOpponents([
        spot('K1ABC', '20m', 14025, '2026-11-08T11:34:00Z'),
        spot('K1ABC', '20m', 14026, '2026-11-08T11:35:00Z')
    ], '', bearing, {now});
    const html = opponentCardHtml(opponent);
    assert.match(html, /K1ABC/);
    assert.match(html, /1 频段 · 2 SPOT/);
    assert.match(html, /20M/);
    assert.match(html, /14\.026/);
    assert.match(html, /MHz/);
    assert.match(html, /东 90°/);
});

test('call colours are deterministic and stay off the semantic palette', () => {
    assert.equal(callColorIndex('K1ABC'), callColorIndex('k1abc'));
    assert.equal(callColorIndex('K1ABC'), callColorIndex('K1ABC'));
    /* Alert red, DX red, my-station cyan, QSO green and every band colour. */
    const reserved = ['#e4572e', '#ff6b6b', '#4cc9f0', '#35d6a4',
        ...Object.values(WALL_BAND_COLORS)];
    OPPONENT_COLORS.forEach(color => assert.ok(!reserved.includes(color), color + ' collides'));
    assert.equal(new Set(OPPONENT_COLORS).size, OPPONENT_COLORS.length);
});

test('neighbouring rivals never share a colour, even when hashes collide', () => {
    const byIndex = new Map();
    let pair = null;
    for (let index = 0; index < 800 && !pair; index++) {
        const call = 'T' + index + 'AA';
        const slot = callColorIndex(call);
        if (byIndex.has(slot)) pair = [byIndex.get(slot), call];
        else byIndex.set(slot, call);
    }
    assert.ok(pair, 'expected a hash collision inside the palette');
    const colors = assignOpponentColors(pair);
    assert.notEqual(colors.get(pair[0]), colors.get(pair[1]));

    const six = ['DL1ABC', 'K1ABC', 'G4XYZ', 'JA1XYZ', 'UA9QQ', 'W3LPL'];
    const distinct = six.map(call => assignOpponentColors(six).get(call));
    assert.equal(new Set(distinct).size, six.length, 'free slots must all differ');

    const many = Array.from({length: 20}, (value, index) => 'R' + index + 'AA');
    const assigned = many.map(call => assignOpponentColors(many).get(call));
    for (let index = 1; index < assigned.length; index++) {
        assert.notEqual(assigned[index], assigned[index - 1]);
    }
    /* Rebuilding the same ordered list must reproduce the same colours. */
    assert.deepEqual(many.map(call => assignOpponentColors(many).get(call)), assigned);
});

test('the map assigns each rival the same colour as its panel card', () => {
    const rows = [
        spot('K1ABC', '20m', 14020, '2026-11-08T11:31:00Z'),
        spot('K1ABC', '40m', 7025, '2026-11-08T11:50:00Z'),
        spot('DL1ABC', '20m', 14030, '2026-11-08T11:40:00Z'),
        spot('JA1XYZ', '15m', 21030, '2026-11-08T11:45:00Z')
    ];
    const panel = buildOpponents(rows, '', bearing, {now});
    const map = opponentColorMap(rows, '', {now});
    assert.equal(map.size, panel.length);
    panel.forEach(opponent => {
        assert.equal(map.get(opponent.call), opponent.color);
        assert.match(opponentCardHtml(opponent), new RegExp('--call-color:' + opponent.color));
    });
    assert.match(opponentCardHtml(panel[0]), /class="oc-dot"/);
});

test('too few or scattered samples never fake a main direction', () => {
    const single = buildOpponents([
        spot('K1ABC', '20m', 14025, '2026-11-08T11:34:00Z')
    ], '', bearing, {now})[0].bands[0];
    assert.equal(single.dirSamples, 1);
    assert.equal(single.spread, false);
    assert.match(bandCellHtml(single), /thin/);

    const flat = (lat1, lon1, lat2) => lat2;
    const scattered = buildOpponents([0, 90, 180, 270].map((degrees, index) => spot(
        'K1ABC', '20m', 14025, `2026-11-08T11:3${index}:00Z`, {lat: degrees}
    )), '', flat, {now})[0].bands[0];
    assert.equal(scattered.spread, true);
    assert.match(bandCellHtml(scattered), /多向/);

    const noCoords = buildOpponents([
        spot('K1ABC', '20m', 14025, '2026-11-08T11:34:00Z', {lat: null, lon: null})
    ], '', bearing, {now})[0].bands[0];
    assert.equal(noCoords.dirSamples, 0);
    assert.match(bandCellHtml(noCoords), /—/);
});
