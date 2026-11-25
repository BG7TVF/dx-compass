'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {lookupQuery, parseLookup} = require('../lib/qsos/qrz.js');
const {checkCall} = require('../lib/storage/qso-sql.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

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

test('OP 点「无误」记的是呼号，存在服务端设置里，全部席位共享', () => {
    const op = read('public', 'js', 'pages', 'op-page.mjs');
    assert.match(op, /ctx\.settings\.opConfirmedCalls = list\.join\(','\)/);
    assert.match(op, /ctx\.saveSettings\(\{opConfirmedCalls: ctx\.settings\.opConfirmedCalls\}\)/);
    // 命中白名单的直接跳过，连检查请求都不发。
    assert.match(op, /if \(confirmed\.has\(call\)/);
    // 「已修改」只是这一条 QSO 的事，不能把写错的呼号本身放进白名单。
    assert.match(op, /if \(status === 'ok'\) \{[\s\S]*?rememberConfirmedCall\(item\.call\);[\s\S]*?\} else \{\s*\/\/[^\n]*\n\s*state\.review\[key\] = \{status, at: Date\.now\(\)\};/);
});

test('呼号白名单是服务端设置，不进设置表单，只由全部重置清除', () => {
    const schema = read('public', 'shared', 'settings', 'schema.js');
    assert.match(schema, /field\('opConfirmedCalls', 'qso', 'string', ''/);
    const settings = read('public', 'js', 'pages', 'settings-page.mjs');
    assert.match(settings, /const EXTERNAL_CONTROL_KEYS = new Set\(\s*\[[^\]]*'opConfirmedCalls'/);
    // 全部重置清掉本机的旧复核记忆与旋转器预设角；服务端那一份由 settings.reset 恢复默认。
    assert.match(settings, /\['dxcompass-settings', 'dxcompass-rot-sec', 'dxcompass-op-call-review',\s*\n\s*'dxcompass-op-rotor-presets'\]/);
});
