/**
 * Great-circle sampling and map clipping. Input: numeric lat/lon degrees.
 * Output: [lat, lon] points or drawable segments; longitudes are seam-cut and
 * track paths are clipped at +/-85 degrees for Leaflet Mercator.
 */
import {toDegrees, toRadians} from './coordinates.mjs';

export const TRACK_LAT = 85;

export function greatCirclePoints(lat1, lon1, lat2, lon2, samples = 64) {
    const count = Math.max(1, Math.floor(samples));
    const f1 = toRadians(lat1), l1 = toRadians(lon1);
    const f2 = toRadians(lat2), l2 = toRadians(lon2);
    const distance = 2 * Math.asin(Math.sqrt(
        Math.sin((f2 - f1) / 2) ** 2 +
        Math.cos(f1) * Math.cos(f2) * Math.sin((l2 - l1) / 2) ** 2
    ));
    if (distance < 1e-9) return [[lat1, lon1]];
    const sinDistance = Math.sin(distance);
    const points = [];
    for (let i = 0; i <= count; i++) {
        const fraction = i / count;
        const a = Math.sin((1 - fraction) * distance) / sinDistance;
        const b = Math.sin(fraction * distance) / sinDistance;
        const x = a * Math.cos(f1) * Math.cos(l1) + b * Math.cos(f2) * Math.cos(l2);
        const y = a * Math.cos(f1) * Math.sin(l1) + b * Math.cos(f2) * Math.sin(l2);
        const z = a * Math.sin(f1) + b * Math.sin(f2);
        const lat = toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y)));
        let lon = toDegrees(Math.atan2(y, x));
        if (points.length) {
            const previous = points[points.length - 1][1];
            lon = previous + ((lon - previous + 540) % 360) - 180;
        }
        points.push([lat, lon]);
    }
    return points;
}

export function greatCirclePaths(lat1, lon1, lat2, lon2, samples = 64) {
    const points = greatCirclePoints(lat1, lon1, lat2, lon2, samples);
    const worldOf = lon => Math.floor((lon + 180) / 360);
    const segments = [];
    let copy = worldOf(points[0][1]);
    let segment = [[points[0][0], points[0][1] - 360 * copy]];
    for (let i = 1; i < points.length; i++) {
        const nextCopy = worldOf(points[i][1]);
        if (nextCopy === copy) {
            segment.push([points[i][0], points[i][1] - 360 * copy]);
            continue;
        }
        const [latA, lonA] = points[i - 1];
        const [latB, lonB] = points[i];
        const boundary = nextCopy > copy ? 180 + 360 * copy : -180 + 360 * copy;
        const crossLat = latA + (latB - latA) * ((boundary - lonA) / (lonB - lonA));
        segment.push([crossLat, boundary - 360 * copy]);
        segments.push(segment);
        segment = [[crossLat, boundary - 360 * nextCopy],
            [points[i][0], points[i][1] - 360 * nextCopy]];
        copy = nextCopy;
    }
    segments.push(segment);
    return segments;
}

/** Big-screen compatible default: coincident endpoints produce no track. */
export function gcSegments(lat1, lon1, lat2, lon2, samples = 40) {
    const points = greatCirclePoints(lat1, lon1, lat2, lon2, samples);
    return points.length === 1 ? [] : greatCirclePaths(lat1, lon1, lat2, lon2, samples);
}

export function clipLat(points, low = -TRACK_LAT, high = TRACK_LAT) {
    const cross = (a, b, lat) => {
        const delta = b[0] - a[0];
        return [lat, a[1] + (b[1] - a[1]) * (delta ? (lat - a[0]) / delta : 0)];
    };
    const inside = point => point[0] >= low && point[0] <= high;
    const output = [];
    let current = null;
    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        if (!inside(point)) {
            if (current) {
                current.push(cross(points[i - 1], point, point[0] > high ? high : low));
                output.push(current);
                current = null;
            }
            continue;
        }
        if (!current) {
            const previous = points[i - 1];
            current = previous && !inside(previous)
                ? [cross(previous, point, previous[0] > high ? high : low)]
                : [];
        }
        current.push(point);
    }
    if (current) output.push(current);
    return output.filter(segment => segment.length > 1);
}

export function trackPaths(lat1, lon1, lat2, lon2, samples = 40) {
    const output = [];
    gcSegments(lat1, lon1, lat2, lon2, samples).forEach(segment => {
        clipLat(segment, -TRACK_LAT, TRACK_LAT).forEach(part => output.push(part));
    });
    return output;
}
