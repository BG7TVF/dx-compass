/* ============================================================
 * GAMBIT / IRTAM coefficient probe
 *
 * LGDC publishes the coefficients of the IRI-based Real-Time
 * Assimilative Model (IRTAM) as a Jones-Gallet temporal-spatial
 * expansion over a 46x45 global grid:
 *
 *   https://lgdc.uml.edu/rix/gambit-coeffs?time=yyyy.mm.ddThh:mm&charName=nnnn
 *
 * charName is one of foF2 / hmF2 / B0 / B1. LGDC asks for one
 * request every 15 seconds, and the newest ~3 days need elevated
 * access ("Data access level exceeds user permissions"), so the
 * default sample time is four days back.
 *
 * This module only downloads and validates the payload; the expansion is
 * evaluated in irtam.js and served by lib/prop.js as the `gambit` field.
 * Run it by hand to check the link and the coefficient layout.
 *
 *   node lib/gambit.js
 *   node lib/gambit.js --time 2026.10.25T12:00 --out gambit.json
 *   node lib/gambit.js --chars foF2,B0 --pace 0
 * ============================================================ */
const https = require('https');

const GAMBIT_URL = 'https://lgdc.uml.edu/rix/gambit-coeffs';
const CHARS = ['foF2', 'hmF2', 'B0', 'B1'];
const PACE_MS = 15000;      // LGDC's requested request rate
const LOCKED_DAYS = 4;      // newest days are not readable anonymously

/* "yyyy.mm.ddThh:mm" in UTC, the format the servlet expects. */
function gambitTime(d) {
    const p = (n, len) => String(n).padStart(len || 2, '0');
    return p(d.getUTCFullYear(), 4) + '.' + p(d.getUTCMonth() + 1) + '.' +
        p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

function defaultTime() {
    const d = new Date(Date.now() - LOCKED_DAYS * 86400e3);
    d.setUTCMinutes(0, 0, 0);
    return gambitTime(d);
}

function gambitUrl(time, charName) {
    return GAMBIT_URL + '?time=' + encodeURIComponent(time) +
        '&charName=' + encodeURIComponent(charName);
}

/* One GET. The servlet answers a locked request with an HTTP 500 and
 * a Tomcat exception page, so the status must survive into the report
 * instead of being thrown away. */
function fetchGambit(time, charName) {
    const url = gambitUrl(time, charName);
    return new Promise((resolve, reject) => {
        const req = https.get(url, {headers: {
            'User-Agent': 'dx-compass-gambit-probe',
            'Accept': 'text/plain'
        }}, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', c => body += c);
            res.on('end', () => resolve({status: res.statusCode, url, body}));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('timeout after 30s'));
        });
    });
}

/* Header block (# lines) + whitespace-separated coefficients after
 * "# END_HEADER". The station list is the honest proxy for "which
 * soundings actually fed this run" -- worth knowing for a region that
 * lost all of its real-time ionosondes. */
function parseGambit(text) {
    const out = {
        char: null,
        unit: null,
        valid: null,
        grid: {lats: 0, lons: 0},
        basis: {temporal: 0, spatial: 0},
        stations: [],
        coeffs: [],
        expected: 0,
        malformed: 0,
        locked: false,
        error: null
    };
    const src = String(text || '');
    if (/Data access level exceeds user permissions/i.test(src)) {
        out.locked = true;
        out.error = 'locked';
        return out;
    }
    const lines = src.split(/\r?\n/);
    let dataFrom = lines.length;
    let inStations = false;
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l) continue;
        if (!l.startsWith('#')) {
            if (dataFrom === lines.length) dataFrom = i;
            break;
        }
        const body = l.replace(/#+\s*/, '').trim();
        if (/^END_HEADER$/i.test(body)) {
            dataFrom = i + 1;
            inStations = false;
            break;
        }
        let m;
        m = /Ionospheric Characteristic:\s*([A-Za-z0-9_-]+)/.exec(body);
        if (m) out.char = m[1];
        m = /Characteristic:[^\[]*\[([^\]]*)\]/.exec(body);
        if (m) out.unit = m[1].trim();
        m = /Time of Validity\s+([0-9T:\-.Zz]+)/.exec(body);
        if (m) out.valid = m[1];
        m = /Earth Grid:\s*(\d+)\s*lats\s*x\s*(\d+)\s*lons/i.exec(body);
        if (m) {
            out.grid.lats = +m[1];
            out.grid.lons = +m[2];
        }
        m = /Basis Lengths:\s*(\d+)\(temporal\)\s*x\s*(\d+)\(spatial\)/i.exec(body);
        if (m) {
            out.basis.temporal = +m[1];
            out.basis.spatial = +m[2];
        }
        if (/Assimilated stations:/i.test(body)) {
            inStations = true;
        } else if (inStations) {
            /* the list may wrap over several # lines; any other header
             * keyword line carries a colon and ends the run */
            if (body.includes(':')) inStations = false;
            else body.split(/\s+/).forEach(t => {
                if (/^[A-Z0-9_]{3,}$/i.test(t)) out.stations.push(t);
            });
        }
    }
    const toks = lines.slice(dataFrom).join(' ').trim().split(/\s+/).filter(Boolean);
    toks.forEach(t => {
        const v = Number(t);
        if (isFinite(v)) out.coeffs.push(v);
        else out.malformed++;
    });
    out.expected = out.basis.temporal * out.basis.spatial;
    out.complete = out.expected > 0 && out.coeffs.length === out.expected &&
        out.malformed === 0;
    return out;
}

