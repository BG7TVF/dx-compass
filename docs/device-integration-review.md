# DX-Compass 设备接入与集中控制 · 需求评审

- 评审对象：
  - 第一轮：`DX-Compass 设备接入与集中控制_1794421445555.md`（v1.0，3438 字节 / 共 75 行，正文止于第 74 行）
  - 第二轮：`DX-Compass 设备接入与集中控制_1794422860248.md`（v2.0，4481 字节 / 共 79 行，正文止于第 79 行）
  - 第三轮：`# DX-Compa....txt`（v2.1，35552 字节 / 1625 物理行 / 754 非空行，**完整版，自然结束**）
- 评审基线：DX-Compass v2.1.0；文档评审起点 `f078e9f`（2026-11-12），当前实现 HEAD 见下方「执行状态」
- 评审日期：2026-11-12（第二轮同日）
- 评审范围：第一轮只做文档与实现的对照；第二轮在此基础上落地“不部署公网”的部署边界约束（见 §14）
- 标注约定：**核实** = 已读源码确认；**待确认** = 文档未提供或需现场信息，不能作为结论。**本报告不再用“推断”充当结论。**
- 严重程度：**P0 阻断**（不解决无法实施，或存在现场安全风险）；**P1 高**（会导致返工或运行期错误）；**P2**（可后置的建议）

> **本文件的结构**：§1–§10 是**第一轮**对 v1.0 的评审；§11–§17 是**第二轮**对 v2.0 的评审；§18 是**第三轮**对完整版 v2.1 的评审；**§19 是第四轮，基于用户新给的设备树模型与部署边界口径，覆盖 §18 中 D2/D3、D4、D17 等结论；§20 是第五轮，补“一台旋转器挂多副天线、多席位可控制”的特殊情况；§21 是第六轮，曾按用户定调取消发射互锁；**§22 是第七轮最终口径：恢复“发射中禁止切换天线/矩阵 OUT”，旋转器仍不做任何发射判定；§23 是第八轮并按现场模拟电路改为三态（展开/收回/中间）；§24 是第九轮，O4/O6 已确认（安装偏移 + 最后指令生效；源中断即降级）；O7 已确认（脉冲启动 + 硬件自锁，非点动/非持续闭合）**。九轮冲突处，一律以 §22–§24 为准；被作废/关闭的旧结论集中在 §19.8、§21.4 与 §22.1–§22.3。
>
> **关键事实**：v1.0 与 v2.0 都只有 3–4.5 KB、在 79 行左右被截断；v2.1 已恢复完整（35.5 KB、1625 物理行 / 754 非空行），第 1625 行是 §17 的最后一条，**没有截断**。v2.1 补齐了协议、接口、数据模型、安全、验收与分期，第二轮标为“文档缺失”的多数条目已在 §18.3 改为「已覆盖」并注明章节。

---

## 执行状态（2026-11-15 更新）

评审阶段的“代码冻结”已结束；设备接入、画布编辑器与切换器/功放/旋转器链路均已进入实施与修复阶段。

| 项 | 状态 |
|---|---|
| 当前提交 | 本地 HEAD `88b35c3`（2026-11-15 15:49 +0800，`fix: 修正功放开机命令与切换器下发语义`） |
| 远端 | 本地 main 已推送 origin；远端不再停在 11-13 的 `c57558f` |
| 部署 | 生产先清理人工覆盖的 `public/index.html`、`public/js/pages/qso-page.mjs`，再正常 pull；审计项完成后已拉到 `856c6b3` 并重启，`systemctl is-active` = active、`http://127.0.0.1:5758/` = 200 |
| 本轮受版本控制修改 | `.gitignore`、`README.md`、`docs/rf-component-spec.md`、`lib/devices/commands.js`、`lib/devices/model.js`、`lib/devices/rotator-link.js`、`lib/devices/service.js`、`lib/devices/switch-link.js`、`lib/devices/switch-models.js`、`lib/settings/service.js`、`lib/spots/service.js`、`public/js/i18n.js`、`public/js/pages/devices-page.mjs`、`tests/architecture.test.js`、`tests/backend-settings.test.js`、`tests/backend-spots.test.js`、`tests/devices.test.js`、`tests/switch-link.test.js` |
| 本轮新增入库文档 | `docs/contesting-tactics-research.md`、`docs/device-canvas-editor-plan.md`、`docs/device-integration-implementation-plan.md`、`docs/device-integration-review.md`、`docs/dx-compass-m2-mm-gap-plan.md`、`docs/dx-compass-official-device-json-protocol.md`、`docs/hamalert-server-research.md`、`docs/m2-mm-collaboration-playbook.md`、`docs/m2-mm-rules-constraints.md`、`docs/supercheckpartial-research.md` |
| 测试状态 | 本轮起点 537 通过、0 失败；新增传输层、AG 双栈、旋转器串口继承、SPOT 回填等用例后，全量 `node --test` 为 548 通过、0 失败 |
| 已清理 | `.commit-msg.tmp`、空的 `lib/deployment/`；`artifacts/`、`.screenshots/` 已加入 `.gitignore` |
| 处置 | 文档与代码一并入库；不再保持“未提交、未部署” |

---

## 0. 结论摘要

> **本表是第一轮对 v1.0 的结论摘要，已被 §18–§24 覆盖；当前 P0 状态以 §24.3.1 为准。** 其中“无鉴权 P0”已按用户定调降级为部署提醒（§19.7），“发射热切换 P0”已按用户定调取消（§21），后经 §22 恢复为“仅天线切换 + 通用 TX 上报接口”。

