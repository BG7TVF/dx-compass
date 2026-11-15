# DX-Compass 官方设备 JSON 通信协议（v1.0）

- 适用设备：天线切换器（1×n）、矩阵切换器（m×n）、铁塔升降控制器、多波段 BPF 组、驻波表。
- 文档定位：今后 DX-Compass 官方硬件开发的**唯一标准依据**。硬件按本文实现即可接入本站；站点实现变更时先改本文，再改硬件。
- 对齐基线：DX-Compass v2.1.0 工作区，2026-11-15。
- 可执行契约：JSON Schema（draft 2020-12）与本文同目录交付，清单见附录 B。

> 阅读顺序：§0（标准与兼容边界）→ §1（总则）→ §2（传输）→ §3（数值与时间）→ §4（兼容策略）→ §5（上线与心跳）→ 按设备读 §6–§10 → §11（错误码）→ **§12（安全边界，验收否决项）** → §13（接入现状）。

---

## 0. 标准依据与兼容边界

### 0.1 引用标准

| 标准 | 版本 | 本文用在哪 |
|---|---|---|
| RFC 8259 · JSON 数据交换格式 | 2017-12 | §3.1 语法约束、§3.2 数值表示、禁止 `NaN`/`Infinity`、字符串转义 |
| OASIS MQTT | 3.1.1（OASIS Standard, 2014-10-29） | §2.2 版本选择、QoS、retain、§2.3 LWT 与掉线检测、§2.4 主题通配符禁令 |
| OASIS MQTT | 5.0（OASIS Standard, 2019-03-07） | §2.2 仅说明"可选支持、不得依赖其特性" |
| RFC 9110 · HTTP 语义 | 2022-06 | §2.5 方法与状态码、§2.6 幂等性、§11.2 错误码映射 |
| JSON Schema | draft 2020-12 | 附录 B，`docs/schema/*.schema.json` |
| ISO 8601 / RFC 3339 | ISO 8601-1:2019；RFC 3339 §5.6 | §3.3 时间格式（UTC，`Z` 结尾，毫秒三位） |
| IEC 60027-2 / SI 词头 | — | §3.4 单位（Hz、W、dB、℃） |
| IEEE 754 binary64 | 2019 | §3.2 浮点精度、安全整数范围 |

### 0.2 标注约定

| 标注 | 含义 |
|---|---|
| **【实现】** | 从现有代码反推的事实，服务端与硬件必须逐字一致 |
| **【沿用 AMP1000】** | 国赫 AMP1000 已在生产运行，其字段名与语义是既成事实，**不得修改**；新设备按原文继承 |
| **【标准】** | 本文新增的约定（服务端尚未实现或仅部分实现），需评审确认 |
| **【新设备】** | 只对 5 类官方新设备生效；AMP1000 不适用 |
| **【禁止】** | 出于机械与射频安全不允许远程触发的动作 |

### 0.3 与 AMP1000 的兼容边界（硬约束）

AMP1000 已在生产运行，下列字段**一个都不能改**；新设备沿用同一套命名与语义，只是把"功放专属"换成"设备类专属"。

| 项 | AMP1000 现状（【沿用 AMP1000】） | 新设备（【新设备】） |
|---|---|---|
| 信封字段 | `msg_id`、`cmd`、`timestamp`、`data` | 同上，另加可选 `proto`、`ts` |
| `cmd` 取值 | `remote_control` | 同值，不新增 `cmd` 变体 |
| 主题 | `amplifier/device/{device_id}/{heartbeat\|json_command}` | `{class}/device/{device_id}/{...}`，结构不变 |
| 时间 | `timestamp` = **Unix 秒**（整数） | `timestamp` 照旧必带（兼容老解析器），另加 `ts` = ISO 8601 UTC |
| 上报语义 | 完整快照，缺字段即 null/false | 同 |
| 下发语义 | delta，未提供字段保持原值 | 同 |
| `device_id` | 载荷内必须等于主题键 | 同 |
| `data.result` | `ok` / `error`；`error` 帧被整帧丢弃 | 同 |
| 字段命名 | `snake_case`（如 `current_voltage`、`out_fwd_power`） | 同，不改成 camelCase |
| `device_class` | **没有**（靠主题前缀识别） | 新增（冗余，便于抓包归属） |

> 结论：本文所有"命名规范"都是对 AMP1000 既有命名的**归纳**，不是重新设计。凡与 AMP1000 冲突的写法一律按 AMP1000 为准。

### 0.4 术语

| 术语 | 含义 |
|---|---|
| 快照（snapshot） | 设备当前完整状态；上报用 |
| 增量（delta） | 只含变化字段；下发用（`amp-link.js:6-13`） |
| 回读（readback） | 设备回报的真实机械状态，是"已切换"的唯一证据 |
| 互锁（interlock） | 发射中禁止天线/矩阵切换的保护（`commands.js:250-287`） |
| 看门狗（watchdog） | 1500 ms 未续期即断开塔输出（`tower-hold.js:134-155`） |
| 席位（seat） | 操作员身份，指令必带 `X-DX-Seat` |

---

## 1. 总则

### 1.1 设备类与端口模型

端口不单独建表，由设备类型 + 实例配置即时派生（`lib/devices/rf.js:75-139`）。

| 设备类 | `type` | 射频端口（方形） | 控制口（圆形） | 状态口（圆形） | 本文档 |
|---|---|---|---|---|---|
| 天线切换器 | `switch` | `in` + `ant1…antN` | `relay` | `position` | §6 |
| 矩阵切换器 | `matrix` | `in1…inN` + `out1…outM` | `relay` | `route` | §7 |
| 铁塔升降控制器 | `tower` | 不接射频 | `relay` | `limit` | §8 |
| 多波段 BPF 组 | `bpf` | `in` + `out` | 无 | 无 | §9 |
| 驻波表 | `swr` | `in` + `out` | `report` | `status` | §10 |

派生规则：

- 切换器：`in` 是电台侧 COMMON，`ant1…antN` 是天线侧出口；`N = config.out_count`，取值 1–16，缺省 2（`rf.js:17,97-104`）。
- 矩阵：`in1…inN` 输入、`out1…outM` 输出；`N=in_count`（缺省 2）、`M=out_count`（缺省 4），各 1–16（`rf.js:105-116`、`model.js:237-248`）。
- 天线/假负载只有 `in`；驻波表、BPF 为串联环节，`in`/`out` 各一（`rf.js:86-96`）。
- BPF 必须显式配置 `bands`，否则保存报 `bpf-band-required`（`model.js:561-562`）；波段 `^\d{1,3}m$`，最多 16 个（`model.js:18-20,95-110`）。
- 端口键只允许 `[A-Za-z0-9:_-]{1,32}`（`rf.js:15`）。

### 1.2 两种接入档

| 档 | 传输 | 服务端现状 | 用途 |
|---|---|---|---|
| **A 档（标准）** | MQTT JSON，与 AMP1000 同族 | 仅功放 `amp` 已实现（`amp-link.js`）；其余 5 类需新增 driver（§13.2） | 官方设备协议主体，必须实现 |
| **B 档（兼容）** | HTTP JSON：`relay` 控制、`report` 遥测、`tx` 发射状态 | **已实现并在运行**（`relay.js`、`service.js`、`tx.js`） | 现版本唯一能"接上就动"的最小集合 |

结论：

1. 只做 A 档的硬件，在 §13.2 的 G1–G9 完成前，服务端无法驱动（表现为"未接入/无状态源"）。
2. 只做 B 档的硬件，今天就能被切换、能上报限位与在线状态，但没有回读，只能显示"未验证"。
3. 官方硬件目标形态：**A 档为协议主体，B 档为最小兼容面**。两档映射见 §6.3、§7.3、§8.3、§9.3、§10.3。

### 1.3 三条不可协商的规则

1. **上报是快照，下发是增量。** 设备 → 服务端的 `data` 是完整状态（缺字段即 null/false，整帧替换，`runtime.js:44-107`）；服务端 → 设备的 `data` 是 delta（`amp-link.js:6-13`）。
2. **服务端是唯一状态源。** 没上报就是 `unknown`，绝不补"看起来合理"的值（`runtime.js:3-9`、`service.js:90-112`）。
3. **只有回读确认的通路才参与 RF 可达与互锁。** 只写型号永远不写 `ports`；服务端只认 `state="verified"` 的 `ports`（`switch-link.js:395-405`、`service.js:352-359`）。未确认时互锁保守覆盖全部端口（`rf.js:469-557`）。

### 1.4 对齐基线

| 模块 | 被引用的关键事实 |
|---|---|
| `amp-link.js` | 帧结构、主题、`cmd`、delta、`device_id` 校验、`result=error` 掉帧、QoS 0、心跳去重 |
| `rf.js` | 端口派生、波段剪枝、TX 可达、互锁范围 |
| `model.js` | `config` 白名单与长度限制、端口数 1–16 |
| `control.js` | 直连 / 串口服务器寻址 |
| `switch-link.js` | pending / verified / unverified / stale 状态机 |
| `commands.js` | 指令唯一入口、租约、互锁、错误码、审计 |
| `tower-hold.js` | 500 ms 心跳、1500 ms 看门狗、1000 ms 换向间隔 |
| `tower.js` | 二态模型、限位 NO/NC、运行超时 |
| `tx.js` | `source_id` + `tx_active`、健康度、超时降级 |
| `relay.js` | 干接点 HTTP 契约、2 s 超时 |
| `service.js` | `/api/devices` 快照、`report`/`tx` 入口、10 s 在线阈值 |
| `flow.json` | 三个 HTTP 路由 |

## 2. 传输与主题

### 2.1 连接方式

官方设备一律作为 **MQTT 客户端**主动连站内 broker，服务端作为另一个 MQTT 客户端发布/订阅。理由与 AMP1000 一致：

- 服务端只认 `device_id`，不需要知道设备 IP，也不做扫描发现；
- 设备可放在 NAT 后，现场不需要固定 IP；
- 断线由 broker 的连接状态与 LWT 反映，不依赖"最后一次上报时间"。

【实现】功放的连接参数（`amp-link.js:652-665`）：

| 项 | 服务端取值 | 硬件要求 |
|---|---|---|
| MQTT 版本 | 3.1.1（`protocolVersion: 4`） | 必须支持 3.1.1 |
| `clean session` | `true` | 允许 `clean session = true` |
| `clientId` | `dxc-<设备记录 id>` | 设备用自己的 clientId 即可 |
| `connectTimeout` | 5000 ms | 连接超时 ≤ 10 s |
| `reconnectPeriod` | 5000 ms | 自动重连 ≤ 10 s |
| `keepalive` | 60 s | ≤ 60 s |
| QoS | 0（发布与订阅） | 必须支持 QoS 0 |
| retain | 心跳/指令**不用** | 心跳/指令不得 retain |

> QoS 0 是刻意的：状态有下一帧覆盖，重发只会放大乱序。设备不得因 QoS 0 自行"多条重发"，用新 `seq` 覆盖即可。

### 2.2 MQTT 版本选择

| 版本 | 结论 | 理由 |
|---|---|---|
| **3.1.1（OASIS Standard）** | **必须支持** | 服务端 MQTT 客户端固定 `protocolVersion: 4`（`amp-link.js:659`）；现网 broker 已按此验证 |
| 5.0（OASIS Standard） | 可选，**不得依赖** | 若 broker 与固件都支持可启用，但协议不得使用 5.0 专有特性（Reason Code、Message Expiry、Shared Subscription、User Properties），否则降级到 3.1.1 即失效 |

明确不用的 3.1.1 特性：

- 不使用持久会话（`clean session = true`）；因此**不依赖 broker 补发离线消息**。
- 不使用保留消息承载状态（例外：§2.3 的 `/status` LWT，明确 `retain=true`）。
- 不使用通配符发布（`+`、`#` 只允许出现在服务端订阅侧，见 §2.4）。

### 2.3 QoS、retain 与 LWT

| 消息 | QoS | retain | 说明 |
|---|---|---|---|
| `heartbeat` | 0 | false | 下一帧可覆盖 |
| `json_command` | 0 | false | 设备重连后不补发 |
| `status`（LWT） | 0 | **true** | 唯一允许 retain 的主题 |

LWT 用法（MQTT 3.1.1 §3.1.2.5）：设备在 CONNECT 报文里注册遗嘱，broker 在**非正常断开**（网络中断、掉电、keepalive 超时）时代发。

```json
{
  "topic": "switch/device/SW-A/status",
  "payload": "{\"online\":false,\"device_id\":\"SW-A\",\"reason\":\"lwt\",\"ts\":\"2026-11-15T06:50:00.000Z\"}",
  "qos": 0,
  "retain": true
}
```

上线后立即向同一主题发布 `{"online":true,...}`，同样 `retain=true`。**必须用独立主题**：若把 LWT 挂在 `heartbeat` 上并 retain，新连上的服务端会读到一帧过期快照，被当成当前状态。

掉线检测的三层机制（从快到慢）：

| 层 | 机制 | 时延 | 服务端现状 |
|---|---|---|---|
| 1 | TCP/MQTT 连接断开 | 即时 | 功放已用（`amp-link.js:694-697`） |
| 2 | LWT retained `online=false` | keepalive 1.5×（默认 90 s） | 【待落地】G6 |
| 3 | 最近上报超时 | 塔/驻波表 10 s；TX 源 2 s | 已实现（`service.js:46`、`tx.js:41-54`） |

【标准】keepalive 用 60 s：既能满足 90 s 内发现掉电，也不会因链路抖动误判断线。

### 2.4 主题命名规范

结构（与功放同构，`amp-link.js:97-103`）：

```
{topic_prefix}/{device_id}/heartbeat       设备 → 服务端：状态快照、ack
{topic_prefix}/{device_id}/json_command    服务端 → 设备：控制增量
{topic_prefix}/{device_id}/status          设备 → 服务端：LWT 在线状态（retain）
```

`topic_prefix` 缺省值：

