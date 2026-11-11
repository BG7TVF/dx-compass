'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const wpx = require('../lib/wpx/prefix.js');

test('WPX 前缀按规则 V.C.1 推导', () => {
    const cases = {
        N8BJQ: 'N8',
        WD8XYZ: 'WD8',
        HG19ABC: 'HG19',
        LY1000ABC: 'LY1000',
        '9A1A': '9A1',
        XEFTJW: 'XE0',
        'PA/N8BJQ': 'PA0',
        'N8BJQ/P': 'N8',
        'KH8/S': 'KH8',
        '3D2/C': '3D2',
        'KH8/N8BJQ': 'KH8',
        ZS8: 'ZS8'
    };
    for (const [call, expected] of Object.entries(cases)) {
        assert.equal(wpx.wpxPrefix(call), expected, call);
    }
});

test('执照/移动后缀不参与前缀，空值不猜测', () => {
    assert.equal(wpx.wpxPrefix('N8BJQ/QRP'), 'N8');
    assert.equal(wpx.wpxPrefix('N8BJQ/M'), 'N8');
    assert.equal(wpx.wpxPrefix(''), '');
    assert.equal(wpx.wpxPrefix(null), '');
    assert.equal(wpx.wpxPrefix('A/B'), '');
});

test('前缀表去重、全大写，并带来源与事实性数据说明', () => {
    const table = wpx.TABLE;
    const list = table.authorizedPrefixes;
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 200 && list.length <= 1200, `unexpected count ${list.length}`);
    assert.equal(new Set(list).size, list.length);
    for (const prefix of list) assert.match(prefix, /^[A-Z0-9]+$/, prefix);

    assert.match(table.meta.sourceUrl, /^https:\/\/cqwpx\.com\//);
    assert.ok(Number.isFinite(Date.parse(table.meta.fetchedAt)));
    assert.match(table.meta.license, /CQ WPX/i);
    assert.match(table.meta.note, /not DXCC entities/);
    assert.equal(table.meta.entryCount, list.length);
});

test('己授权字头校验只看字母基底，避免与 DXCC 实体混用', () => {
    assert.equal(wpx.isAuthorizedPrefix('N8'), true);
    assert.equal(wpx.isAuthorizedPrefix('k1'), true);
    assert.equal(wpx.isAuthorizedPrefix('LY1000'), true);
    assert.equal(wpx.isAuthorizedPrefix('QQ1'), false);
    assert.equal(wpx.isAuthorizedPrefix(''), false);
    assert.equal(wpx.baseLetters('HG19'), 'HG');
});

test('prefixSet 对同一前缀去重', () => {
    const set = wpx.prefixSet(['N8BJQ', 'N8XYZ', 'N8ABC', 'K1ABC', '']);
    assert.deepEqual([...set].sort(), ['K1', 'N8']);
});
