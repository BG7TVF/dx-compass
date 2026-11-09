import {getSettings} from '../shared/data/settings.mjs';
import {getPropSnapshot} from '../shared/data/propagation.mjs';
import {fetchSpots} from '../shared/data/spots.mjs';
import {fetchQsos} from '../shared/data/qsos.mjs';
import {getStationState} from '../shared/data/station.mjs';
import {bearing} from '../shared/geo/coordinates.mjs';
import {createPoller} from '../shared/monitoring/poller.mjs';
import {
    renderQsoTrend,
    renderRateTrend,
    renderSpaceTrend,
    renderSpotTrend,
    setSpaceDwell
} from './wall-charts.mjs';
import {createOpponentRenderer, opponentColorGradient} from './wall-opponents.mjs';
import {
    renderBands,
    renderQsoStats,
    renderRadios,
    renderSpaceWeather,
    tickClock
} from './wall-cards.mjs';
import {createWallMap} from './wall-map.mjs';

const $ = selector => document.querySelector(selector);
const LAYERS = {
    prop: {name: '传播场', en: 'PROP'},
    aurora: {name: '极光', en: 'AURORA'},
    weather: {name: '天气', en: 'WX'},
    qso: {name: 'QSO', en: 'QSO'},
    myspot: {name: '我方 SPOT', en: 'MY SPOT'},
    dxspot: {name: '对手 SPOT', en: 'DX SPOT'}
};
const LAYER_ORDER = ['prop', 'aurora', 'weather', 'qso', 'myspot', 'dxspot'];
const COLORS = {qso: '#35d6a4', myspot: '#4cc9f0', dxspot: '#ff6b6b'};

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
        qsoRows: [],
        station: null,
        settingsKey: ''
    };
    const wallMap = createWallMap();
    const opponents = createOpponentRenderer({
        bearing: (lat1, lon1, lat2, lon2) => bearing(
            {lat: lat1, lon: lon1},
            {lat: lat2, lon: lon2}
        )
    });
    const secSetting = (key, fallback, min, max) => {
        const value = Number(state.settings && state.settings[key]);
        return (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback) * 1000;
    };
    const numSetting = (key, fallback, min, max) => {
        const value = Number(state.settings && state.settings[key]);
        return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    };

    function renderLegend(shown) {
        const parts = [];
        if (shown.includes('prop')) {
            parts.push('<span>MUF</span><i class="grad" style="background:linear-gradient(90deg,' +
                wallMap.mufLegendGradient() + ')"></i>');
        }
        if (shown.includes('aurora')) {
            parts.push('<span><i class="dot" style="background:#5ce68a"></i>极光</span>');
        }
        if (shown.includes('weather')) {
            parts.push('<span><i class="dot" style="background:#7bc4ff"></i>天气</span>');
        }
        if (shown.includes('qso')) {
            parts.push('<span><i class="dot" style="background:' + COLORS.qso + '"></i>QSO</span>');
        }
        if (shown.includes('myspot')) {
            parts.push('<span><i class="dot" style="background:' + COLORS.myspot + '"></i>我方 SPOT</span>');
        }
        if (shown.includes('dxspot')) {
            /* Each rival has its own colour, so the legend shows the palette
             * swatch instead of a single neutral red. */
            parts.push('<span><i class="dot" style="background:' +
                opponentColorGradient() + '"></i>对手 SPOT</span>');
        }
        $('#mapLegend').innerHTML = parts.join('');
    }

    function applyWallSettings() {
        const settings = state.settings;
        $('#wallName').textContent = settings.wallTitle || 'DX-COMPASS';
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
                $('#layerTag').textContent = LAYERS[state.selected[index]].en +
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
            $('#layerTag').textContent = 'ALL LAYERS · ' + state.selected.length;
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
            state.settings.myCall,
            state.settings.grid
        ]);
        if (key !== state.settingsKey) {
            state.settingsKey = key;
            applyWallSettings();
            wallMap.drawQso(state.qsoRows, state.settings.grid);
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

    async function refreshSpots() {
        try {
            state.spotRows = await fetchSpots({limit: 400});
        } catch (error) {
            /* Keep the previous spots. */
        }
        wallMap.drawSpots(state.spotRows, state.settings.myCall, {
            windowMin: numSetting('opponentWindowMin', 30, 5, 180)
        });
        renderSpotTrend(state.spotRows);
        opponents.render(state.spotRows, state.settings.myCall);
    }

    async function refreshQso() {
        try {
            state.qsoRows = await fetchQsos({limit: 2000});
        } catch (error) {
            /* Keep the previous QSOs. */
        }
        wallMap.drawQso(state.qsoRows, state.settings.grid);
        renderQsoStats(state.qsoRows);
        renderQsoTrend(state.qsoRows);
        renderRateTrend(state.qsoRows);
    }

    async function refreshStation() {
        try {
            state.station = await getStationState();
        } catch (error) {
            /* Keep the previous radios. */
        }
        renderRadios(state.station);
    }

    const pollers = [
        createPoller(refreshProp, {intervalMs: () => secSetting('propPollSec', 60, 30, 600), immediate: false}),
        createPoller(refreshSpots, {intervalMs: () => secSetting('wallSpotSec', 30, 5, 300), immediate: false}),
        createPoller(refreshQso, {intervalMs: () => secSetting('wallQsoSec', 30, 5, 300), immediate: false}),
        createPoller(refreshStation, {intervalMs: () => secSetting('wallStationSec', 15, 5, 120), immediate: false}),
        createPoller(refreshSettings, {intervalMs: () => secSetting('syncSec', 60, 10, 300), immediate: false})
    ];
    const [propPoller, spotPoller, qsoPoller, stationPoller, settingsPoller] = pollers;

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        wallMap.fit();
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            wallMap.invalidate();
            renderQsoTrend(state.qsoRows);
            renderRateTrend(state.qsoRows);
            renderSpotTrend(state.spotRows);
            renderSpaceTrend(state.prop || {});
        }, 200);
    });
    if (window.ResizeObserver) {
        new ResizeObserver(() => opponents.trim()).observe($('#oppRows'));
        /* The grid can settle after the first fit (fonts, wrapped header, data
         * cards), so re-fit whenever the pane itself changes size instead of
         * trusting the size the map was created with. */
        let paneWidth = 0;
        let paneHeight = 0;
        new ResizeObserver(entries => {
            const box = entries[0].contentRect;
            if (!box.width || !box.height) return;
            if (box.width === paneWidth && box.height === paneHeight) return;
            paneWidth = box.width;
            paneHeight = box.height;
            wallMap.fit();
        }).observe($('#map'));
    }

    tickClock(state.settings);
    setInterval(() => tickClock(state.settings), 1000);

    await settingsPoller.run();
    await Promise.all([
        propPoller.run(),
        spotPoller.run(),
        qsoPoller.run(),
        stationPoller.run()
    ]);
    pollers.forEach(poller => poller.start());
}
