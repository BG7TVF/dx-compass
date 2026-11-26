/* 设备动态：席位铭牌、天线归属、波段占用、天线指向。
 *
 * 这一栏只回答观众的一个问题——「此刻这套台子正在怎么打」。
 * 所有涉及席位的颜色都来自 wall-cards 的 SEAT_COLORS：同一个席位在席位卡、
 * 天线徽章、波段徽章、QSO 流水和地图连线上永远是同一个颜色。这里不存在
 * 「本席 / 他席」的区分，观众墙没有“我”的视角。 */

import {bandOf, seatColor, tr, trimRows} from './wall-cards.mjs';
import {WALL_BAND_COLORS} from '../shared/opponents/opponents.mjs';
import {t} from './wall-i18n.mjs';

const $ = selector => document.querySelector(selector);
const esc = value => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* normalizeKey 与 lib/qsos/seat.js 保持一致：大写、去首尾空白、竖线与冒号
 * 换成下划线、连续空白压成一个空格、最长 64。席位键 = STATION:NR。 */
function normalizeKey(value) {
    return String(value === undefined || value === null ? '' : value)
        .trim()
        .toUpperCase()
        .replace(/[|:]/g, '_')
        .replace(/\s+/g, ' ')
        .slice(0, 64);
}

function seatKey(station, radioNr) {
    /* 必须再过一遍 normalizeKey：席位计划表里的键也是规范化后的形态（冒号被
     * 换成下划线）。这里若留着一个字面冒号，流水表就永远对不上席位，观众看到的
     * 席位列会整屏是破折号。 */
    return normalizeKey((normalizeKey(station) || 'LOCAL') + ':' + (normalizeKey(radioNr) || '1'));
}

function seatNumber(seat) {
    return Number(String(seat === undefined || seat === null ? '' : seat).replace(/\D/g, '')) || 0;
}

/* 波段展示名：10M/20M… 是全世界 HAM 都认的写法，只有 VHF 需要本地化。 */
function bandLabel(key) {
    return key === 'VHF' ? t('wall.band.vhf') : key;
}

function mhz(freqKhz) {
    const value = Number(freqKhz);
    return isFinite(value) && value > 0 ? (value / 1000).toFixed(3) : '';
}

/**
 * 组装席位模型。
 *
 * 数据来自三处，缺一不可：
 *   devices.seat_plan.seats  — 谁是几号席位（设备属性里绑定的稳定编号）；
 *   station.seats            — 该席位此刻的频率 / 模式 / 是否在发射（N1MM 心跳）；
 *   rows                     — QSO 流水，用来统计每个席位打了多少条。
 * 没有 seat_plan 时退回用 station.seats 自行编号，保证大屏永远有席位可看。
 */
