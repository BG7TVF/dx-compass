# 第三方设备接入与取证记录

- 定位：工程内部文档。记录站内对第三方/遗留设备的接入现状、证据强度、未验证项与服务端改造事项。
- **不是硬件接口标准**。官方设备协议见 `dx-compass-official-device-json-protocol.md`，本文不复制、不改写其字段定义。
- 品牌型号的帧格式与取证结论以 `rf-component-spec.md` §10–§17 为准；本文只记录"我们现在改到哪、还差什么"。

---

## 1. 已实现的接入能力

| 能力 | 位置 | 适用设备 |
|---|---|---|
| MQTT JSON 心跳/指令（`remote_control`） | `lib/devices/amp-link.js` | 功放（含国赫 AMP1000） |
| 干接点脉冲/吸合/释放 | `lib/devices/relay.js` | 切换器、矩阵、塔 |
| 设备遥测上报（在线、限位、角度、端口） | `lib/devices/service.js` | 塔、驻波表、任意类型 |
| 发射状态上报与健康度 | `lib/devices/tx.js` | 驻波表（作为 TX 源） |
| 统一指令入口（租约、互锁、审计） | `lib/devices/commands.js` | 全部 |
| 切换器回读状态机 | `lib/devices/switch-link.js` | 有回读的型号 |
| 塔按住运行与看门狗 | `lib/devices/tower-hold.js` | 塔 |
| 型号能力表（协议/传输/回读/可控/已验证） | `lib/devices/switch-models.js` | 切换器、矩阵 |

## 2. 官方设备 A 档接入的服务端改造清单

官方协议（A 档）目前只有功放一类落地；其余 5 类设备要接 A 档，需完成下列事项。编号 G1–G10 与评审记录对应。

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

## 3. 现阶段能接什么

| 硬件形态 | 今天 | 说明 |
|---|---|---|
| B 档切换器（网络继电器板） | 可以 | 可切换，状态 `unverified`，无回读 |
| B 档塔控器 | 可以 | 按住运行 + 限位上报，完整二态与看门狗 |
| B 档驻波表 | 可以 | 可提供 TX 状态并参与互锁 |
| A 档任意官方设备 | 不可以 | 需完成 G1–G10 |
| B 档 BPF | 只能看在线 | 无控制 |
| A 档 BPF | 不可以 | 需 G2/G5 |

## 4. 官方协议字段的推导来源

官方协议的所有字段来自两类：

1. **从现有实现反推**（必须逐字一致）：主题结构、信封、`cmd`、`timestamp` 秒、delta 语义、`data.device_id` 校验、`result=error` 掉帧、QoS 0/clean/重连 5 s/协议 3.1.1（`amp-link.js`）；`ports` 按键合并与 verified/pending/unverified/stale（`switch-link.js`、`commands.js`）；端口键与 1–16 上限（`rf.js`、`model.js`）；干接点契约、2 s 超时、50–5000 ms 脉宽（`relay.js`）；租约 30 s、423 `tx-active` 与 scope（`runtime.js`、`commands.js`）；塔 500/1500/1000 ms（`tower-hold.js`）、限位原始电平与 NO/NC 取反（`tower.js`）；10 s 离线阈值（`service.js`）；TX `source_id`/严格布尔/2000 ms/3× 降级/`stale-seq`/403 token（`tx.js`）。
2. **新定，待评审**：`proto`/`ts`/`device_class`/`boot_id`/`uptime_ms`、ack 帧、`/status` LWT、心跳间隔、8192 字节上限、`fault_word` 位分配、矩阵 `output-busy`、BPF 的 `band`/`bypass`/`mode`、驻波表指标集与判定门限、断电后默认直通等。

逐字段对照表见官方协议 v1.0 初版（提交 `bd3d1c0`）的 §14.2；该表已从官方文档移出，保留在版本历史中备查。

## 5. 遗留型号的取证状态

| 型号 / 驱动 | 现状 | 取证记录 |
|---|---|---|
| RCS-4（`rcs4-tcp`） | 4 字节帧与校验和由参考实现推断，无厂商文档 | `rf-component-spec.md` §17.5 |
| Amplitec（`amplitec-tcp`） | 只确认了读状态帧，字段位置为推断 | `rf-component-spec.md` §17.5 |
| Station Genius（`station-genius-tcp`） | 64 字节帧与按键码来自社区逆向 | `rf-component-spec.md` §17.5 |
| Six2Two（`six2two-mqtt`） | topic 约定来自项目文档，无厂商依据 | `rf-component-spec.md` §17.5 |
| Antenna Genius legacy（`ag-tcp` 旧二进制） | 旧二进制帧来自调研，未在厂商文档核对 | `rf-component-spec.md` §17.5 |

处理口径：

1. 这些型号在型号表标 `verified:false`，界面显著提示；对外不呈现为"已支持并已验证"。
2. 官方硬件不得以其帧格式为模板，也不得声明"兼容 XX"。
3. 拿到厂商文档后另行立项核对，再决定是否进入 `rf-component-spec.md` 的已验证清单。

## 6. 相关文档

- `docs/dx-compass-official-device-json-protocol.md`：官方设备协议（A/B 档、Schema 索引）。
- `docs/rf-component-spec.md`：部件、端口、各品牌接入与取证细节。
- `docs/schema/`：官方协议的 JSON Schema（draft 2020-12）。
