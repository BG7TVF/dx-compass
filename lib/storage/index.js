'use strict';

module.exports = {
    schema: require('./schema.js'),
    spots: require('./spot-sql.js'),
    neighbors: require('./neighbor-sql.js'),
    recording: require('./recording-sql.js'),
    qso: require('./qso-sql.js')
};
