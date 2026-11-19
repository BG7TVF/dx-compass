'use strict';

/**
 * 零依赖 ONVIF 客户端（只用 Node 核心模块）。
 *
 * 为什么手写 SOAP：摄像头在局域网里，ONVIF 是唯一跨品牌的发现/取 profile
 * 协议；不引第三方 XML 库，profile 结构稳定，用轻量正则扫描足够。
 *
 * 安全：任何返回给上层的 URL 都剥掉内嵌 userinfo，账号密码绝不回传前端；
 * 本模块只读，绝不写设备记录。
 */

const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');

const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const PW_DIGEST_TYPE = WSSE_NS + '#PasswordDigest';
const NONCE_ENCODING = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-secext-encodings.xsd#Base64Binary';

function escapeXml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
        h.slice(16, 20) + '-' + h.slice(20);
}

/** WSSE UsernameToken PasswordDigest：nonce 用原始字节参与哈希。 */
function wssePassword(username, password, nonceBase64, created) {
    const nonce = Buffer.from(String(nonceBase64 || crypto.randomBytes(16).toString('base64')), 'base64');
    const createdStr = String(created);
    const digest = crypto.createHash('sha1')
        .update(Buffer.concat([nonce, Buffer.from(createdStr, 'utf8'), Buffer.from(String(password), 'utf8')]))
        .digest('base64');
    return {nonce: nonce, created: createdStr, digest: digest};
}

/** Created 时间戳：去掉毫秒，yyyy-mm-ddThh:mm:ssZ。 */
function createdStamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function securityHeader(username, password) {
    const nonceB64 = crypto.randomBytes(16).toString('base64');
    const created = createdStamp();
    const wsse = wssePassword(username, password, nonceB64, created);
    return '<wsse:Security xmlns:wsse="' + WSSE_NS + '" xmlns:wsu="' + WSU_NS +
        '" s:mustUnderstand="1"><wsse:UsernameToken>' +
        '<wsse:Username>' + escapeXml(username) + '</wsse:Username>' +
        '<wsse:Password Type="' + PW_DIGEST_TYPE + '">' + wsse.digest + '</wsse:Password>' +
        '<wsse:Nonce EncodingType="' + NONCE_ENCODING + '">' + nonceB64 + '</wsse:Nonce>' +
        '<wsu:Created>' + created + '</wsu:Created>' +
        '</wsse:UsernameToken></wsse:Security>';
}

function envelope(toUrl, username, password, bodyXml) {
    return '<?xml version="1.0" encoding="utf-8"?>' +
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
        'xmlns:a="http://www.w3.org/2005/08/addressing" ' +
        'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
        'xmlns:trt="http://www.onvif.org/ver10/media/wsdl">' +
        '<s:Header><a:To s:mustUnderstand="1">' + escapeXml(toUrl) + '</a:To>' +
        securityHeader(username, password) +
        '</s:Header><s:Body>' + bodyXml + '</s:Body></s:Envelope>';
}

const GET_PROFILES_BODY = '<trt:GetProfiles trt:fixed="true"/>';
function snapshotUriBody(token) {
    return '<trt:GetSnapshotUri><trt:ProfileToken>' + escapeXml(token) +
        '</trt:ProfileToken></trt:GetSnapshotUri>';
}

/** 把裸 host/path 按 base 补全成绝对 http URL。 */
function resolveUrl(raw, base) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text) || /^rtsp:\/\//i.test(text)) return text;
    const hostPort = (base && base.host) ?
        (base.host + (base.port && Number(base.port) !== 80 ? ':' + base.port : '')) : '';
    if (text.startsWith('/')) return 'http://' + hostPort + text;
    return 'http://' + (hostPort ? hostPort + '/' : '') + text;
}

/** 剥掉 URL 内嵌 userinfo，账号密码不回传。 */
function stripUserinfo(url) {
    return String(url || '').replace(/^([a-zA-Z]+):\/\/[^/@]*@/, '$1://');
}

/** 从一段 ProbeMatch XML 文本抽出 host/port/xaddrs（去重）。 */
function parseProbeMatch(text) {
    const out = [];
    const seen = new Set();
    const re = /<[\w:.-]*XAddrs[^>]*>([^<]*)</g;
    let m;
    const source = String(text || '');
    while ((m = re.exec(source)) !== null) {
        const urls = m[1].trim().split(/\s+/).filter(Boolean);
        for (const raw of urls) {
            const hp = extractHostPort(raw);
            if (!hp) continue;
            const key = hp.host + ':' + hp.port;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({host: hp.host, port: hp.port, xaddrs: raw});
        }
    }
    return out;
}

