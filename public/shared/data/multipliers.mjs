/**
 * 倍率矩阵仓库：只读 /api/multipliers，不在页面里直接 fetch。
 * 参数与后端 prepare() 一致：mode / scope / contest / from / to。
 */
import {getJson} from '../core/transport.mjs';

const defaultTransport = {getJson};

export async function fetchMultiplierMatrix({transport = defaultTransport, ...params} = {}, options = {}) {
    const query = new URLSearchParams();
    for (const key of ['mode', 'scope', 'contest', 'from', 'to']) {
        const value = params[key];
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    const data = await transport.getJson(`/api/multipliers${suffix ? `?${suffix}` : ''}`, options);
    if (!data || data.ok !== true) throw new TypeError('/api/multipliers returned an invalid DTO');
    return data;
}

/** OP 视图：紧凑矩阵只需要 mode 与竞赛窗口。 */
export async function fetchMultipliers({mode = 'ALL', scope = 'contest', transport = defaultTransport, ...options} = {}) {
    const query = new URLSearchParams();
    query.set('mode', String(mode || 'ALL').toUpperCase());
    query.set('scope', scope === 'all' ? 'all' : 'contest');
    return transport.getJson(`/api/multipliers?${query.toString()}`, options);
}
