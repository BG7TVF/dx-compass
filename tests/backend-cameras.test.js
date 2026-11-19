'use strict';

// backend-cameras.test.js — 摄像头后端模块单测（node:test 运行器，不依赖 Node-RED）。
// 重要约束：绝不真连摄像头、绝不 spawn ffmpeg（hub 用注入的假 ingest 工厂）。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const net = require('../lib/cameras/net.js');
const hub = require('../lib/cameras/hub.js');
const ingestSnapshot = require('../lib/cameras/ingest-snapshot.js');
const ingestRtsp = require('../lib/cameras/ingest-rtsp.js');
const onvif = require('../lib/cameras/onvif.js');

const JPEG = Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    Buffer.from('fake-jpeg-body'),
    Buffer.from([0xFF, 0xD9])
]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({server, port: server.address().port});
        });
    });
}

async function closeServer(server) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

function collectResponse(url, options) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, options || {}, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

function postRaw(port, path, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers: {'Content-Type': 'application/json'}
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

// =====================================================================
// net.fetchBinary — Basic / Digest / content-type / 状态码 / 大小 / 超时
// =====================================================================

test('fetchBinary: Basic 认证成功取回 JPEG', async () => {
    const expected = 'Basic ' + Buffer.from('u:p', 'utf8').toString('base64');
    const {server, port} = await listen((req, res) => {
        if (req.headers.authorization === expected) {
            res.writeHead(200, {'Content-Type': 'image/jpeg'});
            res.end(JPEG);
        } else {
            res.writeHead(401, {'WWW-Authenticate': 'Basic realm="cam"'});
            res.end();
        }
    });
    try {
        const buffer = await net.fetchBinary('http://127.0.0.1:' + port + '/jpg', {username: 'u', password: 'p'});
        assert.deepEqual(buffer, JPEG);
    } finally {
        await closeServer(server);
    }
});

test('fetchBinary: 401 Digest 挑战后重算摘要只重试一次', async () => {
    const realm = 'cam';
    const nonce = 'xyz';
    const opaque = 'op';
    let hits = 0;
    const {server, port} = await listen((req, res) => {
        hits += 1;
        const auth = String(req.headers.authorization || '');
        if (auth.startsWith('Digest')) {
            const fields = {};
            // qop/nc/algorithm 是不带引号的 token，其余是带引号字符串。
            const re = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]+)/g;
            let m;
            while ((m = re.exec(auth)) !== null) {
                fields[m[1]] = m[2].replace(/^"|"$/g, '');
            }
            const ha1 = crypto.createHash('md5').update('u:' + realm + ':p').digest('hex');
            const ha2 = crypto.createHash('md5').update('GET:' + fields.uri).digest('hex');
            const expect = crypto.createHash('md5')
                .update([ha1, nonce, fields.nc, fields.cnonce, fields.qop, ha2].join(':')).digest('hex');
            if (expect === fields.response) {
                res.writeHead(200, {'Content-Type': 'image/jpeg'});
                res.end(JPEG);
                return;
            }
        }
        res.writeHead(401, {
            'WWW-Authenticate': 'Digest realm="' + realm + '", nonce="' + nonce +
                '", qop="auth", algorithm=MD5, opaque="' + opaque + '"'
        });
        res.end();
    });
    try {
        const buffer = await net.fetchBinary('http://127.0.0.1:' + port + '/snap', {username: 'u', password: 'p'});
        assert.deepEqual(buffer, JPEG);
        assert.equal(hits, 2);
    } finally {
        await closeServer(server);
    }
});

test('fetchBinary: content-type 不是图片时 reject bad-content-type', async () => {
    const {server, port} = await listen((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<html>not an image</html>');
    });
    try {
        await assert.rejects(() => net.fetchBinary('http://127.0.0.1:' + port + '/jpg', {}),
            /bad-content-type/);
    } finally {
        await closeServer(server);
    }
});

test('fetchBinary: 非 2xx 用 http-<status> 短码 reject', async () => {
    const {server, port} = await listen((req, res) => {
        res.writeHead(500);
        res.end('boom');
    });
    try {
        await assert.rejects(() => net.fetchBinary('http://127.0.0.1:' + port + '/jpg', {}),
            /http-500/);
    } finally {
        await closeServer(server);
    }
});

