/**
 * Maidenhead locator adapter. Input: a 4/6-character grid string.
 * Output: grid-centre [lat, lon] in degrees, or null for invalid input.
 */
export function isValidMaidenhead(grid) {
    return /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i.test(String(grid || ''));
}

export function gridToLatLon(grid) {
    const value = String(grid || '').toUpperCase();
    if (!isValidMaidenhead(value)) return null;
    let lon = (value.charCodeAt(0) - 65) * 20 - 180 + Number(value[2]) * 2 + 1;
    let lat = (value.charCodeAt(1) - 65) * 10 - 90 + Number(value[3]) + 0.5;
    if (value.length === 6) {
        lon += (value.charCodeAt(4) - 65) * (2 / 24) - 1 + 1 / 24;
        lat += (value.charCodeAt(5) - 65) * (1 / 24) - 0.5 + 1 / 48;
    }
    return [lat, lon];
}
