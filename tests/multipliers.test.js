'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../lib/multipliers/service.js');

function row(call, band, mode, timestamp, contestname, countryprefix) {
    return {call, band, mode, timestamp, contestname: contestname || '', countryprefix: countryprefix || ''};
}

const ROWS = [
    row('K1ABC', '20m', 'CW', '2026-11-01T00:00:00.000Z', 'CQWW'),
    row('K1ABC', '20m', 'CW', '2026-11-05T00:00:00.000Z', 'CQWW'),
    row('KH8/S', '15m', 'SSB', '2026-11-05T01:00:00.000Z', 'CQWW'),
    row('JA1XX', '20m', 'CW', '2026-11-05T02:00:00.000Z', 'CQWW'),
    row('ZS8', '20m', 'CW', '2026-10-01T00:00:00.000Z', 'CQWW'),
    row('3D2/C', '10m', 'FT8', '2026-11-05T03:00:00.000Z', 'CQWW'),
    row('QQ1ZZZ', '20m', 'CW', '2026-11-05T04:00:00.000Z', 'CQWW')
];

const WINDOW = {from: '2026-11-04T00:00', to: '2026-11-06T00:00'};

async function matrix(query, settings, rows) {
    const prepared = service.prepare({...WINDOW, ...query}, settings || {});
    return service.complete(prepared, rows || ROWS);
}

function entity(result, dxcc) {
    return result.rows.find(item => item.dxcc === dxcc);
}

test('prepare 生成 qsos 查询并优先使用查询窗口', () => {
    const prepared = service.prepare({from: '2026-11-04T00:00', to: '2026-11-06T00:00'},
        {wallTimerStart: '2026-01-01T00:00', wallTimerEnd: '2026-01-02T00:00'});
    assert.match(prepared.sql, /FROM qsos/);
    assert.match(prepared.sql, /ORDER BY timestamp ASC/);
    assert.equal(prepared.request.windowSource, 'query');
    assert.equal(prepared.request.perBand, true);
});

test('没有查询窗口时回落到设置里的赛事时间', () => {
    const prepared = service.prepare({}, {
        wallTimerStart: '2026-11-04T00:00', wallTimerEnd: '2026-11-06T00:00'
    });
    assert.equal(prepared.request.windowSource, 'settings');
    assert.equal(prepared.request.from, Math.floor(Date.parse('2026-11-04T00:00:00Z') / 1000));
});

test('当前比赛窗口优先于墙钟倒计时窗口', () => {
    const prepared = service.prepare({}, {
        contestStart: '2026-11-08T00:00', contestEnd: '2026-11-09T12:00',
        wallTimerStart: '2026-11-04T00:00', wallTimerEnd: '2026-11-06T00:00'
    });
    assert.equal(prepared.request.windowSource, 'contest');
    assert.equal(prepared.request.from, Math.floor(Date.parse('2026-11-08T00:00:00Z') / 1000));
    assert.equal(prepared.request.to, Math.floor(Date.parse('2026-11-09T12:00:00Z') / 1000));
});

test('查询参数仍然压过当前比赛窗口', () => {
    const prepared = service.prepare({from: '2026-11-01T00:00', to: '2026-11-02T00:00'}, {
        contestStart: '2026-11-08T00:00', contestEnd: '2026-11-09T12:00'
    });
    assert.equal(prepared.request.windowSource, 'query');
});

test('worked / new / pending / unknown 四种结果', async () => {
    const result = await matrix({mode: 'ALL'});
    assert.equal(result.ok, true);
    assert.equal(result.window.from, '2026-11-04T00:00:00.000Z');
    assert.equal(result.window.to, '2026-11-06T00:00:00.000Z');

    const usa = entity(result, 291);
    assert.equal(usa.status, 'worked');
    assert.equal(usa.cells['20m'].status, 'worked');
    assert.equal(usa.cells['20m'].count, 2);

    const swains = entity(result, 515);
    assert.equal(swains.status, 'new');
    assert.equal(swains.cells['15m'].status, 'new');
    assert.equal(swains.cells['15m'].calls[0].call, 'KH8/S');

    const zs8 = entity(result, 201);
    assert.equal(zs8.status, 'pending');
    assert.equal(zs8.cells['20m'].status, 'pending');

    assert.equal(result.unknown.callCount, 1);
    assert.equal(result.unknown.calls[0].call, 'QQ1ZZZ');
    assert.equal(result.unknown.cells['20m'].status, 'new');
});

