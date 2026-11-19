'use strict';

/**
 * 快照轮询摄取（HTTP GET 单帧 JPEG）。
 *
 * 用 setTimeout 递归而非 setInterval：摄像头响应慢时，setInterval 会把
 * 多个请求叠在一起，越拖越糟；这里必须等上一次结束再排下一次。
 * 连续失败退避到 5s，成功即恢复原周期；失败只通过 ctx.note 上报。
 */

const net = require('./net.js');

const MIN_PERIOD_MS = 200;
const BACKOFF_PERIOD_MS = 5000;
const FAILURE_BACKOFF = 5;

function start(ctx) {
    const cfg = ctx.cfg;
    const port = cfg.port || 80;
    const url = cfg.snapshot_url ||
        ('http://' + cfg.host + (port && port !== 80 ? ':' + port : '') + '/jpg');
    const fps = cfg.fps || 2;
    const basePeriod = Math.max(MIN_PERIOD_MS, Math.round(1000 / fps));

    let stopped = false;
    let timer = null;
    let failures = 0;

    function schedule(period) {
        if (stopped) return;
        timer = setTimeout(tick, period);
        if (timer.unref) timer.unref();
    }

    function tick() {
        if (stopped) return;
        net.fetchBinary(url, {username: cfg.username, password: cfg.password})
            .then(function(buffer) {
                if (stopped) return;          // 进行中的请求结果直接丢弃
                failures = 0;
                ctx.publish(buffer);
                schedule(basePeriod);
            })
            .catch(function(err) {
                if (stopped) return;
                failures += 1;
                ctx.note(err && err.message ? err.message : 'snapshot-failed');
                // 连续多次失败才退避，避免偶发一次就拖慢恢复。
                schedule(failures >= FAILURE_BACKOFF ? BACKOFF_PERIOD_MS : basePeriod);
            });
    }

    // 首次立即取，之后链式排期。
    tick();

    return function stop() {
        if (stopped) return;
        stopped = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
}

module.exports = {start: start};
