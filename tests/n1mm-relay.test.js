'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let core;
test.before(async () => {
    core = await import('../scripts/n1mm-relay-core.mjs');
});

test('参数解析：命令行优先，环境变量兜底，自动拼 URL', () => {
    const cli = core.parseArgs(['--host', '1.2.3.4', '--token', 't', '--port', '8080',
        '--udp-port', '12345', '--path', '/ingest'], {});
    assert.equal(cli.url, 'http://1.2.3.4:8080/ingest');
    assert.equal(cli.token, 't');
    assert.equal(cli.udpPort, 12345);
    assert.equal(core.validate(cli), '');

    const env = core.parseArgs([], {DX_N1MM_HOST: 'dx.example', DX_N1MM_TOKEN: 'envtoken',
        DX_N1MM_PROTOCOL: 'https', DX_N1MM_PORT: '443'});
    assert.equal(env.url, 'https://dx.example:443/api/n1mm/ingest');
    assert.equal(env.token, 'envtoken');

    const direct = core.parseArgs(['--url', 'http://x/y', '--token', 't'], {});
    assert.equal(direct.url, 'http://x/y');
});

test('缺少地址或令牌时校验失败', () => {
    assert.match(core.validate({url: '', token: 't'}), /missing/);
    assert.match(core.validate({url: 'http://x', token: ''}), /token/);
    assert.match(core.validate({url: 'ftp://x', token: 't'}), /http/);
    assert.equal(core.validate({help: true}), 'help');
});

test('转发请求带令牌与原始 XML', () => {
    const request = core.buildRequest({url: 'http://s/api', token: 'abc'}, '<contactinfo/>');
    assert.equal(request.url, 'http://s/api');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers['X-DX-Token'], 'abc');
    assert.match(request.init.headers['Content-Type'], /text\/plain/);
    assert.equal(request.init.body, '<contactinfo/>');
});

test('指数退避递增并封顶，抖动限制在 ±20%', () => {
    assert.equal(core.retryDelay(1, 500, 30000, () => 0.5), 500);
    assert.equal(core.retryDelay(2, 500, 30000, () => 0.5), 1000);
    assert.equal(core.retryDelay(10, 500, 30000, () => 0.5), 30000);
    assert.ok(core.retryDelay(1, 500, 30000, () => 0) >= 400);
    assert.ok(core.retryDelay(1, 500, 30000, () => 1) <= 600);
});

test('断线队列有界，丢弃最旧的包并计数', () => {
    const queue = new core.BoundedQueue(2);
    queue.push('a');
    queue.push('b');
    queue.push('c');
    assert.equal(queue.size, 2);
    assert.equal(queue.dropped, 1);
    assert.equal(queue.peek(), 'b');
    assert.equal(queue.pop(), 'b');
    assert.equal(queue.size, 1);
});

test('服务器错误给出可操作的提示', () => {
    assert.match(core.errorMessage(401, ''), /令牌/);
    assert.match(core.errorMessage(503, ''), /n1mmToken/);
    assert.match(core.errorMessage(404, ''), /\/api\/n1mm\/ingest/);
    assert.match(core.errorMessage(500, 'boom'), /500.*boom/);
});

test('帮助文本包含 N1MM 广播设置入口', () => {
    const text = core.helpText();
    assert.match(text, /Configure Ports/);
    assert.match(text, /Broadcast Data/);
    assert.match(text, /12060/);
});
