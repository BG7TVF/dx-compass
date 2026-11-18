/**
 * 频率联动（band link）：电台换到新频段时，天线跟着换过去。
 *
 * 切换动作不另立口径——最终仍走 commands.js 的 route 指令，
 * 占用判定、TX 互锁、逐跳下发、审计流水与操作员手动点天线按钮完全一致。
 * 本模块只多做一件事：替人决定“切到哪一副天线”。
 *
 * 选择顺序（同一频段有多副可选天线时）：
 *   1. 只挑单频段天线——这副天线就是为这段频率架的；
 *   2. 没有单频段天线，或多副单频段天线同时覆盖这段频率，取“优先天线”
 *      （天线属性里的开关，落库为 config.preferred）；
 *   3. 仍然裁定不出来就不动手，把原因写进状态给界面看，绝不猜。
 * 目标频段的天线正被别的席位接通时同样不动：联动不抢占。
 *
 * 开关状态存在 Node-RED global 的 bandLink 键（settings.js 里 global 走
 * localfilesystem 持久化），重启不丢，也不会被某一个浏览器独占。
 */

const STATE_KEY = 'bandLink';
const MAX_SEAT = 64;
const SEAT_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;

/** 正在发射导致下发被挡时，隔这么久重试一次，最多这么多次后放弃。 */
const TX_RETRY_DELAY_MS = 10000;
const TX_RETRY_LIMIT = 5;

/** 判定结论，界面按这些键出文案（public/js/i18n.js 的 op.station.linkReason.*）。 */
const REASONS = {
    NO_BAND: 'no-band',
    NO_ANTENNA: 'no-antenna',
    ALREADY: 'already',
    OCCUPIED: 'occupied',
    SINGLE: 'single-band',
    ONLY: 'only',
    PREFERRED: 'preferred',
    AMBIGUOUS: 'ambiguous',
    TX_ACTIVE: 'tx-active',
    FAILED: 'route-failed'
};

function normalizeSeat(value) {
    const seat = String(value === undefined || value === null ? '' : value).trim().slice(0, MAX_SEAT);
    return SEAT_PATTERN.test(seat) ? seat : '';
}

function toMs(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value === undefined || value === null ? '' : value));
    return Number.isFinite(parsed) ? parsed : null;
}

function emptyState() {
    return {version: 1, seats: {}};
}

