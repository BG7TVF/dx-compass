# 设备接入实施方案（Phase 0–5）

> 依据：`docs/device-integration-review.md` 已定死的设备模型、状态机与边界；本文只做落地拆解，不重新设计。
> 最新口径以 2026-11-12 任务消息为准（租约 60s、按角度幂等、服务端唯一状态源、明文口令、`/red` 禁用、塔按住运行 + 心跳）。

## 0. 现状与总原则

- 部署位置由用户决定：**不做网络拦截、不判断公网/内网**，只做提醒。
- 所有设备一张表、一个 `parent_id`；任何类型可父可子；约束只有单父、无环、有子节点禁止删除。
- 服务端是唯一状态源；客户端每次显示都从服务端拉取，不缓存设备状态。
- 设备口令与 TX 源令牌明文存 SQLite，不进 settings、不进日志、不出现在读接口响应里。
- 不锁品牌、不做型号白名单、不做厂商适配；协议只提供标准能力与可配置通道。
- N1MM 的 `is_transmitting` 永远不进准入判断，只做显示与弱提示。
- 不做任何自动归属写回；归属只计算、只投影。
- 审计只追加，不修改历史行。

## Phase 0 · 数据与契约

**目标**：把统一节点模型、天线波段/安装偏移、TX 上报入口、P1 语义和两个设置项落库并可用。

**数据模型**
- `devices`：`id`、`name`、`type`（开放字符串）、`parent_id`、`bands`（逗号分隔）、`install_offset_deg`（0–359）、`exclusive`（1×n）、`port_label`、`password`（明文）、`enabled`、`travel_timeout_sec`、`notes`、时间戳。
- `tx_sources`：`source_id`、`name`、`priority`、`timeout_ms`（默认 2000）、`token`（明文）、`enabled`、时间戳。
- 迁移：`CREATE TABLE IF NOT EXISTS` + 启动时 `PRAGMA table_info` 与 `ALTER TABLE` 补列；不删旧数据。

**接口**
- `GET /api/devices`：设备树 + 运行态 + 席位归属 + TX 源快照。
- `POST /api/devices`：`action=save|delete|tx-source|tx-source-delete|report`。
- `POST /api/devices/tx`：`source_id`、`tx_active`、可选 `ts`/`seq`；未知源自动登记为最低优先级。
- `POST /api/devices/report`：通用只读遥测（设备在线、塔限位、旋转器角度、端口）。

**UI**：设备树、状态只读展示、TX 源面板、归属三色、塔二态；两个设置项（限位开关 NO/NC 默认 NO；脉冲宽度默认 400ms）。

**测试**：单父/环/删除保护、偏移换算、租约释放、角度去重、unknown 语义、归属三态、TX 超时降级。

**验收**：`GET /api/devices` 可 curl 联调；无源时常驻「未接入发射状态源」；切换波段或席位离线后灯色立即变化。

## Phase 1 · 只读监控

**目标**：设备配置可增删改，状态只读展示，归属只计算不写回。

**接口**：复用 Phase 0 的 `GET /api/devices` 与 `POST /api/devices`（`save`/`delete` 只改配置）。

**UI**
- 左侧统一设备树，可新增/编辑/删除设备与父子关系。
- 右侧状态卡：在线/通信中断/未知、最近上报、旋转器实际/目标角、塔二态、TX 源健康。
- 席位表：按当前波段投影红/黄/绿；本席=红、他席=黄、空闲=绿；1×n 不产生黄灯。
- 席位离线判定：60 秒无 N1MM UDP 心跳即离线并释放占用。

**测试**：两席位不同颜色、离线释放、同波段双红、无天线波段提示。

**验收**：无写操作；刷新失败整页回落 `unknown`；客户端不保留旧值。

## Phase 2 · 鉴权与指令骨架

**目标**：建立统一指令通道、设备租约、按角度幂等、审计与 `/red` 禁用，为 Phase 3–5 提供唯一入口。

**数据模型**
- `device_commands`（只追加）：`id`、`ts`、`device_id`、`seat`、`operator`、`command`、`args`、`result`、`error`、`ip`。
- 运行态新增：`deviceLeases`（device→{seat, expires_ms}）、`rotator target`、`last_commander`、`towerHolds`。

**接口**
- `POST /api/devices/:id/command`：
  - 必带 `X-DX-Seat`（缺失 401 `seat-required`）；设备有口令时必带 `X-DX-Device-Token`（错误 403）。
  - 设备租约 30s：他席持有 → 409 `device-locked` + `owner`；`stop`/`release` 例外。
  - 按角度幂等：目标角与当前目标角相同 → 返回首次 `command_id`，不下发；360 与 0 等同。
  - 返回 `202` + `command_id`；结果经 `/ws` 的 `deviceCommand` 消息回推。
  - 审计每次受理/拒绝/失败，含 seat、operator、command、args、result、error、ip。

**UI**：所有控制按钮携带 `X-DX-Seat`；错误码映射为可读提示；实时刷新服务端状态。

**测试**：无 seat 401、错误设备口令 403、并发写 409 + owner、重复角度返回首次结果、审计行完整、租约过期。

**验收**：绕过 API 无第二入口；`/red` 一律 404。

## Phase 3 · 旋转器写操作（rotctld / GS-232）