test('fetchBinary: 超过 4MB 立即 reject payload-too-large', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
    const {server, port} = await listen((req, res) => {
        res.writeHead(200, {'Content-Type': 'image/jpeg'});
        res.end(big);
    });
    try {
        await assert.rejects(() => net.fetchBinary('http://127.0.0.1:' + port + '/jpg', {}),
            /payload-too-large/);
    } finally {
        await closeServer(server);
    }
});

test('fetchBinary: 服务器不响应时超时掐断为 timeout', async () => {
    const {server, port} = await listen(() => {
        /* 故意不响应 */
    });
    try {
        await assert.rejects(() => net.fetchBinary('http://127.0.0.1:' + port + '/jpg', {timeoutMs: 120}),
            /timeout/);
    } finally {
        await closeServer(server);
    }
});

// =====================================================================
// ingest-snapshot：轮询并 publish
// =====================================================================

test('ingest-snapshot: 轮询调用 publish 且 stop 幂等停发', async () => {
    const {server, port} = await listen((req, res) => {
        res.writeHead(200, {'Content-Type': 'image/jpeg'});
        res.end(JPEG);
    });
    try {
        const published = [];
        const ctx = {
            cfg: {id: 'snap1', host: '127.0.0.1', port, protocol: 'snapshot', fps: 5,
                snapshot_url: 'http://127.0.0.1:' + port + '/snap', username: '', password: ''},
            publish: (b) => published.push(b),
            note: () => {}
        };
        const stop = ingestSnapshot.start(ctx);
        const deadline = Date.now() + 1500;
        while (published.length === 0 && Date.now() < deadline) await sleep(20);
        assert.ok(published.length >= 1, '应在截止前取到至少一帧');
        assert.deepEqual(published[0], JPEG);

        stop();
        stop(); // 幂等
        const after = published.length;
        await sleep(400);
        assert.equal(published.length, after, 'stop 后不应继续 publish');
    } finally {
        await closeServer(server);
    }
});

// =====================================================================
// hub：sync 幂等 / 指纹重建 / 移除即停 / 引用计数 / 帧率闸门
// =====================================================================

function makeFakeFactories() {
    const log = {snapshotStart: 0, snapshotStop: 0, rtspStart: 0, rtspStop: 0};
    return {
        log,
        factories: {
            snapshot() {
                log.snapshotStart += 1;
                return () => { log.snapshotStop += 1; };
            },
            rtsp() {
                log.rtspStart += 1;
                return () => { log.rtspStop += 1; };
            }
        }
    };
}

function cameraEntry(id, extra) {
    return Object.assign({id: id, type: 'camera', name: id,
        config: Object.assign({host: '10.0.0.1', protocol: 'snapshot', username: 'u', password: 'p', fps: 5}, extra || {})}, {});
}

test('hub.sync: 同输入幂等、改指纹重建、移除即停', async () => {
    hub.stopAll();
    const fake = makeFakeFactories();
    hub.configure({idleStopMs: 60, factories: fake.factories});

    const list = [cameraEntry('cam-A')];
    assert.equal(hub.sync(list), 1);
    let entry = hub.list().find((e) => e.id === 'cam-A');
    assert.equal(entry.ingesting, false, 'sync 不启动摄取（懒启动）');

    const unsub = hub.subscribe('cam-A', () => {});
    assert.equal(fake.log.snapshotStart, 1);
    entry = hub.list().find((e) => e.id === 'cam-A');
    assert.equal(entry.ingesting, true);
    assert.equal(entry.gen, 1);

    // 同输入：不重启任务
    assert.equal(hub.sync(list), 1);
    assert.equal(fake.log.snapshotStart, 1, '同指纹不应重启');
    assert.equal(hub.list().find((e) => e.id === 'cam-A').gen, 1);

    // 改指纹：重建（停旧起新）
    hub.sync([cameraEntry('cam-A', {fps: 3})]);
    assert.equal(fake.log.snapshotStart, 2);
    assert.equal(fake.log.snapshotStop, 1);
    assert.equal(hub.list().find((e) => e.id === 'cam-A').gen, 2);

    unsub();
    hub.stopAll();
});

