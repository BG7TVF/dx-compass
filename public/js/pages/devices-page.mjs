/**
 * Devices view: a Node-RED style canvas editor.
 *
 * Left palette drags out new device drafts, wires on the canvas express the
 * single-parent tree, and the inspector edits one device at a time. Positions
 * are layout-only data stored in SQLite; every device state still comes from
 * GET /api/devices, and a failed refresh clears the view to `unknown`.
 */
import {$, escapeHtml as esc, showToast, showConfirm} from '../ui.mjs';
import {
    getDevicesSnapshot,
    saveDevice,
    deleteDevice,
    saveDeviceLayouts,
    sendDeviceCommand
} from '../../shared/data/devices.mjs';

const POLL_MS = 2000;
const NODE_W = 210;
const NODE_H = 76;
const CANVAS_MIN_W = 1600;
const CANVAS_MIN_H = 1000;
// 面板提供这十一种可拖出的设备；前五种是射频链路组成部分，后六种是机械与射频路由/分合路支撑。
// 切换器（1×n）与矩阵切换器（n×n）是两种不同类型，占用判定也不同。
const PALETTE_TYPES = ['radio', 'swr', 'bpf', 'amp', 'antenna', 'tower', 'rotator', 'switch', 'matrix', 'divider', 'combiner'];
// 旧版本已有的兜底类型仍可编辑与显示，但不从面板新建。
const TYPE_OPTIONS = PALETTE_TYPES.concat(['other']);
const TYPE_BADGE = {
    radio: 'RX', swr: 'SW', bpf: 'BP', amp: 'PA', antenna: 'AN', tower: 'TW', rotator: 'RT',
    switch: 'CX', matrix: 'MX', divider: 'DV', combiner: 'CB', other: 'OT'
};
const STATUS_KEYS = {online: 'dev.status.online', offline: 'dev.status.offline', unknown: 'dev.status.unknown'};
const TOWER_KEYS = {
    erected: 'dev.tower.erected',
    retracted: 'dev.tower.retracted',
    moving: 'dev.tower.moving',
    fault: 'dev.tower.fault',
    offline: 'dev.tower.offline',
    unknown: 'dev.tower.unknown'
};
const COLOR_KEYS = {red: 'dev.color.red', yellow: 'dev.color.yellow', green: 'dev.color.green'};
const HEALTH_KEYS = {ok: 'dev.tx.health.ok', stale: 'dev.tx.health.stale', offline: 'dev.tx.health.offline'};
const MOTION_KEYS = {
    moving: 'dev.motion.moving',
    settled: 'dev.motion.settled',
    unknown: 'dev.motion.unknown'
};
const ERROR_KEYS = {
    'has-children': 'dev.error.has-children',
    cycle: 'dev.error.cycle',
    'antenna-band-required': 'dev.error.antenna-band-required',
    'invalid-offset': 'dev.error.invalid-offset',
    'unknown-device': 'dev.error.unknown-device',
    'unknown-parent': 'dev.error.unknown-parent',
    'invalid-band': 'dev.error.invalid-band',
    'seat-required': 'dev.error.seat-required',
    'invalid-device-token': 'dev.error.invalid-device-token',
    'device-locked': 'dev.error.device-locked',
    'device-disabled': 'dev.error.device-disabled',
    'invalid-azimuth': 'dev.error.invalid-azimuth',
    'transport-error': 'dev.error.transport-error',
    'transport-timeout': 'dev.error.transport-timeout',
    'transport-connect': 'dev.error.transport-error',
    'transport-protocol': 'dev.error.transport-error',
    'transport-not-configured': 'dev.error.transport-not-configured',
    'tx-active': 'dev.error.tx-active',
    'invalid-config': 'dev.error.invalid-config',
    'invalid-config-channels': 'dev.error.invalid-config-channels',
    'invalid-device-type': 'dev.error.invalid-device-type',
    'invalid-port': 'dev.error.invalid-port',
    'invalid-outlet': 'dev.error.invalid-outlet',
    'unknown-channel': 'dev.error.unknown-channel',
    'invalid-direction': 'dev.error.invalid-direction',
    'unknown-command': 'dev.error.unknown-command',
    'direction-switch-too-fast': 'dev.error.direction-switch-too-fast',
    'invalid-layout': 'dev.error.invalid-layout',
    'invalid-layouts': 'dev.error.invalid-layouts',
    'too-many-layouts': 'dev.error.too-many-layouts'
};

