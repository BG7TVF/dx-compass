const strength = require('./strength.js');
const estimate = require('./estimate.js');
const service = require('./service.js');

module.exports = {
    ...estimate,
    strength,
    service
};
