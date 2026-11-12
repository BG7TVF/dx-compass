/**
 * Shared Leaflet base-map lifecycle and tile providers. Input: a map target and
 * provider/options. Output: {map, tile, setTileProvider, destroy}; no data fetching.
 * Also renders the existing offline window.LAND rings to a canvas image overlay.
 */
import {getLeaflet} from './leaflet.mjs';
import {createRasterPane} from './layers.mjs';
import {clamp, toDegrees, toRadians} from '../geo/coordinates.mjs';

export const WORLD_BOUNDS = [[-85.06, -180], [85.06, 180]];
export const LAND_BOUNDS = [[-85, -180], [85, 180]];
export const AUTO_FIT_MAX_ZOOM = 7;

export const TILE_PROVIDERS = {
    osm: {
        name: 'OpenStreetMap',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: {attribution: '&copy; OpenStreetMap', maxZoom: 18}
    },
    amap: {
        name: '高德地图 (AMap)',
        url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        options: {
            attribution: '&copy; AutoNavi 高德地图', maxZoom: 18,
            minNativeZoom: 3, subdomains: ['1', '2', '3', '4']
        }
    }
};

export const DEFAULT_MAP_OPTIONS = {
    zoomControl: false,
    scrollWheelZoom: true,
    attributionControl: true,
    zoomSnap: 0,
    maxBounds: [[-90, -180], [90, 180]],
    maxBoundsViscosity: 1
};

export function createTileLayer(provider = 'amap', {L = globalThis.L, ...options} = {}) {
    const leaflet = getLeaflet(L);
    const definition = TILE_PROVIDERS[provider] || TILE_PROVIDERS.amap;
    return leaflet.tileLayer(definition.url, {
        ...definition.options,
        ...options,
        noWrap: true,
        bounds: options.bounds || WORLD_BOUNDS
    });
}

export function replaceTileLayer(map, current, provider, options = {}) {
    const next = createTileLayer(provider, options);
    if (current && map.hasLayer(current)) map.removeLayer(current);
    next.addTo(map);
    return next;
}

export function createBaseMap(target, {
    L = globalThis.L,
    provider = 'amap',
    mapOptions = {},
    tileOptions = {}
} = {}) {
    const leaflet = getLeaflet(L);
    const map = leaflet.map(target, {...DEFAULT_MAP_OPTIONS, ...mapOptions});
    let tile = null;
    const setTileProvider = providerKey => {
        tile = replaceTileLayer(map, tile, providerKey, {L: leaflet, ...tileOptions});
        return tile;
    };
    if (provider) setTileProvider(provider);
    return {
        map,
        setTileProvider,
        get tile() { return tile; },
        destroy() {
            if (tile && map.hasLayer(tile)) map.removeLayer(tile);
            tile = null;
            map.remove();
        }
    };
}

/** Recompute the fractional zoom where one world covers the entire container. */
export function setWorldMinZoom(map, bounds = WORLD_BOUNDS) {
    map.setMinZoom(0);
    map.setMinZoom(map.getBoundsZoom(bounds, true));
    if (map.getZoom() !== undefined && map.getZoom() < map.getMinZoom()) {
        map.setZoom(map.getMinZoom());
    }
    return map.getMinZoom();
}

/* A ring that reaches this far south belongs to Antarctica; anything else is
 * continental/coastal land that must stay inside the fitted view. Cape Horn
 * (-55.2 deg) and the sub-Antarctic islands are therefore not mistaken for the
 * Antarctic landmass, whose northern edge is the peninsula near -63 deg. */
const SOUTH_POLAR_REACH = -80;
const LAND_VIEW_FALLBACK = {north: 83.5, antarcticNorth: -63.2};
let landViewCache = null;
let landViewSource = null;

/** Northern limit of continental land plus the northern edge of Antarctica. */
function landViewExtents() {
    const land = globalThis.LAND;
    if (landViewCache && landViewSource === land) return landViewCache;
    let north = -90;
    let antarcticNorth = -90;
    let found = false;
    for (const ring of land || []) {
        if (!ring || !ring.length) continue;
        const flat = typeof ring[0] === 'number';
        const count = flat ? Math.floor(ring.length / 2) : ring.length;
        let highest = -90;
        let lowest = 90;
        for (let i = 0; i < count; i++) {
            const lat = Number(flat ? ring[i * 2 + 1] : ring[i][1]);
            if (!Number.isFinite(lat)) continue;
            if (lat > highest) highest = lat;
            if (lat < lowest) lowest = lat;
        }
        if (highest < -90) continue;
        found = true;
        if (lowest <= SOUTH_POLAR_REACH) antarcticNorth = Math.max(antarcticNorth, highest);
        else north = Math.max(north, highest);
    }
    if (!found || antarcticNorth < -90) landViewCache = LAND_VIEW_FALLBACK;
    else landViewCache = {north, antarcticNorth};
    landViewSource = land;
    return landViewCache;
}

/** Visible Mercator fraction (0-1) of the world at a given zoom. */
function viewSpan(map, zoom) {
    const size = map.getSize();
    const worldPx = map.project([0, 180], zoom).x - map.project([0, -180], zoom).x;
    return size.y / worldPx;
}

/** Centre latitude that keeps every continental coastline inside the viewport
 *  while Antarctica may run past the southern edge. */
export function worldViewCenter(map, zoom) {
    const span = viewSpan(map, zoom);
    const {north, antarcticNorth} = landViewExtents();
    const half = Math.min(0.5, span / 2);
    const center = clamp((mercY(north) + mercY(antarcticNorth)) / 2, half, 1 - half);
    return [mercLat(center), 0];
}

