/* 大屏台站链路面板：波段占用矩阵、天线使用矩阵、天线指向罗盘。
 *
 * 全部是只读渲染——数据由 shared 仓库取回后传进来，本模块既不碰传输，
 * 也不下发任何旋转器/切换器指令。字段口径与主应用操作员页一致：
 *   · 波段占用取自席位状态（freqKhz → 波段、mode、isTransmitting）；
 *   · 天线使用取自设备快照 ownership.antennas[].switch_color_by_seat，
 *     红=本席已接通、黄=被别席接通、绿=无人接通；
 *   · 天线指向取自 rotators[id] 的实际方位（physical + 安装偏移）。 */

import {bandOf, trimRows} from './wall-cards.mjs';
import {WALL_BAND_COLORS} from '../shared/opponents/opponents.mjs';
import {t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const BAND_ORDER = ['160M', '80M', '60M', '40M', '30M', '20M', '17M', '15M', '12M', '10M', 'VHF'];
const bandColor = band => WALL_BAND_COLORS[band] || WALL_BAND_COLORS[String(band || '').toLowerCase()] ||
    '#35d6a4';
const seatNumber = seat => {
    const value = Number(String(seat).replace(/\D/g, ''));
    return Number.isFinite(value) ? value : 0;
};
/* 席位列按号码排序，大屏从左到右就是 1 号机到 N 号机。 */
const sortSeats = seats => [...new Set(seats.filter(Boolean).map(String))]
    .sort((a, b) => seatNumber(a) - seatNumber(b) || String(a).localeCompare(String(b)));
const shortMode = mode => String(mode || '').toUpperCase().slice(0, 5);
const normalizeBand = band => {
    const raw = String(band || '').toUpperCase();
    if (!raw) return '';
    if (raw === 'VHF' || raw === 'UHF') return 'VHF';
    const mhz = parseFloat(raw);
    return isFinite(mhz) ? bandOf(mhz * 1000) : raw;
};

/* ── 波段占用：行=波段，列=席位 ─────────────────────────────── */

export function renderBandOccupancy(station) {
    const box = $('#bandOcc');
    if (!box) return;
    const seats = (station && Array.isArray(station.seats) ? station.seats : [])
        .filter(seat => seat && seat.seat);
    const columns = sortSeats(seats.map(seat => seat.seat));
    if (!columns.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.empty.waitingStation')) + '</div>';
        return;
    }
    const bySeat = new Map(seats.map(seat => [String(seat.seat), seat]));
    const used = new Map();
    columns.forEach(id => {
        const seat = bySeat.get(id) || {};
        const band = normalizeBand(seat.band) || (seat.freqKhz ? bandOf(seat.freqKhz) : '');
        if (!band) return;
        if (!used.has(band)) used.set(band, []);
        used.get(band).push(id);
    });
    if (!used.size) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.empty.waitingStation')) + '</div>';
        return;
    }
    const rows = BAND_ORDER.filter(band => used.has(band));
    const grid = '--cols:' + columns.length;
    const head = '<div class="occ-row occ-head" style="' + grid + '"><i class="occ-tag"></i>' +
        columns.map(id => '<b>' + esc('S' + seatNumber(id)) + '</b>').join('') + '</div>';
    const body = rows.map(band => {
        const taken = used.get(band);
        const cells = columns.map(id => {
            const seat = bySeat.get(id) || {};
            const seatBand = normalizeBand(seat.band) || (seat.freqKhz ? bandOf(seat.freqKhz) : '');
            if (seatBand !== band) return '<i class="occ-cell"></i>';
            const tx = seat.isTransmitting ? ' tx' : '';
            const mode = shortMode(seat.mode);
            const freq = seat.freqKhz ? (seat.freqKhz / 1000).toFixed(3) : '—';
            return '<i class="occ-cell on' + tx + '" style="--c:' + bandColor(band) + '" ' +
                'title="' + esc(freq + ' MHz · ' + mode) + '"><u>' + esc(mode || '·') + '</u></i>';
        }).join('');
        return '<div class="occ-row occ-data" style="' + grid + '"><b class="occ-tag" style="--c:' +
            bandColor(band) + '">' + esc(band) + '</b>' + cells + '</div>';
    }).join('');
    box.innerHTML = head + body + '<div class="occ-legend">' +
        '<span class="lg tx"></span>TX<span class="lg on"></span>QSY' +
        '<span class="lg idle"></span>' + esc(t('wall.occ.idle')) + '<i class="more" hidden></i></div>';
    trimRows(box, {
        rowClass: 'occ-data',
        marker: box.querySelector('.occ-legend .more'),
        min: 1
    });
}

/* ── 天线使用：行=天线，列=席位 ─────────────────────────────── */

const CELL_CLASS = {red: 'mine', yellow: 'other', green: 'idle'};

