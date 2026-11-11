/**
 * Shared offline country-border layer. Input: a Leaflet map and optional style.
 * Output: one layer group drawn from window.MAP_BORDERS; no data fetching.
 *
 * Borders use the same 50m Natural Earth outline as the coastlines and the same
 * canvas renderer shape (one pane, one renderer) so both views stay identical.
 * The data file stores flat [lon, lat, ...] lines, which Leaflet needs as
 * [lat, lon] pairs; that swap is the single conversion point.
 */
import {getLeaflet} from './leaflet.mjs';
import {createRasterPane} from './layers.mjs';

export const BORDER_PANE = 'map-borders';
export const BORDER_Z_INDEX = 210;
export const BORDER_STYLE = {color: '#3d5666', weight: 0.7, opacity: 0.75};

/** Flat [lon, lat, ...] -> Leaflet [lat, lon] pairs, skipping invalid values. */
export function borderLatLngs(flat) {
    if (!Array.isArray(flat)) return [];
    const latlngs = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
        const lon = Number(flat[i]);
        const lat = Number(flat[i + 1]);
        if (Number.isFinite(lon) && Number.isFinite(lat)) latlngs.push([lat, lon]);
    }
    return latlngs;
}

/** Border lines from the generated data file; an empty list when absent. */
export function borderLines(root = globalThis) {
    const lines = root && root.MAP_BORDERS;
    return Array.isArray(lines) ? lines : [];
}

export function addOfflineBorders(map, {
    L = globalThis.L,
    root = globalThis,
    color = BORDER_STYLE.color,
    weight = BORDER_STYLE.weight,
    opacity = BORDER_STYLE.opacity,
    dashArray = null,
    pane = BORDER_PANE,
    zIndex = BORDER_Z_INDEX
} = {}) {
    const leaflet = getLeaflet(L);
    const lines = borderLines(root);
    if (!lines.length) return null;
    createRasterPane(map, pane, zIndex);
    const renderer = typeof leaflet.canvas === 'function' ? leaflet.canvas({padding: 0.3, pane}) : null;
    const group = leaflet.layerGroup();
    const style = {color, weight, opacity, interactive: false};
    if (dashArray) style.dashArray = dashArray;
    if (renderer) style.renderer = renderer;
    for (const flat of lines) {
        const latlngs = borderLatLngs(flat);
        if (latlngs.length < 2) continue;
        group.addLayer(leaflet.polyline(latlngs, {...style}));
    }
    group.addTo(map);
    return group;
}

/** Remove a layer group returned by addOfflineBorders. */
export function clearOfflineBorders(map, group) {
    if (group && map.hasLayer(group)) map.removeLayer(group);
}
