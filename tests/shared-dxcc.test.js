'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const paths = require('../lib/analysis/paths.js');
const entitiesFile = require('../public/shared/dxcc/entities.json');

const NOW_SEC = Math.floor(Date.parse('2026-11-10T13:00:00Z') / 1000);

function entity(dxcc) {
    return entitiesFile.entities.find(item => item.dxcc === dxcc);
}

function row(sender, sGrid, sDxcc, receiver, rGrid, rDxcc, snr, time, lat, lon) {
    return {
        spot_call: sender, de: receiver, band: '20m', snr,
        comment: `PSKR FT8 ${snr} dB`, mode: 'DIGI', timestamp: time,
        sender_grid: sGrid, receiver_grid: rGrid,
        dxcc_sender: sDxcc, dxcc_receiver: rDxcc,
        lat: lat || 31.2, lon: lon || 121.4, dx_lat: 35.6, dx_lon: 139.7
    };
}

test('DXCC 实体表覆盖 318/339/291/110 的国家与主字头', () => {
    assert.deepEqual(entity(318), {dxcc: 318, name: 'China', prefix: 'BY', deleted: false, nameZh: '中国'});
    assert.equal(entity(339).name, 'Japan');
    assert.equal(entity(339).prefix, 'JA');
    assert.equal(entity(339).nameZh, '日本');
    assert.equal(entity(291).name, 'United States');
    assert.equal(entity(291).prefix, 'K');
    assert.equal(entity(110).prefix, 'KH6');
    assert.ok(entitiesFile.entities.length > 300, '应覆盖 ADIF/ARRL DXCC 实体');
    assert.ok(entitiesFile.source.includes('ADIF'), '数据文件必须标注 ADIF 来源');
    assert.ok(entitiesFile.source.includes('ARRL'), '补充实体必须标注 ARRL 来源');
    assert.equal(entitiesFile.fetched, '2026-11-11');
});

test('卡片标题按语言渲染国家与主字头，不再拼接网格', async () => {
    const {regionTitle} = await import('../public/shared/dxcc/title.mjs');
    const japan = {dxcc: 339, country: 'Japan', countryZh: '日本', prefix: 'JA',
        grid: 'PM95', grids: ['PM95', 'PM96', 'PM74']};
    assert.equal(regionTitle(japan, 'en'), 'Japan, JA');
    assert.equal(regionTitle(japan, 'zh'), '日本, JA');
    assert.equal(regionTitle(japan, 'de'), 'Japan, JA');
    assert.equal(regionTitle(japan, 'zh-CN'), '日本, JA');
    assert.ok(!regionTitle(japan, 'en').includes('PM95'));
});

test('缺号/未知编号/无网格时按顺序回退且不编造国家名', async () => {
    const {regionTitle} = await import('../public/shared/dxcc/title.mjs');
    // 表内没有的编号：保留网格前缀与 DXCC 编号便于追溯
    assert.equal(regionTitle({dxcc: 999, country: '', countryZh: '', prefix: 'PM95', grid: 'PM95'}, 'zh', '未知区域'),
        'PM95 · DXCC 999');
    // 完全没有编号：只显示网格
    assert.equal(regionTitle({dxcc: null, country: '', prefix: '', grid: 'PM95'}, 'zh', '未知区域'), 'PM95');
    // 编号与网格都没有：显示未知区域
    assert.equal(regionTitle({dxcc: null, country: '', prefix: '', grid: ''}, 'zh', '未知区域'), '未知区域');
    assert.equal(regionTitle(null, 'en', 'Unknown region'), 'Unknown region');
});

test('同一 DXCC 多个网格前缀只产生一条卡片并只显示一次国家+字头', async () => {
    const {regionTitle} = await import('../public/shared/dxcc/title.mjs');
    const rows = [];
    const grids = ['PM95AA', 'PM96BB', 'PM74CC'];
    grids.forEach((grid, index) => {
        for (let i = 0; i < 2; i += 1) {
            rows.push(row('BG7NEI', 'OL42AA', 318, 'JA' + (index + 1) + 'AA', grid, 339,
                3 + index + i, `2026-11-10T12:0${index}:1${i}Z`));
        }
    });
    const report = paths.analyzePaths({
        myCall: 'BG7TV', myGrid: 'OL42ET', monitored: [], windowMinutes: 15, rows, now: NOW_SEC
    });
    assert.equal(report.rows.length, 1, '三个网格同属 DXCC 339，应合并为一张卡片');
    const region = report.rows[0].region;
    assert.equal(region.dxcc, 339);
    assert.equal(region.country, 'Japan');
    assert.equal(region.prefix, 'JA');
    assert.deepEqual(region.grids.slice().sort(), ['PM74', 'PM95', 'PM96']);
    assert.equal(regionTitle(region, 'en'), 'Japan, JA');
    assert.equal(regionTitle(region, 'zh'), '日本, JA');
});
