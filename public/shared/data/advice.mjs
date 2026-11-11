/**
 * 实时建议仓库：只读 /api/advice，页面不直接 fetch。
 * 返回规则引擎 DTO；不可用时返回 null，由页面回退到本地提醒。
 */
import {getJson} from '../core/transport.mjs';

const defaultTransport = {getJson};

export async function fetchAdvice({transport = defaultTransport} = {}, options = {}) {
    const data = await transport.getJson('/api/advice', options);
    if (!data || data.ok !== true) return null;
    return data;
}
