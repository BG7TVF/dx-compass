/**
 * 可通性卡片的区域标题：<国家>, <主字头>
 *
 * 数据来源：./entities.json（ADIF 3.1.5 DXCC 枚举 + cty.dat 主字头，抓取日期见文件头）。
 * 回退顺序：实体表 → 网格前缀（+ 未知 DXCC 编号）→ 未知区域，绝不编造国家名。
 */

/**
 * @param {{dxcc?:number|null, country?:string, countryZh?:string, prefix?:string, grid?:string, grids?:string[]}} region
 * @param {string} lang 当前界面语言（仅 zh 使用中文名）
 * @param {string} unknown 无法判定时的文案
 * @returns {string}
 */
export function regionTitle(region, lang, unknown = 'Unknown region') {
    if (!region) return unknown;
    const zh = String(lang || '').toLowerCase().startsWith('zh');
    const name = zh ? (region.countryZh || region.country) : region.country;
    if (name && region.prefix) return `${name}, ${region.prefix}`;
    if (name) return name;
    const grid = String(region.grid || (Array.isArray(region.grids) ? region.grids[0] : '') || '')
        .trim().toUpperCase();
    if (grid && region.dxcc) return `${grid} · DXCC ${region.dxcc}`;
    if (grid) return grid;
    if (region.dxcc) return `DXCC ${region.dxcc}`;
    return unknown;
}
