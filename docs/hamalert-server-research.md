# HamAlert Server 调研报告：可复用于 DX-Compass 的能力评估

- **调研对象**：<https://github.com/hamalert/hamalert-server>
- **调研版本**：`main` @ `cf88c8946afc8daf89bd31474b984e4f47dab9a1`（2026-10-31，`Add User-Agent header when making outbound API requests`）
- **仓库规模**：90 个受版本控制文件、94 次提交、3 位贡献者（Manuel Kasper 61、Jonathan Burns 32、Ian Duncan 1），首次导入 2025-04-22
- **调研方式**：完整浅克隆后逐文件阅读源码与配置，并取消浅克隆以查看提交历史；结论均标注源码文件与行号，不依据 README 推断
- **调研日期**：2026-11-10

> 重要边界：本仓库只是**后端**。用户、触发器的增删改查与前端表单校验在另一个仓库 `hamalert-web` 中，本仓库只消费 `triggers` 集合。因此下文关于"条件模型"的结论来自**匹配器实际接受的条件键**（`config_clean.js`、`matcher.js`）与**写入数据库的触发器文档**，而不是官网 UI 文案。

---

## 0. 结论速览

| 维度 | 判断 | 一句话理由 |
| --- | --- | --- |
| 数据源 | **增量最大，优先做** | 多出 SOTA / POTA / WWFF / IOTA / Club Log DXCC 解析等 DX-Compass 完全没有的源与参考数据 |
| 告警匹配引擎 | **借鉴模型，不要搬代码** | 条件模型设计成熟，但实现绑定 MongoDB + Redis + `roaring` 原生模块 + 多进程 IPC |
| 推送通道 | **只取 Webhook 与 Telnet 集群仿真** | APNs/FCM 需要自建 App 与证书，投入产出比不适合本项目；Webhook 与 VE7CC 输出反而契合比赛场景 |
| 技术栈 | **不建议整体部署** | Node 24 + MongoDB 7 + Redis 7 + PM2 + 6 个 matcher 子进程，相对 DX-Compass 的 Node-RED + SQLite 是数量级的运维增量 |
| 许可证 | **MIT，可商用、可闭源二次分发** | 保留版权与许可声明即可；注意 `package.json` 写的是 ISC，与 `LICENSE` 冲突，以 LICENSE 为准 |
| 明确不建议 | APNs/FCM、Threema、D-STAR 三路抓取、多用户账号体系、旁路部署整套服务 | 与 DX-Compass 的单机单用户定位不匹配，且会造成双份数据链路 |

**最值得做的三件事**（按性价比排序）：

1. 用 SQLite 表 + 纯函数自研"条件组合告警"，条件键直接照搬 HamAlert 的模型（含 `notXxx` 负条件、`hf/vhf/uhf` 伪频段）；
2. 接入 SOTAwatch 与 POTA 两个公开 REST 源 + 本地参考表富化（summit/park 名称、海拔、积分）；
3. 复用 `url_guard.js` 的 SSRF 防护思路做 Webhook 推送，并借鉴 `telnetconn.js` 的 VE7CC 格式把告警喂给 N1MM。

---

## 1. 数据源清单

### 1.1 SPOT / 活动源

| 源 | 接入方式与端点 | 认证 | 轮询/超时 | 关键实现 | 对 DX-Compass 是否增量 |
| --- | --- | --- | --- | --- | --- |
| RBN CW/RTTY | Telnet `telnet.reversebeacon.net:7000` | 连接后写一行呼号登录（配置为 `HB9DQM-4`），无密码 | 180s 无数据即重连；逐行流式 | `rbn.js:28-58`；正则 `rbn.js:8`；伪呼号过滤 `rbn.js:79-83` | 已有 RBN，**源本身非增量**；FT8 独立端口与 quorum 是增量 |
| RBN FT8 | Telnet `telnet.reversebeacon.net:7001` | 同上 | 同上 | `config_clean.js:149-163` | **增量**：独立 FT8 流 |
| DX Cluster（通用） | Telnet `spider.ham-radio-deluxe.com:8000`、`spider.hb9on.net:8000` | 呼号登录行 | 300s 超时重连 | `cluster.js:22-61`；定宽字段解析 `cluster.js:63-113`（用 `latin1` 避免非 ASCII 导致字段错位，`cluster.js:42`） | 与现有 dxwatch 重叠，**价值低** |
| WWFF Cluster | Telnet `spots.wwff.co:7300` | 无登录 | 300s | `config_clean.js:185-197`；`cluster.js:88-96` 自定义 `参考号 模式 注释` 解析 | **增量**：WWFF 活动 SPOT |
| PSKReporter | HTTPS NDJSON 流 `https://stream.pskreporter.info/stream/report?token=<redacted>` | **需要 token**（配置中已脱敏） | 300s 无数据重连，重连间隔 5s | `pskreporter.js:20-66`；过滤 CW/WSPR/FST4W/异常 spotter `pskreporter.js:75-98` | 传输层非增量（DX-Compass 已用 MQTT v2）；**quorum 判定是增量** |
| SOTAwatch | REST `https://api-db2.sota.org.uk/api/spots/50/all/all`，另有 `.../api/spots/epoch` 做廉价变更检测 | 无，仅需 User-Agent | 30s 轮询；5 分钟内有效 | `sotaspots.js:25-53`；`id + SHA-256(内容)` 去重 `sotaspots.js:59-68`；只收 `type === NORMAL` `sotaspots.js:75-78` | **增量** |
| POTA | REST `https://api.pota.app/spot/activator` | 无，仅需 User-Agent | 60s 轮询；5 分钟内有效 | `potaspots.js:25-49`；`spotId + SHA-256` 去重 `potaspots.js:55-63`；从 `locationDesc` 推单州/省 `hamutil.js:5-20` | **增量** |
| D-STAR（三路） | `openquad.net/ics/ics`、`live.ircddb.net:8080/jj3.yaws`、`dstarusers.org/lastheard.php` | 无 | 15s / 15s / 30s 轮询 | `dstar.js`，说明见 README 与 `config_clean.js:210-292` | 与本项目无关，**不建议接** |
| 本地模拟入口 | HTTP `POST http://127.0.0.1:1983/sendSpot` | 仅绑定 127.0.0.1，靠 `user_id` 限定触发器范围 | 按需 | `simulator.js:53-168` | **不建议**（调试用；DX-Compass 有回放机制） |
| 比赛日历 | **不存在** | — | — | 全仓库检索 `contest|calendar|dxsummit|dxwatch` 无匹配 | 无法复用，需另找数据源 |
| DX Summit / dxwatch | **不存在**（只有通用 DX Cluster） | — | — | 同上 | 无增量 |
| 太阳活动/空间天气 | **不存在** | — | — | — | 无增量（DX-Compass 已有传播模块） |

