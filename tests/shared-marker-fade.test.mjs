import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarkerFade} from '../public/shared/map/marker-fade.mjs';

/* 假 Leaflet 图层：只保留淡出真正会碰到的接口——矢量图层的 setStyle、
 * 图标标记的 getElement，以及图层组的 removeLayer。 */
function stubShape(initial = {}) {
    return Object.assign({}, initial, {
        setStyle(options) {
            Object.assign(this, options);
            return this;
        }
    });
}

function stubIcon() {
    const element = {style: {}};
    return {element, getElement: () => element};
}

function stubGroup() {
    const layers = new Set();
    return {
        layers,
        add(layer) { layers.add(layer); },
        removeLayer(layer) { layers.delete(layer); }
    };
}

/* 出生 0、到期 1000：中点淡出比例应为 0.5。 */
const BORN = 0;
const DIE = 1000;

function addRecord(fade, group) {
    const entry = fade.add({group, bornAt: BORN, dieAt: DIE});
    const track = stubShape({opacity: 0.8});
    const dot = stubShape({opacity: 1, fillOpacity: 0.6});
    const icon = stubIcon();
    entry.addTrack([track], 0.8);
    entry.addDot(dot, 1, 0.6);
    entry.addIcon(icon);
    [track, dot, icon].forEach(layer => group.add(layer));
    return {entry, track, dot, icon};
}

test('tick 把淡出比例乘到每个图层的基准透明度上', () => {
    const fade = createMarkerFade();
    const group = stubGroup();
    const {track, dot, icon} = addRecord(fade, group);

    fade.tick(500);
    assert.equal(track.opacity, 0.4);            // 0.5 × 0.8
    assert.equal(dot.opacity, 0.5);               // 0.5 × 1
    assert.equal(dot.fillOpacity, 0.3);           // 0.5 × 0.6
    assert.equal(String(icon.element.style.opacity), '0.5');

    fade.tick(0);
    assert.equal(track.opacity, 0.8);
    assert.equal(dot.fillOpacity, 0.6);
});

test('不限时长（dieAt=Infinity）的记录不参与淡出，也不会被剪掉', () => {
    const fade = createMarkerFade();
    const group = stubGroup();
    const entry = fade.add({group, bornAt: 0, dieAt: Infinity});
    const track = stubShape({opacity: 0.9});
    entry.addTrack([track], 0.9);
    group.add(track);

    fade.tick(10 ** 12);
    assert.equal(track.opacity, 0.9);
    fade.prune(10 ** 12);
    assert.equal(fade.size, 1);
    assert.equal(group.layers.has(track), true);
});

test('prune 只摘到期记录的图层，没到期的留在原处', () => {
    const fade = createMarkerFade();
    const group = stubGroup();
    const alive = addRecord(fade, group);
    const dead = fade.add({group, bornAt: 0, dieAt: 100});
    const deadTrack = stubShape({opacity: 0.4});
    dead.addTrack([deadTrack], 0.4);
    group.add(deadTrack);
    assert.equal(fade.size, 2);

    fade.prune(500);
    assert.equal(fade.size, 1);
    assert.equal(group.layers.has(deadTrack), false);
    assert.equal(group.layers.has(alive.track), true);
    assert.equal(group.layers.has(alive.dot), true);
    assert.equal(group.layers.has(alive.icon), true);
});

test('reset 清空账本但不碰图层，drop 只撤账不摘图层', () => {
    const fade = createMarkerFade();
    const group = stubGroup();
    const {track} = addRecord(fade, group);
    const lonely = fade.add({group, bornAt: 0, dieAt: 100});
    const orphan = stubShape({opacity: 0.5});
    lonely.addTrack([orphan], 0.5);
    group.add(orphan);
    assert.equal(fade.size, 2);

    fade.drop(lonely);
    assert.equal(fade.size, 1);
    fade.prune(10 ** 9);
    assert.equal(fade.size, 0);
    assert.equal(group.layers.has(track), false);   // 到期的那条确实被摘掉
    assert.equal(group.layers.has(orphan), true);   // drop 只撤账，不碰图层

    const again = addRecord(fade, group);
    fade.reset();
    assert.equal(fade.size, 0);
    assert.equal(group.layers.has(again.track), true);  // 图层归地图自己管
});
