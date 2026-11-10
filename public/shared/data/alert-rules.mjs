/**
 * 条件告警仓库：规则与命中记录都走独立接口，页面不直接 fetch。
 * 规则存储在后端 alert_rules 表，不写入 uiSettings。
 */
import {getJson, postJson, putJson, deleteJson} from '../core/transport.mjs';

const defaultTransport = {getJson, postJson, putJson, deleteJson};

function ensure(ok, data, endpoint) {
    if (!data || data.ok !== ok) throw new TypeError(`${endpoint} returned an invalid DTO`);
    return data;
}

export async function fetchAlertRules({transport = defaultTransport} = {}, options = {}) {
    return ensure(true, await transport.getJson('/api/alert-rules', options), '/api/alert-rules');
}

export async function createAlertRule(rule, {transport = defaultTransport} = {}, options = {}) {
    return ensure(true, await transport.postJson('/api/alert-rules', rule, options), '/api/alert-rules');
}

export async function updateAlertRule(id, rule, {transport = defaultTransport} = {}, options = {}) {
    const path = `/api/alert-rules/${encodeURIComponent(id)}`;
    return ensure(true, await transport.putJson(path, rule, options), path);
}

export async function deleteAlertRule(id, {transport = defaultTransport} = {}, options = {}) {
    const path = `/api/alert-rules/${encodeURIComponent(id)}`;
    return ensure(true, await transport.deleteJson(path, options), path);
}

export async function fetchAlertHits({transport = defaultTransport} = {}, options = {}) {
    return ensure(true, await transport.getJson('/api/alert-rules/hits', options), '/api/alert-rules/hits');
}