### 1.2 富化与参考数据源（这部分被低估）

| 数据 | 用途 | 获取方式 | 更新节奏 | 关键实现 |
| --- | --- | --- | --- | --- |
| Club Log 前缀库（cty） | 呼号 → DXCC/CQ/ITU/大洲；带生效/失效日期、例外呼号、无效呼号、KG4 特例、`/AM` `/MM` 排除 | `https://cdn.clublog.org/cty.php?api=<key>`，gzip XML | 24h 重载 | `dxcc-lookup.js:23-59`、`61-161` |
| Club Log DXCC 查询 | 单呼号 → DXCC，补 CQ 与大洲 | `https://clublog.org/dxcc?call=&api=&full=1` | 按需，LRU 100k/24h | `clublog.js:38-131` |
| Club Log 最想要榜 | `dxcc + band` → 是否热门实体（`bandslot`） | `https://clublog.org/mostwanted.php?api=1` | 24h | `top-dxcc-filter.js:35-53`（**未被任何模块 require，属死代码**） |
| SOTA 山峰表 | 参考号 → 名称/海拔/积分/激活次数/有效期 | `https://www.sotadata.org.uk/summitslist.csv` | 手工脚本 | `tools/updateSotaSummits.js` |
| WWFF/POTA 公园目录 | 参考号 → 名称/项目/位置 | `http://wwff.co/wwff-data/wwff_directory.csv` | 手工脚本 | `tools/updateWwffParks.js` |
| IOTA 岛屿组 | `AF-001` → 名称/DXCC | `https://www.iota-world.org/.../fulllist.json` | 手工脚本 | `tools/updateIota.js` |
| LotW 活跃用户 | 呼号 → 是否 365 天内上传过 LotW | `https://lotw.arrl.org/lotw-user-activity.csv` | 手工脚本 | `tools/updateLotwUsers.js` |
| eQSL AG 名单 | 呼号 → 是否 AG 成员 | `https://www.eqsl.cc/.../AGMemberList.txt` | 手工脚本 | `tools/updateEqslUsers.js` |
| 美国/加拿大州 | 呼号 → 州/省 | FCC `l_amat.zip`、IC `amateur_delim.zip` | 手工脚本 | `tools/updateStates.js` |
| 静态 DXCC 表 | `前缀 → 名称/大洲/ITU/CQ/DXCC`，341 行制表符分隔 | 随仓库提供 `dxcc.txt` | 静态 | `tools/importDxcc.js:15-59` |

### 1.3 增量结论

**明确是增量、且与 DX-Compass 现有链路不重复的：**

1. **SOTAwatch 活动 SPOT**（含山峰元数据）——竞赛/野外场景有价值，接口无需密钥；
2. **POTA 活动 SPOT**（含公园元数据）——同上；
3. **WWFF Cluster**（`spots.wwff.co:7300`）——纯 Telnet，解析成本低；
4. **IOTA 参考号解析**（从 SPOT 注释里抓 `NA-001` 这类组号并关联名称）；
5. **Club Log 前缀 → DXCC/CQ/ITU 解析能力**（DX-Compass 目前只有 `public/shared/dxcc/entities.json` 用于显示标题，没有"呼号 → 实体"的解析）；
6. **LotW/eQSL QSL 状态标记**（可做"该台是否确认过 QSL"筛选）；
7. **RBN FT8 独立端口 + 多 spotter quorum**；
8. **SPOT 源心跳监控**（`stats.js` 写 `heartbeat` + `tools/spotWatchdog.js` 判 stale）。

**不构成增量的：** 通用 DX Cluster（与 dxwatch 重叠）、PSKReporter 传输层（已有 MQTT v2）、比赛日历（不存在）、太阳活动（不存在）。

**接入礼貌性要求（代码中可见）：** 每个外部请求都带自定义 `User-Agent`（`config_clean.js:5`，且 2026-10-31 的 HEAD 提交专门修了这一点）；RBN/Cluster 用真实呼号登录；Club Log 走带 key 的官方接口而非抓网页。DX-Compass 若接入 SOTA/POTA，应保持同样的 UA 与轮询频率，不要缩短间隔。

---

## 2. 告警匹配引擎

### 2.1 数据模型

