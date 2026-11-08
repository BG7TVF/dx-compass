'use strict';

const collector = require('./collector.js');
const model = require('./model.js');
const service = require('./service.js');
const geo = require('./geo.js');

module.exports = {
    ...collector,
    ...model,
    collect: collector.collect,
    getSnapshot: service.getSnapshot,
    gridToLatLon: service.gridToLatLon,
    buildForecast: service.buildForecast,
    createForecastCacheKey: service.createForecastCacheKey,
    fetchGeo: geo.fetchGeo,
    resolveGeo: geo.resolveGeo
};
