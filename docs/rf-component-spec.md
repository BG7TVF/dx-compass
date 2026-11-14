# 天馈系统部件 / 端口 / 属性规范

本文是设备画布重构（18 条）的依据。调研对象是业余无线电台站里真实存在的天馈部件，
不局限于当前画布已支持的 10 类。先给结论，再给本期实现边界。

## 1. 端口语义（先定死）

| 形状 | 类别 | 是否可连线 | 作用 |
|---|---|---|---|
| 方形 | 射频端口（RF） | 只与方形相连，参与 TX 可达与互锁 | 同轴线连接点；方向由 `in` / `out` / `bidir` 决定 |
| 圆形 | 控制 / 状态端口 | 控制口只与圆形控制口相连，**不接射频**；状态口不连线 | 表达控制或遥测通道，如 rotctld、继电器、串口、限位、功率/SWR 上报 |

规则：

1. 同一台设备可以同时有方形与圆形端口，但两者在画布上分排显示：
   射频口在卡片上/下缘，控制/状态口在卡片侧边；混接（方-圆）在服务端直接拒绝。
2. 射频源（电台）只有 `out`，没有 `in`；射频末端（天线、假负载）只有 `in`，没有 `out`。
3. 串联环节一律 `in` + `out` 各一个（驻波表、BPF、功放、天调、陷波器、避雷器、巴伦、LNA）。
4. 分支/汇聚设备端口数量由属性派生：
   - 合路器：波段数 = `in` 口数，另有 1 个 `out`；
   - 功分器：1 个 `in`，`out` 数 = 路数；
   - 切换器：1 个 `in`（电台侧，物理上的 COMMON）+ `ant1…antN`；
   - 矩阵：`in1…inN` + `out1…outM`；
   - 串口服务器：没有射频口，只有 `net` + `serial1…serialN` 控制口。
5. 波段只影响“这条通路能不能走这个波段”，不改变端口数量；唯一例外是合路器，它按波段分口。
6. 端口 key 使用小写、`[a-z0-9:_-]`，波段口统一 `in:<band>`。
7. **布置规则：下 in、上 out。** 射频连接点按信号方向分布在卡片上下两边——
   所有 `in`（含 `bidir` 的进入侧）在下边，所有 `out` 在上边，不要全堆在同一侧。
   这样从电台（out，上边）向下经串联设备（下 in / 上 out）到天线（in，下边）时，
   走线方向与信号方向一致，减少回绕和交叉。
8. 圆形控制口之间的连线只表达控制从属关系（当前用于串口设备 → 串口服务器），
   单独存 `control_links`，不进入射频图，不参与 TX 可达、波段剪枝或发射互锁。

## 2. 部件总表

“本期”列：`改` = 纳入 18 条修正；`保留` = 本期只按新端口/属性规范收敛；`后续` = 规范已定，本期不新增类型。

| 类型 | 射频位置 | 射频端口（方形） | 控制/状态（圆形） | 应保留属性 | 本期 |
|---|---|---|---|---|---|
| 电台 `radio` | 射频源 | `out` ×1 | 无 | 名称、计算机标识（StationName / ComputerName）、电台型号、备注 | 改 |
| 功放 `amp` | 串联 | `in` / `out` | keying、状态 | 名称、工作波段（多选）、备注 | 保留 |
| 驻波表 `swr` | 串联测量 | `in` / `out` | SWR/功率上报 | 名称、上报 IP、上报端口、备注 | 改 |
| BPF `bpf` | 串联滤波 | `in` / `out` | 无 | 名称、通过波段（多选）、备注 | 改 |
| 合路器 `combiner` | 按波段汇聚 | `in:<band>` ×N / `out` | 无 | 名称、波段（多选）、备注 | 改 |
| 切换器 `switch` | 选择 | `in`（COMMON）/ `ant1…antN` | 继电器控制、当前位 | 名称、输出路数、继电器配置、备注 | 改 |
| 矩阵 `matrix` | 路由 | `in1…inN` / `out1…outM` | 继电器控制、当前路由 | 名称、输入/输出路数、继电器配置、备注 | 改 |
| 天线 `antenna` | 通路末端 | `in` ×1 | 无 | 名称、波段（多选）、安装偏移、备注 | 改 |
| 塔 `tower` | 不接射频 | 无 | 上/下限位、升降控制 | 名称、继电器配置、上/下通道、脉冲宽度、运行超时、备注 | 改 |
| 旋转器 `rotator` | 不接射频 | 无 | rotctld、当前方位 | 名称、rotctld host/port、旋转超时、备注 | 改 |
| 串口服务器 `serial` | 不接射频 | 无 | `net` + `serial1…N`（均为控制口） | 名称、监听 IP/端口、串口数、波特率/数据位/停止位/校验、备注 | 新增 |
| 天调 `tuner` | 串联 | `in` / `out` | 调谐控制、状态 | 名称、支持波段（多选）、备注 | 后续 |
| 陷波器 `notch` | 串联 | `in` / `out` | 无 | 名称、抑制波段（多选）、备注 | 后续 |
| LNA `lna` | 串联（接收） | `in` / `out` | 供电/旁路 | 名称、供电方式、备注 | 后续 |
| 巴伦 `balun` | 串联/天线侧 | `in` / `out` | 无 | 名称、变换比、备注 | 后续 |
| 避雷器 `spd` | 串联 | `in` / `out` | 接地状态（可选） | 名称、安装位置、备注 | 后续 |
| 定向耦合器 `coupler` | 串联测量 | `in` / `out` / `cpl` | 耦合口测量 | 名称、耦合度、方向、备注 | 后续 |
| 假负载 `dummy` | 通路末端 | `in` ×1 | 无 | 名称、承受功率、备注 | 后续 |
| 功分器 `divider` | 分支 | `in` ×1 / `out1…outN` | 无 | 名称、路数、备注 | 后续 |
| 双工器/三工器 | 按波段汇聚 | 同合路器 | 无 | 名称、波段（多选）、备注 | 用 `combiner` 表达，不新增类型 |
| 天线开关 | 选择 | 同 `switch` | 同 `switch` | 同 `switch` | 用 `switch` 表达 |

