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
| `amp` | `bands`（工作波段多选）、型号驱动字段：`config.brand`、`config.model`、`config.host`、`config.port`、`config.protocol`、`config.device_id`、`config.topic_prefix`、`config.username`、`config.password` | 类型、安装偏移、端口、口令、运行超时、独占通路 |
| `antenna` | `bands`（多选）、`install_offset_deg` | 端口、口令、运行超时、独占通路 |
| `combiner` | `bands`（多选，决定 `in` 口） | 安装偏移、端口、口令、独占通路 |
| `switch` | `config.brand`、`config.model`、`config.protocol`、`config.host`、`config.port`、`config.status_port`、`config.switch_id`、`config.radio`、`config.antenna_bands`（手工兜底映射）、`config.key_map`、`config.topic_prefix`、`config.username`、`config.password`、`config.relay_url`、`config.relay_token`、`config.channels`、`config.pulse_ms`、`config.out_count` | 波段、安装偏移、独占通路 |
| `matrix` | 同 `switch`，外加 `config.in_count` | 波段、安装偏移、独占通路 |
| `tower` | 继电器配置、`config.up_channel`、`config.down_channel`、`config.pulse_ms`、`travel_timeout_sec` | 波段、安装偏移、端口、独占通路 |
| `rotator` | `config.brand`、`config.model`、`config.host`、`config.port`、`config.protocol`（rotctld / gs232）、`travel_timeout_sec` | 波段、安装偏移、端口、独占通路 |
| `serial` | `config.host`、`config.port`、`config.port_count`、`config.baud`、`config.data_bits`、`config.stop_bits`、`config.parity` | 波段、安装偏移、运行超时、独占通路 |

型号表（`switch-models.js` / `amp-models.js` / `rotator-models.js`）负责给出每个型号的默认值、可编辑字段与能力；
白名单只决定「允不允许存」，不再为所有型号写死同一组字段。矩阵与切换器的 `in_count` / `out_count` 只在字段缺失时填默认，
已存的自定义路数不会被保存动作覆盖。


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

## 14. 功放接入：OM Power（官方 RCM PA+ HF v3.41 取证）

### 14.1 取证对象与技术栈

- 素材：官方安装包 `HF_PA_Manager_v3.41-setup.exe` 与安装目录 `C:\Program Files (x86)\OMPower\RCM PA+ HF`。
- 程序：`AmpMan.exe`（约 1.15 MB），PE32 .NET 程序集（元数据签名 `BSJB`），引用
  `Microsoft.VisualBasic.CompilerServices`、`My.MyProject/MyForms`、`System.Windows.Forms`，
  判定为 **VB.NET / .NET Framework 4 Client Profile WinForms**；没有混淆器特征，类型与方法名可读。
- 工具：7-Zip 查看安装包、Mono.Cecil 0.11.5 在 PowerShell 5 中读取程序集并导出 IL、
  字符串扫描（ASCII + UTF-16LE）。本机没有 `dotnet` / ILSpy / ildasm，因此结论来自 IL 与
  字符串，而不是 C# 反编译源码。
- 取证范围：只做静态分析。安装目录里的 `ampman.ini` 指向 `192.168.1.211:10001`，
  本次环境不可达，未做真机抓包；所有帧样例均按解析器构造，已逐条标注。
- 取证边界：不记录管理口令、校准、偏置、保护阈值、工程参数的写入路径与数值。

### 14.2 连接方式

- **只有网络，没有 PA 串口模式**：`ApdWs` 是 `TcpClient`，默认端口 **10001**，无 TLS、无登录。
- Lantronix XPort 的配置口是 **9999/telnet**；程序只通过它改波特率（**230400**）、TCP KeepAlive、
  ARP 缓存时间。XPort 串口侧的 8N1、无流控是设备默认值（**推断**，程序未显式设置）。
- 会话握手（`CheckStatus`）：
  1. 清空接收缓冲，检查是否有 `^\n\rPassword ? $`、`HVF;`、`HF;`；
  2. 发 `^`，等 `^OK;`；
  3. 发 `C`，等 `CON;`；失败会重发 `C`/`C `；
  4. 发 `?`，取一帧 `ST…;`；
  5. 发 `1`，取 `INFO…;` 识别型号与固件。
