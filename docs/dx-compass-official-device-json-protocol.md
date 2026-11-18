# DX-Compass 官方设备 JSON 通信协议（v1.0）

> **状态：设计稿，平台尚未实现。**
> 本协议只完成了文档、JSON Schema 与示例校验；截至 2026-11-17，服务端只为既有功放 MQTT 路径提供 `json_command`，切换器 / 矩阵 / 塔 / BPF / 驻波表五类设备的官方 driver、上线心跳与 ack 状态机仍未实现（G1–G10）。没有设备实现过本协议，不能把它当成现网契约。

- 适用设备：天线切换器（1×n）、矩阵切换器（m×n）、铁塔升降控制器、多波段 BPF 组、驻波表。
- 文档定位：DX-Compass 官方硬件开发的唯一标准依据。硬件按本文实现即可接入本平台；平台实现变更时先改本文，再改硬件。
- **边界声明**：本协议为 DX-Compass 官方设备标准，不承诺与任何第三方设备兼容。
- 可执行契约：JSON Schema（draft 2020-12），文件清单见附录 B。

> 阅读顺序：§1（范围）→ §2（引用标准）→ §3（传输与主题）→ §4（报文结构）→ §5（上线与心跳）→ §6（兼容性）→ §7（通用字段）→ 按设备读 §8–§12 → §13（错误码）→ **§14（安全边界，验收否决项）**。

---

## 1. 范围与约定

### 1.1 适用范围

| 在范围内 | 不在范围内 |
|---|---|
| 上述 5 类官方设备的 MQTT JSON 协议（A 档） | 第三方设备的任何帧格式、按键码、私有 topic |
| 上述 5 类官方设备的 HTTP JSON 兼容面（B 档） | 平台内部模块划分、部署与排期 |
| 设备侧状态机、时序、安全边界 | 电台、旋转器、功放等非本协议设备 |
| 结构校验用 JSON Schema | 现场网络与 broker 运维 |

### 1.2 术语

| 术语 | 含义 |
|---|---|
| 快照（snapshot） | 设备当前完整状态；上报用 |
| 增量（delta） | 只含变化字段；下发用 |
| 回读（readback） | 设备回报的真实机械状态，"已切换"的唯一证据 |
| 互锁（interlock） | 发射中禁止天线/矩阵切换的保护 |
| 看门狗（watchdog） | 塔控制器 1500 ms 未续期即断开输出 |
| 席位（seat） | 操作员身份，平台侧指令必带 `X-DX-Seat` |
| A 档 | MQTT JSON 主协议 |
| B 档 | HTTP JSON 兼容面 |

### 1.3 标注约定

| 标注 | 含义 |
|---|---|
| **必须** | 强制要求，不满足不得接入 |
| **禁止** | 安全或一致性禁忌 |
| **可选** | 可以省略，省略后按缺省行为 |
| **只读** | 只允许设备上报，平台下发时应忽略 |
| **【待评审】** | 本文新增且尚未冻结的约定，见 §15 |

### 1.4 设备类与端口模型

| 设备类 | `type` | 射频端口（方形） | 控制口（圆形） | 状态口（圆形） | 章节 |
|---|---|---|---|---|---|
| 天线切换器 | `switch` | `in` + `ant1…antN` | `relay` | `position` | §8 |
| 矩阵切换器 | `matrix` | `in1…inN` + `out1…outM` | `relay` | `route` | §9 |
| 铁塔升降控制器 | `tower` | 不接射频 | `relay` | `limit` | §10 |
| 多波段 BPF 组 | `bpf` | `in` + `out` | 无 | 无 | §11 |
| 驻波表 | `swr` | `in` + `out` | `report` | `status` | §12 |

端口规则：

- 切换器：`in` 是电台侧 COMMON，`ant1…antN` 是天线侧出口；`N = out_count`，1–16，缺省 2。
- 矩阵：`in1…inN` 输入、`out1…outM` 输出；`N = in_count`（缺省 2）、`M = out_count`（缺省 4），各 1–16。
- 天线与假负载只有 `in`；驻波表、BPF 为串联环节，`in`/`out` 各一。
- BPF 的射频口固定为 `in` + `out` 各一个；**支持哪些波段由设备自己上报 `supported_bands`（§11.2）**，平台不预置波段清单。首帧上报之前平台按"能力未知"处理：不生成可选波段、不据此做 RF 剪枝，但仍可展示该设备为在线。
- 端口键只允许 `[A-Za-z0-9:_-]{1,32}`。

### 1.5 两种接入档

| 档 | 传输 | 用途 | 说明 |
|---|---|---|---|
| **A 档** | MQTT JSON | 官方设备协议主体 | 必须实现 |
| **B 档** | HTTP JSON | 兼容面：干接点控制、遥测上报、发射状态 | 应实现，保证现场可快速联调 |

两档表达同一物理动作，映射见 §3.8。B 档的动作语义与 A 档一一对应，不得出现"只有 B 档才能做"的能力。

### 1.6 三条不可协商的规则

1. **上报是快照，下发是增量。** 设备上报的 `data` 是完整状态（缺字段即 null/false，整帧替换）；平台下发的 `data` 只含变化字段，未提供的设备保持原值。
2. **平台是唯一状态源。** 设备没上报就是 `unknown`，平台绝不从配置或上一次会话补一个"看起来合理"的值。
3. **只有回读确认的通路才参与 RF 可达与互锁。** 只写型号永远不产生 `ports`；平台只认 `verified` 的通路。未确认时互锁按"选择未知"保守覆盖全部端口。

---

## 2. 引用标准

| 标准 | 版本 | 用在哪里 |
|---|---|---|
| RFC 8259 · JSON 数据交换格式 | 2017-12 | §4.3 语法、§4.4 数值、禁止 `NaN`/`Infinity` |
| OASIS MQTT | 3.1.1（2014-10-29） | §3.2 版本、§3.3 QoS/retain/LWT |
| OASIS MQTT | 5.0（2019-03-07） | §3.2 仅"可选、不得依赖其特性" |
| RFC 9110 · HTTP 语义 | 2022-06 | §3.6 方法与状态码、§3.7 幂等、§13.2 错误码 |
| JSON Schema | draft 2020-12 | 附录 B |
| ISO 8601-1:2019 / RFC 3339 §5.6 | — | §4.5 时间（UTC，`Z`） |
| IEEE 754 binary64 | 2019 | §4.4 精度与安全整数 |
| SI / IEC 60027-2 | — | §4.6 单位 |

---

## 3. 传输与主题

### 3.1 连接方式

官方设备一律以 **MQTT 客户端**身份主动连接站内 broker，平台作为另一个 MQTT 客户端发布/订阅。

- 平台只认 `device_id`，不需要知道设备 IP，也不做扫描发现。
- 设备可放在 NAT 后，现场不需要固定 IP。
- 断线由 broker 的连接状态与 LWT 反映，不依赖"最后一次上报时间"。

连接参数：

| 项 | 取值 | 要求 |
|---|---|---|
| MQTT 版本 | 3.1.1 | 必须支持 |
| `clean session` | `true` | 允许 |
| `connect timeout` | 5000 ms | 设备侧 ≤ 10 s |
| 自动重连 | 5000 ms | ≤ 10 s |
| `keepalive` | 60 s | ≤ 60 s |
| QoS | 0 | 必须支持 |
| retain | 心跳/指令不用 | 心跳/指令禁止 retain |

> QoS 0 是刻意的：状态有下一帧覆盖，重发只会放大乱序。设备不得因 QoS 0 自行"多条重发"，用新 `seq` 覆盖即可。

### 3.2 MQTT 版本选择

| 版本 | 结论 | 说明 |
|---|---|---|
| **3.1.1** | **必须支持** | 平台客户端固定使用 3.1.1，现网 broker 已按此验证 |
| 5.0 | 可选，不得依赖 | 若 broker 与固件都支持可启用，但协议不得使用 5.0 专有特性（Reason Code、Message Expiry、Shared Subscription、User Properties），否则降级到 3.1.1 即失效 |

不使用 3.1.1 的以下特性：

- 不使用持久会话；**不依赖 broker 补发离线消息**。
- 不使用保留消息承载状态（唯一例外：`/status` LWT，明确 `retain=true`）。
- 不使用通配符发布（`+`、`#` 只允许出现在平台订阅侧）。

### 3.3 QoS、retain 与 LWT

| 消息 | QoS | retain | 说明 |
|---|---|---|---|
| `heartbeat` | 0 | false | 下一帧可覆盖 |
| `json_command` | 0 | false | 设备重连后不补发 |
| `status`（LWT） | 0 | **true** | 唯一允许 retain 的主题 |

LWT 用法（MQTT 3.1.1 §3.1.2.5）：设备在 CONNECT 时注册遗嘱，broker 在非正常断开（网络中断、掉电、keepalive 超时）时代发。

```json
{
  "topic": "switch/device/SW-A/status",
  "payload": "{\"online\":false,\"device_id\":\"SW-A\",\"reason\":\"lwt\",\"ts\":\"2026-11-15T06:40:00.000Z\"}",
  "qos": 0,
  "retain": true
}
```

上线后立即向同一主题发布 `{"online":true,...}`，同样 `retain=true`。**必须使用独立主题**：若把 LWT 挂在 `heartbeat` 上并 retain，新连上的平台会读到一帧过期快照，被当成当前状态。

掉线检测的三层机制：

| 层 | 机制 | 时延 |
|---|---|---|
| 1 | TCP/MQTT 连接断开 | 即时 |
| 2 | LWT retained `online=false` | keepalive 1.5×（默认 90 s） |
| 3 | 最近上报超时 | 塔/驻波表 10 s；TX 源 2 s |

### 3.4 主题命名规范

```
{topic_prefix}/{device_id}/heartbeat       设备 → 平台：状态快照、ack
{topic_prefix}/{device_id}/json_command    平台 → 设备：控制增量
{topic_prefix}/{device_id}/status          设备 → 平台：LWT 在线状态（retain）
```

`topic_prefix` 缺省值：

| 设备类 | 缺省 `topic_prefix` | heartbeat 示例 |
|---|---|---|
| 切换器 | `switch/device` | `switch/device/SW-A/heartbeat` |
| 矩阵 | `matrix/device` | `matrix/device/MX-A/heartbeat` |
| 铁塔 | `tower/device` | `tower/device/TW-A/heartbeat` |
| BPF | `bpf/device` | `bpf/device/BPF-A/heartbeat` |
| 驻波表 | `swr/device` | `swr/device/SWR-A/heartbeat` |

| 规则 | 说明 |
|---|---|
| `topic_prefix` 是前缀 | 平台拼 `prefix + '/' + device_id + '/' + 动作`；固件不要重复拼 `device_id` |
| `device_id` 必须单段 | ≤100 字符；禁止 `/`、`+`、`#`、空格、空串 |
| 禁止通配符发布 | 固件不得向含 `+`/`#` 的主题发布 |
| 大小写敏感 | `device_id` 必须与配置逐字一致 |
| 单设备单主题 | 一台设备只用一个 `device_id`，多台不得共用 |

### 3.5 寻址

