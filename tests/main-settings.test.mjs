import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bandLabel, dbRowToQso, defaultSettings, sanitizeSettings
} from '../public/js/settings-model.mjs';

test('main settings sanitizer keeps valid shared settings and rejects malformed values', () => {
    const result = sanitizeSettings({
        lang: 'ja', theme: 'ocean', tiles: 'amap', grid: 'om89vx', myCall: ' bg7tvf/r ',
        layout: '3x3', category: 'SO2R', qsoMax: 2200, qsoLines: false,
        qsoAutoFit: false, mySpotTtl: 45, mySpotMax: 750,
        propProj: 'azimuthal', propLayer: 'aurora', propDxLat: -35.5, propDxLon: 179.5,
        wallTitle: '  CONTEST  ', wallLayers: ['prop', 'invalid', 'qso'], wallMode: 'cycle',
        wallTimerOn: true, wallTimerStart: '2026-11-08T12:30', wallTimerEnd: 'bad',
        ttl: {CW: 12, SSB: 0, DIGI: 181}, bandColors: {'20m': '#A1b2C3', '15m': 'red'}
    });
    assert.equal(result.lang, 'ja');
    assert.equal(result.grid, 'OM89VX');
    assert.equal(result.myCall, 'BG7TVF/R');
    assert.equal(result.layout, '3x3');
    assert.equal(result.qsoMax, 2200);
    assert.equal(result.qsoLines, false);
    assert.equal(result.mySpotTtl, 45);
    assert.equal(result.mySpotMax, 750);
    assert.deepEqual(result.wallLayers, ['prop', 'qso']);
    assert.equal(result.wallTimerStart, '2026-11-08T12:30');
    assert.equal(result.wallTimerEnd, '');
    assert.deepEqual(result.ttl, {CW: 12, SSB: 30, DIGI: 30});
    assert.equal(result.bandColors['20m'], '#A1b2C3');
    assert.equal(result.bandColors['15m'], defaultSettings().bandColors['15m']);
});

test('main settings sanitizer applies defaults and one-time Mercator migration', () => {
    const fallback = sanitizeSettings({lang: 'xx', grid: 'not-a-grid', qsoMax: 20, wallLayers: 'all'});
    assert.deepEqual(fallback, defaultSettings());
    const migrated = sanitizeSettings({cfgV: 1, propProj: 'mercator'});
    assert.equal(migrated.propProj, 'robinson');
    assert.equal(migrated.cfgV, 2);
    const explicit = sanitizeSettings({cfgV: 2, propProj: 'mercator'});
    assert.equal(explicit.propProj, 'mercator');
});

test('main QSO display adapters preserve band and N1MM fields', () => {
    assert.equal(bandLabel('14', 14000), '20M');
    assert.equal(bandLabel('20', 14000), '20M');
    assert.equal(bandLabel('', 7100), '40M');
    const qso = dbRowToQso({
        n1mm_id: 42, timestamp: '2026-11-08T12:00:00Z', call: 'K1ABC', band: '20',
        freq_khz: 14001.5, rst_snt: '59', rst_rcv: '57', is_mult: 1, lat: 40, lon: -75
    });
    assert.equal(qso.n1mmId, 42);
    assert.equal(qso.ts, '2026-11-08T12:00:00Z');
    assert.equal(qso.freqKhz, 14001.5);
    assert.equal(qso.isMult, true);
});
