/**
 * Fixed offline map for the OP view. Everything visual comes from the shared
 * map surface: offline land, 50m borders, fixed world fit and the layer groups.
 * Leaflet's zoom/pan gestures are disabled so a click is always a bearing pick.
 */
import {createMapSurface} from '../../shared/map/surface.mjs';
import {cssVar} from '../ui.mjs';
import {
    bearing, distanceKm, toRadians, toDegrees, normalizeLongitude, relativeLongitude
} from '../../shared/geo/coordinates.mjs';
import {trackPaths} from '../../shared/geo/great-circle.mjs';
import {addTrackPaths} from '../../shared/map/layers.mjs';
import {qsoDotIcon} from '../../shared/map/markers.mjs';

const RADIO_COLORS = ['#00e5ff', '#ffb020'];
/* Leaflet needs literal colours, so every draw resolves the active theme tokens
 * and falls back to the dark-console defaults when no theme is mounted. */
function radioColors() {
    return [
        cssVar('--op-r1', RADIO_COLORS[0]),
        cssVar('--op-r2', RADIO_COLORS[1])
    ];
}
/* Antenna coverage wedge: the two edges are great-circle lines leaving the home
 * station at the rotator heading ± HALF_DEG, capped at RADIUS_DEG of arc so the
 * beam reads as a direction, not a full lune. Longitudes are kept continuous
 * relative to home and drawn on three world copies so the beam never splits at
 * the antimeridian. */
const COVERAGE_HALF_DEG = 30;
const COVERAGE_RADIUS_DEG = 55;
const COVERAGE_COLOR = '#ffb020';
const COVERAGE_EDGE = 84;
const clampLat = value => Math.max(-COVERAGE_EDGE, Math.min(COVERAGE_EDGE, value));

/* Width-driven world fit for the map box. The centre container now owns a
 * single 1fr track, so its right edge lines up with the amplifier bay and the
 * map fills the container. Filling that width fixes the zoom, so the visible
 * latitude band shortens as the box grows wider than it is tall: 81..-66 is the
 * window whose centre the view holds, south of the plain land midpoint. A tall
 * box is clamped back to the frame and still shows Greenland in full; a
 * squeezed box loses the empty ice cap north of 81 N rather than the Antarctic
 * peninsula. */
const OP_VIEW_RANGE = [81, -66];

/** Destination point on the sphere: [lat, lon] degrees from a start + bearing + arc. */
function destination(lat, lon, headingDeg, arcDeg) {
    const delta = toRadians(arcDeg);
    const theta = toRadians(headingDeg);
    const phi1 = toRadians(lat);
    const lambda1 = toRadians(lon);
    const sinPhi2 = Math.sin(phi1) * Math.cos(delta) +
        Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
    const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
    const lambda2 = lambda1 + Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
        Math.cos(delta) - Math.sin(phi1) * sinPhi2
    );
    return [toDegrees(phi2), normalizeLongitude(toDegrees(lambda2))];
}

function coverageOutline(home, heading) {
    const left = heading - COVERAGE_HALF_DEG;
    const right = heading + COVERAGE_HALF_DEG;
    const radialSteps = 12;
    const arcSteps = 24;
    const continuous = ([lat, lon]) =>
        [clampLat(lat), home.lon + relativeLongitude(lon, home.lon)];
    const outline = [[home.lat, home.lon]];
    for (let i = 1; i <= radialSteps; i += 1) {
        outline.push(continuous(destination(home.lat, home.lon, left, COVERAGE_RADIUS_DEG * i / radialSteps)));
    }
    for (let i = 1; i <= arcSteps; i += 1) {
        const headingStep = left + (right - left) * i / arcSteps;
        outline.push(continuous(destination(home.lat, home.lon, headingStep, COVERAGE_RADIUS_DEG)));
    }
    for (let i = radialSteps; i >= 0; i -= 1) {
        outline.push(continuous(destination(home.lat, home.lon, right, COVERAGE_RADIUS_DEG * i / radialSteps)));
    }
    return outline;
}