function extractHostPort(url) {
    const stripped = String(url || '').replace(/^[a-zA-Z]+:\/\//, '');
    const authority = stripped.split('/')[0];
    if (!authority) return null;
    const at = authority.indexOf('@');
    const hostPart = at >= 0 ? authority.slice(at + 1) : authority;
    const colon = hostPart.lastIndexOf(':');
    let host = hostPart;
    let port = 80;
    if (colon > 0 && /^\d+$/.test(hostPart.slice(colon + 1))) {
        host = hostPart.slice(0, colon);
        port = Number(hostPart.slice(colon + 1));
    }
    if (!host) return null;
    return {host: host, port: port};
}

/** 从 GetProfiles 响应 XML 解析多个 profile（轻量正则，无第三方库）。 */
function parseProfiles(text, base) {
    const source = String(text || '');
    const profiles = [];
    // ONVIF 响应里 profile 元素是 <tt:Profiles>（复数），前缀含冒号；用
    // (?=[\s>]) 卡住标签名边界，避免把外层 <...GetProfilesResponse> 误当 profile。
    const re = /<([\w:.-]*Profile[s]?)(?=[\s>])([^>]*)>([\s\S]*?)<\/[\w:.-]*Profile[s]?>/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        const attrs = m[2];
        const inner = m[3];
        const tokenMatch = /\btoken\s*=\s*"([^"]*)"/.exec(attrs);
        const token = tokenMatch ? tokenMatch[1] : '';
        const nameMatch = /<[\w:.-]*Name[^>]*>([^<]*)</.exec(inner);
        const snapMatch = /<[\w:.-]*SnapshotUri[^>]*>([^<]*)</.exec(inner);
        const streamMatch = /<[\w:.-]*StreamUri[^>]*>[\s\S]*?<[\w:.-]*URI[^>]*>([^<]*)</.exec(inner);
        profiles.push({
            host: base && base.host,
            port: base && base.port,
            token: token,
            name: nameMatch ? nameMatch[1].trim() : '',
            snapshot_url: stripUserinfo(resolveUrl(snapMatch ? snapMatch[1] : '', base)),
            stream_url: stripUserinfo(resolveUrl(streamMatch ? streamMatch[1] : '', base))
        });
    }
    return profiles;
}

function parseSnapshotUri(text, base) {
    const m = /<[\w:.-]*Uri[^>]*>([^<]*)</.exec(String(text || ''));
    return m ? stripUserinfo(resolveUrl(m[1], base)) : '';
}