结论：**本期不新增射频部件类型**。双工器/三工器与合路器同构（N 个波段口 → 1 个公共口），
天线开关与切换器同构；功分器只是合路器反向，但会改变可达判定语义，放到下一批与 RX 方向一起做。
控制侧新增 `serial`（串口服务器）类型，它没有射频口，只提供控制口的串口汇聚。
调研结论先固化，避免本次同时改模型和交互导致回归面失控。

## 3. 属性白名单（本期）

全局字段（所有类型）：`name`、`notes`、`parent_id`（机械挂载，画布连树）、`layout`。
`type` 在拖出设备时确定，创建后不可编辑；不再作为表单字段。

| 类型 | 专属字段 | 明确移除 |
|---|---|---|
| `radio` | `config.computer`（计算机标识：StationName 或 ComputerName）、`config.model`（RadioName/电台型号）、派生 `seat` | 波段、安装偏移、端口、口令、运行超时、独占通路 |
| `swr` | `config.host`（上报 IP/主机）、`config.port` | 类型、波段、安装偏移、端口、口令、运行超时、独占通路 |
| `bpf` | `bands`（通过波段多选） | 类型、安装偏移、端口、口令、运行超时、独占通路 |
| `amp` | `bands`（工作波段多选）、`config.host`、`config.port` | 类型、安装偏移、端口、口令、运行超时、独占通路 |
| `antenna` | `bands`（多选）、`install_offset_deg` | 端口、口令、运行超时、独占通路 |
| `combiner` | `bands`（多选，决定 `in` 口） | 安装偏移、端口、口令、独占通路 |
| `switch` | `config.out_count`、继电器配置 | 波段、安装偏移、独占通路 |
| `matrix` | `config.in_count`、`config.out_count`、继电器配置 | 波段、安装偏移、独占通路 |
| `tower` | 继电器配置、`config.up_channel`、`config.down_channel`、`config.pulse_ms`、`travel_timeout_sec` | 波段、安装偏移、端口、独占通路 |
| `rotator` | `config.host`、`config.port`、`travel_timeout_sec` | 波段、安装偏移、端口、独占通路 |
| `serial` | `config.host`、`config.port`、`config.port_count`、`config.baud`、`config.data_bits`、`config.stop_bits`、`config.parity` | 波段、安装偏移、运行超时、独占通路 |


移除的设备级字段：`password`、`port_label`、`exclusive`、非电台类型的 `seat`。
`password` 在现有代码里没有任何传输层使用（继电器用 `relay_token`），属于历史残留，一并删除。

## 4. 波段

- 唯一来源：`lib/radio/bands.js` 的 13 个波段（160m…70cm）。
- 所有波段字段改为复选框多选，禁止自由输入；服务端仍按 `^\\d{1,3}m$` 校验。
- 合路器的 `bands` 直接派生 `in:<band>` 端口。

## 5. 席位归属模型

### 5.1 归属在电台节点

- 席位不再是设备的分类维度，也不再是画布分区。
- 电台节点保存 `config.computer` + `config.model`，与 N1MM 上行报文里的
  计算机标识（`ComputerName`，缺省时取 `StationName`，如 `BG7TVF-2`）和
  `RadioName` 对应；席位键仍由现有 `seat-identity` 规则解析
  （计算机标识 + RadioName + RadioNr，回退 SourceIP + RadioNr），不另造一套。
- 快照时把 `radioStates` 的席位键回填到匹配的电台节点，`seat` 只读展示，不手填。
- `config.computer` / `config.model` 在表单里是下拉，候选由服务端从**实收 N1MM 报文**汇聚：
  `GET /api/seats` 的 `candidates` 返回 `computers` / `radios` / `pairs`（均带 `lastSeen`）。
  `computers` 同时收录 `ComputerName` 与 `StationName`（去重、大小写不敏感），
  因为多数单机 N1MM 部署只发 `StationName`。
  取数同时覆盖 HTTP relay（`resolveSeat`）与直收 UDP（`saveRadio` / `parseContact` 补记）。
- 型号下拉按所选计算机标识过滤；不存在的组合只提示、不阻止保存。
- 已有配置即使暂不在候选集里也保留在下拉首项（标“当前配置”）；候选为空时下拉与说明
  都给出「尚未收到 N1MM UDP 报文」，并提供「重新获取」。
- `devices.seat` 列删除；否则会留下两套归属来源。

### 5.2 多席位共用设备怎么表达

不再给设备打席位标签，而是由**拓扑 + 当前选择**自然表达：

