import {clamp} from '../shared/geo/coordinates.mjs';
import {computeTerminator, solarCosAt} from '../shared/map/terminator.mjs';
import {trackPaths} from '../shared/geo/great-circle.mjs';
import {gridToLatLon} from '../shared/geo/maidenhead.mjs';
import {
    addOfflineLand,
    createBaseMap,
    LAND_BOUNDS,
    mercLat,
    mercY
} from '../shared/map/base-map.mjs';
import {getLeaflet} from '../shared/map/leaflet.mjs';
import {
    addTrackPaths,
    createLayerGroup,
    removeLayers,
    setLayerVisible
} from '../shared/map/layers.mjs';
import {
    MUF_LAYER_ALPHA, MUF_LEGEND_VALUES, TWILIGHT_ELEVATION_DEG,
    mufColor, mufRgb, nightShadeAlpha, sampleMufGrid
} from '../shared/propagation/forecast-view.mjs';

const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0', dxspot: '#ff6b6b'};
const WORLD_FIT = [[-62, -180], [85, 180]];
const TOP_LAT = 85;
const BOTTOM_LAT = -85;

/* Rows follow the Leaflet Mercator projection so the MUF field lines up with
 * the Mercator-rendered land instead of stretching towards the poles. */
function rowLat(row, rows) {
    const top = mercY(TOP_LAT), bottom = mercY(BOTTOM_LAT);
    return mercLat(top + (row + 0.5) / rows * (bottom - top));
}

function fieldSize(map) {
    const size = map.getSize();
    return {
        width: Math.max(200, Math.min(720, Math.round(size.x / 2))),
        height: Math.max(100, Math.min(360, Math.round(size.y / 2)))
    };
}

