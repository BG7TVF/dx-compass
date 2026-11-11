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

test('analysis HTTP routes are registered and wired end to end', () => {
    const flow = JSON.parse(read('flow.json'));
    const byId = new Map(flow.map(node => [node.id, node]));
    const tabs = new Map(flow.filter(node => node.type === 'tab').map(node => [node.id, node]));
    const routes = flow.filter(node => node.type === 'http in' &&
        /^\/api\/analysis(?:\/|$)/.test(node.url || ''));
    const urls = routes.map(node => `${node.method} ${node.url}`).sort();
    assert.deepEqual(urls, ['get /api/analysis/estimate', 'get /api/analysis/paths']);

    for (const route of routes) {
        assert.notEqual(route.disabled, true, `${route.url} must not be disabled`);
        const tab = tabs.get(route.z);
        assert.ok(tab && !tab.disabled, `${route.url} must live in an enabled tab`);
        let pending = [...(route.wires || [])].flat();
        const seen = new Set();
        const functions = [];
        let endsAtResponse = false;
        while (pending.length) {
            const id = pending.shift();
            assert.ok(byId.has(id), `${route.url} wires to missing node ${id}`);
            if (seen.has(id)) continue;
            seen.add(id);
            const node = byId.get(id);
            assert.notEqual(node.disabled, true, `${route.url} chain has disabled node ${id}`);
            if (node.type === 'function') functions.push(node);
            if (node.type === 'http response') endsAtResponse = true;
            pending = pending.concat([...(node.wires || [])].flat());
        }
        assert.ok(functions.length > 0, `${route.url} must run through function nodes`);
        assert.ok(endsAtResponse, `${route.url} must terminate at an http response node`);
        for (const node of functions) {
            assert.match(node.func || '', /\bdx\./, `${node.name} must call the dx facade`);
        }
    }
});

