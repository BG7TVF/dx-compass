/**
 * Devices view: unified node tree, configuration editing, and read-only status.
 *
 * Every rendered state comes from GET /api/devices; the page keeps no device
 * state of its own. When a refresh fails the view is cleared to `unknown`
 * rather than showing the previous values.
 *
 * This phase has no device commands: save/delete only touch configuration.
 */
import {$, escapeHtml as esc, showToast, showConfirm} from '../ui.mjs';
import {getDevicesSnapshot, saveDevice, deleteDevice} from '../../shared/data/devices.mjs';

const POLL_MS = 2000;
const TYPE_OPTIONS = ['tower', 'rotator', 'antenna', 'matrix', 'switch', 'other'];
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
const ERROR_KEYS = {
    'has-children': 'dev.error.has-children',
    cycle: 'dev.error.cycle',
    'antenna-band-required': 'dev.error.antenna-band-required',
    'invalid-offset': 'dev.error.invalid-offset',
    'unknown-device': 'dev.error.unknown-device',
    'unknown-parent': 'dev.error.unknown-parent',
    'invalid-band': 'dev.error.invalid-band'
};

export function createDevicesPage(ctx) {
    let active = false;
    let busy = false;
    let snapshot = null;
    let selectedId = null;
    let seatKey = null;
    let creating = false;
    let formDirty = false;
    let formSignature = null;
    let timer = null;

    function t(key, params) {
        const value = ctx.t(key, params);
        return value === undefined || value === null ? key : value;
    }

    function typeLabel(type) {
        const key = 'dev.type.' + String(type || '').replace(/[^a-z]/g, '');
        const label = ctx.t(key);
        return label === key ? String(type || '') : label;
    }

    function errorText(code) {
        const key = ERROR_KEYS[code];
        return key ? t(key) : t('dev.error.generic');
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

    function selectedDevice() {
        if (!snapshot || !selectedId) return null;
        return snapshot.devices.find(device => device.id === selectedId) || null;
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
        const device = snapshot.devices.find(item => item.id === node.id);
        if (!device) return '';
        const status = deviceStatus(device.id);
        const activeClass = node.id === selectedId ? ' active' : '';
        const colorChip = device.type === 'antenna'
            ? `<span class="dev-chip dev-color-${antennaColor(device.id)}">${t(COLOR_KEYS[antennaColor(device.id)])}</span>`
            : '';
        return `<div class="dev-node${activeClass}" role="button" tabindex="0" data-dev-id="${esc(device.id)}" style="--depth:${node.depth}">
            <span class="dev-node-main">
                <span class="dev-node-name">${esc(device.name)}</span>
                <span class="dev-node-type">${esc(typeLabel(device.type))}</span>
                ${device.enabled ? '' : '<span class="dev-chip dev-chip-muted">off</span>'}
                ${colorChip}
            </span>
            <span class="dev-node-meta">${esc(nodeMeta(device))}</span>
            <span class="dev-node-status">
                <span class="dev-dot dev-dot-${status.state}"></span>
                <span>${t(STATUS_KEYS[status.state] || STATUS_KEYS.unknown)}</span>
                <span class="dev-node-report">${esc(lastReportText(status.last_report))}</span>
            </span>
        </div>`;
    }

    function treeHtml(nodes, seen = new Set()) {
        if (!nodes.length) return `<p class="dev-empty">${t('dev.empty')}</p>`;
        return nodes.map(node => {
            if (seen.has(node.id)) return '';
            seen.add(node.id);
            return nodeHtml(node) + treeHtml(node.children || [], seen);
        }).join('');
    }

    function parentOptions(device) {
        const current = device ? device.parent_id : null;
        const options = [`<option value="">${esc(t('dev.form.root'))}</option>`];
        for (const item of snapshot.devices) {
            if (device && (item.id === device.id || item.id === current)) continue;
            options.push(`<option value="${esc(item.id)}"${current === item.id ? ' selected' : ''}>${esc(item.name)} · ${esc(typeLabel(item.type))}</option>`);
        }
        if (current) {
            const parent = snapshot.devices.find(item => item.id === current);
            if (parent) {
                options.splice(1, 0, `<option value="${esc(parent.id)}" selected>${esc(parent.name)} · ${esc(typeLabel(parent.type))}</option>`);
            }
        }
        return options.join('');
    }

    function formHtml() {
        const device = selectedDevice();
        if (!device && !creating) return `<p class="dev-empty">${t('dev.noSelection')}</p>`;
        const value = device || {id: '', name: '', type: 'antenna', parent_id: null, bands: [], install_offset_deg: 0,
            exclusive: false, port_label: '', enabled: true, travel_timeout_sec: 120, notes: '', has_password: false};
        return `<form id="devFormEl" class="dev-form" data-dev-id="${esc(value.id || '')}">
            <h3>${t(device ? 'dev.form.edit' : 'dev.form.new')}</h3>
            <div class="dev-grid">
                <label>${t('dev.form.name')}<input name="name" maxlength="60" required value="${esc(value.name)}"></label>
                <label>${t('dev.form.type')}
                    <input name="type" list="devTypeList" maxlength="32" required value="${esc(value.type)}">
                </label>
                <label>${t('dev.form.parent')}<select name="parent_id">${parentOptions(device)}</select></label>
                <label>${t('dev.form.bands')}<input name="bands" placeholder="20m, 15m" value="${esc((value.bands || []).join(', '))}"></label>
                <label>${t('dev.form.offset')}<input name="install_offset_deg" type="number" min="0" max="359" step="1" value="${esc(value.install_offset_deg)}"></label>
                <label>${t('dev.form.port')}<input name="port_label" maxlength="32" value="${esc(value.port_label)}"></label>
                <label>${t('dev.form.password')}<input name="password" type="password" maxlength="200" autocomplete="new-password" placeholder="${esc(device && device.has_password ? t('dev.form.passwordKeep') : '')}"></label>
                <label>${t('dev.form.travel')}<input name="travel_timeout_sec" type="number" min="5" max="3600" step="1" value="${esc(value.travel_timeout_sec)}"></label>
            </div>
            <label class="dev-check"><input name="exclusive" type="checkbox"${value.exclusive ? ' checked' : ''}> ${t('dev.form.exclusive')}</label>
            <label class="dev-check"><input name="enabled" type="checkbox"${value.enabled !== false ? ' checked' : ''}> ${t('dev.form.enabled')}</label>
            <label>${t('dev.form.notes')}<input name="notes" maxlength="200" value="${esc(value.notes)}"></label>
            <p class="dev-form-error hidden" id="devFormError"></p>
            <div class="dev-form-actions">
                <button class="dev-btn primary" type="submit">${t('save')}</button>
                ${device ? `<button class="dev-btn danger" type="button" id="devDelete">${t('danger')}</button>` : ''}
            </div>
            <datalist id="devTypeList">
                ${TYPE_OPTIONS.map(type => `<option value="${type}">${esc(typeLabel(type))}</option>`).join('')}
            </datalist>
        </form>`;
    }

    function seatsHtml() {
        const view = snapshot.ownership;
        const header = `<h3>${t('dev.seat.title')}</h3>`;
        if (!view.seats.length) return header + `<p class="dev-empty">${t('dev.seat.none')}</p>`;
        const rows = view.seats.map(seat => {
            const seatViewItem = view.by_seat[seat.seat] || {colors: {}, band: '', online: false};
            const chips = view.antennas.map(antenna => `<span class="dev-chip dev-color-${seatViewItem.colors[antenna.id]}">${esc(antenna.name)}</span>`).join('');
            const notes = [];
            if (seatViewItem.unassigned) notes.push(t('dev.seat.unassigned'));
            if (seatViewItem.ambiguous) notes.push(t('dev.seat.ambiguous'));
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

    function seatOptions() {
        if (!snapshot.ownership.seats.length) return `<option value="">—</option>`;
        return snapshot.ownership.seats.map(seat => `<option value="${esc(seat.seat)}"${seat.seat === seatKey ? ' selected' : ''}>${esc(seat.seat)}${seat.band ? ' · ' + esc(seat.band) : ''}</option>`).join('');
    }

    function render() {
        if (!snapshot) {
            $('#devSummary').textContent = '';
            $('#devTree').innerHTML = `<p class="dev-empty">${t('dev.status.unknown')}</p>`;
            $('#devForm').innerHTML = `<p class="dev-empty">${t('dev.error.generic')}</p>`;
            formSignature = null;
            $('#devSeats').innerHTML = '';
            $('#devTx').innerHTML = '';
            return;
        }
        const seats = snapshot.ownership.seats;
        $('#devSummary').textContent = t('dev.summary', {
            devices: snapshot.devices.length,
            seats: seats.length,
            antennas: snapshot.ownership.antennas.length
        });
        if (document.activeElement !== $('#devSeat')) {
            $('#devSeat').innerHTML = seatOptions();
        }
        $('#devTree').innerHTML = treeHtml(snapshot.tree);
        // 轮询不覆盖正在编辑的表单；选中项变化或保存后才重建。
        const signature = creating ? 'new' : (selectedId || '');
        if (!formDirty && signature !== formSignature) {
            $('#devForm').innerHTML = formHtml();
            formSignature = signature;
        }
        $('#devSeats').innerHTML = seatsHtml();
        $('#devTx').innerHTML = txHtml();
    }

    async function refresh() {
        if (busy) return;
        busy = true;
        try {
            const data = await getDevicesSnapshot();
            snapshot = data && data.ok ? data : null;
            if (!snapshot) throw new Error('invalid snapshot');
            const seats = snapshot.ownership.seats;
            if (!seatKey || !seats.some(seat => seat.seat === seatKey)) {
                const online = seats.find(seat => seat.online);
                seatKey = online ? online.seat : (seats.length ? seats[0].seat : null);
            }
            if (selectedId && !snapshot.devices.some(device => device.id === selectedId)) {
                selectedId = null;
                creating = false;
                formDirty = false;
                formSignature = null;
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

    function selectDevice(id) {
        selectedId = id;
        creating = false;
        formDirty = false;
        formSignature = null;
        render();
        const form = $('#devFormEl');
        if (form) form.querySelector('input[name="name"]')?.focus();
    }

    function startCreate() {
        selectedId = null;
        creating = true;
        formDirty = false;
        formSignature = null;
        render();
        $('#devFormEl')?.querySelector('input[name="name"]')?.focus();
    }

    function formValues(form) {
        const data = new FormData(form);
        const device = {
            name: String(data.get('name') || ''),
            type: String(data.get('type') || ''),
            parent_id: String(data.get('parent_id') || '') || null,
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
        return device;
    }

    function apiError(error) {
        const body = error && error.body;
        return errorText(body && body.error ? body.error : 'generic');
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
            const result = await saveDevice(formValues(form));
            if (!result || !result.ok) {
                if (errorBox) {
                    errorBox.textContent = errorText(result && result.error);
                    errorBox.classList.remove('hidden');
                }
                return;
            }
            selectedId = result.device && result.device.id ? result.device.id : selectedId;
            creating = false;
            formDirty = false;
            formSignature = null;
            await refresh();
        } catch (error) {
            if (errorBox) {
                errorBox.textContent = apiError(error);
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
            await refresh();
        } catch (error) {
            showToast(apiError(error));
        }
    }

    function applyLabels() {
        $('#devTitle').textContent = t('dev.title');
        $('#devSubtitle').textContent = t('dev.subtitle');
        $('#devSeatLabel').textContent = t('dev.seat.current');
        $('#devRefresh').textContent = t('refresh');
        $('#devNew').textContent = t('dev.add');
        $('#devHint').textContent = t('dev.hint.server');
    }

    function init() {
        applyLabels();
        $('#devRefresh').addEventListener('click', () => { void refresh(); });
        $('#devNew').addEventListener('click', startCreate);
        $('#devSeat').addEventListener('change', event => {
            seatKey = event.target.value || null;
            render();
        });
        $('#devTree').addEventListener('click', event => {
            const node = event.target.closest('[data-dev-id]');
            if (node) selectDevice(node.dataset.devId);
        });
        $('#devTree').addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const node = event.target.closest('[data-dev-id]');
            if (node) {
                event.preventDefault();
                selectDevice(node.dataset.devId);
            }
        });
        $('#devSeats').addEventListener('click', event => {
            const row = event.target.closest('[data-dev-seat]');
            if (!row) return;
            seatKey = row.dataset.devSeat;
            render();
        });
        $('#devForm').addEventListener('submit', submitForm);
        $('#devForm').addEventListener('input', () => { formDirty = true; });
        $('#devForm').addEventListener('click', event => {
            if (event.target.id === 'devDelete') void removeSelected();
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
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    return {init, show, hide, refresh};
}