function postSoap(host, port, path, bodyXml, options) {
    return new Promise(function(resolve, reject) {
        const payload = envelope('http://' + host + (port && port !== 80 ? ':' + port : '') + path,
            options.username, options.password, bodyXml);
        let settled = false;
        let timedOut = false;

        const req = http.request({
            hostname: host,
            port: port || 80,
            path: path,
            method: 'POST',
            timeout: options.timeoutMs || 6000,
            headers: {
                'Content-Type': 'application/soap+xml; charset=utf-8',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, function(res) {
            const chunks = [];
            res.on('data', function(c) { chunks.push(c); });
            res.on('end', function() {
                if (settled) return;
                settled = true;
                const status = res.statusCode;
                const body = Buffer.concat(chunks).toString('utf8');
                if (status >= 200 && status < 300) { resolve(body); return; }
                if (status === 401 || status === 403) { reject(new Error('onvif-unauthorized')); return; }
                if (status === 404) { reject(new Error('onvif-not-found')); return; }
                reject(new Error('onvif-bad-response'));
            });
            res.on('error', function() {
                if (settled) return;
                settled = true;
                reject(new Error('onvif-bad-response'));
            });
        });

        req.setTimeout(options.timeoutMs || 6000, function() {
            if (settled) return;
            timedOut = true;
            req.destroy();
        });
        req.on('error', function() {
            if (settled) return;
            settled = true;
            reject(new Error(timedOut ? 'onvif-timeout' : 'onvif-unreachable'));
        });
        req.write(payload);
        req.end();
    });
}

/** 主动探测（WS-Discovery over UDP）。收到几条算几条，超时/出错都 resolve 数组。 */
function discover(options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 2000;
    const ttl = opts.ttl || 2;
    const found = new Map();

    function collect(message) {
        for (const item of parseProbeMatch(message)) {
            const key = item.host + ':' + item.port;
            if (!found.has(key)) found.set(key, item);
        }
    }

    return new Promise(function(resolve) {
        let socket;
        try {
            socket = dgram.createSocket('udp4');
        } catch (e) {
            resolve([]);
            return;
        }

        function finish() {
            try { socket.close(); } catch (e) {}
            resolve(Array.from(found.values()));
        }

        const probe = '<?xml version="1.0" encoding="utf-8"?>' +
            '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
            'xmlns:a="http://www.w3.org/2005/08/addressing" ' +
            'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ' +
            'xmlns:dn="http://www.onvif.org/ver10/network/wsdl" ' +
            'xmlns:td="http://schemas.xmlsoap.org/ws/2005/10/device/typ">' +
            '<s:Header>' +
            '<a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>' +
            '<a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>' +
            '<a:MessageID>urn:uuid:' + uuid() + '</a:MessageID>' +
            '<a:ReplyTo><a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address></a:ReplyTo>' +
            '</s:Header>' +
            '<s:Body><d:Probe><d:Matches d:Name="NetworkVideoTransmitter"/>' +
            '<Types xmlns:dn="http://www.onvif.org/ver10/network/wsdl" ' +
            'xmlns:td="http://schemas.xmlsoap.org/ws/2005/10/device/typ">dn:NetworkVideoTransmitter td:sdpdevice</Types>' +
            '</d:Probe></s:Body></s:Envelope>';

        socket.on('message', function(msg) {
            collect(msg.toString('utf8'));
        });
        socket.on('error', function() {
            finish();
        });

        const timer = setTimeout(finish, timeoutMs);
        timer.unref();

        socket.bind(0, function() {
            try {
                socket.setBroadcast(true);
                if (typeof socket.setMulticastTTL === 'function') socket.setMulticastTTL(ttl);
                const buf = Buffer.from(probe, 'utf8');
                socket.send(buf, 0, buf.length, 3702, '239.255.255.255', function(err) {
                    if (err) { clearTimeout(timer); finish(); }
                });
            } catch (e) {
                clearTimeout(timer);
                finish();
            }
        });
    });
}

/** 连到某台设备取 profile 列表（先 media_service，404 再 Media）。 */
function probeDevice(options) {
    const opts = options || {};
    const host = opts.host;
    const port = opts.port || 80;
    const timeoutMs = opts.timeoutMs || 6000;
    if (!host) return Promise.reject(new Error('onvif-missing-host'));
    const base = {host: host, port: port};
    const paths = ['/onvif/media_service', '/onvif/Media'];
    const auth = {username: opts.username, password: opts.password, timeoutMs: timeoutMs};

    let lastError = null;
    function tryPath(index) {
        if (index >= paths.length) {
            return Promise.reject(lastError || new Error('onvif-bad-response'));
        }
        return postSoap(host, port, paths[index], GET_PROFILES_BODY, auth)
            .then(function(xml) {
                const profiles = parseProfiles(xml, base);
                if (profiles.length === 0) {
                    // 拿到响应但没解析到 profile：视为坏响应，继续尝试下一路径。
                    throw new Error('onvif-not-found');
                }
                return fillMissingSnapshots(profiles, paths[index], auth, base);
            })
            .catch(function(err) {
                lastError = err;
                // 认证失败直接上报，不再换路径；其它错误尝试下一个路径。
                if (err && err.message === 'onvif-unauthorized') throw err;
                return tryPath(index + 1);
            });
    }

    return tryPath(0);
}

function fillMissingSnapshots(profiles, path, auth, base) {
    // 缺 SnapshotUri 的 profile 单独补一次 GetSnapshotUri，拿不到留空字符串。
    const chain = profiles.reduce(function(promise, profile) {
        return promise.then(function() {
            if (profile.snapshot_url || !profile.token) return;
            return postSoap(base.host, base.port, path, snapshotUriBody(profile.token), auth)
                .then(function(xml) { profile.snapshot_url = parseSnapshotUri(xml, base); })
                .catch(function() { profile.snapshot_url = ''; });
        });
    }, Promise.resolve());
    return chain.then(function() { return profiles; });
}

module.exports = {
    discover: discover,
    probeDevice: probeDevice,
    wssePassword: wssePassword,
    // 纯解析函数导出，便于录制样本单测
    parseProbeMatch: parseProbeMatch,
    parseProfiles: parseProfiles,
    parseSnapshotUri: parseSnapshotUri,
    stripUserinfo: stripUserinfo,
    resolveUrl: resolveUrl
};
