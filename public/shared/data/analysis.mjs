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
