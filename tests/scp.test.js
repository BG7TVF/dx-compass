'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseMaster, candidates} = require('../lib/scp/parse.js');
const {createStore} = require('../lib/scp/index.js');

function fixture(count = 40000) {
    const lines = ['!!Order,1,1', '#', '# Super Check Partial', '# Release 2026.11.06', '#'];
    for (let i = 0; i < count; i += 1) {
        lines.push('K' + String(i).padStart(5, '0') + 'AA');
    }
    return lines.join('\r\n') + '\r\n';
}

test('parseMaster reads the release, skips comments and the version pseudo call', () => {
    const {release, calls} = parseMaster(fixture(10) + 'VER20261106\r\n');
    assert.equal(release, '2026.11.06');
    assert.equal(calls.has('VER20261106'), false);
    assert.equal(calls.size, 10);
    assert.equal(calls.has('K00000AA'), true);
});

test('candidates prefer the exact call and fall back to slash parts', () => {
    assert.deepEqual(candidates('dl1abc'), ['DL1ABC']);
    assert.deepEqual(candidates('DL1ABC/P'), ['DL1ABC/P', 'DL1ABC']);
    assert.deepEqual(candidates('P/DL1ABC'), ['P/DL1ABC', 'DL1ABC']);
    assert.deepEqual(candidates(''), []);
});

test('store loads a cached file and answers exact / portable lookups', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-'));
    fs.writeFileSync(path.join(dir, 'MASTER.SCP'), fixture(40000), 'utf8');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
        release: '2026.11.06', fetchedAt: new Date().toISOString(), lastModified: ''
    }), 'utf8');
    const store = createStore({dir});
    const status = store.init();
    assert.equal(status.loaded, true);
    assert.equal(status.count, 40000);
    assert.equal(status.release, '2026.11.06');
    assert.equal(store.lookup('K00001AA').status, 'hit');
    assert.equal(store.lookup('K00001AA/P').status, 'hit');
    assert.equal(store.lookup('DL1ABC').status, 'miss');
    fs.rmSync(dir, {recursive: true, force: true});
});

test('store reports unavailable instead of a false miss before loading', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-empty-'));
    const store = createStore({dir});
    assert.equal(store.init().loaded, false);
    assert.equal(store.lookup('DL1ABC').status, 'unavailable');
    fs.rmSync(dir, {recursive: true, force: true});
});

test('refresh keeps the old copy when the download fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-refresh-'));
    fs.writeFileSync(path.join(dir, 'MASTER.SCP'), fixture(40000), 'utf8');
    const store = createStore({
        dir,
        fetchImpl: async () => { throw new Error('offline'); }
    });
    store.init();
    const result = await store.refresh({force: true});
    assert.equal(result.ok, false);
    assert.equal(store.status().loaded, true);
    assert.equal(store.lookup('K00002AA').status, 'hit');
    fs.rmSync(dir, {recursive: true, force: true});
});

test('refresh writes a validated download and preserves the release', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-download-'));
    const store = createStore({
        dir,
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: {get: () => 'Fri, 06 Nov 2026 00:01:38 GMT'},
            text: async () => fixture(45000)
        })
    });
    const result = await store.refresh({force: true});
    assert.equal(result.ok, true);
    assert.equal(result.status.count, 45000);
    assert.equal(fs.existsSync(path.join(dir, 'MASTER.SCP')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).release, '2026.11.06');
    fs.rmSync(dir, {recursive: true, force: true});
});
