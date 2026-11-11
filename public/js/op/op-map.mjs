/**
 * Fixed offline map for the OP view. No tile provider is used: the coastline
 * comes from the project's bundled LAND rings and the borders from BORDERS.
 * Leaflet's zoom/pan gestures are disabled so a click is always a bearing pick.
 */
import {addOfflineLand, createBaseMap, fitWorld, WORLD_BOUNDS} from '../../shared/map/base-map.mjs';
import {distanceKm, bearing} from '../../shared/geo/coordinates.mjs';
import {getForecastMapData} from '../../shared/propagation/forecast-view.mjs';

const RADIO_COLORS = ['#00e5ff', '#ffb020'];

export function createOpMap(container, {onBearing, canRotate} = {}) {
    const L = globalThis.L;
    const base = createBaseMap(container, {
        provider: null,
        mapOptions: {
            zoomControl: false,
            attributionControl: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            touchZoom: false,
            boxZoom: false,
            keyboard: false,
            dragging: false,
            inertia: false,
            zoomSnap: 0,
            maxBounds: WORLD_BOUNDS,
            maxBoundsViscosity: 1
        }
    });
    const map = base.map;
    addOfflineLand(map, {fill: '#1d2a35', line: '#4d6b7d'});
    drawBorders(map);

    const qsoGroup = L.layerGroup().addTo(map);
    const spotGroup = L.layerGroup().addTo(map);
    const homeGroup = L.layerGroup().addTo(map);
    const rotGroup = L.layerGroup().addTo(map);

    let home = null;
    let target = null;

    map.on('click', event => {
        if (!home || !onBearing) return;
        const lat = event.latlng.lat;
        const lon = event.latlng.lng;
        const deg = (bearing(home.lat, home.lon, lat, lon) + 360) % 360;
        const km = distanceKm(home.lat, home.lon, lat, lon);
        // A click is only a bearing pick when a rotator is configured; without
        // one the handler is still told so it can explain why nothing happened.
        if (canRotate && !canRotate()) {
            onBearing(deg, {lat, lon, km, blocked: true});
            return;
        }
        target = {lat, lon, deg};
        drawRotatorLine();
        onBearing(deg, {lat, lon, km});
    });

    function drawBorders(mapInstance) {
        const geo = getForecastMapData();
        const lines = Array.isArray(geo.borders) ? geo.borders : [];
        if (!lines.length) return;
        const renderer = L.canvas({padding: 0.3, pane: 'overlayPane'});
        for (const flat of lines) {
            const latlngs = [];
            for (let i = 0; i + 1 < flat.length; i += 2) latlngs.push([flat[i], flat[i + 1]]);
            if (latlngs.length < 2) continue;
            L.polyline(latlngs, {
                renderer,
                color: '#3d5666',
                weight: 0.7,
                opacity: 0.75,
                interactive: false
            }).addTo(mapInstance);
        }
    }

    function drawRotatorLine() {
        rotGroup.clearLayers();
        if (!home || !target) return;
        L.polyline([[home.lat, home.lon], [target.lat, target.lon]], {
            color: '#ffb020', weight: 1.6, opacity: 0.95, dashArray: '5 4', interactive: false
        }).addTo(rotGroup);
        L.circleMarker([target.lat, target.lon], {
            radius: 4, color: '#ffb020', fillColor: '#ffb020', fillOpacity: 1, weight: 1
        }).addTo(rotGroup);
    }

    function setHome(next) {
        home = next && isFinite(next.lat) && isFinite(next.lon) ? {lat: Number(next.lat), lon: Number(next.lon)} : null;
        homeGroup.clearLayers();
        if (!home) return;
        L.circleMarker([home.lat, home.lon], {
            radius: 5, color: '#00e08a', fillColor: '#00e08a', fillOpacity: 0.95, weight: 2
        }).addTo(homeGroup);
        L.circleMarker([home.lat, home.lon], {
            radius: 11, color: '#00e08a', fillColor: 'transparent', weight: 1, opacity: 0.5
        }).addTo(homeGroup);
        drawRotatorLine();
    }

    function setData({qsos = [], spots = [], radioFilter = 'all'} = {}) {
        qsoGroup.clearLayers();
        spotGroup.clearLayers();
        if (!home) return;

        for (const qso of qsos) {
            if (!isFinite(qso.lat) || !isFinite(qso.lon)) continue;
            if (radioFilter !== 'all' && String(qso.radioNr) !== String(radioFilter)) continue;
            const radio = Number(qso.radioNr) === 2 ? 2 : 1;
            L.polyline([[home.lat, home.lon], [qso.lat, qso.lon]], {
                color: RADIO_COLORS[radio - 1],
                weight: radio === 2 ? 1.1 : 1.4,
                opacity: radio === 2 ? 0.45 : 0.6,
                dashArray: radio === 2 ? '3 4' : null,
                interactive: false
            }).addTo(qsoGroup);
            L.marker([qso.lat, qso.lon], {
                interactive: false,
                icon: L.divIcon({
                    className: 'op-map-dot r' + radio,
                    html: '<i></i>',
                    iconSize: [9, 9],
                    iconAnchor: [4.5, 4.5]
                })
            }).addTo(qsoGroup);
        }

        for (const spot of spots) {
            const lat = Number(spot.lat);
            const lon = Number(spot.lon);
            if (!isFinite(lat) || !isFinite(lon)) continue;
            L.polyline([[home.lat, home.lon], [lat, lon]], {
                color: '#8fe3ff', weight: 0.8, opacity: 0.28, dashArray: '1 5', interactive: false
            }).addTo(spotGroup);
            L.circleMarker([lat, lon], {
                radius: 2.6, color: '#8fe3ff', fillColor: '#0a1929',
                fillOpacity: 0.65, weight: 1, interactive: false
            }).addTo(spotGroup);
        }
    }

    function resize() {
        map.invalidateSize();
        const zoom = fitWorld(map);
        map.setMaxZoom(zoom);
    }

    return {
        map,
        setHome,
        setData,
        resize,
        get target() { return target; },
        destroy() {
            base.destroy();
        }
    };
}