export function createOpMap(container, {onBearing, canRotate} = {}) {
    const L = globalThis.L;
    const surface = createMapSurface(container, {
        provider: 'offline',
        view: {kind: 'world', lockZoom: true, range: OP_VIEW_RANGE},
        land: {show: true},
        borders: {show: true},
        interaction: {zoom: false, pan: false, click: true},
        resize: {observe: true, debounce: 120},
        layers: ['coverage', 'qso', 'spot', 'home', 'rotator'],
        on: {
            click(latlng) {
                if (!home || !onBearing) return;
                const lat = latlng.lat;
                const lon = latlng.lng;
                const deg = (bearing(home.lat, home.lon, lat, lon) + 360) % 360;
                const km = distanceKm(home.lat, home.lon, lat, lon);
                // A click is only a bearing pick when a rotator is configured;
                // without one the handler is still told so it can explain why.
                if (canRotate && !canRotate()) {
                    onBearing(deg, {lat, lon, km, blocked: true});
                    return;
                }
                target = {lat, lon, deg};
                drawRotatorLine();
                onBearing(deg, {lat, lon, km});
            }
        }
    });
    const map = surface.map;
    const qsoLayer = surface.layer('qso');
    const spotLayer = surface.layer('spot');
    const homeLayer = surface.layer('home');
    const rotatorLayer = surface.layer('rotator');
    const coverageLayer = surface.layer('coverage');

    let home = null;
    let target = null;
    let coverageHeading = null;

    function drawCoverage() {
        coverageLayer.clear();
        if (!home || coverageHeading === null || !isFinite(coverageHeading)) return;
        const outline = coverageOutline(home, (coverageHeading + 360) % 360);
        const coverage = cssVar('--op-r2', COVERAGE_COLOR);
        [-360, 0, 360].forEach(shift => {
            L.polygon(
                outline.map(([lat, lon]) => [lat, lon + shift]),
                {
                    className: 'op-coverage',
                    color: coverage,
                    weight: 1,
                    opacity: 0.55,
                    fillColor: coverage,
                    fillOpacity: 0.12,
                    interactive: false
                }
            ).addTo(coverageLayer.group);
        });
    }

    function setCoverage(heading) {
        const value = Number(heading);
        coverageHeading = isFinite(value) ? value : null;
        drawCoverage();
    }

    function drawRotatorLine() {
        rotatorLayer.clear();
        if (!home || !target) return;
        const heading = cssVar('--op-r2', COVERAGE_COLOR);
        L.polyline([[home.lat, home.lon], [target.lat, target.lon]], {
            color: heading, weight: 1.6, opacity: 0.95, dashArray: '5 4', interactive: false
        }).addTo(rotatorLayer.group);
        L.circleMarker([target.lat, target.lon], {
            radius: 4, color: heading, fillColor: heading, fillOpacity: 1, weight: 1
        }).addTo(rotatorLayer.group);
    }

    function setHome(next) {
        home = next && isFinite(next.lat) && isFinite(next.lon)
            ? {lat: Number(next.lat), lon: Number(next.lon)}
            : null;
        homeLayer.clear();
        if (!home) { drawCoverage(); return; }
        const open = cssVar('--map-open', '#00e08a');
        L.circleMarker([home.lat, home.lon], {
            radius: 5, color: open, fillColor: open, fillOpacity: 0.95, weight: 2
        }).addTo(homeLayer.group);
        L.circleMarker([home.lat, home.lon], {
            radius: 11, color: open, fillColor: 'transparent', weight: 1, opacity: 0.5
        }).addTo(homeLayer.group);
        drawRotatorLine();
        drawCoverage();
    }

    function setData({qsos = [], spots = [], radioFilter = 'all'} = {}) {
        qsoLayer.clear();
        spotLayer.clear();
        if (!home) return;

        const lanes = radioColors();
        const spotColor = cssVar('--map-spot', '#8fe3ff');
        const spotFill = cssVar('--map-bg', '#0a1929');

        for (const qso of qsos) {
            if (!isFinite(qso.lat) || !isFinite(qso.lon)) continue;
            if (radioFilter !== 'all' && String(qso.radioNr) !== String(radioFilter)) continue;
            const radio = Number(qso.radioNr) === 2 ? 2 : 1;
            const color = lanes[radio - 1];
            addTrackPaths(map, trackPaths(home.lat, home.lon, qso.lat, qso.lon, 64), {
                L,
                group: qsoLayer.group,
                color,
                weight: radio === 2 ? 1.1 : 1.4,
                opacity: radio === 2 ? 0.45 : 0.6,
                dashArray: radio === 2 ? '3 4' : null
            });
            L.marker([qso.lat, qso.lon], {
                interactive: false,
                icon: qsoDotIcon(L, radio)
            }).addTo(qsoLayer.group);
        }

        for (const spot of spots) {
            const lat = Number(spot.lat);
            const lon = Number(spot.lon);
            if (!isFinite(lat) || !isFinite(lon)) continue;
            addTrackPaths(map, trackPaths(home.lat, home.lon, lat, lon, 64), {
                L,
                group: spotLayer.group,
                color: spotColor,
                weight: 0.8,
                opacity: 0.28,
                dashArray: '1 5'
            });
            L.circleMarker([lat, lon], {
                radius: 2.6, color: spotColor, fillColor: spotFill,
                fillOpacity: 0.65, weight: 1, interactive: false
            }).addTo(spotLayer.group);
        }
    }

    return {
        map,
        setHome,
        setData,
        setCoverage,
        resize() {
            return surface.fit();
        },
        get target() { return target; },
        destroy() {
            surface.destroy();
        }
    };
}
