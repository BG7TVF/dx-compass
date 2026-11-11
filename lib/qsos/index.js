'use strict';

const seatIdentity = require('./seat-identity.js');

module.exports = {
    ...require('./n1mm.js'),
    ...require('./service.js'),
    ...require('./frequency-claims.js'),
    ...require('./ingest.js'),
    ...require('./qrz.js'),
    seatIdentity,
    listSeatIdentities: seatIdentity.list,
    summarySeatIdentities: seatIdentity.summary,
    changeSeatIdentity: seatIdentity.changeIdentity
};