function summarise(p) {
    if (!p.coeffs.length) return {min: null, max: null, mean: null};
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of p.coeffs) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
    }
    return {min, max, mean: sum / p.coeffs.length};
}

/* Sequentially fetch the requested characteristics at LGDC's pace. */
async function probe(opts) {
    const o = opts || {};
    const time = o.time || defaultTime();
    const chars = o.chars || CHARS.slice();
    const pace = o.pace === undefined ? PACE_MS : o.pace;
    const report = {time, pace, items: []};
    for (let i = 0; i < chars.length; i++) {
        if (i && pace > 0) await new Promise(r => setTimeout(r, pace));
        const charName = chars[i];
        let res;
        try {
            res = await fetchGambit(time, charName);
        } catch (e) {
            report.items.push({charName, at: stamp(new Date()), status: null, bytes: 0,
                ok: false, reason: e.message});
            continue;
        }
        const p = parseGambit(res.body);
        const item = {
            charName,
            at: stamp(new Date()),
            status: res.status,
            bytes: res.body.length,
            ok: res.status === 200 && p.complete,
            characteristic: p.char,
            unit: p.unit,
            valid: p.valid,
            grid: p.grid,
            basis: p.basis,
            stations: p.stations,
            coeffs: p.coeffs.length,
            expected: p.expected,
            malformed: p.malformed,
            locked: p.locked,
            range: summarise(p)
        };
        if (!item.ok) {
            item.reason = p.locked ? 'locked (newest days need elevated access)'
                : res.status === 200
                    ? 'incomplete payload: ' + p.coeffs.length + '/' + p.expected +
                        ' coefficients, ' + p.malformed + ' malformed'
                    : 'HTTP ' + res.status;
        }
        report.items.push(item);
    }
    report.ok = report.items.every(i => i.ok);
    return report;
}

/* ---------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------- */
function argOf(argv, name) {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : null;
}

function p2(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
    return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
}

async function main() {
    const argv = process.argv.slice(2);
    const time = argOf(argv, 'time') || defaultTime();
    const charsArg = argOf(argv, 'chars');
    const chars = charsArg ? charsArg.split(',').map(s => s.trim()).filter(Boolean) : null;
    const pace = argOf(argv, 'pace') !== null ? +argOf(argv, 'pace') : PACE_MS;
    const outFile = argOf(argv, 'out');

    console.log('GAMBIT probe  time=' + time + '  chars=' + (chars || CHARS).join(',') +
        '  pace=' + pace + 'ms');
    const report = await probe({time, chars, pace});

    for (const it of report.items) {
        const head = '[' + (it.at || stamp(new Date())) + '] ' + it.charName.padEnd(5) +
            (it.status === null ? ' net-error' : ' HTTP ' + it.status);
        if (it.ok) {
            const r = it.range;
            console.log(head + '  ' + it.coeffs + '/' + it.expected + ' coeffs' +
                '  grid ' + it.grid.lats + 'x' + it.grid.lons +
                '  basis ' + it.basis.temporal + 'x' + it.basis.spatial +
                '  valid ' + it.valid +
                '  min ' + r.min.toExponential(3) + ' max ' + r.max.toExponential(3));
            console.log('        stations(' + it.stations.length + '): ' +
                it.stations.join(' '));
        } else {
            console.log(head + '  FAILED: ' + it.reason);
        }
    }

    console.log('\nresult: ' + (report.ok ? 'ALL OK' : 'NOT OK'));
    if (outFile) {
        require('fs').writeFileSync(outFile, JSON.stringify(report, null, 2));
        console.log('written: ' + outFile);
    }
    process.exitCode = report.ok ? 0 : 1;
}

module.exports = {GAMBIT_URL, CHARS, PACE_MS, gambitTime, gambitUrl, fetchGambit,
    parseGambit, summarise, probe, defaultTime};

if (require.main === module) {
    main().catch(e => {
        console.error('gambit probe failed:', e && e.message ? e.message : e);
        process.exitCode = 1;
    });
}