| 判断 | 结论 |
|---|---|
| 文档完整性 | **不完整**。正文止于 `### 3.1 分层` 标题，没有 3.1 的正文，也没有第 4 节之后的任何内容（协议、接口、数据模型、安全、验收、实施计划全部缺失）。**P0，见 §1** |
| 能否据此排期 | **不能**。现有内容只有背景、9 条硬约束和 5 条定性目标；没有任何一条可测验收标准，也没有优先级和边界定义 |
| 与现有实现的真实差距 | 文档假设“不具备任何硬件控制能力”，实际仓库**已有完整的 OP 底部设备区 UI、前端驱动契约、地图点击方位预览和 3 个设置开关**（[op-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L931-L1066)、[peripherals.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/peripherals.mjs#L1-L68)）。缺的是**后端**：连接、驱动、状态、指令、锁、审计。因此这是“改造占位 + 补后端”，不是纯新建，文档低估了可复用面，也漏掉了已有约束 |
| 最大架构冲突 | 设备区一旦启用会**整体替换**席位卡与频率协调卡（[op-page.mjs L976-L979](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L971-L997)）；且设备配置是**全站全局**，没有席位归属。多席位（M2/MM）场景下与现有席位模型直接冲突 |
| 最大安全缺口 | 现有 Web 端**没有任何鉴权**（`settings.js` 无 `adminAuth` / `httpNodeAuth`，监听 `0.0.0.0:5758`，CORS `*`，[settings.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/settings.js#L6-L48)）。文档要求“权限”，但未定义身份模型。在此之上接塔/旋转器等于把物理控制面开放给整个网络，**P0** |
| 设备归属 | 文档完全没有定义。现有席位是**被动发现**的（`station:radioNr`，[seat.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/seat.js#L28-L42)），没有 seats 注册表，IP 回退不稳定，不能直接当设备绑定键，**P0 设计缺口** |
| 控制安全 | 冲突锁、超时、断线重连、状态回读、失败回滚、幂等、急停、审计：文档当时**一项都没有写**（截断所致），现有代码也只做到“点了就 return 一个布尔”。塔超程仍属现场安全项；**天线热切换的“发射互锁”最终恢复（仅天线切换，通用 TX 上报接口，§19.6/§22）**，旋转器不做 |
| 数据落点 | 文档未定义。若把设备配置塞进 `schema.js`，会受限于“只支持标量 / intMap / colorMap / enumArray”（[schema.js L9-L10](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L9-L10)、[L762-L809](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L762-L809)），且设置会被 WS 广播给所有客户端、大屏也能读到（[server.js L33-L40](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/bigscreen/server.js#L33-L40)），**设备口令会泄露**。建议设备配置独立落 SQLite |
| 实时性 | 现有链路可复用：`/ws` 已推送 `radio / score / frequencyClaims / qso / qsoDelete / settings / alert`（[main.mjs L46-L78](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/main.mjs#L46-L78)）。设备状态必须走 WS，不能沿用 OP 页 2s/10s/60s 的轮询重绘（[op-page.mjs L1356-L1378](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L1356-L1378)） |
| 建议 | 先把文档补到“可实现 + 可验收”再立项：补 §3–§9、安全模型、设备归属、存储方案、验收标准；实施顺序按“只读 → 旋转器 → 切换器 → 塔”的风险递增推进（§9） |

---

## 1. 文档完整性：这是第一个 P0

### 1.1 事实

- 文件实际大小 **3438 字节**，共 75 行；正文止于第 74 行的 `### 3.1 分层`，其后没有任何内容。
- 已包含：§1 背景/目标（C1–C9、5 条设计目标）、§2 术语与角色、§3 的标题与 3.1 标题。
- 完全缺失：分层图与模块边界、设备类型与能力清单、协议与帧格式、Driver/Transport 接口、配置与数据模型、HTTP/WS 接口、权限模型、互锁/限速/急停、异常与恢复、前端交互、验收标准、实施计划。

### 1.2 影响

- 评审问题 2–7 中，除“与现有实现冲突”外，**无法按文档字面核对**。依据 C1–C9 只能列出候选解释，这些条目一律标为「待确认」，不作为结论。
- 文档无法作为软件侧的开发输入：没有接口签名、没有数据结构、没有可测指标，开发只能自行发明协议，必然返工。

### 1.3 建议

补齐以下 10 项后再评审（可直接用本报告 §2–§8 作为提纲）：

1. 分层与模块边界（`lib/devices/` 与 `flow.json`、前端 `shared/` 的职责）
2. 设备类型 / 能力（capability）枚举与“未知能力”的渲染规则
3. 每类设备的协议、帧格式、超时、重试、错误码
4. Driver / Transport 接口签名（含异步、取消、超时、回读）
5. 设备注册、连接参数、凭据的存储与迁移
6. 设备与席位 / 操作员的归属与共享规则
7. 指令生命周期（受理 → 下发 → 确认 → 回读 → 失败/超时）
8. 安全联锁、急停、限位、限速、审计
9. 前端卡片与 OP 底栏的版面规则（与席位卡共存）
10. 验收标准（每条可测）+ 实施阶段与回滚方案

---

## 2. 能力对照：已有 / 新增 / 冲突（问题 1）

### 2.1 总表

| 文档要求的能力 | 仓库现状 | 判定 |
|---|---|---|
| OP 底部设备区（卡片、添加/移除） | 已有完整 UI 与 i18n：[op-page.mjs L999-L1066](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L999-L1066)、[op.css L411-L504](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/css/op.css#L411-L504) | **已有，可复用** |
| 天线切换器（端口下拉） | 有卡片，端口**硬编码 1–6**（[L1005-L1008](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L1005-L1008)），无驱动 | 部分已有 |
| 天线塔升降（上/下/停） | 有按钮与 `direction` 命令契约（[L1009-L1015](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L1009-L1015)、[L1534-L1538](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L1534-L1538)），无安全逻辑 | 占位；**新模型下“停”只保留为急停/异常，不作常规操作**（§23） |
| 旋转器（地图点击目标方位） | 地图点击 → 方位角 → `hub.command('rotator','bearing')`，只更新本浏览器 `state.rotorTarget`（[L931-L942](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L931-L942)、[op-map.mjs L24-L41](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/op-map.mjs#L24-L41)） | 前端预览，无控制 |
| 前端驱动契约 | `status()/setBearing()/setDirection()/selectAntenna()`，**同步返回**，无回读/超时（[peripherals.mjs L8-L11](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/peripherals.mjs#L8-L11)、[L53-L66](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/peripherals.mjs#L53-L66)） | 有契约，但方向与文档相反 |
| 设备配置（启用/名称） | `opRotatorConfigured/opRotatorName/opAntennaSwitchConfigured/...` 6 个字段，属 `qso` 设置域（[schema.js L315-L338](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L315-L338)） | 已有但远远不够 |
| 设备列表 / 能力 / 协议 / 地址 / 凭据 | 无 | **全新增** |
| 后端驱动 / 连接管理 / 状态机 | 无 | **全新增** |
| 指令 API / 冲突锁 / 审计日志 | 无 | **全新增** |
| 席位模型 | 已有：`seat = station:radioNr`，内存 + `radio_state` / `operator_sessions` 表（[service.js L8-L35](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L8-L35)、[n1mm-sql.js L12-L45](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/n1mm-sql.js#L12-L45)） | 已有，但设备未绑定 |
| 实时推送 | `/ws` 已推 radio/score/claims/qso/settings/alert（[main.mjs L46-L78](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/main.mjs#L46-L78)） | 可复用 |
| 告警 | `lib/alerts/` 是 **SPOT 条件规则引擎**，不面向设备（[service.js L16-L22](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/alerts/service.js#L16-L22)） | 需新增设备故障告警 |
| 决策 / 建议 | `lib/advice/` 消费 radio/prop/score/rows（[service.js L75-L106](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/service.js#L75-L106)），无设备输入 | 可选扩展 |
| 设置体系 | schema 校验 + 全局共享 + WS 广播，无鉴权（[settings/service.js L39-L70](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/settings/service.js#L39-L70)） | 不能承载设备凭据 |
| 大屏 | 只读白名单，不含任何设备接口（[server.js L33-L40](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/bigscreen/server.js#L33-L40)） | 默认不支持，需明确是否要求 |

### 2.2 三处必须澄清的“冲突”

**(A) 设备区与席位卡互斥（P1，UI 归属冲突）**

`renderBottom()` 只要检测到任一设备已配置，就直接只渲染设备卡并 `return`，席位卡、频率协调卡、最近 QSO 全部不渲染：

```js
if (devices.length) {
    host.innerHTML = devices.map(device => deviceCard(device)).join('');
    return;
}
```

见 [op-page.mjs L971-L997](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L971-L997)。底栏高度只有 104–132px（[op.css L412-L420](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/css/op.css#L412-L420)）。文档要求“每台设备一张状态卡”且“设备类型开放”，在 M2/MM 多席位下必然放不下，还会挤掉现有的席位/频率协调视图。

建议：设备区改为**独立区域或可折叠抽屉**，与席位卡并存；或按当前席位过滤设备，并保留一行席位摘要。

**(B) “Driver”同名不同义（P1，术语冲突）**

现有前端已经把 `driver` 定义为“浏览器内的适配器对象”，文档把 Driver 定义为“服务端把厂商协议翻译为能力的模块”。两者如果都叫 Driver，开发会自然沿用前端注册路径，导致控制逻辑跑在浏览器里——既无法持有串口/TCP 长连接，也无法做权限与审计。

建议：保留 `peripherals.mjs` 只做 UI 占位，明确“所有 Driver/Transport 只在 `lib/devices/` 实现”，前端只能经仓库层调 API。

**(C) 固定 3 类 vs 类型开放（P2，实现冲突）**

`DEVICE_TYPES = ['antenna','tower','rotator']` 是白名单，`hub.register` 直接拒绝其它类型（[peripherals.mjs L12-L37](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/peripherals.mjs#L12-L37)）。这与 C5“设备类型开放、不限于 5 类”矛盾。建议改为“能力驱动渲染”：前端只认识 capability（`rotate / lift / select_port / read_power / read_swr`），未知 capability 渲染为只读数值卡。

---

## 3. 多席位与设备归属（问题 2）

### 3.1 文档说了什么（P0）

**什么都没说。** C1–C9 与 §1.3 均未出现“席位 / 操作员 / 归属 / 共享”的概念；§2 的 Entity 只定义了 ID、类型、能力、状态，没有 owner。这是数据模型级缺口，必须在写第一行代码前定稿。

### 3.2 现有席位是怎么来的（决定归属键能不能直接用）

- 席位键 `seatKeyFrom(station, radioNr)` → `STATION:NR`（[seat.js L38-L42](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/seat.js#L38-L42)）。
- station 的取值优先级：relay `--station` → 报文 `StationName` → `RadioName` → **来源 IP** → `LOCAL`（[seat.js L28-L36](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/seat.js#L28-L36)）。
- 席位是**被动发现**的：只存在于 `radioStates` 内存与 `radio_state` 表，没有 seats 注册表（[n1mm-sql.js L12-L26](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/n1mm-sql.js#L12-L26)）。
- 前端另有一套静态配置作为回退：`settings.seatCount`（席位数）与 `settings.operators`（按席位顺序的操作员名单，[schema.js L561-L570](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L561-L570)）；`seatChoices()` 先取实时席位、没有再回退静态配置（[op-page.mjs L130-L146](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L130-L146)）。

**结论**：直接把 `seat` 当设备 owner 不可靠。IP 回退会随 DHCP/NAT 漂移；没有 N1MM 上报的席位（例如只看设备、不打比赛的工位）根本不存在。需要引入**稳定的 seatId**（建议显式配置 `RUN / MULT / ...`，并让 relay 的 `X-DX-Station` 直接写这个值——该机制已存在，见 [n1mm-relay-core.mjs L101-L114](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/scripts/n1mm-relay-core.mjs#L101-L114)）。

### 3.3 建议的归属模型（文档必须补写）

| 归属类型 | 语义 | 读 | 写 |
|---|---|---|---|
| `station` | 全站资产（塔、总电源、共用旋转器） | 所有席位可见 | 需租约；任何持锁席位可写（**天线切换受 TX 上报互锁；旋转器/塔不做**，见 §22） |
| `seat` | 绑定单一席位（该席位的天线切换器） | 所有席位可见（便于态势） | 仅绑定席位可写 |
| `group` | 席位组共享（MULT 组共用一副天线） | 组内可见 | 组内租约 |

一个设备服务多个席位时，文档必须回答这 4 件事，否则无法实现：

1. **谁有权写**：建议“租约（lease）”——首个写入者获得 `deviceId` 锁，TTL 默认 30s，可续租；其他席位只能读。
2. **如何仲裁**：建议复用现有频率协调的 409 + owner 语义（[frequency-claims.js L52-L58](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/frequency-claims.js#L52-L63)），但**急停不受锁限制**，任何席位都可立即执行；塔不提供常规 STOP（§23）。
3. **写冲突如何呈现**：必须回传当前持有者（席位 + 操作员），前端显示“被 RUN 席位占用”，而不是静默失败。
4. **操作员轮换**：`operator_sessions` 已有 append-only 记录（[n1mm-sql.js L38-L45](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/n1mm-sql.js#L38-L45)），设备指令日志应记录当时的 `operator`，不能只记 seat。

### 3.4 与现有表的关系

设备归属**不要**塞进 `radio_state`（它表达的是“当前 VFO/收发状态”，与设备无关）。建议新增 `devices` / `device_bindings` / `device_state` / `device_commands`（见 §6.3），`seat_id` 只作为外键字符串引用，不复制 N1MM 的推导逻辑。

---

## 4. 控制指令的安全边界（问题 3）

### 4.1 先决条件：现有系统没有鉴权（P0）

> **第二轮补充（项目方决策）**：不采用“补一套公网级鉴权”的路线，改为收敛暴露面（默认回环 + 内网可达前提），内网内再加设备口令与指令来源校验。该决定落地情况见 §14；本节对“无鉴权”的事实描述不变，但 P0 的处置方式已从“补鉴权”改为“先收敛 + 内网基本防护”。

- `settings.js` 没有 `adminAuth`、没有 `httpNodeAuth`；`uiHost: "0.0.0.0"`、`httpNodeCors.origin: "*"`（[settings.js L6-L48](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/settings.js#L6-L48)）。
- 全仓唯一带鉴权的写接口是 `POST /api/n1mm/ingest`（`X-DX-Token`，[flow.json L4405-L4425](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L4405-L4425)）；`/api/settings`、`/api/alert-rules`、`/api/frequency-claims` 均无鉴权。
- 文档 §1.3 目标 5 要求“权限”，但全文没有用户、角色、会话、令牌的任何定义。

**风险**：接入塔升降后，任何能访问 5758 的设备（含公网，如果安全组放行）都能升降天线塔。这是现场安全事故，不是功能缺陷。

**建议**：设备控制必须走**独立的鉴权**（最小方案：设备控制专用 Bearer Token 或 Node-RED `httpNodeAuth` + 前端登录态），且**写接口只允许内网/回环**；在鉴权落地前，设备写接口不得上线（只读监控可以先上）。

### 4.2 逐项核对（文档全部未定义）

| 安全项 | 文档 | 现有实现 | 风险与建议 |
|---|---|---|---|
| 冲突锁 | 未定义 | 只有频率协调的 409 软锁（[frequency-claims.js L39-L86](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/frequency-claims.js#L39-L86)），设备无锁 | 两个席位同时点“上升/下降”会互相覆盖。必须有 `deviceId` 级互斥 + TTL + owner 回传 |
| 超时 | 未定义 | 前端 `hub.command` 同步返回，无超时（[peripherals.mjs L53-L66](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/peripherals.mjs#L53-L66)） | 网络设备无响应时 UI 会一直显示“已发送”。必须定义“下发超时 / 确认超时 / 回读超时”三档 |
| 断线重连 | 未定义 | N1MM relay 有退避与有界队列（[n1mm-relay-core.mjs L65-L99](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/scripts/n1mm-relay-core.mjs#L65-L99)），但那套是**可重放的幂等数据** | 控制指令**不能重放**：断线期间重复 `UP` 可能导致超程。必须 at-most-once + 指令序号 + 重连后“先读状态再允许写” |
| 状态回读 | 未定义 | 前端契约只有 `status(): 'ready'\|'unconfigured'\|'error'`，没有数值回读 | 无法确认塔的**终端状态（展开/收回）**、旋转器的实际方位。塔不需要高度/行程百分比，只需要终端态与到位确认（§23） |
| 失败回滚 | 未定义 | 前端点击后直接改 `state.rotorTarget`（[L936-L941](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L931-L942)），属乐观更新 | 指令失败时界面仍显示目标方位。服务端应持有 last-known-good，前端只显示服务端状态 |
| 幂等 / 去重 | 未定义 | 无 | 地图连点会连发（[op-map.mjs L24-L41](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/op-map.mjs#L24-L41)）；旋转器需合并/丢弃旧目标，并设最小指令间隔 |
| 急停 / 限位 | 未定义 | 无 | 塔类必须有**展开/收回两个终端限位与独立急停回路**；失联/超时记为 `unknown`，不得当作终态；运行超时用于判 `unknown`（§23） |
| 发射互锁 | **已取消（第六轮，§21）** | `is_transmitting` 已从 N1MM 采集（[n1mm.js L160-L161](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/n1mm.js#L160-L161)、[n1mm-sql.js L12-L26](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/n1mm-sql.js#L12-L26)），但该状态由 N1MM 推断，未接 CAT/脚踏/语音处理器时不可靠 | 原建议“`isTransmitting=true` 时拒绝切换”作废；`is_transmitting` 只用于显示与一次弱提示，**不得进入准入判定** |
| 审计 | 未定义（仅“审计三重保障”） | 只有 `lib/logger.js` 控制台日志（[logger.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/logger.js#L1-L42)），不落库、无操作员 | 无法追溯“谁在几点把塔升了上去”。需要 `device_commands` 表（seat/operator/command/ts/result/error） |
| 速率限制 | 未定义 | 无 | 建议每设备最小指令间隔 + 每席位每分钟指令上限，防止误触/脚本刷 |

### 4.3 建议的指令生命周期（文档需照此写清）

```
受理（鉴权 + 归属校验 + 参数范围）
  → 加锁（deviceId 租约，急停例外）
  → 下发（带 seq，at-most-once）
  → 等待确认（ack 或错误码，超时 N 秒）
  → 状态回读（与目标比对，写 device_state）
  → 解锁 / 记录审计
失败：回读 last-known-good，UI 覆盖为目标状态，不保留乐观值
```

---

## 5. 协议与现场部署（问题 4）

文档**没有协议清单**（截断），只给了 C1–C4 的约束。下面只能列出候选接入方式；**具体协议、帧格式与依赖以完整文档为准，当前均为「待确认」**。

| 接入方式 | 典型设备 | 服务器侧实现/依赖 | 可行性 | 现场前提与成本 |
|---|---|---|---|---|
| **rotctld（Hamlib，TCP 4533）** | 旋转器 | Node 内置 `net`，纯文本协议，无新依赖 | **高（旋转器首选）** | 现场需要一台跑 `rotctld` 的机器（通常是 shack PC）或支持 Hamlib 的网络旋转器控制器。**文档必须写明这个额外进程的部署归属**，否则会被误认为服务器直连 |
| **串口服务器 TCP 透传（TCP Server / Client）** | 天线切换器、功放、驻波表、DIY 塔 | Node 内置 `net` | **高** | 每台设备一个串口服务器；需固定 IP / DHCP 保留、波特率/校验匹配、分帧规则（分隔符/定长/超时）。C3 的核心诉求就是这条 |
| **UDP 透传** | 同上 | `dgram` | 中 | 无连接、易丢包，需应用层重试与去重；不建议用于塔 |
| **RFC2217（串口 over Telnet）** | 部分串口服务器 | 需实现 telnet 协商 | 中/低 | 不是所有串口服务器都支持，一期不建议 |
| **Modbus-TCP** | 功放、驻波表、PLC、电源 | 需新增 npm 依赖（如 `modbus-serial`） | 中 | 寄存器表随厂商不同，必须驱动级配置；CRC/功能码错误处理成本高 |
| **MQTT** | DIY 网关、远程站点 | 需 `mqtt` 依赖 + 现场 broker | 中 | 需部署 broker；QoS1 + 遗嘱消息可以顺带解决“在线状态” |
| **HTTP / WebSocket 设备 API** | 厂商网络设备 | 内置 `fetch` / Node 内置 WebSocket | 高 | 需设备凭据（不能放 settings，见 §6）；云设备还有外网可达性要求 |
| **GPIO / 串口直连服务器** | — | — | **不适用** | 被 C1/C3 明确排除；如需要，只能放在远端网关（树莓派等），由网关转成网络协议 |

### 5.1 “必须支持市面上全部串口服务器”（C4）不可验收

C4 是产品口号，不是需求。串口服务器之间的差异体现在**传输模式与分帧**，而不是品牌。建议改写为可验收的矩阵：

- 传输模式：TCP Client（连设备的 Server 端口）/ TCP Server（设备主动连我们）/ UDP / RFC2217（可选）
- 分帧：分隔符（`\r\n` 等）/ 定长 / 空闲超时 / 长度前缀
- 重连与心跳：断线检测时间、重连退避、心跳帧可配

这样“支持全部品牌”就变成“支持上述 4×4 组合”，可测试、可验收。

### 5.2 依赖与部署成本

- 当前 `package.json` 只有 `node-red` 与 `node-red-node-sqlite`（[package.json L5-L8](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/package.json#L5-L8)）。Node-RED 核心自带 TCP/UDP/WebSocket/HTTP 节点，**raw TCP 不需要新依赖**；Modbus/MQTT 需要新增依赖。
- `install.sh` 要求 Node 18+（[install.sh L33](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/install.sh#L33)），走 npmmirror。若现场离线，新增依赖必须提前打包，这是部署成本。
- 生产在 `root@103.82.52.149:/opt/dx-compass`，服务器与设备同网段的假设**文档未写**。若设备在另一个内网，需要 VPN/反向隧道，这属于必须提前确认的网络前提。

---

## 6. 数据与配置落在哪里（问题 5）

### 6.1 现状：两套存储并存

| 存储 | 内容 | 特点 |
|---|---|---|
| Node-RED global context（`localfilesystem`，[settings.js L36-L41](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/settings.js#L36-L41)） | `uiSettings`（全部共享设置）、`radioStates`、`operatorSessions`、`frequencyClaims`、`propData` 等 | 全量 JSON，`GET /api/settings` 直接返回，`POST` 后 WS 广播（[settings/service.js L39-L70](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/settings/service.js#L39-L70)） |
| SQLite（`dxcompass.db`） | `spots`、`qsos`、`radio_state`、`operator_sessions`、`score_state`、`alert_rules` 等 | SQL 只允许写在 `lib/storage/`（架构测试约束，[architecture.test.js L62-L68](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/architecture.test.js#L62-L68)） |

### 6.2 为什么设备配置不能放 settings（P0）

1. **类型不支持**：schema 只有 `enum/bool/int/number/string/color/datetime/time/intMap/colorMap/enumArray`，没有对象数组（[schema.js L9-L10](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L9-L10)、[L762-L809](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L762-L809)）。多设备 + 嵌套 transport 配置无法表达。
2. **会泄露凭据**：settings 是“全共享 + WS 广播”，任何客户端都能读到；大屏 5859 只读代理也放行 `/api/settings`（[server.js L33-L40](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/bigscreen/server.js#L33-L40)）。设备口令、MQTT 密码、API Key 一旦进入 settings，等于对所有页面公开。
3. **重置语义冲突**：`/api/reset` 与 `settings.resetDomain` 会清 `uiSettings`、`radioStates`、`operatorSessions`（[settings/service.js L156-L172](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/settings/service.js#L156-L172)）。设备配置若在其中，“恢复出厂”会把设备注册表一起删掉。

> 先例说明：`n1mmToken` 目前就在 settings 里（[schema.js L221-L225](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L221-L225)），但它只是接入令牌且风险较低；**设备凭据不应沿用这个先例**。

### 6.3 建议的落点（文档需明确）

```sql
devices(id TEXT PK, name TEXT, type TEXT, driver TEXT, transport TEXT, config_json TEXT,
        enabled INTEGER, created_ts TEXT)
device_bindings(device_id TEXT, seat_id TEXT, mode TEXT, PRIMARY KEY(device_id, seat_id))
device_state(device_id TEXT PK, ts TEXT, online INTEGER, state_json TEXT, last_error TEXT)
device_commands(id INTEGER PK AUTOINCREMENT, device_id TEXT, seat_id TEXT, operator TEXT,
                command TEXT, params_json TEXT, ts TEXT, status TEXT, result_json TEXT, error TEXT)
```

- 表建立与迁移放 `lib/storage/`，SQL 构造仍遵守“只在 storage 模块”的架构约束。
- 凭据单独存放（SQLite 字段或 Node-RED credentials），**不得**出现在 `GET /api/settings` 与 WS 广播中。
- `settings` 只保留 UI 偏好（是否显示设备区、卡片排序、单位），不保留连接参数。
- 迁移要写清：现有 6 个 `opXxxConfigured/opXxxName` 字段如何处理（保留为“是否显示”还是废弃）。

### 6.4 与席位表的关系

`device_bindings.seat_id` 建议引用**显式配置的 seatId**，而不是 `radio_state.seat`。理由见 §3.2：后者是推导值，可能因 IP 变化而漂移。若要复用，必须先把 seat 身份固化为注册表（这也是 `docs/dx-compass-m2-mm-gap-plan.md` 中 G-02 的遗留问题）。

---

## 7. 实时性要求与现有架构（问题 6）

### 7.1 现有链路（核实）

- 服务端：Node-RED 流程；`/ws` 广播；SQLite 写入；propagation 每 5 分钟采集。
- 前端：`subscribeWS('/ws')` 处理 `radio/score/frequencyClaims/qso/qsoDelete/settings/alert`（[main.mjs L46-L78](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/main.mjs#L46-L78)）。
- OP 页：2s 重算数字/建议、10s 重绘地图与底栏、15s 我方 spot、60s 对手/乘数、120s 传播（[L1356-L1378](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L1356-L1378)）。
- 大屏：60s 轮询共享设置与只读数据。

### 7.2 匹配与卡点

| 点 | 判断 |
|---|---|
| 状态推送 | **可复用 `/ws`**，新增 `device` / `deviceCommand` 消息类型即可；不需要新通道 |
| 指令往返 | 设备控制要求“点击 → 确认 ≤1s、状态回读 ≤2s”。OP 页现有 2s/10s 重绘**不满足**，必须由 WS 驱动，不能等定时器 |
| 长连接 | Node-RED 的 flow 不是长连接守护者。TCP 长连接、心跳、重连必须放在 `lib/devices/` 的模块级单例里；`flow.json` 只做 API 适配（这也符合架构测试对“薄适配”的要求，[architecture.test.js L70-L88](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/architecture.test.js#L70-L88)） |
| SQLite | 设备状态若每次都落库，可能与高频 spot/QSO 写入排队（**待确认**：需压测 `node-red-node-sqlite` 的单库写入行为）。建议状态只写内存 + 30s 快照，指令日志异步批量写 |
| 大屏 | 只读白名单不含设备；若要求墙上显示设备状态，需要改 `bigscreen/server.js`，而该白名单被架构测试锁定（[architecture.test.js L305-L311](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/architecture.test.js#L305-L311)） |
| 前端约束 | 页面控制器不得直接 `fetch`/`WebSocket`，必须走 `shared/core/transport` + `shared/data` 仓库（[architecture.test.js L32-L41](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/architecture.test.js#L32-L41)、[transport.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/core/transport.mjs#L78-L105)）。文档若让前端直连设备会直接违反现有测试 |

### 7.3 建议

- 设备状态：**事件驱动 + 心跳**（在线状态每 5–10s，状态变化立即推）。
- 指令：`POST /api/devices/:id/command` 受理后立即返回 `202 + commandId`，结果经 `/ws` 回推；前端按 `commandId` 更新卡片，不乐观改值。
- 明确 Node-RED restart / redeploy 时设备连接的行为（断开重连、状态恢复、未完成指令如何收尾）。**待确认**：当前 deployment 生命周期下模块级连接是否保留。

---

## 8. 文档自身的问题（问题 7，逐条）

| 编号 | 位置 | 问题 | 类型 | 建议改法 |
|---|---|---|---|---|
| D1 | 全文 | 正文止于 `### 3.1 分层`，无后续内容（3438 字节） | 无法实施 | 补齐 §3–§9（清单见 §1.3）后重新评审 |
| D2 | §1.1 | “不具备任何硬件控制能力”忽略现有 OP 设备区、前端驱动契约与地图方位预览 | 事实不符 | 改为“已有 UI 占位与前端契约，缺后端连接/驱动/状态/审计”，并把它列为可复用资产 |
| D3 | §1.3 目标 5 | “权限、互锁、审计三重保障”三项均无定义（无用户模型、无互锁规则、无审计表） | 缺失 | 分别补：鉴权方案、设备级锁 TTL/优先级/急停例外、`device_commands` 审计表 |
| D4 | §1.3 目标 4 | “支持历史数据”未定义采样率、保留期、存储位置 | 边界未定义 | 明确：采样周期、保留天数、是否降采样、落 SQLite 还是文件 |
| D5 | §1.2 C4 | “必须支持市面上全部串口服务器”不可验收，且把“品牌”与“传输模式”混为一谈 | 不可验收 | 改为 §5.1 的传输模式 × 分帧矩阵 |
| D6 | §1.2 C5 vs C8 | C5 要求类型开放，C8 又要求“软件定义命令协议并出文档”；§2 角色表却把协议定义划给硬件侧 | 需求冲突 / 责任不清 | 明确：协议文本由硬件侧提供，软件侧只提供**声明式描述格式**（字段/帧/超时）；或反之，二选一并写入角色表 |
| D7 | §1.2 C6 | “排除电台本体，已有 N1MM+ 路径”——现有路径只是**只读状态**（RadioInfo），不能控制 | 描述不准确 | 改为“电台状态只读来自 N1MM+；若未来需要 CAT/PTT，另行立项”，并说明天线切换与发射的联锁关系 |
| D8 | §1.2 C1 + C3/C4 | “服务器与任何外设无物理连接”与“串口设备经串口服务器”一致，但未写清**串口服务器由谁供电/配置/固定 IP**，也没写现场网络拓扑 | 边界未定义 | 补部署拓扑图与网络前提（同网段/VPN、固定 IP、防火墙端口） |
| D9 | §1.2 C9 | 要求遵循 `schema.js` 单一设置源，但设备配置无法用现有字段类型表达，且凭据不能进 settings | 与现有实现冲突 | 明确“设备注册与凭据走 SQLite，不走 settings”，并说明与 C9 的关系（C9 约束 UI 偏好，不约束设备资产） |
| D10 | §2 | Entity 只定义 ID/类型/能力/状态，未定义 ID 规则、持久化、重名与重复接入 | 缺失 | 定义 `deviceId` 生成规则（用户可读 slug + 唯一性校验）、同一物理设备重复注册的检测 |
| D11 | §2 | `Driver` 与现有前端 `driver` 同名不同义；`Transport` 未区分“字节流”与“语义协议”（Modbus 不是字节流透传） | 术语不一致 / 设计缺陷 | 区分 `StreamTransport`（TCP/UDP/串口服务器）与 `ProtocolTransport`（Modbus/MQTT/rotctld），Driver 只依赖前者 |
| D12 | §2 角色表 | 把“限位与安全逻辑”整体划给硬件侧，但 C8 的 DIY 塔没有厂商硬件，安全逻辑实际落在软件 | 责任不清 | 明确“硬件限位/急停是强制前提，软件只做第二道”，并写入验收清单 |
| D13 | §1.3 目标 1 | “新增设备类型不改核心代码”未定义能力枚举由谁维护、未知能力如何渲染 | 边界未定义 | 定义 capability 注册表与前端降级规则（未知能力 → 只读卡 + “不支持”标识） |
| D14 | 全文 | 无验收标准、无优先级、无里程碑、无非功能指标（延迟/并发/可用性/离线） | 缺失 | 每条需求补“可测指标”，例如：指令确认 ≤1s、状态回读 ≤2s、断线 5s 内置 offline、连续 10 次点击只下发最后目标 |
| D15 | §1.2 C2 | 把 TCP/UDP/HTTP/Modbus/MQTT/WebSocket 并列为“接入方式”，但未说明依赖由谁提供（broker、网关、npm 包） | 不可实施 | 每种协议补“依赖清单 + 现场提供方 + 离线安装方式” |
| D16 | 全文 | 没有“不做什么”的边界（除 C6），例如是否支持联动（塔升起自动切天线）、是否支持定时/场景 | 边界未定义 | 明确一期不做联动与自动化，只做单设备单指令 |

---

## 9. 建议实施顺序

顺序原则：**先只读后写、先低风险后高风险、先有鉴权后有物理动作**。每个阶段都必须有可测的通过条件。

### Phase 0 — 文档与设计（不写业务代码）

- 补齐 §1.3 与 §8 中的 D1–D16。
- 定稿：设备归属模型（§3.3）、存储方案（§6.3）、安全模型（§4）。
- 定稿验收标准（至少覆盖：在线状态、指令确认、回读、锁冲突、超时、断线、审计）。
- **通过条件**：文档中每个功能都能对应到一条可执行测试。

### Phase 1 — 设备注册与只读监控

- 新增 `lib/devices/`（registry + transport 抽象 + 只读 driver）。
- 新增 `devices/device_state` 表与只读 API（`GET /api/devices`）。
- 前端把 `peripherals.mjs` 的假 driver 改为读 API；设备卡只显示状态，所有按钮禁用。
- `/ws` 增加 `device` 消息。
- **通过条件**：设备断线 5s 内在 UI 标红；重启后状态恢复；不产生任何写指令。

### Phase 2 — 鉴权与指令骨架

- 设备控制专用鉴权（Bearer 或 `httpNodeAuth`），写接口只允许内网。
- `POST /api/devices/:id/command`：参数校验、归属校验、`deviceId` 锁、审计落库、`202 + commandId`、WS 回推结果。
- **通过条件**：无 token 401；并发两个席位写同一设备，第二个返回 409 且带 owner；每次指令都有审计行。

### Phase 3 — 旋转器闭环（低风险写）

- 接 rotctld（TCP 4533）或串口服务器透传；实现超时、回读、重试上限。
- 地图点击 → 指令 → 回读方位 → 卡片显示实际值。
- **通过条件**：点击到实际转动 ≤2s；连点 10 次只执行最后目标；设备离线时卡片显示 offline 且不发指令。

### Phase 4 — 天线切换器（**恢复发射互锁，仅天线切换**）

- 串口服务器 TCP；端口数改为驱动声明（不再硬编码 1–6）。
- TX 上报源 active 时拒绝切换，无二次确认（§19.6/§22）。
- **通过条件**：切换后回读端口一致；审计含操作员；TX 有效时被拒并给出源。

### Phase 5 — 天线塔（最高风险，单独评审）

- 硬件限位与急停回路确认为前提；软件做终端态校验、运行超时→`unknown`、急停任何席位可执行；**不提供常规“停半路”**（§23）。
- 双人确认或长按确认；操作前后状态快照。
- **通过条件**：二态读取正确；断联→`offline`；运行超时告警；非授权席位无法操作；所有动作可追溯；无软件自停。

### Phase 6 — 通用驱动 / DIY / Modbus / MQTT

- 声明式驱动（字段/帧/超时）+ 单文件驱动加载；Modbus/MQTT 作为可选依赖。
- **通过条件**：新增一类设备不需要改核心代码；未知 capability 前端降级为只读。

### Phase 7 — 多席位共享与联动（如需）

- 租约续期、席位组、设备组联动（若产品确认要做）。
- **通过条件**：M2 六席位同时在线时，设备归属与锁行为符合 §3.3。

---

## 10. 附录：本次核实的关键位置

| 主题 | 文件与行 |
|---|---|
| OP 设备区渲染 / 席位卡互斥 / 设备命令 | [op-page.mjs L971-L1066](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L971-L1066)、[L1534-L1545](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L1534-L1545) |
| 前端驱动契约（同步、无回读） | [peripherals.mjs L8-L68](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/peripherals.mjs#L8-L68)、[op-peripherals.test.mjs L19-L37](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/op-peripherals.test.mjs#L19-L37) |
| 地图点击 → 方位 | [op-map.mjs L14-L42](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/op/op-map.mjs#L14-L42)、[op-page.mjs L931-L942](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L931-L942) |
| 设备相关设置字段 | [schema.js L315-L338](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L315-L338) |
| 设置类型能力（无对象数组） | [schema.js L9-L10](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L9-L10)、[L762-L809](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L762-L809) |
| 设置存储 / 重置语义 | [settings/service.js L30-L70](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/settings/service.js#L30-L70)、[L156-L172](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/settings/service.js#L156-L172) |
| 无鉴权 / CORS / 监听 | [settings.js L6-L48](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/settings.js#L6-L48) |
| 席位键推导 | [seat.js L28-L42](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/seat.js#L28-L42) |
| 席位状态 / 操作员轮换 | [service.js L8-L35](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L8-L35)、[L65-L93](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L65-L93) |
| `radio_state` / `operator_sessions` / 恢复 | [n1mm-sql.js L12-L88](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/n1mm-sql.js#L12-L88)、[ingest.js L73-L127](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/ingest.js#L73-L127) |
| 频率协调 409 / 单席位单频 | [frequency-claims.js L39-L86](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/frequency-claims.js#L39-L86) |
| N1MM 接入鉴权示例 | [flow.json L4405-L4425](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L4405-L4425) |
| WS 消息类型 | [main.mjs L46-L78](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/main.mjs#L46-L78) |
| 架构约束（前端网络出口 / SQL 归属 / 薄适配 / 大屏白名单） | [architecture.test.js L32-L41](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/architecture.test.js#L32-L41)、[L62-L88](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/architecture.test.js#L62-L88)、[L305-L311](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/architecture.test.js#L305-L311) |
| 大屏只读白名单 | [bigscreen/server.js L33-L40](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/bigscreen/server.js#L33-L40) |
| 依赖 / Node 版本 | [package.json L5-L8](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/package.json#L5-L8)、[install.sh L33](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/install.sh#L33) |
| 断线重连参考实现（非控制） | [n1mm-relay-core.mjs L65-L114](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/scripts/n1mm-relay-core.mjs#L65-L114) |

---

# 第二轮评审（v2.0，2026-11-12）

## 11. v1.0 → v2.0 对比

| 项 | v1.0 | v2.0 | 判断 |
|---|---|---|---|
| 文件大小 | 3438 字节 | 4481 字节（+1043） | 有增量 |
| 行数 / 正文终点 | 75 行 / 第 74 行 `### 3.1 分层` | 79 行 / 第 79 行 `// 所有设备写接口先过 isInternalRequest…` | **仍然截断**，且断在代码块中间 |
| 版本声明 | v1.0 | “v2.0（重构版，补全评审缺口）”“前序文档 v1.0（内容截断，本版为完整替代版）” | 自我声明与交付物不符 |
| 新增内容 | — | §0 变更表（R1–R8）、§1.1 修正为承认现有 UI/前端契约、C4 改为传输×分帧矩阵、C5 改为能力驱动、新增 §1.3 部署边界 D1–D6 + net-guard 片段 | 只补到 §1.3 |
| 仍缺失 | §2 术语、§3 分层、§4 安全、§5 协议、§6 数据、§7 API、§8 验收、§9 计划 | 同样缺失 | **无法评审问题 3–7 的主体内容** |

**结论**：v2.0 是一次**方向正确但未完成**的重写。可见部分（§0、§1.1、C4/C5、§1.3）已经把上一轮最关键的几处批评吸收进去了；但 §0 声称补全的五章（R3）以及 R2/R6/R7 的具体设计，在交付文件里**一个字都没有**。因此“已补全”不可采信，需要重新导出完整文件。

### 11.1 R1–R8 逐条核验

| 编号 | v2.0 声称 | 交付物中的实际内容 | 判定 |
|---|---|---|---|
| R1 | 新增部署边界章节 | §1.3 D1–D6 完整可见 | **已补**（但 D2/D3 自相矛盾，见 N1） |
| R2 | 新增“设备与席位绑定”设置页，粒度到端口 | 仅出现在变更表；设置页字段、交互、存储均无 | **未提供**（待确认） |
| R3 | 补全部署/协议/存储/安全/验收五章 | 只有部署边界；协议仅 C4 一句；存储、安全、验收无正文 | **未提供** |
| R4 | 设备配置落 SQLite | 仅变更表一行；无表结构、无迁移、无凭据方案 | **方向确认，设计缺失** |
| R5 | C4 改为矩阵 | 约束表已改；指向的 §5.2 不存在 | **半补**（矩阵本体缺失） |
| R6 | 设备区与席位卡并存 | 仅变更表一行；无版面规则 | **未提供** |
| R7 | Driver 术语唯一化，仅服务端实现 | 仅变更表一行；§2 术语表缺失 | **未提供** |
| R8 | 能力驱动渲染取代白名单 | C5 已改为“类型开放，能力驱动渲染”；capability 枚举与降级规则缺失 | **半补** |

---

## 12. v2.0 §1.3 部署边界评审

先给结论：**D1/D2/D6 与项目方新定的调子一致，方向正确；D3 与 D2 直接冲突，D4 的实现建议不可直接落地，D5 缺少状态归属。** 这一节整体应从“建议”升级为“可执行的约束 + 可测验收”。

| 编号 | 问题 | 严重程度 | 建议改法 |
|---|---|---|---|
| N1 | **D2 与 D3 自相矛盾**。D2 明令“禁止对公网暴露监听端口，包含 5758、5859”；D3 又说“若用户执意使用公网隧道，仅允许访问只读大屏 5859”。同一份文档里 5859 既禁止又放行，且放行条件没有边界（谁判断、如何限制、如何审计） | **P0** | 删除 D3 的 5859 例外，统一为“任何端口都不做公网隧道”；若产品坚持保留只读例外，必须改为“明确的不受支持模式”，并要求显式配置 + 常驻横幅 + 只读白名单（现有大屏本身已只读，但仍会转发 `/api/settings` 与 `/api/station/state`，见 N3） |
| N2 | **D4 代码片段不可运行**：`normalize()`、`inRange()` 未定义；`PRIVATE_RANGES` 只有字符串数组，没有 IPv6 解析；没有处理 `::ffff:192.168.1.5`；不含 CGNAT `100.64.0.0/10`；在反向代理后面 `req.socket.remoteAddress` 恒为 `127.0.0.1`，校验会**无条件通过**，形成假安全感 | **P0** | 用服务端共享函数实现并单测：先 `::ffff:` 归一化、IPv4/IPv6 分别判段、只信任 socket 地址、**绝不信任 `X-Forwarded-For`**；若检测到代理头直接 403 并告警。校验范围扩到 `/api/devices/*` 全部（含只读）与 `/ws` 的 upgrade 请求 |
| N3 | **D4 只保护设备写接口，LAN 内其余面仍然敞开**：Node-RED 编辑器 `/red` 无 `adminAuth`，`/ws` 无鉴权且会广播 `settings`（其中含 `n1mmToken`）；大屏白名单会转发 `/api/settings` 与 `/api/station/state` | **P1** | 文档必须写明“内网 ≠ 可信”：限定 `DX_LISTEN_HOST` 时同时考虑 `/red` 的 `adminAuth` 或让编辑器只走本机；`/ws` 至少校验 Origin/来源；settings 广播剔除令牌类字段 |
| N4 | **D5 的“首次启用确认”没有定义状态归属**：存浏览器 localStorage 还是服务端？A 用户确认后是否对全站生效？重新安装是否重置？弹窗本身不是安全控制，只是告知 | **P1** | 明确“确认状态存服务端（如 `uiSettings` 的 `deviceEnabledAcknowledged` 或独立表），按部署实例生效”；并说明它只用于告知，不替代来源校验与设备口令 |
| N5 | **D1/D2 与仓库既有文档/部署现实冲突**：README 原本指导云服务器安全组放行、`<服务器IP>:5758` 访问、N1MM relay 跨公网；生产实例也确实在公网 VPS（`103.82.52.149`）。按 D1，这个实例属于“不受支持部署” | **P1（部署动作）** | 仓库文档已按新调子改写（见 §14）；**存量实例需要迁移到本机/内网，或明确标注为不受支持并停止对外暴露**。这是运维动作，代码无法替代 |
| N6 | **D6 要求写入四处**（README、安装输出、首次弹窗、设置页），目前只能覆盖三处；设备模块尚不存在，弹窗没有挂载点 | P2 | 工作区中已改 README/安装输出/设置页（未提交、未部署、已冻结）；首次弹窗随设备模块 Phase 1 一起实现，并在验收中检查 |
| N7 | **D4 的地址范围不完整**：缺 `100.64.0.0/10`（运营商级 NAT，常见于 4G/5G 上行）、`198.18.0.0/15`、IPv6 `fe80::/10` 的完整判段；`fc00::/7` 用字符串匹配容易漏掉 `fc::/fd::` 简写 | P2 | 用 §14 的 `lib/deployment/exposure.js` 的 `scopeOfAddress()` 作为唯一实现，避免文档与代码两套判定 |
| N8 | **“完整替代版”不成立**，且 §0 用变更表代替正文，评审无法确认 R2/R3/R6/R7 是否真的设计过 | **P0（流程）** | 重新导出完整文档；若文件仍被截断，请提供可分片读取的版本。R2/R6/R7 必须在正文出现字段、接口、版面或数据模型，否则视为未完成 |

### 12.1 与“不部署公网”调子的对照

| 文档条款 | 与新调子是否一致 | 说明 |
|---|---|---|
| D1 禁止公网可访问主机 | 一致 | 表述明确，含云服务器/VPS |
| D2 禁止端口暴露（含 5859） | 一致 | 但被 D3 破坏 |
| D3 允许只读大屏走公网隧道 | **不一致** | 新调子是“执意部署，后果自负”，不是“允许只读面公网可达”；且大屏会转发设置与席位状态 |
| D4 来源校验 | 部分一致 | 方向对，但实现不可用；且“内网”不等于“可信” |
| D5 首次确认 | 一致 | 属于告知，不是控制 |
| D6 免责声明 | 一致 | 措辞可直接复用 |

---

## 13. 上一轮待确认条目复核

| 上一轮条目 | v2.0 新增信息 | 本轮结论 |
|---|---|---|
| §2.1 设备区与席位卡互斥 | R6 声称改为并存，无正文 | **方向确认，规则仍缺**：并存后的版面、底栏高度、按席位过滤规则仍需补 |
| §3.1 设备归属“什么都没说” | §1.1 新增“按席位归属 + 按端口绑定” | **降级为“只有方向”**：归属类型（station/seat/group）、共享写仲裁、租约 TTL、STOP 例外仍全部缺失 |
| §4.2 冲突锁/超时/回读/回滚 | 无新增 | **维持 P0**：D1–D6 只解决暴露面，不解决指令生命周期 |
| §5 协议可行性 | C4 改为传输×分帧矩阵，§5.2 缺失 | **约束已修正，矩阵未提供**：rotctld / Modbus / MQTT 的依赖与部署成本仍未写 |
| §6.1 两套存储 | R4 声称落 SQLite，无表结构 | **方向确认**：仍缺 `devices/device_state/device_commands` 与凭据方案（§6.3 的建议可直接采用） |
| §7.2 SQLite 写入排队 | 无新增 | **待确认**（缺 §6 数据模型，未跑压测）；建议 Phase 1 用“内存 + 30s 快照”规避 |
| §8 D1 文档不完整 | v2.0 仍截断 | **维持 P0**，见 N8 |
| §8 D5 “全部串口服务器” | C4 已改 | **已修复**（矩阵本体待补） |
| §8 D9 配置不能进 settings | R4 已确认 | **已修复（方向）** |
| §8 D11 Driver/Transport 术语 | R7 声称修复，正文缺失 | **未核实** |
| §8 D13 能力枚举/未知能力渲染 | C5 已改，规则缺失 | **未核实** |

---

## 14. 工作区中的部署边界改动（未提交、未部署、已冻结）

> **状态声明**：以下改动发生在用户下达“评审阶段、禁止改动项目代码”之前。目前全部留在工作区：**未提交、未部署、不再继续修改**。本节只用于说明现状与回退依据，不表示这些改动已被接受或交付；是否保留由用户决定。

按项目方新调子，这些改动把“暴露面收敛”当成主控制，而不是补公网鉴权。最后一次全量测试为 394 项通过、0 失败（仅说明工作区代码可运行）。

| 改动 | 位置 | 行为 |
|---|---|---|
| 默认只绑定回环 | [settings.js L7-L25](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/settings.js#L7-L25) | `uiHost = DX_LISTEN_HOST || 127.0.0.1`；注释里写明放开方式与“不支持公网” |
| 暴露面检测模块 | [exposure.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/deployment/exposure.js) | 纯函数：地址分段（IPv4/IPv6/映射地址）、云平台环境变量、显式公网 URL、接口地址；输出 `local / lan / unsupported` |
| 启动告警 | [settings.js L18-L21](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/settings.js#L18-L21) | 非回环即 `console.warn` 醒目提示；公网/云迹象时给出“后果自负”与收回暴露面的做法 |
| 暴露面 API | [flow.json L4686-L4731](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/flow.json#L4686-L4731) | `GET /api/system/exposure`，`Cache-Control: no-store`，仅返回判定结果，不返回网卡地址明细 |
| 设置页常驻提示 | [index.html L342](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/index.html#L342)、[settings-page.mjs L789-L814](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/settings-page.mjs#L789-L814)、[style.css L747-L763](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/css/style.css#L747-L763) | 回环时不显示；LAN 为黄色提示；公网/云迹象为红色提示；11 种语言已补齐（[i18n.js L1050-L1051](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/i18n.js#L1050-L1051) 等 11 处） |
| 前端取数走统一出口 | [system.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/data/system.mjs) | 符合“页面不得直接 fetch”的架构测试 |
| 只读大屏默认回环 | [bigscreen/server.js L26-L30](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/bigscreen/server.js#L26-L30)、[L192-L200](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/bigscreen/server.js#L192-L200) | `BIGSCREEN_HOST || 127.0.0.1`；显式放开时打印警告 |
| 安装脚本显式化 | `install.sh` 的两个 unit 与结尾输出 | 主服务 `Environment=DX_LISTEN_HOST=127.0.0.1`；大屏 `Environment=BIGSCREEN_HOST=0.0.0.0` 并注明“只读、仅内网”；结尾打印中英文部署边界与免责声明 |
| README | [README.md 部署边界](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/README.md#L7-L27) | 新增“部署边界（重要）”；访问地址改为 `127.0.0.1`；安全组/ufw/relay/大屏段落全部改为“自有局域网”，并明确公网/云部署不支持 |
| 测试 | [deployment-exposure.test.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/tests/deployment-exposure.test.js) | 覆盖默认回环、地址分段、LAN/不受支持判定、API 接线与 `dx.deployment` 暴露 |

**检测边界（必须诚实说明）**：进程内看不到路由器 NAT/UPnP/隧道配置，也无法确认外部是否可达。因此“端口映射”用三类可观测信号代理判断：绑定地址、网卡上是否存在公网地址、云平台/公网 URL 环境标记。若用户在回环绑定下通过路由器 DMZ 或外部隧道暴露，服务端无法感知——这种情形只能依赖文档、安装输出与设置页提示告知，不能宣称“已自动检测全部公网暴露”。

### 14.1 未做（有意）

- **未加公网级鉴权**：按项目方决策，不用鉴权替代暴露面收敛。设备模块落地时只需内网基本防护：设备口令、指令来源校验、操作员/席位绑定。
- **未做首次启用弹窗**：设备模块尚不存在，没有挂载点；D5 的确认状态建议随 Phase 1 一起设计（服务端存储，不用 localStorage）。
- **未收紧 `/red` 与 `/ws`**：默认回环下不可从外部访问；一旦用户显式设置 `DX_LISTEN_HOST`，这两个面会随之开放，属于 §12 N3 的待办。

### 14.2 设备模块必须遵守的前提（写入实现约束）

1. 设备控制面按“仅本机/内网可达”设计，**不引入面向公网的 OAuth/多租户/远程控制**。
2. 设备写接口在服务端做来源校验（复用 `scopeOfAddress()`），并且**不信任代理头**；校验失败返回 403 并记录审计。
3. 即使来源在内网，也要有设备口令与操作员归属校验；口令不得进入 `uiSettings`/`/api/settings`/WS 广播。
4. 写接口必须与暴露面检测联动：`level === 'unsupported'` 时，设备写接口默认关闭（只读仍可用），直到部署回到受支持形态。
5. 大屏始终只读；若未来要显示设备状态，只允许新增只读白名单，不得转发任何 command 接口。

---

## 15. 更新后的实施顺序

在第一轮 §9 的基础上，插入“部署边界”作为 Phase 0.5，并调整 Phase 2 的措辞（不再以公网鉴权为前提）。

| 阶段 | 内容 | 通过条件 |
|---|---|---|
| Phase 0 | 补齐 v2.0 §2–§9（R2/R3/R6/R7 必须有正文）；定稿归属模型、存储、验收 | 每条需求可对应一条测试；文档不再截断 |
| **Phase 0.5（工作区改动，未提交/未部署/已冻结）** | 默认回环、启动告警、暴露面 API、设置页提示、README/安装脚本免责 | 若用户决定保留：`npm test` 394 项通过；默认启动只监听 `127.0.0.1`；非回环时日志与设置页均有提示 |
| Phase 1 | 设备注册 + 只读监控 + 设备区与席位卡并存；首次启用确认（服务端状态） | 断线 5s 内标红；重启后状态恢复；确认状态不随浏览器变化 |
| Phase 2 | 指令骨架：来源校验、设备口令、席位归属、锁、审计、`202 + commandId`、WS 回推 | 非内网 403；绕过代理头无法提权；并发写返回 409 + owner；每条指令有审计行 |
| Phase 3 | 旋转器（rotctld / TCP）闭环 | 点击到转动 ≤2s；连点只执行最后目标；离线不发指令 |
| Phase 4 | 天线切换器 + **TX 上报互锁**（仅天线切换） | 回读端口一致；TX 上报源 active 时被拒并给出来源 |
| Phase 5 | 天线塔（硬件终端限位/急停为前提，二态/脉冲自锁） | 二态读取正确；断联→`offline`；运行超时告警；全量可追溯 |
| Phase 6 | 声明式 DIY 驱动 + Modbus/MQTT（可选依赖） | 新增设备类型不改核心代码；未知 capability 降级为只读 |
| Phase 7 | 多席位共享（租约/席位组/联动） | M2 六席位在线时归属与锁符合 §3.3 |
| **运维动作** | 存量部署迁移：公网 VPS（`103.82.52.149`）迁回本机/内网，或明确标注为不受支持并停止对外暴露；`/red` 与 `/ws` 在 LAN 模式下的保护 | 公网扫描不到 5758/5859；LAN 模式下 `/red` 需鉴权或仅本机；设置广播不含令牌 |

---

## 16. 第二轮结论

- **v2.0 方向正确但未完成**：只补到 §1.3；R2/R3/R6/R7 无正文，R5/R8 只有约束级修改。文档层面仍是 P0 阻断。
- **部署边界是新调子的正确落法，但文档内部 D2/D3 打架**；D4 的示例代码不能直接用，且只保护写接口不足以覆盖 LAN 内的 `/red` 与 `/ws`。
- **“不部署公网”目前只存在于工作区**：默认回环、启动告警、设置页常驻提示、大屏与安装脚本、README 免责声明均未提交、未部署；按评审阶段要求已冻结，是否保留待用户决定。
- **设备模块的功能性缺口没有变化**：冲突锁、超时、断线重连、状态回读、失败回滚、审计、验收标准，仍是 P0/P1，需要等 §2–§9 补齐后再评审。**发射互锁最终恢复，但只针对天线切换（§22）；旋转器不做。**
- **两版交付文档都在 79 行左右被截断**（v1.0 停在 §3.1 标题，v2.0 停在 §1.3 代码块中间），需要用户重新提供完整版。在拿到完整文档之前，§12–§13 中依赖 §2–§9 的条目一律保留「待确认」，本报告不会用推断替代结论。

---

## 17. 待确认清单（第二轮，已被 §18.3 取代）

> **状态更新**：本节是第二轮基于截断版列出的 14 条待确认。完整版 v2.1 已交付，逐条结论见 **§18.3**；本节保留原文仅用于对照，不再作为当前结论。

以下条目在当时**没有文档依据**，全部标为「待确认」。它们不是评审意见，而是“必须由完整文档回答的问题”；在此之前不做实现判断。

| # | 待确认项 | 为什么现在不能定 | 需要文档中的位置 |
|---|---|---|---|
| Q1 | 设备清单与每类设备的能力（capability）边界 | 只有 5 个示例和“类型开放”，没有枚举 | §2 设备模型 / §3 能力清单 |
| Q2 | 每类设备的协议、帧格式、超时、错误码 | 只有 C2 的协议名罗列；C4 指向的 §5.2 不存在 | §5.2 传输×分帧矩阵、§5.3 帧格式 |
| Q3 | Driver / Transport 接口签名（异步、取消、超时、回读） | §2 术语表缺失，R7 无正文 | §3 分层、§4 接口 |
| Q4 | 设备配置与凭据的存储（表结构、迁移、是否进 settings） | R4 只有一句结论，无表结构 | §6 数据模型 |
| Q5 | 设备与席位 / 操作员的归属与共享写仲裁 | 只有“按席位归属 + 按端口绑定”一句；无 owner/共享/租约规则 | §2 归属模型、§7 API |
| Q6 | 指令锁、TTL、优先级、急停例外、幂等与去重 | 完全缺失 | §4 安全与互锁 |
| Q7 | 断线重连、状态回读、失败回滚、last-known-good | 完全缺失 | §4 状态机、§8 异常 |
| Q8 | 天线切换与发射的互锁（是否使用 `is_transmitting`）、塔的限位与急停 | **最终：仅天线切换做 TX 上报互锁（§22）**；不用 N1MM；旋转器/塔不做；塔的限位/急停仍需软件边界 | §4 安全联锁 |
| Q9 | 审计字段（seat/operator/command/result/ts）与保留期 | 只有“审计三重保障”一句 | §6 表结构、§4 审计 |
| Q10 | 验收标准与非功能指标（确认 ≤1s、回读 ≤2s、断线 5s、并发席位） | 全文无一条可测指标 | §8 验收 |
| Q11 | 设备区与席位卡的版面规则（并存后底栏怎么排、按席位过滤） | R6 只有一句“改为并存” | §7 UI 交互 |
| Q12 | 未知 capability 的降级渲染与 capability 枚举维护方 | C5 只写“能力驱动渲染” | §3 能力清单、§7 UI |
| Q13 | 现有 6 个 `opXxxConfigured/opXxxName` 字段的迁移/废弃策略 | 无迁移说明 | §6 数据迁移 |
| Q14 | 部署边界 D2/D3 冲突的最终口径（5859 是否允许隧道） | v2.0 内部矛盾 | §1.3 修订 |

### 17.1 七个评审问题的覆盖状态

| 评审问题 | 第二轮状态 | 完整版（第三轮）状态 |
|---|---|---|
| 1. 已有 / 新增 / 冲突 | 已核实 | **已核实**（§2） |
| 2. 多席位设备归属 | 待确认 | **已覆盖规则（§3.2–3.4）**；席位身份已定（D18 关闭：ComputerName+RadioName+RadioNr，显式配置优先）；group 表仍缺（D22） |
| 3. 控制指令安全边界 | 待确认 | **已覆盖主体（§3.4/§9.3/§9.4）**；见 §18.5 逐项差距 |
| 4. 协议与部署成本 | 待确认 | **已覆盖（§6.2/6.3/7.3/12.2）**；个别帧格式待补 |
| 5. 数据与配置落点 | 部分核实 | **已覆盖（§8.2–8.4）**；密钥与迁移仍缺（D23/Q13） |
| 6. 实时性与架构匹配 | 部分核实 | **设计与现有架构匹配（§11.2/§13）**；容量与进程生命周期见 D25/D31/D32 |
| 7. 文档自身问题 | 已核实（可见部分） | **已核实（完整版）**；见 §18.4 与 D17–D32 |

---

# 第三轮评审（完整版 v2.1）

> **第四轮已修订本节的以下结论，施工时以 §19 为准**：
> - D2 / D3：由用户定调**关闭**（不做拦截），§18.4(1) 的 P0 判断作废；
> - D4：**整条作废**（不做公网/来源判断），§18.4(2) 的 P0 判断作废；
> - D17：按设备树 + 占用模型**重写**，见 §19.6；
> - §18.12“仍有 3 个 P0”的结论失效，最新结论见 §21.7。

## 18. 完整版评审

### 18.1 完整性与版本核验

| 项 | 结果 |
|---|---|
| 文件 | 35552 字节（35.5 KB） |
| 行数 | 1625 物理行 / **754 非空行** |
| 结尾 | 第 1625 行是 §17 最后一条“seats 表与 settings.seatCount / settings.operators 的关系”，**自然结束，无截断** |
| 章节 | §0–§17 齐全：术语、席位、设置页、架构、Transport、驱动、存储、安全、前端、接口、部署、NFR、交付物、验收、分期、待确认 |
| R1–R8 | 八项现在都有正文：R1 §1.3、R2 §4、R3 §5–§9/§15、R4 §8.2–8.3、R5 §6.2、R6 §10.2、R7 §2/§7、R8 §10.1 |
| 小问题 | §0 标题仍是“本版相对 v1.0 的关键变更”，未随 v2.1 更新；§1.4 的编号在转换后丢了标题层级（不影响内容） |

### 18.2 第一、二轮结论的升级对照

| 第二轮的结论 | 完整版对应内容 | 第三轮结论 |
|---|---|---|
| “设备归属什么都没说”（§3.1） | §3.2 稳定 seatId、§3.3 station/seat/group、§3.4 租约 | **已覆盖**；席位身份已定（D18 关闭）；仍缺 group 表（D22） |
| “冲突锁/超时/重连/回读/回滚一项都没写”（§4.2） | §3.4、§6.2、§7.4、§9.3、§9.4 | **已覆盖主体**；逐项差距见 §18.5 |
| “协议只有口号，没有清单”（§5） | §6.2 矩阵、§6.3 kind、§7.3 驱动清单、§12.2 依赖 | **已覆盖到接入层**；个别设备帧格式仍缺 |
| “配置落点未定义”（§6） | §8.2 不进 settings、§8.3 六张表、§8.4 加密 | **已覆盖**；密钥管理与迁移仍缺（D23/Q13） |
| “实时性待确认” | §6.2 连接管理、§7.4 轮询/在线判定、§11.2 WS、§13 NFR | **设计已覆盖**；容量与 SQLite 写入仍需实测（D25/D31） |
| “无验收标准”（§8 D14） | §13 NFR + §15 十条验收 | **已覆盖**；个别验收不可安全执行（D30） |
| “设备区与席位卡互斥未定”（§2.2A） | §10.2 明确并存，给出两种方案 | **要求覆盖，方案未定稿**（P2） |
| “Driver 术语冲突”（§2.2B） | §2 术语唯一化声明 + §7 服务端契约 | **已覆盖** |
| “能力渲染未定义”（§2.2C） | §10.1 capability 驱动、未知能力只读卡 | **已覆盖**；注册表维护方仍缺 |

### 18.3 §17 十四条待确认的关闭情况

| # | 待确认项 | 完整版章节 | 结论 | 剩余缺口 |
|---|---|---|---|---|
| Q1 | 设备清单与能力边界 | §7.3、§7.1、§10.1 | **部分关闭** | 类型开放是刻意设计；capability 名称/单位/枚举的注册表未给（谁维护、如何校验） |
| Q2 | 协议、帧格式、超时、错误码 | §6.2、§6.3、§7.1、§7.3 | **部分关闭** | 接入方式与分帧已齐全；`yaesu-gs232` 的具体帧格式未写，矩阵/继电器协议依赖厂商 |
| Q3 | Driver/Transport 接口 | §6.1–6.2、§7.1–7.2 | **基本关闭** | `execute()` 的返回值/错误约定、capability 元数据、同 Transport 并发策略未定义 |
| Q4 | 配置与凭据存储 | §8.2、§8.3、§8.4、§4.3 | **基本关闭** | 密钥存放/轮换未定（D23）；无 settings → SQLite 的迁移脚本 |
| Q5 | 席位归属与共享写 | §3.2–3.4、§4.2.3 | **关闭（规则层）** | 席位身份已定（D18 关闭）；group 无表结构（D22） |
| Q6 | 锁、TTL、优先级、急停、幂等 | §3.4、§9.3、§9.4 | **基本关闭** | 幂等键/去重窗口缺失（D20）；租约与长动作冲突（D19）；排队策略“可配”未给默认 |
| Q7 | 重连、回读、回滚 | §6.2、§7.4、§9.4 | **基本关闭** | “丢弃旧状态”与“回滚 last-known-good”冲突（D21）；超时 N 未给值 |
| Q8 | 发射互锁、限位、急停 | §9.3、§9.5 | **最终：天线切换互锁恢复（§22）**；旋转器不做；限位/急停仍覆盖 | 状态源改为通用上报接口（用户自研，优先级可配）；D17 恢复但范围收窄；D42 取消 |
| Q9 | 审计字段与保留期 | §8.3、§9.6、§4.2.4 | **基本关闭** | 保留期未给默认；追加写无数据库级约束；probe 是否审计未写 |
| Q10 | 验收标准与 NFR | §13、§15 | **部分关闭** | “72h 无异常”无阈值；“32 台”无轮询预算；403 验收不可安全执行（D30） |
| Q11 | 设备区与席位卡版面 | §10.2 | **部分关闭** | 给了两个“或”方案，未选定；M2/MM 具体布局仍缺 |
| Q12 | 未知 capability 降级 | §10.1 | **关闭** | 未知 → 只读数值卡已明确 |
| Q13 | 现有 6 个 `opXxx*` 字段迁移 | §8.2、§17 最后一条 | **未关闭** | 只写“旧配置作迁移来源”，没有逐字段映射与废弃步骤 |
| Q14 | D2/D3 最终口径 | §1.3 | **未关闭** | v2.1 原文仍然矛盾，见 §18.4 |

### 18.3.1 设备归属与“一个设备服务多个席位”的直接答案

- **文档怎么定义**：三种归属——`station`（全站共用：塔、总电源、共用旋转器）、`seat`（单席位专用：该席位的切换器）、`group`（席位组共用，如 MULT 组共用一副天线），见 §3.3。绑定键是**稳定的 `seatId`**（§3.2），明确禁止用 IP 或原始 `STATION:NR`。
- **一个设备服务多个席位**：多端口设备按端口拆分（§4.2.3）——`IN` 口绑定席位、`OUT` 口绑定天线/station/组；席位只能操作绑定给自己的 IN 口。单端口共用设备按 `station` 归属处理，读全部、写靠租约。
- **并发写**：租约 30s + 409 返回当前持有者（席位 + 操作员）；`stop/emergency_stop` 不受锁限制（§3.4）。两个席位把各自 IN 选到同一 OUT 时，软件负责检测并告警，物理互斥由硬件决定（§4.2.3）。
- **席位身份已定**（D18 关闭）：`seatId = ComputerName + RadioName + RadioNr`，显式配置为最高优先级覆盖；HTTP 请求用 `X-DX-Seat` 携带该组合，服务端对照 `seats` 校验。
- **仍缺**：`group` 没有表结构（D22）；不补则“仅绑定席位可写”和越权 403 无法完整验收。

### 18.4 两处硬伤复核（完整版）——**第四轮已覆盖，见 §19.7**

> D2/D3 已由用户定调关闭、D4 已作废；本节保留原文仅用于追溯，不再作为待修项。

**(1) D2 与 D3 仍然自相矛盾，且与“不部署公网”的调子冲突（P0，未修复）**

- v2.1 §1.3 原文：D2“禁止对公网暴露监听端口……含 5758、5859”；D3“执意使用仅允许只读大屏（5859）”。同一节里 5859 既禁止又放行。
- 与用户定调冲突：定调是“执意部署公网/云，后果自负”，不是“允许只读大屏走公网隧道”。§11.3/§4.3 限制大屏访问设备接口只能降低风险，不能消除“公网可达”的事实；现有大屏还会转发 `/api/settings` 与 `/api/station/state`，会泄露站名、操作员与 `n1mmToken`。
- 建议：删除 D3 的 5859 例外，统一为“所有端口都不做公网映射/隧道”；远程访问只保留 §1.3 末尾的“用户自建 VPN”，并明确 VPN 属用户基础设施、项目不提供。

**(2) D4 示例代码仍不可实现（P0，未修复）**

- v2.1 §1.3 的片段与 v2.0 相同：`normalize()`、`inRange()` 仍未定义，`PRIVATE_RANGES` 仍是字符串数组。
- 未处理 `::ffff:192.168.1.5` 映射地址；未解析 IPv6（`fc00::/7`、`fe80::/10`、`::1`）；不含 `100.64.0.0/10`（CGNAT，常见于 4G/5G 上行）。
- **反代失效**：`req.socket.remoteAddress` 在 nginx/Caddy 后面恒为 `127.0.0.1`，D4 会无条件放行；而 D3 又讨论反向代理/隧道，说明这个部署形态现实存在。
- §9.1 写“无论是否已部署在公网”，但没有给出可执行的判定算法、代理头处理策略与测试方法；§15 的验收“部署于公网主机时返回 403”既与 D1 冲突，也不是安全的测试方式。
- 建议：把判定做成单一服务端函数并单测（本仓库工作区已有 `scopeOfAddress()` 可复用）；只信任 socket 地址，检测到 `X-Forwarded-For`/`Forwarded` 直接 403；用注入地址的单元测试替代“真去公网部署”。

### 18.5 控制安全逐项确认（有没有、够不够）

| 项 | 文档有没有 | 够不够 | 说明 |
|---|---|---|---|
| 冲突锁 | 有（§3.4） | **基本够** | device/port 级租约、30s、409 + 持有者、急停例外；缺长动作续租（D19） |
| 超时 | 有（§9.4） | **不够** | “超时 N 秒”未给默认值；ack 超时与回读超时未分开；未定义超时后的指令状态（unknown？failed？） |
| 断线重连 | 有（§6.2、§7.4） | **够** | 心跳/keepalive、指数退避+抖动、半开检测、重连后强制全量 readState；缺进程重启后的锁与指令恢复（D32） |
| 状态回读 | 有（§9.4） | **基本够** | 回读与目标比对、写 device_state；缺回读失败的重试上限与降级显示 |
| 失败回滚 | 有（§9.4） | **不够** | “回读 last-known-good”与 §6.2“丢弃旧状态”冲突（D21）；未定义 last-known-good 的存储位置与可信时间 |
| 幂等/去重 | 部分（§9.4） | **不够** | 只说“带 seq、at-most-once”；无 commandId、去重窗口、重复请求返回语义（D20） |
| 急停 | 有（§9.3） | **基本够** | 不受租约限制，但仍受离线拒绝；需明确“离线时急停”如何处置（硬件回路兜底） |
| 限位 | 有（§9.3/§9.5） | **基本够** | 软件按 `read_limit` 拒绝；硬件终端限位/急停写入用户文档；缺运行超时告警与二态确认 |
| 发射互锁 | **部分恢复（§19.6/§22）** | **天线切换够；旋转器不需要** | 仅天线切换/矩阵 OUT 在 TX 上报源 active 时拒绝；旋转器不做发射判定；N1MM 状态只显示/弱提示 |
| 速率限制 | 有（§9.3） | **基本够** | 每设备 ≥500ms、每席位 20 次/分；缺突发/令牌桶与拒绝后的重试提示 |
| 审计 | 有（§8.3、§9.6） | **基本够** | 字段齐全（含 IP/seat/operator/result）；缺保留期、只追加的数据库级保证、读取权限 |
| 权限 | 有（§3.3、§11.1） | **基本够** | 席位身份 = ComputerName+RadioName+RadioNr，显式配置优先；请求用 `X-DX-Seat`（D18 关闭）；仍需 group 表（D22） |

### 18.6 协议清单与现场部署成本

| kind | 现场前提 | 依赖 | 成本/风险 | 结论 |
|---|---|---|---|---|
| tcp-raw | 串口服务器网段可达、固定 IP、串口参数在设备侧设好 | Node `net` | 低；需处理分帧与半开连接 | 可行，首选 |
| tcp-server | 设备主动连服务器，需固定监听端口与防火墙规则 | `net` | 低；端口管理需纳入部署文档 | 可行 |
| udp | 设备支持 UDP 透传 | `dgram` | 中；无连接、丢包，不适合塔 | 可行但限只读/低风险 |
| tcp-modbus | 厂商寄存器表可得 | 新增 `modbus-serial` | 中；寄存器映射随厂商不同，离线装机需预打包 | 可行，P2 |
| http | 设备提供 REST | 内置 fetch | 低；凭据管理是重点 | 可行 |
| mqtt | 现场有 broker | 新增 `mqtt` + broker | 中；多一个故障点 | 可行，P2 |
| ws | 网关提供 WebSocket | 内置 | 低 | 可行 |
| hamlib-rotctld | **另需一台机器运行 rotctld** | `net` | 低（协议简单）；但多一个进程/主机 | 可行，旋转器首选；部署归属已写明（§6.3） |
| hamlib-rigctld | 同上 | `net` | 与 C6“排除电台本体”冲突 | **建议删除或标注仅诊断**（D27） |
| tcp-telnet/RFC2217 | 串口服务器支持 IAC 协商 | 自实现 | 中高 | P2，默认不做 |

依赖结论与 §12.2 一致：除 `modbus-serial` / `mqtt` 外均用 Node 内置；离线安装要预打包。

### 18.7 数据、凭据与现有表的关系

| 新表 | 与现有实现的关系 | 缺口 |
|---|---|---|
| `devices` | 纯新增；配置不再进 `uiSettings` | `capabilities`/`ports` 为 TEXT，无 schema 校验；与驱动声明重复（D28） |
| `seats` | 新表；替代 `settings.seatCount/operators` 的运行时来源 | 无 `owner_type`/`group_id`，group 模式无法落库（D22）；`station_map` 无唯一约束（D30） |
| `device_bindings` | 新表，端口粒度 | 单端口设备无 port_id 约定（D29）；无外键/级联规则 |
| `device_state` | 与 `radio_state` 分离，正确 | 只存最新值；last-known-good 与“丢弃旧状态”的关系未定（D21） |
| `device_commands` | 与 `operator_sessions` 关联（operator 快照） | 未给具体保留期；仅 UI 层禁止删除，无数据库级 append-only 约束 |
| `device_samples` | 新表，历史曲线 | 无默认采样率/保留期；32 台 × 500ms ≈ 550 万行/天（D25） |

凭据：§8.4 要求 AES-256-GCM + 前端掩码 + 不写日志/WS/错误，方向正确；但**密钥放哪、如何轮换/备份/重装恢复**仍未定（D23），这是实现前必须拍板的。

### 18.8 实时性与现有架构的匹配

- **匹配的部分**：§11.2 的 6 个 WS 事件与现有 `/ws` 广播方式一致；§10.1 要求 store 差分、禁止全量重绘，正好对应现有 `renderBottom` 10s 全量重绘的问题；§5.1 把前端收口到 `shared/core`，与仓库架构测试一致。
- **需要注意的容量点**：§7.4 允许 500ms 轮询，§13 要求 32 台设备 → 理论上 64 次请求/秒，叠加 `device_samples` 落库会与现有 spot/QSO 写入竞争；SQLite 只有一个库文件。
- **Node-RED 生命周期**：文档仍未定义进程重启/流程 redeploy 时长连接、租约、在途指令如何收尾（D32）。
- **结论**：设计方向与现有架构匹配，风险集中在采样/写入预算与进程生命周期，不构成架构性冲突。

### 18.9 验收标准是否可执行

§15 的十条大多可测：席位越权、409 + 持有者、审计字段、凭据不外泄、无回归、M2 布局。**“发射互锁”验收恢复，但只针对天线切换/矩阵 OUT（§22.9）**；旋转器不做发射拦截。需要修正的：

| 验收项 | 问题 | 建议 |
|---|---|---|
| “部署于公网主机时写接口返回 403” | **已作废（§19.7）**：新口径不做任何来源拦截，该验收项不再存在 | 删除；不再要求公网部署或 403 |
| “拔网线 10s 内卡片转红” | 与 §7.4“3 × pollInterval”判定未对齐（poll=1s 时约 3s，poll=8s 时 24s） | 明确取 `max(10s, 3×pollInterval)` 并写进验收 |
| “连续 72h 无内存增长异常” | 无阈值 | 给出允许增长上限（如 RSS 漂移 <10%） |
| “≥32 台设备稳定运行” | 未定义轮询周期与采样频率的组合 | 给出“32 台 × 1s 轮询 + 10s 采样”的基准场景 |
| “RUN 只能操作 IN1” | 缺少席位身份传递方式，无法判定请求属于谁 | 按已定 seatId（ComputerName+RadioName+RadioNr）用 `X-DX-Seat` 传递，再写验收（D18 关闭） |

### 18.10 新问题清单（接 D16 之后）

| 编号 | 章节 | 问题 | 严重程度 | 建议改法 |
|---|---|---|---|---|
| D17 | §9.3 发射互锁 | **第七轮最终：恢复“发射中禁止切换天线/矩阵 OUT”**；状态源改为通用上报接口（用户自研设备，优先级可配），不是 N1MM；旋转器不在范围内 | **P0（仅天线切换）** | 按 §19.6/§22 实现：`TX_ACTIVE` 直接拒绝、无二次确认；无源按 §22.5.1 提示，源超时/失效按 O6 降级 |
| D18 | §11.1、§3.3、§15 | 没有定义“请求属于哪个席位” | **已关闭（用户确认）** | 席位身份 = `ComputerName + RadioName + RadioNr` 组合；显式配置为最高优先级覆盖；请求用 `X-DX-Seat` 携带该组合值，服务端对照 `seats` 校验。仅用于操作归属/灯色投影，**不是安全边界** |
| D19 | §3.4、§9.3 | 租约 TTL 30s 与长动作冲突：升降塔/旋转可能超过 30s，租约中途过期后另一席位可下发反向命令 | **P1** | 租约绑定指令生命周期（执行期内自动续租，终态释放）；或 busy 期间禁止换主；明确过期后的处理（保持/急停） |
| D20 | §9.4 | 只有“seq + at-most-once”，缺 commandId、去重窗口与重复请求语义；ack 丢失后浏览器重试，操作员无法知道指令是否已执行 | **P1** | 客户端生成 commandId（UUID），服务端在 ≥timeout 的窗口内去重并返回首次结果；定义 `unknown` 终态与查询方式 |
| D21 | §6.2 vs §9.4 | “重连后丢弃旧状态，不得展示陈旧数据”与“失败回滚到 last-known-good，UI 覆盖为目标状态”冲突；旧值可能被当成已确认状态 | **P1** | last-known-good 必须带 `verified_at` 并在 UI 标“未确认”；重连后首次全量 readState 覆盖；禁止把缓存值显示为目标值 |
| D22 | §8.3、§3.3、§4.2.1 | `seats` 表只有 seat_id/display_name/station_map/created_ts，没有 `owner_type`/`group_id`；group 归属与页面上的“归属类型”列无法落库 | **P1** | 增加 `owner_type` 与 `seat_groups`/`seat_group_members` 表；`device_bindings.mode` 与 group 的引用规则写清 |
| D23 | §8.4、§17 | 凭据加密只说“建议机器密钥 + AES-256-GCM”，密钥位置/轮换/备份/重装恢复未定；实现时极易退化为硬编码密钥 | **P1** | 明确密钥文件路径与权限（0600、服务用户）、`DX_DEVICE_KEY` 覆盖、轮换与备份流程；禁止由主机名派生 |
| D24 | §9.1、§11.3 | net-guard 只保护设备写接口；`/red` 无鉴权、`/ws` 无鉴权且广播 settings（含 `n1mmToken`）、大屏转发 `/api/settings` 与 `/api/station/state`。文档称“权限”但未覆盖这些面 | **P1** | 明确“内网 ≠ 可信”：编辑器加 `adminAuth` 或仅本机；`/ws` 校验 Origin；settings 广播剔除令牌；把残余风险写进威胁模型 |
| D25 | §8.3、§13 | `device_samples` 无默认采样率、保留期与降采样；32 台 × 500ms 约 550 万行/天，与 SQLite 单库及 72h 稳定性目标冲突 | P2 | 默认采样 5–10s、保留 7–30 天、按 1 分钟聚合；批量写；给出容量估算 |
| D26 | §11.1 | `POST /api/devices/import export` 路由不合法；`428_LOCKED` 语义不对（428 是 Precondition Required，锁定应为 423）；`GET .../operations` 无来源限制 | P2 | 修正为 `/api/devices/import`、`/api/devices/export`；统一错误码表；审计读取仅内网 |
| D27 | §6.3 vs C6 | `hamlib-rigctld` 作为设备接入方式，与“排除电台本体控制”冲突，容易被理解为可做 CAT/PTT | P2 | 删除，或明确“仅用于非电台设备的诊断，禁止 PTT/CAT 写” |
| D28 | §8.3 vs §7.1 | `devices.capabilities`（DB）与驱动 `capabilities` 两个来源，运行时以谁为准未写 | P2 | 驱动声明为唯一权威，DB 只存快照；加载时校验不一致即告警 |
| D29 | §8.3、§4.2.3 | 单端口设备（旋转器/塔/TX 上报）没有端口定义，但 `device_bindings` 主键要求 `port_id` | P2 | 约定虚拟端口 `main`，或允许 `port_id` 为 NULL 并加唯一索引；在 §4.2.3 写明 |
| D30 | §8.3、§4.2.1 | `seats.station_map` 无唯一约束，两个席位可映射同一个 N1MM station，操作员归属会产生歧义 | P2 | 加唯一索引（允许 NULL），冲突时拒绝保存并提示 |
| D31 | §15、§13 | 验收“公网主机 403”不可安全执行；“32 台”没有轮询/采样组合的基准 | P2 | 用注入 socket 地址的测试替代公网部署；给出基准场景与容量表 |
| D32 | §12、§16 | Node-RED 重启/流程 redeploy 时长连接、租约、在途指令的收尾未定义；回滚方案只写了 `devices.enabled=false` | P2 | 写明启动重连、租约释放、在途指令置 `unknown` 并提示；增加重启恢复测试 |

> 说明：D17 第七轮恢复为 **P0（仅天线切换/矩阵 OUT，通用 TX 上报接口）**；D18 已按“ComputerName+RadioName+RadioNr，显式配置优先”关闭；D19–D24 是会导致返工或权限模型失效的 P1；D25–D32 是可后置但不写清会踩坑的 P2。

### 18.11 建议实施顺序（按“仅内网”前提重排）

与 §16 的分期相比，调整原则是：**先证明身份与只读链路，再开放任何写操作；先做矩阵与旋转器，塔最后做。天线切换做 TX 上报互锁，旋转器不做。**（本表已被 §22.8 的最终顺序取代）

| 阶段 | 内容 | 进入下一阶段的条件 |
|---|---|---|
| Phase 0（文档/设计） | 修 D2/D3 口径、D4 可执行算法、D22 group 表、D19/D20/D21 状态语义、D23 密钥方案、Q13 迁移映射（D18 已关闭） | 每条都有明确字段/接口/默认值，验收可写 |
| Phase 1（只读） | `lib/devices/` 骨架、Transport（tcp-raw/tcp-server/udp）、`devices/seats/device_state/device_samples`、probe、只读卡片、设置页席位与设备清单 | `devices.mode=monitor` 下 32 台稳定；断线/重连/在线判定符合 §7.4；无任何写接口 |
| Phase 2（身份 + 指令骨架） | `X-DX-Seat` 校验、lease、audit、commandId 去重、状态机、WS 回执 | 越权 403、409 + 持有者、原子审计、重启恢复可测 |
| Phase 3（低风险写） | rotctld 旋转器闭环 + 回读 + 超时 + 回滚语义 | 点击到转动 ≤2s；断线不误报；last-known-good 标注“未确认” |
| Phase 4（矩阵/天线切换） | 端口绑定矩阵、`select_port`、占用冲突 409、**TX 上报互锁**（仅天线切换） | TX 上报源 active 时切换被拒；IN/OUT 越权 403；冲突告警 |
| Phase 5（塔） | 塔二态（展开/收回）+ 脉冲自锁 + 运行超时告警 + 双人确认 | 终端限位/急停验收通过；超时告警；所有动作可追溯 |
| Phase 6（扩展） | Modbus/MQTT、声明式 DIY、raw 调试、采样保留与降采样、大屏只读扩展 | 新增类型不改核心；采样容量达标；raw 仅内网且审计 |

### 18.12 第三轮结论

- **文档现在具备实施条件**：协议矩阵、驱动契约、六张表、设备占用规则、指令生命周期、接口与验收都已成文，架构与现有仓库（`lib/` 分层、`shared/core` 出口、SQLite、`/ws`）基本对齐。
- **P0 = D17（仅天线切换互锁）**（**此判断经第七轮最终修正**）：D2/D3 已关闭、D4 已作废；D17 恢复但范围缩到天线切换/矩阵 OUT；最新结论见 §22.11。
- **6 个 P1 集中在“状态语义与权限”**：租约与长动作（D19）、幂等（D20）、陈旧状态（D21）、group 表（D22）、密钥管理（D23）、内网威胁面（D24）；席位身份（D18）已关闭。
- **§17 的 14 条**：2 条关闭（Q5/Q12）、6 条基本关闭（Q3/Q4/Q6/Q7/Q8/Q9）、4 条部分关闭（Q1/Q2/Q10/Q11）、2 条未关闭（Q13/Q14）。实现前需要补齐的是：D19–D24，以及 Q1 的能力注册表、Q2 的 GS-232 帧格式、Q10 的验收阈值、Q11 的版面定稿、Q13 的字段迁移（Q14 已关闭；D18 已关闭）。
- **本轮未改任何代码**；工作区里此前的部署边界改动仍保持未提交、未部署、已冻结，等待用户决定。

---

# 第四轮评审（用户补充口径修订）

> 本节依据用户 2026-11-12 补充的两组口径：**设备树 + 波段自动归属 + 灯色语义**，以及**不做任何网络拦截、只做提醒**的部署边界。与 §18 冲突处一律以本节为准；被作废/关闭的旧结论见 §19.8。

## 19.1 新口径摘要

- 设备是**树形**：所有设备共用一张表、一个 `parent_id`，**任何类型都可父可子**；塔→旋转器→天线、塔→天线→旋转器、一台旋转器挂多副天线都能表达（示例，不是类型限制）。
- **天线必须配置波段**；OP 把电台切到某个波段时，该波段对应的天线**自动归属到当前席位**。
- 多席位共用设备的灯色**相对当前席位**：**红 = 本席占用；黄 = 他席占用（繁忙）；绿 = 空闲**。
- 适用于任意 **n×n 天线矩阵**和类似共用设备；**1×n 切换开关除外**（独占通路，无共享冲突）。
- 部署：**不做网络拦截、不判断是否公网**；部署位置由用户决定，项目只做提醒与免责，默认按内网环境开发。

## 19.2 设备树模型（本轮新增）

### 19.2.1 统一节点模型（第六轮定稿）

**不按设备类型限定父子关系**：所有设备共用一张表、一个 `parent_id`，任何类型都可以当父、也可以当子。以下结构都能直接表达，不需要特例：

```text
塔 → 旋转器 → 天线
塔 → 天线 → 旋转器
旋转器 → 天线 A
        ├── 天线 B
        └── 天线 C
```

| 节点 | 关键属性 | 父子角色 |
|---|---|---|
| `tower` | **二态（`erected`/`retracted`）+ `moving`/`fault`/`unknown`/`offline`**、上限位/下限位 | 可父可子（通常为父） |
| `antenna` | **必填波段**（一个或多个）、端口/矩阵出口、**`install_offset_deg`（0–359）** | 可父可子 |
| `rotator` | 方位角、目标、范围 | **可父可子**；作为父时可带多副天线 |
| `matrix` / `switch` | n×n 路由表、端口 | 可父可子；只对 n×n 应用共享占用，1×n 例外 |

只保留三条约束：

1. **单父**：每个设备至多一个 `parent_id`，因此是树不是图；多父问题自动消失，不需要“禁止旋转器多父”的类型规则。
2. **无环**：保存/移动节点时沿父链检测，遇到自己即拒绝。
3. **删除策略**：**建议禁止删除有子设备的节点**，先移走或删除子树；备选是级联软删除（需要 `deleted_at` 与恢复策略）。一期采用“禁止删除”，实现最简单。

**旋转器解析**：某副天线当前受哪台旋转器控制，从该天线沿 `parent_id` 向上找**最近的 `type=rotator` 祖先**；找不到则视为**手动/固定指向**。不再按“塔只能装旋转器/天线只能挂旋转器”的类型规则推导。

**校验降级**：设备类型校验从“类型组合白名单”降为“仅单父 + 环检测 + 删除策略”，原先为类型组合准备的多余校验项删除。

### 19.2.2 与“波段”的绑定

- 波段是**天线**的属性，不是席位的属性；同一副天线可配置多个波段（如三波段八木）。
- 一个波段可以对应多副天线（例如 20m 同时有八木和 DP），这时必须有**优先级/选择策略**，否则“按波段自动归属”不唯一（见 D38）。
- 波段标识必须与现有 N1MM 解析出的波段一致（仓库已有 `band` 字段），避免再做一套映射。
- 天线未配置波段视为**配置无效**，不能在矩阵/卡片中启用。

### 19.2.3 归属是“派生状态”，不是静态绑定

v2.1 的 `device_bindings` 是静态绑定（device/port → seat）。新模型下，天线的归属由**当前席位的波段 + 天线波段 + 矩阵路由**推导出来，会随操作变化。建议区分两层：

| 层 | 内容 | 存储 |
|---|---|---|
| 配置层 | 树、波段、安装偏移、矩阵端口、席位清单 | SQLite（`devices.parent_id`、`antenna_bands`、`antennas.install_offset_deg`、`matrix_routes`） |
| 运行层 | 当前席位 → 当前 OUT/天线、自动/手工来源、占用集合 | 内存状态 + 快照；必要时落 `seat_assignments` |

只靠 `device_bindings` 无法表达“切波段后自动改归属”，这是与 v2.1 的核心模型差异（D33）。

## 19.3 自动归属流转

触发源：当前席位的 N1MM `radio_state` 波段变化（现有 ingest 已解析 band）。

```text
席位 S 的波段从 B0 变为 B1
  → 查 B1 对应的天线/OUT 集合（按优先级取一个）
  → 该资源当前占用者是谁？
      空闲（绿）        → 归属 S，释放 S 在 B0 的自动归属；S 侧显示红
      本席占用（红）    → 保持不变
      他席占用（黄）    → **不抢占**：保持原路由，提示“该天线正被席位 X 占用”，占用关系与灯色都不变
      无匹配天线        → 保持原路由，提示“波段 B1 未配置天线”
  → 写审计（自动变更也要记录）
  → WS 推送 seat_scope 的归属变化
```

需要同时定义的规则（v2.1 没有）：

1. **自动 vs 手工优先级**：手工选过天线后，切波段是否覆盖手工选择？建议每席位一个 `AUTO/MANUAL` 模式，MANUAL 下只提示不自动改。
2. **释放时机**：离开波段即释放，还是保留到下一次占用？建议立即释放自动归属，手工锁定除外。
3. **同波段多席位**：两席位同波段共用一副天线时，两人都显示红（共享），不产生黄；切换仍受**TX 上报互锁**（仅天线切换，§22）；N1MM 状态只显示/弱提示。
4. **审计**：自动归属变化必须能追溯到“因为波段变化”，而不是被当成人工操作。

## 19.4 灯色状态机与共享占用判定

### 19.4.1 状态定义

灯色不是设备的全局属性，而是 **`f(当前席位, 资源)`** 的投影：

| 条件 | 灯色 | 含义 |
|---|---|---|
| 资源的占用集合包含当前席位 | **红** | 本席占用 |
| 占用集合非空，且不包含当前席位 | **黄** | 他席占用（繁忙） |
| 占用集合为空 | **绿** | 空闲 |

因此同一副天线可能同时是“席位 1 的红”和“席位 2 的黄”。服务端要么按请求席位计算后返回，要么 WS 推送占用集合、由前端按当前席位投影；**不能只推一个全局颜色**。

### 19.4.2 用户给出的 M2 2×4 示例（原文复现）

矩阵：OUT1=20m 八木、OUT2=15m 八木、OUT3=10m 八木、OUT4=40m 八木；席位 1 用 OUT2，席位 2 用 OUT3。

| 资源 | 席位 1 界面 | 席位 2 界面 |
|---|---|---|
| ANT1（20m） | 绿 | 绿 |
| ANT2（15m） | **红**（本席） | **黄**（他席） |
| ANT3（10m） | **黄**（他席） | **红**（本席） |
| ANT4（40m） | 绿 | 绿 |

### 19.4.3 占用判定

- **占用集合** = 所有“当前路由指向该 OUT/天线”的席位，包含自动归属与手工选路。
- n×n 矩阵：两个 IN 指向同一 OUT 时，该 OUT 的占用集合有两人；双方都显示红，同时必须有冲突提示（不建议静默共享）。
- 旋转器/塔不是“多席位共用端口”，其占用按**当前租约/正在执行的动作**判定：有他席租约 → 黄；本席租约 → 红；无 → 绿。
- 灯色只表达占用，不表达设备健康；v2.1 的绿/黄/红健康灯与新语义冲突，必须拆成两个视觉通道（见 D35）。

## 19.5 1×n 例外

- 1×n 切换开关是**独占通路**：同一时刻只有一个席位/电台使用，不存在两个席位争同一输出。
- 因此 **1×n 不套用 §19.4 的共享占用判定**：不产生黄灯，只有本席的红/绿；也不做“他席占用”拒绝。
- **仍受租约与发射互锁约束**：1×n 只是不受“共享冲突”规则约束；它仍属于天线切换，发射中（TX 上报源 active）一律禁止切换（§19.6）。
- 若 1×n 被配置成多席位共用（一个切换器接多台电台），则它实际上是 n×1 共用设备，应按 §19.4 处理，不能享受例外。

## 19.6 D17（最终口径）：**发射中禁止切换天线 / 矩阵 OUT**（P0）

> **第七轮最终口径，第十三轮修订**：恢复天线切换互锁；**范围仅限天线切换与 n×n 矩阵 OUT 切换**。旋转器、塔不做任何发射判定（见 §22.3、§20.6）。发射状态源改为**通用上报接口（用户自研设备）**，不是 N1MM，也不是本项目内置的某型设备驱动。

**规则**：

```text
收到天线切换/矩阵 OUT 切换指令 S
  解析该指令影响的射频路径（源 IN + 目标 OUT + 相关天线）
  tx = pick_tx_source(路径)          // 按用户在设置中配置的源优先级选取
  若 tx 可用且 tx.tx_active == true：
      拒绝，返回 423 Locked（code: TX_ACTIVE）；不提供二次确认放行；审计记录
  若 tx 不可用（未接入/超时/中断/异常）：
      按 O6（已确认）：移除该源、显示“与设备通信中断”或“未接入发射状态源”、允许切换、审计；见 §22.5
  否则放行
```

**边界**：

- **包含**：天线切换器、n×n 矩阵的 OUT 选择；1×n 切换器也属于天线切换，因此同样受此互锁（1×n 只豁免“共享占用冲突”，不豁免发射互锁）。
- **不包含**：旋转器转动（§22.3 明确允许边转边发）、塔升降、电源/功放等非射频路径切换。
- **不做**：不再按“占用集合里谁的 `is_transmitting`”推导；不再用 N1MM 状态作为互锁源；不再扩展到旋转器子树。
- 租约、归属（黄灯不抢占）、限位、急停仍按原规则独立生效；本互锁只是在原流程前多加一道 TX 上报判定。

**为什么这次能做**：发射状态由**用户自研设备**通过通用入口上报二元值，不是软件推断；本项目只接收与判定，不实现检测装置。N1MM 的 `is_transmitting` 仍只用于显示与弱提示。

## 19.7 部署边界定调修正

### 19.7.1 新口径

不做任何网络拦截、不做是否公网的判断；用户部署在哪里由用户决定；项目只做提醒与免责；默认按内网环境开发。

### 19.7.2 D2 / D3：由用户定调关闭

| 旧结论 | 新状态 | 理由 |
|---|---|---|
| D2 禁止暴露 5758/5859 | **关闭** | 新口径不做拦截 |
| D3 允许只读大屏走公网隧道（与 D2 矛盾） | **关闭（矛盾消失）** | 既然不禁止任何暴露，就不存在“例外”；改为统一提醒 + 免责 |
| §18.4(1) 把 D2/D3 列为 P0 | **作废** | 不再要求禁止暴露，也不再要求 5859 限制 |

保留：README / 安装输出 / 设置页/首次使用的**提醒与免责文案**。文案措辞建议从“禁止/不要”改为“不建议/不受支持，后果自负”，与新口径一致。

### 19.7.3 D4：整条作废

以下内容全部不再需要，也不应作为验收项：

- `normalize()` / `inRange()` 的实现；
- `::ffff:` 映射地址、IPv6（`fc00::/7`、`fe80::/10`）、CGNAT `100.64.0.0/10` 的判定；
- 反向代理下 `remoteAddress` 的处理、`X-Forwarded-For` 策略；
- /api/devices/* 的 403 来源校验；
- §15 的“部署于公网主机时返回 403”验收。

理由：新口径明确不做网络层拦截与公网判断；这些代码即使实现，也只会造成“假安全”和维护负担。

### 19.7.4 工作区旧改动：需撤掉或改造（未执行）

这些改动是上一轮按“默认回环 + 暴露面收敛”做的，与新口径不符。**本轮不撤销**，仅列清单与影响，等用户决定。

| 文件/改动 | 现状 | 与新口径的关系 | 建议处置 |
|---|---|---|---|
| `settings.js` 默认 `127.0.0.1`、`DX_LISTEN_HOST`、启动告警、`DX_RESOLVED_HOST` | 未提交 | 默认回环属于“行为限制”，不是提醒 | 恢复原默认监听；删除启动告警与 `DX_RESOLVED_HOST` |
| `lib/deployment/exposure.js`、`lib/deployment/index.js`、`lib/index.js` 的 `deployment` 导出 | 未提交（新增） | 暴露面检测/判断，明确不做 | 删除 |
| `flow.json` `GET /api/system/exposure` 三个节点 | 未提交 | 同上 | 删除 |
| `public/shared/data/system.mjs` | 未提交（新增） | 同上 | 删除 |
| `public/index.html` `#deployNotice`、`settings-page.mjs` 提示逻辑、`style.css` 样式、`i18n.js` 的 `deploy.*` 11 组键 | 未提交 | 属于“状态提示”，可保留也可删；它依赖 exposure API | 若保留提醒，改为静态文案/不依赖 API；否则全部删除 |
| `tests/deployment-exposure.test.js` | 未提交（新增） | 测试的是被作废的判定 | 删除 |
| `bigscreen/server.js` 默认 `127.0.0.1` + 警告 | 未提交 | 默认回环是行为限制 | 恢复默认监听；日志提醒可保留 |
| `install.sh` 两个 unit 的 `DX_LISTEN_HOST=127.0.0.1`、`BIGSCREEN_HOST=0.0.0.0` | 未提交 | 强制监听地址属于实现层限制 | 删除这两行；**保留**结尾的中英文提醒/免责 |
| `README.md` 部署边界章节 | 未提交 | 提醒/免责保留；但“默认只监听 127.0.0.1”“必须 DX_LISTEN_HOST”与新口径不符 | 保留免责段落；删除默认回环与强制环境变量的说明，改回正常访问方式，措辞改为“不建议/不受支持” |

**影响**：若按现状提交，局域网用户默认无法访问（与“部署在哪由用户决定”冲突），并多出一套不被支持的暴露面 API 与测试；建议在设备模块动工前先清理。

## 19.8 旧结论作废 / 关闭清单（施工前必读）

| 旧结论 | 位置 | 新状态 | 原因 |
|---|---|---|---|
| D2 禁止公网暴露 5758/5859 | §18.4(1)、§18.10 | **关闭（用户定调）** | 不做拦截 |
| D3 只读大屏可走公网隧道（与 D2 矛盾） | §18.4(1) | **关闭（矛盾消失）** | 不禁止任何暴露，无需例外 |
| “D2/D3 是 P0 待修” | §18.4、§18.12 | **作废** | 同上 |
| D4 地址校验、`normalize`/`inRange`、IPv6/CGNAT、反代、403 | §18.4(2)、§18.10、§18.9 | **整条作废** | 不做网络判断与拦截 |
| D17“只检查绑定席位的发射状态” | §18.5、§18.10 | **第七轮最终：恢复（仅天线切换）** | 状态源改为通用上报接口（用户自研，优先级可配）；旋转器不做；不再按“绑定席位”或 N1MM 判定（§19.6/§22） |
| “§18.12 仍有 3 个 P0” | §18.12 | **失效** | D2/D3 关闭、D4 作废；D17 第六轮曾取消、第七轮恢复（仅天线切换），当前 P0 = D17 |
| Q14（D2/D3 口径）待确认 | §18.3 | **关闭** | 用户已定调 |
| D24 建议“加 adminAuth / 仅本机” | §18.10 | **降级为提醒** | 新口径不做强制拦截；保留 README 风险提示即可 |
| “部署边界默认回环”相关评审与改动 | §14、§18 | **需撤/改** | 与“部署在哪由用户决定”冲突 |
| 设备模型：扁平 Entity + 静态 `device_bindings` | §3、§4.2.3、§8.3 | **被树形 + 自动归属取代** | 见 §19.2/§19.9 |

## 19.9 v2.1 设备模型与新模型的冲突点

| # | v2.1 原文 | 新模型 | 冲突性质 |
|---|---|---|---|
| M1 | 设备是扁平实体（`devices` 无 `parent_id`） | 塔/天线/旋转器是树 | **数据模型不兼容**（D33） |
| M2 | `antenna` 不是设备类型；矩阵的 OUT 只是“天线/station/group”标签（§4.2.3） | 天线是一等设备，必须配波段、可挂旋转器 | **模型缺一层** |
| M3 | `device_bindings` 静态绑定 seat（§8.3） | 归属随当前波段自动流转 | **静态 vs 动态**（D34） |
| M4 | §4.2.3 只要求“检测并告警”两席位争同一 OUT | 红/黄/绿占用状态机 + 自动归属 | **只告警 vs 状态机**（D35） |
| M5 | §7.4/§10.1 用绿/黄/红表示**设备健康** | 绿/黄/红表示**席位占用** | **同一视觉语言两套含义**（D35） |
| M6 | 没有 1×n 例外 | 1×n 不适用共享规则 | **缺例外**（D36） |
| M7 | 塔/旋转器/矩阵的层级与命令作用域未定义 | 塔命令作用于子树；旋转器挂在塔或天线 | **缺树形语义**（D37） |
| M8 | 没有“波段→天线”的配置与优先级 | 天线必须配波段，可能多对多 | **配置模型缺失**（D38） |
| M9 | `device_bindings(device_id, port_id, seat_id, mode)` | 自动归属需要 `seat_assignments` / 运行态 | **表结构不足** |
| M10 | WS `devices.state` 是全局状态 | 灯色是 `f(当前席位, 资源)` | **推送需按席位投影**（D35） |

## 19.10 新问题（接 D32 之后）

| 编号 | 章节 | 问题 | 严重程度 | 建议改法 |
|---|---|---|---|---|
| D33 | §8.3、§4.2.3 | 数据模型没有 `parent_id`、`bands`、树约束；塔/天线/旋转器的层级无法落库 | **P1** | `devices` 增 `parent_id`、`node_role`；新增 `antenna_bands(device_id, band, priority)`；应用层校验单父/无环 |
| D34 | §3.3、§8.3 | 自动归属（切波段→改天线）没有规则表/运行态；静态 `device_bindings` 无法表达；手工选路与自动归属的优先级未定（与“黄灯不抢占”是两件事） | **P1** | 新增 `seat_assignments(seat_id, resource_id, source, since)`；定义 AUTO/MANUAL、释放与覆盖规则 |
| D35 | §7.4、§10.1、§11.2 | 灯色语义冲突：v2.1 绿/黄/红是健康，新模型是占用；占用状态机与按席位投影缺失；WS 只推全局状态 | **P1** | 拆分“健康点”和“占用色”两个通道；服务端按 `seat` 计算或推占用集合；定义同波段共享（双红） |
| D36 | §4.2.3 | 没有 1×n 例外；把共享规则套到 1×n 会产生不存在的黄灯/拒绝 | P2 | 在设备类型/路由配置里标记 `exclusive`；1×n 跳过占用冲突判断，但**仍受天线切换的发射互锁** |
| D37 | §9.3、§9.5 | 树形命令作用域未定义 | **已解决（设计确认）** | 统一为“命令作用域 = 子树”；旋转器按最近 `rotator` 祖先解析；不再区分“挂塔/挂天线”；原“是否必须停发”随“塔不做发射判定”而删除 |
| D38 | §4.2.3、§7.3 | 波段→天线可能是多对多；无优先级、无“该波段无天线”的降级规则 | P2 | `antenna_bands` 带优先级；无匹配时保持原路由并提示；禁止静默选第一副 |
| D39 | §11.1、§11.2 | 归属与灯色需要“当前席位”才能计算；席位身份已定义（D18 已关闭：`ComputerName + RadioName + RadioNr`），`X-DX-Seat` 只承载该组合值 | **已关闭（随 D18）** | `X-DX-Seat` 仅用于归属/灯色投影；写操作仍按设备口令 + 租约；不要把它包装成鉴权 |

## 19.11 黄灯规则（已确认：不抢占）

**规则：自动归属遇到黄灯（他席占用）时，不允许抢占。** 这是设备占用判定的明确规则，不是待定策略。

| 场景 | 系统行为 |
|---|---|
| 席位切到某波段，该波段的天线正被他席占用 | **不做占用转移**，不打断对方操作；只在界面提示「该天线正被席位 X 占用」 |
| 占用关系 | **保持不变**；本席看到的仍是黄灯，对方仍是红灯 |
| 本席可选动作 | 等对方释放；改用其他空闲天线；由人协调后再切 |
| 超时 | **不设**超时自动抢占 |
| 优先级 | **不设**优先级强制抢占 |
| 管理员 | **没有例外通道**，与普通席位走同一路径 |
| 对方释放后 | 天线转为绿灯；**建议**不做追溯补占，等待席位在下一次选路/波段事件中按绿灯规则正常归属（避免多席位等待时产生新的竞态） |
| 审计 | **建议**记录“自动归属被拒（占用者=X）”，便于事后说明为什么没切过去 |

补充：

- 该规则只约束“自动归属”，不改变写操作的租约语义：即使目标已变绿，手工切换仍要拿租约，并受**天线切换的 TX 上报互锁**约束（§22）。
- 黄灯状态下的手工切换请求：若对方仍占用，返回冲突并显示占用者；对方释放后才可成功。没有“强制覆盖”参数。
- 同波段共享（两人都红）不属于黄灯抢占场景，按 §19.4.3 的共享规则处理。

## 19.12 实施顺序（按树形模型重排）

| 阶段 | 内容 | 通过条件 |
|---|---|---|
| Phase 0（模型/文档） | 定稿树形 schema、`antenna_bands`、`seat_assignments`、灯色投影、AUTO/MANUAL、黄灯不抢占规则（§19.11）、D17 算法；同步修订 v2.1 的 §3/§4.2.3/§8.3/§9.3 | 数据模型能表达父子/波段/自动归属；D17 有可执行伪代码 |
| Phase 1（只读） | 树形设备页、波段配置、席位清单、占用投影与灯色；不开放任何写按钮 | 切波段能改变归属与灯色；两个席位看到不同颜色；1×n 无黄灯 |
| Phase 2（自动流转） | 监听 `radio_state` 波段变化，执行自动归属/释放；黄灯只提示；审计 | 切波段 1s 内更新；黄灯不抢占；审计可追溯 |
| Phase 3（矩阵/天线切换写） | n×n 选路 + 租约 + 占用冲突 409 + **TX 上报互锁**（仅天线切换） | TX 上报源 active 时切换被拒；黄灯切换被拒并给出占用者 |
| Phase 4（旋转器/塔） | 旋转器按父链定位；塔命令按子树检查、二态确认、脉冲启动、断联→`offline`、运行超时告警；**不做发射判定** | 终端限位/急停可用；超时告警；发射中允许转动/升降 |
| Phase 5（1×n） | 独占设备接入，跳过共享冲突；**仍受天线切换的 TX 互锁** | 1×n 无黄灯；TX 上报源 active 时不可切 |
| Phase 6（其余） | Modbus/MQTT/DIY、采样与保留、UI 细节 | 与 §18.11 Phase 6 相同 |

部署相关：**不实现任何网络拦截**；只在 README/安装输出/首次使用给提醒与免责。工作区旧改动按 §19.7.4 清理后再继续。

## 19.13 第四轮结论

- **设备模型需要重做，不是补字段**：v2.1 的扁平设备 + 静态绑定无法表达“塔→天线→旋转器”与“按波段自动归属”。至少需要 `parent_id`、`antenna_bands`、`seat_assignments` 和按席位投影的占用状态（D33–D35）。
- **灯色语义有硬冲突**：v2.1 用绿/黄/红表示健康，新口径表示占用；必须拆成两个视觉通道，否则现场会误读“红=故障”还是“红=本席占用”。
- **D17 最终恢复，但只针对天线切换/矩阵 OUT**：状态源为通用上报接口（用户自研设备，优先级可配）；旋转器不做发射判定（§22）。N1MM 状态仍只显示/弱提示。
- **部署边界按新口径收敛为“提醒 + 免责”**：D2/D3 关闭、D4 作废；工作区旧改动需撤/改但本轮未执行。
- **黄灯规则已确认**：自动归属遇到他席占用时**一律不抢占**，不设超时、优先级或管理员例外；只提示占用者，等释放/换空闲天线/人工协调（§19.11）。
- 本轮**未改任何代码**，仅更新本报告。

---

# 第五轮评审（旋转器共享控制）

> 本节依据用户补充的特殊情况：**一台旋转器挂多副天线，多个席位同时可控制该旋转器**。与 §19 冲突处，以本节为准；本节只新增/修正旋转器相关规则，不改变 §19.11 的天线黄灯规则。

## 20. 旋转器挂多副天线、多席位共享控制

### 20.1 两种资源性质不同，不能套用同一套状态

| 维度 | 天线（antenna） | 旋转器（rotator） |
|---|---|---|
| 资源性质 | **按波段归属的独占资源**（同波段多席位时例外共享，双方都显示红） | **共享**（不设单一使用者） |
| 归属 | 按波段自动归属到当前席位（§19.3） | **不设独占归属**；多个席位都可下发指令 |
| 灯色 | 红=本席占用 / 黄=他席占用 / 绿=空闲 | **不适用三色占用灯** |
| 冲突 | 黄灯禁止切换（§19.11） | 允许接管，但需二次确认（§20.4） |
| 状态展示 | 占用色 + 波段 | 当前角/目标角/运动状态/最近发起席位 |
| 数据 | `seat_assignments`（归属） | `device_state.last_commanded_by`（控制权）+ `device_commands`（历史） |

**明确禁止**：不要给旋转器卡片套用天线的红/黄/绿占用灯。旋转器不是“被某个席位占用”，它只有一个物理指向角，多个席位共享对它的控制。

### 20.2 物理约束：“可控制”不等于“并行执行”

- 一台旋转器只有一个指向角；两个席位要 45° 和 120° 时，物理上不可能同时满足。
- “多个席位同时可控制”的准确含义是：**都允许下发指令**，但指令必须串行化，后一次会改变前一次的目标。
- 旋转器的指向变化会同时影响它**子树中的所有天线**；这是“一台旋转器挂多副天线”的物理结果（但旋转器不做发射互锁，见 §22.3；天线切换仍做）。

### 20.3 必须给所有席位可见的状态

旋转器卡片/接口至少要暴露：

| 字段 | 说明 |
|---|---|
| `physical_azimuth` | 旋转器**物理**角度（来自回读） |
| `target_azimuth` | 当前目标；空闲时可为空 |
| `motion_state` | `idle / moving / settled / error / offline / unknown` |
| `last_commanded_by` | 最近一次下发指令的席位 + 操作员（仅显示，保留） |
| `last_command_at` | 最近指令时间 |
| `move_started_at` / `settled_at` | 转动开始/到位时间 |
| `verified_at` | 最近一次回读时间；用于标识数据是否可信 |

**天线实际指向**（新增，O4 已确认）：

- 每副天线增加 `install_offset_deg`（0–359 整数），在**天线设置**里配置。
- `actual_azimuth = (physical_azimuth + install_offset_deg) mod 360`。
- 同一旋转器下所有天线共享旋转器角度，但各自偏移不同，因此实际指向各不相同：

| 天线 | `install_offset_deg` | 旋转器 0° 时实际指向 | 旋转器 45° 时实际指向 |
|---|---|---|---|
| ANT1 | 0 | 0°（正北） | 45° |
| ANT2 | 180 | 180°（正南） | 225° |
| ANT3 | 90 | 90°（正东） | 135° |

- 界面每副天线显示**自己的实际指向**；旋转器物理角度只作为次要信息（例如“旋转器 45° / ANT2 225°”）。
- 任一席位转动后，向所有使用该旋转器下天线的席位广播：「你的 ANTn 实际指向已变为 X°」。
- **偏移只改变读数，不改变物理事实**：一台旋转器仍然只有一个物理角度；两个席位要不同实际指向时，仍会互相带动。偏移不解决争用，只是让每副天线显示正确方向。

### 20.4 冲突处理：**最后指令生效**（O4 已确认，接管协议取消）

| 场景 | 行为 |
|---|---|
| 旋转器空闲 | 任一席位可直接转动，不需要先“占用” |
| 正在转动，另一席位下发**相同**方位 | 幂等，不重复动作 |
| 正在转动，另一席位下发**不同**方位 | **直接覆盖**，最后指令生效；不锁、不排队、不接管、不二次确认 |
| 已到位（settled） | 任一席位可直接转，无需确认 |
| 新指令覆盖旧指令 | 旧指令标记 `superseded`；新指令成为当前目标；两条都写审计 |
| N1MM 报告本席正在发射 | 不拒绝；可弹一次弱提示，确认后照常执行（仅显示层，见 §22.6） |
| 急停 | 任何席位都可执行，立即停止并清除目标；优先级最高 |

约束：

- **取消接管协议**：删除 `takeover_from`、二次确认接管、原席位“已被接管”文案。
- **允许覆盖，但必须可见**：不静默改变他席目标；所有席位通过 WS 看到 `last_commanded_by`、新目标、以及自己天线的实际指向变化。
- **不做永久排队**：转动中收到的新目标直接生效，不保留“等到位后自动执行”的队列。
- **这不是天线归属变更**：只改变旋转器目标与 `last_commanded_by`，不改变任何天线的波段归属与灯色。
- O4 已确认关闭；不得再按旧报告实现“二次确认接管”。

### 20.5 与“黄灯不抢占”规则的区别（必须分清）

| 场景 | 规则 | 本质 |
|---|---|---|
| 天线黄灯（他席按波段占用） | **永不抢占**：不转移、不打断、不设超时/优先级/管理员例外（§19.11） | **资源归属** |
| 旋转器转动中改目标 | **最后指令生效**，无确认（§20.4） | **共享设备的控制权** |

两者不矛盾：

- 天线归属是“谁在使用这副天线”，黄灯期间不能夺走。
- 旋转器控制是“谁在驱动这个共享设备”，允许多人先后驱动，最后指令生效只是换驾驶员。
- 覆盖旧指令**不得**改变天线归属，也不得把黄灯变成红灯；反过来，天线黄灯也**不禁止**该席位按 §20.4 转动共享旋转器（**不做发射互锁**，只在 N1MM 报告时提示一次）。

### 20.6 旋转器的发射状态：**不做互锁，只做显示与弱提示**

> **第六轮修订**：本节原“任一子天线发射即禁止转动”的 P0 互锁整条撤销。旋转器**不因 N1MM 报告发射而阻断，也不检查 TX 上报源**（§22.3）；天线切换的互锁不扩展到旋转器。

- 旋转器命令**不检查** `is_transmitting`，不因发射状态拒绝、排队或自动中止。
- 仅在 N1MM 恰好报告“发起指令的席位正在发射”时，弹一次确认提示；操作员确认后照常执行（详见 §22.3）。
- 该提示可能漏报（未接 CAT、脚踏/手键、语音处理器等），**不构成保护**。
- 若转动中途开始发射，系统**不会**自动停止；是否停止由操作员决定。原 O5 作废（见 §21.4）。
- 验收改为：N1MM 报告发射时出现一次提示且确认后可执行；N1MM 未报告时不出现提示；**任何路径都不得因 `is_transmitting` 拒绝**。
- 严重程度：不再是 P0；D42 作废。

### 20.7 归属与控制的分离（两个独立维度）

- **天线归属**：按波段派生，存 `seat_assignments`（seat → antenna），决定红/黄/绿。
- **旋转器控制**：共享，存 `device_state.last_commanded_by`（最近发起席位）与 `device_commands`，决定“谁在转”。
- 不要把两者合并成一个 `owner_seat` 字段；也不要因为某席位“拥有”某副天线，就认为它独占旋转器。
- 允许的状态组合：
  - 席位 1 拥有 15m 天线，但最近一次转动由席位 2 发起；
  - 席位 2 不拥有任何天线，仍可转动共享旋转器（最后指令生效；不受发射状态限制）。
- UI 上：天线卡显示占用色与波段；旋转器卡显示角度/状态/最近发起者，**不使用占用色**。

### 20.8 父子结构（第六轮定稿：统一节点、单父、无环）

v2.1 **完全没有父子模型**：`devices` 没有 `parent_id`（§8.3），§4.2.3 只有端口绑定；因此它既不允许也不禁止“一父多子/多父”，属于未定义，而不是已有约束。

**第六轮最终口径（O2、O3 已确认关闭）**：取消按设备类型限定父子关系，**所有设备共用一张表、一个 `parent_id`，任何类型都可父可子**。因此以下结构都能直接表达，不需要特例：

- 塔 → 旋转器 → 天线
- 塔 → 天线 → 旋转器
- 一台旋转器 → 多副天线（一父多子）

只保留三条约束：

| 约束 | 规则 | 实现 |
|---|---|---|
| **单父** | 每个设备至多一个 `parent_id`，因此是树不是图 | 字段本身即可保证；保存时不需要类型白名单 |
| **无环** | 不允许 A→B→A | 保存/移动节点时沿父链检测，遇到自己即拒绝 |
| **删除有子节点的节点** | **建议禁止删除**，先移走或删除子树；备选是级联软删除（需要 `deleted_at` 与恢复策略） | 一期采用“禁止删除”，实现最简单、最不容易误删现场配置 |

- 「旋转器多父导致指向冲突」的问题**消失**：单父约束已经覆盖，不需要再单独禁止“旋转器多父”。
- **旋转器解析改为沿父链上溯**：某副天线当前受哪台旋转器控制，从该天线出发沿 `parent_id` 向上找**最近的 `type=rotator` 祖先**；找到即由它控制，找不到则视为**手动/固定指向**。不再按“塔只能装旋转器/天线只能挂旋转器”的类型规则推导。
- 设备类型校验从“类型组合白名单”**降级为仅做环检测与单父约束**；原先为类型组合准备的校验项全部删除。

### 20.9 失败回滚与最终指向的一致性

必须定义并能测试以下状态：

| 事件 | 指令状态 | 界面/数据要求 |
|---|---|---|
| 正常到位 | `settled` | 显示回读的实际角，目标=实际 |
| 新指令覆盖 | 旧 `superseded`，新 `moving` | 广播新目标与 `last_commanded_by`；不提示“被接管”；两条都审计 |
| 操作员手动停止 | `stopped` | 立即回读，显示实际角；目标清除；不得显示未到达的目标角 |
| 超时/断线 | `timeout` / `unknown` | 保留 `verified_at`，标“未确认”；重连后强制全量回读 |
| 硬件失败 | `failed` | 显示错误码与实际角；不得把目标角当实际角 |

硬性要求：**界面不得出现“显示 120° 而实际停在 45°”**。`physical_azimuth`、`target_azimuth` 与每副天线的 `actual_azimuth` 必须分字段渲染；`motion_state` 不是 `settled` 时，不得把目标角样式化成当前角。

### 20.10 与 v2.1 的冲突、新问题与待确认

#### 20.10.1 与 v2.1 的冲突

| # | v2.1 原文 | 新规则 | 冲突 |
|---|---|---|---|
| R1 | §4.2.3 A：“单端口设备（旋转器…）只有一个逻辑归属，直接绑定席位” | 旋转器是共享资源，不绑定单一席位 | **直接冲突**；旋转器不能按席位独占绑定 |
| R2 | §3.3 把“共用旋转器”归为 `station`，写操作靠租约 | 方向接近；O4 已确认最后指令生效 | 部分兼容；不需要接管协议，补“无锁直接覆盖”说明 |
| R3 | §9.3 发射互锁只写“切换器/塔操作时，若绑定席位 is_transmitting” | **第七轮最终：天线切换互锁保留，但状态源改为通用上报接口（用户自研）；旋转器/塔不扩展** | 不是“删除全部”：天线切换仍拒绝；只删除“绑定席位”判定与旋转器/塔的发射判定 |
| R4 | §7.4/§10.1 只有健康灯/位置，没有“谁在转” | 需要 `last_commanded_by`、`motion_state`、实际指向；无接管提示 | **状态模型缺失** |
| R5 | §8.3 `devices` 无 `parent_id`；`device_bindings` 无共享控制概念 | 需要树 + 共享控制状态 | **表结构不足** |
| R6 | §9.4 指令生命周期没有 `superseded`/`stopped`/`unknown` | 覆盖/操作员停止需要这些终态 | **状态机不足** |

#### 20.10.2 新问题（接 D39）

| 编号 | 章节 | 问题 | 严重程度 | 建议改法 |
|---|---|---|---|---|
| D40 | §8.3、§4.2.3 | 没有父子模型，无法表达“旋转器挂多副天线” | **已解决（用户确认）** | 统一节点 + 单个 `parent_id` + 单父 + 无环；不设类型白名单；删除策略见 §20.8 |
| D41 | §4.2.3 A | 把旋转器列为“单端口设备，直接绑定席位”，与共享控制冲突 | **P1** | 旋转器归为 shared/station 资源，不写 `device_bindings` 的 seat 行；控制靠 `last_commanded_by` + 最后指令生效 |
| D42 | §9.3 | 原问题：发射互锁只覆盖切换器/塔，旋转器漏掉 | **维持取消（非 P0）** | 旋转器不做发射互锁；天线切换仍做（§22.3）；`is_transmitting` 仅显示，不参与准入 |
| D43 | §7.4、§10.1、§11.2 | 没有共享旋转器的可见状态（谁在转、转动中、各天线实际指向） | **P1（仅剩可见性）** | 增加 §20.3 字段与 WS 事件；**不再需要接管提示**（O4 已取消接管） |
| D44 | §9.4 | 缺 `superseded / stopped / unknown` 终态与回读规则，存在“显示目标角=实际角”的风险 | **P1** | 补齐状态机；`physical/target/actual` 分字段；覆盖/停止/断线都强制回读并标 `verified_at`（不再有 `aborted_tx`） |
| D45 | §4.2.3、§8.3 | 原问题：“一父多子/旋转器多父”没有配置校验 | **已解决（用户确认）** | 单父 + 无环 + 禁止删除有子节点；一父多子允许；多父问题由单父约束消失 |

#### 20.10.3 待确认（需用户拍板）

| 编号 | 问题 | 推荐 | 状态 |
|---|---|---|---|
| O2 | 是否允许一台旋转器下挂多副天线（一父多子）？ | 允许；统一节点下任何类型都可父可子 | **已确认关闭** |
| O3 | 是否允许旋转器同时挂在多个塔/天线节点下（多父）？ | 不允许；单父约束天然覆盖，不需要单独规则 | **已确认关闭** |
| O4 | 旋转器多席位控制与天线实际指向 | **已确认关闭**：每副天线加 `install_offset_deg`；实际指向 =（旋转器角度 + 偏移）mod 360；**取消接管协议**，任何席位可直接转动，最后指令生效，不锁/不排队/不二次确认 | **已确认关闭** |
| O5 | 转动中途开始发射时，是否立即停止并中止当前指令？ | **作废**：旋转器不做发射互锁，系统不自动停止 | **已作废** |

> 说明：O2/O3 已按“任何类型都可父可子、单父、无环”关闭；O4 已按“安装偏移 + 最后指令生效”关闭；O5 随发射互锁取消而作废。

### 20.11 实施顺序调整

在 §19.12 的基础上，旋转器相关阶段调整为：

| 阶段 | 增补内容 | 通过条件 |
|---|---|---|
| Phase 0 | 定稿统一节点模型（单父/无环/删除策略）、`install_offset_deg`、最后指令生效、可见状态字段、`superseded/stopped/unknown`；**纳入天线切换互锁规格与 TX 源模型；不含旋转器/塔发射判定** | 字段与状态机可写进 schema；TX 源优先级/降级文案定稿 |
| Phase 1（只读） | 旋转器卡片显示实际角/目标角/状态/最近发起席位；不显示占用三色灯 | 两个席位看到同一真实状态；不把目标角显示成实际角 |
| Phase 2（自动流转） | 波段归属变化不影响旋转器控制权；归属与控制分开存储 | 切波段不改变 `last_commanded_by` |
| Phase 3（矩阵写） | 保持 §19.12 的矩阵/租约/占用冲突 | 黄灯切换被拒；N1MM 报告发射时仅提示一次 |
| Phase 4（旋转器写） | 空闲直转、转动中直接覆盖（最后指令生效）、到位直转、实际指向广播；**不检查发射状态** | 无锁/无确认/无接管；各天线实际指向正确；发射状态不影响执行 |
| Phase 5（塔） | 塔命令按**子树**检查（类型无关）；限位/急停 | 限位/急停可用；不因发射状态拒绝 |

### 20.12 第五轮结论

- **旋转器是共享控制资源，不是天线那种独占资源**：不要套红/黄/绿占用灯；它需要“当前角/目标角/运动状态/最近发起席位”这套状态。
- **“多席位可控制”是串行下发，不是并行执行**：空闲直转、转动中直接覆盖（最后指令生效）、到位直转；不锁、不排队、不二次确认。
- **覆盖 ≠ 抢占天线**：天线黄灯仍按 §19.11 永不抢占；旋转器覆盖只改变目标与最近发起者，不改变天线归属与灯色。
- **安装偏移只改读数**：`actual = (physical + offset) mod 360`；一台旋转器仍只有一个物理角度，两个席位要不同实际指向时仍会互相带动，偏移不解决争用。
- **旋转器不做发射判定（最终口径）**：`is_transmitting` 只显示、只触发一次弱提示；天线切换的 TX 上报互锁不扩展到旋转器；D42/O5 作废（§22.3）。
- **v2.1 的冲突**：旋转器被当作单端口席位设备、没有树模型、没有共享可见状态、缺 `superseded/stopped/unknown`；其中“发射互锁漏掉旋转器”不成立，因为旋转器本来就不该有发射互锁。
- **父子结构与 O4 已定稿**：统一节点、单父、无环、禁止删除有子节点；安装偏移 + 最后指令生效；D40/D45 关闭，O2/O3/O4 关闭。
- **O6 已确认**：TX 源中断即降级，天线切换互锁不生效、正常允许切换；不再待确认。
- 本轮**未改任何代码**，仅更新本报告。

---

# 第六轮评审（取消发射互锁）——**已被 §22 取代**

> 本节记录第六轮“取消全部发射互锁”的结论。**第七轮最终口径已修订：天线切换/矩阵 OUT 的互锁恢复（通用 TX 上报接口），旋转器仍不做发射判定。** 与 §22 冲突处，一律以 §22 为准；本节仅保留历史与“旋转器不互锁”的部分。

## 21.1 第六轮结论（已被 §22 部分修订）

- **D17**：第六轮曾取消；**第七轮恢复，但范围仅限天线切换/矩阵 OUT，状态源改为外部硬件**（§19.6、§22）。
- **D42 仍取消**：旋转器不做任何发射判定，发射中允许转动（§22.3）。
- **O5 作废**：不讨论“转动中途开始发射是否立即停止”，旋转器不自动停止。
- 发射互锁不再是“全部取消”，而是“仅天线切换保留”。

**为什么取消**：

1. 系统能拿到的“发射状态”只有 N1MM 上报的 `is_transmitting`；N1MM 的发射状态是它自己推断的。
2. 未接 CAT、使用脚踏/手键、经过语音处理器等情形下，该状态并不准确。
3. 用不完整的信号做硬阻断会产生两类错误：真正发射时放行、未发射时拦截；后者还会促使操作员绕过系统。
4. **不可靠的互锁比没有互锁更危险**，因为它制造虚假的安全感。

## 21.2 可见性 + 弱提示（N1MM 部分；不是互锁源）

### 21.2.1 可见性（显示层）

- 每副天线显示当前占用者（席位/操作员）与灯色。
- 显示最近一次切换/转动由哪个席位发起（`last_commanded_by`）。
- 显示 N1MM 报告的发射状态，标注为“N1MM 报告”，不标注为“实际发射”；同时显示 TX 上报源状态（若已配置）。

### 21.2.2 弱提示（不阻断；与硬件互锁并存）

- 当操作员提交“切换天线”或“转动旋转器”时，如果 N1MM 恰好报告**该席位**处于发射状态，弹**一次**确认提示：
  「N1MM 报告席位 X 正在发射，仍要切换/转动吗？」
- **旋转器**：确认后照常执行；N1MM 未报告时不提示，直接执行。
- **天线切换**：N1MM 提示不构成放行依据；若 TX 上报源有效且为发射中，仍必须拒绝（§19.6）。上报源不可用/未知时按 O6 处理。
- **不排队、不自动中止**；N1MM 状态不做服务端准入判定（硬件源除外）。
- 该提示**可能漏报**（未接 CAT、脚踏/手键、语音处理器等），因此**不构成保护**。

### 21.2.3 明确的风险声明

> **系统不阻止发射过程中转动旋转器；天线切换仅在检测到可靠 TX 上报信号时被拒绝。未配置或未检测到发射状态源时，互锁不生效，相关风险与操作责任由操作员承担。**

该声明应进入 README/设备接入文档，并与“仅提醒、不做网络拦截”的部署口径保持一致。

## 21.3 `is_transmitting` 的使用边界

| 允许 | 禁止 |
|---|---|
| 界面显示“N1MM 报告：发射中” | 作为命令准入条件 |
| 命令前弹一次弱提示 | 服务端因 `is_transmitting` 返回 403/409/拒绝 |
| 审计记录“操作员在 N1MM 报告发射时确认执行” | 作为租约授予/拒绝条件 |
| 调试/诊断展示 | 自动停止、自动中止、`aborted_tx` 状态 |
| | 验收要求“发射中必须被拦截” |

**代码约束**：`is_transmitting` 不得出现在任何 command guard / admission 函数中；只允许出现在 UI 展示、提示逻辑与审计字段。实现后应加一条静态检查或 code review 清单，防止它又被接回拦截逻辑。

> **注意**：上表只约束 N1MM 的 `is_transmitting`。**TX 上报源（用户自研设备）是另一条通道，允许作为“天线切换”的准入条件**；它不用于旋转器/塔，也不用于租约。

## 21.4 依赖“能准确获取发射状态”的旧结论清单（逐条处理）

| 位置 | 旧结论 | 第七轮最终处理 |
|---|---|---|
| §9 Phase 4 | “发射中切换被拒并给出原因” | **恢复**：仅天线切换，TX 上报源 active 时拒绝；不使用 N1MM |
| §16 Phase 4 | “天线切换器 + 发射互锁” | **恢复**（仅天线切换）；旋转器不扩展 |
| §18.5 控制安全表 | “发射互锁 P0，不够” | **部分恢复**：天线切换 P0；旋转器不需要 |
| §18.9 验收 | “发射互锁”验收项 | **恢复**天线切换拒绝用例；旋转器不要求 |
| §18.10 D17 | 互锁重写，P0 | **恢复 P0，但范围缩到天线切换/矩阵 OUT**；状态源为通用上报接口 |
| §18.11 原则 | “先解决共用天线互锁” | **恢复**“先做天线切换互锁”；旋转器不做 |
| §18.11 Phase 4 | “按天线路径的发射互锁” | **恢复**（天线切换）；删除“旋转器子树”部分 |
| §18.12 结论 | “仍有 3 个 P0，含 D17” | **修正**：P0 = D17（仅天线切换） |
| §19.6 | “占用集合 + 发射状态”的完整互锁 | **改写为最终口径**：外部硬件源、仅天线切换；不再按占用集合推导 |
| §19.10 D36 | “1×n 保留发射互锁” | **恢复**：1×n 仍受天线切换 TX 互锁 |
| §19.12 Phase 3/4/5 | “按占用集合的发射互锁”“子树检查发射” | Phase 3 **恢复**（天线切换）；Phase 4/5 **维持不做**（旋转器/塔） |
| §19.13 | “D17 是唯一 P0” | **修正**：D17 恢复，仅天线切换 |
| §20.4 | “发射互锁命中 → 拒绝” | **保持**：旋转器不拒绝；N1MM 仅弱提示 |
| §20.6 | “任一子天线发射即禁止转动，P0” | **维持撤销**：旋转器不做发射判定（D42 取消） |
| §20.9 | `aborted_tx`“发射互锁中止” | **保持删除**；改为操作员主动停止的 `stopped` |
| §20.10.1 R3/R6 | “缺旋转器互锁”“缺 aborted_tx” | R3：天线互锁保留但换源，旋转器不扩展；R6：状态机仍用 `superseded/stopped/unknown` |
| §20.10.2 D42 | 旋转器互锁 P0 | **维持取消**（非 P0） |
| §20.10.2 D44 | 含 `aborted_tx` 的状态机缺口 | **保持**：补状态机，但删除 `aborted_tx` |
| §20.10.3 O5 | “中途发射是否立即停止” | **维持作废**：旋转器不自动停止 |
| §20.11 Phase 0/4/5 | 含“旋转器发射互锁/共用互锁” | Phase 0 增加 TX 源模型；Phase 4/5 旋转器/塔**不做**；Phase 3 天线切换**要做** |
| §20.12 结论 | “发射互锁必须覆盖旋转器，P0” | **维持修正**：旋转器不做 |
| 租约冲突（D19） | 租约 TTL 与长动作冲突 | **保留**，与发射状态无关 |
| 急停 | 硬件/软件急停 | **保留**，与发射互锁无关 |
| N1MM `is_transmitting` | 曾考虑作为互锁源 | **永久禁止**作为互锁源；只显示/弱提示（§22.6） |
| D17 旧“占用集合”推导 | 按“谁占用 + 谁在发”推导 | **不恢复**；只恢复“TX 上报源 active → 拒绝天线切换” |

## 21.5 实施顺序（已被 §22.8 取代）

第六轮曾建议 Phase 3/4/5 均不做发射判定。**第七轮最终：Phase 3（天线切换/矩阵）恢复 TX 上报互锁；Phase 4（旋转器）与 Phase 5（塔）仍不做。** 完整顺序见 §22.8。

## 21.6 v2.1 文档修订（已被 §22.7 取代）

- **保留** §9.3 的“天线切换互锁”，但状态源改为通用 TX 上报接口，**不用 N1MM**。
- **删除**“旋转器/塔也做发射互锁”的扩展（D42 维持取消）。
- **增加**无可靠 TX 源时的界面/设置页降级提示（§22.5）。
- N1MM 的 `is_transmitting` 仍只用于显示/弱提示。

## 21.7 第六轮结论（已被 §22.9 取代）

- **旋转器不做任何发射判定**（仍然有效）：发射中允许转动，D42 取消。
- **天线切换互锁恢复**：仅天线切换/矩阵 OUT，TX 上报源 active 时拒绝（§19.6/§22）。
- **N1MM 仍只显示/弱提示**，永久禁止作为互锁源。
- **P0 = D17（仅天线切换）**；O5 维持作废。
- 父子结构按第六轮口径统一为“同一种节点、单父、无环、禁止删除有子节点”，O2/O3 关闭，D40/D45 关闭。
- 本轮**未改任何代码**，仅更新本报告。

## 21.8 类型无关化清单（本轮同步修改）

| 位置 | 原表述（类型假设） | 已改为 |
|---|---|---|
| §19.2.1 | “父类型只能是 `tower` 或 `antenna`” | 任何类型可父可子；只保留单父、无环、删除策略 |
| §19.2.1 节点表 | 塔/天线“可作为父”、旋转器“单一父节点（塔或天线）” | 全部改为“可父可子”；单父对全类型统一 |
| §19.2.1 删除规则 | “拒绝或级联待定” | 明确建议“禁止删除有子节点”，备选级联软删除 |
| §20.2 | “它下挂的所有子天线” | “它子树中的所有天线” |
| §20.7 | “某副子天线”“不拥有任何子天线” | “某副天线”“不拥有任何天线” |
| §20.8 | “一父多子需确认”“禁止旋转器多父”“父类型白名单” | 一父多子允许；多父由单父约束消失；删除类型白名单 |
| §20.10.2 D40/D45 | 无父子模型、多父/多子无校验 | 关闭：统一节点 + 单父 + 无环 + 删除策略 |
| §20.10.3 O2/O3 | 待确认 | 已确认关闭 |
| §20.10.2 D37 | “旋转器挂塔与挂天线的语义差异”“子树是否必须停发” | 命令作用域统一为子树；旋转器按最近 `rotator` 祖先解析；删除“停发”要求 |
| §20.11 Phase 5 | “子树检查”但暗含类型语义 | 明确“类型无关的子树作用域” |

**因此删除的多余校验项**（不再实现）：

- 父类型与子类型的组合白名单；
- “塔只能挂旋转器/天线”“天线只能挂旋转器”“矩阵不能当父”等规则；
- “旋转器不能多父”的单独类型规则（由单父字段统一覆盖）；
- 为上述白名单准备的错误码、配置页提示与测试用例。

**保留的实现只有**：单父（字段天然保证）、环检测（保存/移动时沿父链）、删除策略（有子节点禁止删除）。实现复杂度低于原“类型组合校验”。

---

# 第七轮评审（最终口径：仅天线切换互锁）

> 用户原话：**“发射互锁可以做，可以由驻波表，功放提供发射状态，发射禁止旋转不要做这样子浪费调整时间，只做发射禁止切换天线。”** 本节是最终口径；与 §21 冲突处，一律以本节为准。
>
> **第十三轮修订（D17/O9）**：用户明确「D17，让用户自己开发，目前还没有这种产品」。因此本节中一切“驻波表/功放/干接点/串口/GPIO”等具体产品与接口形态的指定**全部作废**，改为**通用 TX 状态上报接口 + 用户配置源优先级**。互锁范围（仅天线切换/矩阵 OUT）、N1MM 永久不作互锁源、无源/中断降级这三条不变。

## 22.1 最终范围

| 操作 | 发射中是否允许 | 说明 |
|---|---|---|
| 天线切换器 / n×n 矩阵 OUT 切换 | **禁止** | 唯一互锁范围；TX 上报源 active 即拒绝，**无二次确认放行** |
| 1×n 天线切换 | **禁止** | 它也是天线切换；只豁免“共享占用”规则，不豁免发射互锁 |
| 旋转器转动 | **允许** | 边转边发是竞赛常态；旋转不改变电气连接，不构成设备损坏风险 |
| 塔升降（二态：展开/收回，脉冲自锁） | **允许** | 非射频路径切换；不做发射判定；运行超时告警 |
| 电源等 | 不做发射判定 | 不在本次范围 |

## 22.2 D17 重新定级：**留下 TX 状态上报入口**（P0）

- **范围**：仅天线切换、矩阵 OUT 切换（含 1×n）。
- **判定**：该射频路径上配置的 TX 上报源存在、健康且 `tx_active=true` → **直接拒绝**，返回 **423 Locked**（`code: TX_ACTIVE`），写明源标识与上报时间；**不提供“仍要继续”的二次确认**。409 保留给租约冲突，避免两种冲突混用同一状态码。
- **不做**：不按占用集合推导；不按 N1MM `is_transmitting` 判定；不扩展到旋转器/塔。
- **审计**：记录席位、操作员、源、`tx_active`、上报时间、目标端口、结果 `rejected_tx`。
- **失败路径**：完全无源按 §22.5.1（提示“未接入发射状态源”）；源超时/中断/异常按 §22.5.2（O6 已确认）：显示通信中断、移除该源、允许正常切换、审计。两种都不得静默假装互锁生效。
- **严重程度**：**P0**。但 P0 的性质是**必须留出这个上报入口并把它接入切换链路**，不是必须由本项目做出检测装置——检测装置由用户自研。

## 22.3 旋转器 D42 维持取消

- 旋转器命令**不做任何发射判定**：不检查 N1MM，也不检查 TX 上报。
- 理由：
  1. 边转边发是竞赛常态，禁止旋转会直接浪费调向时间；
  2. 旋转不改变射频电气连接，不产生天线切换那种“带载热切换”的风险；
  3. 旋转器与天线切换是两个不同的物理动作，不应共用同一条互锁。
- 仅在 N1MM 恰好报告本席发射时给一次弱提示（可确认后继续），**不构成保护**。
- 塔升降同样不做发射判定。

## 22.4 发射状态源：通用上报接口（用户自研设备）

> 目前没有现成产品，用户自研。本项目**只定义上报入口**，不指定设备、不指定物理接口形态。

### 22.4.1 上报契约

对接方（用户自研）通过一个**通用入口**上报二元状态，本项目不关心它内部怎么取信号：

- **传输形式**：HTTP POST、UDP 数据报、WebSocket 三者任选其一即可；契约固定，实现可先选一种。
- **请求体（JSON）最小字段**：

  | 字段 | 类型 | 必填 | 说明 |
  |---|---|---|---|
  | `source_id` | string | 是 | 上报源标识，由用户在设置中配置后分发 |
  | `tx_active` | boolean | 是 | `true` = 发射中；`false` = 未发射 |
  | `ts` | string/number | 否 | 上报时间（ISO8601 或 epoch ms）；缺省用服务端接收时间 |
  | `seq` | number | 否 | 序号，用于乱序/重复丢弃 |

- **服务端维护**：`last_seen`、`health`（`ok` / `stale` / `offline`）、`latency_ms`、`priority`。
- **超时**：超过可配的 `tx_source_timeout_ms`（默认 2000ms）无上报 → `stale`；继续无上报 → `offline`，按 §22.5.2 降级。
- **安全**：入口仅限内网；用 `source_id` + 共享令牌校验，不引入账号体系。

### 22.4.2 多个上报源：优先级由用户配置

- **删除“驻波表 > 功放”这类基于具体产品的优先级**，本项目不判断哪种设备更可信。
- 多个源并存时，**按用户在设置中配置的优先级**选取：取该射频路径上“已配置 + 健康 + 优先级最高”的源。
- 源通过 `tx_source_bindings(source_id → antenna_id / port_id / station_id)` 绑定到射频路径；未绑定的源不参与该路径判定。
- 同一路径可配置多个源；优先级是配置项，不是内置常量。

### 22.4.3 不做厂商适配

- 不内置任何具体协议实现，不做设备型号白名单，不做厂商适配。
- 不实现串口/GPIO/Modbus/HTTP 轮询等“读取某台设备”的驱动——这些由用户自研设备完成，再按 §22.4.1 上报。
- 因此本能力**不是设备驱动**，而是一条独立的轻量上报入口，接入切换判定链路即可。

## 22.5 降级路径与失效策略

### 22.5.1 无可靠源

- 界面与设置页必须常驻显示：**「未接入发射状态源，天线切换互锁未启用」**。
- 不得静默假装互锁生效；不得把“无源”显示成“未发射”。
- 无源时天线切换允许执行，但必须提示“互锁未启用”，并写审计。

### 22.5.2 源失效（O6 已确认）：中断即降级，不拦截

硬件断线、读取超时、数值异常时：

1. 界面显示**「与设备通信中断」**，并把该源从可用集合中移除；
2. 若所有源都不可用，则**等同“无发射监测设备”**，按 §22.5.1 显示「互锁未启用」；
3. **天线切换互锁不生效，正常允许切换**；不做保守阻断、不要求二次确认；
4. **不得沿用旧状态、不得缓存最后一次已知发射状态、不得把 `unknown` 当作“正在发射”**；
5. 保留审计：记录中断起止时间，以及该窗口内的所有切换操作。

理由（与用户定调一致）：

- 源失效后它已不可信；“阻断”不能保证安全，只会把硬件故障转嫁成无法切天线的操作障碍。
- 允许 + 明确提示 + 审计，让操作员知情决策，并留下追溯依据。

> O6 已确认关闭；实现不得再保留“源失效时保守阻断”的分支。

## 22.6 N1MM 的 `is_transmitting`：永久禁止作为互锁源

- 只允许：显示“N1MM 报告：发射中”、弱提示、审计备注。
- 禁止：作为天线切换的准入条件、租约条件、拒绝理由、自动停止依据。
- TX 上报与 N1MM 冲突时：**以上报为准**。
  - 上报 active、N1MM false → 拒绝天线切换；
  - 上报 inactive、N1MM true → 允许天线切换（可能弹一次 N1MM 提示）。

## 22.7 v2.1 文档与设备接入章节的修订

本项目只提供上报入口，具体采集由用户自研完成。v2.1 需要写清的是**契约与配置**，不是硬件手册：

| 项 | 需要写入 v2.1 的内容 |
|---|---|
| 上报入口 | 传输方式（HTTP/UDP/WS 择一）、路径/端口、请求体字段（§22.4.1）、鉴权（`source_id` + 令牌） |
| 配置项 | 源列表、`source_id`、显示名、优先级、超时阈值、绑定到天线/端口/席位 |
| 状态模型 | `ok` / `stale` / `offline`、`tx_active`、`last_seen`、`latency_ms` |
| 降级 | 无源 → 「未接入发射状态源」；超时/中断 → 「与设备通信中断」、移除源、允许切换、审计（§22.5） |
| 非目标 | 不写设备型号、不写 PTT/干接点/串口/GPIO 等具体接线；这些属于用户自研设备的内部实现 |

v2.1 需要同步修改：

- §9.3：保留天线切换互锁，状态源改为“通用上报接口”，删除“绑定席位 `is_transmitting`”与旋转器扩展。
- §15：恢复“天线切换在 TX 中拒绝”的验收；增加“无源时提示未接入”的验收；删除“旋转器 TX 中禁止转动”的任何表述。
- §6/§7：增加上报入口的契约说明与源配置/优先级/绑定，不写 `read_tx_state` 设备驱动能力。

## 22.8 新 P0 清单与实施顺序

**P0（仅 1 项）**：

- **D17：留下通用 TX 状态上报入口，并接入天线切换/矩阵 OUT（含 1×n）判定**；无二次确认放行。检测装置由用户自研，本项目不做。

**实施顺序**：

| 阶段 | 内容 | 通过条件 |
|---|---|---|
| Phase 0 | 统一节点模型、`antenna_bands`、`seat_assignments`、灯色投影、AUTO/MANUAL、黄灯不抢占、`install_offset_deg`、最后指令生效；**新增 TX 上报契约**（入口、字段、源配置、用户优先级、超时、绑定）与 O6 降级文案 | 契约可联调（curl/UDP/WS 三选一）；源优先级与降级文案定稿 |
| Phase 1（只读） | 树形设备页、波段配置、席位清单、占用与灯色、最近发起者；显示 TX 源状态与“未接入发射状态源”提示 | 两席位看到不同颜色；无源时提示常驻 |
| Phase 2（自动流转） | 波段变化自动归属/释放；黄灯不抢占；审计 | 切波段 1s 内更新 |
| Phase 3（天线切换/矩阵写） | 端口绑定、`select_port`、租约、占用冲突 409、**上报源 active 时拒绝切换**（含 1×n） | 上报 active 时拒绝且无旁路；无源时提示并允许；审计完整 |
| Phase 4（旋转器写） | 空闲直转、转动中直接覆盖（最后指令生效）、到位直转、实际指向广播、`stopped`/回读；**不做发射判定** | 无锁/无确认/无接管；各天线实际指向正确；回读正确 |
| Phase 5（塔） | 塔二态、上限位/下限位、脉冲启动、运行超时告警；**不做发射判定** | 二态读取正确；脉冲自锁；超时告警；急停可用 |
| Phase 6（扩展） | Modbus/MQTT/DIY、采样与保留、UI 细节 | 新增类型不改核心；容量达标 |

## 22.9 验收标准

| 场景 | 预期 |
|---|---|
| 已配置源上报 `tx_active=true`，切换天线/矩阵 OUT | **拒绝** `423 Locked / TX_ACTIVE`，不动作，审计 `rejected_tx`；无“仍要继续”按钮 |
| 已配置源上报 `tx_active=false` | 允许切换 |
| 同一路径配置多个源、优先级不同 | 按用户配置的最高优先级健康源判定；与“哪个产品”无关 |
| 未接入任何源 | 界面/设置页显示“未接入发射状态源，天线切换互锁未启用”；切换允许但提示；审计记录 |
| 源超时/中断/异常 | 显示“与设备通信中断”、移除源、允许切换、审计；不得静默、不得缓存旧状态 |
| N1MM 报告发射，上报源 inactive | 允许切换（可弹一次 N1MM 提示）；不得因 N1MM 拒绝 |
| N1MM 未报告，上报源 active | **拒绝**（上报源优先） |
| 发射中转动旋转器 | **允许**，正常执行；无拒绝 |
| 发射中升降塔 | 允许；不做发射判定 |
| 1×n 天线切换，上报源 active | 拒绝（与矩阵相同） |

## 22.10 新问题与待确认

| 编号 | 章节 | 问题 | 严重程度 | 建议 |
|---|---|---|---|---|
| D46 | §6、§7、§8 | v2.1 没有 TX 上报源实体、优先级、健康、绑定 | **P1** | 增加上报契约（入口/字段/鉴权）、`tx_sources`/`tx_source_bindings`、health/priority；不做设备驱动 |
| D47 | §9、§10 | 无源/源中断时的界面与设置页降级提示未定义 | **已定义（O6）** | 无源显示“未接入发射状态源”；源中断显示“与设备通信中断”；设置页显示源状态 |
| D48 | §6.3、§7.3 | 原按“设备输出形式/隔离/去抖”提的问题 | **作废（转对接方）** | 本项目不规定物理形态；由用户自研设备自行处理，接口只接收二元状态（§22.4） |
| O6 | §9 | 源失效（断线/超时/异常）的处理 | **已确认关闭** | 移除该源；全不可用则等同无源；显示通信中断；不拦截、不缓存旧状态；允许切换并审计（§22.5.2） |

> O6 已确认关闭；O4 也已确认关闭（§24）。当前没有阻塞实施的待确认项。

## 22.11 第七轮结论（第十三轮修订）

- **D17 的 P0 性质改为“接口契约待实现”**：必须留出 TX 状态上报入口并接入天线切换/矩阵 OUT 判定；检测装置由用户自研，本项目不指定型号、不做厂商适配、不内置具体协议。
- **旋转器 D42 维持取消**：发射中照常转动；不检查 N1MM，也不检查上报源；塔同理。
- **多源优先级由用户配置**，不预设“驻波表 > 功放”之类基于具体产品的顺序。
- **N1MM `is_transmitting` 永久禁止作为互锁源**，只显示/弱提示。
- **降级路径明确**：未接入 → 常驻「未接入发射状态源」并允许切换；超时/中断 → 「与设备通信中断」、移除该源、允许正常切换、审计。
- **v2.1 需同步修订** §9.3/§15，并新增上报契约与源配置（D46），但不写设备驱动能力。
- 本轮**未改任何代码**，仅更新本报告。

---

# 第八轮评审（塔的二态模型、脉冲自锁与模拟电路）

> 用户补充的现场实情：**“纯靠机械模拟电路，我可以提供上限位、下限位信号，到位自停由模拟电路完成，电路是按钮互锁 + 交流接触器连锁正反转电路，上升到一半可以直接点下降，反之亦然。”** 本节按此重写；原“二态、禁止反向、软件到位自停”的结论作废。

## 23.1 现场电气事实与软件职责

| 项 | 现场实现 | 软件职责 |
|---|---|---|
| 启动方式 | **按下即松手，继电器自锁到限位** | 输出一次脉冲后立即释放；**不保持吸合** |
| 到位自停 | 模拟电路/自锁回路完成 | **不实现**；只读限位显示状态 |
| 正反转互锁 | 按钮互锁 + 交流接触器连锁 | **不实现**；不重复做“防同时上下” |
| 运动中反向 | 硬件支持且安全 | **允许**；软件不禁止 |
| 限位信号 | 上限位、下限位两路 | 只读，用于状态与运行超时告警 |
| 控制输出 | 两路干接点，并接在上升/下降按钮上 | 只输出启动脉冲；**不直接驱动接触器线圈** |

软件不承担“安全回路”角色：它是并联在按钮上的一个“脉冲手指”，启动后由硬件自锁接管。

## 23.2 状态模型：二态 + 暂态/故障

| 状态 | 判据 | 说明 |
|---|---|---|
| `erected` | 上限位有效、下限位无效 | 展开终端 |
| `retracted` | 下限位有效、上限位无效 | 收回终端 |
| `moving` | 启动脉冲已发出、目标限位尚未有效 | **暂态**；由硬件自锁运行到限位 |
| `fault` | 两路限位同时有效 | 传感器/接线故障，告警；不得推断方向 |
| `unknown` | 运行超时、反馈异常 | 故障待确认；不得声称终态 |
| `offline` | 通信中断 | 保留最后状态与时间戳，不当作当前位置 |

- **没有 `intermediate` 正常停留态**：自锁回路会一直运行到限位才停；若中途停下，只能是故障（`unknown`/`fault`），不是正常状态。
- **运行超时告警**：发出启动脉冲后，超过 `travel_timeout_sec` 仍未读到目标限位 → 判定故障并告警。阈值按塔的实际行程时间配置（建议默认“正常行程 × 1.5”，具体待现场确认）。
- 超时可能原因至少包括：塔卡阻、接触器未吸合、自锁回路故障、限位开关损坏或线路断。
- 两路限位同时有效 → `fault` 告警；不得二选一，也不得据此自动动作。
- **不需要位置传感器**：不显示高度、行程百分比、倾角、进度条。

## 23.3 控制模型：脉冲启动 + 硬件自锁（O7 已确认）

**O7 已确认关闭**：不是点动，也不是持续闭合。现场是**按下即松手、继电器自锁直到限位**；软件输出**一次启动脉冲**，随后立即释放，由接触器自锁回路保持运行。**软件不保持输出、不持续吸合。**

### 23.3.1 脉冲参数（O9 已改为用户可配置）

- 软件闭合输出一次，时长 `pulse_width_ms` 是**设置项，由用户自行填写**，**默认 400ms**。
- **删除“首次脉冲自锁测试通过后才开放写操作”这类门控**：不做前置校验、不做阻断，由用户自己负责。
- 说明保留：**脉冲过短，接触器可能不吸合**（表现为点动一下即停）；**过长可能掩盖反向指令**或增加同时激励/误动作窗口。用户按实际接触器调整即可。

### 23.3.2 撤销死手开关

- **删除心跳续期、心跳超时释放、`normal_release`/`heartbeat_timeout`/`connection_closed`/`server_restart`/`config_reload` 这套释放原因分类**。
- 理由：脉冲发出后由硬件自锁接管；网络中断不影响本次运行完成，不需要“按住/续命”语义。
- 保留 fail-safe：服务启动、重启、崩溃恢复、配置重载时，两路输出**默认释放**，**不自动续跑、不产生意外启动**。
- 服务启动/重启时不得自动吸合；只有新的显式启动脉冲才允许闭合。

### 23.3.3 反向与两路输出

- **允许运动中反向**：上升途中可直接下反向指令；硬件按钮/接触器互锁负责先断后合。
- 软件保证：**先释放当前方向输出，再发反向脉冲**；释放到下一次闭合最小间隔建议 **200ms**，反向最小间隔建议 **1000ms**（可配置）。
- 反向会**重新触发运行超时监控**（以新方向的目标限位为准）。
- 同一方向重复下发：运动中幂等/去抖，不重复发脉冲，避免接触器频繁动作。

### 23.3.4 与 D19 租约的关系

- 输出脉冲的条件：**租约有效 + 方向合法**；**不再需要心跳参与**。
- D19 的租约续期仍独立保留（长行程可能超过 30s），但它只影响“谁有权发下一个脉冲”，与已发出的脉冲无关。
- 租约到期不会中断已经由硬件自锁执行的本次运行；只阻止后续新指令。

### 23.3.5 O8 已确认：限位类型只做一个下拉框

- 限位开关类型只有**一个下拉框**：「常开（NO）/ 常闭（NC）」，在设置中由用户选择。
- **默认值：常开（NO）**。理由是普通限位开关多数按常开接法使用；这是默认值，不是自动判断。
- 下拉框旁只保留一句静态说明：**「按实际接线选择，选错会显示相反状态」**。不做校验、不做提示、不做阻断。
- **不做限位自检**：没有“限位自检”按钮、没有实时电平对照、没有不一致提示、没有“首次配置强制自检”、没有“未自检则禁止塔写操作”。这一整套全部删除，不保留部分实现。
- 断线检测按所选类型分别定义：
  - **NO**：断线 = 断开 = 未到位；不会误判“已到位”，但目标限位会永远读不到 → 由运行超时告警兜底。
  - **NC**：断线 = 断开 = 被读成“限位有效” → 可能误判“已到位”；由“两路同时有效”与“运行超时未见状态变化”兜底。
- 无论选择 NO/NC，运行期都处理两种异常：**两路同时有效 → `fault`**；**两路同时无效超过 `travel_timeout_sec` → `unknown` + 运行超时告警**（与 §23.2 合并）。这两条是运行期保护，与配置引导无关。
- O8 **已确认关闭**；D50 更新为“已定义”。塔的启用前置条件中**不含自检**；O9 已改为用户可配置项（默认 400ms），也不构成门控。

### 23.3.6 隔离与现场风险

- 干接点输出与限位输入建议**光耦隔离**。
- **网络只影响“启动脉冲”能否及时发出**；脉冲一旦被硬件接收，运行由自锁回路完成。现场关键动作仍优先使用物理按钮，软件按钮作为辅助，不要宣称等同于本地按钮的响应速度。
- 塔仍不做发射判定（§22.3）。

## 23.4 运动中反向与并发

- **允许运动中直接反向**：硬件支持“上升到一半直接点下降，反之亦然”；软件删除“运动中禁止反向”的限制与文案。
- 反向仍受 `reverse_min_interval_ms`（默认 1000ms）节流，避免接触器高频动作；这是时序保护，不是禁止反向。
- **不做软件“运动中独占/半路接管”**：塔由现场按钮/接触器控制，软件只发启动脉冲；其他席位的并发由现有租约串行（D19 仍待解决），不新增接管协议。
- 同一方向重复下发：幂等/去抖，不重复发脉冲。
- **无中间态**：自锁到限位才停；没有“停在中途”的正常状态，只有 `unknown`/`fault` 故障态。
- **塔不做发射判定**（沿用 §22.3）：`is_transmitting` 与 TX 上报源都不参与塔命令；天线切换互锁与塔无关。

## 23.5 清理清单（本轮删除/替换）

| 位置 | 被删除/替换的内容 | 处理 |
|---|---|---|
| §23.3（第十轮） | “点动”“持续闭合”“按住吸合、松开释放” | **删除**；改为“脉冲启动 + 硬件自锁” |
| §23.3.2（第十轮） | 心跳续期 500ms/1500ms、心跳超时释放、释放原因分类 | **整段删除**；动作由硬件自锁接管 |
| §23.2（第九轮） | `intermediate` 状态、中间态超时告警 | **删除**；改为二态 + `moving`/`fault`/`unknown` |
| §23.3.1（第十轮） | “按下开始/松开停止”的交互模型 | **删除**；改为“按一次发一个启动脉冲” |
| §23.3.5（第十轮） | “心跳与租约分离/心跳参与输出” | **替换**；输出只需租约 + 方向，无心跳 |
| §23.3.5（第十二轮） | “限位自检”、实时电平对照、自检不一致提示、首次强制自检、未自检禁止塔写 | **整段删除**；只保留一个 NO/NC 下拉框（默认 NO）与一句静态说明 |
| §23.7（第十轮） | 心跳超时释放、中间态超时告警验收 | **删除**；改为脉冲自锁、运行超时告警 |
| §24.3.1（第十轮） | 因点动假设新增的 O7/心跳/中间态条目 | **更新**；O7 改为脉冲自锁；O9 改为用户可配置设置项 |
| 全文 | “点动一下即停”“按住才动”“死手开关” | **删除**；不再作为塔的操作语义 |
| §19.2.1 节点表 | “三态 + fault/offline” | 改为“二态 + `moving`/`fault`/`unknown`/`offline`” |
| §22.8 Phase 5 | “三态 + 中间超时告警” | 改为“二态 + 脉冲自锁 + 运行超时告警” |
| §24.4 UI 契约 | “三态 + 中间态超时告警” | 改为“二态 + `moving`/`fault`/`unknown`；运行超时告警” |

> 全文不再用“高度/行程/倾角/百分比/进度条”描述塔；也不再把“软件停半路/软件防反向/软件防同时上下”写成职责。

## 23.6 与 v2.1 的冲突、新问题与待确认

| 编号 | 章节 | 问题 | 严重程度 | 建议 |
|---|---|---|---|---|
| D49 | §9.4、§15 | **文档未反映模拟电路实现，导致软件职责界定错误**：把到位自停、正反转互锁写成软件职责，还禁止运动中反向 | **P1** | 软件只读限位、只输出启动脉冲；删除软件自停/互斥/禁止反向；允许反向 |
| D50 | §9.5、§15 | 到位确认只写“限位”，未定义常开/常闭、断线电平与检测方式 | **已定义（O8）** | 限位类型一个下拉框（NO/NC），默认 NO，旁附一句静态说明；不做自检、不做校验阻断；NO/NC 分别定义断线语义；两路同有效→`fault`，同无效超时→`unknown` |
| D51 | §10.1、§11.2 | 通用设备卡可能把塔渲染成数值/进度条；现有 UI 有“停”按钮 | P2 | 塔卡只显示二态 + `moving`/`fault`/`unknown`/`offline`；删除进度条；“停”=急停/释放 |
| O7 | §9.4 | 输出是瞬时脉冲还是持续闭合 | **已确认关闭** | 现场为“按下即松手、继电器自锁到限位”；软件输出一次脉冲（默认 400ms，200–800ms 可配）后释放；不保持、不死手 |
| O8 | §9.5 | 限位常开/常闭、断线电平；常闭断线可能误读“已到位” | **已确认关闭** | 设置中一个下拉框选 NO/NC，默认 NO，旁附「按实际接线选择，选错会显示相反状态」；不做自检、不做校验、不阻断塔写；两路同有效/同无效超时仍在运行期告警 |
| O9 | §9.4 | 脉冲宽度 | **已关闭（用户可配置）** | `pulse_width_ms` 为设置项，用户自行填写，默认 400ms；不做“测试通过才开放写”的门控；保留“过短不吸合、过长可能掩盖反向指令”的说明 |

**O4/O6 已在 §24 确认关闭；塔仍不做发射判定。**

## 23.7 实施顺序（塔部分）

| 阶段 | 内容 | 通过条件 |
|---|---|---|
| Phase 0 | 定稿二态 schema、`moving`/`fault`/`unknown`/`offline`、`travel_timeout_sec`、`pulse_width_ms`（设置项，默认 400ms）、限位类型开关（默认 NO）、fail-safe | 字段可落库；限位类型有默认值与说明文案；脉冲宽度可由用户修改 |
| Phase 1（只读） | 显示二态 + `moving`/`fault`/`unknown`/`offline`；运行超时告警；不显示高度/进度条 | 两席位一致；超时阈值可配 |
| Phase 5（塔写） | 两路干接点并接按钮；**发一次 400ms 脉冲后释放**；硬件自锁；限位按设置中的 NO/NC 解析；允许反向；先断后合；不做软件自停/互斥/死手/自检 | 脉冲能自锁；松开后仍运行到限位；中途反向可用；运行超时告警 |
| 验收 | NO/NC 各验证一次（选错只体现为相反显示，不阻断写）；上/下各 10 次；脉冲后松手仍运行到限位；中途反向；拔线→`offline`；两路同有效→`fault`；两路同无效超时→`unknown`+告警；服务重启→默认释放且不自动启动；审计含脉冲宽度 | 全量审计可追溯；无心跳/自检类事件 |

## 23.8 第八轮结论（第九/十一轮修订）

- **塔是二态**：`erected`（上限位）、`retracted`（下限位）；`moving` 是暂态；两路同时有效为 `fault`；超时/反馈异常为 `unknown`；通信中断为 `offline`。
- **没有正常中间态**：自锁回路运行到限位才停；中途停下只能是故障。
- **控制是脉冲启动 + 硬件自锁**：软件闭合一次（默认 400ms）后立即释放，不保持、不持续吸合；删除心跳/死手/释放原因分类。
- **运行超时告警**：超 `travel_timeout_sec` 未读到目标限位 → 故障告警；原因包括卡阻、接触器未吸合、自锁回路故障、限位损坏/断线。
- **允许运动中反向**；软件先释放再发反向脉冲，反向最小间隔 1000ms；反向重新触发超时监控。
- **输出只需租约 + 方向合法**，不需要心跳；D19 租约续期独立保留。
- **O7 已确认**（脉冲自锁）；**O8 已确认关闭**（设置中一个下拉框选 NO/NC，默认 NO，只附一句静态说明；不做自检、不做校验与阻断；两路同有效/同无效超时仍在运行期告警）；**O9 已关闭**（`pulse_width_ms` 为用户可配置设置项，默认 400ms，不做门控）。
- **塔不做发射判定**（§22.3）；D49/D50 已按本节更新。
- 本轮**未改任何代码**，仅更新本报告。

---

# 第九轮评审（O4/O6 确认与最终结论）

> 本轮关闭 O4、O6；不新增机制。与前面各轮冲突处，以本节为准。

## 24.1 O4 已确认：天线安装偏移 + 取消接管

### 24.1.1 安装偏移

- 每副天线新增 `install_offset_deg`（0–359 整数），在**天线设置**里配置。
- **实际指向 = `(physical_azimuth + install_offset_deg) mod 360`**。
- 用户例子：

| 天线 | 偏移 | 旋转器 0° 时实际 | 旋转器 45° 时实际 |
|---|---|---|---|
| ANT1 | 0° | 0°（正北） | 45° |
| ANT2 | 180° | 180°（正南） | 225° |
| ANT3 | 90° | 90°（正东） | 135° |

- 界面每副天线显示**自己的实际指向**；旋转器物理角度作为次要信息。
- 任一席位转动后，向所有使用该旋转器下天线的席位广播：「你的 ANTn 实际指向已变为 X°」。
- **边界**：偏移只改变读数，不改变“一台旋转器只有一个物理角度”的事实；两个席位要不同实际指向时仍会互相带动，偏移不解决争用。

### 24.1.2 取消接管协议

- 任何席位均可直接转动；**最后指令生效**。
- 不锁、不排队、不接管、不二次确认；旧指令记 `superseded`，新指令成为当前目标。
- `last_commanded_by` 保留作显示；**删除 `takeover_from`** 及“已被接管”文案。
- O4 **已确认关闭**；不得再按 §20.4 旧方案实现二次确认接管。

## 24.2 O6 已确认：状态源中断即降级，不拦截

- 源断线、超时、异常：界面显示**「与设备通信中断」**，把该源从可用集合移除。
- 所有源都不可用：等同**“无发射监测设备”**，显示「天线切换互锁未启用」。
- 此时**互锁不生效，正常允许切换**；不保守阻断、不要求二次确认。
- **不得沿用旧状态、不得缓存最后一次已知发射状态、不得把 `unknown` 当作“正在发射”**。
- 审计：记录中断起止时间，以及该窗口内的切换操作。
- O6 **已确认关闭**；D47 更新为“已定义”。

## 24.3 最终状态：未解决项与已关闭项

### 24.3.1 仍未解决

| 级别 | 条目 | 说明 |
|---|---|---|
| **P0** | D17（仅天线切换/矩阵 OUT） | 通用 TX 状态上报接口待实现（入口 + 接入切换判定）；检测装置由用户自研；这是唯一 P0 |
| **P1** | D19 租约续期、D20 commandId 去重、D21 重连状态语义、D22 group 表、D23 密钥管理、D24 `/red`+`/ws` 内网威胁面 | 多席位写入前必须定；详见 §18.10 |
| **P1** | D33 树形 schema、D34 归属运行态、D35 灯色按席位投影、D41 旋转器绑定、D43 共享可见状态、D44 状态机、D46 TX 上报接口契约、D49 塔软件职责错误（模拟电路） | 设备实现前必须定；详见 §19.10/§20.10/§22.10/§23.6 |
| **P2** | D25 采样容量、D26 错误码、D27 rigctld、D28 capability 来源、D29 port_id、D30 station_map、D31 验收基准、D32 Node-RED 重启、D38 波段多对多、D51 塔 UI | 可后置，但不写清会踩坑 |
| **设置项** | **O9** 脉冲宽度 | 设置项，用户自行填写，默认 400ms；不做门控；说明“过短不吸合、过长可能掩盖反向指令”。O8 已关闭，塔的启用前置条件中不含自检 |

### 24.3.2 已确认关闭/作废

| 条目 | 结论 |
|---|---|
| D2/D3 | 由用户“只提醒、不拦截”定调关闭 |
| D4 | 地址校验整条作废（不做拦截） |
| D48 | 作废；TX 检测的物理接口形态由对接方自研，本项目只接收二元上报（§22.4） |
| D17 的“占用集合 + N1MM”旧方案 | 作废；现为“TX 上报 + 仅天线切换” |
| D40/D45 | 由统一节点 + 单父 + 无环解决 |
| D42 | 旋转器互锁维持取消 |
| D47 | O6 已定义降级提示 |
| D37 | 树形命令作用域 = 子树，已定 |
| O2/O3 | 任何类型可父可子、单父、无环，已确认关闭 |
| O4 | 安装偏移 + 最后指令生效，已确认关闭 |
| O5 | 随旋转器不做发射判定而作废 |
| O6 | 源中断即降级、不拦截，已确认关闭 |
| O7 | 脉冲启动 + 硬件自锁 + fail-safe，已确认关闭 |
| O8 | 限位类型只做一个下拉框（NO/NC，默认 NO）+ 一句静态说明；不做自检/校验/阻断，已确认关闭 |
| D18 | 席位身份 = `ComputerName + RadioName + RadioNr`，显式配置最高优先级覆盖，已关闭 |
| D50 | 限位 NO/NC 与断线语义已定义（随 O8），已关闭 |
| O9 | `pulse_width_ms` 改为设置项（默认 400ms），删除测试门控，已确认关闭 |

> 关于 D17：其“按绑定席位/N1MM 判定”的旧实现永久作废；**恢复的是“TX 上报源 active → 拒绝天线切换”这一条**，两者不要混淆。

## 24.4 从评审转入实施的入口条件

1. **需求文档修订完成**：D17（天线切换 + 通用 TX 上报接口）、O4（安装偏移、取消接管）、O6（源中断降级）、§23（塔二态/模拟电路/脉冲自锁）、§20.8（统一节点）写入 v2.1；删除所有“N1MM 互锁”“旋转器互锁”“塔连续位置/软件自停/禁止反向”“二次确认接管”的残留表述。
2. **P0 契约可落地**：定义 TX 上报入口（HTTP/UDP/WS 择一）、字段与鉴权、源配置与用户优先级、超时与健康判定、无源/中断降级文案与审计字段；**不指定设备型号、物理接口或具体协议实现**。
3. **多席位写入前置**：至少先定 D23（密钥）、D20（commandId 去重）、D19（租约续期），否则不应开放矩阵/旋转器写操作；席位身份（D18）已关闭，按 `ComputerName + RadioName + RadioNr` 实现即可。
4. **验收标准更新**：按 §22.9、§23.7、§24.1 补齐；删除“发射中旋转器必须被拒”“塔不得停在中间”“软件到位自停”“接管二次确认”等旧用例，增加“脉冲自锁、运行超时告警”用例。
5. **UI 契约更新**：天线显示实际指向（含偏移）；旋转器显示物理角/目标/`last_commanded_by`；塔显示二态 + `moving`/`fault`/`unknown`/`offline` + 运行超时告警；无源/中断提示常驻。
6. **塔的配置项**：限位类型是设置里的一个下拉框（NO/NC，默认 NO，选错只表现为状态相反），**没有自检、也不阻断塔写**；`pulse_width_ms` 同样是设置项（默认 400ms），**没有“测试通过才开放写”的门控**。
7. **部署边界旧改动处理完毕**：见 §24.5；在决定撤/留之前，不把该批改动当作已交付能力。

## 24.5 工作区部署边界旧改动状态（未提交、未部署、未撤销）

> 这批改动早于“只提醒、不拦截”的最终定调，**当前仍原样留在工作区**，我没有提交、没有部署、也没有回退。

| 类别 | 文件 |
|---|---|
| 修改 | `settings.js`、`lib/index.js`、`flow.json`、`bigscreen/server.js`、`public/index.html`、`public/css/style.css`、`public/js/i18n.js`、`public/js/pages/settings-page.mjs`、`README.md`、`install.sh` |
| 新增 | `lib/deployment/exposure.js`、`lib/deployment/index.js`、`public/shared/data/system.mjs`、`tests/deployment-exposure.test.js` |

按新口径需要撤/改的部分（§19.7.4 已列）：

- **撤掉**：默认回环绑定、`/api/system/exposure`、设置页暴露面提示、`lib/deployment/*`、对应 i18n 与测试；
- **保留**：`README.md` 与 `install.sh` 里的“本机/局域网自用、公网/云部署不在支持范围、后果自负”提醒与免责文案；
- 具体撤/留由用户决定，评审阶段不执行。

## 24.6 第九/十/十二/十三轮结论

- **O4 关闭**：`install_offset_deg` + 实际指向公式；每副天线显示自己的实际指向；取消接管，最后指令生效；`takeover_from` 删除，`last_commanded_by` 保留显示。
- **O6 关闭**：源中断显示“与设备通信中断”，移除源；全不可用等同无源；互锁不生效、允许切换；不缓存旧状态；审计中断窗口。
- **O7 关闭**：现场为“按下即松手、继电器自锁到限位”；软件输出一次脉冲（默认 400ms）后释放，不保持；无死手/心跳；服务重启默认释放；反向先断后合；与租约只需租约 + 方向。
- **O8 关闭**：限位类型只有设置里的一个下拉框（常开/常闭，**默认常开**），旁边一句「按实际接线选择，选错会显示相反状态」；**不做自检、不做校验、不做阻断**，塔的启用前置条件里不含自检。两路同时有效、两路同时无效超过运行超时仍在运行期告警。
- **O9 关闭**：`pulse_width_ms` 是设置项，用户自行填写，默认 400ms；**不做“测试通过才开放写”的门控**；保留“过短不吸合、过长可能掩盖反向指令”的说明。
- **D17 关闭为“接口契约待实现”**：只做通用 TX 上报入口（HTTP/UDP/WS 择一）+ 用户配置源优先级；不指定型号、不做厂商适配、不内置具体协议；未接入显示「未接入发射状态源」并允许切换，超时/中断显示「与设备通信中断」并降级。
- **P0 仍只有 D17**（仅天线切换/矩阵 OUT 的**通用 TX 上报接口**；检测装置由用户自研）；旋转器、塔不做发射判定。
- **剩余 P1/P2** 见 §24.3.1；关闭项见 §24.3.2。
- **实施入口条件**见 §24.4；工作区部署边界旧改动状态见 §24.5。
- 本轮**未改任何代码**，仅更新本报告。