| 设备类 | 缺省 `topic_prefix` | heartbeat 示例 |
|---|---|---|
| 切换器 | `switch/device` | `switch/device/SW-A/heartbeat` |
| 矩阵 | `matrix/device` | `matrix/device/MX-A/heartbeat` |
| 铁塔 | `tower/device` | `tower/device/TW-A/heartbeat` |
| BPF | `bpf/device` | `bpf/device/BPF-A/heartbeat` |
| 驻波表 | `swr/device` | `swr/device/SWR-A/heartbeat` |
| 功放（既有） | `amplifier/device` | `amplifier/device/AMP1000-A/heartbeat` |

主题约束：

| 规则 | 说明 |
|---|---|
| `topic_prefix` 是**前缀** | 服务端拼 `prefix + '/' + device_id + '/' + 动作`；固件不要重复拼 `device_id` |
| `device_id` 必须单段 | ≤100 字符；禁止 `/`、`+`、`#`、空格、空串（`model.js:49-52`） |
| 禁止通配符发布 | 固件不得向含 `+`/`#` 的主题发布 |
| 主题大小写敏感 | `device_id` 大小写必须与站内配置逐字一致 |
| 单设备单主题 | 一台设备只用一个 `device_id`；多台设备不得共用一个 |

### 2.5 HTTP（B 档）语义

B 档按 RFC 9110 描述：

| 端点 | 方法 | 语义（RFC 9110） | 成功码 | 幂等 |
|---|---|---|---|---|
| `POST /api/devices/:id/command` | POST | 创建一次控制动作（非幂等） | 202 Accepted | 否 |
| `POST /api/devices/report` | POST | 提交一次遥测（非幂等，但同值重复无副作用） | 200 OK | 否（语义上收敛） |
| `POST /api/devices/tx` | POST | 提交一次发射状态（非幂等） | 200 OK | 否（`seq` 提供去重） |
| `POST <relay_url>` | POST | 干接点动作（非幂等；`pulse` 重复会产生两次脉冲） | 200–299 | 否 |
| `GET /api/devices` | GET | 只读快照（安全且幂等，RFC 9110 §9.2.1/9.2.2） | 200 OK | 是 |

- **202 只表示"已受理，未完成"**（RFC 9110 §15.3.3）。真正的完成证据是设备回读（§6.4）。
- 请求体必须是 `application/json`，UTF-8；响应体同理（`flow.json` 显式设置 `content-type`）。
- 不使用 `PUT`/`PATCH`/`DELETE`：本项目所有写操作都是"提交一个动作或一帧数据"，语义上是 POST。
- 401/403/404/409/423/501/502/504 的用法见 §11.2。

### 2.6 幂等性与重试

| 场景 | 规则 |
|---|---|
| HTTP POST 重试 | 仅可对**连接失败**（无响应）重试；收到 4xx 不得重试 |
| `select` / `switch` 重复下发 | 目标相同则收敛（设备重复执行同一目标不产生额外物理动作）；不同目标按新指令执行 |
| 塔 `hold` 重复 | 视为续期，**不得重复吸合**（`tower-hold.js:74-87`） |
| 设备侧去重 | 同一 `msg_id` 重复收到只执行一次（至少保留最近 16 条的 `msg_id` 环形缓存）【标准】 |
| TX 上报去重 | 由 `seq` 单调保证；`seq <= 上次` 服务端返回 200 `ignored:"stale-seq"` 且不更新（`tx.js:102-114`） |
| 继电器 `pulse` | 天然非幂等；服务端不重试（`relay.js:72-99`） |

> 为什么设备还要按 `msg_id` 去重：QoS 0 不会重复，但现场可能存在桥接、抓包重放或上层重试。设备侧去重是最后一道保险。

### 2.7 寻址方式

| 形态 | 地址来源 | 适用 |
|---|---|---|
| **官方设备（推荐）** | `config.host` + `config.port` = **broker 地址**；`config.device_id` = 主题键 | A 档 |
| 老设备直连 | `config.host` + `config.port` = 设备自身 IP:端口 | 各品牌 TCP 驱动（帧格式未证实，见 §13.5） |
| 经串口服务器 | 控制连线连到串口服务器 `serialN`，地址与串口参数继承服务器配置 | RS-232/485 老设备（`control.js:164-214`） |

对官方设备的要求：

- **必须支持直连 broker**；不要求固定 IP、不要求端口映射。
- **不要求**实现串口/串口服务器转发。官方形态是网络设备，现场不要为它加串口服务器。
- **不需要**在设备侧保存站内拓扑、席位、租约等任何站点信息。
- 一台设备只允许一个控制入口（broker），不允许多个上位机直连设备私有端口。

> 【实现】现实约束：切换器/矩阵只要选了具体品牌型号，服务端就走该型号的 TCP 地址解析（`switch-link.js:432-438`），`host/port` 会被当成设备 IP；选"其他"则退回 `relay`，只认 `relay_url`。所以 A 档官方切换器必须在型号描述表里新增独立条目（§13.2 G1），否则 `host/port` 语义与 broker 冲突。

---

## 3. 报文格式与数值规范

### 3.1 JSON 语法（RFC 8259）

所有报文必须满足 RFC 8259，额外约束：

| 约束 | 要求 | 依据 |
|---|---|---|
| 编码 | UTF-8，不带 BOM | RFC 8259 §8.1 |
| 顶层类型 | **必须是 object**，禁止数组、字符串、数字 | RFC 8259 §2；服务端会丢弃数组（`amp-link.js:619`） |
| 注释 | 禁止 | RFC 8259 §2 |
| 尾随逗号 | 禁止 | RFC 8259 §4 |
| 重复键 | 禁止（同一对象内键唯一） | RFC 8259 §4 |
| `NaN` / `Infinity` / `-Infinity` | **禁止**（JSON 无此字面量） | RFC 8259 §6 |
| 控制字符 | 必须转义（`\u00XX`） | RFC 8259 §7 |
| 字符串编码 | 非 ASCII（如中文天线名）可直接 UTF-8，也可 `\uXXXX` | RFC 8259 §8.2 |
| 数字前导零 / 前导 `+` | 禁止（`01`、`+1` 非法） | RFC 8259 §6 |

服务端对非法 JSON 的行为是**静默忽略**（`amp-link.js:613-618`），不会回错误。因此固件必须在上报前做一次序列化自检。

### 3.2 数值表示

| 类型 | 规则 |
|---|---|
| 整数 | 必须落在 IEEE 754 安全整数范围 ±(2^53−1) = ±9007199254740991；本协议所有整数实际都 ≤ 1.3×10⁹（频率 Hz） |
| 计数类（`*_count`、`position`、`seq`） | 用整数，禁止 `2.0` 这种写法 |
| 浮点 | 最多 **3 位小数**；不使用指数记法（`1e3`）；不写 `-0` |
| 精度约定 | 功率 0.1 W；驻波比 0.01；温度 0.1 ℃；频率整数 Hz；角度 0.1° |
| 比较 | 浮点按 `|a−b| ≤ 1e-3` 判定相等，禁止用 `===` 比浮点 |
| 未知值 | 用 `null`，**禁止**用 `-1`、`0`、`9999` 当哨兵值 |
| `swr` | 无量纲；无 RF 时 `null`；不得用 `0` 表示无穷大 |
| 比率/百分比 | 本协议不传百分比，统一传物理量（W、℃、dB） |

> 数值统一按"物理量 + 单位"传，单位见 §3.4；固件内部的 ADC 码值、dBm、传感器原始值必须在设备侧换算完毕再上报。

### 3.3 时间（ISO 8601 / RFC 3339）

| 字段 | 类型 | 格式 | 归属 |
|---|---|---|---|
| `ts` | string | `YYYY-MM-DDTHH:MM:SS.sssZ`（UTC，毫秒三位，`Z` 结尾） | 【新设备】必带，标准时间 |
| `timestamp` | number | Unix 秒（10 位整数） | 【沿用 AMP1000】必带；服务端原样存为 `amp_ts`（`amp-link.js:632`） |

规则：

1. 两个字段必须表达**同一时刻**，允许 ±1 s 误差。
2. 新设备以 `ts` 为准；`timestamp` 仅为兼容老解析器保留。服务端新 driver 解析 `ts`，`timestamp` 只做一致性校验。
3. 统一 UTC，**禁止** `+08:00` 偏移写法与本地时间。
4. 设备时钟未同步时，用"开机单调计时 + 首次 NTP/SNTP 结果"折算；无法折算时 `ts` 取设备当前已知时间，但 `uptime_ms` 必须真实。
5. 精度：毫秒。亚毫秒不传。

示例：

```json
{"msg_id":"sw-a-0101","cmd":"remote_control",
 "timestamp":1794724800,"ts":"2026-11-15T06:40:00.000Z",
 "data":{"device_id":"SW-A"}}
```

> `1794724800` 与 `2026-11-15T06:40:00.000Z` 对应同一秒，仅作示例；实际报文两者必须一致。

### 3.4 单位

| 物理量 | 单位 | 符号 | 字段示例 | 说明 |
|---|---|---|---|---|
| 频率 | 赫兹 | Hz | `freq_hz` / `work_freq` | 一律整数 Hz，不传 kHz/MHz |
| 功率 | 瓦特 | W | `fwd_power_w`、`out_fwd_power` | 有效值/峰值由 `pep` 标注 |
| 增益 / 损耗 | 分贝 | dB | `insertion_loss_db` | 功率比 10·log₁₀ |
| 驻波比 | 无量纲 | — | `swr` | 1.00 = 全匹配 |
| 温度 | 摄氏度 | ℃ | `temperature_c` | 有符号，允许负值 |
| 时间间隔 | 毫秒 | ms | `hold_ms`、`uptime_ms` | 整数 |
| 电压 / 电流 | 伏特 / 安培 | V / A | `current_voltage` | 【沿用 AMP1000】原样继承 |

**dBm 与 W 的换算**（若设备内部用 dBm，必须换算后上报 W）：

```
P(W)  = 10^((P(dBm) − 30) / 10)
P(dBm) = 10·log10(P(W) / 1mW) = 10·log10(P(W)) + 30
```

- 0 dBm = 1 mW；30 dBm = 1 W；60 dBm = 1 kW。
- 换算后按 0.1 W 四舍五入；**不得**同时上报 dBm 与 W 两个字段造成歧义。
- 本文所有功率字段一律用 W 命名并带 `_w` 后缀（`out_fwd_power` 为【沿用 AMP1000】的历史命名，单位同样是 W，`amp-link.js:154-160`）。

### 3.5 字段命名与类型

| 规则 | 说明 |
|---|---|
| 命名 | `snake_case`，全小写；与现有实现一致（`current_voltage`、`out_swr`、`work_freq`） |
| 布尔 | 必须是 JSON `true`/`false`；**禁止** `0`/`1`/`"true"`（服务端严格 `=== true`，`amp-link.js:144-165`） |
| 空值 | 用 `null`；**禁止**空字符串代替数值缺失（字符串型字段例外，如 `error: ""`） |
| 数组 | 空即 `[]`，不传 `null` |
| 对象 | `ports` 允许 `null` 值表达"该端口未知" |
| 单位后缀 | 新字段带单位后缀（`_w`、`_hz`、`_c`、`_ms`、`_db`、`_a`）；无单位字段不加 |
| 布尔前缀 | 用 `is_`/`has_` 可选；本协议沿用 `tx_active`、`rf_detected` 这类形容词式命名 |

### 3.6 报文大小与字段必填

| 项 | 值 | 说明 |
|---|---|---|
| 单条 PUBLISH 上限 | **8192 字节**（UTF-8 编码后） | 【标准】超限接收方整帧丢弃并记日志 |
| 建议心跳大小 | ≤ 2048 字节 | 含 `antennas` 时可能接近上限 |
| `antennas[]` 上限 | 16 项；每项 `name` ≤ 60 字符 | 与端口数上限一致 |
| 字段策略 | 见下表 | — |

三档字段策略（每类设备的表头会标 `必填` 列）：

| 档 | 含义 | 接收方行为 |
|---|---|---|
| **必填** | 缺失即整帧非法 | 丢弃该帧，保持上一状态并标 `stale` |
| **可选** | 缺失按缺省值 | 用表里的"缺省行为"列 |
| **只读** | 只能由设备上报，服务端下发时应忽略 | 收到即忽略，不报错 |

### 3.7 枚举扩展规则

所有枚举（`state`、`error`、`fault`、`mode`、`direction`）按"开放枚举"处理：

1. 接收方**必须**把不认识的枚举值当作 `unknown`（或忽略该字段），**不得崩溃、不得拒绝整帧**。
2. 发送方新增枚举值前，必须在本文登记，并把 `proto` 的 minor 版本 +1。
3. 枚举值只用小写 `snake_case` 或短横线短语（如 `tx-active`、`limit-conflict`），**不使用无含义数字**。
4. 状态位图（`fault_word`）按位定义，未知位一律保留并在界面显示原始值。

---

## 4. 兼容性策略

### 4.1 协议版本字段

| 字段 | 类型 | 格式 | 必填 | 说明 |
|---|---|---|---|---|
| `proto` | string | `<major>.<minor>`，如 `"1.0"` | 可选 | 缺失等同 `"1.0"`（兼容 AMP1000 无版本字段） |

接收规则：

| 情形 | 行为 |
|---|---|
| major 相同、minor ≥ 自身 | 正常处理，忽略未知字段与未知枚举 |
| major 相同、minor < 自身 | 正常处理，缺失字段按缺省值 |
| **major 不同** | 拒绝处理：设备回 `error="proto-unsupported"`；服务端把该帧记为不支持版本并提示升级 |

### 4.2 版本类字段

| 字段 | 适用 | 说明 |
|---|---|---|
| `firmware_version` | 全部 | 固件版本字符串（`1.0.3`） |
| `software_version` | 全部（可选） | 上位软件/应用层版本；AMP1000 已用同名字段（`amp-link.js:165-166`） |
| `hardware_version` | 【新设备】可选 | 硬件修订号（`revB`） |
| `serial` | 【新设备】可选 | 设备序列号，用于现场对号 |
| `boot_id` | 【新设备】必填 | 每次上电/复位变化；用于识别重启与重置 `seq` |

### 4.3 未知字段：接收方必须忽略