export function renderAntennaUse(devices) {
    const box = $('#antMatrix');
    if (!box) return;
    const antennas = (devices && devices.ownership && devices.ownership.antennas) || [];
    if (!antennas.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.ants.empty')) + '</div>';
        return;
    }
    const columns = sortSeats(antennas.flatMap(antenna => Object.keys(
        (antenna && antenna.switch_color_by_seat) || {})));
    if (!columns.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.empty.waitingStation')) + '</div>';
        return;
    }
    const grid = '--cols:' + columns.length;
    /* 已被接通的排在前面，大屏一眼就能看到 RF 现在落在哪几副天线上。
     * 一行一副天线：支持的波段写进 title，不再单独占一行，否则整张矩阵卡
     * 会撑出左栏，把后面的波段占用卡顶出栏外。 */
    const ranked = [...antennas].sort((a, b) =>
        (b.routed_by || []).length - (a.routed_by || []).length ||
        String(a.name || a.id).localeCompare(String(b.name || b.id)));
    const shown = ranked.slice(0, 8);
    const hidden = ranked.length - shown.length;
    const head = '<div class="occ-row ant-head" style="' + grid + '"><i class="occ-tag"></i>' +
        columns.map(id => '<b>' + esc('S' + seatNumber(id)) + '</b>').join('') + '</div>';
    const body = shown.map(antenna => {
        const colors = antenna.switch_color_by_seat || {};
        const cells = columns.map(id => {
            const cls = CELL_CLASS[colors[id]] || 'idle';
            return '<i class="ant-cell ' + cls + '"></i>';
        }).join('');
        const bands = (antenna.bands || []).slice(0, 8)
            .map(band => normalizeBand(band)).filter(Boolean).join(' ');
        const name = (antenna.name || antenna.id) +
            (antenna.preferred ? ' ★' : '');
        return '<div class="occ-row ant-row occ-data" style="' + grid + '">' +
            '<b class="ant-name" title="' + esc(name + (bands ? ' · ' + bands : '')) + '">' +
            esc(name) + '</b>' + cells + '</div>';
    }).join('');
    box.innerHTML = head + body + '<div class="occ-legend">' +
        '<span class="lg mine"></span>' + esc(t('wall.rig.mine')) +
        '<span class="lg other"></span>' + esc(t('wall.rig.other')) +
        '<span class="lg idle"></span>' + esc(t('wall.occ.idle')) +
        '<i class="more" hidden></i></div>';
    // 天线行数由视口高度决定：放不下的删掉，剩余数量并进 "+N"。
    trimRows(box, {
        rowClass: 'occ-data',
        marker: box.querySelector('.occ-legend .more'),
        extra: hidden,
        min: 2
    });
}

/* ── 天线指向：每台带旋转器的天线一个罗盘 ─────────────────────── */

const dialTicks = () => {
    let marks = '';
    for (let deg = 0; deg < 360; deg += 30) {
        const major = deg % 90 === 0;
        marks += '<line x1="50" y1="' + (major ? 6 : 8) + '" x2="50" y2="' + (major ? 15 : 14) +
            '" class="' + (major ? 'maj' : 'min') + '" transform="rotate(' + deg + ' 50 50)"></line>';
    }
    return marks +
        '<text x="50" y="21" class="cardinal">N</text>' +
        '<text x="83" y="53.5" class="cardinal">E</text>' +
        '<text x="50" y="86" class="cardinal">S</text>' +
        '<text x="17" y="53.5" class="cardinal">W</text>';
};

function dial(azimuth, target, cls, color) {
    const hasAz = Number.isFinite(azimuth);
    const needle = hasAz
        ? '<g transform="rotate(' + (((azimuth % 360) + 360) % 360).toFixed(1) + ' 50 50)" class="' + cls + '">' +
          '<path d="M50 18 L54.5 52 L50 47 L45.5 52 Z"></path></g>'
        : '<g class="nodata"><circle cx="50" cy="50" r="26"></circle></g>';
    const aim = Number.isFinite(target) && !hasAz
        ? '<line x1="50" y1="16" x2="50" y2="26" class="target" transform="rotate(' +
          (((target % 360) + 360) % 360).toFixed(1) + ' 50 50)" style="stroke:' + color + '"></line>'
        : '';
    return '<circle cx="50" cy="50" r="34" class="ring"></circle>' + dialTicks() + aim + needle +
        '<circle cx="50" cy="50" r="3.2" class="hub"></circle>';
}

export function renderRotors(devices) {
    const box = $('#rotorDials');
    if (!box) return;
    const ownership = (devices && devices.ownership) || {};
    const rotators = (devices && devices.rotators) || {};
    const antennas = ownership.antennas || [];
    const withRotator = antennas.filter(antenna => antenna && antenna.rotator_id);
    if (!withRotator.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.rotor.empty')) + '</div>';
        return;
    }
    const ranked = [...withRotator].sort((a, b) => {
        const liveA = Number.isFinite(a.actual_azimuth) ? 1 : 0;
        const liveB = Number.isFinite(b.actual_azimuth) ? 1 : 0;
        return liveB - liveA || String(a.name || a.id).localeCompare(String(b.name || b.id));
    }).slice(0, 8);
    box.innerHTML = ranked.map(antenna => {
        const rotator = rotators[antenna.rotator_id] || {};
        const az = Number.isFinite(antenna.actual_azimuth) ? antenna.actual_azimuth : null;
        const target = Number.isFinite(rotator.target_azimuth) ? rotator.target_azimuth : null;
        const motion = rotator.motion_state === 'moving' ? 'moving'
            : (rotator.motion_state === 'settled' ? 'settled' : '');
        const owners = (antenna.routed_by || []).map(seat => 'S' + seatNumber(seat)).join(' ');
        const cls = 'needle ' + (owners ? 'hot' : 'cold');
        const value = az === null ? '—' : Math.round(((az % 360) + 360) % 360) + '°';
        return '<div class="dial' + (owners ? ' owned' : '') + ' ' + motion + '" ' +
            'title="' + esc((antenna.name || antenna.id) + ' · ' + value) + '">' +
            '<svg viewBox="0 0 100 100" aria-hidden="true">' +
            dial(az, target, cls, owners ? '#ffcf6b' : '#4cc9f0') + '</svg>' +
            '<b>' + esc(value) + '</b>' +
            '<span class="dial-name">' + esc(antenna.name || antenna.id) + '</span>' +
            '<i class="dial-seat">' + esc(owners || (motion === 'moving'
                ? t('wall.rotor.moving')
                : (motion === 'settled' ? t('wall.rotor.settled') : '—'))) + '</i>' +
            '</div>';
    }).join('');
}
