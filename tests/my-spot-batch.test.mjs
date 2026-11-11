import test from 'node:test';
import assert from 'node:assert/strict';

import {MySpotBatcher, MY_SPOT_WINDOW_MS} from '../public/shared/alerts/my-spot-batch.mjs';

test('我的 SPOT：30 秒窗口内合并计数，窗口结束后重新开始', () => {
    const batcher = new MySpotBatcher(MY_SPOT_WINDOW_MS);
    const start = 1700000000000;
    assert.deepEqual(batcher.push(start), {count: 1, started: true});
    assert.deepEqual(batcher.push(start + 5000), {count: 2, started: false});
    assert.deepEqual(batcher.push(start + 12000), {count: 3, started: false});
    assert.equal(batcher.count, 3);
    const window = batcher.take();
    assert.equal(window.count, 3);
    assert.equal(batcher.count, 0);
    assert.deepEqual(batcher.push(start + 31000), {count: 1, started: true});
});

test('我的 SPOT：窗口边界到达后视为新窗口', () => {
    const batcher = new MySpotBatcher(30000);
    batcher.push(0);
    assert.deepEqual(batcher.push(29999), {count: 2, started: false});
    assert.deepEqual(batcher.push(30000), {count: 1, started: true});
});
