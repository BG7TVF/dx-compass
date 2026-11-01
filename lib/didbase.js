/* ============================================================
 * DIDBase (GIRO / LGDC) scaled-characteristics probe
 *
 * giro.uml.edu/didbase/scaled.php is the GIRO Digital Ionogram
 * Database front end run by the Lowell GIRO Data Center. It answers
 * a POST form with a plain-text table: a '#' header block naming the
 * station geometry, then one row per sounding:
 *
 *   2024-01-15T00:00:05.000Z 100  9.500 // 29.873 //
 *   Time                    CS   foF2 QD MUF(D) QD
 *
 * The POST answers with a 302 to a per-session results URL, so the
 * request must keep its Set-Cookie and follow the redirect with GET.
 *
 * Coverage is archival and patchy: a station can answer "STATUS:
 * ERROR (No measurement data could be found for requested time)"
 * for a whole day, and several East Asian stations have been silent
 * for years. That is exactly what this probe is for: to tell a real
 * measured value from a gap.
 *
 * Data use: GIRO data is CC-BY-NC-SA 4.0 under the Lowell GIRO Data
 * Center Rules of the Road; the station's provider must be credited.
 *
 *   node lib/didbase.js                          # East Asia, last 3 days
 *   node lib/didbase.js --station BP440 --days 2
 *   node lib/didbase.js --start 2024-01-15 --end 2024-01-15 --chars foF2,MUF
 *   node lib/didbase.js --out didbase.json
 * ============================================================ */
const https = require('https');

const DIDBASE_URL = 'https://giro.uml.edu/didbase/scaled.php';

/* The form posts characteristic names as the index of this list. */
const CHARS = {
    foF2: 0, foF1: 1, foE: 2, foEs: 3, fbEs: 4, foEa: 5, foP: 6, fxI: 7,
    MUF: 8, M: 9, hF2: 10, hF: 11, hE: 12, hEs: 13, hEa: 14, hP: 15,
    typeEs: 16, hmF2: 17, hmF1: 18, hmE: 19, zhalfNm: 20, yF2: 21,
    yF1: 22, yE: 23, scaleF2: 24, B0: 25, B1: 26, D1: 27, TEC: 28,
    FF: 29, FE: 30, QF: 31, QE: 32, fmin: 33, fminF: 34, fminE: 35,
    fminEs: 36, foF2p: 37
};
const DEFAULT_CHARS = ['foF2', 'MUF', 'hmF2'];

/* Stations of interest around the dashboard's region. Several of them
 * stopped reporting years ago, so the probe reports the gap instead of
 * pretending the value is current. */
const EAST_ASIA = [
    ['AN438', 'ANYANG'],
    ['BP440', 'BEIJING'],
    ['HA419', 'HAINAN'],
    ['WU430', 'WUHAN'],
    ['JJ433', 'JEJU IS'],
    ['TO535', 'KOKUBUNJI'],
    ['OK426', 'OKINAWA']
];

const PACE_MS = 2000;

/* "yyyy-mm-dd hh:mm" in UTC, the format the servlet parses. */
function didbStamp(d) {
    const p = (n, len) => String(n).padStart(len || 2, '0');
    return p(d.getUTCFullYear(), 4) + '-' + p(d.getUTCMonth() + 1) + '-' +
        p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

/* A bare yyyy-mm-dd would parse as 00:00 on both ends and yield an
 * empty window, so widen it to the full day. */
function normDate(v, isEnd) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s + (isEnd ? ' 23:59' : ' 00:00');
    return s;
}

function defaultWindow(days) {
    const end = new Date();
    const start = new Date(end.getTime() - (days || 3) * 86400e3);
    return {start: didbStamp(start).slice(0, 11) + '00:00',
        end: didbStamp(end).slice(0, 11) + '23:59'};
}

function queryBody(o) {
    const parts = [];
    const add = (k, v) => parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    const chars = o.chars || DEFAULT_CHARS;
    chars.forEach(c => add('chosenchars[]', CHARS[c]));
    add('location', o.station);
    add('date_start', o.start);
    add('date_end', o.end);
    add('DMUF', o.dmuf || 3000);
    add('equal', '=');
    add('plusDay', '0');
    add('plusHour', '0');
    add('query_submit', 'Submit Query');
    return parts.join('&');
}

/* giro.uml.edu serves an incomplete certificate chain: Windows/system
 * stores accept it but Node's bundled CA list does not. Retry once
 * without verification and say so, rather than failing every query.
 * --strict turns that fallback off. */
let tlsUnverified = false;
let tlsStrict = false;

