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
import {
    fitWorld, mercLat, mercY, ringPoints, worldViewCenter, createLandCanvas
} from '../public/shared/map/base-map.mjs';
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

test('world view fills the container without cutting continental land', () => {
    globalThis.LAND = [
        [100, 10, 140, 70, 100, 10],
        [0, -80, 20, -65, 0, -80]
    ];
    const calls = {};
    const map = {
        getSize: () => ({x: 592, y: 399}),
        project: ([, lon], zoom) => ({x: (lon + 180) / 360 * 256 * Math.pow(2, zoom)}),
        getBoundsZoom: (bounds, inside) => inside ? 1.15 : 1,
        setMinZoom: zoom => { calls.minZoom = zoom; },
        setView: (center, zoom) => { calls.center = center; calls.zoom = zoom; }
    };
    const zoom = fitWorld(map);
    assert.equal(zoom, 1.15);
    assert.equal(calls.zoom, 1.15);
    assert.equal(calls.minZoom, 1.15);
    const span = 399 / (256 * Math.pow(2, zoom));
    const y = mercY(calls.center[0]);
    assert.ok(y - span / 2 <= mercY(70) + 1e-9, 'northern land must stay inside');
    assert.ok(y + span / 2 >= mercY(-65) - 1e-9, 'Antarctica must stay partly visible');
    assert.equal(calls.center[1], 0);
});

test('Antarctic anchor is the peninsula, not Cape Horn', () => {
    globalThis.LAND = [
        [-140, 12, -50, 83.565, -140, 12],                                        // Greenland
        [-73, 12, -50, -55.166, -73, 12],                                         // Cape Horn
        [-180, -90, 180, -90, 180, -63.226, -180, -63.226, -180, -90]             // Antarctica
    ];
    const size = {x: 900, y: 300};
    const map = {
        getSize: () => size,
        project: ([, lon], zoom) => ({x: (lon + 180) / 360 * 256 * Math.pow(2, zoom)})
    };
    const zoom = Math.log2(size.x / 256);
    const y = mercY(worldViewCenter(map, zoom)[0]);
    close(y, (mercY(83.565) + mercY(-63.226)) / 2, 1e-6);
    assert.ok(y > (mercY(83.565) + mercY(-55.166)) / 2 + 1e-6,
        'Cape Horn must not become the southern anchor');
});

test('panes narrower than one world at zoom 1 still fill the full width', () => {
    /* Leaflet's getBoundsZoom returns max(current minZoom, coverZoom). The wall
     * map used to start at minZoom 1, so a 377 px pane kept zoom 1 (512 px wide
     * world) and the raster overflowed the container. fitWorld must lift the
     * limit before asking, whatever the pane size. */
    const size = {x: 377, y: 318};
    const calls = {minZoom: 1};
    const cover = Math.log2(size.x / 256);
    const map = {
        getSize: () => size,
        project: ([, lon], zoom) => ({x: (lon + 180) / 360 * 256 * Math.pow(2, zoom)}),
        getBoundsZoom: () => Math.max(calls.minZoom, cover),
        setMinZoom: zoom => { calls.minZoom = zoom; },
        setView: (center, zoom) => { calls.zoom = zoom; calls.center = center; }
    };
    const zoom = fitWorld(map);
    close(zoom, cover);
    close(calls.zoom, cover);
    close(calls.minZoom, cover);
    close(256 * Math.pow(2, zoom), size.x);
});

test('wide containers still fit one world to the full width', () => {
    const size = {x: 1200, y: 400};
    const calls = {minZoom: 0};
    const cover = Math.log2(size.x / 256);
    const map = {
        getSize: () => size,
        project: ([, lon], zoom) => ({x: (lon + 180) / 360 * 256 * Math.pow(2, zoom)}),
        getBoundsZoom: () => Math.max(calls.minZoom, cover),
        setMinZoom: zoom => { calls.minZoom = zoom; },
        setView: (center, zoom) => { calls.zoom = zoom; }
    };
    const zoom = fitWorld(map);
    close(zoom, cover);
    close(calls.zoom, cover);
    close(calls.minZoom, cover);
    close(256 * Math.pow(2, zoom), size.x);
});