- XPort 若设置了连接口令，程序直接拒绝连接并提示移除口令；正常控制不需要口令。
- 若收到 `COFF;`（原有远程会话被清除），补发 `C` 重建会话。
- 断开：断线或连续 10 秒无数据即关闭 TCP；没有应用层重连退避。

### 14.3 帧格式

**这是纯 ASCII 文本协议**，不是二进制帧：

- 帧边界：以 `;`（0x3B）结尾，`;` 同时是分隔符。
- 没有起始符、长度、地址、序号、校验和、转义；字段用 `,` 分隔。
- 主机 → 功放：**单个 ASCII 字符**（频率输入例外：`=` + 5 位十进制 + `;`）。
- 功放 → 主机：以 `^` 开头的状态/测量 token，或 `ST` / `INFO` / `TCVR` / `CON` / `COFF` /
  `LAST 20 …` 等固定前缀 token；均以 `;` 结尾。
- 因为字段是变长十进制文本，**不存在固定字节偏移**；下表用字符位置描述唯一有固定布局的 `ST` 帧。

固定布局的 `ST` 状态帧：

```
S T A B C D E <name up to 51 chars> ;
0 1 2 3 4 5 6 ...
```

| 位置 | 字段 | 编码 |
|---|---|---|
| 0–1 | `ST` | 固定前缀 |
| 2 | 天线号 | 1 位十六进制字符（`0`–`9`、`A`–`F`），程序按 16 进制转整数 |
| 3 | 电源状态 | 1 位十进制；`1` = PA ON |
| 4 | 模式 | 1 位十进制；`1` = OPERATE，`0` = STANDBY |
| 5 | 发射 | 1 位十进制；`1` = PTT/TRANSMIT |
| 6 | 调谐标志 | `[01-]`；`1` = 手动调谐进行中，程序此时发 `&` 取 `LO`/`TU` |
| 7… | 天线名 | 最长 51 字符，可为空 |

帧样例（十六进制按 ASCII 编码构造，非真机抓包）：

| 文本帧 | 十六进制 |
|---|---|
| `^PO1500,PR20,PI12.5;` | `5E 50 4F 31 35 30 30 2C 50 52 32 30 2C 50 49 31 32 2E 35 3B` |
| `ST3110-ANT 3;` | `53 54 33 31 31 30 2D 41 4E 54 20 33 3B` |
| `^UP3200;` | `5E 55 50 33 32 30 30 3B` |

主机命令 `#`、`?`、`C` 分别是单字节 `23`、`3F`、`43`，不带结束符。

### 14.4 命令表

轮询与查询：

| 字符 | 用途 | 回包 | 节奏 |
|---|---|---|---|
| `^` | 链路/命令通道探测 | `^OK;` | 握手时 |
| `C` | 建立远程会话 | `CON;`（失败重试） | 握手时，`COFF;` 后重发 |
| `?` | 取一帧状态 | `ST…;` | 连接时一次；程序不周期轮询 |
| `#` | 批量遥测 | 多条 `^UP…;`、`^PO…;` 等 | **每 1 秒** |
| `I` | 快速功率 | `^PO…;` | 发射中且显示板流表时，最快 **每 250 ms** |
| `F` | 频率 | `FA…;` 或 `FR…;` | 每 **60 秒**，以及模式/调谐状态变化后 |
| `J` | 频率控制源 | `TCVR<n>;` / `TCVR:<text>;` | 连接时、切换频率源后 |
| `1` | 型号信息 | `INFO…;` | 连接时 |
| `H` / `G` | 最近 20 条故障 / 告警 | `LAST 20 FAULTS…;` / `LAST 20 WARNINGS…;` | 打开窗口时 |
| `$` | 读天线配置 | 名称/编号/波段范围列表 | 打开天线设置时 |
| `2` | 读辅助风扇模式 | `^BLOWER:<mode>;` | 打开风扇设置时 |
| `&` | 手动调谐下一步 | `^LO<n>;`、`^TU<n>;` | 调谐中每 5 秒或收到 `AUTO` 后 |
| `T` | 空闲链路保活 | 无专门回包（**推断**） | 每 1 秒，未发射时 |

操作类（均为单字符）：