- 共用切换器：多台电台分别接矩阵/切换器的不同 `in`，共用设备没有 seat；某席位是否“拥有”
  某副天线，由该席位电台出发的 RF 可达集合决定。
- 共用旋转器/塔：机械上仍是单父树（天线挂在旋转器下），控制权由指令租约
  （`runtime.acquireLease`）仲裁，不使用设备 seat。
- 矩阵同时服务多席位：`selections` 记录每个 `in` 当前接到哪个 `out`，可达判定按选择走；
  互锁只锁当前 TX 源实际经过的端口。

### 5.3 OP 灯色与互锁的取舍

- 红灯 = 当前席位可达；黄灯 = 他席可达；绿灯 = 无人可达。
- 删除天线级 `exclusive`：原规则“独占通路不给黄灯”失效。取舍是：共用天线同时被两席
  可达时如实显示黄灯，而不是靠一个人工布尔值掩盖共享事实；如果确实需要“本席专用”，
  应通过拓扑（独立天线/独立切换器输出）表达。
- 发射互锁不变：仍从 TX 源绑定的设备出发，沿 RF 图（含切换器/矩阵当前选择）反查端口，
  与席位无关。席位只影响归属展示，不影响锁范围。

## 6. 控制寻址模型

所有设备控制走网络，分两条路径：

1. **直接寻址**：设备自带网口（旋转器、网络继电器/矩阵、带网口的功放/驻波表、串口服务器）。
   属性里直接写 `config.host` + `config.port`（继电器类用 `config.relay_url`）。
2. **串口服务器转发**：RS-232/485 设备（旋转器、塔继电器、矩阵、功放、驻波表等）
   自己只有串口。它先与控制口 `serialN` 的串口服务器画一条控制连线，
   实际访问目标 = 服务器 `host` + 服务器 `port` + 连线上的串口号 `N`，
   串口参数（波特率/数据位/停止位/校验）取自串口服务器属性。

解析结果由服务端统一产出在快照的 `control_addresses`：

```json
{
  "rotator-1": {
    "mode": "serial",
    "host": "192.168.1.50",
    "port": 4001,
    "serial_port": 2,
    "serial": {"baud": 9600, "data_bits": 8, "stop_bits": 1, "parity": "none"},
    "via": "serial-1"
  },
  "matrix-1": {"mode": "direct", "url": "http://relay.local/out"},
  "amp-1": {"mode": "unconfigured"}
}
```

约束：

- 控制连线只能连接“串口服务器的 `serialN`”与“另一台设备的控制口”，
  两端都是串口服务器、或两端都没有串口服务器时拒绝；
- 每个控制口最多一条控制连线，每个串口最多挂一台设备；
- 串口服务器没有射频口，`net` 口只表示它有网络出口，不参与连线；
- 控制连线独立存 `control_links`，不进入 `rf_links`，不影响 TX 可达、波段和互锁。

## 7. 草稿连线与批量保存

画布允许“先摆设备、先连线，最后一次保存”：

- 草稿设备用页面内临时 key（`draft-N`）标识，端口由服务端按同一套 `rf.js` 规则派生，
  所以草稿与已保存设备的卡片在端口形状、上下分布上完全一致；
- 只要有一端是草稿，连线就只存在于页面内存，拖动落下时调用 `preview` 复用落库前的
  校验（方形只连方形、圆形只连圆形、射频口一对一占用、每个串口只挂一台设备），
  拒绝时直接提示，不会静默连上；
- 删除草稿或删除设备时，挂在其两端的草稿连线一并移除，不留悬空线；
- `save-batch` 一次提交草稿设备、布局与两类草稿连线：服务端先按类型分配正式 id、
  重写连线端点，再整体校验，全部通过才以 `BEGIN IMMEDIATE … COMMIT` 写入，
  任一条不合法则整批拒绝，不会出现“设备进去了、连线丢了”；
- 保存成功后刷新页面，连线从 `rf_links` / `control_links` 读回，与草稿阶段一致。

## 8. 数据模型与迁移

1. 删除 `devices.seat` 列（SQLite `ALTER TABLE devices DROP COLUMN seat`）。
2. 端口 key 迁移（只改受影响的设备类型，避免误伤自定义端口）：
   - `radio` 的 `ant` → `out`；
   - `antenna` 的 `feed` → `in`；
   - `switch` 的 `common` → `in`。
   `rf_links` 的 `a_port` / `b_port` 两侧都要按设备类型更新。
3. `exclusive`、`password`、`port_label` 列保留与否：本期直接停止读写并在 `publicDevice`
   中移除；列删除放在同一次迁移里，避免“读一半写一半”。
4. `config.computer` / `config.model` 走现有 JSON config，无需加列。
5. 新增 `control_links` 表与 `control_links_pair` 唯一索引；不迁移旧数据（旧库没有控制连线）。

## 9. 条目与本文的对应

