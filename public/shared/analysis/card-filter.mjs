/**
 * 可通性卡片的展示层过滤。
 *
 * 隐藏只有两类，且都要求“两侧”同时成立：
 *  - 双向不可通：aToB 与 bToA 都可用，且 CW/SSB 全部判为不可通；
 *  - 双向无数据：aToB 与 bToA 都不可用（样本不足或没有报告）。
 * 单侧有数据（另一侧不可用）必须保留——方向差异本身是研判信息。
 * 这里只决定展示哪些行，不修改、不丢算法结果。
 */

const MODES = ['CW', 'SSB'];

function directionUnworkable(direction) {
    if (!direction || direction.available !== true || !direction.verdicts) return false;
    return MODES.every(mode => direction.verdicts[mode] === 'unworkable');
}

function directionUnavailable(direction) {
    return !direction || direction.available === false;
}

/** 返回 null（显示）、'unworkable'（双向不可通）或 'no-data'（双向无数据）。 */
export function hiddenReason(row) {
    const directions = row && row.directions;
    if (!directions) return null;
    if (directionUnworkable(directions.aToB) && directionUnworkable(directions.bToA)) {
        return 'unworkable';
    }
    if (directionUnavailable(directions.aToB) && directionUnavailable(directions.bToA)) {
        return 'no-data';
    }
    return null;
}

/** 保持传入顺序（服务端已按可利用性排序），并分别返回两类被隐藏的数量。 */
export function visiblePathRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let hiddenUnworkable = 0;
    let hiddenNoData = 0;
    const visible = [];
    list.forEach(item => {
        const reason = hiddenReason(item);
        if (reason === 'unworkable') hiddenUnworkable += 1;
        else if (reason === 'no-data') hiddenNoData += 1;
        else visible.push(item);
    });
    return {visible, hiddenUnworkable, hiddenNoData};
}
