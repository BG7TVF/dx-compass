/**
 * Solar gray-line geometry and Leaflet lifecycle. Input: a Date and optional
 * central longitude. Output: finite [lat, lon] curves plus night-pole metadata;
 * createTerminator returns {update, stop, destroy, layers}. No network access.
 */
import {getLeaflet} from './leaflet.mjs';
import {toDegrees, toRadians} from '../geo/coordinates.mjs';

export function computeTerminator(now = new Date(), {
    step = 1,
    lonC = 0,
    relative = false,
    pole = 89.9
} = {}) {
    const date = now instanceof Date ? now : new Date(now);
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const doy = (date - start) / 86400000;
    const dec = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365.25);
    const declination = toRadians(dec);
    const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    const lonSun = 180 - utcHours * 15;
    const base = [];
    let previous = 0;
    const increment = Math.max(0.1, Math.abs(step));
    for (let offset = -180; offset <= 180 + 1e-9; offset += increment) {
        const longitude = relative ? offset + lonC : offset;
        const hour = toRadians(longitude - lonSun);
        let lat = toDegrees(Math.atan(-Math.cos(hour) / Math.tan(declination)));
        if (!Number.isFinite(lat)) lat = previous;
        base.push([lat, offset]);
        previous = lat;
    }
    return {
        base,
        dec,
        lonSun,
        nightPole: declination > 0 ? -Math.abs(pole) : Math.abs(pole),
        equinox: Math.abs(dec) < 0.6
    };
}

let projectionMemo = null;
/** Solar elevation cosine at a geographic point, using the same solar geometry
 * as computeTerminator: >0 day, <0 night, 0 on the gray line. */
export function solarCos(lat, lon, when = new Date()) {
    return solarCosAt(computeTerminator(when), lat, lon);
}

/** solarCos with caller-supplied geometry, for per-pixel field loops. */
export function solarCosAt(geometry, lat, lon) {
    const latitude = toRadians(lat);
    const declination = toRadians(geometry.dec);
    const hour = toRadians(lon - geometry.lonSun);
    return Math.sin(latitude) * Math.sin(declination) +
        Math.cos(latitude) * Math.cos(declination) * Math.cos(hour);
}

/** Canvas-propagation compatible 2-degree, home-centred curve with minute caching. */
export function propTerminator(now = new Date(), lonC = 0) {
    const date = now instanceof Date ? now : new Date(now);
    const key = `${Math.floor(date.getTime() / 60000)}|${lonC}`;
    if (projectionMemo && projectionMemo.key === key) return projectionMemo.value;
    const value = computeTerminator(date, {step: 2, lonC, relative: true, pole: 89.99});
    projectionMemo = {key, value};
    return value;
}

/** Draw line + night shade on three world copies and refresh every 60 seconds. */
export function createTerminator(map, {
    L = globalThis.L,
    now = () => new Date(),
    intervalMs = 60000,
    visible = true,
    shifts = [-360, 0, 360],
    lineOptions = {},
    shadeOptions = {},
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval
} = {}) {
    const leaflet = getLeaflet(L);
    let layers = [];
    let timer = null;
    let active = true;
    let show = visible !== false;

    const remove = () => {
        layers.forEach(layer => {
            if (map.hasLayer(layer)) map.removeLayer(layer);
        });
        layers = [];
        if (map._termLayers) map._termLayers = layers;
    };
    const update = () => {
        if (!active || !show) return null;
        remove();
        const geometry = computeTerminator(now());
        shifts.forEach(shift => {
            const line = geometry.base.map(point => [point[0], point[1] + shift]);
            const shade = line.concat([
                [geometry.nightPole, 180 + shift],
                [geometry.nightPole, -180 + shift]
            ]);
            layers.push(leaflet.polygon(shade, {
                stroke: false,
                fillColor: '#000',
                fillOpacity: 0.28,
                interactive: false,
                ...shadeOptions
            }).addTo(map));
            layers.push(leaflet.polyline(line, {
                color: '#aaa',
                weight: 1.5,
                opacity: 0.8,
                interactive: false,
                ...lineOptions
            }).addTo(map));
        });
        map._termLayers = layers;
        return geometry;
    };
    const stop = () => {
        if (timer !== null) clearIntervalImpl(timer);
        timer = null;
        if (map._termTimer) map._termTimer = null;
    };
    const start = () => {
        if (!active || !show || timer !== null) return;
        timer = setIntervalImpl(update, intervalMs);
        map._termTimer = timer;
    };
    const destroy = () => {
        if (!active) return;
        active = false;
        stop();
        remove();
    };
    const setVisible = next => {
        const value = next !== false;
        if (value === show) return;
        show = value;
        if (!active) return;
        if (show) {
            update();
            start();
        } else {
            stop();
            remove();
        }
    };
    const setIntervalMs = next => {
        const value = Number(next);
        if (!Number.isFinite(value) || value <= 0) return;
        intervalMs = value;
        if (timer !== null) {
            stop();
            start();
        }
    };

    update();
    start();
    return {
        update,
        stop,
        destroy,
        setVisible,
        setIntervalMs,
        get visible() { return show; },
        get layers() { return [...layers]; }
    };
}
