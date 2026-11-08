'use strict';

function unesc(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

function modeOf(c0) {
    const c = String(c0).toUpperCase();
    if (/\bCW\b/.test(c)) return 'CW';
    if (/FT8|FT4|RTTY|PSK|JT65|JT9|JS8|MFSK|OLIVIA|CONTESTIA|DOMINO|HELL|THOR|THROB/.test(c)) return 'DIGI';
    if (/\b(SSB|USB|LSB|AM|FM|PHONE)\b/.test(c)) return 'PHONE';
    return null;
}

function pskrModeOf(m) {
    const s = String(m || '').toUpperCase();
    if (s === 'CW') return 'CW';
    if (/^(SSB|USB|LSB|AM|FM|PHONE)/.test(s)) return 'PHONE';
    return 'DIGI';
}

function monitoredCalls(global) {
    const monitored = (global.get('monitoredCalls') || []).map(c => String(c).toUpperCase());
    const my = String((global.get('uiSettings') || {}).myCall || '').trim().toUpperCase();
    if (my && !monitored.includes(my)) monitored.push(my);
    return monitored;
}

function unslash(s) {
    return String(s || '').trim().toUpperCase().replace(/\./g, '/');
}

function infoCoords(info) {
    let lat = parseFloat(info[6]);
    if (isNaN(lat)) lat = null;
    let lon = parseFloat(info[7]);
    if (isNaN(lon)) lon = null;
    return {lat, lon};
}

function dedupKey(target, de, freq, epoch) {
    return target + '|' + de.replace(/-\d+$/, '') + '|' +
        Math.round(isNaN(freq) ? 0 : freq) + '|' + Math.floor(epoch / 180);
}

function pruneDedup(dedup, nowSec) {
    for (const k of Object.keys(dedup)) {
        if (nowSec - dedup[k] > 900) delete dedup[k];
    }
    return dedup;
}

module.exports = {unesc, modeOf, pskrModeOf, monitoredCalls, unslash, infoCoords,
    dedupKey, pruneDedup};