export function buildSeats(station, devices, rows) {
    const plan = (devices && devices.seat_plan) || {};
    const planSeats = Array.isArray(plan.seats) ? plan.seats : [];
    const live = station && Array.isArray(station.seats) ? station.seats : [];
    const byNo = new Map();
    const keyToNo = new Map();

    const ensure = no => {
        if (!byNo.has(no)) {
            byNo.set(no, {
                no, color: seatColor(no), keys: [], operator: '', stationName: '',
                radioName: '', computerName: '', band: '', online: false,
                freqKhz: 0, txFreqKhz: 0, mode: '', isRunning: false,
                isTransmitting: false, qsos: 0, points: 0, mults: 0
            });
        }
        return byNo.get(no);
    };

    planSeats.forEach(seat => {
        const no = seatNumber(seat && seat.no);
        if (!no) return;
        const entry = ensure(no);
        entry.online = !!seat.online;
        entry.band = String(seat.band || '').toUpperCase();
        entry.operator = String(seat.operator || '').trim();
        entry.stationName = String(seat.station_name || '').trim();
        entry.computerName = String(seat.computer_name || '').trim();
        entry.radioName = String(seat.radio_name || '').trim();
        (Array.isArray(seat.keys) ? seat.keys : []).forEach(key => {
            const normalized = normalizeKey(key);
            if (!normalized) return;
            entry.keys.push(normalized);
            keyToNo.set(normalized, no);
        });
        (Array.isArray(seat.radio_ids) ? seat.radio_ids : []).forEach(id => {
            const normalized = normalizeKey(id);
            if (normalized) keyToNo.set('RADIO:' + normalized, no);
        });
    });

    /* station.seats 的键就是 STATION:NR；没有计划表时按键顺序补出编号。 */
    live.forEach(state => {
        const key = normalizeKey(state && state.seat);
        if (!key) return;
        let no = keyToNo.get(key);
        if (!no) {
            no = seatNumber(state.radioNr) || (byNo.size + 1);
            keyToNo.set(key, no);
        }
        const entry = ensure(no);
        if (!entry.keys.includes(key)) entry.keys.push(key);
        entry.online = true;
        entry.freqKhz = Number(state.freqKhz) || entry.freqKhz;
        entry.txFreqKhz = Number(state.txFreqKhz) || entry.txFreqKhz;
        entry.mode = String(state.mode || entry.mode || '').toUpperCase();
        entry.isRunning = state.isRunning !== false;
        entry.isTransmitting = !!state.isTransmitting;
        entry.operator = String(state.operator || entry.operator || '').trim();
        entry.stationName = entry.stationName || String(state.stationName || '').trim();
        entry.computerName = entry.computerName || String(state.computerName || '').trim();
        entry.radioName = entry.radioName || String(state.radioName || '').trim();
        if (!entry.band) entry.band = bandOf(entry.freqKhz);
    });

    const txKeys = new Set();
    byNo.forEach(entry => {
        if (!entry.isTransmitting) return;
        entry.keys.forEach(key => txKeys.add(key));
    });

    /* QSO 行落到席位：先按「台站:电台号」精确匹配，再退回只认电台号。
     * 日志里偶尔只有 radionr（或者台站名写法与席位表不一致），此时若不兜底，
     * 流水表的席位列就整屏空白，观众再也无法用颜色把同一台机器串起来。 */
    const seatOfRow = row => {
        if (!row) return null;
        const key = seatKey(row.stationname, row.radionr);
        const radio = normalizeKey(row.radionr);
        const no = keyToNo.get(key)
            || (radio && (keyToNo.get('RADIO:' + radio) || keyToNo.get('STATION_' + radio)))
            || 0;
        return no ? {no, key, color: seatColor(no)} : null;
    };

    const list = [...byNo.values()].sort((a, b) => a.no - b.no);
    (rows || []).forEach(row => {
        const seat = seatOfRow(row);
        if (!seat) return;
        const entry = byNo.get(seat.no);
        if (!entry) return;
        entry.qsos += 1;
        entry.points += Number(row.points) || 0;
        if (row.is_mult) entry.mults += 1;
    });

    return {seats: list, seatOfRow, keyToNo, txKeys, byNo};
}

function seatTag(no, extra) {
    if (!no) return '';
    return '<span class="seat-badge' + (extra || '') + '" style="--seat:' + seatColor(no) +
        '">' + esc(tr('wall.rig.seatNo', 'Seat {n}', {n: no})) + '</span>';
}

/**
 * 席位铭牌：色点 + 「席位 N」 + 当前操作员呼号 + 频率/模式/波段 + 该席位战果。
 * 没人打的席位仍然占一行（压暗），观众能看出这套台子有几台机器在闲着。
 */
