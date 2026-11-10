import {
    fetchAlertRules, createAlertRule, updateAlertRule, deleteAlertRule, fetchAlertHits
} from '../../shared/data/alert-rules.mjs';
import {$, showConfirm, showToast} from '../ui.mjs';

/**
 * 条件告警规则页：规则 CRUD + 最近命中。
 * 规则走独立 /api/alert-rules 接口（alert_rules 表），与 uiSettings 无关；
 * 命中记录由服务端按 call|band 聚合后返回，并标注触发的规则名。
 */

const HIT_STALE_MS = 30 * 1000;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function utcText(iso) {
    if (!iso) return '—';
    const time = new Date(iso);
    return Number.isFinite(time.getTime()) ? time.toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—';
}

function utcInput(iso) {
    const time = new Date(iso);
    return iso && Number.isFinite(time.getTime()) ? time.toISOString().slice(0, 16) : '';
}

function utcBound(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const ms = Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}:00Z`);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

export function createAlertsPage(ctx) {
    let built = false;
    let rules = [];
    let hits = [];
    let editing = null;
    let busy = false;
    let error = null;
    let hitsAt = 0;

    const t = key => ctx.t(key);

    const visible = () => {
        const view = $('#alertView');
        return Boolean(view) && !view.classList.contains('hidden');
    };

    function stateLabel(state) {
        const key = {
            newMultiplier: 'alStateNewMultiplier',
            newBand: 'alStateNewBand',
            rare: 'alStateRare',
            unknown: 'alStateUnknown',
            other: 'alStateOther'
        }[state];
        return key ? t(key) : (state || '—');
    }

    function conditionsOf(rule) {
        const parts = [];
        if (rule.call) parts.push(`call=${rule.call}`);
        if (rule.prefix) parts.push(`prefix=${rule.prefix}`);
        if (rule.dxcc) parts.push(`DXCC=${rule.dxcc}`);
        if (rule.band) parts.push(`band=${rule.band}`);
        if (rule.mode) parts.push(`mode=${rule.mode}`);
        if (rule.source) parts.push(`src=${rule.source}`);
        if (rule.snrMin !== null && rule.snrMin !== undefined) parts.push(`SNR>=${rule.snrMin}`);
        if (rule.snrMax !== null && rule.snrMax !== undefined) parts.push(`SNR<=${rule.snrMax}`);
        if (rule.from) parts.push(`from ${utcText(rule.from)}`);
        if (rule.to) parts.push(`to ${utcText(rule.to)}`);
        if (rule.notCall) parts.push(`!call=${rule.notCall}`);
        if (rule.notDxcc) parts.push(`!DXCC=${rule.notDxcc}`);
        if (rule.notBand) parts.push(`!band=${rule.notBand}`);
        if (rule.notMode) parts.push(`!mode=${rule.notMode}`);
        if (rule.notSource) parts.push(`!src=${rule.notSource}`);
        return parts.join(' · ') || '—';
    }

    function field(label, name, type = 'text', placeholder = '') {
        const wrap = element('label', 'al-field');
        wrap.appendChild(element('span', 'al-field-label', label));
        const input = element('input', 'al-input');
        input.name = name;
        input.type = type;
        input.autocomplete = 'off';
        if (placeholder) input.placeholder = placeholder;
        wrap.appendChild(input);
        return wrap;
    }

    function checkbox(label, name) {
        const wrap = element('label', 'al-check');
        const input = element('input');
        input.type = 'checkbox';
        input.name = name;
        wrap.appendChild(input);
        wrap.appendChild(element('span', '', label));
        return wrap;
    }

    function build() {
        const view = $('#alertView');
        if (!view) return;
        view.innerHTML = '';
        const shell = element('div', 'mx-shell');

        const head = element('div', 'mx-head');
        head.appendChild(element('h2', 'mx-title', t('alertView')));
        head.appendChild(element('p', 'mx-hint', t('alHint')));
        shell.appendChild(head);

        const bar = element('div', 'mx-bar');
        const add = element('button', 'primary-btn', t('alNewRule'));
        add.type = 'button';
        add.id = 'alNewRule';
        const status = element('span', 'mx-status', '');
        status.id = 'alStatus';
        bar.appendChild(add);
        bar.appendChild(status);
        shell.appendChild(bar);

        shell.appendChild(buildForm());

        const rulesTitle = element('h3', 'al-section-title', t('alRules'));
        shell.appendChild(rulesTitle);
        const ruleGrid = element('div', 'mx-grid');
        ruleGrid.id = 'alRuleGrid';
        shell.appendChild(ruleGrid);

        const hitsTitle = element('h3', 'al-section-title', t('alHits'));
        shell.appendChild(hitsTitle);
        const hitGrid = element('div', 'mx-grid');
        hitGrid.id = 'alHitGrid';
        shell.appendChild(hitGrid);

        view.appendChild(shell);

        add.addEventListener('click', () => {
            editing = {};
            render();
        });
        ruleGrid.addEventListener('click', event => {
            const button = event.target.closest('[data-action]');
            if (!button) return;
            const id = Number(button.getAttribute('data-id'));
            const rule = rules.find(item => item.id === id);
            if (!rule) return;
            const action = button.getAttribute('data-action');
            if (action === 'edit') {
                editing = Object.assign({}, rule);
                render();
            } else if (action === 'toggle') {
                void save(Object.assign({}, rule, {enabled: rule.enabled ? 0 : 1}));
            } else if (action === 'delete') {
                void remove(rule);
            }
        });
        built = true;
        render();
    }

    function buildForm() {
        const form = element('form', 'al-form hidden');
        form.id = 'alForm';
        const grid = element('div', 'al-form-grid');
        const fields = [
            [t('alName'), 'name', 'text', 'DL*'],
            [t('alCall'), 'call', 'text', 'DL1ABC, K1ABC/P'],
            [t('alPrefix'), 'prefix', 'text', 'DL'],
            [t('alDxcc'), 'dxcc', 'text', '230'],
            [t('alBand'), 'band', 'text', '20m'],
            [t('alMode'), 'mode', 'text', 'CW'],
            [t('alSource'), 'source', 'text', 'rbn'],
            [t('alSnrMin'), 'snrMin', 'number', ''],
            [t('alSnrMax'), 'snrMax', 'number', ''],
            [t('alFrom'), 'from', 'datetime-local', ''],
            [t('alTo'), 'to', 'datetime-local', '']
        ];
        fields.forEach(([label, name, type, placeholder]) => {
            grid.appendChild(field(label, name, type, placeholder));
        });
        form.appendChild(grid);

        const advanced = element('details', 'al-advanced');
        advanced.appendChild(element('summary', '', t('alAdvanced')));
        const advancedGrid = element('div', 'al-form-grid');
        [[t('alNotCall'), 'notCall'], [t('alNotDxcc'), 'notDxcc'], [t('alNotBand'), 'notBand'],
            [t('alNotMode'), 'notMode'], [t('alNotSource'), 'notSource']]
            .forEach(([label, name]) => advancedGrid.appendChild(field(label, name)));
        advanced.appendChild(advancedGrid);
        form.appendChild(advanced);

        const notify = element('div', 'al-notify');
        [['alPopup', 'popup'], ['alVoice', 'voice'], ['alSound', 'sound'], ['alEnabled', 'enabled']]
            .forEach(([label, name]) => notify.appendChild(checkbox(t(label), name)));
        form.appendChild(notify);

        const actions = element('div', 'al-actions');
        const saveButton = element('button', 'primary-btn', t('alSave'));
        saveButton.type = 'submit';
        const cancel = element('button', 'ghost-btn', t('alCancel'));
        cancel.type = 'button';
        actions.appendChild(saveButton);
        actions.appendChild(cancel);
        form.appendChild(actions);

        form.addEventListener('submit', event => {
            event.preventDefault();
            void submitForm(form);
        });
        cancel.addEventListener('click', () => {
            editing = null;
            form.classList.add('hidden');
            renderRules();
        });
        return form;
    }

    function fillForm() {
        const form = $('#alForm');
        if (!form) return;
        const rule = editing || {};
        form.querySelectorAll('[name]').forEach(input => {
            const name = input.name;
            if (input.type === 'checkbox') {
                input.checked = name === 'enabled' ? Number(rule.enabled) !== 0 :
                    name === 'voice' ? Number(rule.voice) === 1 :
                        name === 'sound' ? Number(rule.sound) !== 0 :
                            Number(rule.popup) !== 0;
            } else if (name === 'from' || name === 'to') {
                input.value = utcInput(rule[name]);
            } else {
                input.value = rule[name] === null || rule[name] === undefined ? '' : String(rule[name]);
            }
        });
        form.classList.toggle('hidden', editing === null);
    }

    async function submitForm(form) {
        const formData = new FormData(form);
        const rule = {};
        for (const [key, value] of formData.entries()) rule[key] = value;
        ['popup', 'voice', 'sound', 'enabled'].forEach(key => {
            rule[key] = form.querySelector(`[name="${key}"]`).checked ? 1 : 0;
        });
        rule.from = utcBound(rule.from);
        rule.to = utcBound(rule.to);
        if (editing && editing.id) rule.id = editing.id;
        await save(rule);
    }

    async function save(rule) {
        if (busy) return;
        busy = true;
        error = null;
        renderStatus();
        try {
            const result = rule.id
                ? await updateAlertRule(rule.id, rule)
                : await createAlertRule(rule);
            editing = null;
            showToast(t('alSaved'));
            await loadRules();
            lastAlert();
        } catch (err) {
            error = String((err && err.message) || err);
        } finally {
            busy = false;
            render();
        }
    }

    async function remove(rule) {
        const confirmed = await showConfirm(ctx,
            t('alConfirmDelete').replace('{name}', rule.name), {danger: true});
        if (!confirmed) return;
        try {
            await deleteAlertRule(rule.id);
            if (editing && editing.id === rule.id) editing = null;
            showToast(t('alDeleted'));
            await loadRules();
        } catch (err) {
            error = String((err && err.message) || err);
            renderStatus();
        }
    }

    function lastAlert() {
        hitsAt = 0;
        if (visible()) void loadHits(true);
    }

    function renderStatus() {
        const status = $('#alStatus');
        if (!status) return;
        status.textContent = busy ? t('alLoading') : (error ? `${t('alFailed')}: ${error}` : '');
        status.classList.toggle('mx-error', Boolean(error));
    }

    function renderRules() {
        const grid = $('#alRuleGrid');
        if (!grid) return;
        grid.innerHTML = '';
        if (!rules.length) {
            grid.appendChild(element('p', 'mx-empty-text', t('alNoRules')));
            return;
        }
        const table = element('table', 'mx-table al-table');
        const thead = element('thead');
        const head = element('tr');
        [t('alName'), t('alConditions'), t('alState'), t('alPopup'), t('alActions')].forEach(label => {
            head.appendChild(element('th', '', label));
        });
        thead.appendChild(head);
        table.appendChild(thead);
        const tbody = element('tbody');
        rules.forEach(rule => {
            const tr = element('tr', rule.enabled ? '' : 'al-row-off');
            const name = element('td', 'al-name');
            name.appendChild(element('strong', '', rule.name));
            name.appendChild(element('span', `al-chip ${rule.enabled ? 'al-on' : 'al-off'}`,
                rule.enabled ? t('alEnabled') : t('alDisabled')));
            tr.appendChild(name);
            tr.appendChild(element('td', 'al-conditions', conditionsOf(rule)));
            tr.appendChild(element('td', '', stateLabel(rule.state || 'other')));
            const flags = [];
            if (Number(rule.popup)) flags.push(t('alPopup'));
            if (Number(rule.voice)) flags.push(t('alVoice'));
            if (Number(rule.sound)) flags.push(t('alSound'));
            tr.appendChild(element('td', 'al-flags', flags.join(' / ') || '—'));
            const actions = element('td', 'al-row-actions');
            const toggle = element('button', 'ghost-btn', rule.enabled ? t('alDisable') : t('alEnable'));
            toggle.type = 'button';
            toggle.setAttribute('data-action', 'toggle');
            toggle.setAttribute('data-id', String(rule.id));
            const edit = element('button', 'ghost-btn', t('alEdit'));
            edit.type = 'button';
            edit.setAttribute('data-action', 'edit');
            edit.setAttribute('data-id', String(rule.id));
            const del = element('button', 'ghost-btn danger', t('alDelete'));
            del.type = 'button';
            del.setAttribute('data-action', 'delete');
            del.setAttribute('data-id', String(rule.id));
            actions.appendChild(toggle);
            actions.appendChild(edit);
            actions.appendChild(del);
            tr.appendChild(actions);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        grid.appendChild(table);
    }

    function renderHits() {
        const grid = $('#alHitGrid');
        if (!grid) return;
        grid.innerHTML = '';
        if (!hits.length) {
            grid.appendChild(element('p', 'mx-empty-text', t('alNoHits')));
            return;
        }
        const table = element('table', 'mx-table al-table');
        const thead = element('thead');
        const head = element('tr');
        [t('alTime'), t('alCall'), t('alBand'), t('alState'), t('alSources'), t('alReports'), t('alRuleName')]
            .forEach(label => head.appendChild(element('th', '', label)));
        thead.appendChild(head);
        table.appendChild(thead);
        const tbody = element('tbody');
        hits.forEach(hit => {
            const tr = element('tr');
            tr.appendChild(element('td', '', utcText(hit.at)));
            tr.appendChild(element('td', 'al-call', hit.call || '—'));
            tr.appendChild(element('td', '', hit.band || '—'));
            tr.appendChild(element('td', `al-state al-state-${hit.state || 'other'}`, stateLabel(hit.state)));
            tr.appendChild(element('td', '', (hit.sources || []).join(', ') || hit.source || '—'));
            tr.appendChild(element('td', '', String(hit.reports || 1)));
            tr.appendChild(element('td', 'al-rules', hit.ruleNames || '—'));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        grid.appendChild(table);
    }

    function render() {
        if (!built) return;
        fillForm();
        renderRules();
        renderHits();
        renderStatus();
    }

    async function loadRules() {
        const result = await fetchAlertRules();
        rules = Array.isArray(result.rules) ? result.rules : [];
    }

    async function loadHits(force) {
        if (!force && Date.now() - hitsAt < HIT_STALE_MS) return;
        const result = await fetchAlertHits();
        hits = Array.isArray(result.hits) ? result.hits : [];
        hitsAt = Date.now();
    }

    async function load(force) {
        if (busy) return;
        busy = true;
        error = null;
        renderStatus();
        try {
            await loadRules();
            if (force || !hitsAt) await loadHits(true);
        } catch (err) {
            error = String((err && err.message) || err);
        } finally {
            busy = false;
            render();
        }
    }

    return {
        init() {
            if (!built) build();
        },
        show() {
            if (!built) build();
            void load(!hitsAt);
        },
        hide() {},
        applyLang() {
            if (!built) return;
            const formWasOpen = editing !== null;
            build();
            if (formWasOpen) fillForm();
        },
        applySettings() {
            if (!built || !visible()) return;
            void load(true);
        },
        handleAlert() {
            hitsAt = 0;
            if (visible()) void loadHits(true).then(renderHits).catch(() => {});
        }
    };
}