test('hub.sync: 列表移除的 id 即停，订阅者也不再收帧', async () => {
    hub.stopAll();
    const fake = makeFakeFactories();
    hub.configure({idleStopMs: 60, factories: fake.factories});

    hub.sync([cameraEntry('cam-B')]);
    let got = 0;
    const unsub = hub.subscribe('cam-B', () => { got += 1; });
    assert.equal(hub.has('cam-B'), true);

    hub.sync([]); // 移除
    assert.equal(hub.has('cam-B'), false);
    assert.equal(hub.stats('cam-B'), null);
    assert.equal(fake.log.snapshotStop, 1, '移除应停摄取');

    hub.publish('cam-B', JPEG); // 已不登记，无效
    await sleep(20);
    assert.equal(got, 0, '已删除的摄像头不发帧');
    unsub();
});

test('hub.subscribe: 引用计数 0→1→2→0 后等 IDLE_STOP 才停，窗口内重订阅取消定时器', async () => {
    hub.stopAll();
    const fake = makeFakeFactories();
    hub.configure({idleStopMs: 80, factories: fake.factories});

    hub.sync([cameraEntry('cam-C')]);
    const a = hub.subscribe('cam-C', () => {});
    const b = hub.subscribe('cam-C', () => {});
    assert.equal(fake.log.snapshotStart, 1, '第二个订阅者不应再起');

    a(); // 还剩一个，不停
    assert.equal(hub.list().find((e) => e.id === 'cam-C').ingesting, true);

    b(); // 归零 → 调度 idle 定时器（尚未停）
    assert.equal(fake.log.snapshotStop, 0);
    assert.equal(hub.list().find((e) => e.id === 'cam-C').ingesting, true);

    const c = hub.subscribe('cam-C', () => {}); // 窗口内重新订阅 → 取消定时器
    assert.equal(fake.log.snapshotStart, 1, '重订阅复用既存任务');
    await sleep(120);
    assert.equal(fake.log.snapshotStop, 0, '定时器已被取消');

    c(); // 再次归零
    await sleep(160);
    assert.equal(fake.log.snapshotStop, 1, 'idle 窗口过后才停');
    assert.equal(hub.list().find((e) => e.id === 'cam-C').ingesting, false);
});

test('hub.publish: 帧率闸门丢弃过快帧但 latest 始终保留最新', async () => {
    hub.stopAll();
    const fake = makeFakeFactories();
    hub.configure({idleStopMs: 60, factories: fake.factories});

    hub.sync([cameraEntry('cam-D', {fps: 2})]); // minInterval 500ms
    const delivered = [];
    const unsub = hub.subscribe('cam-D', (buf) => delivered.push(buf));

    const f1 = Buffer.from('frame-1');
    const f2 = Buffer.from('frame-2');
    const f3 = Buffer.from('frame-3');
    hub.publish('cam-D', f1);
    hub.publish('cam-D', f2);
    hub.publish('cam-D', f3);

    assert.equal(delivered.length, 1, '500ms 内的过快帧被丢弃');
    assert.deepEqual(delivered[0], f1);
    assert.deepEqual(hub.latest('cam-D').buffer, f3, '被丢弃的帧也要覆盖 latest');
    unsub();
    hub.stopAll();
});

test('hub: rtsp 协议走 ingest-rtsp，快照协议走 ingest-snapshot', async () => {
    hub.stopAll();
    const fake = makeFakeFactories();
    hub.configure({idleStopMs: 60, factories: fake.factories});

    hub.sync([cameraEntry('cam-rt', {protocol: 'rtsp', stream_url: 'rtsp://10.0.0.2:554/1'})]);
    const un1 = hub.subscribe('cam-rt', () => {});
    assert.equal(fake.log.rtspStart, 1);

    hub.sync([cameraEntry('cam-snap', {protocol: 'snapshot'})]);
    const un2 = hub.subscribe('cam-snap', () => {});
    assert.equal(fake.log.snapshotStart, 1);

    un1();
    un2();
    hub.stopAll();
});

// =====================================================================
// ingest-rtsp：URL userinfo 注入纯函数
// =====================================================================

test('ingest-rtsp: userinfo 注入与不重复注入', () => {
    assert.equal(
        ingestRtsp._injectUserInfo('rtsp://10.0.0.1:554/stream', 'a b', 'p/x'),
        'rtsp://a%20b:p%2Fx@10.0.0.1:554/stream');
    // 已带 userinfo 不重复注入
    assert.equal(
        ingestRtsp._injectUserInfo('rtsp://u:p@10.0.0.1:554/stream', 'a', 'b'),
        'rtsp://u:p@10.0.0.1:554/stream');
});