export function renderSeatRoster(box, model) {
    if (!box) return;
    const seats = (model && model.seats) || [];
    if (!seats.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.empty.waitingStation')) + '</div>';
        return;
    }
    box.innerHTML = seats.map(seat => {
        const classes = ['seat'];
        if (seat.isTransmitting) classes.push('tx');
        else if (!seat.online || seat.isRunning === false) classes.push('idle');
        const operator = seat.operator ||
            '<em>' + esc(t('wall.rig.unattended')) + '</em>';
        const frequency = mhz(seat.freqKhz);
        const details = [
            frequency ? frequency + ' MHz' : '—',
            seat.mode || '—',
            bandLabel(seat.band || bandOf(seat.freqKhz) || '')
        ].join(' · ');
        return '<div class="' + classes.join(' ') + '" style="--seat:' + seat.color + '">' +
            '<i class="seat-dot"></i>' +
            '<div class="seat-text"><b><i>' + esc(tr('wall.rig.seatNo', 'Seat {n}', {n: seat.no})) +
            '</i>' + operator + '</b><span>' + esc(details) + '</span></div>' +
            '<div class="seat-num"><b>' + seat.qsos + '</b><span>' +
            esc(t('wall.qso.col.qsos')) + '</span></div>' +
            '</div>';
    }).join('') + '<div class="rows-more" hidden></div>';
    trimRows(box, {rowClass: 'seat'});
}

/**
 * 天线归属：一行一副天线，行尾列出此刻把天线切过去的席位徽章。
 * 归属来自 ownership 投影（routed_by 优先、owners 兜底），发射中的席位徽章点亮。
 */
export function renderAntennaUse(box, devices, model) {
    if (!box) return;
    const antennas = devices && devices.ownership &&
        Array.isArray(devices.ownership.antennas) ? devices.ownership.antennas : [];
    if (!antennas.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.ants.empty')) + '</div>';
        return;
    }
    const txKeys = (model && model.txKeys) || new Set();
    const keyToNo = (model && model.keyToNo) || new Map();
    const rows = antennas.map(antenna => {
        const users = [...new Set([
            ...(Array.isArray(antenna.routed_by) ? antenna.routed_by : []),
            ...(Array.isArray(antenna.owners) ? antenna.owners : [])
        ].map(key => keyToNo.get(normalizeKey(key))).filter(Boolean))].sort((a, b) => a - b);
        const transmitting = [...new Set([
            ...(Array.isArray(antenna.routed_by) ? antenna.routed_by : [])
        ].map(key => normalizeKey(key)))].some(key => txKeys.has(key));
        const bands = (Array.isArray(antenna.bands) ? antenna.bands : [])
            .map(band => String(band).toUpperCase());
        const bandKey = bands.length === 1 ? bands[0] : (bands[0] || '');
        return {
            name: String(antenna.name || antenna.id || '—'),
            users,
            transmitting,
            bandKey,
            free: !users.length
        };
    }).sort((a, b) => (a.free === b.free ? a.name.localeCompare(b.name) : (a.free ? 1 : -1)));

    box.innerHTML = rows.map(row => {
        const color = WALL_BAND_COLORS[row.bandKey] || 'rgba(122, 168, 255, .22)';
        const badges = row.users.length
            ? '<div class="ant-badges">' + row.users.map(no => seatTag(no,
                row.transmitting && txKeys.size ? ' tx' : '')).join('') + '</div>'
            : '<span class="ant-idle">' + esc(t('wall.occ.idle')) + '</span>';
        return '<div class="ant-row' + (row.free ? ' free' : '') + '" style="--c:' + color + '">' +
            '<span class="ant-name">' + esc(row.name) + '</span>' + badges + '</div>';
    }).join('') + '<div class="rows-more" hidden></div>';
    trimRows(box, {rowClass: 'ant-row'});
}

/**
 * 波段占用：一行一个波段，上面是「这个波段通了多少条 + 占比」，下面是
 * 「此刻谁在这个波段上」。波段色和席位色各管各的，互不混淆。
 */