- 服务端解析器**不得**因为出现未知字段而拒绝整帧（现有 `normalizeAmp` 就是逐字段取值，未知字段天然被忽略，`amp-link.js:125-168`）。
- 设备同样必须忽略服务端下发的未知字段（例如未来新增的只读配置）。
- 未知字段可以被转发/记录，但不得参与控制决策。

### 4.4 字段废弃流程

三步，至少跨一个 minor 版本：

1. **标记**：本文把字段标为"废弃（deprecated）"，并在 `proto` minor +1；服务端开始同时接受新旧字段。
2. **双发**：设备在过渡期同时上报旧字段与新字段（值必须一致）；服务端优先用新字段。
3. **删除**：下一个 major 版本删除旧字段，文档同步移除。

任何"直接改语义"的做法都禁止——语义变更按不兼容变更处理（§4.5）。

### 4.5 不兼容变更 = 升主版本

| 变更 | 版本动作 |
|---|---|
| 新增可选字段 / 新增枚举值 / 新增设备类 | minor +1 |
| 新增必填字段、删除字段、改字段语义/单位/符号 | **major +1** |
| 改主题结构、改 `cmd` 取值、改 QoS/retain 策略 | **major +1** |
| 改安全边界（§12） | **major +1**，且必须重新验收 |

升级流程：文档升版 → 服务端先支持双版本 → 固件升级 → 旧版本至少保留一个现场周期（建议 ≥ 30 天）→ 下线旧版本。过渡期内服务端必须能同时解析两个 major。

## 5. 上线与心跳

### 5.1 信封字段

| 字段 | 类型 | 必填 | 约束 | 缺省行为 |
|---|---|---|---|---|
| `msg_id` | string | 必填 | 1–64，`[A-Za-z0-9._:-]` | 服务端下发格式 `dxc-<36进制毫秒>-<8位随机>`（`amp-link.js:963-968`）；设备自定，建议全局唯一 |
| `cmd` | string | 必填 | 固定 `remote_control` | 【实现】服务端允许省略，省略按 `remote_control`（`amp-link.js:620`） |
| `timestamp` | number | 必填 | Unix **秒**，10 位整数 | 【沿用 AMP1000】原样存 `amp_ts`（`amp-link.js:632`） |
| `ts` | string | 设备上行必填 | ISO 8601 UTC，`Z` 结尾，毫秒三位 | 缺失时服务端回退用 `timestamp`；新 driver 必须优先用 `ts` |
| `proto` | string | 可选 | `<major>.<minor>` | 缺失等同 `"1.0"` |
| `data` | object | 必填 | 非空、非数组 | 数组或缺失 → 整帧丢弃（`amp-link.js:619-622`） |

服务端下发的完整形态：

```json
{
  "msg_id": "dxc-m7k2p1-a1b2c3d4",
  "cmd": "remote_control",
  "timestamp": 1794724800,
  "ts": "2026-11-15T06:40:00.000Z",
  "proto": "1.0",
  "data": { "device_id": "SW-A", "ports": { "in": "ant3" } }
}
```

> **当前实现的下行报文**只有 `msg_id` / `cmd` / `timestamp` / `data` 四个字段（`amp-link.js:958-961`），**不带 `ts` 与 `proto`**。上面的 `ts`/`proto` 是 G10 完成后补齐的目标形态。设备解析必须同时接受"有 `ts`"与"无 `ts`"两种下发，不得把缺失当非法；缺失时用帧到达时间兜底。

### 5.2 上报是完整快照

来自 `normalizeAmp` 与 `runtime.record` 的实际行为：

1. 未出现的数值字段 = `null`（不是保留旧值）。
2. 未出现的布尔字段 = `false`。
3. 未出现的字符串字段 = `""`。
4. 未出现的数组字段 = `[]`。
5. `alarm_word` / `fault_word` 类位图缺失 = 0，即"无告警"。

所以设备**不要省字段**：不需要的字段也照常上报（该 null 就 null），否则服务端会显示成未知/无。

例外：`ports` 按键增量合并（`switch-link.js:395-405`）。矩阵可只报变化的输入；清空某输入用 `null`。

### 5.3 下发是增量

服务端 `data` 只含本次要改的字段。设备必须：未出现的字段保持当前值，不得复位。

只读字段（`model`、`serial`、`firmware_version`、`boot_id`、`device_class`）**不接受**下发，收到应忽略。

### 5.4 通用状态字段（5 类新设备共用）

各设备章节只列**专属**字段；完整快照 = §5.4 ∪ 该节专属字段。

| 字段 | 类型 | 必填 | 范围 | 缺省行为 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | 必填 | ≤100，单段 | — | 必须等于主题中的 `device_id`，否则整帧丢弃（`amp-link.js:624-625`） |
| `device_class` | string | 必填 | `switch`/`matrix`/`tower`/`bpf`/`swr` | 按主题前缀推断 | 开放枚举 |
| `model` | string | 必填 | ≤100 | `""` | 型号 |
| `serial` | string | 可选 | ≤64 | `""` | 序列号 |
| `firmware_version` | string | 必填 | ≤32 | `""` | 固件版本 |
| `software_version` | string | 可选 | ≤32 | `""` | 应用层版本 |
| `hardware_version` | string | 可选 | ≤32 | `""` | 硬件修订 |
| `boot_id` | string | 必填 | ≤32 | — | 每次上电/复位必须变化 |
| `uptime_ms` | number | 必填 | 0–2^32−1 | 0 | 自本次上电起算 |
| `seq` | number | 必填（见 §5.6） | 1–4294967295 | — | 单调 +1，不回绕 |
| `state` | string | 必填 | 见 §11.3 | `unknown` | 开放枚举 |
| `result` | string | 可选 | `ok`/`error` | `ok` | ack 帧必带 |
| `ack_msg_id` | string | 可选 | 1–64 | `""` | 回应哪条下发 |
| `error` | string | 可选 | 见 §11.1 | `""` | 机器可读错误码 |
| `error_detail` | string | 可选 | ≤200 | `""` | 人读补充，不参与决策 |
| `fault_word` | number | 可选 | uint32 | 0 | 位图见 §11.4 |
| `temperature_c` | number | 可选 | -40–125，有符号 | `null` | 设备内部温度 |

### 5.5 启动序列

1. 连 broker，注册 LWT（§2.3）。
2. 本地自检：读机械位置、限位电平、继电器状态；读不到记未知，**不得猜测**。
3. 向 `status` 发布 online。
4. 向 `heartbeat` 发布**首帧完整快照**：`state="init"` 或 `"idle"`，`boot_id` 为新值，`uptime_ms` 接近 0，位置类字段按实测（读不到即 `null`）。
5. 进入 §5.7 周期心跳。

【禁止】启动时自动"恢复"断电前的射频通路。射频类设备必须以安全态起步并如实上报实际位置（§12.3）。

### 5.6 序号与去重

| 项 | 规则 | 依据 |
|---|---|---|
| `seq` 起点 | 从 1 开始，单调 +1，uint32 不回绕 | 【标准】 |
| 服务端去重 | `report` 路径：`seq <= 上次` 直接返回 `ignored:"stale-seq"` 且**不记录** | `service.js:808-816` |
| 重启 | **必须持久化 `seq`**；做不到时重启后首帧起**省略 `seq`**（服务端缺失时不判 stale） | `service.js:809-816`、`runtime.js:61` |
| `msg_id` | 仅用于 ack 关联与设备侧去重，不参与服务端去重 | 【标准】 |
| 设备侧去重 | 同一 `msg_id` 只执行一次，保留最近 16 条环形缓存 | 【标准】 |

> 这个坑真实存在：设备断电后 `seq` 从 1 重来，服务端会一直丢弃，直到 `seq` 超过断电前的值。所以要么持久化，要么重启后不带 `seq`。

### 5.7 心跳节奏

| 设备类 | 变化时 | 无变化时 | 服务端在线判定 | 依据 |
|---|---|---|---|---|
| 功放（对照） | 立即发 | 可长期静默 | MQTT 连接本身 | `amp-link.js:14-17` |
| 切换器 / 矩阵 | 立即发 | 每 5 s 保活 | 连接 + 最近回读 | 【标准】 |
| 铁塔 | 立即发（尤其限位变化） | **每 1 s** | 最近上报 > 10 s 判离线 | `service.js:46,394-400` |
| BPF | 立即发 | 每 5 s | 最近上报 > 10 s | 【标准】 |
| 驻波表 | 立即发（发射起止必须即时） | **每 1 s** | 最近上报 > 10 s；TX 源另按 `timeout_ms` | `service.js:46`、`tx.js:41-54` |

保活帧允许裁剪到：`device_id`、`device_class`、`seq`、`uptime_ms`、`state`、`ts`、`timestamp`。**铁塔与驻波表不要裁剪限位/发射字段**，其超时判定以整帧为准。

### 5.8 去重

- 内容与上一帧完全相同且距上一帧 < 保活间隔 → 不发。
- 内容有任何变化 → 立即发，不受间隔限制。
- 保活帧不参与"内容相同"判断，必须按间隔发。
- 发射起止（`tx_active` 翻转）与限位变化属于"变化"，必须立即发。

### 5.9 服务端在线判定对照

| 设备类 | 判定依据 | 超时/阈值 | 显示 |
|---|---|---|---|
| 功放 | `amp_connected`（MQTT 连接） | — | `online` / `offline`（带 `error`） |
| 切换器 / 矩阵 | `state.online` + 最近回读 | 无硬超时；只写型号永远 `unverified` | `online` / `unverified` / `awaiting` / `offline` |
| 铁塔 | `last_report_ms` | 10 s | `offline`（保留 `last_state`） |
| 驻波表 / 通用 | `last_report_ms` | 10 s | `online` / `offline` |
| TX 源 | `last_seen_ms` | `timeout_ms`（缺省 2000 ms）→ `stale`；3× → `offline` | `ok` / `stale` / `offline` |

### 5.10 ack 帧

【标准】设备收到 `json_command` 后 **500 ms 内**回一帧 ack 到 `heartbeat`，**只带 ack 字段、不带状态**：

```json
{"msg_id":"sw-a-ack-0007","cmd":"remote_control",
 "timestamp":1794724801,"ts":"2026-11-15T06:40:01.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","result":"ok",
         "ack_msg_id":"dxc-m7k2p1-a1b2c3d4","seq":42}}
```

失败时：

```json
{"msg_id":"sw-a-ack-0008","cmd":"remote_control",
 "timestamp":1794724801,"ts":"2026-11-15T06:40:01.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","result":"error",
         "ack_msg_id":"dxc-m7k2p1-a1b2c3d4","error":"tx-active",
         "error_detail":"fwd_power=620W","seq":43}}
```

【实现】服务端当前对 `data.result === "error"` 的帧**整帧丢弃**（不写状态、不判离线，`amp-link.js:626`）。因此：

- ack 帧**不能替代**状态帧，下一次周期快照仍必须发真实状态；
- 但 ack 必须发——它是唯一能证明"设备看到指令"的证据。

## 6. 天线切换器（1×n）

### 6.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `switch` |
| 端口 | `in` + `ant1…antN`，`N = out_count`（1–16，缺省 2） |
| 上行 | `switch/device/{device_id}/heartbeat` |
| 下行 | `switch/device/{device_id}/json_command` |
| LWT | `switch/device/{device_id}/status`（retain） |
| 控制口 / 状态口 | `relay` / `position` |
| 单帧上限 | 8192 字节；建议 ≤2048 字节 |
| Schema | `docs/schema/heartbeat-switch.schema.json`、`command-switch.schema.json` |

### 6.2 状态上报字段（专属）

与 §5.4 通用字段合并后即完整快照。

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `out_count` | number | 必填 | 路 | 1–16 | 无符号 | 必须与实际出口数一致；服务端据此校验 `antN` |
| `position` | number | 必填 | 口序 | 1–N 或 `null` | 无符号 | `null` = 位置未知；**禁止**用 0 表示未知 |
| `ports` | object | 必填 | — | `{"in": "antN" \| null}` | — | 缺键 = 保持上次回读；`null` = 该口未知/未接 |
| `target` | string | 可选 | — | `antN` 或 `null` | — | 稳定态与 `position` 一致；切换中为目标位 |
| `switching` | boolean | 必填 | — | true/false | — | 缺省 `false`；为 true 时服务端不得标 `verified` |
| `relay_state` | array<boolean> | 可选 | — | 长度 = `out_count` | — | 各路继电器实际状态，诊断用 |
| `rf_detected` | boolean | 必填 | — | true/false | — | 缺省 `false`；本地 RF 检测 |
| `tx_active` | boolean | 必填 | — | true/false | — | 缺省 `false`；设备自测发射，仅诊断，不参与服务端互锁 |
| `antennas` | array<object> | 可选 | — | ≤16 项 | — | 缺省 `[]`；端口 → 天线 → 波段回读 |

`antennas[]` 元素（与 `switchModels.mappingFor` 的读回结构一致，`switch-models.js:435-452`）：

| 键 | 类型 | 必填 | 范围 | 说明 |
|---|---|---|---|---|
| `index` | number | 必填 | 1–16 | 对应 `antN` |
| `name` | string | 必填 | ≤60 | 天线名 |
| `bands` | array<string> | 必填 | `^\d{1,3}m$`，≤16 | 空数组 = 未配置波段 |

完整快照示例：

```json
{"msg_id":"sw-a-0101","cmd":"remote_control",
 "timestamp":1794724800,"ts":"2026-11-15T06:40:00.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","model":"DXC-SW-6",
  "serial":"SWA2026001","firmware_version":"1.0.3","boot_id":"b7f3c1",
  "uptime_ms":128400,"seq":42,"state":"idle","out_count":6,
  "position":3,"ports":{"in":"ant3"},"target":"ant3","switching":false,
  "relay_state":[false,false,true,false,false,false],
  "rf_detected":false,"tx_active":false,"temperature_c":31.5,
  "fault_word":0,"error":"","result":"ok",
  "antennas":[{"index":1,"name":"160 INV-L","bands":["160m"]},
              {"index":2,"name":"80 DP","bands":["80m"]},
              {"index":3,"name":"20/15/10 YAGI","bands":["20m","15m","10m"]}]}}
```

### 6.3 控制指令字段

