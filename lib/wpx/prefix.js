'use strict';

/**
 * CQ WPX 前缀（乘数）解析。
 *
 * 依据 CQ WPX 规则 V.C.1（见 public/shared/wpx/prefixes.json 的 definition）：
 *   PREFIX = 呼号首部的“字母/数字组合”，数字差异也算不同前缀
 *   （N8 / W8 / WD8 / HG1 / HG19 / KC2 / OE2 / OE25 / LY1000 都是不同前缀）。
 *   数字后出现字母即截止；无数字呼号取前两位字母 + 0（XEFTJW -> XE0）；
 *   无数字的便携标识符同样加 0（PA/N8BJQ -> PA0）。
 *   /P /M /MM /A /E /J /QRP 等执照/移动标识不参与前缀。
 *
 * 重要：WPX 前缀不是 DXCC 实体。本模块只做前缀推导，
 * 实体归属仍走 public/shared/dxcc/callsign.mjs，二者不得混用。
 */

const TABLE = require('../../public/shared/wpx/prefixes.json');

const IGNORED_TOKENS = new Set(['P', 'M', 'MM', 'AM', 'A', 'E', 'J', 'QRP', 'QRPP', 'LH', 'R']);
const PREFIX_RE = /^([0-9]?[A-Z]+)(\d+)/;

/** 规范化为大写去空格；空值返回空串。 */
function normalizePrefix(value) {
    return String(value === null || value === undefined ? '' : value).trim().toUpperCase();
}

function chooseDesignator(call) {
    const parts = String(call || '').toUpperCase().split('/')
        .map(p => p.trim())
        .filter(Boolean)
        .filter(p => !IGNORED_TOKENS.has(p));
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    // 单字母后缀（KH8/S、3D2/C 这类属地标识）不是主呼号，先剔除。
    const real = parts.filter(p => p.length >= 2);
    const candidates = real.length ? real : parts;
    // 便携标识通常比主呼号短；等长时优先带数字的一段。
    return candidates.slice().sort((a, b) =>
        a.length - b.length ||
        (PREFIX_RE.test(b) ? 1 : 0) - (PREFIX_RE.test(a) ? 1 : 0))[0];
}

/**
 * 由一个呼号推导 WPX 前缀。无法判定时返回 ''，调用方应跳过而不是猜测。
 * @param {string} call
 * @returns {string}
 */
function wpxPrefix(call) {
    const designator = chooseDesignator(call);
    if (!designator) return '';
    const m = PREFIX_RE.exec(designator);
    if (m) return m[1] + m[2];
    const letters = designator.replace(/[^A-Z]/g, '');
    if (letters.length < 2) return '';
    return letters.slice(0, 2) + '0';
}

/** 前缀的字母基底（去掉尾部数字），用于“已授权字头”校验。 */
function baseLetters(prefix) {
    return normalizePrefix(prefix).replace(/\d+$/, '');
}

/** 该前缀的字母基底是否出现在 DXCC 已授权字头里。 */
function isAuthorizedPrefix(prefix) {
    const base = baseLetters(prefix);
    return !!base && TABLE.authorizedPrefixes.includes(base);
}

/** 一批呼号 -> 去重后的 WPX 前缀集合。 */
function prefixSet(calls) {
    const out = new Set();
    for (const call of Array.isArray(calls) ? calls : []) {
        const prefix = wpxPrefix(call);
        if (prefix) out.add(prefix);
    }
    return out;
}

module.exports = {
    TABLE,
    IGNORED_TOKENS,
    normalizePrefix,
    wpxPrefix,
    baseLetters,
    isAuthorizedPrefix,
    prefixSet
};
