# DX-Compass 支撑 M2 / MM 的现状、缺口与落地方案

> 配套文档：
> - [M2/MM 规则硬约束](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/docs/m2-mm-rules-constraints.md)
> - [M2/MM 协作模式与操作流程](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/docs/m2-mm-collaboration-playbook.md)
>
> 代码核对日期：2026-11-11。本文所有“现状”均以仓库代码为准；`docs/contesting-decision-module-feasibility.md` 是早期评估，其中“缺 M2”等结论已被后续实现覆盖，不再作为现状依据。

---

## 0. 结论摘要

### 0.1 一句话现状

DX-Compass **已经具备“多电台状态 + 全局乘数矩阵 + 全局可通性 + 全局规则建议”的骨架**，但**席位身份、分台换波段计数、分席位告警路由**三件事没有打通。当前更适合“单台/双台辅助 + 全局看板”，还不能可靠地当作 M2/MM 的多席位运行系统。

### 0.2 最大的三个风险

| 风险 | 现状 | 后果 |
|---|---|---|
| **席位身份塌缩** | `radioStates` 只用 `radioNr` 做 key（[qsos/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L6-L15)）；N1MM 每个席位的 `RadioNr` 通常都是 1 | MM 六个席位会互相覆盖，只剩一个“电台 1” |
| **QSO 主键冲突** | `qsos.n1mm_id` 是 UNIQUE，写入用 `INSERT OR REPLACE`（[qso-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/qso-sql.js#L5-L19)）；`n1mmId` 直接用 N1MM 的 `ID`（[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L70-L73)、[ingest.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/ingest.js#L37-L42)） | 多个独立 N1MM 实例的 `ID` 会重复，后写入的 QSO 覆盖先写入的 |
| **换波段计数是全局的** | `/api/advice` 的 `seq` 查询不带 `radionr`/`stationname`（[advice-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/advice-sql.js#L63-L64)）；`bandChangeInfo` 对整个序列计变化（[engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L126-L144)） | M2 两台交替记录会被算成“频繁换波段”，8 次配额被误判用完；G6 建议不可信 |

### 0.3 结论的边界

- 本文只评估 **CQ WW / WPX / ARRL DX** 的 M2、MM、MS 支撑；不涵盖 IARU、WAE、CQ 160 等其他规则族。
- “现在就能用”指**不需要改代码**即可使用的能力；“改一点就能用”指**不新增表、或只加少量字段/参数**；“需要新增”指**新表、新接口、新 UI 或新数据源**。

---

## 1. 现有能力核实

### 1.1 组别枚举

**结论：已有 M2，且比早期文档更完整。**

- 组别：`['SO1R', 'SO2R', 'MS', 'M2', 'MM']`（[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L38)）。
- 比赛规则族：`AUTO / CQWW / CQWPX / CQWW_RTTY / ARRL_DX / CQ160 / WAE / IARU / OTHER`（[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L39)）。
- 功率组别：`UNKNOWN / HP / LP / QRP`（[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L40)）。
- 换波段约束：`none / time-lock / hourly-quota`（[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L42)）。
- MS 角色：`none / run / mult`（[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L43)）。
- 设置项：`category`、`powerClass`、`contestSingleBand`、`multMode`、`bandChangeRule`、`bandChangeLimit`、`msRole`（[schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L596-L625)）。

**缺口：** 没有“席位（seat）”这个一等概念；组别只是字符串，不能表达“哪个电台属于哪个席位”。

### 1.2 多电台数据怎么区分

**结论：QSO 层有 `radionr/operator/stationname`，状态层只按 `radioNr` 聚合。**

- `qsos` 表字段：`operator`、`radionr`、`stationname`（[storage/schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/schema.js#L45-L69)）。
- N1MM ContactInfo 解析：`operator`、`radioNr`、`stationName`（[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L70-L93)）。
- N1MM RadioInfo 解析：`radioNr`、`radioName`、`stationName`、`opCall`、`activeRadioNr`（[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L113-L131)）。
- 电台状态写入：`states[radio.radioNr] = radio`（[qsos/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L6-L15)）。
- `/api/station/state` 返回 `{radio, radios, score}`（[qsos/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L46-L51)）。
- UDP 入口：RadioInfo 12060、Contacts 12061、Score 12062（[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L1433)、[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L1458)、[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L1558)、[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L1756)）。

**缺口：**

1. 状态 key 只有 `radioNr`，MM 多席位（每台 N1MM 的 RadioNr 都是 1）会互相覆盖。
2. 没有保存 UDP 来源 IP；当 `stationName` 为空时无法区分席位。
3. `qsos.n1mm_id` 没有席位命名空间，独立实例会撞主键。

### 1.3 OP 视图的席位切换

**结论：MS/MM 有“电台页签”，SO2R 有双 lane，M2 两者都没有。**

- 页面注释：`SO1R / SO2R` 一台或两台同页；`MS / MM` 顶部 station tabs 切换（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L1-L11)）。
- `currentRadioKey()`：只有 `SO2R` 返回 `'all'`（双 lane）；其他组别返回单个 key（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L95-L104)）。
- `renderStationTabs()`：只有 `MS` 或 `MM` 且 `keys.length >= 2` 才显示页签（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L249-L265)）。
- 地图图例：只有 `SO2R` 显示第二条 radio 图例（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L727-L736)）。
- `radioTheme` 只有 r1/r2 两个主题（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L31)、[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L106-L108)）。

