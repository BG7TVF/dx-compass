import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmitter} from '../public/shared/core/events.mjs';
import {
    formatDuration,
    formatUtcDate,
    formatUtcTime,
    parseUtcDateTime,
    utcHourKey
} from '../public/shared/core/clock.mjs';
import {createI18n} from '../public/shared/core/i18n.mjs';
import {
    getJson,
    HttpError,
    postJson,
    resolveWebSocketUrl,
    sendBeacon
} from '../public/shared/core/transport.mjs';

test('event emitter supports unsubscribe, once and synchronous snapshots', () => {
    const events = createEmitter();
    const values = [];
    const off = events.on('value', value => values.push(value));
    events.once('value', value => values.push(value * 10));
    assert.equal(events.emit('value', 2), 2);
    assert.equal(events.emit('value', 3), 1);
    off();
    assert.equal(events.emit('value', 4), 0);
    assert.deepEqual(values, [2, 20, 3]);
});

test('UTC helpers parse datetime-local as UTC and format stable labels', () => {
    const iso = '2026-11-08T15:04:05Z';
    assert.equal(parseUtcDateTime('2026-11-08T15:04'), Date.parse('2026-11-08T15:04:00Z'));
    assert.equal(parseUtcDateTime('2026-11-08T15:04:05'), Date.parse(iso));
    assert.equal(formatUtcTime(iso), '15:04:05');
    assert.equal(formatUtcDate(iso), '2026-11-08');
    assert.equal(utcHourKey(iso), '2026-11-08T15');
    assert.equal(formatDuration(3661000), '01:01:01');
    assert.equal(formatUtcTime('invalid'), '');
});

test('i18n adapter is read-only, supports fallback/functions/interpolation', () => {
    const dictionaries = {
        en: {hello: 'Hello {call}', count: value => `${value} spots`, onlyEn: 'fallback'},
        zh: {hello: '你好 {call}'}
    };
    const root = {I18N: dictionaries, LANGS: ['zh', 'en'], LANG_NAMES: {zh: '中文'}};
    const i18n = createI18n({root});
    assert.equal(i18n.t('hello', {call: 'K1A'}), '你好 K1A');
    assert.equal(i18n.t('count', 3), '3 spots');
    assert.equal(i18n.t('onlyEn'), 'fallback');
    assert.equal(i18n.t('missing'), 'missing');
    assert.deepEqual(i18n.languages, ['zh', 'en']);
    assert.deepEqual(dictionaries.zh, {hello: '你好 {call}'});
});

const response = (text, {ok = true, status = 200, statusText = 'OK'} = {}) => ({
    ok, status, statusText,
    text: async () => text
});

test('JSON transport parses payloads, sets POST headers and reports HTTP/JSON errors', async () => {
    const requests = [];
    const fetchImpl = async (url, options) => {
        requests.push({url, options});
        return response('{"success":true}');
    };
    assert.deepEqual(await getJson('/api/test', {fetchImpl}), {success: true});
    assert.deepEqual(await postJson('/api/test', {on: true}, {fetchImpl}), {success: true});
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.body, '{"on":true}');
    assert.equal(requests[1].options.headers.get('Content-Type'), 'application/json');

    await assert.rejects(
        getJson('/api/missing', {fetchImpl: async () => response('{"error":"missing"}', {ok: false, status: 404, statusText: 'Not Found'})}),
        error => error instanceof HttpError && error.status === 404 && error.body.error === 'missing'
    );
    await assert.rejects(
        getJson('/api/bad-json', {fetchImpl: async () => response('not json')}),
        SyntaxError
    );
});

test('WebSocket URL and beacon adapters preserve the current protocol and JSON body', () => {
    assert.equal(resolveWebSocketUrl('/ws', {protocol: 'https:', host: 'example.test'}), 'wss://example.test/ws');
    assert.equal(resolveWebSocketUrl('/ws', {protocol: 'http:', host: 'example.test'}), 'ws://example.test/ws');
    assert.equal(resolveWebSocketUrl('wss://radio.test/ws'), 'wss://radio.test/ws');
    let sent;
    const ok = sendBeacon('/api/monitoring', {on: false, client: 'x'}, {
        navigatorImpl: {sendBeacon(url, payload) { sent = {url, payload}; return true; }},
        BlobImpl: null
    });
    assert.equal(ok, true);
    assert.equal(sent.url, '/api/monitoring');
    assert.deepEqual(JSON.parse(sent.payload), {on: false, client: 'x'});
    assert.equal(sendBeacon('/x', {}, {navigatorImpl: null}), false);
});
