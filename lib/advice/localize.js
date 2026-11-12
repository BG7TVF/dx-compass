'use strict';

/**
 * Localize advice titles/details produced by rules.js.
 *
 * rules.js keeps building the authoritative zh/en strings; this module adds the
 * other nine UI languages from messages.json so a German/French/Japanese
 * operator never sees a Chinese card. English remains the fallback.
 */

const fs = require('fs');
const path = require('path');

const MESSAGES = JSON.parse(fs.readFileSync(path.join(__dirname, 'messages.json'), 'utf8'));
const LANGS = ['de', 'fr', 'es', 'pt', 'ru', 'it', 'ar', 'ko', 'ja'];

function render(lang, key, params) {
    const table = MESSAGES[key];
    if (!table) return '';
    const template = table[lang] || table.en || '';
    return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        params && Object.prototype.hasOwnProperty.call(params, name) && params[name] !== null && params[name] !== undefined
            ? String(params[name])
            : match);
}

function renderAll(spec) {
    const out = {};
    for (const lang of LANGS) out[lang] = render(lang, spec.key, spec.params);
    return out;
}

function round(value) {
    return Number.isFinite(value) ? Math.round(value) : '?';
}

function specFor(advice, gates) {
    const ev = advice.evidence || {};
    switch (advice.id) {
        case 'G7':
            return {title: {key: 'G7.title'}, detail: {key: 'G7.detail'}};
        case 'G9':
            return {title: {key: 'G9.title'}, detail: {key: 'G9.detail'}};
        case 'G2':
        case 'G6': {
            let detail;
            if (ev.quota !== null && ev.quota !== undefined) {
                detail = {
                    key: 'G2.detail',
                    params: {
                        changes: ev.changesThisHour,
                        quota: ev.quota,
                        remaining: gates && gates.quotaRemaining !== null && gates.quotaRemaining !== undefined
                            ? gates.quotaRemaining : Math.max(0, ev.quota - (ev.changesThisHour || 0))
                    }
                };
            } else if (gates && gates.lockRemainingMin !== null && gates.lockRemainingMin !== undefined) {
                detail = {key: 'G2.lock', params: {lock: gates.lockRemainingMin}};
            } else {
                detail = {key: 'G2.none'};
            }
            return {title: {key: advice.id === 'G2' ? 'G2.title' : 'G6.title'}, detail};
        }
        case 'G3':
            return {title: {key: 'G3.title'}, detail: {key: 'G3.detail'}};
        case 'G5':
        case 'G4':
            return {title: {key: 'G5.title'}, detail: {key: 'G5.detail'}};
        case 'R1':
            if (advice.action === 'evaluate-band-change') {
                return {
                    title: {key: 'R1.titleBand', params: {rate: round(ev.rate), band: ev.altBand}},
                    detail: {
                        key: 'R1.detailAlt',
                        params: {stay: round(ev.stayRate), band: ev.altBand, alt: ev.altEQso}
                    }
                };
            }
            return {
                title: {key: 'R1.titleSp', params: {rate: round(ev.rate)}},
                detail: {key: 'R1.detail', params: {stay: round(ev.stayRate)}}
            };
        case 'R2':
            return {
                title: {key: 'R2.title'},
                detail: {key: 'R2.detail', params: {eqso: ev.eqso, sp: ev.spBaseline}}
            };
        case 'R8':
            return {
                title: {key: 'R8.title', params: {remaining: ev.remainingMin}},
                detail: {key: 'R8.detail'}
            };
        case 'R9':
            return {title: {key: 'R9.title'}, detail: {key: 'R9.detail'}};
        case 'R10':
            return {
                title: {key: 'R10.title'},
                detail: {key: 'R10.detail', params: {kp: ev.kp, cgm: ev.cgmLat}}
            };
        case 'S1':
            return {
                title: {key: 'S1.title'},
                detail: {key: 'S1.detail', params: {gap: ev.gap, sp: ev.spEst}}
            };
        case 'S2':
            return {
                title: {key: 'S2.title'},
                detail: {key: 'S2.detail', params: {worked: ev.workedThisBand, before: ev.spotsBefore, now: ev.spotsNow}}
            };
        case 'S3':
            return {title: {key: 'S3.title'}, detail: {key: 'S3.detail'}};
        case 'S5':
            return {
                title: {key: 'S5.title'},
                detail: {key: 'S5.detail', params: {rate: round(ev.rate), threshold: ev.threshold}}
            };
        case 'S6':
            return {
                title: {key: 'S6.title'},
                detail: {key: 'S6.detail', params: {gap: ev.gap}}
            };
        case 'B1':
            return {
                title: {key: 'B1.title', params: {band: ev.to}},
                detail: {
                    key: 'B1.detail',
                    params: {fromBpi: ev.fromBpi, toBpi: ev.bpi, delta: ev.deltaIn}
                }
            };
        case 'B3':
            return {
                title: {key: 'B3.title', params: {band: ev.to}},
                detail: {key: 'B3.detail', params: {t: ev.tStar, gap: ev.gap}}
            };
        case 'B4':
            return {title: {key: 'B4.title'}, detail: {key: 'B4.detail'}};
        case 'B6':
            return {
                title: {key: 'B6.title'},
                detail: {key: 'B6.detail', params: {remaining: ev.remaining}}
            };
        case 'B7':
            return {
                title: {key: 'B7.title'},
                detail: {key: 'B7.detail', params: {kp: ev.kp, cgm: ev.cgmLat}}
            };
        case 'B8':
            return {
                title: {key: 'B8.title', params: {s: ev.sLevel}},
                detail: {key: 'B8.detail'}
            };
        case 'B9':
            return {
                title: {key: 'B9.title', params: {r: ev.rLevel}},
                detail: {key: 'B9.detail'}
            };
        case 'B10':
            return {title: {key: 'B10.title'}, detail: {key: 'B10.detail'}};
        case 'B11':
            return {title: {key: 'B11.title'}, detail: {key: 'B11.detail'}};
        case 'B12':
            return {
                title: {key: 'B12.title'},
                detail: {key: 'B12.detail', params: {remaining: ev.remainingMin}}
            };
        case 'B13':
            return {
                title: {key: 'B13.title'},
                detail: {key: 'B13.detail', params: {q: ev.q, gap: ev.gap}}
            };
        case 'ENGINE':
            return {title: {key: 'ENGINE.title'}};
        default:
            return null;
    }
}

function localizeAdvice(advice, gates) {
    if (!advice || typeof advice !== 'object') return advice;
    const spec = specFor(advice, gates);
    if (!spec) return advice;
    if (advice.title && typeof advice.title === 'object') {
        advice.title = Object.assign({}, advice.title, renderAll(spec.title));
    }
    if (advice.detail && typeof advice.detail === 'object' && spec.detail) {
        advice.detail = Object.assign({}, advice.detail, renderAll(spec.detail));
    }
    return advice;
}

function localizeGates(gates) {
    if (!gates || !gates.blockReason) return gates;
    const key = gates.blockBandChange === 'G7' ? 'GATE.G7'
        : gates.blockBandChange === 'G9' ? 'GATE.G9'
            : gates.blockBandChange === 'G1' ? 'GATE.G1' : null;
    if (!key) return gates;
    gates.blockReason = Object.assign({}, gates.blockReason,
        renderAll({key, params: {lock: gates.lockRemainingMin}}));
    return gates;
}

module.exports = {
    LANGS,
    render,
    localizeAdvice,
    localizeGates
};