| 字段 | 类型 | 必填 | 范围 | 缺省行为 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | 必填 | ≤100 | — | 服务端总会带（`amp-link.js:958-961`） |
| `ports` | object | 必填 | `{"in": "antN"}` | — | 键必须是 `in`；值必须是已存在的 `antN` |
| `action` | string | 可选 | `select` | 可缺省 | 显式表达意图，服务端不强制 |

约束：

- `N` 必须在 `1…out_count`；超出 → 回 `error="unknown-channel"`，不动作。
- **值不得为 `null`**：远程"全断"属【禁止】（§12.4）。收到 `{"in": null}` 必须拒绝。
- 切换必须 **break-before-make**，断开窗口 ≤ 50 ms，总动作 ≤ 200 ms。
- 同一时刻只允许一路 `antN` 闭合，机械上不得两路并接。

B 档等价动作（`relay.js:101-105`）：

```
POST <relay_url>
X-Relay-Token: <token>
{"channel": <channels["in:ant3"] 或 channels["ant3"]>, "action": "pulse", "pulse_ms": 400}
```

`channels` 键允许 `in:antN` 或 `antN`（`commands.js:206-212`）；`pulse_ms` 50–5000，缺省 400（`relay.js:16-18`）。

### 6.4 服务端状态机（必须与硬件对得上）

| 服务端状态 | 触发 | 硬件侧对应 | 参与互锁 |
|---|---|---|---|
| `waiting` / `awaiting` | 已配置但无回读 | 未见 | 否 |
| `pending` | 指令已下发，等回读 | `switching=true` | 否（`service.js:352-359`） |
| `verified` | 收到回读并写入 `ports` | `switching=false`，`ports` 有效 | **是** |
| `unverified` | 只写型号，永远无回读 | B 档 relay 设备 | 否 |
| `unknown` + `stale` | 通信中断 | 无心跳 | 否（保留最后 `ports` 但不用） |

关键点：**只有设备自己确认机械到位后才允许上报 `ports`**。上报 `ports` 等于向服务端声明"这条通路现在是通的"，会被用于 TX 可达与互锁计算。

### 6.5 硬件状态机与边界

```
      上电
       │
       ▼
   init（读位置；读不到 → position=null, ports.in=null）
       │ 读出确定位置
       ▼
   idle ◄────────── 到位且稳定
    │  ▲                    ▲
    │  └── 切换失败/超时 ──┐ │
    ▼                     │ │
 switching ── 到位 ───────┘ │
    │                       │
    └── 机械/继电器故障 ──► fault
```

| 边界 | 规则 |
|---|---|
| 单次切换 | ≤200 ms；>1 s 未到位 → `state="fault"`、`error="switch-timeout"`，保持原位，不得抖动 |
| 连续指令 | 切换中收到新指令 → `error="busy"`，不排队、不预存 |
| 位置未知 | `ports.in=null`、`position=null`；不得按最后一条命令"假装"到位 |
| 发射中收到切换 | 本地拒绝（有 RF 检测时），`error="tx-active"` |
| 通信中断 | 保持机械位置（切换器自保持） |
| 断电 | 线圈失电后位置由机械决定；上电必须实测 |

### 6.6 示例（请求 / 响应成对）

**(1) 上线首帧（设备 → 服务端）**

```json
{"msg_id":"sw-a-0001","cmd":"remote_control",
 "timestamp":1794724800,"ts":"2026-11-15T06:40:00.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","state":"init",
  "position":null,"ports":{"in":null},"target":null,"switching":false,
  "out_count":6,"seq":1,"boot_id":"b7f3c1","uptime_ms":820}}
```

服务端显示"在线 / 位置未知"，不参与互锁。

**(2) 服务端下发切换**

```json
{"msg_id":"dxc-m7k2p1-a1b2c3d4","cmd":"remote_control",
 "timestamp":1794724810,"ts":"2026-11-15T06:40:10.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","ports":{"in":"ant3"}}}
```

**(3) 设备 ack**

```json
{"msg_id":"sw-a-0102","cmd":"remote_control",
 "timestamp":1794724810,"ts":"2026-11-15T06:40:10.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","result":"ok",
  "ack_msg_id":"dxc-m7k2p1-a1b2c3d4","seq":43}}
```

**(4) 回读确认（切换完成后）**

```json
{"msg_id":"sw-a-0103","cmd":"remote_control",
 "timestamp":1794724811,"ts":"2026-11-15T06:40:11.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","state":"idle",
  "position":3,"ports":{"in":"ant3"},"target":"ant3","switching":false,
  "rf_detected":false,"relay_state":[false,false,true,false,false,false],
  "error":"","result":"ok","seq":44}}
```

服务端把 `ports` 标为 `verified`，此后该通路进入 RF 可达与互锁。

**(5) 发射中拒绝**

```json
{"msg_id":"sw-a-0104","cmd":"remote_control",
 "timestamp":1794724820,"ts":"2026-11-15T06:40:20.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","result":"error",
  "ack_msg_id":"dxc-m7k2p9-77aa01bb","error":"tx-active",
  "error_detail":"fwd_power=620W","seq":45}}
```

**(6) B 档等价（HTTP）**

请求：

```
POST http://192.168.1.60/relay
X-Relay-Token: <token>
{"channel": 3, "action": "pulse", "pulse_ms": 400}
```

响应：HTTP 200（服务端只认 2xx，`relay.js:79-87`）。

### 6.7 响应与错误码

| 情形 | 设备返回 `error` | 服务端 HTTP |
|---|---|---|
| 正常受理 | — | 202 `accepted`，`state:"pending"` |
| 端口越界 | `unknown-channel` | —（异步，HTTP 已 202） |
| 切换中又来指令 | `busy` | — |
| 发射中 | `tx-active` | 服务端自身也可能先返回 **423 `tx-active`**（`commands.js:496-503`） |
| 机械未到位 | `switch-timeout` | — |
| 未配置 | — | 400 `transport-not-configured` |
| 连不上继电器 | — | 502 `transport-connect` / 504 `transport-timeout` |
| 型号不支持控制 | — | 501 `unsupported-control`（`commands.js:490`） |

### 6.8 异常与超时

| 情形 | 设备行为 | 服务端表现 |
|---|---|---|
| 非法 JSON / 未知 `cmd` | 静默丢弃 | 无变化 |
| `ports.in` 值不存在 | 回 `unknown-channel`，不动作 | 状态不更新 |
| 机械卡阻 | `state="fault"`、`error="switch-timeout"`、`fault_word` 置位 | 保持 `pending` |
| broker 断线 | 本地继续运行；重连后立即全量快照 | 功放式 driver 判 `offline`；B 档按 10 s 超时 |
| 5 s 无回读 | — | 服务端不自动改状态，仍 `pending`（【待落地】G9） |

---

## 7. 矩阵切换器（m×n）

### 7.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `matrix` |
| 端口 | `in1…inN` + `out1…outM`；`N=in_count`（缺省 2）、`M=out_count`（缺省 4），各 1–16 |
| 上行 / 下行 | `matrix/device/{device_id}/heartbeat` / `json_command` |
| LWT | `matrix/device/{device_id}/status` |
| 单帧上限 | 8192 字节 |
| Schema | `docs/schema/heartbeat-matrix.schema.json`、`command-matrix.schema.json` |

### 7.2 状态上报字段（专属）

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `in_count` | number | 必填 | 路 | 1–16 | 无符号 | 与配置一致 |
| `out_count` | number | 必填 | 路 | 1–16 | 无符号 | 与配置一致 |
| `ports` | object | 必填 | — | `{"inN":"outM"}`，值或 `null` | — | **按键增量**；缺键保持，`null` = 该输入未接 |
| `switching` | boolean | 必填 | — | true/false | — | 缺省 `false` |
| `relay_state` | array<boolean> | 可选 | — | 长度 = N×M | — | 诊断 |
| `rf_detected` / `tx_active` | boolean | 必填 | — | true/false | — | 同切换器 |
| `antennas` | array<object> | 可选 | — | 同 §6.2 | — | 出口侧波段映射 |

完整快照示例（2×4）：

```json
{"msg_id":"mx-a-0001","cmd":"remote_control",
 "timestamp":1794724900,"ts":"2026-11-15T06:41:40.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","device_class":"matrix","model":"DXC-MX-2X4",
  "serial":"MXA2026001","firmware_version":"1.0.0","boot_id":"c19a2e",
  "uptime_ms":56300,"seq":18,"state":"idle","in_count":2,"out_count":4,
  "ports":{"in1":"out2","in2":"out4"},"switching":false,
  "relay_state":[false,true,false,false,false,false,false,true],
  "rf_detected":false,"tx_active":false,"temperature_c":29.0,
  "fault_word":0,"error":"","result":"ok"}}
```

### 7.3 控制指令字段

| 字段 | 类型 | 必填 | 范围 | 缺省行为 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | 必填 | ≤100 | — | — |
| `ports` | object | 必填 | `{"inN":"outM"}` | — | 一次只改一个输入；多键按**逐键独立**处理 |

约束（来自现有数据结构，`rf.js:236-260`、`switch-link.js:660-663`）：

- 每个输入同一时刻只能对应**一个**输出；服务端选择表是 `inN → outM` 单值映射。
- **一个输出不得被多个输入同时选中**（硬件必须互斥）。需要多路合请用合路器。
- 不允许"广播式"把多个输入接到同一输出。
- 值不得为 `null`（远程断开射频通路属【禁止】）。
- 单输入动作时间同切换器：≤200 ms，break-before-make。

B 档等价：`{"channel": <channels["in1:out2"]>, "action": "pulse", "pulse_ms": 400}`。

### 7.4 服务端状态机

与 §6.4 相同。矩阵额外注意：`ports` 按键合并，"只报一个输入"合法；但**切换中不得先把目标值写进 `ports`**，否则服务端会提前把该通路当已通。

### 7.5 示例

**(1) 下发：`in2 → out1`**

```json
{"msg_id":"dxc-m7k2pa-00112233","cmd":"remote_control",
 "timestamp":1794725000,"ts":"2026-11-15T06:43:20.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","ports":{"in2":"out1"}}}
```

**(2) ack**

```json
{"msg_id":"mx-a-0201","cmd":"remote_control",
 "timestamp":1794725000,"ts":"2026-11-15T06:43:20.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","device_class":"matrix","result":"ok",
  "ack_msg_id":"dxc-m7k2pa-00112233","seq":19}}
```

**(3) 回读（只报变化的输入）**

```json
{"msg_id":"mx-a-0202","cmd":"remote_control",
 "timestamp":1794725001,"ts":"2026-11-15T06:43:21.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","device_class":"matrix","state":"idle",
  "ports":{"in2":"out1"},"switching":false,"seq":20}}
```

**(4) 拒绝：目标输出已被占用**

```json
{"msg_id":"mx-a-0203","cmd":"remote_control",
 "timestamp":1794725010,"ts":"2026-11-15T06:43:30.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","device_class":"matrix","result":"error",
  "ack_msg_id":"dxc-m7k2pb-44556677","error":"output-busy",
  "error_detail":"out1 used by in1","seq":21}}
```

### 7.6 响应与错误码

| 情形 | 设备返回 | 说明 |
|---|---|---|
| 目标输出被占用 | `output-busy` | 不允许"抢占" |
| 输入越界 | `unknown-channel` | — |
| 机械卡阻 | `switch-timeout` | 保持原位 |
| 发射中 | `tx-active` | 服务端亦可能 423 |

### 7.7 异常与超时

| 情形 | 设备行为 |
|---|---|
| 断线 | 保持机械位置，重连后全量快照 |
| 单输入失败 | 只回滚该输入，其他输入不动 |
| 回读缺失 | `ports` 里不出现该键（服务端保留上次值，不会被清空） |
| 多个输入指向同一输出 | 本地拒绝后到的那个，`output-busy` |

## 8. 铁塔升降控制器

### 8.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `tower` |
| 射频端口 | 无（塔不接射频，`rf.js:135-137`） |
| 控制 / 状态口 | `relay` / `limit` |
| 上行 / 下行 | `tower/device/{device_id}/heartbeat` / `json_command` |
| LWT | `tower/device/{device_id}/status` |
| 服务端配置 | `up_channel` / `down_channel`（0–255）、`pulse_ms`、`travel_timeout_sec`（5–3600，缺省 120） |
| 上层设置 | 限位开关类型 `NO` / `NC`，**全局一项，缺省 NO**（`service.js:333-343`、`tower.js:14`） |
| 单帧上限 | 8192 字节 |
| Schema | `docs/schema/heartbeat-tower.schema.json`、`command-tower.schema.json` |

> 限位类型不是每台塔各自的配置，而是站点级设置。设备上报**原始电平**，取反由上位机做。设备若自行取反，NO/NC 设置就完全失效。

### 8.2 状态上报字段（专属）

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `limit_top` | boolean | 必填 | — | 接点原始电平 | — | **true = 接点闭合**；不得省略 |
| `limit_bottom` | boolean | 必填 | — | 接点原始电平 | — | 同上 |
| `moving` | boolean | 必填 | — | true/false | — | 缺省 `false` |
| `direction` | string | 可选 | — | `up`/`down`/`null` | — | `null` |
| `motor_on` | boolean | 必填 | — | true/false | — | 输出继电器实际吸合状态 |
| `hold_active` | boolean | 必填 | — | true/false | — | 本次 hold 是否仍在续期窗口内 |
| `hardware_interlock` | boolean | 必填 | — | true/false | — | 本地硬互锁有效；`false` = 旁路/故障 |
| `limit_wiring` | string | 可选 | — | `NO`/`NC`/`null` | — | 设备实际接线，供上位机核对；服务端暂不消费 |
| `travel_ms` | number | 可选 | ms | 0–3600000 | 无符号 | 本次运动已用时长 |
| `motor_current_a` | number | 可选 | A | 0–50，3 位小数 | 无符号 | 过流诊断 |
| `fault` | string | 可选 | — | 见 §11.1 | — | 空串 = 无故障 |

`limit_top` / `limit_bottom` 语义必须精确：