/** Fill the container width exactly with one world, cropping only vertical
 *  ocean/void bands. The centre keeps every continental coastline inside the
 *  viewport (Antarctica may run past the southern edge). */
export function fitWorld(map) {
    /* getBoundsZoom clamps its answer to the current minZoom, so the limit has
     * to be lifted first or a small container keeps the old (too coarse) zoom
     * and the world ends up wider than the map pane. */
    map.setMinZoom(0);
    const zoom = map.getBoundsZoom(WORLD_BOUNDS, true);
    map.setMinZoom(zoom);
    map.setView(worldViewCenter(map, zoom), zoom, {animate: false});
    return zoom;
}

/** Same width-filling fit as fitWorld, but centred on an explicit latitude
 *  window. The documented defaults (85/-85) delegate to fitWorld so the wall
 *  keeps its existing framing byte-for-byte. */
export function fitWorldRange(map, topLat = 85, bottomLat = -85) {
    let north = Number(topLat);
    let south = Number(bottomLat);
    if (!Number.isFinite(north)) north = 85;
    if (!Number.isFinite(south)) south = -85;
    north = clamp(north, -85, 85);
    south = clamp(south, -85, 85);
    if (north < south) [north, south] = [south, north];
    if (north === 85 && south === -85) return fitWorld(map);
    map.setMinZoom(0);
    const zoom = map.getBoundsZoom(WORLD_BOUNDS, true);
    map.setMinZoom(zoom);
    const span = viewSpan(map, zoom);
    const half = Math.min(0.5, span / 2);
    const center = clamp((mercY(north) + mercY(south)) / 2, half, 1 - half);
    map.setView([mercLat(center), 0], zoom, {animate: false});
    return zoom;
}

export function fitPoints(map, points, {L = globalThis.L, maxZoom = AUTO_FIT_MAX_ZOOM, pad = 0.08} = {}) {
    const valid = (points || []).filter(point => point &&
        Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
    setWorldMinZoom(map);
    if (!valid.length) {
        fitWorld(map);
        return;
    }
    const bounds = getLeaflet(L).latLngBounds(valid).pad(pad);
    const zoom = Math.min(Math.max(map.getBoundsZoom(bounds), map.getMinZoom()), maxZoom);
    map.setView(bounds.getCenter(), zoom, {animate: false});
}

export function mercY(lat) {
    const phi = toRadians(clamp(lat, -85, 85));
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
}

/** Inverse of mercY: latitude whose normalised Mercator row is y. */
export function mercLat(y) {
    return toDegrees(Math.atan(Math.sinh((0.5 - Number(y)) * 2 * Math.PI)));
}

/** Unwrap flat [lon, lat, ...] or nested [[lon, lat], ...] rings. */
export function ringPoints(ring) {
    const flat = typeof ring[0] === 'number';
    const count = flat ? Math.floor(ring.length / 2) : ring.length;
    const points = [];
    let previous = null;
    for (let i = 0; i < count; i++) {
        let lon = flat ? ring[i * 2] : ring[i][0];
        const lat = flat ? ring[i * 2 + 1] : ring[i][1];
        if (previous !== null) {
            while (lon - previous > 180) lon -= 360;
            while (previous - lon > 180) lon += 360;
        }
        previous = lon;
        points.push([lon, lat]);
    }
    return points;
}

/** Render an offline land canvas; caller supplies document in non-browser tests. */
export function createLandCanvas({
    land = globalThis.LAND,
    documentImpl = globalThis.document,
    width = 2048,
    height = 1024,
    ocean = '#08111c',
    fill = '#0d1a29',
    stroke = '#1b3550',
    strokeWidth = 1
} = {}) {
    if (!documentImpl || typeof documentImpl.createElement !== 'function') {
        throw new Error('document.createElement is required for the offline land canvas');
    }
    const canvas = documentImpl.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const xOf = lon => (lon + 180) / 360 * width;
    const yOf = lat => mercY(lat) * height;
    context.fillStyle = ocean;
    context.fillRect(0, 0, width, height);
    (land || []).forEach(ring => {
        const points = ringPoints(ring);
        if (points.length < 3) return;
        let minLon = Infinity, maxLon = -Infinity;
        points.forEach(point => {
            minLon = Math.min(minLon, point[0]);
            maxLon = Math.max(maxLon, point[0]);
        });
        const offsets = [0];
        if (maxLon > 180) offsets.push(-360);
        if (minLon < -180) offsets.push(360);
        offsets.forEach(offset => {
            context.beginPath();
            points.forEach((point, index) => {
                const x = xOf(point[0] + offset), y = yOf(point[1]);
                if (index === 0) context.moveTo(x, y);
                else context.lineTo(x, y);
            });
            context.closePath();
            if (fill) {
                context.fillStyle = fill;
                context.fill();
            }
            if (stroke) {
                context.strokeStyle = stroke;
                context.lineWidth = strokeWidth;
                context.stroke();
            }
        });
    });
    return canvas;
}

export function createOfflineLandOverlay({L = globalThis.L, bounds = LAND_BOUNDS, pane = 'raster', ...options} = {}) {
    const canvas = createLandCanvas(options);
    return getLeaflet(L).imageOverlay(canvas.toDataURL('image/png'), bounds, {
        opacity: 1,
        interactive: false,
        pane
    });
}

export function addOfflineLand(map, options = {}) {
    const pane = options.pane || 'raster';
    createRasterPane(map, pane, options.zIndex || 250);
    return createOfflineLandOverlay({...options, pane}).addTo(map);
}
