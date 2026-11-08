'use strict';

/**
 * DX-Compass - same-origin tile proxy middleware.
 *
 * The dashboard's Leaflet maps used to pull raster tiles straight from
 * OpenStreetMap / AMap in the browser. That fails wherever the viewing
 * machine can reach this server but not the public tile hosts (firewalled
 * site networks, corporate proxies, ...). The fetch therefore happens
 * here, server-side; the browser only ever talks to the dashboard itself:
 *
 *     GET /api/tiles/<osm|amap>/<z>/<x>/<y>.png
 *
 * Tiles are cached in memory (LRU, ~600 entries) so any number of viewers
 * share one upstream fetch per tile, and responses carry a day of browser
 * cache. Everything that is not a tile URL falls through to the normal
 * Node-RED routing.
 */

const https = require('https');

/* OSM policy asks for a descriptive User-Agent. AMap serves its webrd
 * tiles without referer checks. The subdomains that the browser used to
 * rotate over now live here, one host is picked per tile. */
const PROVIDERS = {
    osm: {
        hosts: ['https://a.tile.openstreetmap.org',
                'https://b.tile.openstreetmap.org',
                'https://c.tile.openstreetmap.org'],
        url: (h, z, x, y) => `${h}/${z}/${x}/${y}.png`,
        ua: 'DX-Compass tile proxy (+https://github.com/BG7TVF/dx-compass)'
    },
    amap: {
        hosts: ['https://webrd01.is.autonavi.com',
                'https://webrd02.is.autonavi.com',
                'https://webrd03.is.autonavi.com',
                'https://webrd04.is.autonavi.com'],
        url: (h, z, x, y) =>
            `${h}/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`,
        ua: 'Mozilla/5.0 (compatible; DX-Compass tile proxy)'
    }
};

const ROUTE = /^\/api\/tiles\/(osm|amap)\/(\d{1,2})\/(\d+)\/(\d+)\.png$/;
const MAX_ZOOM = 19;
const CACHE_MAX = 600;               // ~600 tiles * ~15 KB ≈ 9 MB
const CACHE_TTL = 24 * 3600 * 1000;  // re-fetch after a day
const FETCH_TIMEOUT = 10 * 1000;

const cache = new Map();             // key -> {buf, type, ts}; insertion order = LRU
const inflight = new Map();          // key -> Promise, dedupes concurrent misses

function fetchTile(provider, z, x, y) {
    const key = provider + '/' + z + '/' + x + '/' + y;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
        cache.delete(key);           // refresh LRU position
        cache.set(key, hit);
        return Promise.resolve(hit);
    }
    const flying = inflight.get(key);
    if (flying) return flying;

    const p = PROVIDERS[provider];
    const host = p.hosts[(x + y) % p.hosts.length];
    const job = new Promise((resolve, reject) => {
        const req = https.get(p.url(host, z, x, y), {
            headers: { 'user-agent': p.ua, accept: 'image/*' },
            timeout: FETCH_TIMEOUT
        }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('upstream ' + res.statusCode));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const tile = {
                    buf: Buffer.concat(chunks),
                    type: res.headers['content-type'] || 'image/png',
                    ts: Date.now()
                };
                cache.set(key, tile);
                while (cache.size > CACHE_MAX) {
                    cache.delete(cache.keys().next().value);
                }
                resolve(tile);
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('upstream timeout')));
        req.on('error', reject);
    });
    inflight.set(key, job);
    job.finally(() => inflight.delete(key));
    return job;
}

/* Express-style middleware, mounted via httpNodeMiddleware in settings.js. */
module.exports = function tileProxy(req, res, next) {
    const m = ROUTE.exec(req.path);
    if (!m) { next(); return; }
    const z = Number(m[2]);
    const x = Number(m[3]);
    const y = Number(m[4]);
    if (z > MAX_ZOOM || x >= (1 << z) || y >= (1 << z)) {
        res.status(404).end();
        return;
    }
    fetchTile(m[1], z, x, y).then(tile => {
        res.set({
            'content-type': tile.type,
            'cache-control': 'public, max-age=86400',
            'content-length': tile.buf.length
        });
        res.end(tile.buf);
    }).catch(() => {
        /* No placeholder image: a failed tile must stay visibly failed so
         * Leaflet retries on the next pan instead of caching a blank. */
        res.status(502).end();
    });
};
