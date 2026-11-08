import {createI18n} from '../shared/core/i18n.mjs';
import {formatUtcTime} from '../shared/core/clock.mjs';
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

    setInterval(() => {
        $('#utcClock').textContent = `UTC: ${formatUtcTime(new Date())}`;
        if (ctx.qso.state.view === 'qso') ctx.qso.updateQsoAge();
    }, 1000);
    setInterval(() => {
        const now = Date.now();
        ctx.spot.tick(now);
        ctx.qso.tick(now);
    }, 10000);
    setInterval(() => ctx.spot.prune(), 30000);
    window.addEventListener('resize', () => {
        if (ctx.qso.state.view === 'spots') ctx.spot.refreshMaps();
        else if (ctx.qso.state.view === 'qso') ctx.qso.refreshMap();
        else ctx.prop.resize();
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void start(); }, {once: true});
else void start();
