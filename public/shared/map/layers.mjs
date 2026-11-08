/**
 * Leaflet layer lifecycle helpers. Input: an existing map, layer options and
 * seam-cut [lat, lon] paths. Output: tracked groups/layers; no network or business state.
 */
import {getLeaflet} from './leaflet.mjs';

export function createRasterPane(map, name = 'raster', zIndex = 250) {
    if (!map.getPane(name)) map.createPane(name);
    map.getPane(name).style.zIndex = zIndex;
    return map.getPane(name);
}

export function createLayerGroup(map, {L = globalThis.L} = {}) {
    return getLeaflet(L).layerGroup().addTo(map);
}

export function setLayerVisible(map, layer, visible) {
    if (!layer) return false;
    const has = map.hasLayer(layer);
    if (visible && !has) map.addLayer(layer);
    if (!visible && has) map.removeLayer(layer);
    return Boolean(visible);
}

export function removeLayers(map, layers) {
    (layers || []).forEach(layer => {
        if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    });
}

/** Build non-interactive polylines from great-circle/track path segments. */
export function addTrackPaths(map, paths, {L = globalThis.L, group = map, ...options} = {}) {
    const leaflet = getLeaflet(L);
    return (paths || []).map(path => leaflet.polyline(path, {
        weight: 2,
        opacity: 0.85,
        interactive: false,
        ...options
    }).addTo(group));
}
