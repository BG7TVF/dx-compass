'use strict';

function hav(la1, lo1, la2, lo2) {
    const R = 6371;
    const r = d => d * Math.PI / 180;
    const dLa = r(la2 - la1), dLo = r(lo2 - lo1);
    const a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
        Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceFields(la1, lo1, la2, lo2) {
    if (la1 === null || lo1 === null || la2 === null || lo2 === null) {
        return {distanceKm: null, distanceMiles: null};
    }
    const distanceKm = hav(la1, lo1, la2, lo2);
    return {
        distanceKm: Math.round(distanceKm),
        distanceMiles: Math.round(distanceKm * 0.62137)
    };
}

module.exports = {hav, haversine: hav, distanceFields};
