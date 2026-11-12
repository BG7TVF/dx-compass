import test from 'node:test';
import assert from 'node:assert/strict';
import {
    htmlToText, extractBands, extractPeriods, extractCategories,
    extractQsoPoints, extractSource, validateRules, diffRules
} from '../scripts/fetch-contest-rules.mjs';

const SPEC = {family: 'CQWW', name: 'CQ World-Wide DX Contest', sources: []};
const FETCHED = '2026-11-12T00:00:00.000Z';

const HTML = `<!doctype html><html><body>
<h1>The 2026 CQ World-Wide DX Contest</h1>
<p>SSB: October 24-25&nbsp;&nbsp; CW: November 28-29</p>
<p>II. BANDS: Six bands only: 1.8, 3.5, 7, 14, 21 and 28 MHz.</p>
<p>V. SCORING: Contacts between stations on different continents count three (3) points.
Contacts between stations on the same continent but in different countries count one (1) point.
Contacts between stations in the same country have zero (0) QSO point value.</p>
<p>Zone: one (1) for each different CQ Zone contacted on each band.
Country: one (1) for each different country contacted on each band.</p>
<p>1. Multi-Single: Only one transmitted signal on one band permitted during any 10-minute period.
The multiplier station/signal may not call CQ.</p>
<p>2. Multi-Two: Two transmitted signals. A maximum of 8 band changes in any clock hour.</p>
<p>3. Multi-Multi: Six bands may be used at the same time.</p>
</body></html>`;

test('HTML 转文本保留段落边界并解码实体', () => {
    const text = htmlToText('<p>A&amp;B</p><p>C&nbsp;D</p><script>bad()</script>');
    assert.equal(text, 'A&B\nC D');
});

test('波段列表兼容 MHz 与 meter 两种写法', () => {
    assert.deepEqual(extractBands('II. BANDS: Six bands only: 1.8, 3.5, 7, 14, 21 and 28 MHz.'),
        ['160m', '80m', '40m', '20m', '15m', '10m']);
    assert.deepEqual(extractBands('Use only the 160, 80, 40, 20, 15, and 10 meter bands.'),
        ['160m', '80m', '40m', '20m', '15m', '10m']);
    assert.equal(extractBands('no band list here'), 'unknown');
});

test('起止时间按页面年份生成 UTC 区间', () => {
    const result = extractPeriods(htmlToText(HTML), 2026, 'CW');
    assert.equal(result.periods.length, 2);
    assert.equal(result.periods[0].start, '2026-10-24T00:00:00.000Z');
    assert.equal(result.periods[0].end, '2026-10-25T23:59:59.000Z');
    assert.equal(result.periods[1].start, '2026-11-28T00:00:00.000Z');
});

test('组别限制按标题分块，Multi-Single 不会借用 Multi-Two 配额', () => {
    const {categories, unknowns} = extractCategories(htmlToText(HTML), 'CQWW');
    assert.deepEqual(categories.MS.bandChange, {rule: 'time-lock', minutes: 10});
    assert.equal(categories.MS.multiplierStationRole, 'mult');
    assert.equal(categories.M2.simultaneousSignals, 2);
    assert.deepEqual(categories.M2.bandChange, {rule: 'hourly-quota', limitPerHour: 8});
    assert.equal(categories.MM.simultaneousSignals, 6);
    assert.equal(categories.MM.bandChange, 'unknown');
    assert.ok(unknowns.some(item => item.field === 'categories.MM.bandChange'));
});

test('单源抽取输出完整字段，unknown 显式记录', () => {
    const source = extractSource(SPEC, ['CW', 'SSB'], HTML, 'https://example.test/rules', FETCHED);
    assert.equal(source.name, 'The 2026 CQ World-Wide DX Contest');
    assert.equal(source.year, 2026);
    assert.deepEqual(source.modes, ['CW', 'SSB']);
    assert.equal(source.multiplierCounting, 'dxcc-per-band');
    assert.equal(source.qsoPoints.differentContinent, 3);
    assert.deepEqual(source.unknowns.map(item => item.field), ['categories.MM.bandChange']);
    assert.equal(source.fetchedAt, FETCHED);
});

test('校验拒绝缺家族或结构错误的文档', () => {
    const errors = validateRules({schemaVersion: 1, contests: {}});
    assert.ok(errors.some(line => line.includes('CQWW: missing')));
    assert.ok(errors.some(line => line.includes('CQ160: missing')));
});

test('差异提示区分新增、变化与未变化', () => {
    const previous = {contests: {CQWW: {year: 2025}, CQ160: {year: 2025}}};
    const next = {contests: {CQWW: {year: 2026}, CQ160: {year: 2025}, IARU: {year: 2026}}};
    const diff = diffRules(previous, next);
    assert.deepEqual(diff.lines, ['~ CQWW', '= CQ160', '+ IARU']);
    assert.equal(diff.unknownCount, 0);
});

test('CQWW RTTY 计分表按三/二/一解析', () => {
    const text = 'Contacts between stations on different continents count three (3) points. '
        + 'Contacts between stations on the same continent count two (2) points. '
        + 'Contacts within the same country count one (1) point.';
    assert.deepEqual(extractQsoPoints(text, 'CQWW_RTTY'), {
        sameCountry: 1, sameContinent: 2, differentContinent: 3
    });
});

test('WAE 三段赛程与 SINGLE-OP/MULTI-OP 组别可解析', () => {
    const text = 'CW: August, second full weekend\n'
        + 'Saturday, August 8th 2026, 00:00 UTC until Sunday, August 9th 2026, 23:59 UTC\n'
        + 'SSB: September, second full weekend\n'
        + 'Saturday, September 12th 2026, 00:00 UTC until Sunday, September 13th 2026, 23:59 UTC\n'
        + 'RTTY: November, second full weekend\n'
        + 'Saturday, November 14th 2026, 00:00 UTC until Sunday, November 15th 2026, 23:59 UTC\n'
        + 'SINGLE-OP LOW\nMax. output 100 watts - all bands. Only one signal permitted at any time.\n'
        + 'MULTI-OP\nBand changes are allowed every 10 minutes.\n';
    const periods = extractPeriods(text, 2026, 'CW').periods;
    assert.equal(periods.length, 3);
    assert.deepEqual(periods.map(p => p.mode), ['CW', 'SSB', 'RTTY']);
    assert.equal(periods[0].start, '2026-08-08T00:00:00.000Z');
    const {categories} = extractCategories(text, 'WAE');
    assert.equal(categories.SO1R.simultaneousSignals, 1);
    assert.equal(categories.MS.bandChange.rule, 'time-lock');
    assert.equal(categories.MS.bandChange.minutes, 10);
});