| 字符 | 动作 |
|---|---|
| `Y` / `Z` | 开机 / 关机 |
| `O` | OPERATE ↔ STANDBY 切换 |
| `L` / `M` | 自动调谐 / 手动调谐模式 |
| `A` / `B` | 天线号 +1 / −1 |
| `X` / `W` | 波段 +1 / −1 |
| `V` / `U` | 波段内分段 +1 / −1 |
| `>` / `<` | 调谐电容 + / − |
| `+` / `-` | 负载电容 + / − |
| `S` | 保存手动调谐结果 |
| `7` / `9` / `8` / `*` | 恢复默认值 / 重试自动调谐 / 停止 / 退出手动调谐 |
| `=` + 5 位数字 + `;` | 手动输入频率（kHz） |
| `K` / `R` | 频率源切到手动 / COM CAT（回 `NOCAT;` / `RTCVR;`） |

**按取证边界不复述**：管理员口令相关写入（`N`/`P`/`Q`）、天线配置写入（`%`）、
辅助风扇模式写入（`3`/`4`/`5`），以及任何校准、偏置、保护阈值、工程参数命令。

### 14.5 状态解析

遥测 token：

| token | 字段 | 编码 / 单位 | 换算 |
|---|---|---|---|
| `^PO<n>,PR<n>,PI<n.n>;` | 正向、反射、输入功率 | 十进制，W；PI 带 1 位小数 | 直接使用 |
| `^UP<n>;` | 板压 | 十进制，V | 直接用 |
| `^UM<n>;` | 市电电压 | 十进制，V | 直接用 |
| `^US<n>;` | 帘栅压 | 十进制，V | 直接用 |
| `^IP<n>;` | 板流 | 十进制，mA | `/1000` 得 A |
| `^IS<[-]n>;` | 帘栅流 | 有符号十进制，mA | 直接用 |
| `^UH<n.n>;` / `^UHA<n.n>;` / `^UHB<n.n>;` | 灯丝电压（总/A/B） | 十进制，V，1 位小数 | 直接用 |
| `^UG<n>;` / `^UGA<n>;` / `^UGB<n>;` | 栅压（总/A/B） | 十进制绝对值，V | 程序显示为 `−n`；即负栅压 |
| `^IG<n>;` | 栅流 | 十进制，0.1 mA（推断） | 程序显示 `−n/10` |
| `^TE<n>;` / `TE[-]n;` | 温度 | 原始值 | `/2` 得传感器半度值，再按型号多项式换算；系数属校准数据，不复述 |
| `FR:<kHz>;` / `FR<kHz>;` | 当前频率 | kHz | `×1000` 得 Hz |
| `FA<8–12 位>;` | 当前频率 | Hz | `/1000` 得 kHz |
| `^AN<hex><name>;` | 天线号 + 名称 | 天线号 1–2 位十六进制 | 名称最长 51 字符 |
| `^BLOWER:<ALWAYS|PTT|TEMP>;` | 辅助风扇模式 | 枚举 | 只读回显 |

SWR 不单独下发，由正向/反射功率计算：

```
r = sqrt(PR / PO)            （仅 PO > PR > 0）
SWR = (1 + r) / (1 - r)
```

型号相关缩放：当型号字符串同时包含 `OM4001` 与 `OH` 时，正向功率 `PO` 在显示前 `/2`；
其余型号直接使用原始值。

状态与事件 token：

| token | 含义 |
|---|---|
| `^PAON;` / `^PAOFF;` | 电源开 / 关 |
| `^OPERATE;` / `^STBY;` | 模式 |
| `^PTTON;` / `^PTTOFF;` | 发射开始 / 结束 |
| `^WA<n>;` | 预热剩余秒数 |
| `^COON;` / `^CO<n>;` / `^CT<n>;` | 关机冷却开始 / 剩余秒数 / 按温度等待 |
| `^MAN;` / `^AUTO;` / `^AUTO:<text>;` / `^STOP;` / `^AGAIN;` | 调谐模式与阶段 |
| `^LO<n>;` / `^TU<n>;` / `^OT<n>;` | 手动调谐的负载、调谐、其他位置值 |
| `^WG<n>;` | 告警计数 |
| `^FA<1–15>;` | 当前故障号 |
| `^FERROR;` | 软启动错误 |
| `^HVF;` / `^HF;` | 高压故障 / 硬故障 |
| `^OK;` / `^BADPSW;` | 命令确认 / 权限不足 |
| `INFO:…;` | 序列号、电子管序列号、固件版本、累计分钟数、型号 |
| `TCVR<n>;` / `TCVR:<text>;` | 频率控制源 |
| `CON;` / `COFF;` | 远程会话建立 / 被清除 |

