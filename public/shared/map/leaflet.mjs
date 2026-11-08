/**
 * Legacy Leaflet global adapter. Input: window/globalThis or an L namespace.
 * Output: the existing L object; no scripts are loaded and no globals are changed.
 */
const LEAFLET_METHODS = ['map', 'tileLayer', 'layerGroup', 'polygon', 'polyline', 'imageOverlay'];
const isNamespace = value => Boolean(value && LEAFLET_METHODS.some(name => typeof value[name] === 'function'));

export function getLeaflet(root = globalThis) {
    const namespace = root && root.L ? root.L : (isNamespace(root) ? root : null);
    if (!namespace) throw new Error('Leaflet global L is unavailable');
    return namespace;
}

export function hasLeaflet(root = globalThis) {
    return Boolean(root && (root.L || isNamespace(root)));
}
