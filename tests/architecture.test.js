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

test('我的 SPOT 提醒不随当前视图变化', () => {
    const source = read('public', 'js', 'pages', 'qso-page.mjs');
    const start = source.indexOf('function showSpotAlert(');
    assert.ok(start > 0, 'showSpotAlert must exist in the QSO page');
    const end = source.indexOf('\n    }', start);
    const body = source.slice(start, end);
    // 操作员停在 Spot / 传播 / OP 任一视图都要收到本台被播报的提醒。
    assert.match(body, /queueMySpot\(spot\)/);
    assert.doesNotMatch(body, /\bstate\.view\b/);
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

test('neighbors schema is delivered as one batch statement', () => {
    // 建表语句合并成一条 msg.topic，由 sqlite 节点的 batch 模式一次执行；
    // 多条消息逐条 db.all 会在启动竞态里丢语句。
    const flow = JSON.parse(read('flow.json'));
    const builder = flow.find(node => node.name === 'Create neighbors schema');
    const apply = flow.find(node => node.name === 'Apply neighbors schema');
    assert.ok(builder && apply);
    assert.match(builder.func, /list\.join\('\\n'\)/);
    assert.equal(apply.sqlquery, 'batch');
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

test('alert seat migration and frequency claim API are wired end to end', () => {
    const flow = JSON.parse(read('flow.json'));
    const byName = name => flow.find(node => node.name === name);
    assert.deepEqual(byName('Create alert rules').wires, [[byName('Build alert seat column query').id]]);
    assert.match(byName('Build alert seat column query').func, /seatColumnQuery/);
    assert.match(byName('Build alert seat migration').func, /migrateSeat/);
    assert.deepEqual(byName('Apply alert seat migration').wires, [[]]);

    const route = byName('POST /api/frequency-claims/:action');
    const change = byName('Change frequency claim');
    assert.deepEqual(route.wires, [[change.id]]);
    assert.equal(change.outputs, 2);
    assert.match(change.func, /dx\.qso\.changeFrequencyClaim/);
    assert.match(change.func, /type: 'frequencyClaims'/);
    assert.ok(change.wires[0].includes(byName('Frequency claim response').id));
    assert.ok(change.wires[1].includes(byName('Broadcast frequency claims').id));
});

test('seat identification API and UDP source header are wired end to end', () => {
    const flow = JSON.parse(read('flow.json'));
    const byName = name => flow.find(node => node.name === name);
    const list = byName('List seat identities');
    const change = byName('Change seat identity');
    assert.deepEqual(byName('GET /api/seats').wires, [[list.id]]);
    assert.match(list.func, /dx\.qso\.listSeatIdentities/);
    assert.deepEqual(byName('POST /api/seats').wires, [[change.id]]);
    assert.match(change.func, /dx\.qso\.changeSeatIdentity/);
    assert.match(change.func, /type: 'seatIdentities'/);
    assert.ok(change.wires[0].includes(byName('Change seat identity').wires[0][0]));
    const auth = byName('N1MM ingest auth');
    assert.match(auth.func, /x-dx-source/);
    assert.match(auth.func, /msg\.n1mmMeta = \{station: String\(station \|\| ''\), ip, port\}/);
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

test('startup readiness probe covers every schema object', () => {
    const flow = JSON.parse(read('flow.json'));
    const inject = flow.find(node => node.type === 'inject' && node.name === 'DB self-check on startup');
    assert.ok(inject && inject.once === true, 'readiness probe must run once on startup');
    assert.ok(Number(inject.onceDelay) < 1, 'probe must start immediately instead of after a guessed delay');
    const query = flow.find(node => node.name === 'Build DB self-check query');
    assert.ok(query, 'probe query builder must exist');
    assert.match(query.func, /dx\.ready\.probeQuery\(\)/);
    const sql = require('../lib/storage/ready-sql.js').probeQuery();
    assert.match(sql, /pragma_table_info\('spots'\)/);
    assert.match(sql, /sqlite_master/);
    for (const token of ['rf_links', 'rf_links_pair', 'control_links', 'control_links_pair', 'alert_rules', 'devices', 'tx_sources']) {
        assert.match(sql, new RegExp(token));
    }
    const check = flow.find(node => node.name === 'Check DB self-check result');
    assert.ok(check, 'probe result handler must exist');
    assert.match(check.func, /dx\.ready\.missing\(/);
    assert.match(check.func, /dx\.ready\.markReady\(\)/);
    assert.match(check.func, /dx\.ready\.markFailed\(/);
    assert.match(check.func, /PROBE_TIMEOUT_MS/);
    assert.match(check.func, /node\.warn\(/);
});

test('operational UI does not render operator callsigns', () => {
    assertNoMatch([
        path.join(ROOT, 'public/js/pages/qso-page.mjs'),
        path.join(ROOT, 'public/bigscreen/wall-cards.mjs')
    ], /opCall/, 'operational UI must not render OpCall');
    // 波段占用横条是唯一豁免：仅 renderBandOccupancy 内允许显示操作员呼号，
    // 否则 OP 无法判断是谁占用了某段。圈定 opcall-exception 标记后整段剔除，
    // 其余 op-page.mjs 仍禁止出现 opCall。
    const opSource = read('public', 'js', 'pages', 'op-page.mjs');
    assert.match(opSource, /\/\* opcall-exception:start \*\/[\s\S]*?opCall[\s\S]*?\/\* opcall-exception:end \*\//,
        'the band-occupancy exception must wrap a real OpCall use');
    assert.doesNotMatch(
        opSource.replace(/\/\* opcall-exception:start \*\/[\s\S]*?\/\* opcall-exception:end \*\//g, ''),
        /opCall/, 'op-page must not render OpCall outside the band-occupancy strip');
    assert.doesNotMatch(read('public', 'index.html'), /id="qtOp"|id="qOpDist"/);
    assert.doesNotMatch(read('public', 'bigscreen', 'index.html'), /id="opList"/);
});

test('OP 功放面板：只列本席位链路上的功放，画面永远画出来', () => {
    const op = read('public', 'js', 'pages', 'op-page.mjs');
    // 功放归属读服务端沿 RF 连线的投影（ownership.by_seat[seat].amps），
    // 前端不重算走线；只有投影没有结论时才退回全部功放。
    assert.match(op, /const bySeat = \(\(deviceSnapshot\(\) \|\| \{\}\)\.ownership \|\| \{\}\)\.by_seat \|\| \{\}/);
    assert.match(op, /Array\.isArray\(view\.amps\)/);
    assert.match(op, /\.filter\(device => !allowed \|\| allowed\.has\(String\(device\.id\)\)\)/);
    // 没有读数也画刻度：空值安全 + 面板一律走 ampReadings，状态原因压进标签。
    assert.match(op, /function ampReadings\(amp, stale\) \{\r?\n\s*const data = amp \|\| \{\}/);
    assert.match(op, /const face = ampReadings\(amp, stale\);/);
    assert.match(op, /:\s*ampSkeleton\(t\('op\.amp\.none'/);
    assert.match(op, /grid\.innerHTML = ampSkeleton\(t\('op\.amp\.loading'\)/);
    assert.doesNotMatch(op, /op-amp-empty/);

    // 功放主容器让出第 3 行第 4 列（300px），给下一步的容器。
    const css = read('public', 'css', 'op.css');
    assert.match(css, /\.op-view > \.op-amp-bay \{ grid-column: 1 \/ 4; grid-row: 3; \}/);
    assert.doesNotMatch(css, /\.op-amp-empty/);
});

test('OP 天线切换容器：按钮来自拓扑投影，配色沿用波段占用三态', () => {
    const html = read('public', 'index.html');
    assert.match(html, /<section class="op-card op-antswitch-card">/);
    assert.match(html, /<h3 id="opAntSwitchTitle" data-i18n="op\.antswitch\.title">/);
    assert.match(html, /<div id="opAntSwitch" class="op-antswitch"><\/div>/);

    const css = read('public', 'css', 'op.css');
    // 第 3 行第 4 列：天线控制下方、疑似错误呼号上方
    assert.match(css, /\.op-view > \.op-antswitch-card \{ grid-column: 4; grid-row: 3; \}/);
    // 三态配色复用波段占用的绿/红/黄，不另发明一套颜色
    assert.match(css, /\.op-antswitch-btn\.free \{ background: var\(--green\); \}/);
    assert.match(css, /\.op-antswitch-btn\.occupied \{ background: var\(--red\); \}/);
    assert.match(css, /\.op-antswitch-btn\.preempted \{ background: var\(--yellow\); \}/);

    const op = read('public', 'js', 'pages', 'op-page.mjs');
    const render = (/    function renderAntSwitch\(\) \{[\s\S]*?\n    \}/.exec(op) || [''])[0];
    assert.ok(render, '天线切换容器必须由 OP 页渲染');
    // 按钮集合与配色只读服务端沿 RF 连线的投影，前端不重算走线
    assert.match(op, /ant_switch/);
    assert.match(render, /reachable/);
    assert.match(render, /switch_color_by_seat/);
    // 标签只显示天线名，不显示占用者
    assert.match(render, /antenna\.name \|\| id/);
    assert.doesNotMatch(render, /routed_by|\bowners\b|opCall/);
    // 点击走既有下发通道：命令交给天线设备，端口由服务端反推
    assert.match(op, /\$\('#opAntSwitch'\)\?\.addEventListener\('click'/);
    assert.match(op, /\{command: 'route', device_id: antennaId\}/);
});

test('cold-start entry points wait for the readiness gate', () => {
    const gate = read('nodes', 'ready-gate.js');
    assert.ok(fs.existsSync(path.join(ROOT, 'nodes', 'ready-gate.html')),
        'Node-RED only loads a local node file when a sibling .html exists');
    assert.match(gate, /RED\.httpNode\.use\(/,
        'the gate must be a global middleware registered before http-in routes');
    assert.match(gate, /flows:started/,
        'the gate must wait for http-in routes to be registered');
    assert.match(gate, /prependListener\('upgrade'/,
        'websocket upgrades must also wait for route registration');
    assert.match(gate, /ready\.whenReady\(\)/);
    assert.match(gate, /require\('\.\.\/lib\/ready\.js'\)/);
    assert.match(gate, /schema-init-failed/);

    const flow = JSON.parse(read('flow.json'));
    const gated = [
        'Parse PSKR spot',
        'Parse RadioInfo',
        'Parse QSO',
        'Parse Score',
        'Build INSERT SQL',
        'Build alert rules query',
        'Build alert index query',
        'Station state query',
        'Build retention SQL',
        'Prepare rotator poll',
        'Prepare tower release',
        'Prepare tower watchdog',
        'Run device polls',
        'Run tower release on start',
        'Run tower watchdog'
    ];
    for (const name of gated) {
        const node = flow.find(item => item.type === 'function' && item.name === name);
        assert.ok(node, name + ' must exist');
        assert.match(node.func, /ready\.whenReady\(\)/, name + ' must await schema readiness');
    }
});

test('schema self-check builder does not await the gate it feeds', () => {
    const flow = JSON.parse(read('flow.json'));
    const builder = flow.find(node => node.name === 'Build DB self-check query');
    assert.doesNotMatch(builder.func, /whenReady/,
        'schema probing must not wait on the gate it is responsible for resolving');
});

test('global gate holds HTTP and WebSocket until schema and flows are ready', async () => {
    const ready = require('../lib/ready.js');
    const gatePath = path.join(ROOT, 'nodes', 'ready-gate.js');
    delete require.cache[require.resolve(gatePath)];

    const middleware = [];
    const listeners = {};
    const upgrades = [];
    const emitted = [];
    require(gatePath)({
        httpNode: {use(fn) { middleware.push(fn); }},
        server: {
            prependListener(name, fn) { if (name === 'upgrade') upgrades.push(fn); },
            emit(name, req, socket, head) { if (name === 'upgrade') emitted.push(req); }
        },
        events: {on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }},
        log: {info() {}},
        nodes: {createNode() {}, registerType() {}}
    });
    assert.equal(middleware.length, 1, 'HTTP gate must be registered once');
    assert.equal(upgrades.length, 1, 'upgrade gate must be registered once');

    let nextCalled = false;
    let status = 0;
    let body = '';
    const res = {
        setHeader() {},
        end(payload) { body = payload; },
        get statusCode() { return status; },
        set statusCode(value) { status = value; }
    };
    const held = new Promise(resolve => {
        middleware[0]({}, res, () => { nextCalled = true; resolve(); });
    });

    const socket = {
        destroyed: false,
        on() {},
        destroy() { this.destroyed = true; }
    };
    const wsRequest = {url: '/ws'};
    upgrades[0](wsRequest, socket, Buffer.alloc(0));

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(nextCalled, false, 'request must not pass while schema is pending');
    assert.equal(emitted.length, 0, 'websocket upgrade must be held while routes are pending');

    ready.markReady();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(nextCalled, false, 'schema alone is not enough; routes must be registered');
    assert.equal(emitted.length, 0);

    for (const listener of listeners['flows:started'] || []) listener();
    await held;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(nextCalled, true);
    assert.equal(status, 0);
    assert.equal(body, '');
    assert.equal(emitted.length, 1, 'held websocket upgrade must be re-emitted once routes are up');
    assert.equal(emitted[0], wsRequest);
    assert.equal(socket.destroyed, false);
});

test('read-only wall keeps an exact static whitelist and GET/HEAD boundary', () => {
    const source = read('bigscreen', 'server.js');
    assert.match(source, /const\s+STATIC\s*=\s*\{/);
    assert.match(source, /req\.method\s*!==\s*'GET'\s*&&\s*req\.method\s*!==\s*'HEAD'/);
    assert.doesNotMatch(source, /express\.static|sendFile\s*\(/,
        'wall must not switch to broad static directory serving');
});
