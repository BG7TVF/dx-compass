'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file, out);
        else if (/\.(?:js|mjs|json)$/.test(entry.name)) out.push(file);
    }
    return out;
}

function read(...parts) {
    return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function assertNoMatch(files, pattern, message) {
    for (const file of files) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), pattern,
            `${message}: ${path.relative(ROOT, file)}`);
    }
}

test('page controllers use repositories instead of owning transport', () => {
    const files = [
        ...walk(path.join(ROOT, 'public', 'js', 'pages')),
        ...walk(path.join(ROOT, 'public', 'bigscreen'))
            .filter(file => file.endsWith('.mjs'))
    ];
    assert.ok(files.length > 0, 'module page controllers must exist');
    assertNoMatch(files, /\bfetch\s*\(|new\s+WebSocket\b|\bsendBeacon\s*\(/,
        'page controllers must use shared transport/repositories');
});

test('map modules have no network access and data modules have no DOM access', () => {
    assertNoMatch(walk(path.join(ROOT, 'public', 'shared', 'map')),
        /\bfetch\s*\(|new\s+WebSocket\b|\bsendBeacon\s*\(/,
        'map modules must be render-only');
    assertNoMatch(walk(path.join(ROOT, 'public', 'shared', 'data')),
        /\bdocument\.|\bquerySelector\b/,
        'repositories and stores must not access the DOM');
});

test('prediction formulas have one server-side home', () => {
    const files = [
        ...walk(path.join(ROOT, 'public')),
        ...walk(path.join(ROOT, 'lib'))
    ].filter(file => file !== path.join(ROOT, 'lib', 'propagation', 'model.js'));
    assertNoMatch(files,
        /function\s+(?:propIonoAt|propMufAt|propPathWindow|propBandScore|fof2At|mufAt)\s*\(/,
        'prediction formula definitions must live in lib/propagation/model.js');
});

test('SQL is confined to the storage module', () => {
    const files = walk(path.join(ROOT, 'lib'))
        .filter(file => !file.includes(`${path.sep}storage${path.sep}`));
    assertNoMatch(files,
        /\b(?:SELECT\s+.+\s+FROM|INSERT\s+(?:OR\s+\w+\s+)?INTO|CREATE\s+TABLE|DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/i,
        'SQL construction must live in lib/storage');
});

test('domain Node-RED function nodes are thin dx adapters', () => {
    const flow = JSON.parse(read('flow.json'));
    const domainNodes = /^(?:Process (?:dxwatch|RBN) spots|Parse PSKR spot|Parse RadioInfo|Parse QSO|Lookup QSO coords|Delete QSO|Parse Score|Set monitoring|Record into session|Recording (?:control|scheduler)|Sync PSKR subscriptions|Settings: (?:get|save)|Collect propagation data|Reply propagation data|Read monitored calls|Save calls \+ queue backfill|Station state|Build (?:INSERT SQL|query SQL|QSO query|recording query))$/;
    const functions = flow.filter(node => node.type === 'function');
    const nodes = functions.filter(node => domainNodes.test(node.name || ''));
    assert.ok(nodes.length >= 18, 'expected domain adapters in flow.json');
    for (const node of nodes) {
        assert.match(node.func, /\bdx\./, `${node.name} must call the dx facade`);
    }
    for (const node of functions) {
        assert.doesNotMatch(node.func,
            /\b(?:SELECT\s+.+\s+FROM|INSERT\s+(?:OR\s+\w+\s+)?INTO|CREATE\s+TABLE|DELETE\s+FROM)\b/i,
            `${node.name} must not contain SQL`);
        assert.doesNotMatch(node.func, /function\s+(?:hav|bandOf|modeOf|gridToLatLon|gridToLatLng)\s*\(/,
            `${node.name} must not redefine domain formulas`);
        assert.doesNotMatch(node.func, /global\.set\(['"]monitoring['"]/,
            `${node.name} must delegate monitoring state to its module`);
    }
});

test('read-only wall keeps an exact static whitelist and GET/HEAD boundary', () => {
    const source = read('bigscreen', 'server.js');
    assert.match(source, /const\s+STATIC\s*=\s*\{/);
    assert.match(source, /req\.method\s*!==\s*'GET'\s*&&\s*req\.method\s*!==\s*'HEAD'/);
    assert.doesNotMatch(source, /express\.static|sendFile\s*\(/,
        'wall must not switch to broad static directory serving');
});
