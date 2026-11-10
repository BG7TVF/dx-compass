import {fetchAnalysis, fetchPathAnalysis} from '../../shared/data/analysis.mjs';
import {$} from '../ui.mjs';

/**
 * 天线研判页：输入目标呼号与 UTC 时间窗，展示三分类概率、主朝向与判定依据。
 * 本页不展示任何功率、EIRP 或绝对场强结论——服务端也不计算。
 */

const SECTOR_LABELS = ['0°', '30°', '60°', '90°', '120°', '150°', '180°', '210°', '240°', '270°', '300°', '330°'];

function utcInputValue(offsetMs) {
    return new Date(Date.now() + offsetMs).toISOString().slice(0, 16);
}

function fmtPct(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function fmtWindow(epochSeconds) {
    if (!Number.isFinite(epochSeconds)) return '—';
    return new Date(epochSeconds * 1000).toISOString().slice(11, 16) + 'Z';
}

export function createAnalysisPage(ctx) {
    let built = false;
    let busy = false;
    let pathBusy = false;
    let lastReport = null;
    let lastPathReport = null;
    let lastPathAt = 0;
    let liveText = null;
    const PATH_STALE_MS = 5 * 60 * 1000;

    const t = key => ctx.t(key);

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function row(labelKey, value) {
        const wrap = element('div', 'an-row');
        wrap.appendChild(element('span', 'an-label', t(labelKey)));
        wrap.appendChild(element('span', 'an-value', value));
        return wrap;
    }

    function section(titleKey, children) {
        const wrap = element('section', 'an-section');
        wrap.appendChild(element('h3', 'an-section-title', t(titleKey)));
        children.forEach(child => child && wrap.appendChild(child));
        return wrap;
    }

    function sectionBlock(...nodes) {
        const body = element('div', 'an-list');
        nodes.flat().forEach(node => node && body.appendChild(node));
        return body;
    }

    function build() {
        if (built) return;
        const view = $('#analysisView');
        view.innerHTML = '';

        // 自动研判放在最前：打开页面即按本台设置与实时邻台出结果，不要求任何输入。
        const pathBody = element('div', 'analysis-body');
        pathBody.id = 'pathBody';
        const pathBar = element('div', 'analysis-bar');
        const pathTitle = element('span', 'an-path-title', t('anSecPaths'));
        const pathRefresh = element('button', 'primary-btn an-run', t('anPathRefresh'));
        pathRefresh.id = 'anPathRun';
        pathRefresh.type = 'button';
        const pathStatus = element('span', 'analysis-status');
        pathStatus.id = 'pathStatus';
        pathBar.append(pathTitle, pathRefresh, pathStatus);
        pathBody.appendChild(pathBar);
        const pathInfo = element('div', 'an-path-info');
        pathInfo.id = 'pathInfo';
        pathBody.appendChild(pathInfo);
        const pathResults = element('div', 'an-list');
        pathResults.id = 'pathResults';
        pathBody.appendChild(pathResults);
        view.appendChild(pathBody);

        // 手动研判属于可选功能：按指定目标呼号做天线朝向分析，默认折叠，
        // 避免让用户误以为必须先填呼号才能出结果。
        const manual = element('details', 'an-manual');
        manual.id = 'anManual';
        const manualSummary = element('summary', 'an-manual-summary', t('anManualTitle'));
        manual.appendChild(manualSummary);

        const bar = element('div', 'analysis-bar');
        const callLabel = element('label', 'an-field', t('anCall'));
        callLabel.setAttribute('for', 'anCall');
        const callInput = element('input', 'set-input an-call');
        callInput.id = 'anCall';
        callInput.maxLength = 16;
        callInput.autocomplete = 'off';
        callInput.spellcheck = false;
        callInput.placeholder = 'DL8WR';

        const fromLabel = element('label', 'an-field', `${t('anFrom')} (UTC)`);
        fromLabel.setAttribute('for', 'anFrom');
        const fromInput = element('input', 'set-input an-time');
        fromInput.type = 'datetime-local';
        fromInput.id = 'anFrom';
        fromInput.value = utcInputValue(-86400000);

        const toLabel = element('label', 'an-field', `${t('anTo')} (UTC)`);
        toLabel.setAttribute('for', 'anTo');
        const toInput = element('input', 'set-input an-time');
        toInput.type = 'datetime-local';
        toInput.id = 'anTo';
        toInput.value = utcInputValue(0);

        const run = element('button', 'primary-btn an-run', t('anRun'));
        run.id = 'anRun';
        run.type = 'button';
        const status = element('span', 'analysis-status');
        status.id = 'analysisStatus';

        bar.append(callLabel, callInput, fromLabel, fromInput, toLabel, toInput, run, status);
        manual.appendChild(bar);
        const hint = element('div', 'an-hint', t('anHint'));
        manual.appendChild(hint);
        const body = element('div', 'analysis-body');
        body.id = 'analysisBody';
        manual.appendChild(body);
        view.appendChild(manual);
        liveText = {
            callLabel, fromLabel, toLabel, run, hint, pathRefresh, pathTitle, manualSummary
        };

        run.addEventListener('click', () => runAnalysis());
        callInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') runAnalysis();
        });
        pathRefresh.addEventListener('click', () => runPaths());
        built = true;
        if (lastReport) render(lastReport);
        if (lastPathReport) renderPaths(lastPathReport);
    }

    function setStatus(text, isError) {
        const status = $('#analysisStatus');
        if (!status) return;
        status.textContent = text || '';
        status.classList.toggle('error', Boolean(isError));
    }

    async function runAnalysis() {
        if (busy) return;
        const call = $('#anCall').value.trim().toUpperCase();
        if (!call) {
            setStatus(t('anCallRequired'), true);
            return;
        }
        const from = $('#anFrom').value.replace('T', ' ');
        const to = $('#anTo').value.replace('T', ' ');
        busy = true;
        setStatus(t('anRunning'));
        try {
            const report = await fetchAnalysis({call, from, to});
            lastReport = report;
            render(report);
            setStatus('');
        } catch (error) {
            lastReport = null;
            renderError(error);
            setStatus(t('anRequestFailed'), true);
        } finally {
            busy = false;
        }
    }

    function renderError(error) {
        const body = $('#analysisBody');
        body.replaceChildren(element('div', 'an-empty', t('anRequestFailed')));
        if (error && error.message) body.appendChild(element('div', 'an-hint', error.message));
    }

    function setPathStatus(text, isError) {
        const status = $('#pathStatus');
        if (!status) return;
        status.textContent = text || '';
        status.classList.toggle('error', Boolean(isError));
    }

    async function runPaths() {
        if (pathBusy) return;
        pathBusy = true;
        setPathStatus(t('anRunning'));
        try {
            // 全自动：不传目标呼号，身份与大网格由服务端设置决定，默认回看 6 小时。
            const report = await fetchPathAnalysis({});
            lastPathReport = report;
            lastPathAt = Date.now();
            renderPaths(report);
            setPathStatus('');
        } catch (error) {
            lastPathReport = null;
            lastPathAt = 0;
            // 服务端 400 时 body 里带 error 码，直接给出“去设置里填呼号/网格”的明确提示，
            // 不能只显示笼统的“请求失败”让人以为功能坏了。
            const code = error && error.body && error.body.error;
            const key = code === 'call-required' ? 'anPathErrorCall'
                : code === 'grid-required' ? 'anPathErrorGrid' : 'anRequestFailed';
            const info = $('#pathInfo');
            if (info) info.replaceChildren();
            const results = $('#pathResults');
            results.replaceChildren(element('div', 'an-empty', t(key)));
            if (key === 'anRequestFailed' && error && error.message) {
                results.appendChild(element('div', 'an-hint', error.message));
            }
            setPathStatus(key === 'anRequestFailed' ? t('anRequestFailed') : '', true);
        } finally {
            pathBusy = false;
        }
    }

    const VERDICT_KEYS = ['CW', 'SSB'];

    function marginText(margin) {
        if (!Number.isFinite(margin)) return '—';
        return `${margin > 0 ? '+' : ''}${margin.toFixed(1)} dB`;
    }

    function fmtUtcTime(iso) {
        const ms = Date.parse(iso || '');
        if (!Number.isFinite(ms)) return '—';
        return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
    }

    /** 功率口径两层表述：假设（50 W 标称，10–70 W 不对称）或实测覆盖值。 */
    function powerText(power) {
        if (!power) return '';
        if (power.basis === 'override') {
            return t('anPathPowerKnown').replace('{watts}', String(power.watts));
        }
        return t('anPathPowerUnknown');
    }

    function verdictChip(mode, verdict, margin) {
        return element('span', `an-chip ${verdict}`, [
            mode,
            t(`anPathVerdict.${verdict}`),
            marginText(margin)
        ].join(' · '));
    }

    function directionBlock(labelKey, direction) {
        const block = element('div', 'an-path-dir');
        block.appendChild(element('span', 'an-dir-label', t(labelKey)));
        if (!direction) {
            block.appendChild(element('span', 'an-chip unknown', t('anPathNoData')));
            return block;
        }
        if (!direction.available) {
            const reason = direction.reason
                ? t(`anPathInsufficient.${direction.reason}`) : '';
            const detail = [
                t('anPathInsufficient'),
                reason,
                `${t('anPathSamples')} ${direction.samples}`
            ].filter(Boolean).join(' · ');
            block.appendChild(element('span', 'an-chip unknown', detail));
            return block;
        }
        VERDICT_KEYS.forEach(mode => {
            block.appendChild(verdictChip(mode, direction.verdicts[mode], direction.margins[mode]));
        });
        const meta = [
            `${t('anPathSamples')} ${direction.samples}`,
            `${t('anPathWindows')} ${direction.windows}`,
            `${t('anPathStations')} ${direction.stations}`,
            powerText(direction.power)
        ].filter(Boolean);
        block.appendChild(element('span', 'an-dir-meta', meta.join(' · ')));
        return block;
    }

    function selfLine(self) {
        if (!self) return null;
        const parts = VERDICT_KEYS.map(mode => [
            mode,
            t(`anPathVerdict.${self.verdicts[mode]}`),
            marginText(self.margins[mode])
        ].join(' '));
        return [
            `${t('anPathSelf')}: ${parts.join(' · ')}`,
            `（${t('anPathSamples')} ${self.samples}，${t('anPathSelfExcluded')}；${powerText(self.power)}）`
        ].join(' ');
    }

    /** 下钻：把两个方向的参与邻台合并，按样本量排序。 */
    function contributorTable(row) {
        const merged = new Map();
        ['aToB', 'bToA'].forEach(dirKey => {
            const direction = row.directions[dirKey];
            if (!direction || !Array.isArray(direction.contributors)) return;
            direction.contributors.forEach(item => {
                if (!merged.has(item.call)) {
                    merged.set(item.call, {
                        call: item.call,
                        grid4: item.grid4,
                        isOpponent: item.isOpponent,
                        lastSeen: item.lastSeen,
                        aToB: null,
                        bToA: null,
                        samples: 0
                    });
                }
                const entry = merged.get(item.call);
                entry[dirKey] = item;
                entry.samples += item.samples;
            });
        });
        const list = [...merged.values()].sort((a, b) => b.samples - a.samples);
        if (!list.length) return null;
        const table = element('table', 'an-table an-contrib');
        const head = element('tr');
        [t('anContribCall'), t('anContribSamples'), t('anPathAtoB'), t('anPathBtoA')]
            .forEach(label => head.appendChild(element('th', null, label)));
        table.appendChild(head);
        list.forEach(entry => {
            const tr = element('tr');
            const nameCell = element('td', null,
                entry.call + (entry.grid4 ? ` · ${entry.grid4}` : ''));
            if (entry.isOpponent) {
                nameCell.appendChild(element('span', 'an-badge an-opponent', t('anPathOpponent')));
            }
            tr.appendChild(nameCell);
            tr.appendChild(element('td', null, String(entry.samples)));
            ['aToB', 'bToA'].forEach(dirKey => {
                const item = entry[dirKey];
                tr.appendChild(element('td', null, item
                    ? `CW ${t(`anPathVerdict.${item.verdicts.CW}`)} · SSB ${t(`anPathVerdict.${item.verdicts.SSB}`)} · n=${item.samples}`
                    : '—'));
            });
            table.appendChild(tr);
        });
        return table;
    }

    function pathCard(row) {
        const card = element('div', 'an-path-card');
        const head = element('div', 'an-path-head');
        head.appendChild(element('span', 'an-path-region',
            row.region.label + (row.region.grids && row.region.grids.length
                ? ` · ${row.region.grids.join(' / ')}` : '')));
        head.appendChild(element('span', 'an-path-band', row.band));
        head.appendChild(element('span', `an-badge an-conf-${row.confidence.level}`,
            `${t('anConfidence')} ${t(`anPathConf.${row.confidence.level}`)}`));
        (row.opponents || []).forEach(call => {
            head.appendChild(element('span', 'an-badge an-opponent',
                `${t('anPathOpponent')} ${call}`));
        });
        card.appendChild(head);

        const directions = element('div', 'an-path-dirs');
        directions.appendChild(directionBlock('anPathAtoB', row.directions.aToB));
        directions.appendChild(directionBlock('anPathBtoA', row.directions.bToA));
        card.appendChild(directions);

        const advice = VERDICT_KEYS
            .map(mode => {
                const summary = row.modes[mode];
                return summary && summary.advice
                    ? `${mode} ${t(`anPathVerdict.${summary.advice}`)}` : null;
            })
            .filter(Boolean)
            .join(' · ');
        if (advice) {
            card.appendChild(element('div', 'an-note', `${t('anPathAdvice')}：${advice}`));
        }
        [selfLine(row.self && row.self.aToB), selfLine(row.self && row.self.bToA)]
            .filter(Boolean)
            .forEach(text => card.appendChild(element('div', 'an-note an-path-self', text)));

        const table = contributorTable(row);
        if (table) {
            const details = element('details', 'an-path-detail');
            details.appendChild(element('summary', null,
                `${t('anPathContributors')} (${row.region.label} · ${row.band})`));
            details.appendChild(table);
            card.appendChild(details);
        }
        return card;
    }

    function infoItem(labelKey, value) {
        const item = element('div', 'an-path-info-item');
        item.appendChild(element('span', 'an-label', t(labelKey)));
        item.appendChild(element('span', 'an-value', value));
        return item;
    }

    function renderPaths(report) {
        const info = $('#pathInfo');
        const results = $('#pathResults');
        if (!info || !results) return;
        results.replaceChildren();
        if (!report || report.ok === false) {
            info.replaceChildren();
            const code = report && report.error;
            const key = code === 'call-required' ? 'anPathErrorCall'
                : code === 'grid-required' ? 'anPathErrorGrid' : 'anRequestFailed';
            results.appendChild(element('div', 'an-empty', t(key)));
            return;
        }
        const local = report.local || {};
        const neighborCount = Number.isFinite(local.neighborCount)
            ? local.neighborCount : (local.neighbors || []).length;
        info.replaceChildren(
            infoItem('anPathLocal',
                [local.call, local.grid].filter(Boolean).join(' · ') || '—'),
            infoItem('anPathLargeGrid', local.largeGrid || '—'),
            infoItem('anPathNeighbors', String(neighborCount)),
            infoItem('anPathWindow', `${report.windowMinutes} min`),
            infoItem('anPathUpdated', fmtUtcTime(report.generatedAt))
        );
        results.appendChild(element('div', 'an-hint', t('anPathHint')));

        const rows = report.rows || [];
        if (!rows.length) {
            results.appendChild(element('div', 'an-empty',
                neighborCount ? t('anPathNoRows') : t('anPathNoNeighbors')));
        } else {
            const grid = element('div', 'an-path-grid');
            rows.forEach(item => grid.appendChild(pathCard(item)));
            results.appendChild(grid);
            if (report.observations && report.observations.truncated) {
                results.appendChild(element('div', 'an-note', t('anPathTruncated')));
            }
        }
        ['anPathCaveat1', 'anPathCaveat2', 'anPathCaveat3', 'anPathCaveat4']
            .forEach(key => results.appendChild(element('div', 'an-note', t(key))));
    }

    function render(report) {
        const body = $('#analysisBody');
        if (!body) return;
        body.replaceChildren();
        body.appendChild(renderTarget(report));
        body.appendChild(renderMethod(report));
        body.appendChild(renderAntenna(report));
        body.appendChild(renderObservations(report));
        body.appendChild(renderConfidence(report));
    }

    function renderTarget(report) {
        const values = sectionBlock(
            row('anTarget', report.target),
            row('anFrom', (report.window && report.window.from) || '—'),
            row('anTo', (report.window && report.window.to) || '—')
        );
        return section('anSecTarget', [values]);
    }

    function renderMethod(report) {
        return section('anSecMethod', [sectionBlock(
            row('anMethod', t('anMethodDistribution')),
            element('div', 'an-note', t('anMethodNoPower')),
            element('div', 'an-note', t('anHint'))
        )]);
    }

    function renderAntenna(report) {
        const antenna = report.antenna || {};
        const probs = antenna.probabilities || {};
        const nodes = [];
        if (!antenna.ok || antenna.type === 'unknown') {
            nodes.push(element('div', 'an-empty', t('anInsufficient')));
        }
        nodes.push(row('anType', `${t(`anType.${antenna.type || 'unknown'}`)} (${fmtPct(antenna.confidence)})`));
        if (probs.directional !== undefined) {
            nodes.push(row('anProbability', [
                `${t('anDir')} ${fmtPct(probs.directional)}`,
                `${t('anDipole')} ${fmtPct(probs.dipole)}`,
                `${t('anOmni')} ${fmtPct(probs.omni)}`
            ].join(' · ')));
        }
        nodes.push(row('anAzimuth', Number.isFinite(antenna.azimuthDeg)
            ? `${Math.round(antenna.azimuthDeg)}°`
            : t('anNone')));
        const evidence = antenna.evidence;
        if (evidence) {
            nodes.push(row('anBasis', [
                `${t('anMainShare')} ${fmtPct(evidence.mainShare)}`,
                `${t('anBackShare')} ${fmtPct(evidence.backShare)}`,
                `${t('anSideShare')} ${fmtPct(evidence.sideShare)}`,
                `${t('anMedianDistance')} ${Number.isFinite(evidence.medianDistanceKm) ? Math.round(evidence.medianDistanceKm) + ' km' : '—'}`
            ].join(' · ')));
            nodes.push(sectorChart(evidence.sectors || []));
        }
        const relative = report.relative;
        if (relative) {
            if (relative.available) {
                nodes.push(row('anRelative', [
                    `${Number.isFinite(relative.deltaDb) ? relative.deltaDb.toFixed(1) : '—'} dB`,
                    `${t('anRelativeReceivers')} ${relative.receivers}`,
                    `${t('anRelativePoints')} ${relative.usablePoints}`,
                    t('anRelativeOnly')
                ].join(' · ')));
            } else {
                nodes.push(row('anRelative', `${t('anRelativeUnavailable')} (${relative.reason})`));
            }
        }
        (antenna.notes || []).forEach(code => {
            const key = `anNote.${code}`;
            const text = t(key);
            if (text && text !== key) nodes.push(element('div', 'an-note', text));
        });
        return section('anSecAntenna', [sectionBlock(nodes)]);
    }

    function sectorChart(sectors) {
        const max = sectors.reduce((value, sector) => Math.max(value, sector.count || 0), 0) || 1;
        const chart = element('div', 'an-sectors');
        sectors.forEach(sector => {
            const line = element('div', 'an-sector');
            line.appendChild(element('span', 'an-sector-label',
                SECTOR_LABELS[Math.round(sector.fromDeg / 30)] || `${sector.fromDeg}°`));
            const track = element('div', 'an-sector-track');
            const fill = element('div', 'an-sector-fill');
            fill.style.width = `${Math.round((sector.count / max) * 100)}%`;
            track.appendChild(fill);
            line.appendChild(track);
            line.appendChild(element('span', 'an-sector-count', String(sector.count)));
            chart.appendChild(line);
        });
        return chart;
    }

    function renderObservations(report) {
        const observations = report.observations || {};
        const groups = observations.groups || [];
        const sources = observations.strengthSources || {};
        const excludedText = Object.entries(observations.excluded || {})
            .filter(([, count]) => count)
            .map(([code, count]) => `${t(`anExcl.${code}`)} ${count}`)
            .join(' · ') || t('anNone');
        const nodes = [
            row('anGroups', String(observations.groupCount || 0)),
            row('anPoints', String(observations.positioned || 0)),
            row('anTotalRows', String(observations.totalRows || 0)),
            row('anCoverage', `${observations.sectorCoverage || 0}/12`),
            row('anExcluded', excludedText),
            row('anStrength', [
                `${t('anStrengthRst')} ${sources.rst || 0}`,
                `${t('anStrengthSnr')} ${sources.snrOnly || 0}`,
                `${t('anStrengthNone')} ${sources.none || 0}`
            ].join(' · '))
        ];
        const table = element('table', 'an-table');
        const head = element('tr');
        ['anThBand', 'anThGroup', 'anThN'].forEach(key => {
            head.appendChild(element('th', null, t(key)));
        });
        table.appendChild(head);
        groups.forEach(group => {
            const rowNode = element('tr');
            rowNode.appendChild(element('td', null, group.band || '—'));
            rowNode.appendChild(element('td', null, `${fmtWindow(group.startEpoch)}–${fmtWindow(group.endEpoch)}`));
            rowNode.appendChild(element('td', null, String(group.n)));
            table.appendChild(rowNode);
        });
        if (groups.length) nodes.push(table);
        return section('anSecObs', [sectionBlock(nodes)]);
    }

    function renderConfidence(report) {
        const antenna = report.antenna || {};
        const nodes = [
            row('anConfidence', fmtPct(antenna.confidence)),
            element('div', 'an-note', t('anConfidenceNote')),
            element('div', 'an-note', t('anDisc.noPower'))
        ];
        const relative = report.relative;
        if (relative && relative.usage === 'auxiliary-only') {
            nodes.push(element('div', 'an-note', t('anDisc.strengthUsage')));
        }
        (report.warnings || []).forEach(code => {
            const key = `anWarn.${code}`;
            const label = t(key);
            nodes.push(element('div', 'an-warn', label && label !== key ? label : code));
        });
        return section('anSecConfidence', [sectionBlock(nodes)]);
    }

    /** 页面打开即出结果：有缓存且未过期则复用，否则自动请求。 */
    function maybeAutoRunPaths() {
        if (pathBusy) return;
        if (lastPathReport && Date.now() - lastPathAt < PATH_STALE_MS) return;
        runPaths();
    }

    return {
        init() {
            if (!built) build();
            maybeAutoRunPaths();
        },
        show() {
            if (!built) build();
            maybeAutoRunPaths();
        },
        hide() {},
        resize() {},
        applyLang() {
            if (!built || !liveText) return;
            liveText.callLabel.textContent = t('anCall');
            liveText.fromLabel.textContent = `${t('anFrom')} (UTC)`;
            liveText.toLabel.textContent = `${t('anTo')} (UTC)`;
            liveText.run.textContent = t('anRun');
            liveText.hint.textContent = t('anHint');
            liveText.pathTitle.textContent = t('anSecPaths');
            liveText.pathRefresh.textContent = t('anPathRefresh');
            liveText.manualSummary.textContent = t('anManualTitle');
            if (lastReport) render(lastReport);
            if (lastPathReport) renderPaths(lastPathReport);
        }
    };
}
