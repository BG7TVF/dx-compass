import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLongitude} from '../public/shared/geo/coordinates.mjs';
import {
    makeProjection,
    propFit,
    propRingCopies,
    PROP_NORTH_MIN,
    PROP_SOUTH_MIN
} from '../public/shared/map/projection.mjs';
import {mercLat, mercY, ringPoints} from '../public/shared/map/base-map.mjs';
import {
    computeTerminator, createTerminator, propTerminator, solarCos, solarCosAt
} from '../public/shared/map/terminator.mjs';

const close = (actual, expected, tolerance = 1e-5) => {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test('Mercator/Robinson/azimuthal projections round-trip map coordinates', () => {
    const de = {lat: 23, lon: 113};
    const points = [[23, 113], [40, 130], [-20, 90], [0, -170], [60, 100]];
    for (const kind of ['mercator', 'robinson', 'azimuthal']) {
        const projection = makeProjection(kind, 1000, 700, de);
        for (const [lat, lon] of points) {
            const pixel = projection.fwd(lon, lat);
            assert.ok(pixel && pixel.every(Number.isFinite), `${kind} fwd ${lat},${lon}`);
            const inverse = projection.inv(...pixel);
            assert.ok(inverse, `${kind} inv ${lat},${lon}`);
            close(inverse[0], lat);
            close(normalizeLongitude(inverse[1] - lon), 0);
        }
    }
});

test('projection fit keeps mainland-safe crop and rejects phantom positions', () => {
    const tall = makeProjection('robinson', 800, 1200, {lat: 0, lon: 0});
    assert.equal(tall.fit.centered, true);
    const wide = makeProjection('mercator', 2000, 200, {lat: 0, lon: 0});
    assert.equal(wide.fit.north, PROP_NORTH_MIN);
    assert.equal(wide.fit.south, PROP_SOUTH_MIN);
    assert.equal(wide.inv(-10000, 0), null);
    const azimuthal = makeProjection('azimuthal', 800, 800, {lat: 0, lon: 0});
    assert.equal(azimuthal.fwd(180, 0), null);
    assert.equal(azimuthal.inv(10000, 10000), null);

    const identity = propFit(100, 200, 1, 1, Math.abs, value => value, 90);
    assert.deepEqual(identity, {sc: 100, north: 90, south: -90, centered: true});
});

test('ring helpers unwrap the seam and project finite copies', () => {
    assert.deepEqual(ringPoints([170, 0, -170, 0]), [[170, 0], [190, 0]]);
    assert.ok(Number.isFinite(mercY(85)));
    const projection = makeProjection('robinson', 1000, 600, {lat: 20, lon: 0});
    const copies = propRingCopies([170, 10, -170, 20, 170, 30], 0, projection);
    assert.ok(copies.length > 0);
    copies.forEach(copy => assert.ok([...copy.pts].every(Number.isFinite)));
});

test('Mercator row helpers round-trip latitude for wall field sampling', () => {
    for (const lat of [-85, -60, -23, 0, 23, 45, 60, 85]) {
        close(mercLat(mercY(lat)), lat, 1e-9);
    }
    assert.equal(mercLat(0.5), 0);
});

test('terminator geometry remains finite through solstices and equinox', () => {
    for (const iso of ['2026-06-21T12:00:00Z', '2026-12-21T12:00:00Z', '2026-03-20T06:00:00Z']) {
        const geometry = computeTerminator(new Date(iso));
        assert.equal(geometry.base.length, 361);
        geometry.base.forEach(([lat, lon]) => {
            assert.ok(Number.isFinite(lat) && Math.abs(lat) <= 90);
            assert.ok(Number.isFinite(lon));
        });
    }
    const projected = propTerminator(new Date('2026-06-21T12:00:00Z'), 113);
    assert.equal(projected.base.length, 181);
    assert.equal(projected.base[0][1], -180);
    assert.equal(projected.base.at(-1)[1], 180);
});

test('solarCos shares terminator geometry for day and night fields', () => {
    assert.ok(solarCos(0, 0, new Date('2026-06-21T12:00:00Z')) > 0.9);
    assert.ok(solarCos(0, 0, new Date('2026-06-21T00:00:00Z')) < -0.9);
    const geometry = computeTerminator(new Date('2026-06-21T12:00:00Z'));
    const onLine = solarCos(geometry.base[0][0], geometry.base[0][1],
        new Date('2026-06-21T12:00:00Z'));
    assert.ok(Math.abs(onLine) < 1e-9);
    close(solarCosAt(geometry, 23, 113), solarCos(23, 113, new Date('2026-06-21T12:00:00Z')));
});

test('Leaflet terminator tracks six layers and destroy removes layers/timer', () => {
    const map = {
        layers: new Set(),
        hasLayer(layer) { return this.layers.has(layer); },
        removeLayer(layer) { this.layers.delete(layer); }
    };
    const layer = (points, options) => ({
        points, options,
        addTo(target) { target.layers.add(this); return this; }
    });
    const L = {
        polygon: (points, options) => layer(points, options),
        polyline: (points, options) => layer(points, options)
    };
    let cleared = null;
    const controller = createTerminator(map, {
        L,
        now: () => new Date('2026-12-21T12:00:00Z'),
        setIntervalImpl: () => 42,
        clearIntervalImpl: id => { cleared = id; }
    });
    assert.equal(map._termLayers.length, 6);
    assert.equal(map.layers.size, 6);
    assert.equal(map._termTimer, 42);
    map._termLayers.forEach(item => item.points.forEach(point => {
        assert.ok(point.every(Number.isFinite));
        assert.ok(Math.abs(point[0]) <= 90);
    }));
    controller.destroy();
    assert.equal(cleared, 42);
    assert.equal(map.layers.size, 0);
    assert.equal(controller.layers.length, 0);
});
