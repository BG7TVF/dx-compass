/**
 * Spherical geodesy helpers. Input: {lat, lon} points in degrees.
 * Output: kilometres, initial bearing in degrees, or normalized longitudes.
 */
export const EARTH_RADIUS_KM = 6371;
export const toRadians = degrees => degrees * Math.PI / 180;
export const toDegrees = radians => radians * 180 / Math.PI;
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function normalizeLongitude(lon) {
    return (((lon + 180) % 360 + 360) % 360) - 180;
}

export function relativeLongitude(lon, centre = 0) {
    return normalizeLongitude(lon - centre);
}

export function absoluteLongitude(offset, centre = 0) {
    return normalizeLongitude(offset + centre);
}

export function haversine(a, b, radiusKm = EARTH_RADIUS_KM) {
    const f1 = toRadians(a.lat), f2 = toRadians(b.lat);
    const df = f2 - f1, dl = toRadians(b.lon - a.lon);
    const h = Math.sin(df / 2) ** 2 +
        Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return 2 * radiusKm * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export const distanceKm = haversine;

export function bearing(a, b) {
    const f1 = toRadians(a.lat), f2 = toRadians(b.lat);
    const dl = toRadians(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}