export function renderBandOccupancy(box, rows, model, antennaBands) {
    if (!box) return;
    const byBand = new Map();
    (rows || []).forEach(row => {
        const key = String(row.band || bandOf(row.freq_khz) || '').toUpperCase() || '—';
        const entry = byBand.get(key) || {qsos: 0, seats: new Set()};
        entry.qsos += 1;
        byBand.set(key, entry);
    });
    const seats = (model && model.seats) || [];
    const txKeys = (model && model.txKeys) || new Set();
    seats.forEach(seat => {
        const key = String(seat.band || bandOf(seat.freqKhz) || '').toUpperCase();
        if (!key) return;
        if (!byBand.has(key)) byBand.set(key, {qsos: 0, seats: new Set()});
        byBand.get(key).seats.add(seat.no);
    });
    /* 天线能到但今天还没人用的波段也列出来，观众能看出这套台子在等什么。 */
    (Array.isArray(antennaBands) ? antennaBands : []).forEach(key => {
        if (!byBand.has(key)) byBand.set(key, {qsos: 0, seats: new Set()});
    });

    const total = (rows || []).length || 1;
    const order = ['160M', '80M', '60M', '40M', '30M', '20M', '17M', '15M', '12M', '10M', 'VHF'];
    const rank = key => {
        const index = order.indexOf(key);
        return index < 0 ? order.length : index;
    };
    const list = [...byBand.entries()]
        .sort((a, b) => b[1].qsos - a[1].qsos || rank(a[0]) - rank(b[0]))
        .slice(0, 11);
    if (!list.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.qso.empty')) + '</div>';
        return;
    }
    const max = Math.max(1, ...list.map(([, entry]) => entry.qsos));

    box.innerHTML = list.map(([key, entry]) => {
        const live = [...entry.seats].filter(no => {
            const seat = seats.find(item => item.no === no);
            return seat ? seat.keys.some(k => txKeys.has(k)) : false;
        });
        const classes = ['band-row'];
        if (!entry.qsos && !entry.seats.size) classes.push('silent');
        else if (live.length) classes.push('live');
        const badges = entry.seats.size
            ? [...entry.seats].sort((a, b) => a - b)
                .map(no => seatTag(no, live.includes(no) ? ' tx' : '')).join('')
            : '<span class="ant-idle">' + esc(t('wall.occ.idle')) + '</span>';
        return '<div class="' + classes.join(' ') + '" style="--c:' +
            (WALL_BAND_COLORS[key] || 'var(--accent)') + '">' +
            '<div class="band-top"><span class="band-tag">' + esc(bandLabel(key)) + '</span>' +
            '<i class="band-gauge"><i style="width:' + Math.round(entry.qsos / max * 100) +
            '%"></i></i><span class="band-count">' + entry.qsos + ' <em>' +
            esc(t('wall.qso.col.qsos')) + '</em></span></div>' +
            '<div class="band-live">' + badges + '</div></div>';
    }).join('') + '<div class="rows-more" hidden></div>';
    trimRows(box, {rowClass: 'band-row'});
}

/* 罗盘：0/90/180/270 四个主刻度加长，其余每 30° 一个短刻度，
 * 指针指向当前实际方位角，虚线是旋转器设定的目标方位角。 */
function dialSvg(azimuth, target) {
    const point = (angle, radius) => {
        const rad = (angle - 90) * Math.PI / 180;
        return [50 + radius * Math.cos(rad), 50 + radius * Math.sin(rad)];
    };
    const ticks = [];
    for (let angle = 0; angle < 360; angle += 30) {
        const [x1, y1] = point(angle, angle % 90 === 0 ? 38 : 42);
        const [x2, y2] = point(angle, 45);
        ticks.push('<line class="' + (angle % 90 === 0 ? 'maj' : 'min') + '" x1="' +
            x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) +
            '" y2="' + y2.toFixed(1) + '"/>');
    }
    const labels = [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']].map(([angle, text]) => {
        const [x, y] = point(angle, 30);
        return '<text class="cardinal" x="' + x.toFixed(1) + '" y="' + (y + 3).toFixed(1) +
            '" text-anchor="middle">' + text + '</text>';
    }).join('');
    let hands = '';
    if (isFinite(target) && target >= 0) {
        const [tx, ty] = point(target, 44);
        hands += '<line class="target" x1="50" y1="50" x2="' + tx.toFixed(1) +
            '" y2="' + ty.toFixed(1) + '" stroke-dasharray="3 3"/>';
    }
    if (isFinite(azimuth)) {
        const [nx, ny] = point(azimuth, 36);
        hands += '<line class="needle hot" x1="50" y1="50" x2="' + nx.toFixed(1) +
            '" y2="' + ny.toFixed(1) + '"/>';
    } else {
        hands += '<g class="nodata"><circle cx="50" cy="50" r="30"/></g>';
    }
    return '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring" cx="50" cy="50" r="45"/>' +
        ticks.join('') + labels + hands + '<circle class="hub" cx="50" cy="50" r="3"/></svg>';
}

