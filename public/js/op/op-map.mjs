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

/* 席位泳道调色板：与 op.css 的 --op-r1..--op-r6 一一对应，
 * 序号由 OP 页按席位编号（seatLane）送进来，地图自己不再猜电台号。 */
const RADIO_COLORS = ['#00e5ff', '#ffb020', '#7cf05a', '#c78bff', '#ff6f91', '#5ad1ff'];
const LANE_COUNT = RADIO_COLORS.length;
/* Leaflet needs literal colours, so every draw resolves the active theme tokens
 * and falls back to the dark-console defaults when no theme is mounted. */
function radioColors() {
    return RADIO_COLORS.map((fallback, index) => cssVar('--op-r' + (index + 1), fallback));
}
function laneIndex(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 1;
    return ((Math.floor(n) - 1) % LANE_COUNT) + 1;
}
/* 坐标可能是数字、数字字符串，也可能是接口里的 null。
 * isFinite(null) 是 true（null 被当成 0），所以旧的写法会把「没坐标」的 QSO
 * 当成 (0, 0) 交给 Leaflet：marker 的 _latlng 变成 null，addTo 时直接抛
 * "Cannot read properties of null (reading 'lat')"，整个绘制循环当场中断，
 * 后面的 QSO 弧线一条都画不出来。取不到坐标就跳过，(0,0) 也当没坐标处理。 */
function pointOf(lat, lon) {
    const north = Number(lat);
    const east = Number(lon);
    if (!Number.isFinite(north) || !Number.isFinite(east)) return null;
    if (Math.abs(north) < 1e-9 && Math.abs(east) < 1e-9) return null;
    return [north, east];
}
/* Antenna coverage wedge: the two edges are great-circle lines leaving the home
 * station at the rotator heading ± HALF_DEG, capped at RADIUS_DEG of arc so the
 * beam reads as a direction, not a full lune. Longitudes are kept continuous
 * relative to home and drawn on three world copies so the beam never splits at
 * the antimeridian. */
const COVERAGE_HALF_DEG = 15;
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
        /* 只接受 {lat, lon}；数组、null 字段、(0,0) 都算「本台没有位置」。 */
        const at = next && !Array.isArray(next) ? pointOf(next.lat, next.lon) : null;
        home = at ? {lat: at[0], lon: at[1]} : null;
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
            const at = pointOf(qso.lat, qso.lon);
            if (!at) continue;
            if (radioFilter !== 'all' && String(qso.radioNr) !== String(radioFilter)) continue;
            const lane = laneIndex(qso.seatLane !== undefined ? qso.seatLane : qso.radioNr);
            const color = lanes[lane - 1];
            /* 本席位的线粗而实，其他席位的线细而淡，颜色按席位泳道分开：
             * 一眼就能分清这条 QSO 是自己打的还是隔壁席位打的。 */
            const own = qso.ownSeat !== false;
            addTrackPaths(map, trackPaths(home.lat, home.lon, at[0], at[1], 64), {
                L,
                group: qsoLayer.group,
                color,
                weight: own ? 1.4 : 1,
                opacity: own ? 0.6 : 0.34,
                dashArray: own ? null : '3 4'
            });
            L.marker(at, {
                interactive: false,
                icon: qsoDotIcon(L, lane, {
                    className: 'op-map-dot ' + (own ? 'own' : 'other'),
                    size: own ? 12 : 7
                })
            }).addTo(qsoLayer.group);
        }

        for (const spot of spots) {
            const at = pointOf(spot.lat, spot.lon);
            if (!at) continue;
            addTrackPaths(map, trackPaths(home.lat, home.lon, at[0], at[1], 64), {
                L,
                group: spotLayer.group,
                color: spotColor,
                weight: 0.8,
                opacity: 0.28,
                dashArray: '1 5'
            });
            /* 本席位被 spot 的位置同样用大圆点：半径 6px，是本席位 QSO 点的量级，
             * 细线只是「谁在听我」的连线，点才是答案。 */
            L.circleMarker(at, {
                radius: 6, color: spotColor, fillColor: spotFill,
                fillOpacity: 0.55, weight: 1.4, interactive: false
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
