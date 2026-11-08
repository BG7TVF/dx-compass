'use strict';

function esc(v) {
    return v === null || v === undefined ? 'NULL' : ("'" + String(v).replace(/'/g, "''") + "'");
}

function num(v) {
    return v === null || v === undefined || isNaN(v) ? 'NULL' : v;
}

module.exports = {esc, num};