`INFO` 字段（按解析正则）：

```
INFO:<serial>,<tube1>,<tube2?>,<firmware>,<minutes>,<model?>;
```

- `serial`：整机序列号；
- `tube1` / 可选 `tube2`：电子管序列号（字母数字与空格）；
- `firmware`：`数字.数字` + 可选字母后缀；
- `minutes`：有符号整数，累计运行分钟；
- `model`：可选，大写字母/数字/空格，例如 `OM2501A`、`OM4001A FCC`、`OM4001C OH`。
  缺省时程序按固件版本推断型号。

### 14.6 与现有 `grmi64` 实现的对照

| 项 | 官方 v3.41 | 当前 `amp-om.js` | 判定 |
|---|---|---|---|
| 传输 | TCP 10001 | TCP 10001 | 一致 |
| 握手 | `^`→`^OK;`，`C`→`CON;`，失败重试 `C` | 等 0.6 s 发 `C`，`CON` 后轮询 | 缺 `^`/`^OK` 探测 |
| 测量 | 纯文本 `#` 批量 + `I` 快速 `^PO` | 解析 10 字节 `0x3D…0x3B` 二进制帧 | **官方无此二进制路径**；若真机返回该帧，属于官方 3.41 不兼容的旧固件/其他实现 |
| 状态 | `ST` + 天线号 + 电源/模式/发射/调谐 5 个字符 + 名称 | `ST(\\d{4})-(name)` | **不兼容**：会把 `ST3110-…` 误读成 4 位状态码 |
| 轮询 | `#` 1 Hz，`I` ≤4 Hz（发射时），`F` 60 s，`?` 仅连接时 | `#` 1 Hz，`?` 每 2 s，`F` 每 5 s | 节奏不同，`?` 过密；缺 `I` |
| 频率 | `FA`（Hz）/ `FR`（kHz） | 仅 `FR` | 缺 `FA` |
| 电压/电流 | `UP/UM/US/IP/IS/UH/UHA/UHB/UG/UGA/UGB/IG`，栅压为负 | 缺 `UG/UGA/UGB/IG`，`IS` 未取符号 | 不全 |
| 温度 | `TE/2` 后按型号多项式 | `TE × 0.5` | 缺多项式，读数会偏低/偏高 |
| 型号/故障/天线 | `1`、`H`、`G`、`$`、`2`、`J` | 未实现 | 能力缺口 |
| 控制 | `Y/Z/O/L/M/A/B/X/W/V/U/>/</+/-/S/7/9/8/*` | 仅 `Y/Z/O/L` | 能力缺口 |
| 校验 | 无校验、无长度、无地址 | 二进制帧有首尾字节 | 协议模型不同 |

与 ACOM、SPE 的风格对比：

- ACOM：`0x55` 起始、固定 72 字节、字节和校验为 0，二进制遥测。
- SPE：`0xAA 0xAA 0xAA` 同步 + 长度 + 双字节校验，二进制。
- OM Power：单字符命令 + `;` 结尾的可读 ASCII，无校验、无长度。
- 结论：**不同源**，不能复用 ACOM/SPE 的帧解析，也不存在“同一套二进制帧”的迹象。

### 14.7 型号表（官方全集）

型号表以官方 `AmpMan.exe` 的 `allPATypes` 为准，共 20 项，这就是完整集合：

`OM1700A+`、`OM2000A+`、`OM3001A`、`OM4001A`、`OM4001A FCC`、`OM4001A OH`、
`OM4001C`、`OM4001C FCC`、`OM2501A`、`OM2501A FCC`、`OM3501A`、`OM4001HF`、
`OM4001HF FCC`、`OM4001HF OH`、`OM2501HF`、`OM2501HF FCC`、`OM3501HF`、`OM3006+`、
`OM2000+`、`OM1700+`。

- 协议层没有按型号分支的帧格式；差异只在应用层：型号识别、固件版本门槛、界面能力，
  以及 `OM4001* OH` 的正向功率 `/2` 显示缩放。
- `ChangePATypeFromCheck` 只在 `INFO` 返回的型号属于上述全集时才切换型号；未知型号
  只写日志，不改变当前型号。
- 本仓库目前只把 `OM2501A`、`OM3501A`、`OM4001A` 放进型号下拉，这三型有官方 rev.4
  的完整证据链；其余型号按需再补，不凭社区传闻添加。

