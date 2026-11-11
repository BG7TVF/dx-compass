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

import {t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const compassIndex = degrees => Math.round(((degrees % 360) + 360) % 360 / 45) % 8;
const compass = degrees => t('wall.dir.' + COMPASS[compassIndex(degrees)]);
const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (value, digits) => value === null || value === undefined || !isFinite(value)
    ? '—' : (digits === undefined ? String(value) : Number(value).toFixed(digits));

export const WALL_BAND_COLORS = {
    '160M': '#b565d8', '80M': '#e67e22', '60M': '#fd79a8', '40M': '#f1c40f',
    '30M': '#1abc9c', '20M': '#00e5ff', '17M': '#3498db', '15M': '#9b59b6',
    '12M': '#e84393', '10M': '#e17055', '6M': '#dfe6e9', '2M': '#55efc4'
};

/* Rival identity palette, shared by the opponent list and the map markers.
 *
 * The semantic palette already owns most of the wheel: alert red 14 deg, DX
 * red 0 deg, my-station cyan 193 deg, QSO green 161 deg, and the 12 band hues
 * (285/27/336/48/168/184/204/283/327/14/200/164 deg). The only wide free arcs
 * are 49-160, 205-282 and 286-326, so a mathematically even split is not
 * possible; the six hues below sit in the middle of those arcs and are pulled
 * apart further by lightness. Hue angle and WCAG contrast on the #0a121d
 * panel:
 *
 *   #f3ed3f  58 deg  15.2:1   lemon
 *   #26e109 112 deg  10.6:1   grass green
 *   #6ff69c 140 deg  13.7:1   spring green
 *   #3377ff 220 deg   4.7:1   royal blue
 *   #c6a8fa 262 deg   9.3:1   lavender
 *   #f859e8 306 deg   6.8:1   magenta
 *
 * Closest rival pair is dE(CIE76) 42; closest reserved neighbour is dE 21.5
 * (40M gold). Six hues are fewer than ten rivals, so every rival also gets a
 * fixed marker shape (below); no two rivals on screen share colour + shape. */
export const OPPONENT_COLORS = [
    '#f3ed3f', /* lemon        hue  58 */
    '#26e109', /* grass         hue 112 */
    '#6ff69c', /* spring green  hue 140 */
    '#3377ff', /* royal blue    hue 220 */
    '#c6a8fa', /* lavender      hue 262 */
    '#f859e8' /* magenta       hue 306 */
];

/* Second encoding: a fixed glyph per rival, drawn identically in the list and
 * on the map. Colour alone cannot carry six-plus identities on a dense map,
 * so shape survives colour-vision differences and small marker sizes. */
export const OPPONENT_SHAPES = [
    'disc', 'ring', 'square', 'diamond', 'triangle', 'hexagon', 'cross', 'bullseye'
];

const SHAPE_DRAW = {
    disc: color => '<circle cx="8" cy="8" r="5.6" fill="' + color +
        '" stroke="#04101c" stroke-width="1.6"/>',
    ring: color => '<circle cx="8" cy="8" r="5" fill="none" stroke="' + color +
        '" stroke-width="2.8"/>',
    square: color => '<rect x="3" y="3" width="10" height="10" rx="1" fill="' + color +
        '" stroke="#04101c" stroke-width="1.6"/>',
    diamond: color => '<path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" fill="' + color +
        '" stroke="#04101c" stroke-width="1.4"/>',
    triangle: color => '<path d="M8 2.4 13.6 13.2 2.4 13.2Z" fill="' + color +
        '" stroke="#04101c" stroke-width="1.4"/>',
    hexagon: color => '<path d="M8 2.4 13 5.2v5.6L8 13.6 3 10.8V5.2Z" fill="none" stroke="' +
        color + '" stroke-width="2.4"/>',
    cross: color => '<path d="M8 2.4v11.2M2.4 8h11.2" stroke="' + color +
        '" stroke-width="2.8" stroke-linecap="round"/>',
    bullseye: color => '<circle cx="8" cy="8" r="5.8" fill="none" stroke="' + color +
        '" stroke-width="1.7"/><circle cx="8" cy="8" r="2.2" fill="' + color + '"/>'
};

/** Inline SVG glyph, used verbatim by the card swatch and the map marker so
 *  the two views cannot drift apart. */
export function shapeSvg(shape, color, size = 16) {
    const draw = SHAPE_DRAW[shape] || SHAPE_DRAW.disc;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" ' +
        'aria-hidden="true">' + draw(color || OPPONENT_COLORS[0]) + '</svg>';
}

/** Third, weaker cue on the great-circle tracks: dashed/dotted variants plus a
 *  slightly heavier stroke, so paths stay separable where markers overlap. */
export function trackStyle(shapeIndex) {
    return {
        weight: shapeIndex % 3 === 1 ? 1.7 : 1.1,
        dashArray: shapeIndex % 4 === 1 ? '6,4' : shapeIndex % 4 === 3 ? '2,3' : null,
        opacity: 0.5
    };
}

/** FNV-1a over the upper-cased call: same call, same slot on every device. */
export function callColorIndex(call) {
    const text = String(call || '').toUpperCase();
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % OPPONENT_COLORS.length;
}

/** Assign colours in display order. While free slots remain every rival gets
 *  its own colour (hash picks the start, the nearest free slot wins); once the
 *  palette is exhausted colours are reused, but a rival never repeats its
 *  predecessor's colour. Deterministic for a given ordered call list. */
export function assignOpponentColors(calls) {
    const size = OPPONENT_COLORS.length;
    const colors = new Map();
    const used = new Set();
    let previous = null;
    calls.forEach(call => {
        const start = callColorIndex(call);
        let color = null;
        for (let step = 0; step < size; step++) {
            const candidate = OPPONENT_COLORS[(start + step) % size];
            if (candidate === previous) continue;
            if (used.size < size && used.has(candidate)) continue;
            color = candidate;
            break;
        }
        if (!color) color = OPPONENT_COLORS[start];
        colors.set(call, color);
        used.add(color);
        previous = color;
    });
    return colors;
}

/** Colour + shape in display order. Colours come from the palette rule above;
 *  the glyph seed is spread by palette slot so two rivals that share a hue
 *  always land on different shapes. A rival never repeats an already used
 *  colour+shape pair, which keeps even 10 rivals on screen unambiguous. */
export function assignOpponentStyles(calls) {
    const colors = assignOpponentColors(calls);
    const size = OPPONENT_SHAPES.length;
    const taken = new Map();
    const styles = new Map();
    calls.forEach((call, position) => {
        const color = colors.get(call);
        if (!taken.has(color)) taken.set(color, new Set());
        const used = taken.get(color);
        const colorSlot = Math.max(0, OPPONENT_COLORS.indexOf(color));
        let shapeIndex = (colorSlot * 3 + position) % size;
        for (let step = 0; step < size; step++) {
            const candidate = (shapeIndex + step) % size;
            if (!used.has(candidate)) {
                shapeIndex = candidate;
                break;
            }
        }
        used.add(shapeIndex);
        styles.set(call, {
            color,
            shape: OPPONENT_SHAPES[shapeIndex],
            shapeIndex
        });
    });
    return styles;
}

/** Conic swatch listing the palette, used by the map legend for DX spots. */
export function opponentColorGradient() {
    const stops = OPPONENT_COLORS.map((color, index) => {
        const from = Math.round(index * 100 / OPPONENT_COLORS.length);
        const to = Math.round((index + 1) * 100 / OPPONENT_COLORS.length);
        return color + ' ' + from + '% ' + to + '%';
    });
    return 'conic-gradient(' + stops.join(',') + ')';
}
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

function finishBand(entry, concentrationMin) {
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
        spread: entry.dirs >= 2 && resultant < concentrationMin
    };
}

