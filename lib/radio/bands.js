'use strict';

const BANDS = [
    [1800, 2000, '160m'], [3500, 4000, '80m'], [5330, 5410, '60m'],
    [7000, 7300, '40m'], [10100, 10150, '30m'], [14000, 14350, '20m'],
    [18068, 18168, '17m'], [21000, 21450, '15m'], [24890, 24990, '12m'],
    [28000, 29700, '10m'], [50000, 54000, '6m'], [144000, 148000, '2m'],
    [420000, 450000, '70cm']
];

function bandOf(f) {
    if (isNaN(f)) return null;
    for (const b of BANDS) {
        if (f >= b[0] && f <= b[1]) return b[2];
    }
    return null;
}

module.exports = {BANDS, bandOf};