| # | 结论 |
|---|---|
| 1 | 删除设备页席位选择器与分区；画布全局唯一数据 |
| 2 | `seat` 只存在于电台节点，由计算机标识（StationName / ComputerName） + RadioName 派生 |
| 3 | 草稿可多个并存，保存是显式动作 |
| 4 | 单设备删除（含 RF 连线），父节点仍有子节点时拒绝 |
| 5 | 电台表单只剩名称 / 计算机标识 / 型号 / 备注 |
| 6 | 电台端口只保留 `out` |
| 7 | 驻波表 `in`/`out` 各一，上报地址进属性 |
| 8 | 驻波表表单按白名单收敛 |
| 9 | BPF 只保留 `in`/`out` 与通过波段 |
| 10 | 天线只保留 `in`，删 `feed` |
| 11 | 塔无 RF 端口，表单去掉波段/偏移/端口/独占 |
| 12 | 旋转器无 RF 端口，表单同上 |
| 13 | 切换器 `in`（COMMON）+ `ant1…N`，全部方形且可连 |
| 14 | 矩阵 `in1…N` / `out1…M`，全部方形且可连 |
| 15 | 合路器 `in:<band>` / `out`，全部方形且可连 |
| 16 | 方形=射频、圆形=控制/状态；方形只连方形，圆形只连圆形，RF 图不读控制线 |
| 17 | 画布框选多选 + Delete 删除 |
| 18 | 波段一律复选框多选 |
| 19 | 控制设备必须有网络寻址：直连 `host/port`，或经串口服务器 `serialN` 继承地址 |
| 20 | 调色板新增串口服务器 `serial`：无射频口，`net` + `serial1…N` 圆形控制口 |
| 21 | 草稿之间、草稿与已保存设备之间可直接连线；连线随「保存全部」整批原子落库 |

## 10. 功放接入：ACOM 串口二进制（500S / 600S / 700S / 1200S / 2020S）

本节记录 `lib/devices/amp-models.js` 与 `lib/devices/amp-link.js` 中 ACOM 路径的依据。
实现以 `github.com/bjornekelund/ACOM-Controller` 的真实代码为准，与官方协议 v1.1
不一致的地方单独列出，避免以后照着文档改坏已验证的行为。

### 10.1 型号与差异

五个型号共用同一套帧结构与解析，差异只有两项：铭牌功率（用于界面标尺）与温度换算偏移。

| 型号 | 温度偏移 | 仓库是否显示温度数字 | 状态项 / 动作 |
|---|---|---|---|
| 500S | 282 | 否（只显示温度条） | 相同 |
| 600S | 273 | 是 | 相同 |
| 700S | 282 | 是 | 相同 |
| 1200S | 281 | 是 | 相同 |
| 2020S | 282 | 否（只显示温度条） | 相同 |

本实现按统一方式显示温度数值（偏移按型号取值），不复制“某些型号不显示数字”的界面差异；
偏移值放在型号描述表的 `parser.temperature_offset`，不散落在解析代码里。

### 10.2 传输与寻址

- 串口参数：9600、8 数据位、1 停止位、无校验、无握手，DTR/RTS 保持低电平。
- 地址：设备属性直接填 `host` / `port`；RS-232 型号也可以与控制口 `serialN` 的
  串口服务器画控制连线，地址由 `control.resolveFor` 继承（见 §6）。
- 传输实现在 `amp-link.js` 的串口二进制分支，`transport = 'acom-binary'`。

### 10.3 遥测帧

- 固定 72 字节，首字节 `0x55`、第二字节 `0x2F`；所有字节按模 256 相加必须为 0。
- 解析按字节偏移读取：

| 偏移 | 含义 | 换算 |
|---|---|---|
| byte3 高半字节 | 状态 | 1 RESET / 2 INIT / 3 DEBUG / 4 SERVICE / 5 STANDBY / 6 RECEIVE / 7 TRANSMIT / 9 SYSTEM / 10 OFF |
| byte8、byte9 | 直流功率 | `b8*0.1 + b9*25.6`（W） |
| byte16、byte17 | 温度原值 | `b16 + b17*256 - 型号偏移`（°C） |
| byte20、byte21 | 推动功率 | `(b20 + b21*256) / 10`（W） |
| byte22、byte23 | 正向功率 | `b22 + b23*256`（W） |
| byte24、byte25 | 反射功率 | `b24 + b25*256`（W） |
| byte26、byte27 | SWR | `(b26 + b27*256) / 100` |
| byte66 | 错误码 | `0xFF` 表示无错误 |
| byte69 高半字节 | 风扇档位 | 0–4 |
| byte69 低半字节 | 波段索引 | 0 未知 / 1 160m / 2 80m / 3 40-60m / 4 30m / 5 20m / 6 17m / 7 15m / 8 12m / 9 10m / 10 6m / 11 4m |

### 10.4 遥测启停与超时

- Start Telemetry：`55 92 04 15`；Stop Telemetry：`55 91 04 16`。
- 连接成功立即发 Start；此后每 2 秒没有收到遥测就重发一次 Start（仓库行为）。
- 超过 6 秒没有任何有效帧，标记 `transport-timeout`（状态置为离线），保留 socket 继续重试。
- 断开链路前发 Stop Telemetry，避免设备继续推送。

### 10.5 与官方协议 v1.1 的差异（重要）

- **不实现 0x86 ACK。** 官方 v1.1 要求对设备消息回 ACK；仓库的实现完全没有这条分支，
  只靠“固定 72 字节 + `0x55 0x2F` 起始 + 和校验为零”识别遥测帧。本实现照仓库走，
  不发送 ACK、也不假设动作一定成功，状态完全靠下一帧遥测回读。
- 保留上述差异的原因：ACK 涉及帧序号/应答时序，凭文档补一条未经真机验证的分支，
  风险高于收益。将来真机出现帧错位、丢帧或动作不生效时，再回来补 ACK。

