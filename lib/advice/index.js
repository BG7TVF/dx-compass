'use strict';

module.exports = Object.assign({}, require('./service.js'), {
    engine: require('./engine.js'),
    rules: require('./rules.js'),
    environment: require('./environment.js'),
    config: require('./config.js')
});
