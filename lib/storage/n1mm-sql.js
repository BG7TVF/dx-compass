'use strict';

const {esc, num} = require('./sql.js');

/**
 * N1MM 状态落库：电台状态与分数快照。
 * QSO 本身仍写 qsos 表；这里只补规则引擎需要的“当前 VFO / RUN-S&P / 分数”。
 */
const CREATE_STATION_STATE = `CREATE TABLE IF NOT EXISTS station_state (
    radio_nr TEXT PRIMARY KEY,
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

function createN1mm() {
    return [CREATE_STATION_STATE, CREATE_SCORE_STATE];
}

function radioUpsert(radio) {
    const r = radio || {};
    const key = r.radioNr || '1';
    return 'INSERT OR REPLACE INTO station_state (radio_nr, ts, freq_khz, tx_freq_khz, mode, ' +
        'is_running, is_transmitting, is_split, op_call, radio_name, station_name) VALUES (' +
        esc(key) + ', ' + esc(r.ts) + ', ' + num(r.freqKhz) + ', ' + num(r.txFreqKhz) + ', ' +
        esc(r.mode) + ', ' + (r.isRunning ? 1 : 0) + ', ' + (r.isTransmitting ? 1 : 0) + ', ' +
        (r.isSplit ? 1 : 0) + ', ' + esc(r.opCall) + ', ' + esc(r.radioName) + ', ' +
        esc(r.stationName) + ');';
}

function scoreUpsert(score) {
    const s = score || {};
    return 'INSERT OR REPLACE INTO score_state (id, ts, contest, qsos, mults, points, score) VALUES (' +
        "'live', " + esc(s.ts) + ', ' + esc(s.contest) + ', ' + (parseInt(s.qsos, 10) || 0) + ', ' +
        num(s.mults) + ', ' + num(s.points) + ', ' + num(s.score) + ');';
}

/** 启动时把上次的电台/分数状态取回来；UDP 恢复前规则引擎也有 VFO。 */
function stateQuery() {
    return "SELECT 'radio' AS kind, radio_nr AS id, ts, freq_khz, tx_freq_khz, mode, is_running, " +
        'is_transmitting, is_split, op_call, radio_name, station_name, ' +
        'NULL AS contest, NULL AS qsos, NULL AS mults, NULL AS points, NULL AS score FROM station_state ' +
        "UNION ALL SELECT 'score', 'live', ts, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, " +
        'contest, qsos, mults, points, score FROM score_state;';
}

module.exports = {
    CREATE_STATION_STATE,
    CREATE_SCORE_STATE,
    createN1mm,
    radioUpsert,
    scoreUpsert,
    stateQuery
};
