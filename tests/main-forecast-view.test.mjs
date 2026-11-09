import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bestMatrixRow, mufColor, sampleMufGrid, selectBandConditions, selectPathMatrix,
    MUF_LAYER_ALPHA, NIGHT_ALPHA, NIGHT_ALPHA_NO_TWILIGHT, TWILIGHT_ALPHA,
    MUF_LEGEND_VALUES, nightShadeAlpha
} from '../public/shared/propagation/forecast-view.mjs';

const grid = {
    nLat: 3, nLon: 4, lats: [-90, 0, 90], lons: [-180, -90, 0, 90],
    values: [[0, 0, 0, 0], [0, 10, 20, 30], [40, 40, 40, 40]],
    longitudeWrap: true, interpolation: 'bilinear'
};

test('forecast MUF sampling interpolates bilinearly and wraps longitude', () => {
    assert.equal(sampleMufGrid(grid, 0, -135), 5);
    assert.equal(sampleMufGrid(grid, 0, 225), 5);
    assert.equal(sampleMufGrid(grid, 0, 180), 0);
    assert.equal(sampleMufGrid(grid, 0, 270), 10);
    assert.equal(sampleMufGrid(grid, 45, -135), 22.5);
    assert.equal(sampleMufGrid(grid, -100, -135), 0);
    assert.equal(sampleMufGrid(grid, 100, -135), 40);
    assert.equal(sampleMufGrid(null, 0, 0), null);
});

test('forecast MUF colour uses the legacy 3..30 MHz canvas colour ramp', () => {
    assert.equal(mufColor(3), 'rgb(20,60,180)');
    assert.equal(mufColor(30), 'rgb(220,40,60)');
    assert.match(mufColor(15), /^rgb\(\d+,\d+,\d+\)$/);
});

test('forecast selectors retain server matrix and object-mapped band conditions', () => {
    const matrix = {
        hourNow: 12,
        rows: [
            {name: '40M', cells: Array.from({length: 24}, (_, hour) => hour === 12 ? 35 : 10)},
            {name: '20M', cells: Array.from({length: 24}, (_, hour) => hour === 12 ? 82 : 20)}
        ]
    };
    const conditions = {bands: {'40M': {day: 'Fair', night: 'Good'}, '20M': {day: 'Good', night: 'Poor'}}};
    const forecast = {pathMatrix: matrix, bandConditions: conditions};
    assert.equal(selectPathMatrix(forecast), matrix);
    assert.equal(selectBandConditions(forecast), conditions);
    assert.deepEqual(Object.entries(selectBandConditions(forecast).bands)[0], ['40M', {day: 'Fair', night: 'Good'}]);
    assert.equal(bestMatrixRow(matrix).name, '20M');
    assert.equal(bestMatrixRow(matrix, 0).name, '20M');
});

test('shared overlay styling matches the propagation canvas night shading', () => {
    assert.equal(MUF_LAYER_ALPHA, 77 / 255);
    assert.deepEqual(MUF_LEGEND_VALUES, [3, 9, 15, 21, 27, 30]);
    assert.equal(nightShadeAlpha(1), 0);
    assert.equal(nightShadeAlpha(0), 0);
    assert.equal(nightShadeAlpha(-0.01), NIGHT_ALPHA);
    assert.equal(nightShadeAlpha(Math.sin(-6 * Math.PI / 180)), NIGHT_ALPHA);
    assert.equal(nightShadeAlpha(-0.5), 1 - (1 - NIGHT_ALPHA) * (1 - TWILIGHT_ALPHA));
    assert.equal(nightShadeAlpha(-0.5, false), NIGHT_ALPHA_NO_TWILIGHT);
});