| 形态 | 地址来源 | 适用 |
|---|---|---|
| **官方设备** | `config.host` + `config.port` = **broker 地址**；`config.device_id` = 主题键 | A 档 |
| 串口服务器转发 | 控制连线连到串口服务器，地址与串口参数继承服务器 | 仅现场遗留的串口设备，不适用于官方设备 |

对官方设备的要求：

- **必须支持直连 broker**；不要求固定 IP、不要求端口映射。
- **不要求**实现串口/串口服务器转发；官方形态是网络设备。
- **不需要**在设备侧保存站内拓扑、席位、租约等站点信息。
- 一台设备只允许一个控制入口（broker），不允许多个上位机直连设备私有端口。

### 3.6 B 档 HTTP 语义

| 端点 | 方法 | 语义（RFC 9110） | 成功码 | 幂等 |
|---|---|---|---|---|
| `POST /api/devices/:id/command` | POST | 创建一次控制动作 | 202 Accepted | 否 |
| `POST /api/devices/report` | POST | 提交一次遥测 | 200 OK | 否（同值重复无副作用） |
| `POST /api/devices/tx` | POST | 提交一次发射状态 | 200 OK | 否（`seq` 提供去重） |
| `POST <relay_url>` | POST | 干接点动作（`pulse` 重复会产生两次脉冲） | 200–299 | 否 |
| `GET /api/devices` | GET | 只读快照（安全且幂等，RFC 9110 §9.2） | 200 OK | 是 |

- **202 只表示"已受理，未完成"**（RFC 9110 §15.3.3）。完成证据是设备回读。
- 请求体与响应体必须是 `application/json`，UTF-8。
- 不使用 `PUT`/`PATCH`/`DELETE`：所有写操作都是"提交一个动作或一帧数据"，语义上是 POST。
- 错误码用法见 §13.2。

### 3.7 幂等性与重试

| 场景 | 规则 |
|---|---|
| HTTP POST 重试 | 仅可对连接失败（无响应）重试；收到 4xx 不得重试 |
| `select` 重复下发 | 目标相同则收敛，不产生额外物理动作；不同目标按新指令执行 |
| 塔 `hold` 重复 | 视为续期，**不得重复吸合** |
| 设备侧去重 | 同一 `msg_id` 只执行一次，至少保留最近 16 条的环形缓存 |
| TX 上报去重 | `seq` 单调；`seq <= 上次` 返回 `ignored:"stale-seq"` 且不更新 |
| 继电器 `pulse` | 天然非幂等；平台不重试 |

> 为什么设备还要按 `msg_id` 去重：QoS 0 不会重复，但现场可能存在桥接、抓包重放或上层重试。设备侧去重是最后一道保险。

### 3.8 B 档动作映射

| 设备类 | 控制 | 状态上报 | 发射状态 |
|---|---|---|---|
| 切换器 | `POST relay_url` `{channel,action:"pulse",pulse_ms}` | `POST /api/devices/report` `{device_id,seq,...}` | 由驻波表提供 |
| 矩阵 | 同上（通道键 `inN:outM` 或 `outM`） | 同上 | 同上 |
| 铁塔 | `POST relay_url` `{channel,action:"on"/"off"}` | `{device_id,tower:{limit_top,limit_bottom,moving},seq}` | 不适用 |
| BPF | 仅 A 档 | `{device_id,seq}`（仅在线） | 由驻波表提供 |
| 驻波表 | 无 | `{device_id,seq}` | `POST /api/devices/tx` `{source_id,tx_active,ts,seq}` |

`pulse_ms` 范围 50–5000，缺省 400；继电器单次请求超时 2 s。

## 4. 报文结构

### 4.1 信封字段

| 字段 | 类型 | 必填 | 约束 | 缺省行为 |
|---|---|---|---|---|
| `msg_id` | string | 必须 | 1–64，`[A-Za-z0-9._:-]` | 平台下发格式 `dxc-<36进制毫秒>-<8位随机>`；设备自定，建议全局唯一 |
| `cmd` | string | 必须 | 固定 `remote_control` | 平台允许省略，省略按 `remote_control` 处理；设备建议始终显式携带 |
| `timestamp` | number | 必须 | Unix **秒**，10 位整数 | 平台原样记录，不做毫秒换算 |
| `ts` | string | 设备上行必须 | ISO 8601 UTC，`Z` 结尾，毫秒三位 | 缺失时平台回退用 `timestamp`；解析以 `ts` 优先 |
| `proto` | string | 可选 | `<major>.<minor>` | 缺失等同 `"1.0"` |
| `data` | object | 必须 | 非空、非数组 | 数组或缺失 → 整帧丢弃 |

平台下发的完整形态：

```json
{
  "msg_id": "dxc-m7k2p1-a1b2c3d4",
  "cmd": "remote_control",
  "timestamp": 1794724810,
  "ts": "2026-11-15T06:40:10.000Z",
  "proto": "1.0",
  "data": { "device_id": "SW-A", "ports": { "in": "ant3" } }
}
```

> 平台下行的最小形态只有 `msg_id` / `cmd` / `timestamp` / `data` 四个字段，`ts` 与 `proto` 可能缺失。设备解析必须同时接受"有 `ts`"与"无 `ts`"两种下发，缺失时用帧到达时间兜底。

### 4.2 快照与增量

上报是快照，缺字段的含义：

1. 未出现的数值字段 = `null`（不是保留旧值）。
2. 未出现的布尔字段 = `false`。
3. 未出现的字符串字段 = `""`。
4. 未出现的数组字段 = `[]`。
5. 位图字段（`fault_word`）缺失 = 0，即"无告警"。

所以设备**不要省字段**：不需要的字段也照常上报（该 null 就 null），否则平台会显示成未知/无。

例外：`ports` 按键增量合并。矩阵可只报变化的输入；清空某输入用 `null`。

### 4.3 JSON 语法（RFC 8259）

| 约束 | 要求 | 依据 |
|---|---|---|
| 编码 | UTF-8，不带 BOM | RFC 8259 §8.1 |
| 顶层类型 | **必须是 object**，禁止数组、字符串、数字 | RFC 8259 §2 |
| 注释 / 尾随逗号 | 禁止 | RFC 8259 §2、§4 |
| 重复键 | 禁止（同一对象内键唯一） | RFC 8259 §4 |
| `NaN` / `Infinity` / `-Infinity` | **禁止**（JSON 无此字面量） | RFC 8259 §6 |
| 控制字符 | 必须转义（`\u00XX`） | RFC 8259 §7 |
| 非 ASCII | 可直接 UTF-8，也可 `\uXXXX` | RFC 8259 §8.2 |
| 前导零 / 前导 `+` | 禁止（`01`、`+1` 非法） | RFC 8259 §6 |

平台对非法 JSON 的行为是静默忽略，不回错误。固件必须在上报前做一次序列化自检。

### 4.4 数值表示

| 类型 | 规则 |
|---|---|
| 整数 | 必须落在 IEEE 754 安全整数范围 ±(2^53−1)；本协议所有整数实际 ≤ 1.3×10⁹（频率 Hz） |
| 计数类（`*_count`、`position`、`seq`） | 用整数，禁止 `2.0` 写法 |
| 浮点 | 最多 3 位小数；不使用指数记法（`1e3`）；不写 `-0` |
| 精度约定 | 功率 0.1 W；驻波比 0.01；温度 0.1 ℃；频率整数 Hz；角度 0.1° |
| 比较 | 浮点按 `|a−b| ≤ 1e-3` 判定相等，禁止用 `===` 比浮点 |
| 未知值 | 用 `null`；**禁止**用 `-1`、`0`、`9999` 当哨兵值 |
| `swr` | 无量纲；无 RF 时 `null`；不得用 `0` 表示无穷大 |
| 百分比 | 不传百分比，统一传物理量（W、℃、dB） |

设备内部的 ADC 码值、dBm、传感器原始值必须在设备侧换算完毕再上报。

### 4.5 时间（ISO 8601 / RFC 3339）

| 字段 | 类型 | 格式 |
|---|---|---|
| `ts` | string | `YYYY-MM-DDTHH:MM:SS.sssZ`（UTC，毫秒三位，`Z` 结尾） |
| `timestamp` | number | Unix 秒（10 位整数），兼容字段 |

1. 两个字段必须表达**同一时刻**，允许 ±1 s 误差。
2. 统一 UTC，**禁止** `+08:00` 偏移写法与本地时间。
3. 设备时钟未同步时，用"开机单调计时 + 首次 NTP/SNTP 结果"折算；无法折算时 `ts` 取设备当前已知时间，但 `uptime_ms` 必须真实。
4. 精度毫秒，亚毫秒不传。

### 4.6 单位

| 物理量 | 单位 | 符号 | 字段示例 |
|---|---|---|---|
| 频率 | 赫兹 | Hz | `freq_hz` |
| 功率 | 瓦特 | W | `fwd_power_w` |
| 增益 / 损耗 | 分贝 | dB | `insertion_loss_db` |
| 驻波比 | 无量纲 | — | `swr` |
| 温度 | 摄氏度 | ℃ | `temperature_c`（有符号） |
| 时间间隔 | 毫秒 | ms | `hold_ms`、`uptime_ms` |

**dBm 与 W 的换算**（设备内部若用 dBm，必须换算后上报 W）：

```
P(W)   = 10^((P(dBm) − 30) / 10)
P(dBm) = 10·log10(P(W) / 1mW) = 10·log10(P(W)) + 30
```

- 0 dBm = 1 mW；30 dBm = 1 W；60 dBm = 1 kW。
- 换算后按 0.1 W 四舍五入；**不得**同时上报 dBm 与 W 造成歧义。

### 4.7 命名与类型

| 规则 | 说明 |
|---|---|
| 命名 | `snake_case`，全小写 |
| 布尔 | 必须是 JSON `true`/`false`；**禁止** `0`/`1`/`"true"` |
| 空值 | 数值缺失用 `null`；字符串型字段用 `""`（如 `error`） |
| 数组 | 空即 `[]`，不传 `null` |
| 对象 | `ports` 允许 `null` 值表达"该端口未知" |
| 单位后缀 | 新字段带单位后缀（`_w`、`_hz`、`_c`、`_ms`、`_db`、`_a`） |

### 4.8 报文大小与字段策略

| 项 | 值 | 说明 |
|---|---|---|
| 单条 PUBLISH 上限 | **8192 字节**（UTF-8） | 超限接收方整帧丢弃并记日志 |
| 建议心跳大小 | ≤ 2048 字节 | 含 `antennas` 时可能接近上限 |
| `antennas[]` 上限 | 16 项；每项 `name` ≤ 60 字符 | 与端口数上限一致 |

| 档 | 含义 | 接收方行为 |
|---|---|---|
| **必须** | 缺失即整帧非法 | 丢弃该帧，保持上一状态并标 `stale` |
| **可选** | 缺失按缺省值 | 用表里的"缺省行为"列 |
| **只读** | 只能由设备上报，平台下发时应忽略 | 收到即忽略，不报错 |

### 4.9 枚举扩展

所有开放枚举（`state`、`error`、`fault`、告警 `code`）按以下规则处理：

