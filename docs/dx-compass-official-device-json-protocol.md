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
 "timestamp":1794384000,"ts":"2026-11-15T06:40:00.000Z",
 "data":{"device_id":"SW-A"}}
```

> `1794384000` 与 `2026-11-15T06:40:00.000Z` 对应同一秒，仅作示例；实际报文两者必须一致。

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
| `ts` | string | 【新设备】必填 | ISO 8601 UTC，`Z` 结尾，毫秒三位 | 缺失时服务端回退用 `timestamp`，新 driver 必须优先用 `ts` |
| `proto` | string | 可选 | `<major>.<minor>` | 缺失等同 `"1.0"` |
| `data` | object | 必填 | 非空、非数组 | 数组或缺失 → 整帧丢弃（`amp-link.js:619-622`） |

服务端下发的完整形态：

```json
{
  "msg_id": "dxc-m7k2p1-a1b2c3d4",
  "cmd": "remote_control",
  "timestamp": 1794384000,
  "ts": "2026-11-15T06:40:00.000Z",
  "proto": "1.0",
  "data": { "device_id": "SW-A", "ports": { "in": "ant3" } }
}
```

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
 "timestamp":1794384001,"ts":"2026-11-15T06:40:01.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","result":"ok",
         "ack_msg_id":"dxc-m7k2p1-a1b2c3d4","seq":42}}
```

失败时：

```json
{"msg_id":"sw-a-ack-0008","cmd":"remote_control",
 "timestamp":1794384001,"ts":"2026-11-15T06:40:01.000Z","proto":"1.0",
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
 "timestamp":1794384000,"ts":"2026-11-15T06:40:00.000Z","proto":"1.0",
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
 "timestamp":1794384000,"ts":"2026-11-15T06:40:00.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","state":"init",
  "position":null,"ports":{"in":null},"target":null,"switching":false,
  "out_count":6,"seq":1,"boot_id":"b7f3c1","uptime_ms":820}}
```

服务端显示"在线 / 位置未知"，不参与互锁。

**(2) 服务端下发切换**

```json
{"msg_id":"dxc-m7k2p1-a1b2c3d4","cmd":"remote_control",
 "timestamp":1794384010,"ts":"2026-11-15T06:40:10.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","ports":{"in":"ant3"}}}
```

**(3) 设备 ack**

```json
{"msg_id":"sw-a-0102","cmd":"remote_control",
 "timestamp":1794384010,"ts":"2026-11-15T06:40:10.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","result":"ok",
  "ack_msg_id":"dxc-m7k2p1-a1b2c3d4","seq":43}}
```

**(4) 回读确认（切换完成后）**

```json
{"msg_id":"sw-a-0103","cmd":"remote_control",
 "timestamp":1794384011,"ts":"2026-11-15T06:40:11.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","state":"idle",
  "position":3,"ports":{"in":"ant3"},"target":"ant3","switching":false,
  "rf_detected":false,"relay_state":[false,false,true,false,false,false],
  "error":"","result":"ok","seq":44}}
```

服务端把 `ports` 标为 `verified`，此后该通路进入 RF 可达与互锁。

**(5) 发射中拒绝**

```json
{"msg_id":"sw-a-0104","cmd":"remote_control",
 "timestamp":1794384020,"ts":"2026-11-15T06:40:20.000Z","proto":"1.0",
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
 "timestamp":1794384100,"ts":"2026-11-15T06:41:40.000Z","proto":"1.0",
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
 "timestamp":1794384200,"ts":"2026-11-15T06:43:20.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","ports":{"in2":"out1"}}}
```

**(2) ack**

```json
{"msg_id":"mx-a-0201","cmd":"remote_control",
 "timestamp":1794384200,"ts":"2026-11-15T06:43:20.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","device_class":"matrix","result":"ok",
  "ack_msg_id":"dxc-m7k2pa-00112233","seq":19}}
```

**(3) 回读（只报变化的输入）**

```json
{"msg_id":"mx-a-0202","cmd":"remote_control",
 "timestamp":1794384201,"ts":"2026-11-15T06:43:21.000Z","proto":"1.0",
 "data":{"device_id":"MX-A","device_class":"matrix","state":"idle",
  "ports":{"in2":"out1"},"switching":false,"seq":20}}
```

**(4) 拒绝：目标输出已被占用**

```json
{"msg_id":"mx-a-0203","cmd":"remote_control",
 "timestamp":1794384210,"ts":"2026-11-15T06:43:30.000Z","proto":"1.0",
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

<!-- DXC-APPEND -->
