'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {lookupQuery, parseLookup} = require('../lib/qsos/qrz.js');
const {checkCall} = require('../lib/storage/qso-sql.js');

test('QRZ lookup query encodes the call and needs a session key', () => {
    assert.equal(lookupQuery('dl1abc', ''), null);
    const request = lookupQuery('dl1abc', 'k 1');
    assert.match(request.url, /xmldata\.qrz\.com/);
    assert.match(request.url, /callsign=DL1ABC/);
    assert.match(request.url, /s=k%201/);
});

test('QRZ lookup keeps "not found" separate from a failed request', () => {
    const found = parseLookup({
        QRZDatabase: {Callsign: [{call: ['DL1ABC'], country: ['Germany'], grid: ['JO31']}]}
    });
    assert.equal(found.status, 'found');
    assert.equal(found.callsign.call, 'DL1ABC');
    assert.equal(found.callsign.country, 'Germany');

    const missing = parseLookup({QRZDatabase: {Session: [{Error: ['Not found: no match']}]}});
    assert.equal(missing.status, 'not-found');

    const failed = parseLookup({QRZDatabase: {Session: [{Error: ['Session timeout']}]}});
    assert.equal(failed.status, 'error');

    const invalid = parseLookup(null);
    assert.equal(invalid.status, 'error');
});

test('local call log check excludes the QSO under review and escapes input', () => {
    assert.equal(checkCall('', null), null);
    assert.equal(checkCall("dl1'abc", null),
        "SELECT COUNT(*) AS n FROM qsos WHERE UPPER(call) = 'DL1''ABC';");
    assert.equal(checkCall('DL1ABC', 'abc-1'),
        "SELECT COUNT(*) AS n FROM qsos WHERE UPPER(call) = 'DL1ABC' AND n1mm_id <> 'abc-1';");
});