**目标**：通过 rotctld（GS-232 语义）控制旋转器，支持实际角、目标角、运动状态、最近发起席位。

**数据模型**
- `devices.config_json`：`{host, port, protocol:"rotctld"}`；`protocol` 仅接受 `rotctld`（GS-232 语义）。
- 运行态：`physical_azimuth`、`target_azimuth`、`motion_state`、`last_commander`、`last_command_id`。

**接口**
- `command="rotate"`，参数 `azimuth`（0–359）；到达/覆盖均直接下发最后目标；不做发射判定。
- 使用 rotctld 文本协议：`P <az> 0\n` 设定、`p\n` 回读、`S\n` 停止；TCP 超时 2s、断线指数退避重连。
- 每副天线的实际指向 =（旋转器物理角 + 该天线 `install_offset_deg`）mod 360。

**UI**：目标角输入 + 转动/停止；显示实际/目标/运动中/最近发起席位；离线禁用并标注。

**测试**：帧格式、回读解析、超时/断线不误报、同角幂等、360≡0、偏移分别显示、无 TX 拦截。

**验收**：点击到下发 ≤2s；连点只执行最后目标；离线不发指令。

## Phase 4 · 天线切换器与 n×n 矩阵 OUT（继电器干接点）

**目标**：通过可配置继电器通道完成 1×n 切换与 n×n 矩阵 OUT，并接入 TX 上报源互锁。

**数据模型**
- `devices.config_json`：`{relay_url, relay_token, channels:{"IN1:1":1,...}, pulse_ms}`；通道由用户现场配置。
- 运行态：`ports:{port:outlet}`、`last_commander`。

**接口**
- `command="select"`，参数 `port`、`outlet`；通道不存在 → 400 `unknown-channel`。
- 互锁：当前生效 TX 源 `tx_active=true` → **423 `TX_ACTIVE`**，不输出、不二次确认；审计 `rejected_tx`。
- 未接入源或源中断 → 互锁不启用、正常放行，响应带 `interlock:"not-enabled"` 与提示。
- 1×n 与 n×n 使用同一互锁；1×n 归属投影不产生黄灯。
- 输出为干接点脉冲：`pulse_ms` 取设备配置，缺省 400ms（与全局 `towerPulseWidthMs` 默认一致）。
- 继电器 HTTP 契约（软件只提供能力，接线由现场决定）：`POST <relay_url>`，JSON `{"channel":N,"action":"pulse","pulse_ms":400}` / `{"channel":N,"action":"on"}` / `{"channel":N,"action":"off"}`；可选头 `X-Relay-Token`。2s 超时，非 2xx 记通信失败，不重试。

**UI**：端口/出口选择 + 切换按钮；显示互锁状态、当前端口映射、拒绝原因。

**测试**：TX active 拒绝 423 且无继电器调用、无源放行、源中断放行、1×n 同样拒绝、通道校验、脉冲参数。

**验收**：上报 active 时无旁路；无源提示常驻；审计完整。

## Phase 5 · 天线塔升降（继电器 + 按住运行）

**目标**：二态塔控制，按下保持、松开释放、心跳 500ms、服务端 1500ms 超时释放。

**数据模型**
- `devices.config_json`：`{relay_url, relay_token, up_channel, down_channel}`。
- 运行态：`towerHolds`（方向、席位、开始时间、到期时间、通道）。

**接口**
- `command="tower_hold"`（`direction:"up"|"down"`）：闭合对应通道并续期；重复心跳幂等。
- `command="tower_release"`：立即释放；`tower_stop` 同义。
- 看门狗 250ms 扫描，超过 1500ms 未续期 → 释放并广播 `heartbeat-timeout`。
- 两路不同时闭合；反向前先断后合，方向切换最小间隔 1000ms（不足 → 409 `direction-switch-too-fast`）。
- 服务启动/重载默认释放；删除/改配置设备时释放其输出。
- 最短闭合时间取设置项 `pulse_width_ms`（默认 400ms），短按不会抖动。

**UI**：上升/下降按住按钮；按下每 500ms 续心跳，松开/离开/失焦立即释放；显示二态、运动暂态、超时/故障。

**测试**：心跳续期、1500ms 超时释放、松手立即释放、反向前先断、最小间隔、两路互斥、重启默认释放、限位 NO/NC、双限位 fault。

**验收**：任何时刻两路不同时闭合；断网 1.5s 内输出释放；塔状态未知时不声称终态。

## 部署与回滚

- 全部阶段完成后统一部署；启动时自动补齐表与列，不破坏已有数据。
- 回滚：`devices.enabled=false` 停止写操作；保留审计表；不做破坏性删列。
- 旋转器依赖现场一台运行 `rotctld` 的主机（TCP 4533），部署归属由用户决定。
- 继电器板由用户自备，软件只发送可配置的 HTTP 干接点命令。

## 测试矩阵与提交策略

- 每个阶段跑完整 `node --test`；全绿才提交，提交主题含阶段名。
- 覆盖：设备树、偏移、租约、去重、unknown、三态、TX 降级、鉴权、409/423、审计、rotctld 帧、继电器、塔心跳。
- `docs/*.md` 与 `.screenshots/` 保持未跟踪。
