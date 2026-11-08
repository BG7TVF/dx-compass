/**
 * Pure propagation-map projection tools extracted from prop.js.
 * Input: projection kind, CSS-pixel width/height and optional DE {lat, lon}.
 * Output: {fwd(lon,lat), inv(x,y)} plus fit/ring helpers; no data or prediction math.
 */
import {
    absoluteLongitude,
    clamp,
    relativeLongitude,
    toDegrees,
    toRadians
} from '../geo/coordinates.mjs';

export const PROP_NORTH_MIN = 78;
export const PROP_SOUTH_MIN = -56;
export const propLonRel = relativeLongitude;
export const propLonAbs = absoluteLongitude;

export const ROB_X = [1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216,
    0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322];
export const ROB_Y = [0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958,
    0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1];

export function robinsonTable(absLat, table) {
    const index = clamp(Math.floor(absLat / 5), 0, 17);
    const fraction = absLat / 5 - index;
    return table[index] + (table[index + 1] - table[index]) * fraction;
}

export function robLatFromY(y) {
    const target = Math.min(Math.abs(y / 1.3523), 1);
    let low = 0, high = 18;
    for (let i = 0; i < 24; i++) {
        const middle = (low + high) / 2;
        if (robinsonTable(middle * 5, ROB_Y) < target) low = middle;
        else high = middle;
    }
    return clamp((low + high) / 2 * 5, 0, 90);
}

/** Width-first fit with the existing mainland-safe polar crop limits. */
export function propFit(width, height, worldWidth, yNorth, yOf, latFromY, northLimit) {
    const scaleWidth = width / worldWidth;
    const needed = height / scaleWidth;
    const ySouth = yOf(Math.abs(PROP_SOUTH_MIN));
    const yNorthMin = yOf(PROP_NORTH_MIN);
    if (needed >= 2 * yNorth) {
        return {sc: scaleWidth, north: northLimit, south: -northLimit, centered: true};
    }
    const southCandidate = needed - yNorth;
    if (southCandidate >= ySouth) {
        return {sc: scaleWidth, north: northLimit, south: -latFromY(southCandidate), centered: false};
    }
    const northCandidate = needed - ySouth;
    if (northCandidate >= yNorthMin) {
        return {sc: scaleWidth, north: latFromY(northCandidate), south: PROP_SOUTH_MIN, centered: false};
    }
    return {
        sc: Math.min(scaleWidth, height / (yNorthMin + ySouth)),
        north: PROP_NORTH_MIN,
        south: PROP_SOUTH_MIN,
        centered: false
    };
}

