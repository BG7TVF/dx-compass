'use strict';

/**
 * MASTER.SCP is a plain-text list: `#` comments (with the release date),
 * `!` ordering hints, then one uppercase callsign per line.
 * It is an "active contest callsigns" list, never a validity database.
 */
const CALL_RE = /^[A-Z0-9/]{3,20}$/;
const VERSION_CALL_RE = /^VER\d{8}$/;
const PORTABLE_RE = /^(P|M|MM|AM|QRP|A|\d{1,2})$/;

function parseMaster(text) {
    const calls = new Set();
    let release = '';
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#')) {
            const match = /^#\s*Release\s+(\S+)/i.exec(line);
            if (match) release = match[1];
            continue;
        }
        if (line.startsWith('!')) continue;
        const call = line.toUpperCase();
        if (!CALL_RE.test(call) || VERSION_CALL_RE.test(call)) continue;
        calls.add(call);
    }
    return {release, calls};
}

/**
 * SCP stores some portable calls (GM0FRT/P) but not every spelling, so an
 * exact hit wins and the slash parts are only fallbacks. A miss here is still
 * inconclusive and must not be reported as an invalid callsign.
 */
function candidates(call) {
    const base = String(call || '').trim().toUpperCase();
    if (!base) return [];
    const out = [base];
    if (base.includes('/')) {
        const parts = base.split('/').filter(Boolean);
        for (const part of parts) {
            if (part.length >= 3) out.push(part);
        }
        const bare = parts.filter(part => !PORTABLE_RE.test(part));
        if (bare.length && bare.length !== parts.length) out.push(bare.join('/'));
    }
    return [...new Set(out)];
}

module.exports = {parseMaster, candidates, CALL_RE, VERSION_CALL_RE};
