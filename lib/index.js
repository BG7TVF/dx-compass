'use strict';

const monitoring = require('./monitoring');
const qsos = require('./qsos');
const settings = require('./settings');

module.exports = {
    radio: require('./radio'),
    spots: require('./spots'),
    qso: qsos,
    qsos,
    monitoring,
    recording: monitoring.recording,
    settings,
    callsigns: {get: settings.getCallsigns, save: settings.saveCallsigns},
    storage: require('./storage'),
    propagation: require('./propagation'),
    maintenance: require('./maintenance')
};