### 10.6 动作与边界

- 只开放三个动作，字节与仓库一致：
  - Operate：`55 81 08 02 00 06 00 1A`
  - Standby：`55 81 08 02 00 05 00 1B`
  - Off：`55 81 08 02 00 0A 00 16`
- 仓库没有串口开机命令，因此不提供 `power_on`；也不提供清故障动作。
- 校准、偏置、保护阈值、工程参数一律不实现，动作只经 `commands.js` 白名单下发。

## 11. 功放接入：Elecraft KPA1500（只读）

### 11.1 依据

- 官方文档：Elecraft《KPA1500 Programming Reference》rev 1.47（`E740328`），
  路径 `ftp.elecraft.com/KPA1500/Manuals Downloads/archive/`。
- 社区实现：wo2x Node-RED flow 通过 TCP 轮询同一组 ASCII 命令；本实现以官方命令格式为准。

### 11.2 连接方式

- USB “Host PC” 虚拟串口：4800 / 9600 / 19200 / 38400 / 57600 / 115200 / 230400，
  8 数据位、1 停止位、无校验、无流控；命令之间要等响应，不能连续灌命令。
- 原生 TCP：默认端口 1500，可用 `^CP` 改；命令集与串口完全相同。
- 在本系统中地址仍统一走 `control.resolveFor`：可直连 `host` / `port`，也可经串口服务器
  `serialN` 继承地址（此时端口字段不参与）。

### 11.3 可读项（本轮轮询）

| 命令 | 含义 | 解析 |
|---|---|---|
| `^OS;` | Operate / Standby | `^OSx;`，1 = Operate，0 = Standby |
| `^BN;` | 当前波段 | `^BNbb;`，K3 波段号 00=160m … 10=6m |
| `^WS;` | 正向功率与 SWR | `^WSwwww swr;`，wwww 为瓦，swr 以十分之一为单位 |
| `^TM;` | 散热器温度 | `^TMxxx;`，摄氏度 |
| `^VI;` | PA 电压与电流 | `^VIvvv iii;`，电压十分之一伏，电流**整安**（与 KPA500 不同） |
| `^FS;` | 风扇档位 | `^FSn;`，0–5 |
| `^FL;` | 当前故障码 | `^FLhh;`，两位十六进制，00 无故障 |
| `^RVM;` | 固件版本 | `^RVMnn.nn;` |

`^VI` 的电流单位在 KPA500 与 KPA1500 之间不一致：KPA500 是十分之一安，KPA1500 是整安。
解析器按型号描述表的 `parser.current_divisor` 处理，不靠猜。

### 11.4 可控项与明确拿不到的东西

- 本轮**只读**：动作表为空，`amp_set` 会被 `commands.js` 直接拒绝。等真机状态稳定后再开
  开关机、Operate/Standby、清故障。
- 明确不实现：ATU 调谐/存储、波段切换、天线选择、功率校准、保护阈值、`^PJ`/`^AL`/`^STA`
  等工程参数。
- 未解析：`^ON` 的电源主开关状态（官方只写了 GET/SET 形式，响应格式未明确），因此卡片上
  不显示“电源开/关”，只用 `^OS` 的 Operate/Standby 表达工作模式。

## 12. 功放接入：SPE Expert 1.3K-FA / 1.5K-FA / 2K-FA（只读）

### 12.1 依据

- 官方文档：SPE《Application Programmer's Guide》Rev. 1.1（2015-10-15），覆盖
  Expert 1.3K-FA、1.5K-FA、2K-FA；下载地址 `spetlc.com/images/download/SPE_Application_Programmers_Guide.pdf`。
- 交叉验证：公开 Python 实现 `github.com/albertM-hub/SPE-monitor`（最后更新 2026-05-22，
  仓库未声明许可证）。本实现只按官方文档的帧格式与字段表编写，未复制该仓库代码。

### 12.2 连接方式

- USB 或 RS-232，异步串口：8 数据位、1 停止位、无校验；最高 115200，功放会自动适配更低速率。
- USB 与 RS-232 两个口不能同时使用；同一时间只能有一个客户端（KTerm 要关闭）。
- 本系统中地址仍走 `control.resolveFor`：可直接填 `host` / `port`，也可经串口服务器
  `serialN` 继承地址。

### 12.3 帧格式

- 主机 → 功放：`55 55 55 | CNT | DATA... | CHK`；单字节命令时 `CNT=1`、`CHK` 等于命令本身。
- 功放 → 主机：`AA AA AA | CNT | DATA... | CHK0 CHK1 | CR LF`；
  `CHK` 为数据字节和，`CHK0` 取低 8 位、`CHK1` 取高 8 位。
- 状态查询命令 `0x90`，响应固定 67 字节 ASCII CSV、19 个字段。

### 12.4 19 字段与可读项

