import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BORDER_PANE,
    BORDER_STYLE,
    BORDER_Z_INDEX,
    addOfflineBorders,
    borderLatLngs,
    borderLines,
    clearOfflineBorders
} from '../public/shared/map/borders.mjs';

function fakeMap() {
    const panes = new Map();
    const layers = new Set();
    return {
        panes,
        layers,
        getPane: name => panes.get(name) || null,
        createPane(name) {
            const pane = {style: {}};
            panes.set(name, pane);
            return pane;
        },
        addLayer(layer) { layers.add(layer); },
        removeLayer(layer) { layers.delete(layer); },
        hasLayer(layer) { return layers.has(layer); }
    };
}

function fakeLeaflet() {
    const polylines = [];
    const canvasCalls = [];
    const groups = [];
    return {
        polylines,
        canvasCalls,
        groups,
        canvas(options) {
            canvasCalls.push(options);
            return {kind: 'canvas'};
        },
        polyline(latlngs, options) {
            const line = {latlngs, options};
            polylines.push(line);
            return line;
        },
        layerGroup() {
            const group = {
                items: [],
                addLayer(layer) { group.items.push(layer); },
                addTo(map) { map.addLayer(group); return group; }
            };
            groups.push(group);
            return group;
        }
    };
}

const root = {MAP_BORDERS: [[-1, 33.9, -3.1, 37.7, -3.7, 37.8], [10, 10], [0, 0, 1, 1]]};

test('flat border data becomes [lat, lon] pairs', () => {
    assert.deepEqual(borderLatLngs([-1, 33.9, -3.1, 37.7]), [[33.9, -1], [37.7, -3.1]]);
    assert.deepEqual(borderLatLngs([0, 0, Number.NaN, 1, 2, 2]), [[0, 0], [2, 2]]);
    assert.deepEqual(borderLatLngs(null), []);
});

test('border data is read only from MAP_BORDERS', () => {
    assert.deepEqual(borderLines(root), root.MAP_BORDERS);
    assert.deepEqual(borderLines({BORDERS: root.MAP_BORDERS}), []);
    assert.deepEqual(borderLines({}), []);
});

test('offline borders render on the shared border pane with the default style', () => {
    const L = fakeLeaflet();
    const map = fakeMap();
    const group = addOfflineBorders(map, {L, root});
    assert.ok(group);
    assert.equal(map.panes.get(BORDER_PANE).style.zIndex, BORDER_Z_INDEX);
    assert.equal(L.canvasCalls.length, 1);
    assert.equal(L.canvasCalls[0].pane, BORDER_PANE);
    assert.deepEqual(L.polylines.map(line => line.latlngs), [
        [[33.9, -1], [37.7, -3.1], [37.8, -3.7]],
        [[0, 0], [1, 1]]
    ]);
    assert.equal(L.polylines[0].options.color, BORDER_STYLE.color);
    assert.equal(L.polylines[0].options.weight, BORDER_STYLE.weight);
    assert.equal(L.polylines[0].options.opacity, BORDER_STYLE.opacity);
    assert.equal(L.polylines[0].options.interactive, false);
    assert.deepEqual(L.polylines[0].options.renderer, {kind: 'canvas'});
    assert.equal(map.hasLayer(group), true);
});

test('style overrides are applied and lines shorter than two points are skipped', () => {
    const L = fakeLeaflet();
    const map = fakeMap();
    addOfflineBorders(map, {L, root, color: '#fff', weight: 2, opacity: 1, dashArray: '4 3'});
    assert.equal(L.polylines.length, 2);
    assert.equal(L.polylines[0].options.color, '#fff');
    assert.equal(L.polylines[0].options.weight, 2);
    assert.equal(L.polylines[0].options.opacity, 1);
    assert.equal(L.polylines[0].options.dashArray, '4 3');
});

test('missing data returns null without touching the map', () => {
    const L = fakeLeaflet();
    const map = fakeMap();
    assert.equal(addOfflineBorders(map, {L, root: {}}), null);
    assert.equal(map.panes.size, 0);
    assert.equal(L.polylines.length, 0);
    assert.equal(L.canvasCalls.length, 0);
});

test('clearOfflineBorders removes only an attached group', () => {
    const L = fakeLeaflet();
    const map = fakeMap();
    const group = addOfflineBorders(map, {L, root});
    clearOfflineBorders(map, group);
    assert.equal(map.hasLayer(group), false);
    clearOfflineBorders(map, null);
});
