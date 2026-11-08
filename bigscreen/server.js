'use strict';

/**
 * DX-Compass - read-only wall display server.
 *
 * Serves public/bigscreen/ on port 5859 (BIGSCREEN_PORT) and proxies a short
 * whitelist of GET requests to the running Node-RED dashboard
 * (BIGSCREEN_UPSTREAM, default http://127.0.0.1:5758).
 *
 * The wall screen is a viewer, never a console:
 *   - only GET/HEAD are accepted, every other method is answered 405;
 *   - only the six read endpoints below are proxied, everything else 404s
 *     here instead of reaching Node-RED;
 *   - only explicitly whitelisted static files are served, so no path can
 *     escape their configured roots;
 *   - nothing writes to the database, the flow or the global context.
 *
 * Start it next to Node-RED:
 *     node bigscreen/server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.BIGSCREEN_PORT || 5859);
const UPSTREAM = new URL(process.env.BIGSCREEN_UPSTREAM || 'http://127.0.0.1:5758');
const ROOT = path.join(__dirname, '..', 'public', 'bigscreen');
const UPSTREAM_TIMEOUT = 30 * 1000;

/* Read-only endpoints the wall screen is allowed to see. Anything else --
 * settings saves, spot clearing, monitoring toggles, resets -- is refused. */
const READ_API = new Set([
    '/api/prop',
    '/api/spots',
    '/api/qsos',
    '/api/station/state',
    '/api/settings',
    '/api/callsigns'
]);

/* Static whitelist: name -> [file, content type, base]. "data" points at the
 * shared land/border outlines the propagation page also draws from, "leaflet"
 * at the vendored Leaflet build (served locally so the wall never depends on
 * an external CDN). No directory walking anywhere. */
const JS = 'application/javascript; charset=utf-8';
const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/bigscreen.css': ['bigscreen.css', 'text/css; charset=utf-8'],
    '/main.mjs': ['main.mjs', JS],
    '/wall-page.mjs': ['wall-page.mjs', JS],
    '/wall-map.mjs': ['wall-map.mjs', JS],
    '/wall-cards.mjs': ['wall-cards.mjs', JS],
    '/wall-charts.mjs': ['wall-charts.mjs', JS],
    '/wall-opponents.mjs': ['wall-opponents.mjs', JS],
    '/shared/core/clock.mjs': ['core/clock.mjs', JS, 'shared'],
    '/shared/core/events.mjs': ['core/events.mjs', JS, 'shared'],
    '/shared/core/transport.mjs': ['core/transport.mjs', JS, 'shared'],
    '/shared/data/settings.mjs': ['data/settings.mjs', JS, 'shared'],
    '/shared/data/propagation.mjs': ['data/propagation.mjs', JS, 'shared'],
    '/shared/data/spots.mjs': ['data/spots.mjs', JS, 'shared'],
    '/shared/data/qsos.mjs': ['data/qsos.mjs', JS, 'shared'],
    '/shared/data/station.mjs': ['data/station.mjs', JS, 'shared'],
    '/shared/geo/coordinates.mjs': ['geo/coordinates.mjs', JS, 'shared'],
    '/shared/geo/great-circle.mjs': ['geo/great-circle.mjs', JS, 'shared'],
    '/shared/geo/maidenhead.mjs': ['geo/maidenhead.mjs', JS, 'shared'],
    '/shared/map/leaflet.mjs': ['map/leaflet.mjs', JS, 'shared'],
    '/shared/map/base-map.mjs': ['map/base-map.mjs', JS, 'shared'],
    '/shared/map/layers.mjs': ['map/layers.mjs', JS, 'shared'],
    '/shared/map/terminator.mjs': ['map/terminator.mjs', JS, 'shared'],
    '/shared/monitoring/poller.mjs': ['monitoring/poller.mjs', JS, 'shared'],
    '/shared/propagation/forecast-view.mjs': ['propagation/forecast-view.mjs', JS, 'shared'],
    '/data/land.js': ['land.js', 'application/javascript; charset=utf-8', 'data'],
    '/data/borders.js': ['borders.js', 'application/javascript; charset=utf-8', 'data'],
    '/vendor/leaflet/leaflet.css': ['leaflet.css', 'text/css; charset=utf-8', 'leaflet'],
    '/vendor/leaflet/leaflet.js': ['leaflet.js', 'application/javascript; charset=utf-8', 'leaflet'],
    '/vendor/leaflet/images/layers.png': ['layers.png', 'image/png', 'leaflet-img'],
    '/vendor/leaflet/images/layers-2x.png': ['layers-2x.png', 'image/png', 'leaflet-img'],
    '/vendor/leaflet/images/marker-icon.png': ['marker-icon.png', 'image/png', 'leaflet-img'],
    '/vendor/leaflet/images/marker-icon-2x.png': ['marker-icon-2x.png', 'image/png', 'leaflet-img'],
    '/vendor/leaflet/images/marker-shadow.png': ['marker-shadow.png', 'image/png', 'leaflet-img']
};