1. 接收方**必须**把不认识的枚举值当作 `unknown`（或忽略该字段），**不得崩溃、不得拒绝整帧**。
2. 发送方新增枚举值前必须登记到本文，并把 `proto` minor +1。
3. 枚举值只用小写 `snake_case` 或短横线短语（如 `tx-active`），**不使用无含义数字**。
4. 位图（`fault_word`）按位定义，未知位保留并在界面显示原始值。

### 4.10 ack 帧

设备收到 `json_command` 后 **500 ms 内**回一帧 ack 到 `heartbeat`，**只带 ack 字段、不带状态**：

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

平台当前对 `result="error"` 的帧整帧丢弃（不写状态、不判离线）。因此：

- ack 帧**不能替代**状态帧，下一次周期快照仍必须发真实状态；
- 但 ack 必须发——它是唯一能证明"设备看到指令"的证据。

---

## 5. 上线、心跳与序号

### 5.1 启动序列

1. 连 broker，注册 LWT（§3.3）。
2. 本地自检：读机械位置、限位电平、继电器状态；读不到记未知，**不得猜测**。
3. 向 `status` 发布 online。
4. 向 `heartbeat` 发布**首帧完整快照**：`state="init"` 或 `"idle"`，`boot_id` 为新值，`uptime_ms` 接近 0，位置类字段按实测（读不到即 `null`）。
5. 进入 §5.2 周期心跳。

**禁止**启动时自动"恢复"断电前的射频通路。射频类设备必须以安全态起步并如实上报实际位置（§14.3）。

### 5.2 心跳节奏

| 设备类 | 变化时 | 无变化时 | 平台在线判定 | 阈值 |
|---|---|---|---|---|
| 切换器 / 矩阵 | 立即发 | 每 5 s 保活 | 连接 + 最近回读 | — |
| 铁塔 | 立即发（尤其限位变化） | 每 1 s | 最近上报 | 10 s |
| BPF | 立即发 | 每 5 s | 最近上报 | 10 s |
| 驻波表 | 立即发（发射起止必须即时） | 每 1 s | 最近上报；TX 源另按 `timeout_ms` | 10 s / 2 s |

保活帧允许裁剪到：`device_id`、`device_class`、`seq`、`uptime_ms`、`state`、`ts`、`timestamp`。例外：

- **铁塔与驻波表不要裁剪限位/发射字段**，其超时判定以整帧为准。
- **BPF 的保活帧必须保留 `supported_bands`、`capability_rev`、`current_band`、`bypass`、`alarms`**（§11.2 规则 1、§11.4），不得裁剪。

### 5.3 去重

- 内容与上一帧完全相同且距上一帧 < 保活间隔 → 不发。
- 内容有任何变化 → 立即发，不受间隔限制。
- 保活帧不参与"内容相同"判断，必须按间隔发。
- 发射起止（`tx_active` 翻转）与限位变化属于"变化"，必须立即发。

### 5.4 序号

| 项 | 规则 |
|---|---|
| 起点 | 从 1 开始，单调 +1，uint32 不回绕 |
| 平台去重 | `seq <= 上次` 的帧被丢弃并返回 `ignored:"stale-seq"`，不更新状态 |
| 重启 | **必须持久化 `seq`**；做不到时重启后首帧起**省略 `seq`**（缺失时不判 stale） |
| `msg_id` | 仅用于 ack 关联与设备侧去重 |

> 若设备断电后 `seq` 从 1 重来，平台会一直丢弃，直到超过断电前的值。所以要么持久化，要么重启后不带 `seq`。

### 5.5 在线判定对照

| 设备类 | 判定依据 | 超时 | 显示 |
|---|---|---|---|
| 切换器 / 矩阵 | 连接 + 最近回读 | 无硬超时；只写型号永远 `unverified` | `online` / `unverified` / `awaiting` / `offline` |
| 铁塔 | 最近上报 | 10 s | `offline`（保留 `last_state`） |
| 驻波表 | 最近上报 | 10 s | `online` / `offline` |
| TX 源 | 最近上报 | `timeout_ms`（缺省 2000 ms）→ `stale`；3× → `offline` | `ok` / `stale` / `offline` |

---

## 6. 兼容性策略

### 6.1 协议版本字段

| 字段 | 类型 | 格式 | 必填 |
|---|---|---|---|
| `proto` | string | `<major>.<minor>`，如 `"1.0"` | 可选，缺失等同 `"1.0"` |

| 情形 | 行为 |
|---|---|
| major 相同、minor ≥ 自身 | 正常处理，忽略未知字段与未知枚举 |
| major 相同、minor < 自身 | 正常处理，缺失字段按缺省值 |
| **major 不同** | 拒绝处理：设备回 `error="proto-unsupported"`；平台提示升级 |

### 6.2 版本类字段

| 字段 | 适用 | 说明 |
|---|---|---|
| `firmware_version` | 全部 | 固件版本（`1.0.3`） |
| `software_version` | 可选 | 应用层版本 |
| `hardware_version` | 可选 | 硬件修订号（`revB`） |
| `serial` | 可选 | 序列号，现场对号 |
| `boot_id` | 必须 | 每次上电/复位变化，用于识别重启与重置 `seq` |

### 6.3 未知字段：接收方必须忽略

- 平台解析器不得因出现未知字段而拒绝整帧。
- 设备同样必须忽略平台下发的未知字段。
- 未知字段可被转发/记录，但不得参与控制决策。

### 6.4 字段废弃流程

三步，至少跨一个 minor 版本：

1. **标记**：本文标"废弃"，`proto` minor +1；平台同时接受新旧字段。
2. **双发**：设备过渡期同时上报旧字段与新字段（值必须一致）；平台优先用新字段。
3. **删除**：下一个 major 删除旧字段，文档同步移除。

任何"直接改语义"的做法都禁止——语义变更按不兼容变更处理。

### 6.5 不兼容变更 = 升主版本

| 变更 | 版本动作 |
|---|---|
| 新增可选字段 / 新增枚举值 / 新增设备类 | minor +1 |
| 新增必填字段、删除字段、改字段语义/单位/符号 | **major +1** |
| 改主题结构、改 `cmd` 取值、改 QoS/retain 策略 | **major +1** |
| 改安全边界（§14） | **major +1**，且必须重新验收 |

升级流程：文档升版 → 平台先支持双版本 → 固件升级 → 旧版本至少保留一个现场周期（建议 ≥ 30 天）→ 下线旧版本。过渡期内平台必须能同时解析两个 major。

### 6.6 与既有 amp 类设备的共存

平台已有一类既有功放设备（`type=amp`）在用同一套信封与主题风格，其字段名与语义是既成事实，**一个都不能改**。新设备沿用同一风格，只把功放专属字段换成设备类专属字段：

| 项 | 既有 amp 类设备 | 新设备 |
|---|---|---|
| 信封 | `msg_id`、`cmd`、`timestamp`、`data` | 同上，另加可选 `ts`、`proto` |
| 主题 | `amplifier/device/{device_id}/…` | `{class}/device/{device_id}/…` |
| 时间 | `timestamp`（Unix 秒） | 同字段必带，另加 `ts`（ISO 8601 UTC） |
| 上报 / 下发 | 快照 / delta | 同 |
| `data.device_id` | 必须等于主题键 | 同 |
| `result` | `ok` / `error`，`error` 帧整帧丢弃 | 同 |
| 命名 | `snake_case`（如 `current_voltage`） | 同 |

> 新协议的设计是对既有命名的归纳，不是重新设计。凡冲突之处一律以既有设备为准。

---

## 7. 通用状态字段（5 类新设备共用）

各设备章节只列**专属**字段；完整快照 = 本节 ∪ 该节专属字段。

| 字段 | 类型 | 必填 | 范围 | 缺省行为 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | 必须 | ≤100，单段 | — | 必须等于主题中的 `device_id`，否则整帧丢弃 |
| `device_class` | string | 必须 | `switch`/`matrix`/`tower`/`bpf`/`swr` | 按主题前缀推断 | 开放枚举 |
| `model` | string | 必须 | ≤100 | `""` | 型号 |
| `serial` | string | 可选 | ≤64 | `""` | 序列号 |
| `firmware_version` | string | 必须 | ≤32 | `""` | 固件版本 |
| `software_version` | string | 可选 | ≤32 | `""` | 应用层版本 |
| `hardware_version` | string | 可选 | ≤32 | `""` | 硬件修订 |
| `boot_id` | string | 必须 | ≤32 | — | 每次上电/复位必须变化 |
| `uptime_ms` | number | 必须 | 0–2^32−1 | 0 | 自本次上电起算 |
| `seq` | number | 必须（见 §5.4） | 1–4294967295 | — | 单调 +1 |
| `state` | string | 必须 | 见 §13.3 | `unknown` | 开放枚举 |
| `result` | string | 可选 | `ok`/`error` | `ok` | ack 帧必带 |
| `ack_msg_id` | string | 可选 | 1–64 | `""` | 回应哪条下发 |
| `error` | string | 可选 | 见 §13.1 | `""` | 机器可读错误码 |
| `error_detail` | string | 可选 | ≤200 | `""` | 人读补充，不参与决策 |
| `fault_word` | number | 可选 | uint32 | 0 | 位图见 §13.4；**BPF 不使用**（改用 `alarms[]`，§11.4） |
| `temperature_c` | number | 可选 | -40–125，有符号 | `null` | 设备内部温度 |

## 8. 天线切换器（1×n）

### 8.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `switch` |
| 端口 | `in` + `ant1…antN`，`N = out_count`（1–16，缺省 2） |
| 上行 / 下行 | `switch/device/{device_id}/heartbeat` / `json_command` |
| LWT | `switch/device/{device_id}/status` |
| 单帧上限 | 8192 字节；建议 ≤2048 字节 |
| Schema | `heartbeat-switch.schema.json`、`command-switch.schema.json` |

### 8.2 状态上报字段

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `out_count` | number | 必须 | 路 | 1–16 | 无符号 | 必须与实际出口数一致 |
| `position` | number | 必须 | 口序 | 1–N 或 `null` | 无符号 | `null` = 位置未知；**禁止**用 0 表示未知 |
| `ports` | object | 必须 | — | `{"in": "antN" \| null}` | — | 缺键 = 保持上次回读；`null` = 该口未知/未接 |
| `target` | string | 可选 | — | `antN` 或 `null` | — | 稳定态与 `position` 一致；切换中为目标位 |
| `switching` | boolean | 必须 | — | true/false | — | 缺省 `false`；为 true 时平台不得标 `verified` |
| `relay_state` | array<boolean> | 可选 | — | 长度 = `out_count` | — | 各路继电器实际状态，诊断用 |
| `rf_detected` | boolean | 必须 | — | true/false | — | 缺省 `false`；本地 RF 检测 |
| `tx_active` | boolean | 必须 | — | true/false | — | 缺省 `false`；设备自测发射，仅诊断 |
| `antennas` | array<object> | 可选 | — | ≤16 项 | — | 缺省 `[]`；端口 → 天线 → 波段回读 |

`antennas[]` 元素：

| 键 | 类型 | 必填 | 范围 | 说明 |
|---|---|---|---|---|
| `index` | number | 必须 | 1–16 | 对应 `antN` |
| `name` | string | 必须 | ≤60 | 天线名 |
| `bands` | array<string> | 必须 | `^\d{1,3}m$`，≤16 | 空数组 = 未配置波段 |

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