触发器文档存放在 MongoDB `triggers` 集合，结构可从三处交叉验证（`seedLocalUser.js:45-75`、`matcher.js:307-363`、`server.js:241-317`）：

```text
trigger {
  _id, user_id,
  disabled: bool,
  internal: bool,              // 系统生成的 "我的呼号被 SPOT" 触发器
  conditions: { <条件键>: 值 | [值...] },
  actions: ['app'|'telnet'|'url'|'threema'|'myspot'|'email'...],
  comment: string,             // 命中后附带的用户备注
  matchCount: number,
  options: { clublog: {...} }  // bandslot 相关
}
```

条件键全集共 **35 个**（`config_clean.js:398-434`）：

| 类别 | 条件键 |
| --- | --- |
| 目标台 | `callsign`、`notCallsign`、`fullCallsign`、`notFullCallsign`、`prefix`、`notPrefix` |
| 区域/实体 | `dxcc`、`callsignDxcc`、`cq`、`itu`、`continent`、`state`、`summitAssociation`、`summitRegion`、`wwffDivision`、`iotaGroupRef`、`bandslot`（`dxcc_band`，配合 Club Log 最想要榜） |
| 发射/接收方 | `spotter`、`notSpotter`、`spotterPrefix`、`spotterDxcc`、`spotterCq`、`spotterContinent`、`spotterState` |
| 频率/模式 | `band`、`mode` |
| 活动 | `summitRef`、`wwffRef`、`qsl` |
| 时间 | `daysOfWeek` |
| D-STAR | `dvEvent`、`dvNode`、`dvReflector`、`dvGroup` |

另有 **10 个区间类条件**不走哈希索引、在精确校验阶段单独判断（`matcher.js:186-223`）：`timeFrom/timeTo`、`speedFrom/speedTo`（CW WPM）、`snrFrom/snrTo`、`summitPointsFrom/To`、`summitActivationsFrom/To`。

派生条件在 `server.js:142-227` 生成，值得借鉴的是：

- **伪频段**：`hf/vhf/uhf/shf/ehf/mf/lf/vlf` 作为 `band` 的附加候选值，用户写 `band: hf` 即可匹配全部短波（`server.js:189-217`）；
- **模块字母可选**：`W4HFH-C` 同时产出 `W4HFH-C` 与 `W4HFH` 两个候选，触发器写哪个都能命中（`server.js:178-187`）；
- **通配候选**：`wwffDivision`、`iotaGroupRef` 追加 `"*"` 作为"任意"候选（`server.js:170-176`）；
- **负条件命名约定**：`notXxx` 去掉前 3 个字符并小写首字母映射到查询字段（`matcher.js:145-147`），实现统一、UI 只需生成 `not` 前缀。

用户侧的辅助模型：

| 集合 | 作用 | 关键字段 |
| --- | --- | --- |
| `users` | 账号与告警开关 | `alerts`、`blockedSpotters[]`、`appTokens[]`、4 类限流配置、`badgeCount` |
| `mutes` | 临时静音某台 | `user_id`、`expires`、`callsign`、`band`、`mode`、`summitRef`，空值表示"不限"（`server.js:290-294`） |
| `spots` | 命中后的告警历史 | `user_id`、`actions`、`triggerComment`、完整 SPOT 字段 |
| `myspots` | "我的呼号被 SPOT" 最新记录 | 按 `callsign` upsert（`server.js:338-340`） |
| `heartbeat` / `stats` | 源心跳与计数 | `lastSeen[source]`、每日 SPOT/告警计数 |

### 2.2 匹配流水线

```text
源事件
  └─ notifySpot()                     server.js:125-140
       └─ normalizeSpot()              server.js:342-472
            · 模式归一（psk*/jt*/msk* 合并）
            · 模式猜测（无模式时按频段/注释猜）modeguesser.js
            · 呼号清洗 + extractCanonicalCallsign + 前缀
            · 频率 → 频段；丢弃 11m(CB)
            · 并发富化：DXCC(俱乐部日志)、spotter DXCC、SOTA/WWFF/IOTA 参考、呼号信息
       └─ runMatcher()                 server.js:142-239
            · 把 SPOT 折叠成条件查询对象
            · 追加伪频段、bandslot、daysOfWeek、user_id
       └─ matcher_client.js            轮询分发给 N 个子进程
       └─ matcher.js doMatch()         85-262
            ① 粗筛：对每个 commonCondition 取 (null 桶 ∪ 命中值桶) 的并集，再全部求交
            ② 精筛：uncommonCondition 逐值 Set 匹配；负条件"任一命中即失败"
            ③ 区间：时间窗、WPM、SNR、SOTA 积分/激活数
            ④ 按 user 聚合 actions / comment / trigger_ids
       └─ runNotifiers()               server.js:261-317
            · "自己呼号"短路 → myspots
            · 限流 4 层 → 写 spots + Redis Stream
            · mutes 查询 → 投递到各 notifier
```

### 2.3 实现要点与可移植性

**粗筛用 RoaringBitmap 倒排索引**：`config_clean.js:436-469` 把 31 个高频条件列为 `commonConditions`；加载时为每个取值建位图，并把"该触发器没有这个条件"记入 `null` 桶（`matcher.js:320-346`）。查询时先取并集再求交（`matcher.js:88-124`）。这个设计对"百万级触发器 × 每秒数千 SPOT"是必要的，对 DX-Compass 的"9 个呼号 + 几十条规则"则是过度设计。

