import {clamp} from '../shared/geo/coordinates.mjs';
import {solarCos} from '../shared/map/terminator.mjs';
import {trackPaths} from '../shared/geo/great-circle.mjs';
import {gridToLatLon} from '../shared/geo/maidenhead.mjs';
import {
    addOfflineLand,
    createBaseMap,
    LAND_BOUNDS
} from '../shared/map/base-map.mjs';
import {getLeaflet} from '../shared/map/leaflet.mjs';
import {
    addTrackPaths,
    createLayerGroup,
    removeLayers,
    setLayerVisible
} from '../shared/map/layers.mjs';
import {mufColor, sampleMufGrid} from '../shared/propagation/forecast-view.mjs';

const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0', dxspot: '#ff6b6b'};
const WORLD_FIT = [[-62, -180], [85, 180]];
const FIELD_W = 200;
const FIELD_H = 100;
const MUF_LEGEND_VALUES = [3, 8.4, 13.8, 19.2, 24.6, 30];

function fieldCanvas(mufGrid, when, night) {
    const canvas = document.createElement('canvas');
    canvas.width = FIELD_W;
    canvas.height = FIELD_H;
    const context = canvas.getContext('2d');
    if (!night) {
        context.globalAlpha = 150 / 255;
        for (let y = 0; y < FIELD_H; y++) {
            const lat = 85 - (y + 0.5) * 170 / FIELD_H;
            for (let x = 0; x < FIELD_W; x++) {
                const lon = -180 + (x + 0.5) * 360 / FIELD_W;
                const value = sampleMufGrid(mufGrid, lat, lon);
                if (value === null || value === undefined || !isFinite(value)) continue;
                context.fillStyle = mufColor(value);
                context.fillRect(x, y, 1, 1);
            }
        }
        return canvas.toDataURL('image/png');
    }

    const image = context.createImageData(FIELD_W, FIELD_H);
    const pixels = image.data;
    for (let y = 0; y < FIELD_H; y++) {
        const lat = 85 - (y + 0.5) * 170 / FIELD_H;
        for (let x = 0; x < FIELD_W; x++) {
            const lon = -180 + (x + 0.5) * 360 / FIELD_W;
            const offset = (y * FIELD_W + x) * 4;
            pixels[offset] = 2;
            pixels[offset + 1] = 6;
            pixels[offset + 2] = 12;
            pixels[offset + 3] = Math.round(150 * clamp((0.12 - solarCos(lat, lon, when)) / 0.24, 0, 1));
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
        const now = new Date();
        const nextMuf = L.imageOverlay(fieldCanvas(mufGrid, now, false), LAND_BOUNDS, {
            opacity: 0.72,
            interactive: false,
            pane: 'raster'
        });
        const nextNight = L.imageOverlay(fieldCanvas(mufGrid, now, true), LAND_BOUNDS, {
            opacity: 0.9,
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