### 8.3 控制指令字段

| 字段 | 类型 | 必填 | 范围 | 缺省行为 |
|---|---|---|---|---|
| `device_id` | string | 必须 | ≤100 | — |
| `ports` | object | 必须 | `{"in": "antN"}` | — |
| `action` | string | 可选 | `select` | 可省略；仅表达意图 |

约束：

- `N` 必须在 `1…out_count`；超出回 `unknown-channel`，不动作。
- **值不得为 `null`**：远程"全断"属禁止（§14.4）。收到 `{"in": null}` 必须拒绝。
- 切换必须 **break-before-make**，断开窗口 ≤50 ms，总动作 ≤200 ms。
- 同一时刻只允许一路 `antN` 闭合，机械上不得两路并接。

B 档等价：

```
POST <relay_url>
X-Relay-Token: <token>
{"channel": 3, "action": "pulse", "pulse_ms": 400}
```

### 8.4 状态机与平台状态

| 平台状态 | 触发 | 硬件侧对应 | 参与互锁 |
|---|---|---|---|
| `waiting` / `awaiting` | 已配置但无回读 | 未见 | 否 |
| `pending` | 指令已下发，等回读 | `switching=true` | 否 |
| `verified` | 收到回读并写入 `ports` | `switching=false`，`ports` 有效 | **是** |
| `unverified` | 只写型号，永远无回读 | B 档 relay 设备 | 否 |
| `unknown` + `stale` | 通信中断 | 无心跳 | 否（保留最后 `ports` 但不用） |

关键点：**只有设备自己确认机械到位后才允许上报 `ports`**。上报 `ports` 等于声明"这条通路现在是通的"，会被用于 TX 可达与互锁计算。

硬件状态机：

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

### 8.5 示例

**(1) 上线首帧**

```json
{"msg_id":"sw-a-0001","cmd":"remote_control",
 "timestamp":1794724800,"ts":"2026-11-15T06:40:00.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","state":"init",
  "position":null,"ports":{"in":null},"target":null,"switching":false,
  "out_count":6,"seq":1,"boot_id":"b7f3c1","uptime_ms":820}}
```

**(2) 平台下发切换**

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

**(4) 回读确认**

```json
{"msg_id":"sw-a-0103","cmd":"remote_control",
 "timestamp":1794724811,"ts":"2026-11-15T06:40:11.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","state":"idle",
  "position":3,"ports":{"in":"ant3"},"target":"ant3","switching":false,
  "rf_detected":false,"relay_state":[false,false,true,false,false,false],
  "error":"","result":"ok","seq":44}}
```

**(5) 发射中拒绝**

```json
{"msg_id":"sw-a-0104","cmd":"remote_control",
 "timestamp":1794724820,"ts":"2026-11-15T06:40:20.000Z","proto":"1.0",
 "data":{"device_id":"SW-A","device_class":"switch","result":"error",
  "ack_msg_id":"dxc-m7k2p9-77aa01bb","error":"tx-active",
  "error_detail":"fwd_power=620W","seq":45}}
```

### 8.6 响应与错误码

| 情形 | 设备返回 | 平台 HTTP |
|---|---|---|
| 正常受理 | — | 202，`state:"pending"` |
| 端口越界 | `unknown-channel` | —（HTTP 已 202） |
| 切换中又来指令 | `busy` | — |
| 发射中 | `tx-active` | 平台可能先返回 **423 `tx-active`** |
| 机械未到位 | `switch-timeout` | — |
| 未配置 B 档地址 | — | 400 `transport-not-configured` |
| 连不上继电器 | — | 502 `transport-connect` / 504 `transport-timeout` |
| 型号不支持控制 | — | 501 `unsupported-control` |

### 8.7 异常与超时

| 情形 | 设备行为 | 平台表现 |
|---|---|---|
| 非法 JSON / 未知 `cmd` | 静默丢弃 | 无变化 |
| `ports.in` 值不存在 | 回 `unknown-channel`，不动作 | 状态不更新 |
| 机械卡阻 | `state="fault"`、`error="switch-timeout"`、`fault_word` 置位 | 保持 `pending` |
| broker 断线 | 本地继续运行；重连后立即全量快照 | 按连接或超时判 `offline` |
| 5 s 无回读 | — | 状态停在 `pending`，由平台标注超时未确认 |

---

## 9. 矩阵切换器（m×n）

### 9.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `matrix` |
| 端口 | `in1…inN` + `out1…outM`；`N=in_count`（缺省 2）、`M=out_count`（缺省 4），各 1–16 |
| 上行 / 下行 | `matrix/device/{device_id}/heartbeat` / `json_command` |
| LWT | `matrix/device/{device_id}/status` |
| Schema | `heartbeat-matrix.schema.json`、`command-matrix.schema.json` |

### 9.2 状态上报字段

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `in_count` | number | 必须 | 路 | 1–16 | 无符号 | 与配置一致 |
| `out_count` | number | 必须 | 路 | 1–16 | 无符号 | 与配置一致 |
| `ports` | object | 必须 | — | `{"inN":"outM"}`，值或 `null` | — | **按键增量**；`null` = 该输入未接 |
| `switching` | boolean | 必须 | — | true/false | — | `false` |
| `relay_state` | array<boolean> | 可选 | — | 长度 = N×M | — | 诊断 |
| `rf_detected` / `tx_active` | boolean | 必须 | — | true/false | — | 同 §8.2 |
| `antennas` | array<object> | 可选 | — | 同 §8.2 | — | 出口侧波段映射 |

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

### 9.3 控制指令字段

| 字段 | 类型 | 必填 | 范围 | 缺省行为 |
|---|---|---|---|---|
| `device_id` | string | 必须 | ≤100 | — |
| `ports` | object | 必须 | `{"inN":"outM"}` | 一次只改一个输入；多键按**逐键独立**处理 |

约束：

- 每个输入同一时刻只能对应**一个**输出；平台选择表是 `inN → outM` 单值映射。
- **一个输出不得被多个输入同时选中**（硬件必须互斥）。需要多路合请用合路器。
- 不允许"广播式"把多个输入接到同一输出。
- 值不得为 `null`（远程断开射频通路属禁止）。
- 单输入动作时间同切换器：≤200 ms，break-before-make。

B 档等价：`{"channel": <channels["in1:out2"]>, "action": "pulse", "pulse_ms": 400}`。

### 9.4 状态机与边界

与 §8.4 相同。矩阵额外注意：`ports` 按键合并，"只报一个输入"合法；但**切换中不得先把目标值写进 `ports`**，否则平台会提前把该通路当已通。

### 9.5 示例

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

### 9.6 响应与错误码

| 情形 | 设备返回 | 说明 |
|---|---|---|
| 目标输出被占用 | `output-busy` | 不允许"抢占" |
| 输入越界 | `unknown-channel` | — |
| 机械卡阻 | `switch-timeout` | 保持原位 |
| 发射中 | `tx-active` | 平台亦可能 423 |

### 9.7 异常与超时

| 情形 | 设备行为 |
|---|---|
| 断线 | 保持机械位置，重连后全量快照 |
| 单输入失败 | 只回滚该输入，其他输入不动 |
| 回读缺失 | `ports` 里不出现该键（平台保留上次值） |
| 多输入指向同一输出 | 本地拒绝后到的那个，`output-busy` |

## 10. 铁塔升降控制器

### 10.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `tower` |
| 射频端口 | 无（塔不接射频） |
| 控制 / 状态口 | `relay` / `limit` |
| 上行 / 下行 | `tower/device/{device_id}/heartbeat` / `json_command` |
| LWT | `tower/device/{device_id}/status` |
| 配置项 | `up_channel` / `down_channel`（0–255）、`pulse_ms`、`travel_timeout_sec`（5–3600，缺省 120） |
| 站点设置 | 限位开关类型 `NO` / `NC`，**全局一项，缺省 NO** |
| Schema | `heartbeat-tower.schema.json`、`command-tower.schema.json` |

> 限位类型不是每台塔各自的配置，而是站点级设置。设备上报**原始电平**，取反由平台做。设备若自行取反，NO/NC 设置就完全失效。

### 10.2 状态上报字段

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `limit_top` | boolean | 必须 | — | 接点原始电平 | — | **true = 接点闭合**；不得省略 |
| `limit_bottom` | boolean | 必须 | — | 接点原始电平 | — | 同上 |
| `moving` | boolean | 必须 | — | true/false | — | `false` |
| `direction` | string | 可选 | — | `up`/`down`/`null` | — | `null` |
| `motor_on` | boolean | 必须 | — | true/false | — | 输出继电器实际吸合状态 |
| `hold_active` | boolean | 必须 | — | true/false | — | 本次 hold 是否仍在续期窗口内 |
| `hardware_interlock` | boolean | 必须 | — | true/false | — | 本地硬互锁有效；`false` = 旁路/故障 |
| `limit_wiring` | string | 可选 | — | `NO`/`NC`/`null` | — | 设备实际接线，供核对 |
| `travel_ms` | number | 可选 | ms | 0–3600000 | 无符号 | 本次运动已用时长 |
| `motor_current_a` | number | 可选 | A | 0–50 | 无符号 | 过流诊断 |
| `fault` | string | 可选 | — | 见 §13.1 | — | 空串 = 无故障 |

`limit_top` / `limit_bottom` 语义必须精确：

- 上报限位开关**接点电平**，不是"逻辑到位"。
- `NO` 接法：接点闭合（true）= 到位；`NC` 接法：接点断开（false）= 到位。
- 平台按站点配置解释：`NC` 时取反。
- 两限位同时逻辑到位 → `fault` + `alert="limit-conflict"`；任一侧读不到 → `unknown` + `reason="no-limit-feedback"`。

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

### 10.3 控制指令字段

| 字段 | 类型 | 必填 | 范围 | 缺省行为 |
|---|---|---|---|---|
| `device_id` | string | 必须 | ≤100 | — |
| `action` | string | 必须 | `hold` / `release` / `stop` | — |
| `direction` | string | `hold` 时必须 | `up` / `down` | 其余动作忽略 |
| `hold_ms` | number | 可选 | 500–1500 | 1500 |

语义：

1. **按住运行（点动）**：平台每 500 ms 发一条 `action="hold"`，方向不变即续期，**不得重复吸合**。
2. **看门狗**：设备 **1500 ms** 未收到新的 `hold`，必须断开两路输出。
3. **两路不同时闭合**：换向时先断另一路，再吸合目标路。
4. **换向最小间隔 1000 ms**：平台会以 `409 direction-switch-too-fast` 拒绝；设备端也必须独立执行同样的间隔。
5. **释放**：`release` / `stop` 立即断开当前通道。
6. **启动**：平台启动时对所有塔执行一次 `off`；设备重启后也必须是两路断开。

B 档等价：

```
POST <relay_url>  {"channel": <up_channel>,   "action": "on"}    // hold up
POST <relay_url>  {"channel": <up_channel>,   "action": "off"}   // release
POST <relay_url>  {"channel": <down_channel>, "action": "on"}    // hold down
```

### 10.4 状态机与边界

平台二态模型：

