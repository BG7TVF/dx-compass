/**
 * 可通性卡片的展示层过滤（白名单）。
 *
 * 只有同一模式（CW 或 SSB）、两个方向都判为“可通”时才展示；其余全部隐藏，
 * 并按以下优先级各计一次：
 *  1. marginal：任一侧出现“可通”或“边缘”（双向边缘、仅单侧可通/边缘都归此类）；
 *  2. unworkable：两个方向都可用，且两个模式的判定全为“不可通”；
 *  3. no-data：任一侧 available === false（样本不足或没有报告）。
 * 这里只决定展示哪些行，不修改、不丢算法结果。
 */

const MODES = ['CW', 'SSB'];

function directionVerdict(direction, mode) {
    if (!direction || direction.available !== true || !direction.verdicts) return null;
    return direction.verdicts[mode] || null;
}

function directionHas(direction, verdict) {
    return MODES.some(mode => directionVerdict(direction, mode) === verdict);
}

function directionAllUnworkable(direction) {
    return Boolean(direction && direction.available === true && direction.verdicts) &&
        MODES.every(mode => direction.verdicts[mode] === 'unworkable');
}

function directionUnavailable(direction) {
    return !direction || direction.available === false;
}

export function isBidirectionalWorkable(row) {
    const directions = row && row.directions;
    if (!directions) return false;
    return MODES.some(mode =>
        directionVerdict(directions.aToB, mode) === 'workable' &&
        directionVerdict(directions.bToA, mode) === 'workable');
}

/** 返回 null（展示）或 'marginal' / 'unworkable' / 'no-data'。 */
export function hiddenReason(row) {
    if (isBidirectionalWorkable(row)) return null;
    const directions = (row && row.directions) || {};
    const aToB = directions.aToB;
    const bToA = directions.bToA;
    // 单侧可通也落在这一类：卡片不满足白名单，但仍不是“双向不可通”。
    if (directionHas(aToB, 'marginal') || directionHas(bToA, 'marginal') ||
        directionHas(aToB, 'workable') || directionHas(bToA, 'workable')) {
        return 'marginal';
    }
    if (directionAllUnworkable(aToB) && directionAllUnworkable(bToA)) return 'unworkable';
    if (directionUnavailable(aToB) || directionUnavailable(bToA)) return 'no-data';
    // 理论上不会走到这里（可用方向的余量一定可判定）；保守归入不可通，避免漏计。
    return 'unworkable';
}

/** 保持传入顺序（服务端已按可利用性排序），并按三类分别返回隐藏数量。 */
export function visiblePathRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let hiddenMarginal = 0;
    let hiddenUnworkable = 0;
    let hiddenNoData = 0;
    const visible = [];
    list.forEach(item => {
        const reason = hiddenReason(item);
        if (reason === 'marginal') hiddenMarginal += 1;
        else if (reason === 'unworkable') hiddenUnworkable += 1;
        else if (reason === 'no-data') hiddenNoData += 1;
        else visible.push(item);
    });
    return {visible, hiddenMarginal, hiddenUnworkable, hiddenNoData};
}
