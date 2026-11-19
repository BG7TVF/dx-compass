'use strict';

/**
 * RTSP 摄取：spawn ffmpeg 把 RTSP 流转成 MJPEG 写进 stdout，再按 JPEG
 * SOI/EOI 边界切帧。这是唯一会起子进程的摄取模块。
 *
 * 账号密码只注入到传给 ffmpeg 的 URL（内存中），绝不外传；进程内不做
 * 任何日志刷屏，异常通过 ctx.note 上报。ffmpeg 未安装（ENOENT）时不重试，
 * 直接 ctx.fallback() 让 hub 降级到快照轮询。
 */

const childProcess = require('child_process');

const NO_FRAME_MS = 10000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1000;
const MAX_BACKOFF_MS = 30000;
const KILL_GRACE_MS = 500;

/** 把 user/pass 注入 rtsp URL 的 userinfo；已带 userinfo 不重复注入。 */
function injectUserInfo(url, username, password) {
    if (!url) return url;
    if (!username) return url;
    const m = /^rtsp:\/\/([^/]*)/i.exec(url);
    if (!m) return url;
    const authority = m[1];
    if (authority.indexOf('@') >= 0) return url; // 已有 userinfo
    const creds = encodeURIComponent(String(username)) + ':' +
        encodeURIComponent(String(password || ''));
    return 'rtsp://' + creds + '@' + url.slice('rtsp://'.length);
}

function findMarker(buf, from) {
    // 找 FF D8（SOI）。
    for (let i = from; i < buf.length - 1; i++) {
        if (buf[i] === 0xFF && buf[i + 1] === 0xD8) return i;
    }
    return -1;
}

function findEoi(buf, from) {
    // 找 FF D9（EOI）。
    for (let i = from; i < buf.length - 1; i++) {
        if (buf[i] === 0xFF && buf[i + 1] === 0xD9) return i + 2; // 含 EOI 两字节
    }
    return -1;
}

function start(ctx) {
    const cfg = ctx.cfg;
    const fps = Math.min(10, Math.max(1, cfg.fps || 5));
    let url = cfg.stream_url || ('rtsp://' + cfg.host + ':' + (cfg.rtsp_port || 554) + '/');
    url = injectUserInfo(url, cfg.username, cfg.password);

    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-rtsp_transport', 'tcp',
        '-i', url,
        '-threads', '1',
        '-vf', 'fps=' + fps + ",scale='min(1280,iw)':-2",
        '-f', 'mjpeg', '-q:v', '6',
        'pipe:1'
    ];

    let stopped = false;
    let fatal = false;            // ENOENT 等致命错误，不再重开
    let restartAttempt = 0;
    let child = null;
    let acc = Buffer.alloc(0);
    let stderrRing = '';
    let watchdog = null;
    let restartTimer = null;
    let killTimer = null;

    function killChild() {
        if (!child || child.killed) return;
        const target = child;
        try { target.kill('SIGTERM'); } catch (e) {}
        if (killTimer) clearTimeout(killTimer);
        killTimer = setTimeout(function() {
            if (target.exitCode === null && target.signalCode === null) {
                try { target.kill('SIGKILL'); } catch (e) {}
            }
        }, KILL_GRACE_MS);
        if (killTimer.unref) killTimer.unref();
    }

    function resetWatchdog() {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(function() {
            // 长时间无新帧：杀掉进程，靠 close 走指数退避重开。
            killChild();
        }, NO_FRAME_MS);
        if (watchdog.unref) watchdog.unref();
    }

    function drainFrames() {
        for (;;) {
            const startIdx = findMarker(acc, 0);
            if (startIdx < 0) {
                // 没有 SOI，丢掉除最后一字节外的数据。
                if (acc.length > 1) acc = acc.slice(acc.length - 1);
                return;
            }
            if (startIdx > 0) acc = acc.slice(startIdx);
            const endIdx = findEoi(acc, 2);
            if (endIdx < 0) return; // 帧还没收完
            const frame = acc.slice(0, endIdx);
            acc = acc.slice(endIdx);
            if (frame.length > 2) {
                restartAttempt = 0;     // 来帧即认为链路恢复，退避归零
                resetWatchdog();
                ctx.publish(frame);
            }
        }
    }

    function spawn() {
        if (stopped || fatal) return;
        acc = Buffer.alloc(0);
        let proc;
        try {
            proc = childProcess.spawn('ffmpeg', args, {windowsHide: true});
        } catch (e) {
            ctx.note('spawn-failed');
            fatal = true;
            ctx.fallback();
            return;
        }
        child = proc;

        proc.stdout.on('data', function(chunk) {
            if (stopped) return;
            acc = Buffer.concat([acc, chunk]);
            if (acc.length > MAX_BUFFER_BYTES) {
                // 帧迟迟不完整说明流坏了，整段丢弃防泄漏。
                acc = Buffer.alloc(0);
                return;
            }
            drainFrames();
        });
        proc.stdout.on('error', function() {});

        proc.stderr.on('data', function(chunk) {
            // 只保留尾部有限字节供日志，不做刷屏。
            stderrRing = (stderrRing + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
        });
        proc.stderr.on('error', function() {});

        proc.on('error', function(err) {
            if (err && err.code === 'ENOENT') {
                ctx.note('binary-missing');
                fatal = true;       // ffmpeg 没装，重开也没用
                if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                ctx.fallback();     // 交回 hub 降级到快照轮询
                return;
            }
            ctx.note('spawn-error');
        });

        proc.on('close', function() {
            if (stopped || fatal) return;
            child = null;
            if (watchdog) { clearTimeout(watchdog); watchdog = null; }
            ctx.note('stream-closed');
            scheduleRestart();
        });

        resetWatchdog();
    }

    function scheduleRestart() {
        if (stopped || fatal) return;
        restartAttempt += 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, restartAttempt - 1));
        restartTimer = setTimeout(spawn, delay);
        if (restartTimer.unref) restartTimer.unref();
    }

    spawn();

    return function stop() {
        if (stopped) return;
        stopped = true;
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        const target = child;
        child = null;
        acc = Buffer.alloc(0);
        if (target) {
            try { target.removeAllListeners && target.removeAllListeners(); } catch (e) {}
            try { target.kill('SIGTERM'); } catch (e) {}
            // 500ms 后仍存活再补 SIGKILL。
            const t = setTimeout(function() {
                if (target.exitCode === null && target.signalCode === null) {
                    try { target.kill('SIGKILL'); } catch (e) {}
                }
            }, KILL_GRACE_MS);
            if (t.unref) t.unref();
        }
    };
}

module.exports = {
    start: start,
    // 纯函数导出，便于单测 URL userinfo 注入
    _injectUserInfo: injectUserInfo
};