- 上报限位开关**接点电平**，不是"逻辑到位"。
- `NO` 接法：接点闭合（true）= 到位；`NC` 接法：接点断开（false）= 到位。
- 服务端按全局配置解释：`logicalLevel(raw, "NC") = !raw`（`tower.js:22-25`）。
- 两限位同时逻辑到位 → `fault` + `alert="limit-conflict"`（`tower.js:42-44`）；任一侧读不到 → `unknown` + `reason="no-limit-feedback"`。

完整快照示例（已收回，下限位有效）：

```json
{"msg_id":"tw-a-0001","cmd":"remote_control",
 "timestamp":1794725100,"ts":"2026-11-15T06:45:00.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","device_class":"tower","model":"DXC-TW-1",
  "serial":"TWA2026001","firmware_version":"1.0.2","boot_id":"d00d42",
  "uptime_ms":204500,"seq":306,"state":"idle",
  "limit_top":false,"limit_bottom":true,"limit_wiring":"NO",
  "moving":false,"direction":null,"motor_on":false,"hold_active":false,
  "hardware_interlock":true,"travel_ms":0,"motor_current_a":0.0,
  "temperature_c":18.5,"fault":"","error":"","fault_word":0,"result":"ok"}}
```

### 8.3 控制指令字段

| 字段 | 类型 | 必填 | 范围 | 缺省行为 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | 必填 | ≤100 | — | — |
| `action` | string | 必填 | `hold` / `release` / `stop` | — | `hold` 续期即"继续按住" |
| `direction` | string | `hold` 时必填 | `up` / `down` | — | 其余动作忽略 |
| `hold_ms` | number | 可选 | 500–1500 | 1500 | 本次 hold 有效期；**上限 1500** |

语义（与 `tower-hold.js` 完全一致）：

1. **按住运行（点动）**：上位机每 500 ms 发一条 `action="hold"`，方向不变即续期，**不得重复吸合**（`tower-hold.js:74-87`）。
2. **看门狗**：设备 **1500 ms** 未收到新的 `hold`，必须断开两路输出（`tower-hold.js:9-10,134-155`）。
3. **两路不同时闭合**：换向时先断另一路，再吸合目标路（`tower-hold.js:87-101`）。
4. **换向最小间隔 1000 ms**：服务端会以 `409 direction-switch-too-fast` 拒绝（`tower-hold.js:65-72`）；设备端也必须独立执行同样的 1000 ms 间隔。
5. **释放**：`release` / `stop` 立即断开当前通道（`tower-hold.js:117-132`）。
6. **启动/重载**：服务端启动时对所有塔执行一次 `off`（`tower-hold.js:175-198`）；设备重启后也必须是两路断开。

B 档等价（干接点）：

```
POST <relay_url>  {"channel": <up_channel>,   "action": "on"}    // hold up
POST <relay_url>  {"channel": <up_channel>,   "action": "off"}   // release
POST <relay_url>  {"channel": <down_channel>, "action": "on"}    // hold down
```

服务端每次 hold 都真的写一次 `on`（`relay.js:107-121`）；换向时先写另一路 `off`。

### 8.4 状态机与边界

服务端二态模型（`tower.js:27-60`），设备侧必须能一一对应：

| 服务端状态 | 条件 | 设备侧应满足 |
|---|---|---|
| `erected` | 上限位逻辑到位 | `limit_top` 有效 |
| `retracted` | 下限位逻辑到位 | `limit_bottom` 有效 |
| `moving` | 两限位都未到位、`moving=true`、未超 `travel_timeout_sec` | 电机已通电 |
| `fault` | 两限位同时逻辑到位 | `fault="limit-conflict"` |
| `unknown` | 限位读不到 / 无上报 / 运动超时 | `error` 说明原因 |
| `offline` | >10 s 无上报 | broker 断线或设备停机 |

设备侧状态机：

```
       上电
        │
        ▼
   init（两路断开；读限位）
        │
        ├─ 两限位都无效 ──► idle/unknown（中间位置，等指令）
        ├─ 上限位有效 ────► erected
        └─ 下限位有效 ────► retracted
                │ hold up / down
                ▼
            moving ── 目标限位到位 ──► erected / retracted
                │
                ├─ 1500 ms 无续期 ──► 断两路，回 idle
                ├─ 超 travel_timeout_sec ──► fault（断两路）
                └─ 两限位同时有效 ──► fault（断两路）
```

| 边界 | 规则 |
|---|---|
| 上限位到达 | 硬件自行切断上升输出，**不等上位机**；即使收到 `hold up` 也保持断开 |
| 下限位到达 | 同上 |
| 两限位冲突 | 两路立即断开，`fault="limit-conflict"`，拒绝任何 `hold` 直到断电复位 |
| 换向间隔 | 1000 ms；设备端从"上一路断开"开始计时 |
| 运动超时 | 设备自行断电并报 `fault="travel-timeout"`；服务端 `travel_timeout_sec` 只用于显示判定，不能替代硬件切断 |
| 通信中断 | 1500 ms 看门狗断开两路（fail-safe） |
| 断电 | 两路失电，塔由机械自锁保持；上电必须先读限位，不得自动继续断电前的动作 |
| 塔在中间位置 | 允许上报（真实存在）；不得谎报为 `erected`/`retracted` |

### 8.5 示例

**(1) 按住上升**

```json
{"msg_id":"dxc-m7k2pc-99887766","cmd":"remote_control",
 "timestamp":1794725200,"ts":"2026-11-15T06:46:40.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","action":"hold","direction":"up","hold_ms":1500}}
```

**(2) ack**

```json
{"msg_id":"tw-a-0501","cmd":"remote_control",
 "timestamp":1794725200,"ts":"2026-11-15T06:46:40.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","device_class":"tower","result":"ok",
  "ack_msg_id":"dxc-m7k2pc-99887766","seq":307}}
```

**(3) 续期（500 ms 后同方向再来一条；设备不得重复吸合）**

```json
{"msg_id":"dxc-m7k2pc-aabbccdd","cmd":"remote_control",
 "timestamp":1794725201,"ts":"2026-11-15T06:46:41.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","action":"hold","direction":"up","hold_ms":1500}}
```

设备 ack `result="ok"`，`hold_active` 保持 true，`motor_on` 不翻转。

**(4) 运动中快照**

```json
{"msg_id":"tw-a-0502","cmd":"remote_control",
 "timestamp":1794725202,"ts":"2026-11-15T06:46:42.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","device_class":"tower","state":"moving",
  "limit_top":false,"limit_bottom":false,"moving":true,"direction":"up",
  "motor_on":true,"hold_active":true,"hardware_interlock":true,
  "travel_ms":1200,"motor_current_a":3.4,"seq":308}}
```

**(5) 到位**

```json
{"msg_id":"tw-a-0503","cmd":"remote_control",
 "timestamp":1794725242,"ts":"2026-11-15T06:47:22.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","device_class":"tower","state":"idle",
  "limit_top":true,"limit_bottom":false,"moving":false,"direction":null,
  "motor_on":false,"hold_active":false,"travel_ms":41200,
  "motor_current_a":0.0,"seq":309}}
```

服务端显示 `erected`。

**(6) 换向过快（服务端拒绝）**

```
POST /api/devices/TW-A/command
X-DX-Seat: OP-A
{"command":"tower_hold","direction":"down"}
```

```
409 Conflict
{"ok":false,"error":"direction-switch-too-fast"}
```

**(7) 看门狗释放（设备侧，无请求）**

1.5 s 内无新 `hold` → 断开上升输出 → 下一帧：

```json
{"msg_id":"tw-a-0504","cmd":"remote_control",
 "timestamp":1794725202,"ts":"2026-11-15T06:46:42.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","device_class":"tower","state":"idle",
  "moving":false,"direction":null,"motor_on":false,"hold_active":false,
  "error":"watchdog-release","seq":310}}
```

### 8.6 响应与错误码

| 情形 | 设备返回 `error` | 服务端 HTTP |
|---|---|---|
| 正常受理 | — | 202 `accepted` |
| 方向非法 | `invalid-direction` | 400 `invalid-direction` |
| 已到位还同向 | `limit-reached` | — |
| 两限位冲突 | `limit-conflict` | — |
| 换向 <1000 ms | `direction-switch-too-fast` | 409 同名 |
| 通道未配置 | — | 400 `unknown-channel`（`commands.js:588-589`） |
| 继电器 HTTP 超时 | — | 504 `transport-timeout` |

### 8.7 异常与超时

| 情形 | 设备行为 | 服务端表现 |
|---|---|---|
| 硬件互锁失效 | 两路断开，`hardware_interlock=false`、`fault="interlock-open"` | 界面必须显红 |
| 双限位同时有效 | 两路断开，`fault="limit-conflict"` | `fault` + `alert="limit-conflict"` |
| 运动超时 | 两路断开，`fault="travel-timeout"` | `unknown` + `alert="travel-timeout"` |
| broker 断线 | 1500 ms 后断开两路 | 10 s 后 `offline` |
| 继电器超时 | — | 504，不重试 |

---

## 9. 多波段 BPF 组

### 9.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `bpf` |
| 射频端口 | `in` + `out` |
| 控制 / 状态口 | 无（`rf.js:22-47` 未定义 BPF 控制口） |
| 上行 / 下行 | `bpf/device/{device_id}/heartbeat` / `json_command` |
| LWT | `bpf/device/{device_id}/status` |
| 单帧上限 | 8192 字节 |
| Schema | `docs/schema/heartbeat-bpf.schema.json`、`command-bpf.schema.json` |

波段归属规则：

- `bands` 是整机允许通过的波段集合，RF 遍历用它剪枝（`rf.js:188-192,304`）。
- 一台多波段 BPF 组在拓扑上仍是单个 `in`/`out` 串联环节，**不按波段分口**（分口是合路器的事）。
- 整机 `bands` 应覆盖所有滤波仓的并集；单次插入的仓由 `band` 表达。

### 9.2 状态上报字段（专属）

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `band` | string | 必填 | — | `^\d{1,3}m$` 或 `""` | — | `""` = 未插入任何滤波仓 |
| `mode` | string | 必填 | — | `manual` / `auto` | — | `manual` |
| `bypass` | boolean | 必填 | — | true/false | — | `false`；true = 直通 |
| `switching` | boolean | 必填 | — | true/false | — | `false` |
| `filter_bank` | array<string> | 必填 | — | `^\d{1,3}m$`，1–16 | — | 本机安装的滤波仓列表 |
| `rf_detected` | boolean | 必填 | — | true/false | — | 本地 RF 检测 |
| `tx_active` | boolean | 必填 | — | true/false | — | 本地发射判定 |
| `insertion_loss_db` | number | 可选 | dB | 0–10，3 位小数 | 无符号 | `null` |
| `fault` | string | 可选 | — | 见 §11.1 | — | `""` |

完整快照示例：

```json
{"msg_id":"bpf-a-0001","cmd":"remote_control",
 "timestamp":1794725300,"ts":"2026-11-15T06:48:20.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","model":"DXC-BPF-6",
  "serial":"BPFA2026001","firmware_version":"1.0.1","boot_id":"e5c210",
  "uptime_ms":98200,"seq":64,"state":"idle","band":"20m","mode":"auto",
  "bypass":false,"switching":false,
  "filter_bank":["160m","80m","40m","20m","15m","10m"],
  "rf_detected":false,"tx_active":false,"insertion_loss_db":0.6,
  "fault":"","error":"","result":"ok"}}
```

### 9.3 控制指令字段

| 字段 | 类型 | 必填 | 范围 | 缺省行为 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | 必填 | ≤100 | — | — |
| `band` | string | 可选 | `filter_bank` 中的一项 | 不变 | 切到指定滤波仓 |
| `bypass` | boolean | 可选 | true/false | 不变 | 直通 / 恢复插入 |
| `mode` | string | 可选 | `manual` / `auto` | 不变 | 自动模式跟随外部波段信息 |

三者至少给一个，否则回 `error="empty-command"`。

约束：

- `band` 必须已安装，否则 `unknown-band`，不动作。
- **`bypass=true` 不得由上位机在发射中下发**（§12.4）；设备检测到 RF 时必须拒绝。
- break-before-make，断开窗口 ≤50 ms，总动作 ≤200 ms。
- `mode="auto"` 时设备可自行跟随外部波段，但**不得静默切换**：切换前后都必须发快照。

服务端现状：

- 【实现】BPF 属"无状态源类型"（`service.js:77-80`），`COMMAND_TYPES` 也没有 BPF 命令（`commands.js:54-62`）。
- 【待落地】本文的 `band`/`bypass`/`mode` 需服务端新增 `bpf_set` 与 driver；在此之前 BPF 只能通过 B 档 `report` 表达"在线"。

### 9.4 状态机与边界

```
   init（继电器复位 → 直通）
     │
     ├─ 已读出仓位置 ──► idle（band=实际仓）
     └─ 读不出 ────────► unknown（band=""）
              │ band 指令
              ▼
           switching ── 到位 ──► idle
              │
              ├─ RF 存在 ──► 拒绝，保持原位
              └─ 继电器未到位 ──► fault
```

| 边界 | 规则 |
|---|---|
| 上电/断电 | **默认直通**（`bypass=true`、`band=""`），不得自动插入断电前的仓 |
| 发射中 | 拒绝任何插入/直通切换，回 `tx-active` 或 `rf-detected` |
| 未知仓 | `band=""`、`bypass` 按实测；不得用最后一条命令填充 |
| 多波段并存 | 机械上一次只能插入一个仓；不得同时插入两个波段 |
| 断线 | 保持当前机械位置（不自动回直通，避免发射中断路） |

### 9.5 示例

**(1) 切到 15m**

```json
{"msg_id":"dxc-m7k2pd-1234abcd","cmd":"remote_control",
 "timestamp":1794725310,"ts":"2026-11-15T06:48:30.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","band":"15m"}}
```

**(2) ack**

```json
{"msg_id":"bpf-a-0101","cmd":"remote_control",
 "timestamp":1794725310,"ts":"2026-11-15T06:48:30.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","result":"ok",
  "ack_msg_id":"dxc-m7k2pd-1234abcd","seq":65}}
```

**(3) 回读**

```json
{"msg_id":"bpf-a-0102","cmd":"remote_control",
 "timestamp":1794725311,"ts":"2026-11-15T06:48:31.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","state":"idle",
  "band":"15m","bypass":false,"switching":false,"seq":66}}
```

