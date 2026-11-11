'use strict';

module.exports = {
    schema: require('./schema.js'),
    spots: require('./spot-sql.js'),
    neighbors: require('./neighbor-sql.js'),
    recording: require('./recording-sql.js'),
    qso: require('./qso-sql.js'),
    alerts: require('./alert-sql.js'),
    activity: require('./activity-sql.js'),
    advice: require('./advice-sql.js'),
    n1mm: require('./n1mm-sql.js')
};
