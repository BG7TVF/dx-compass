import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/shared/settings/schema.js';
import {
    bornAtOf,
    clampSec,
    dieAtOf,
    fadeOpacity,
    fadeScale,
    fadeTickMs,
    isExpired,
    markerLife,
    pruneTickMs,
    qsoTtlMs,
    ttlForMode
} from '../public/shared/map/marker-life.mjs';

const MINUTE = 60000;

test('qsoTtl: 0/非法值/负数一律当作不限，正数按分钟换算', () => {
    assert.equal(qsoTtlMs({qsoTtl: 0}), 0);
    assert.equal(qsoTtlMs({qsoTtl: -12}), 0);
    assert.equal(qsoTtlMs({qsoTtl: ''}), 0);
    assert.equal(qsoTtlMs({qsoTtl: 'abc'}), 0);
    assert.equal(qsoTtlMs({}), 0);
    assert.equal(qsoTtlMs(null), 0);
    assert.equal(qsoTtlMs({qsoTtl: 5}), 5 * MINUTE);
    assert.equal(qsoTtlMs({qsoTtl: '45'}), 45 * MINUTE);
});

test('ttlForMode: 命中模式用自己的值，缺键回退 SSB，再缺才用 schema 默认', () => {
    const settings = {ttl: {CW: 10, SSB: 20, DIGI: 30}};
    assert.equal(ttlForMode(settings, 'CW'), 10 * MINUTE);
    assert.equal(ttlForMode(settings, 'digi'), 30 * MINUTE);
    assert.equal(ttlForMode(settings, ' USB '), 20 * MINUTE);   // 电话模式落到 SSB 档
    assert.equal(ttlForMode(settings, 'FT8'), 20 * MINUTE);     // 表里没有这个模式 → SSB 档
    assert.equal(ttlForMode({ttl: {SSB: 7}}, 'CW'), 7 * MINUTE);
    assert.equal(ttlForMode({ttl: {DIGI: 0}}, 'DIGI'), 0);      // 显式 0 仍然有效
    assert.equal(ttlForMode({}, null), globalThis.DXSettingsSchema.DEFAULT_TTL_MIN.SSB * MINUTE);
    assert.equal(ttlForMode(undefined, 'CW'), globalThis.DXSettingsSchema.DEFAULT_TTL_MIN.CW * MINUTE);
});

test('bornAtOf: QSO 用 ts、SPOT 用 timestamp，非法时间戳当作没有', () => {
    const stamp = '2026-11-28T10:00:00.000Z';
    const wanted = new Date(stamp).getTime();
    assert.equal(bornAtOf({ts: stamp}), wanted);
    assert.equal(bornAtOf({timestamp: stamp}), wanted);
    assert.equal(bornAtOf({ts: 1700000000000}), 1700000000000);
    assert.equal(bornAtOf(wanted), wanted);
    assert.equal(bornAtOf({ts: null}), null);
    assert.equal(bornAtOf({}), null);
    assert.equal(bornAtOf({timestamp: ''}), null);
    assert.equal(bornAtOf({timestamp: 'not-a-date'}), null);
});

test('非法或空时间戳的记录当作「不过期」', () => {
    const now = Date.now();
    [null, undefined, '', 'garbage', {ts: 'garbage'}].forEach(value => {
        const bornAt = bornAtOf(value, now);
        const dieAt = dieAtOf(bornAt, ttlForMode({ttl: {SSB: 1}}, 'SSB'));
        assert.equal(dieAt, Infinity, String(value));
        assert.equal(isExpired(dieAt, now + 10 * MINUTE), false);
        assert.equal(markerLife({ttlMs: MINUTE, at: value, now: now + 10 * MINUTE}).expired, false);
    });
});

test('dieAtOf: ttl<=0 或没有出生时刻 = Infinity，否则出生+存活', () => {
    assert.equal(dieAtOf(1000, 0), Infinity);
    assert.equal(dieAtOf(1000, -5), Infinity);
    assert.equal(dieAtOf(1000, NaN), Infinity);
    assert.equal(dieAtOf(null, 5000), Infinity);
    assert.equal(dieAtOf(1000, 5000), 6000);
});

test('fadeOpacity: 出生为 1、到期为 0，中途单调递减', () => {
    const bornAt = 0;
    const dieAt = 1000;
    const samples = [0, 100, 250, 500, 750, 999, 1000, 2000].map(now =>
        fadeOpacity(bornAt, dieAt, now));
    assert.equal(samples[0], 1);
    assert.equal(samples[6], 0);
    assert.equal(samples[7], 0);
    for (let index = 1; index < samples.length; index += 1) {
        assert.ok(samples[index] <= samples[index - 1], `第 ${index} 个采样没有递减`);
    }
    assert.equal(fadeOpacity(bornAt, dieAt, 500), 0.5);
    assert.equal(fadeOpacity(bornAt, Infinity, 10 ** 12), 1);   // 不限时长的标记不淡出
    assert.equal(fadeOpacity(null, 2000, 500), 1);              // 没有出生时刻：从当前时刻起算，本刻仍是 1
    assert.equal(fadeOpacity(null, Infinity, 500), 1);
});

test('markerLife 把过期判定与淡出比例一起给出', () => {
    const now = Date.now();
    const fresh = markerLife({ttlMs: 10 * MINUTE, at: now, now});
    assert.equal(fresh.dieAt, now + 10 * MINUTE);
    assert.equal(fresh.expired, false);
    assert.equal(fresh.opacity, 1);

    const dying = markerLife({ttlMs: 10 * MINUTE, at: now - 9 * MINUTE, now});
    assert.equal(dying.expired, false);
    assert.equal(dying.opacity, 0.1);

    const dead = markerLife({ttlMs: 10 * MINUTE, at: now - 10 * MINUTE, now});
    assert.equal(dead.expired, true);
    assert.equal(dead.opacity, 0);

    const forever = markerLife({ttlMs: 0, at: now - 999 * MINUTE, now});
    assert.equal(forever.dieAt, Infinity);
    assert.equal(forever.expired, false);
    assert.equal(forever.opacity, 1);
});

test('fadeScale 把淡出比例乘到基准透明度上，结果始终落在 [0,1]', () => {
    assert.equal(fadeScale(0.5, 0.8), 0.4);
    assert.equal(fadeScale(1, 0.62), 0.62);
    assert.equal(fadeScale(0, 0.9), 0);
    assert.equal(fadeScale(2, 0.9), 0.9);
    assert.equal(fadeScale(NaN, 0.9), 0.9);                     // 非法比例当作不淡出
    assert.equal(fadeScale(0.5, null), 0);
});

test('fadeTickMs / pruneTickMs 复用设置里的秒数并夹在合法区间内', () => {
    assert.equal(fadeTickMs({fadeSec: 3}), 5000);               // 下限 5 秒
    assert.equal(fadeTickMs({fadeSec: 600}), 60000);            // 上限 60 秒
    assert.equal(fadeTickMs({}), fadeTickMs(undefined));        // 非法值走兜底
    assert.equal(pruneTickMs({pruneSec: 1}), 10000);            // 下限 10 秒
    assert.equal(pruneTickMs({pruneSec: 9999}), 300000);        // 上限 300 秒
    assert.equal(pruneTickMs({pruneSec: 45}), 45000);
    assert.equal(clampSec('20', 10, 5, 60), 20);
    assert.equal(clampSec(undefined, 10, 5, 60), 10);
});
