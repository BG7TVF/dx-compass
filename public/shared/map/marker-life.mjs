/**
 * 地图上标记的生命周期（存活时长 / 淡出比例 / 剪枝节奏）的唯一实现。
 *
 * 这里是纯函数：不碰 DOM、不依赖 Leaflet，因此 QSO 页、OP 视图和大屏地图
 * 用的是同一把尺子。以前 OP 视图和大屏的地图完全不读 qsoTtl / ttl，标记一画
 * 上去就留到下一次全量重绘，用户在设置里改「标记存活」毫无反应；现在三处都
 * 只问这个模块要答案。
 *
 * 时间基准一律是该条记录自己的时间（QSO 用 ts、SPOT 用 timestamp），不是
 * 浏览器收到它的时刻：刷新页面或补录历史时，老标记不会重新"出生"。
 */
import '../settings/schema.js';

const MINUTE_MS = 60000;
/* 淡出/剪枝 tick 的兜底值与区间，和设置页里的 fadeSec / pruneSec 一致。 */
const FALLBACK_FADE_SEC = 10;
const FALLBACK_PRUNE_SEC = 30;

/** schema 的 ttl 默认值（{CW,SSB,DIGI}）；模块按副作用导入，取值时才保证已挂载。 */
function schemaTtl(key) {
    const schema = globalThis.DXSettingsSchema;
    const defaults = schema && schema.DEFAULT_TTL_MIN;
    const minutes = defaults && defaults[key];
    return Number.isFinite(minutes) ? minutes * MINUTE_MS : 0;
}

/** 数值夹到 [min,max]；非法值退回 fallback。 */
export function clampSec(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** 淡出重算间隔（毫秒），来自设置 fadeSec。 */
export function fadeTickMs(settings) {
    return clampSec(settings && settings.fadeSec, FALLBACK_FADE_SEC, 5, 60) * 1000;
}

/** 过期清理间隔（毫秒），来自设置 pruneSec。 */
export function pruneTickMs(settings) {
    return clampSec(settings && settings.pruneSec, FALLBACK_PRUNE_SEC, 10, 300) * 1000;
}

/**
 * 某条 SPOT 行的存活毫秒数：按模式取 settings.ttl，缺这个模式的键回退 SSB，
 * SSB 也拿不到才用 schema 默认。模式名原样大写查表（USB/FT8 之类自然落到
 * SSB / DIGI 之外的回退），与 SPOT 页一直以来的口径保持一致。
 */
export function ttlForMode(settings, mode) {
    const map = (settings && settings.ttl) || {};
    const key = String(mode || '').trim().toUpperCase();
    const minutes = map[key] !== undefined ? map[key] : map.SSB;
    if (minutes !== undefined && Number.isFinite(Number(minutes))) return Number(minutes) * MINUTE_MS;
    return schemaTtl(key) || schemaTtl('SSB');
}

/** QSO 标记存活毫秒数：0 / 非法 / 负数 = 不限（只受数量上限约束）。 */
export function qsoTtlMs(settings) {
    const raw = Number(settings && settings.qsoTtl);
    return Number.isFinite(raw) && raw > 0 ? raw * MINUTE_MS : 0;
}

/**
 * 记录自己的出生时刻。取不到合法时间戳时返回 null——调用方据此把这条记录
 * 当作「不过期」处理：宁可多留一个标记，也不要把没有时间的历史数据算成过期。
 */
export function bornAtOf(value, now = Date.now()) {
    const raw = value && typeof value === 'object'
        ? (value.ts !== undefined ? value.ts : value.timestamp)
        : value;
    if (raw === null || raw === undefined || raw === '') return null;
    const time = new Date(raw).getTime();
    return Number.isFinite(time) ? time : null;
}

/** 到期时刻：ttlMs<=0 或没有出生时刻 = Infinity（永不过期）。 */
export function dieAtOf(bornAt, ttlMs) {
    const ttl = Number(ttlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) return Infinity;
    if (!Number.isFinite(bornAt)) return Infinity;
    return bornAt + ttl;
}

/** 是否已过期（该从地图上剪掉了）。 */
export function isExpired(dieAt, now = Date.now()) {
    return Number.isFinite(dieAt) && now >= dieAt;
}

/**
 * 淡出比例：出生时为 1，到期为 0，中间线性递减（与 SPOT 页原有曲线同一个公式）。
 * 永不过期的标记恒为 1，不参与淡出。
 */
export function fadeOpacity(bornAt, dieAt, now = Date.now()) {
    if (!Number.isFinite(dieAt)) return 1;
    const total = dieAt - (Number.isFinite(bornAt) ? bornAt : now);
    if (total <= 0) return 1;
    return Math.max(0, Math.min(1, (dieAt - now) / total));
}

/**
 * 一次性算出一条记录的完整生命周期，供绘制处直接取用。
 * `expired` 为真就整条跳过；否则用 `opacity` 缩放该记录本来的透明度。
 */
export function markerLife({ttlMs, at, now = Date.now()}) {
    const bornAt = bornAtOf(at, now);
    const dieAt = dieAtOf(bornAt, ttlMs);
    return {bornAt, dieAt, expired: isExpired(dieAt, now), opacity: fadeOpacity(bornAt, dieAt, now)};
}

/** 把淡出比例乘到基准透明度上，结果始终落在 [0,1]。 */
export function fadeScale(opacity, base) {
    const value = Number(base);
    if (!Number.isFinite(value)) return 0;
    const scale = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    return Math.max(0, Math.min(1, value * scale));
}
