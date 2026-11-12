'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {server, READ_API, STATIC} = require('../bigscreen/server.js');

const ROOT = path.join(__dirname, '..');
const MODULE_PATHS = [
    '/main.mjs',
    '/wall-page.mjs',
    '/wall-map.mjs',
    '/wall-cards.mjs',
    '/wall-charts.mjs',
    '/wall-i18n.mjs',
    '/shared/opponents/opponents.mjs',
    '/js/i18n.js',
    '/shared/core/clock.mjs',
    '/shared/core/events.mjs',
    '/shared/core/transport.mjs',
    '/shared/data/settings.mjs',
    '/shared/data/propagation.mjs',
    '/shared/data/spots.mjs',
    '/shared/data/qsos.mjs',
    '/shared/data/station.mjs',
    '/shared/data/callsigns.mjs',
    '/shared/geo/coordinates.mjs',
    '/shared/geo/great-circle.mjs',
    '/shared/geo/maidenhead.mjs',
    '/shared/map/leaflet.mjs',
    '/shared/map/base-map.mjs',
    '/shared/map/layers.mjs',
    '/shared/map/borders.mjs',
    '/shared/map/surface.mjs',
    '/shared/map/markers.mjs',
    '/shared/map/terminator.mjs',
    '/shared/map/data/land.js',
    '/shared/monitoring/poller.mjs',
    '/shared/propagation/forecast-view.mjs'
];

let port;

test.before(async () => {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
});

function request(method, requestPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path: requestPath,
            headers: {connection: 'close'}
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks)
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('wall serves every local browser module with JavaScript MIME', async t => {
    for (const modulePath of MODULE_PATHS) {
        await t.test(modulePath, async () => {
            assert.ok(STATIC[modulePath], `${modulePath} must be individually whitelisted`);
            const response = await request('GET', modulePath);
            assert.equal(response.status, 200);
            assert.match(response.headers['content-type'], /^application\/javascript;\s*charset=utf-8$/);
            assert.ok(response.body.length > 0);
        });
    }
});

test('wall keeps only the six read API routes', () => {
    assert.deepEqual([...READ_API].sort(), [
        '/api/callsigns',
        '/api/prop',
        '/api/qsos',
        '/api/settings',
        '/api/spots',
        '/api/station/state'
    ].sort());
});

test('wall exposes only an asset fingerprint so a stale tab can reload', async () => {
    const first = await request('GET', '/wall-build.json');
    assert.equal(first.status, 200);
    assert.match(first.headers['content-type'], /^application\/json;\s*charset=utf-8$/);
    assert.equal(first.headers['cache-control'], 'no-store');
    const body = JSON.parse(first.body.toString());
    assert.match(body.build, /^[0-9a-f]{16}$/);
    /* Stable between requests and across the five second cache. */
    const second = await request('GET', '/wall-build.json');
    assert.equal(JSON.parse(second.body.toString()).build, body.build);

    const head = await request('HEAD', '/wall-build.json');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
});

test('existing data and vendor whitelist entries remain exact', () => {
    for (const route of [
        '/shared/opponents/opponents.css',
        '/shared/map/data/land.js',
        '/vendor/leaflet/leaflet.css',
        '/vendor/leaflet/leaflet.js',
        '/vendor/leaflet/images/layers.png',
        '/vendor/leaflet/images/layers-2x.png',
        '/vendor/leaflet/images/marker-icon.png',
        '/vendor/leaflet/images/marker-icon-2x.png',
        '/vendor/leaflet/images/marker-shadow.png'
    ]) {
        assert.ok(STATIC[route], `${route} must remain whitelisted`);
    }
});

test('non-whitelist files and API writes return 404 before proxying', async () => {
    for (const requestPath of [
        '/bigscreen.js',
        '/shared/monitoring/client.mjs',
        '/shared/map/projection.mjs',
        '/shared/core/',
        '/api/settings/save',
        '/api/spots/clear'
    ]) {
        const response = await request('GET', requestPath);
        assert.equal(response.status, 404, requestPath);
    }
});

test('POST and other write methods receive 405 for API and static paths', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const requestPath of ['/api/settings', '/main.mjs']) {
            const response = await request(method, requestPath);
            assert.equal(response.status, 405, `${method} ${requestPath}`);
            assert.equal(response.headers.allow, 'GET, HEAD');
        }
    }
});

test('HEAD returns headers and content length without a response body', async () => {
    for (const requestPath of ['/main.mjs', '/shared/propagation/forecast-view.mjs']) {
        const response = await request('HEAD', requestPath);
        assert.equal(response.status, 200, requestPath);
        assert.equal(response.body.length, 0, requestPath);
        const relative = requestPath === '/main.mjs'
            ? path.join('public', 'bigscreen', 'main.mjs')
            : path.join('public', 'shared', 'propagation', 'forecast-view.mjs');
        assert.equal(Number(response.headers['content-length']),
            fs.statSync(path.join(ROOT, relative)).size, requestPath);
    }
    const missing = await request('HEAD', '/not-whitelisted.mjs');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.length, 0);
});

test('index has one module entry and no legacy script', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'bigscreen', 'index.html'), 'utf8');
    assert.match(html, /<script\s+type="module"\s+src="main\.mjs"><\/script>/);
    assert.doesNotMatch(html, /src="bigscreen\.js"/);
});