| 平台状态 | 条件 | 设备侧应满足 |
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
| 上限位到达 | 硬件自行切断上升输出，**不等平台**；即使收到 `hold up` 也保持断开 |
| 下限位到达 | 同上 |
| 两限位冲突 | 两路立即断开，`fault="limit-conflict"`，拒绝任何 `hold` 直到断电复位 |
| 换向间隔 | 1000 ms；设备端从"上一路断开"开始计时 |
| 运动超时 | 设备自行断电并报 `fault="travel-timeout"`；平台 `travel_timeout_sec` 只用于显示判定，不能替代硬件切断 |
| 通信中断 | 1500 ms 看门狗断开两路（fail-safe） |
| 断电 | 两路失电，塔由机械自锁保持；上电必须先读限位，不得自动继续断电前的动作 |
| 塔在中间位置 | 允许上报（真实存在）；不得谎报为 `erected`/`retracted` |

### 10.5 示例

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

**(6) 换向过快（平台拒绝）**

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

```json
{"msg_id":"tw-a-0504","cmd":"remote_control",
 "timestamp":1794725202,"ts":"2026-11-15T06:46:42.000Z","proto":"1.0",
 "data":{"device_id":"TW-A","device_class":"tower","state":"idle",
  "moving":false,"direction":null,"motor_on":false,"hold_active":false,
  "error":"watchdog-release","seq":310}}
```

### 10.6 响应与错误码

| 情形 | 设备返回 | 平台 HTTP |
|---|---|---|
| 正常受理 | — | 202 |
| 方向非法 | `invalid-direction` | 400 `invalid-direction` |
| 已到位还同向 | `limit-reached` | — |
| 两限位冲突 | `limit-conflict` | — |
| 换向 <1000 ms | `direction-switch-too-fast` | 409 同名 |
| 通道未配置 | — | 400 `unknown-channel` |
| 继电器超时 | — | 504 `transport-timeout` |

### 10.7 异常与超时

| 情形 | 设备行为 | 平台表现 |
|---|---|---|
| 硬件互锁失效 | 两路断开，`hardware_interlock=false`、`fault="interlock-open"` | 界面必须显红 |
| 双限位同时有效 | 两路断开，`fault="limit-conflict"` | `fault` + `alert="limit-conflict"` |
| 运动超时 | 两路断开，`fault="travel-timeout"` | `unknown` + `alert="travel-timeout"` |
| broker 断线 | 1500 ms 后断开两路 | 10 s 后 `offline` |
| 继电器超时 | — | 504，不重试 |

---

## 11. 多波段 BPF 组

### 11.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `bpf` |
| 射频端口 | `in` + `out` |
| 控制 / 状态口 | 无 |
| 上行 / 下行 | `bpf/device/{device_id}/heartbeat` / `json_command` |
| LWT | `bpf/device/{device_id}/status` |
| Schema | `heartbeat-bpf.schema.json`、`command-bpf.schema.json` |

设备形态（必须先明确）：

- 硬件对外只有**一个射频输入 `in`、一个射频输出 `out`**，与 §1.4 的端口模型一致；内部是多波段滤波器组。
- 任何时刻只有一个射频通路：要么插入某个波段滤波器，要么旁路直通。
- **不存在多路 `in` 或多路 `out`**，也不按波段分口（分口是合路器的事）。平台侧 RF 遍历把它当作单个串联环节。
- 设备必须自己上报支持的波段列表，平台不预设、不硬编码。

支持的波段以设备上报为准；平台只做校验、展示与指令下发，不在协议层固定某个波段清单。

### 11.2 能力上报：`supported_bands`

| 字段 | 类型 | 单位/取值 | 必填 | 缺省值 | 说明 |
|---|---|---|---|---|---|
| `supported_bands` | array<string> | `^\d{1,3}m$`，1–16 项，不重复 | 必须 | — | 设备实际支持的波段；**不允许空数组** |
| `capability_rev` | number | uint32，≥1 | 必须 | 1 | 能力版本号；`supported_bands` 每次变化必须 +1 |

规则：

1. **上线首帧与每一次心跳都必须携带 `supported_bands`**（保活帧也不得裁剪）；平台据此生成可选波段。
2. 列表发生变化时：`capability_rev` +1，并**立即**发一帧完整快照，不等下一个周期。平台发现 `capability_rev` 变化即刷新可选波段。
3. 平台绝不在协议层写死波段清单；设备报什么就是什么。
4. 平台**不得**把未支持的波段"映射"成邻近波段，也不得因为未识别而丢弃整条设备记录。

波段标识：

| 情形 | 示例 | 平台处理 |
|---|---|---|
| 语法合法且平台可识别 | 平台波段表中已有的项（如 `20m`、`15m`） | 正常进入可选波段与 RF 剪枝 |
| 语法合法但平台未识别 | 平台波段表中尚无的合法标识（如 `4m`） | 保留展示、标记"未识别波段"（告警 `band-unrecognized`，`info` 级）；**不进入可选列表、不参与 RF 剪枝**；设备仍可被切到该波段并如实回读 |
| 语法非法 | `20M`、`20`、`hf-20`、`""`、`7000kHz` | 平台丢弃该项并记 `warning`；不得下发给设备 |

- 设备**禁止**发明标识写法：`supported_bands` 的每一项都必须匹配 `^\d{1,3}m$`。
- 设备收到不在自身 `supported_bands` 内的目标时必须拒绝，见 §11.5。
- 波段标识只用米制波段名，不用频率区间；频率区间一律不做支持性判定依据。上表左列仅为判定方式的说明，**不构成协议级波段清单**——设备能支持哪些波段由设备自己上报。

### 11.3 状态回读

| 字段 | 类型 | 单位/取值 | 必填 | 缺省值 | 说明 |
|---|---|---|---|---|---|
| `current_band` | string \| null | `^\d{1,3}m$` 或 `null` | 必须 | `null` | 当前实际插入的滤波器；`bypass=true` 时必须为 `null` |
| `bypass` | boolean | true/false | 必须 | `false` | true = 直通（不插滤波器） |
| `switching` | boolean | true/false | 必须 | `false` | 切换动作进行中 |
| `filter_health` | string | `ok`/`degraded`/`fault`/`unknown` | 必须 | `unknown` | 滤波器组整体健康度 |
| `filter_fault_bands` | array<string> | `^\d{1,3}m$`，≤16 | 可选 | `[]` | 具体失效的波段，用于定位 |
| `insertion_loss_db` | number \| null | dB，0–10，3 位小数 | 可选 | `null` | 当前通路插损 |

- `current_band` 与 `bypass` **不得同时表达"生效通路"**：`bypass=true` 时 `current_band` 必须是 `null`；`bypass=false` 时 `current_band` 必须是具体波段或 `null`（未知）。
- `filter_health` 是整体结论，`filter_fault_bands` 是明细；两者矛盾时以 `filter_health` 为准并置 `self-test-failed`。
- 回读值必须来自实际位置/传感器，**禁止**回显最后一条指令。

### 11.4 告警

| 字段 | 类型 | 单位/取值 | 必填 | 缺省值 | 说明 |
|---|---|---|---|---|---|
| `alarms` | array<object> | ≤16 项 | 必须 | `[]` | 当前活动告警；无告警即空数组 |
| `alarms[].code` | string | `^[a-z][a-z0-9-]*$` | 必须 | — | 告警码，开放枚举 |
| `alarms[].severity` | string | `info`/`warning`/`major`/`critical` | 必须 | — | 严重程度 |
| `alarms[].latched` | boolean | true/false | 必须 | — | 是否锁定（需确认才清除） |
| `alarms[].acknowledged` | boolean | true/false | 必须 | `false` | 平台是否已确认 |
| `alarms[].since` | string | ISO 8601 UTC | 必须 | — | 告警首次发生时间 |
| `alarms[].detail` | string | ≤200 | 可选 | `""` | 人读补充 |
| `fault` | string | 告警码或 `""` | 必须 | `""` | 最高严重级别的活动告警码，无告警为 `""` |

必须覆盖的告警码：

| code | severity | latched | 触发条件 | 清除方式 |
|---|---|---|---|---|
| `band-unsupported` | `warning` | false | 收到的 `band` 不在 `supported_bands` 内 | 条件消失后下一帧自动清除 |
| `switch-failed` | `major` | **true** | 切换超时（>1 s 未到位）或继电器反馈不符 | 需 `ack_alarms` **且**故障条件已消失 |
| `self-test-failed` | `critical` | **true** | 上电自检失败、内部总线/传感器异常 | 需 `ack_alarms` 且重新自检通过 |
| `filter-degraded` | `warning` | **true** | 某波段插损超限、继电器接触不良 | 需 `ack_alarms` 且指标恢复 |
| `filter-fault` | `major` | **true** | 某波段滤波器开路/短路 | 需 `ack_alarms` 且硬件修复 |
| `band-unrecognized` | `info` | false | **平台侧**告警：设备上报的波段标识平台无法识别 | 条件消失后自动清除 |

严重程度与平台处理：

| severity | 含义 | 平台行为 |
|---|---|---|
| `info` | 提示，不影响运行 | 仅记录，设备卡片显示灰点 |
| `warning` | 降级，仍可用 | 黄点 + 文本；允许继续下发 |
| `major` | 功能受损 | 红点；该设备标记为不可用于自动切换 |
| `critical` | 设备不可用 | 红点 + 阻断该设备的控制指令 |

清除规则：

1. `latched=false` 的告警由设备自动清除，平台只跟随，不得自行丢弃。
2. `latched=true` 的告警**必须**由平台下发 `ack_alarms` 才算确认；但确认不等于消失——故障条件仍在时告警继续存在，仅 `acknowledged=true`。
3. 设备重启后，`latched` 告警仍然保留（若条件依旧），并带上新的 `boot_id`。
4. **禁止**用"清告警"代替修复：`ack_alarms` 不改变 `filter_health`、不改 `current_band`。

### 11.5 切换控制

| 字段 | 类型 | 单位/取值 | 必填 | 缺省值 | 说明 |
|---|---|---|---|---|---|
| `device_id` | string | ≤100 | 必须 | — | 与主题一致 |
| `band` | string | `^\d{1,3}m$` | 三选一 | — | 目标波段，必须在 `supported_bands` 内 |
| `bypass` | boolean | true/false | 三选一 | — | 直通 / 退出直通 |
| `action` | string | `ack_alarms` | 三选一 | — | 确认锁定告警 |
| `codes` | array<string> | 告警码，≤16 | 可选 | 全部 | 仅 `ack_alarms` 使用；省略表示确认全部 |

`band`、`bypass`、`action` 三个动作字段**必须且只能出现一个**；出现零个或多个时回 `empty-command` / `invalid-arg`。

切换语义（全部写死，硬件不得自选）：