**多进程 + 热重载**：`matcher_client.js:7-37` fork 6 个 matcher，轮询派发；每个子进程每 60s 全量重载 `triggers`（`matcher.js:37-40`）。**注意：`config.matcher.ipcTimeout`（10s）在代码中从未被读取，`matcherClient.match()` 也没有超时回调**（`matcher_client.js:40-53`）——子进程一旦卡住，该 SPOT 的回调永不返回。仓库自带的 `check_pending.sh` 正是用于监控这个"Pending"计数并邮件告警，属于已知运维痛点。

**时间语义存在不一致（借鉴时不要照搬）：**

- `query.time` 是 SPOT 自身的时间字符串，RBN/Cluster 为 **UTC**（`rbn.js:66`、`cluster.js:73-74`），而 PSKReporter 用 `Date.getHours()/getMinutes()` 即**服务器本地时区**（`pskreporter.js:108`）；
- `daysOfWeek` 用 `new Date().getDay()`，也是**服务器本地星期**（`server.js:153`）。

结果是同一套 `timeFrom/timeTo` 触发器在不同来源上表现不一致，跨日/跨时区会错。DX-Compass 已有"UTC 统一"的约定，重写时必须统一为 UTC，并把"星期"显式按用户时区或 UTC 定义。

**限流与去重模型（值得直接借鉴）：** `ratelimit.js:85-220` 实现四层限额——总量、每呼号、每呼号+频段+模式、每呼号+频率+模式，另加"SOTA 独立计数"；频率比较使用容差，CW/SSB 为 0.0004 MHz（400 Hz），数字模式为 0.003 MHz（3 kHz）（`config_clean.js:39-45`）。这比"精确频率相等"更贴近真实去重需求。

**Quorum（多 spotter 确认）**：RBN 与 PSKReporter 各有一份几乎相同的实现，按 `呼号-频段-模式` 缓存窗口内 SPOT，唯一 spotter 数达到阈值才放行（`rbn.js:91-146`、`pskreporter.js:138-188`）；PSKReporter 生产配置为 3 个不同 spotter / 15 分钟（`config_clean.js:199-208`）。这是抑制误报的有效手段，且实现与传输无关，容易移植。

### 2.4 可移植性评估（逐文件）

| 文件 | 依赖 | 可否直接复用 | 说明 |
| --- | --- | --- | --- |
| `prefix-trie.js`（39 行） | 无 | **可以，几乎原样** | 前缀最长匹配，纯数据结构 |
| `hamutil.js:34-55` `extractCanonicalCallsign` | 无 | **可以** | 处理 `/P`、`/MM`、双斜杠；比正则更稳 |
| `hamutil.js:22-32` `formatFrequency` | `sprintf-js` | 可以（去掉依赖即可） | 去尾零的 6 位小数格式 |
| `hamutil.js:5-20` `potaStateFromPark` | 无 | 可以 | 单州/省才覆盖，多州返回 `null` |
| `notify/url_guard.js`（138 行） | `dns`、`net` | **可以** | 完整 SSRF 防护：私有网段、IPv6、NAT64、重定向复用 lookup |
| `tools/spotWatchdog.js:10-34` | 无（纯函数） | 可以 | `staleSources()` / `formatReport()` 与 IO 分离 |
| `modeguesser.js` | 配置注入 | 半可以 | 频段→模式表是 **IARU 2 区（美国）** 划分，中国属 3 区，必须重做表 |
| `ratelimit.js` | `fs`、`exit-hook`、配置 | 半可以 | 核心计数逻辑可移植，dump/restore 可删 |
| `matcher.js` | MongoDB、`roaring` 原生模块、`async`、IPC | **不可以** | 与 Mongo 触发器集合、子进程协议强耦合 |
| `server.js` | Mongo、Redis、全部 notifier | **不可以** | 富化流程可参考，代码不可拆 |
| `sotaspots.js` / `potaspots.js` | axios、Mongo（仅 SOTA 查山峰） | 半可以 | 轮询/去重逻辑简单，但 `potaspots.js:131-133` **在模块加载时自启动**，`server.js:83-85` 又实例化一次，生产环境实际跑了两套 60s POTA 轮询器（自启动那个没有监听者，纯浪费配额） |
| `clublog.js` / `dxcc-lookup.js` | Mongo、axios、`lru-cache`、API Key | 不建议 | 依赖 Club Log API Key；且 `top-dxcc-filter.js` 无人 require，连带 `dxcc-lookup.js` 在本服务中属死代码 |

### 2.5 给 DX-Compass 的模型建议

建议直接采用如下规则模型（存 SQLite，不塞进设置 schema）：

```json
{
  "id": 1, "enabled": true, "name": "EU 20m 新实体",
  "match": {
    "calls": ["DL100ABC"], "notCalls": [],
    "prefixes": ["DL", "DK"], "notPrefixes": [],
    "dxcc": [230], "cq": [14], "itu": [28], "continents": ["EU"],
    "spotterPrefixes": ["BY"], "notSpotters": [],
    "bands": ["20m", "hf"], "modes": ["CW", "SSB"], "sources": ["rbn", "dxwatch"],
    "daysOfWeek": [0, 6], "timeFrom": "22:00", "timeTo": "02:00",
    "minSnr": -10, "maxSnr": 30, "minSpeed": 18
  },
  "actions": { "desktop": true, "sound": true, "webhook": true },
  "cooldownSec": 600, "respectQuietHours": true
}
```