### 14.8 取证的边界

- 未记录管理员口令、校准、偏置、保护阈值、工程参数的写入路径与具体数值。
- 未实现上述写入；本节只描述只读遥测、常规操作和连接握手。
- 所有“推断”均已显式标注：XPort 8N1/无流控、`IG` 的 0.1 mA 单位、`T` 无专门回包。

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
- 换向前先停止：旋转器处于运动态时拒绝新的 `rotate`，必须先发 `stop`；
  `stop` 不受运动态限制，保证随时可停。
- 到位后延时放行：轮询/上报判定到位（角度差 ≤1°）时记录 `arrived_ms`，
  2 秒静默期内拒绝新方向；`stop` 之后同样有 2 秒静默期，给桅杆和刹车留稳定时间。
- 超时保护：沿用设备属性 `travel_timeout_sec`（默认 120 秒）判断“运动中/已到位”；
  到位后不再显示运动，超时未到位则回到未知，不伪造位置。
- 明确不做：限位标定、刹车/速度设置、控制器内部参数、任何校准类写入。

### 15.6 明确拿不到的东西

- RT-21 的 DCU-1 私有命令细节、AlfaSpid 私有文本、Yaesu 二进制：没有可核对的完整
  命令表，本轮不实现。
- 控制器内部软限位、刹车状态、转速档位：GS-232/rotctld 通用命令不暴露，不读取。
- PST Rotator 的 UDP 接口依赖 Windows 程序，不作为服务端方案。

## 16. 功放接入：Elecraft KPA500

### 16.1 依据与边界

依据 Elecraft *KPA500 Programmer's Reference*。与 KPA1500 共用 ASCII 传输层，但命令集和
`^VI` 电流单位不同（KPA500 为 0.1 A，KPA1500 为 1 A），实现里按型号分开。

只实现「状态回读 + 常规操作」，不实现 `^PJ` / `^AL` 等调整、阈值与校准命令。

### 16.2 命令表

| 动作 | 线命令 | 说明 |
|---|---|---|
| 开机 | `P` | BootLoader 单字符命令，**不带分号**；写成 `P;` 会被设备忽略 |
| 关机 | `^ON0;` | 电源状态命令 |
| 进入 OP | `^OS1;` | |
| 进入 STBY | `^OS0;` | |
| 清除故障 | `^FLC;` | |

轮询（全部只读）：`^OS;`、`^BN;`、`^WS;`、`^TM;`、`^VI;`、`^FL;`、`^RVM;`。

### 16.3 只读项与可控项

- 可读：OP/STBY（`^OS`）、电源状态（`^ON`）、波段（`^BN`）、正向功率与 SWR（`^WS`，
  SWR 为三位数、隐含小数点在第二位之后）、温度（`^TM`）、电压/电流（`^VI`）、
  故障灯（`^FL`）、ATU 回读（`^RVM`）。
- 可控：开机、关机、OP、STBY、清故障。
- 下发后**不乐观置位**：只写 `command_pending`，等 `^OS` / `^ON` 回读确认；
  读不到就保持原值并标记未确认，界面显示「命令已下发，等待回读」。

### 16.4 明确拿不到的东西

- 调整类参数（功率上限、ATU 调谐、保护阈值）没有公开的稳定命令，不写。
- 电源是否真的完成 BootLoader 启动，只能靠后续 `^ON1` 判断，不能靠命令返回。

## 17. 切换器 / 矩阵切换器接入

实现文件：`lib/devices/switch-models.js`（能力表）与 `lib/devices/switch-link.js`（协议与传输）。
每个型号必须声明 `protocol`、`transport`、`readback`、`control`、`verified`，未知型号不猜协议。

### 17.1 型号与能力

