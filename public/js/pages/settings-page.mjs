import {getJson, postJson} from '../../shared/core/transport.mjs';
import {
    getSettings as getSharedSettings, saveSettingsPatch, resetSettingsDomain, settingsFromMessage
} from '../../shared/data/settings.mjs';
import {TILE_PROVIDERS} from '../../shared/map/base-map.mjs';
import {isValidMaidenhead} from '../../shared/geo/maidenhead.mjs';
import {
    DEFAULT_BAND_COLORS, SETTINGS_FIELDS, SETTINGS_SCHEMA, SETTINGS_VERSION,
    THEMES, WALL_CHECKS, WALL_LAYERS, mergeSettings, readLocalExtras, sanitizeSettings,
    validateSettingsPatch, writeLocalExtras
} from '../settings-model.mjs';
import {$, $$, showConfirm, showToast} from '../ui.mjs';

const FIELD_CONTAINERS = {
    ui: '#globalAdvanced', map: '#spotAdvanced', qso: '#qsoAdvanced',
    wall: '#wallAdvanced', data: '#dataFields', prop: '#propFields'
};

/* Keys with a hand-written control in index.html; generated schema fields
 * skip them to avoid duplicate inputs. */
const LEGACY_FIELD_KEYS = new Set([
    'lang', 'theme', 'tiles', 'myCall', 'grid', 'layout', 'rotationSec',
    'category', 'qsoMax', 'qsoLines', 'qsoAutoFit', 'qsoSpotAlert', 'qsoVoiceAlert',
    'mySpotTtl', 'mySpotMax', 'mySpotPopup', 'mySpotVoice',
    'wallTitle', 'wallLayers', 'wallMode', 'wallTimerOn', 'wallTimerStart', 'wallTimerEnd',
    'ttl', 'bandColors'
]);

const DOMAIN_LABELS = {
    ui: ['全局', 'Global'], map: ['SPOT 地图', 'Spot Map'], qso: ['QSO 地图', 'QSO Map'],
    wall: ['大屏', 'Wall'], data: ['数据与告警', 'Data & Alerts'], prop: ['传播', 'Propagation']
};

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