- **匹配实现**：线性扫描即可（规则数 < 100），按 `bands/modes/sources` 先做一层粗筛，再逐条精筛；**不要引入 RoaringBitmap**。
- **时间**：统一 UTC 比较（`timeFrom/timeTo` 允许跨零点，逻辑与 `matcher.js:186-196` 相同）；`daysOfWeek` 明确按 UTC 或按用户设置时区，二选一并写进设置说明。
- **派生字段**：呼号清洗/规范呼号/前缀/DXCC/CQ/ITU/大洲/伪频段，全部在入库 normalize 阶段算好并写入 `spots` 列（现有表已有 `dxcc_sender/dxcc_receiver`，可再补 `prefix/de`），规则求值时零解析。
- **负条件**：保留 `not*` 前缀约定，UI 上展示为"排除"。
- **动作**：分两档——`desktop/sound`（前端，复用现有能力）、`webhook/telegram`（服务端，受静音时段与限流约束）。

---

## 3. 推送通道

| 通道 | 实现文件 | 依赖与凭据 | 自建复杂度 | 对 DX-Compass 的适配度 |
| --- | --- | --- | --- | --- |
| APNs | `notify/apns.js` | `@parse/node-apn`；Apple 开发者账号、APNs Key/TeamID、`org.hamalert.app` 主题 | 高（还要有 iOS App、证书轮换、token 失效处理） | **低**：没有 App，不建议 |
| FCM | `notify/fcm.js` | `firebase-admin` + 服务账号 JSON；Android App | 高（Play 上架、渠道/声音资源） | **低**：同上 |
| 邮件 | `notify/email.js` | `nodemailer` + SMTP | 中 | **可选**，但注意本仓库**生产未启用**（`server.js:9`、`58-59` 均被注释） |
| URL/Webhook | `notify/url.js` + `url_guard.js` | 无第三方依赖，仅 http/https | **低** | **最高**：可直接接 Bark/ntfy/Server酱/飞书/企微机器人 |
| Threema | `notify/threema.js` | `tweetnacl` 端到端加密 + Threema Gateway 付费账号 | 中 | **低**：用户群极小 |
| Telnet（集群仿真） | `notify/telnetsrv.js` + `telnetconn.js` | 纯 `net` + bcrypt 登录 | 中 | **高**：N1MM / 日志软件可直接消费 |
| App 内信息流 | `server.js:319-336`（Redis Stream `spots:<user_id>`）+ `badgeCount` | Redis 7 | 中 | 中：DX-Compass 已有前端实时通道，无需 Redis |

**关键实现细节（值得借鉴）：**

1. **Webhook 三态**：`GET`（查询串）、`POST`（表单）、`POST-JSON`（`notify/url.js:67-77`），一套参数模型覆盖绝大多数机器人接口。
2. **SSRF 防护**：`guardedLookup` 在 DNS 解析后校验目标地址，拦截回环、私有网段、链路本地、CGNAT、文档网段、组播、IPv6 ULA/链路本地，并解包 NAT64 内嵌 IPv4；axios 重定向会复用该 lookup（`url_guard.js:37-135`）。还强制 `proxy:false`，避免校验的是代理而非最终目标（`url.js:61-66`）。
3. **可自定义模板**：用户可设置标题/正文格式，用 `expand-template` 的 `${...}` 占位符填充（`apns.js:44-52`、`fcm.js:46-54`），占位符集合见 `hamutil.js:57-135`。
4. **Telnet 集群仿真**：支持 `set/ve7cc`、`set/json`、`show/dx [N]`（`telnetconn.js:60-113`），并输出三种格式——VE7CC `CC11^...`、JSON、经典定宽 `DX de ...`（`telnetconn.js:193-259`）。这一条对比赛场景很有价值：**把告警当成一个只含"我关心"的 DX Cluster 节点喂给 N1MM**。
5. **投递前静音**：mutes 按 `呼号 + 可选频段/模式/山峰` 组合匹配（`server.js:289-314`），比 DX-Compass 现有"全局静音时段"更细。

**HamAlert 没有的通道**：Telegram、Discord、Slack、ntfy、Bark、企业微信/飞书。若 DX-Compass 要做移动端，**优先走这些现成 HTTP 机器人，而不是 APNs/FCM**。

**自建 vs 第三方的取舍结论：**

- 需要"手机锁屏弹出"时，**自建 App 是错误路径**（双端开发 + 证书 + 商店审核 + token 维护）；用 ntfy/Bark/Telegram Bot 的 HTTP 接口即可，DX-Compass 只需一个 `POST`。
- Webhook 出口必须带：超时（建议 5s）、失败重试（1 次即可）、响应码记录、按规则冷却，以及上文的 SSRF 白名单/黑名单校验。

---

## 4. 技术栈与集成成本

### 4.1 技术栈

| 层 | 技术 | 证据 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 24（`.node-version`、`package.json` `engines`） | `package.json:34-36` |
| 数据库 | MongoDB 7（主存储） | `config_clean.js:25-28`、`package.json` `mongodb ^7.7.0` |
| 缓存/消息 | Redis 7（每用户 SPOT Stream，`spotMaxAge` 1 天） | `config_clean.js:30-37`、`server.js:327-336` |
| HTTP | Express（**仅**本地模拟入口） | `simulator.js:56-63` |
| 进程模型 | 主进程 + `child_process.fork` × 6 matcher，IPC JSON 消息 | `matcher_client.js:7-37`、`config_clean.js:393` |
| 原生依赖 | `roaring`（RoaringBitmap32） | `matcher.js:5` |
| 调度/守护 | PM2（依赖中）、`check_pending.sh` 日志轮询告警 | `package.json`、`check_pending.sh` |
| 测试 | Node 内置 `node --test`，6 个测试文件，均为解析/纯函数级，使用离线 fixture | `test/*.test.js`、`tools/fixtures/` |
| 部署 | 单机（README 明确"designed to run on a single server only"），无 Dockerfile、无 K8s、无 CI 配置 | 仓库文件清单 |