const BASES = {
    leaflet: path.join(ROOT, '..', 'vendor', 'leaflet'),
    'leaflet-img': path.join(ROOT, '..', 'vendor', 'leaflet', 'images'),
    data: path.join(ROOT, '..', 'data'),
    shared: path.join(ROOT, '..', 'shared')
};

function log(req, status) {
    const t = new Date().toISOString().slice(11, 19);
    console.log(t + ' ' + status + ' ' + req.method + ' ' + req.url);
}

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    res.end(text);
}

function sendStatic(req, res, meta) {
    const [name, type, base] = meta;
    const dir = base ? BASES[base] : ROOT;
    fs.readFile(path.join(dir, name), (err, buf) => {
        if (err) {
            log(req, 500);
            sendJson(res, 500, {error: 'cannot read ' + name});
            return;
        }
        res.writeHead(200, {
            'content-type': type,
            'cache-control': 'no-cache',
            'content-length': buf.length
        });
        log(req, 200);
        res.end(req.method === 'HEAD' ? undefined : buf);
    });
}

/* Forward the query string untouched: /api/spots?limit=300 keeps working. */
function proxy(req, res, url) {
    const target = new URL(url.pathname + url.search, UPSTREAM);
    const up = http.request(target, {
        method: 'GET',
        headers: {accept: 'application/json'},
        timeout: UPSTREAM_TIMEOUT
    }, r => {
        res.writeHead(r.statusCode || 502, {
            'content-type': r.headers['content-type'] || 'application/json; charset=utf-8',
            'cache-control': 'no-store'
        });
        log(req, r.statusCode || 502);
        if (req.method === 'HEAD') {
            r.resume();
            res.end();
        } else {
            r.pipe(res);
        }
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, {error: 'upstream unavailable'});
        else res.destroy();
    });
    up.end();
}

const server = http.createServer((req, res) => {
    let url;
    try {
        url = new URL(req.url, 'http://127.0.0.1');
    } catch (e) {
        sendJson(res, 400, {error: 'bad request'});
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {allow: 'GET, HEAD', 'content-type': 'text/plain'});
        log(req, 405);
        res.end('read-only wall display');
        return;
    }

    if (READ_API.has(url.pathname)) {
        proxy(req, res, url);
        return;
    }

    const meta = STATIC[url.pathname];
    if (meta) {
        sendStatic(req, res, meta);
        return;
    }

    log(req, 404);
    sendJson(res, 404, {error: 'not found'});
});

if (require.main === module) {
    server.listen(PORT, () => {
        console.log('DX-Compass wall display: http://0.0.0.0:' + PORT +
            '  (read-only, upstream ' + UPSTREAM.origin + ')');
    });
}

module.exports = {server, READ_API, STATIC};