export function createDevicesPage(ctx) {
    let active = false;
    let busy = false;
    let snapshot = null;
    let selectedId = null;
    let seatKey = null;
    let draft = null;
    let draftSeq = 0;
    let formDirty = false;
    let formSignature = null;
    let ctrlSignature = null;
    let timer = null;
    let towerTimer = null;
    let towerHoldDevice = null;
    let towerDirection = null;
    let dragging = null;
    let wiring = null;
    let localLayout = null;

    function t(key, params) {
        const value = ctx.t(key, params);
        return value === undefined || value === null ? key : value;
    }

    function typeLabel(type) {
        const key = 'dev.type.' + String(type || '').replace(/[^a-z]/g, '');
        const label = ctx.t(key);
        return label === key ? String(type || '') : label;
    }

    function errorText(code, params) {
        const key = ERROR_KEYS[code];
        return key ? t(key, params) : t('dev.error.generic');
    }

    function clock(iso) {
        if (!iso) return '—';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '—';
        return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
    }

    function lastReportText(iso) {
        return iso ? t('dev.lastReport', {time: clock(iso)}) : t('dev.never');
    }

    function realDevices() {
        return snapshot ? snapshot.devices : [];
    }

    function deviceById(id) {
        if (!snapshot) return null;
        return snapshot.devices.find(device => device.id === id) || null;
    }

    function selectedDevice() {
        if (!selectedId) return null;
        return deviceById(selectedId);
    }

    function selectedDraft() {
        return draft && selectedId === draft.key ? draft : null;
    }

    function selectedValue() {
        const draftItem = selectedDraft();
        if (draftItem) return Object.assign({}, draftItem.device, {layout: draftItem.layout});
        return selectedDevice();
    }

    function isDraftKey(key) {
        return !!(draft && key === draft.key);
    }

    function positionOf(device) {
        if (localLayout && localLayout[device.id]) return localLayout[device.id];
        return device.layout || {x: 80, y: 80};
    }

    function seatsView() {
        return snapshot ? snapshot.ownership : {seats: [], by_seat: {}, antennas: []};
    }

    function seatView() {
        if (!snapshot || !seatKey) return null;
        return snapshot.ownership.by_seat[seatKey] || null;
    }

    function antennaColor(antennaId) {
        const view = seatView();
        return view && view.colors[antennaId] ? view.colors[antennaId] : 'green';
    }

    function deviceStatus(id) {
        return (snapshot && snapshot.status[id]) || {state: 'unknown', last_report: null};
    }

    function nodeMeta(device) {
        const parts = [];
        if (device.bands && device.bands.length) {
            parts.push(t('dev.bands', {bands: device.bands.join(' ')}));
        }
        if (device.type === 'antenna' && snapshot) {
            const antenna = snapshot.ownership.antennas.find(item => item.id === device.id);
            if (antenna && antenna.actual_azimuth !== null && antenna.actual_azimuth !== undefined) {
                parts.push(t('dev.antenna.actual', {deg: antenna.actual_azimuth}));
            }
        }
        if (device.type === 'rotator' && snapshot) {
            const rotator = snapshot.rotators[device.id];
            if (rotator && rotator.physical_azimuth !== null) {
                parts.push(t('dev.rotator.physical', {deg: rotator.physical_azimuth}));
            }
            if (rotator && rotator.target_azimuth !== null) {
                parts.push(t('dev.rotator.target', {deg: rotator.target_azimuth}));
            }
        }
        if (device.type === 'tower' && snapshot) {
            const tower = snapshot.towers[device.id];
            parts.push(t(TOWER_KEYS[tower && tower.state] || TOWER_KEYS.unknown));
        }
        return parts.join(' · ');
    }

    function nodeHtml(node) {
        const device = node.device;
        const status = node.draft ? {state: 'unknown', last_report: null} : deviceStatus(device.id);
        const classes = ['dev-canvas-node'];
        if (node.key === selectedId) classes.push('active');
        if (node.draft) classes.push('draft');
        const color = device.type === 'antenna'
            ? `<span class="dev-chip dev-color-${antennaColor(device.id)}">${t(COLOR_KEYS[antennaColor(device.id)])}</span>`
            : '';
        const ports = node.draft ? '' : '<span class="dev-port dev-port-in" title="in"></span>' +
            '<span class="dev-port dev-port-out" title="out"></span>';
        return `<div class="${classes.join(' ')}" role="button" tabindex="0" data-node-key="${esc(node.key)}"${node.draft ? '' : ` data-real-id="${esc(device.id)}"`}
                style="left:${node.layout.x}px;top:${node.layout.y}px;width:${NODE_W}px;height:${NODE_H}px">
            ${ports}
            <div class="dev-node-head">
                <span class="dev-node-badge">${esc(TYPE_BADGE[device.type] || 'O')}</span>
                <span class="dev-node-name">${esc(device.name)}</span>
            </div>
            <div class="dev-node-meta">${esc(nodeMeta(device))}</div>
            <div class="dev-node-foot">
                <span class="dev-dot dev-dot-${status.state}"></span>
                <span>${node.draft ? t('dev.draft.chip') : t(STATUS_KEYS[status.state] || STATUS_KEYS.unknown)}</span>
                ${node.draft ? '' : `<span class="dev-node-report">${esc(lastReportText(status.last_report))}</span>`}
                ${color}
            </div>
        </div>`;
    }

    function renderCanvas() {
        const nodesBox = $('#devNodes');
        const canvas = $('#devCanvas');
        if (!nodesBox || !canvas) return;
        const nodes = [];
        for (const device of realDevices()) {
            nodes.push({key: device.id, device, layout: positionOf(device), draft: false});
        }
        if (draft) {
            nodes.push({key: draft.key, device: Object.assign({}, draft.device), layout: draft.layout, draft: true});
        }
        let maxX = CANVAS_MIN_W;
        let maxY = CANVAS_MIN_H;
        for (const node of nodes) {
            maxX = Math.max(maxX, node.layout.x + NODE_W + 260);
            maxY = Math.max(maxY, node.layout.y + NODE_H + 220);
        }
        canvas.style.width = maxX + 'px';
        canvas.style.height = maxY + 'px';
        const svg = $('#devWires');
        if (svg) {
            svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
            svg.setAttribute('width', String(maxX));
            svg.setAttribute('height', String(maxY));
        }
        nodesBox.innerHTML = nodes.map(nodeHtml).join('');
        $('#devCanvasEmpty')?.classList.toggle('hidden', nodes.length > 0);
        renderWires(nodes);
    }

    function wirePath(from, to) {
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }

    function renderWires(nodes) {
        const svg = $('#devWires');
        if (!svg) return;
        const list = nodes || [];
        const byId = new Map();
        for (const node of list) byId.set(node.key, node);
        const parts = [];
        for (const node of list) {
            if (node.draft) continue;
            const parentId = node.device.parent_id;
            const parent = parentId ? byId.get(parentId) : null;
            if (!parent) continue;
            const d = wirePath(parent.layout, node.layout);
            parts.push(`<path class="dev-wire" d="${d}"></path>`);
            parts.push(`<path class="dev-wire-hit" d="${d}" data-wire-child="${esc(node.device.id)}"><title>${esc(t('dev.wire.remove'))}</title></path>`);
        }
        if (wiring) {
            parts.push(`<path class="dev-wire dev-wire-draft" d="${draftWirePath(wiring.x1, wiring.y1, wiring.x2, wiring.y2)}"></path>`);
        }
        svg.innerHTML = parts.join('');
    }

    function draftWirePath(x1, y1, x2, y2) {
        const mx = (x1 + x2) / 2;
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }

    function canvasNodes() {
        const nodes = [];
        for (const device of realDevices()) {
            nodes.push({key: device.id, device, layout: positionOf(device), draft: false});
        }
        if (draft) nodes.push({key: draft.key, device: Object.assign({}, draft.device), layout: draft.layout, draft: true});
        return nodes;
    }

    function defaultSlot() {
        const count = realDevices().length + (draft ? 1 : 0);
        return {x: 80 + (count % 4) * 250, y: 80 + Math.floor(count / 4) * 140};
    }

    function defaultDraftName(type) {
        const label = typeLabel(type);
        const used = realDevices().filter(device => device.type === type).length + 1;
        return `${label} ${used}`;
    }

    function createDraft(type, x, y) {
        if (draft) {
            showToast(t('dev.draft.single'));
            return;
        }
        const slot = defaultSlot();
        const pos = {
            x: Math.max(0, Math.round(Number.isFinite(x) ? x : slot.x)),
            y: Math.max(0, Math.round(Number.isFinite(y) ? y : slot.y))
        };
        draft = {
            key: 'draft-' + (++draftSeq),
            layout: pos,
            device: {
                id: '',
                name: defaultDraftName(type),
                type,
                parent_id: null,
                bands: [],
                install_offset_deg: 0,
                exclusive: false,
                port_label: '',
                enabled: true,
                travel_timeout_sec: 120,
                notes: '',
                config: {},
                has_password: false,
                has_relay_token: false
            }
        };
        selectNode(draft.key);
    }

    function discardDraft() {
        if (!draft) return;
        const wasSelected = selectedId === draft.key;
        draft = null;
        if (wasSelected) {
            selectedId = null;
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
        }
        render();
    }

    async function confirmDiscard() {
        if (!formDirty) return true;
        return showConfirm(ctx, t('dev.draft.discard'), {danger: true});
    }

    async function selectNode(key) {
        if (key === selectedId) return;
        if (draft && selectedId === draft.key && formDirty && key !== draft.key) {
            const ok = await confirmDiscard();
            if (!ok) return;
            draft = null;
        }
        stopTower();
        selectedId = key;
        formDirty = false;
        formSignature = null;
        ctrlSignature = null;
        render();
    }

    function parentLabel(device) {
        if (!device || !device.parent_id) return t('dev.form.root');
        const parent = deviceById(device.parent_id);
        return parent ? parent.name : device.parent_id;
    }

    function configFields(value) {
        const config = value.config || {};
        if (value.type === 'rotator') {
            return `<label>${t('dev.config.host')}<input name="cfg_host" maxlength="100" value="${esc(config.host || '')}"></label>
                <label>${t('dev.config.port')}<input name="cfg_port" type="number" min="1" max="65535" step="1" value="${esc(config.port || '')}"></label>`;
        }
        if (value.type === 'matrix' || value.type === 'switch') {
            return `<label>${t('dev.config.relayUrl')}<input name="cfg_relay_url" maxlength="300" value="${esc(config.relay_url || '')}"></label>
                <label>${t('dev.config.relayToken')}<input name="cfg_relay_token" type="password" autocomplete="off" placeholder="${esc(t('dev.config.keepToken'))}"></label>
                <label>${t('dev.config.channels')}<textarea name="cfg_channels" rows="3" spellcheck="false">${esc(JSON.stringify(config.channels || {}))}</textarea></label>
                <label>${t('dev.config.pulse')}<input name="cfg_pulse_ms" type="number" min="50" max="5000" step="1" value="${esc(config.pulse_ms || '')}"></label>`;
        }
        if (value.type === 'tower') {
            return `<label>${t('dev.config.relayUrl')}<input name="cfg_relay_url" maxlength="300" value="${esc(config.relay_url || '')}"></label>
                <label>${t('dev.config.relayToken')}<input name="cfg_relay_token" type="password" autocomplete="off" placeholder="${esc(t('dev.config.keepToken'))}"></label>
                <label>${t('dev.config.upChannel')}<input name="cfg_up_channel" type="number" min="0" max="255" step="1" value="${esc(config.up_channel === undefined ? '' : config.up_channel)}"></label>
                <label>${t('dev.config.downChannel')}<input name="cfg_down_channel" type="number" min="0" max="255" step="1" value="${esc(config.down_channel === undefined ? '' : config.down_channel)}"></label>`;
        }
        return '';
    }

    function formHtml() {
        const value = selectedValue();
        if (!value) return '';
        const isDraft = !!selectedDraft();
        return `<form id="devFormEl" class="dev-form" data-dev-id="${esc(isDraft ? '' : value.id)}" data-draft="${isDraft ? '1' : '0'}">
            <h3>${t(isDraft ? 'dev.form.new' : 'dev.form.edit')}</h3>
            <div class="dev-grid">
                <label>${t('dev.form.name')}<input name="name" maxlength="60" required value="${esc(value.name)}"></label>
                <label>${t('dev.form.type')}
                    <input name="type" list="devTypeList" maxlength="32" required value="${esc(value.type)}">
                </label>
                <label>${t('dev.form.bands')}<input name="bands" placeholder="20m, 15m" value="${esc((value.bands || []).join(', '))}"></label>
                <label>${t('dev.form.offset')}<input name="install_offset_deg" type="number" min="0" max="359" step="1" value="${esc(value.install_offset_deg)}"></label>
                <label>${t('dev.form.port')}<input name="port_label" maxlength="32" value="${esc(value.port_label)}"></label>
                <label>${t('dev.form.password')}<input name="password" type="password" maxlength="200" autocomplete="new-password" placeholder="${esc(!isDraft && value.has_password ? t('dev.form.passwordKeep') : '')}"></label>
                <label>${t('dev.form.travel')}<input name="travel_timeout_sec" type="number" min="5" max="3600" step="1" value="${esc(value.travel_timeout_sec)}"></label>
                ${configFields(value)}
            </div>
            <p class="dev-note">${t('dev.form.parentFixed')} · ${esc(isDraft ? '—' : parentLabel(value))}</p>
            <label class="dev-check"><input name="exclusive" type="checkbox"${value.exclusive ? ' checked' : ''}> ${t('dev.form.exclusive')}</label>
            <label class="dev-check"><input name="enabled" type="checkbox"${value.enabled !== false ? ' checked' : ''}> ${t('dev.form.enabled')}</label>
            <label>${t('dev.form.notes')}<input name="notes" maxlength="200" value="${esc(value.notes)}"></label>
            <p class="dev-form-error hidden" id="devFormError"></p>
            <div class="dev-form-actions">
                <button class="dev-btn primary" type="submit">${t('save')}</button>
                ${isDraft ? '' : `<button class="dev-btn danger" type="button" id="devDelete">${t('danger')}</button>`}
            </div>
            <datalist id="devTypeList">
                ${TYPE_OPTIONS.map(type => `<option value="${type}">${esc(typeLabel(type))}</option>`).join('')}
            </datalist>
        </form>`;
    }

    function seatsHtml() {
        const view = seatsView();
        const header = `<h3>${t('dev.seat.title')}</h3>`;
        if (!view.seats.length) return header + `<p class="dev-empty">${t('dev.seat.none')}</p>`;
        const rows = view.seats.map(seat => {
            const item = view.by_seat[seat.seat] || {colors: {}, band: '', online: false};
            const chips = view.antennas.map(antenna => `<span class="dev-chip dev-color-${item.colors[antenna.id]}">${esc(antenna.name)}</span>`).join('');
            const notes = [];
            if (item.unassigned) notes.push(t('dev.seat.unassigned'));
            if (item.ambiguous) notes.push(t('dev.seat.ambiguous'));
            return `<tr class="${seat.seat === seatKey ? 'active' : ''}" data-dev-seat="${esc(seat.seat)}">
                <td>${esc(seat.seat)}</td>
                <td>${esc(seat.band || '—')}</td>
                <td><span class="dev-dot dev-dot-${seat.online ? 'online' : 'offline'}"></span>${seat.online ? t('dev.status.online') : t('dev.status.offline')}</td>
                <td>${chips || '—'}${notes.length ? `<div class="dev-note">${esc(notes.join(' · '))}</div>` : ''}</td>
            </tr>`;
        }).join('');
        return header + `<table class="dev-table">
            <thead><tr><th>${t('dev.seat.current')}</th><th>${t('dev.seat.band')}</th><th>${t('dev.seat.online')}</th><th>${t('dev.seat.antennas')}</th></tr></thead>
            <tbody>${rows}</tbody></table>
            <p class="dev-note">${t('dev.hint.offset')}</p>`;
    }

    function txHtml() {
        const view = snapshot.tx;
        let headline = t('dev.tx.none');
        if (view.state === 'interrupted') headline = t('dev.tx.interrupted');
        else if (view.state === 'ok' && view.current) {
            headline = t('dev.tx.current', {name: view.current.name});
            headline += ' · ' + (view.current.tx_active ? t('dev.tx.active') : t('dev.tx.idle'));
        }
        const rows = view.sources.map(source => `<tr>
            <td>${esc(source.name)}</td>
            <td>${source.priority}</td>
            <td>${t(HEALTH_KEYS[source.health] || HEALTH_KEYS.offline)}</td>
            <td>${source.tx_active === null ? '—' : (source.tx_active ? t('dev.tx.active') : t('dev.tx.idle'))}</td>
            <td>${esc(source.last_seen ? clock(source.last_seen) : t('dev.never'))}</td>
        </tr>`).join('');
        return `<h3>${t('dev.tx.title')}</h3>
            <p class="dev-tx-headline dev-tx-${view.state}">${esc(headline)}</p>
            ${rows ? `<table class="dev-table">
                <thead><tr><th>${t('dev.form.name')}</th><th>${t('dev.tx.priority')}</th><th>${t('dev.tx.health')}</th><th>TX</th><th>${t('dev.tx.lastSeen')}</th></tr></thead>
                <tbody>${rows}</tbody></table>` : ''}`;
    }

    function paletteHtml() {
        return PALETTE_TYPES.map(type => `<div class="dev-palette-item" draggable="true" role="button" tabindex="0" data-type="${esc(type)}">
            <span class="dev-node-badge">${esc(TYPE_BADGE[type] || 'O')}</span>
            <span>${esc(typeLabel(type))}</span>
        </div>`).join('');
    }

    function txPaletteHtml() {
        const view = snapshot.tx;
        const head = view.state === 'none'
            ? `<p class="dev-empty">${t('dev.tx.none')}</p>`
            : `<p class="dev-note">${esc(view.current ? view.current.name : t('dev.tx.interrupted'))}</p>`;
        const rows = view.sources.map(source => `<div class="dev-palette-tx-row">
            <span class="dev-dot dev-dot-${source.health === 'ok' ? 'online' : (source.health === 'stale' ? 'unknown' : 'offline')}"></span>
            <span class="dev-palette-tx-name">${esc(source.name)}</span>
            <span class="dev-chip">${source.priority}</span>
        </div>`).join('');
        return head + rows;
    }

    function controlHtml(device) {
        if (!device || !['rotator', 'matrix', 'switch', 'tower'].includes(device.type)) return '';
        const status = '<p class="dev-ctrl-status" id="devCtrlStatus"></p>';
        const error = '<p class="dev-form-error hidden" id="devCtrlError"></p>';
        const token = device.has_password
            ? `<label>${t('dev.control.deviceToken')}<input id="devCtrlToken" type="password" autocomplete="off"></label>`
            : '';
        const seatNote = `<p class="dev-note">${t('dev.control.seatNote', {seat: seatKey || '—'})}</p>`;
        if (device.type === 'rotator') {
            return `<h3>${t('dev.control.title')}</h3>${status}
                <div class="dev-ctrl-row">
                    <label>${t('dev.control.target')}<input id="devCtrlAzimuth" type="number" min="0" max="360" step="1" inputmode="numeric"></label>
                    <button class="dev-btn primary" type="button" data-cmd="rotate">${t('dev.control.rotate')}</button>
                    <button class="dev-btn" type="button" data-cmd="stop">${t('dev.control.stop')}</button>
                </div>
                ${token}${error}${seatNote}`;
        }
        if (device.type === 'matrix' || device.type === 'switch') {
            return `<h3>${t('dev.control.title')}</h3>${status}
                <div class="dev-ctrl-row">
                    <label>${t('dev.control.port')}<input id="devCtrlPort" maxlength="32"></label>
                    <label>${t('dev.control.outlet')}<input id="devCtrlOutlet" maxlength="32"></label>
                    <button class="dev-btn primary" type="button" data-cmd="select">${t('dev.control.select')}</button>
                </div>
                ${token}${error}${seatNote}`;
        }
        if (device.type === 'tower') {
            return `<h3>${t('dev.control.title')}</h3>${status}
                <div class="dev-ctrl-row">
                    <button class="dev-btn" type="button" data-tower="up">${t('dev.control.up')}</button>
                    <button class="dev-btn" type="button" data-tower="down">${t('dev.control.down')}</button>
                </div>
                ${token}${error}${seatNote}
                <p class="dev-note">${t('dev.control.holdHint')}</p>`;
        }
        return `<h3>${t('dev.control.title')}</h3>${status}${error}${seatNote}`;
    }

    function updateControlStatus(device) {
        const box = $('#devCtrlStatus');
        if (!box) return;
        const parts = [];
        const status = deviceStatus(device.id);
        parts.push(t(STATUS_KEYS[status.state] || STATUS_KEYS.unknown));
        if (device.type === 'rotator') {
            const rotator = (snapshot.rotators && snapshot.rotators[device.id]) || {};
            parts.push(t('dev.rotator.physical', {deg: rotator.physical_azimuth === null || rotator.physical_azimuth === undefined ? '—' : rotator.physical_azimuth}));
            parts.push(t('dev.rotator.target', {deg: rotator.target_azimuth === null || rotator.target_azimuth === undefined ? '—' : rotator.target_azimuth}));
            parts.push(t(MOTION_KEYS[rotator.motion_state] || MOTION_KEYS.unknown));
            parts.push(t('dev.control.lastCommander', {name: rotator.last_commander || '—'}));
        }
        const control = snapshot.controls && snapshot.controls[device.id];
        if (control && control.lease) parts.push(t('dev.control.lease', {seat: control.lease.seat}));
        if (control && control.ports) {
            const ports = Object.keys(control.ports).map(port => port + '→' + control.ports[port]).join(' ');
            if (ports) parts.push(ports);
        }
        box.textContent = parts.join(' · ');
    }

    function renderControl() {
        const container = $('#devControl');
        if (!container) return;
        const device = selectedDevice();
        if (!device) {
            container.innerHTML = selectedDraft() ? `<p class="dev-empty">${t('dev.control.draft')}</p>` : '';
            ctrlSignature = null;
            return;
        }
        const signature = [device.id, device.type, device.has_password ? 1 : 0].join('|');
        if (signature !== ctrlSignature) {
            container.innerHTML = controlHtml(device);
            ctrlSignature = signature;
        }
        updateControlStatus(device);
    }

    function showCtrlError(text) {
        const box = $('#devCtrlError');
        if (!box) return;
        box.textContent = text;
        box.classList.remove('hidden');
    }

    async function sendCommand(device, command) {
        const box = $('#devCtrlError');
        if (box) {
            box.textContent = '';
            box.classList.add('hidden');
        }
        if (!seatKey) {
            showCtrlError(t('dev.error.seat-required'));
            return;
        }
        const token = $('#devCtrlToken');
        try {
            const result = await sendDeviceCommand(device.id, command, {
                seat: seatKey,
                deviceToken: token ? token.value : ''
            });
            if (!result || !result.ok) {
                showCtrlError(errorText(result && result.error ? result.error : 'generic'));
                return;
            }
            await refresh();
        } catch (error) {
            const body = error && error.body;
            showCtrlError(errorText(body && body.error ? body.error : 'generic', {owner: body && body.owner}));
        }
    }

    function startTower(device, direction) {
        if (towerTimer) clearInterval(towerTimer);
        towerHoldDevice = device;
        towerDirection = direction;
        void sendCommand(device, {command: 'tower_hold', direction});
        // 按住期间每 500ms 续一次心跳，服务端 1500ms 收不到就释放。
        towerTimer = setInterval(() => {
            const current = towerHoldDevice;
            if (!current || towerDirection !== direction) {
                stopTower();
                return;
            }
            void sendCommand(current, {command: 'tower_hold', direction});
        }, 500);
    }

    function stopTower() {
        if (towerTimer) {
            clearInterval(towerTimer);
            towerTimer = null;
        }
        towerDirection = null;
        const device = towerHoldDevice;
        towerHoldDevice = null;
        if (device) void sendCommand(device, {command: 'tower_release'});
    }

    function seatOptions() {
        const seats = seatsView().seats;
        if (!seats.length) return `<option value="">—</option>`;
        return seats.map(seat => `<option value="${esc(seat.seat)}"${seat.seat === seatKey ? ' selected' : ''}>${esc(seat.seat)}${seat.band ? ' · ' + esc(seat.band) : ''}</option>`).join('');
    }

    function renderInspector() {
        const value = selectedValue();
        const title = $('#devInspectorTitle');
        if (title) title.textContent = value ? value.name : t('dev.inspector.title');
        const formBox = $('#devForm');
        if (!formBox) return;
        if (!value) {
            formBox.innerHTML = `<p class="dev-empty">${t('dev.inspector.none')}</p>`;
            formSignature = null;
            renderControl();
            return;
        }
        const signature = [selectedId, value.type, value.has_password ? 1 : 0].join('|');
        if (!formDirty && signature !== formSignature) {
            formBox.innerHTML = formHtml();
            formSignature = signature;
        }
        renderControl();
    }

    function renderMonitors() {
        $('#devSeats').innerHTML = seatsHtml();
        $('#devTx').innerHTML = txHtml();
        $('#devTxPalette').innerHTML = txPaletteHtml();
    }

    function render() {
        if (!snapshot) {
            $('#devSummary').textContent = '';
            $('#devNodes').innerHTML = '';
            $('#devWires').innerHTML = '';
            $('#devCanvasEmpty')?.classList.remove('hidden');
            $('#devForm').innerHTML = `<p class="dev-empty">${t('dev.error.generic')}</p>`;
            $('#devControl').innerHTML = '';
            $('#devInspectorTitle').textContent = t('dev.inspector.title');
            $('#devSeats').innerHTML = '';
            $('#devTx').innerHTML = '';
            $('#devTxPalette').innerHTML = '';
            formSignature = null;
            ctrlSignature = null;
            return;
        }
        const seats = seatsView().seats;
        $('#devSummary').textContent = t('dev.summary', {
            devices: snapshot.devices.length,
            seats: seats.length,
            antennas: snapshot.ownership.antennas.length
        }) + ' · ' + t('dev.hint.canvas');
        if (document.activeElement !== $('#devSeat')) {
            $('#devSeat').innerHTML = seatOptions();
        }
        renderPalette();
        renderCanvas();
        renderInspector();
        renderMonitors();
    }

    function renderPalette() {
        const box = $('#devPalette');
        if (box) box.innerHTML = paletteHtml();
    }

    function applyLayouts(snapshotData) {
        if (!localLayout) return;
        for (const id of Object.keys(localLayout)) {
            const device = snapshotData.devices.find(item => item.id === id);
            const local = localLayout[id];
            if (!device) {
                delete localLayout[id];
                continue;
            }
            if (device.layout_saved && device.layout && device.layout.x === local.x && device.layout.y === local.y) {
                delete localLayout[id];
            }
        }
        if (!Object.keys(localLayout).length) localLayout = null;
    }

    async function refresh() {
        if (busy || dragging || wiring) return;
        busy = true;
        try {
            const data = await getDevicesSnapshot();
            const next = data && data.ok ? data : null;
            if (!next) throw new Error('invalid snapshot');
            snapshot = next;
            applyLayouts(snapshot);
            const seats = snapshot.ownership.seats;
            if (!seatKey || !seats.some(seat => seat.seat === seatKey)) {
                const online = seats.find(seat => seat.online);
                seatKey = online ? online.seat : (seats.length ? seats[0].seat : null);
            }
            if (selectedId && !isDraftKey(selectedId) && !deviceById(selectedId)) {
                selectedId = null;
                formDirty = false;
                formSignature = null;
                ctrlSignature = null;
            }
            render();
        } catch (error) {
            // 读取失败不沿用旧值：整页回落到 unknown。
            snapshot = null;
            render();
        } finally {
            busy = false;
        }
    }

    function formValues(form) {
        const data = new FormData(form);
        const device = {
            name: String(data.get('name') || ''),
            type: String(data.get('type') || ''),
            bands: String(data.get('bands') || ''),
            install_offset_deg: String(data.get('install_offset_deg') || '0'),
            port_label: String(data.get('port_label') || ''),
            exclusive: data.get('exclusive') === 'on',
            enabled: data.get('enabled') === 'on',
            travel_timeout_sec: String(data.get('travel_timeout_sec') || '120'),
            notes: String(data.get('notes') || '')
        };
        if (form.dataset.devId) device.id = form.dataset.devId;
        const password = String(data.get('password') || '');
        if (password) device.password = password;
        device.config = formConfig(data, device.type);
        return device;
    }

    /** Protocol settings live under `config`; empty inputs clear the stored key. */
    function formConfig(data, type) {
        const config = {};
        if (type === 'rotator') {
            config.host = String(data.get('cfg_host') || '');
            config.port = String(data.get('cfg_port') || '');
            config.protocol = config.host ? 'rotctld' : '';
        } else if (type === 'matrix' || type === 'switch') {
            config.relay_url = String(data.get('cfg_relay_url') || '');
            const relayToken = String(data.get('cfg_relay_token') || '');
            if (relayToken) config.relay_token = relayToken;
            config.pulse_ms = String(data.get('cfg_pulse_ms') || '');
            const channelsText = String(data.get('cfg_channels') || '').trim();
            if (channelsText) {
                try {
                    config.channels = JSON.parse(channelsText);
                } catch (error) {
                    throw new Error('invalid-config-channels');
                }
            }
        } else if (type === 'tower') {
            config.relay_url = String(data.get('cfg_relay_url') || '');
            const relayToken = String(data.get('cfg_relay_token') || '');
            if (relayToken) config.relay_token = relayToken;
            config.up_channel = String(data.get('cfg_up_channel') || '');
            config.down_channel = String(data.get('cfg_down_channel') || '');
        }
        return config;
    }

    function apiError(error) {
        const body = error && error.body;
        return errorText(body && body.error ? body.error : 'generic');
    }

    async function persistDraftLayout(id) {
        if (!draft) return;
        const pos = draft.layout;
        try {
            await saveDeviceLayouts([{id, x: pos.x, y: pos.y}]);
        } catch (error) {
            // 位置写失败不影响设备本身，下一次刷新会用自动布局补位。
        }
    }

    async function submitForm(event) {
        event.preventDefault();
        const form = event.target;
        const errorBox = $('#devFormError');
        if (errorBox) {
            errorBox.textContent = '';
            errorBox.classList.add('hidden');
        }
        try {
            const values = formValues(form);
            const result = await saveDevice(values);
            if (!result || !result.ok) {
                if (errorBox) {
                    errorBox.textContent = errorText(result && result.error);
                    errorBox.classList.remove('hidden');
                }
                return;
            }
            const created = !form.dataset.devId;
            const id = result.device && result.device.id ? result.device.id : selectedId;
            if (created) {
                await persistDraftLayout(id);
                draft = null;
            }
            selectedId = id;
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
            await refresh();
        } catch (error) {
            if (errorBox) {
                errorBox.textContent = error && ERROR_KEYS[error.message] ? errorText(error.message) : apiError(error);
                errorBox.classList.remove('hidden');
            }
        }
    }

    async function removeSelected() {
        const device = selectedDevice();
        if (!device) return;
        const confirmed = await showConfirm(ctx, t('dev.confirmDelete'), {danger: true});
        if (!confirmed) return;
        try {
            const result = await deleteDevice(device.id);
            if (!result || !result.ok) {
                const errorBox = $('#devFormError');
                if (errorBox) {
                    errorBox.textContent = errorText(result && result.error);
                    errorBox.classList.remove('hidden');
                }
                return;
            }
            selectedId = null;
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    function wouldCycleClient(childId, parentId) {
        let cursor = parentId;
        const seen = new Set();
        while (cursor) {
            if (cursor === childId || seen.has(cursor)) return true;
            seen.add(cursor);
            const node = deviceById(cursor);
            cursor = node ? node.parent_id : null;
        }
        return false;
    }

    async function connectNodes(parentId, childId) {
        if (!parentId || !childId || parentId === childId) {
            showToast(t('dev.error.cycle'));
            return;
        }
        if (wouldCycleClient(childId, parentId)) {
            showToast(t('dev.error.cycle'));
            return;
        }
        try {
            const result = await saveDevice({id: childId, parent_id: parentId});
            if (!result || !result.ok) {
                showToast(errorText(result && result.error));
                return;
            }
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    async function removeWire(childId) {
        const node = deviceById(childId);
        if (!node) return;
        const confirmed = await showConfirm(ctx, t('dev.wire.remove'), {danger: true});
        if (!confirmed) return;
        try {
            const result = await saveDevice({id: childId, parent_id: null});
            if (!result || !result.ok) {
                showToast(errorText(result && result.error));
                return;
            }
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    function keyFromEvent(event) {
        const node = event.target.closest('[data-node-key]');
        return node ? node.dataset.nodeKey : null;
    }

    function nodeElement(key) {
        const nodes = document.querySelectorAll('#devNodes [data-node-key]');
        for (const node of nodes) {
            if (node.dataset.nodeKey === key) return node;
        }
        return null;
    }

    function beginDrag(key, event) {
        const base = isDraftKey(key) && draft ? draft.layout : positionOf(deviceById(key));
        dragging = {
            key,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: base.x,
            originY: base.y,
            x: base.x,
            y: base.y,
            moved: false
        };
        const node = nodeElement(key);
        try {
            if (node) node.setPointerCapture(event.pointerId);
        } catch (error) {
            // 某些浏览器不支持节点级捕获，window 监听仍可完成拖动。
        }
    }

    function moveDrag(event) {
        if (!dragging) return;
        const dx = event.clientX - dragging.startX;
        const dy = event.clientY - dragging.startY;
        if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        dragging.moved = true;
        dragging.x = Math.max(0, Math.round(dragging.originX + dx));
        dragging.y = Math.max(0, Math.round(dragging.originY + dy));
        const node = nodeElement(dragging.key);
        if (node) {
            node.style.left = dragging.x + 'px';
            node.style.top = dragging.y + 'px';
        }
        if (isDraftKey(dragging.key) && draft) {
            draft.layout = {x: dragging.x, y: dragging.y};
        }
        renderWires(canvasNodes());
    }

    async function endDrag() {
        if (!dragging) return;
        const drag = dragging;
        dragging = null;
        if (!drag.moved) return;
        if (isDraftKey(drag.key)) {
            if (draft) draft.layout = {x: drag.x, y: drag.y};
            renderCanvas();
            return;
        }
        localLayout = Object.assign({}, localLayout, {[drag.key]: {x: drag.x, y: drag.y}});
        try {
            const result = await saveDeviceLayouts([{id: drag.key, x: drag.x, y: drag.y}]);
            if (!result || !result.ok) throw new Error('layout rejected');
        } catch (error) {
            delete localLayout[drag.key];
            showToast(errorText('invalid-layout'));
        }
        renderCanvas();
    }

    function beginWire(node, event) {
        const key = node.dataset.nodeKey;
        if (isDraftKey(key)) {
            showToast(t('dev.wire.firstSave'));
            return;
        }
        const layoutPos = positionOf(deviceById(key));
        const rect = $('#devCanvas').getBoundingClientRect();
        wiring = {
            fromKey: key,
            x1: layoutPos.x + NODE_W,
            y1: layoutPos.y + NODE_H / 2,
            x2: event.clientX - rect.left,
            y2: event.clientY - rect.top
        };
        event.preventDefault();
        renderWires(canvasNodes());
    }

    function moveWire(event) {
        if (!wiring) return;
        const rect = $('#devCanvas').getBoundingClientRect();
        wiring.x2 = event.clientX - rect.left;
        wiring.y2 = event.clientY - rect.top;
        renderWires(canvasNodes());
    }

    async function endWire(event) {
        if (!wiring) return;
        const fromKey = wiring.fromKey;
        wiring = null;
        const x = event ? event.clientX : 0;
        const y = event ? event.clientY : 0;
        const targetEl = document.elementFromPoint(x, y);
        const targetNode = targetEl ? targetEl.closest('[data-node-key]') : null;
        renderWires(canvasNodes());
        if (!targetNode) return;
        const childKey = targetNode.dataset.nodeKey;
        if (childKey === fromKey) return;
        if (isDraftKey(childKey)) {
            showToast(t('dev.wire.firstSave'));
            return;
        }
        await connectNodes(fromKey, childKey);
    }

    function applyLabels() {
        $('#devTitle').textContent = t('dev.title');
        $('#devSubtitle').textContent = t('dev.subtitle');
        $('#devSeatLabel').textContent = t('dev.seat.current');
        $('#devRefresh').textContent = t('refresh');
        $('#devNew').textContent = t('dev.add');
        $('#devHint').textContent = t('dev.hint.server');
        $('#devPaletteTitle').textContent = t('dev.palette.title');
        $('#devPaletteHint').textContent = t('dev.palette.hint');
        $('#devTxPaletteTitle').textContent = t('dev.palette.tx');
        $('#devCanvasEmpty').textContent = t('dev.canvas.empty');
        $('#devInspectorTitle').textContent = t('dev.inspector.title');
        $('#devMonitorTitle').textContent = t('dev.monitor.title');
    }

    function init() {
        applyLabels();
        $('#devRefresh').addEventListener('click', () => { void refresh(); });
        $('#devNew').addEventListener('click', () => createDraft('antenna'));
        $('#devInspectorClose').addEventListener('click', () => {
            if (draft && selectedId === draft.key) {
                void confirmDiscard().then(ok => { if (ok) discardDraft(); });
                return;
            }
            selectedId = null;
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
            render();
        });
        $('#devSeat').addEventListener('change', event => {
            seatKey = event.target.value || null;
            render();
        });
        $('#devSeats').addEventListener('click', event => {
            const row = event.target.closest('[data-dev-seat]');
            if (!row) return;
            seatKey = row.dataset.devSeat;
            render();
        });

        $('#devPalette').addEventListener('dragstart', event => {
            const item = event.target.closest('[data-type]');
            if (!item) return;
            event.dataTransfer.setData('text/plain', item.dataset.type);
            event.dataTransfer.effectAllowed = 'copy';
        });
        $('#devPalette').addEventListener('dblclick', event => {
            const item = event.target.closest('[data-type]');
            if (item) createDraft(item.dataset.type);
        });
        $('#devPalette').addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const item = event.target.closest('[data-type]');
            if (!item) return;
            event.preventDefault();
            createDraft(item.dataset.type);
        });

        const canvas = $('#devCanvas');
        canvas.addEventListener('dragover', event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });
        canvas.addEventListener('drop', event => {
            event.preventDefault();
            const type = event.dataTransfer.getData('text/plain');
            if (!PALETTE_TYPES.includes(type)) return;
            const rect = canvas.getBoundingClientRect();
            createDraft(type, event.clientX - rect.left - NODE_W / 2, event.clientY - rect.top - NODE_H / 2);
        });
        canvas.addEventListener('click', event => {
            if (event.target.closest('[data-node-key]')) return;
            if (event.target.closest('[data-wire-child]')) return;
            if (draft && selectedId === draft.key) {
                void confirmDiscard().then(ok => { if (ok) discardDraft(); });
                return;
            }
            selectedId = null;
            formSignature = null;
            ctrlSignature = null;
            render();
        });

        $('#devNodes').addEventListener('pointerdown', event => {
            const port = event.target.closest('.dev-port-out');
            const node = event.target.closest('[data-node-key]');
            if (!node) return;
            if (port) {
                beginWire(node, event);
                return;
            }
            if (event.button !== undefined && event.button !== 0) return;
            const key = node.dataset.nodeKey;
            void (async () => {
                await selectNode(key);
                // 用户可能在「放弃草稿」确认里取消，此时不启动拖动。
                if (selectedId === key) beginDrag(key, event);
            })();
        });
        $('#devNodes').addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const key = keyFromEvent(event);
            if (!key) return;
            event.preventDefault();
            void selectNode(key);
        });
        $('#devWires').addEventListener('click', event => {
            const hit = event.target.closest('[data-wire-child]');
            if (hit) void removeWire(hit.dataset.wireChild);
        });

        window.addEventListener('pointermove', event => {
            moveDrag(event);
            moveWire(event);
        });
        window.addEventListener('pointerup', event => {
            void endDrag();
            void endWire(event);
        });

        $('#devControl').addEventListener('click', event => {
            const button = event.target.closest('[data-cmd]');
            const device = selectedDevice();
            if (!button || !device) return;
            const cmd = button.dataset.cmd;
            if (cmd === 'rotate') {
                const input = $('#devCtrlAzimuth');
                void sendCommand(device, {command: 'rotate', azimuth: input ? Number(input.value) : NaN});
            } else if (cmd === 'stop') {
                void sendCommand(device, {command: 'stop'});
            } else if (cmd === 'select') {
                const port = $('#devCtrlPort');
                const outlet = $('#devCtrlOutlet');
                void sendCommand(device, {
                    command: 'select',
                    port: port ? port.value : '',
                    outlet: outlet ? outlet.value : ''
                });
            }
        });
        $('#devControl').addEventListener('pointerdown', event => {
            const button = event.target.closest('[data-tower]');
            const device = selectedDevice();
            if (!button || !device) return;
            event.preventDefault();
            startTower(device, button.dataset.tower);
        });
        document.addEventListener('pointerup', stopTower);
        window.addEventListener('blur', stopTower);

        $('#devForm').addEventListener('submit', submitForm);
        $('#devForm').addEventListener('input', () => { formDirty = true; });
        $('#devForm').addEventListener('click', event => {
            if (event.target.id === 'devDelete') void removeSelected();
        });
        $('#devView').addEventListener('keydown', event => {
            if (event.key !== 'Delete') return;
            const tag = document.activeElement ? document.activeElement.tagName : '';
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
            if (selectedDevice()) void removeSelected();
        });
    }

    function show() {
        active = true;
        applyLabels();
        void refresh();
        if (timer) clearInterval(timer);
        timer = setInterval(() => {
            if (active && !document.hidden) void refresh();
        }, POLL_MS);
    }

    function hide() {
        active = false;
        stopTower();
        dragging = null;
        wiring = null;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    function resize() {
        renderWires(canvasNodes());
    }

    return {init, show, hide, refresh, resize};
}