| 品牌 | 型号 | 传输 | 回读 | 可控 | 协议验证 |
|---|---|---|---|---|---|
| 4O3A | Antenna Genius 8×2 | `ag-tcp` 9007 | 是 | 是 | 是（双栈：v4 ASCII / 旧二进制） |
| 4O3A | Station Genius | `station-genius-tcp` 8001 | 否 | 是 | **否**（社区逆向帧，无厂商文档） |
| Hamation / ShackLan | ZSERVER 4×8 | `zserver-udp` 50333 命令 / 50334 状态 | 是 | 是 | 是 |
| Green Heron | Everyware 4×8 | `greenheron-tcp` 10000 | 是 | 是 | 是 |
| Amplitec | SW3000-6 | `amplitec-tcp` | 是 | 否 | **否**（只确认了读状态帧） |
| wa4mcm | 1×4 ASCII | `wa4mcm-tcp` 8008 | 是 | 是 | 是 |
| Array Solutions | RCS-4 | `rcs4-tcp` 8080 | 否 | 是 | **否**（4 字节帧无公开来源） |
| RemoteQTH | Six2Two 2×6 | `six2two-mqtt` 1883 | 否 | 是 | **否**（topic 约定来自项目文档） |
| Array Solutions | Stack Match | — | — | 否 | 不支持（型号表 `supported:false`） |

### 17.2 帧与语义

- **Antenna Genius**：v4 为 `C<seq>|port set <in> rxant=<out> txant=<out>\r`，另有 `band list`、
  `antenna list`、`port get`；旧固件为 `!LLLL!HHHHHH!payload`。连接后主动发 `band list` 探测，
  按回包判定协议；判定前 `select` 返回 `409 protocol-undetermined`；判成 legacy 后保留一次
  5 秒探活重判机会。
- **ZSERVER**：命令为 JSON `{name:"zserver", command:"set_antenna", id, radio, antenna}`；
  状态口接收广播 JSON，按 `switch_id` / `host` 匹配，端口可在型号字段 `status_port` 配置。
  绑定失败写入运行态并通过 `status_error` 返回，不再静默降级。
- **Green Heron**：`SET_SWITCH<id>Radio-<n>\x1FA<m>\r\n`；`SWITCHUPDATE Radio-n Antenna m`
  回读后转 `verified`。
- **wa4mcm**：`A<n>\r\n` 选择、`A?\r\n` 查询；回 `A<n>` 后转 `verified`。
- **Amplitec**：查询 `01 01 44 0D` / `01 01 52 0D`；状态帧按 `0x52 0x0D` 后的 mode/position
  解析（**推断，无帧结构文档**），二进制按 `Buffer` 累积，不经字符串中转。
- **RCS-4**：`[0xA0, port, state, checksum]`，校验和按 `(0xA0+port+state)&0xFF` 计算（**推断**）。
  1×4 切换时先对 1..out_count 全发 OFF，再发目标 ON，避免旧通路与目标通路同时闭合。
- **Six2Two**：topic `<prefix>/<in>_<out>`，发布 `1` 选通、`0` 断开；旧 topic 按
  `deviceId + 输入号` 分键，切换 in2 不会关掉 in1 的通路。
- **Station Genius**：64 字节帧，`0x89` 连接、`0x84` 保活、`0x80 + key` 选通；按键映射
  可由 `key_map` 覆盖，未配置时用默认 `7 8 9 / * - 0`。

### 17.3 状态语义

- `verified`：收到设备回读并写入 `ports`。
- `pending`：已下发、等待回读确认。
- `unverified`：只写型号，已连上且命令已下发，但状态无法验证；`online:true`，不复用「等待回读」。
- `unknown` / `stale`：通信中断或从未收到回读，保留最后一次已知值并标注原因。

### 17.4 端口映射

「切换器端口 → 可用波段」按三级优先级计算：设备回读（AG `0x412` / `0x082`）>
画布拓扑派生（沿 RF 连线找到该端口所接天线，取 `bands`，并联取并集）> `antenna_bands`
手工兜底。拓扑变化即时重算；手工值与拓扑冲突时明确提示是哪根天线、哪个端口，不静默覆盖。

### 17.5 无公开依据、按未验证处理的实现

- RCS-4 的 4 字节帧与校验和。
- Amplitec 状态帧的字段位置与语义。
- Station Genius 的 64 字节帧与按键码。
- Six2Two 的 MQTT topic 约定。
- Antenna Genius 旧二进制帧（来自调研 flow，未在厂商文档中核对）。

以上型号在型号表标 `verified:false`，界面显著提示；对外不呈现为「已支持并已验证」。

### 17.6 接入现状与取证台账

型号能力、代码入口、官方设备 A 档的服务端改造清单（G1–G10）、现阶段可接范围，统一记录在
`docs/third-party-device-onboarding-record.md`。本文只负责帧格式与取证结论，进度与改造项不在此重复维护。