| # | 字段 | 说明 |
|---|---|---|
| 0 | ID | 2K-FA 为 `20K`，1.3K-FA 为 `13K`；官方表未列 1.5K 的 ID，故本实现不校验 ID |
| 1 | S / O | Standby / Operate |
| 2 | R / T | RX / TX |
| 3 | A / B | 记忆库（2K 固定 `x`） |
| 4 | 1 / 2 | 输入端口 |
| 5 | 00–11 | 波段，00=160m … 10=6m、11=4m |
| 6 | TX 天线 + ATU | 第二个字符 t/b/a 表示可调/旁路/启用 |
| 7 | RX 天线 | 未单独设置时读 `0r` |
| 8 | L / M / H | 功率档 |
| 9 | 0000 | 输出功率（W），RX 为 0 |
| 10 | 0.00 | ATU 前 SWR |
| 11 | 0.00 | 天线 SWR |
| 12 | 0.0 | PA 电压（V） |
| 13 | 0.0 | PA 电流（A） |
| 14 | 000 | 上层散热器温度（°C） |
| 15 | 000 | 下层散热器温度，1.3K/1.5K 固定 000 |
| 16 | 000 | 合成器温度，1.3K/1.5K 固定 000 |
| 17 | N | 告警（WARNING），N 表示无 |
| 18 | N | 报警（ALARM），N 表示无 |

本实现上卡的项：工作模式、TX 状态、波段、输出功率、天线 SWR、ATU 前 SWR、PA 电压/电流、
上层温度；2K-FA 额外显示下层与合成器温度。告警/报警合并为“故障”标记，原始字母保存在
`fault_code`。

### 12.5 可控项与明确拿不到的东西

- 本轮**只读**：动作表为空，`amp_set` 会被 `commands.js` 直接拒绝。协议本身有
  OPERATE `0x0D`、OFF `0x0A`、TUNE `0x09`、波段/天线/功率档等按键码，但先不开，
  等状态串在真机稳定后再评估。
- 明确不实现：调谐/天线预设、功率校准、保护阈值、固件升级、工程参数。
- 状态串里还有记忆库、输入端口、TX/RX 天线、功率档，本轮未上卡；固件版本不在状态串中，
  因此无法从该协议读取。

## 13. 功放接入：RF-Kit RF2K-S / RF2K+（只读身份）

### 13.1 依据

- 官方手册：RF-KIT《Power Amplifier RF2K-S》用户手册（LAN / Wi-Fi、VNC 5900、CAT/UDP
  接口），**没有公开 HTTP API 章节**。
- 身份字段来源：公开项目 `github.com/tnxqso/rf2k-trainer` 的 `rf2ks_client.py`
  （最后更新 2025-08-20，仓库已归档、未声明许可证）。它读取
  `GET http://<host>:8080/info`，字段为 `device`、`custom_device_name`、
  `software_version.GUI`、`software_version.controller`。

### 13.2 连接与可读项

- 原生 HTTP，默认端口 8080；请求头 `Accept: application/json`。
- 本系统中地址仍走 `control.resolveFor`：可直连 `host` / `port`，也可继承控制连线地址。
- 只上卡三项：设备名称（`custom_device_name`，缺省退回 `device`）、设备型号（`device`）、
  固件版本（GUI / controller 合并显示）。

### 13.3 明确拿不到的东西

- 官方手册没有功率、驻波、温度、电压、波段、故障的 HTTP 读取说明，本实现一律不猜。
- 同一公开项目还调用了 `/power`（`forward.max_value`、`swr.max_value`）、`/operate-mode`、
  `/data`、`/tuner`，但这些端点不在官方手册中，且该项目已归档、无许可证，因此本轮
  不据此实现功率/驻波，避免把单个逆向项目当成稳定协议。
- 无任何控制动作；`amp_set` 会被 `commands.js` 直接拒绝。

## 14. 功放接入：OM Power 2501A / 3501A / 4001A（rev.4 TCP）

### 14.1 来源与许可

- 实现依据：`github.com/grmi64/OM-Power-Control`，MIT 许可。本系统移植的是它的
  `decoder.py`（帧/token 解析）、`session_protocol.py`（TCP 会话）与 `controls.py`
  （单条未确认命令、不重试）三部分行为。
- 适用型号与固件：仓库明确只覆盖 OM2501A / OM3501A / OM4001A，协议标为 rev.4，
  固件 ≥ 3.16；这三型写入型号表并 `supported: true`。
- 取舍原则：OM Power 没有公开的官方协议手册，因此本轮以该 MIT 实现为唯一依据；
  与其他品牌一样，将来若拿到官方文档，以官方文档为准，并在本节更新差异。
- 不移植的内容：仓库里用于“只读测试 / 单次调谐测试 / 电源循环测试”的 socket 包装类
  属于测试策略，不是设备协议；`*`（退出自动调谐）与 `8`（停止自动调谐）本轮不开放，
  避免开放未验证的现场操作。

### 14.2 连接方式

- 传输：原生 TCP（Lantronix XPort），默认端口 **10001**，无 TLS、无登录。
- 本系统中地址仍走 `control.resolveFor`：可直连 `host` / `port`，也可经串口服务器
  控制连线继承地址（`transport = 'om-tcp'`）。
- 会话：TCP 连上后等 **0.6 秒**再发 `C`；设备回 `CON` 表示进入远程会话，回 `COFF`
  表示清除了已有会话，再补发一次 `C`。`C` 只切换远程会话，不改变功放电源状态。
- 轮询：`#`（测量）每 1 秒、`?`（状态）每 2 秒、`F`（频率）每 5 秒；有命令待确认时
  暂停 `?` / `F`，只保留 `#`。10 秒没有任何数据判 `transport-timeout`。

### 14.3 帧格式

测量帧固定 10 字节，二进制：