### 4.2 耦合地图

```text
强耦合（不可拆）
  server.js ── Mongo(users/triggers/mutes/spots/callsignInfo/summits/wwffParks/iotaGroups)
            ── Redis(spots:<uid>)
            ── matcher_client ── fork ── matcher.js ── Mongo(triggers/users) + roaring
            ── 全部 notifier（共享 user/spot 文档形状）

弱耦合（可借鉴/可搬运）
  prefix-trie.js、hamutil.js、url_guard.js、modeguesser.js、ratelimit.js
  sotaspots.js、potaspots.js、rbn.js 的 quorum、pskreporter.js 的 quorum
  tools/spotWatchdog.js 的 staleSources()
  telnetconn.js 的三种输出格式
```

### 4.3 三种集成方式的成本与风险

| 方式 | 成本 | 风险 | 结论 |
| --- | --- | --- | --- |
| **A. 直接复用模块代码** | 低（复制 + 改 require） | 中：小模块可接受；`matcher.js`/`server.js` 会引入 Mongo+roaring+子进程，与 Node-RED 运行时冲突 | **仅限小模块**：`prefix-trie`、`url_guard`、`hamutil` 的三个函数、`dxcc.txt` |
| **B. 只借鉴模型自研** | 中（1 个 `lib/alerts/` 模块 + 1 张表 + 设置项） | 低：无新进程、无新数据库、无新凭据 | **主路径** |
| **C. 旁路部署整套 HamAlert** | 高（Mongo + Redis + 用户体系 + 订阅源凭据） | 高：SPOT 双份抓取、告警双份投递、两套用户/权限、运维面翻倍 | **不建议** |

补充：若真想"直接用"，更现实的是**只接 HamAlert 的公开网站/App 服务**，但本仓库没有对外 REST API（只有 127.0.0.1 的模拟入口），因此不存在"调它的接口拿结果"这条捷径。

---

## 5. 许可证

| 项 | 结论 |
| --- | --- |
| 仓库根 `LICENSE` | **MIT License**，`Copyright (c) 2025 HamAlert` |
| `package.json` `"license"` | **ISC**（与 LICENSE 冲突，属元数据瑕疵） |
| 以哪个为准 | 以仓库根 `LICENSE` 文件为准，按 **MIT** 合规；引用时建议在文件头保留 `Copyright (c) 2025 HamAlert` 与 MIT 全文 |
| 商用 | **允许** |
| 闭源二次分发 | **允许**（MIT 无 copyleft，不要求开放衍生源码） |
| 义务 | 在所有副本/实质性部分中保留版权声明与许可声明；软件按"现状"提供，无担保 |
| 依赖许可 | 以 MIT/Apache-2.0/ISC 为主；其中 `mongodb`、`firebase-admin`、`roaring` 为 Apache-2.0，再分发时需保留其 NOTICE；具体以 `package-lock.json` 为准 |
| **数据许可（易被忽略）** | 代码是 MIT，**不代表数据可自由再分发**。SOTA/WWFF/IOTA/POTA/Club Log/LotW/eQSL 各有自己的使用条款；`dxcc.txt` 为仓库内静态表，可随 MIT 使用，但其中的实体/前缀划分属于公开事实数据。接入前应逐一核对这些站点对"缓存/再展示"的要求 |
| 商标 | MIT **不授予** "HamAlert" 名称、Logo、`org.hamalert.app` 标识的使用权，不要在自己的产品中暗示关联或背书 |

---

## 6. 明确的取舍建议

### 6.1 值得直接复用（复制代码 / 数据，保留 MIT 声明）

| # | 对象 | 理由 | DX-Compass 改动面 |
| --- | --- | --- | --- |
| A1 | `prefix-trie.js` | 39 行、零依赖、最长前缀匹配正确；DX-Compass 目前没有前缀匹配能力 | 新增 `lib/alerts/prefix-trie.js`（或 `lib/radio/prefix-trie.js`） |
| A2 | `notify/url_guard.js` | 成熟的 SSRF 防护，含 IPv6/NAT64/重定向；自研容易漏 | 新增 `lib/alerts/url-guard.js`；仅 Webhook 出口使用 |
| A3 | `hamutil.extractCanonicalCallsign` / `formatFrequency` / `potaStateFromPark` | 纯函数，边界处理（`/P`、`/MM`、双斜杠、多州）已验证 | 合并进 `lib/spots/normalize.js` 与 `lib/radio/` |
| A4 | `dxcc.txt`（341 行前缀表） | 现成的 `前缀 → 名称/大洲/ITU/CQ/DXCC` 种子数据 | 新增 SQLite 表 `dxcc_entities` 或 `public/shared/dxcc/prefixes.json`；导入脚本放 `scripts/` |
| A5 | `tools/spotWatchdog.js` 的 `staleSources()/formatReport()` | 纯函数、有单测；可直接用于"源无数据"告警 | 新增 `lib/alerts/source-watchdog.js`，由 `lib/maintenance/service.js` 定时调用并写日志/前端状态 |

> 复制时的最小改动：把 `require('../config_loader')` 换成入参、去掉 `fs`/`exit-hook` 持久化、把 CommonJS 保持为 CommonJS（本项目 `lib/` 即 CommonJS）。

