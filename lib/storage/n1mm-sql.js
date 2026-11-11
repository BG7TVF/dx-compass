'use strict';

const {esc, num} = require('./sql.js');

/**
 * N1MM 状态落库：电台状态、分数快照与操作员轮换。
 * QSO 本身仍写 qsos 表；这里只补规则引擎需要的“当前 VFO / RUN-S&P / 分数”。
 *
 * 电台状态以 seat（station + radio）为主键：MM 的多台实例通常都报 RadioNr=1，
 * 只用 radioNr 会互相覆盖。
 */
const CREATE_RADIO_STATE = `CREATE TABLE IF NOT EXISTS radio_state (
    seat TEXT PRIMARY KEY,
    radio_nr TEXT,
    instance TEXT,
    ts TEXT NOT NULL,
    freq_khz REAL,
    tx_freq_khz REAL,
    mode TEXT,
    is_running INTEGER NOT NULL DEFAULT 0,
    is_transmitting INTEGER NOT NULL DEFAULT 0,
    is_split INTEGER NOT NULL DEFAULT 0,
    op_call TEXT,
    radio_name TEXT,
    station_name TEXT
);`;

const CREATE_SCORE_STATE = `CREATE TABLE IF NOT EXISTS score_state (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    contest TEXT,
    qsos INTEGER NOT NULL DEFAULT 0,
    mults INTEGER,
    points INTEGER,
    score REAL
);`;

/** 操作员轮换：append-only，最新一行即当前操作员。 */
const CREATE_OPERATOR_SESSIONS = `CREATE TABLE IF NOT EXISTS operator_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seat TEXT NOT NULL,
    operator TEXT,
    radio_nr TEXT,
    start_ts TEXT NOT NULL
);`;

function createN1mm() {
    return [CREATE_RADIO_STATE, CREATE_SCORE_STATE, CREATE_OPERATOR_SESSIONS];
}

function radioUpsert(radio) {
    const r = radio || {};
    const key = r.seat || r.radioNr || 'LOCAL:1';
    return 'INSERT OR REPLACE INTO radio_state (seat, radio_nr, instance, ts, freq_khz, tx_freq_khz, ' +
        'mode, is_running, is_transmitting, is_split, op_call, radio_name, station_name) VALUES (' +
        esc(key) + ', ' + esc(r.radioNr) + ', ' + esc(r.instance) + ', ' + esc(r.ts) + ', ' +
        num(r.freqKhz) + ', ' + num(r.txFreqKhz) + ', ' + esc(r.mode) + ', ' +
        (r.isRunning ? 1 : 0) + ', ' + (r.isTransmitting ? 1 : 0) + ', ' +
        (r.isSplit ? 1 : 0) + ', ' + esc(r.opCall) + ', ' + esc(r.radioName) + ', ' +
        esc(r.stationName) + ');';
}

/**
 * 只有 OpCall 真正变化（saveRadio 标记 operatorChangedAt）时才写一行；
 * 每条 RadioInfo 都写会瞬间灌满 sessions 表。
 */
function sessionInsert(radio) {
    const r = radio || {};
    if (!r.operatorChangedAt || r.operatorChangedAt !== r.ts) return null;
    return 'INSERT INTO operator_sessions (seat, operator, radio_nr, start_ts) VALUES (' +
        esc(r.seat) + ', ' + esc(r.opCall) + ', ' + esc(r.radioNr) + ', ' + esc(r.ts) + ');';
}

function scoreUpsert(score) {
    const s = score || {};
    return 'INSERT OR REPLACE INTO score_state (id, ts, contest, qsos, mults, points, score) VALUES (' +
        "'live', " + esc(s.ts) + ', ' + esc(s.contest) + ', ' + (parseInt(s.qsos, 10) || 0) + ', ' +
        num(s.mults) + ', ' + num(s.points) + ', ' + num(s.score) + ');';
}

/** 启动时把上次的电台/分数状态取回来；UDP 恢复前规则引擎也有 VFO。 */
function stateQuery() {
    return "SELECT 'radio' AS kind, seat AS id, radio_nr, instance, ts, freq_khz, tx_freq_khz, mode, " +
        'is_running, is_transmitting, is_split, op_call, radio_name, station_name, ' +
        'NULL AS contest, NULL AS qsos, NULL AS mults, NULL AS points, NULL AS score FROM radio_state ' +
        "UNION ALL SELECT 'score', 'live', NULL, NULL, ts, NULL, NULL, NULL, NULL, NULL, NULL, NULL, " +
        'NULL, NULL, contest, qsos, mults, points, score FROM score_state;';
}

module.exports = {
    CREATE_RADIO_STATE,
    CREATE_SCORE_STATE,
    CREATE_OPERATOR_SESSIONS,
    createN1mm,
    radioUpsert,
    sessionInsert,
    scoreUpsert,
    stateQuery
};
