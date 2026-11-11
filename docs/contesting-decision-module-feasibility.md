# 竞赛实时决策辅助模块：能力核对与分期方案

- 核对日期：2026-11-11
- 依据：`docs/contesting-tactics-research.md`（G/R/S/B/P 五组规则与第 6 节输入清单）
- 范围：只做能力核对与设计，不含实现代码；不涉及 `public/shared/map/`（OP 视图地图收口中）
- 标注约定：**核实** = 已读源码确认；**推断** = 由代码结构推出、未跑数据验证；**待确认** = 需要现场/用户信息才能定

---

## 0. 结论摘要

| 判断 | 结论 |
|---|---|
| 能不能落地 | **能，但只能分层落地**。纯日志统计类规则（R1/R2/R8/B4/B12/B13）现在就能做；规则约束类（G 组）补一组配置后可做；spot 流类（S1/S2/S6/B3/R3/R4）与传播类（B1/B2/B5/B7/R9/R10/B11）缺输入，必须先补数据；现场事件类（R5/R6/G8/S8）依赖 CAT/日志事件接入 |
| 最大单点依赖 | **本机 QSO 全部来自 N1MM+ UDP**。没有 N1MM+ 在跑，`qsos` 为空，R/S/B 三组全部退化为“无建议”（P3 降级） |
| 最大数据缺口 | **不存在“波段级 spot 流”**。DXWatch/RBN 只入库监控呼号，PSKReporter 只入库监控呼号 + 本台 4 位大网格。报告里所有“10 分钟内未通乘数 spot ≥ 2”类判据目前无法计算 |
| 最省力的复用 | 传播侧 `propContinentTable` 已给出“各洲 × 最佳波段 + 分数”，可作为 `BPI` 的现成骨架；`scoreState`/`radioState` 已含 N1MM+ 实时总分与 `IsRunning`，可省掉一半自算 |
| 建议输出形态 | 新增只读 `GET /api/advice`，返回规则命中数组（id/动作/置信度/强度/证据），OP 视图以“建议卡”消费。**不新建页面，不重复实现 paths/multipliers/callsign-check** |

---

## 1. 字段级对照表

状态三档：**已有** / **部分有** / **没有**。规则列引用报告第 5 章 ID。

### 1.1 本台与环境

