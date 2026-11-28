/* 设备动态：席位铭牌、天线归属、波段占用、天线指向。
 *
 * 这一栏只回答观众的一个问题——「此刻这套台子正在怎么打」。
 * 所有涉及席位的颜色都来自 wall-cards 的 SEAT_COLORS：同一个席位在席位卡、
 * 天线徽章、波段徽章、QSO 流水和地图连线上永远是同一个颜色。这里不存在
 * 「本席 / 他席」的区分，观众墙没有“我”的视角。 */

import {bandOf, normalizeBand, seatColor, seatMark, tr, trimRows} from './wall-cards.mjs';
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
                /* lastHour 是该席位最近 60 分钟内的 QSO 条数，口径与头栏 KPI 的
                 * 「速率」完全一致，席位行里直接读得出「这位现在打得快不快」。 */
                isTransmitting: false, qsos: 0, points: 0, mults: 0, lastHour: 0
            });
        }
        return byNo.get(no);
    };

    planSeats.forEach(seat => {
        const no = seatNumber(seat && seat.no);
        if (!no) return;
        const entry = ensure(no);
        entry.online = !!seat.online;
        entry.band = normalizeBand(seat.band);
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
    const hourAgo = Date.now() - 60 * 60 * 1000;
    (rows || []).forEach(row => {
        const seat = seatOfRow(row);
        if (!seat) return;
        const entry = byNo.get(seat.no);
        if (!entry) return;
        entry.qsos += 1;
        entry.points += Number(row.points) || 0;
        if (row.is_mult) entry.mults += 1;
        const time = new Date(row.timestamp).getTime();
        if (isFinite(time) && time > hourAgo) entry.lastHour += 1;
    });

    return {seats: list, seatOfRow, keyToNo, txKeys, byNo};
}

/**
 * 席位徽章：天线归属、波段占用、通联时段都用它。
 * 身份是「色点 + 形状」双编码——8 色色板撑不住纯颜色串联，形状才是主线索。
 * 徽章在 flex 容器里整体换行，形状加宽只会让徽章折到下一行，不会裁字。
 */
function seatTag(no, extra) {
    if (!no) return '';
    return '<span class="seat-badge' + (extra || '') + '" style="--seat:' + seatColor(no) +
        '">' + seatMark(no) + esc(tr('wall.rig.seatNo', 'Seat {n}', {n: no})) + '</span>';
}

/**
 * 席位铭牌就是这一栏的主角：色条 + 形状 + 「席位 N」 + 当前操作员呼号 +
 * 频率/模式/波段，右侧再挂这一席自己的四个短读数（QSO 数 / 分数 / 倍率 /
 * 速率）。原先单独一张「各操作员」卡把呼号和条数重复了一遍，合并后删掉。
 * 没人打的席位仍然占一行（压暗），观众能看出这套台子有几台机器在闲着。
 *
 * 宽度只有换行和整行删除两种解法：中间文字列允许折行，右侧读数排成 2×2，
 * 纵向真放不下时交给 trimRows 整行删掉并在末尾标 +N。
 */
export function renderSeatRoster(box, model) {
    if (!box) return;
    const seats = (model && model.seats) || [];
    if (!seats.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.empty.waitingStation')) + '</div>';
        return;
    }
    /* 四个标签都压在两三个字，2×2 才站得稳。分数是这一席自己的累计分，
     * 不能借头栏「总分」那个键，所以走 tr 的中文兜底。 */
    const statLabels = [
        ['qsos', t('wall.qso.col.qsos')],
        ['points', tr('wall.rig.seatPoints', '分数')],
        ['mults', t('wall.kpi.mults')],
        ['rate', t('wall.kpi.rate')]
    ];
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
            bandLabel(normalizeBand(seat.band, seat.freqKhz) || '')
        ].join(' · ');
        const stats = statLabels.map(([field, label]) =>
            '<span class="ss s-' + field + '"><b>' + Number(seat[field] || 0) +
            '</b><i>' + esc(label) + '</i></span>').join('');
        return '<div class="' + classes.join(' ') + '" style="--seat:' + seat.color + '">' +
            '<div class="seat-marks"><i class="seat-dot"></i>' + seatMark(seat.no) + '</div>' +
            '<div class="seat-text"><b><i>' + esc(tr('wall.rig.seatNo', 'Seat {n}', {n: seat.no})) +
            '</i>' + operator + '</b><span>' + esc(details) + '</span></div>' +
            '<div class="seat-stats">' + stats + '</div>' +
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
        /* 行首那根竖条是「波段」语义，走 WALL_BAND_COLORS，本阶段有意保留：
         * 全墙色相预算只有三类——席位身份 = SEAT_COLORS 的色 + 形（下面的席位
         * 徽章属于这一类）、波段 = 天线归属行首竖条与波段徽章、传播好坏 =
         * --good/--fair/--poor。KPI 数字与波段占用条都不再参与用色。 */
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
 *
 * 天线能到但今天完全没动静的波段不再逐行占位，统一折叠成末尾一行摘要：
 * 逐行只留「通过客」和「此刻有人守着的」，省下来的高度全给有内容的行。
 */
export function renderBandOccupancy(box, rows, model, antennaBands) {
    if (!box) return;
    const byBand = new Map();
    (rows || []).forEach(row => {
        const key = normalizeBand(row.band, row.freq_khz) || '—';
        const entry = byBand.get(key) || {qsos: 0, seats: new Set()};
        entry.qsos += 1;
        byBand.set(key, entry);
    });
    const seats = (model && model.seats) || [];
    const txKeys = (model && model.txKeys) || new Set();
    seats.forEach(seat => {
        const key = normalizeBand(seat.band, seat.freqKhz);
        if (!key) return;
        if (!byBand.has(key)) byBand.set(key, {qsos: 0, seats: new Set()});
        byBand.get(key).seats.add(seat.no);
    });
    /* 天线覆盖但既没通过也没人守着的波段，只进末尾那一行摘要。 */
    (Array.isArray(antennaBands) ? antennaBands : []).forEach(key => {
        if (!byBand.has(key)) byBand.set(key, {qsos: 0, seats: new Set()});
    });

    const order = ['160M', '80M', '60M', '40M', '30M', '20M', '17M', '15M', '12M', '10M', 'VHF'];
    const rank = key => {
        const index = order.indexOf(key);
        return index < 0 ? order.length : index;
    };
    const sorted = [...byBand.entries()]
        .sort((a, b) => b[1].qsos - a[1].qsos || rank(a[0]) - rank(b[0]));
    const isLive = ([, entry]) => entry.qsos > 0 || entry.seats.size > 0;
    /* 有内容的行不做条数上限：纵向本来就有 trimRows 整行删除并标 +N 兜底，
     * 再截一刀就会无声丢掉一个真在用的波段。 */
    const list = sorted.filter(isLive);
    /* 静默波段按波段表顺序念出来，观众听着像「还留着哪些频段没开胡」。 */
    const silent = sorted.filter(entry => !isLive(entry)).sort((a, b) => rank(a[0]) - rank(b[0]));
    if (!list.length) {
        box.innerHTML = '<div class="opp-empty">' + esc(t('wall.qso.empty')) + '</div>';
        return;
    }
    const max = Math.max(1, ...list.map(([, entry]) => entry.qsos));

    /* 全部波段都通过时不要这行摘要。 */
    let silentLine = '';
    if (silent.length) {
        const params = {
            n: silent.length,
            bands: silent.map(([key]) => esc(bandLabel(key))).join('、')
        };
        /* 键不在 11 语种字典里时 tr 只给中文兜底，占位符得自己填。 */
        const text = tr('wall.band.silentMore', '另有 {n} 个波段今天未通：{bands}', params)
            .replace(/\{n\}/g, () => params.n)
            .replace(/\{bands\}/g, () => params.bands);
        silentLine = '<div class="band-silent">' + text + '</div>';
    }

    box.innerHTML = list.map(([key, entry]) => {
        const live = [...entry.seats].filter(no => {
            const seat = seats.find(item => item.no === no);
            return seat ? seat.keys.some(k => txKeys.has(k)) : false;
        });
        const classes = ['band-row'];
        if (live.length) classes.push('live');
        const badges = entry.seats.size
            ? [...entry.seats].sort((a, b) => a - b)
                .map(no => seatTag(no, live.includes(no) ? ' tx' : '')).join('')
            : '<span class="ant-idle">' + esc(t('wall.occ.idle')) + '</span>';
        /* 波段行不再挂 --c 波段色：波段身份由「波段名文字 + 固定排序」表达，
         * 颜色变量在这里已经没有任何消费者（见 bigscreen.css .band-tag/.band-gauge）。 */
        return '<div class="' + classes.join(' ') + '">' +
            '<div class="band-top"><span class="band-tag">' + esc(bandLabel(key)) + '</span>' +
            '<i class="band-gauge"><i style="width:' + Math.round(entry.qsos / max * 100) +
            '%"></i></i><span class="band-count">' + entry.qsos + ' <em>' +
            esc(t('wall.qso.col.qsos')) + '</em></span></div>' +
            '<div class="band-live">' + badges + '</div></div>';
    }).join('') + silentLine + '<div class="rows-more" hidden></div>';
    trimRows(box, {rowClass: 'band-row'});
    /* trimRows 只认 .band-row，摘要行得自己兜底：连这一行都塞不下就整行删，
     * 宁可少一句说明，也不能出现半句话。 */
    const note = box.querySelector('.band-silent');
    if (note && box.scrollHeight > box.clientHeight + 1) note.remove();
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

/* 中文八方位词：把圆周分成八个 45° 扇区，第 i 格覆盖 [i*45-22.5, i*45+22.5)，
 * 语义是「从本站大圆初始方位角看过去，正前方对着哪个方向」——观众不用自己
 * 心算 315° 是不是西北。方位词复用字典里现成的 wall.dir.* 键（对手卡罗盘
 * 同款，11 语种齐全），tr 的中文串只是兜底。每个方位再配一行大致目标区：
 * 措辞刻意保留余地（列的是「这个方向上常见的地区」，不断言对手就在那里）。 */
const COMPASS8 = [
    ['n', '北', 'wall.rotor.region.n', '中亚 · 俄罗斯南部'],
    ['ne', '东北', 'wall.rotor.region.ne', '日本 · 堪察加'],
    ['e', '东', 'wall.rotor.region.e', '北美西海岸 · 太平洋'],
    ['se', '东南', 'wall.rotor.region.se', '东南亚 · 大洋洲'],
    ['s', '南', 'wall.rotor.region.s', '印度洋 · 南极传播'],
    ['sw', '西南', 'wall.rotor.region.sw', '南亚 · 东非'],
    ['w', '西', 'wall.rotor.region.w', '中东 · 非洲'],
    ['nw', '西北', 'wall.rotor.region.nw', '欧洲 · 独联体']
];

/** 方位角（度）→ {word 八方位词, region 大致目标区}；无有效方位角返回 null。 */
function compass8Of(azimuth) {
    if (azimuth === null || !isFinite(azimuth)) return null;
    const entry = COMPASS8[Math.round((((azimuth % 360) + 360) % 360) / 45) % 8];
    return {word: tr('wall.dir.' + entry[0], entry[1]), region: tr(entry[2], entry[3])};
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
              /* 一根天线可能被多个席位共用，形状与颜色都只标主用的那一席。 */
              seatMark(dial.seat || dial.users[0]) +
              esc(dial.users.map(no => tr('wall.rig.seatNo', 'Seat {n}', {n: no})).join(' / ')) +
              '</i>'
            : '<i class="dial-seat">' + esc(t('wall.occ.idle')) + '</i>';
        const compassInfo = compass8Of(dial.azimuth);
        return '<div class="' + classes.join(' ') + '"' +
            (dial.seat ? ' style="--seat:' + seatColor(dial.seat) + '"' : '') + '>' +
            '<span class="dial-name">' + esc(dial.name) + '</span>' +
            dialSvg(dial.azimuth, dial.target) +
            /* 主读数从裸角度改成「八方位词 + 度数」：观众看到「西北 315°」
             * 立刻知道天线对着哪边；没有方位角时保持破折号。 */
            '<b>' + (compassInfo
                ? compassInfo.word + ' ' + Math.round(dial.azimuth) + '°'
                : '—') + '</b>' +
            /* 副标注：该方向上常见的通联目标区（压暗小字，整行可换行）。 */
            (compassInfo
                ? '<span class="dial-region">' + esc(compassInfo.region) + '</span>'
                : '') +
            seatLabel + '</div>';
    }).join('');
    if (box.children.length) trimRows(box, {rowClass: 'dial'});
}

export {bandOf, seatKey, seatNumber};
