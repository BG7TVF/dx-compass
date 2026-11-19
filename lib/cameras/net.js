'use strict';

/**
 * 摄像头 HTTP 取流（快照轮询用）。
 *
 * 只用 Node 核心模块，不引任何第三方：摄像头在局域网里，认证方式五花八门
 * （Basic / Digest），而浏览器不应该看到账号密码，所以摄取统一在服务端做。
 *
 * 错误一律用 error.message 承载一个短码（'timeout' / 'http-500' /
 * 'bad-content-type' / 'payload-too-large' / 'conn-error'），方便上层
 * hub.note() 记一条日志而不刷屏。
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const {URL} = require('url');

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function md5(text) {
    return crypto.createHash('md5').update(text).digest('hex');
}

/** 解析 WWW-Authenticate: Digest ... 里的 realm/nonce/qop/opaque/algorithm。 */
function parseDigestChallenge(header) {
    const fields = {};
    const re = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,]+)/g;
    let match;
    while ((match = re.exec(String(header || ''))) !== null) {
        const raw = match[2];
        fields[match[1].toLowerCase()] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    }
    return fields;
}

/** 计算一次 Digest 认证的 Authorization 头值（只支持 qop=auth 与 MD5/MD5-sess）。 */
function digestHeader(challenge, options) {
    const algorithm = (challenge.algorithm || 'MD5');
    const nonce = challenge.nonce || '';
    const realm = challenge.realm || '';
    const opaque = challenge.opaque;
    // qop 服务器可能给 "auth,auth-int"，我们只用 auth。
    const qop = String(challenge.qop || '').split(',').map(s => s.trim()).includes('auth') ? 'auth' : '';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = '00000001';
    const uri = options.uri;

    let ha1 = md5(options.username + ':' + realm + ':' + options.password);
    if (/^MD5-sess$/i.test(algorithm)) {
        // RFC 2617: H(A1) = HEX(MD5(UPPERCASE(H(A1)):cnonce:authNonce))
        ha1 = md5(ha1.toUpperCase() + ':' + cnonce + ':' + nonce);
    }
    const ha2 = md5('GET:' + uri);
    const response = qop
        ? md5(ha1 + ':' + nonce + ':' + nc + ':' + cnonce + ':' + qop + ':' + ha2)
        : md5(ha1 + ':' + nonce + ':' + ha2);

    const parts = [
        'Digest username="' + options.username + '"',
        'realm="' + realm + '"',
        'nonce="' + nonce + '"',
        'uri="' + uri + '"',
        'algorithm=' + algorithm,
        'response="' + response + '"'
    ];
    if (qop) parts.push('qop=' + qop, 'nc=' + nc, 'cnonce="' + cnonce + '"');
    if (opaque) parts.push('opaque="' + opaque + '"');
    return parts.join(', ');
}

/**
 * 执行一次 GET，返回 {statusCode, headers, body}。
 * 2xx 之外的状态码不 reject（交由调用方判断是否要 Digest 重试）；
 * 只在超时、连接错误、payload 超限时 reject 一个短码 Error。
 */
function requestOnce(parsed, lib, headers, timeoutMs) {
    return new Promise(function(resolve, reject) {
        let settled = false;
        let timedOut = false;
        const chunks = [];
        let total = 0;

        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (lib === https ? 443 : 80),
            path: (parsed.pathname || '/') + (parsed.search || ''),
            method: 'GET',
            headers: headers,
            timeout: timeoutMs
        }, function(res) {
            res.on('data', function(chunk) {
                if (settled) return;
                total += chunk.length;
                if (total > MAX_BODY_BYTES) {
                    settled = true;
                    res.destroy();
                    req.destroy();
                    reject(new Error('payload-too-large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', function() {
                if (settled) return;
                settled = true;
                resolve({statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)});
            });
            res.on('error', function() {
                if (settled) return;
                settled = true;
                reject(new Error('conn-error'));
            });
        });

        req.setTimeout(timeoutMs, function() {
            if (settled) return;
            timedOut = true;
            req.destroy();
        });

        req.on('error', function() {
            if (settled) return;
            settled = true;
            reject(new Error(timedOut ? 'timeout' : 'conn-error'));
        });

        req.end();
    });
}

function basicHeader(username, password) {
    const token = Buffer.from(String(username) + ':' + String(password), 'utf8').toString('base64');
    return 'Basic ' + token;
}

/**
 * 拉取一个二进制快照。
 * options: {username, password, timeoutMs=5000}
 */
function fetchBinary(url, options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 5000;
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return Promise.reject(new Error('bad-url'));
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers = {Accept: 'image/jpeg, image/*;q=0.8, */*;q=0.5'};
    if (opts.username) {
        headers.Authorization = basicHeader(opts.username, opts.password || '');
    }

    function check(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
            return Promise.reject(new Error('http-' + response.statusCode));
        }
        const type = String(response.headers['content-type'] || '');
        if (!/jpeg|jpg|image/i.test(type)) {
            return Promise.reject(new Error('bad-content-type'));
        }
        return Promise.resolve(response.body);
    }

    return requestOnce(parsed, lib, headers, timeoutMs).then(function(response) {
        const challenge = response.headers['www-authenticate'];
        // 401 + Digest 挑战：算一次摘要，只重发一次。
        if (response.statusCode === 401 && opts.username &&
            challenge && /digest/i.test(challenge)) {
            const parsedChallenge = parseDigestChallenge(challenge);
            const uri = (parsed.pathname || '/') + (parsed.search || '');
            const retryHeaders = Object.assign({}, headers, {
                Authorization: digestHeader(parsedChallenge, {
                    username: opts.username,
                    password: opts.password || '',
                    uri: uri
                })
            });
            return requestOnce(parsed, lib, retryHeaders, timeoutMs).then(check);
        }
        return check(response);
    });
}

module.exports = {
    fetchBinary: fetchBinary,
    // 导出便于单测摘要算法本身
    _parseDigestChallenge: parseDigestChallenge,
    _digestHeader: digestHeader,
    MAX_BODY_BYTES: MAX_BODY_BYTES
};
