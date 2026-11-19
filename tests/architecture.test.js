'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

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
    // 只有两处豁免允许显示操作员呼号，各自用 opcall-exception 标记圈住：
    // 一是波段占用横条，否则 OP 无法判断是谁占用了某段；
    // 二是席位铭牌，本席位的 OP 必须显示出来。
    // 剔除标记内的代码后，其余 op-page.mjs 仍禁止出现 opCall。
    const opSource = read('public', 'js', 'pages', 'op-page.mjs');
    assert.match(opSource, /\/\* opcall-exception:start \*\/[\s\S]*?opCall[\s\S]*?\/\* opcall-exception:end \*\//,
        'an OpCall exception must wrap a real OpCall use');
    assert.doesNotMatch(
        opSource.replace(/\/\* opcall-exception:start \*\/[\s\S]*?\/\* opcall-exception:end \*\//g, ''),
        /opCall/, 'op-page must not render OpCall outside the band-occupancy strip and the seat nameplate');
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
    // 手动设备：上报页面已经收起品牌/型号字段，config 里残留的旧型号不能再印到
    // 功放卡上，否则改成手动设备后 OP 还挂着之前设置的型号。
    assert.match(op, /function ampIdentity\(device, manual\)/);
    assert.match(op, /if \(manual\) return \{brand: '', model: ''\};/);
    assert.match(op, /const identity = ampIdentity\(device, manual\);/);
    assert.match(op, /const reason = manual \? t\('op\.amp\.manual'\)/);

    // 功放容器再缩短到前两列：第 3 列电台卡片，第 4 列天线切换。
    const css = read('public', 'css', 'op.css');
    assert.match(css, /\.op-view > \.op-amp-bay \{ grid-column: 1 \/ 3; grid-row: 3; \}/);
    assert.match(css, /\.op-view > \.op-station-card \{ grid-column: 3; grid-row: 3; \}/);
    // 地图容器同样只占中间两轨的第一轨：右缘与功放容器右缘落在同一条竖线上，
    // 第二轨空出来留给后续内容。
    assert.match(css, /\.op-view > \.op-center \{ grid-column: 2 \/ 3; grid-row: 2; \}/);
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
    // 三态配色复用波段占用的绿/红/黄，不另发明一套颜色；墨色同样走 --op-on-*
    assert.match(css, /\.op-antswitch-btn\.free \{ background: var\(--green\); color: var\(--op-on-green\); \}/);
    assert.match(css, /\.op-antswitch-btn\.occupied \{ background: var\(--red\); color: var\(--op-on-red\); \}/);
    assert.match(css, /\.op-antswitch-btn\.preempted \{ background: var\(--yellow\); color: var\(--op-on-yellow\); \}/);

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

test('OP 视频监控卡片：与地图同一行轨道，画面按接通天线绑定的摄像头换源', () => {
    const html = read('public', 'index.html');
    assert.match(html, /<section class="op-card op-camera-card">/);
    assert.match(html, /<h3 id="opCameraTitle" data-i18n="op\.camera\.title">/);
    assert.match(html, /<div class="op-camera-body" id="opCameraBody"><\/div>/);
    // 地图标题栏只剩标题与署名：那条「地图固定…点击地图设置旋转器目标方位」的说明整条删掉。
    assert.doesNotMatch(html, /opMapHint/);

    const css = read('public', 'css', 'op.css');
    // 第 2 行第 3 轨：和 .op-center 同处一行轨道，所以高度天然齐平，不需要任何高度算术。
    assert.match(css, /\.op-view > \.op-camera-card \{ grid-column: 3; grid-row: 2;/);
    assert.doesNotMatch(css, /\.op-map-hint/);
    // 画面黑底等比居中，高度跟着行轨道走。
    assert.match(css, /\.op-camera-body img \{[\s\S]*?object-fit: contain;/);

    const op = read('public', 'js', 'pages', 'op-page.mjs');
    assert.doesNotMatch(op, /opMapHint|updateMapHint/);
    // 画面由服务器拉取后分发，浏览器只加载 <img>：不直连摄像头，也不另开一路 WebSocket。
    assert.match(op, /img\.src = '\/api\/cameras\/' \+ encodeURIComponent\(id\) \+ '\/stream';/);
    // 绑定关系本来就在设备快照里（天线 config.camera），这里只查表，不另开数据通道。
    assert.match(op, /antenna\.config \|\| \{\}\)\.camera/);
    // 同一路画面绝不重建 <img>：重建等于每次刷新都重连一次 MJPEG。
    assert.match(op, /if \(cameraShownId === id && host\.querySelector\('img'\)\)/);
});

test('OP 地图：本台位置、本席位与其他席位 QSO、本台 SPOT 都要上图', () => {
    const op = read('public', 'js', 'pages', 'op-page.mjs');
    const map = read('public', 'js', 'op', 'op-map.mjs');
    const css = read('public', 'css', 'op.css');
    /* shared/geo 的 gridToLatLon 返回 [lat, lon] 数组，而 op-map 的 setHome 只认
     * {lat, lon}。把数组直接递过去等于声明「本台没有位置」，setData 立刻 return，
     * 本台标记、波束扇形、每个席位的 QSO 线、本台 SPOT 一起消失。 */
    const home = (/    function homeLatLon\(\) \{[\s\S]*?\n    \}/.exec(op) || [''])[0];
    assert.ok(home, '本台位置必须由 OP 页换算');
    assert.match(home, /\{\s*lat:/);
    assert.doesNotMatch(home, /return grid \? gridToLatLon\(grid\) : null;/);
    assert.match(map, /const at = next && !Array\.isArray\(next\) \? pointOf\(next\.lat, next\.lon\) : null;/);
    // 接口里没坐标的 QSO 是 lat:null；isFinite(null) 为真，旧写法会把 null 当 (0,0)
    // 交给 Leaflet，marker 的 _latlng 变成 null，addTo 抛出 TypeError 后整个绘制循环
    // 中断——后面的 QSO 弧线一条都画不出来。坐标一律先 Number 再校验。
    assert.match(map, /function pointOf\(lat, lon\) \{[\s\S]*?Number\.isFinite\(north\)[\s\S]*?\n\}/);
    assert.doesNotMatch(map, /if \(!isFinite\(qso\.lat\)/);
    assert.match(map, /const at = pointOf\(qso\.lat, qso\.lon\);\s*if \(!at\) continue;/);
    assert.match(map, /L\.marker\(at, \{/);
    // 图上不止本席位：席位列表 ∪ QSO 里真实出现过的席位，每席位各截一段。
    assert.match(op, /function mapSeatKeys\(current\)/);
    assert.match(op, /qsos: mapQsos\(key, limit\)/);
    assert.match(op, /seatLane: seatLane\(seat\),\s*ownSeat: seat === own/);
    // 泳道号由 OP 页按席位编号定，地图只负责取色；本席位实线，他席位细虚线。
    assert.match(map, /const lane = laneIndex\(qso\.seatLane !== undefined \? qso\.seatLane : qso\.radioNr\);/);
    assert.match(map, /const own = qso\.ownSeat !== false;/);
    assert.match(map, /const LANE_COUNT = RADIO_COLORS\.length;/);
    assert.match(map, /RADIO_COLORS\.map\(\(fallback, index\) => cssVar\('--op-r' \+ \(index \+ 1\), fallback\)\)/);
    assert.match(map, /className: 'op-map-dot ' \+ \(own \? 'own' : 'other'\)/);
    // 本席位 QSO 与本席位被 spot 的位置都要画成大圆点，别的席位保持小点。
    assert.match(map, /size: own \? 12 : 7/);
    assert.match(map, /radius: 6, color: spotColor, fillColor: spotFill/);
    assert.match(css, /\.op-map-dot\.own i \{\s*width: 12px;\s*height: 12px;\s*border-radius: 50%;\s*transform: none;/);
    assert.ok(css.indexOf('.op-map-dot.own i') > css.indexOf('.op-map-dot.r2 i'),
        '大圆点必须排在泳道形状规则之后，否则 r2 的菱形会盖掉它');
    // 席位多于两个时颜色不能塌回 --op-r1。
    assert.match(css, /\.op-map-dot\.r3 i \{ background: var\(--op-r3\)/);
    assert.match(css, /\.op-map-dot\.r6 i \{ background: var\(--op-r6\)/);
    assert.match(css, /\.op-map-dot\.other i \{/);
    // 本台 SPOT 仍按本席位电台的波段与模式族挑选。
    assert.match(op, /spots: spotsForSeat\(key\)/);
});

test('摄像头设备：白名单只放行取流地址，天线绑定摄像头 id', () => {
    const model = read('lib', 'devices', 'model.js');
    assert.match(model, /antenna: \['preferred', 'camera'\]/);
    assert.match(model, /camera: \['brand', 'model', 'host', 'port', 'protocol', 'username', 'password',/);
    assert.match(model, /camera: \['onvif', 'snapshot', 'rtsp'\]/);
    // 口令只存 username / password 一份：URL 里的 userinfo 落库前剥掉。
    assert.match(model, /function scrubUrlAuth\(value\)/);
    assert.match(model, /invalid-config-fps/);

    const service = read('lib', 'devices', 'service.js');
    // 摄像头没有任何上报通道：状态该显示「无状态源」，不是「状态未知」。
    assert.match(service, /NO_STATE_SOURCE_TYPES = new Set\(\[[\s\S]*?'camera'/);
    // 设备快照是摄取登记表的唯一同步入口，换天线/改地址都走这一条路径。
    assert.match(service, /cameras\.sync\(devices\)/);

    // 分发端点：settings.httpNodeMiddleware 在 Node-RED 3.x 开不了新端点，
    // 唯一被验证过的挂载点是本地节点模块体内的 RED.httpNode.use。
    const hubNode = read('nodes', 'camera-hub.js');
    assert.ok(fs.existsSync(path.join(ROOT, 'nodes', 'camera-hub.html')),
        'Node-RED 只加载有同名 .html 兄弟文件的本地节点');
    assert.match(hubNode, /RED\.httpNode\.use\(handler\);/);
    assert.match(hubNode, /\/api\/cameras\/discover/);
    assert.match(hubNode, /require\('\.\.\/lib\/ready\.js'\)/,
        '手写路由同样要过就绪门闩，否则冷启动会撞上未迁移的库');
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

test('频率联动：电台卡片、服务端判定与轮询链路都在约定位置', () => {
    const html = read('public', 'index.html');
    assert.match(html, /<section class="op-card op-station-card">/);
    assert.match(html, /<div class="op-station-body" id="opStationBody"><\/div>/);
    assert.match(html, /<input type="checkbox" id="opBandLink">/,
        '联动开关必须是界面里看得见的复选框，不是藏在菜单里的暗桩');

    const op = read('public', 'js', 'pages', 'op-page.mjs');
    assert.match(op, /function renderStationCard\(\) \{/);
    assert.match(op, /renderAntSwitch\(\);\s*\n\s*renderStationCard\(\);/,
        '电台卡片要和天线切换一起进渲染链');
    assert.match(op, /const radio = radioOf\(currentSeat\(\)\);/,
        '收发状态/频率/模式按当前席位取电台状态');
    assert.doesNotMatch(op, /radioOf\(state\.seat\)/,
        '电台状态不存在 state.seat 这个键，取错了整张卡片会静默显示未绑定');
    assert.match(op, /\$\('#opBandLink'\)\?\.addEventListener\('change'/);
    assert.match(op, /await setBandLink\(seat, want/,
        '开关联动状态写服务端，不用浏览器本地偏好');
    assert.match(op, /function stationSeatKey\(\) \{[\s\S]*?antSwitchSeatHit\(\)/,
        '联动必须按服务端席位键存取，和天线切换同一口径');

    // 收发指示必须跟着报文走：卡片曾经只靠 3 秒一轮的 loadDevices 重绘，
    // 电台早就收着了灯还红着，比 QSO 地图的本台状态慢一个数量级。
    const stationTick = op.slice(op.indexOf('function handleStation() {'),
        op.indexOf('function handleQso('));
    assert.ok(stationTick.length > 40, 'handleStation 必须存在');
    assert.match(stationTick, /renderStationCard\(\);/,
        'radio 报文一到就要重绘电台卡片，不能等轮询');
    assert.match(read('public', 'js', 'main.mjs'),
        /case 'radio':[\s\S]*?ctx\.op\.handleStation\(\);/,
        'radio 报文要同时喂给 OP 视图');

    // 卡片加密：读数带 + 四格副读数 + 贴底结论栏，三行缺一行就又变成空卡片。
    assert.match(op, /class="op-station-read /,
        '主读数带：波段牌、大号频率、模式/异频、收发灯');
    assert.match(op, /class="op-station-meta"/,
        '副读数四格：电台、接通天线、可达天线、心跳');
    const stationCss = read('public', 'css', 'op.css');
    assert.match(stationCss, /\.op-view \.op-station-card\[data-tx="1"\]/,
        '发射态描边要带 .op-view 加权，否则被后面的通用卡片描边整条覆盖');
    assert.match(stationCss, /\.op-station-read \{[\s\S]*?min-height: 40px;/,
        '读数带设了下限，窄容器里不能把大号频率数字上下裁掉');
    assert.match(stationCss,
        /\.op-station-meta \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
        '四格副读数永远一行等宽：换成 3+1 会把上行读数挤扁');
    assert.match(op, /'op\.station\.reason\.' \+ last\.reason/,
        '没动手的判定也要出文案，不能静悄悄');

    const api = read('public', 'shared', 'data', 'devices.mjs');
    assert.match(api, /export function setBandLink\(seat, enabled/);
    assert.match(api, /action: 'band-link'/);

    const model = read('lib', 'devices', 'model.js');
    assert.match(model, /antenna: \['preferred', 'camera'\]/,
        '优先天线与摄像头绑定都要过 config 白名单，否则落不了库');

    const ownership = read('lib', 'devices', 'ownership.js');
    assert.match(ownership, /preferred: !!\(antenna\.config && antenna\.config\.preferred === true\)/);

    const service = read('lib', 'devices', 'service.js');
    assert.match(service, /const bandLink = require\('\.\/band-link\.js'\)/);
    assert.match(service, /band_link: bandLink\.view\(global\)/,
        '快照要带联动状态，界面才不用另开一条请求');
    assert.match(service, /if \(action === 'band-link'\)/);
    assert.match(service, /async function bandLinkTick\(global, rows, now\)/);
    assert.match(service, /bandLinkTick,[\s\S]*\n\};/);

    const flow = JSON.parse(read('flow.json'));
    const byId = new Map(flow.map(node => [node.id, node]));
    const poll = byId.get('dxdev00000000b0');
    assert.ok(poll, '频率联动要有自己的轮询 inject');
    assert.equal(poll.repeat, '2');
    assert.equal(poll.once, true, '重启后第一轮不等频段变化');
    const run = byId.get('dxdev00000000b3');
    assert.match(run.func, /dx\.devices\.bandLinkTick\(global, msg\.payload, new Date\(\)\)/);
    assert.deepEqual(run.wires[1], ['dxc000000000000e'],
        '判定结果要广播，其它浏览器才会跟着刷新');

    const i18n = read('public', 'js', 'i18n.js');
    for (const key of ['no-antenna', 'occupied', 'ambiguous', 'single-band', 'preferred',
        'only', 'already', 'tx-active', 'route-failed']) {
        const hits = i18n.split("'op.station.reason." + key + "'").length - 1;
        assert.equal(hits, 2, 'op.station.reason.' + key + ' 需要中英两套文案');
    }
    assert.equal(i18n.split("'dev.form.preferred'").length - 1, 2);
});

test('浏览器端模块都能被解析', () => {
    // 前端是原生 ES module，没有构建步骤：任何一行语法错误都只在浏览器里炸，
    // 而模块一旦解析失败，整棵依赖树都不会执行——页面空白、点什么都没反应。
    // 上面那些文本断言抓不到这种错误，必须真解析一遍。
    const files = walk(path.join(ROOT, 'public')).filter(file => file.endsWith('.mjs'));
    assert.ok(files.length >= 40, 'expected the whole browser module graph, got ' + files.length);
    for (const file of files) {
        let stderr = '';
        try {
            execFileSync(process.execPath, ['--check', file], {stdio: 'pipe'});
        } catch (error) {
            stderr = String(error.stderr || error.message).trim();
        }
        assert.equal(stderr, '', path.relative(ROOT, file) + ' 解析失败：\n' + stderr);
    }
});