function send(method, url, body, cookie, insecure) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const headers = {
            'User-Agent': 'dx-compass-didbase-probe',
            'Accept': 'text/plain',
            'Referer': DIDBASE_URL
        };
        if (body) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            headers['Content-Length'] = Buffer.byteLength(body);
        }
        if (cookie) headers['Cookie'] = cookie;
        const req = https.request({method, hostname: u.hostname,
            port: u.port || 443, path: u.pathname + u.search, headers,
            rejectUnauthorized: !insecure}, res => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', c => buf += c);
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: buf}));
        });
        req.on('error', reject);
        req.setTimeout(45000, () => {
            req.destroy();
            reject(new Error('timeout after 45s'));
        });
        if (body) req.write(body);
        req.end();
    });
}

function request(method, url, body, cookie) {
    return send(method, url, body, cookie, tlsUnverified).catch(e => {
        const certError = /CERT|ISSUER|SELF_SIGNED/i.test(e.code || '') ||
            /certificate/i.test(e.message || '');
        if (tlsUnverified || tlsStrict || !certError) throw e;
        tlsUnverified = true;
        return send(method, url, body, cookie, true);
    });
}

/* One probe: POST the form, keep the session cookie, GET the result. */
async function fetchScaled(o) {
    const post = await request('POST', DIDBASE_URL, queryBody(o), null);
    const raw = post.headers['set-cookie'];
    const cookie = raw ? raw.map(c => c.split(';')[0]).join('; ') : null;
    if (post.status >= 300 && post.status < 400 && post.headers.location) {
        const target = new URL(post.headers.location, DIDBASE_URL).href;
        const got = await request('GET', target, null, cookie);
        return {status: got.status, url: target, body: got.body};
    }
    return {status: post.status, url: DIDBASE_URL, body: post.body};
}

/* Header block -> metadata, then the fixed-column rows. */
function parseDidbase(text) {
    const out = {
        station: null, ursi: null, lat: null, lon: null,
        start: null, end: null, instrument: null,
        status: null, error: null,
        columns: [], rows: [], first: null, last: null
    };
    const src = String(text || '');
    const lines = src.split(/\r?\n/);
    let m;
    if ((m = /URSI-Code\s+([A-Z0-9_]+)\s*,\s*([^\r\n]+)/.exec(src))) {
        out.ursi = m[1].trim();
        out.station = m[2].trim();
    }
    if ((m = /Location:\s*GEO\s*\(\s*([0-9.]+)\s*([NS])\s+([0-9.]+)\s*([EW])\s*\)/i.exec(src))) {
        const lat = parseFloat(m[1]), lon = parseFloat(m[3]);
        out.lat = (/N/i.test(m[2]) ? lat : -lat);
        out.lon = (/E/i.test(m[4]) ? lon : -lon);
    }
    if ((m = /measurement interval of time:\s*([0-9T:.\-Z]+)\s*-\s*([0-9T:.\-Z]+)/.exec(src))) {
        out.start = m[1];
        out.end = m[2];
    }
    if ((m = /Instrument:.*Model:\s*\[(.*?)\]/i.exec(src))) out.instrument = m[1] || '';
    if ((m = /STATUS:\s*([^\r\n]*)/.exec(src))) {
        out.status = m[1].trim();
        if (/ERROR/i.test(out.status)) out.error = out.status;
    }
    let inData = false;
    for (const raw of lines) {
        const l = raw.trim();
        if (!l) continue;
        if (l.startsWith('#')) {
            const cols = /^#\s*Time\s+(.+)$/.exec(l);
            if (cols) {
                out.columns = ['Time'].concat(cols[1].trim().split(/\s+/));
                inData = true;
            }
            continue;
        }
        if (!inData) continue;
        const toks = l.split(/\s+/);
        if (!toks.length) continue;
        const row = {time: toks[0], values: {}};
        /* Columns after Time are name/QD pairs for each characteristic. */
        let k = 1;
        for (let i = 1; i < out.columns.length; i++) {
            const name = out.columns[i];
            if (toks[k] === undefined) break;
            if (name === 'CS') {
                row.cs = toks[k];
                k++;
            } else if (name === 'QD') {
                k++;  // qualifying descriptor of the preceding value
            } else {
                row.values[name] = toks[k] === '//' ? null : toks[k];
                k++;
            }
        }
        out.rows.push(row);
        if (!out.first) out.first = row.time;
        out.last = row.time;
    }
    return out;
}

