import test from 'node:test';
import assert from 'node:assert/strict';
import {getSettings, saveSettings, settingsFromMessage} from '../public/shared/data/settings.mjs';
import {getPropSnapshot, selectForecast} from '../public/shared/data/propagation.mjs';
import {applyStationMessage, changeFrequencyClaim, getStationState} from '../public/shared/data/station.mjs';

test('settings repository preserves DTO and keeps layout local by default', async () => {
    const settings = {lang: 'zh', grid: 'FN31', layout: '3x3'};
    let saved;
    const transport = {
        async getJson(url) {
            assert.equal(url, '/api/settings');
            return {settings};
        },
        async postJson(url, body) {
            assert.equal(url, '/api/settings');
            saved = body;
            return {success: true};
        }
    };
    assert.strictEqual(await getSettings({transport}), settings);
    assert.deepEqual(await saveSettings(settings, {transport}), {success: true});
    assert.deepEqual(saved, {lang: 'zh', grid: 'FN31'});
    assert.equal(settings.layout, '3x3');
    assert.strictEqual(settingsFromMessage({type: 'settings', settings}), settings);
    assert.equal(settingsFromMessage({type: 'qso'}), null);
});

test('propagation snapshot and forecast are passed through without calculation', async () => {
    const snapshot = {sfi: {value: 123}, forecast: {muf: {values: [[7.2]]}, degraded: true}};
    const transport = {async getJson(url) {
        assert.equal(url, '/api/prop');
        return snapshot;
    }};
    assert.strictEqual(await getPropSnapshot({transport}), snapshot);
    assert.strictEqual(selectForecast(snapshot), snapshot.forecast);
    assert.equal(selectForecast({}), null);
});

test('station repository and pure radio/score merger retain raw messages', async () => {
    const initial = {radio: null, radios: {}, score: null};
    const transport = {async getJson(url) {
        assert.equal(url, '/api/station/state');
        return initial;
    }};
    assert.strictEqual(await getStationState({transport}), initial);
    const radio = {type: 'radio', radioNr: 2, freq: 14000};
    const withRadio = applyStationMessage(initial, radio);
    assert.strictEqual(withRadio.radio, radio);
    assert.strictEqual(withRadio.radios[2], radio);
    assert.deepEqual(initial, {radio: null, radios: {}, score: null});
    const score = {type: 'score', qsos: 12};
    const withScore = applyStationMessage(withRadio, score);
    assert.strictEqual(withScore.score, score);
    assert.strictEqual(withScore.radio, radio);
    assert.strictEqual(applyStationMessage(withScore, {type: 'qso'}), withScore);
});

test('station repository routes claims and keeps composite seat keys', async () => {
    let request;
    const transport = {async postJson(url, body) {
        request = {url, body};
        return {ok: true, claims: []};
    }};
    await changeFrequencyClaim('claim', {seat: 'PC-A:1', freqKhz: 14025}, {transport});
    assert.deepEqual(request, {
        url: '/api/frequency-claims/claim', body: {seat: 'PC-A:1', freqKhz: 14025}
    });

    const initial = {radio: null, radios: {}, claims: [], score: null};
    const radio = {type: 'radio', seat: 'PC-A:1', radioNr: 1};
    const withRadio = applyStationMessage(initial, radio);
    assert.strictEqual(withRadio.radios['PC-A:1'], radio);
    assert.equal(withRadio.radios[1], undefined);
    const claims = [{seat: 'PC-A:1', freqKhz: 14025}];
    const withClaims = applyStationMessage(withRadio, {type: 'frequencyClaims', claims});
    assert.strictEqual(withClaims.claims, claims);
    assert.strictEqual(withClaims.radios['PC-A:1'], radio);
});
