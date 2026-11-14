/**
 * Devices view: a global Node-RED style canvas.
 *
 * The canvas is a single global topology: devices and RF links are not
 * partitioned by seat. A radio owns the seat it belongs to (derived from
 * ComputerName + radio model reported by N1MM), not the other way round.
 *
 * Port semantics are fixed:
 *   - square  = RF port, connectable; `in` sits on the bottom edge
 *     and `out` on the top edge so wiring follows signal direction;
 *   - circle  = control / status port, never connectable to an RF wire.
 *
 * Palette drags out drafts; several drafts may coexist and saving is an
 * explicit action. Positions are layout-only data in SQLite.
 */
import {$, escapeHtml as esc, showToast, showConfirm} from '../ui.mjs';
import {
    getDevicesSnapshot,
    saveDevice,
    deleteDevice,
    saveDeviceLayouts,
    saveRfLink,
    deleteRfLink,
    saveControlLink,
    deleteControlLink,
    previewDrafts,
    saveDraftBatch,
    sendDeviceCommand
} from '../../shared/data/devices.mjs';
import {getSeatIdentities} from '../../shared/data/station.mjs';

const POLL_MS = 2000;
const NODE_W = 210;
const NODE_H = 84;
const CANVAS_MIN_W = 1600;
const CANVAS_MIN_H = 1000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
// 面板提供这十种可拖出的设备；前五种是射频链路组成部分，后五种是机械与射频路由支撑。
const PALETTE_TYPES = ['radio', 'swr', 'bpf', 'amp', 'antenna', 'tower', 'rotator', 'switch', 'matrix', 'combiner', 'serial'];
const TYPE_BADGE = {
    radio: 'RIG', swr: 'SW', bpf: 'BP', amp: 'PA', antenna: 'AN', tower: 'TW', rotator: 'RT',
    switch: 'CX', matrix: 'MX', divider: 'DV', combiner: 'CB', serial: 'SS', other: 'OT'
};
// 控制口之间的连线表达“串口设备 → 串口服务器”的从属关系；与 RF 链路无关。
const CONTROL_TYPES = ['rotator', 'tower', 'switch', 'matrix', 'amp', 'swr', 'serial'];
const SERIAL_BAUD = ['1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'];
// 唯一波段来源与 lib/radio/bands.js 保持一致；一律勾选，不允许手输。
const BAND_OPTIONS = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '2m', '70cm'];
const BAND_TYPES = ['amp', 'bpf', 'antenna', 'combiner'];
const TRAVEL_TYPES = ['tower', 'rotator'];
const RELAY_TYPES = ['switch', 'matrix', 'tower'];
const STATUS_KEYS = {
    online: 'dev.status.online',
    offline: 'dev.status.offline',
    unknown: 'dev.status.unknown',
    'no-source': 'dev.status.noSource',
    unbound: 'dev.status.unbound',
    awaiting: 'dev.status.awaiting'
};
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
    'unknown-port': 'dev.error.unknown-port',
    'unknown-link': 'dev.error.unknown-link',
    'invalid-link': 'dev.error.invalid-link',
    'unknown-parent': 'dev.error.unknown-parent',
    'combiner-band-required': 'dev.error.combiner-band-required',
    'bpf-band-required': 'dev.error.bpf-band-required',
    'invalid-config-ports': 'dev.error.invalid-config-ports',
    'invalid-config-port-key': 'dev.error.invalid-config-port-key',
    'invalid-config-port-dir': 'dev.error.invalid-config-port-dir',
    'invalid-config-port-band': 'dev.error.invalid-config-port-band',
    'invalid-config-out_count': 'dev.error.invalid-config-out_count',
    'invalid-config-in_count': 'dev.error.invalid-config-in_count',
    'invalid-config-baud': 'dev.error.invalid-config-baud',
    'invalid-config-databits': 'dev.error.invalid-config-databits',
    'invalid-config-stopbits': 'dev.error.invalid-config-stopbits',
    'invalid-config-parity': 'dev.error.invalid-config-parity',
    'unknown-control-port': 'dev.error.unknown-control-port',
    'invalid-control-port': 'dev.error.invalid-control-port',
    'serial-server-required': 'dev.error.serial-server-required',
    'control-port-busy': 'dev.error.control-port-busy',
    'rf-port-busy': 'dev.error.rf-port-busy',
    'too-many-links': 'dev.error.too-many-links',
    'invalid-band': 'dev.error.invalid-band',
    'device-locked': 'dev.error.device-locked',
    'device-disabled': 'dev.error.device-disabled',
    'invalid-azimuth': 'dev.error.invalid-azimuth',
    'transport-error': 'dev.error.transport-error',
    'transport-timeout': 'dev.error.transport-timeout',
    'transport-connect': 'dev.error.transport-connect',
    'transport-protocol': 'dev.error.transport-protocol',
    'transport-not-configured': 'dev.error.transport-not-configured',
    'tx-active': 'dev.error.tx-active',
    'invalid-config': 'dev.error.invalid-config',
    'invalid-amp-brand': 'dev.error.invalid-amp-brand',
    'invalid-amp-model': 'dev.error.invalid-amp-model',
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
    'too-many-layouts': 'dev.error.too-many-layouts',
    'seat-required': 'dev.error.seat-required',
    'mixed-ports': 'dev.error.mixed-ports'
};