// =====================================================================
// onvif：WSSE 固定向量 + 纯解析函数 + probeDevice（本地假 SOAP 服务器）
// =====================================================================

test('onvif.wssePassword: 用原始 nonce 字节做 SHA1（非 base64 文本）', () => {
    const nonceB64 = crypto.randomBytes(16).toString('base64');
    const created = '2024-01-01T00:00:00Z';
    const password = 'secret';
    const result = onvif.wssePassword('admin', password, nonceB64, created);

    const raw = Buffer.from(nonceB64, 'base64');
    assert.ok(Buffer.isBuffer(result.nonce));
    assert.deepEqual(result.nonce, raw);

    const expected = crypto.createHash('sha1')
        .update(Buffer.concat([raw, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
        .digest('base64');
    assert.equal(result.digest, expected);

    // 反例：用 base64 文本参与哈希会得到不同结果，证明实现用的是原始字节
    const wrong = crypto.createHash('sha1')
        .update(Buffer.concat([Buffer.from(nonceB64, 'utf8'), Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
        .digest('base64');
    assert.notEqual(result.digest, wrong);
});

test('onvif.parseProbeMatch: 从录制样本抽出 host/port 并去重', () => {
    const xml = '<s:Envelope><s:Body><d:ProbeMatches>' +
        '<d:ProbeMatch><d:XAddrs>http://10.0.0.5:8080/onvif/device_service</d:XAddrs></d:ProbeMatch>' +
        '<d:ProbeMatch><d:XAddrs>http://10.0.0.6/onvif/device_service</d:XAddrs></d:ProbeMatch>' +
        '<d:ProbeMatch><d:XAddrs>http://10.0.0.5:8080/onvif/media</d:XAddrs></d:ProbeMatch>' +
        '</d:ProbeMatches></s:Body></s:Envelope>';
    const list = onvif.parseProbeMatch(xml);
    assert.deepEqual(list.map((x) => x.host + ':' + x.port),
        ['10.0.0.5:8080', '10.0.0.6:80']);
});

test('onvif.parseProfiles: 解析多 profile、补全裸 host、剥掉 userinfo', () => {
    const xml = '<s:Envelope><s:Body><tds:GetProfilesResponse xmlns:tds="http://www.onvif.org/ver10/media/wsdl">' +
        '<tt:Profiles token="P1" xmlns:tt="http://www.onvif.org/ver10/schema">' +
        '<tt:Name>Cam One</tt:Name>' +
        '<tt:SnapshotUri>http://admin:pass@192.168.0.10:8080/snap.jpg</tt:SnapshotUri>' +
        '<tt:StreamUri><tt:URI>rtsp://admin:pass@192.168.0.10:554/stream1</tt:URI></tt:StreamUri>' +
        '</tt:Profiles>' +
        '<tt:Profiles token="P2" xmlns:tt="http://www.onvif.org/ver10/schema">' +
        '<tt:Name>Cam Two</tt:Name>' +
        '<tt:SnapshotUri>/snap2.jpg</tt:SnapshotUri>' +
        '<tt:StreamUri><tt:URI>rtsp://192.168.0.10:554/stream2</tt:URI></tt:StreamUri>' +
        '</tt:Profiles>' +
        '</tds:GetProfilesResponse></s:Body></s:Envelope>';
    const profiles = onvif.parseProfiles(xml, {host: '192.168.0.10', port: 8080});
    assert.equal(profiles.length, 2);
    assert.equal(profiles[0].token, 'P1');
    assert.equal(profiles[0].name, 'Cam One');
    assert.equal(profiles[0].snapshot_url, 'http://192.168.0.10:8080/snap.jpg');
    assert.equal(profiles[0].stream_url, 'rtsp://192.168.0.10:554/stream1');
    assert.ok(profiles[0].snapshot_url.indexOf('admin:pass@') < 0, '不应含 userinfo');
    assert.equal(profiles[1].snapshot_url, 'http://192.168.0.10:8080/snap2.jpg');
});

test('onvif.probeDevice: POST media_service 带 WSSE，解析并剥 userinfo', async () => {
    const profilesXml = '<s:Envelope><s:Body><tds:GetProfilesResponse>' +
        '<tt:Profiles token="P1"><tt:Name>A</tt:Name>' +
        '<tt:SnapshotUri>http://admin:pw@127.0.0.1/snap</tt:SnapshotUri>' +
        '<tt:StreamUri><tt:URI>rtsp://admin:pw@127.0.0.1:554/s</tt:URI></tt:StreamUri>' +
        '</tt:Profiles></tds:GetProfilesResponse></s:Body></s:Envelope>';
    const captured = {};
    const {server, port} = await listen((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            captured.body = body;
            if (req.url === '/onvif/media_service') {
                res.writeHead(200, {'Content-Type': 'application/soap+xml'});
                res.end(profilesXml);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
    });
    try {
        const profiles = await onvif.probeDevice({host: '127.0.0.1', port, username: 'admin', password: 'pw'});
        assert.equal(profiles.length, 1);
        assert.equal(profiles[0].token, 'P1');
        assert.equal(profiles[0].snapshot_url, 'http://127.0.0.1/snap', '应剥掉 admin:pw@');
        assert.match(captured.body, /GetProfiles/);
        assert.match(captured.body, /wsse:Security/);
        assert.match(captured.body, /PasswordDigest/);
    } finally {
        await closeServer(server);
    }
});

test('onvif.probeDevice: media_service 404 时回退 /onvif/Media', async () => {
    const profilesXml = '<s:Envelope><s:Body><tds:GetProfilesResponse>' +
        '<tt:Profiles token="PX"><tt:Name>X</tt:Name>' +
        '<tt:SnapshotUri>http://127.0.0.1/snap</tt:SnapshotUri>' +
        '<tt:StreamUri><tt:URI>rtsp://127.0.0.1:554/s</tt:URI></tt:StreamUri>' +
        '</tt:Profiles></tds:GetProfilesResponse></s:Body></s:Envelope>';
    const paths = [];
    const {server, port} = await listen((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            paths.push(req.url);
            if (req.url === '/onvif/Media') {
                res.writeHead(200, {'Content-Type': 'application/soap+xml'});
                res.end(profilesXml);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
    });
    try {
        const profiles = await onvif.probeDevice({host: '127.0.0.1', port, username: 'a', password: 'b'});
        assert.equal(profiles.length, 1);
        assert.deepEqual(paths, ['/onvif/media_service', '/onvif/Media']);
    } finally {
        await closeServer(server);
    }
});

// =====================================================================
// HTTP 端点（nodes/camera-hub.js + mock RED + 真临时服务器）
// =====================================================================

test('camera-hub HTTP: /frame 命中、/stream 404、discover 非法 JSON、其它路径 next()', async () => {
    hub.stopAll();
    const fake = makeFakeFactories();
    hub.configure({idleStopMs: 60, factories: fake.factories});

    const ready = require('../lib/ready.js');
    ready.markReady(); // 冷启动门闩放行

    const captured = [];
    const RED = {
        httpNode: {use(fn) { captured.push(fn); }},
        nodes: {createNode() {}, registerType() {}},
        log: {info() {}, error() {}}
    };
    require('../nodes/camera-hub.js')(RED);
    assert.equal(captured.length, 1, '加载阶段就注册中间件');
    const handler = captured[0];

    // 登记一台摄像头并注入一帧（不触发真实摄取）
    hub.sync([cameraEntry('http-cam', {protocol: 'snapshot'})]);
    hub.publish('http-cam', JPEG);

    const {server, port} = await listen((req, res) => {
        handler(req, res, () => { res.writeHead(444); res.end('next'); });
    });
    try {
        const frame = await collectResponse('http://127.0.0.1:' + port + '/api/cameras/http-cam/frame');
        assert.equal(frame.status, 200);
        assert.match(frame.headers['content-type'], /image\/jpeg/);
        assert.deepEqual(frame.body, JPEG);
        assert.equal(frame.headers['access-control-allow-origin'], '*');

        const missing = await collectResponse('http://127.0.0.1:' + port + '/api/cameras/nope/stream');
        assert.equal(missing.status, 404);
        assert.deepEqual(JSON.parse(missing.body.toString()), {ok: false, error: 'camera-not-found'});

        const badJson = await postRaw(port, '/api/cameras/discover', 'this is not json');
        assert.equal(badJson.status, 400);
        assert.deepEqual(JSON.parse(badJson.body.toString()), {ok: false, error: 'invalid-json'});

        const other = await collectResponse('http://127.0.0.1:' + port + '/api/some-other');
        assert.equal(other.status, 444, '非摄像头路径应交回 next()');
    } finally {
        await closeServer(server);
        hub.stopAll();
    }
});
