'use strict';

/**
 * 波段活跃度聚合（5 分钟桶 × 波段）。
 *
 * 设计约束（来自需求）：
 *   - 不放开 monitoredCalls 过滤，也不全量落盘：计数器只统计“已经通过现有过滤、
 *     真正写入 spots 表”的那些 spot，因此它反映的是“本台关心范围内的活跃度”，
 *     不是全球波段总流量。规则引擎必须按这一口径解释。
 *   - 聚合由 spots 的 AFTER INSERT 触发器维护（见 lib/storage/schema.js），
 *     这里只负责读侧与纯计算，便于单测。
 *
 * 表：
 *   band_activity(bucket, band, spots, calls, updated_at)
 *   band_activity_call(bucket, band, call)   -- 独立呼号去重
 */

const activitySql = require('../storage/activity-sql.js');

const BUCKET_MIN = 5;
const DEFAULT_WINDOW_MIN = 60;
const MAX_WINDOW_MIN = 720;
const MAX_BUCKETS = 144;

function bucketOf(value, minutes) {
    const width = Number.isFinite(minutes) && minutes > 0 ? minutes : BUCKET_MIN;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const ms = Math.floor(date.getTime() / 60000);
    const aligned = Math.floor(ms / width) * width;
    return new Date(aligned * 60000).toISOString().slice(0, 16);
}

const bucketFloor = activitySql.bucketFloor;

function parseOptions(query) {
    const q = query || {};
    const windowMin = Math.min(Math.max(parseInt(q.window, 10) || DEFAULT_WINDOW_MIN, BUCKET_MIN),
        MAX_WINDOW_MIN);
    const buckets = Math.min(Math.max(Math.ceil(windowMin / BUCKET_MIN), 1), MAX_BUCKETS);
    return {bucketMin: BUCKET_MIN, windowMin, buckets};
}

const querySql = activitySql.querySql;

function emptyBucketList(buckets, now) {
    const end = bucketFloor(now || new Date(), BUCKET_MIN);
    const out = [];
    for (let i = buckets - 1; i >= 0; i--) {
        out.push(new Date(end.getTime() - i * BUCKET_MIN * 60000).toISOString().slice(0, 16));
    }
    return out;
}

/**
 * 纯计算：把聚合行折叠成按波段的序列。
 * rows: [{bucket, band, spots, calls}]
 */
function build(rows, options) {
    const opts = options || {};
    const bucketMin = opts.bucketMin || BUCKET_MIN;
    const buckets = Array.isArray(opts.buckets) && opts.buckets.length
        ? opts.buckets.slice()
        : emptyBucketList(opts.count || 12, opts.now || new Date());
    const bandSet = new Set();
    const byBand = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.bucket || !row.band) continue;
        bandSet.add(row.band);
        const series = byBand.get(row.band) || new Map();
        series.set(row.bucket, {
            spots: Number(row.spots) || 0,
            calls: Number(row.calls) || 0
        });
        byBand.set(row.band, series);
    }

    const bands = [...bandSet].sort((a, b) => {
        const rank = {160: 0, 80: 1, 60: 2, 40: 3, 30: 4, 20: 5, 17: 6, 15: 7, 12: 8, 10: 9, 6: 10, 2: 11};
        return (rank[parseInt(a, 10)] ?? 99) - (rank[parseInt(b, 10)] ?? 99) || a.localeCompare(b);
    });

    const series = {};
    const totals = {};
    const latest = {};
    for (const band of bands) {
        const map = byBand.get(band);
        series[band] = buckets.map(bucket => ({
            bucket,
            spots: map.has(bucket) ? map.get(bucket).spots : 0,
            calls: map.has(bucket) ? map.get(bucket).calls : 0
        }));
        const sum = series[band].reduce((acc, item) => {
            acc.spots += item.spots;
            acc.calls = Math.max(acc.calls, item.calls);
            return acc;
        }, {spots: 0, calls: 0});
        totals[band] = {spots: sum.spots, calls: sum.calls};
        latest[band] = series[band].length ? series[band][series[band].length - 1] : null;
    }

    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        bucketMin,
        buckets,
        bands,
        series,
        totals,
        latest
    };
}

/** 最近 N 个桶内某波段的 spot 总数（规则引擎用）。 */
function recentTotal(activity, band, bucketsBack) {
    if (!activity || !activity.series) return 0;
    const list = activity.series[band] || [];
    const back = Number.isFinite(bucketsBack) ? bucketsBack : 3;
    return list.slice(-back).reduce((sum, item) => sum + (Number(item.spots) || 0), 0);
}

/** 最近 N 个桶内某波段的峰值独立呼号数。 */
function recentCalls(activity, band, bucketsBack) {
    if (!activity || !activity.series) return 0;
    const list = activity.series[band] || [];
    const back = Number.isFinite(bucketsBack) ? bucketsBack : 3;
    return list.slice(-back).reduce((max, item) => Math.max(max, Number(item.calls) || 0), 0);
}

/**
 * /api/activity 的 prepare/complete 对。
 * @param {object} query {window}
 * @param {Date}   nowOverride
 */
function prepare(query, nowOverride) {
    const opts = parseOptions(query);
    const now = nowOverride instanceof Date ? nowOverride : new Date(nowOverride || Date.now());
    const {from, sql} = querySql(opts.buckets, now);
    return {
        ok: true,
        error: null,
        sql,
        request: {
            bucketMin: opts.bucketMin,
            windowMin: opts.windowMin,
            buckets: emptyBucketList(opts.buckets, now),
            from,
            now: now.toISOString()
        }
    };
}

function complete(prepared, rows) {
    if (!prepared || !prepared.ok) {
        return {ok: false, error: (prepared && prepared.error) || 'invalid-request'};
    }
    const request = prepared.request || {};
    return build(rows, {
        bucketMin: request.bucketMin,
        buckets: request.buckets,
        count: request.buckets ? request.buckets.length : 12
    });
}

module.exports = {
    BUCKET_MIN,
    DEFAULT_WINDOW_MIN,
    MAX_WINDOW_MIN,
    MAX_BUCKETS,
    bucketOf,
    bucketFloor,
    parseOptions,
    querySql,
    emptyBucketList,
    build,
    prepare,
    complete,
    recentTotal,
    recentCalls
};
