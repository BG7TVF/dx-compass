/**
 * 分析研判接口的数据访问层。只负责拼查询串与校验响应形状，
 * 不做任何估算——算法在服务端 lib/analysis。
 */
import {getJson} from '../core/transport.mjs';

const defaultTransport = {getJson};

export async function fetchAnalysis({call, from, to, limit, transport = defaultTransport, ...options} = {}) {
    const target = String(call || '').trim().toUpperCase();
    if (!target) throw new TypeError('call is required');
    const query = new URLSearchParams({call: target});
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    if (limit) query.set('limit', String(limit));
    const report = await transport.getJson(`/api/analysis/estimate?${query}`, options);
    if (!report || typeof report !== 'object') throw new TypeError('invalid analysis response');
    return report;
}

/** CW/SSB 可通性研判；身份与功率来自服务端设置，这里只传时间范围。 */
export async function fetchPathAnalysis({from, to, limit, transport = defaultTransport, ...options} = {}) {
    const query = new URLSearchParams();
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    if (limit) query.set('limit', String(limit));
    const suffix = query.toString();
    const report = await transport.getJson(
        '/api/analysis/paths' + (suffix ? `?${suffix}` : ''), options);
    if (!report || typeof report !== 'object') throw new TypeError('invalid path analysis response');
    return report;
}

/** OP 视图：单目标天线推断，复用分析研判的估算结果。 */
export async function fetchEstimate(call, {transport = defaultTransport, ...options} = {}) {
    const query = new URLSearchParams();
    query.set('call', String(call || '').trim().toUpperCase());
    return transport.getJson(`/api/analysis/estimate?${query.toString()}`, options);
}

/** OP 视图：按时间窗口读取 CW/SSB 可通性。 */
export async function fetchPaths({hours = 2, transport = defaultTransport, ...options} = {}) {
    const query = new URLSearchParams();
    query.set('hours', String(hours));
    return transport.getJson(`/api/analysis/paths?${query.toString()}`, options);
}