### 6.2 值得借鉴设计（自己实现）

| # | 设计 | 理由 | DX-Compass 改动面 |
| --- | --- | --- | --- |
| B1 | 条件模型（35 键 + `not*` + 伪频段 `hf/vhf/uhf` + `bandslot`） | 直接覆盖你列的"按模式/波段/呼号/区域/来源筛选"，且已被真实用户验证 | 新表 `alert_rules`（`lib/storage/schema.js` 幂等建表）；新 `lib/storage/alert-sql.js`；新 `lib/alerts/match.js` 纯函数；`flow.json` 在 SPOT 入库后新增评估 function 节点 |
| B2 | 两段式匹配（粗筛倒排 + 精筛区间） | 结构清晰，但 DX-Compass 规模小，用 Map 分桶即可，无需 roaring | 同上，纯函数即可 |
| B3 | 四层限流 + 频率容差（400 Hz / 3 kHz） | 有效解决"同一台连续 SPOT 刷屏" | `lib/alerts/cooldown.js`；设置项 `alertCooldownSec`、`alertFreqToleranceHz` |
| B4 | mute 模型（呼号 + 可选频段/模式/山峰 + 过期时间） | 比"全局静音时段"更精细，可做成"静音此台 30 分钟"按钮 | 新表 `alert_mutes`；前端告警条目增加"静音"操作；复用 `public/shared/monitoring/quiet-hours.mjs` 做全局兜底 |
| B5 | SPOT 富化流水线（DXCC / SOTA / WWFF / IOTA，`id + 内容哈希` 去重） | 富化后告警条件才能按"区域/山峰/公园"筛；哈希去重能捕获"编辑过的 SPOT" | 新源模块 `lib/spots/sources/{sota,pota,wwff}.js` 或 `flow.json` 新增 `http request` + `function` 节点；新表 `sota_summits`、`pota_parks`、`iota_groups`；`spots` 增列 `summit_ref/park_ref/iota_ref` |
| B6 | Quorum（N 个不同 spotter / 窗口） | 抑制单点误报，且与传输无关 | `lib/alerts/quorum.js`，在 SPOT 入库前调用；设置项 `quorumSpotters`、`quorumWindowMin` |
| B7 | Telnet 集群仿真（VE7CC / JSON / 定宽） | 让 N1MM 等日志软件直接消费"只看我关心的" SPOT，比赛场景价值高于手机推送 | 新增 `lib/alerts/telnet-server.js`（`net` 模块）；端口与开关进 `public/shared/settings/schema.js` 的 `data` 域；需注意与现有 5758 端口的部署说明 |
| B8 | 用户自定义标题/正文模板（占位符） | Webhook/Telegram 消息可读性提升明显，实现只是字符串替换 | `lib/alerts/template.js`；设置项 `alertTitleTpl`、`alertBodyTpl`（string，`maxLen` 限制） |
| B9 | 源心跳 + 看门狗 | 上游断流时能第一时间知道，而不是"地图空了才排查" | 现有 `lib/maintenance/service.js` 增加心跳表/字段；前端"数据源状态"小标签；设置项 `sourceStaleMin` |
| B10 | `myspot` 内部触发器 | "我的呼号被 SPOT"是独立语义，与普通规则分开可避免重复告警 | 现有 `myCall` 已存在，评估器里内置一条内部规则即可，无需新表 |
| B11 | 每个 SPOT 附加 `spotter` 维度条件 | 支持"只被我附近的台 SPOT"这类需求，与现有邻台表天然契合 | 复用 `neighbors` 表与 `sender_grid/receiver_grid`；规则增加 `spotterPrefixes/notSpotters` |

> 破坏性提醒：`public/shared/settings/schema.js` 的 `type` **只有** `enum|bool|int|number|string|color|datetime|time|intMap|colorMap|enumArray`（`schema.js:9-12`），**没有对象/数组类型**，且 `DOMAINS` 固定 6 个（`schema.js:57-64`）。因此：
> - **规则列表必须存 SQLite + 独立 API**，不要塞进设置；
> - 通道开关/URL/冷却等标量配置放进现有 `data` 域（其描述本来就是 "Data & Alerts"），避免新增第 7 个域导致设置页结构改动；
> - 新增键需同步 11 种语言的 i18n 键（`public/shared/core/i18n.mjs`），并按现有约定做键集合一致性校验。

### 6.3 不建议采用

| # | 对象 | 理由 |
| --- | --- | --- |
| C1 | APNs / FCM | 需要自建 iOS/Android App、证书、商店账号与 token 生命周期管理；用 ntfy/Bark/Telegram 的 HTTP 接口即可达到"手机提醒"目的 |
| C2 | Threema | 付费网关 + 端到端加密，用户群与中文场景不匹配 |
| C3 | MongoDB + Redis + 6 个 fork 的 matcher | 与 Node-RED + SQLite 单机架构冲突；为一个告警功能引入两套数据库不划算 |
| C4 | D-STAR 三路抓取与反射器目录 | 与 DX-Compass 的 HF/竞赛定位无关，且维护成本高（HTML 抓取 + 反射器差异 + WebSocket-only 个例） |
| C5 | 依赖 Club Log API Key 的在线查询 | 需要申请 key，且属于外部配额；可用离线 `cty.dat` / `dxcc.txt` 替代 |
| C6 | 邮件通道 | 在 HamAlert 生产环境本身就是禁用状态（`server.js:9,58-59` 注释）；SMTP 配置与退信处理成本高于收益 |
| C7 | 多用户 / 账号 / 计费 | DX-Compass 是单机单用户面板，引入账号体系会牵动设置、存储、权限全部设计 |
| C8 | 直接搬 `matcher.js` 进 Node-RED function 节点 | Node-RED function 节点无法可靠加载原生 `roaring`、无法 fork 子进程、也不应持有 Mongo 连接 |
| C9 | `potaspots.js` 的"模块加载即自启动"写法 | 现有代码已因此产生双份轮询；自研时必须是显式 `start()`/`stop()` |