| 字段 | 规则 | 状态 | 数据来源（核实位置） | 缺口说明 |
|---|---|---|---|---|
| 本台网格 | P1、全部 | 已有 | `settings.grid`（4/6 位），[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L95-L99) | — |
| 本台经纬度 | P1、R9、B10 | 已有 | `gridToLatLon()`，[service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/service.js#L12-L22)；前端同名实现在 `public/shared/geo/maidenhead.mjs` | 两处实现重复，但结果一致；服务端可直接用 |
| CGM 磁纬 | R9/R10/B7/B10 | **没有** | 全仓无 IGRF/CGM 实现（grep `elevation|declination|subsolar` 无命中） | 需内置偶极近似（报告 4.1 的 ±几度表）；纯离线计算，无外部依赖 |
| 太阳赤纬 / 季节档 | P1、4.2 | **没有** | 同上 | 可用日期直接算，工程量极小 |
| 太阳高度角 / 灰线窗口 | B10/B11、3.2 | **没有** | 服务端无；前端只有 `.trae/skills/leaflet-terminator-grayline` 模板，不属于运行时数据 | 需新增小函数（经纬度 + 赤纬） |
| 当前 UTC / 地方时 | 全部 | 已有 | 系统时间 + `settings.timeZone` | 地方时需由经度换算，现无 |
| 剩余时间 `T_rem` | R8/B12、G 组 | **部分有** | `contestStart`/`contestEnd`，[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L549-L558)；到期自动清空 [service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/contest/service.js#L38-L57) | 有起止即可算；但没有“赛事时长/是否 48h”校验，用户填错就是错建议 |

### 1.2 空间天气

| 字段 | 规则 | 状态 | 数据来源（核实位置） | 缺口说明 |
|---|---|---|---|---|
| SFI / F10.7 | P1、4.3 | 已有 | `propData.sfi`（`10cm-flux-30-day.json`），[collector.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/collector.js#L499)；回退 `ham.sfi` | **F10.7 就是 SFI**，同一物理量，不需要再单独接 |
| SSN | P1 | 已有 | `propData.ssn`（solar-cycle 观测），[collector.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/collector.js#L500-L508) | — |
| Kp | P1、R10、B7 | 已有 | `propData.kp`（planetary K index），[collector.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/collector.js#L497) | 10 分钟级序列，够用 |
| Ap | P1、4.3 | 已有（未展示） | `propData.a`（DGD 日行星 A 指数），[collector.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/collector.js#L510)、解析在 [L377-L388](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/collector.js#L377-L388) | **不在大屏 8 项里**，但传播页已消费（[propagation-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/propagation-page.mjs#L785)） |
| S 级（质子通量） | B8 | 已有 | `propData.proton`（GOES ≥10 MeV），[collector.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/collector.js#L511-L522)；`propData.scales.s` | 两级来源都有，可直接判 S1–S5 |
| R 级（X 射线） | B9 | 已有 | `propData.xray`（0.1–0.8nm），[collector.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/collector.js#L523-L537)；`propData.scales.r` | 已有 A/B/C/M/X 分档逻辑，[wall-cards.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/bigscreen/wall-cards.mjs#L84-L91) |
| G 级 | P1 | 已有 | `propData.scales.g` | 仅展示，未参与任何门控 |
| DRAP / 极光 / 电离层站 | B1/B2/B5 辅助 | 已有 | `propData.drap`、`aurora`、`muf`（kc2g 站点）、`gambit` | 原始数据齐全，缺“结论化”的派生字段 |
| 分方向 MUF | B1/B2/B5、Δ_in | **部分有** | `propPathMatrix(de,dx)` 单点对单点，[model.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/model.js#L501-L518)；`propContinentTable` 给出各洲最佳波段 [L520-L545](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/propagation/model.js#L520-L545) | `settings.propDxLat/Lon` **只有单个 DX 目标**；要做“本台→主要 DX 方向”需扩成多方向采样，属新建而非改一行 |

> **8 项空间天气已核实**：大屏/OP 视图共用 `spaceWeatherCells()`，固定为 SFI、SSN、KP、DST、BZ、BT、WIND、XRAY 八格（[wall-cards.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/bigscreen/wall-cards.mjs#L94-L114)）。含 SFI/SSN/Kp，**不含 Ap**（Ap 另存 `propData.a`），F10.7 即 SFI。

### 1.3 Spot 与邻台

| 字段 | 规则 | 状态 | 数据来源（核实位置） | 缺口说明 |
|---|---|---|---|---|
| PSKReporter 报告 | S 组、B 组 | **部分有** | MQTT 订阅监控呼号 + `v2_field` 全区域，客户端按 4 位大网格收紧，[service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/spots/service.js#L363-L405)；入库判定 [L289-L305](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/spots/service.js#L289-L305) | 覆盖 = 监控呼号 + 本台大网格；**不是全域** |
| RBN 报告 | S 组、R3 | **部分有** | [processRbn](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/spots/service.js#L194-L272) | `if (!monitored.includes(target)) continue;`（[L234](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/spots/service.js#L234)）——**只入库监控呼号**，CW only |
| DX Cluster | S 组 | **部分有** | 无 telnet 节点；走 dxwatch.com HTTP 聚合页，[liveRequest](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/spots/service.js#L40-L50) | 同样只入库监控呼号（[L128](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/spots/service.js#L128)）；无独立 cluster 源 |
| spot 波段活跃度（10 min 新 spot 数） | S1/S2/B2/B3/R4 | **没有** | — | 现有 spot 流是“监控呼号子集”，不能代表波段活跃度；这是最关键的缺口 |
| “未通乘数” spot | S1/S2/B3 | **没有** | — | 需要“全量 spot × 已通矩阵差集”；两侧都不成立（spot 非全量、矩阵只有 DXCC 粒度） |
| 邻台表 | 路径研判 | 已有 | `neighbors` + 两条 AFTER INSERT 触发器，[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/schema.js#L71-L123) | **重要**：触发器依赖 `sender_grid`/`receiver_grid`，只有 PSKReporter 记录带这两列 → 邻台实际是 PSKR-only（核实：DXWatch/RBN 记录未填这两列） |
| 邻台 30 分钟 TTL | 路径研判 | 已有 | `NEIGHBOR_TTL_MINUTES = 30`，[paths.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/analysis/paths.js#L58)；SQL 侧 [neighbor-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/neighbor-sql.js#L16-L25)；物理清理 60 min | 与报告要求一致，无需改 |
| 双向可通性（CW/SSB） | R1/S1 的“替代波段” | 已有 | `GET /api/analysis/paths`，[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L2769)；算法 [paths.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/analysis/paths.js#L427-L712) | 只能当“波段是否开着”的弱代理：**FT8-only**（`comment LIKE 'PSKR FT8%'`，[spot-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/spot-sql.js#L62)）、区域粒度、双侧不对称取较差侧 |
| 对手同波段活动强度 | R7、1.1 | **部分有** | 监控呼号的 spot 计数 | 只对显式加入 `monitoredCalls` 的对手成立 |

### 1.4 乘数与计分

| 字段 | 规则 | 状态 | 数据来源（核实位置） | 缺口说明 |
|---|---|---|---|---|
| QSO 时间序列 | R/S/B 全部 | **部分有** | `qsos` 表，仅 N1MM+ UDP 12061 写入，[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L1433)、[L1555](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L1555) | 无 N1MM+ 即为空；`/api/qsos` 默认 200 行（[qso-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/qso-sql.js#L21-L24)） |
| 单 QSO 点值 `points` | `p̄_b`、eQSO | **部分有** | `contactinfo.points`，[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L59) | 由 N1MM+ 按赛事规则算；缺失/为 0 时 `p̄` 退化 |
| 是否乘数 `is_mult` | `M_b` | **部分有** | `ismultiplier1..3` 求和 → 布尔，[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L37-L39) | **只有布尔，没有是哪个乘数**；不能还原矩阵 |
| DXCC × 波段矩阵 | `M_b`、乘数缺口 | **部分有** | `GET /api/multipliers`，[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L2886)；逻辑 [multipliers/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/multipliers/service.js#L186-L360) | 只有**已通**格；分母 `activeEntities` 来自 ARRL 表（342 个有效实体，已跑数确认 402 实体/342 active） |
| 每波段 `M_b` 汇总 | `t*`、B3/B13 | **部分有** | 同上，但 `totals` 只有全局（`entities/worked/pending/new/slots*`），无 per-band 聚合 | 需加一个 `totals.perBand`（小改）或前端自算 |
| 倍率口径（按波段 / 总计） | B3、B13 | **部分有** | `settings.multPerBand`，[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L359-L362) | 只有 DXCC 一个维度；**WPX 全局前缀口径不存在**（无前缀乘数表） |
| QSO 累计 / 总分 / 分数 | eQSO/hr | 已有（需 N1MM+） | `/api/station/state` 的 `score`，`dynamicresults` 只取 `band=total, mode=ALL`，[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L106-L128) | 只有总计，**没有 per-band**；但 `ΔScore(10min)` 可由此直接取 |
| 历史 rate | 校准 `R_stay` | **部分有** | 前端用 `rateBucketMin/minBuckets` 从 QSO 行自算，[qso-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/qso-page.mjs#L50)、[L329-L358](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/qso-page.mjs#L329-L358) | 服务端无 rate 接口、无小时桶表；行数受 `qsoMax`/`qsoHistoryLimit` 限制 |
| 日志归档 | 跨赛事校准 | **部分有** | `qsos` 全量在库；`retentionQsoDays` 默认 0（不自动删），[maintenance/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/maintenance/service.js#L17) | 无聚合表、无导出归档；“上一场同赛事”只能按 `contestname` 过滤，赛事名靠手填可能不一致 |

### 1.5 台站与规则元数据

| 字段 | 规则 | 状态 | 数据来源（核实位置） | 缺口说明 |
|---|---|---|---|---|
| 当前 VFO 频率 / 模式 | R4/R9/B11、G8 | **部分有** | `RadioInfo` UDP 12060 → `radioState`/`radioStates` → `GET /api/station/state`，[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L85-L104)、[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L1916) | 仅 N1MM+；**无 CAT / rigctld**；多台时 `radios` 按 `radioNr` 存 |
| RUN / S&P 状态 | R1/R2 | 已有（需 N1MM+） | `radio.IsRunning`，同上 | 可直接用，比从 rate 反推更稳 |
| 发射功率 | 路径研判、S&P 基准 | 已有 | `settings.txPowerW`，[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L100-L103) | 可选覆盖；空=按 50 W 假设（[paths.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/analysis/paths.js#L100-L104)） |
| 天线配置 | 频率质量、`τ` | **没有** | 仅 `opAntennaSwitchConfigured/Name`、`opTowerConfigured/Name`（显示用），[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L315-L330)；驱动层明确“无内置协议” [peripherals.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/peripherals.mjs#L1-L11) | 无“波段→天线”映射、无增益/朝向；报告 §1.1 已声明此项不可量化 |
| 赛事类型（CQWW/WPX/ARRL/CQ160…） | G1–G9、B 组 | **没有** | `contestName` 是自由文本（`maxLen 120`），[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L544-L548) | 无法据名称可靠判定规则族；必须新增枚举 |
| 组别 | G 组、`R_stay`/`τ` | **部分有** | `settings.category` ∈ `SO1R/SO2R/MS/MM`，[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L38) | **缺 M2、缺单波段标志、缺功率组别（HP/LP/QRP）**；报告表 1.3 的六行阈值里有三行无法选中 |
| 换波段约束类型与上限 | G4–G6、B6 | **没有** | — | 需新增：时间锁(10 min)/小时配额(8/10/6) + 上限值 |
| 换波段计数器 | G4–G6 | **没有** | — | 可从 `qsos` 波段序列近似；更准需 `RadioInfo` 频点变化。需按小时/按台/整点重置 |
| MS run/mult 台角色 | G2/G3/S3 | **没有** | — | 只能手填 |
| CQ 无应答计数 | R3/R4 | **没有** | 无 CAT、无 N1MM+ 事件 | 只能手填（OP 点一下“无应答”），或等 CAT |
| dupe 占比 | R5 | **部分有** | `GET /api/callsign/check` 单呼号计数，[qso-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/qso-sql.js#L39-L47) | 无“10 分钟窗口聚合”；同样 SQL 加时间条件即可，不必建表 |
| 被迫 QSY / 邻频冲突 | R6 | **没有** | — | 无数据源 |

**汇总**：已有 13 项、部分有 15 项、没有 14 项（按上表行计）。

---

## 2. 补齐方式与代价

分四档，代价按“改动面”而非工时描述。

| 档位 | 内容 | 具体项 | 代价 |
|---|---|---|---|
| **A. 复用/小改** | 不改表，只加聚合或读现有字段 | `totals.perBand`（`M_b`）；10 分钟 QSO 桶接口（基于 `qsos`）；dupe 窗口聚合（`checkCall` 加时间条件）；`scoreState` 取 `ΔScore(10min)`；`radio.IsRunning` 直读；太阳赤纬/高度角（纯数学）；`t*`/`V_b`/eQSO 计算 | 低。都是纯函数 + 一条 SQL，可用 `node --test` 全覆盖 |
| **B. 新建服务/接口** | 新模块、新 DTO，不迁表 | `GET /api/advice`（规则引擎）；CGM 近似（离线表/公式）；NOAA 标度 → 门控因子；`propContinentTable` 扩成“洲×波段分数” | 中。规则引擎本身是纯函数，可完全离线单测 |
| **C. 新建表/字段** | schema 变更 | 赛事配置（类型枚举、功率组、M2、单波段、换波段约束、MS 角色）；换波段计数器（或改为从 QSO 序列实时算，回避建表）；`rate_bucket` 小时聚合表（仅在需要跨赛事校准 `R_stay` 时才建，否则 A 档够用） | 中高。配置项建议并入现有 `contest` 域，计数器优先“实时算”避免状态表 |
| **D. 外部接入** | 本机之外或新协议 | **CAT / rigctld**（脱 N1MM+ 的真实 VFO、模式、发射状态）；**N1MM+ 扩展事件**（CQ 无应答、QSY、被抢频）；天线切换器/旋转器驱动；全量 DX Cluster / RBN 流（若要 spot 类规则） | 高。每一项都是独立适配器；全量 spot 还会显著抬高写入与保留成本 |
| **E. 只能手填/定性** | 不建模 | 天线朝向匹配、频率质量、pileup 深度、操作者疲劳、对手意图（报告 §7 全部） | — 只输出“观察提示”，不出动作 |

---

## 3. 分期方案

### L1：现在就能上（数据已在库，零外部依赖）

**能覆盖的规则**：R1（仅当有 ≥2 个 10 分钟桶）、R2（S&P 基准先用 D 级默认 20–35/hr）、R8、B4、B12、B13，以及 P1 的“环境档位”**只输出不门控**（SFI/SSN/Kp + 赤纬季节）。

**输入契约**

| 字段 | 来源 | 必需 |
|---|---|---|
| `qsos(timestamp, band, mode, points, call, contestname)` | `qsos` 表 | 是 |
| `radioState{radioNr, freqKhz, mode, isRunning}` | 全局 context / `/api/station/state` | R1/R2 需要 |
| `scoreState{qsos, mults, points, score, ts}` | 同上 | eQSO 需要 |
| `settings{grid, category, contestStart, contestEnd, multPerBand, txPowerW, pskWindowMin}` | `/api/settings` | 是 |
| `multipliers`（矩阵行 + per-band 汇总） | 服务层直调，非 HTTP | 是 |
| `paths`（区域×波段 的 CW/SSB 判定） | 服务层直调 | 可选，弱代理 |

**计算层**：新增 `lib/advice/`（纯函数），输入以上快照，输出规则命中。10 分钟桶按 UTC 对齐，与现有墙钟分桶一致。

**输出形式**：`GET /api/advice`，返回
```
{ ok, generatedAt, window:{from,to}, environment:{...}, rules:[
  {id:'R1', action:'evaluate-sp', confidence:'medium', strength:'D',
   evidence:{band:'20m', rb:38, rStay:45, buckets:2}, cooldownSec:600}
], suppressed:[{id, reason:'G1'}] }
```
OP 视图渲染为“建议卡”，与现有 `opRunIdleMin` 的 RUN 空闲提醒**合并**（不要并存两套提醒）。前端模块放 `public/js/op/`，不碰 `public/shared/map/`。

**验证方式**
- `node --test`：用固定 `qsos` 快照（构造 20 条覆盖 3 桶 2 波段）断言 R1/B13/B12 命中与不命中。
- 回放：把历史日志 `timestamp` 截断到某时刻，跑引擎，人工核对 5–10 个决策点。
- 降级：清空 `qsos`，断言返回 `rules: []` + `degraded:'no-qsos'`（对应 P3）。

**明确不做**：任何涉及 spot 密度、MUF、换波段配额的建议。

---

### L2：补数据后能上（本机内，无需外部协议）

**补三块数据**
1. **规则元数据**（C 档）：`contestType`（枚举）、`powerClass`、`singleBand`、`bandChangeRule{type:'time-lock'|'hourly-quota', limit}`、`msRole`、`category` 增加 `M2`。
2. **聚合接口**（A 档）：`/api/rate`（10 min 桶，按波段/按台）、`totals.perBand`。
3. **spot 侧**（D 档的一部分，但仍是“接入公开源”而非硬件）：
   - 方案一（推荐）：另建 `band_activity` 聚合表，只存“每 10 分钟 × 波段 × 是否新 DXCC”的计数，不存原始 spot → 写入可控。
   - 方案二：放开 RBN/DXWatch 的 `monitored` 过滤，只保留 `band/spot_call/dxcc` → 存储压力大，需独立 retention。
   - 前置校验：先确认 PSKR `v2_field` 在本地区的实际流量是否足以支撑“波段活跃度”（**待确认**）。

**能新增的规则**：G 组全部（G1–G9，依赖配置 + 波段序列）、S1/S2/S5/S6、B2/B3/B5/B6/B7、R9/R10/B10/B11（依赖 CGM + 太阳几何）、B8/B9（NOAA 标度已有）。

**输入契约新增**：`contestConfig`、`bandActivity{band, windowStart, newSpots, newMults}`、`cgmLat`、`solarElev{home, dx}`。

**输出形式**：同一 `/api/advice`，`rules[]` 增加 `gatedBy:'G1'` 字段；OP 视图“建议卡”加分组（硬约束/战术/观察）。

**验证方式**
- 规则表驱动测试：每条规则一组 `if/then` 用例，含“G 组否决 R/S/B”的断言。
- spot 侧用录制 30 分钟真实流回放，比对“新乘数 spot 数”与人工数。
- 校准：用自己历史 3 场日志算 `R_stay` 的 25 分位，与默认表对比，偏差 >30% 则改默认值。

**风险**：`band_activity` 的“新乘数”在 WPX 口径下无前缀表（只有 DXCC 表），WPX 场景只能退化为 DXCC 粒度（**待确认**是否以 WPX 为目标赛事）。

---

### L3：依赖外部接入

| 能力 | 接入方式 | 解锁规则 | 验证 |
|---|---|---|---|
| 真实 VFO/模式/发射状态（脱 N1MM+） | CAT（串口/TCP）或 rigctld | R4/R9/B11、G8 | 录包回放 + 手动比对频率 |
| CQ 无应答、QSY、被抢频事件 | N1MM+ 扩展 / CAT 轮询 + 音频静噪代理 | R3/R4/R5/R6 | 现场 30 分钟标注，算准/漏比 |
| 天线切换器、旋转器 | 现有 `peripherals.mjs` 驱动契约 | 频率质量提示 | 只做“显示”，不做决策 |
| 全量 spot 流（若 L2 方案二不可行） | DX Cluster telnet / RBN 全量 | S1/S2/B3 精确化 | 流量与落库量压测 |

**输出形式**：仍走 `/api/advice`，新增 `source:'cat'|'n1mm'` 与 `staleSec`；超过新鲜度阈值自动降级为“观察”。

---

## 4. 与现有三条 API 的关系（避免重复造）

| 现有接口 | 现有职责 | 新模块怎么用 | 明确不做什么 |
|---|---|---|---|
| `GET /api/analysis/paths` | FT8 报告 → 区域×波段 CW/SSB 双向判定；OP 视图已在消费 | **服务层直调** `dx.analysis.pathService`，作为“波段是否开着”的弱证据；不作为“替代波段 eQSO”的唯一依据 | 不新增第二个“可通性”接口；不把 FT8 判定升格为决策结论 |
| `GET /api/multipliers` | `qsos` → DXCC×波段矩阵（new/worked/pending） | 直调 `dx.multipliers.service` 取矩阵与缺口；`M_b` 用新增的 per-band 汇总 | 不重算矩阵、不复制 DXCC 解析（复用 `public/shared/dxcc/callsign.mjs`） |
| `GET /api/callsign/check` | 单呼号重复检查 | R5 用同一 SQL 模式加时间窗聚合 | 不新建 dupe 表 |
| `GET /api/station/state` | N1MM+ radio/score 快照 | 直接消费 `radio.isRunning`、`score` | 不做第二套状态缓存 |
| `GET /api/qsos` | QSO 行 | 规则引擎读 `qsos` 表（服务层），不经 HTTP | 不在前端重算规则 |

**结论**：新模块是“**消费者 + 一层纯函数规则引擎**”，不新建数据采集管线（L2 的 `band_activity` 除外）。

---

## 5. 已核实 / 待确认

**已核实（读码确认）**
1. 空间天气 8 项 = SFI、SSN、KP、DST、BZ、BT、WIND、XRAY；Ap 已采集但不在这 8 项。
2. DXWatch/RBN 入库前按 `monitoredCalls` 过滤；PSKR 额外收本台 4 位大网格。
3. `neighbors` 由触发器维护，但只有 PSKR 记录带 `sender_grid/receiver_grid` → 邻台实际为 PSKR-only。
4. QSO 唯一来源是 N1MM+ UDP 12060/12061/12062；`points` 与 `is_mult` 来自 N1MM+。
5. `category` 仅 `SO1R/SO2R/MS/MM`，无 M2、无功率组别、无单波段。
6. `/api/multipliers` 的 `totals` 无 per-band 汇总；乘数口径仅 DXCC（`multPerBand`）。
7. 服务端无 CGM、无太阳高度角/赤纬实现。
8. `/api/analysis/paths` 为 FT8-only（SQL 硬编码 `comment LIKE 'PSKR FT8%'`）。
9. 无 CAT/rigctld；外设层明确“未配置驱动时不得假装成功”。
10. `retentionQsoDays` 默认 0 → QSO 默认不自动清理。

**待确认（需现场/用户）**
1. 比赛现场是否常驻 N1MM+；若不是，L1 也要先做“无日志降级”文案与手动录入。
2. 目标赛事是否包含 WPX（决定是否需要前缀乘数表）。
3. PSKR `v2_field` 在本地区的实际流量能否支撑波段活跃度。
4. 是否需要 SO2R/M2 双台并行（影响计数器的按台维度）。
5. 是否已有可用的 CAT/rigctld 环境（决定 L3 起点）。
6. `qsos.contestname` 的实际一致性（手填 vs N1MM+ 自动），影响“跨赛事校准”。

---

## 6. 不建议做的事

- 不要把“整点/半点传播”写进规则（报告 §1.4/§8 已否）。
- 不要用 `monitoredCalls` 的 spot 密度冒充“波段 spot 流”，会系统性低估波段活跃度。
- 不要在 L1 就暴露 `t*` 的精确数值给操作者：`M_b` 缺 per-band 汇总、`p̄_b` 依赖 N1MM+ 点值，精度不足时给区间与方向，不给小数。
- 不要为“记录状态”新建 `band_change_counter` 表——优先从 `qsos` 波段序列 + `RadioInfo` 频点实时算，避免跨重启一致性问题。