export function buildOpponents(rows, myCall, bearing, {
    now = Date.now(), windowMs = WINDOW_MS, concentrationMin = CONCENTRATION_MIN
} = {}) {
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
            opponent = {call, n: 0, ts: 0, bands: new Map(), last: null};
            opponents.set(call, opponent);
        }
        opponent.n++;
        opponent.ts = Math.max(opponent.ts, time);
        if (!opponent.last || time >= opponent.last.ts) opponent.last = {ts: time, row};

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

        if (bearing && row.lat !== null && row.lat !== undefined &&
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

    const list = [...opponents.values()].map(opponent => {
        const row = opponent.last && opponent.last.row || {};
        /* PSKR writes the spotted sender into spot_call; RBN writes the spotter
         * there. The "target" fields therefore describe the *other* station,
         * never the rival itself. */
        const rivalIsSpot = String(row.spot_call || '').toUpperCase() === opponent.call;
        const targetGrid = rivalIsSpot ? row.receiver_grid : row.sender_grid;
        const targetDxcc = rivalIsSpot ? row.dxcc_receiver : row.dxcc_sender;
        let dir = null;
        if (bearing && row.dx_lat !== null && row.dx_lat !== undefined &&
            row.dx_lon !== null && row.dx_lon !== undefined &&
            row.lat !== null && row.lat !== undefined &&
            row.lon !== null && row.lon !== undefined) {
            const value = bearing(row.dx_lat, row.dx_lon, row.lat, row.lon);
            if (isFinite(value)) dir = (value + 360) % 360;
        }
        return {
            call: opponent.call,
            n: opponent.n,
            ts: opponent.ts,
            lat: row.dx_lat === undefined ? null : row.dx_lat,
            lon: row.dx_lon === undefined ? null : row.dx_lon,
            grid: rivalIsSpot ? row.sender_grid : row.receiver_grid,
            dxcc: rivalIsSpot ? row.dxcc_sender : row.dxcc_receiver,
            targetCall: rivalIsSpot ? row.de : row.spot_call,
            targetGrid: targetGrid || null,
            targetDxcc: targetDxcc === undefined ? null : targetDxcc,
            bearing: dir,
            freq: row.freq === undefined ? null : row.freq,
            band: row.band || '',
            bands: [...opponent.bands.values()]
                .sort((a, b) => b.n - a.n || bandRank(a.band) - bandRank(b.band))
                .map(entry => finishBand(entry, concentrationMin))
        };
    }).sort((a, b) => b.n - a.n || b.ts - a.ts || a.call.localeCompare(b.call));
    /* Colour and glyph in the same order the cards are painted, so the map can
     * rebuild the identical assignment from the same rows. */
    const styles = assignOpponentStyles(list.map(opponent => opponent.call));
    list.forEach(opponent => {
        const style = styles.get(opponent.call);
        opponent.color = style.color;
        opponent.shape = style.shape;
        opponent.shapeIndex = style.shapeIndex;
    });
    return list;
}

