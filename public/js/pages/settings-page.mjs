import {getJson, postJson} from '../../shared/core/transport.mjs';
import {getSettings as getSharedSettings, saveSettings as saveSharedSettings, settingsFromMessage} from '../../shared/data/settings.mjs';
import {TILE_PROVIDERS} from '../../shared/map/base-map.mjs';
import {isValidMaidenhead} from '../../shared/geo/maidenhead.mjs';
import {
    DEFAULT_BAND_COLORS, THEMES, WALL_CHECKS, WALL_LAYERS, sanitizeSettings
} from '../settings-model.mjs';
import {$, $$, showConfirm, showToast} from '../ui.mjs';

export function createSettingsPage(ctx) {
    let pushTimer = null, pendingPush = null, applyingRemote = false;

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

    async function pushNow() {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = null;
        if (applyingRemote) return null;
        if (pendingPush) return pendingPush;
        pendingPush = saveSharedSettings(ctx.settings).catch(() => null).finally(() => { pendingPush = null; });
        return pendingPush;
    }

    function save() {
        localStorage.setItem('dxcompass-settings', JSON.stringify(ctx.settings));
        if (applyingRemote) return;
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
            } else await pushNow();
        } catch {
            // The local cache is the offline fallback.
        }
        ctx.i18n.setLanguage(ctx.settings.lang);
    }

    function setTileProvider(key) {
        if (!TILE_PROVIDERS[key] || ctx.settings.tiles === key) return;
        ctx.settings.tiles = key;
        save();
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
                save();
                ctx.spot.applyBandColors();
            });
            const label = document.createElement('span');
            label.textContent = band;
            item.append(input, label);
            wrap.appendChild(item);
        });
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
        renderThemeOptions();
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

    function applyRemote(message) {
        const raw = settingsFromMessage(message);
        if (!raw) return;
        const previous = {
            lang: ctx.settings.lang, theme: ctx.settings.theme, tiles: ctx.settings.tiles,
            grid: ctx.settings.grid, category: ctx.settings.category, qsoLines: ctx.settings.qsoLines,
            qsoAutoFit: ctx.settings.qsoAutoFit, myCall: ctx.settings.myCall,
            mySpotTtl: ctx.settings.mySpotTtl, mySpotMax: ctx.settings.mySpotMax,
            propDxLat: ctx.settings.propDxLat, propDxLon: ctx.settings.propDxLon,
            colors: JSON.stringify(ctx.settings.bandColors)
        };
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
            if (ctx.settings.grid !== previous.grid ||
                ctx.settings.propDxLat !== previous.propDxLat || ctx.settings.propDxLon !== previous.propDxLon) {
                void ctx.prop.refresh();
            }
        } finally {
            applyingRemote = false;
        }
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
                save();
                after(value);
            }
        });
    }

    function bindCheckedSetting(selector, key, after = () => {}) {
        const input = $(selector);
        input.checked = ctx.settings[key];
        input.addEventListener('change', () => {
            ctx.settings[key] = input.checked;
            save();
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
            save();
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
            save();
            applyLang();
        });
        renderThemeOptions();
        $('#setTheme').addEventListener('change', () => {
            applyTheme($('#setTheme').value);
            save();
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
            save();
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
                save();
            });
        });
        const wallMode = $('#setWallMode');
        wallMode.value = ctx.settings.wallMode;
        wallMode.addEventListener('change', () => {
            ctx.settings.wallMode = wallMode.value;
            save();
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
                save();
            });
        }
        buildBandColorInputs();
    }

    return {
        bind, pull, save, flush: pushNow, applyRemote, applyLang, applyTheme,
        openConfig, closeConfig, closeAppMenu, loadConfig, buildBandColorInputs
    };
}
