import {getJson, postJson} from '../../shared/core/transport.mjs';
import {clockOptions, formatClockDateTime, parseUtcDateTime} from '../../shared/core/clock.mjs';
import {fetchContests, refreshContests} from '../../shared/data/contests.mjs';
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
    contest: '#contestFields', wall: '#wallAdvanced', data: '#dataFields', prop: '#propFields'
};

/* Keys with a hand-written control in index.html; generated schema fields
 * skip them to avoid duplicate inputs. */
const LEGACY_FIELD_KEYS = new Set([
    'lang', 'theme', 'tiles', 'myCall', 'grid', 'layout', 'rotationSec',
    'category', 'qsoMax', 'qsoLines', 'qsoAutoFit', 'qsoSpotAlert', 'qsoVoiceAlert',
    'mySpotTtl', 'mySpotMax', 'mySpotPopup', 'mySpotVoice',
    'wallTitle', 'wallLayers', 'wallMode', 'wallTimerOn', 'wallTimerStart', 'wallTimerEnd',
    'multPerBand',
    'ttl', 'bandColors', 'contestId', 'contestUpdatedAt'
]);

/* Short descriptions come from the dictionary (settings.field.<key>.desc,
 * see docs/i18n-glossary-and-gap-audit.md); the schema keeps English as a
 * fallback for callers that do not go through i18n. */
/* Hand-written controls mapped to their schema key, so the same description
 * and unit logic applies to legacy markup and generated rows. */
const LEGACY_ROW_KEYS = {
    setLang: 'lang', setTheme: 'theme', setTiles: 'tiles', setMyCall: 'myCall', setGrid: 'grid',
    setCategory: 'category', setQsoMax: 'qsoMax', setQsoAutoFit: 'qsoAutoFit',
    setQsoLines: 'qsoLines', setQsoSpotAlert: 'qsoSpotAlert', setQsoVoice: 'qsoVoiceAlert',
    setMySpotTtl: 'mySpotTtl', setMySpotMax: 'mySpotMax', setMySpotPopup: 'mySpotPopup',
    setMySpotVoice: 'mySpotVoice', setWallTitle: 'wallTitle', setWallMode: 'wallMode',
    setWallTimerOn: 'wallTimerOn', setWallTimerStart: 'wallTimerStart', setWallTimerEnd: 'wallTimerEnd',
    ttlCw: 'ttl', ttlSsb: 'ttl', ttlDigi: 'ttl',
    setWallProp: 'wallLayers', setWallAurora: 'wallLayers', setWallWeather: 'wallLayers',
    setWallQso: 'wallLayers', setWallMySpot: 'wallLayers', setWallDxSpot: 'wallLayers'
};
/* Controls whose tooltip lives outside the schema (settings.desc.<name>). */
const CUSTOM_DESC_KEYS = {
    setQrzUser: 'qrzUser', setQrzPass: 'qrzPass',
    setWallProp: 'wallProp', setWallAurora: 'wallAurora', setWallWeather: 'wallWeather',
    setWallQso: 'wallQso', setWallMySpot: 'wallMySpot', setWallDxSpot: 'wallDxSpot'
};
/* Rows whose control carries no id of its own (multi-input groups). */
const LEGACY_LABEL_KEYS = {bandTitle: 'bandColors', ttlTitle: 'ttl'};
/* Units that are not written in the label parenthetical. */
const UNIT_BY_KEY = {propDxLat: '°', propDxLon: '°'};

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