1. **目标必须受支持**：`band` 不在 `supported_bands` 内 → 回 `error="unknown-band"`，同时置 `band-unsupported` 告警；**不动作**。禁止静默失败、禁止退到邻近波段、禁止自动旁路。
2. **发射中禁止切换**：`tx_active=true` → 回 `error="tx-active"`；仅 `rf_detected=true`（检测到 RF 但未确认是本机发射）→ 回 `error="rf-detected"`。两者任一为真都**不动作**。这是设备侧硬性拒绝，不依赖平台先做互锁。
3. **切换是异步的**：设备收到后 ≤50 ms 内开始动作，典型 ≤200 ms 完成；期间 `switching=true`。完成后发快照（`switching=false` + 实际 `current_band`/`bypass`）。平台**只在收到回读后**才把该波段标为生效；回读前一律 `pending`。
4. **失败默认行为**：切换超时（>1 s 未到位）或继电器反馈不符时，设备**必须恢复到切换前的状态**——原来插着哪个波段就回到哪个波段，原来旁路就保持旁路——并置 `switch-failed`（`major`，latched）。**不得转旁路、不得转邻近波段、不得停在中间态**。
5. **切换期间再收指令**：回 `error="busy"`，不排队、不预存。
6. **机械要求**：break-before-make，断开窗口 ≤50 ms；同一时刻只允许一个滤波器接入。
7. **`ack_alarms` 不改变射频状态**，只清 `acknowledged` 标记；发射中也可执行。


### 11.6 状态机

上电默认：**旁路直通**。自检通过后 `state="idle"`、`bypass=true`、`current_band=null`；自检失败则 `state="fault"` 并置 `self-test-failed`。

| `state` | `bypass` | `current_band` | 含义 | 允许的操作 |
|---|---|---|---|---|
| `init` | 按实测 | `null` | 上电自检中 | 仅 `ack_alarms`；其余回 `busy` |
| `idle` | `true` | `null` | 直通 | `band` 切换、`bypass=false`、`ack_alarms` |
| `idle` | `false` | 具体波段 | 正常插入 | 换波段、`bypass=true`、`ack_alarms` |
| `switching` | 保持切换前值 | 保持切换前值 | 动作中（≤1 s） | 仅 `ack_alarms`；其余回 `busy` |
| `fault` | 按实测 | 按实测 | 自检/滤波器故障 | `bypass=true`、`ack_alarms`；`band` 回 `hardware-fault` |
| `unknown` | 按实测 | `null` | 位置读不出 | 仅 `ack_alarms` 与 `bypass=true` |

```
        上电（两路断开 → 直通）
              │
              ▼
            init ── 自检失败 ──► fault（critical 告警）
              │ 自检通过
              ▼
        idle / bypass=true
              │ band 指令（非发射中）
              ▼
          switching ── 到位 ──► idle / 目标波段
              │
              ├─ 超时/反馈不符 ──► 恢复切换前状态 + switch-failed（major）
              └─ 滤波器故障 ────► fault（critical/major）
```

| 边界 | 规则 |
|---|---|
| 上电/断电 | 默认直通；不得自动插入断电前的波段；位置以实测为准 |
| 发射中 | 拒绝一切射频动作（`tx-active`），含 `bypass` 的往返切换 |
| 切换失败 | 恢复切换前状态 + `switch-failed`；不转旁路、不转邻近波段、不停中间态 |
| 位置读不出 | `current_band=null`、`state="unknown"`，不得猜测 |
| 断线 | 保持当前机械位置（不自动回直通，避免发射中断路） |
| 多波段并存 | 机械上一次只能插入一个；不得同时插入两个波段 |
| 告警确认 | `ack_alarms` 只改 `acknowledged`，不改射频状态 |

### 11.7 六项核心字段总表

| 名称 | 方向 | 类型 | 单位/取值 | 必填 | 缺省值 |
|---|---|---|---|---|---|
| `supported_bands` | 上报 | array<string> | `^\d{1,3}m$`，1–16 | 必须 | — |
| `capability_rev` | 上报 | number | uint32，≥1 | 必须 | 1 |
| `current_band` | 上报 | string \| null | `^\d{1,3}m$` / `null` | 必须 | `null` |
| `bypass` | 上报 | boolean | true/false | 必须 | `false`（上电为 `true`） |
| `filter_health` | 上报 | string | `ok`/`degraded`/`fault`/`unknown` | 必须 | `unknown` |
| `alarms` | 上报 | array<object> | 见 §11.4 | 必须 | `[]` |
| `fault` | 上报 | string | 告警码 / `""` | 必须 | `""` |
| `band`（指令） | 下发 | string | `^\d{1,3}m$` | 三选一 | — |
| `bypass`（指令） | 下发 | boolean | true/false | 三选一 | — |
| `action`（指令） | 下发 | string | `ack_alarms` | 三选一 | — |
| `codes`（指令） | 下发 | array<string> | 告警码，≤16 | 可选 | 全部 |

### 11.8 示例（请求 / 响应成对）

**(1) 上线首帧（直通、上报能力）**

```json
{"msg_id":"bpf-a-0001","cmd":"remote_control",
 "timestamp":1794725300,"ts":"2026-11-15T06:48:20.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","model":"DXC-BPF-6",
  "serial":"BPFA2026001","firmware_version":"1.1.0","boot_id":"e5c210",
  "uptime_ms":98200,"seq":64,"state":"idle",
  "supported_bands":["160m","80m","40m","20m","15m","10m"],
  "capability_rev":1,"current_band":null,"bypass":true,
  "switching":false,"filter_health":"ok","filter_fault_bands":[],
  "rf_detected":false,"tx_active":false,"insertion_loss_db":null,
  "alarms":[],"fault":"","error":"","result":"ok"}}
```

**(2) 切到 20m：下发 → ack → 回读**

下发：

```json
{"msg_id":"dxc-m7k2pd-1234abcd","cmd":"remote_control",
 "timestamp":1794725310,"ts":"2026-11-15T06:48:30.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","band":"20m"}}
```

ack：

```json
{"msg_id":"bpf-a-0101","cmd":"remote_control",
 "timestamp":1794725310,"ts":"2026-11-15T06:48:30.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","result":"ok",
  "ack_msg_id":"dxc-m7k2pd-1234abcd","seq":65}}
```

回读（到位后；此前平台保持 `pending`）：

```json
{"msg_id":"bpf-a-0102","cmd":"remote_control",
 "timestamp":1794725311,"ts":"2026-11-15T06:48:31.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","state":"idle",
  "current_band":"20m","bypass":false,"switching":false,
  "filter_health":"ok","seq":66}}
```

**(3) 目标不在 `supported_bands`：拒绝并告警**

下发：

```json
{"msg_id":"dxc-m7k2pf-99aabbcc","cmd":"remote_control",
 "timestamp":1794725320,"ts":"2026-11-15T06:48:40.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","band":"30m"}}
```

ack：

```json
{"msg_id":"bpf-a-0103","cmd":"remote_control",
 "timestamp":1794725320,"ts":"2026-11-15T06:48:40.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","result":"error",
  "ack_msg_id":"dxc-m7k2pf-99aabbcc","error":"unknown-band",
  "error_detail":"30m not in supported_bands","seq":67}}
```

紧随其后的快照（原波段不变，带告警）：

```json
{"msg_id":"bpf-a-0104","cmd":"remote_control",
 "timestamp":1794725320,"ts":"2026-11-15T06:48:40.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","state":"idle",
  "current_band":"20m","bypass":false,"switching":false,
  "alarms":[{"code":"band-unsupported","severity":"warning","latched":false,
             "acknowledged":false,"since":"2026-11-15T06:48:40.000Z",
             "detail":"requested 30m"}],
  "fault":"band-unsupported","seq":68}}
```

**(4) 发射中拒绝**

```json
{"msg_id":"bpf-a-0105","cmd":"remote_control",
 "timestamp":1794725330,"ts":"2026-11-15T06:48:50.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","result":"error",
  "ack_msg_id":"dxc-m7k2pg-11223344","error":"tx-active",
  "error_detail":"fwd_power=410W","seq":69}}
```

**(5) 切换失败：恢复原波段并置锁存告警**

```json
{"msg_id":"bpf-a-0106","cmd":"remote_control",
 "timestamp":1794725340,"ts":"2026-11-15T06:49:00.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","state":"idle",
  "current_band":"20m","bypass":false,"switching":false,
  "filter_health":"degraded",
  "alarms":[{"code":"switch-failed","severity":"major","latched":true,
             "acknowledged":false,"since":"2026-11-15T06:49:00.000Z",
             "detail":"target 15m not reached in 1s, restored 20m"}],
  "fault":"switch-failed","seq":70}}
```

**(6) 确认锁存告警**

下发：

```json
{"msg_id":"dxc-m7k2ph-55667788","cmd":"remote_control",
 "timestamp":1794725350,"ts":"2026-11-15T06:49:10.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","action":"ack_alarms","codes":["switch-failed"]}}
```

ack：

```json
{"msg_id":"bpf-a-0107","cmd":"remote_control",
 "timestamp":1794725350,"ts":"2026-11-15T06:49:10.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","result":"ok",
  "ack_msg_id":"dxc-m7k2ph-55667788","seq":71}}
```

回读（故障条件已消失，`alarms` 变空）：

```json
{"msg_id":"bpf-a-0108","cmd":"remote_control",
 "timestamp":1794725351,"ts":"2026-11-15T06:49:11.000Z","proto":"1.0",
 "data":{"device_id":"BPF-A","device_class":"bpf","state":"idle",
  "current_band":"20m","bypass":false,"switching":false,
  "filter_health":"ok","alarms":[],"fault":"","seq":72}}
```

### 11.9 响应与错误码

| 情形 | 设备返回 | 是否置告警 |
|---|---|---|
| 波段不受支持 | `unknown-band` | `band-unsupported`（warning） |
| 发射中切换（含旁路往返） | `tx-active`；仅检测到 RF 时 `rf-detected` | 否 |
| 切换中再收指令 | `busy` | 否 |
| 三个动作字段都给或都没给 | `invalid-arg` / `empty-command` | 否 |
| 标识语法非法 | `invalid-arg` | 否 |
| 滤波器故障时请求换波段 | `hardware-fault` | 已有 `filter-fault` / `self-test-failed` |
| 主版本不支持 | `proto-unsupported` | 否 |

### 11.10 异常与超时

| 情形 | 设备行为 |
|---|---|
| 继电器反馈与命令不一致 | 1 s 内恢复切换前状态，置 `switch-failed`；`filter_health` 按实测 |
| 切换超时 | 同上，不得停在中间态 |
| 自检失败 | `state="fault"`、`self-test-failed`（critical，latched），只允许 `bypass=true` 与 `ack_alarms` |
| 通信中断 | 保持当前机械位置；重连后全量快照（含 `supported_bands` 与 `capability_rev`） |
| 位置读不出 | `current_band=null`、`state="unknown"`，等指令，不猜测 |
| 平台下发的波段标识平台自身不认识 | 设备仍按自己的 `supported_bands` 判定；支持则执行，不支持则 `unknown-band` |

---

## 12. 驻波表

### 12.1 连接与主题

| 项 | 值 |
|---|---|
| 设备类 | `swr` |
| 射频端口 | `in` + `out` |
| 控制 / 状态口 | `report` / `status` |
| 上行 / 下行 | `swr/device/{device_id}/heartbeat` / `json_command` |
| LWT | `swr/device/{device_id}/status` |
| Schema | `heartbeat-swr.schema.json`、`command-swr.schema.json`、`http-tx.schema.json` |