export function createDevicesPage(ctx) {
    let active = false;
    let busy = false;
    let snapshot = null;
    let drafts = [];
    let selectedKeys = new Set();
    let commandSeat = null;
    let draftSeq = 0;
    let formDirty = false;
    let formSignature = null;
    let ctrlSignature = null;
    let timer = null;
    let towerTimer = null;
    let towerHoldDevice = null;
    let towerDirection = null;
    let dragging = null;
    let marquee = null;
    let wiring = null;
    let rfWiring = null;
    let ctlWiring = null;
    let localLayout = null;
    // 画布缩放：transform-origin 在左上角，所有指针坐标统一除以 zoom 回到画布坐标系。
    let zoom = 1;
    let panning = null;
    let spaceHeld = false;
    // 草稿阶段的端口与连线：只活在页面内存里，保存全部时随设备一起落库。
    let draftPorts = {rf: {}, ctl: {}};
    let draftRfLinks = [];
    let draftCtlLinks = [];
    let draftAddresses = {};
    let draftPreviewSeq = 0;
    // 电台属性下拉的 N1MM 候选：由服务端从已收报文汇聚，失败时保留旧值展示。
    let n1mmCandidate = {status: 'idle', data: null, loadedAt: 0, seq: 0};

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

    /** 状态文案：通信中断时把原因一并说出来，不再只给一个「未知」。 */
    function statusText(status) {
        const value = status || {};
        const label = t(STATUS_KEYS[value.state] || STATUS_KEYS.unknown);
        return value.error ? t('dev.status.withError', {status: label, reason: errorText(value.error)}) : label;
    }

    /** 数值读数格式化：缺失时给 —，避免卡片出现 NaN。 */
    function metric(value, digits = 1) {
        return Number.isFinite(value) ? Number(value).toFixed(digits) : '—';
    }

    // ---- 功放品牌/型号描述表（服务端 amp-models.js 是唯一数据源） ----
    function ampCatalog() {
        return (snapshot && snapshot.amp_models) || {brands: [], generic: null};
    }

    function ampBrands() {
        return ampCatalog().brands || [];
    }

    /** 解析设备配置对应的型号定义；未选或「其他」时用通用定义。 */
    function ampDefinitionFor(config) {
        const source = config || {};
        const brandId = String(source.brand || '');
        const modelId = String(source.model || '');
        const catalog = ampCatalog();
        // 明确选「其他品牌」时按手工填写处理，不再拿型号去猜协议。
        if (modelId && modelId !== 'other' && brandId !== 'other') {
            const brands = ampBrands().filter(item => !brandId || item.id === brandId);
            for (const brand of brands) {
                const found = (brand.models || []).find(item => item.id === modelId);
                if (found) return found;
            }
        }
        return catalog.generic || null;
    }

    function ampStatusItems(config, cardOnly) {
        const definition = ampDefinitionFor(config);
        const items = (definition && definition.status) || [];
        return cardOnly ? items.filter(item => item.card) : items;
    }

    /** 一项状态按描述表里的 kind 读出可展示文本；没有读数时留空。 */
    function ampItemText(item, amp) {
        if (!item || !amp) return '';
        const value = amp[item.key];
        if (item.kind === 'freq') {
            return Number.isFinite(value) ? (value / 1e6).toFixed(3) + ' MHz' : '';
        }
        if (item.kind === 'band') return amp.band || '';
        if (item.kind === 'state') {
            if (value === 1) return t(item.on);
            if (value === 0) return t(item.off);
            return '';
        }
        if (item.kind === 'flag') return value === item.when ? t(item.label) : '';
        if (item.kind === 'enum') {
            const key = item.values && item.values[value];
            return key ? t(key) : '';
        }
        if (item.kind === 'metric') {
            const digits = Number.isInteger(item.digits) ? item.digits : 1;
            const text = metric(value, digits);
            return `${t(item.label)} ${text}${item.unit ? ' ' + item.unit : ''}`;
        }
        if (item.kind === 'alarm') {
            return value ? `${t(item.label)} 0x${Number(amp.alarm_word || 0).toString(16).toUpperCase()}` : '';
        }
        if (item.kind === 'fault') {
            return value ? `${t(item.label)} ${amp.fault_code || amp.alarm_word}` : '';
        }
        if (item.kind === 'text') return value ? String(value) : '';
        return '';
    }

    function ampFieldHtml(field, values) {
        const raw = values[field.key];
        const value = raw === undefined || raw === null || raw === '' ? field.default : raw;
        const shown = value === undefined || value === null ? '' : value;
        if (field.type === 'number') {
            return `<label>${esc(t(field.label))}<input name="cfg_${esc(field.key)}" type="number"
                min="${esc(field.min)}" max="${esc(field.max)}" step="${esc(field.step || 1)}"
                value="${esc(shown)}"></label>`;
        }
        if (field.type === 'select') {
            const options = (field.options || []).map(item =>
                `<option value="${esc(item.value)}"${String(item.value) === String(shown) ? ' selected' : ''}>${esc(t(item.label))}</option>`).join('');
            return `<label>${esc(t(field.label))}<select name="cfg_${esc(field.key)}">${options}</select></label>`;
        }
        const type = field.type === 'password' ? 'password' : 'text';
        const extra = field.type === 'password'
            ? ` autocomplete="off" placeholder="${esc(t(field.placeholder || 'dev.config.keepPassword'))}" value="${esc(shown)}"`
            : ` maxlength="${esc(field.maxlength || 100)}" value="${esc(shown)}"`;
        return `<label>${esc(t(field.label))}<input name="cfg_${esc(field.key)}" type="${type}"${extra}></label>`;
    }

    /** 型号决定字段集合；values 是当前表单里已填的内容（切换型号时原样带入）。 */
    function ampConfigFields(config, values) {
        const merged = Object.assign({}, config || {}, values || {});
        const brandId = String(merged.brand || '');
        const modelId = String(merged.model || '');
        const brandOptions = [`<option value="">${esc(t('dev.config.brandNone'))}</option>`]
            .concat(ampBrands().map(brand =>
                `<option value="${esc(brand.id)}"${brandId === brand.id ? ' selected' : ''}>${esc(brand.name)}</option>`))
            .concat([`<option value="other"${brandId === 'other' ? ' selected' : ''}>${esc(t('dev.config.brandOther'))}</option>`]);
        const brand = ampBrands().find(item => item.id === brandId);
        const models = brand ? (brand.models || []) : [];
        // 品牌换了以后，旧型号不再属于当前品牌，按「未指定」处理。
        const modelValue = modelId === 'other' || models.some(item => item.id === modelId) ? modelId : '';
        const modelOptions = [`<option value="">${esc(t('dev.config.modelNone'))}</option>`]
            .concat(models.map(model => {
                const unsupported = model.supported === false;
                const suffix = unsupported ? ' · ' + t('dev.config.communityOnly') : '';
                return `<option value="${esc(model.id)}"${modelValue === model.id ? ' selected' : ''}${unsupported ? ' disabled' : ''}>${esc(model.name + suffix)}</option>`;
            }))
            .concat([`<option value="other"${modelValue === 'other' ? ' selected' : ''}>${esc(t('dev.config.modelOther'))}</option>`]);
        const definition = ampDefinitionFor(Object.assign({}, merged, {model: modelValue}));
        const protocol = definition ? String(definition.protocol || 'mqtt') : 'mqtt';
        const fields = definition ? (definition.fields || []) : [];
        return `<div class="dev-config-fields" id="devConfigFields">
            <label>${t('dev.config.brand')}<select name="cfg_brand">${brandOptions.join('')}</select></label>
            <label>${t('dev.config.ampModel')}<select name="cfg_amp_model">${modelOptions.join('')}</select></label>
            <p class="dev-note">${t('dev.config.resolvedProtocol', {protocol: protocol.toUpperCase()})}</p>
            ${definition && definition.hint ? `<p class="dev-note">${esc(t(definition.hint))}</p>` : ''}
            ${fields.map(field => ampFieldHtml(field, merged)).join('')}
        </div>`;
    }

    /** 只重绘功放配置字段：切型号不重置已填写的地址与凭据。 */
    function refreshAmpConfigFields() {
        const box = document.getElementById('devConfigFields');
        if (!box) return;
        const values = {};
        for (const input of box.querySelectorAll('input[name^="cfg_"]')) {
            values[input.name.slice(4)] = input.value;
        }
        const brandSelect = box.querySelector('select[name="cfg_brand"]');
        const modelSelect = box.querySelector('select[name="cfg_amp_model"]');
        values.brand = brandSelect ? brandSelect.value : '';
        values.model = modelSelect ? modelSelect.value : '';
        box.outerHTML = ampConfigFields(values, values);
        formDirty = true;
    }

    function radioLiveText(status) {        const radio = status && status.radio;
        if (!radio || !Number.isFinite(radio.freq_khz)) return '';
        return t('dev.radio.live', {
            freq: (radio.freq_khz / 1000).toFixed(3),
            mode: radio.mode || '—',
            tx: t(radio.is_transmitting ? 'dev.radio.txOn' : 'dev.radio.txOff')
        });
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

    function draftByKey(key) {
        return drafts.find(item => item.key === key) || null;
    }

    function isDraftKey(key) {
        return !!draftByKey(key);
    }

    function selectedValue() {
        if (selectedKeys.size !== 1) return null;
        const key = [...selectedKeys][0];
        const draft = draftByKey(key);
        if (draft) return Object.assign({}, draft.device, {layout: draft.layout});
        return deviceById(key);
    }

    function positionOf(device) {
        if (!device) return {x: 80, y: 80};
        if (localLayout && localLayout[device.id]) return localLayout[device.id];
        return device.layout || {x: 80, y: 80};
    }

    function rfView() {
        return snapshot && snapshot.rf ? snapshot.rf : {links: [], ports: {}, control: {}, warnings: []};
    }

    function rfPorts(deviceId) {
        const ports = rfView().ports || {};
        if (Array.isArray(ports[deviceId])) return ports[deviceId];
        return Array.isArray(draftPorts.rf[deviceId]) ? draftPorts.rf[deviceId] : [];
    }

    function controlPorts(deviceId) {
        const ports = rfView().control || {};
        if (Array.isArray(ports[deviceId])) return ports[deviceId];
        return Array.isArray(draftPorts.ctl[deviceId]) ? draftPorts.ctl[deviceId] : [];
    }

    /** 已保存设备与草稿共用一套端口/连线渲染，草稿用页面内的临时 key 当 id。 */
    function nodeById(id) {
        const device = deviceById(id);
        if (device) return device;
        const draft = draftByKey(id);
        return draft ? Object.assign({}, draft.device, {id: draft.key}) : null;
    }

    function nodePosition(id) {
        const draft = draftByKey(id);
        if (draft) return draft.layout;
        const device = deviceById(id);
        return device ? positionOf(device) : {x: 0, y: 0};
    }

    /* ---- 画布缩放与平移 ------------------------------------------------ */

    /**
     * 以某个客户端坐标为锚点缩放：先把锚点换算成画布坐标，缩放后再反推滚动位置，
     * 这样光标下的那一点在缩放前后保持不动。
     */
    function applyZoom(next, anchor) {
        const wrap = $('#devCanvasWrap');
        const canvas = $('#devCanvas');
        const stage = $('#devCanvasStage');
        if (!wrap || !canvas || !stage) return;
        const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
        const rect = wrap.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const point = anchor || {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
        const localX = point.x - rect.left;
        const localY = point.y - rect.top;
        const contentX = (wrap.scrollLeft + localX) / zoom;
        const contentY = (wrap.scrollTop + localY) / zoom;
        zoom = clamped;
        canvas.style.transform = `scale(${zoom})`;
        stage.style.width = `${canvas.offsetWidth * zoom}px`;
        stage.style.height = `${canvas.offsetHeight * zoom}px`;
        wrap.scrollLeft = contentX * zoom - localX;
        wrap.scrollTop = contentY * zoom - localY;
        const label = $('#devZoomValue');
        if (label) label.textContent = `${Math.round(zoom * 100)}%`;
    }

    function zoomBy(factor, anchor) {
        applyZoom(zoom * factor, anchor);
    }

    /** 适应全部：把所有卡片（含草稿）框进视口，最大回到 150%，避免单台设备被放得过大。 */
    function fitAll() {
        const wrap = $('#devCanvasWrap');
        if (!wrap) return;
        const nodes = canvasNodes();
        if (!nodes.length) {
            applyZoom(1);
            wrap.scrollLeft = 0;
            wrap.scrollTop = 0;
            return;
        }
        const pad = 80;
        const minX = Math.min(...nodes.map(node => node.layout.x));
        const minY = Math.min(...nodes.map(node => node.layout.y));
        const maxX = Math.max(...nodes.map(node => node.layout.x + NODE_W));
        const maxY = Math.max(...nodes.map(node => node.layout.y + NODE_H));
        const width = Math.max(1, maxX - minX) + pad * 2;
        const height = Math.max(1, maxY - minY) + pad * 2;
        const rect = wrap.getBoundingClientRect();
        const next = Math.min(1.5, rect.width / width, rect.height / height);
        applyZoom(Math.max(MIN_ZOOM, next));
        wrap.scrollLeft = (minX - pad) * zoom;
        wrap.scrollTop = (minY - pad) * zoom;
    }

    function resetZoom() {
        applyZoom(1);
    }

    function beginPan(event) {
        const wrap = $('#devCanvasWrap');
        if (!wrap) return;
        panning = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: wrap.scrollLeft,
            top: wrap.scrollTop
        };
        wrap.classList.add('panning');
        try { wrap.setPointerCapture(event.pointerId); } catch (error) { /* 捕获失败不影响滚动逻辑 */ }
        event.preventDefault();
    }

    function movePan(event) {
        if (!panning) return;
        const wrap = $('#devCanvasWrap');
        if (!wrap) return;
        wrap.scrollLeft = panning.left - (event.clientX - panning.x);
        wrap.scrollTop = panning.top - (event.clientY - panning.y);
    }

    function endPan() {
        if (!panning) return;
        panning = null;
        $('#devCanvasWrap')?.classList.remove('panning');
    }

    function controlLinks() {
        return Array.isArray(snapshot && snapshot.control_links) ? snapshot.control_links : [];
    }

    /** 已保存连线 + 页面内存里的草稿连线，统一给渲染层用。 */
    function rfLinksForRender() {
        return (rfView().links || []).map(link => Object.assign({}, link, {pending: false}))
            .concat(draftRfLinks.map(link => Object.assign({}, link, {pending: true})));
    }

    function controlLinksForRender() {
        return controlLinks().map(link => Object.assign({}, link, {pending: false}))
            .concat(draftCtlLinks.map(link => Object.assign({}, link, {pending: true})));
    }

    function controlAddress(deviceId) {
        const map = (snapshot && snapshot.control_addresses) || {};
        if (map[deviceId]) return map[deviceId];
        return draftAddresses[deviceId] || null;
    }

    /** 控制口坐标：卡片左缘竖排；圆形只连控制口，不参与 RF。 */
    function controlPortPoint(deviceId, portKey) {
        const device = nodeById(deviceId);
        if (!device) return null;
        const ports = controlPorts(deviceId);
        const index = ports.findIndex(port => port.key === portKey);
        if (index < 0) return null;
        const pos = nodePosition(deviceId);
        return {
            x: pos.x,
            y: pos.y + ((index + 1) / (ports.length + 1)) * NODE_H
        };
    }

    /** RF 端口坐标：in 在下边、out 在上边，同向端口均分。 */
    function rfPortPoint(deviceId, portKey) {
        const device = nodeById(deviceId);
        if (!device) return null;
        const ports = rfPorts(deviceId);
        const port = ports.find(item => item.key === portKey);
        if (!port) return null;
        const same = ports.filter(item => item.dir === port.dir);
        const index = same.indexOf(port);
        const pos = nodePosition(deviceId);
        return {
            x: pos.x + ((index + 1) / (same.length + 1)) * NODE_W,
            y: port.dir === 'out' ? pos.y : pos.y + NODE_H,
            dir: port.dir
        };
    }

    function rfWirePath(from, to) {
        const bend = 46;
        const c1 = from.y + (from.dir === 'out' ? -bend : bend);
        const c2 = to.y + (to.dir === 'in' ? bend : -bend);
        return `M${from.x},${from.y} C${from.x},${c1} ${to.x},${c2} ${to.x},${to.y}`;
    }

    function rfWarningText(warning) {
        const item = warning || {};
        if (item.code === 'antenna-multi-upstream') {
            return t('dev.rf.warn.multiUpstream', {
                name: item.name || item.device_id,
                count: item.count
            });
        }
        if (item.code === 'combiner-antenna-band-uncovered') {
            return t('dev.rf.warn.combinerCoverage', {
                combiner: item.combiner_id,
                antenna: item.antenna_id,
                bands: (item.missing || []).join(', ')
            });
        }
        if (item.code === 'rf-link-orphan') return t('dev.rf.warn.orphan');
        return '';
    }

    function seatsView() {
        return snapshot ? snapshot.ownership : {seats: [], by_seat: {}, antennas: []};
    }

    function seatColors() {
        if (!snapshot || !commandSeat) return null;
        return snapshot.ownership.by_seat[commandSeat] || null;
    }

    function antennaColor(antennaId) {
        const view = seatColors();
        return view && view.colors[antennaId] ? view.colors[antennaId] : 'green';
    }

    function deviceStatus(id) {
        return (snapshot && snapshot.status[id]) || {state: 'unknown', last_report: null};
    }

    function nodeMeta(device) {
        const parts = [];
        if (device.type === 'radio' && device.seat) parts.push(t('dev.node.seat', {seat: device.seat}));
        if (device.type === 'radio' && !device.seat) parts.push(t('dev.radio.unbound'));
        if (device.type === 'radio' && snapshot) {
            const live = radioLiveText(snapshot.status[device.id]);
            if (live) parts.push(live);
        }
        if (device.bands && device.bands.length) parts.push(t('dev.bands', {bands: device.bands.join(' ')}));
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
        if (device.type === 'amp' && snapshot) {
            const amp = (deviceStatus(device.id) || {}).amp;
            if (amp) {
                for (const item of ampStatusItems(device.config, true)) {
                    const text = ampItemText(item, amp);
                    if (text) parts.push(text);
                }
            }
        }
        return parts.join(' · ');
    }

    function antennaChip(device) {
        if (device.type !== 'antenna' || !snapshot) return '';
        const antenna = snapshot.ownership.antennas.find(item => item.id === device.id);
        const owners = antenna && Array.isArray(antenna.owners) ? antenna.owners.length : 0;
        if (!owners) return `<span class="dev-chip dev-color-green">${t('dev.color.green')}</span>`;
        const color = commandSeat && antenna.color_by_seat[commandSeat] ? antenna.color_by_seat[commandSeat] : 'yellow';
        return `<span class="dev-chip dev-color-${color}">${t('dev.antenna.owners', {n: owners})}</span>`;
    }

    function rfPortsHtml(device) {
        const ports = rfPorts(device.id);
        if (!ports.length) return '';
        const html = ports.filter(port => port.dir !== 'bidir').map(port => {
            const same = ports.filter(item => item.dir === port.dir);
            const index = same.indexOf(port);
            const title = port.band ? `${port.key} · ${port.band}` : port.key;
            return `<span class="dev-rf-port dev-rf-${port.dir}" style="left:${((index + 1) / (same.length + 1)) * 100}%"
                data-rf-device="${esc(device.id)}" data-rf-port="${esc(port.key)}" title="${esc(title)}"></span>`;
        }).join('');
        return html ? `<div class="dev-rf-ports">${html}</div>` : '';
    }

    function controlPortsHtml(device) {
        const ports = controlPorts(device.id);
        if (!ports.length) return '';
        return `<div class="dev-ctl-ports">${ports.map((port, index) => {
            const label = port.kind === 'control' ? t('dev.port.control') : t('dev.port.status');
            const connectable = port.kind === 'control';
            return `<span class="dev-ctl-port dev-ctl-${esc(port.kind)}" style="top:${((index + 1) / (ports.length + 1)) * 100}%"
                ${connectable ? `data-ctl-device="${esc(device.id)}" data-ctl-port="${esc(port.key)}"` : ''}
                title="${esc(port.key)} · ${esc(label)}"></span>`;
        }).join('')}</div>`;
    }

    function nodeHtml(node) {
        const device = node.device;
        const status = node.draft ? {state: 'unknown', last_report: null} : deviceStatus(device.id);
        const classes = ['dev-canvas-node'];
        if (selectedKeys.has(node.key)) classes.push('active');
        if (node.draft) classes.push('draft');
        return `<div class="${classes.join(' ')}" role="button" tabindex="0" data-node-key="${esc(node.key)}"${node.draft ? '' : ` data-real-id="${esc(device.id)}"`}
                style="left:${node.layout.x}px;top:${node.layout.y}px;width:${NODE_W}px;height:${NODE_H}px">
            <span class="dev-mount-handle" title="${esc(t('dev.mount.handle'))}" aria-hidden="true"></span>
            ${controlPortsHtml(device)}
            ${rfPortsHtml(device)}
            <div class="dev-node-head">
                <span class="dev-node-badge">${esc(TYPE_BADGE[device.type] || 'O')}</span>
                <span class="dev-node-name">${esc(device.name)}</span>
            </div>
            <div class="dev-node-meta">${esc(nodeMeta(device))}</div>
            <div class="dev-node-foot">
                <span class="dev-dot dev-dot-${status.state}"></span>
                <span>${node.draft ? t('dev.draft.chip') : statusText(status)}</span>
                ${node.draft ? '' : `<span class="dev-node-report">${esc(lastReportText(status.last_report))}</span>`}
                ${node.draft ? '' : antennaChip(device)}
            </div>
        </div>`;
    }

    function canvasNodes() {
        const nodes = [];
        for (const device of realDevices()) {
            nodes.push({key: device.id, device, layout: positionOf(device), draft: false});
        }
        for (const draft of drafts) {
            nodes.push({
                key: draft.key,
                device: Object.assign({}, draft.device, {id: draft.key}),
                layout: draft.layout,
                draft: true
            });
        }
        return nodes;
    }

    function renderCanvas() {
        const nodesBox = $('#devNodes');
        const canvas = $('#devCanvas');
        if (!nodesBox || !canvas) return;
        const nodes = canvasNodes();
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
        for (const link of rfLinksForRender()) {
            if (!byId.has(link.a_device) || !byId.has(link.b_device)) continue;
            const from = rfPortPoint(link.a_device, link.a_port);
            const to = rfPortPoint(link.b_device, link.b_port);
            if (!from || !to) continue;
            const d = rfWirePath(from, to);
            parts.push(`<path class="dev-rf-wire${link.pending ? ' dev-rf-wire-pending' : ''}" d="${d}"></path>`);
            parts.push(`<path class="dev-rf-wire-hit" d="${d}" data-rf-link="${esc(link.link_id)}"${link.pending ? ' data-rf-pending="1"' : ''}><title>${esc(t('dev.rf.remove'))}</title></path>`);
        }
        for (const link of controlLinksForRender()) {
            if (!byId.has(link.a_device) || !byId.has(link.b_device)) continue;
            const from = controlPortPoint(link.a_device, link.a_port);
            const to = controlPortPoint(link.b_device, link.b_port);
            if (!from || !to) continue;
            const d = controlWirePath(from, to);
            parts.push(`<path class="dev-ctl-wire${link.pending ? ' dev-ctl-wire-pending' : ''}" d="${d}"></path>`);
            parts.push(`<path class="dev-ctl-wire-hit" d="${d}" data-ctl-link="${esc(link.link_id)}"${link.pending ? ' data-ctl-pending="1"' : ''}><title>${esc(t('dev.ctl.remove'))}</title></path>`);
        }
        if (wiring) {
            parts.push(`<path class="dev-wire dev-wire-draft" d="${draftWirePath(wiring.x1, wiring.y1, wiring.x2, wiring.y2)}"></path>`);
        }
        if (ctlWiring) {
            parts.push(`<path class="dev-ctl-wire dev-ctl-wire-draft" d="${draftWirePath(ctlWiring.x1, ctlWiring.y1, ctlWiring.x2, ctlWiring.y2)}"></path>`);
        }
        if (rfWiring) {
            const from = {x: rfWiring.x1, y: rfWiring.y1, dir: rfWiring.dir};
            const to = {x: rfWiring.x2, y: rfWiring.y2, dir: rfWiring.dir === 'out' ? 'in' : 'out'};
            parts.push(`<path class="dev-rf-wire dev-rf-wire-draft" d="${rfWirePath(from, to)}"></path>`);
        }
        svg.innerHTML = parts.join('');
    }

    function draftWirePath(x1, y1, x2, y2) {
        const mx = (x1 + x2) / 2;
        return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }

    function controlWirePath(from, to) {
        // 控制线绕到卡片左侧，避免与射频线（上/下缘）混在一起。
        const offset = 60;
        const x1 = from.x - 4;
        const x2 = to.x - 4;
        const c1 = x1 - offset;
        const c2 = x2 - offset;
        return `M${x1},${from.y} C${c1},${from.y} ${c2},${to.y} ${x2},${to.y}`;
    }

    function defaultSlot() {
        const count = realDevices().length + drafts.length;
        return {x: 80 + (count % 4) * 250, y: 80 + Math.floor(count / 4) * 150};
    }

    /**
     * 默认名按类型分别递增：已保存设备与草稿一起参与计数，取同类型里最小的未占用序号，
     * 这样连续加草稿不会重名，删掉中间某一台后再新建也不会和现存设备撞名。
     */
    function defaultDraftName(type) {
        const label = typeLabel(type);
        const pattern = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\d+)$');
        const names = new Set();
        const numbers = new Set();
        for (const device of realDevices().concat(drafts.map(item => item.device))) {
            if (!device || device.type !== type) continue;
            const name = String(device.name || '').trim();
            if (!name) continue;
            names.add(name);
            const match = name.match(pattern);
            if (match) numbers.add(Number(match[1]));
        }
        let index = 1;
        while (numbers.has(index) || names.has(`${label} ${index}`)) index += 1;
        return `${label} ${index}`;
    }

    function createDraft(type, x, y) {
        const slot = defaultSlot();
        const pos = {
            x: Math.max(0, Math.round(Number.isFinite(x) ? x : slot.x)),
            y: Math.max(0, Math.round(Number.isFinite(y) ? y : slot.y))
        };
        const draft = {
            key: 'draft-' + (++draftSeq),
            layout: pos,
            device: {
                id: '',
                name: defaultDraftName(type),
                type,
                parent_id: null,
                bands: [],
                install_offset_deg: 0,
                enabled: true,
                travel_timeout_sec: TRAVEL_TYPES.includes(type) ? 120 : 0,
                notes: '',
                config: {},
                has_relay_token: false
            }
        };
        drafts.push(draft);
        selectedKeys = new Set([draft.key]);
        formDirty = false;
        formSignature = null;
        ctrlSignature = null;
        render();
        void refreshDraftPreview();
    }

    function discardDraft(key) {
        drafts = drafts.filter(item => item.key !== key);
        dropDraftLinksFor(key);
        if (selectedKeys.delete(key)) {
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
        }
        render();
        void refreshDraftPreview();
    }

    /* ---- 草稿连线：只存在于页面内存，服务端只做校验与最终落库 ---- */

    function draftPayload() {
        return drafts.map(item => Object.assign({}, item.device, {id: item.key}));
    }

    function dropDraftLinksFor(id) {
        draftRfLinks = draftRfLinks.filter(link => link.a_device !== id && link.b_device !== id);
        draftCtlLinks = draftCtlLinks.filter(link => link.a_device !== id && link.b_device !== id);
    }

    /** 单台草稿保存时只带走两端都已存在的连线，另一端还是草稿的先留在内存。 */
    function draftLinksSaveable(key, list) {
        return list.filter(link => {
            if (link.a_device !== key && link.b_device !== key) return false;
            const other = link.a_device === key ? link.b_device : link.a_device;
            return !isDraftKey(other);
        });
    }

    function remapDraftLinks(fromKey, toId) {
        const swap = link => Object.assign({}, link, {
            a_device: link.a_device === fromKey ? toId : link.a_device,
            b_device: link.b_device === fromKey ? toId : link.b_device
        });
        draftRfLinks = draftRfLinks.map(swap);
        draftCtlLinks = draftCtlLinks.map(swap);
    }

    /** 只保留两端都还在画布上的草稿连线，避免删设备后留下悬空线。 */
    function pruneDraftLinks() {
        const alive = new Set(realDevices().map(device => device.id).concat(drafts.map(item => item.key)));
        draftRfLinks = draftRfLinks.filter(link => alive.has(link.a_device) && alive.has(link.b_device));
        draftCtlLinks = draftCtlLinks.filter(link => alive.has(link.a_device) && alive.has(link.b_device));
    }

    function previewError(result) {
        return errorText((result && result.error) || 'generic');
    }

    /** 非 2xx 时 transport 会抛 HttpError，真正的业务错误码在 error.body 里。 */
    function apiFailure(error) {
        const body = error && error.body && typeof error.body === 'object' ? error.body : null;
        if (body && body.error) return body;
        return {ok: false, error: 'generic', message: apiError(error)};
    }

    async function requestBatch(payload) {
        try {
            const result = await saveDraftBatch(payload);
            return result || {ok: false, error: 'generic'};
        } catch (error) {
            return apiFailure(error);
        }
    }

    /**
     * 用服务端的同一套规则校验草稿拓扑，成功后草稿端口/连线/寻址整体换新。
     * 传入 extra 可以临时叠加一条候选连线，用于拖拽当下给出接受或拒绝。
     */
    async function previewState(extra) {
        const seq = ++draftPreviewSeq;
        try {
            const result = await previewDrafts(Object.assign({
                devices: draftPayload(),
                rf_links: draftRfLinks,
                control_links: draftCtlLinks
            }, extra || {}));
            if (seq !== draftPreviewSeq) return null;
            if (!result || !result.ok) return result || {ok: false, error: 'generic'};
            draftPorts = {rf: result.ports || {}, ctl: result.control || {}};
            draftRfLinks = Array.isArray(result.rf_links) ? result.rf_links : [];
            draftCtlLinks = Array.isArray(result.control_links) ? result.control_links : [];
            draftAddresses = result.addresses || {};
            return result;
        } catch (error) {
            if (seq !== draftPreviewSeq) return null;
            return apiFailure(error);
        }
    }

    async function refreshDraftPreview() {
        if (!drafts.length) {
            draftPorts = {rf: {}, ctl: {}};
            draftRfLinks = [];
            draftCtlLinks = [];
            draftAddresses = {};
            render();
            return;
        }
        pruneDraftLinks();
        const result = await previewState();
        if (result && !result.ok) {
            // 已有草稿连线在当前拓扑下不再成立：清掉并给出提示，避免保存时才发现。
            draftRfLinks = [];
            draftCtlLinks = [];
            showToast(previewError(result));
        }
        render();
    }

    function selectNode(key, additive) {
        if (additive) {
            if (selectedKeys.has(key)) selectedKeys.delete(key);
            else selectedKeys.add(key);
        } else {
            selectedKeys = new Set([key]);
        }
        stopTower();
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

    function radioSeatLabel(value) {
        if (!value || value.type !== 'radio') return '';
        return value.seat || t('dev.radio.unbound');
    }

    function bandPicker(value) {
        const chosen = new Set((value.bands || []).map(band => String(band).toLowerCase()));
        return `<fieldset class="dev-bands"><legend>${t('dev.form.bands')}</legend>
            ${BAND_OPTIONS.map(band => `<label class="dev-band">
                <input type="checkbox" name="bands" value="${band}"${chosen.has(band) ? ' checked' : ''}> ${band}
            </label>`).join('')}
        </fieldset>`;
    }

    /* ---- 电台 ComputerName / 型号下拉：候选来自 N1MM 报文 ---------------- */

    const CANDIDATE_TTL_MS = 15000;

    function candidateKey(value) {
        return String(value || '').trim().toLowerCase();
    }

    function candidatePairs() {
        const data = n1mmCandidate.data;
        return data && Array.isArray(data.pairs) ? data.pairs : [];
    }

    function candidateComputers() {
        const data = n1mmCandidate.data;
        return data && Array.isArray(data.computers) ? data.computers : [];
    }

    function candidateRadios() {
        const data = n1mmCandidate.data;
        return data && Array.isArray(data.radios) ? data.radios : [];
    }

    /** 型号候选按所选 ComputerName 过滤；该机器只有 ContactInfo 时回退到全量型号。 */
    function candidateRadiosFor(computerName) {
        const key = candidateKey(computerName);
        if (!key) return candidateRadios();
        const names = new Map();
        for (const pair of candidatePairs()) {
            if (!pair.radioName || candidateKey(pair.computerName) !== key) continue;
            const radioKey = candidateKey(pair.radioName);
            const previous = names.get(radioKey);
            if (!previous || String(pair.lastSeen || '') > String(previous.lastSeen || '')) {
                names.set(radioKey, {name: pair.radioName, lastSeen: pair.lastSeen || null});
            }
        }
        return names.size ? [...names.values()] : candidateRadios();
    }

    function candidateEmpty() {
        return !candidateComputers().length && !candidateRadios().length;
    }

    function candidatePlaceholder(computerName) {
        if (candidateEmpty()) return t('dev.radio.candidates.empty');
        if (computerName && !candidateRadiosFor(computerName).length) return t('dev.radio.candidates.noModel');
        return '—';
    }

    /** 计算机名下拉的占位：报文里只有型号、没有 ComputerName 时要说清楚。 */
    function computerPlaceholder() {
        if (candidateEmpty()) return t('dev.radio.candidates.empty');
        if (!candidateComputers().length) return t('dev.radio.candidates.noComputer');
        return '—';
    }

    function candidateNoteText() {
        const status = n1mmCandidate.status;
        if (status === 'error') return t('dev.radio.candidates.error');
        if (status === 'idle' || status === 'loading') return t('dev.radio.candidates.loading');
        if (candidateEmpty()) return t('dev.radio.candidates.empty');
        const stamp = n1mmCandidate.data && n1mmCandidate.data.updatedAt
            ? clock(n1mmCandidate.data.updatedAt) : '—';
        if (!candidateComputers().length) {
            return t('dev.radio.candidates.partial', {count: candidateRadios().length, time: stamp});
        }
        return t('dev.radio.candidates.ready', {count: candidateComputers().length, time: stamp});
    }

    /**
     * 生成下拉选项：候选值 + 当前值。当前值即使已不在候选集里也必须保留，
     * 否则刷新候选会把已有配置清掉；没有候选时把提示放进下拉，避免空列表。
     */
    function candidateOptions(entries, current, placeholder) {
        const list = [];
        const seen = new Set();
        const push = (name, label) => {
            const key = candidateKey(name);
            if (!name || seen.has(key)) return;
            seen.add(key);
            list.push({name, label: label || name});
        };
        const currentInList = entries.some(entry => candidateKey(entry.name) === candidateKey(current));
        if (current) push(current, currentInList ? current : `${current} ${t('dev.radio.candidates.keep')}`);
        for (const entry of entries) push(entry.name, entry.name);
        if (!list.length) {
            return `<option value="" selected disabled>${esc(placeholder || '—')}</option>`;
        }
        const options = [];
        // 没有当前值时留一个空选项：候选只作建议，不替用户默认选中。
        if (!current) options.push('<option value="" selected>—</option>');
        options.push(...list.map(item =>
            `<option value="${esc(item.name)}"${item.name === current ? ' selected' : ''}>${esc(item.label)}</option>`));
        if (!entries.length && placeholder) {
            // 候选为空时仍把“尚未收到报文”明确写在下拉里。
            const selected = current ? '' : ' selected';
            options.push(`<option value="" disabled${selected}>${esc(placeholder)}</option>`);
        }
        return options.join('');
    }

    function fillCandidateSelect(select, entries, current, placeholder) {
        if (!select) return;
        select.innerHTML = candidateOptions(entries, current, placeholder);
        if (current) select.value = current;
    }

    function candidateMismatch(computerName, radioName) {
        if (!computerName || !radioName || candidateEmpty()) return false;
        const cn = candidateKey(computerName);
        const rn = candidateKey(radioName);
        if (!candidateComputers().some(item => candidateKey(item.name) === cn)) return true;
        return !candidatePairs().some(pair =>
            candidateKey(pair.computerName) === cn && candidateKey(pair.radioName) === rn);
    }

    /** 只重绘两个下拉与提示，不整表重渲染，避免冲掉其他未保存的输入。 */
    function refreshCandidateControls() {
        const form = $('#devFormEl');
        if (!form) return;
        const computerSelect = form.querySelector('select[name="cfg_computer"]');
        const modelSelect = form.querySelector('select[name="cfg_model"]');
        if (!computerSelect || !modelSelect) return;
        const computer = computerSelect.value;
        const model = modelSelect.value;
        fillCandidateSelect(computerSelect, candidateComputers(), computer, computerPlaceholder());
        fillCandidateSelect(modelSelect, candidateRadiosFor(computer), model, candidatePlaceholder(computer));
        const note = $('#devCandidateNote');
        if (note) note.textContent = candidateNoteText();
        const hint = $('#devCandidateHint');
        if (hint) {
            const mismatch = candidateMismatch(computer, model);
            hint.textContent = mismatch ? t('dev.radio.candidates.mismatch') : '';
            hint.classList.toggle('hidden', !mismatch);
        }
    }

    async function loadCandidates(force) {
        const now = Date.now();
        if (!force) {
            if (n1mmCandidate.status === 'loading') return;
            if (n1mmCandidate.status !== 'idle' && now - n1mmCandidate.loadedAt < CANDIDATE_TTL_MS) return;
        }
        n1mmCandidate.seq += 1;
        const seq = n1mmCandidate.seq;
        n1mmCandidate.status = 'loading';
        refreshCandidateControls();
        try {
            const data = await getSeatIdentities();
            if (seq !== n1mmCandidate.seq) return;
            const candidates = data && data.candidates ? data.candidates : null;
            const empty = !candidates ||
                (!(candidates.computers || []).length && !(candidates.radios || []).length);
            n1mmCandidate = {status: empty ? 'empty' : 'ready', data: candidates, loadedAt: Date.now(), seq};
        } catch (error) {
            if (seq !== n1mmCandidate.seq) return;
            // 读取失败保留旧候选，已有配置与可选项不因一次失败消失。
            n1mmCandidate = {status: 'error', data: n1mmCandidate.data, loadedAt: Date.now(), seq};
        }
        refreshCandidateControls();
    }

    function configFields(value) {
        const config = value.config || {};
        if (value.type === 'radio') {
            // ComputerName 与型号都来自 N1MM 实收报文，手工输入改为下拉；
            // 当前配置即使不在候选集里也保留，并在下方提示是否为已知组合。
            const computer = String(config.computer || '');
            const model = String(config.model || '');
            return `<label>${t('dev.form.computer')}<select name="cfg_computer">${candidateOptions(candidateComputers(), computer, computerPlaceholder())}</select></label>
                <label>${t('dev.form.model')}<select name="cfg_model">${candidateOptions(candidateRadiosFor(computer), model, candidatePlaceholder(computer))}</select></label>
                <div class="dev-candidate-row">
                    <span class="dev-note" id="devCandidateNote">${esc(candidateNoteText())}</span>
                    <button class="dev-btn" type="button" id="devCandidateRefresh">${esc(t('dev.radio.candidates.refresh'))}</button>
                </div>
                <p class="dev-note dev-candidate-hint hidden" id="devCandidateHint"></p>`;
        }
        if (value.type === 'amp') {
            return ampConfigFields(config);
        }
        if (value.type === 'swr') {
            return `<label>${t('dev.form.reportHost')}<input name="cfg_host" maxlength="100" value="${esc(config.host || '')}"></label>
                <label>${t('dev.config.port')}<input name="cfg_port" type="number" min="1" max="65535" step="1" value="${esc(config.port || '')}"></label>`;
        }
        if (value.type === 'rotator') {
            return `<label>${t('dev.config.host')}<input name="cfg_host" maxlength="100" value="${esc(config.host || '')}"></label>
                <label>${t('dev.config.port')}<input name="cfg_port" type="number" min="1" max="65535" step="1" value="${esc(config.port || '')}"></label>`;
        }
        if (value.type === 'serial') {
            const baud = String(config.baud || 9600);
            const option = (list, current) => list.map(item =>
                `<option value="${item}"${String(item) === current ? ' selected' : ''}>${item}</option>`).join('');
            return `<label>${t('dev.config.host')}<input name="cfg_host" maxlength="100" value="${esc(config.host || '')}"></label>
                <label>${t('dev.config.listenPort')}<input name="cfg_port" type="number" min="1" max="65535" step="1" value="${esc(config.port || '')}"></label>
                <label>${t('dev.config.serialPorts')}<input name="cfg_port_count" type="number" min="1" max="16" step="1" value="${esc(config.port_count === undefined ? 4 : config.port_count)}"></label>
                <label>${t('dev.config.baud')}<select name="cfg_baud">${option(SERIAL_BAUD, baud)}</select></label>
                <label>${t('dev.config.dataBits')}<select name="cfg_data_bits">${option(['5', '6', '7', '8'], String(config.data_bits || 8))}</select></label>
                <label>${t('dev.config.stopBits')}<select name="cfg_stop_bits">${option(['1', '2'], String(config.stop_bits || 1))}</select></label>
                <label>${t('dev.config.parity')}<select name="cfg_parity">${option(['none', 'even', 'odd'], String(config.parity || 'none'))}</select></label>`;
        }
        if (RELAY_TYPES.includes(value.type)) {
            const counts = value.type === 'switch'
                ? `<label>${t('dev.config.outCount')}<input name="cfg_out_count" type="number" min="1" max="16" step="1" value="${esc(config.out_count === undefined ? '' : config.out_count)}"></label>`
                : (value.type === 'matrix'
                    ? `<label>${t('dev.config.inCount')}<input name="cfg_in_count" type="number" min="1" max="16" step="1" value="${esc(config.in_count === undefined ? '' : config.in_count)}"></label>
                       <label>${t('dev.config.outCount')}<input name="cfg_out_count" type="number" min="1" max="16" step="1" value="${esc(config.out_count === undefined ? '' : config.out_count)}"></label>`
                    : '');
            const channels = value.type === 'tower'
                ? `<label>${t('dev.config.upChannel')}<input name="cfg_up_channel" type="number" min="0" max="255" step="1" value="${esc(config.up_channel === undefined ? '' : config.up_channel)}"></label>
                   <label>${t('dev.config.downChannel')}<input name="cfg_down_channel" type="number" min="0" max="255" step="1" value="${esc(config.down_channel === undefined ? '' : config.down_channel)}"></label>`
                : `<label>${t('dev.config.channels')}<textarea name="cfg_channels" rows="3" spellcheck="false">${esc(JSON.stringify(config.channels || {}))}</textarea></label>`;
            return `<label>${t('dev.config.relayUrl')}<input name="cfg_relay_url" maxlength="300" value="${esc(config.relay_url || '')}"></label>
                <label>${t('dev.config.relayToken')}<input name="cfg_relay_token" type="password" autocomplete="off" placeholder="${esc(t('dev.config.keepToken'))}"></label>
                <label>${t('dev.config.pulse')}<input name="cfg_pulse_ms" type="number" min="50" max="5000" step="1" value="${esc(config.pulse_ms || '')}"></label>
                ${counts}${channels}`;
        }
        return '';
    }

    function controlAddressLabel(value, id) {
        if (!value || !CONTROL_TYPES.includes(value.type)) return '';
        const address = controlAddress(id || value.id);
        if (!address || address.mode === 'unconfigured') return t('dev.control.unconfigured');
        if (address.mode === 'direct') {
            if (address.url) return t('dev.control.directUrl', {url: address.url});
            return t('dev.control.directAddress', {host: address.host, port: address.port});
        }
        const serial = address.serial || {};
        return t('dev.control.serialAddress', {
            host: address.host,
            port: address.port,
            serial: address.serial_port,
            baud: serial.baud,
            format: `${serial.data_bits || 8}${String(serial.parity || 'none').charAt(0).toUpperCase()}${serial.stop_bits || 1}`,
            via: address.via
        });
    }

    function formHtml() {
        const value = selectedValue();
        if (!value) return '';
        const key = selectedKeys.size === 1 ? [...selectedKeys][0] : '';
        const isDraft = !!draftByKey(key);
        const bands = BAND_TYPES.includes(value.type) ? bandPicker(value) : '';
        const offset = value.type === 'antenna'
            ? `<label>${t('dev.form.offset')}<input name="install_offset_deg" type="number" min="0" max="359" step="1" value="${esc(value.install_offset_deg || 0)}"></label>`
            : '';
        const travel = TRAVEL_TYPES.includes(value.type)
            ? `<label>${t('dev.form.travel')}<input name="travel_timeout_sec" type="number" min="5" max="3600" step="1" value="${esc(value.travel_timeout_sec || 120)}"></label>`
            : '';
        const seat = value.type === 'radio'
            ? `<p class="dev-note">${t('dev.form.seat')} · ${esc(radioSeatLabel(value))}</p>`
            : '';
        return `<form id="devFormEl" class="dev-form" data-dev-id="${esc(isDraft ? '' : value.id)}" data-draft="${isDraft ? '1' : '0'}">
            <h3>${t(isDraft ? 'dev.form.new' : 'dev.form.edit')}</h3>
            <div class="dev-form-type"><span class="dev-node-badge">${esc(TYPE_BADGE[value.type] || 'O')}</span>${esc(typeLabel(value.type))}</div>
            <div class="dev-grid">
                <label>${t('dev.form.name')}<input name="name" maxlength="60" required value="${esc(value.name)}"></label>
                ${configFields(value)}
                ${bands}
                ${offset}
                ${travel}
            </div>
            ${seat}
            <p class="dev-note">${t('dev.form.address')} · ${esc(controlAddressLabel(value, isDraft ? key : value.id) || '—')}</p>
            <p class="dev-note">${t('dev.form.parentFixed')} · ${esc(isDraft ? '—' : parentLabel(value))}</p>
            <p class="dev-note">${t('dev.form.rfPorts')} · ${esc(isDraft ? '—' : (rfPorts(value.id).map(port => port.band ? `${port.key} (${port.band})` : port.key).join(' · ') || '—'))}</p>
            <label class="dev-check"><input name="enabled" type="checkbox"${value.enabled !== false ? ' checked' : ''}> ${t('dev.form.enabled')}</label>
            <label>${t('dev.form.notes')}<input name="notes" maxlength="200" value="${esc(value.notes)}"></label>
            <p class="dev-form-error hidden" id="devFormError"></p>
            <div class="dev-form-actions">
                <button class="dev-btn primary" type="submit">${t('save')}</button>
                ${isDraft ? '' : `<button class="dev-btn danger" type="button" id="devDelete">${t('danger')}</button>`}
            </div>
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
            return `<tr>
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

    function seatOptions() {
        const seats = seatsView().seats;
        if (!seats.length) return '<option value="">—</option>';
        if (!commandSeat || !seats.some(seat => seat.seat === commandSeat)) {
            const online = seats.find(seat => seat.online);
            commandSeat = online ? online.seat : seats[0].seat;
        }
        return seats.map(seat => `<option value="${esc(seat.seat)}"${seat.seat === commandSeat ? ' selected' : ''}>${esc(seat.seat)}</option>`).join('');
    }

    function controlHtml(device) {
        if (!device || !['rotator', 'matrix', 'switch', 'tower', 'amp'].includes(device.type)) return '';
        const status = '<p class="dev-ctrl-status" id="devCtrlStatus"></p>';
        const error = '<p class="dev-form-error hidden" id="devCtrlError"></p>';
        const seat = `<label>${t('dev.control.seat')}<select id="devCtrlSeat">${seatOptions()}</select></label>`;
        if (device.type === 'rotator') {
            return `<h3>${t('dev.control.title')}</h3>${status}
                <div class="dev-ctrl-row">
                    <label>${t('dev.control.target')}<input id="devCtrlAzimuth" type="number" min="0" max="360" step="1" inputmode="numeric"></label>
                    <button class="dev-btn primary" type="button" data-cmd="rotate">${t('dev.control.rotate')}</button>
                    <button class="dev-btn" type="button" data-cmd="stop">${t('dev.control.stop')}</button>
                </div>
                <div class="dev-ctrl-row">${seat}</div>${error}`;
        }
        if (device.type === 'matrix' || device.type === 'switch') {
            const portHint = device.type === 'switch' ? t('dev.control.switchHint') : t('dev.control.matrixHint');
            return `<h3>${t('dev.control.title')}</h3>${status}
                <div class="dev-ctrl-row">
                    <label>${t('dev.control.port')}<input id="devCtrlPort" maxlength="32" placeholder="in"></label>
                    <label>${t('dev.control.outlet')}<input id="devCtrlOutlet" maxlength="32" placeholder="ant1"></label>
                    <button class="dev-btn primary" type="button" data-cmd="select">${t('dev.control.select')}</button>
                </div>
                <div class="dev-ctrl-row">${seat}</div>
                <p class="dev-note">${esc(portHint)}</p>${error}`;
        }
        if (device.type === 'amp') {
            const definition = ampDefinitionFor(device.config);
            // 可控制项由型号描述表给出；未选型号时用通用定义（常规操作，不含校准）。
            const buttons = ((definition && definition.controls) || []).map(control =>
                `<button class="dev-btn${control.primary ? ' primary' : ''}" type="button" data-cmd="amp_set"
                    data-amp="${esc(control.action)}" data-amp-delta="${esc(JSON.stringify(control.delta || {}))}">${esc(t(control.label))}</button>`).join('');
            return `<h3>${t('dev.control.title')}</h3>${status}
                <div class="dev-ctrl-row">${buttons}</div>
                <div class="dev-ctrl-row">${seat}</div>
                <p class="dev-note">${esc(t('dev.amp.controlHint'))}</p>${error}`;
        }
        return `<h3>${t('dev.control.title')}</h3>${status}
            <div class="dev-ctrl-row">
                <button class="dev-btn" type="button" data-tower="up">${t('dev.control.up')}</button>
                <button class="dev-btn" type="button" data-tower="down">${t('dev.control.down')}</button>
            </div>
            <div class="dev-ctrl-row">${seat}</div>
            <p class="dev-note">${t('dev.control.holdHint')}</p>${error}`;
    }

    function updateControlStatus(device) {
        const box = $('#devCtrlStatus');
        if (!box) return;
        const parts = [];
        const status = deviceStatus(device.id);
        parts.push(statusText(status));
        if (device.type === 'rotator') {
            const rotator = (snapshot.rotators && snapshot.rotators[device.id]) || {};
            parts.push(t('dev.rotator.physical', {deg: rotator.physical_azimuth === null || rotator.physical_azimuth === undefined ? '—' : rotator.physical_azimuth}));
            parts.push(t('dev.rotator.target', {deg: rotator.target_azimuth === null || rotator.target_azimuth === undefined ? '—' : rotator.target_azimuth}));
            parts.push(t(MOTION_KEYS[rotator.motion_state] || MOTION_KEYS.unknown));
            parts.push(t('dev.control.lastCommander', {name: rotator.last_commander || '—'}));
        }
        if (device.type === 'amp') {
            const amp = (status && status.amp) || {};
            for (const item of ampStatusItems(device.config, false)) {
                const text = ampItemText(item, amp);
                if (text) parts.push(text);
            }
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
        const value = selectedValue();
        if (!value || isDraftKey([...selectedKeys][0] || '')) {
            container.innerHTML = selectedKeys.size === 1 ? `<p class="dev-empty">${t('dev.control.draft')}</p>` : '';
            ctrlSignature = null;
            return;
        }
        const signature = [value.id, value.type,
            (value.config && value.config.brand) || '', (value.config && value.config.model) || ''].join('|');
        if (signature !== ctrlSignature) {
            container.innerHTML = controlHtml(value);
            ctrlSignature = signature;
        }
        updateControlStatus(value);
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
        if (!commandSeat) {
            showCtrlError(t('dev.error.seat-required'));
            return;
        }
        try {
            const result = await sendDeviceCommand(device.id, command, {seat: commandSeat});
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

    function renderInspector() {
        const value = selectedValue();
        const title = $('#devInspectorTitle');
        if (title) title.textContent = value ? value.name : t('dev.inspector.title');
        const formBox = $('#devForm');
        if (!formBox) return;
        if (!value) {
            formBox.innerHTML = selectedKeys.size > 1
                ? `<p class="dev-empty">${t('dev.inspector.multi', {n: selectedKeys.size})}</p>`
                : `<p class="dev-empty">${t('dev.inspector.none')}</p>`;
            formSignature = null;
            renderControl();
            return;
        }
        const signature = [value.id || 'draft', value.type].join('|');
        if (!formDirty && signature !== formSignature) {
            formBox.innerHTML = formHtml();
            formSignature = signature;
            if (value.type === 'radio') {
                // 先用缓存渲染，再异步刷新候选；下拉改由服务端候选集驱动。
                refreshCandidateControls();
                void loadCandidates(false);
            }
        }
        renderControl();
    }

    function renderMonitors() {
        $('#devSeats').innerHTML = seatsHtml();
        $('#devTx').innerHTML = txHtml();
        $('#devTxPalette').innerHTML = txPaletteHtml();
    }

    function render() {
        const saveAll = $('#devSaveAll');
        if (saveAll) saveAll.hidden = !drafts.length;
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
        const warnings = (rfView().warnings || []).map(rfWarningText).filter(Boolean);
        $('#devHint').textContent = warnings.length ? warnings.join(' · ') : t('dev.hint.server');
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
        if (busy || dragging || wiring || rfWiring || ctlWiring || marquee) return;
        busy = true;
        try {
            const data = await getDevicesSnapshot();
            const next = data && data.ok ? data : null;
            if (!next) throw new Error('invalid snapshot');
            snapshot = next;
            applyLayouts(snapshot);
            const seats = snapshot.ownership.seats;
            if (commandSeat && !seats.some(seat => seat.seat === commandSeat)) commandSeat = null;
            for (const key of [...selectedKeys]) {
                if (!isDraftKey(key) && !deviceById(key)) selectedKeys.delete(key);
            }
            pruneDraftLinks();
            render();
        } catch (error) {
            // 读取失败不沿用旧值：整页回落到 unknown。
            snapshot = null;
            render();
        } finally {
            busy = false;
        }
    }

    function checkedBands(form) {
        return [...form.querySelectorAll('input[name="bands"]:checked')].map(input => input.value);
    }

    function formValues(form) {
        const data = new FormData(form);
        const value = selectedValue();
        const type = value ? value.type : '';
        const device = {
            type,
            name: String(data.get('name') || ''),
            enabled: data.get('enabled') === 'on',
            notes: String(data.get('notes') || '')
        };
        if (form.dataset.devId) device.id = form.dataset.devId;
        if (BAND_TYPES.includes(type)) device.bands = checkedBands(form);
        if (type === 'antenna') device.install_offset_deg = String(data.get('install_offset_deg') || '0');
        if (TRAVEL_TYPES.includes(type)) device.travel_timeout_sec = String(data.get('travel_timeout_sec') || '120');
        device.config = formConfig(data, type);
        return device;
    }

    /** Protocol settings live under `config`; empty inputs clear the stored key. */
    function formConfig(data, type) {
        const config = {};
        if (type === 'radio') {
            config.computer = String(data.get('cfg_computer') || '');
            config.model = String(data.get('cfg_model') || '');
        } else if (type === 'amp') {
            config.brand = String(data.get('cfg_brand') || '');
            config.model = String(data.get('cfg_amp_model') || '');
            const definition = ampDefinitionFor(config);
            config.protocol = (definition && definition.protocol) || 'mqtt';
            // 只提交该型号真正显示的字段；没显示的键不出现在 config 里，
            // 服务端按“未提供则沿用旧值”处理，切型号不会清掉地址和凭据。
            for (const field of (definition && definition.fields) || []) {
                const raw = data.get('cfg_' + field.key);
                if (raw === null) continue;
                const value = String(raw);
                if (field.type === 'password') {
                    if (value) config[field.key] = value;
                    continue;
                }
                config[field.key] = value;
            }
        } else if (type === 'swr' || type === 'rotator') {
            config.host = String(data.get('cfg_host') || '');
            config.port = String(data.get('cfg_port') || '');
            if (type === 'rotator') config.protocol = config.host ? 'rotctld' : '';
        } else if (type === 'serial') {
            config.host = String(data.get('cfg_host') || '');
            config.port = String(data.get('cfg_port') || '');
            config.port_count = String(data.get('cfg_port_count') || '');
            config.baud = String(data.get('cfg_baud') || '');
            config.data_bits = String(data.get('cfg_data_bits') || '');
            config.stop_bits = String(data.get('cfg_stop_bits') || '');
            config.parity = String(data.get('cfg_parity') || '');
        } else if (RELAY_TYPES.includes(type)) {
            config.relay_url = String(data.get('cfg_relay_url') || '');
            const relayToken = String(data.get('cfg_relay_token') || '');
            if (relayToken) config.relay_token = relayToken;
            config.pulse_ms = String(data.get('cfg_pulse_ms') || '');
            if (type === 'switch') {
                config.out_count = String(data.get('cfg_out_count') || '');
            } else if (type === 'matrix') {
                config.in_count = String(data.get('cfg_in_count') || '');
                config.out_count = String(data.get('cfg_out_count') || '');
            } else {
                config.up_channel = String(data.get('cfg_up_channel') || '');
                config.down_channel = String(data.get('cfg_down_channel') || '');
            }
            const channelsText = String(data.get('cfg_channels') || '').trim();
            if (type !== 'tower' && channelsText) {
                try {
                    config.channels = JSON.parse(channelsText);
                } catch (error) {
                    throw new Error('invalid-config-channels');
                }
            }
        }
        return config;
    }

    function apiError(error) {
        const body = error && error.body;
        return errorText(body && body.error ? body.error : 'generic');
    }

    async function persistDraftLayout(id, layout) {
        try {
            await saveDeviceLayouts([{id, x: layout.x, y: layout.y}]);
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
        const key = selectedKeys.size === 1 ? [...selectedKeys][0] : '';
        const draft = draftByKey(key);
        try {
            const values = formValues(form);
            // 草稿保存要把挂在它身上的草稿连线一起原子落库，不能只写设备。
            if (draft) {
                const batch = await requestBatch({
                    devices: [Object.assign({}, values, {id: draft.key})],
                    layouts: [{id: draft.key, x: draft.layout.x, y: draft.layout.y}],
                    rf_links: draftLinksSaveable(draft.key, draftRfLinks),
                    control_links: draftLinksSaveable(draft.key, draftCtlLinks)
                });
                if (!batch || !batch.ok) {
                    if (errorBox) {
                        errorBox.textContent = errorText(batch && batch.error);
                        errorBox.classList.remove('hidden');
                    }
                    return;
                }
                const savedId = (batch.id_map && batch.id_map[draft.key]) || '';
                drafts = drafts.filter(item => item.key !== draft.key);
                if (savedId) remapDraftLinks(draft.key, savedId);
                selectedKeys = savedId ? new Set([savedId]) : new Set();
                formDirty = false;
                formSignature = null;
                ctrlSignature = null;
                render();
                await refresh();
                await refreshDraftPreview();
                return;
            }
            const result = await saveDevice(values);
            if (!result || !result.ok) {
                if (errorBox) {
                    errorBox.textContent = errorText(result && result.error);
                    errorBox.classList.remove('hidden');
                }
                return;
            }
            const id = result.device && result.device.id ? result.device.id : values.id;
            selectedKeys = new Set([id]);
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

    /**
     * 一次保存全部草稿：先吸收当前表单编辑，再把设备、布局与草稿连线
     * 作为一个批次提交；服务端整批校验通过后才在同一事务里写库。
     */
    async function saveAllDrafts() {
        if (!drafts.length) return;
        const key = selectedKeys.size === 1 ? [...selectedKeys][0] : '';
        const current = draftByKey(key);
        const form = $('#devFormEl');
        if (form && current) {
            try {
                Object.assign(current.device, formValues(form));
            } catch (error) {
                showToast(error && ERROR_KEYS[error.message] ? errorText(error.message) : apiError(error));
                return;
            }
        }
        try {
            const result = await requestBatch({
                devices: drafts.map(item => Object.assign({}, item.device, {id: item.key})),
                layouts: drafts.map(item => ({id: item.key, x: item.layout.x, y: item.layout.y})),
                rf_links: draftRfLinks,
                control_links: draftCtlLinks
            });
            if (!result || !result.ok) {
                showToast(errorText(result && result.error));
                return;
            }
            const savedIds = Object.values(result.id_map || {});
            drafts = [];
            draftRfLinks = [];
            draftCtlLinks = [];
            draftPorts = {rf: {}, ctl: {}};
            draftAddresses = {};
            selectedKeys = savedIds.length ? new Set([savedIds[0]]) : new Set();
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
            render();
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    async function removeSelected() {        const realIds = [...selectedKeys].filter(key => !isDraftKey(key));
        const draftKeys = [...selectedKeys].filter(key => isDraftKey(key));
        if (!realIds.length && !draftKeys.length) return;
        const confirmed = await showConfirm(ctx, realIds.length + draftKeys.length > 1
            ? t('dev.confirmDeleteMany', {n: realIds.length + draftKeys.length})
            : t('dev.confirmDelete'), {danger: true});
        if (!confirmed) return;
        drafts = drafts.filter(item => !draftKeys.includes(item.key));
        for (const id of draftKeys.concat(realIds)) dropDraftLinksFor(id);
        for (const id of realIds) {
            try {
                const result = await deleteDevice(id);
                if (!result || !result.ok) {
                    showToast(errorText(result && result.error));
                    return;
                }
            } catch (error) {
                showToast(apiError(error));
                return;
            }
        }
        selectedKeys.clear();
        formDirty = false;
        formSignature = null;
        ctrlSignature = null;
        await refresh();
        await refreshDraftPreview();
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

    async function connectRfPorts(from, to) {
        if (!from || !to || !from.deviceId || !to.deviceId) return;
        if (from.deviceId === to.deviceId && from.port === to.port) return;
        const draftInvolved = isDraftKey(from.deviceId) || isDraftKey(to.deviceId);
        try {
            if (draftInvolved) {
                // 草稿连线先走服务端校验，命中规则才留在页面内存里。
                const candidate = {
                    a_device: from.deviceId, a_port: from.port,
                    b_device: to.deviceId, b_port: to.port
                };
                const result = await previewState({rf_links: draftRfLinks.concat(candidate)});
                if (!result) return;
                if (!result.ok) {
                    showToast(previewError(result));
                    return;
                }
                render();
                return;
            }
            const result = await saveRfLink({
                a_device: from.deviceId,
                a_port: from.port,
                b_device: to.deviceId,
                b_port: to.port
            });
            if (!result || !result.ok) {
                showToast(errorText(result && result.error));
                return;
            }
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    async function removeRfLinkById(linkId) {
        if (!linkId) return;
        const confirmed = await showConfirm(ctx, t('dev.rf.remove'), {danger: true});
        if (!confirmed) return;
        try {
            const result = await deleteRfLink(linkId);
            if (!result || !result.ok) {
                showToast(errorText(result && result.error));
                return;
            }
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    async function removeControlLinkById(linkId) {
        if (!linkId) return;
        const confirmed = await showConfirm(ctx, t('dev.ctl.remove'), {danger: true});
        if (!confirmed) return;
        try {
            const result = await deleteControlLink(linkId);
            if (!result || !result.ok) {
                showToast(errorText(result && result.error));
                return;
            }
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    /** 草稿连线只存在于内存，点线即撤，无需服务端往返与确认弹窗。 */
    async function removeDraftLink(kind, linkId) {
        if (!linkId) return;
        if (kind === 'ctl') draftCtlLinks = draftCtlLinks.filter(link => link.link_id !== linkId);
        else draftRfLinks = draftRfLinks.filter(link => link.link_id !== linkId);
        render();
        await refreshDraftPreview();
    }

    async function removeWire(childId) {        const node = deviceById(childId);
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

    function nodeElement(key) {
        const nodes = document.querySelectorAll('#devNodes [data-node-key]');
        for (const node of nodes) {
            if (node.dataset.nodeKey === key) return node;
        }
        return null;
    }

    function beginDrag(key, event) {
        const draft = draftByKey(key);
        const base = draft ? draft.layout : positionOf(deviceById(key));
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
        const dx = (event.clientX - dragging.startX) / zoom;
        const dy = (event.clientY - dragging.startY) / zoom;
        if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        dragging.moved = true;
        dragging.x = Math.max(0, Math.round(dragging.originX + dx));
        dragging.y = Math.max(0, Math.round(dragging.originY + dy));
        const node = nodeElement(dragging.key);
        if (node) {
            node.style.left = dragging.x + 'px';
            node.style.top = dragging.y + 'px';
        }
        const draft = draftByKey(dragging.key);
        if (draft) draft.layout = {x: dragging.x, y: dragging.y};
        renderWires(canvasNodes());
    }

    async function endDrag() {
        if (!dragging) return;
        const drag = dragging;
        dragging = null;
        if (!drag.moved) return;
        const draft = draftByKey(drag.key);
        if (draft) {
            draft.layout = {x: drag.x, y: drag.y};
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
            x2: (event.clientX - rect.left) / zoom,
            y2: (event.clientY - rect.top) / zoom
        };
        event.preventDefault();
        renderWires(canvasNodes());
    }

    function beginCtlWire(portEl, event) {
        const deviceId = portEl.dataset.ctlDevice;
        const port = portEl.dataset.ctlPort;
        const point = controlPortPoint(deviceId, port);
        if (!deviceId || !port || !point) return;
        const rect = $('#devCanvas').getBoundingClientRect();
        ctlWiring = {
            fromDevice: deviceId,
            fromPort: port,
            x1: point.x,
            y1: point.y,
            x2: (event.clientX - rect.left) / zoom,
            y2: (event.clientY - rect.top) / zoom
        };
        event.preventDefault();
        event.stopPropagation();
        renderWires(canvasNodes());
    }

    async function endCtlWire(event) {
        if (!ctlWiring) return;
        const from = {device: ctlWiring.fromDevice, port: ctlWiring.fromPort};
        ctlWiring = null;
        const x = event ? event.clientX : 0;
        const y = event ? event.clientY : 0;
        const targetEl = document.elementFromPoint(x, y);
        const portEl = targetEl ? targetEl.closest('[data-ctl-device]') : null;
        renderWires(canvasNodes());
        if (!portEl) {
            // 圆形控制口只能连圆形控制口：拖到射频口要明确拒绝，而不是静默丢弃。
            if (targetEl && targetEl.closest('.dev-rf-port')) showToast(errorText('mixed-ports'));
            return;
        }
        const to = {device: portEl.dataset.ctlDevice, port: portEl.dataset.ctlPort};
        if (!to.device || !to.port) return;
        if (to.device === from.device && to.port === from.port) return;
        const draftInvolved = isDraftKey(from.device) || isDraftKey(to.device);
        try {
            if (draftInvolved) {
                const candidate = {
                    a_device: from.device, a_port: from.port,
                    b_device: to.device, b_port: to.port
                };
                const preview = await previewState({control_links: draftCtlLinks.concat(candidate)});
                if (!preview) return;
                if (!preview.ok) {
                    showToast(previewError(preview));
                    return;
                }
                render();
                return;
            }
            const result = await saveControlLink({a: from, b: to});
            if (!result || !result.ok) {
                showToast(errorText(result && result.error));
                return;
            }
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    function beginRfWire(portEl, event) {        const deviceId = portEl.dataset.rfDevice;
        const port = portEl.dataset.rfPort;
        const point = rfPortPoint(deviceId, port);
        if (!deviceId || !port || !point) return;
        const rect = $('#devCanvas').getBoundingClientRect();
        rfWiring = {
            fromDevice: deviceId,
            fromPort: port,
            dir: point.dir,
            x1: point.x,
            y1: point.y,
            x2: (event.clientX - rect.left) / zoom,
            y2: (event.clientY - rect.top) / zoom
        };
        event.preventDefault();
        event.stopPropagation();
        renderWires(canvasNodes());
    }

    function moveWire(event) {
        if (!wiring && !rfWiring && !ctlWiring) return;
        const rect = $('#devCanvas').getBoundingClientRect();
        if (rfWiring) {
            rfWiring.x2 = (event.clientX - rect.left) / zoom;
            rfWiring.y2 = (event.clientY - rect.top) / zoom;
        } else if (ctlWiring) {
            ctlWiring.x2 = (event.clientX - rect.left) / zoom;
            ctlWiring.y2 = (event.clientY - rect.top) / zoom;
        } else if (wiring) {
            wiring.x2 = (event.clientX - rect.left) / zoom;
            wiring.y2 = (event.clientY - rect.top) / zoom;
        }
        renderWires(canvasNodes());
    }

    async function endRfWire(event) {
        if (!rfWiring) return;
        const from = {deviceId: rfWiring.fromDevice, port: rfWiring.fromPort};
        rfWiring = null;
        const x = event ? event.clientX : 0;
        const y = event ? event.clientY : 0;
        const targetEl = document.elementFromPoint(x, y);
        const portEl = targetEl ? targetEl.closest('.dev-rf-port') : null;
        renderWires(canvasNodes());
        if (!portEl) {
            // 方形射频口只能连方形射频口。
            if (targetEl && targetEl.closest('[data-ctl-device], .dev-ctl-port')) {
                showToast(errorText('mixed-ports'));
            }
            return;
        }
        const to = {deviceId: portEl.dataset.rfDevice, port: portEl.dataset.rfPort};
        if (!to.deviceId || !to.port) return;
        if (to.deviceId === from.deviceId && to.port === from.port) return;
        await connectRfPorts(from, to);
    }

    async function endWire(event) {
        if (ctlWiring) {
            await endCtlWire(event);
            return;
        }
        if (rfWiring) {
            await endRfWire(event);
            return;
        }
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
        if (isDraftKey(childKey) || isDraftKey(fromKey)) {
            showToast(t('dev.wire.firstSave'));
            return;
        }
        await connectNodes(fromKey, childKey);
    }

    /* ---- Marquee selection --------------------------------------------- */

    function canvasPoint(event) {
        const rect = $('#devCanvas').getBoundingClientRect();
        return {x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom};
    }

    function startMarquee(event) {
        const point = canvasPoint(event);
        marquee = {x: point.x, y: point.y, startX: point.x, startY: point.y, moved: false};
        const box = document.createElement('div');
        box.className = 'dev-marquee';
        box.id = 'devMarquee';
        $('#devCanvas').appendChild(box);
        event.preventDefault();
    }

    function moveMarquee(event) {
        if (!marquee) return;
        const point = canvasPoint(event);
        marquee.x = point.x;
        marquee.y = point.y;
        if (Math.abs(point.x - marquee.startX) + Math.abs(point.y - marquee.startY) > 4) marquee.moved = true;
        const box = $('#devMarquee');
        if (!box) return;
        const left = Math.min(marquee.startX, marquee.x);
        const top = Math.min(marquee.startY, marquee.y);
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.style.width = Math.abs(marquee.x - marquee.startX) + 'px';
        box.style.height = Math.abs(marquee.y - marquee.startY) + 'px';
        highlightMarquee(left, top, box.style.width, box.style.height);
    }

    function highlightMarquee(left, top, width, height) {
        const right = left + parseFloat(width || '0');
        const bottom = top + parseFloat(height || '0');
        const keys = new Set();
        for (const node of canvasNodes()) {
            const x2 = node.layout.x + NODE_W;
            const y2 = node.layout.y + NODE_H;
            if (node.layout.x < right && x2 > left && node.layout.y < bottom && y2 > top) keys.add(node.key);
        }
        selectedKeys = keys;
        for (const el of document.querySelectorAll('#devNodes [data-node-key]')) {
            el.classList.toggle('active', keys.has(el.dataset.nodeKey));
        }
    }

    function endMarquee() {
        if (!marquee) return;
        const moved = marquee.moved;
        marquee = null;
        $('#devMarquee')?.remove();
        if (moved) {
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
            renderInspector();
            return;
        }
        // 单击空白：清空选择。
        selectedKeys.clear();
        render();
    }

    function applyLabels() {
        $('#devTitle').textContent = t('dev.title');
        $('#devSubtitle').textContent = t('dev.subtitle');
        $('#devRefresh').textContent = t('refresh');
        $('#devNew').textContent = t('dev.add');
        $('#devSaveAll').textContent = t('dev.saveAll');
        $('#devHint').textContent = t('dev.hint.server');
        $('#devPaletteTitle').textContent = t('dev.palette.title');
        $('#devPaletteHint').textContent = t('dev.palette.hint');
        $('#devTxPaletteTitle').textContent = t('dev.palette.tx');
        $('#devCanvasEmpty').textContent = t('dev.canvas.empty');
        $('#devInspectorTitle').textContent = t('dev.inspector.title');
        $('#devMonitorTitle').textContent = t('dev.monitor.title');
        $('#devZoomIn').title = t('dev.zoom.in');
        $('#devZoomOut').title = t('dev.zoom.out');
        $('#devZoomFit').textContent = t('dev.zoom.fit');
        $('#devZoomFit').title = t('dev.zoom.fit');
        $('#devZoomReset').title = t('dev.zoom.reset');
        $('#devZoomValue').title = t('dev.zoom.level');
    }

    function init() {
        applyLabels();
        $('#devRefresh').addEventListener('click', () => { void refresh(); });
        $('#devNew').addEventListener('click', () => createDraft('antenna'));
        $('#devSaveAll').addEventListener('click', () => { void saveAllDrafts(); });
        $('#devInspectorClose').addEventListener('click', () => {
            const key = selectedKeys.size === 1 ? [...selectedKeys][0] : '';
            if (isDraftKey(key)) {
                discardDraft(key);
                return;
            }
            selectedKeys.clear();
            formDirty = false;
            formSignature = null;
            ctrlSignature = null;
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
            createDraft(type,
                (event.clientX - rect.left) / zoom - NODE_W / 2,
                (event.clientY - rect.top) / zoom - NODE_H / 2);
        });
        canvas.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return;
            if (spaceHeld) return;
            const target = event.target;
            if (target.closest('[data-node-key]') || target.closest('[data-wire-child]') ||
                target.closest('[data-rf-link]')) return;
            startMarquee(event);
        });

        const wrap = $('#devCanvasWrap');
        wrap.addEventListener('wheel', event => {
            event.preventDefault();
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
            zoomBy(Math.exp(-event.deltaY * unit * 0.0015), {x: event.clientX, y: event.clientY});
        }, {passive: false});

        // 平移：中键拖动，或按住空格后左键拖动；空出左键给框选。
        wrap.addEventListener('pointerdown', event => {
            if (event.button !== 1 && !(event.button === 0 && spaceHeld)) return;
            beginPan(event);
            event.stopPropagation();
        });
        wrap.addEventListener('pointermove', event => {
            if (!panning || event.pointerId !== panning.pointerId) return;
            movePan(event);
        });
        wrap.addEventListener('pointerup', event => {
            if (!panning || event.pointerId !== panning.pointerId) return;
            endPan();
        });
        wrap.addEventListener('pointercancel', endPan);
        wrap.addEventListener('mousedown', event => {
            if (event.button === 1) event.preventDefault();
        });

        window.addEventListener('keydown', event => {
            if (event.code !== 'Space' || event.repeat) return;
            const element = event.target;
            const typing = element && element.closest &&
                element.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]');
            if (typing || $('#devView').classList.contains('hidden')) return;
            spaceHeld = true;
            event.preventDefault();
        });
        window.addEventListener('keyup', event => {
            if (event.code === 'Space') spaceHeld = false;
        });
        window.addEventListener('blur', () => { spaceHeld = false; });

        $('#devZoomIn')?.addEventListener('click', () => zoomBy(1.2));
        $('#devZoomOut')?.addEventListener('click', () => zoomBy(1 / 1.2));
        $('#devZoomFit')?.addEventListener('click', fitAll);
        $('#devZoomReset')?.addEventListener('click', resetZoom);

        $('#devNodes').addEventListener('pointerdown', event => {
            if (spaceHeld) return;
            const ctlPort = event.target.closest('[data-ctl-device]');
            if (ctlPort) {
                beginCtlWire(ctlPort, event);
                return;
            }
            const rfPort = event.target.closest('.dev-rf-port');
            if (rfPort) {
                beginRfWire(rfPort, event);
                return;
            }
            const mount = event.target.closest('.dev-mount-handle');
            const node = event.target.closest('[data-node-key]');
            if (!node) return;
            if (mount) {
                beginWire(node, event);
                return;
            }
            if (event.button !== undefined && event.button !== 0) return;
            const key = node.dataset.nodeKey;
            selectNode(key, event.shiftKey);
            if (selectedKeys.has(key) && selectedKeys.size === 1) beginDrag(key, event);
        });
        $('#devNodes').addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const node = event.target.closest('[data-node-key]');
            if (!node) return;
            event.preventDefault();
            selectNode(node.dataset.nodeKey, event.shiftKey);
        });
        $('#devWires').addEventListener('click', event => {
            const ctlHit = event.target.closest('[data-ctl-link]');
            if (ctlHit) {
                if (ctlHit.dataset.ctlPending) void removeDraftLink('ctl', ctlHit.dataset.ctlLink);
                else void removeControlLinkById(ctlHit.dataset.ctlLink);
                return;
            }
            const rfHit = event.target.closest('[data-rf-link]');
            if (rfHit) {
                if (rfHit.dataset.rfPending) void removeDraftLink('rf', rfHit.dataset.rfLink);
                else void removeRfLinkById(rfHit.dataset.rfLink);
                return;
            }
            const hit = event.target.closest('[data-wire-child]');
            if (hit) void removeWire(hit.dataset.wireChild);
        });

        window.addEventListener('pointermove', event => {
            moveDrag(event);
            moveWire(event);
            moveMarquee(event);
        });
        window.addEventListener('pointerup', event => {
            void endDrag();
            void endWire(event);
            endMarquee();
        });

        $('#devControl').addEventListener('click', event => {
            const button = event.target.closest('[data-cmd]');
            const device = selectedValue();
            if (!button || !device || !device.id) return;
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
            } else if (cmd === 'amp_set') {
                // 下发内容由型号描述表给出，页面不再自带一份命令映射。
                let delta = null;
                try {
                    delta = JSON.parse(button.dataset.ampDelta || '');
                } catch (error) {
                    delta = null;
                }
                if (delta && typeof delta === 'object' && Object.keys(delta).length) {
                    void sendCommand(device, {command: 'amp_set', args: delta});
                }
            }
        });
        $('#devControl').addEventListener('change', event => {
            if (event.target.id !== 'devCtrlSeat') return;
            commandSeat = event.target.value || null;
        });
        $('#devControl').addEventListener('pointerdown', event => {
            const button = event.target.closest('[data-tower]');
            const device = selectedValue();
            if (!button || !device || !device.id) return;
            event.preventDefault();
            startTower(device, button.dataset.tower);
        });
        document.addEventListener('pointerup', stopTower);
        window.addEventListener('blur', stopTower);

        $('#devForm').addEventListener('submit', submitForm);
        $('#devForm').addEventListener('input', () => { formDirty = true; });
        $('#devForm').addEventListener('change', event => {
            if (!event.target) return;
            // 功放品牌/型号决定字段集合；切换时保留已填写的地址与凭据。
            if (event.target.matches('select[name="cfg_brand"], select[name="cfg_amp_model"]')) {
                refreshAmpConfigFields();
                return;
            }
            if (!event.target.matches('select[name="cfg_computer"], select[name="cfg_model"]')) return;
            // 切换计算机名时按新机器过滤型号；换型号时同步更新“是否已知组合”的提示。
            refreshCandidateControls();
        });
        $('#devForm').addEventListener('click', event => {
            if (event.target && event.target.id === 'devCandidateRefresh') {
                event.preventDefault();
                void loadCandidates(true);
            }
        });
        $('#devForm').addEventListener('click', event => {
            if (event.target.id === 'devDelete') void removeSelected();
        });
        document.addEventListener('keydown', event => {
            if (!active) return;
            if (event.key !== 'Delete') return;
            const tag = document.activeElement ? document.activeElement.tagName : '';
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
            if (selectedKeys.size) void removeSelected();
        });
    }

    function show() {
        active = true;
        applyLabels();
        void refresh();
        // 提前拉一次 N1MM 候选，选中电台时下拉已就绪。
        void loadCandidates(false);
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
        rfWiring = null;
        ctlWiring = null;
        marquee = null;
        $('#devMarquee')?.remove();
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
