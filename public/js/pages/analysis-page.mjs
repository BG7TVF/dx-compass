import {fetchAnalysis} from '../../shared/data/analysis.mjs';
import {$} from '../ui.mjs';

/**
 * 分析研判页：输入目标呼号与 UTC 时间窗，渲染结构化研判报告。
 * 数值全部来自 /api/analysis/estimate，前端不做任何估算，
 * 只负责把可追溯明细（分组、剔除、σ 分项）呈现出来。
 */

const SECTOR_LABELS = ['0°', '30°', '60°', '90°', '120°', '150°', '180°', '210°', '240°', '270°', '300°', '330°'];

function utcInputValue(offsetMs) {
    return new Date(Date.now() + offsetMs).toISOString().slice(0, 16);
}

function fmtDb(value, t) {
    return Number.isFinite(value) ? `${value.toFixed(1)} dB` : t('anNone');
}

function fmtDbm(value, t) {
    return Number.isFinite(value) ? `${value.toFixed(1)} dBm` : t('anNone');
}

function fmtPct(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function fmtWatts(value) {
    if (!Number.isFinite(value) || value <= 0) return '—';
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} kW`;
    if (value >= 10) return `${Math.round(value)} W`;
    return `${value.toFixed(1)} W`;
}

function fmtWindow(epochSeconds) {
    if (!Number.isFinite(epochSeconds)) return '—';
    return new Date(epochSeconds * 1000).toISOString().slice(11, 16) + 'Z';
}

function classText(item) {
    if (!item) return '—';
    return item.id === 'D3-D5' ? item.label : `${item.id} · ${item.label}`;
}

export function createAnalysisPage(ctx) {
    let built = false;
    let busy = false;
    let lastReport = null;
    let liveText = null;

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

        bar.append(callLabel, callInput, fromLabel, fromInput, toLabel, toInput, run);
        view.appendChild(bar);
        const hint = element('div', 'an-hint', t('anHint'));
        view.appendChild(hint);
        const body = element('div', 'analysis-body');
        body.id = 'analysisBody';
        view.appendChild(body);
        liveText = {callLabel, fromLabel, toLabel, run, hint};

        run.addEventListener('click', () => runAnalysis());
        callInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') runAnalysis();
        });
        built = true;
        if (lastReport) render(lastReport);
    }

    function setStatus(text, isError) {
        const status = $('.analysis-status') || (() => {
            const node = element('span', 'analysis-status');
            $('#analysisView').querySelector('.analysis-bar').appendChild(node);
            return node;
        })();
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
        const detail = element('div', 'an-hint', error && error.message ? error.message : '');
        body.appendChild(detail);
    }

    function render(report) {
        const body = $('#analysisBody');
        if (!body) return;
        body.replaceChildren();
        body.appendChild(renderTarget(report));
        body.appendChild(renderMethod(report));
        body.appendChild(renderAntenna(report));
        body.appendChild(renderObservations(report));
        body.appendChild(renderPower(report));
        body.appendChild(renderError(report));
        body.appendChild(renderDisclaimer(report));
    }

    function renderTarget(report) {
        const values = sectionBlock(
            row('anTarget', report.target),
            row('anFrom', report.window && report.window.from ? report.window.from : '—'),
            row('anTo', report.window && report.window.to ? report.window.to : '—')
        );
        return section('anSecTarget', [values]);
    }

    function renderMethod(report) {
        const methodKey = report.method === 'lineA' ? 'anMethodLineA' : 'anMethodAbs';
        const nodes = [row('anMethod', t(methodKey))];
        if (report.method === 'absolute') {
            if (!report.references || !report.references.loaded || report.references.referenceCount === 0) {
                nodes.push(element('div', 'an-note', t('anWarn.refEmpty')));
            } else {
                nodes.push(element('div', 'an-note', t('anWarn.noPairs')));
            }
            nodes.push(element('div', 'an-note', t('anMethodAbsCaveat')));
        } else {
            const pairs = report.power && Array.isArray(report.power.pairs) ? report.power.pairs.length : 0;
            const refs = (report.references && report.references.used) || [];
            nodes.push(row('anReferences', refs.length ? refs.join(', ') : t('anNone')));
            nodes.push(row('anPairs', String(pairs)));
        }
        return section('anSecMethod', [sectionBlock(nodes)]);
    }

    function renderAntenna(report) {
        const antenna = report.antenna || {};
        const probs = antenna.probabilities || {};
        const nodes = [];
        const typeLabel = t(`anType.${antenna.type || 'unknown'}`);
        nodes.push(row('anType', `${typeLabel} (${fmtPct(probs[antenna.type])})`));
        if (probs.directional !== undefined) {
            nodes.push(row('anProbability', [
                `${t('anDir')} ${fmtPct(probs.directional)}`,
                `${t('anDipole')} ${fmtPct(probs.dipole)}`,
                `${t('anOmni')} ${fmtPct(probs.omni)}`
            ].join(' · ')));
        }
        nodes.push(row('anAzimuth', Number.isFinite(antenna.azimuthDeg) ? `${Math.round(antenna.azimuthDeg)}°` : t('anNone')));
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
            line.appendChild(element('span', 'an-sector-label', SECTOR_LABELS[Math.round(sector.fromDeg / 30)] || `${sector.fromDeg}°`));
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
        const isLineA = report.method === 'lineA';
        const nodes = [
            row(isLineA ? 'anPairs' : 'anGroups', String(isLineA ? (observations.pairs || 0) : (observations.groupCount || 0))),
            row('anPoints', String(observations.totalPointsUsed || 0)),
            row('anTotalRows', String(observations.totalRows || 0)),
            row('anMedianLevel', fmtDbm(observations.medianLevelDbm, t))
        ];
        const excluded = observations.excluded || {};
        const excludedText = Object.entries(excluded)
            .filter(([, count]) => count)
            .map(([code, count]) => `${t(`anExcl.${code}`)} ${count}`)
            .join(' · ') || t('anNone');
        nodes.push(row('anExcluded', excludedText));
        if (observations.powerExcluded) {
            const powerExcluded = Object.entries(observations.powerExcluded)
                .filter(([, count]) => count)
                .map(([code, count]) => `${t(`anExcl.${code}`)} ${count}`);
            if (powerExcluded.length) nodes.push(element('div', 'an-note', powerExcluded.join(' · ')));
        }

        const table = element('table', 'an-table');
        const head = element('tr');
        ['anThBand', 'anThGroup', 'anThN', 'anThMedian'].forEach(key => {
            head.appendChild(element('th', null, t(key)));
        });
        table.appendChild(head);
        groups.forEach(group => {
            const rowNode = element('tr');
            rowNode.appendChild(element('td', null, group.band || '—'));
            rowNode.appendChild(element('td', null, `${fmtWindow(group.startEpoch)}–${fmtWindow(group.endEpoch)}`));
            rowNode.appendChild(element('td', null, String(group.n)));
            rowNode.appendChild(element('td', null, fmtDbm(group.medianDbm, t)));
            table.appendChild(rowNode);
        });
        if (groups.length) nodes.push(table);
        return section('anSecObs', [sectionBlock(nodes)]);
    }

    function renderPower(report) {
        const power = report.power || {};
        if (!power.ok) {
            const empty = element('div', 'an-empty', t('anInsufficient'));
            const notes = element('div', 'an-hint', [
                `${t('anPoints')}: ${(report.observations && report.observations.totalPointsUsed) || 0}`,
                `${t('anThN')}: ${(report.observations && report.observations.groupCount) || 0}`
            ].join(' · '));
            return section('anSecPower', [empty, notes]);
        }
        const classes = power.classes || {};
        const nodes = [
            row('anEstimate', `${fmtDbm(power.estimateDbm, t)} / ${fmtWatts(power.watts)}`),
            row('anMainClass', classText(classes.mainClass)),
            row('anPossible', (classes.possibleClasses || []).map(classText).join(' · ') || t('anNone')),
            row('anConfidence', fmtPct(classes.confidence)),
            row('anInterval', Number.isFinite(power.sigma)
                ? `${power.intervalDbm[0].toFixed(1)} … ${power.intervalDbm[1].toFixed(1)} dBm (±${power.sigma.toFixed(1)} dB)`
                : t('anNone'))
        ];
        const sepKey = classes.separability === 'absolute-merged-high' ? 'anSep.absolute' : 'anSep.lineA';
        nodes.push(element('div', 'an-note', t(sepKey)));
        if (power.outliers && power.outliers.length) {
            nodes.push(row('anOutliers', String(power.outliers.length)));
            nodes.push(element('div', 'an-note', power.outliers.slice(0, 8).map(pair =>
                `${pair.receiver}→${pair.reference}: ${pair.ptDbm.toFixed(1)} dBm`).join(' · ')));
        }
        if (power.rejectedPairs && power.rejectedPairs.length) {
            nodes.push(row('anRejected', String(power.rejectedPairs.length)));
        }
        return section('anSecPower', [sectionBlock(nodes)]);
    }

    function renderError(report) {
        const power = report.power || {};
        const breakdown = power.breakdown;
        if (!breakdown) {
            return section('anSecError', [element('div', 'an-hint', t('anInsufficient'))]);
        }
        const nodes = [];
        Object.entries(breakdown).forEach(([key, item]) => {
            const labelKey = `anSig.${key}`;
            const label = t(labelKey);
            nodes.push(row(labelKey, `${fmtDb(item.value, t)}${label && label !== labelKey ? ` · ${label}` : ''}`));
        });
        nodes.push(row('anSigma', fmtDb(power.sigma, t)));
        if (power.paramDetail) {
            const params = power.paramDetail;
            nodes.push(element('div', 'an-note', [
                `${t('anParam.gain')} ${params.gainT} dBi`,
                `${t('anParam.group')} ${params.groupSeconds / 3600} h`,
                `${t('anParam.crossPol')} ${params.crossPolDb} dB`,
                `${t('anParam.pathLoss')} ${params.pathLoss}`
            ].join(' · ')));
        }
        nodes.push(element('div', 'an-note', t('anDisc.errorFloor')));
        return section('anSecError', [sectionBlock(nodes)]);
    }

    function renderDisclaimer(report) {
        const nodes = [
            element('div', 'an-note', t('anDisc.errorFloor')),
            element('div', 'an-note', t('anDisc.threeDb'))
        ];
        (report.warnings || []).forEach(code => {
            const node = element('div', 'an-warn');
            const key = `anWarn.${code}`;
            const label = t(key);
            node.textContent = label && label !== key ? label : code;
            nodes.push(node);
        });
        if (report.method === 'absolute') {
            nodes.push(element('div', 'an-note', t('anMethodAbsCaveat')));
        }
        return section('anSecDisclaimer', [sectionBlock(nodes)]);
    }

    return {
        init() {
            if (!built) build();
        },
        show() {
            if (!built) build();
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
            if (lastReport) render(lastReport);
        }
    };
}