驻波表承担两件事：

1. **功率与驻波测量**（展示、告警）；
2. **发射状态源**：提供 `tx_active`，用于天线切换互锁。

### 12.2 状态上报字段

| 字段 | 类型 | 必填 | 单位 | 范围 | 符号 | 缺省行为 |
|---|---|---|---|---|---|---|
| `fwd_power_w` | number | 必须 | W | 0–`max_power_w`，1 位小数 | 无符号 | 无 RF 时 `0.0`；未测到 `null` |
| `rev_power_w` | number | 必须 | W | 0–`max_power_w` | 无符号 | 同上 |
| `swr` | number | 必须 | — | 1.00–99.99，2 位小数 | 无符号 | 无 RF 时 `null`；**不得用 0 表示无穷大** |
| `rl_db` | number | 可选 | dB | 0–40 | 无符号 | `null` |
| `pep` | boolean | 必须 | — | true/false | — | `false` |
| `peak_fwd_w` | number | 可选 | W | 0–`max_power_w` | 无符号 | `0.0` |
| `freq_hz` | number | 可选 | Hz | 0–1300000000 | 无符号 | `null` |
| `band` | string | 可选 | — | `^\d{1,3}m$` 或 `""` | — | 由频率换算，算不出给 `""` |
| `tx_active` | boolean | 必须 | — | true/false | — | 见 §12.3 |
| `tx_threshold_w` | number | 必须 | W | 1–10000 | 无符号 | 发射判定门限 |
| `sample_ms` | number | 可选 | ms | 1–10000 | 无符号 | 采样窗口 |
| `max_power_w` | number | 必须 | W | 1–100000 | 无符号 | 量程上限 |
| `cal_valid` | boolean | 必须 | — | true/false | — | 校准数据是否有效 |
| `cal_locked` | boolean | 必须 | — | true/false | — | 校准写入是否锁定 |

发射判定的时间要求：

- 功率超过门限 → `tx_active=true`：**≤200 ms**；
- 功率跌回门限以下 → `tx_active=false`：**≤300 ms**（允许去抖）；
- 去抖窗口 ≤50 ms，防止单次尖峰误判。

平台互锁是实时读 `tx_active`，门限与去抖设置不当会直接导致"该锁不锁"或"频繁误锁"。

### 12.3 发射状态上报（两条通路）

**B 档（必须实现）**

| 项 | 值 |
|---|---|
| 端点 | `POST /api/devices/tx`（RFC 9110 POST，非幂等；`seq` 去重） |
| 频率 | 发射起止立即发；无变化时每 1 s 一帧 |
| 认证 | 配置 token 的源必须带 `X-DX-TX-Token`，否则 403 `invalid-token` |
| 绑定 | `source_id` 命中设备台账里的设备 id 时**自动绑到该设备**，互锁按这条 RF 通路精确锁定；也可显式配置 `device_id` |

请求：

```json
{"source_id":"swr-a","tx_active":true,"ts":1794725400123,"seq":1041}
```

响应：

```json
{"ok":true,"source_id":"swr-a","tx_active":true,
 "received_ts":"2026-11-15T06:50:00.123Z","registered":false,"health":"ok"}
```

| 字段 | 类型 | 必填 | 范围 | 缺省行为 |
|---|---|---|---|---|
| `source_id` | string | 必须 | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` | 缺失 400 `source-id-required` |
| `tx_active` | boolean | 必须 | true/false（**严格布尔**） | 缺失 400 `tx-active-required` |
| `ts` | number \| ISO 8601 string | 可选 | 毫秒或 `Z` 结尾 ISO | 缺省取平台当前时间 |
| `seq` | number | 可选 | 单调递增整数 | `seq <= 上次` 返回 200 `ignored:"stale-seq"` |
| `token` | string | 可选 | ≤200 | 可放 body 或 `X-DX-TX-Token` 头 |

健康度：`timeout_ms` 内 `ok`；≤3× `timeout_ms` 为 `stale`；超过为 `offline`；三者都不可用时互锁不启用、正常放行。

**A 档**：心跳 `data.tx_active` 与 B 档同时上报，取"或"逻辑（任一通路判发射即发射）。

另外，驻波表还需上报 `POST /api/devices/report`（`device_id` + `seq`），否则设备卡片显示"等待上报"。

**发射源的选择与降级**

平台同时接受两条轨道的发射证据，不存在"启用/停用"开关：

- **外部上报**：`POST /api/devices/tx` 的 `source_id + tx_active`，即上文 B 档。
- **内部信号**：平台本来就收到的数据，无需再登记一遍 —— 功放 `amp.transmitting`、驻波表 `tx_active`/`fwd_power_w > 0`、N1MM `is_transmitting`。内部源只在"确实正在发射且信号 10 s 内未过期"时参与，空闲设备不进清单。

选源排序为 **功放 > 驻波表 > 外部/其它 > 电台（N1MM）**；同档内再比 `priority`（越小越优先，默认 0）与 `source_id`。同一台设备上，仍然健康的外部上报优先，内部推断只兜底，避免一台设备两把锁。所有源都不可用时等同"未接入发射状态源"，正常放行。

### 12.4 控制指令字段

只读测量设备，可下发动作只有一项：

| 字段 | 类型 | 必填 | 范围 | 说明 |
|---|---|---|---|---|
| `action` | string | 必须 | `clear_peak` | 清峰值保持 |

**禁止**远程写校准系数、清零校准基准、修改保护/告警阈值、切换量程校准表。设备收到被禁止字段必须回 `error="calibration-locked"` 并保持原值，**不得静默接受**。

### 12.5 示例

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

HTTP 200，平台**不更新**状态。

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

### 12.6 响应与错误码

| 情形 | 返回 | 说明 |
|---|---|---|
| 正常 | 200 `{"ok":true,...,"health":"ok"}` | — |
| 缺 `source_id` | 400 `source-id-required` | — |
| `tx_active` 非布尔 | 400 `tx-active-required` | 必须发 JSON 布尔 |
| `seq` 非数字 | 400 `invalid-seq` | — |
| token 不匹配 | 403 `invalid-token` | 停止重试并告警 |
| `seq` 回退 | 200 `ignored:"stale-seq"` | 不更新状态 |
| 未知源 | 200 `registered:true` | 自动登记为缺省优先级 |

### 12.7 异常与超时

| 情形 | 设备行为 | 平台表现 |
|---|---|---|
| 2 s 未上报 TX | 立即重发当前值 | `stale`，互锁仍按最后 `tx_active` 直到 `offline` |
| 6 s 未上报 | — | `offline`，源不可用，互锁降级为"不启用" |
| 功率为 0 | `swr=null`、`tx_active=false` | 正常显示 |
| 校准无效 | `cal_valid=false`、`fault="not-calibrated"` | 界面提示，不阻断 |
| 时钟未同步 | `ts` 用单调整数折算 | `latency_ms` 可能为 0，不影响判定 |

### 12.8 互锁降级语义

- 有可用源且 `tx_active=true` → 切换被 **423 `tx-active`** 拒绝，并带 `scope`（`path` / `global`）与 `source_id`。
- 源全部不可用 → 等同"未接入发射状态源"，**不阻断、不沿用旧值、不把 unknown 当发射**，响应带 `interlock:"not-enabled"`。
- 设备侧要求：**宁可报"没发射"，也不要报"正在发射"**造成全站锁死；也不得为了"安全"把 `tx_active` 恒置 true。

## 13. 错误码与状态字

### 13.1 设备 → 平台 `error` 码

出现在 `heartbeat` 的 `data.error`（ack 帧或状态帧均可）。

| `error` | 含义 | 设备应同时做什么 |
|---|---|---|
| `tx-active` | 检测到发射，拒绝射频动作 | 保持原位，不改 `ports` |
| `rf-detected` | 检测到 RF 能量（可能非本机发射） | 同上 |
| `unknown-channel` | 端口/通道不存在 | 不动作 |
| `unknown-band` | 波段不在设备的 `supported_bands` | 不动作 |
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

可扩展规则：

1. `error` 是**开放字符串枚举**，新增值只需登记到本表并把 `proto` minor +1。
2. 接收方遇到未登记的 `error` 必须：记录原始字符串、按"未知故障"处理（不崩溃、不据此做安全动作）。
3. **禁止**用数字码表达错误；数字只用于 `fault_word` 位图。
4. 面向人的补充信息一律放 `error_detail`（≤200 字符），不参与决策。

### 13.2 平台 HTTP 错误码

状态码语义按 RFC 9110 §15。

| HTTP | `error` | 含义 |
|---|---|---|
| 202 | — | 已受理（异步下发，不代表已执行） |
| 200 | — | 上报已处理 |
| 200 | `duplicate` | 幂等命中 |
| 200 | `ignored: "stale-seq"` | 序号回退，整帧丢弃 |
| 400 | `invalid-arg` | 参数不在白名单/越界 |
| 400 | `empty-command` | 没有可下发字段 |
| 400 | `unknown-command` | 命令不存在 |
| 400 | `invalid-device-type` | 命令与设备类型不符 |
| 400 | `invalid-port` / `invalid-outlet` | 端口参数缺失或格式错 |
| 400 | `unknown-port` | 端口不存在 |
| 400 | `invalid-direction` | 不是 in→out / 塔方向非法 |
| 400 | `unknown-channel` | 干接点通道未配置 |
| 400 | `transport-not-configured` | 未配置 B 档地址 |
| 400 | `source-id-required` | TX 上报缺 `source_id` |
| 400 | `tx-active-required` | TX 上报缺布尔 `tx_active` |
| 400 | `invalid-seq` | `seq` 不是数字 |
| 400 | `invalid-tower-limit-top` 等 | 塔上报字段非布尔 |
| 401 | `seat-required` | 缺 `X-DX-Seat` |
| 403 | `invalid-token` | TX 源 token 不匹配 |
| 404 | `unknown-device` | 设备不存在 |
| 409 | `device-locked` | 他席持有租约（30 s） |
| 409 | `direction-switch-too-fast` | 换向 <1000 ms |
| 409 | `protocol-undetermined` | 设备协议尚未判定 |
| 423 | `tx-active` | **发射中禁止切换天线/矩阵 OUT**（带 `scope`、`source_id`） |
| 501 | `unsupported-control` | 型号不支持控制 |
| 501 | `unsupported-switch-model` | 型号不受支持 |
| 502 | `transport-connect` | 连不上设备/broker |
| 502 | `transport-error` | 传输错误 |
| 504 | `transport-timeout` | 干接点请求超时 |

### 13.3 `state` 枚举

| 值 | 含义 | 适用 |
|---|---|---|
| `init` | 上电自检中 | 全部 |
| `idle` | 就绪且位置已确认 | 全部 |
| `switching` | 射频通路切换中 | switch / matrix / bpf |
| `moving` | 塔运动中 | tower |
| `fault` | 故障（见 `fault` / `fault_word`） | 全部 |
| `unknown` | 状态无法确定 | 全部 |

平台映射：`switching` → `pending`；`fault` → `unverified`/`fault`；`unknown` → `unknown`；无上报 → `awaiting`。

### 13.4 `fault_word` 位定义

未定义的位一律保留 0；新增位必须登记。

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

> 本表适用于 switch / matrix / tower / swr。BPF 不使用 `fault_word`，改用 `alarms[]`（§11.4），`fault` 为最高严重级别的告警码。

### 13.5 关键语义

- **202 只表示"已发出"**，不代表已执行；真正确认来自回读。
- **423 `tx-active`** 是互锁唯一拒绝码，带 `scope`（`path`/`global`）与 `source_id`。
- **409 `device-locked`** 是席位租约冲突，30 s 自动过期。
- 审计只追加，`result` 取 `accepted` / `duplicate` / `rejected` / `rejected_tx`。

---

## 14. 安全边界

本节是硬件验收的**否决项**。任一条不满足，不得接入现场。

### 14.1 必须保持静默的情况

| 情况 | 要求 | 理由 |
|---|---|---|
| 上电自检未完成 | 不发布状态帧，不发 `ports` | 防止把"未知"报成"已知" |
| 机械位置读不出 | 只发 `null`，不发猜测值 | 上报即承诺 |
| `tx_active` 期间无新事件 | 只按保活间隔发，不刷屏 | QoS 0 下高频无意义 |
| 内容与上一帧完全相同 | 不发（保活帧除外） | 心跳去重 |
| 收到非法 JSON / 未知 `cmd` | 丢弃，不回报 | 不是有效指令 |
| 收到 `device_id` 与自身不符的指令 | 丢弃 | 防串台 |
| 未完成校准的驻波表 | 不提供 `tx_active=true`（宁可不判发射） | 假发射误锁；假不发射害射频 |

> **"拒绝执行"不是静默**：凡收到有效指令但不能执行，必须回 ack 帧说明原因（§14.2）。

### 14.2 必须拒绝执行的情况

| 情况 | 返回 | 依据 |
|---|---|---|
| 发射中切换天线/矩阵 OUT | `tx-active` | §8.3、§9.3 |
| 发射中切换 BPF / 直通 | `tx-active` / `rf-detected` | §11.5 |
| 远程把切换器置"全断" | `invalid-arg` | §8.3 |
| 远程把矩阵某输入置 `null` | `invalid-arg` | §9.3 |
| 多输入接同一输出 | `output-busy` | §9.3 |
| 让塔两路同时闭合 | `interlock-open` | §10.3 |
| 换向 <1000 ms | `direction-switch-too-fast` | §10.3 |
| 塔已到位还同向运行 | `limit-reached` | §10.4 |
| 双限位同时有效时任何动作 | `limit-conflict` | §10.4 |
| 写校准/保护阈值 | `calibration-locked` | §12.4 |
| 参数越界 | `invalid-arg` / `unknown-*` | 各节 |

### 14.3 断电或重启后必须报告的状态

| 设备类 | 必须报告 | 绝不允许 |
|---|---|---|
| 切换器 | `state="init"`，实测 `position`（读不到则 `null`），`ports` 按实测 | 沿用断电前 `ports` |
| 矩阵 | 每输入实测通路，读不到的那个输入报 `null` | 把全部输入报成"上次选择" |
| 铁塔 | 两路 `motor_on=false`、`hold_active=false`，实测两限位 | 自动继续断电前方向 |
| BPF | `state="init"`→自检通过后 `bypass=true`、`current_band=null`（§11.6 写死）；`supported_bands` 与 `capability_rev` 必须重发；`alarms` 按实测 | 自动插入断电前波段；省略 `supported_bands` |
| 驻波表 | `tx_active=false`、`cal_valid` 按实测、`peak_fwd_w=0` | 报上一次 `tx_active=true`（会永久锁死切换） |

统一要求：

- `boot_id` 每次上电/复位必须变化；`uptime_ms` 从 0 起算。
- `seq` 必须持久化；做不到时重启首帧起省略 `seq`（§5.4）。
- 重启后首帧必须是**完整快照**，不能是增量。

平台运行态只存内存，平台重启后全部为 `unknown`，必须等设备重新上报。所以"设备重启后自己报"不是可选行为。

### 14.4 绝不允许由平台远程触发的动作

射频安全：

| 动作 | 设备类 | 原因 |
|---|---|---|
| 发射中切换天线通路 / 矩阵输出 | switch / matrix | 带电热切换烧继电器、拉弧、损坏功放 |
| 远程"全断"某输入或输出 | switch / matrix | 发射时开路 → 全反射 → 功放损毁 |
| 多输入并到同一输出 | matrix | 射频合路，互调与功率叠加不可控 |
| 发射中切换 BPF 或强制直通 | BPF | 瞬态失配与带外发射 |
| 旁路/短接滤波器"应急" | BPF | 失去保护，干扰他台 |
| 远程写校准、清零基准、改保护阈值 | SWR | 读数与保护失效 |
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

### 14.5 失联 fail-safe

| 设备类 | 断线/超时后的物理状态 | 平台展示 |
|---|---|---|
| 切换器 / 矩阵 | 保持机械位置（自保持），不自动回默认位 | 按连接或超时判 `offline` |
| 铁塔 | **1500 ms 内断开两路** | `offline`，`last_state` 保留 |
| BPF | 保持当前位置 | `offline` |
| 驻波表 | 继续本地测量；无法上报时互锁降级 | `stale` → `offline`；互锁 `not-enabled` |

降级原则：源不可用 = "未接入发射状态源"，**不阻断、不沿用旧值、不把 unknown 当发射**，但界面必须明确提示互锁未启用。

---

## 15. 待评审决策项

| 编号 | 待确认 | 影响 |
|---|---|---|
| R1 | 主题前缀最终命名（§3.4） | 出厂后再改要升级所有固件 |
| R2 | 是否强制 A + B 双档（§1.5） | 决定首批硬件能否直接联调 |
| R3 | `proto` 版本策略与 `ts` 双时间字段（§4.1、§4.5、§6.1） | 影响所有固件 |
| R4 | ack 帧是否强制（§4.10） | 固件复杂度与排障方式 |
| R5 | 单帧 8192 字节上限（§4.8） | 与天线表规模相关 |
| R6 | 心跳间隔 5 s / 1 s（§5.2） | 带宽与离线误判 |
| R7 | 字段精度 0.1 W / 0.01 SWR / 0.1 ℃（§4.4） | 与传感器分辨率绑定 |
| R8 | 是否强制装配 `rf_detected` | 硬件成本 |
| R9 | 矩阵 `output-busy` 互斥口径（§9.3） | 是否允许输出共用 |
| R10 | 塔 A 档用 `direction` 还是沿用干接点通道号（§10.3） | 塔控制器固件接口 |
| R11 | BPF 必须支持旁路（§11.3、§11.5）。本协议已按"必须支持"写死；若某型号物理上无法旁路，需走不兼容变更评审，不在协议里留"不支持"分支 | 影响所有 BPF 固件与状态机 |
| R12 | BPF 上电默认直通（§11.6，已写死） | 安全取舍，评审确认 |
| R13 | 切换器 200 ms 动作 / 1 s 超时（§8.4） | 依赖继电器与机械结构 |
| R14 | `fault_word` 位分配（§13.4） | 位定义一旦发布不宜改 |
| R15 | 设备侧 `msg_id` 去重缓存 16 条（§3.7） | 内存与去重强度取舍 |

---

## 附录 A · 一帧到底长什么样

以切换器为例，从操作员点击到状态确认的完整链路：

```
操作员点击 ant3
   │
   ▼