```
0x3D | b0 | b1 | b2 | b3 | b4 | b5 | b6 | b7 | 0x3B
```

| 字节 | 含义 | 换算 |
|---|---|---|
| b0、b1 | 正向功率 | 小端 uint16，W |
| b2 | 反射功率 | `b2 × 2`，W |
| b3 | 输入功率 | 直接读，W |
| b4 | 帘栅流（仓库 `screen_ma`） | 有符号 8 位，mA |
| b5–b7 | 仓库未使用 | 不解释、不猜字段 |

SWR 不单独下发，按仓库公式计算：
`r = √(reflected / forward)`（仅 `forward > reflected > 0`），`SWR = (1 + r) / (1 - r)`。
流式解析时先找 `0x3D`，第 10 字节必须是 `0x3B`；不匹配就丢 1 字节重新同步，
避免假起始字节卡死；token 以 `;` 结尾，NUL 视为空闲填充丢弃。

ASCII token（`;` 结尾）：

| token | 含义 |
|---|---|
| `STxxxx-name` | 天线名与工作状态；后三位 `100` = Standby、`110` = Operate，`1000` / `2000` = Off |
| `OPERATE` / `STBY` / `PAON` / `PAOFF` | 模式与电源状态 |
| `COON`、`WA<秒>` / `CO<秒>` | 冷却、预热/冷却倒计时 |
| `PTTON` / `PTTOFF` | 发射开始/结束（PTTOFF 时清零功率与 SWR） |
| `FR<kHz>` | 当前频率 |
| `IP<mA>` | 板流，`× 0.001` 得 A |
| `UP` / `US` / `UGA` / `UGB` / `UHA` / `UHB` / `UM` | 板压、帘栅压、栅压 A/B、灯丝 A/B、市电电压，直接读 V |
| `TE<half-°C>` | 温度，`× 0.5` 得 °C |
| `AUTO`、`AUTO:*`、`AUTOESC` | 自动调谐阶段 |
| `CON` / `COFF` | 远程会话状态 |

### 14.4 可读项（上卡）

正向功率、反射功率、SWR、输入功率、板流、帘栅流、板压、帘栅压、栅压 A/B、灯丝 A/B、
市电电压、温度、频率、天线名、工作状态（含预热/冷却）、发射标志。

### 14.5 可控项

只开放仓库真实存在的五个动作，且都必须出现在型号描述表的 `controls` 中：

| 动作 | 线上字节 | 前置条件 |
|---|---|---|
| 开机 `power_on` | `Y` | 当前不是 On/Operate/Standby；等待 `PAON` 或 `WA<秒>` |
| 关机 `power_off` | `Z` | 当前不是 Off；等待 `PAOFF` / `COON` / `CO<秒>` |
| Operate | `O` | 当前必须是 Standby；等待 `OPERATE` |
| Standby | `O` | 当前必须是 Operate；等待 `STBY` |
| 自动调谐 `autotune` | `L` 然后 `&` | 当前必须是 Operate 且不在调谐流程中；收到 `AUTO` 后补发 `&` |

共同约束（来自仓库 `controls.py`）：

- 单条未确认命令；5 秒没有确认就置为“结果不确定”，**不重发**，等新的测量帧到来后
  才允许下一条。
- 命令之间最小间隔 2 秒；发射中、预热/冷却倒计时、自动调谐流程中都拒绝其他动作。
- 命令必须建立在 3 秒内的新鲜读数上；超过 3 秒没有数据返回 `transport-timeout`。
- 与仓库的唯一差异：本实现不开放 `*` 退出自动调谐，因此 `AUTO:AUTOTUNE ABORTED`
  被视为流程结束，允许后续操作，避免把设备永久卡在“调谐中”。

### 14.6 明确拿不到的东西

- 仓库没有波段读取/波段切换命令，本系统不提供波段项与波段动作。
- 没有故障码、故障复位命令；不显示故障、不提供 `clear_fault`。
- 没有校准、偏置、阈值、工程参数的读写；这些类别一律不实现、不读取、不下发。
- b5–b7 及 `LO` / `TU` / `OT` 原始位置值仓库未换算成工程单位，本系统不展示。
- 不实现仓库的只读/调谐/电源循环测试包装，也不实现 `*` / `8`。

### 14.7 未覆盖的 2500A

- rev.4 依据的仓库只覆盖 2501A / 3501A / 4001A（固件 ≥3.16），没有 2500A 的抓包、
  命令表或分支。
- 2500A 机背只有 REMOTE 模拟口与 TCVR CAT 输入；公开资料（S53ZO flow）只证明它能
  跟随 Kenwood 频率，`Adminotech/remoteom` 也只提供单字节开关机/模式/故障。
- 因此 2500A 不进入型号表，也不进入 `om-tcp` 轮询；等拿到真机抓包确认后再评估。

## 15. 旋转器接入：型号表、rotctld 与 GS-232

### 15.1 调研来源与范围

- 论坛：`groups.io/g/nodered-hamradio`。该组设置为“Archive is visible to anyone”，
  公开帖子可直接阅读；Wiki 与 Files 仅成员可见，本次未登录、未订阅，因此**没有读过
  任何 flow 文件内容**，只依据帖子正文与公开手册。