**(4) 发射中拒绝**

```json
{"msg_id":"bpf-a-0103","cmd":"remote_control",
 "timestamp":1794725320,"ts":"2026-11-15T06:48:40.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","result":"error",
  "ack_msg_id":"dxc-m7k2pe-5678efgh","error":"tx-active",
  "error_detail":"fwd_power=410W","seq":67}}
```

### 9.6 响应与错误码

| 情形 | 设备返回 | 说明 |
|---|---|---|
| 波段未安装 | `unknown-band` | 不动作 |
| 无有效字段 | `empty-command` | 三个字段至少一个 |
| 发射中 | `tx-active` | 不动作 |
| 继电器反馈不符 | `fault="relay-mismatch"` + 报实际位置 | — |
| 服务端下发 `bands` | 忽略 | 只读字段 |

### 9.7 异常与超时

| 情形 | 设备行为 |
|---|---|
| 继电器反馈与命令不一致 | `state="fault"`、`fault="relay-mismatch"`，上报实际位置 |
| 上位机 `bands` 与 `filter_bank` 不一致 | 以 `filter_bank` 执行，`error_detail` 提示 |
| 通信中断 | 保持位置；重连后全量快照 |
| 仓位置读不出 | `band=""`，等指令，不猜测 |

## 10. 驻波表

### 10.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `swr` |
| 射频端口 | `in` + `out` |
| 控制 / 状态口 | `report` / `status` |
| 上行 / 下行 | `swr/device/{device_id}/heartbeat` / `json_command` |
| LWT | `swr/device/{device_id}/status` |
| 单帧上限 | 8192 字节 |
| Schema | `docs/schema/heartbeat-swr.schema.json`、`command-swr.schema.json`、`http-tx.schema.json` |

驻波表承担两件事：

1. **功率与驻波测量**（展示、告警）；
2. **发射状态源**：向服务端提供 `tx_active`，用于天线切换互锁（`tx.js`、`commands.js:250-287`）。

### 10.2 状态上报字段（专属）

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `fwd_power_w` | number | 必填 | W | 0 – `max_power_w`，1 位小数 | 无符号 | 无 RF 时 `0.0`；未测到 `null` |
| `rev_power_w` | number | 必填 | W | 0 – `max_power_w` | 无符号 | 同上 |
| `swr` | number | 必填 | — | 1.00–99.99，2 位小数 | 无符号 | 无 RF 时 `null`；**不得用 0 表示无穷大** |
| `rl_db` | number | 可选 | dB | 0–40 | 无符号 | `null` |
| `pep` | boolean | 必填 | — | true/false | — | `false` |
| `peak_fwd_w` | number | 可选 | W | 0 – `max_power_w` | 无符号 | `0.0` |
| `freq_hz` | number | 可选 | Hz | 0–1300000000 | 无符号 | `null` |
| `band` | string | 可选 | — | `^\d{1,3}m$` 或 `""` | — | 由频率换算，算不出给 `""` |
| `tx_active` | boolean | 必填 | — | true/false | — | 见 §10.3 |
| `tx_threshold_w` | number | 必填 | W | 1–10000 | 无符号 | 发射判定门限 |
| `sample_ms` | number | 可选 | ms | 1–10000 | 无符号 | 采样窗口 |
| `max_power_w` | number | 必填 | W | 1–100000 | 无符号 | 量程上限 |
| `cal_valid` | boolean | 必填 | — | true/false | — | 校准数据是否有效 |
| `cal_locked` | boolean | 必填 | — | true/false | — | 校准写入是否锁定 |

发射判定的时间要求（【标准】）：

- 功率超过门限 → `tx_active=true`：**≤200 ms**；
- 功率跌回门限以下 → `tx_active=false`：**≤300 ms**（允许去抖）；
- 去抖窗口 ≤50 ms，防止单次尖峰误判。

服务端互锁是**实时**读 `tx_active`（`tx.snapshot` → `commands.interlockBlock`），门限与去抖设置不当会直接导致"该锁不锁"或"频繁误锁"。

### 10.3 发射状态上报（两条通路）

**B 档（今天可用，必须实现）**

| 项 | 值 |
|---|---|
| 端点 | `POST /api/devices/tx`（RFC 9110 POST，非幂等；`seq` 提供去重） |
| 频率 | 发射起止立即发；无变化时每 1 s 一帧 |
| 认证 | 配置 token 的源必须带 `X-DX-TX-Token`，否则 403 `invalid-token`（`tx.js:92-98`） |
| 绑定 | 源配置的 `device_id` = 本驻波表的设备记录 id，互锁才按这条 RF 通路精确锁定（`service.js:514-520`） |

请求：

```json
{"source_id":"swr-a","tx_active":true,"ts":1794725400123,"seq":1041}
```

响应：

```json
{"ok":true,"source_id":"swr-a","tx_active":true,
 "received_ts":"2026-11-15T06:50:00.123Z","registered":false,"health":"ok"}
```

字段与约束（`tx.js:72-154`）：

| 字段 | 类型 | 必填 | 范围 | 缺省行为 |
|---|---|---|---|---|
| `source_id` | string | 必填 | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` | 缺失 400 `source-id-required` |
| `tx_active` | boolean | 必填 | true/false（**严格布尔**） | 缺失 400 `tx-active-required` |
| `ts` | number \| ISO 8601 string | 可选 | 毫秒或 `Z` 结尾 ISO | 缺省取服务端当前时间 |
| `seq` | number | 可选 | 单调递增整数 | `seq <= 上次` 返回 200 `ignored:"stale-seq"` |
| `token` | string | 可选 | ≤200 | 可放 body 或 `X-DX-TX-Token` 头 |

健康度：`timeout_ms` 内 `ok`；≤3× `timeout_ms` 为 `stale`；超过为 `offline`；三者都不可用时互锁不启用、正常放行（`tx.js:41-54`、`service.js:190-198`）。

**A 档（标准）**：心跳 `data.tx_active` 与 B 档同时上报，取"或"逻辑（任一通路判发射即发射）。服务端当前只消费 B 档【待落地】。

另外，驻波表还需按设备在线语义上报 `POST /api/devices/report`（`device_id` + `seq`），否则设备卡片显示"等待上报"（`service.js:83,249-254`）。

### 10.4 控制指令字段

只读测量设备，可下发动作只有一项：

| 字段 | 类型 | 必填 | 范围 | 说明 |
|---|---|---|---|---|
| `action` | string | 必填 | `clear_peak` | 清峰值保持 |

【禁止】远程写校准系数、清零校准基准、修改保护/告警阈值、切换量程校准表。与功放 §5.9 工程参数同一原则（`amp-link.js:12-13`、`commands.js:66-84`）。

设备收到被禁止字段必须回 `error="calibration-locked"` 并保持原值，**不得静默接受**。

### 10.5 示例

**(1) 发射起（B 档）**

```json
{"source_id":"swr-a","tx_active":true,"ts":1794725400123,"seq":1041}
```

```json
{"ok":true,"source_id":"swr-a","tx_active":true,
 "received_ts":"2026-11-15T06:50:00.123Z","registered":false,"health":"ok"}
```

**(2) 发射止**

```json
{"source_id":"swr-a","tx_active":false,"ts":1794725410870,"seq":1042}
```

```json
{"ok":true,"source_id":"swr-a","tx_active":false,
 "received_ts":"2026-11-15T06:50:10.870Z","registered":false,"health":"ok"}
```

**(3) token 错误**

```json
{"ok":false,"error":"invalid-token"}
```

HTTP 403。

**(4) seq 回退**

```json
{"ok":true,"ignored":"stale-seq","source_id":"swr-a","seq":1040,"last_seq":1042}
```

HTTP 200，服务端**不更新**状态。

**(5) A 档心跳快照**

```json
{"msg_id":"swr-a-0001","cmd":"remote_control",
 "timestamp":1794725420,"ts":"2026-11-15T06:50:20.000Z","proto":"1.0",
 "data":{"device_id":"SWR-A","device_class":"swr","model":"DXC-SWR-1",
  "serial":"SWRA2026001","firmware_version":"1.0.4","boot_id":"f0a1b2",
  "uptime_ms":604000,"seq":1200,"state":"idle",
  "fwd_power_w":0.0,"rev_power_w":0.0,"swr":null,"pep":false,
  "peak_fwd_w":820.0,"freq_hz":null,"band":"","tx_active":false,
  "tx_threshold_w":5.0,"sample_ms":20,"max_power_w":2000,
  "cal_valid":true,"cal_locked":true,"temperature_c":34.0,
  "error":"","result":"ok"}}