/** Call -> colour for the map. Runs the list aggregation (same window, same
 *  band filter, same activity order) so a rival never changes colour between
 *  the panel and its markers. */
export function opponentColorMap(rows, myCall, options) {
    const colors = new Map();
    buildOpponents(rows, myCall, null, options)
        .forEach(opponent => colors.set(opponent.call, opponent.color));
    return colors;
}

/** Call -> {color, shape, shapeIndex} for the map: the same assignment the
 *  panel cards use, including the second encoding. */
export function opponentStyleMap(rows, myCall, options) {
    const styles = new Map();
    buildOpponents(rows, myCall, null, options).forEach(opponent => {
        styles.set(opponent.call, {
            color: opponent.color,
            shape: opponent.shape,
            shapeIndex: opponent.shapeIndex
        });
    });
    return styles;
}

export function bandCellHtml(band) {
    let direction = '—';
    let arrow = '';
    if (band.dirSamples >= 2 && band.spread) {
        direction = t('wall.opp.multiDir');
    } else if (band.dir !== null) {
        /* The compass word is its own span so the compact grid can hide it and
         * keep only the arrow + degrees when the card is narrow. */
        direction = '<span class="ob-compass">' + compass(band.dir) + '</span> ' +
            Math.round(band.dir) + '°';
        arrow = '<i class="ob-arrow">' + ARROWS[compassIndex(band.dir)] + '</i>';
    }
    const thin = band.dirSamples === 1;
    const frequency = band.freq ? num(band.freq / 1000, 3) : '—';
    const title = band.band + ' · ' + band.n + ' SPOT · ' +
        (band.dirSamples
            ? t('wall.opp.dirSamples', {count: band.dirSamples})
            : t('wall.opp.noDirSamples')) +
        (thin ? t('wall.opp.thinHint') : '') +
        (band.freq ? ' · ' + num(band.freq, 0) + ' kHz' : '');
    return '<div class="opp-band' + (thin ? ' thin' : '') + '" style="--band-color:' +
        band.color + '" title="' + esc(title) + '">' +
        '<div class="ob-line"><b>' + esc(band.band) + '</b><u>' + frequency +
        '<small>MHz</small></u></div>' +
        '<div class="ob-dir">' + arrow + '<em>' + direction + '</em></div>' +
        '</div>';
}

