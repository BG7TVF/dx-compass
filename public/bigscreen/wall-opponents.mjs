/* Opponent aggregation for the wall, grouped by band with recent activity.
 * The shared geo bearing function is injected so this module contains no
 * second geography formula.
 *
 * Data comes straight from /api/spots rows:
 *   monitored_call  rival call (target of the spot)
 *   band / freq     band label ("20m") and kHz
 *   lat / lon       spotter position
 *   dx_lat / dx_lon rival position
 * The per-band "main direction" is the circular mean of the bearings from the
 * rival to its spotters: the heading the rival's signal is reaching, i.e. the
 * direction that band is being worked. Spots older than the activity window
 * are ignored, matching the 30 min cutoff of the wall map markers. */

const $ = selector => document.querySelector(selector);
const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const compassIndex = degrees => Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
const compass = degrees => COMPASS[compassIndex(degrees)];
const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (value, digits) => value === null || value === undefined || !isFinite(value)
    ? '—' : (digits === undefined ? String(value) : Number(value).toFixed(digits));

export const WALL_BAND_COLORS = {
    '160M': '#b565d8', '80M': '#e67e22', '60M': '#fd79a8', '40M': '#f1c40f',
    '30M': '#1abc9c', '20M': '#00e5ff', '17M': '#3498db', '15M': '#9b59b6',
    '12M': '#e84393', '10M': '#e17055', '6M': '#dfe6e9', '2M': '#55efc4'
};
const BAND_RANK = ['160M', '80M', '60M', '40M', '30M', '20M', '17M', '15M',
    '12M', '10M', '6M', '2M'];
const bandRank = band => {
    const index = BAND_RANK.indexOf(band);
    return index < 0 ? BAND_RANK.length : index;
};

/** Spots older than this are not "active" on the wall (same window as the map). */
export const OPPONENT_WINDOW_MIN = 30;
const WINDOW_MS = OPPONENT_WINDOW_MIN * 60 * 1000;
const MAX_CALLS = 4;
/* Below this resultant length the bearings cancel out, so a single "main
 * direction" would be a lie; the tile reports multi-directional instead. */
const CONCENTRATION_MIN = 0.4;

export function buildOpponentBands(rows, myCall, bearing, {now = Date.now(), windowMs = WINDOW_MS} = {}) {
    const my = String(myCall || '').toUpperCase();
    const bands = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
        const call = String(row.monitored_call || row.dx_call || '').toUpperCase();
        if (!call || call === my) return;
        const time = new Date(row.timestamp).getTime();
        if (!isFinite(time) || now - time > windowMs) return;
        const band = String(row.band || '').toUpperCase();
        if (!band) return;

        let entry = bands.get(band);
        if (!entry) {
            entry = {band, n: 0, sin: 0, cos: 0, dirs: 0, calls: new Map()};
            bands.set(band, entry);
        }
        entry.n++;

        let opponent = entry.calls.get(call);
        if (!opponent) {
            opponent = {call, n: 0, ts: 0, freq: null};
            entry.calls.set(call, opponent);
        }
        opponent.n++;
        if (time >= opponent.ts) {
            opponent.ts = time;
            opponent.freq = row.freq === undefined ? null : row.freq;
        }

        if (row.lat !== null && row.lat !== undefined &&
            row.lon !== null && row.lon !== undefined &&
            row.dx_lat !== null && row.dx_lat !== undefined &&
            row.dx_lon !== null && row.dx_lon !== undefined) {
            const direction = bearing(row.dx_lat, row.dx_lon, row.lat, row.lon);
            if (isFinite(direction)) {
                entry.sin += Math.sin(direction * Math.PI / 180);
                entry.cos += Math.cos(direction * Math.PI / 180);
                entry.dirs++;
            }
        }
    });

    return [...bands.values()].map(entry => {
        const calls = [...entry.calls.values()]
            .sort((a, b) => b.n - a.n || a.call.localeCompare(b.call));
        const resultant = entry.dirs ? Math.hypot(entry.sin, entry.cos) / entry.dirs : 0;
        const dir = entry.dirs
            ? (Math.atan2(entry.sin, entry.cos) * 180 / Math.PI + 360) % 360
            : null;
        return {
            band: entry.band,
            color: WALL_BAND_COLORS[entry.band] || '#8aa0bd',
            n: entry.n,
            calls,
            dir,
            spread: dir === null || resultant < CONCENTRATION_MIN
        };
    }).sort((a, b) => b.n - a.n || bandRank(a.band) - bandRank(b.band));
}

export function opponentBandHtml(band, wide, maxCalls = MAX_CALLS) {
    const arrow = band.dir !== null && !band.spread
        ? '<i class="ob-arrow">' + ARROWS[compassIndex(band.dir)] + '</i>'
        : '';
    const direction = band.spread
        ? '多向'
        : compass(band.dir) + ' ' + Math.round(band.dir) + '°';
    const calls = band.calls.slice(0, maxCalls).map(item => {
        const frequency = item.freq ? num(item.freq / 1000, 3) : '—';
        return '<div class="ob-call"><b>' + esc(item.call) + '</b><u>' + frequency +
            '</u><i>' + item.n + '</i></div>';
    }).join('');
    const extra = band.calls.length > maxCalls
        ? '<div class="ob-more">+' + (band.calls.length - maxCalls) + ' more</div>' : '';
    const title = band.calls.length + ' 个对手 · ' + band.n + ' 个 SPOT';
    return '<div class="opp-band' + (wide ? ' wide' : '') +
        '" style="--band-color:' + band.color + '">' +
        '<div class="ob-top"><b>' + esc(band.band) + '</b><span title="' + title + '">' +
        band.n + ' SPOT</span></div>' +
        '<div class="ob-dir" title="主攻方向：对手信号抵达的方向"><label>主攻</label>' +
        arrow + '<em>' + direction + '</em></div>' +
        '<div class="ob-list">' + calls + extra + '</div>' +
        '</div>';
}

export function createOpponentRenderer({bearing}) {
    let bands = [];
    let callCount = 0;

    function paint() {
        const box = $('#oppRows');
        if (!box) return;
        const summary = $('#oppSummary');
        if (!bands.length) {
            box.innerHTML = '<div class="opp-empty">最近 ' + OPPONENT_WINDOW_MIN +
                ' 分钟无对手 SPOT</div>';
            if (summary) summary.textContent = '';
            return;
        }
        const maxCalls = bands.length > 8 ? 2 : bands.length > 6 ? 3 : MAX_CALLS;
        box.innerHTML = bands.map((band, index) => opponentBandHtml(
            band,
            bands.length % 2 === 1 && index === bands.length - 1,
            maxCalls
        )).join('');
        if (summary) summary.textContent = callCount + ' 对手 · ' + bands.length + ' 频段';
    }

    function render(rows, myCall) {
        bands = buildOpponentBands(rows, myCall, bearing);
        const calls = new Set();
        bands.forEach(band => band.calls.forEach(item => calls.add(item.call)));
        callCount = calls.size;
        paint();
    }

    return {render, trim: paint};
}