```

### 10.6 响应与错误码

| 情形 | 返回 | 说明 |
|---|---|---|
| 正常 | 200 `{"ok":true,...,"health":"ok"}` | — |
| 缺 `source_id` | 400 `source-id-required` | — |
| `tx_active` 非布尔 | 400 `tx-active-required` | 必须发 JSON 布尔 |
| `seq` 非数字 | 400 `invalid-seq` | — |
| token 不匹配 | 403 `invalid-token` | 停止重试并告警 |
| `seq` 回退 | 200 `ignored:"stale-seq"` | 不更新状态 |
| 未知源 | 200 `registered:true` | 自动登记为 priority 1000（`tx.js:128-140`） |

### 10.7 异常与超时

| 情形 | 设备行为 | 服务端表现 |
|---|---|---|
| 2 s 未上报 TX | 立即重发当前值 | `stale`，互锁仍按最后 `tx_active` 直到 `offline` |
| 6 s 未上报 | — | `offline`，源不可用，互锁降级为"不启用" |
| 功率为 0 | `swr=null`、`tx_active=false` | 正常显示 |
| 校准无效 | `cal_valid=false`、`fault="not-calibrated"` | 界面提示，不阻断 |
| 时钟未同步 | `ts` 用单调整数折算 | `latency_ms` 可能为 0，不影响判定 |

### 10.8 互锁降级语义（必须与实现一致）

- 有可用源且 `tx_active=true` → 切换被 **423 `tx-active`** 拒绝，并带 `scope`（`path` / `global`）与 `source_id`。
- 源全部不可用 → 等同"未接入发射状态源"，**不阻断、不沿用旧值、不把 unknown 当发射**（`tx.js:5-9`），响应带 `interlock:"not-enabled"`。
- 这一点对硬件的要求是：**宁可报"没发射"，也不要报"正在发射"**造成全站锁死；也不得为了"安全"把 `tx_active` 恒置 true。

---

## 11. 错误码与状态字

### 11.1 设备 → 服务端 `error` 码

出现在 `heartbeat` 的 `data.error`（ack 帧或状态帧均可）。服务端当前丢弃 `result="error"` 的整帧，因此这些码主要用于现场排障与后续 driver。

| `error` | 含义 | 设备应同时做什么 |
|---|---|---|
| `tx-active` | 检测到发射，拒绝射频动作 | 保持原位，不改 `ports` |
| `rf-detected` | 检测到 RF 能量（可能非本机发射） | 同上 |
| `unknown-channel` | 端口/通道不存在 | 不动作 |
| `unknown-band` | 波段不在 `filter_bank` | 不动作 |
| `output-busy` | 矩阵目标输出已被占用 | 不动作、不抢占 |
| `unknown-command` | 指令不认识 | 不动作 |
| `invalid-arg` | 参数越界 | 不动作 |
| `empty-command` | 没有任何有效字段 | 不动作 |
| `invalid-direction` | 塔方向不是 `up`/`down` | 不动作 |
| `busy` | 正在动作，拒绝新指令 | 不排队 |
| `switch-timeout` | 机械未在时限内到位 | 保持原位、置 fault |
| `limit-reached` | 塔目标方向已到位 | 不吸合 |
| `limit-conflict` | 两限位同时有效 | 两路断开 |
| `interlock-open` | 本地硬互锁无效 | 两路断开 |
| `travel-timeout` | 运动超时 | 两路断开 |
| `watchdog-release` | 看门狗释放输出 | 正常状态，仅记录 |
| `direction-switch-too-fast` | 换向间隔 <1000 ms | 不动作 |
| `relay-mismatch` | 继电器反馈与命令不符 | 置 fault、报实际位置 |
| `calibration-locked` | 试图写校准/阈值 | 保持原值 |
| `not-calibrated` | 校准数据无效 | 只读上报 |
| `proto-unsupported` | `proto` 主版本不支持 | 拒绝处理该帧 |
| `overtemp` | 过温 | 按本地策略降级 |
| `vswr-high` | 驻波超限 | 上报，不自行切换 |
| `hardware-fault` | 硬件故障 | 置 fault |

**可扩展规则**：

1. `error` 是**开放字符串枚举**，新增值只需登记到本表并把 `proto` minor +1。
2. 接收方遇到未登记的 `error` 必须：记录原始字符串、按"未知故障"处理（不崩溃、不据此做安全动作）。
3. 禁止用数字码（如 `-3`、`17`）表达错误；数字只用于 `fault_word` 位图。
4. 面向人的补充信息一律放 `error_detail`（≤200 字符），不参与决策。

### 11.2 服务端 → 上位机的 HTTP 错误码

这些是站内 `/api/devices/:id/command`、`/api/devices/report`、`/api/devices/tx` 的真实返回（`commands.js`、`service.js`、`relay.js`），状态码语义按 RFC 9110 §15。

| HTTP | `error` | 含义 | 触发 |
|---|---|---|---|
| 202 | — | 已受理（异步下发，不代表已执行） | 正常指令 |
| 200 | — | 上报已处理 | `report` / `tx` |
| 200 | `duplicate` | 幂等命中（仅旋转器按角度） | 目标角与当前目标相同 |
| 200 | `ignored: "stale-seq"` | 序号回退，整帧丢弃 | `seq <= 上次` |
| 400 | `invalid-arg` | 参数不在白名单/越界 | 功放 delta 校验 |
| 400 | `empty-command` | 没有可下发字段 | 功放空 delta |
| 400 | `unknown-command` | 命令不存在 | 未注册命令 |
| 400 | `invalid-device-type` | 命令与设备类型不符 | 例：对塔发 `select` |
| 400 | `invalid-port` / `invalid-outlet` | 端口参数缺失或格式错 | `select` |
| 400 | `unknown-port` | 端口不存在 | `select` |
| 400 | `invalid-direction` | 不是 in→out / 塔方向非法 | `select` / `tower_hold` |
| 400 | `unknown-channel` | 干接点通道未配置 | 继电器下发 |
| 400 | `transport-not-configured` | 未配 `relay_url` | B 档下发 |
| 400 | `source-id-required` | TX 上报缺 `source_id` | `/api/devices/tx` |
| 400 | `tx-active-required` | TX 上报缺布尔 `tx_active` | `/api/devices/tx` |
| 400 | `invalid-seq` | `seq` 不是数字 | `/api/devices/tx` |
| 400 | `invalid-tower-limit-top` 等 | 塔上报字段非布尔 | `/api/devices/report` |
| 401 | `seat-required` | 缺 `X-DX-Seat` | 所有指令 |
| 403 | `invalid-token` | TX 源 token 不匹配 | `/api/devices/tx` |
| 404 | `unknown-device` | 设备不存在 | 所有写接口 |
| 409 | `device-disabled` | 设备已停用 | 所有写接口 |
| 409 | `device-locked` | 他席持有租约（30 s） | 指令下发 |
| 409 | `direction-switch-too-fast` | 换向 <1000 ms | 塔 |
| 409 | `protocol-undetermined` | 切换器协议尚未判定 | 特定型号 |
| 423 | `tx-active` | **发射中禁止切换天线/矩阵 OUT** | `select`（带 `scope`、`source_id`） |
| 501 | `unsupported-control` | 型号不支持控制 | 只读型号 |
| 501 | `unsupported-switch-model` | 型号不受支持 | 例：Stack Match |
| 502 | `transport-connect` | 连不上设备/broker | 所有传输 |
| 502 | `transport-error` | 传输错误 | 所有传输 |
| 504 | `transport-timeout` | 继电器 HTTP 2 s 超时 | B 档下发 |

### 11.3 `state` 枚举

| 值 | 含义 | 适用 |
|---|---|---|
| `init` | 上电自检中 | 全部 |
| `idle` | 就绪且位置已确认 | 全部 |
| `switching` | 射频通路切换中 | switch / matrix / bpf |
| `moving` | 塔运动中 | tower |
| `fault` | 故障（见 `fault` / `fault_word`） | 全部 |
| `unknown` | 状态无法确定 | 全部 |

服务端映射（`service.js:184-257`、`tower.js:27-60`）：`switching` → `pending`；`fault` → `unverified`/`fault`；`unknown` → `unknown`；设备无上报 → `awaiting`/`no-source`。

### 11.4 `fault_word` 位定义

未定义的位一律保留 0；新增位必须在本文登记。

| 位 | 名称 | 含义 |
|---|---|---|
| 0 | `relay-fault` | 任一继电器反馈异常 |
| 1 | `limit-fault` | 限位回路异常/冲突 |
| 2 | `motor-fault` | 电机过流/堵转 |
| 3 | `sensor-fault` | 位置/功率传感器失效 |
| 4 | `overtemp` | 过温 |
| 5 | `vswr-high` | 驻波超限 |
| 6 | `comm-fault` | 内部通信总线故障 |
| 7 | `cal-fault` | 校准数据无效 |
| 8 | `interlock-bypassed` | 硬互锁被旁路 |
| 9 | `power-fault` | 供电异常 |
| 10–31 | 保留 | 必须为 0 |

### 11.5 关键语义

- **202 只表示"已发出"**，不代表已执行；真正确认来自回读（§6.4）。
- **423 `tx-active`** 是互锁唯一拒绝码，带 `scope`（`path`/`global`）与 `source_id`（`commands.js:497-503`）。
- **409 `device-locked`** 是席位租约冲突，30 s 自动过期（`runtime.js:9,146-155`）。
- 审计只追加，`result` 取 `accepted` / `duplicate` / `rejected` / `rejected_tx`（`commands.js:189-204`）。

## 12. 安全边界

本节是硬件验收的**否决项**。任一条不满足，不得接入现场。

### 12.1 必须保持静默的情况

| 情况 | 要求 | 理由 |
|---|---|---|
| 上电自检未完成 | 不发布状态帧，不发 `ports` | 防止把"未知"报成"已知" |
| 机械位置读不出 | 只发 `null`，不发猜测值 | 上报即承诺 |
| `tx_active` 期间无新事件 | 只按保活间隔发，不刷屏 | QoS 0 下高频无意义 |
| 内容与上一帧完全相同 | 不发（保活帧除外） | 心跳去重 |
| 收到非法 JSON / 未知 `cmd` | 丢弃，不回报 | 不是有效指令 |
| 收到 `device_id` 与自身不符的指令 | 丢弃 | 防串台 |
| 未完成校准的驻波表 | 不提供 `tx_active=true`（宁可不判发射） | 假发射误锁；假不发射害射频 |

> **"拒绝执行"不是静默**：凡收到有效指令但不能执行，必须回 ack 帧说明原因（§12.2）。

### 12.2 必须拒绝执行的情况

| 情况 | 返回 | 依据 |
|---|---|---|
| 发射中切换天线/矩阵 OUT | `tx-active` | `commands.js:496-503`（423） |
| 发射中切换 BPF / 直通 | `tx-active` / `rf-detected` | §9.3 |
| 远程把切换器置"全断" | `invalid-arg` | §6.3【禁止】 |
| 远程把矩阵某输入置 `null` | `invalid-arg` | §7.3【禁止】 |
| 多输入接同一输出 | `output-busy` | §7.3 |
| 让塔两路同时闭合 | `interlock-open` | `tower-hold.js:88-101` |
| 换向 <1000 ms | `direction-switch-too-fast` | `tower-hold.js:65-72` |
| 塔已到位还同向运行 | `limit-reached` | 硬件限位 |
| 双限位同时有效时任何动作 | `limit-conflict` | `tower.js:42-44` |
| 写校准/保护阈值 | `calibration-locked` | §10.4 |
| 参数越界 | `invalid-arg` / `unknown-*` | 各节 |

### 12.3 断电或重启后必须报告的状态

| 设备类 | 必须报告 | 绝不允许 |
|---|---|---|
| 切换器 | `state="init"`，实测 `position`（读不到则 `null`），`ports` 按实测 | 沿用断电前 `ports` |
| 矩阵 | 每输入实测通路，读不到的那个输入报 `null` | 把全部输入报成"上次选择" |
| 铁塔 | 两路 `motor_on=false`、`hold_active=false`，实测两限位 | 自动继续断电前方向 |
| BPF | `bypass` 按实测（推荐上电即直通），`band` 按实测仓 | 自动插入断电前仓 |
| 驻波表 | `tx_active=false`、`cal_valid` 按实测、`peak_fwd_w=0` | 报上一次 `tx_active=true`（会永久锁死切换） |

统一要求：

- `boot_id` 每次上电/复位必须变化；`uptime_ms` 从 0 起算。
- `seq` 必须持久化；做不到时重启首帧起**省略 `seq`**（§5.6）。
- 重启后首帧必须是**完整快照**，不能是增量。

服务端事实：运行态只存内存，服务重启后全部 `unknown`，必须等设备重新上报（`runtime.js:3-9`）。所以"设备重启后自己报"不是可选行为。

### 12.4 绝不允许由上位机远程触发的动作

射频安全：

| 动作 | 设备类 | 原因 |
|---|---|---|
| 发射中切换天线通路 / 矩阵输出 | switch / matrix | 带电热切换烧继电器、拉弧、损坏功放 |
| 远程"全断"某输入或输出 | switch / matrix | 发射时开路 → 全反射 → 功放损毁 |
| 多输入并到同一输出 | matrix | 射频合路，互调与功率叠加不可控 |
| 发射中切换 BPF 或强制直通 | BPF | 瞬态失配与带外发射 |
| 旁路/短接滤波器"应急" | BPF | 失去保护，干扰他台 |
| 远程写校准、清零基准、改保护阈值 | SWR | 读数与保护失效（同功放 §5.9 原则） |
| 强制把 `tx_active` 置 false | SWR | 直接解除全站天线互锁 |

机械安全：

| 动作 | 设备类 | 原因 |
|---|---|---|
| 解除或旁路上下限位 | tower | 越限拉断钢丝绳/损坏塔体 |
| 两路同时闭合 | tower | 正反转同时通电，堵转烧电机 |
| 超过 1500 ms 的持续 `hold` | tower | 失去人因确认，等同无人值守运行 |
| 超时后继续运行 / 自动重试 | tower | 卡阻时应断电，不是加大电流 |
| 断电保持输出（fail-active） | tower | 复电即自行动作，无人确认 |
| 一次指令触发整段行程 | tower | 与二态模型、看门狗设计相反 |
| 远程点动微调（短脉冲挪一点） | tower | 中间位置无机械锁定，风载下有风险 |

### 12.5 失联 fail-safe

| 设备类 | 断线/超时后的物理状态 | 服务端展示 |
|---|---|---|
| 切换器 / 矩阵 | 保持机械位置（自保持），不自动回默认位 | 功放式 driver 判 `offline`；B 档 10 s 后 `offline` |
| 铁塔 | **1500 ms 内断开两路** | `offline`，`last_state` 保留 |
| BPF | 保持当前位置 | `offline` |
| 驻波表 | 继续本地测量；无法上报时互锁降级 | `stale` → `offline`；互锁 `not-enabled` |

降级原则（与 `tx.js:5-9` 一致）：源不可用 = "未接入发射状态源"，**不阻断、不沿用旧值、不把 unknown 当发射**，但界面必须明确提示互锁未启用。

---

## 13. 接入现状与改造清单

### 13.1 已实现的能力

| 能力 | 位置 | 适用设备 |
|---|---|---|
| MQTT JSON 心跳/指令（`remote_control`） | `amp-link.js:600-700,953-979` | 功放 |
| 干接点脉冲/吸合/释放 | `relay.js:101-121` | 切换器、矩阵、塔 |
| 设备遥测上报（在线、限位、角度、端口） | `service.js:800-831` | 塔、驻波表、任意类型 |
| 发射状态上报与健康度 | `tx.js:72-199` | 驻波表（作为 TX 源） |
| 统一指令入口（租约、互锁、审计） | `commands.js:313-707` | 全部 |
| 切换器回读状态机 | `switch-link.js:371-428` | 有回读的型号 |
| 塔按住运行与看门狗 | `tower-hold.js` | 塔 |

### 13.2 必须新增（否则 A 档接不进来）

| 编号 | 事项 | 影响设备 | 说明 |
|---|---|---|---|
| G1 | 型号描述表新增官方品牌条目，`protocol="mqtt"`、`transport="mqtt"` | switch / matrix | 否则只能选"其他"，落回 `relay`，`host/port` 被当设备 IP |
| G2 | `CONFIG_ALLOWED` 为 tower / bpf / swr 增加 `host`/`port`/`device_id`/`topic_prefix`/`username`/`password` | tower / bpf / swr | BPF 当前完全没有 config 白名单 |
| G3 | MQTT driver：订阅 `heartbeat`、发布 `json_command`、把 `ports` 写入 `runtime.switch` | switch / matrix | 结构对齐 `amp-link.js` 的 `clients`/`signature`/`pollAmps` 模式 |
| G4 | 塔 MQTT driver：`hold`/`release` 映射到 `tower-hold` 运行时 | tower | 与 `tower-hold.js` 共用计时与看门狗 |
| G5 | 新增 `bpf_set` 命令与字段白名单（`band`/`bypass`/`mode`） | bpf | `COMMAND_TYPES` 当前无 bpf |
| G6 | 订阅 `/status` 并消费 LWT | 全部 | 当前在线判定靠连接或 10 s 超时 |
| G7 | 驻波表读数入库/投影（功率、SWR） | swr | `runtime.record` 只保留 tower/azimuth/port/moving/seq |
| G8 | 消费 `result`/`error`/`ack_msg_id` | 全部 | 当前 `result="error"` 整帧丢弃 |
| G9 | driver 对 `pending > 5 s` 标 `stale` | switch / matrix | 现在会永远停在 `pending` |
| G10 | 解析 `ts`（ISO 8601）并与 `timestamp` 做一致性校验 | 全部新设备 | 当前只存 `amp_ts` |

### 13.3 B 档映射速查

| 设备类 | 控制 | 状态 | 发射状态 |
|---|---|---|---|
| 切换器 | `POST relay_url` `{channel,action:"pulse",pulse_ms}` | `POST /api/devices/report` `{device_id,seq,...}` | 由驻波表提供 |
| 矩阵 | 同上（`channels["inN:outM"]` 或 `channels["outM"]`） | 同上 | 同上 |
| 铁塔 | `POST relay_url` `{channel,action:"on"/"off"}` | `{device_id,tower:{limit_top,limit_bottom,moving},seq}` | 不适用 |
| BPF | 无（只有 A 档） | `{device_id,seq}` 仅在线 | 由驻波表提供 |
| 驻波表 | 无 | `{device_id,seq}` | `POST /api/devices/tx` `{source_id,tx_active,ts,seq}` |

### 13.4 今天能接什么

| 硬件形态 | 今天 | 说明 |
|---|---|---|
| B 档切换器（网络继电器板） | **可以** | 可切换，状态 `unverified`，无回读 |
| B 档塔控器 | **可以** | 按住运行 + 限位上报，完整二态与看门狗 |
| B 档驻波表 | **可以** | 可提供 TX 状态并参与互锁 |
| A 档任意设备 | **不可以** | 需完成 G1–G10 |
| B 档 BPF | **只能看在线** | 无控制 |
| A 档 BPF | **不可以** | 需 G2/G5 |

### 13.5 遗留型号：帧格式未证实，不得作为官方规范

站内另有 5 类第三方/遗留设备的驱动，其报文格式是**根据参考实现与现场抓包推断**得到的，**没有厂商文档依据**：

| 型号 / 驱动 | 现状 | 本文态度 |
|---|---|---|
| RCS-4 | 帧格式由参考实现推断 | 仅作兼容参考 |
| Amplitec | 帧格式由参考实现推断 | 仅作兼容参考 |
| Station Genius | 帧格式由参考实现推断 | 仅作兼容参考 |
| Six2Two | 帧格式由参考实现推断 | 仅作兼容参考 |
| Antenna Genius legacy（`ag-tcp` 等） | 帧格式由参考实现推断 | 仅作兼容参考 |

约束：

1. 上述帧格式**不是标准**，本文不收录、不背书、不派生任何字段。
2. 官方硬件**不得**以这些帧格式为模板实现，也不得声明"兼容 XX"。将来若拿到厂商文档，另行立项核对，再决定是否进入标准。
3. 本文 §2.7 提到的"各品牌 TCP 驱动"即指这些型号；它们只影响老设备接入的寻址方式，不影响 A 档协议。
4. 服务端错误码 `protocol-undetermined` / `unsupported-switch-model`（§11.2）来自这些型号的不确定性，属实现现状，不是协议约定。

---

## 14. 字段与规则来源对照

### 14.1 来自标准（非本项目自造）

| 内容 | 标准 |
|---|---|
| JSON 语法、编码、禁止 `NaN`/`Infinity` | RFC 8259 §4, §6, §7, §8 |
| 数字范围与浮点精度 | IEEE 754 binary64；安全整数 2^53−1 |
| MQTT 3.1.1 报文、QoS、clean session、LWT | OASIS MQTT 3.1.1 §3.1.2.5, §4.3 |
| HTTP 方法、202/4xx/5xx 语义、安全/幂等 | RFC 9110 §9.2, §9.3.3, §15 |
| 时间格式 | ISO 8601-1:2019；RFC 3339 §5.6 |
| 单位 | SI / IEC 60027-2 |
| Schema 校验 | JSON Schema draft 2020-12 |

### 14.2 从现有实现反推（必须一致）

| 字段 / 规则 | 来源 |
|---|---|
| 主题 `{prefix}/{id}/heartbeat|json_command`、`topic_prefix` 缺省 | `amp-link.js:93-103` |
| `msg_id` 格式 `dxc-<36进制>-<随机>` | `amp-link.js:963-968` |
| `cmd=remote_control`、可省略 | `amp-link.js:620` |
| `timestamp` 秒 | `amp-link.js:967` |
| `data` delta 语义 | `amp-link.js:958-961`、`commands.js:94-113` |
| `data.device_id` 串台校验 | `amp-link.js:624-625` |
| `result="error"` 整帧丢弃 | `amp-link.js:626` |
| QoS 0 / clean / 重连 5 s / 协议 3.1.1 | `amp-link.js:652-665,682,971` |
| `ports` 按键增量合并 | `switch-link.js:395-405` |
| `verified`/`pending`/`unverified`/`stale` | `commands.js:533-551`、`switch-link.js:407-416` |
| 只有 `verified` 参与可达与互锁 | `service.js:352-359` |
| `in`/`antN`/`inN`/`outM` 端口键 | `rf.js:97-116` |
| 端口数 1–16、切换器缺省 2、矩阵 2/4 | `rf.js:17,53-59,97-116`、`model.js:237-248` |
| `bands` 必填（BPF）与 `^\d{1,3}m$` | `model.js:18-20,561-562` |
| `channels["in:antN"]` / `channels["antN"]` | `commands.js:206-212` |
| 干接点 `{channel,action,pulse_ms}`、2 s、50–5000 ms | `relay.js:9-18,52-103` |
| 租约 30 s、`X-DX-Seat` | `runtime.js:9`、`commands.js:50-52,139-142` |
| 423 `tx-active` 与 `scope`/`source_id` | `commands.js:494-503` |
| 塔 500/1500/1000 ms | `tower-hold.js:9-11` |
| 两路不同时闭合、换向先断开 | `tower-hold.js:88-101` |
| 限位原始电平 + NO/NC 取反 | `tower.js:17-25` |
| 限位冲突 → fault | `tower.js:42-44` |
| 运动超时 → unknown（缺省 120 s） | `tower.js:46-56`、`model.js:22,575-585` |
| 10 s 无上报判离线 | `service.js:46,394-400` |
| TX `source_id` 模式、严格布尔、默认 2000 ms | `tx.js:14-18,63-89` |
| TX 健康 `ok`/`stale`/`offline`（3×） | `tx.js:46-54` |
| `stale-seq` 丢弃 | `tx.js:102-114`、`service.js:808-816` |
| token → 403 `invalid-token` | `tx.js:92-98` |
| 未知 TX 源自动登记（priority 1000） | `tx.js:128-140` |
| `config` 白名单与长度限制（`device_id` ≤100） | `model.js:35-54` |
| 直连 / 串口服务器寻址 | `control.js:164-214` |
| `/api/devices` 快照字段 | `service.js:345-464` |

### 14.3 本文新定（需评审）

| 项 | 本文取值 | 为什么需要确认 |
|---|---|---|
| `proto` 版本字段 | `"1.0"`，major/minor | AMP1000 无版本字段；引入方式与拒绝策略需确认 |
| `ts`（ISO 8601） | 新设备必填，与 `timestamp` 并存 | 双时间字段是否可接受；是否只保留 `ts` 的新设备子集 |
| 主题前缀命名 | `switch/device` 等 | 出厂后再改要升级全部固件 |
| `device_class` | 冗余字段 | 便于抓包归属，增加一列维护成本 |
| `boot_id` / `uptime_ms` | 必填 | 用于解决"重启后 seq 归零"与"是否真重启" |
| ack 帧 | 复用 `heartbeat`，500 ms 内回 | 服务端当前不消费；是否强制 |
| `/status` + retained LWT | 独立主题 | 需 G6 |
| 心跳间隔（5 s / 1 s） | §5.7 | 无历史依据，按 10 s 与 2 s 超时反推 |
| 单帧 8192 字节上限 | §3.6 | 需与实际天线表规模核对 |
| 字段精度（0.1 W / 0.01 SWR / 0.1 ℃） | §3.2 | 与传感器分辨率绑定 |
| `position`/`target`/`switching`/`relay_state` | 切换器专属 | 现有实现只有 `ports` |
| `rf_detected` / `tx_active`（设备侧） | 本地 RF 检测 | 是否强制每台都装 RF 检测，属硬件成本 |
| 矩阵 `output-busy` | 禁止多输入共用一个输出 | 现有代码不校验该冲突 |
| 塔 `limit_wiring`/`hardware_interlock`/`motor_on`/`hold_active`/`travel_ms` | 诊断与验收字段 | 服务端暂不消费 |
| 塔 `action=hold|release|stop` + `hold_ms` | MQTT 层语义 | B 档是 `on/off`；A 档是否复用通道号需确认 |
| BPF `band`/`bypass`/`mode` 与 `bpf_set` | 新增命令 | 服务端完全没有 BPF 控制 |
| 驻波表字段集 | 本文定义 | 当前不落库（G7） |
| 发射判定门限与 200/300 ms 时序 | 5 W 起判、≤50 ms 去抖 | 直接影响互锁可靠性 |
| `clear_peak` | 唯一允许的 SWR 远程动作 | 是否需要"远程清零" |
| 断电后 BPF 默认直通 | §9.4 | 直通与保持当前仓之间是安全取舍 |
| 切换器 200 ms / 1 s 超时 | §6.5 | 依赖具体继电器与机械结构 |
| `fault_word` 位分配 | §11.4 | 位定义一旦发布不宜改 |
| 设备侧 `msg_id` 去重缓存 16 条 | §2.6 | 内存与去重强度的取舍 |

---

## 15. 待评审确认清单

按影响面排序，前 7 条不定无法冻结 v1.0：

| 编号 | 待确认 | 影响 |
|---|---|---|
| R1 | 主题前缀最终命名（§2.4） | 出厂后再改要升级所有固件 |
| R2 | 是否要求官方硬件同时实现 A + B 档（§1.2） | 决定首批硬件能否在现版本上线 |
| R3 | `proto` 版本策略与 `ts` 双时间字段（§4.1、§3.3） | 影响所有新固件，且与 AMP1000 兼容边界相关 |
| R4 | ack 帧是否强制（§5.10） | 固件复杂度与现场排障方式 |
| R5 | G1/G2 服务端排期（型号表 + config 白名单） | A 档能否接入的前提 |
| R6 | BPF 是否立项远程控制（G5 / §9.3） | BPF 是否只做"在线可见" |
| R7 | 塔 A 档用 `direction` 还是沿用干接点通道号（§8.3） | 塔控器固件接口 |
| R8 | 驻波表读数是否入库（G7） | 是否扩 `runtime` 与前端卡片 |
| R9 | 发射判定门限/去抖（§10.2） | 互锁可靠性 |
| R10 | 心跳间隔（§5.7）与保活裁剪 | 带宽与离线误判 |
| R11 | 单帧 8192 字节上限（§3.6） | 与天线表规模相关 |
| R12 | 断电后 BPF 默认直通（§9.4） | 安全取舍 |

---

## 附录 A · 一帧到底长什么样（端到端）

以切换器为例，从操作员点击到状态确认的完整链路：

```
操作员点击 ant3
   │
   ▼