---

## 7. 建议的落地路线（如需实施）

| 阶段 | 内容 | 改动面 |
| --- | --- | --- |
| 1（低成本、高收益） | 条件组合告警 + 桌面/声音 + Webhook | `lib/storage/schema.js`（`alert_rules`/`alert_mutes`）、`lib/storage/alert-sql.js`、`lib/alerts/{match,cooldown,template,url-guard}.js`、`flow.json` 新增评估节点、`schema.js` `data` 域 4-6 个键、`i18n.mjs` 键、设置页"数据与告警"分组 |
| 2（数据增量） | SOTAwatch + POTA 接入与富化；WWFF Cluster 可选 | `lib/spots/sources/`、参考表导入脚本、`spots` 增列、告警条件增加 `summitRef/parkRef`、设置项轮询开关 |
| 3（差异化） | VE7CC Telnet 告警源 + Telegram/Bark 推送 | `lib/alerts/telnet-server.js`、`net` 监听端口配置、通道设置项、部署文档 |

每阶段建议保留现有的"静音时段"作为总闸，并让告警评估复用 `lib/logger` 的日志级别，便于线上排查。

---

## 8. 来源与关键文件索引

### 8.1 上游链接（固定到调研提交，便于复核）

- 仓库：<https://github.com/hamalert/hamalert-server/tree/cf88c8946afc8daf89bd31474b984e4f47dab9a1>
- 匹配器：[matcher.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/matcher.js#L85-L262)
- 编辑器与服务装配：[server.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/server.js#L142-L317)
- 条件全集/公共条件/各源配置：[config_clean.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/config_clean.js#L398-L469)
- RBN：[rbn.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/rbn.js#L60-L146)
- DX Cluster：[cluster.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/cluster.js#L63-L113)
- PSKReporter：[pskreporter.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/pskreporter.js#L68-L188)
- SOTA：[sotaspots.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/sotaspots.js#L25-L158)
- POTA：[potaspots.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/potaspots.js#L51-L133)
- 限流：[ratelimit.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/ratelimit.js#L85-L220)
- Webhook + SSRF：[url.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/notify/url.js#L31-L83)、[url_guard.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/notify/url_guard.js#L37-L135)
- Telnet 仿真：[telnetconn.js](https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/notify/telnetconn.js#L60-L259)
- 许可证：<https://github.com/hamalert/hamalert-server/blob/cf88c8946afc8daf89bd31474b984e4f47dab9a1/LICENSE>

### 8.2 本次阅读的仓库内文件（相对克隆根目录）

`README.md`、`LOCAL_DEV.md`、`LICENSE`、`package.json`、`config_clean.js`、`config_loader.js`、`server.js`、`matcher.js`、`matcher_client.js`、`prefix-trie.js`、`hamutil.js`、`modeguesser.js`、`ratelimit.js`、`rbn.js`、`cluster.js`、`pskreporter.js`、`sotaspots.js`、`potaspots.js`、`clublog.js`、`dxcc-lookup.js`、`top-dxcc-filter.js`、`stats.js`、`limitlog.js`、`matchlog.js`、`simulator.js`、`dxcc.txt`、`check_pending.sh`、`notify/*.js`、`tools/seedLocalUser.js`、`tools/testMatcher.js`、`tools/spotWatchdog.js`、`tools/importDxcc.js`、`tools/update*.js`、`test/*.test.js`

### 8.3 DX-Compass 侧的对照依据

- 设置 schema 类型与域：`public/shared/settings/schema.js:9-12`、`33`、`57-64`
- 存储建表与 SQL 生成：`lib/storage/schema.js:1-60`、`lib/storage/spot-sql.js:5-48`、`lib/storage/index.js`
- SPOT 归一化（现有模式映射，无 DXCC/前缀）：`lib/spots/normalize.js:9-55`
- 静音时段实现：`public/shared/monitoring/quiet-hours.mjs`
- 告警/日志级别约定：`lib/logger.js`

---

## 9. 未能验证的事项

1. **触发器编辑器的字段与校验**在 `hamalert-web` 仓库，本仓库只消费 `triggers` 文档；本报告的条件模型以匹配器实际接受的键为准，但不保证官网 UI 暴露了全部条件（例如 `DSTAR_CATCHALL` 那种"仅 mode = dstar"的触发器，`tools/seedLocalUser.js:6-9` 明确说是网页触发器编辑器**故意不允许**的）。
2. **各上游服务官方的速率/配额条款**：代码只能证明轮询间隔与超时（SOTA 30s、POTA 60s、D-STAR 15–30s、Club Log 24h 缓存），不能替代对这些站点服务条款的核对。
3. **PSKReporter token 的申请流程**与 Club Log API Key 的配额：仓库中均已脱敏，无法从代码确认。
4. **未运行服务**：本地栈需要 Docker + MongoDB + Redis + 推送凭据，本次仅做静态源码阅读；因此没有实测吞吐、内存占用或告警端到端时延。
5. **未评估 `hamalert-app` / `hamalert-web` 两个仓库**，手机 App 的推送能力只按服务端代码推断。
