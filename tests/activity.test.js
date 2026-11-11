'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const activity = require('../lib/activity/service.js');
const schema = require('../lib/storage/schema.js');

test('5 分钟桶按 UTC 对齐，非法时间返回 null', () => {
    assert.equal(activity.bucketOf('2026-11-08T12:03:45.000Z'), '2026-11-08T12:00');
    assert.equal(activity.bucketOf('2026-11-08T12:07:00.000Z'), '2026-11-08T12:05');
    assert.equal(activity.bucketOf('2026-11-08T12:59:59.000Z'), '2026-11-08T12:55');
    assert.equal(activity.bucketOf('not-a-date'), null);
    assert.equal(activity.bucketOf(new Date('2026-11-08T12:05:00.000Z')), '2026-11-08T12:05');
});

test('查询窗口被钳制在 5 分钟到 720 分钟', () => {
    assert.deepEqual(activity.parseOptions({}), {bucketMin: 5, windowMin: 60, buckets: 12});
    assert.equal(activity.parseOptions({window: '1'}).windowMin, 5);
    assert.equal(activity.parseOptions({window: '5000'}).windowMin, 720);
    assert.equal(activity.parseOptions({window: '30'}).buckets, 6);
});

test('聚合行折叠成按波段的连续序列与总计', () => {
    const buckets = ['2026-11-08T11:50', '2026-11-08T11:55', '2026-11-08T12:00'];
    const result = activity.build([
        {bucket: '2026-11-08T11:55', band: '20', spots: 4, calls: 3},
        {bucket: '2026-11-08T11:55', band: '15', spots: 2, calls: 2},
        {bucket: '2026-11-08T12:00', band: '20', spots: 6, calls: 5}
    ], {bucketMin: 5, buckets});

    assert.deepEqual(result.buckets, buckets);
    assert.deepEqual(result.bands, ['20', '15']);
    assert.deepEqual(result.series['20'].map(item => item.spots), [0, 4, 6]);
    assert.deepEqual(result.series['15'].map(item => item.spots), [0, 2, 0]);
    assert.deepEqual(result.totals['20'], {spots: 10, calls: 5});
    assert.deepEqual(result.latest['20'], {bucket: '2026-11-08T12:00', spots: 6, calls: 5});
    assert.equal(activity.recentTotal(result, '20', 2), 10);
    assert.equal(activity.recentCalls(result, '20', 2), 5);
    assert.equal(activity.recentTotal(result, '40', 2), 0);
});

test('空输入仍返回完整桶轴，规则引擎不用自己补零', () => {
    const buckets = ['2026-11-08T11:55', '2026-11-08T12:00'];
    const result = activity.build([], {bucketMin: 5, buckets});
    assert.deepEqual(result.bands, []);
    assert.deepEqual(result.series, {});
    assert.deepEqual(result.buckets, buckets);
});

test('计数器由 spots AFTER INSERT 触发器维护，且不放开 monitored 过滤', () => {
    const ddl = schema.createActivity();
    assert.equal(ddl.length, 4);
    assert.match(ddl[0], /CREATE TABLE IF NOT EXISTS band_activity/);
    assert.match(ddl[1], /CREATE TABLE IF NOT EXISTS band_activity_call/);
    assert.match(ddl[2], /DROP TRIGGER IF EXISTS trg_spots_band_activity/);
    assert.match(ddl[3], /AFTER INSERT ON spots/);
    assert.match(ddl[3], /INSERT OR IGNORE INTO band_activity_call/);
    assert.match(ddl[3], /CAST\(substr\(NEW\.timestamp, 15, 2\) AS INTEGER\) \/ 5/);
    assert.doesNotMatch(ddl.join('\n'), /monitored/i);
});

test('聚合表按保留天数清理，0 天表示永久保留', () => {
    const statements = schema.purgeActivity(7, '2026-11-11T00:00:00.000Z');
    assert.equal(statements.length, 2);
    assert.match(statements[0], /DELETE FROM band_activity_call WHERE bucket < '2026-11-04T00:00'/);
    assert.match(statements[1], /DELETE FROM band_activity WHERE bucket < '2026-11-04T00:00'/);
    assert.deepEqual(schema.purgeActivity(0, '2026-11-11T00:00:00.000Z'), []);
});
