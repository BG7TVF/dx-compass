import {getJson, postJson} from '../../shared/core/transport.mjs';
import {clearSpots, createSpotStore, fetchSpots} from '../../shared/data/spots.mjs';
import {createPoller} from '../../shared/monitoring/poller.mjs';
import {$, $$, escapeHtml, formatTime, modeBadge, showConfirm, showToast, signalClass, snrClass} from '../ui.mjs';

export function dtLocalToMdHm(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!match) return null;
    return `${parseInt(match[2], 10)}-${parseInt(match[3], 10)} ${parseInt(match[4], 10)}:${match[5]}`;
}

export function mdHmToDtLocal(value, now = new Date()) {
    const match = String(value || '').match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/);
    if (!match) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${now.getUTCFullYear()}-${pad(match[1])}-${pad(match[2])}T${pad(match[3])}:${pad(match[4])}`;
}

function recordingSpotUrl(call, limit) {
    const query = new URLSearchParams();
    if (call) query.set('call', call);
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString();
    return `/api/recording/spots${suffix ? `?${suffix}` : ''}`;
}

export function createRecordsPage(ctx) {
    const store = createSpotStore();
    const state = {view: 'all', status: null};
    let sequence = 0, refreshTimer = null;

    async function rowsForCurrentView(limit) {
        const call = $('#recordCallSelect').value;
        if (state.view === 'rec') return getJson(recordingSpotUrl(call, limit));
        const rows = await fetchSpots({call, limit});
        store.clear();
        store.replay(rows);
        return store.select({call, newestFirst: true, limit});
    }

    function renderRows(rows, recorded) {
        const body = $('#recordsBody');
        body.innerHTML = '';
        for (const row of rows) {
            const tr = document.createElement('tr');
            if (recorded) {
                tr.innerHTML = `<td>${escapeHtml(row.date || '')}</td><td>${escapeHtml(row.time || '')}</td><td>${escapeHtml(row.call || '')}</td><td>${escapeHtml(row.de)}</td><td>${escapeHtml(row.band || '')}</td><td>${escapeHtml(row.freq || '')}</td><td>${modeBadge(row.mode)}</td><td>${escapeHtml(row.detail || '')}</td><td class="${snrClass(row)}">${row.snr ?? ''}</td><td>${row.distance_km || ''}</td><td title="${escapeHtml(row.comment || '')}">${escapeHtml(String(row.comment || '').substring(0, 30))}</td>`;
            } else {
                tr.innerHTML = `<td>${formatTime(row.timestamp, ctx.settings)}</td><td>${escapeHtml(row.monitored_call)}</td><td>${escapeHtml(row.de)}</td><td>${escapeHtml(row.freq || '')}</td><td>${modeBadge(row.mode)}</td><td class="${signalClass(row)}">${escapeHtml(row.signal || '')}</td><td class="${snrClass(row)}">${row.snr ?? ''}</td><td>${row.distance_km || ''}</td><td title="${escapeHtml(row.comment || '')}">${escapeHtml(String(row.comment || '').substring(0, 30))}</td>`;
            }
            body.appendChild(tr);
        }
        $('#recordsFooter').textContent = ctx.t('recordsN')(rows.length);
    }

    async function refresh() {
        const current = ++sequence, recorded = state.view === 'rec';
        const head = [...ctx.t(recorded ? 'headRec' : 'headAll')];
        if (!recorded && ctx.settings.timeZone === 'local' && head.length) {
            head[0] = ctx.t('records.timeLocal');
        }
        $('#recordsHead').innerHTML = head.map(text => `<th>${text}</th>`).join('');
        try {
            const rows = await rowsForCurrentView();
            if (current !== sequence) return;
            renderRows(rows, recorded);
        } catch {
            if (current === sequence) showToast(ctx.t('loadFail'));
        }
    }

    function refreshSoon() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void refresh();
        }, 2000);
    }

    function populateCallSelect() {
        const select = $('#recordCallSelect'), current = select.value;
        select.innerHTML = `<option value="">${ctx.t('allCalls')}</option>`;
        for (const call of ctx.spot.state.callsigns.filter(Boolean)) {
            const option = document.createElement('option');
            option.value = call;
            option.textContent = call;
            select.appendChild(option);
        }
        select.value = current;
    }

    function renderRecordingStatus(rec, syncInputs) {
        state.status = rec;
        const dot = $('#recDot'), text = $('#recStatus'), button = $('#btnRecToggle');
        if (rec.active) {
            dot.className = 'rec-dot active';
            const since = rec.startedAt ? `${rec.startedAt.substring(5, 16).replace('T', ' ')}Z` : '';
            text.textContent = (rec.manual ? ctx.t('recManual') : ctx.t('recSched')) +
                (since ? ` ${ctx.t('since')} ${since}` : '');
            button.textContent = ctx.t('stopRec');
            button.classList.add('recording');
        } else {
            dot.className = rec.schedule ? 'rec-dot scheduled' : 'rec-dot idle';
            text.textContent = rec.schedule
                ? `${ctx.t('scheduled')}: ${rec.schedule.start} → ${rec.schedule.end} UTC`
                : ctx.t('notRecording');
            button.textContent = ctx.t('record');
            button.classList.remove('recording');
        }
        if (syncInputs && rec.schedule) {
            $('#recStart').value = mdHmToDtLocal(rec.schedule.start);
            $('#recEnd').value = mdHmToDtLocal(rec.schedule.end);
        }
    }

    async function refreshRecordingStatus(syncInputs = false) {
        try {
            renderRecordingStatus(await getJson('/api/recording'), syncInputs);
        } catch {
            // Keep the last known recording state during a backend restart.
        }
    }

    async function action(body) {
        try {
            return await postJson('/api/recording', body);
        } catch (error) {
            throw new Error(error.body && error.body.error || error.message);
        }
    }

    async function toggleRecording() {
        const stopping = state.status && state.status.active;
        try {
            await action({action: stopping ? 'stop' : 'start'});
            showToast(stopping ? ctx.t('recStopped') : ctx.t('recStarted'));
            await refreshRecordingStatus();
            if (state.view === 'rec') await refresh();
        } catch (error) {
            showToast(`Recording: ${error.message}`);
        }
    }

    async function setSchedule() {
        const start = dtLocalToMdHm($('#recStart').value), end = dtLocalToMdHm($('#recEnd').value);
        if (!start || !end) {
            showToast(ctx.t('pickDt'));
            return;
        }
        try {
            await action({action: 'schedule', start, end});
            showToast(ctx.t('schedOk'));
            await refreshRecordingStatus(true);
        } catch (error) {
            showToast(`Schedule: ${error.message}`);
        }
    }

    async function clearSchedule() {
        try {
            await action({action: 'unschedule'});
            $('#recStart').value = '';
            $('#recEnd').value = '';
            showToast(ctx.t('schedCleared'));
            await refreshRecordingStatus(true);
        } catch (error) {
            showToast(`Schedule: ${error.message}`);
        }
    }

    async function exportCsv() {
        const call = $('#recordCallSelect').value, recorded = state.view === 'rec';
        const headers = recorded
            ? ['date', 'time', 'call', 'de', 'band', 'freq', 'mode', 'detail', 'snr', 'signal', 'distance_km', 'comment']
            : ['timestamp', 'monitored_call', 'de', 'freq', 'spot_call', 'mode', 'signal', 'snr', 'distance_km', 'distance_miles', 'comment'];
        try {
            const rows = recorded ? await getJson(recordingSpotUrl(call, 10000)) : await fetchSpots({call, limit: 10000});
            const csv = [headers.join(',')].concat(rows.map(row => headers.map(header => {
                const value = row[header] === null || row[header] === undefined ? '' : String(row[header]);
                return `"${value.replace(/"/g, '""')}"`;
            }).join(','))).join('\n');
            const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
            const link = document.createElement('a');
            link.href = url;
            link.download = `dxcompass-${recorded ? 'recording' : 'spots'}-${call || 'all'}-${Date.now()}.csv`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            showToast(ctx.t('csvOk'));
        } catch {
            showToast(ctx.t('loadFail'));
        }
    }

    async function clearDatabase() {
        const confirmed = await showConfirm(ctx, ctx.t('askClearDb'), {
            title: ctx.t('clearDb'), okText: ctx.t('danger'), danger: true
        });
        if (!confirmed) return;
        try {
            await clearSpots();
            showToast(ctx.t('cleared'));
            await refresh();
        } catch {
            showToast(ctx.t('clearFail'));
        }
    }

    const poller = createPoller(async () => {
        await refreshRecordingStatus();
        if (state.status && state.status.active && state.view === 'rec') await refresh();
    }, {
        intervalMs: () => {
            const value = Number(ctx.settings && ctx.settings.recordsRefreshSec);
            return Math.min(300, Math.max(5, Number.isFinite(value) ? value : 15)) * 1000;
        },
        immediate: false
    });

    function bind() {
        $('#btnRefreshRecords').addEventListener('click', refresh);
        $('#btnExportCsv').addEventListener('click', exportCsv);
        $('#recordCallSelect').addEventListener('change', refresh);
        $('#btnClearDb').addEventListener('click', clearDatabase);
        $('#btnRecToggle').addEventListener('click', toggleRecording);
        $('#btnRecSched').addEventListener('click', () => $('#recSchedForm').classList.toggle('hidden'));
        $('#btnRecSchedSet').addEventListener('click', setSchedule);
        $('#btnRecSchedClear').addEventListener('click', clearSchedule);
        $$('.rec-tab').forEach(tab => tab.addEventListener('click', () => {
            state.view = tab.dataset.view;
            $$('.rec-tab').forEach(item => item.classList.toggle('active', item === tab));
            void refresh();
        }));
    }

    function init() {
        bind();
        void refreshRecordingStatus(true);
        void refresh();
        poller.start();
    }

    function applyLang() {
        populateCallSelect();
        void refreshRecordingStatus();
        void refresh();
    }

    return {state, init, refresh, refreshSoon, populateCallSelect, applyLang, refreshRecordingStatus};
}