test('a slightly wide box still leaves Antarctica on screen', () => {
    /* The OP map buys width from the empty band on the right (5:4). The fit then
     * no longer shows the whole world: the squashed polar interior runs past the
     * southern edge, but the northern coast of Antarctica must stay inside and no
     * northern coastline may be pushed out. */
    globalThis.LAND = [
        [-42, 83.565, -20, 70, -42, 83.565],
        [-180, -90, 180, -90, 180, -63.226, -180, -63.226, -180, -90]
    ];
    const size = {x: 500, y: 400};
    const calls = {};
    const map = {
        getSize: () => size,
        project: ([, lon], zoom) => ({x: (lon + 180) / 360 * 256 * Math.pow(2, zoom)}),
        getBoundsZoom: () => Math.log2(size.x / 256),
        setMinZoom: () => {},
        setView: (center, zoom) => { calls.center = center; calls.zoom = zoom; }
    };
    fitWorld(map);
    const span = size.y / (256 * Math.pow(2, calls.zoom));
    const top = mercY(calls.center[0]) - span / 2;
    const bottom = mercY(calls.center[0]) + span / 2;
    assert.ok(span < 1, 'the polar interior is cropped, one world no longer fits');
    assert.ok(top <= mercY(83.565) + 1e-9, 'Greenland keeps its northern coast');
    assert.ok(bottom >= mercY(-63.226) + 1e-9, 'Antarctica must not be cropped away');
    assert.ok(bottom < mercY(-85) - 1e-9, 'only part of Antarctica is cut');
    assert.equal(calls.center[1], 0);
});

test('world view centre matches the fitted latitude', () => {
    const map = {
        getSize: () => ({x: 592, y: 399}),
        project: ([, lon], zoom) => ({x: (lon + 180) / 360 * 256 * Math.pow(2, zoom)})
    };
    const lat = worldViewCenter(map, 1.15)[0];
    assert.ok(Number.isFinite(lat) && lat > 0 && lat < 90);
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

/* Every ring createLandCanvas draws, as the raw path it handed to the context. */
function landPaths(rings, {width = 256, height = 128} = {}) {
    const paths = [];
    let current = null;
    const context = {
        beginPath() { current = []; paths.push(current); },
        moveTo(x, y) { current.push([x, y]); },
        lineTo(x, y) { current.push([x, y]); },
        closePath() { current.push(current[0].slice()); },
        fill() {}, stroke() {}, fillRect() {}
    };
    createLandCanvas({
        land: rings, width, height,
        documentImpl: {createElement: () => ({getContext: () => context})}
    });
    return {paths, width, height};
}

test('pole-reaching rings close along the frame edge, not across the pole', () => {
    /* Shape of the shipped Antarctica ring: cut at the antimeridian, so the two
     * open ends sit on the coast at -180 and +180, and the tail steps down to the
     * pole. A plain closePath joins them with a chord that carves a wedge of
     * ocean out of the bottom of the continent. */
    const coast = [-180, -84, -90, -70, 0, -69, 90, -72, 179, -84, 179, -90, 180, -90];
    const island = [10, -50, 20, -52, 15, -48];
    const {paths, width, height} = landPaths([coast, island]);
    assert.equal(paths.length, 2);
    const [pole, small] = paths;
    const closure = pole.slice(-3, -1);
    assert.deepEqual(closure, [[width, height], [0, height]],
        'the ring must run down to the frame, along it, and back up');
    assert.deepEqual(pole.at(-1), pole[0]);
    assert.equal(pole.filter(([, y]) => y === height).length, 2,
        'no other segment may sit on the frame row');
    /* mercY clamps -90 to -85, so the pole vertices land just inside the frame. */
    assert.ok(pole.at(-4)[1] < height && pole.at(-4)[1] > height * 0.99);
    small.forEach(([x, y]) => {
        assert.ok(y < height && y > 0, 'a mid-latitude coast keeps its own closure');
        assert.ok(x > 0 && x < width);
    });
});

test('rings unwrapped past the antimeridian keep their wrapped copy', () => {
    const seam = [170, 5, -170, 6, 175, -5];
    const {paths, width} = landPaths([seam]);
    assert.equal(paths.length, 2, 'one copy per side of the seam');
    const xOf = lon => (lon + 180) / 360 * width;
    const starts = paths.map(path => path[0][0]).sort((a, b) => a - b);
    assert.deepEqual(starts, [xOf(170 - 360), xOf(170)]);
});

