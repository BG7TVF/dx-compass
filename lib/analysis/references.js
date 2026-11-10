'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 人工维护的参照表。
 *
 * RBN / DX Cluster / DX Summit / PSKR 都不提供接收站或参照台的功率、天线、
 * 朝向，这些只能来自人工维护。文件缺失或为空时，分析模块只能走绝对法，
 * 并必须在结果中声明这一点——绝不编造参照台数据。
 */

const DEFAULT_FILE = path.join(__dirname, 'reference-stations.json');

function normalizeCall(value) {
    return String(value || '').trim().toUpperCase();
}

/** 呼号匹配变体：原样 -> 去掉 -# -> 去掉 SSID。 */
function callVariants(call) {
    const full = normalizeCall(call);
    if (!full) return [];
    const out = [full];
    const noHash = full.replace(/-#$/, '');
    if (noHash !== full) out.push(noHash);
    const base = noHash.replace(/-\d+$/, '');
    if (base !== noHash) out.push(base);
    return out;
}

function pickNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizeAntennaType(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'directional' || text === 'dir' || text === 'yagi' || text === 'beam') return 'directional';
    if (text === 'dipole') return 'dipole';
    if (text === 'omni' || text === 'omnidirectional' || text === 'vertical') return 'omni';
    return 'unknown';
}

function normalizeReference(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const call = normalizeCall(entry.call);
    const powerW = pickNumber(entry.powerW);
    if (!call || powerW === null || powerW <= 0) return null;
    return {
        call,
        powerW,
        powerDbm: 10 * Math.log10(powerW * 1000),
        gainDbi: pickNumber(entry.gainDbi),
        antennaType: normalizeAntennaType(entry.antennaType),
        source: entry.source || null,
        verifiedAt: entry.verifiedAt || null
    };
}

function normalizeReceiver(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const call = normalizeCall(entry.call);
    if (!call) return null;
    return {
        call,
        model: entry.model || null,
        antennaType: normalizeAntennaType(entry.antennaType),
        gainDbi: pickNumber(entry.gainDbi),
        azimuthDeg: pickNumber(entry.azimuthDeg),
        agcCompressed: entry.agcCompressed === true,
        source: entry.source || null
    };
}

function emptyTable(file = DEFAULT_FILE, error = 'empty') {
    return {loaded: false, path: file, error, references: [], receivers: [], warnings: []};
}

/** 读取并校验参照表；任何异常都退化为空表，不抛错、不补假数据。 */
function loadReferences(file = DEFAULT_FILE) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        return emptyTable(file, error.code === 'ENOENT' ? 'missing' : String(error.message || error));
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (error) {
        return emptyTable(file, 'invalid-json');
    }
    const warnings = [];
    const references = [];
    const receivers = [];
    for (const entry of Array.isArray(data.references) ? data.references : []) {
        const item = normalizeReference(entry);
        if (item) references.push(item);
        else warnings.push('invalid-reference');
    }
    for (const entry of Array.isArray(data.receivers) ? data.receivers : []) {
        const item = normalizeReceiver(entry);
        if (item) receivers.push(item);
        else warnings.push('invalid-receiver');
    }
    return {
        loaded: true,
        path: file,
        error: null,
        references,
        receivers,
        warnings
    };
}

function lookup(list, call) {
    const variants = callVariants(call);
    for (const variant of variants) {
        const found = list.find(item => item.call === variant);
        if (found) return found;
    }
    return null;
}

function referenceFor(table, call) {
    return lookup((table && table.references) || [], call);
}

function receiverFor(table, call) {
    return lookup((table && table.receivers) || [], call);
}

/** 引用的天线增益：优先表内值，其次按类型给保守默认。 */
function gainForAntennaType(type, explicitGain) {
    if (Number.isFinite(explicitGain)) return explicitGain;
    if (type === 'directional') return 8;
    if (type === 'dipole') return 2;
    if (type === 'omni') return 1.5;
    return 2;
}

module.exports = {
    DEFAULT_FILE,
    normalizeCall,
    callVariants,
    loadReferences,
    referenceFor,
    receiverFor,
    gainForAntennaType
};