**缺口：**

- M2 没有双 lane，也没有页签；默认只显示编号最小的那个电台，第二个信号看不见。
- MM 页签依赖 `radioNr` 多值；如果所有席位都报 `1`，页签不会出现。
- 3–6 号电台没有独立主题色。

### 1.4 乘数矩阵

**结论：已有全局 DXCC × 波段矩阵，且 OP 页已消费；但没有“哪个席位通的”维度。**

- `/api/multipliers` 的 `totals.perBand` 已实现（[multipliers/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/multipliers/service.js#L285-L309)）。
- 矩阵数据只来自 `qsos`，查询列不含 `radionr/stationname`（[qso-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/qso-sql.js#L31-L36)）。
- OP 页有紧凑矩阵与展开（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L491-L524)）。

**缺口：**

- 矩阵是“全队已通”，不能按席位过滤；无法回答“A 席守的波段缺什么、B 席抓了什么”。
- 没有“待通/缺口”的任务分配字段（owner/claimed），矩阵只是结果，不是协作板。

### 1.5 告警

**结论：规则是全局的，推送是广播的，没有席位维度。**

- `alert_rules` 表字段只有呼号/前缀/DXCC/zone/波段/模式/来源/时间/SNR/WPM/负条件/弹窗/语音/声音（[alert-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/alert-sql.js#L13-L48)）。
- 没有 `seat`、`operator`、`radio` 字段。
- 推送是单个 `websocket out` 节点 `Broadcast alerts`，没有 client 过滤（[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L3398-L3408)）。
- 告警规则维护只有 API，没有 UI（与现有约束一致）。

**缺口：**

- 所有席位收到同一条告警；多席位同房间时会出现多个 TTS/弹窗。
- 去重键是 `CALL|band`（全局），没有“席位”维度；无法做到“A 席已提醒过，B 席还需要提醒”。

### 1.6 可通性判断

**结论：全局、按区域 × 波段，和席位无关；这本身是合理的，但无法按席位/波段订阅。**

- `/api/analysis/paths` 用 `settings.myCall` 与 `settings.grid` 建请求（[path-service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/analysis/path-service.js#L28-L61)）。
- 输出是区域聚合与双向判定，不接收 `seat`/`radio` 参数。
- OP 页调用 `fetchPaths` 并展示（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L17)）。

**缺口：**

- 不能按席位“只看本波段/本方向”的切片；所有席位看同一份全量结果。
- 不能把“某席位当前波段”作为可通性查询的过滤条件。

### 1.7 `/api/advice` 与 MS/M2 相关约束

**结论：规则文本已经写了 G1/G2/G3/G4/G5/G6/G9，但执行是“单电台 + 全局计数”。**

已有规则（[rules.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/rules.js#L200-L255)）：

| 规则 | 触发 | 适用 |
|---|---|---|
| **G1/G2** | CQ WW MS 的 10 分钟锁；`time-lock` 时剩余分钟 | CQ WW MS |
| **G3** | `msRole === 'mult'` → 只做 S&P，不得 CQ | CQ WW MS |
| **G4/G5** | 小时配额接近/用尽 | WPX/ARRL MS 型 |
| **G6** | M2 每台配额独立记账 | M2 |
| **G9** | MM 不评估换波段，评估“波段开人” | MM |

执行层的问题：

1. **输入是单电台**：`/api/advice` 只把 `state.radio` 传给引擎（[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L4136-L4140)），`state.radio` 是“最后一次上报的电台”（[qsos/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L6-L9)）。M2 只能看到一台的 `freq/mode/isRunning`。
2. **band change 是全局的**：`seq` 不带席位（[advice-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/advice-sql.js#L63-L64)），`bandChangeInfo` 对整个序列计数（[engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L126-L144)）。
3. **M2 配额是全局的**：`gates.quotaRemaining = limit - ctx.bandChanges.count`（[rules.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/rules.js#L176-L180)），没有分台。
4. **`tau`/`deltaIn` 对 M2 回退到 SO1R**：`cfg.tau[category]` 没有 `M2`，回退 `SO1R=2.0`（[engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L228-L229)），而 M2 的起跑成本应接近 MS（0.3）而不是 SO1R。
5. **cooldown 是全局的**：`global.set('adviceCooldown', ...)`（[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L4140)），A 席看过的建议会抑制 B 席。

**结论：G 组规则“文本正确、执行口径不适用于多席位”。**

---

## 2. 三档：现在就能用 / 改一点就能用 / 需要新增

### 2.1 现在就能用（不改代码）

| 能力 | 怎么用 | 适用 | 注意事项 |
|---|---|---|---|
| 组别选择 | 设置里选 `M2` / `MM` | M2/MM | 组别已存在；但席位未建模 |
| 比赛规则族 | `contestType` 选 `CQWW` / `CQWPX` / `ARRL_DX`；或 `AUTO` 由名称推断 | 全部 | `AUTO` 依赖名称含 `WPX/ARRL/CQ WW` 等关键词 |
| 换波段配额参数 | `bandChangeRule=hourly-quota`、`bandChangeLimit=8/6` | M2 | 当前只作用于全局，作“提醒”可以，作“硬门控”不可靠 |
| 全局乘数矩阵 | `/api/multipliers` + OP 页矩阵 | 全部 | 全队口径，不能分席位 |
| 全局可通性 | OP 页可通性卡片 | 全部 | 全队同一份 |
| 全局告警 | `/api/alert-rules` 建规则 | 全部 | 广播给所有客户端 |
| MM 的“波段开人”提示 | G9 文案 | MM | 只是提示，没有开人模型 |
| QSO 操作员/电台字段 | `qsos.operator/radionr/stationname` | 全部 | 已入库，但 OP 页未按席位消费 |

**现在就能用的推荐姿势：**

1. 先把 DX-Compass 当“**全队共享看板**”，不要当“分席位控制台”。
2. M2 只把 G6/配额当**参考**，真正的配额由 C 席人工台账兜底。
3. MM 只用 G9 做“是否值得开这个波段”的讨论提示，不指望它分配人。
4. 告警只开“全队都需要”的规则（新高价值 DXCC、新 zone），席位专属告警先不要开，避免刷屏。

### 2.2 改一点就能用（不新增表或只加少量字段/参数）

| 能力 | 改动 | 量级 | 依赖 |
|---|---|---|---|
| 席位复合 key | `radioStates` 的 key 改为 `seatId = stationName || ip || ('R'+radioNr)`，或 `stationName + '|' + radioNr` | S | N1MM 上报带 `StationName` |
| QSO 主键命名空间 | `n1mm_id` 入库前拼 `seatId + ':' + ID`；迁移旧数据 | S | 需要 seatId |
| M2 双 lane | `currentRadioKey()` 对 M2 返回 `'all'`；`renderStationTabs()` 纳入 M2；补 3–6 号主题色 | S/M | 席位 key 正确 |
| 分台换波段计数 | `seq` SQL 增加 `radionr/stationname`；`bandChangeInfo` 按席位分组；`gates.perSeat` | M | 席位 key |
| `/api/advice?seat=` | 引擎按 seat 选 radio；cooldown 按 seat；输出 `seat` | M | 席位 key |
| 告警按席位路由 | WS 连接带 `?seat=`；广播节点按 `targetSeat` 过滤；规则加 `seat` 字段；去重键加 seat | M | 席位 key + 前端连接参数 |
| 操作员轮换 | 监听 RadioInfo `OpCall` 变化，写 `operator_sessions`（或先写内存 + API） | S/M | N1MM 会在换人时更新 OpCall（[待验证]） |
| 频率占用表 | 新表 `frequency_claims` 或内存 `global.frequencyClaims`；claim/release API；OP 展示 | M | 席位 key |

### 2.3 需要新增（新表 / 新接口 / 新 UI / 新模型）

| 能力 | 为什么必须新增 | 量级 |
|---|---|---|
| **席位注册表** | 席位不是 `radioNr`；需要 `seat_id / station_name / radio_nr / op_call / last_seen / capabilities` | M |
| **换波段台账（可选）** | 若只做实时提醒，可从 QSO 重算；若要做赛后审计/申诉，需要 `band_change_ledger` | M |
| **乘数任务板** | 现在只有“结果矩阵”，没有 `needed/claimed/worked/owner` 协作状态 | M/L |
| **MM 波段开人模型** | G9 只有文案；需要“波段 eQSO/hr × 人力边际”模型与建议 | M/L |
| **交接/所有权流程** | 需要 `handoff` 事件、频率所有权、确认状态 | M |
| **跨席位冲突检测** | 同波段双信号、同频率、配额临界，需要跨席位实时比较 | M |
| **按席位的乘数归因** | 矩阵查询需要 `radionr/stationname`；用于“谁抓了什么” | S/M |

---

## 3. 五个指定问题的答案

### 3.1 多席位如何接入：每个席位一个 N1MM 实例，还是共用日志的多电台模式？

**推荐：共用一份 N1MM 日志的“网络多机”模式；每个席位一个 N1MM 实例，但都连同一个共享日志。**

理由：

- N1MM 的 ContactInfo 里 `ID` 是**该日志内**的 contact ID；共享日志时 ID 唯一，`qsos.n1mm_id` 不会撞。
- 每个席位仍可上报 `RadioInfo`（`RadioNr` 通常是 1 或 2、`StationName` 区分席位、`OpCall` 区分操作员）。
- 共用日志能保证“同一呼号、同一乘数状态、同一 dupe 检查”，符合 M2/MM 的规则要求。

**接入拓扑：**

```
席位 A N1MM ─┐
席位 B N1MM ─┼─ UDP 12060/12061/12062 ─→ DX-Compass 采集
席位 C N1MM ─┘          （同一台机器或同一广播域）
```

**数据标注入库（建议）：**

| 字段 | 来源 | 用途 |
|---|---|---|
| `seat_id` | `StationName` 优先；空则 `source_ip`；再空则 `R{radioNr}` | 席位主键 |
| `radio_nr` | `RadioInfo.RadioNr` | 席位内的 1/2 号机 |
| `op_call` | `RadioInfo.OpCall` | 操作员轮换 |
| `station_name` | `ContactInfo.StationName` / `RadioInfo.StationName` | 日志归属 |
| `n1mm_id` | `seat_id + ':' + ContactInfo.ID` | 防撞主键 |
| `source_ip` | Node-RED UDP `msg.ip` | 兜底识别 |

**不推荐：每个席位完全独立的 N1MM 日志（各自记各自的）。**

- 会撞 `n1mm_id`（当前 `INSERT OR REPLACE` 直接覆盖）。
- 无法共享 dupe/乘数状态，容易出现“两个人追同一个乘数”。
- 赛后合并日志容易出错，M2 还要求标“哪个发射机”。

**如果必须用独立日志：**

1. 先做 `n1mm_id` 命名空间（`seat_id + ':' + ID`）。
2. 增加 `seat_id` 列或从 `stationname` 派生。
3. 增加“合并后去重”规则：`call + band + timestamp(±1min)`。
4. 明确这是“离线合并”模式，不提供实时共享乘数板。

### 3.2 共享状态放在哪

| 状态 | 现在放哪 | 建议放哪 | 说明 |
|---|---|---|---|
| **乘数看板** | `qsos` 表 + `/api/multipliers` 现算 | 保持全局，不按席位拆 | 乘数是全队资产；可分“谁通的”但不分“是否已通” |
| **band change 计数** | `/api/advice` 每次从全局 `seq` 现算 | **按席位现算**（`radionr`/`stationname` 分组）；可选 `band_change_ledger` | 现算避免状态漂移；台账用于审计 |
| **频率占用** | 没有 | 新表 `frequency_claims` 或内存 `global.frequencyClaims` | 需要 `band/freq/seat/since/until/status` |
| **席位注册** | 没有（只有 `radioStates`） | 新表 `seats` 或 `global.seats` | `seat_id/station_name/radio_nr/op_call/last_seen` |
| **操作员轮换** | 只有 `qsos.operator` 与 `radio.opCall` | `operator_sessions` 表 | 用于赛后统计与 Cabrillo `OPERATORS` |
| **告警去重** | 全局 `CALL|band` | 键加 `seat_id` | 避免 A 席提醒后 B 席不再提醒 |
| **建议 cooldown** | 全局 `adviceCooldown` | 按 `seat_id` 分桶 | A 席 dismiss 不影响 B 席 |

### 3.3 告警与建议如何按席位路由

**现状：** 单 `/ws` 通道 + 单个 `websocket out` 节点广播；所有客户端收到同一条（[flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L3398-L3408)）。

**建议方案（按改动从小到大）：**

1. **连接带席位**
   - 前端连接 `/ws?seat=<seat_id>`；Node-RED 在 WS 连接时记录 `seat`。
   - 广播节点发送前读 `msg.targetSeat`；为空则广播，否则只发给匹配连接。
2. **规则带作用域**
   - `alert_rules` 增加 `seat`（空 = 全队）与 `scope`（`global` / `seat`）。
   - `global` 规则默认**视觉提示**，不默认语音；`seat` 规则才语音/弹窗。
3. **去重带席位**
   - 去重键从 `CALL|band` 改为 `CALL|band|seat`（或 `CALL|band|global`）。
4. **建议按席位**
   - `/api/advice?seat=`：引擎用该席位的 `radio`，`cooldown` 按席位分桶，输出 `seat`。
   - OP 页只请求“本席位”的建议；指挥席请求“全队汇总”（可加 `?seat=all`）。
5. **一个房间一个声音**
   - 即使技术上每条告警都能路由，同房间仍建议只让“语音主控席”出声；其他席位只显示视觉。
   - 这是 [实践]，不是代码必须；但可以做成 `voiceMasterSeat` 设置。

**路由矩阵示例：**

| 告警类型 | 目标 | 语音 | 说明 |
|---|---|---|---|
| 新高价值 DXCC（全队） | all | 仅语音主控 | 避免多席同时响 |
| 本波段新乘数 | 该波段席 + 乘数指挥 | 是 | 与席位强相关 |
| 本台配额剩 1 次 | 该发射席 | 是 | 只提醒当事台 |
| 换波段冲突 | 相关两席 + 指挥 | 是 | 需要立即处理 |
| 操作员轮换提醒 | 该席位 | 否 | 视觉即可 |

### 3.4 操作员轮换怎么记录

**现状：**

- 每条 QSO 有 `operator`（[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L75)）。
- 每次 RadioInfo 有 `opCall`（[n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L123)）。
- 没有 session 表、没有 API、OP 页不显示“当前操作员”。

**建议：**

1. **事件驱动**：每次 `radio` 事件入库时，比较 `opCall` 与该席位上一次的 `opCall`。
   - 不同 → 关闭上一条 session，开新 session。
   - 相同 → 只更新 `last_seen`。
2. **表结构（建议）：**

```sql
CREATE TABLE IF NOT EXISTS operator_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat_id TEXT NOT NULL,
  radio_nr TEXT,
  op_call TEXT NOT NULL,
  from_ts TEXT NOT NULL,
  to_ts TEXT,
  source TEXT
);
```

3. **API：** `GET /api/operator-sessions?seat=&from=&to=`。
4. **UI：** OP 页每个席位标题显示“当前操作员 + 已连续操作时长”；换人时提示“记录轮换”。
5. **Cabrillo：** 导出时生成 `OPERATORS:` 行；M2/MM 的操作员列表来自 session 表，不靠手填。
6. **兜底：** 如果 N1MM 不发送 `OpCall` 变化（[待验证]），提供手动“换人”按钮，写一条 session 事件。

### 3.5 M2 的换波段次数配额如何实时显示与预警

**现状：** 全局计数，M2 两台会互相“污染”；G6 文案正确但数字不可信。

**建议实现：**

1. **数据层**
   - `seq` 查询增加 `radionr`、`stationname`：
     ```sql
     SELECT 'seq', band, timestamp, 1, 0, 0, timestamp, timestamp, radionr, stationname
     FROM qsos WHERE ...
     ```
   - 席位 key：`seat_id = COALESCE(NULLIF(stationname,''), 'R'||radionr)`。
2. **计算层**
   - `bandChangeInfo(seq, now)` 改为按 `seat_id` 分组，产出：
     ```js
     {
       perSeat: {
         "STN-A|1": {count: 3, lastAt: "..."},
         "STN-B|1": {count: 5, lastAt: "..."}
       }
     }
     ```
   - 配额：CQ WW/WPX M2 = 8；ARRL DX M2 = 6；用 `contestType` 选默认，`bandChangeLimit` 可覆盖。
   - 整点重置：按 UTC 00–59 分；用 QSO `timestamp`（UTC）判定。
3. **接口层**
   - `/api/advice` 输出：
     ```json
     "gates": {
       "perSeat": {
         "STN-A|1": {"changes": 3, "quota": 8, "remaining": 5, "warn": false},
         "STN-B|1": {"changes": 7, "quota": 8, "remaining": 1, "warn": true}
       }
     }
     ```
4. **UI 层**
   - M2 双 lane 每 lane 标题显示 `BC 3/8`；剩 1 次变黄，0 次变红。
   - 颜色规则：`remaining > 1` 绿；`remaining === 1` 黄；`remaining === 0` 红。
   - 建议卡 G6 按席位显示：“A 席剩余 1 次，B 席剩余 5 次；不要再让 A 席换波段”。
5. **预警**
   - `remaining === 1`：提示“保留给 P0 乘数”。
   - `remaining === 0`：硬阻止“换波段”建议；如果仍检测到新波段 QSO，提示“已超限，立即停止”。
   - 不要只做“计数器 +1”；每次从 QSO 重算，避免删除/改日志后计数漂移。
6. **性能**
   - 给 `qsos(timestamp)`、`qsos(stationname, timestamp)` 建索引；只查当前小时 + 前一小时边界。
   - `seq` 现在只取最近 3 小时（[advice-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/advice-sql.js#L63-L64)），足够覆盖整点边界。

---

## 4. 缺口清单（含改动量级与优先级）

> 量级定义：
> - **S**：≤1 个模块、<100 行、无表结构变更；
> - **M**：2–4 个模块、100–400 行、可能加 1 个字段/表；
> - **L**：新表 + 新 API + 新 UI/模型，>400 行。

| ID | 缺口 | 现状证据 | 补法 | 量级 | 优先级 | 验收 |
|---|---|---|---|---|---|---|
| **G-01** | `n1mm_id` 跨席位撞主键 | [qso-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/qso-sql.js#L5-L19)、[ingest.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/ingest.js#L37-L42) | 入库前拼 `seat_id + ':' + ID`；迁移旧行 | S | **P0** | 两个实例同 ID 不覆盖；单测覆盖 |
| **G-02** | `radioStates` 只按 `radioNr` | [qsos/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L6-L15) | key 改 `seat_id`；`/api/station/state` 增加 `seats` | S/M | **P0** | MM 六席位都能看到；不再互相覆盖 |
| **G-03** | M2 配额全局计数 | [advice-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/advice-sql.js#L63-L64)、[engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L126-L144) | `seq` 加席位；`bandChangeInfo` 分组；`gates.perSeat` | M | **P0** | 两台交替 QSO 不再误判；配额与 Cabrillo TX 列一致 |
| **G-04** | M2 无双 lane / 无页签 | [op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L95-L104)、[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L249-L265) | M2 走 `'all'`；页签纳入 M2；补 r3–r6 主题 | S/M | **P0** | M2 两个信号同屏可见 |
| **G-05** | `/api/advice` 单电台 | [flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L4136-L4140) | 增加 `?seat=`；按 seat 选 radio；cooldown 分桶 | M | **P0** | 两个席位得到不同 radio/配额建议 |
| **G-06** | 告警全局广播 | [flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L3398-L3408)、[alert-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/alert-sql.js#L13-L48) | WS 连接带 seat；规则加 `seat/scope`；去重键加 seat | M | P1 | 只有目标席位收到语音/弹窗 |
| **G-07** | 无操作员轮换记录 | `qsos.operator` 有，无 session 表 | `operator_sessions` + API + OP 显示 | S/M | P1 | 换人后 OP 显示正确；可导出 OPERATORS |
| **G-08** | 无频率占用 | 无表；R6 标 unavailable（[engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L285-L295)） | `frequency_claims` 或内存 claims + claim/release API | M | P1 | 两席不能同时 claim 同频；OP 可见 |
| **G-09** | 矩阵无席位归因 | [qso-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/qso-sql.js#L31-L36) | 查询加 `radionr/stationname`；矩阵可按席位过滤 | S/M | P2 | 能看“谁通的” |
| **G-10** | G9 只有文案 | [rules.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/rules.js#L212-L217) | 波段 eQSO/hr × 人力边际模型 | M/L | P2 | 输出“开/关某波段”建议及依据 |
| **G-11** | 无交接/所有权 | 无 | 交接事件 + 频率/波段 ownership + 确认 | M | P2 | 交接可追溯；无双信号 |
| **G-12** | 无跨席位冲突检测 | 无 | 同波段/同频/配额临界检测 + 路由告警 | M | P2 | 冲突在 1 个刷新周期内提示 |
| **G-13** | M2 的 `tau/deltaIn` 回退 SO1R | [engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L228-L229) | 增加 `tau.M2`、`deltaIn.M2`（建议接近 MS） | S | P2 | 建议不再按 SO1R 起跑成本算 |
| **G-14** | 文档过时 | 可行性文档仍写“缺 M2” | 更新或在本方案中声明以代码为准 | S | P2 | 不再误导 |

---

## 5. 分阶段实施

### P0：先让“多席位数据不丢、不错”

目标：**两个/六个席位同时上报时，数据不互相覆盖，M2 两台各自看到自己的配额。**

1. G-01 `n1mm_id` 命名空间。
2. G-02 `seat_id` 复合 key（`stationName` → `source_ip` → `R{radioNr}`）。
3. G-03 分席位 band change 计算 + `gates.perSeat`。
4. G-04 M2 双 lane。
5. G-05 `/api/advice?seat=` + per-seat cooldown。

**验收：**

- 两个 N1MM 实例发送相同 `ID`，`qsos` 行数 = 2，不覆盖。
- MM 六个 `StationName` 上报后，`/api/station/state.seats` 有 6 项。
- M2 两台交替 QSO，`perSeat` 计数分别正确；整点重置。
- OP 页 M2 两个 lane 都能看到频率/模式/RUN 状态。
- `npm test` 全绿；新增单测覆盖 ingest 撞键、per-seat 计数、M2 lane。

### P1：让“告警/建议/轮换/频率”按席位工作

1. G-06 WS 席位路由 + 规则 `seat/scope`。
2. G-07 `operator_sessions`。
3. G-08 频率占用 claim/release。

**验收：**

- A 席规则只响 A 席；B 席不重复响。
- 换人后 OP 页显示新 `opCall`；session 表有起止。
- 两席 try claim 同频，第二个被拒绝并提示当前 owner。

### P2：让“协作流程”进入系统

1. G-09 矩阵席位归因。
2. G-10 MM 波段开人模型。
3. G-11 交接/所有权事件。
4. G-12 跨席位冲突检测。
5. G-13 M2 的 `tau/deltaIn`。
6. G-14 文档更新。

**验收：**

- 能回答“这个乘数是谁通的”“这个波段现在值不值得开人”“交接是否完成”。
- 冲突检测在 OP 页可见，且不会误报跨波段正常操作。

---

## 6. 不建议做的事

| 不建议 | 原因 |
|---|---|
| 为每个席位建独立数据库 | 乘数/dupe 是共享资产；拆库会让“已通”状态分裂 |
| 用轮询代替 WS 做席位实时状态 | 现有 OP 定位是秒级/十秒级；轮询会放大延迟与负载 |
| 前端各自计算乘数/配额 | 现有约定是服务端纯函数 + 单一口径；前端重算会出现两套数字 |
| 把所有告警广播给所有席位，再靠人忽略 | 多席位同房间会互相干扰；应在服务端路由 |
| 把 M2 的“乘数台不得 CQ”写进规则引擎 | 这是 CQ WW MS 的规则，不是 M2；会错误限制合法操作 |
| 用 `RadioNr` 作为 MM 席位主键 | N1MM 每个席位通常都报 1；必须用 `StationName`/来源 IP |
| 只做“计数器 +1”的配额 | 删除/修改 QSO 后计数漂移；应按已记录 QSO 重算 |

---

## 7. 证据索引（按文件）

| 文件 | 关键位置 | 说明 |
|---|---|---|
| [schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L38-L43) | L38–L43 | 组别/规则族/功率/换波段/MS 角色枚举 |
| [schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L596-L625) | L596–L625 | contest 域设置项 |
| [storage/schema.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/schema.js#L45-L69) | L45–L69 | `qsos` 表字段 |
| [n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L70-L93) | L70–L93 | ContactInfo 解析（operator/radioNr/stationName） |
| [n1mm.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L113-L131) | L113–L131 | RadioInfo 解析（OpCall/StationName/ActiveRadioNr） |
| [qsos/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L6-L15) | L6–L15 | `radioStates` 按 `radioNr` 写入 |
| [qsos/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L46-L51) | L46–L51 | `/api/station/state` 返回结构 |
| [qso-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/qso-sql.js#L5-L19) | L5–L19 | `INSERT OR REPLACE` + 按 `n1mm_id` 删除 |
| [ingest.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/ingest.js#L37-L42) | L37–L42 | 缺 ID 时的合成 key |
| [op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L95-L104) | L95–L104 | 只有 SO2R 走 `'all'` |
| [op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L249-L265) | L249–L265 | 只有 MS/MM 显示页签 |
| [rules.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/rules.js#L200-L255) | L200–L255 | G1/G2/G3/G4/G5/G6/G9 |
| [engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L126-L144) | L126–L144 | 全局 band change 计数 |
| [engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L228-L229) | L228–L229 | M2 的 tau/deltaIn 回退 SO1R |
| [advice-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/advice-sql.js#L63-L64) | L63–L64 | `seq` 查询不带席位 |
| [alert-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/alert-sql.js#L13-L48) | L13–L48 | `alert_rules` 无 seat 字段 |
| [flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L3398-L3408) | L3398–L3408 | 单节点广播告警 |
| [flow.json](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L4136-L4140) | L4136–L4140 | `/api/advice` 只传 `state.radio` |
| [multipliers/service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/multipliers/service.js#L285-L309) | L285–L309 | `totals.perBand` |
| [path-service.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/analysis/path-service.js#L28-L61) | L28–L61 | 可通性用全局 myCall/grid |

---

## 8. 一句话总结

**DX-Compass 的“看板能力”已经够用，“席位能力”还没建：先修 `seat_id` 与 `n1mm_id`（P0，不修会丢数据），再把换波段计数与建议按席位拆（P0），然后做告警路由、操作员轮换、频率占用（P1），最后才做 MM 开人模型与交接流程（P2）。**