export function createSettingsPage(ctx) {
    let pushTimer = null, pendingPush = null, pendingPatch = null, applyingRemote = false;
    let syncedSettings = null;

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
    const PROP_SETTING_KEYS = new Set([
        'propProj', 'propLayer', 'propDxLat', 'propDxLon',
        'mufOpacity', 'nightOpacity', 'propPollSec'
    ]);
    const MULT_SETTING_KEYS = new Set([
        'wallTimerStart', 'wallTimerEnd', 'multPerBand', 'contestStart', 'contestEnd'
    ]);
    const LIVE_SETTING_KEYS = new Set([
        ...CLOCK_SETTING_KEYS, ...MAP_SETTING_KEYS, ...QSO_SETTING_KEYS, ...PROP_SETTING_KEYS,
        ...MULT_SETTING_KEYS
    ]);

    let contestCalendar = null;
    const t = (key, params) => ctx.t(key, params);

    function contestTime(value) {
        return formatClockDateTime(value, clockOptions(ctx.settings));
    }

    function safeLink(value) {
        try {
            const url = new URL(String(value || ''));
            return /^https?:$/.test(url.protocol) ? url.href : '';
        } catch {
            return '';
        }
    }

    function renderContestDetail(entry) {
        const detail = $('#contestDetail');
        if (!detail) return;
        if (!entry) { detail.textContent = ''; return; }
        const missing = t('settings.hint.contestMissing');
        const modes = Array.isArray(entry.modes) && entry.modes.length ? entry.modes.join(', ') : missing;
        const bands = Array.isArray(entry.bands) && entry.bands.length ? entry.bands.join(', ') : missing;
        const link = safeLink(entry.rulesUrl || entry.sourceUrl);
        const rules = link ? ` · <a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(t('settings.calendar.rules'))}</a>` : '';
        detail.innerHTML =
            `${escapeHtml(t('settings.calendar.start'))} ${escapeHtml(contestTime(entry.startUtc))}` +
            ` · ${escapeHtml(t('settings.calendar.end'))} ${escapeHtml(contestTime(entry.endUtc))}<br>` +
            `${escapeHtml(t('settings.calendar.modes'))} ${escapeHtml(modes)}` +
            ` · ${escapeHtml(t('settings.calendar.bands'))} ${escapeHtml(bands)}` +
            ` · ${escapeHtml(missing)}${rules}`;
    }

    function renderContestCalendar() {
        const select = $('#contestPick');
        if (!select) return;
        const now = Date.now();
        const entries = (contestCalendar && Array.isArray(contestCalendar.contests) ? contestCalendar.contests : [])
            .filter(entry => parseUtcDateTime(entry.endUtc) >= now);
        select.replaceChildren(new Option(t('settings.calendar.pick'), ''));
        for (const entry of entries) {
            select.appendChild(new Option(`${entry.name} · ${contestTime(entry.startUtc)}`, entry.id));
        }
        if (entries.some(entry => entry.id === ctx.settings.contestId)) select.value = ctx.settings.contestId;
        const meta = $('#contestMeta');
        if (meta) {
            const info = contestCalendar && contestCalendar.meta;
            meta.textContent = info && info.fetchedAt
                ? t('settings.hint.contestUpdated', {
                    time: contestTime(info.fetchedAt), count: Number(info.count) || 0
                })
                : t('settings.hint.contestEmpty');
        }
        renderContestDetail(entries.find(entry => entry.id === select.value) || null);
    }

    async function loadContests() {
        try {
            const data = await fetchContests();
            if (data && Array.isArray(data.contests)) contestCalendar = data;
        } catch {
            // Keep any previously loaded calendar; the bundled snapshot is the offline fallback.
        }
        renderContestCalendar();
    }

    function applyContest(entry) {
        if (!entry) return;
        const start = String(entry.startUtc || '').slice(0, 16);
        const end = String(entry.endUtc || '').slice(0, 16);
        const patch = {
            contestId: entry.id,
            contestName: entry.name,
            contestStart: start,
            contestEnd: end,
            contestModes: Array.isArray(entry.modes) ? entry.modes.join(', ') : '',
            contestBands: Array.isArray(entry.bands) ? entry.bands.join(', ') : '',
            contestRulesUrl: entry.rulesUrl || entry.sourceUrl || '',
            contestUpdatedAt: String((contestCalendar && contestCalendar.meta && contestCalendar.meta.fetchedAt) ||
                new Date().toISOString()).slice(0, 19),
            wallTimerStart: start,
            wallTimerEnd: end
        };
        Object.assign(ctx.settings, patch);
        save(patch);
        syncGeneratedFields();
        renderContestDetail(entry);
        showToast(t('settings.calendar.applied'));
    }

    function clearContest() {
        const patch = {
            contestId: '', contestName: '', contestStart: '', contestEnd: '',
            contestModes: '', contestBands: '', contestRulesUrl: '', contestUpdatedAt: '',
            wallTimerStart: '', wallTimerEnd: ''
        };
        Object.assign(ctx.settings, patch);
        save(patch);
        syncGeneratedFields();
        $('#contestPick').value = '';
        renderContestDetail(null);
        showToast(t('settings.calendar.cleared'));
    }

    async function refreshCalendar() {
        const button = $('#btnContestRefresh');
        if (button) { button.disabled = true; button.textContent = t('settings.calendar.refreshing'); }
        try {
            const result = await refreshContests();
            if (result && result.ok) {
                await loadContests();
                showToast(t('settings.calendar.refreshed', {
                    count: Number(result.meta && result.meta.count) || 0
                }));
            } else {
                showToast(t('settings.calendar.failed'));
            }
        } catch {
            showToast(t('settings.calendar.failed'));
        } finally {
            if (button) { button.disabled = false; button.textContent = t('settings.calendar.refresh'); }
        }
    }

    /** Push only the affected display groups into the live pages. */
    function applyLiveSettings(keys = LIVE_SETTING_KEYS) {
        const changed = [...keys];
        if (changed.some(key => CLOCK_SETTING_KEYS.has(key))) ctx.refreshClock?.();
        if (changed.some(key => MAP_SETTING_KEYS.has(key))) ctx.spot?.applyMapSettings?.();
        if (changed.some(key => QSO_SETTING_KEYS.has(key))) ctx.qso?.applyDisplaySettings?.();
        if (changed.some(key => PROP_SETTING_KEYS.has(key))) ctx.prop?.applySettings?.();
        if (changed.some(key => MULT_SETTING_KEYS.has(key))) ctx.mult?.applySettings?.();
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
        const disabled = field.readonly ? ' disabled' : '';
        const common = `id="${id}" data-key="${escapeHtml(field.key)}"${disabled}`;
        switch (field.type) {
            case 'bool':
                return `<input type="checkbox" class="set-check" ${common}>`;
            case 'enum':
                return `<select class="set-input" ${common}>` +
                    (field.values || []).map(value =>
                        `<option value="${escapeHtml(value)}">${escapeHtml(ctx.t(`settings.field.${field.key}.option.${value}`))}</option>`).join('') +
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
        if (!field.wired) flags.push(`<span class="set-flag preview">${ctx.t('settings.flag.preview')}</span>`);
        if (field.readonly) flags.push(`<span class="set-flag readonly">${ctx.t('settings.flag.readonly')}</span>`);
        if (field.restart) flags.push(`<span class="set-flag restart">${ctx.t('settings.flag.restart')}</span>`);
        const label = ctx.t(`settings.field.${field.key}.label`);
        const desc = descFor(field.key);
        const search = `${field.key} ${field.label} ${field.zh} ${label} ${desc}`.toLowerCase();
        return `<div class="set-row" data-search="${escapeHtml(search)}">` +
            `<div class="set-text"><label class="set-label" for="gen_${escapeHtml(field.key)}">` +
            `<span class="set-label-text">${escapeHtml(label)}</span>` +
            (flags.length ? `<span class="set-flags">${flags.join('')}</span>` : '') +
            `</label><p class="set-desc">${escapeHtml(desc || '')}</p></div>` +
            `<div class="set-ctl">${control}</div></div>`;
    }

    /** Split a trailing unit parenthetical from a localized label. */
    function splitUnit(text) {
        const match = String(text || '').match(/^(.*?)\s*[（(]([^）)]+)[）)]\s*$/);
        if (!match) return null;
        const unit = match[2].split(/[,，]/)[0].trim();
        if (!/^[A-Za-z%°秒分钟天月小时毫秒千赫公里]+$/.test(unit)) return null;
        return {label: match[1].trim(), unit};
    }

    function rowKey(row) {
        const keyed = row.querySelector('[data-key]');
        if (keyed) return keyed.dataset.key;
        const label = row.querySelector('label[id]');
        if (label && LEGACY_LABEL_KEYS[label.id]) return LEGACY_LABEL_KEYS[label.id];
        for (const control of row.querySelectorAll('input[id], select[id]')) {
            if (LEGACY_ROW_KEYS[control.id]) return LEGACY_ROW_KEYS[control.id];
            if (control.id.startsWith('set')) {
                return control.id.charAt(3).toLowerCase() + control.id.slice(4);
            }
        }
        return null;
    }

    function descFor(key) {
        if (!key) return '';
        if (SETTINGS_SCHEMA.FIELD_MAP[key]) return ctx.t(`settings.field.${key}.desc`);
        return '';
    }

    /* Rows that share one schema key across several controls keep their own
     * labels (mode names, wall layer names) instead of the field label. */
    const MULTI_LABEL_KEYS = new Set(['ttl', 'wallLayers']);

    /** Give every hand-written row the same text/description/unit anatomy as
     * the generated rows without touching the controls themselves. */
    function decorateRows() {
        $$('.set-row, .form-row').forEach(row => {
            let text = row.querySelector(':scope > .set-text');
            let label = text
                ? text.querySelector(':scope > label')
                : row.querySelector(':scope > label');
            if (!text && label) {
                text = document.createElement('div');
                text.className = 'set-text';
                row.insertBefore(text, label);
                text.appendChild(label);
            }
            if (!text) return;
            const key = rowKey(row);
            const controlId = row.querySelector('input[id], select[id]')?.id;
            if (key && label && !MULTI_LABEL_KEYS.has(key) && SETTINGS_SCHEMA.FIELD_MAP[key]) {
                const target = label.querySelector('.set-label-text') || label;
                target.textContent = ctx.t(`settings.field.${key}.label`);
            }
            const customDescKey = controlId && CUSTOM_DESC_KEYS[controlId];
            const rawLabel = label
                ? (label.querySelector('.set-label-text')?.textContent || label.textContent || '')
                : '';
            const desc = customDescKey
                ? ctx.t(`settings.desc.${customDescKey}`)
                : descFor(key);
            let descEl = text.querySelector('.set-desc');
            if (desc) {
                if (!descEl) {
                    descEl = document.createElement('p');
                    descEl.className = 'set-desc';
                    text.appendChild(descEl);
                }
                descEl.textContent = desc;
            } else if (descEl) {
                descEl.remove();
            }
            row.dataset.search = `${key || ''} ${rawLabel} ${desc}`.toLowerCase();

            const numbers = row.querySelectorAll('input[type="number"]');
            let unitEl = row.querySelector('.set-unit');
            if (numbers.length === 1 && label) {
                const target = label.querySelector('.set-label-text') || label;
                const parsed = splitUnit(target.textContent) ||
                    (UNIT_BY_KEY[key] ? {label: target.textContent.trim(), unit: UNIT_BY_KEY[key]} : null);
                if (parsed) {
                    target.textContent = parsed.label;
                    if (!unitEl) {
                        unitEl = document.createElement('span');
                        unitEl.className = 'set-unit';
                        numbers[0].after(unitEl);
                    }
                    unitEl.textContent = parsed.unit;
                } else if (unitEl) {
                    unitEl.remove();
                }
            }
        });
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
        decorateRows();
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

    // ------------------------------------------------- search / profiles
    function filterSettings(term) {
        const query = String(term || '').trim().toLowerCase();
        const panes = $$('.cfg-pane');
        let total = 0;
        panes.forEach(pane => {
            let visible = 0;
            pane.querySelectorAll('.set-row, .form-row').forEach(node => {
                if (!query) {
                    node.classList.remove('search-hidden');
                    return;
                }
                const haystack = node.dataset.search || node.textContent || '';
                const match = haystack.toLowerCase().includes(query);
                node.classList.toggle('search-hidden', !match);
                if (match) visible++;
            });
            // Keep matching sections open and hide sections whose rows all miss.
            pane.querySelectorAll('.form-section').forEach(section => {
                const rows = section.querySelectorAll('.set-row, .form-row');
                if (!query) {
                    section.classList.remove('search-hidden');
                    return;
                }
                if (!rows.length) return;
                if ([...rows].some(row => !row.classList.contains('search-hidden'))) {
                    section.classList.remove('search-hidden', 'collapsed');
                    const title = section.querySelector('.section-title');
                    if (title) title.setAttribute('aria-expanded', 'true');
                } else {
                    section.classList.add('search-hidden');
                }
            });
            pane.dataset.matches = String(visible);
            total += visible;
        });
        const hint = $('#cfgSearchHint');
        if (hint) hint.textContent = query ? String(total) : '';
        if (!query) {
            const active = $('.cfg-pane.active');
            if (active) active.dataset.matches = '';
            return;
        }
        const active = $('.cfg-pane.active');
        if (active && active.dataset.matches === '0') {
            const target = panes.find(pane => Number(pane.dataset.matches) > 0);
            const name = target && target.id.replace(/^pane/, '').toLowerCase();
            const tab = name && $(`.cfg-tab[data-pane="${name}"]`);
            if (tab) tab.click();
        }
    }

    const PROFILE_KEY = 'dxcompass-profiles';
    const PROFILE_SKIP = new Set(['lang', 'theme']);

    function readProfiles() {
        try {
            const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }

    function writeProfiles(profiles) {
        localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
    }

    function renderProfiles(selected) {
        const select = $('#profileSelect');
        if (!select) return;
        const names = Object.keys(readProfiles()).sort();
        select.innerHTML = names.length
            ? names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
            : '<option value="">—</option>';
        if (selected && names.includes(selected)) select.value = selected;
    }

    function saveProfile() {
        const existing = $('#profileSelect').value;
        const answer = window.prompt(ctx.t('settings.profile.name'), existing || '');
        const name = String(answer || '').trim().slice(0, 24);
        if (!name) return;
        const shared = {};
        for (const field of SETTINGS_FIELDS) {
            if (field.storage !== 'shared' || !field.exportable) continue;
            if (PROFILE_SKIP.has(field.key)) continue;
            if (ctx.settings[field.key] === undefined) continue;
            shared[field.key] = cloneSettings(ctx.settings[field.key]);
        }
        const profiles = readProfiles();
        profiles[name] = {settings: shared, savedAt: new Date().toISOString()};
        writeProfiles(profiles);
        renderProfiles(name);
        showToast(ctx.t('settings.profile.saved'));
    }

    async function loadProfile() {
        const name = $('#profileSelect').value;
        const profile = name && readProfiles()[name];
        if (!profile) return;
        const result = validateSettingsPatch(profile.settings, {languages: ctx.i18n.languages});
        if (!Object.keys(result.values).length) {
            showToast(ctx.t('settings.profile.empty'));
            return;
        }
        const before = cloneSettings(ctx.settings);
        applySettingsObject(mergeSettings(ctx.settings, result.values), {authoritative: false});
        localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));
        syncedSettings = before;
        const response = await flushAll();
        if (!response) {
            applySettingsObject(before, {authoritative: true});
            localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));
            showToast(ctx.t('saveFail'));
            return;
        }
        showToast(ctx.t('settings.profile.applied', {name}));
    }

    async function deleteProfile() {
        const name = $('#profileSelect').value;
        if (!name) return;
        const confirmed = await showConfirm(ctx,
            ctx.t('settings.profile.deleteConfirm', {name}), {
                title: ctx.t('settings.profile.deleteTitle'), okText: ctx.t('danger'), danger: true
            });
        if (!confirmed) return;
        const profiles = readProfiles();
        delete profiles[name];
        writeProfiles(profiles);
        renderProfiles();
        showToast(ctx.t('settings.profile.deleted'));
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
            showToast(ctx.t('settings.import.invalidJson'));
            return {ok: false, error: 'parse'};
        }
        const source = parsed && typeof parsed === 'object'
            ? (parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed)
            : null;
        if (!source) {
            showToast(ctx.t('settings.import.missingSettings'));
            return {ok: false, error: 'shape'};
        }
        const incoming = cloneSettings(source);
        delete incoming._rev;
        delete incoming.cfgV;
        const result = validateSettingsPatch(incoming, {languages: ctx.i18n.languages});
        const appliedKeys = Object.keys(result.values);
        if (!appliedKeys.length) {
            showToast(ctx.t('settings.import.nothing'));
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
            ? ctx.t('settings.import.partial', {
                applied: appliedKeys.length - result.rejected.length,
                skipped: result.rejected.length
            })
            : ctx.t('settings.import.ok'));
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
        const label = ctx.t(`settings.domain.${domain}.title`);
        const confirmed = await showConfirm(ctx,
            ctx.t('settings.reset.groupConfirm', {group: label}), {
                title: ctx.t('settings.reset.groupTitle'), okText: ctx.t('danger'), danger: true
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
        /* Keep the map dashboard LTR (Leaflet is not mirrored) but render the
         * settings pane right-to-left for Arabic. */
        document.documentElement.dir = 'ltr';
        const configPanel = $('#configPanel');
        if (configPanel) configPanel.dir = ctx.settings.lang === 'ar' ? 'rtl' : 'ltr';
        document.body.classList.toggle('lang-ar', ctx.settings.lang === 'ar');
        document.title = `DX-Compass · ${t('subtitle')}`;
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
            '#btnQsoView': 'qsoView', '#btnPropView': 'propView', '#btnAnalysisView': 'analysisView', '#btnMultView': 'multView', '#btnAlertView': 'alertView', '#btnOpView': 'op.title', '#propProjLabel': 'propProjection',
            '#propLayerLabel': 'propLayer', '#qsoPanelTitle': 'stPanel', '#qLastTitle': 'stLastQso',
            '#qRateTitle': 'qsoRate', '#qMinTitle': 'qsoPerMin', '#qOpTitle': 'qsoByOp',
            '#qBandTitle': 'qsoByBand', '#qLQsos': 'stQsos', '#qLMults': 'stMults',
            '#qLPoints': 'stPoints', '#qLScore': 'stScore', '#btnSaveCfg': 'save'
        };
        Object.entries(texts).forEach(([selector, key]) => {
            const element = $(selector);
            if (element) element.textContent = t(key);
        });
        $('#btnConfig').title = t('nav.settings');
        $('#btnMenu').title = t('menu');
        const tooltips = {
            '#btnSpotView': 'nav.spotGrid', '#btnQsoView': 'nav.qsoMap',
            '#btnPropView': 'nav.propMap', '#btnAnalysisView': 'nav.analysis',
            '#btnMultView': 'nav.multipliers',
            '#btnAlertView': 'nav.alerts',
            '#btnOpView': 'op.title',
            '#connDot': 'nav.conn',
            '#rotateGroup': 'nav.rotateHint', '#btnClearDb': 'nav.clearDbHint',
            '#saClose': 'nav.close'
        };
        Object.entries(tooltips).forEach(([selector, key]) => {
            const element = $(selector);
            if (element) element.title = t(key);
        });
        setText('#qRateFrom', t('nav.rateFrom'));
        setText('#qRateNow', t('now'));
        $('#wallTimerStartLabel').textContent = `${t('wallTimerStart')} (UTC)`;
        $('#wallTimerEndLabel').textContent = `${t('wallTimerEnd')} (UTC)`;
        $('#cfgHint').innerHTML = t('cfgHint');
        $('#btnRotateNext').title = t('nextPage');
        $('#rotSec').title = t('rotSecTitle');
        const search = document.querySelector('#cfgSearch');
        if (search) search.placeholder = t('settings.action.search');

        setText('#tabData', t('settings.tab.data'));
        setText('#tabProp', t('settings.tab.prop'));
        setText('#tabContest', t('settings.tab.contest'));
        setText('#globalAdvancedTitle', t('settings.section.advanced'));
        setText('#basicSectionTitle', t('settings.section.basic'));
        setText('#spotAdvancedTitle', t('settings.section.display'));
        setText('#qsoAdvancedTitle', t('settings.section.displayAlerts'));
        setText('#wallAdvancedTitle', t('settings.section.advanced'));
        setText('#dataTitle', t('settings.section.data'));
        setText('#propTitle', t('settings.section.prop'));
        setText('#contestCalendarTitle', t('settings.section.calendar'));
        setText('#contestWindowTitle', t('settings.section.contestWindow'));
        setText('#contestPickLabel', t('settings.calendar.pick'));
        setText('#contestSourceHint', t('settings.hint.contestSource'));
        setText('#btnContestRefresh', t('settings.calendar.refresh'));
        setText('#btnContestClear', t('settings.calendar.clear'));
        setText('#contestResetLabel', t('settings.reset.contest'));
        setText('#contestMultBandLabel', t('settings.field.multPerBand.label'));
        setText('#backupTitle', t('settings.section.backup'));
        setText('#backupHint', t('settings.hint.backup'));
        setText('#btnExportSettings', t('settings.action.export'));
        setText('#btnImportSettings', t('settings.action.import'));
        setText('#dataHint', t('settings.hint.data'));
        setText('#propSettingsHint', t('settings.hint.prop'));
        setText('#spotResetLabel', t('settings.reset.spot'));
        setText('#qsoResetLabel', t('settings.reset.qso'));
        setText('#wallResetLabel', t('settings.reset.wall'));
        setText('#dataResetLabel', t('settings.reset.data'));
        setText('#propResetLabel', t('settings.reset.prop'));
        setText('#globalResetLabel', t('settings.reset.global'));
        $$('[data-reset-domain]').forEach(button => {
            button.textContent = t('settings.action.resetGroup');
        });
        $$('.cfg-call').forEach((input, index) => {
            input.placeholder = t('nav.slot', {n: index + 1});
        });

        renderThemeOptions();
        renderSchemaFields();
        renderContestCalendar();
        ctx.spot.applyLang();
        ctx.qso.renderLastQso();
        ctx.qso.renderQsoPanel();
        ctx.records.applyLang();
        ctx.prop.applyLang();
        ctx.analysis?.applyLang();
        ctx.mult?.applyLang();
        ctx.alerts?.applyLang();
        ctx.op?.applyLang();
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
                ['#setWallTimerOn', 'wallTimerOn'], ['#setContestMultPerBand', 'multPerBand']
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
        renderContestCalendar();
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
        void loadContests();
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
        tiles.innerHTML = Object.keys(TILE_PROVIDERS).map(key =>
            `<option value="${key}">${ctx.t(`settings.field.tiles.option.${key}`)}</option>`).join('');
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
            $$('.cfg-tab').forEach(item => {
                const active = item === button;
                item.classList.toggle('active', active);
                item.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            $$('.cfg-pane').forEach(pane => pane.classList.toggle('active',
                pane.id === `pane${button.dataset.pane.charAt(0).toUpperCase()}${button.dataset.pane.slice(1)}`));
        }));
        // Section headers collapse their card; keyboard and pointer share one path.
        $$('.form-section').forEach(section => {
            const title = section.querySelector('.section-title');
            if (!title) return;
            title.setAttribute('role', 'button');
            title.setAttribute('tabindex', '0');
            title.setAttribute('aria-expanded', 'true');
            const toggle = () => {
                const collapsed = section.classList.toggle('collapsed');
                title.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            };
            title.addEventListener('click', toggle);
            title.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle();
                }
            });
        });
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
        bindCheckedSetting('#setContestMultPerBand', 'multPerBand');

        $('#saClose').addEventListener('click', ctx.qso.hideSpotAlertAndVoice);
        $('#btnSpotView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('spots'); });
        $('#btnQsoView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('qso'); });
        $('#btnPropView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('prop'); });
        $('#btnAnalysisView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('analysis'); });
        $('#btnMultView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('mult'); });
        $('#btnAlertView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('alert'); });
        $('#btnOpView').addEventListener('click', () => { closeConfig(); ctx.qso.setViewMode('op'); });
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
        const search = $('#cfgSearch');
        if (search) search.addEventListener('input', () => filterSettings(search.value));
        renderProfiles();
        $('#btnSaveProfile').addEventListener('click', saveProfile);
        $('#btnLoadProfile').addEventListener('click', () => { void loadProfile(); });
        $('#btnDeleteProfile').addEventListener('click', () => { void deleteProfile(); });

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
        const contestPick = $('#contestPick');
        if (contestPick) {
            contestPick.addEventListener('change', () => {
                const entry = (contestCalendar && Array.isArray(contestCalendar.contests)
                    ? contestCalendar.contests : []).find(item => item.id === contestPick.value);
                if (entry) applyContest(entry);
                else renderContestDetail(null);
            });
        }
        $('#btnContestRefresh')?.addEventListener('click', () => { void refreshCalendar(); });
        $('#btnContestClear')?.addEventListener('click', clearContest);

        buildBandColorInputs();
        renderSchemaFields();
    }

    return {
        bind, pull, save, flush: flushAll, applyRemote, applyLang, applyTheme,
        openConfig, closeConfig, closeAppMenu, loadConfig, buildBandColorInputs,
        exportSettings, importSettings, resetDomainSettings, filterSettings
    };
}