export function opponentCardHtml(opponent, bandsMax = 12) {
    const limit = Number.isFinite(bandsMax) ? Math.max(1, Math.round(bandsMax)) : opponent.bands.length;
    return '<section class="opp-call-card" style="--call-color:' +
        (opponent.color || OPPONENT_COLORS[0]) + '">' +
        '<div class="oc-head"><i class="oc-shape">' +
        shapeSvg(opponent.shape, opponent.color, 13) + '</i>' +
        '<b>' + esc(opponent.call) + '</b><span>' +
        esc(t('wall.opp.cardMeta', {bands: opponent.bands.length, count: opponent.n})) +
        '</span></div>' +
        '<div class="ob-bands">' + opponent.bands.slice(0, limit).map(bandCellHtml).join('') + '</div>' +
        '</section>';
}

export function createOpponentRenderer({bearing, windowMin = 30, concentrationMin = 0.4,
    compactMin = 5, bandsMax = 12} = {}) {
    let opponents = [];
    let lastRows = [];
    let lastCall = '';
    const config = {windowMin, concentrationMin, compactMin, bandsMax};
    const windowMs = () => Math.max(1, Number(config.windowMin) || 30) * 60000;

    function paint() {
        const box = $('#oppRows');
        if (!box) return;
        const summary = $('#oppSummary');
        if (!opponents.length) {
            box.innerHTML = '<div class="opp-empty">' +
                esc(t('wall.opp.empty', {min: config.windowMin})) + '</div>';
            box.classList.remove('dense', 'dense-2', 'compact');
            if (summary) summary.textContent = '';
            return;
        }
        box.innerHTML = opponents.map(opponent => opponentCardHtml(opponent, config.bandsMax)).join('');
        const bands = new Set();
        opponents.forEach(opponent => opponent.bands.forEach(band => bands.add(band.band)));
        if (summary) {
            summary.textContent = t('wall.opp.summary', {
                count: opponents.length, bands: bands.size
            });
        }
        /* Up to nine rivals must fit on a 1080p wall without scrolling, so
         * five or more switch to a two-column grid of short cards (band cells
         * inline). Fewer rivals keep the roomier one-column cards. */
        box.classList.remove('dense');
        box.classList.remove('dense-2');
        box.classList.remove('compact');
        if (opponents.length >= config.compactMin) {
            box.classList.add('compact');
            return;
        }
        if (box.scrollHeight > box.clientHeight + 1) {
            box.classList.add('dense');
            if (box.scrollHeight > box.clientHeight + 1) box.classList.add('dense-2');
        }
    }

    function render(rows, myCall) {
        lastRows = Array.isArray(rows) ? rows : [];
        lastCall = myCall;
        opponents = buildOpponents(lastRows, lastCall, bearing, {
            windowMs: windowMs(),
            concentrationMin: config.concentrationMin
        });
        paint();
    }

    function setOptions(options = {}) {
        const read = (key, fallback, min, max) => {
            const value = Number(options[key]);
            config[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
        };
        read('windowMin', 30, 5, 180);
        read('concentrationMin', 0.4, 0, 1);
        read('compactMin', 5, 2, 12);
        read('bandsMax', 12, 3, 12);
        if (lastRows.length) render(lastRows, lastCall);
        else paint();
    }

    return {render, trim: paint, setOptions};
}
