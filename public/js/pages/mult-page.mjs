import {fetchMultiplierMatrix} from '../../shared/data/multipliers.mjs';
import {$} from '../ui.mjs';

/**
 * DXCC × 波段倍率矩阵页：只负责展示与筛选，数据全部来自 /api/multipliers。
 * 状态含义：new=本届新增波段格，worked=本届已通，pending=往届已通本届待补。
 */

const MODES = [
    ['ALL', 'mxModeAll'],
    ['CW', 'mxModeCw'],
    ['SSB', 'mxModeSsb'],
    ['DIGI', 'mxModeDigi']
];
const SCOPES = [
    ['contest', 'mxScopeContest'],
    ['all', 'mxScopeAll']
];
const STALE_MS = 60 * 1000;

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

export function createMultiplierPage(ctx) {
    let built = false;
    let busy = false;
    let data = null;
    let error = null;
    let lastAt = 0;
    let mode = 'ALL';
    let scope = 'contest';

    const t = key => ctx.t(key);
    const visible = () => {
        const view = $('#multView');
        return Boolean(view) && !view.classList.contains('hidden');
    };

    function statusText(status) {
        if (status === 'new') return t('mxNew');
        if (status === 'worked') return t('mxWorked');
        if (status === 'pending') return t('mxPending');
        return t('mxWindowNone');
    }

    function windowSourceText(source) {
        if (source === 'settings') return t('mxWindowSettings');
        if (source === 'query') return t('mxWindowQuery');
        if (source === 'derived') return t('mxWindowDerived');
        return t('mxWindowNone');
    }

    function build() {
        const view = $('#multView');
        if (!view) return;
        view.innerHTML = '';
        const shell = element('div', 'mx-shell');

        const head = element('div', 'mx-head');
        head.appendChild(element('h2', 'mx-title', t('multView')));
        head.appendChild(element('p', 'mx-hint', t('mxHint')));
        shell.appendChild(head);

        const bar = element('div', 'mx-bar');
        const modeLabel = element('label', 'mx-label', t('mxMode'));
        const modeSel = element('select', 'mx-select');
        modeSel.id = 'mxMode';
        MODES.forEach(([value, key]) => {
            const option = element('option', '', t(key));
            option.value = value;
            option.selected = value === mode;
            modeSel.appendChild(option);
        });
        modeLabel.appendChild(modeSel);

        const scopeLabel = element('label', 'mx-label', t('mxScope'));
        const scopeSel = element('select', 'mx-select');
        scopeSel.id = 'mxScope';
        SCOPES.forEach(([value, key]) => {
            const option = element('option', '', t(key));
            option.value = value;
            option.selected = value === scope;
            scopeSel.appendChild(option);
        });
        scopeLabel.appendChild(scopeSel);

        const refresh = element('button', 'primary-btn mx-refresh', t('mxRefresh'));
        refresh.id = 'mxRefresh';
        refresh.type = 'button';
        const status = element('span', 'mx-status', busy ? t('mxRunning') : '');
        status.id = 'mxStatus';

        bar.appendChild(modeLabel);
        bar.appendChild(scopeLabel);
        bar.appendChild(refresh);
        bar.appendChild(status);
        shell.appendChild(bar);

        const summary = element('div', 'mx-summary');
        summary.id = 'mxSummary';
        shell.appendChild(summary);

        const notes = element('div', 'mx-notes');
        notes.id = 'mxNotes';
        shell.appendChild(notes);

        const legend = element('div', 'mx-legend');
        [['new', 'mxLegendNew'], ['worked', 'mxLegendWorked'], ['pending', 'mxLegendPending']]
            .forEach(([state, key]) => {
                const item = element('span', 'mx-legend-item');
                item.appendChild(element('i', `mx-swatch mx-${state}`));
                item.appendChild(element('span', '', t(key)));
                legend.appendChild(item);
            });
        legend.appendChild(element('span', 'mx-legend-hint', t('mxClickHint')));
        shell.appendChild(legend);

        const grid = element('div', 'mx-grid');
        grid.id = 'mxGrid';
        shell.appendChild(grid);

        const detail = element('div', 'mx-detail hidden');
        detail.id = 'mxDetail';
        shell.appendChild(detail);

        view.appendChild(shell);

        modeSel.addEventListener('change', () => {
            mode = modeSel.value;
            void load(true);
        });
        scopeSel.addEventListener('change', () => {
            scope = scopeSel.value;
            void load(true);
        });
        refresh.addEventListener('click', () => { void load(true); });
        grid.addEventListener('click', event => {
            const cell = event.target.closest('[data-dxcc]');
            if (!cell || !data) return;
            openDetail(cell.getAttribute('data-dxcc'), cell.getAttribute('data-band'));
        });
        built = true;
        if (data || error) render();
    }

    function renderSummary() {
        const box = $('#mxSummary');
        if (!box) return;
        box.innerHTML = '';
        if (!data) return;
        const totals = data.totals || {};
        const cards = [
            [t('mxEntities'), String(totals.entities || 0)],
            [t('mxWorked'), String(totals.worked || 0)],
            [t('mxPending'), String(totals.pending || 0)],
            [t('mxNew'), String(totals.new || 0)],
            [t('mxCompletion'), Number.isFinite(totals.completion)
                ? `${Math.round(totals.completion * 100)}% (${totals.completed}/${data.activeEntities})`
                : '—']
        ];
        cards.forEach(([label, value]) => {
            const card = element('div', 'mx-card');
            card.appendChild(element('span', 'mx-card-label', label));
            card.appendChild(element('strong', 'mx-card-value', value));
            box.appendChild(card);
        });
    }

    function renderNotes() {
        const box = $('#mxNotes');
        if (!box) return;
        box.innerHTML = '';
        if (!data) return;
        const window = data.window || {};
        const line = element('span', 'mx-note');
        line.textContent = `${t('mxWindow')}: ${window.from ? `${utcText(window.from)} → ${utcText(window.to)}` : t('mxWindowNone')}` +
            ` · ${windowSourceText(window.source)}`;
        box.appendChild(line);
        if (data.contest) box.appendChild(element('span', 'mx-note', `${t('mxEntities')}: ${data.contest}`));
        box.appendChild(element('span', 'mx-note', `${t('mxBands')}: ${(data.bands || []).join(' ') || '—'}`));
        if ((data.warnings || []).includes('no-window')) {
            box.appendChild(element('span', 'mx-warn', t('mxNoWindow')));
        }
        if ((data.warnings || []).includes('truncated')) {
            box.appendChild(element('span', 'mx-warn', t('mxTruncated')));
        }
    }

    function cellNode(entity, band) {
        const cell = entity.cells && entity.cells[band];
        const node = element('td', 'mx-cell');
        node.setAttribute('data-dxcc', String(entity.dxcc));
        node.setAttribute('data-band', band);
        if (!cell) {
            node.classList.add('mx-empty');
            return node;
        }
        node.classList.add(`mx-${cell.status}`);
        node.title = `${entity.country || entity.dxcc} · ${band} · ${statusText(cell.status)} · ${cell.callCount}`;
        node.appendChild(element('span', 'mx-cell-count', String(cell.callCount)));
        return node;
    }

    function entityRow(entity) {
        const tr = element('tr', `mx-row mx-row-${entity.status}`);
        const name = element('th', 'mx-entity', entity.country || `#${entity.dxcc}`);
        name.scope = 'row';
        name.appendChild(element('span', 'mx-prefix', entity.prefix || String(entity.dxcc)));
        tr.appendChild(name);
        (data.bands || []).forEach(band => tr.appendChild(cellNode(entity, band)));
        return tr;
    }

    function renderTable() {
        const grid = $('#mxGrid');
        if (!grid) return;
        grid.innerHTML = '';
        if (!data) return;
        const rows = data.rows || [];
        if (!rows.length) {
            grid.appendChild(element('p', 'mx-empty-text', t('mxNoData')));
            grid.appendChild(element('p', 'mx-empty-hint', t('mxNoDataHint')));
            return;
        }
        const table = element('table', 'mx-table');
        const thead = element('thead');
        const headRow = element('tr');
        const corner = element('th', 'mx-corner', t('mxEntity'));
        corner.scope = 'col';
        headRow.appendChild(corner);
        (data.bands || []).forEach(band => {
            const th = element('th', 'mx-band', band);
            th.scope = 'col';
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = element('tbody');
        const fragment = document.createDocumentFragment();
        rows.forEach(entity => fragment.appendChild(entityRow(entity)));
        const unknown = data.unknown;
        if (unknown && (unknown.callCount || 0) > 0) {
            const tr = element('tr', 'mx-row mx-row-unknown');
            const name = element('th', 'mx-entity', t('mxUnknown'));
            name.scope = 'row';
            name.appendChild(element('span', 'mx-prefix', String(unknown.callCount)));
            tr.appendChild(name);
            (data.bands || []).forEach(band => {
                tr.appendChild(cellNode({
                    dxcc: 'unknown',
                    country: t('mxUnknown'),
                    cells: unknown.cells
                }, band));
            });
            fragment.appendChild(tr);
        }
        tbody.appendChild(fragment);
        table.appendChild(tbody);
        grid.appendChild(table);
        if (unknown && (unknown.callCount || 0) > 0) {
            grid.appendChild(element('p', 'mx-unknown-hint', t('mxUnknownHint')));
        }
    }

    function render() {
        renderSummary();
        renderNotes();
        renderTable();
        const status = $('#mxStatus');
        if (status) {
            status.textContent = busy ? t('mxRunning') : (error ? `${t('mxRequestFailed')}: ${error}` : '');
            status.classList.toggle('mx-error', Boolean(error));
        }
    }

    function openDetail(rawDxcc, band) {
        const detail = $('#mxDetail');
        if (!detail || !data) return;
        let entity = null;
        if (rawDxcc === 'unknown') {
            entity = {
                dxcc: 'unknown',
                country: t('mxUnknown'),
                prefix: '',
                cells: (data.unknown && data.unknown.cells) || {}
            };
        } else {
            entity = (data.rows || []).find(row => String(row.dxcc) === rawDxcc);
        }
        if (!entity) return;
        const cell = (entity.cells || {})[band];
        if (!cell) return;

        detail.innerHTML = '';
        const head = element('div', 'mx-detail-head');
        head.appendChild(element('strong', '', `${entity.country || entity.dxcc} · ${band}`));
        head.appendChild(element('span', 'mx-detail-status', statusText(cell.status)));
        const close = element('button', 'mx-close', t('mxClose'));
        close.type = 'button';
        close.addEventListener('click', () => detail.classList.add('hidden'));
        head.appendChild(close);
        detail.appendChild(head);

        const meta = element('div', 'mx-detail-meta');
        meta.textContent = `${t('mxQsoCount')}: ${cell.count} · ${t('mxLast')}: ${utcText(cell.last)}`;
        detail.appendChild(meta);

        if (!cell.calls || !cell.calls.length) {
            detail.appendChild(element('p', 'mx-empty-text', t('mxNoCalls')));
        } else {
            const table = element('table', 'mx-call-table');
            const headRow = element('tr');
            [t('mxCall'), t('mxCount'), t('mxLast')].forEach(label => {
                headRow.appendChild(element('th', '', label));
            });
            const thead = element('thead');
            thead.appendChild(headRow);
            table.appendChild(thead);
            const tbody = element('tbody');
            cell.calls.forEach(item => {
                const tr = element('tr');
                tr.appendChild(element('td', 'mx-call', item.call));
                tr.appendChild(element('td', '', String(item.count)));
                tr.appendChild(element('td', '', utcText(item.last)));
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            detail.appendChild(table);
            if (cell.callCount > cell.calls.length) {
                detail.appendChild(element('p', 'mx-more', t('mxMoreCalls').replace('{n}',
                    String(cell.callCount - cell.calls.length))));
            }
        }
        detail.classList.remove('hidden');
    }

    async function load(force) {
        if (busy) return;
        if (!force && data && Date.now() - lastAt < STALE_MS) return;
        busy = true;
        error = null;
        const status = $('#mxStatus');
        if (status) status.textContent = t('mxRunning');
        try {
            const result = await fetchMultiplierMatrix({mode, scope});
            data = result;
            lastAt = Date.now();
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
            void load(data ? false : true);
        },
        hide() {},
        applyLang() {
            if (!built) return;
            build();
        },
        applySettings() {
            if (!built || !visible()) return;
            void load(true);
        }
    };
}