export function makeProjection(kind, width, height, de) {
    if (kind === 'azimuthal') {
        const lat0 = toRadians(de ? de.lat : 40);
        const lon0 = toRadians(de ? de.lon : 0);
        const scale = Math.min(width, height) / (2 * Math.PI);
        const cx = width / 2, cy = height / 2;
        return {
            kind: 'azimuthal',
            lon0: toDegrees(lon0),
            lat0: toDegrees(lat0),
            fwd(lon, lat) {
                const phi = toRadians(lat), delta = toRadians(lon) - lon0;
                const cosC = Math.sin(lat0) * Math.sin(phi) +
                    Math.cos(lat0) * Math.cos(phi) * Math.cos(delta);
                const c = Math.acos(clamp(cosC, -1, 1));
                if (c > Math.PI * 0.999) return null;
                const k = c < 1e-9 ? 1 : c / Math.sin(c);
                const x = k * Math.cos(phi) * Math.sin(delta);
                const y = k * (Math.cos(lat0) * Math.sin(phi) -
                    Math.sin(lat0) * Math.cos(phi) * Math.cos(delta));
                return [cx + x * scale, cy - y * scale];
            },
            inv(px, py) {
                const x = (px - cx) / scale, y = (cy - py) / scale;
                const c = Math.hypot(x, y);
                if (c > Math.PI) return null;
                if (c < 1e-9) return [toDegrees(lat0), toDegrees(lon0)];
                const lat = Math.asin(Math.cos(c) * Math.sin(lat0) +
                    y * Math.sin(c) * Math.cos(lat0) / c);
                const lon = lon0 + Math.atan2(x * Math.sin(c),
                    c * Math.cos(lat0) * Math.cos(c) - y * Math.sin(lat0) * Math.sin(c));
                return [toDegrees(lat), absoluteLongitude(toDegrees(lon), 0)];
            }
        };
    }
    if (kind === 'robinson') {
        const xMax = 0.8487 * Math.PI, yMax = 1.3523;
        const yOf = lat => 1.3523 * robinsonTable(Math.abs(lat), ROB_Y);
        const fit = propFit(width, height, 2 * xMax, yMax, yOf, robLatFromY, 90);
        const scale = fit.sc, cx = width / 2;
        const cy = fit.centered ? height / 2 : yOf(fit.north) * scale;
        const lonC = de ? de.lon : 0;
        const fwdRaw = (offset, lat) => {
            const absLat = Math.abs(lat), sign = lat < 0 ? -1 : 1;
            return [cx + 0.8487 * robinsonTable(absLat, ROB_X) * toRadians(offset) * scale,
                cy - 1.3523 * robinsonTable(absLat, ROB_Y) * sign * scale];
        };
        return {
            kind: 'robinson', lon0: lonC, fit,
            fwd(lon, lat) { return fwdRaw(relativeLongitude(lon, lonC), lat); },
            fwdRaw,
            inv(px, py) {
                const x = (px - cx) / scale, y = (cy - py) / scale;
                if (Math.abs(y) > yMax + 0.02) return null;
                const absLat = robLatFromY(y);
                const lat = y < 0 ? -absLat : absLat;
                if (lat > fit.north + 0.3 || lat < fit.south - 0.3) return null;
                const xs = 0.8487 * robinsonTable(absLat, ROB_X);
                if (!xs || Math.abs(x / xs) > Math.PI + 0.02) return null;
                return [lat, absoluteLongitude(toDegrees(x / xs), lonC)];
            }
        };
    }

    const northLimit = 85.06;
    const mercator = lat => Math.log(Math.tan(Math.PI / 4 +
        clamp(lat, -northLimit, northLimit) * Math.PI / 360));
    const yOf = lat => mercator(Math.abs(lat));
    const latFromY = y => toDegrees(2 * Math.atan(Math.exp(y)) - Math.PI / 2);
    const fit = propFit(width, height, 2 * Math.PI, mercator(northLimit), yOf, latFromY, northLimit);
    const scale = fit.sc, cx = width / 2;
    const cy = fit.centered ? height / 2 : yOf(fit.north) * scale;
    const lonC = de ? de.lon : 0;
    const fwdRaw = (offset, lat) => [cx + toRadians(offset) * scale, cy - mercator(lat) * scale];
    return {
        kind: 'mercator', lon0: lonC, fit,
        fwd(lon, lat) { return fwdRaw(relativeLongitude(lon, lonC), lat); },
        fwdRaw,
        inv(px, py) {
            const x = (px - cx) / scale, y = (cy - py) / scale;
            if (Math.abs(toDegrees(x)) > 180.5) return null;
            const lat = latFromY(y);
            if (lat > fit.north + 0.3 || lat < fit.south - 0.3) return null;
            return [clamp(lat, -85, 85), absoluteLongitude(toDegrees(x), lonC)];
        }
    };
}

/** Project a Natural Earth ring into up to three continuous home-centred copies. */
export function propRingCopies(ring, lonC, projection) {
    const flat = typeof ring[0] === 'number';
    const count = flat ? ring.length / 2 : ring.length;
    if (!count) return [];
    const at = index => flat ? [ring[index * 2], ring[index * 2 + 1]] : ring[index];
    const first = at(0), last = at(count - 1);
    const closed = Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6;
    const pole = !closed && Math.abs(last[1]) >= 89.5 ? (last[1] < 0 ? -89.99 : 89.99) : null;
    let tail = 0;
    if (pole) {
        while (tail < count && Math.abs(at(count - 1 - tail)[1]) >= 89.5) tail++;
    }
    const relatives = new Float64Array(count), latitudes = new Float64Array(count);
    let previous = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < count; i++) {
        const point = at(i);
        let offset = relativeLongitude(point[0], lonC);
        if (i > 0) {
            while (offset - previous > 180) offset -= 360;
            while (previous - offset > 180) offset += 360;
        }
        relatives[i] = offset;
        latitudes[i] = point[1];
        previous = offset;
        min = Math.min(min, offset);
        max = Math.max(max, offset);
    }
    const output = [];
    for (let copy = -1; copy <= 1; copy++) {
        if (max + 360 * copy < -180 || min + 360 * copy > 180) continue;
        const points = new Float64Array(count * 2);
        for (let i = 0; i < count; i++) {
            const projected = projection.fwdRaw(relatives[i] + 360 * copy, latitudes[i]);
            points[i * 2] = projected[0];
            points[i * 2 + 1] = projected[1];
        }
        output.push({
            pts: points,
            pole,
            tail,
            dFirst: relatives[0] + 360 * copy,
            dLast: relatives[count - 1] + 360 * copy
        });
    }
    return output;
}
