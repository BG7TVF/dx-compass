import {getSettings} from '../shared/data/settings.mjs';
import {getPropSnapshot} from '../shared/data/propagation.mjs';
import {fetchSpots} from '../shared/data/spots.mjs';
import {fetchCallsigns} from '../shared/data/callsigns.mjs';
import {fetchQsos} from '../shared/data/qsos.mjs';
import {getStationState} from '../shared/data/station.mjs';
import {bearing} from '../shared/geo/coordinates.mjs';
import {getJson} from '../shared/core/transport.mjs';
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
import {applyStatic, getLanguage, setLanguage, t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
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
        watched: [],
        watchedRows: [],
        qsoRows: [],
        station: null,
        settingsKey: '',
        build: ''
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
            parts.push('<span><i class="dot" style="background:#5ce68a"></i>' +
                t('wall.layer.aurora') + '</span>');
        }
        if (shown.includes('weather')) {
            parts.push('<span><i class="dot" style="background:#7bc4ff"></i>' +
                t('wall.layer.weather') + '</span>');
        }
        if (shown.includes('qso')) {
            parts.push('<span><i class="dot" style="background:' + COLORS.qso + '"></i>' +
                t('wall.layer.qso') + '</span>');
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
            wallMap.drawQso(state.qsoRows, state.settings.grid);
            /* Re-render the text that the modules compose from the dictionary:
             * legend, opponent cards, chart captions and the station cards. */
            if (langChanged) {
                tickClock(state.settings);
                renderRadios(state.station);
                renderSpaceTrend(state.prop || {});
                opponents.render(state.watchedRows, state.settings.myCall, state.watched);
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
        opponents.render(state.watchedRows, state.settings.myCall, state.watched);
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
            watched: state.watched
        });
        renderSpotTrend(state.spotRows);
        opponents.render(state.watchedRows, state.settings.myCall, state.watched);
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
        /* Capped at 15 s so a language switch on the settings page reaches the
         * wall promptly, even when the configured sync interval is longer. */
        createPoller(refreshSettings, {intervalMs: () => Math.min(secSetting('syncSec', 60, 10, 300), 15000), immediate: false}),
        /* One tiny check per minute; a changed fingerprint reloads the tab. */
        createPoller(refreshBuild, {intervalMs: () => 60000, immediate: false})
    ];
    const [propPoller, callsignPoller, spotPoller, qsoPoller, stationPoller,
        settingsPoller] = pollers;

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            renderQsoTrend(state.qsoRows);
            renderRateTrend(state.qsoRows);
            renderSpotTrend(state.spotRows);
            renderSpaceTrend(state.prop || {});
        }, 200);
    });
    if (window.ResizeObserver) {
        new ResizeObserver(() => opponents.trim()).observe($('#oppRows'));
        /* #map itself is observed inside createMapSurface(), so the pane's own
         * size changes (fonts, wrapped header, data cards) re-fit the map there
         * instead of keeping a second observer here. */
    }

    tickClock(state.settings);
    setInterval(() => tickClock(state.settings), 1000);
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
        stationPoller.run()
    ]);
    pollers.forEach(poller => poller.start());
}