POST /api/devices/SW-A/command
X-DX-Seat: OP-A
{"command":"select","port":"in","outlet":"ant3"}
   │  commands.js：类型/端口/方向校验 → TX 互锁 → 租约 → dispatch
   ▼
MQTT PUBLISH switch/device/SW-A/json_command   (QoS 0, retain=false)
{"msg_id":"dxc-...","cmd":"remote_control","timestamp":...,"ts":"...Z",
 "data":{"device_id":"SW-A","ports":{"in":"ant3"}}}
   │
   ▼  设备：break-before-make，≤200 ms
MQTT PUBLISH switch/device/SW-A/heartbeat
{"data":{"device_id":"SW-A","device_class":"switch","result":"ok",
         "ack_msg_id":"dxc-...","seq":43}}
   │
   ▼  到位后
MQTT PUBLISH switch/device/SW-A/heartbeat
{"data":{"device_id":"SW-A","device_class":"switch","state":"idle",
         "ports":{"in":"ant3"},"switching":false,"seq":44}}
   │
   ▼  driver: writeVerifiedPorts → state="verified"
GET /api/devices → switches["SW-A"].verified = true → 该通路进入 RF 可达与互锁
```

HTTP 同步返回：

```json
{
  "ok": true,
  "command_id": "cmd-m7k2p1-1",
  "duplicate": false,
  "dispatched": true,
  "port": "in",
  "outlet": "ant3",
  "channel": null,
  "verified": false,
  "state": "pending",
  "protocol_verified": true,
  "interlock": "enabled"
}
```

`state: "pending"` 是关键：**HTTP 202 只代表下发成功，验证永远靠回读。**

---

## 附录 B · JSON Schema（可执行部分）

### B.1 文件清单

所有 Schema 为 **JSON Schema draft 2020-12**，与本文同目录（`docs/schema/`）：

| 文件 | 校验对象 | 根 `$id` |
|---|---|---|
| `common.schema.json` | 共用 `$defs`（信封、时间、数值、错误码、`device_id`） | `https://dx-compass.local/schema/common.schema.json` |
| `heartbeat-switch.schema.json` | 切换器 heartbeat（含 ack 帧） | `.../heartbeat-switch.schema.json` |
| `command-switch.schema.json` | 切换器 json_command | `.../command-switch.schema.json` |
| `heartbeat-matrix.schema.json` | 矩阵 heartbeat | `.../heartbeat-matrix.schema.json` |
| `command-matrix.schema.json` | 矩阵 json_command | `.../command-matrix.schema.json` |
| `heartbeat-tower.schema.json` | 塔 heartbeat | `.../heartbeat-tower.schema.json` |
| `command-tower.schema.json` | 塔 json_command | `.../command-tower.schema.json` |
| `heartbeat-bpf.schema.json` | BPF heartbeat | `.../heartbeat-bpf.schema.json` |
| `command-bpf.schema.json` | BPF json_command | `.../command-bpf.schema.json` |
| `heartbeat-swr.schema.json` | 驻波表 heartbeat | `.../heartbeat-swr.schema.json` |
| `command-swr.schema.json` | 驻波表 json_command | `.../command-swr.schema.json` |
| `http-tx.schema.json` | `POST /api/devices/tx` 请求体 | `.../http-tx.schema.json` |

### B.2 校验方式

Node（AJV）：

```bash
npm i -g ajv-cli@5
ajv validate -r docs/schema/common.schema.json \
  -s docs/schema/heartbeat-switch.schema.json -d frame.json
```

Python：

```python
import json
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

common = json.load(open('docs/schema/common.schema.json'))
schema = json.load(open('docs/schema/heartbeat-switch.schema.json'))
registry = Registry().with_resource(common['$id'], Resource.from_contents(common))
Draft202012Validator(schema, registry=registry).validate(json.load(open('frame.json')))
```

> 跨文件 `$ref` 采用相对 `$id`：校验器需先把 `common.schema.json` 注册到同一 `$id` 空间。JSON Schema 2020-12 允许未知关键字被忽略，因此 Schema 里对"未知字段"一律用 `additionalProperties: true`，与 §4.3 的"接收方忽略未知字段"保持一致。

### B.3 Schema 的约束边界

Schema 只做**结构、类型、范围、必填**校验，不做下列语义校验（由服务端 driver 与设备固件各自实现）：

- `ports` 的键是否在 `1…out_count` / `1…in_count` 内；
- `position` 与 `ports` 是否自洽；
- 限位 NO/NC 逻辑；
- 互锁与看门狗时序；
- `tx_active` 的物理真实性。

这些属于"状态机语义"，没有一份 JSON Schema 能可靠表达；不要试图用 Schema 代替固件自检。

Schema 的枚举策略（与 §3.7 一致）：

- **开放枚举**（`state`、`error`、`fault`）：Schema 只做 `type: string` + 长度/字符约束，**不使用 `enum`**，保证旧校验器不会拒绝新枚举值。
- **封闭枚举**（`device_class`、`result`、`action`）：使用 `enum`；新增值属于 minor 升级，Schema 随之更新。
- 数值一律用 `minimum`/`maximum` + `type`，不用 `multipleOf` 约束小数位（浮点在验证器间行为不一致，精度由 §3.2 的发送方规则保证）。