test('合计与完成度基于现行 DXCC 实体数', async () => {
    const result = await matrix({mode: 'ALL'});
    assert.equal(result.totals.entities, 5);
    assert.equal(result.totals.worked, 1);
    assert.equal(result.totals.new, 3);
    assert.equal(result.totals.pending, 1);
    assert.equal(result.totals.slotsWorked, 1);
    assert.equal(result.totals.slotsNew, 3);
    assert.equal(result.totals.slotsPending, 1);
    assert.equal(result.totals.completed, 4);
    assert.ok(result.activeEntities > 300);
    assert.equal(result.totals.completion, Number((4 / result.activeEntities).toFixed(4)));
});

test('模式筛选只保留 CW / SSB / DIGI 对应 QSO', async () => {
    const cw = await matrix({mode: 'CW'});
    assert.equal(entity(cw, 291).cells['20m'].status, 'worked');
    assert.equal(entity(cw, 515), undefined);
    assert.equal(entity(cw, 489), undefined);

    const ssb = await matrix({mode: 'SSB'});
    assert.equal(entity(ssb, 515).status, 'new');
    assert.equal(entity(ssb, 291), undefined);

    const digi = await matrix({mode: 'DIGI'});
    assert.equal(entity(digi, 489).status, 'new');
    assert.equal(entity(digi, 291), undefined);
});

test('scope=all 时不区分本届，全部记为已通联', async () => {
    const result = await matrix({mode: 'ALL', scope: 'all'});
    assert.equal(result.scope, 'all');
    assert.equal(result.window.from, null);
    assert.equal(result.totals.pending, 0);
    assert.equal(result.totals.slotsPending, 0);
    assert.equal(entity(result, 201).status, 'worked');
});

test('multPerBand=false 时折叠为单列 ALL', async () => {
    const result = await matrix({mode: 'ALL'}, {multPerBand: false});
    assert.equal(result.perBand, false);
    assert.deepEqual(result.bands, ['ALL']);
    assert.equal(entity(result, 291).cells.ALL.status, 'worked');
    assert.equal(entity(result, 515).cells.ALL.status, 'new');
});

test('没有设置窗口时用最近一届赛事推断，并给出提示', async () => {
    const rows = [
        row('DL/K1ABC', '20m', 'CW', '2026-10-01T00:00:00.000Z', 'ARRL'),
        row('K1ABC', '20m', 'CW', '2026-11-02T00:00:00.000Z', 'CQWW'),
        row('K1ABC', '20m', 'CW', '2026-11-03T00:00:00.000Z', 'CQWW')
    ];
    const prepared = service.prepare({mode: 'ALL'}, {});
    const result = await service.complete(prepared, rows);
    assert.equal(result.contest, 'CQWW');
    assert.equal(result.window.source, 'derived');
    assert.equal(result.window.from, '2026-11-02T00:00:00.000Z');
    assert.equal(entity(result, 230).status, 'pending');
    assert.equal(entity(result, 291).status, 'new');

    const empty = await service.complete(service.prepare({mode: 'ALL'}, {}), []);
    assert.ok(empty.warnings.includes('no-window'));
});

test('无法解析的呼号不参与实体统计', async () => {
    const rows = [row('QQ1ZZZ', '20m', 'CW', '2026-11-05T00:00:00.000Z', 'CQWW')];
    const result = await matrix({mode: 'ALL'}, {}, rows);
    assert.equal(result.totals.entities, 0);
    assert.equal(result.rows.length, 0);
    assert.equal(result.unknown.callCount, 1);
    assert.equal(result.totals.completion, 0);
});
