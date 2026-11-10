const strength = require('./strength.js');
const estimate = require('./estimate.js');
const service = require('./service.js');
const paths = require('./paths.js');
const pathService = require('./path-service.js');

module.exports = {
    ...estimate,
    strength,
    service,
    paths,
    pathService
};
