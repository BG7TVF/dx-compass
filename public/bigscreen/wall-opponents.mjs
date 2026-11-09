/* Opponent aggregation for the wall: one big card per rival, and inside it one
 * small cell per band that rival is active on. The shared geo bearing function
 * is injected so this module contains no second geography formula.
 *
 * Data comes straight from /api/spots rows:
 *   monitored_call  rival call (target of the spot)
 *   band / freq     band label ("20m") and kHz
 *   lat / lon       spotter position
 *   dx_lat / dx_lon rival position
 * For each rival+band pair the "main direction" is the circular mean of the
 * bearings from that rival to its spotters on that band: the heading its signal
 * is reaching, i.e. the direction that band is being worked. Spots older than
 * the activity window are ignored, matching the 30 min map marker cutoff. */

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
/* Below this resultant length the bearings cancel out, so a single "main
 * direction" would be a lie; the cell reports multi-directional instead. */
const CONCENTRATION_MIN = 0.4;

function finishBand(entry) {
    const resultant = entry.dirs ? Math.hypot(entry.sin, entry.cos) / entry.dirs : 0;
    const dir = entry.dirs
        ? (Math.atan2(entry.sin, entry.cos) * 180 / Math.PI + 360) % 360
        : null;
    return {
        band: entry.band,
        color: WALL_BAND_COLORS[entry.band] || '#8aa0bd',
        n: entry.n,
        ts: entry.ts,
        freq: entry.freq,
        dir,
        dirSamples: entry.dirs,
        /* One bearing is not a "main" direction; the cell shows it dimmed.
         * Two or more spread over the compass mean the band is multi-directional. */
        spread: entry.dirs >= 2 && resultant < CONCENTRATION_MIN
    };
}

export function buildOpponents(rows, myCall, bearing, {now = Date.now(), windowMs = WINDOW_MS} = {}) {
    const my = String(myCall || '').toUpperCase();
    const opponents = new Map();
    (Array.isArray(rows) ? rows : []).forEach(row => {
        const call = String(row.monitored_call || row.dx_call || '').toUpperCase();
        if (!call || call === my) return;
        const time = new Date(row.timestamp).getTime();
        if (!isFinite(time) || now - time > windowMs) return;
        const band = String(row.band || '').toUpperCase();
        if (!band) return;

        let opponent = opponents.get(call);
        if (!opponent) {
            opponent = {call, n: 0, ts: 0, bands: new Map()};
            opponents.set(call, opponent);
        }
        opponent.n++;
        opponent.ts = Math.max(opponent.ts, time);

        let entry = opponent.bands.get(band);
        if (!entry) {
            entry = {band, n: 0, ts: 0, freq: null, sin: 0, cos: 0, dirs: 0};
            opponent.bands.set(band, entry);
        }
        entry.n++;
        if (time >= entry.ts) {
            entry.ts = time;
            entry.freq = row.freq === undefined ? null : row.freq;
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

    return [...opponents.values()].map(opponent => ({
        call: opponent.call,
        n: opponent.n,
        ts: opponent.ts,
        bands: [...opponent.bands.values()]
            .sort((a, b) => b.n - a.n || bandRank(a.band) - bandRank(b.band))
            .map(finishBand)
    })).sort((a, b) => b.n - a.n || b.ts - a.ts || a.call.localeCompare(b.call));
}

export function bandCellHtml(band) {
    let direction = '—';
    let arrow = '';
    if (band.dirSamples >= 2 && band.spread) {
        direction = '多向';
    } else if (band.dir !== null) {
        direction = compass(band.dir) + ' ' + Math.round(band.dir) + '°';
        arrow = '<i class="ob-arrow">' + ARROWS[compassIndex(band.dir)] + '</i>';
    }
    const thin = band.dirSamples === 1;
    const frequency = band.freq ? num(band.freq / 1000, 3) : '—';
    const title = band.band + ' · ' + band.n + ' SPOT · ' +
        (band.dirSamples ? band.dirSamples + ' 个方向样本' : '无坐标样本') +
        (thin ? '（仅 1 个，方向仅供参考）' : '');
    return '<div class="opp-band' + (thin ? ' thin' : '') + '" style="--band-color:' +
        band.color + '" title="' + esc(title) + '">' +
        '<div class="ob-line"><b>' + esc(band.band) + '</b><u>' + frequency +
        '<small>MHz</small></u></div>' +
        '<div class="ob-dir">' + arrow + '<em>' + direction + '</em></div>' +
        '</div>';
}

export function opponentCardHtml(opponent) {
    return '<section class="opp-call-card">' +
        '<div class="oc-head"><b>' + esc(opponent.call) + '</b><span>' +
        opponent.bands.length + ' 频段 · ' + opponent.n + ' SPOT</span></div>' +
        '<div class="ob-bands">' + opponent.bands.map(bandCellHtml).join('') + '</div>' +
        '</section>';
}

export function createOpponentRenderer({bearing}) {
    let opponents = [];

    function paint() {
        const box = $('#oppRows');
        if (!box) return;
        const summary = $('#oppSummary');
        if (!opponents.length) {
            box.innerHTML = '<div class="opp-empty">最近 ' + OPPONENT_WINDOW_MIN +
                ' 分钟无对手 SPOT</div>';
            box.classList.remove('dense');
            if (summary) summary.textContent = '';
            return;
        }
        box.innerHTML = opponents.map(opponentCardHtml).join('');
        const bands = new Set();
        opponents.forEach(opponent => opponent.bands.forEach(band => bands.add(band.band)));
        if (summary) summary.textContent = opponents.length + ' 对手 · ' + bands.size + ' 频段';
        /* If the cards are taller than the panel, tighten type/padding first and
         * then, on short screens, squeeze the spacing only (same font sizes) so
         * every rival stays fully visible before the list falls back to scroll. */
        box.classList.remove('dense');
        box.classList.remove('dense-2');
        if (box.scrollHeight > box.clientHeight + 1) {
            box.classList.add('dense');
            if (box.scrollHeight > box.clientHeight + 1) box.classList.add('dense-2');
        }
    }

    function render(rows, myCall) {
        opponents = buildOpponents(rows, myCall, bearing);
        paint();
    }

    return {render, trim: paint};
}
