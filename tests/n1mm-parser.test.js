'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const n1mm = require('../lib/qsos/n1mm.js');

const NOW = new Date('2026-11-08T12:34:00.000Z');

test('contactinfo 容忍小写字段、数组/标量混用与缺失字段', () => {
    const payload = {contactinfo: {
        id: '42', Call: 'k1abc', BAND: '20', mode: 'CW', rxfreq: '14025000',
        timestamp: '2026-11-08 12:30:00', mycall: 'N0CALL', points: '3'
    }};
    const qso = n1mm.parseContact(payload, NOW);
    assert.equal(qso.call, 'K1ABC');
    assert.equal(qso.n1mmId, 'DXI|LOCAL|42');
    assert.equal(qso.rawId, '42');
    assert.equal(qso.band, '20');
    assert.equal(qso.mode, 'CW');
    assert.equal(qso.freqKhz, 14025);
    assert.equal(qso.ts, '2026-11-08T12:30:00.000Z');
    assert.equal(qso.points, 3);
    assert.equal(qso.isMult, false);
    assert.equal(qso.grid, '');
    assert.equal(qso.lat, null);
});

test('频率单位兼容 Hz / 10 Hz / kHz', () => {
    assert.equal(n1mm.toKhz('14025000'), 14025);
    assert.equal(n1mm.toKhz('1407400'), 14074);
    assert.equal(n1mm.toKhz('14074'), 14074);
    assert.equal(n1mm.toKhz('14.074'), 14074);
    assert.equal(n1mm.toKhz(''), null);
    assert.equal(n1mm.toKhz('abc'), null);
});

test('大小写不一致的根节点仍能识别', () => {
    assert.equal(n1mm.routeContact({CONTACTINFO: {call: 'K1ABC'}}), 'contactinfo');
    const radio = n1mm.parseRadio({radioinfo: {radionr: '2', freq: '14025000',
        mode: 'CW', isrunning: 'true'}}, NOW);
    assert.equal(radio.radioNr, '2');
    assert.equal(radio.freqKhz, 14025);
    assert.equal(radio.isRunning, true);
    const score = n1mm.parseScore({DynamicResults: {contest: ['CQWW'], score: ['10']}}, NOW);
    assert.equal(score.contest, 'CQWW');
    assert.equal(score.score, 10);
});

test('contactdelete 归一化为删除事件', () => {
    const result = n1mm.normalize({contactdelete: {ID: '{A-1}', call: 'k1abc'}}, NOW);
    assert.equal(result.kind, 'delete');
    assert.equal(result.event.rawId, '{A-1}');
    assert.equal(result.event.id, 'DXI|LOCAL|{A-1}');
    assert.equal(result.event.call, 'K1ABC');
    assert.match(result.event.qso.n1mmId, /A-1/);
});

test('分数报文遍历全部 breakdown，而不是只看第一条', () => {
    const score = n1mm.parseScore({dynamicresults: {
        contest: ['CQ WW CW'], score: ['1000'],
        breakdown: [
            {$: {band: '20'}, qso: [{$: {band: '20', mode: 'CW'}, _: '9'}]},
            {$: {band: 'total'}, qso: [{$: {band: 'total', mode: 'ALL'}, _: '12'}],
                mult: [{$: {band: 'total', mode: 'ALL'}, _: '5'}],
                points: [{$: {band: 'total', mode: 'ALL'}, _: '36'}]}
        ]
    }}, NOW);
    assert.deepEqual([score.qsos, score.mults, score.points, score.score], [12, 5, 36, 1000]);
});

test('未知或空包返回 unknown，不抛异常', () => {
    assert.equal(n1mm.normalize(null, NOW).kind, 'unknown');
    assert.equal(n1mm.normalize({hello: 'world'}, NOW).kind, 'unknown');
    assert.equal(n1mm.normalize({contactinfo: {}}, NOW).kind, 'unknown');
    assert.equal(n1mm.normalize({contactdelete: {}}, NOW).kind, 'unknown');
});
