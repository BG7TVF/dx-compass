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
    analysis: require('./analysis'),
    multipliers: require('./multipliers'),
    advice: require('./advice'),
    activity: require('./activity'),
    wpx: require('./wpx'),
    solar: require('./solar.js'),
    scp: require('./scp'),
    alerts: require('./alerts'),
    contest: require('./contest'),
    maintenance: require('./maintenance'),
    devices: require('./devices')
};
