'use strict';

/**
 * 波段活跃度读侧 SQL（生成器只放在 storage 层，服务层做纯计算）。
 */

const BUCKET_MIN = 5;

function bucketFloor(value, minutes) {
    const date = value instanceof Date ? value : new Date(value);
    const width = minutes || BUCKET_MIN;
    return new Date(Math.floor(date.getTime() / (width * 60000)) * width * 60000);
}

/** 读侧 SQL：按桶区间取聚合行。 */
function querySql(buckets, now) {
    const count = Math.min(Math.max(parseInt(buckets, 10) || 12, 1), 144);
    const from = bucketFloor(now || new Date(), BUCKET_MIN * count).toISOString().slice(0, 16);
    return {
        from,
        sql: "SELECT bucket, band, spots, calls FROM band_activity " +
            "WHERE bucket >= '" + from + "' ORDER BY bucket ASC, band ASC"
    };
}

module.exports = {BUCKET_MIN, bucketFloor, querySql};