test('multi-statement function nodes emit every message on output 1', () => {
    // Node-RED 会把 return 的数组按 index 映射到输出；单输出节点必须用 [[msg1,msg2]]
    // 包一层，否则除了第一条，其余语句会被丢弃（列迁移、邻台触发器、清理都踩过）。
    const flow = JSON.parse(read('flow.json'));
    const expected = {
        'Add missing columns': /return \[topics\.map\(/,
        'Create neighbors schema': /return \[list\.map\(/,
        'Build retention SQL': /return \[statements\.map\(/
    };
    for (const [name, pattern] of Object.entries(expected)) {
        const node = flow.find(item => item.name === name);
        assert.ok(node, name + ' must exist');
        assert.equal(Number(node.outputs), 1, name + ' must keep a single output');
        assert.match(node.func, pattern,
            name + ' must wrap its message list so every statement is delivered');
    }
});

test('DB startup migrates columns and creates neighbor schema in independent branches', () => {
    const flow = JSON.parse(read('flow.json'));
    const byName = name => flow.find(node => node.name === name);
    // node-red-node-sqlite 只在使用 output 1，多输出接线等于永远不触发。
    for (const node of flow.filter(item => item.type === 'sqlite')) {
        assert.ok((node.wires || []).length <= 1,
            node.name + ' is an sqlite node and cannot fan out on extra outputs');
    }
    const createTable = byName('Create table');
    assert.ok(createTable, 'Create table sqlite node must exist');
    const fanout = byName('Fan out DB init');
    assert.ok(fanout, 'a function node must fan out the DB init branches');
    assert.ok(Number(fanout.outputs) >= 2, 'fan-out node needs an output per branch');
    assert.match(fanout.func, /return\s*\[\[/,
        'fan-out must return nested arrays, otherwise every message goes to output 1');
    assert.deepEqual(createTable.wires, [[fanout.id]],
        'Create table must hand off to the fan-out node');
    for (const name of ['Check extra columns', 'Check spot_id column']) {
        const node = byName(name);
        assert.ok(node, name + ' must exist');
        assert.ok((fanout.wires || []).flat().includes(node.id),
            'fan-out must wire to ' + name);
        const outputIndex = (fanout.wires || []).findIndex(wire => wire.includes(node.id));
        assert.ok(outputIndex >= 0 && outputIndex < Number(fanout.outputs),
            name + ' must be reachable on a real fan-out output');
    }
    // 邻台建表只能跑一次：Create table 会被多条建表消息重复触发，
    // 若跟着扇出一起跑，多次并发 DROP/CREATE 触发器会让触发器随机缺失。
    const neighborsNode = byName('Create neighbors schema');
    assert.ok(neighborsNode, 'Create neighbors schema must exist');
    assert.ok(!(fanout.wires || []).flat().includes(neighborsNode.id),
        'neighbors schema must not be driven by the multi-message fan-out');
    const schemaInject = flow.find(node => node.type === 'inject' &&
        (node.wires || []).flat().includes(neighborsNode.id));
    assert.ok(schemaInject, 'neighbors schema needs its own inject');
    assert.equal(schemaInject.once, true, 'neighbors schema inject must fire once per start');
    assert.ok(Number(schemaInject.onceDelay) >= 1,
        'neighbors schema must wait until the spots table exists');
    for (const name of ['Apply column migrations', 'Apply neighbors schema', 'Create index']) {
        const node = byName(name);
        assert.ok(node, name + ' must exist');
        assert.deepEqual(node.wires, [[]], name + ' must end its branch');
    }
    const warn = byName('Log DB migration error');
    assert.ok(warn && /\bnode\.warn\(/.test(warn.func || ''),
        'migration failures must be logged with node.warn');
    assert.match(warn.func, /isDuplicateColumnError/,
        'duplicate column errors must be recognised as already migrated');
    assert.match(warn.func, /node\.log\('DB migration skipped/, 'duplicates log at info level');
    const addColumns = byName('Add missing columns');
    assert.ok(addColumns, 'Add missing columns node must exist');
    assert.match(addColumns.func, /columnNames\(/, 'node must read the column list explicitly');
    assert.match(addColumns.func, /ALTER skipped/,
        'an unreadable column list must skip ALTERs and warn');
    const catcher = flow.find(node => node.type === 'catch' &&
        (node.wires || []).flat().includes(warn.id));
    assert.ok(catcher, 'a catch node must feed the migration log');
    assert.ok((catcher.scope || []).length >= 3, 'catch must cover the migration sqlite nodes');
});

test('flow node ids are unique', () => {
    const flow = JSON.parse(read('flow.json'));
    const seen = new Set();
    for (const node of flow) {
        assert.ok(!seen.has(node.id), 'duplicate node id ' + node.id + ' (' + node.name + ')');
        seen.add(node.id);
    }
});

test('analysis routes always answer with a JSON error instead of hanging', () => {
    const flow = JSON.parse(read('flow.json'));
    const byId = new Map(flow.map(node => [node.id, node]));
    const downstream = id => {
        const out = [];
        const queue = [id];
        const seen = new Set([id]);
        while (queue.length) {
            const node = byId.get(queue.shift());
            if (!node) continue;
            out.push(node);
            for (const next of (node.wires || []).flat()) {
                if (!seen.has(next)) {
                    seen.add(next);
                    queue.push(next);
                }
            }
        }
        return out;
    };

    for (const url of ['/api/analysis/estimate', '/api/analysis/paths']) {
        const route = flow.find(node => node.type === 'http in' && node.url === url);
        assert.ok(route, url + ' route must exist');
        const chain = downstream(route.id);
        const catcher = flow.find(node => node.type === 'catch' &&
            (node.scope || []).some(id => chain.some(item => item.id === id)));
        assert.ok(catcher, url + ' must have a catch node covering its chain');
        const handler = (catcher.wires || []).flat()
            .map(id => byId.get(id))
            .find(node => node && node.type === 'function' &&
                /msg\.statusCode\s*=\s*500/.test(node.func || ''));
        assert.ok(handler, url + ' catch must build a 500 JSON response');
        assert.match(handler.func, /error:\s*'query-failed'/);
        const response = (handler.wires || []).flat()
            .map(id => byId.get(id))
            .find(node => node && node.type === 'http response');
        assert.ok(response, url + ' error handler must end at an http response node');
    }
});

test('startup self-check warns when neighbors schema is missing', () => {
    const flow = JSON.parse(read('flow.json'));
    const inject = flow.find(node => node.type === 'inject' && node.name === 'DB self-check on startup');
    assert.ok(inject && inject.once === true, 'self-check must run once on startup');
    const query = flow.find(node => node.name === 'Build DB self-check query');
    assert.ok(query, 'self-check query builder must exist');
    assert.match(query.func, /dx\.storage\.schema\.selfCheckQuery\(\)/);
    const schema = require('../lib/storage/schema.js');
    const sql = schema.selfCheckQuery();
    assert.match(sql, /pragma_table_info\('spots'\)/);
    assert.match(sql, /'column' AS kind/);
    assert.match(sql, /name='neighbors'/);
    assert.match(sql, /trg_spots_neighbor_%/);
    const check = flow.find(node => node.name === 'Check DB self-check result');
    assert.ok(check, 'self-check result handler must exist');
    for (const token of ['sender_grid', 'receiver_grid', 'dxcc_sender', 'dxcc_receiver', 'neighbors']) {
        assert.match(check.func, new RegExp(token));
    }
    assert.match(check.func, /MISSING/, 'missing items must be named explicitly');
    assert.match(check.func, /actual spots columns/, 'log the actual column list for reconciliation');
    assert.match(check.func, /node\.warn\(/);
});

test('read-only wall keeps an exact static whitelist and GET/HEAD boundary', () => {
    const source = read('bigscreen', 'server.js');
    assert.match(source, /const\s+STATIC\s*=\s*\{/);
    assert.match(source, /req\.method\s*!==\s*'GET'\s*&&\s*req\.method\s*!==\s*'HEAD'/);
    assert.doesNotMatch(source, /express\.static|sendFile\s*\(/,
        'wall must not switch to broad static directory serving');
});
