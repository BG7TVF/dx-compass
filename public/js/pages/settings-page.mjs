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

/* Short Chinese descriptions for the row list. The schema keeps the English
 * source text; this map only feeds the muted second line under each label. */
const DESC_ZH = {
    lang: '界面语言，切换后立即生效。',
    theme: '全局配色主题，立即应用到所有页面。',
    tiles: '底图来源；国内网络建议选择高德。',
    myCall: '用于标记“我的 SPOT”并自动调整被监控呼号。',
    grid: 'Maidenhead 网格，决定本台在 QSO 地图与传播页的位置。',
    layout: '地图宫格布局，仅保存在本机。',
    timeZone: '时钟与表格使用 UTC 还是本地时间。',
    hour12: '使用 12 小时制显示时间。',
    showSeconds: '在时钟与记录时间中显示秒。',
    clockSec: '时钟刷新的间隔。',
    ttl: '各模式标记、连线与频段徽章的存活时间。',
    bandColors: '标记、连线与频段徽章使用的频段配色。',
    rotationSec: '轮播模式翻页的间隔。',
    autoFitMaxZoom: '单格自动适配时的最大缩放层级。',
    fitPad: '自动适配边界时保留的内边距比例。',
    terminatorShow: '绘制晨昏线与夜侧阴影。',
    terminatorSec: '晨昏线重新计算的间隔。',
    heatShow: '按频段显示 CW/DIGI 热力图。',
    heatRadius: '热力光斑半径（像素）。',
    heatBlur: '热力光斑模糊半径（像素）。',
    heatOpacity: '热力图层的最低不透明度。',
    gcShow: '绘制被监听站到监听站的大圆路径。',
    gcSamples: '每条大圆路径的插值采样点数。',
    spotterSize: '红色监听站标记的直径（像素）。',
    monitoredSize: '绿色被监听站标记的直径（像素）。',
    historyLimit: '浏览器刷新后回放的 SPOT 数量。',
    markerMax: '每格保留的最大标记数，超出丢弃最旧。',
    fadeSec: '重新计算标记透明度的间隔。',
    pruneSec: '清理过期标记的间隔。',
    category: '决定是否显示多机台卡片。',
    qsoMax: 'QSO 标记上限，超出丢弃最旧。',
    qsoLines: '从本台向每个 QSO 绘制大圆连线。',
    qsoAutoFit: 'QSO 更新后自动缩放到全部标记。',
    qsoSpotAlert: '显示页内新 SPOT 提示卡。',
    qsoVoiceAlert: '使用语音合成播报新 SPOT。',
    mySpotTtl: '我的呼号衍生标记的存活时间。',
    mySpotMax: '我的 SPOT 标记数量上限。',
    mySpotPopup: '我的 SPOT 弹出提示卡。',
    mySpotVoice: '我的 SPOT 语音播报。',
    rateBucketMin: 'QSO 速率图的分桶宽度。',
    minBuckets: '对齐整点的分桶数量。',
    qsoHistoryLimit: '载入时拉取的 QSO 记录条数。',
    freqDeltaKhz: '换频超过该差值才播报。',
    alertPopupMs: '提示卡的显示时长。',
    alertSnrMin: '仅当 SNR 不低于该值时告警。',
    alertDistanceKmMin: '仅当路径长于该距离时告警。',
    voiceRate: '语音合成的语速。',
    voiceVolume: '语音合成的音量。',
    quietFrom: '本地时间，到点后停止弹窗与语音（留空关闭）。',
    quietTo: '本地时间，到点恢复告警；支持跨零点。',
    alertSound: '每次告警播放短提示音，默认关闭，不影响语音。',
    alertSoundVolume: '提示音音量（0 为静音）。',
    wallTitle: '大屏顶部的品牌文字。',
    wallMode: 'all 同时显示全部图层；cycle 自动轮播。',
    wallLayers: '大屏实际渲染的叠加图层。',
    wallTimerOn: '显示 UTC 比赛倒计时。',
    wallTimerStart: '比赛窗口的 UTC 开始时间。',
    wallTimerEnd: '比赛窗口的 UTC 结束时间。',
    cycleSec: '轮播模式下每层停留时间。',
    spaceDwellSec: '空间天气卡片轮播的停留时间。',
    syncSec: '大屏拉取设置的间隔。',
    wallSpotSec: '大屏刷新 SPOT 的间隔。',
    wallQsoSec: '大屏刷新 QSO 的间隔。',
    wallStationSec: '大屏刷新电台快照的间隔。',
    topLat: '大屏世界适配的北侧裁剪纬度。',
    bottomLat: '大屏世界适配的南侧裁剪纬度。',
    opponentWindowMin: '对手卡片统计的 SPOT 时间窗。',
    opponentCompactMin: '对手数达到该值时切换紧凑网格。',
    opponentBandsMax: '单张对手卡片最多显示的频段数。',
    concentrationMin: '主导方向标签所需的最低占比。',
    pollDxwatchSec: 'dxwatch 采集间隔；5 秒流程节拍受此值控制。',
    pollRbnSec: 'reversebeacon 采集间隔；建议不低于 5 秒。',
    pollPskrSyncSec: 'PSKReporter MQTT 订阅同步间隔。',
    sourceDxwatch: 'dxwatch 数据源总开关。',
    sourceRbn: 'reversebeacon.net 数据源总开关。',
    sourcePskr: 'PSKReporter MQTT 数据源总开关。',
    freshSec: '服务端回放的活跃窗口；更早的 SPOT 仍会保存。',
    retentionSpotsDays: '每小时清理 SPOT 表；0 表示永久保留。',
    retentionRecordingMonths: '每小时清理早于该月数的录音 SPOT。',
    retentionQsoDays: '每小时清理 QSO 表；0 表示永久保留。',
    autoPurge: '启用每小时保留策略清理任务。',
    recordsRefreshSec: '记录面板的刷新间隔。',
    propPollSec: '传播页的轮询间隔。',
    maxCallsigns: '/api/callsigns 与 PSKR 订阅列表的上限。',
    logLevel: 'DX-Compass 模块日志级别；Node-RED 核心日志仍由 settings.js 控制。',
    httpProxy: '传播采集器的出站代理；留空为直连。',
    fetchTimeoutMs: '传播采集器单次请求超时。',
    upstreamBase: 'services.swpc.noaa.gov 的替代地址；留空使用官方地址。',
    n1mmPorts: '只读：UDP 端口是 flow.json 的节点属性，修改需要编辑流程并重新部署。',
    recordingRepeat: 'once / daily / weekly 定时录音。',
    diskWarnPct: '工作目录所在文件系统使用率超过该百分比时告警。',
    diskCheckSec: '两次磁盘检查之间的最小间隔。',
    diskAlert: '超过阈值时输出 Node-RED 警告。',
    monitoring: '运行时开关；保存在本机与 global.monitoring，不写入 uiSettings。',
    propProj: '传播地图使用的投影。',
    propLayer: '传播栅格叠加图层。',
    propDxLat: '点对点 DX 目标的纬度。',
    propDxLon: '点对点 DX 目标的经度。',
    collectSec: 'SWPC/GAMBIT 采集间隔；30 秒流程节拍受此值控制。',
    condClosed: '频率达到 MUF 的该比例以上判定为 Closed。',
    condGood: '余量比例高于该值判定为 Good。',
    condFair: '余量比例高于该值判定为 Fair。',
    mufOpacity: '传播页与大屏 MUF 栅格的透明度（0-255）。',
    nightOpacity: '夜侧阴影透明度，晨昏带随之缩放。'
};

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
const CUSTOM_DESC = {
    setQrzUser: ['用于查询呼号资料；仅保存在本机。', 'Used for callsign lookups; kept in this browser only.'],
    setQrzPass: ['QRZ.com 密码，仅在保存时提交。', 'QRZ.com password; submitted only when saved.'],
    setWallProp: ['传播地图与 MUF 栅格。', 'Propagation map and MUF raster.'],
    setWallAurora: ['极光椭圆叠加。', 'Aurora oval overlay.'],
    setWallWeather: ['空间天气卡片与太阳图像。', 'Space-weather cards and solar imagery.'],
    setWallQso: ['QSO 连线与比分。', 'QSO paths and score.'],
    setWallMySpot: ['本台呼号衍生的标记。', 'Markers derived from your own callsign.'],
    setWallDxSpot: ['被监控对手的 SPOT 标记。', 'Spot markers for monitored rivals.']
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
    const PROP_SETTING_KEYS = new Set([
        'propProj', 'propLayer', 'propDxLat', 'propDxLon',
        'mufOpacity', 'nightOpacity', 'propPollSec'
    ]);
    const LIVE_SETTING_KEYS = new Set([
        ...CLOCK_SETTING_KEYS, ...MAP_SETTING_KEYS, ...QSO_SETTING_KEYS, ...PROP_SETTING_KEYS
    ]);

    /** Push only the affected display groups into the live pages. */
    function applyLiveSettings(keys = LIVE_SETTING_KEYS) {
        const changed = [...keys];
        if (changed.some(key => CLOCK_SETTING_KEYS.has(key))) ctx.refreshClock?.();
        if (changed.some(key => MAP_SETTING_KEYS.has(key))) ctx.spot?.applyMapSettings?.();
        if (changed.some(key => QSO_SETTING_KEYS.has(key))) ctx.qso?.applyDisplaySettings?.();
        if (changed.some(key => PROP_SETTING_KEYS.has(key))) ctx.prop?.applySettings?.();
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
        if (field.readonly) flags.push(`<span class="set-flag readonly">${bi('只读', 'read-only')}</span>`);
        if (field.restart) flags.push(`<span class="set-flag restart">${bi('需重启', 'restart')}</span>`);
        const label = bi(field.zh, field.label);
        const desc = ctx.settings.lang === 'zh' ? (DESC_ZH[field.key] || field.desc) : field.desc;
        return `<div class="set-row" data-search="${escapeHtml(`${field.key} ${field.label} ${field.zh} ${desc}`.toLowerCase())}">` +
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
        const field = SETTINGS_SCHEMA.FIELD_MAP[key];
        if (field) return ctx.settings.lang === 'zh' ? (DESC_ZH[key] || field.desc) : field.desc;
        const custom = CUSTOM_DESC[key];
        return custom ? custom[ctx.settings.lang === 'zh' ? 0 : 1] : '';
    }

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
            const customDesc = controlId && CUSTOM_DESC[controlId];
            const rawLabel = label
                ? (label.querySelector('.set-label-text')?.textContent || label.textContent || '')
                : '';
            const desc = customDesc
                ? customDesc[ctx.settings.lang === 'zh' ? 0 : 1]
                : (key ? descFor(key) : '');
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
        const answer = window.prompt(bi('配置档名称', 'Profile name'), existing || '');
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
        showToast(bi('配置档已保存', 'Profile saved'));
    }

    async function loadProfile() {
        const name = $('#profileSelect').value;
        const profile = name && readProfiles()[name];
        if (!profile) return;
        const result = validateSettingsPatch(profile.settings, {languages: ctx.i18n.languages});
        if (!Object.keys(result.values).length) {
            showToast(bi('该配置档没有可用设置', 'This profile has no usable settings'));
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
        showToast(bi(`已应用配置档「${name}」`, `Applied profile "${name}"`));
    }

    async function deleteProfile() {
        const name = $('#profileSelect').value;
        if (!name) return;
        const confirmed = await showConfirm(ctx,
            bi(`确定删除配置档「${name}」吗？`, `Delete the profile "${name}"?`), {
                title: bi('删除配置档', 'Delete profile'), okText: ctx.t('danger'), danger: true
            });
        if (!confirmed) return;
        const profiles = readProfiles();
        delete profiles[name];
        writeProfiles(profiles);
        renderProfiles();
        showToast(bi('配置档已删除', 'Profile deleted'));
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
        setText('#basicSectionTitle', bi('基础', 'Basics'));
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
        buildBandColorInputs();
        renderSchemaFields();
    }

    return {
        bind, pull, save, flush: flushAll, applyRemote, applyLang, applyTheme,
        openConfig, closeConfig, closeAppMenu, loadConfig, buildBandColorInputs,
        exportSettings, importSettings, resetDomainSettings, filterSettings
    };
}
