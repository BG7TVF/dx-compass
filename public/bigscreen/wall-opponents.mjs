/* Opponent aggregation and DOM trimming for the wall. The shared geo bearing
 * function is injected so this module contains no second geography formula. */

const $ = selector => document.querySelector(selector);
const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const compass = degrees => COMPASS[Math.round(((degrees % 360) + 360) % 360 / 45) % 8];
const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (value, digits) => value === null || value === undefined || !isFinite(value)
    ? '—' : (digits === undefined ? String(value) : Number(value).toFixed(digits));

export const WALL_BAND_COLORS = {
    '160M': '#b565d8', '80M': '#e67e22', '60M': '#fd79a8', '40M': '#f1c40f',
    '30M': '#1abc9c', '20M': '#00e5ff', '17M': '#3498db', '15M': '#9b59b6',
    '12M': '#e84393', '10M': '#e17055', '6M': '#dfe6e9', '2M': '#55efc4'
};

export function buildOpponents(rows, myCall, bearing) {
    const my = String(myCall || '').toUpperCase();
    const by = new Map();
    rows.forEach(row => {
        const call = String(row.monitored_call || row.dx_call || '').toUpperCase();
        if (!call || call === my) return;
        let opponent = by.get(call);
        if (!opponent) {
            opponent = {call, n: 0, sin: 0, cos: 0, bands: new Map()};
            by.set(call, opponent);
        }
        opponent.n++;
        const timestamp = new Date(row.timestamp).getTime();
        const band = String(row.band || '').toUpperCase();
        const key = band || (row.freq ? 'F' + row.freq : '');
        const seen = key ? opponent.bands.get(key) : null;
        if (key && (!seen || (isFinite(timestamp) && timestamp > seen.ts))) {
            opponent.bands.set(key, {
                band, freq: row.freq, ts: isFinite(timestamp) ? timestamp : 0
            });
        }
        if (row.lat !== null && row.lat !== undefined &&
            row.dx_lat !== null && row.dx_lat !== undefined) {
            const direction = bearing(row.dx_lat, row.dx_lon, row.lat, row.lon);
            opponent.sin += Math.sin(direction * Math.PI / 180);
            opponent.cos += Math.cos(direction * Math.PI / 180);
        }
    });
    return [...by.values()].sort((a, b) => b.n - a.n).map(opponent => {
        opponent.dir = Math.atan2(opponent.sin, opponent.cos) * 180 / Math.PI;
        opponent.dir = (opponent.dir + 360) % 360;
        opponent.bands = [...opponent.bands.values()].sort((a, b) => b.ts - a.ts);
        return opponent;
    });
}

export function opponentRowHtml(opponent) {
    const named = (opponent.bands || []).filter(item => item.band);
    const shown = named.slice(0, 3);
    const extra = named.length - shown.length;
    const chips = shown.map(item => {
        const color = WALL_BAND_COLORS[item.band] || 'var(--dim)';
        return '<i style="color:' + color + '">' + esc(item.band.replace(/M$/, '')) + '</i>';
    }).join('');
    const more = extra > 0 ? '<em>+' + extra + '</em>' : '';
    const newest = (opponent.bands || [])[0];
    const frequency = newest && newest.freq ? num(newest.freq / 1000, 3) : '';
    const cell = chips
        ? chips + more + (named.length === 1 && frequency ? '<u>' + frequency + '</u>' : '')
        : (frequency || '—');
    const hasDirection = opponent.sin !== 0 || opponent.cos !== 0;
    const direction = hasDirection
        ? compass(opponent.dir) + ' ' + Math.round(opponent.dir) + '°' : '—';
    return '<div class="opp-row"><b>' + esc(opponent.call) + '</b><span class="cnt">' +
        opponent.n + '</span><span class="dir">' + direction + '</span><span class="freq">' +
        cell + '</span></div>';
}

export function createOpponentRenderer({bearing}) {
    let opponents = [];

    function trim() {
        const box = $('#oppRows');
        if (!box || !opponents.length) return;
        box.innerHTML = opponents.slice(0, 12).map(opponentRowHtml).join('');
        const first = box.firstElementChild;
        const rowHeight = first ? first.getBoundingClientRect().height : 0;
        const available = box.clientHeight;
        if (!rowHeight || !available) return;
        let capacity = Math.max(1, Math.floor(available / rowHeight));
        if (capacity >= opponents.length) return;
        capacity = Math.max(1, Math.floor((available - 14) / rowHeight));
        const shown = Math.min(capacity, opponents.length);
        box.innerHTML = opponents.slice(0, shown).map(opponentRowHtml).join('') +
            '<div class="opp-empty">+' + (opponents.length - shown) + ' more</div>';
    }

    function render(rows, myCall) {
        opponents = buildOpponents(rows, myCall, bearing);
        const box = $('#oppRows');
        if (!opponents.length) {
            box.innerHTML = '<div class="opp-empty">等待对手 SPOT…</div>';
            return;
        }
        trim();
    }

    return {render, trim};
}
