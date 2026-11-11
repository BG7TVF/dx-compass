'use strict';

/**
 * G / R / S / B 四组规则（P 组在 environment.js 里先算）。
 *
 * 约定：
 *   - 每条规则返回 null 或 advice 对象；数据不全时仍返回对象，但写入 missing[]、
 *     降低 confidence，绝不让“缺一个字段”把整条规则吞掉（P3）。
 *   - 依据强度 A/B/C/D 原样带出，供 OP 视图区分“规则硬约束”与“经验默认值”。
 */

const {stayFactor} = require('./environment.js');

const BUCKET_MS = 10 * 60000;

function bucketKey(date) {
    const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
    return new Date(Math.floor(ms / BUCKET_MS) * BUCKET_MS).toISOString().slice(0, 16);
}

function bucketKeys(now, count) {
    const end = Math.floor(new Date(now).getTime() / BUCKET_MS) * BUCKET_MS;
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
        out.push(new Date(end - i * BUCKET_MS).toISOString().slice(0, 16));
    }
    return out;
}

function num(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function confidenceOf(deps, strength) {
    const missing = Array.isArray(deps) ? deps.length : 0;
    if (missing >= 2) return 'low';
    if (missing === 1) return strength === 'A' ? 'medium' : 'low';
    return strength === 'A' || strength === 'B' ? 'high' : 'medium';
}

function item(def, missing, confidence) {
    return {
        id: def.id,
        group: def.group,
        priority: def.priority,
        action: def.action,
        title: def.title,
        detail: def.detail,
        strength: def.strength,
        confidence: confidence || confidenceOf(missing || [], def.strength),
        evidence: def.evidence || {},
        missing: missing || [],
        cooldownSec: def.cooldownSec || 600
    };
}

// ---------------------------------------------------------------------------
// 统计口径
// ---------------------------------------------------------------------------

function seriesOf(ctx, band, count) {
    const entry = ctx.stats.bands[band] || {bucketMap: new Map()};
    return bucketKeys(ctx.now, count).map(bucket => ({
        bucket,
        q: entry.bucketMap.has(bucket) ? entry.bucketMap.get(bucket) : 0
    }));
}

function rateOf(ctx, band) {
    const series = seriesOf(ctx, band, 1);
    return series.length ? series[0].q * 6 : 0;
}

function ratePrev(ctx, band) {
    const series = seriesOf(ctx, band, 2);
    return series.length > 1 ? series[0].q * 6 : null;
}

function lastPoints(ctx, band, minutes) {
    const keys = bucketKeys(ctx.now, Math.max(1, Math.round((minutes || 10) / 10)));
    const entry = ctx.stats.bands[band];
    if (!entry) return 0;
    return keys.reduce((sum, key) => sum + (entry.pointMap.get(key) || 0), 0);
}

function eQsoOf(ctx, band, minutes) {
    const pAvg = ctx.stats.pAvg;
    if (!pAvg) return null;
    return 6 * lastPoints(ctx, band, minutes || 10) / pAvg;
}

function bestAlt(ctx, exclude) {
    let best = {band: null, eqso: -1};
    for (const band of Object.keys(ctx.stats.bands)) {
        if (band === exclude) continue;
        const eqso = eQsoOf(ctx, band, 10);
        if (eqso !== null && eqso > best.eqso) best = {band, eqso};
    }
    return best.band ? best : null;
}

function multsOf(ctx, band) {
    const entry = ctx.stats.bands[band];
    if (!entry) return 0;
    if (ctx.contest.multMode === 'wpx') return entry.wpx ? entry.wpx.size : entry.mults;
    return entry.mults;
}

function multGap(ctx, band) {
    if (ctx.contest.multMode === 'wpx') {
        const total = ctx.stats.wpxTotal || 0;
        if (!total) return null;
        return Math.max(0, total - multsOf(ctx, band));
    }
    if (!Number.isFinite(ctx.multipliers.activeEntities)) return null;
    return Math.max(0, ctx.multipliers.activeEntities - multsOf(ctx, band));
}

function stayRate(ctx, band) {
    const cfg = ctx.cfg;
    const key = `${ctx.radio.mode === 'SSB' ? 'SSB' : 'CW'}|${ctx.powerClass}`;
    const multi = ['MS', 'M2', 'MM'].includes(ctx.contest.category);
    const base = multi ? cfg.stayRate.MS : (cfg.stayRate[key] !== undefined
        ? cfg.stayRate[key] : cfg.stayRate['CW|UNKNOWN']);
    return Math.round(base * stayFactor(ctx.env, band));
}

function tStar(ctx, band) {
    const rate = rateOf(ctx, band);
    const mults = multsOf(ctx, band);
    const q = (ctx.stats.bands[band] && ctx.stats.bands[band].q) || 0;
    if (!rate || !mults) return null;
    return 60 * (q / mults) / rate - ctx.tau;
}

function recentSpots(ctx, band, bucketsBack) {
    const list = (ctx.activity.series && ctx.activity.series[band]) || [];
    return list.slice(-(bucketsBack || 3)).reduce((sum, row) => sum + (row.spots || 0), 0);
}

// ---------------------------------------------------------------------------
// G 组：规则硬约束（最高优先级）
// ---------------------------------------------------------------------------

function gateState(ctx) {
    const c = ctx.contest;
    const gates = {
        blockBandChange: null,
        blockReason: null,
        lockRemainingMin: null,
        changesThisHour: ctx.bandChanges.count,
        quota: null,
        quotaRemaining: null
    };

    if (c.type === 'CQ160') {
        gates.blockBandChange = 'G7';
        gates.blockReason = {zh: 'CQ 160 为单波段赛事，不存在换波段', en: 'CQ 160 is single-band: no band changes'};
        return gates;
    }
    if (c.category === 'MM') {
        gates.blockBandChange = 'G9';
        gates.blockReason = {zh: '多人多机不生成换波段建议，改为波段开人评估', en: 'MM: no band-change advice, staff bands instead'};
        return gates;
    }
    if (c.category === 'MS' && c.type === 'CQWW' && c.bandChangeRule !== 'hourly-quota') {
        gates.quota = null;
        gates.rule = 'time-lock';
    }
    if (c.bandChangeRule === 'hourly-quota' || (c.category === 'MS' && c.type !== 'CQWW' && c.type !== 'CQ160')) {
        let limit = c.limit;
        if (!limit) limit = c.type === 'ARRL_DX' ? (c.category === 'M2' ? 6 : 10) : (c.category === 'M2' ? 8 : 10);
        gates.quota = limit;
        gates.quotaRemaining = Math.max(0, limit - ctx.bandChanges.count);
    }
    if (c.category === 'M2' && !gates.quota) {
        const limit = c.type === 'ARRL_DX' ? ctx.cfg.quota.M2_ARRL : ctx.cfg.quota.M2;
        gates.quota = limit;
        gates.quotaRemaining = Math.max(0, limit - ctx.bandChanges.count);
    }

    // G1/G2：时间锁
    if (gates.rule === 'time-lock' && ctx.currentBand) {
        const entry = ctx.stats.bands[ctx.currentBand];
        if (entry && entry.firstTs) {
            const elapsed = (ctx.now.getTime() - Date.parse(entry.firstTs)) / 60000;
            if (elapsed >= 0 && elapsed < 10) {
                gates.blockBandChange = 'G1';
                gates.lockRemainingMin = Number((10 - elapsed).toFixed(1));
                gates.blockReason = {
                    zh: `10 分钟规则锁定中，剩余 ${gates.lockRemainingMin} 分`,
                    en: `10-minute rule lock, ${gates.lockRemainingMin} min remaining`
                };
            }
        }
    }
    return gates;
}

function groupG(ctx) {
    const c = ctx.contest;
    const out = [];
    const gates = ctx.gates;

    if (c.type === 'CQ160') {
        out.push(item({
            id: 'G7', group: 'G', priority: 100, action: 'hold-frequency', strength: 'A',
            title: {zh: 'CQ 160：无换波段，只有守频', en: 'CQ 160: hold frequency, no band changes'},
            detail: {zh: '本赛事单波段；规则只允许一个 CQ 跑台频率，禁止双频来回。', en: 'Single band; one CQ frequency only, flip-flopping is prohibited.'}
        }, [], 'high'));
    }
    if (c.category === 'MM') {
        out.push(item({
            id: 'G9', group: 'G', priority: 100, action: 'staff-bands', strength: 'A',
            title: {zh: 'MM：评估波段开人，不评估换波段', en: 'MM: staff bands instead of changing bands'},
            detail: {zh: '无换波段限制；按各波段 eQSO/hr 与人力边际产出决定开哪几个波段。', en: 'No band-change limit; decide which bands deserve operators.'}
        }, [], 'high'));
    }
    if (c.category === 'MS' || c.category === 'M2') {
        out.push(item({
            id: c.category === 'MS' ? 'G2' : 'G6', group: 'G', priority: 100,
            action: 'respect-lock', strength: 'A',
            title: {
                zh: c.category === 'MS' ? 'M/S：run 与 multiplier 信号各自受锁' : 'M/2：每台配额独立记账',
                en: c.category === 'MS' ? 'M/S: run and multiplier signals are locked separately' : 'M/2: quotas are per transmitter'
            },
            detail: {
                zh: gates.quota
                    ? `${ctx.seat ? '本席（' + ctx.seat + '）' : '本台'}本小时已换 ${gates.changesThisHour} 次，` +
                        `配额 ${gates.quota} 次，剩余 ${gates.quotaRemaining} 次。`
                    : (gates.lockRemainingMin !== null
                        ? `时间锁剩余 ${gates.lockRemainingMin} 分。`
                        : '每次换波段都要按规则记账，配额不能互借。'),
                en: gates.quota
                    ? `${gates.changesThisHour}/${gates.quota} band changes this hour.`
                    : 'Band changes must be accounted for; quotas cannot be transferred.'
            },
            evidence: {changesThisHour: gates.changesThisHour, quota: gates.quota}
        }, [], gates.quota === null && gates.lockRemainingMin === null ? 'medium' : 'high'));
    }
    // 乘数台是 CQ WW MS 专属身份；M2/MM/WPX/ARRL 都没有这个规则角色。
    if (c.category === 'MS' && c.type === 'CQWW' && c.msRole === 'mult') {
        out.push(item({
            id: 'G3', group: 'G', priority: 100, action: 'sp-only', strength: 'A',
            title: {zh: '乘数台：只做 S&P，不得 CQ', en: 'Multiplier station: S&P only, no CQ'},
            detail: {zh: '规则禁止乘数台 CQ；按“整段扫完再换”规划路径。', en: 'Multiplier stations may not CQ; sweep a segment before moving.'}
        }, [], 'high'));
    }
    if (gates.blockBandChange === 'G5' || gates.blockBandChange === 'G4') {
        out.push(item({
            id: gates.blockBandChange, group: 'G', priority: 100, action: 'quota-block', strength: 'A',
            title: {zh: '本小时换波段配额已用完', en: 'Hourly band-change quota exhausted'},
            detail: {zh: '保留配额给高价值乘数；不要再为“找率”换波段。', en: 'Reserve quota for high-value multipliers; do not chase rate.'}
        }, [], 'high'));
    }
    return out;
}

// ---------------------------------------------------------------------------
// R 组：跑台
// ---------------------------------------------------------------------------

function groupR(ctx) {
    const out = [];
    const band = ctx.currentBand;
    if (!band) return out;
    const rate = rateOf(ctx, band);
    const prev = ratePrev(ctx, band);
    const stay = stayRate(ctx, band);
    const alt = bestAlt(ctx, band);
    const running = ctx.radio.isRunning !== false;

    // R1：连续 2 桶低于 R_stay，且替代波段更好
    if (running && prev !== null && rate >= 0 && prev < stay && rate < stay) {
        const altRate = alt ? alt.eqso : null;
        const better = altRate !== null && rate > 0 && altRate > rate * ctx.cfg.altBandRatio;
        out.push(item({
            id: 'R1', group: 'R', priority: 80, action: better ? 'evaluate-band-change' : 'evaluate-sp',
            strength: 'D',
            title: {
                zh: better ? `本波段率低（${Math.round(rate)}/h），评估换到 ${alt.band}m` : `本波段率低（${Math.round(rate)}/h），评估转 S&P`,
                en: better ? `Low rate (${Math.round(rate)}/h): evaluate ${alt.band}m` : `Low rate (${Math.round(rate)}/h): evaluate S&P`
            },
            detail: {
                zh: `连续 2 个 10 分钟桶低于 R_stay（${stay}/h）${better ? `；${alt.band}m 等效 ${Math.round(altRate)}/h` : ''}。`,
                en: `Two consecutive buckets below R_stay (${stay}/h).`
            },
            evidence: {band, rate, prevRate: prev, stayRate: stay, altBand: alt && alt.band, altEQso: alt && Math.round(alt.eqso)}
        }, altRate === null ? ['sp-history'] : []));
    }

    // R2：eQSO 仍不低于 S&P 历史 → 维持跑台
    if (running && prev !== null && rate < stay && ctx.spBaseline && ctx.spBaseline.rate) {
        const eqso = eQsoOf(ctx, band, 20);
        if (eqso !== null && eqso >= ctx.cfg.runKeepRatio * ctx.spBaseline.rate) {
            out.push(item({
                id: 'R2', group: 'R', priority: 78, action: 'keep-running', strength: 'B',
                title: {zh: '率下滑但等效分未降：维持跑台', en: 'Rate down but eQSO holds: keep running'},
                detail: {zh: `eQSO ${Math.round(eqso)}/h ≥ 0.8 × S&P 基准 ${ctx.spBaseline.rate}/h。`, en: 'eQSO still above the S&P baseline.'},
                evidence: {eqso: Math.round(eqso), spBaseline: ctx.spBaseline.rate}
            }, ['sp-history'], 'medium'));
        }
    }

    // R8：末段不换波段
    if (ctx.remainingMin !== null && ctx.remainingMin < ctx.cfg.endgameNoChangeMin) {
        out.push(item({
            id: 'R8', group: 'R', priority: 85, action: 'hold-band', strength: 'C',
            title: {zh: `剩余 ${Math.round(ctx.remainingMin)} 分：只做频率内优化`, en: 'Endgame: optimize within the band'},
            detail: {zh: '末段换波段的期望收益通常低于频率重建成本。', en: 'Late band changes rarely repay the rebuild cost.'}
        }, [], 'high'));
    }

    // R9：极昼低波段
    if (ctx.env.latBand === 'polar' && ctx.env.minElevation !== null && ctx.env.minElevation > 0 &&
        (band === '160' || band === '80')) {
        out.push(item({
            id: 'R9', group: 'R', priority: 82, action: 'leave-low-band', strength: 'B',
            title: {zh: '极昼：低波段基本失效，建议上移', en: 'Polar day: low bands are dead, move up'},
            detail: {zh: `太阳最低高度 ${ctx.env.minElevation}° > 0，无真正黑暗。`, en: 'No true darkness at this latitude.'},
            evidence: {minElevation: ctx.env.minElevation}
        }, [], 'medium'));
    }

    // R10：Kp 风暴 + 高纬 + 高波段率下降
    if (ctx.env.kp !== null && ctx.env.kp >= ctx.cfg.kpStorm && ctx.env.cgmLat !== null &&
        ctx.env.cgmLat > ctx.cfg.highLatCgm && (band === '10' || band === '15') &&
        prev !== null && prev > 0 && (prev - rate) / prev > 0.4) {
        out.push(item({
            id: 'R10', group: 'R', priority: 88, action: 'move-lower', strength: 'B',
            title: {zh: 'Kp 风暴压制高纬高波段，建议下移 20/40', en: 'Kp storm: move down to 20/40'},
            detail: {zh: `Kp ${ctx.env.kp}、CGM ${ctx.env.cgmLat}°；本波段率 2 桶下降超过 40%。`, en: 'High-latitude HF fades during storms.'},
            evidence: {kp: ctx.env.kp, cgmLat: ctx.env.cgmLat, rate, prevRate: prev}
        }, [], 'medium'));
    }

    return out;
}

// ---------------------------------------------------------------------------
// S 组：S&P
// ---------------------------------------------------------------------------

function groupS(ctx) {
    const out = [];
    const band = ctx.currentBand;
    if (!band) return out;
    const rate = rateOf(ctx, band);
    const stay = stayRate(ctx, band);
    const gap = multGap(ctx, band);
    const spots = recentSpots(ctx, band, 1);
    const running = ctx.radio.isRunning === true;

    // S1：率低 + 乘数供给够 → 转 S&P
    if (running && rate < stay && gap !== null && gap >= ctx.cfg.multGapSpots) {
        const spEst = ctx.spBaseline.rate || 0;
        out.push(item({
            id: 'S1', group: 'S', priority: 70, action: 'switch-to-sp', strength: 'D',
            title: {zh: '率低于门槛，乘数缺口足够：转 S&P', en: 'Rate below threshold with multiplier gap: switch to S&P'},
            detail: {zh: `未通乘数缺口 ${gap}；S&P 估计 ${Math.round(spEst)}/h（基准，需自校准）。`, en: `Unworked multiplier gap ${gap}.`},
            evidence: {band, rate, stayRate: stay, gap, spots, spEst: Math.round(spEst)}
        }, ['unworked-mult-spots']));
    }

    // S2：波段刚开
    const series = (ctx.activity.series && ctx.activity.series[band]) || [];
    if (series.length >= 3) {
        const last = series[series.length - 1].spots;
        const before = series[series.length - 3].spots;
        const workedThisBand = (ctx.stats.bands[band] && ctx.stats.bands[band].q) || 0;
        if (before <= 1 && last >= 3) {
            out.push(item({
                id: 'S2', group: 'S', priority: 68, action: 'sp-before-run', strength: 'C',
                title: {zh: '波段刚开：先 S&P 扫乘数，再起跑', en: 'Band just opened: sweep multipliers first'},
                detail: {zh: `本台该波段累计 ${workedThisBand} QSO；spot 数由 ${before} 升至 ${last}。`, en: 'Spots rising from near zero; collect multipliers before running.'},
                evidence: {band, spotsBefore: before, spotsNow: last, workedThisBand}
            }, []));
        }
    }

    // S3：乘数台强制 S&P（仅 CQ WW MS）
    if (ctx.contest.category === 'MS' && ctx.contest.type === 'CQWW' &&
        ctx.contest.msRole === 'mult') {
        out.push(item({
            id: 'S3', group: 'S', priority: 72, action: 'sp-only', strength: 'A',
            title: {zh: '乘数台：强制 S&P', en: 'Multiplier station: forced S&P'},
            detail: {zh: '不得 CQ；按波段成批扫，满足时间锁后再换。', en: 'No CQ; sweep in batches and respect the lock.'}
        }, [], 'high'));
    }

    // S5：S&P 率过低
    if (ctx.radio.isRunning === false) {
        const prev = ratePrev(ctx, band);
        if (prev !== null && prev < ctx.cfg.spTriggerRatio * stay && rate < ctx.cfg.spTriggerRatio * stay) {
            out.push(item({
                id: 'S5', group: 'S', priority: 66, action: 'stop-sp', strength: 'D',
                title: {zh: 'S&P 连续 2 桶低于 R_stay 的 0.7 倍：回跑台', en: 'S&P rate too low: return to running'},
                detail: {zh: `当前 ${Math.round(rate)}/h，阈值 ${Math.round(ctx.cfg.spTriggerRatio * stay)}/h。`, en: 'Two consecutive weak S&P buckets.'},
                evidence: {band, rate, prevRate: prev, stayRate: stay}
            }, []));
        }
    }

    // S6：乘数快饱和
    if (gap !== null && gap < ctx.cfg.multGap30min && gap >= 0) {
        out.push(item({
            id: 'S6', group: 'S', priority: 64, action: 'reduce-sp', strength: 'D',
            title: {zh: '本波段乘数接近饱和：降低 S&P 权重', en: 'Multipliers nearly saturated: reduce S&P'},
            detail: {zh: `未通乘数仅剩 ${gap} 个。`, en: `Only ${gap} unworked multipliers left.`},
            evidence: {band, gap}
        }, []));
    }

    return out;
}

// ---------------------------------------------------------------------------
// B 组：换波段
// ---------------------------------------------------------------------------

function groupB(ctx) {
    const out = [];
    const band = ctx.currentBand;
    if (!band) return out;
    if (ctx.gates.blockBandChange) {
        // G 组否决：B 组建议不生成，由 gates 统一提示
        return out;
    }

    const rate = rateOf(ctx, band);
    const tau = ctx.tau;
    const bpiCurrent = ctx.env.bpi[band];
    const target = Object.keys(ctx.env.bpi)
        .filter(b => b !== band)
        .map(b => ({band: b, bpi: ctx.env.bpi[b]}))
        .sort((a, b) => b.bpi - a.bpi)[0];

    // B4：刚换波段 10 分钟内不二次换
    if (ctx.lastBandChangeAt && (ctx.now.getTime() - ctx.lastBandChangeAt) / 60000 < ctx.cfg.newBandDiscountMin) {
        out.push(item({
            id: 'B4', group: 'B', priority: 60, action: 'hold', strength: 'B',
            title: {zh: '刚换波段不足 10 分钟：暂不二次换', en: 'Just changed band: do not change again yet'},
            detail: {zh: '新波段前 10 分钟乘数占比虚高，eQSO 会被高估。', en: 'New-band eQSO is inflated by multipliers; wait it out.'}
        }, [], 'high'));
        return out;
    }

    // B3：乘数缺口 + t* 足够
    if (target) {
        const gap = multGap(ctx, target.band);
        const t = tStar(ctx, band);
        if (gap !== null && gap >= ctx.cfg.multGapSpots && t !== null && t > tau + 5 &&
            (bpiCurrent === undefined || target.bpi >= bpiCurrent)) {
            out.push(item({
                id: 'B3', group: 'B', priority: 58, action: 'change-band-for-mult',
                strength: 'A',
                title: {zh: `考虑换到 ${target.band}m 抓乘数`, en: `Consider ${target.band}m for multipliers`},
                detail: {zh: `本波段 t* ≈ ${t.toFixed(1)} 分 > τ+5；目标波段未通乘数 ${gap} 个。`, en: `t* exceeds tau+5 with ${gap} unworked multipliers.`},
                evidence: {from: band, to: target.band, tStar: Number(t.toFixed(1)), tau, gap, bpi: target.bpi}
            }, ['unworked-mult-spots']));
        }
    }

    // B1：BPI 差 ≥ 2 且目标波段 spot 在起量
    if (target && bpiCurrent !== undefined && target.bpi - bpiCurrent >= 2 &&
        recentSpots(ctx, target.band, 2) > 0) {
        out.push(item({
            id: 'B1', group: 'B', priority: 54, action: 'move-early', strength: 'C',
            title: {zh: `目标 ${target.band}m 优先级高 2 级：考虑提前到位`, en: `Consider moving early to ${target.band}m`},
            detail: {zh: `BPI ${bpiCurrent} → ${target.bpi}；提前量 Δ_in ≈ ${ctx.deltaIn} 分（无 MUF 时按经验）。`, en: 'BPI gap of two; move before the window peaks.'},
            evidence: {from: band, to: target.band, bpi: target.bpi, deltaIn: ctx.deltaIn, spots: recentSpots(ctx, target.band, 2)}
        }, ctx.env.missing.includes('sfi') ? ['muf'] : ['muf']));
    }

    // B6：配额只剩 1
    if (ctx.gates.quotaRemaining !== null && ctx.gates.quotaRemaining <= ctx.cfg.quotaReserve) {
        out.push(item({
            id: 'B6', group: 'B', priority: 62, action: 'reserve-quota', strength: 'A',
            title: {zh: '换波段配额将尽：留给高价值乘数', en: 'Band-change quota nearly spent: save it'},
            detail: {zh: `本小时剩余 ${ctx.gates.quotaRemaining} 次，不为“找率”换波段。`, en: `Only ${ctx.gates.quotaRemaining} change(s) left this hour.`},
            evidence: {remaining: ctx.gates.quotaRemaining}
        }, [], 'high'));
    }

    // B7：Kp 高 + 高纬
    if (ctx.env.kp !== null && ctx.env.kp >= ctx.cfg.kpStorm && ctx.env.cgmLat !== null &&
        ctx.env.cgmLat > ctx.cfg.highLatCgm) {
        out.push(item({
            id: 'B7', group: 'B', priority: 76, action: 'no-polar-highband', strength: 'B',
            title: {zh: 'Kp ≥ 5：不要以“跨极开通”为由换到 10/15', en: 'Kp ≥ 5: do not count on cross-polar 10/15'},
            detail: {zh: `Kp ${ctx.env.kp}、CGM ${ctx.env.cgmLat}°；高纬路径会衰减。`, en: 'High-latitude HF fades during storms.'},
            evidence: {kp: ctx.env.kp, cgmLat: ctx.env.cgmLat}
        }, [], 'medium'));
    }

    // B8：S3+ 极区黑障
    if (ctx.env.sLevel !== null && ctx.env.sLevel >= ctx.cfg.sLevelPolarBlock) {
        out.push(item({
            id: 'B8', group: 'B', priority: 77, action: 'no-cross-polar', strength: 'A',
            title: {zh: `S${ctx.env.sLevel} 质子事件：禁止跨极换波段`, en: `S${ctx.env.sLevel}: no cross-polar band moves`},
            detail: {zh: '极区 HF 可能黑障数小时；不要等待恢复。', en: 'Polar cap absorption may last hours.'},
            evidence: {sLevel: ctx.env.sLevel}
        }, [], 'high'));
    }

    // B9：R2+ 日照侧黑障
    if (ctx.env.rLevel !== null && ctx.env.rLevel >= ctx.cfg.rLevelPause && ctx.env.solarElev !== null &&
        ctx.env.solarElev > 0) {
        out.push(item({
            id: 'B9', group: 'B', priority: 75, action: 'pause-band-change', strength: 'A',
            title: {zh: `R${ctx.env.rLevel} 耀斑：日照侧 10–20m 可能短时消失`, en: `R${ctx.env.rLevel}: daylight 10–20m may fade`},
            detail: {zh: '暂停换波段建议 10–60 分钟，等黑障结束。', en: 'Pause band-change decisions for 10–60 minutes.'},
            evidence: {rLevel: ctx.env.rLevel, solarElev: ctx.env.solarElev}
        }, [], 'high'));
    }

    // B10：极区冬季白天也能上低波段
    if (ctx.env.latBand === 'polar' && ctx.env.season === 'winter' && ctx.env.solarElev !== null &&
        ctx.env.solarElev < 0 && (band !== '160' && band !== '80')) {
        const lowSpots = recentSpots(ctx, '160', 3) + recentSpots(ctx, '80', 3);
        if (lowSpots > 0) {
            out.push(item({
                id: 'B10', group: 'B', priority: 52, action: 'low-band-daylight', strength: 'B',
                title: {zh: '极夜：白天也可上 160/80', en: 'Polar night: low bands work in daylight'},
                detail: {zh: '低波段无 D 层吸收；按“路径是否在黑暗中 + Kp”判断。', en: 'No D-layer absorption during polar night.'},
                evidence: {solarElev: ctx.env.solarElev, lowSpots}
            }, []));
        }
    }

    // B11：低纬日落延长窗口
    if (ctx.env.latBand === 'low' && ctx.env.localSolarHour !== null) {
        const h = ctx.env.localSolarHour;
        if ((h >= 19 && h <= 23) && (band === '15' || band === '10') && recentSpots(ctx, band, 3) > 0) {
            out.push(item({
                id: 'B11', group: 'B', priority: 50, action: 'stay-high-band', strength: 'C',
                title: {zh: '低纬赤道异常：15/10 窗口比直觉更晚关', en: 'Low latitude: 15/10m stay open later'},
                detail: {zh: '日落后 1–2 小时内不要急于撤离，先看 spot 与应答。', en: 'Do not leave high bands immediately after sunset.'},
                evidence: {localSolarHour: h, spots: recentSpots(ctx, band, 3)}
            }, []));
        }
    }

    // B12：末段冻结探索
    if (ctx.remainingMin !== null && ctx.remainingMin < ctx.cfg.endgameFreezeExploreMin) {
        const alt = bestAlt(ctx, band);
        if (!alt || (rate > 0 && alt.eqso < rate * ctx.cfg.altBandRatio)) {
            out.push(item({
                id: 'B12', group: 'B', priority: 65, action: 'freeze-exploration', strength: 'C',
                title: {zh: '末段：冻结探索性换波段', en: 'Endgame: freeze exploratory band changes'},
                detail: {zh: `剩余 ${Math.round(ctx.remainingMin)} 分，替代波段无明显优势。`, en: 'No alternative band shows a clear advantage.'}
            }, ['sp-history'], 'medium'));
        }
    }

    // B13：QSO 最多的波段优先补乘数
    const bandsByQ = Object.keys(ctx.stats.bands)
        .sort((a, b) => (ctx.stats.bands[b].q || 0) - (ctx.stats.bands[a].q || 0));
    const top = bandsByQ[0];
    if (top && top === band) {
        const gap = multGap(ctx, band);
        if (gap !== null && gap > 0 && (ctx.stats.bands[band].q || 0) >= 50) {
            out.push(item({
                id: 'B13', group: 'B', priority: 48, action: 'hunt-mult-here', strength: 'A',
                title: {zh: '本波段 QSO 最多：未通乘数在这里更值钱', en: 'Most-worked band: hunt its multipliers first'},
                detail: {zh: `Q_b ${ctx.stats.bands[band].q}，未通乘数 ${gap} 个；V_b = Q_b/M_b。`, en: 'Multiplier value scales with Q_b.'},
                evidence: {band, q: ctx.stats.bands[band].q, gap}
            }, ['unworked-mult-spots']));
        }
    }

    return out;
}

module.exports = {
    BUCKET_MS,
    bucketKey,
    bucketKeys,
    seriesOf,
    rateOf,
    ratePrev,
    eQsoOf,
    bestAlt,
    multsOf,
    multGap,
    stayRate,
    tStar,
    recentSpots,
    gateState,
    groupG,
    groupR,
    groupS,
    groupB
};