export function createSettingsPage(ctx) {
    let pushTimer = null, pendingPush = null, pendingPatch = null, applyingRemote = false;
    let syncedSettings = null;

    const bi = (zh, en) => (ctx.settings.lang === 'zh' ? zh : en);
    const cloneSettings = value => SETTINGS_SCHEMA.clone(value);

    function applyTheme(name) {
        ctx.settings.theme = THEMES.includes(name) ? name : 'dark';
        document.body.dataset.theme = ctx.settings.theme;
    }

    function renderThemeOptions() {
        const select = $('#setTheme');
        if (!select) return;
        select.innerHTML = THEMES.map(theme => {
            const key = `theme${theme.charAt(0).toUpperCase()}${theme.slice(1)}`;
            return `<option value="${theme}">${ctx.t(key)}</option>`;
        }).join('');
        select.value = ctx.settings.theme;
    }

    /** Keys whose current value differs from the last server-acknowledged snapshot. */
    function diffAgainstSynced() {
        const patch = {};
        for (const field of SETTINGS_FIELDS) {
            if (field.storage !== 'shared') continue;
            const value = ctx.settings[field.key];
            if (value === undefined) continue;
            const before = syncedSettings ? syncedSettings[field.key] : undefined;
            if (JSON.stringify(before) !== JSON.stringify(value)) patch[field.key] = value;
        }
        return patch;
    }

    async function pushNow() {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = null;
        if (applyingRemote) return null;
        if (pendingPush) return pendingPush;
        const patch = pendingPatch;
        pendingPatch = null;
        if (!patch || !Object.keys(patch).length) return null;
        pendingPush = saveSettingsPatch(patch)
            .then(response => {
                syncedSettings = mergeSettings(syncedSettings || {}, patch);
                return response;
            })
            .catch(async () => {
                pendingPatch = mergeSettings(patch, pendingPatch || {});
                // Older backends have no /api/settings/patch: fall back to the
                // legacy full write, which their service accepts unchanged.
                try {
                    const response = await saveSharedSettings(ctx.settings);
                    syncedSettings = cloneSettings(ctx.settings);
                    pendingPatch = null;
                    return response;
                } catch {
                    return null;
                }
            })
            .finally(() => { pendingPush = null; });
        return pendingPush;
    }

    /** Explicit full diff push; pages that mutate ctx.settings directly call this. */
    async function flushAll() {
        pendingPatch = mergeSettings(pendingPatch || {}, diffAgainstSynced());
        return pushNow();
    }

    const CLOCK_SETTING_KEYS = new Set(['timeZone', 'hour12', 'showSeconds', 'clockSec']);
    const MAP_SETTING_KEYS = new Set([
        'autoFitMaxZoom', 'fitPad', 'terminatorShow', 'terminatorSec',
        'heatShow', 'heatRadius', 'heatBlur', 'heatOpacity', 'gcShow', 'gcSamples',
        'spotterSize', 'monitoredSize', 'historyLimit', 'markerMax'
    ]);
    const QSO_SETTING_KEYS = new Set([
        'autoFitMaxZoom', 'fitPad', 'terminatorShow', 'terminatorSec', 'gcSamples'
    ]);
    const LIVE_SETTING_KEYS = new Set([
        ...CLOCK_SETTING_KEYS, ...MAP_SETTING_KEYS, ...QSO_SETTING_KEYS
    ]);

    /** Push only the affected display groups into the live pages. */
    function applyLiveSettings(keys = LIVE_SETTING_KEYS) {
        const changed = [...keys];
        if (changed.some(key => CLOCK_SETTING_KEYS.has(key))) ctx.refreshClock?.();
        if (changed.some(key => MAP_SETTING_KEYS.has(key))) ctx.spot?.applyMapSettings?.();
        if (changed.some(key => QSO_SETTING_KEYS.has(key))) ctx.qso?.applyDisplaySettings?.();
    }

    function save(patch) {
        localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));
        if (applyingRemote) return;
        const changed = patch && typeof patch === 'object' ? Object.keys(patch) : [...LIVE_SETTING_KEYS];
        applyLiveSettings(changed);
        const delta = patch && typeof patch === 'object' ? patch : diffAgainstSynced();
        if (!Object.keys(delta).length) return;
        pendingPatch = mergeSettings(pendingPatch || {}, delta);
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => { void pushNow(); }, 600);
    }

    async function pull() {
        try {
            const shared = await getSharedSettings();
            if (shared && Object.keys(shared).length) {
                const layout = ctx.settings.layout;
                Object.assign(ctx.settings, sanitizeSettings(shared, {languages: ctx.i18n.languages}));
                ctx.settings.layout = layout;
                localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));
                syncedSettings = cloneSettings(ctx.settings);
            } else await flushAll();
        } catch {
            // The local cache is the offline fallback.
        }
        ctx.i18n.setLanguage(ctx.settings.lang);
    }

    function setTileProvider(key) {
        if (!TILE_PROVIDERS[key] || ctx.settings.tiles === key) return;
        ctx.settings.tiles = key;
        save({tiles: key});
        ctx.spot.setTileProvider(key);
        ctx.qso.setTileProvider(key);
    }

    function buildBandColorInputs() {
        const wrap = $('#bandColors');
        wrap.innerHTML = '';
        Object.keys(DEFAULT_BAND_COLORS).forEach(band => {
            const item = document.createElement('div');
            item.className = 'bc-item';
            const input = document.createElement('input');
            input.type = 'color';
            input.value = ctx.settings.bandColors[band];
            input.title = band;
            input.addEventListener('input', () => {
                ctx.settings.bandColors[band] = input.value;
                save({bandColors: {...ctx.settings.bandColors}});
                ctx.spot.applyBandColors();
            });
            const label = document.createElement('span');
            label.textContent = band;
            item.append(input, label);
            wrap.appendChild(item);
        });
    }

    // ------------------------------------------------- schema-driven fields
    function fieldControl(field) {
        const id = `gen_${field.key}`;
        const common = `id="${id}" data-key="${escapeHtml(field.key)}"`;
        switch (field.type) {
            case 'bool':
                return `<input type="checkbox" class="set-check" ${common}>`;
            case 'enum':
                return `<select class="set-input" ${common}>` +
                    (field.values || []).map(value =>
                        `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('') +
                    '</select>';
            case 'int':
            case 'number':
                return `<input type="number" class="set-input" ${common} ` +
                    `min="${field.min ?? ''}" max="${field.max ?? ''}" step="${field.type === 'int' ? 1 : 0.01}">`;
            case 'color':
                return `<input type="color" ${common}>`;
            case 'datetime':
                return `<input type="datetime-local" class="set-input" ${common}>`;
            case 'time':
                return `<input type="time" class="set-input" ${common}>`;
            case 'string':
                return `<input type="text" class="set-input" ${common} maxlength="${field.maxLen || ''}">`;
            default:
                return '';
        }
    }

    function fieldHtml(field) {
        const control = fieldControl(field);
        if (!control) return '';
        const flags = [];
        if (!field.wired) flags.push(`<span class="set-flag preview">${bi('预览', 'preview')}</span>`);
        if (field.restart) flags.push(`<span class="set-flag restart">${bi('需重启', 'restart')}</span>`);
        const label = bi(field.zh, field.label);
        return `<div class="set-field" title="${escapeHtml(field.desc || '')}">` +
            `<label for="gen_${escapeHtml(field.key)}">${escapeHtml(label)}${flags.join('')}</label>` +
            `${control}</div>`;
    }

    function renderSchemaFields() {
        for (const [domain, selector] of Object.entries(FIELD_CONTAINERS)) {
            const wrap = $(selector);
            if (!wrap) continue;
            wrap.innerHTML = SETTINGS_FIELDS
                .filter(field => field.domain === domain && !LEGACY_FIELD_KEYS.has(field.key))
                .map(fieldHtml).join('');
        }
        bindGeneratedFields();
        syncGeneratedFields();
    }

    function syncField(input, field) {
        const value = ctx.settings[field.key];
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = value === undefined || value === null ? '' : value;
    }

    function syncGeneratedFields() {
        $$('[data-key]').forEach(input => {
            const field = SETTINGS_SCHEMA.FIELD_MAP[input.dataset.key];
            if (field) syncField(input, field);
        });
    }

    function bindGeneratedFields() {
        $$('[data-key]').forEach(input => {
            const field = SETTINGS_SCHEMA.FIELD_MAP[input.dataset.key];
            if (!field) return;
            input.addEventListener('change', () => {
                const raw = field.type === 'bool' ? input.checked
                    : field.type === 'int' ? parseInt(input.value, 10)
                        : field.type === 'number' ? parseFloat(input.value)
                            : input.value;
                const result = SETTINGS_SCHEMA.validateValue(field, raw);
                if (!result.ok) {
                    syncField(input, field);
                    showToast(ctx.t('saveFail'));
                    return;
                }
                ctx.settings[field.key] = result.value;
                syncField(input, field);
                save({[field.key]: result.value});
            });
        });
    }

    // ----------------------------------------------------------- backup I/O
    function exportSettings() {
        const extras = readLocalExtras();
        const shared = {};
        for (const field of SETTINGS_FIELDS) {
            if (field.storage !== 'shared' || !field.exportable) continue;
            if (ctx.settings[field.key] === undefined) continue;
            shared[field.key] = cloneSettings(ctx.settings[field.key]);
        }
        const payload = {
            app: 'dx-compass',
            schemaVersion: SETTINGS_VERSION,
            exportedAt: new Date().toISOString(),
            settings: shared,
            local: {rotationSec: extras.rotationSec}
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `dxcompass-settings-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function importSettings(file) {
        let parsed;
        try {
            parsed = JSON.parse(await file.text());
        } catch {
            showToast(bi('导入失败：文件不是有效 JSON', 'Import failed: invalid JSON'));
            return {ok: false, error: 'parse'};
        }
        const source = parsed && typeof parsed === 'object'
            ? (parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed)
            : null;
        if (!source) {
            showToast(bi('导入失败：缺少 settings 对象', 'Import failed: missing settings object'));
            return {ok: false, error: 'shape'};
        }
        const incoming = cloneSettings(source);
        delete incoming._rev;
        delete incoming.cfgV;
        const result = validateSettingsPatch(incoming, {languages: ctx.i18n.languages});
        const appliedKeys = Object.keys(result.values);
        if (!appliedKeys.length) {
            showToast(bi('没有可导入的有效设置', 'No valid settings to import'));
            return {ok: false, error: 'empty', rejected: result.rejected};
        }

        const before = cloneSettings(ctx.settings);
        const beforeExtras = readLocalExtras();
        applySettingsObject(mergeSettings(ctx.settings, result.values), {authoritative: false});

        const nextExtras = {...beforeExtras};
        const rotation = parsed && parsed.local ? parsed.local.rotationSec : undefined;
        if (rotation !== undefined) {
            const checked = SETTINGS_SCHEMA.validateValue(SETTINGS_SCHEMA.FIELD_MAP.rotationSec, rotation);
            if (checked.ok) nextExtras.rotationSec = checked.value;
        }
        writeLocalExtras(nextExtras);
        if (nextExtras.rotationSec !== beforeExtras.rotationSec) {
            ctx.spot.setRotationInterval(nextExtras.rotationSec);
        }
        localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));

        syncedSettings = before;
        const response = await flushAll();
        if (!response) {
            applySettingsObject(before, {authoritative: true});
            writeLocalExtras(beforeExtras);
            if (beforeExtras.rotationSec !== readLocalExtras().rotationSec) {
                ctx.spot.setRotationInterval(beforeExtras.rotationSec);
            }
            localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));
            showToast(ctx.t('saveFail'));
            return {ok: false, error: 'save', rejected: result.rejected};
        }

        showToast(result.rejected.length
            ? bi(`已导入 ${appliedKeys.length - result.rejected.length} 项，跳过 ${result.rejected.length} 项`,
                `Imported ${appliedKeys.length - result.rejected.length}, skipped ${result.rejected.length}`)
            : bi('设置已导入', 'Settings imported'));
        return {ok: true, applied: appliedKeys.length, rejected: result.rejected};
    }

    function applyLocalDomainDefaults(domain) {
        if (domain === 'ui') {
            ctx.settings.layout = SETTINGS_SCHEMA.FIELD_MAP.layout.default;
            ctx.spot.setLayout(ctx.settings.layout, true);
        }
        if (domain === 'map') {
            ctx.spot.setRotationInterval(SETTINGS_SCHEMA.FIELD_MAP.rotationSec.default);
        }
        if (domain === 'data') void ctx.spot.setMonitoring(false);
    }

    async function resetDomainSettings(domain) {
        const labels = DOMAIN_LABELS[domain] || ['设置', 'Settings'];
        const confirmed = await showConfirm(ctx,
            bi(`确定将「${labels[0]}」分组恢复默认值吗？`, `Reset the "${labels[1]}" group to its defaults?`), {
                title: bi('重置分组', 'Reset group'), okText: ctx.t('danger'), danger: true
            });
        if (!confirmed) return false;
        try {
            const response = await resetSettingsDomain(domain);
            const settings = response && response.settings;
            if (!settings) throw new Error('empty settings');
            applySettingsObject(settings, {authoritative: true});
            applyLocalDomainDefaults(domain);
            localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));
            showToast(ctx.t('saved'));
            return true;
        } catch {
            showToast(ctx.t('resetFail'));
            return false;
        }
    }

    // -------------------------------------------------------------- language
    function setText(selector, text) {
        const element = $(selector);
        if (element) element.textContent = text;
    }

    function applyLang() {
        const t = ctx.t;
        ctx.i18n.setLanguage(ctx.settings.lang);
        document.documentElement.lang = ctx.settings.lang;
        document.documentElement.dir = 'ltr';
        document.body.classList.toggle('lang-ar', ctx.settings.lang === 'ar');
        const texts = {
            '#btnConfig': 'settings', '#recordsPanel .panel-title': 'records',
            '#btnRefreshRecords': 'refresh', '#btnExportCsv': 'exportCsv', '#btnClearDb': 'clearDb',
            '#btnRecSched': 'schedule', '#btnRecSchedSet': 'set', '#btnRecSchedClear': 'clear',
            '.rec-tz': 'recTz', '.rec-tab[data-view="all"]': 'tabAll', '.rec-tab[data-view="rec"]': 'tabRec',
            '#configPanel .panel-title': 'settings', '#cfgSectionTitle': 'cfgSection',
            '#langLabel': 'langLabel', '#themeLabel': 'theme', '#tilesLabel': 'mapTiles',
            '#myCallLabel': 'myCall', '#mySpotSectionTitle': 'mySpotSection',
            '#mySpotTtlLabel': 'mySpotTtl', '#mySpotMaxLabel': 'mySpotMax',
            '#mySpotPopupLabel': 'mySpotPopup', '#mySpotVoiceLabel': 'mySpotVoice',
            '#ttlTitle': 'ttlTitle', '#bandTitle': 'bandTitle', '#gridLabel': 'myGrid',
            '#qrzUserLabel': 'qrzUser', '#qrzPassLabel': 'qrzPass', '#tabGlobal': 'setGlobal',
            '#tabSpot': 'setSpot', '#tabQso': 'setQso', '#spotSectionTitle': 'setSpot',
            '#qsoSectionTitle': 'setQso', '#catLabel': 'contestCat', '#qsoAutoFitLabel': 'qsoAutoFit',
            '#qsoLinesLabel': 'qsoLines', '#qsoDoubleLabel': 'qsoMaxMarkers', '#tabWall': 'setWall',
            '#wallSectionTitle': 'setWall', '#wallTitleLabel': 'wallTitle', '#wallLayer1Label': 'wallLayer1',
            '#wallLayer2Label': 'wallLayer2', '#wallPropLabel': 'wallProp', '#wallAuroraLabel': 'wallAurora',
            '#wallWeatherLabel': 'wallWeather', '#wallQsoLabel': 'wallQso', '#wallMySpotLabel': 'wallMySpot',
            '#wallDxSpotLabel': 'wallDxSpot', '#wallModeLabel': 'wallMode', '#wallModeAll': 'wallModeAll',
            '#wallModeCycle': 'wallModeCycle', '#wallTimerLabel': 'wallTimer',
            '#qsoSpotAlertLabel': 'qsoSpotAlert', '#qsoVoiceLabel': 'qsoVoice',
            '#resetAllLabel': 'resetAll', '#btnResetAll': 'resetAll', '#qtLFreq': 'lblFreq',
            '#qtLCall': 'lblCall', '#qtLRst': 'lblRst', '#qtLExch': 'lblExch', '#qtLBand': 'lblBand',
            '#qtLMode': 'lblMode', '#qtLOp': 'lblOp', '#qtLAge': 'lblAge', '#btnSpotView': 'spotView',
            '#btnQsoView': 'qsoView', '#btnPropView': 'propView', '#propProjLabel': 'propProjection',
            '#propLayerLabel': 'propLayer', '#qsoPanelTitle': 'stPanel', '#qLastTitle': 'stLastQso',
            '#qRateTitle': 'qsoRate', '#qMinTitle': 'qsoPerMin', '#qOpTitle': 'qsoByOp',
            '#qBandTitle': 'qsoByBand', '#qLQsos': 'stQsos', '#qLMults': 'stMults',
            '#qLPoints': 'stPoints', '#qLScore': 'stScore', '#btnSaveCfg': 'save'
        };
        Object.entries(texts).forEach(([selector, key]) => {
            const element = $(selector);
            if (element) element.textContent = t(key);
        });
        $('#btnConfig').title = t('settings');
        $('#btnMenu').title = t('menu');
        $('#wallTimerStartLabel').textContent = `${t('wallTimerStart')} (UTC)`;
        $('#wallTimerEndLabel').textContent = `${t('wallTimerEnd')} (UTC)`;
        $('#cfgHint').innerHTML = t('cfgHint');
        $('#btnRotateNext').title = t('nextPage');
        $('#rotSec').title = t('rotSecTitle');

        setText('#tabData', bi('数据', 'Data'));
        setText('#tabProp', bi('传播', 'Prop'));
        setText('#globalAdvancedTitle', bi('高级', 'Advanced'));
        setText('#spotAdvancedTitle', bi('显示', 'Display'));
        setText('#qsoAdvancedTitle', bi('显示与告警', 'Display & alerts'));
        setText('#wallAdvancedTitle', bi('高级', 'Advanced'));
        setText('#dataTitle', bi('数据与告警', 'Data & Alerts'));
        setText('#propTitle', bi('传播', 'Propagation'));
        setText('#backupTitle', bi('备份与恢复', 'Backup & restore'));
        setText('#backupHint', bi('导出会写出全部共享设置；导入先逐项校验，保存失败会自动回滚。',
            'Export writes every shared setting; import validates first and rolls back on failure.'));
        setText('#btnExportSettings', bi('导出 JSON', 'Export JSON'));
        setText('#btnImportSettings', bi('导入 JSON', 'Import JSON'));
        setText('#dataHint', bi('服务端采集、保留与诊断。标有“需重启”的项在 Node-RED 重启后生效。',
            'Server-side ingest, retention and diagnostics. Restart-marked items apply after a Node-RED restart.'));
        setText('#propSettingsHint', bi('投影、图层与 DX 目标点在传播页工具栏调整；以下用于采集与条件阈值。',
            'Projection, layer and the DX target live on the propagation toolbar; the values below tune collection and thresholds.'));
        setText('#spotResetLabel', bi('重置 SPOT 地图设置', 'Reset Spot Map settings'));
        setText('#qsoResetLabel', bi('重置 QSO 地图设置', 'Reset QSO Map settings'));
        setText('#wallResetLabel', bi('重置大屏设置', 'Reset Wall settings'));
        setText('#dataResetLabel', bi('重置数据设置', 'Reset Data settings'));
        setText('#propResetLabel', bi('重置传播设置', 'Reset Propagation settings'));
        setText('#globalResetLabel', bi('重置全局设置', 'Reset Global settings'));
        $$('[data-reset-domain]').forEach(button => {
            button.textContent = bi('重置本组', 'Reset group');
        });

        renderThemeOptions();
        renderSchemaFields();
        ctx.spot.applyLang();
        ctx.qso.renderLastQso();
        ctx.qso.renderQsoPanel();
        ctx.records.applyLang();
        ctx.prop.applyLang();
    }

    function setValue(selector, value) {
        const element = $(selector);
        if (element) element.value = value;
    }

    function setChecked(selector, value) {
        const element = $(selector);
        if (element) element.checked = value;
    }

    /**
     * Apply a full settings object to the live context and refresh dependent
     * views. authoritative=false is used by import so the diff still knows
     * which keys have not reached the server yet.
     */
    function applySettingsObject(raw, {authoritative = true} = {}) {
        const previous = {
            lang: ctx.settings.lang, theme: ctx.settings.theme, tiles: ctx.settings.tiles,
            grid: ctx.settings.grid, category: ctx.settings.category, qsoLines: ctx.settings.qsoLines,
            qsoAutoFit: ctx.settings.qsoAutoFit, myCall: ctx.settings.myCall,
            mySpotTtl: ctx.settings.mySpotTtl, mySpotMax: ctx.settings.mySpotMax,
            propDxLat: ctx.settings.propDxLat, propDxLon: ctx.settings.propDxLon,
            colors: JSON.stringify(ctx.settings.bandColors)
        };
        const displayBefore = {};
        LIVE_SETTING_KEYS.forEach(key => { displayBefore[key] = JSON.stringify(ctx.settings[key]); });
        applyingRemote = true;
        try {
            const merged = sanitizeSettings(raw, {languages: ctx.i18n.languages});
            delete merged.layout;
            Object.assign(ctx.settings, merged);
            setValue('#setLang', ctx.settings.lang);
            setValue('#setTiles', ctx.settings.tiles);
            setValue('#setGrid', ctx.settings.grid);
            setValue('#setMyCall', ctx.settings.myCall);
            setValue('#setCategory', ctx.settings.category);
            setValue('#setQsoMax', ctx.settings.qsoMax);
            for (const [selector, key] of [
                ['#setQsoLines', 'qsoLines'], ['#setQsoAutoFit', 'qsoAutoFit'],
                ['#setQsoSpotAlert', 'qsoSpotAlert'], ['#setQsoVoice', 'qsoVoiceAlert'],
                ['#setMySpotPopup', 'mySpotPopup'], ['#setMySpotVoice', 'mySpotVoice'],
                ['#setWallTimerOn', 'wallTimerOn']
            ]) setChecked(selector, ctx.settings[key]);
            for (const [selector, key] of [
                ['#setMySpotTtl', 'mySpotTtl'], ['#setMySpotMax', 'mySpotMax'],
                ['#setWallTitle', 'wallTitle'], ['#setWallMode', 'wallMode'],
                ['#setWallTimerStart', 'wallTimerStart'], ['#setWallTimerEnd', 'wallTimerEnd']
            ]) setValue(selector, ctx.settings[key]);
            WALL_LAYERS.forEach(key => setChecked(WALL_CHECKS[key], ctx.settings.wallLayers.includes(key)));
            setValue('#ttlCw', ctx.settings.ttl.CW);
            setValue('#ttlSsb', ctx.settings.ttl.SSB);
            setValue('#ttlDigi', ctx.settings.ttl.DIGI);
            syncGeneratedFields();
            if (ctx.settings.lang !== previous.lang || ctx.settings.theme !== previous.theme) {
                applyTheme(ctx.settings.theme);
                applyLang();
            }
            if (ctx.settings.tiles !== previous.tiles) {
                ctx.spot.setTileProvider(ctx.settings.tiles);
                ctx.qso.setTileProvider(ctx.settings.tiles);
            }
            if (JSON.stringify(ctx.settings.bandColors) !== previous.colors) {
                buildBandColorInputs();
                ctx.spot.applyBandColors();
            }
            if (ctx.settings.grid !== previous.grid || ctx.settings.qsoLines !== previous.qsoLines) {
                ctx.qso.rebuildQsoMap();
                ctx.prop.syncHome();
            }
            if (ctx.settings.myCall !== previous.myCall) ctx.qso.clearMySpots();
            if (ctx.settings.category !== previous.category) ctx.qso.renderQsoPanel();
            if (ctx.settings.qsoAutoFit !== previous.qsoAutoFit) ctx.qso.fitQsoMap();
            if (ctx.settings.mySpotTtl !== previous.mySpotTtl || ctx.settings.mySpotMax !== previous.mySpotMax) {
                ctx.qso.applyMySpotLimits();
            }
            ctx.prop.applySettings();
            const changedDisplay = [...LIVE_SETTING_KEYS]
                .filter(key => displayBefore[key] !== JSON.stringify(ctx.settings[key]));
            applyLiveSettings(changedDisplay);
            if (ctx.settings.grid !== previous.grid ||
                ctx.settings.propDxLat !== previous.propDxLat || ctx.settings.propDxLon !== previous.propDxLon) {
                void ctx.prop.refresh();
            }
        } finally {
            applyingRemote = false;
        }
        if (authoritative) syncedSettings = cloneSettings(ctx.settings);
    }

    function applyRemote(message) {
        const raw = settingsFromMessage(message);
        if (!raw) return;
        applySettingsObject(raw, {authoritative: true});
    }

    function closeAppMenu() {
        toggleAppMenu(false);
    }

    function toggleAppMenu(force) {
        const menu = $('#appMenu'), button = $('#btnMenu');
        const show = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
        menu.classList.toggle('hidden', !show);
        button.setAttribute('aria-expanded', show ? 'true' : 'false');
    }

    function openConfig() {
        closeAppMenu();
        $('#configPanel').classList.remove('hidden');
        void loadConfig();
    }

    function closeConfig() {
        if ($('#configPanel').classList.contains('hidden')) return;
        $('#configPanel').classList.add('hidden');
        if (ctx.qso.state.view === 'qso') ctx.qso.refreshMap();
        else if (ctx.qso.state.view === 'prop') ctx.prop.resize();
        else ctx.spot.refreshMaps();
    }

    async function loadConfig() {
        try {
            const calls = await getJson('/api/callsigns');
            if (!Array.isArray(calls)) return;
            ctx.spot.applyCallsigns(calls);
            $$('.cfg-call').forEach((input, index) => { input.value = calls[index] || ''; });
            if (ctx.spot.state.monitoring) void ctx.spot.replayHistory();
        } catch {
            // Keep the currently configured calls when the backend is offline.
        }
    }

    async function saveConfig(event) {
        event.preventDefault();
        const calls = [...$$('.cfg-call')].map(input => input.value.trim().toUpperCase());
        try {
            await postJson('/api/callsigns', calls);
            ctx.spot.applyCallsigns(calls);
            if (ctx.spot.state.monitoring) void ctx.spot.replayHistory();
            showToast(ctx.t('saved'));
            closeConfig();
        } catch {
            showToast(ctx.t('saveFail'));
        }
    }

    function bindTextSetting(selector, key, transform = value => value, after = () => {}) {
        const input = $(selector);
        input.value = ctx.settings[key];
        input.addEventListener('change', () => {
            const value = transform(input.value.trim());
            if (value === null) {
                input.value = ctx.settings[key];
                return;
            }
            input.value = value;
            if (value !== ctx.settings[key]) {
                ctx.settings[key] = value;
                save({[key]: value});
                after(value);
            }
        });
    }

    function bindCheckedSetting(selector, key, after = () => {}) {
        const input = $(selector);
        input.checked = ctx.settings[key];
        input.addEventListener('change', () => {
            ctx.settings[key] = input.checked;
            save({[key]: input.checked});
            after(input.checked);
        });
    }

    function bindNumberSetting(selector, key, min, max, fallback, after = () => {}) {
        const input = $(selector);
        input.value = ctx.settings[key];
        input.addEventListener('change', () => {
            let value = parseInt(input.value, 10);
            if (!Number.isFinite(value)) value = fallback;
            value = Math.min(max, Math.max(min, value));
            input.value = value;
            ctx.settings[key] = value;
            save({[key]: value});
            after(value);
        });
    }

    function bind() {
        $$('.layout-btn').forEach(button => button.addEventListener('click', () => ctx.spot.setLayout(button.dataset.layout)));
        $$('.panel-close').forEach(button => button.addEventListener('click', () => {
            if (button.dataset.close === 'configPanel') closeConfig();
            else document.getElementById(button.dataset.close).classList.add('hidden');
        }));
        $('#btnMenu').addEventListener('click', event => {
            event.stopPropagation();
            toggleAppMenu();
        });
        $('#appMenu').addEventListener('click', event => event.stopPropagation());
        document.addEventListener('click', closeAppMenu);
        $('#btnConfig').addEventListener('click', openConfig);
        $('#btnMonitor').addEventListener('click', () => ctx.spot.setMonitoring(!ctx.spot.state.monitoring));
        $('#btnRotate').addEventListener('click', () => {
            if (ctx.spot.state.rotation.running) {
                ctx.spot.stopRotation();
                ctx.spot.updateRotateUI();
            } else ctx.spot.startRotation();
        });
        $('#btnRotateNext').addEventListener('click', () => {
            ctx.spot.rotateStep();
            ctx.spot.restartRotationTimer();
        });
        $('#rotSec').addEventListener('change', () => ctx.spot.setRotationInterval(parseInt($('#rotSec').value, 10)));

        const language = $('#setLang'), names = ctx.i18n.languageNames;
        language.innerHTML = ctx.i18n.languages.map(code => `<option value="${code}">${names[code] || code}</option>`).join('');
        language.value = ctx.settings.lang;
        language.addEventListener('change', () => {
            ctx.settings.lang = language.value;
            ctx.i18n.setLanguage(language.value);
            save({lang: language.value});
            applyLang();
        });
        renderThemeOptions();
        $('#setTheme').addEventListener('change', () => {
            applyTheme($('#setTheme').value);
            save({theme: ctx.settings.theme});
        });
        const tiles = $('#setTiles');
        tiles.innerHTML = Object.keys(TILE_PROVIDERS).map(key => `<option value="${key}">${TILE_PROVIDERS[key].name}</option>`).join('');
        tiles.value = ctx.settings.tiles;
        tiles.addEventListener('change', () => setTileProvider(tiles.value));

        bindTextSetting('#setGrid', 'grid', value => {
            const grid = value.toUpperCase();
            return !grid || isValidMaidenhead(grid) ? grid : null;
        }, () => {
            ctx.qso.rebuildQsoMap();
            ctx.prop.syncHome();
            void pushNow().then(() => ctx.prop.refresh());
        });
        bindTextSetting('#setMyCall', 'myCall', value => {
            const call = value.toUpperCase();
            return !call || /^[A-Z0-9/]{3,12}$/.test(call) ? call : null;
        }, () => ctx.qso.clearMySpots());
        $$('.cfg-tab').forEach(button => button.addEventListener('click', () => {
            $$('.cfg-tab').forEach(item => item.classList.toggle('active', item === button));
            $$('.cfg-pane').forEach(pane => pane.classList.toggle('active',
                pane.id === `pane${button.dataset.pane.charAt(0).toUpperCase()}${button.dataset.pane.slice(1)}`));
        }));
        const category = $('#setCategory');
        category.value = ctx.settings.category;
        category.addEventListener('change', () => {
            ctx.settings.category = category.value;
            save({category: category.value});
            ctx.qso.renderQsoPanel();
        });
        bindNumberSetting('#setQsoMax', 'qsoMax', 200, 4000, 1500);
        bindCheckedSetting('#setQsoLines', 'qsoLines', () => ctx.qso.rebuildQsoMap());
        bindCheckedSetting('#setQsoAutoFit', 'qsoAutoFit', () => ctx.qso.fitQsoMap());
        bindCheckedSetting('#setQsoSpotAlert', 'qsoSpotAlert', enabled => { if (!enabled) ctx.qso.hideSpotAlert(); });
        bindCheckedSetting('#setQsoVoice', 'qsoVoiceAlert', enabled => {
            if (!enabled && 'speechSynthesis' in window) speechSynthesis.cancel();
        });
        bindNumberSetting('#setMySpotTtl', 'mySpotTtl', 1, 180, ctx.settings.mySpotTtl, () => ctx.qso.applyMySpotLimits());
        bindNumberSetting('#setMySpotMax', 'mySpotMax', 10, 2000, ctx.settings.mySpotMax, () => ctx.qso.applyMySpotLimits());
        bindCheckedSetting('#setMySpotPopup', 'mySpotPopup');
        bindCheckedSetting('#setMySpotVoice', 'mySpotVoice', enabled => {
            if (!enabled && 'speechSynthesis' in window) speechSynthesis.cancel();
        });
        bindTextSetting('#setWallTitle', 'wallTitle', value => value.slice(0, 24) || 'DX-COMPASS');
        WALL_LAYERS.forEach(key => {
            const input = $(WALL_CHECKS[key]);
            input.checked = ctx.settings.wallLayers.includes(key);
            input.addEventListener('change', () => {
                ctx.settings.wallLayers = WALL_LAYERS.filter(layer => $(WALL_CHECKS[layer]).checked);
                save({wallLayers: ctx.settings.wallLayers});
            });
        });
        const wallMode = $('#setWallMode');
        wallMode.value = ctx.settings.wallMode;
        wallMode.addEventListener('change', () => {
            ctx.settings.wallMode = wallMode.value;
            save({wallMode: wallMode.value});
        });
        for (const [selector, key] of [
            ['#setWallTimerStart', 'wallTimerStart'], ['#setWallTimerEnd', 'wallTimerEnd']
        ]) bindTextSetting(selector, key);
        bindCheckedSetting('#setWallTimerOn', 'wallTimerOn');

        $('#saClose').addEventListener('click', ctx.qso.hideSpotAlertAndVoice);
        $('#btnSpotView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('spots'); });
        $('#btnQsoView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('qso'); });
        $('#btnPropView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('prop'); });
        $('#configForm').addEventListener('submit', saveConfig);

        $('#btnExportSettings').addEventListener('click', exportSettings);
        $('#btnImportSettings').addEventListener('click', () => $('#importSettingsFile').click());
        $('#importSettingsFile').addEventListener('change', async event => {
            const input = event.target;
            const file = input.files && input.files[0];
            input.value = '';
            if (file) await importSettings(file);
        });
        $$('[data-reset-domain]').forEach(button => button.addEventListener('click', () => {
            void resetDomainSettings(button.dataset.resetDomain);
        }));

        $('#btnResetAll').addEventListener('click', async () => {
            const confirmed = await showConfirm(ctx, ctx.t('resetConfirm'), {
                title: ctx.t('resetAll'), okText: ctx.t('danger'), danger: true
            });
            if (!confirmed) return;
            try {
                await Promise.all([postJson('/api/reset'), postJson('/api/callsigns', [])]);
                ['dxcompass-settings', 'dxcompass-monitoring', 'dxcompass-rot-sec']
                    .forEach(key => localStorage.removeItem(key));
                location.reload();
            } catch {
                showToast(ctx.t('resetFail'));
            }
        });

        const username = $('#setQrzUser'), password = $('#setQrzPass');
        getJson('/api/qrz/config').then(config => {
            if (config && config.configured) username.value = config.username || '';
        }).catch(() => {});
        password.addEventListener('change', async () => {
            if (!username.value.trim() || !password.value.trim()) return;
            try {
                const result = await postJson('/api/qrz/config', {
                    username: username.value.trim(), password: password.value.trim()
                });
                if (result && result.ok) {
                    password.value = '';
                    showToast(ctx.t('saved'));
                } else showToast(ctx.t('saveFail'));
            } catch {
                showToast(ctx.t('saveFail'));
            }
        });
        for (const [id, mode] of [['ttlCw', 'CW'], ['ttlSsb', 'SSB'], ['ttlDigi', 'DIGI']]) {
            const input = $(`#${id}`);
            input.value = ctx.settings.ttl[mode];
            input.addEventListener('change', () => {
                let value = parseInt(input.value, 10);
                if (!Number.isFinite(value) || value < 1) value = 1;
                if (value > 180) value = 180;
                input.value = value;
                ctx.settings.ttl[mode] = value;
                save({ttl: {...ctx.settings.ttl}});
            });
        }
        buildBandColorInputs();
        renderSchemaFields();
    }

    return {
        bind, pull, save, flush: flushAll, applyRemote, applyLang, applyTheme,
        openConfig, closeConfig, closeAppMenu, loadConfig, buildBandColorInputs,
        exportSettings, importSettings, resetDomainSettings
    };
}
