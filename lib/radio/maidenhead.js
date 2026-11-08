'use strict';

function gridToLatLng(g) {
    const s = String(g || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length < 4) return null;
    const a = s.charCodeAt(0) - 65, b = s.charCodeAt(1) - 65;
    if (a < 0 || a > 17 || b < 0 || b > 17) return null;
    let lon = -180 + a * 20, lat = -90 + b * 10, lonSpan = 20, latSpan = 10;
    if (/[0-9]{2}/.test(s.slice(2, 4))) {
        lon += Number(s[2]) * 2;
        lat += Number(s[3]);
        lonSpan = 2;
        latSpan = 1;
    } else return [lat + latSpan / 2, lon + lonSpan / 2];
    if (s.length >= 6 && /^[A-Z]{2}$/.test(s.slice(4, 6))) {
        lon += (s.charCodeAt(4) - 65) * (2 / 24);
        lat += (s.charCodeAt(5) - 65) * (1 / 24);
        lonSpan = 2 / 24;
        latSpan = 1 / 24;
    }
    return [lat + latSpan / 2, lon + lonSpan / 2];
}

function gridToLatLon(gr) {
    gr = String(gr || '').trim().toUpperCase();
    if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(gr)) return null;
    let lon = (gr.charCodeAt(0) - 65) * 20 - 180 + 10;
    let lat = (gr.charCodeAt(1) - 65) * 10 - 90 + 5;
    lon += parseInt(gr[2], 10) * 2 + 1;
    lat += parseInt(gr[3], 10);
    if (gr.length >= 6) {
        lon += (gr.charCodeAt(4) - 65) * (5 / 60) + (2.5 / 60);
        lat += (gr.charCodeAt(5) - 65) * (2.5 / 60) + (1.25 / 60);
    }
    return {lat, lon};
}

module.exports = {gridToLatLng, gridToLatLon};
