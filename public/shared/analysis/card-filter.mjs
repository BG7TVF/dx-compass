/**
 * 可通性卡片的展示层过滤。
 *
 * 只有两个方向都明确判为“不可通”时才隐藏；任一侧为可通/边缘，或该侧样本不足、
 * 无法判定，都必须保留——缺数据不能被误判成不可通。
 * 这里只决定展示哪些行，不修改、不丢算法结果。
 */

const MODES = ['CW', 'SSB'];

function directionUnworkable(direction) {
    if (!direction || direction.available !== true || !direction.verdicts) return false;
    return MODES.every(mode => direction.verdicts[mode] === 'unworkable');
}

export function isUnworkableCard(row) {
    const directions = row && row.directions;
    if (!directions) return false;
    return directionUnworkable(directions.aToB) && directionUnworkable(directions.bToA);
}

/** 保持传入顺序（服务端已按可利用性排序），并返回被隐藏的条数。 */
export function visiblePathRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const visible = list.filter(item => !isUnworkableCard(item));
    return {visible, hidden: list.length - visible.length};
}