async function probe(opts) {
    const o = opts || {};
    const stations = o.stations || EAST_ASIA.map(s => ({ursi: s[0], name: s[1]}));
    const win = o.start && o.end ? {start: o.start, end: o.end} : defaultWindow(o.days);
    const pace = o.pace === undefined ? PACE_MS : o.pace;
    const report = {start: win.start, end: win.end, chars: o.chars || DEFAULT_CHARS, items: []};
    for (let i = 0; i < stations.length; i++) {
        if (i && pace > 0) await new Promise(r => setTimeout(r, pace));
        const st = stations[i];
        let res;
        try {
            res = await fetchScaled({station: st.ursi, start: win.start, end: win.end, chars: o.chars});
        } catch (e) {
            report.items.push({ursi: st.ursi, name: st.name, status: null, ok: false,
                rows: 0, reason: e.message});
            continue;
        }
        const p = parseDidbase(res.body);
        report.items.push({
            ursi: st.ursi,
            name: st.name,
            status: res.status,
            ok: p.rows.length > 0,
            geo: p.lat === null ? null : {lat: p.lat, lon: p.lon},
            instrument: p.instrument,
            columns: p.columns,
            rows: p.rows.length,
            first: p.first,
            last: p.last,
            error: p.error,
            samples: p.rows.slice(0, 3)
        });
    }
    report.okStations = report.items.filter(i => i.ok).length;
    report.tls = tlsUnverified ? 'unverified' : 'verified';
    return report;
}

/* ---------------------------------------------------------------
 * CLI
 * ------------------------------------------------------------- */
function argOf(argv, name) {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : null;
}

function fmtRows(it) {
    if (!it.rows) return 'no data';
    const a = it.samples[0], b = it.samples[it.samples.length - 1];
    const pick = (s) => s ? Object.keys(s.values).map(k => k + '=' + (s.values[k] === null ? '-' : s.values[k])).join(' ') : '';
    return it.rows + ' rows  ' + it.first + ' .. ' + it.last + '  | ' + pick(a) +
        (it.rows > 1 ? '  ... ' + pick(b) : '');
}

async function main() {
    const argv = process.argv.slice(2);
    const one = argOf(argv, 'station');
    const days = argOf(argv, 'days') !== null ? +argOf(argv, 'days') : 3;
    const charsArg = argOf(argv, 'chars');
    const start = argOf(argv, 'start');
    const end = argOf(argv, 'end');
    const pace = argOf(argv, 'pace') !== null ? +argOf(argv, 'pace') : PACE_MS;
    const outFile = argOf(argv, 'out');
    if (argv.includes('--strict')) tlsStrict = true;

    const opts = {
        days,
        pace,
        start: normDate(start, false),
        end: normDate(end, true),
        chars: charsArg ? charsArg.split(',').map(s => s.trim()).filter(Boolean) : null,
        stations: one
            ? [{ursi: one.toUpperCase(), name: ''}]
            : EAST_ASIA.map(s => ({ursi: s[0], name: s[1]}))
    };
    for (const c of (opts.chars || DEFAULT_CHARS)) {
        if (CHARS[c] === undefined) {
            console.error('unknown characteristic: ' + c +
                '\nvalid: ' + Object.keys(CHARS).join(' '));
            process.exitCode = 2;
            return;
        }
    }

    const report = await probe(opts);
    console.log('DIDBase probe  ' + report.start + ' .. ' + report.end +
        '  chars=' + report.chars.join(','));
    if (report.tls === 'unverified') {
        console.log('note: TLS certificate could not be verified (incomplete chain);' +
            ' pass --strict to abort instead');
    }
    for (const it of report.items) {
        const head = (it.ursi + (it.name ? ' ' + it.name : '')).padEnd(18) +
            (it.status ? 'HTTP ' + it.status : 'net-error');
        if (it.ok) {
            console.log(head + '  DATA: ' + fmtRows(it));
        } else {
            console.log(head + '  NO DATA: ' + (it.error || it.reason || 'no rows'));
        }
    }
    console.log('\nstations with data: ' + report.okStations + '/' + report.items.length);
    if (outFile) {
        require('fs').writeFileSync(outFile, JSON.stringify(report, null, 2));
        console.log('written: ' + outFile);
    }
    process.exitCode = report.okStations > 0 ? 0 : 1;
}

module.exports = {DIDBASE_URL, CHARS, DEFAULT_CHARS, EAST_ASIA, PACE_MS, didbStamp,
    defaultWindow, queryBody, fetchScaled, parseDidbase, probe};

if (require.main === module) {
    main().catch(e => {
        console.error('didbase probe failed:', e && e.message ? e.message : e);
        process.exitCode = 1;
    });
}