function text(value, max) {
    return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

/** 外部塞进 global 的数据一律重洗一遍：键名、类型、长度都按本模块的口径来。 */
function sanitizeState(raw) {
    const state = emptyState();
    const seats = raw && typeof raw === 'object' && raw.seats && typeof raw.seats === 'object'
        ? raw.seats : null;
    if (!seats) return state;
    for (const key of Object.keys(seats)) {
        const seat = normalizeSeat(key);
        if (!seat) continue;
        const entry = seats[key] && typeof seats[key] === 'object' ? seats[key] : {};
        const clean = {enabled: entry.enabled === true};
        const operator = text(entry.operator, 40);
        if (operator) clean.operator = operator;
        const updated = text(entry.updated_ts, 40);
        if (updated) clean.updated_ts = updated;
        const seenBand = text(entry.seen_band, 8).toLowerCase();
        if (seenBand) clean.seen_band = seenBand;
        if (entry.last && typeof entry.last === 'object') clean.last = sanitizeLast(entry.last);
        if (entry.pending && typeof entry.pending === 'object') {
            const pending = sanitizePending(entry.pending);
            if (pending) clean.pending = pending;
        }
        state.seats[seat] = clean;
    }
    return state;
}

function sanitizeLast(raw) {
    const out = {};
    const ts = text(raw.ts, 40);
    if (ts) out.ts = ts;
    const band = text(raw.band, 8).toLowerCase();
    if (band) out.band = band;
    const from = text(raw.from, 8).toLowerCase();
    if (from) out.from = from;
    const antennaId = text(raw.antenna_id, MAX_SEAT);
    if (antennaId) out.antenna_id = antennaId;
    const antennaName = text(raw.antenna_name, 60);
    if (antennaName) out.antenna_name = antennaName;
    const reason = text(raw.reason, 24);
    if (reason) out.reason = reason;
    const status = Number(raw.status);
    if (Number.isFinite(status)) out.status = status;
    const error = text(raw.error, 48);
    if (error) out.error = error;
    return out;
}

function sanitizePending(raw) {
    const band = text(raw.band, 8).toLowerCase();
    const antennaId = text(raw.antenna_id, MAX_SEAT);
    if (!band || !antennaId) return null;
    const attempts = Math.max(0, Math.min(99, Number(raw.attempts) || 0));
    const nextMs = toMs(raw.next_ms);
    return {
        band,
        antenna_id: antennaId,
        antenna_name: text(raw.antenna_name, 60),
        attempts,
        next_ms: nextMs === null ? 0 : nextMs
    };
}

function readState(global) {
    const raw = global && typeof global.get === 'function' ? global.get(STATE_KEY) : null;
    return sanitizeState(raw);
}

function writeState(global, state) {
    if (!global || typeof global.set !== 'function') return state;
    global.set(STATE_KEY, state);
    return state;
}

/** 快照里给界面的形态：只交代开关与最近一次判定，判定细节留在服务端。 */
function view(global) {
    const state = readState(global);
    const seats = {};
    for (const seat of Object.keys(state.seats)) {
        const entry = state.seats[seat];
        seats[seat] = {
            enabled: entry.enabled === true,
            operator: entry.operator || '',
            updated_ts: entry.updated_ts || null,
            last: entry.last || null
        };
    }
    return {retry_delay_ms: TX_RETRY_DELAY_MS, retry_limit: TX_RETRY_LIMIT, seats};
}

function anyEnabled(state) {
    const seats = state && state.seats ? state.seats : {};
    return Object.keys(seats).some(seat => seats[seat] && seats[seat].enabled === true);
}

/**
 * 打开/关闭某个席位的频率联动。
 * 打开时清掉“上次见过的频段”，下一个轮询就按当前频段判一次——
 * 开关不是只对未来生效的暗桩，按下即生效，结果直接写在 last 里。
 */
function setEnabled(global, options) {
    const opts = options || {};
    const at = opts.now instanceof Date ? opts.now : new Date(toMs(opts.now) === null ? Date.now() : toMs(opts.now));
    const seat = normalizeSeat(opts.seat);
    if (!seat) return {ok: false, status: 400, error: 'seat-required'};
    const state = readState(global);
    const entry = state.seats[seat] || {};
    entry.enabled = opts.enabled === true;
    const operator = text(opts.operator, 40);
    if (operator) entry.operator = operator;
    entry.updated_ts = at.toISOString();
    delete entry.seen_band;
    delete entry.pending;
    state.seats[seat] = entry;
    writeState(global, state);
    return {ok: true, status: 200, seat, enabled: entry.enabled, entry};
}

function briefs(list) {
    return (list || []).map(item => ({
        id: String(item.id),
        name: item.name || '',
        bands: (item.bands || []).map(String),
        preferred: item.preferred === true,
        owners: (item.routed_by || []).map(String)
    }));
}

function byId(items) {
    return items.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * 纯判定：该切到哪一副天线。
 *
 * input = {seat, band, antennas:[{id,name,bands,preferred,routed_by}], reachable:[id...]|null}
 *   reachable 为该席位物理可达的天线（天线切换容器里能点的那些）；
 *   传 null 表示拓扑给不出结论，此时不参与筛选，由调用方自行决定是否下发。
 * 返回 {antenna_id, reason, candidates}；antenna_id 为 null 表示本轮不动。
 */
function pickAntenna(input) {
    const opts = input || {};
    const seat = normalizeSeat(opts.seat);
    const band = text(opts.band, 8).toLowerCase();
    const antennas = Array.isArray(opts.antennas) ? opts.antennas.filter(item => item && item.id) : [];
    const reachable = Array.isArray(opts.reachable)
        ? opts.reachable.map(item => String(item)) : null;
    const noAction = (reason, list) => ({antenna_id: null, reason, candidates: briefs(list || [])});

    if (!band) return noAction(REASONS.NO_BAND);
    const pool = antennas.filter(item => {
        const bands = (item.bands || []).map(value => String(value).toLowerCase());
        if (!bands.includes(band)) return false;
        return !reachable || reachable.includes(String(item.id));
    });
    if (!pool.length) return noAction(REASONS.NO_ANTENNA, pool);

    // 已经接在本频段的天线上：不重复下发，也不许换到另一副等价天线上去。
    const mine = pool.filter(item => (item.routed_by || []).map(String).includes(seat));
    if (mine.length) {
        const chosen = byId(mine)[0];
        return {antenna_id: String(chosen.id), reason: REASONS.ALREADY, candidates: briefs(pool)};
    }

    // 联动不抢占：本频段的天线全被别的席位接通着就等着。
    const free = pool.filter(item => !(item.routed_by || []).length);
    if (!free.length) return noAction(REASONS.OCCUPIED, pool);

    const single = free.filter(item => (item.bands || []).length === 1);
    const chosen = byId(single.length ? single : free);
    if (chosen.length === 1) {
        return {
            antenna_id: String(chosen[0].id),
            reason: single.length ? REASONS.SINGLE : REASONS.ONLY,
            candidates: briefs(chosen)
        };
    }

    const preferred = byId(chosen.filter(item => item.preferred === true));
    if (preferred.length === 1) {
        return {
            antenna_id: String(preferred[0].id),
            reason: REASONS.PREFERRED,
            candidates: briefs(preferred)
        };
    }
    return noAction(REASONS.AMBIGUOUS, chosen);
}

/**
 * 轮询一轮：比较各席位当前频段与上次判定的频段，必要时下发 route。
 *
 * input = {
 *   now, state, seats:[{seat, band, online, operator, reachable}], antennas,
 *   route: async ({seat, operator, antenna_id}) => commands.execute 的返回
 * }
 * 返回 {actions, sql, broadcasts, state}；state 就地更新后由调用方落回 global。
 */
async function tick(input) {
    const opts = input || {};
    const at = opts.now instanceof Date ? opts.now : new Date(toMs(opts.now) === null ? Date.now() : toMs(opts.now));
    const state = opts.state || readState(opts.global);
    const seats = Array.isArray(opts.seats) ? opts.seats : [];
    const antennas = Array.isArray(opts.antennas) ? opts.antennas : [];
    const route = typeof opts.route === 'function' ? opts.route : null;
    const result = {actions: [], sql: [], broadcasts: [], state};

    for (const seat of seats) {
        const key = normalizeSeat(seat && seat.seat);
        const entry = key ? state.seats[key] : null;
        if (!entry || entry.enabled !== true) continue;
        const band = text(seat.band, 8).toLowerCase();
        if (!band) continue;
        if (seat.online !== true) continue;

        // 上一次被“正在发射”挡住：到点重试，重试次数用完就明确放弃。
        if (entry.pending && entry.pending.band === band) {
            if (toMs(entry.pending.next_ms) > at.getTime()) continue;
            if (entry.pending.attempts >= TX_RETRY_LIMIT) {
                const gaveUp = entry.pending;
                const from = entry.seen_band || '';
                delete entry.pending;
                entry.seen_band = band;
                entry.last = {
                    ts: at.toISOString(), band, from, reason: REASONS.TX_ACTIVE,
                    antenna_id: gaveUp.antenna_id,
                    antenna_name: gaveUp.antenna_name,
                    status: 423, error: REASONS.TX_ACTIVE
                };
                result.actions.push({seat: key, from, band, reason: REASONS.TX_ACTIVE,
                    antenna_id: gaveUp.antenna_id, status: 423, error: REASONS.TX_ACTIVE,
                    executed: false, retry: true, attempts: gaveUp.attempts});
                continue;
            }
            await dispatch({result, entry, route, at, seat: key, band,
                antenna: {id: entry.pending.antenna_id, name: entry.pending.antenna_name},
                reason: entry.pending.reason || REASONS.TX_ACTIVE, retry: true});
            continue;
        }
        if (entry.pending) delete entry.pending;
        if (entry.seen_band === band) continue;

        const from = entry.seen_band || '';
        const pick = pickAntenna({
            seat: key, band, antennas,
            reachable: Array.isArray(seat.reachable) ? seat.reachable : null
        });
        entry.seen_band = band;
        const target = pick.antenna_id
            ? antennas.find(item => String(item.id) === String(pick.antenna_id)) || null
            : null;
        if (!pick.antenna_id || pick.reason === REASONS.ALREADY) {
            entry.last = {
                ts: at.toISOString(), band, from,
                antenna_id: pick.antenna_id || '',
                antenna_name: target ? (target.name || '') : '',
                reason: pick.reason, status: null, error: ''
            };
            result.actions.push({
                seat: key, from, band, reason: pick.reason,
                antenna_id: pick.antenna_id || null, status: null, error: '', executed: false
            });
            continue;
        }
        await dispatch({result, entry, route, at, seat: key, band, from,
            antenna: target || {id: pick.antenna_id, name: ''}, reason: pick.reason, retry: false});
    }
    return result;
}

/** 下发一次 route，并按返回码决定是记账、重试还是放弃。 */
async function dispatch(context) {
    const {result, entry, route, at, seat, band, from, antenna, reason, retry} = context;
    const antennaId = antenna ? String(antenna.id) : '';
    const antennaName = antenna ? (antenna.name || '') : '';
    const base = {ts: at.toISOString(), band, from: from || '', antenna_id: antennaId,
        antenna_name: antennaName, reason};
    if (!route || !antennaId) {
        delete entry.pending;
        entry.last = Object.assign({}, base, {reason: REASONS.NO_ANTENNA, status: null, error: ''});
        result.actions.push({seat, from: from || '', band, reason: REASONS.NO_ANTENNA,
            antenna_id: null, status: null, error: '', executed: false});
        return;
    }
    let response = null;
    let thrown = '';
    try {
        response = await route({seat, operator: entry.operator || '', antenna_id: antennaId});
    } catch (error) {
        thrown = (error && error.message) || String(error || 'route-threw');
    }
    const status = response ? Number(response.status) : 0;
    const payload = (response && response.payload) || {};
    const error = thrown || String(payload.error || '');
    if (response && response.sql) result.sql.push.apply(result.sql, response.sql);
    if (response && response.broadcast) result.broadcasts.push(response.broadcast);

    if (status === 423) {
        // 正在发射：天线不动，等 QRT。留待重试，界面同时能看到原因。
        const attempts = (entry.pending ? Number(entry.pending.attempts) || 0 : 0) + 1;
        entry.pending = {band, antenna_id: antennaId, antenna_name: antennaName,
            attempts, next_ms: at.getTime() + TX_RETRY_DELAY_MS, reason};
        entry.seen_band = band;
        entry.last = Object.assign({}, base, {reason: REASONS.TX_ACTIVE, status, error});
        result.actions.push({seat, from: from || '', band, reason: REASONS.TX_ACTIVE,
            antenna_id: antennaId, status, error, executed: true, retry, attempts});
        return;
    }
    delete entry.pending;
    const ok = payload.ok === true;
    entry.last = Object.assign({}, base, {
        reason: ok ? reason : REASONS.FAILED, status, error: ok ? '' : error
    });
    result.actions.push({seat, from: from || '', band, reason: ok ? reason : REASONS.FAILED,
        antenna_id: antennaId, status, error: ok ? '' : error, executed: true, retry});
}

module.exports = {
    STATE_KEY,
    SEAT_PATTERN,
    TX_RETRY_DELAY_MS,
    TX_RETRY_LIMIT,
    REASONS,
    normalizeSeat,
    emptyState,
    sanitizeState,
    readState,
    writeState,
    view,
    anyEnabled,
    setEnabled,
    pickAntenna,
    tick
};