/**
 * 天线指向：数据来自设备快照里的 rotators（以转子 id 为键）与 ownership 投影
 * 给每副天线算出的 actual_azimuth；只有挂了转子的天线才画罗盘。
 */
export function renderRotors(box, devices, model) {
    if (!box) return;
    const ownership = (devices && devices.ownership) || {};
    const antennas = Array.isArray(ownership.antennas) ? ownership.antennas : [];
    const rotators = devices && devices.rotators && typeof devices.rotators === 'object'
        ? devices.rotators : {};
    const ids = new Set(Object.keys(rotators));
    const keyToNo = (model && model.keyToNo) || new Map();
    const dials = antennas
        .filter(antenna => antenna && antenna.rotator_id &&
            (ids.has(String(antenna.rotator_id)) || antenna.actual_azimuth !== undefined))
        .map(antenna => {
            const rotor = rotators[String(antenna.rotator_id)] || {};
            const users = [...new Set([
                ...(Array.isArray(antenna.routed_by) ? antenna.routed_by : []),
                ...(Array.isArray(antenna.owners) ? antenna.owners : [])
            ].map(key => keyToNo.get(normalizeKey(key))).filter(Boolean))].sort((a, b) => a - b);
            const azimuth = Number(antenna.actual_azimuth);
            const target = Number(rotor.target_azimuth);
            return {
                name: String(antenna.name || antenna.rotator_id || '—'),
                seat: users.length ? users[0] : 0,
                users,
                azimuth: isFinite(azimuth) ? azimuth : null,
                target: isFinite(target) ? target : null,
                moving: String(rotor.motion_state || '') === 'moving'
            };
        })
        .sort((a, b) => (a.users.length === b.users.length
            ? a.name.localeCompare(b.name) : (b.users.length - a.users.length)));

    if (!dials.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.rotor.empty')) + '</div>';
        return;
    }
    box.innerHTML = dials.map(dial => {
        const classes = ['dial', dial.users.length ? 'used' : 'unused'];
        if (dial.azimuth === null) classes.push('nodata');
        else if (dial.moving) classes.push('moving');
        else classes.push('settled');
        const seatLabel = dial.users.length
            ? '<i class="dial-seat has-seat" style="--seat:' + seatColor(dial.seat) + '">' +
              esc(dial.users.map(no => tr('wall.rig.seatNo', 'Seat {n}', {n: no})).join(' / ')) +
              '</i>'
            : '<i class="dial-seat">' + esc(t('wall.occ.idle')) + '</i>';
        return '<div class="' + classes.join(' ') + '"' +
            (dial.seat ? ' style="--seat:' + seatColor(dial.seat) + '"' : '') + '>' +
            '<span class="dial-name">' + esc(dial.name) + '</span>' +
            dialSvg(dial.azimuth, dial.target) +
            '<b>' + (dial.azimuth === null ? '—' : Math.round(dial.azimuth) + '°') + '</b>' +
            seatLabel + '</div>';
    }).join('');
    if (box.children.length) trimRows(box, {rowClass: 'dial'});
}

export {bandOf, seatKey, seatNumber};
