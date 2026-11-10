'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveCall, normalizeCall, PREFIX_ENTRIES
} = require('../public/shared/dxcc/callsign.mjs');

function dxcc(call) {
    const result = resolveCall(call);
    return result ? result.dxcc : null;
}

test('常规呼号解析到正确实体与字头', () => {
    assert.deepEqual(
        (({dxcc: code, country, prefix}) => ({dxcc: code, country, prefix}))(resolveCall('BG7TV')),
        {dxcc: 318, country: 'China', prefix: 'BY'});
    assert.equal(dxcc('JA1XX'), 339);
    assert.equal(dxcc('K1ABC'), 291);
    assert.equal(dxcc('KH6XX'), 110);
    assert.equal(dxcc('KH8XX'), 9);
    assert.equal(dxcc('3D2XX'), 176);
});

test('特殊字头不被当成移动标识剥离', () => {
    assert.equal(dxcc('KH8/S'), 515);
    assert.equal(dxcc('KH8/S/P'), 515);
    assert.equal(dxcc('3D2/c'), 489);
    assert.equal(dxcc('3D2CR'), 489);
    assert.equal(dxcc('3D2R'), 460);
    assert.equal(dxcc('VP2E'), 12);
    assert.equal(dxcc('ZS8'), 201);
    assert.equal(dxcc('FT5/W'), 41);
    assert.equal(dxcc('FT5WO'), 41);
    assert.equal(dxcc('FT5X'), 131);
    assert.equal(dxcc('FT5Z'), 10);
});

test('剥离 /P /M /QRP /数字 等移动标识', () => {
    assert.equal(normalizeCall('k1abc/p'), 'K1ABC');
    assert.equal(normalizeCall('K1ABC/M/QRP'), 'K1ABC');
    assert.equal(normalizeCall('K1ABC/7'), 'K1ABC');
    assert.equal(dxcc('K1ABC/P'), 291);
    assert.equal(dxcc('K1ABC/M/QRP'), 291);
    assert.equal(dxcc('K1ABC/7'), 291);
});

test('带斜杠的位置前缀优先于呼号本身', () => {
    assert.equal(dxcc('DL/K1ABC'), 230);
    assert.equal(dxcc('K1ABC/KH8'), 9);
    assert.equal(dxcc('VP2E/K1ABC'), 12);
});

test('空输入与未知前缀不编造实体', () => {
    assert.equal(resolveCall(''), null);
    assert.equal(resolveCall('   '), null);
    const unknown = resolveCall('QQ1ZZZ');
    assert.equal(unknown.dxcc, null);
    assert.equal(unknown.country, '');
    assert.equal(unknown.prefix, '');
});

test('前缀数据标注来源与抓取日期', async () => {
    const {PREFIX_SOURCE} = await import('../public/shared/dxcc/prefixes.mjs');
    assert.ok(PREFIX_ENTRIES.length > 300);
    assert.ok(PREFIX_SOURCE.includes('ARRL'));
    assert.ok(PREFIX_SOURCE.includes('2026-11-11'));
    const rotuma = PREFIX_ENTRIES.find(item => item.dxcc === 460);
    assert.equal(rotuma.name, 'Rotuma Island');
    assert.equal(rotuma.prefix, '3D2R');
    assert.deepEqual(rotuma.prefixes.includes('3D2R'), true);
});
