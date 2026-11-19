'use strict';

/**
 * 摄像头 HTTP 端点（自定义节点内注册的全局中间件）。
 *
 * 为什么走节点而不是 settings.httpNodeMiddleware：Node-RED 3.1 的
 * httpNodeMiddleware 无法新开端点，而节点模块在加载阶段（早于 listen 与
 * flows 启动）就被调用，此时 RED.httpNode.use 注册的手写路由能抢在 httpStatic
 * 与 flow 路由之前生效——这与 ready-gate 是同一套已验证机制。
 *
 * 三个端点在响应前先 await lib/ready.js 的门闩，冷启动时只推迟、不拒绝。
 */

const {URL} = require('url');

module.exports = function(RED) {
    const cameras = require('../lib/cameras');
    const ready = require('../lib/ready.js');
    const DISCOVER_BODY_LIMIT = 64 * 1024;

    RED.log.info('camera-hub: HTTP endpoints armed');

    function sendJson(res, status, obj) {
        const body = JSON.stringify(obj);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.end(body);
    }

    function authorized(req, query) {
        const token = process.env.DX_CAMERA_TOKEN;
        if (!token) return true;   // 默认放行，保持现有匿名访问行为
        const bearer = String(req.headers.authorization || '');
        const m = /^Bearer\s+(.+)$/i.exec(bearer);
        return String(query.t || '') === token || (m && m[1] === token);
    }

    function handleStream(req, res, id) {
        if (!cameras.has(id)) {
            sendJson(res, 404, {ok: false, error: 'camera-not-found'});
            return;
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200, {
            'Content-Type': 'multipart/x-mixed-replace; boundary=dxframe',
            'Cache-Control': 'no-store, private',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        });

        function writePart(buffer) {
            if (res.writableEnded || res.destroyed) return;
            const head = Buffer.from('--dxframe\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
                buffer.length + '\r\n\r\n', 'ascii');
            res.write(Buffer.concat([head, buffer, Buffer.from('\r\n', 'ascii')]));
        }

        // 先推一份缓存帧，让画面秒出。
        const cached = cameras.latest(id);
        if (cached) {
            try {
                writePart(cached.buffer);
            } catch (e) {
                RED.log.error('camera-hub: stream write failed: ' + e.message);
            }
        }

        let unsub = cameras.subscribe(id, writePart);
        let cleaned = false;

        function cleanup() {
            if (cleaned) return;
            cleaned = true;
            try {
                if (typeof unsub === 'function') { unsub(); unsub = null; }
            } catch (e) {}
            try {
                if (!res.writableEnded && !res.destroyed) {
                    res.write('--dxframe--\r\n');
                    res.end();
                }
            } catch (e) {}
        }

        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('error', cleanup);
    }

    function handleFrame(req, res, id) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const frame = cameras.latest(id);
        if (!frame) {
            sendJson(res, 404, {ok: false, error: 'camera-not-found'});
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('Content-Length', frame.buffer.length);
        res.end(frame.buffer);
    }

    function readBody(req) {
        return new Promise(function(resolve, reject) {
            const chunks = [];
            let total = 0;
            req.on('data', function(chunk) {
                total += chunk.length;
                if (total > DISCOVER_BODY_LIMIT) {
                    reject(Object.assign(new Error('payload-too-large'), {status: 413}));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
            req.on('error', reject);
        });
    }

    function handleDiscover(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        readBody(req).then(function(text) {
            let body;
            try {
                body = text ? JSON.parse(text) : {};
            } catch (e) {
                sendJson(res, 400, {ok: false, error: 'invalid-json'});
                return;
            }
            const call = body && body.host
                ? cameras.probeDevice(body)
                : cameras.discover(body);
            return call.then(function(list) {
                sendJson(res, 200, {ok: true, cameras: Array.isArray(list) ? list : []});
            });
        }).catch(function(err) {
            if (err && err.status === 413) {
                sendJson(res, 413, {ok: false, error: 'payload-too-large'});
                return;
            }
            sendJson(res, 502, {
                ok: false,
                error: 'discover-failed',
                detail: String(err && (err.message || err))
            });
        });
    }

    const STREAM_FRAME = /^\/api\/cameras\/([^/]+)\/(stream|frame)$/;

    function handler(req, res, next) {
        let pathname;
        let query;
        try {
            const parsed = new URL(req.url || '', 'http://nored.invalid');
            pathname = parsed.pathname;
            query = Object.fromEntries(parsed.searchParams);
        } catch (e) {
            return next();
        }

        const isDiscover = pathname === '/api/cameras/discover';
        const match = STREAM_FRAME.exec(pathname);
        if (!isDiscover && !match) return next();   // 非摄像头路径原样交回 Express

        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
            res.statusCode = 204;
            res.end();
            return;
        }

        if (!authorized(req, query)) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            sendJson(res, 401, {ok: false, error: 'unauthorized'});
            return;
        }

        const id = match ? decodeURIComponent(match[1]) : null;
        const kind = match ? match[2] : 'discover';

        ready.whenReady().then(function() {
            if (kind === 'stream') handleStream(req, res, id);
            else if (kind === 'frame') handleFrame(req, res, id);
            else handleDiscover(req, res);
        }).catch(function(error) {
            sendJson(res, 500, {
                ok: false,
                error: 'schema-init-failed',
                detail: String(error && error.message ? error.message : error)
            });
        });
    }

    RED.httpNode.use(handler);

    function CameraHubNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.on('close', function() {
            cameras.stopAll();
        });
    }

    RED.nodes.registerType('camera-hub', CameraHubNode);
};