- 官方/项目文档：
  - Hamlib `rotctl` 手册（rotctld 默认 4533，命令 `p` / `P az el` / `S`）；
  - Yaesu GS-232A/B 手册与 K3NG 的 GS-232 模拟命令表（`C2`、`Mxxx`、`S`）；
  - Green Heron RT-21 手册（RS-232 4800 8N1，DCU-1 超集）；
  - Node-RED 论坛中 rotctld、Yaesu、K3NG、RT-21、PST Rotator 的实践帖。
- 取舍原则：能拿到官方文档的协议才实现。GS-232 与 rotctld 有公开命令表；
  RT-21 的 DCU-1 细节、AlfaSpid 私有文本、Yaesu 二进制没有可核对的完整命令表，
  本轮不实现，统一走 rotctld 代理。

### 15.2 社区在控什么

| 设备/控制器 | 社区常见做法 | 是否适合本系统 |
|---|---|---|
| Yaesu G-800DXA / G-1000DXA / G-2800DXA / G-450A / G-650A | GS-232A/B 文本，串口或串口服务器；DJ2VA 等 flow | 适合，GS-232 直连 + rotctld 都支持 |
| K3NG Arduino | 模拟 GS-232，常经 ser2net 转 TCP（如 30001） | 适合，按 GS-232 处理 |
| Green Heron RT-21 | USB/RS-232 4800 8N1，DCU-1 超集；多数经串口或 PST | 走 rotctld；不实现 DCU-1 |
| M2 Orion 2800 | 多由 RT-21 或 rotctld 代管 | 走 rotctld |
| Prosistel D / PRO | 论坛明确用 rotctld 4533 | 走 rotctld |
| AlfaSpid RAK / RAS | 直连 Node-RED 的成熟案例很少 | 走 rotctld |
| Hy-Gain HAM IV / T2X | 依赖外部控制器 | 走 rotctld |
| ERC-4 | USB 串口控制器，社区有 ERC flow | 走 rotctld |
| PST Rotator | Windows 程序，UDP 12000/12001/12005 | 不适合：依赖 Windows 与商业软件 |

其他结论：

- rotctld/Hamlib 是社区最可持续的抽象层，换旋转器通常不用改 Node-RED 流程；
  有帖子专门讨论“转向反向前先停止”，并把命令闸门放在运动期间。
- 论坛没有找到成熟的“Yaesu 二进制”Node-RED 用法，实际使用的都是 GS-232 文本；
  本系统不凭猜测实现二进制。
- Node-RED 侧普遍是串口/TCP 节点 + 定时轮询（GS-232 用 `C2` 约 1 秒一次），
  Dashboard/SVG 地图显示；限位与刹车多由控制器自身完成，软件侧做目标校验和超时。

### 15.3 型号表与协议

实现文件：`lib/devices/rotator-models.js`。新增型号只加一条定义，传输层不按品牌写分支。

| 品牌 | 型号 | 默认协议 | 可选协议 |
|---|---|---|---|
| Yaesu | G-800DXA / G-1000DXA / G-2800DXA / G-450A / G-650A | GS-232 | GS-232、rotctld |
| K3NG | Arduino（GS-232 模拟） | GS-232 | GS-232、rotctld |
| Green Heron | RT-21 | rotctld | rotctld |
| M2 | Orion 2800 | rotctld | rotctld |
| Prosistel | D / PRO | rotctld | rotctld |
| AlfaSpid | RAK / RAS | rotctld | rotctld |
| Hy-Gain | HAM IV / T2X | rotctld | rotctld |
| ERC | ERC-4 | rotctld | rotctld |

未选品牌/型号时保持通用定义：默认 rotctld，也可显式选 GS-232。地址继续走
`control.resolveFor`：直连填 host/port，或经串口服务器 `serialN` 继承地址与串口参数。

### 15.4 协议细节

rotctld（默认 4533，文本行）：

```
P <az> <el>\n   设定目标
p\n             回读 "az el"
S\n             停止
```

GS-232（TCP 串口服务器或直连；端口必须显式填写）：

```
C2;             回读方位/仰角
Mxxx;           转向到方位 xxx（三位，360 归 000）
S;              停止
```

- 回读兼容 `+0aaa+0eee`（GS-232A）、`AZ=aaa EL=eee`（GS-232B）与 `aaa eee` 三种格式。
- GS-232 回复不一定带换行：收到换行立即结束，否则以 120ms 静默作为一帧结束；
  单条命令超时 2 秒，不重试。
- 串口参数（常见 4800/9600、8N1）由串口服务器或控制器决定，本系统不下发、不修改。

### 15.5 动作与保护

- 只开放转向 `rotate` 与停止 `stop`，且必须出现在型号定义的 `controls` 中。
- 目标方位校验：0–359.999，越界拒绝；360 归 0；GS-232 下发取整到整度。
- 超时保护：沿用设备属性 `travel_timeout_sec`（默认 120 秒）判断“运动中/已到位”；
  到位后不再显示运动，超时未到位则回到未知，不伪造位置。
- 明确不做：限位标定、刹车/速度设置、控制器内部参数、任何校准类写入。

### 15.6 明确拿不到的东西

- RT-21 的 DCU-1 私有命令细节、AlfaSpid 私有文本、Yaesu 二进制：没有可核对的完整
  命令表，本轮不实现。
- 控制器内部软限位、刹车状态、转速档位：GS-232/rotctld 通用命令不暴露，不读取。
- PST Rotator 的 UDP 接口依赖 Windows 程序，不作为服务端方案。

