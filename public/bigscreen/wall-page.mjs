import {getSettings} from '../shared/data/settings.mjs';
import {getPropSnapshot} from '../shared/data/propagation.mjs';
import {fetchSpots} from '../shared/data/spots.mjs';
import {fetchCallsigns} from '../shared/data/callsigns.mjs';
import {fetchQsos} from '../shared/data/qsos.mjs';
import {getStationState} from '../shared/data/station.mjs';
import {getDevicesSnapshot} from '../shared/data/devices.mjs';
import {bearing} from '../shared/geo/coordinates.mjs';
import {getJson} from '../shared/core/transport.mjs';
import {createPoller} from '../shared/monitoring/poller.mjs';
import {
    renderMinuteTrend,
    renderPointsCurve,
    renderSpaceTrend,
    setSpaceDwell
} from './wall-charts.mjs';
/* 标记淡出/剪枝的节拍与主视图共用一份实现：改设置里的 fadeSec / pruneSec，
 * 大屏地图也跟着变。 */
import {fadeTickMs, pruneTickMs} from '../shared/map/marker-life.mjs';
import {buildOpponents, createOpponentRenderer, opponentColorGradient} from '../shared/opponents/opponents.mjs';
import {
    renderBands,
    renderKpi,
    renderOpponentMatrix,
    renderQsoLog,
    renderQsoStats,
    renderSpaceWeather,
    SEAT_COLORS,
    tickClock,
    tr
} from './wall-cards.mjs';
import {
    buildSeats,
    renderAntennaUse,
    renderBandOccupancy,
    renderRotors,
    renderSeatRoster
} from './wall-rig.mjs';
import {createWallMap} from './wall-map.mjs';
import {applyStatic, getLanguage, setLanguage, t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
const LAYER_ORDER = ['prop', 'aurora', 'weather', 'qso', 'myspot', 'dxspot'];
const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0', dxspot: '#ff6b6b'};

/* 地图图例的席位色块：与 opponentColorGradient() 同一手法（conic-gradient 硬分
 * 段）。地图上的 QSO 落点按席位取色（见 wall-map 的 seat.color），原来那一颗
 * 绿色圆点等于没说话。地图点位只有颜色、没有形状标记，所以图例里不提形状——
 * 「颜色 / 形状 = 席位」那句话只挂在流水表表头上，那里两种编码都在。 */
const seatColorGradient = () => 'conic-gradient(' + SEAT_COLORS.map((color, index) =>
    color + ' ' + Math.round(index * 100 / SEAT_COLORS.length) + '% ' +
    Math.round((index + 1) * 100 / SEAT_COLORS.length) + '%').join(',') + ')';

export async function startWallPage() {
    const state = {
        settings: {
            wallTitle: 'DX-COMPASS',
            wallLayers: ['prop', 'qso', 'myspot', 'dxspot'],
            wallMode: 'all'
        },
        prop: null,
        selected: [],
        cycleTimer: null,
        spotRows: [],
        watched: [],
        watchedRows: [],
        qsoRows: [],
        station: null,
        devices: null,
        model: null,
        settingsKey: '',
        build: ''
    };
    const wallMap = createWallMap();
    /* 同一个方位角函数既喂共享渲染器，也喂 buildOpponents 的家数判定，
     * 保证「算不算对手」两边口径完全一致。 */
    const bearingOf = (lat1, lon1, lat2, lon2) => bearing(
        {lat: lat1, lon: lon1},
        {lat: lat2, lon: lon2}
    );
    const opponents = createOpponentRenderer({t, bearing: bearingOf});
    /* 非 null = 对手栏当前处于矩阵模式（对手 < 4 家）；resize 时重排矩阵，
     * 而不是交给共享渲染器的 trim——它的 trim 会拿旧的大卡盖掉矩阵。 */
    let oppMatrixRivals = null;
    const secSetting = (key, fallback, min, max) => {
        const value = Number(state.settings && state.settings[key]);
        return (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback) * 1000;
    };
    const numSetting = (key, fallback, min, max) => {
        const value = Number(state.settings && state.settings[key]);
        return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    };

    /* ---------- 对手栏本地渲染 ----------
     * 先用 buildOpponents 数出对手家数：不足 4 家时，共享渲染器的「一家一张
     * 横条大卡」会让整栏高度被两三家占满、几乎没有信息量，改走 wall-cards 的
     * 「波段 × 对手」紧凑矩阵（只有 1 家时矩阵退化成单列，仍然照画）；
     * ≥4 家或一家都没有时沿用共享渲染器（空态文案也由它负责）。
     * spot 列表、SPOT、语言切换、resize 四路刷新统一走这个入口，
     * 保证任何一路数据变化都会按同一口径重算。 */
    function renderOpponents() {
        const rivals = buildOpponents(state.watchedRows, state.settings.myCall, bearingOf, {
            windowMs: numSetting('opponentWindowMin', 30, 5, 180) * 60000,
            concentrationMin: numSetting('concentrationMin', 0.4, 0, 1),
            watched: state.watched
        });
        if (rivals.length && rivals.length < 4) {
            oppMatrixRivals = rivals;
            renderOpponentMatrix($('#oppRows'), rivals);
            /* 摘要徽标与共享渲染器同口径：N 对手 · M 频段。 */
            const bands = new Set();
            rivals.forEach(rival => rival.bands.forEach(band => bands.add(band.band)));
            $('#oppSummary').textContent =
                t('wall.opp.summary', {count: rivals.length, bands: bands.size});
        } else {
            oppMatrixRivals = null;
            $('#oppRows').classList.remove('opp-matrix');
            opponents.render(state.watchedRows, state.settings.myCall, state.watched);
        }
    }

    function renderLegend(shown) {
        const parts = [];
        if (shown.includes('prop')) {
            parts.push('<span>MUF</span><i class="grad" style="background:linear-gradient(90deg,' +
                wallMap.mufLegendGradient() + ')"></i>');
        }
        if (shown.includes('aurora')) {
            parts.push('<span><i class="dot" style="background:#5ce68a"></i>' +
                t('wall.layer.aurora') + '</span>');
        }
        if (shown.includes('weather')) {
            parts.push('<span><i class="dot" style="background:#7bc4ff"></i>' +
                t('wall.layer.weather') + '</span>');
        }
        if (shown.includes('qso')) {
            /* 地图上的 QSO 落点只按席位取色、没有形状标记，所以这句只说
             * 「颜色 = 席位」。字典里现成的 wall.legend.seatColor 是流水表用的
             * 「颜色 / 形状 = 席位」双编码说明，直接复用会提到图上不存在的
             * 形状编码，因此走 tr 给地图专用的兜底文案。 */
            parts.push('<span><i class="dot" style="background:' + seatColorGradient() + '"></i>' +
                t('wall.layer.qso') + ' · ' + tr('wall.legend.mapSeatColor', '颜色 = 席位') + '</span>');
        }
        if (shown.includes('myspot')) {
            parts.push('<span><i class="dot" style="background:' + COLORS.myspot + '"></i>' +
                t('wall.layer.myspot') + '</span>');
        }
        if (shown.includes('dxspot')) {
            /* Each rival has its own colour, so the legend shows the palette
             * swatch instead of a single neutral red. */
            parts.push('<span><i class="dot" style="background:' +
                opponentColorGradient() + '"></i>' + t('wall.layer.dxspot') + '</span>');
        }
        $('#mapLegend').innerHTML = parts.join('');
    }

    function applyWallSettings() {
        const settings = state.settings;
        $('#wallName').textContent = settings.wallTitle || 'DX-COMPASS';
        /* 地图左上角一句话简介，随语言切换刷新；layer-tag 占右上角，两不相碰。 */
        $('#mapTitle').textContent = tr('wall.map.title', '电波覆盖 · 每条线 = 一条已通 QSO');
        const layers = Array.isArray(settings.wallLayers) ? settings.wallLayers : [];
        const selected = LAYER_ORDER.filter(key => layers.includes(key));
        state.selected = selected.length ? selected : ['prop'];
        wallMap.setRange(numSetting('topLat', 85, 0, 90), numSetting('bottomLat', -85, -90, 0));
        wallMap.setOverlays(
            numSetting('mufOpacity', 77, 0, 255),
            numSetting('nightOpacity', 0.18, 0, 1)
        );
        opponents.setOptions({
            windowMin: numSetting('opponentWindowMin', 30, 5, 180),
            concentrationMin: numSetting('concentrationMin', 0.4, 0, 1),
            compactMin: numSetting('opponentCompactMin', 5, 2, 12),
            bandsMax: numSetting('opponentBandsMax', 12, 3, 12)
        });
        setSpaceDwell(secSetting('spaceDwellSec', 8, 3, 30));

        if (state.cycleTimer) {
            clearInterval(state.cycleTimer);
            state.cycleTimer = null;
        }
        LAYER_ORDER.forEach(key => wallMap.setVisible(key, false));

        if (settings.wallMode === 'cycle' && state.selected.length > 1) {
            let index = 0;
            const show = () => {
                LAYER_ORDER.forEach(key => wallMap.setVisible(key, false));
                wallMap.setVisible(state.selected[index], true);
                $('#layerTag').textContent = t('wall.layer.' + state.selected[index]) +
                    ' · ' + (index + 1) + '/' + state.selected.length;
                renderLegend([state.selected[index]]);
            };
            show();
            state.cycleTimer = setInterval(() => {
                index = (index + 1) % state.selected.length;
                show();
            }, secSetting('cycleSec', 10, 3, 60));
        } else {
            state.selected.forEach(key => wallMap.setVisible(key, true));
            $('#layerTag').textContent = t('wall.layer.all', {count: state.selected.length});
            renderLegend(state.selected);
        }
    }

    async function refreshSettings() {
        try {
            const settings = await getSettings();
            if (settings) state.settings = {...state.settings, ...settings};
        } catch (error) {
            /* Keep the previous settings and the read-only defaults. */
        }
        const lang = state.settings.lang || getLanguage();
        const key = JSON.stringify([
            state.settings.wallTitle,
            state.settings.wallLayers,
            state.settings.wallMode,
            state.settings.cycleSec,
            state.settings.spaceDwellSec,
            state.settings.topLat,
            state.settings.bottomLat,
            state.settings.mufOpacity,
            state.settings.nightOpacity,
            state.settings.opponentWindowMin,
            state.settings.concentrationMin,
            state.settings.opponentCompactMin,
            state.settings.opponentBandsMax,
            /* 地图标记的存活时长与淡出/剪章节拍：改了这些必须立刻重画地图，
             * 否则大屏上的点会一直挂到下一次轮询才变。ttl 是对象，
             * 按固定键展开，避免序列化顺序抖动导致无谓重绘。 */
            state.settings.qsoTtl,
            state.settings.fadeSec,
            state.settings.pruneSec,
            state.settings.markerMax,
            (state.settings.ttl || {}).CW,
            (state.settings.ttl || {}).SSB,
            (state.settings.ttl || {}).DIGI,
            state.settings.myCall,
            state.settings.grid,
            lang
        ]);
        if (key !== state.settingsKey) {
            const langChanged = lang !== getLanguage();
            state.settingsKey = key;
            if (langChanged) {
                setLanguage(lang);
                applyStatic(document);
            }
            applyWallSettings();
            wallMap.drawQso(state.qsoRows, state.settings.grid, state.model, {settings: state.settings});
            /* Re-render the text that the modules compose from the dictionary:
             * legend, opponent cards, chart captions and the station cards. */
            if (langChanged) {
                tickClock(state.settings);
                renderRig();
                renderKpi(state.station, state.qsoRows);
                renderQsoLog($('#qsoLog'), state.qsoRows, state.model);
                renderSpaceTrend(state.prop || {});
                renderOpponents();
            }
        }
        renderBands(state.prop && state.prop.forecast);
    }

    async function refreshProp() {
        try {
            const data = await getPropSnapshot();
            state.prop = data;
            wallMap.renderProp(data && data.forecast && data.forecast.mufGrid);
            renderSpaceWeather(data);
            renderSpaceTrend(data);
            renderBands(data && data.forecast);
            wallMap.drawAurora(data);
            wallMap.drawWeather(data);
        } catch (error) {
            /* Keep the previous propagation snapshot and overlays. */
        }
    }

    async function refreshCallsigns() {
        try {
            state.watched = await fetchCallsigns();
        } catch (error) {
            /* Keep the previous allowlist; the wall never widens it on error. */
            return;
        }
        renderOpponents();
    }

    async function refreshSpots() {
        try {
            state.spotRows = await fetchSpots({limit: 400});
        } catch (error) {
            /* Keep the previous spots. */
        }
        /* The opponent scope is filtered server-side by the live callsign list
         * and the TTL, so a removed call disappears even if this page has a
         * stale list and regional PSKR rows can never crowd the rivals out. */
        try {
            state.watchedRows = await fetchSpots({scope: 'watched', limit: 400});
        } catch (error) {
            /* Keep the previous rival rows. */
        }
        wallMap.drawSpots(state.watchedRows, state.settings.myCall, {
            windowMin: numSetting('opponentWindowMin', 30, 5, 180),
            watched: state.watched,
            settings: state.settings
        });
        renderMinuteTrend(state.qsoRows, state.spotRows);
        renderOpponents();
    }

    /* 席位模型：把设备席位计划表、台站实时状态和 QSO 流水三方合到一张表上，
     * 让"席位 N"这个编号在全页唯一，并且每一条 QSO 都能反查回它属于哪个席位。
     * 三方数据各自的刷新节奏不同，所以任何一路回来都要重建一次。 */
    function rebuildModel() {
        state.model = buildSeats(state.station, state.devices, state.qsoRows);
    }

    /* 台站设备四卡：席位名单、天线归属、波段占用、天线指向。取不到快照时
     * 保留上一次的画面，大屏不应该因为一次超时就把 RF 链路图清空。 */
    function renderRig() {
        const bands = new Set();
        const antennas = (state.devices && state.devices.ownership &&
            state.devices.ownership.antennas) || [];
        antennas.forEach(antenna => (antenna.bands || [])
            .forEach(band => bands.add(String(band).toUpperCase())));
        renderSeatRoster($('#seatCards'), state.model);
        renderAntennaUse($('#antMatrix'), state.devices, state.model);
        renderBandOccupancy($('#bandOcc'), state.qsoRows, state.model, [...bands]);
        renderRotors($('#rotorDials'), state.devices, state.model);
    }

    async function refreshDevices() {
        try {
            state.devices = await getDevicesSnapshot();
        } catch (error) {
            /* Keep the previous device snapshot. */
        }
        rebuildModel();
        renderRig();
    }

    async function refreshQso() {
        try {
            state.qsoRows = await fetchQsos({limit: 2000});
        } catch (error) {
            /* Keep the previous QSOs. */
        }
        rebuildModel();
        wallMap.drawQso(state.qsoRows, state.settings.grid, state.model, {settings: state.settings});
        renderQsoStats(state.qsoRows);
        renderMinuteTrend(state.qsoRows, state.spotRows);
        renderPointsCurve(state.qsoRows);
        renderKpi(state.station, state.qsoRows);
        renderQsoLog($('#qsoLog'), state.qsoRows, state.model);
    }

    async function refreshStation() {
        try {
            state.station = await getStationState();
        } catch (error) {
            /* Keep the previous radios. */
        }
        rebuildModel();
        renderRig();
        renderKpi(state.station, state.qsoRows);
    }

    /* A wall tab stays open for days; when the deployed modules change this
     * page reloads itself instead of keeping an old opponent filter alive. */
    async function refreshBuild() {
        let data;
        try {
            data = await getJson('/wall-build.json');
        } catch (error) {
            return;
        }
        const build = data && data.build;
        if (!build) return;
        if (!state.build) {
            state.build = build;
            return;
        }
        if (build !== state.build) location.reload();
    }

    const pollers = [
        createPoller(refreshProp, {intervalMs: () => secSetting('propPollSec', 60, 30, 600), immediate: false}),
        /* The monitored list changes rarely; one tiny read per minute keeps the
         * rival allowlist current without waiting for a page reload. */
        createPoller(refreshCallsigns, {intervalMs: () => 60000, immediate: false}),
        createPoller(refreshSpots, {intervalMs: () => secSetting('wallSpotSec', 30, 5, 300), immediate: false}),
        createPoller(refreshQso, {intervalMs: () => secSetting('wallQsoSec', 30, 5, 300), immediate: false}),
        createPoller(refreshStation, {intervalMs: () => secSetting('wallStationSec', 15, 5, 120), immediate: false}),
        /* 天线指向与切换器配色变化快（转一次天线的过程中就该看到），
         * 因此设备快照比席位状态更勤；这个 GET 只读，不会下发任何指令。 */
        createPoller(refreshDevices, {intervalMs: () => secSetting('wallDevicesSec', 6, 3, 120), immediate: false}),
        /* Capped at 15 s so a language switch on the settings page reaches the
         * wall promptly, even when the configured sync interval is longer. */
        createPoller(refreshSettings, {intervalMs: () => Math.min(secSetting('syncSec', 60, 10, 300), 15000), immediate: false}),
        /* One tiny check per minute; a changed fingerprint reloads the tab. */
        createPoller(refreshBuild, {intervalMs: () => 60000, immediate: false})
    ];
    const [propPoller, callsignPoller, spotPoller, qsoPoller, stationPoller,
        devicesPoller, settingsPoller] = pollers;

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            renderMinuteTrend(state.qsoRows, state.spotRows);
            renderPointsCurve(state.qsoRows);
            renderSpaceTrend(state.prop || {});
            /* 栏宽变了，明细表的列宽要重新量一次；席位行右侧的四个读数、波段占用
             * 与天线行也是先按宽度换行、再按高度整行删，所以一并重绘。 */
            renderRig();
            renderQsoLog($('#qsoLog'), state.qsoRows, state.model);
        }, 200);
    });
    if (window.ResizeObserver) {
        /* 栏宽变化要重量：矩阵模式重排矩阵（列数不变，但 trimRows 要按新
         * 高度重跑），否则交回共享渲染器的 trim。 */
        new ResizeObserver(() => {
            if (oppMatrixRivals) renderOpponentMatrix($('#oppRows'), oppMatrixRivals);
            else opponents.trim();
        }).observe($('#oppRows'));
        /* #map itself is observed inside createMapSurface(), so the pane's own
         * size changes (fonts, wrapped header, data cards) re-fit the map there
         * instead of keeping a second observer here. */
    }

    tickClock(state.settings);
    /* 一秒一跳，但地图只按各自设定的节奏重画透明度 / 摘掉过期标记，
     * 与 main.mjs 里 QSO、SPOT 视图的做法完全一致。 */
    let lastFade = 0;
    let lastPrune = 0;
    setInterval(() => {
        const now = Date.now();
        tickClock(state.settings, new Date(now));
        if (now - lastFade >= fadeTickMs(state.settings)) {
            lastFade = now;
            wallMap.tick(now);
        }
        if (now - lastPrune >= pruneTickMs(state.settings)) {
            lastPrune = now;
            wallMap.prune(now);
        }
    }, 1000);
    applyStatic(document);

    await settingsPoller.run();
    /* Baseline the deployed build now; a later change reloads this tab. */
    await refreshBuild();
    /* Allowlist before first paint: an empty list must never fall back to
     * "every monitored_call is a rival". */
    await callsignPoller.run();
    await Promise.all([
        propPoller.run(),
        spotPoller.run(),
        qsoPoller.run(),
        stationPoller.run(),
        devicesPoller.run()
    ]);
    /* 三路数据的返回顺序不固定，最后统一重绘一次，保证明细表里的席位配色
     * 用的是完整席位模型，而不是某一路数据先到时的那半个。 */
    rebuildModel();
    renderRig();
    renderQsoLog($('#qsoLog'), state.qsoRows, state.model);
    renderKpi(state.station, state.qsoRows);
    pollers.forEach(poller => poller.start());
}