function mufImage(mufGrid, {width, height}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const pixels = image.data;
    for (let y = 0; y < height; y++) {
        const lat = rowLat(y, height);
        for (let x = 0; x < width; x++) {
            const lon = -180 + (x + 0.5) * 360 / width;
            const value = sampleMufGrid(mufGrid, lat, lon);
            if (value === null || value === undefined || !isFinite(value)) continue;
            const rgb = mufRgb(value);
            const offset = (y * width + x) * 4;
            pixels[offset] = rgb[0];
            pixels[offset + 1] = rgb[1];
            pixels[offset + 2] = rgb[2];
            pixels[offset + 3] = 255;
        }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
}

function nightImage(when, {width, height}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const pixels = image.data;
    const geometry = computeTerminator(when);
    const hasTwilight = Math.abs(Math.sin(geometry.dec * Math.PI / 180)) >=
        Math.abs(Math.sin(TWILIGHT_ELEVATION_DEG * Math.PI / 180));
    for (let y = 0; y < height; y++) {
        const lat = rowLat(y, height);
        for (let x = 0; x < width; x++) {
            const lon = -180 + (x + 0.5) * 360 / width;
            const alpha = nightShadeAlpha(solarCosAt(geometry, lat, lon), hasTwilight);
            if (alpha <= 0) continue;
            const offset = (y * width + x) * 4;
            pixels[offset + 3] = Math.round(alpha * 255);
        }
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
}

export function createWallMap() {
    const L = getLeaflet();
    const {map} = createBaseMap('map', {
        L,
        provider: null,
        mapOptions: {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            touchZoom: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            zoomSnap: 0,
            minZoom: 1,
            maxZoom: 6,
            maxBounds: LAND_BOUNDS,
            maxBoundsViscosity: 1
        }
    });
    addOfflineLand(map, {L, bounds: LAND_BOUNDS, pane: 'raster', zIndex: 250});
    map.fitBounds(WORLD_FIT, {animate: false});

    const views = {};
    ['aurora', 'weather', 'qso', 'myspot', 'dxspot'].forEach(key => {
        views[key] = createLayerGroup(map, {L});
        setLayerVisible(map, views[key], false);
    });
    const visible = {};
    let mufOverlay = null;
    let nightOverlay = null;

    function setVisible(key, on) {
        visible[key] = Boolean(on);
        if (key === 'prop') {
            setLayerVisible(map, mufOverlay, visible[key]);
            setLayerVisible(map, nightOverlay, visible[key]);
            return;
        }
        setLayerVisible(map, views[key], visible[key]);
    }

    function renderProp(mufGrid) {
        if (!mufGrid || !Array.isArray(mufGrid.values)) return;
        const when = new Date();
        const size = fieldSize(map);
        const nextMuf = L.imageOverlay(mufImage(mufGrid, size), LAND_BOUNDS, {
            opacity: MUF_LAYER_ALPHA,
            interactive: false,
            pane: 'raster'
        });
        const nextNight = L.imageOverlay(nightImage(when, size), LAND_BOUNDS, {
            opacity: 1,
            interactive: false,
            pane: 'raster'
        });
        removeLayers(map, [mufOverlay, nightOverlay]);
        mufOverlay = nextMuf;
        nightOverlay = nextNight;
        setLayerVisible(map, mufOverlay, visible.prop);
        setLayerVisible(map, nightOverlay, visible.prop);
    }

    function drawSpots(rows, myCall) {
        const my = String(myCall || '').toUpperCase();
        const cutoff = Date.now() - 30 * 60 * 1000;
        views.myspot.clearLayers();
        views.dxspot.clearLayers();
        rows.forEach(row => {
            const time = new Date(row.timestamp).getTime();
            if (!isFinite(time) || time < cutoff) return;
            const mine = String(row.monitored_call || '').toUpperCase() === my;
            const color = mine ? COLORS.myspot : COLORS.dxspot;
            const group = mine ? views.myspot : views.dxspot;
            const hasDe = row.lat !== null && row.lat !== undefined &&
                row.lon !== null && row.lon !== undefined;
            const hasDx = row.dx_lat !== null && row.dx_lat !== undefined &&
                row.dx_lon !== null && row.dx_lon !== undefined;
            if (hasDx) {
                L.circleMarker([row.dx_lat, row.dx_lon], {
                    radius: 3, color, weight: 1, fillColor: color, fillOpacity: 0.85,
                    interactive: false
                }).addTo(group);
            }
            if (hasDe) {
                L.circleMarker([row.lat, row.lon], {
                    radius: 2.4, color, weight: 1, fillColor: color, fillOpacity: 0.55,
                    interactive: false
                }).addTo(group);
            }
            if (hasDe && hasDx) {
                addTrackPaths(map, trackPaths(row.dx_lat, row.dx_lon, row.lat, row.lon, 64), {
                    L, group, color, weight: 1.1, opacity: 0.45
                });
            }
        });
    }

    function drawQso(rows, grid) {
        const group = views.qso;
        group.clearLayers();
        const home = gridToLatLon(grid);
        rows.forEach(qso => {
            if (qso.lat === null || qso.lat === undefined ||
                qso.lon === null || qso.lon === undefined) return;
            L.circleMarker([qso.lat, qso.lon], {
                radius: 2.6, color: COLORS.qso, weight: 1,
                fillColor: COLORS.qso, fillOpacity: 0.8, interactive: false
            }).addTo(group);
            if (home) {
                addTrackPaths(map, trackPaths(home[0], home[1], qso.lat, qso.lon, 64), {
                    L, group, color: COLORS.qso, weight: 1, opacity: 0.35
                });
            }
        });
        if (home) {
            L.circleMarker(home, {
                radius: 6, color: '#ffffff', weight: 2,
                fillColor: COLORS.qso, fillOpacity: 1, interactive: false
            }).addTo(group);
        }
    }

    function drawAurora(data) {
        const group = views.aurora;
        group.clearLayers();
        const points = data && data.aurora && data.aurora.grid || [];
        points.forEach(point => {
            const probability = point[2];
            L.circleMarker([point[1], point[0]], {
                radius: 2 + probability / 22,
                color: 'hsla(' + (140 + probability * 1.5) + ',85%,62%,0.9)',
                weight: 0,
                fillColor: 'hsla(' + (140 + probability * 1.5) + ',85%,62%,0.55)',
                fillOpacity: 0.55,
                interactive: false
            }).addTo(group);
        });
    }

    function drawWeather(data) {
        const group = views.weather;
        group.clearLayers();
        const points = data && data.wx && data.wx.pts || [];
        points.forEach(point => {
            const temperature = point[2];
            if (temperature === null || !isFinite(temperature)) return;
            const hue = clamp(210 - temperature * 6, 0, 210);
            L.circleMarker([point[0], point[1]], {
                radius: 5,
                color: 'transparent',
                weight: 0,
                fillColor: 'hsl(' + hue + ',80%,60%)',
                fillOpacity: 0.7,
                interactive: false
            }).addTo(group);
        });
    }

    return {
        setVisible,
        renderProp,
        drawSpots,
        drawQso,
        drawAurora,
        drawWeather,
        fit() {
            map.invalidateSize();
            map.fitBounds(WORLD_FIT, {animate: false});
        },
        invalidate() {
            map.invalidateSize();
        },
        mufLegendGradient() {
            return MUF_LEGEND_VALUES.map((value, index) => mufColor(value) + ' ' +
                Math.round(index * 100 / (MUF_LEGEND_VALUES.length - 1)) + '%').join(',');
        }
    };
}