POST /api/devices/SW-A/command
X-DX-Seat: OP-A
{"command":"select","port":"in","outlet":"ant3"}
   │  类型/端口/方向校验 → TX 互锁 → 席位租约 → 下发
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
   ▼  平台写入回读 → state="verified"
GET /api/devices → 该通路进入 RF 可达与互锁
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

## 附录 B · JSON Schema 索引

### B.1 文件清单

均为 JSON Schema draft 2020-12，随本项目 `docs/schema/` 目录交付。

| 文件 | 校验对象 |
|---|---|
| `common.schema.json` | 共用定义（信封、时间、数值、错误码、`device_id`） |
| `heartbeat-switch.schema.json` | 切换器 heartbeat（含 ack 帧） |
| `command-switch.schema.json` | 切换器 json_command |
| `heartbeat-matrix.schema.json` | 矩阵 heartbeat |
| `command-matrix.schema.json` | 矩阵 json_command |
| `heartbeat-tower.schema.json` | 铁塔 heartbeat |
| `command-tower.schema.json` | 铁塔 json_command |
| `heartbeat-bpf.schema.json` | BPF heartbeat |
| `command-bpf.schema.json` | BPF json_command |
| `heartbeat-swr.schema.json` | 驻波表 heartbeat |
| `command-swr.schema.json` | 驻波表 json_command |
| `http-tx.schema.json` | `POST /api/devices/tx` 请求体 |

`common.schema.json` 的 `$id` 为 `https://dx-compass.local/schema/common.schema.json`，其余文件通过该 `$id` 引用。

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

### B.3 约束边界

Schema 只做**结构、类型、范围、必填**校验，不做下列语义校验（由固件与平台各自实现）：

- `ports` 的键是否在 `1…out_count` / `1…in_count` 内；
- `position` 与 `ports` 是否自洽；
- 限位 NO/NC 逻辑；
- 互锁与看门狗时序；
- `tx_active` 的物理真实性。

这些属于状态机语义，没有一份 JSON Schema 能可靠表达；不要试图用 Schema 代替固件自检。

Schema 的枚举策略（与 §4.9 一致）：

- **开放枚举**（`state`、`error`、`fault`）：只做 `type: string` + 长度/字符约束，**不使用 `enum`**，保证旧校验器不会拒绝新值。
- **封闭枚举**（`device_class`、`result`、`action`）：使用 `enum`；新增值属 minor 升级，Schema 随之更新。
- 数值一律用 `minimum`/`maximum` + `type`，不用 `multipleOf` 约束小数位（浮点在验证器间行为不一致，精度由 §4.4 的发送方规则保证）。

### B.4 回归用例

`docs/schema/check-examples.mjs` 是随文档交付的可执行用例，覆盖结构校验与关键语义裁决：

```bash
node docs/schema/check-examples.mjs
```

要求全部用例 `PASS`、进程退出码 0。它固定了下列行为，改动协议前必须先改用例并说明理由：

| 类别 | 用例 |
|---|---|
| 结构 | 五类设备 heartbeat / json_command 的必填、类型、范围、枚举 |
| 组合约束 | BPF 指令 `band`/`bypass`/`action` 三选一（给两个或零个均拒绝）；`codes` 只能与 `action` 同时出现 |
| BPF 快照 | `supported_bands` 不允许空数组、标识必须匹配 `^\d{1,3}m$`、`bypass=true` 时 `current_band` 必须为 `null` |
| BPF 语义 | 波段不在 `supported_bands` → `unknown-band` + `band-unsupported`；发射中（`tx_active`/`rf_detected`）→ `tx-active`；切换中 → `busy`；`fault` 状态换波段 → `hardware-fault`；`ack_alarms` 在发射中仍可执行 |
| 波段标识 | 平台已知 / 语法合法未识别 / 语法非法 三种分类的判定 |

用例中的平台波段集合仅用于演示"平台可识别"的判定方式，不是对设备能力的要求。
