'use strict';

/**
 * QRZ 查询结果表。一场比赛里同一个呼号会在不同波段反复出现，而 QRZ 上的
 * 国家、网格、经纬度跟波段无关，查一次就够。内存缓存进程一重启就丢，
 * 落库之后重启也能接着复用，不再重复消耗 QRZ 调用量。
 */

const {esc, num} = require('./sql.js');

const CREATE_QRZ_CALLS = `CREATE TABLE IF NOT EXISTS qrz_calls (
    call TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    name TEXT,
    fname TEXT,
    aliases TEXT,
    country TEXT,
    grid TEXT,
    dxcc TEXT,
    cqzone TEXT,
    ituzone TEXT,
    class TEXT,
    qslmgr TEXT,
    lat REAL,
    lon REAL,
    error TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
);`;

const CREATE_QRZ_INDEX = 'CREATE INDEX IF NOT EXISTS idx_qrz_calls_seen ON qrz_calls(last_seen);';

const COLUMNS = ['call', 'status', 'name', 'fname', 'aliases', 'country', 'grid', 'dxcc',
    'cqzone', 'ituzone', 'class', 'qslmgr', 'lat', 'lon', 'error'];

function create() {
    return [CREATE_QRZ_CALLS, CREATE_QRZ_INDEX];
}

function text(value) {
    if (value === null || value === undefined) return null;
    const out = String(value).trim();
    return out === '' ? null : out;
}

/**
 * 一个呼号只留最新结论。只写明确的 found / not-found，
 * 会话或网络错误不入库，下次照常重试；first_seen 保留首次查到的时间。
 * 呼号统一大写，否则 N1MM 与 QRZ 的大小写差异会把同一个台写成两行。
 */
function upsert(call, result, at) {
    const key = text(call);
    if (!key) return null;
    const status = result && result.status;
    if (status !== 'found' && status !== 'not-found') return null;
    const cs = (status === 'found' && result.callsign) || {};
    const stamp = text(at) || new Date().toISOString();
    const values = [
        esc(key.toUpperCase()), esc(status), esc(text(cs.name)), esc(text(cs.fname)),
        esc(text(cs.aliases)), esc(text(cs.country)), esc(text(cs.grid)),
        esc(text(cs.dxcc)), esc(text(cs.cqzone)), esc(text(cs.ituzone)),
        esc(text(cs.class)), esc(text(cs.qslmgr)),
        num(parseFloat(cs.lat)), num(parseFloat(cs.lon)), esc(text(result.error))
    ];
    const updates = COLUMNS.slice(1).map(column => column + ' = excluded.' + column).join(', ');
    return 'INSERT INTO qrz_calls (' + COLUMNS.join(', ') + ', first_seen, last_seen) VALUES (' +
        values.join(', ') + ', ' + esc(stamp) + ', ' + esc(stamp) + ') ' +
        'ON CONFLICT(call) DO UPDATE SET ' + updates +
        ', first_seen = qrz_calls.first_seen, last_seen = excluded.last_seen;';
}

/** 启动回填：把最近的结论读回内存缓存，过期与否由缓存侧判断。 */
function recentQuery(limit) {
    const count = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 50000);
    return 'SELECT * FROM qrz_calls ORDER BY last_seen DESC LIMIT ' + count + ';';
}

module.exports = {COLUMNS, create, upsert, recentQuery};
