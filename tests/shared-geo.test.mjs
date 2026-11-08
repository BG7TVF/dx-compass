import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bearing,
    haversine,
    normalizeLongitude,
    relativeLongitude,
    absoluteLongitude
} from '../public/shared/geo/coordinates.mjs';
import {gridToLatLon, isValidMaidenhead} from '../public/shared/geo/maidenhead.mjs';
import {
    clipLat,
    gcSegments,
    greatCirclePaths,
    greatCirclePoints,
    trackPaths
} from '../public/shared/geo/great-circle.mjs';

const close = (actual, expected, tolerance = 1e-7) => {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test('Haversine and bearing retain equator/dateline behaviour', () => {
    close(haversine({lat: 0, lon: 0}, {lat: 0, lon: 1}), 111.19492664455873);
    close(haversine({lat: 0, lon: 179}, {lat: 0, lon: -179}), 222.38985328911747);
    close(bearing({lat: 0, lon: 179}, {lat: 0, lon: -179}), 90);
    close(bearing({lat: 0, lon: 0}, {lat: 1, lon: 0}), 0);
});

test('longitude helpers wrap in both directions and around a home meridian', () => {
    assert.equal(normalizeLongitude(180), -180);
    assert.equal(normalizeLongitude(-721), -1);
    assert.equal(relativeLongitude(-170, 170), 20);
    assert.equal(absoluteLongitude(20, 170), -170);
});

test('Maidenhead 4/6-character centres match existing formulas', () => {
    assert.deepEqual(gridToLatLon('AA00'), [-89.5, -179]);
    const fn = gridToLatLon('fn31pr');
    close(fn[0], 41.72916666666667);
    close(fn[1], -72.70833333333333);
    assert.equal(isValidMaidenhead('FN31PR'), true);
    assert.equal(isValidMaidenhead('ZZ99'), false);
    assert.equal(gridToLatLon('FN31PR12'), null);
    assert.equal(gridToLatLon(''), null);
});

test('great-circle samples unwrap the antimeridian before splitting paths', () => {
    const points = greatCirclePoints(0, 179, 0, -179, 8);
    assert.equal(points.length, 9);
    assert.equal(points[0][1], 179);
    assert.ok(points.some(point => point[1] > 180));
    const paths = greatCirclePaths(0, 179, 0, -179, 8);
    assert.equal(paths.length, 2);
    close(paths[0].at(-1)[1], 180);
    close(paths[1][0][1], -180);
    paths.flat().forEach(point => {
        assert.ok(point[1] >= -180 && point[1] <= 180);
    });
});

test('polar tracks are clipped at 85 degrees without stray lines', () => {
    const clipped = clipLat([[80, 0], [90, 10], [82, 20]]);
    assert.equal(clipped.length, 2);
    assert.notStrictEqual(clipped[0], clipped[1]);
    close(clipped[0][1][0], 85);
    close(clipped[0][1][1], 5);
    close(clipped[1][0][0], 85);
    close(clipped[1][0][1], 16.25);
    const paths = trackPaths(80, 0, 80, 150, 64);
    assert.ok(paths.length > 0);
    assert.ok(paths.flat().some(point => Math.abs(Math.abs(point[0]) - 85) < 1e-7));
    paths.flat().forEach(point => assert.ok(Math.abs(point[0]) <= 85));
});

test('coincident big-screen endpoints produce no track', () => {
    assert.deepEqual(greatCirclePoints(10, 20, 10, 20), [[10, 20]]);
    assert.deepEqual(gcSegments(10, 20, 10, 20), []);
    assert.deepEqual(trackPaths(10, 20, 10, 20), []);
});
