import {createI18n} from '../shared/core/i18n.mjs';
import {formatClock, clockOptions} from '../shared/core/clock.mjs';
import {subscribeWS} from '../shared/core/transport.mjs';
import {createMonitoringClient} from '../shared/monitoring/client.mjs';
import {loadLocalSettings} from './settings-model.mjs';
import {createLegacyTranslator} from './legacy-i18n.mjs';
import {$} from './ui.mjs';
import {createSpotPage} from './pages/spot-page.mjs';
import {createQsoPage} from './pages/qso-page.mjs';
import {createRecordsPage} from './pages/records-page.mjs';
import {createSettingsPage} from './pages/settings-page.mjs';
import {createPropagationPage} from './pages/propagation-page.mjs';

async function start() {
    const i18n = createI18n({lang: 'zh'});
    const settings = loadLocalSettings(localStorage, i18n.languages);
    i18n.setLanguage(settings.lang);
    const ctx = {
        settings, i18n,
        t: createLegacyTranslator(i18n, () => settings.lang),
        monitoring: createMonitoringClient()
    };
    ctx.spot = createSpotPage(ctx);
    ctx.qso = createQsoPage(ctx);
    ctx.records = createRecordsPage(ctx);
    ctx.prop = createPropagationPage(ctx);
    ctx.settingsPage = createSettingsPage(ctx);
    ctx.saveSettings = () => ctx.settingsPage.save();

    await ctx.settingsPage.pull();
    ctx.settingsPage.applyTheme(settings.theme);
    ctx.spot.init();
    ctx.qso.init();
    ctx.prop.init();
    ctx.settingsPage.bind();
    ctx.settingsPage.applyLang();
    ctx.records.init();
    await ctx.settingsPage.loadConfig();
    void ctx.qso.loadStation();
    void ctx.monitoring.start(ctx.spot.state.monitoring);

    ctx.ws = subscribeWS({
        url: '/ws',
        onState: state => ctx.spot.setConnState(state),
        onOpen: () => ctx.monitoring.handleOpen(),
        onMessage: message => {
            switch (message && message.type) {
                case 'radio':
                case 'score':
                    ctx.qso.handleStationMessage(message);
                    break;
                case 'qso':
                    ctx.qso.handleQso(message);
                    break;
                case 'qsoDelete':
                    ctx.qso.handleQsoDelete(message);
                    break;
                case 'settings':
                    ctx.settingsPage.applyRemote(message);
                    break;
                default:
                    ctx.spot.handleSpot(message);
            }
        }
    });

    function refreshClock() {
        const options = clockOptions(ctx.settings);
        const label = options.timeZone === 'local' ? ctx.t('nav.local') : 'UTC';
        $('#utcClock').textContent = `${label}: ${formatClock(new Date(), options)}`;
    }
    ctx.refreshClock = refreshClock;

    let lastClock = 0;
    let lastTick = 0;
    let lastPrune = 0;
    const clampSec = (value, fallback, min, max) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    };

    setInterval(() => {
        const now = Date.now();
        if (now - lastClock >= clampSec(ctx.settings.clockSec, 1, 1, 60) * 1000) {
            lastClock = now;
            refreshClock();
        }
        if (ctx.qso.state.view === 'qso') ctx.qso.updateQsoAge();
    }, 250);
    setInterval(() => {
        const now = Date.now();
        if (now - lastTick >= clampSec(ctx.settings.fadeSec, 10, 5, 60) * 1000) {
            lastTick = now;
            ctx.spot.tick(now);
            ctx.qso.tick(now);
        }
        if (now - lastPrune >= clampSec(ctx.settings.pruneSec, 30, 10, 300) * 1000) {
            lastPrune = now;
            ctx.spot.prune(now);
        }
    }, 1000);
    window.addEventListener('resize', () => {
        if (ctx.qso.state.view === 'spots') ctx.spot.refreshMaps();
        else if (ctx.qso.state.view === 'qso') ctx.qso.refreshMap();
        else ctx.prop.resize();
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void start(); }, {once: true});
else void start();
