# DX-Compass 国际化术语表与缺口审计

> 版本：2026-11-10
> 范围：主界面、设置页、Spot/QSO/传播/记录四大页面、大屏页（`/bigscreen/`）的全部用户可见文案。
> 本文件只做审计与方案，不修改任何页面模板。设置页 `settings-page.mjs` / `index.html` / `style.css` 正由另一任务改版，本文相关计数基于当前工作区快照，落地前需重新核数。

---

## 1. 结论摘要

| 指标 | 现状 |
| --- | --- |
| 已支持语言 | 11 种：zh、en、de、fr、es、pt、ru、it、ar、ko、ja |
| 主词典键数 | 133 个／语言；加上两个传播块后运行时 204 个（见 §2.4） |
| 三个词典块的合并结果 | 204 个键（133 + 47 + 24，三块互不重复，见 §2.4） |
| 代码中字面量 `t('key')` | 83 个不同键，缺失 0 个 |
| 设置 schema 键数 | 104 个（6 个域；25 个旧控件 + 79 个动态生成字段） |
| 大屏页 i18n 覆盖 | 0（全中文硬编码） |
| 未翻译/未覆盖条目 | **283 条**（含 79 条字段工具提示） |
| 已翻译但术语不专业/不统一 | **22 组**（涉及 40+ 条具体字符串） |
| 需改页面模板才能落地 | 设置页 220 条、大屏 49 条、主界面 14 条 |
| P1 已预置词典键（本轮） | **370 个**新键 × 11 语言 = 4070 条，见 §8 |

一句话结论：旧界面的 11 语言覆盖是完整的；**新增功能（设置页 6 页签、大屏、动态字段标签/说明/枚举）几乎没有进入词典**，设置页新控件目前只有中英双语（`bi()`），大屏只有中文。

---

## 2. 现有 i18n 机制

### 2.1 文件与调用链

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 源词典（传统脚本） | `public/js/i18n.js` | `LANGS`、`LANG_NAMES`、`I18N`、`PROP_I18N`、`PROP_CARD_I18N`；约 1030 行 |
| 运行时适配器 | `public/shared/core/i18n.mjs` | `createI18n({lang, fallback, dictionaries})`，提供 `t/translate/setLanguage/language/dictionary` |
| 兼容桥 | `public/js/legacy-i18n.mjs` | 保留旧 `t(key)` 合同，支持“值本身是函数”的复数写法 |
| 启动 | `public/js/main.mjs` | `createI18n({lang:'zh'})` → 读取 `settings.lang` → 构造 `ctx.t` |
| 应用到 DOM | `settings-page.applyLang()` 为主，`records-page`、`propagation-page`、`spot-page`、`qso-page` 各自补充 | 选择器→键映射约 100 条 |
| 持久化 | `settings.lang`（schema `ui.lang`，默认 `zh`） | `localStorage: dxcompass-settings` + 服务端设置 + WebSocket 广播 |
| 文档声明 | `<html lang>` 由 `applyLang()` 写入；`body.lang-ar` 只做文字右对齐 | 阿拉伯语不镜像整页（避免地图/面板错位） |

### 2.2 键名规则（现状）

- 扁平 `lowerCamelCase`，**没有命名空间分隔符**，例如 `records`、`headAll`、`propLayerMuf`、`pcSfi`。
- 同一键必须在 11 个语言块中存在；文件头注释已把它写成硬规则。
- 值为字符串；复数/拼接用函数，例如 `spotsN: n => n + ' spots'`。
- 表格表头用数组，例如 `headAll: ['Time','Call','Spotter (DE)',…]`。
- 占位符用 `{name}`，由 `createI18n.t(key, params)` 替换。
- 没有 `Intl.PluralRules`、没有 RTL 镜像、没有按语言的日期/数字格式分支。

### 2.3 回退链

```
当前语言 → en → 键名本身（原样显示 key）
```

- 主词典：逐键回退。
- `PROP_I18N` / `PROP_CARD_I18N`：**整块回退**——`Object.assign(I18N[l], PROP_I18N[l] || PROP_I18N.en)`，缺整个语言块时整块用英文，不逐键。
- `legacy-i18n.mjs`：函数值直接返回函数，带参数时才走 `i18n.t`。
- 现状：11 个语言块均完整，回退链实际未触发。

### 2.4 三个词典块的实际关系（2026-11-10 复核后更正）

初版审计把“运行时合并后的 204 键”误当成了 `I18N` 的原始键数，由此得出“71 键重复、`Object.assign` 是空操作”的错误结论。逐块解析源码后的实测结果是：

| 块 | 每语言键数 | 与主词典重复 | 与另一块重复 |
| --- | --- | --- | --- |
| `I18N` | 133 | — | — |
| `PROP_I18N` | 47 | **0** | 0 |
| `PROP_CARD_I18N` | 24 | **0** | 0 |
| 合并后 | **204** | — | — |

结论：

- 这 71 个键是传播页/空间天气卡片**独有的真实键**（`propBestBand`、`pcSfi`、`rdToa` 等），不是重复内容；
- 末尾两行 `Object.assign` 是必需的合并步骤，删掉会让传播页的 `t()` 全部回退成键名；
- 三处“改一处漏两处”的风险仍在，但正确做法是**保留合并**、再按 §5.3 拆分子文件，而不是删除。
- 本轮已加守卫：合并逻辑使用 `hasOwnProperty` 检测冲突并写入 `I18N_MERGE_DUPLICATES`，测试断言其为空。

### 2.5 哪些走词典、哪些硬编码

| 界面 | 覆盖情况 | 说明 |
| --- | --- | --- |
| 主界面工具栏/菜单 | ✅ 走词典 | 标题、按钮文字、轮播提示、UTC/LOCAL 时钟前缀中仅 `LOCAL` 硬编码 |
| Spot 地图页 | ✅ 基本走词典 | 提示、计数、监听/轮播按钮均 `t()`；`title="Clear map"` 例外 |
| QSO 地图页 | ✅ 标签走词典 | 静态 HTML 由 `applyLang()` 统一刷新；`RUN`/`S&P` 为行业缩写，不译 |
| 传播页 | ✅ 完整走词典 | 图层、图例、空间天气卡片、底条矩阵、署名说明均 `t()` |
| 记录页 | ✅ 基本走词典 | 表头/页签/空态/提示均 `t()`；`Time (Local)` 硬编码 |
| 设置页（旧控件） | ✅ 26 个手写控件走词典 | 语言、主题、底图、呼号、布局、阈值、对手、大屏等 |
| 设置页（新控件） | ❌ 仅中英双语 | 79 个动态字段用 `schema.label` + `schema.zh`，经 `bi()` 二选一 |
| 设置页（骨架/提示/弹窗） | ❌ 仅中英双语 | 约 47 条 `bi()` 或 HTML 静态英文 |
| 大屏页 | ❌ 全中文硬编码 | `bigscreen/index.html`、`wall-cards.mjs`、`wall-charts.mjs`、`wall-opponents.mjs`、`wall-page.mjs` |
| 服务端错误 | ⚪ 技术信息 | API 返回的 `error` 多为技术串，前端只显示通用 `loadFail`，不进入 UI 词典 |

### 2.6 测试现状

`tests/main-i18n.test.mjs` 只做了冒烟级检查（键存在、桥接可用），**没有**：

- 11 语言键集合一致性断言；
- 空值/键名回显断言；
- 禁用译法（蚂蚁/钻机/乐队/斑点等）扫描；
- schema 字段与词典的 1:1 覆盖断言；
- 大屏/新增功能的中文残留扫描。

---

## 3. 术语表（100 条）

> 使用原则：
> 1. **源语言用中文**，英文作为第二源语言；其他 9 种语言从这两个源翻译。
> 2. 行业缩写（CW/SSB/FT8/QSO/CQ/RST/MUF/SFI/SSN/Kp/Ap/Dst/Bz/RBN/N1MM 等）在 UI 中**保留原形**，不翻译、不扩写。
> 3. 单位符号（kHz、MHz、dBi、dBd、ms、km、nT、km/s、p/cm³）不翻译。
> 4. “禁用译法”列用于自动化 lint，命中即失败。

### 3.1 设备与台站（20 条）

| # | 英文（缩写） | 推荐中文 | 允许写法 | 禁用译法 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 1 | antenna (ANT) | 天线 | ANT、天线 | 蚂蚁、触角 | ANT 在任何语境都不得译成“蚂蚁” |
| 2 | rig / transceiver (RIG) | 电台、收发信机 | RIG、电台、收发信机 | 钻机、钻井设备、装备 | RIG 不得译成“钻机” |
| 3 | transmitter (TX) | 发射机 | 发射、TX | 发送器、传输器 | UI 中 `TX` 可保留 |
| 4 | receiver (RX) | 接收机 | 接收、RX | 接收器（设备语境可用，优先“接收机”） | |
| 5 | power amplifier (PA/AMP) | 功放、功率放大器 | 功放、PA | 力量放大器、电源放大器 | |
| 6 | antenna tuner (ATU) | 天线调谐器 | 天调、ATU | 天线调节器 | |
| 7 | low-noise amplifier (LNA) | 前置放大器、低噪声放大器 | 前置放大、LNA | 低噪音功放 | |
| 8 | attenuator (ATT) | 衰减器 | 衰减、ATT | 衰减剂、阻尼器 | |
| 9 | SWR / standing wave ratio | 驻波比 | 驻波、SWR | 驻波率、站立波比 | 口语“驻波”可接受，正式用“驻波比” |
| 10 | antenna gain | 天线增益 | 增益、dBi、dBd | 收益、获得 | |
| 11 | polarization (POL) | 极化 | 水平极化、垂直极化 | 偏振（仅光学语境） | |
| 12 | beam heading / main direction | 波束方向、主攻方向 | 主瓣方向、波束指向 | 光束方向、主方向（歧义） | 天线语境用“波束方向”；对手监测语境用“主攻方向” |
| 13 | decoupling | 去耦 | 隔离 | 解耦（软件语境才用） | 天线/馈线语境统一“去耦” |
| 14 | noise floor | 噪声基底 | 底噪、本底噪声 | 噪音地板、噪声地板 | |
| 15 | diversity | 分集 | 分集接收 | 多样性、差异 | |
| 16 | scanning | 扫描 | 扫频 | 扫描仪（名词设备） | |
| 17 | monitoring | 监听 | 守听、监测（数据语境） | 监控（安防语境） | 本项目的 monitoring 一律“监听” |
| 18 | logbook (LOG) | 通联日志 | 电台日志、日志 | 登录簿、航海日志 | |
| 19 | beacon (BCN) | 信标台 | 信标 | 灯塔、信标器 | |
| 20 | shack | 电台室 | shack | 棚屋、小屋 | |

### 3.2 通联与竞赛（21 条）

| # | 英文（缩写） | 推荐中文 | 允许写法 | 禁用译法 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 21 | SPOT | 频率播报、播报记录 | SPOT（UI 保留大写） | 斑点、地点、聚光灯、现货 | 产品 UI 中建议统一显示 `SPOT`，正文解释为“频率播报” |
| 22 | SPOTTER | 监听台、上报台 | Spotter | 观察者、狙击手、举报者 | 与“被监听台”成对使用 |
| 23 | DX | 远距台、DX | DX | 远程、数据交换、网络 | 保留 `DX`，需要展开时用“远距台” |
| 24 | QSO | 通联 | QSO | 问答、会话、联系 | |
| 25 | CQ | CQ 呼叫、普遍呼叫 | CQ | 请求、呼叫（单独使用） | 必须保留 `CQ` 前缀 |
| 26 | callsign (CALL) | 呼号 | CALL | 电话、呼叫信号、签名 | |
| 27 | RUN | 主叫 | RUN、主叫 | 运行、跑步 | 竞赛语境 = 固定频率主叫 |
| 28 | search & pounce (S&P) | 搜索呼叫 | S&P、搜索应答 | 搜索与猛扑 | 与 RUN 成对 |
| 29 | answer / respond | 应答 | 回应（口语） | 回答、回复（非业余语境） | “主叫/应答”成对 |
| 30 | RST | 信号报告 | RST | 休息、限制 | 保留 RST 三要素 |
| 31 | exchange (EXCH) | 交换信息 | 交换 | 交易所、兑换 | 竞赛交换信息 |
| 32 | multiplier (MULT) | 乘数 | MULT、系数 | 乘法器、倍数 | 竞赛计分术语 |
| 33 | dupe | 重复通联 | DUPE | 复制、副本 | |
| 34 | contest | 竞赛 | 比赛（口语） | 争夺、竞争 | |
| 35 | contest category (CAT) | 竞赛组别 | 组别、CAT | 类别（统一用“组别”） | 如 SO1R、M2 |
| 36 | operator (OP) | 操作员 | OP | 运营者、操作者 | 大屏“各操作员” |
| 37 | section | 分区 | 赛区 | 部门、章节 | 竞赛分区 |
| 38 | pile-up | 呼叫堆积 | pile-up | 堆叠、堆积物 | |
| 39 | split operation (SPLIT) | 异频操作 | 异频、SPLIT | 分离操作、拆分 | |
| 40 | QSL | QSL 卡片 | QSL | 确认信、回执 | 保留 QSL |
| 41 | QTH | 台址、位置 | QTH | 地址（纯 UI 可用）、住址 | |

### 3.3 频率与模式（11 条）

| # | 英文（缩写） | 推荐中文 | 允许写法 | 禁用译法 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 42 | band | 频段 | 波段（仅口语） | 乐队、带子、频带（统一用“频段”） | BAND 不得译成“乐队” |
| 43 | wavelength band | 波长波段 | 160m 波段 | 波浪带 | 只在讲物理波长时用“波段” |
| 44 | frequency (FREQ) | 频率 | 频点 | 频繁、次数 | |
| 45 | mode | 模式 | 方式（非业余语境） | 模特、型号 | |
| 46 | CW | 等幅电报 | CW、电报 | 连续波（直译，不用于 UI） | 保留 CW |
| 47 | SSB | 单边带 | SSB、话务 | 单边频带 | |
| 48 | FT8 / FT4 | FT8 / FT4 | 不译 | 英尺8、FT 八 | 数字模式名不译 |
| 49 | RTTY | 无线电传 | RTTY | 电传打字机（解释可用） | |
| 50 | DIGI | 数字模式 | 数据模式、DIGI | 数字化、数字的 | 本项目 DIGI = 非 CW/SSB 的汇总 |
| 51 | kHz / MHz | 千赫 / 兆赫 | kHz、MHz | 千赫兹（可用但不优先） | UI 优先单位符号 |
| 52 | band plan | 频段规划 | 波段规划 | 乐队计划 | |

### 3.4 传播与空间天气（24 条）

| # | 英文（缩写） | 推荐中文 | 允许写法 | 禁用译法 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 53 | propagation (PROP) | 传播 | 电波传播 | 宣传、繁殖、传播学 | |
| 54 | MUF | 最高可用频率 | MUF | 最大可用频率、最大使用频率 | 标准译法只有“最高可用频率” |
| 55 | LUF | 最低可用频率 | LUF | 最小使用频率 | |
| 56 | SFI | 太阳通量指数 | SFI、太阳射电通量 | 安全基金、科学基金 | |
| 57 | SSN | 太阳黑子数 | SSN、黑子相对数 | 社会安全号 | |
| 58 | Kp index | Kp 指数 | Kp | 开普指数 | 保留 Kp |
| 59 | Ap index | Ap 指数 | Ap | 上午指数、AP 指数（大小写混用） | 注意是 Ap 不是 AP |
| 60 | Dst | Dst 指数（地磁扰动） | Dst | 夏令时、DST 时区 | 与 timezone DST 严格区分 |
| 61 | Bz | Bz 分量 | Bz、行星际磁场 Bz | BZ 业务、Bz 区 | |
| 62 | Bt | Bt（总磁场强度） | Bt | BT 下载 | |
| 63 | solar wind | 太阳风 | 太阳风速度、太阳风密度 | 太阳风（误作“太阳风暴”） | 太阳风暴 ≠ 太阳风 |
| 64 | X-ray flux | X 射线通量 | XRAY、X 射线 | X 光流量 | |
| 65 | S scale (solar radiation storm) | 太阳辐射暴（S 级） | S 级、S1–S5 | 太阳放射风暴 | |
| 66 | R scale (radio blackout) | 短波中断（R 级） | R 级、无线电中断 | 广播中断 | |
| 67 | G scale (geomagnetic storm) | 地磁暴（G 级） | G 级、地磁风暴 | 地球磁场风暴 | |
| 68 | terminator | 晨昏线 | 晨昏圈 | 终结者、终止线、明暗界线 | TERMINATOR 不得译成“终结者” |
| 69 | gray line | 灰线 | 灰线区、gray line | 灰色线、灰度线、灰阶 | |
| 70 | aurora (AUR) | 极光 | 极光椭圆 | 曙光、极光带（可接受） | |
| 71 | OVATION | OVATION 极光模型 | OVATION | 欢呼、喝彩 | 产品名不译 |
| 72 | DRAP | D 层吸收预测 | DRAP | 德拉普 | 产品名不译 |
| 73 | ionosphere | 电离层 | | 离子层 | |
| 74 | critical frequency (foF2) | 临界频率 | foF2 | 关键频率、危机频率 | |
| 75 | sporadic E (Es) | 偶发 E 层 | Es | 零散 E、 sporadic（半中半英） | |
| 76 | take-off angle (TOA) | 发射仰角 | 出射角、TOA | 起飞角、发射角（与方位混淆） | 本项目 `rdToa` 建议改“发射仰角” |

### 3.5 地理与路径（8 条）

| # | 英文（缩写） | 推荐中文 | 允许写法 | 禁用译法 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 77 | Maidenhead grid | 梅登黑德网格 | Maidenhead、网格定位 | 梅登海德（旧译，需统一）、处女头、格子 | 统一用“梅登黑德” |
| 78 | grid locator | 网格定位符 | 定位符、locator | 定位器（设备语境） | 与“设备定位器”区分 |
| 79 | bearing / azimuth (AZ) | 方位角 | 方位、AZ | 轴承、方向角（可用但统一） | |
| 80 | great-circle path | 大圆路径 | 大圆航线 | 巨圆路径、大圈、大圆线 | |
| 81 | distance | 距离 | km、公里 | 远程（与 DX 混淆） | |
| 82 | DXCC entity | DXCC 实体 | DXCC 国家/地区 | DXCC 单位 | 保留 DXCC |
| 83 | continent | 大洲 | 洲 | 大陆（可用，统一用“大洲”） | 底条“大洲最优频段” |
| 84 | region / area | 区域 | 赛区（竞赛）、地区 | 地区（混用） | 竞赛语境用“赛区” |

### 3.6 数据源与界面（16 条）

| # | 英文（缩写） | 推荐中文 | 允许写法 | 禁用译法 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 85 | RBN / Reverse Beacon Network | 反向信标网络 | RBN | 反向灯塔网、反向信标网（可接受） | 首次出现可写“RBN（反向信标网络）” |
| 86 | PSK Reporter | PSK Reporter | PSKR | PSK 报告者、PSK 记者 | 产品名不译 |
| 87 | dxwatch | dxwatch | | DX 手表、DX 观察 | 产品名不译 |
| 88 | N1MM Logger+ | N1MM Logger+ | N1MM | N1MM 记录器、N1MM 日志 | 产品名不译 |
| 89 | QRZ.com | QRZ.com | QRZ | QRZ 网站（解释可用） | 产品名不译 |
| 90 | NOAA SWPC | NOAA 空间天气预报中心 | SWPC | 美国海洋大气局（不完整） | 首次出现给全称 |
| 91 | GIRO / DIDBase | GIRO / DIDBase | GIRO | 吉罗 | 产品名不译 |
| 92 | GAMBIT | GAMBIT 系数 | GAMBIT | 甘比特、赌博 | 产品名不译 |
| 93 | SDO | 太阳动力学观测台 | SDO | 太阳观测卫星（解释可用） | 产品名不译 |
| 94 | wall / big screen | 大屏 | 展示大屏、Wall | 墙、墙壁、壁挂 | `wall` 在本项目一律“大屏” |
| 95 | marker | 标记 | 标记点、marker | 记号笔、标记者 | |
| 96 | heatmap | 热力图 | 热力分布 | 热图（可接受）、热成像 | |
| 97 | TTL / lifetime | 存活时间 | 有效期、TTL | 生存期（可用但统一） | 标记/频段框/热力图共用 |
| 98 | profile | 配置档 | 预设、Profile | 个人资料、简介、档案 | 设置页“配置档” |
| 99 | retention / purge | 保留策略 / 清理 | 保留期、自动清理 | 滞留、保持、清除（可接受） | `purge` 用“清理” |
| 100 | quiet hours | 静音时段 | 免打扰时段 | 安静时间、静默小时 | 支持跨零点 |

---

## 4. 缺口审计

计数口径：**一个用户可见字符串算一条**；多条同类枚举（如 4 个天气等级、8 个方位）按实际条数计；已存在的英文副标题不重复计。

| 分类 | 条数 | 是否需要改模板 |
| --- | --- | --- |
| A1 设置页骨架/提示/弹窗 | 47 | 是（`settings-page.mjs`、`index.html`） |
| A2 设置页动态字段标签 | 79 | 是（`schema.js` + 渲染逻辑） |
| A3 设置页字段说明（tooltip） | 79 | 是（同上） |
| A4 设置页枚举选项 | 15 | 是（同上） |
| B 大屏页 | 49 | 是（`bigscreen/*`） |
| C 主界面/记录/地图残留 | 14 | 是（`index.html`、页面 JS） |
| **合计** | **283** | |

其中 79 条是悬停 tooltip，页面首屏直接可见的标签约 204 条。

### 4.1 A1 设置页骨架/提示/弹窗（47 条）

设置页新控件目前通过 `bi(zh, en)` 二选一，只有中文和英文；9 种语言用户看到的是英文。

| # | 类别 | 条目 | 数量 | 建议键 |
| --- | --- | --- | --- | --- |
| 1 | 页签 | 数据 / Data、传播 / Prop | 2 | `settings.tab.data`、`settings.tab.prop` |
| 2 | 分区标题 | 高级（2 处）、显示、显示与告警、数据与告警、传播、备份与恢复、Backup | 7 | `settings.section.*` |
| 3 | 重置区 | 重置分组/重置本组、重置 SPOT/QSO/大屏/数据/传播/全局设置、Reset everything、Reset all | 9 | `settings.reset.*` |
| 4 | 备份与配置档 | 导出 JSON、导入 JSON、backupHint、profileHint、Save as profile、Apply、Delete、配置档名称、配置档已保存、该配置档没有可用设置、配置档已删除、删除配置档 | 12 | `settings.backup.*`、`settings.profile.*` |
| 5 | 导入反馈 | 文件不是有效 JSON、缺少 settings 对象、没有可导入的有效设置、设置已导入、已导入 N 项/跳过 M 项 | 5 | `settings.import.*` |
| 6 | 状态标志 | 预览、只读、需重启 | 3 | `settings.flag.preview/readonly/restart` |
| 7 | 搜索 | `Search settings…`（placeholder + aria-label） | 2 | `settings.search.placeholder`、`settings.search.aria` |
| 8 | 槽位占位 | `Slot 1` … `Slot 9`（1 个模式） | 1 | `settings.spot.slot` |
| 9 | 示例占位 | `e.g. BG7TVF`、`e.g. OM89vx` | 2 | `settings.spot.callExample`、`settings.spot.gridExample` |
| 10 | 无障碍 | `Settings sections`（tablist aria-label） | 1 | `a11y.settings.sections` |
| 11 | 提示 | 数据面板 hint、传播面板 hint、大屏链接 hint | 3 | `settings.data.hint`、`settings.prop.hint`、`settings.wall.hint` |

**建议译文（中文源 + 英文）**

| 中文 | English |
| --- | --- |
| 数据 | Data |
| 传播 | Propagation |
| 高级 | Advanced |
| 显示 | Display |
| 显示与告警 | Display & alerts |
| 数据与告警 | Data & alerts |
| 备份与恢复 | Backup & restore |
| 备份 | Backup |
| 重置本组 | Reset group |
| 重置全部 | Reset all |
| 重置 SPOT 地图设置 | Reset Spot map settings |
| 重置 QSO 地图设置 | Reset QSO map settings |
| 重置大屏设置 | Reset wall settings |
| 重置数据设置 | Reset data settings |
| 重置传播设置 | Reset propagation settings |
| 重置全局设置 | Reset global settings |
| 导出 JSON | Export JSON |
| 导入 JSON | Import JSON |
| 另存为配置档 | Save as profile |
| 应用 | Apply |
| 删除 | Delete |
| 配置档名称 | Profile name |
| 仅保存在本浏览器；应用配置档不会改变语言与主题。 | Profiles live in this browser only; applying one keeps language and theme. |
| 预览 | Preview |
| 只读 | Read-only |
| 需重启 | Restart required |
| 搜索设置… | Search settings… |
| 设置分区 | Settings sections |

> 建议把 `bi()` 全部替换为 `t()`；`bi()` 在重构完成后删除，避免第二套翻译源。

### 4.2 A2 设置页动态字段标签（79 条）

79 个动态字段的标签来自 `public/shared/settings/schema.js` 的 `label`（英文）和 `zh`（中文）。**除中英外 9 种语言全部缺失**。

分布：ui 4、map 16、qso 13、wall 12、data 24、prop 10。

下表列出全部 79 个键；“建议中文”列只列需要修订的（未列的沿用 `schema.zh` 即可）。

#### ui（4）

| 键 | English | 中文 | 建议中文 |
| --- | --- | --- | --- |
| timeZone | Time zone | 时区 | 时区（UTC/本地） |
| hour12 | 12-hour clock | 12 小时制 | 12 小时制 |
| showSeconds | Show seconds | 显示秒 | 显示秒 |
| clockSec | Clock refresh (s) | 时钟刷新（秒） | 时钟刷新间隔（秒） |

#### map（16）

| 键 | English | 中文 | 建议中文 |
| --- | --- | --- | --- |
| autoFitMaxZoom | Auto-fit max zoom | 自动适配最大层级 | 自动适配最大缩放级别 |
| fitPad | Fit padding | 适配内边距 | 适配留白 |
| terminatorShow | Day/night overlay | 晨昏线 | 晨昏线（昼夜覆盖） |
| terminatorSec | Terminator refresh (s) | 晨昏线刷新（秒） | 晨昏线刷新间隔（秒） |
| heatShow | Heatmap | 热力图 | 热力图 |
| heatRadius | Heat radius | 热力半径 | 热力半径 |
| heatBlur | Heat blur | 热力模糊 | 热力模糊 |
| heatOpacity | Heat intensity | 热力强度 | 热力强度 |
| gcShow | Great-circle links | 大圆连线 | 大圆连线 |
| gcSamples | Great-circle samples | 大圆采样点 | 大圆采样点数 |
| spotterSize | Spotter dot size | 监听站大小 | 监听台标记大小 |
| monitoredSize | Monitored dot size | 被监听站大小 | 被监听台标记大小 |
| historyLimit | History replay limit | 历史回放条数 | 历史回放条数 |
| markerMax | Markers per cell | 每格标记上限 | 每格标记上限 |
| fadeSec | Fade tick (s) | 淡出刷新（秒） | 淡出刷新间隔（秒） |
| pruneSec | Prune tick (s) | 剪枝刷新（秒） | 清理刷新间隔（秒） |

#### qso（13）

| 键 | English | 中文 | 建议中文 |
| --- | --- | --- | --- |
| rateBucketMin | Rate bucket (min) | 速率分桶（分钟） | 速率分桶时长（分钟） |
| minBuckets | Rate buckets | 速率柱数量 | 速率柱数量 |
| qsoHistoryLimit | QSO history limit | QSO 历史条数 | QSO 历史条数 |
| freqDeltaKhz | Frequency alert delta (kHz) | 换频播报阈值（kHz） | 换频播报阈值（kHz） |
| alertPopupMs | Alert popup duration (ms) | 弹窗时长（毫秒） | 弹窗显示时长（毫秒） |
| alertSnrMin | Alert min SNR (-30 = off) | 告警 SNR 门槛（-30 关） | 告警 SNR 门槛（-30 关闭） |
| alertDistanceKmMin | Alert min distance (km, 0 = off) | 告警距离门槛（km，0 关） | 告警距离门槛（km，0 关闭） |
| voiceRate | Voice rate | 语速 | 语音语速 |
| voiceVolume | Voice volume | 音量 | 语音音量 |
| quietFrom | Quiet hours from | 静音开始 | 静音时段开始 |
| quietTo | Quiet hours to | 静音结束 | 静音时段结束 |
| alertSound | Alert tone | 提示音 | 告警提示音 |
| alertSoundVolume | Alert tone volume | 提示音音量 | 告警提示音音量 |

#### wall（12）

| 键 | English | 中文 | 建议中文 |
| --- | --- | --- | --- |
| cycleSec | Layer dwell (s) | 图层停留（秒） | 图层停留时长（秒） |
| spaceDwellSec | Space weather dwell (s) | 空间天气停留（秒） | 空间天气停留时长（秒） |
| syncSec | Wall config sync (s) | 大屏配置同步（秒） | 大屏配置同步间隔（秒） |
| wallSpotSec | Wall spot poll (s) | 大屏 SPOT 轮询（秒） | 大屏 SPOT 轮询间隔（秒） |
| wallQsoSec | Wall QSO poll (s) | 大屏 QSO 轮询（秒） | 大屏 QSO 轮询间隔（秒） |
| wallStationSec | Wall station poll (s) | 大屏电台轮询（秒） | 大屏电台轮询间隔（秒） |
| topLat | Map north latitude | 地图北纬 | 地图北界纬度 |
| bottomLat | Map south latitude | 地图南纬 | 地图南界纬度 |
| opponentWindowMin | Opponent window (min) | 对手窗口（分钟） | 对手统计窗口（分钟） |
| opponentCompactMin | Compact threshold | 紧凑模式阈值（对手数） | 紧凑模式阈值（对手数） |
| opponentBandsMax | Bands per card | 每卡频段上限 | 每卡频段数上限 |
| concentrationMin | Direction concentration | 方向集中度 | 方向集中度阈值 |

#### data（24）

| 键 | English | 中文 | 建议中文 |
| --- | --- | --- | --- |
| pollDxwatchSec | dxwatch poll (s) | dxwatch 轮询（秒） | dxwatch 轮询间隔（秒） |
| pollRbnSec | RBN poll (s) | RBN 轮询（秒） | RBN 轮询间隔（秒） |
| pollPskrSyncSec | PSKR sync (s) | PSKR 订阅同步（秒） | PSKR 订阅同步间隔（秒） |
| sourceDxwatch | Enable dxwatch | 启用 dxwatch | 启用 dxwatch |
| sourceRbn | Enable RBN | 启用 RBN | 启用 RBN |
| sourcePskr | Enable PSKReporter | 启用 PSKReporter | 启用 PSK Reporter |
| freshSec | Active spot window (s) | 活跃窗口（秒） | 活跃 SPOT 窗口（秒） |
| retentionSpotsDays | Spot retention (days, 0 = keep) | SPOT 保留（天，0 永久） | SPOT 保留天数（0 = 永久） |
| retentionRecordingMonths | Recording retention (months) | 录音保留（月） | 录制记录保留月数 |
| retentionQsoDays | QSO retention (days, 0 = keep) | QSO 保留（天，0 永久） | QSO 保留天数（0 = 永久） |
| autoPurge | Automatic purge | 自动清理 | 自动清理 |
| recordsRefreshSec | Records refresh (s) | 记录刷新（秒） | 记录刷新间隔（秒） |
| propPollSec | Propagation refresh (s) | 传播页刷新（秒） | 传播页刷新间隔（秒） |
| maxCallsigns | Max monitored callsigns | 被监控呼号上限 | 被监听呼号上限 |
| logLevel | Log level | 日志级别 | 日志级别 |
| httpProxy | HTTP proxy | HTTP 代理 | HTTP 代理 |
| fetchTimeoutMs | Upstream timeout (ms) | 上游超时（毫秒） | 上游请求超时（毫秒） |
| upstreamBase | SWPC base URL | SWPC 上游地址 | SWPC 上游地址 |
| n1mmPorts | N1MM UDP ports | N1MM UDP 端口 | N1MM UDP 端口（只读） |
| recordingRepeat | Recording repeat | 录音重复 | 录制重复周期 |
| diskWarnPct | Disk warn (%) | 磁盘告警阈值（%） | 磁盘告警阈值（%） |
| diskCheckSec | Disk check (s) | 磁盘检查间隔（秒） | 磁盘检查间隔（秒） |
| diskAlert | Disk alert | 磁盘告警 | 磁盘告警 |
| monitoring | Monitoring | 监控开关 | 监听开关 |

#### prop（10）

| 键 | English | 中文 | 建议中文 |
| --- | --- | --- | --- |
| propProj | Projection | 投影 | 投影方式 |
| propLayer | Layer | 图层 | 图层 |
| propDxLat | DX latitude | DX 纬度 | DX 目标纬度 |
| propDxLon | DX longitude | DX 经度 | DX 目标经度 |
| collectSec | Collector interval (s) | 采集间隔（秒） | 采集间隔（秒） |
| condClosed | Closed threshold | 关闭阈值 | 关闭阈值 |
| condGood | Good threshold | 良好阈值 | 良好阈值 |
| condFair | Fair threshold | 一般阈值 | 一般阈值 |
| mufOpacity | MUF opacity | MUF 透明度 | MUF 透明度 |
| nightOpacity | Night shading opacity | 夜罩透明度 | 夜侧阴影透明度 |

### 4.3 A3 字段说明 tooltip（79 条）

动态字段的描述通过 `title="${field.desc}"` 渲染，目前**只有英文**；中文用户悬停也看到英文。数量与 A2 相同（ui 4、map 16、qso 13、wall 12、data 24、prop 10）。

建议：

- 在 `schema.js` 为每个字段增加 `descKey`，或约定 `settings.field.<key>.desc`，由渲染层 `t()` 取译文；
- 英文保留现有 `desc` 作为兜底；
- 中文先补齐 79 条，再补其余 9 种语言。

示例（建议中文）：

| 键 | 现英文 | 建议中文 |
| --- | --- | --- |
| autoFitMaxZoom | Maximum zoom used by automatic fit | 自动适配时允许的最大缩放级别 |
| fitPad | Fractional padding around marker bounds | 标记范围四周的留白比例 |
| retentionRecordingMonths | Keep recorded spots for this many months | 录制记录保留月数，超期自动清理 |
| diskWarnPct | Warn when disk usage exceeds this percentage | 磁盘占用超过该百分比时告警 |
| quietFrom | Start of quiet hours (local clock) | 静音时段开始（浏览器本地时间） |
| quietTo | End of quiet hours; earlier than start means overnight | 静音时段结束；早于开始时间表示跨零点 |
| n1mmPorts | Read-only; configured in flow.json | 只读；在 flow.json 的 UDP 节点中配置 |
| concentrationMin | Minimum direction concentration for a single beam | 判定为单一主攻方向所需的最小集中度 |

### 4.4 A4 枚举选项（15 条）

生成式 `select` 直接显示原始值，未走词典：

| 字段 | 原始值（当前直接显示） | 建议显示 |
| --- | --- | --- |
| timeZone | utc / local | UTC / 本地时间 |
| logLevel | error / warn / info / debug | 错误 / 警告 / 信息 / 调试 |
| recordingRepeat | once / daily / weekly | 一次性 / 每天 / 每周 |
| propProj | mercator / azimuthal / robinson | 墨卡托 / 方位圆盘 / 罗宾逊 |
| propLayer | muf / weather / aurora | MUF 场 / 天气 / 极光 |

`propProj`、`propLayer` 的译文在传播页词典里已有（`propMercator`、`propLayerMuf` 等），设置页生成控件应复用同一组键，避免两份。

### 4.5 B 大屏页（49 条）

大屏没有 i18n：`bigscreen/index.html` 固定 `<html lang="zh">`，标签直接用中文；数据值中的 `Good/Fair/Poor/Closed` 和星期缩写直接用英文。

| # | 位置 | 现文案 | 建议英文 | 建议键 |
| --- | --- | --- | --- | --- |
| 1 | 倒计时 | 距结束 | Time left | `wall.timer.toEnd` |
| 2 | 分组 | 环境 | Environment | `wall.group.env` |
| 3 | 卡片 | 空间天气 | Space weather | `wall.card.space` |
| 4 | 图表标题 | SFI 30 日趋势 | SFI · 30-day trend | `wall.chart.sfi30` |
| 5 | 卡片 | 频段条件 | Band conditions | `wall.card.bands` |
| 6 | 分组 | 成绩 | Score | `wall.group.score` |
| 7 | 卡片 | 各操作员 | By operator | `wall.card.byOp` |
| 8 | 卡片 | 各频段 | By band | `wall.card.byBand` |
| 9 | 分组 | 对手监测 | Opponents | `wall.group.opp` |
| 10 | 卡片 | 电台 | Station | `wall.card.station` |
| 11 | 卡片 | QSO 速率 | QSO rate | `wall.card.rate` |
| 12 | 速率 | 每分钟 | per minute | `wall.rate.perMin` |
| 13 | 速率图 | 最近 12 小时 | Last 12 hours | `wall.rate.last12h` |
| 14 | 图表 | QSO 趋势 | QSO trend | `wall.chart.qso` |
| 15 | 图表 | SPOT 趋势 | SPOT trend | `wall.chart.spot` |
| 16 | 倒计时 | 距开始 | Starts in | `wall.timer.toStart` |
| 17 | 倒计时 | 已结束 | Ended | `wall.timer.ended` |
| 18 | 电台卡 | 等待电台数据… | Waiting for radio data… | `wall.station.waiting` |
| 19 | 时钟 | SUN…SAT | 用 `Intl.DateTimeFormat` 或词典 | `wall.weekday.*` |
| 20 | 频段卡 | Good/Fair/Poor/Closed | 译成目标语言 | `prop.cond.*`（复用） |
| 21 | 电台卡 | RADIO n | Radio n | `wall.station.radio` |
| 22 | 空间天气轮播 | 30 日趋势 | 30-day trend | `wall.span.d30` |
| 23 | 空间天气轮播 | 24 月趋势 | 24-month trend | `wall.span.m24` |
| 24 | 空间天气轮播 | 近 5 日趋势 | Last 5 days | `wall.span.d5` |
| 25 | 空间天气轮播 | 近 3 日趋势 | Last 3 days | `wall.span.d3` |
| 26 | 空间天气轮播 | 近 2 小时趋势 | Last 2 hours | `wall.span.h2` |
| 27 | 空间天气轮播 | 近 24 小时趋势 | Last 24 hours | `wall.span.h24` |
| 28 | 图表空态 | 趋势等待数据 | Waiting for trend data | `wall.chart.waiting` |
| 29 | 方位 | 北 | N | `wall.dir.n` |
| 30 | 方位 | 东北 | NE | `wall.dir.ne` |
| 31 | 方位 | 东 | E | `wall.dir.e` |
| 32 | 方位 | 东南 | SE | `wall.dir.se` |
| 33 | 方位 | 南 | S | `wall.dir.s` |
| 34 | 方位 | 西南 | SW | `wall.dir.sw` |
| 35 | 方位 | 西 | W | `wall.dir.w` |
| 36 | 方位 | 西北 | NW | `wall.dir.nw` |
| 37 | 对手 | 多向 | Multi-direction | `wall.opp.multi` |
| 38 | 对手 | N 个方向样本 | N direction samples | `wall.opp.samples` |
| 39 | 对手 | 无坐标样本 | No located samples | `wall.opp.noSamples` |
| 40 | 对手 | （仅 1 个，方向仅供参考） | (single sample; direction indicative only) | `wall.opp.thin` |
| 41 | 对手 | N 频段 · M SPOT | N bands · M spots | `wall.opp.meta` |
| 42 | 对手 | 最近 N 分钟无对手 SPOT | No opponent spots in the last N min | `wall.opp.empty` |
| 43 | 对手汇总 | N 对手 · M 频段 | N opponents · M bands | `wall.opp.summary` |
| 44 | 图层 | 传播场 | Propagation field | `wall.layer.prop` |
| 45 | 图层 | 极光 | Aurora | `wall.layer.aurora` |
| 46 | 图层 | 天气 | Weather | `wall.layer.weather` |
| 47 | 图层 | 我方 SPOT | My spots | `wall.layer.mySpot` |
| 48 | 图层 | 对手 SPOT | Opponent spots | `wall.layer.dxSpot` |
| 49 | 图层标签 | ALL LAYERS · N | 可保留英文，或本地化 | `wall.layer.all` |

其他大屏问题：

- `<html lang="zh">` 固定，应随 `settings.lang` 更新；
- 星期用 `['SUN',…]` 硬编码，应用 `Intl.DateTimeFormat(lang,{weekday:'short'})`；
- 频段条件 `Good/Fair/Poor/Closed` 是服务端原始值，建议在前端映射到 `prop.condGood/Fair/Poor/Closed`，与传播页共用；
- 大屏已通过设置接口拿到 `lang`，不需要新增 API。

### 4.6 C 主界面/记录/地图残留（14 条）

| # | 位置 | 现文案 | 建议 | 落地方式 |
| --- | --- | --- | --- | --- |
| 1 | `index.html` `#btnSpotView` | title="Spot grid" | `spotView` 或“SPOT 分屏” | JS 设置 `title` |
| 2 | `#btnQsoView` | title="QSO map" | `qsoView` | 同上 |
| 3 | `#btnPropView` | title="Propagation map" | `propView` | 同上 |
| 4 | `#connDot` | title="Live data link" | `connState` | 同上 |
| 5 | `#rotateGroup` | title="Page through callsigns…" | `rotateGroupHint` | 同上 |
| 6 | `#btnClearDb` | title="Delete all spot records…" | `clearDbTitle` | 同上 |
| 7 | `#saClose` | title="Close" | `close` | 同上 |
| 8 | QSO 速率横轴 | `-60m` | `rateFrom60` | JS 写入 |
| 9 | QSO 速率横轴 | `-30m` | `rateFrom30` | 同上 |
| 10 | QSO 速率横轴 | `now` | `now`（已有键） | 同上 |
| 11 | 记录表头 | `'Time (Local)'` | `timeLocal` | `records-page.mjs` |
| 12 | Spot 地图 | title="Clear map" | `clearMap` | `spot-page.mjs` |
| 13 | 时钟前缀 | `'LOCAL'` | `localTime`（保留 UTC） | `main.mjs` |
| 14 | 底图名称 | `高德地图 (AMap)` | 中文保留，其他语言用 `AMap (AutoNavi)` | `base-map.mjs` |

### 4.7 无需翻译（明确豁免）

- 产品/数据源名：RBN、PSK Reporter、dxwatch、N1MM Logger+、QRZ.com、SWPC、GIRO/DIDBase、GAMBIT、SDO、OVATION、DX-COMPASS。
- 模式/竞赛缩写：CW、SSB、FT8、FT4、RTTY、QSO、CQ、RST、RUN、S&P、SO1R、M2、MULT。
- 单位与符号：kHz、MHz、dBi、dBd、ms、km、nT、km/s、p/cm³、%、Å。
- 示例呼号/网格：BG7TVF、OM89vx（只翻译前缀 “e.g.”）。
- 赛事组别、CQ 分区、ITU 分区等标准代号。

### 4.8 已翻译但不专业/不统一（22 组）

| # | 位置 | 现状 | 建议 | 原因 |
| --- | --- | --- | --- | --- |
| 1 | zh `records` | `Spot Records` | `SPOT 记录` 或 `播报记录` | 中文块残留英文 |
| 2 | zh `tabAll` | `全部 Spot` | `全部播报` | 中英混排 |
| 3 | zh `spotsN` | `n + ' spots'` | `n + ' 条播报'` | 中文界面输出英文 |
| 4 | zh `mySpotSection` | `本台 Spot` | `本台被播报` | 语义是“他人对本台的播报” |
| 5 | zh `myGrid` | `梅登海德` | `梅登黑德` | 音译不统一 |
| 6 | zh `ttlTitle` | `标记点存活时间` | 与 schema 统一为 `标记存活时间` | 同一设置两种叫法 |
| 7 | zh `contestCat` | `竞赛组别` | schema 改 `竞赛组别` | schema 现为“比赛类别” |
| 8 | zh `wallTitle` | `大屏名称` | schema 改 `大屏标题` | 同一字段两种叫法 |
| 9 | zh `qsoView` / `spotView` | `QSO 地图` / `Spot 网格` | `QSO 地图` / `SPOT 分屏` | “网格”与 Maidenhead 混淆 |
| 10 | zh `wallProp` | `传播渲染图` | `传播场` | MUF 场图层 |
| 11 | zh `propBestBand` | `当前最佳波段` | `当前最佳频段` | band 统一“频段” |
| 12 | zh `pcSfi` | `太阳通量` | `太阳通量指数（SFI）` | 专业全称 |
| 13 | zh `pcSsn` | `黑子数` | `太阳黑子数（SSN）` | 易误解为一般黑子 |
| 14 | zh `pcA` | `A 指数` | `Ap 指数` | 标准是 Ap，不是 A |
| 15 | zh `rdToa` | `发射角` | `发射仰角（TOA）` | 避免与方位角混淆 |
| 16 | zh `propLayerMuf` | `传播预测` | `MUF 场` | 该图层是 MUF 场，不是整体预测 |
| 17 | zh `resetAll` | `一键清除` | `全部重置` | 实际是重置设置，不是清库 |
| 18 | en/de/fr/es/pt/it/ru `lblAge` | Since/Seit/Depuis/Desde/Desde/Da/С | AGO/ago/vor/il y a/hace/há/fa/назад | 中文“距上次”是 AGO，不是 SINCE |
| 19 | 全部语言 `headAll/headRec` | `Spotter (DE)` | `Spotter` / `监听台` | DE 易被读成德国（Germany） |
| 20 | de/fr/es/pt/it `myGrid` | Grid/grille/cuadrícula/grade/reticolo | Maidenhead-Locator / locator Maidenhead / localizador Maidenhead / localizador Maidenhead / locatore Maidenhead | “Grid”在德语=电网/网格计算，易误解 |
| 21 | ko `mySpotSection` | `내 Spot` | `내 스폿` | 韩文混拉丁字母 |
| 22 | schema 5 处中文 | `监控开关`、`录音保留（月）`、`静音开始/结束`、`地图北纬/南纬`、`关闭阈值` | `监听开关`、`录制记录保留月数`、`静音时段开始/结束`、`地图北界/南界纬度`、`关闭阈值（可用度）` | 术语与语义修正；“录音”会让人以为是音频 |

补充：

- `propApprox` 建议 `近似预报`（forecast），`rdMufDe` 建议 `MUF 本台`（DE 歧义），`propScR` 建议 `短波中断（R 级）`。
- 俄语用“споты”属当地业余无线电社区习惯，可保留；阿拉伯语 `stMults` = “المضاعفات”（数学倍数）建议改为竞赛语境 `معاملات`，需母语审校。

---

## 5. 词典键名组织方案

### 5.1 原则

1. **单一源语言**：中文为源，英文为第二源；其余 9 种从这两者翻译，禁止从机翻结果二次翻译。
2. **命名空间**：新键统一 `域.子域.语义`，全小写，点号分隔；旧扁平键通过别名表过渡。
3. **与 schema 1:1**：每个 `SETTINGS_FIELDS.key` 必须有 `settings.field.<key>.label` 与 `.desc`，枚举值必须有 `.option.<value>`。
4. **整句成键**：禁止 `t('a') + ' ' + t('b')` 拼句；带数量用函数或 `{n}` 占位。
5. **术语唯一**：同一概念全站一个词（band=频段、spot=SPOT/播报、wall=大屏、profile=配置档）。
6. **缩写保留**：CW/SSB/FT8/QSO/CQ/RST/MUF/SFI/SSN/Kp/Ap/Dst/Bz/Bt/TOA/RBN/DRAP 原样保留，避免“翻译后反而看不懂”。

### 5.2 建议命名空间

```
common.*            确定/取消/保存/关闭/刷新/加载中/空
nav.*               菜单与页面切换
a11y.*              aria-label / title
voice.*             语音播报短语
error.*             用户可见错误

spot.*              SPOT 地图：标题、计数、监听、轮播、频段框、图例
qso.*               QSO 地图：电台卡、速率、趋势、年龄、RUN/S&P
records.*           记录表：表头、页签、录制、空态、CSV
prop.*              传播页：图层、投影、空间天气、矩阵、大洲、署名

wall.group.*        大屏分组标题
wall.card.*         大屏卡片标题
wall.chart.*        大屏图表标题/空态
wall.span.*         空间天气轮播时间跨度
wall.timer.*        倒计时
wall.dir.*          八方位
wall.opp.*          对手监测
wall.layer.*        图层与图例
wall.weekday.*      星期缩写

settings.tab.*      6 个页签
settings.section.*  分区标题
settings.reset.*    分域重置
settings.backup.*   导出/导入
settings.profile.*  配置档
settings.import.*   导入反馈
settings.search.*   搜索
settings.flag.*     预览/只读/需重启
settings.domain.<ui|map|qso|wall|data|prop>.title|hint
settings.field.<schemaKey>.label|desc|unit
settings.field.<schemaKey>.option.<value>
settings.data.hint  等长提示
```

示例：

```
settings.field.retentionRecordingMonths.label
settings.field.retentionRecordingMonths.desc
settings.field.timeZone.option.utc
settings.field.timeZone.option.local
settings.field.logLevel.option.error
wall.opp.summary            // "{n} 对手 · {m} 频段"
wall.timer.toEnd            // "距结束"
records.head.timeLocal      // "时间（本地）"
prop.legend.muf             // "MUF"
```

### 5.3 文件组织

当前 `i18n.js` 是传统脚本，`index.html` 用 `<script src>` 加载；大屏是 module，不加载词典。

**第一阶段（不动模板，可立即做）**

- 仍在 `public/js/i18n.js` 内重组：按 `common/nav/spot/qso/records/prop/wall/settings` 分成多个 `const` 对象，末尾合并成 `I18N`；
- **保留** `PROP_I18N`、`PROP_CARD_I18N` 与两行 `Object.assign`（71 个键是传播页真实独有键，见 §2.4）；
- 新增键先只进词典，不接线，避免和设置页改版冲突。

**第二阶段（设置页改版完成后）**

```
public/js/i18n/
  index.js         // 聚合，保持 window.I18N 兼容
  common.js
  nav.js
  spot.js
  qso.js
  records.js
  prop.js
  wall.js
  settings.js
```

每个文件导出 `{zh:{...}, en:{...}, ...}`，`index.js` 合并。需要给 `index.html` 增加若干 `<script>`，属于模板改动，放到第二阶段。

**第三阶段（大屏）**

- 新建 `public/shared/i18n/wall.mjs`，复用 `createI18n`；
- 大屏 `main.mjs` 读取设置里的 `lang`，构造 `t()` 后传给 `wall-cards/wall-charts/wall-opponents/wall-page`；
- 更新 `<html lang>` 与星期格式（`Intl.DateTimeFormat`）。

### 5.4 旧键兼容

旧键 204 个，已散落在 83 处调用。迁移方式：

1. 建立 `LEGACY_ALIASES`：`records → records.title`、`headAll → records.head.all` 等；
2. 过渡期内 `I18N` 同时保留旧键与新键；
3. 页面代码逐步换成新键；
4. 全部替换后删除别名表，并用 lint 禁止旧键再次出现。

### 5.5 质量门禁（建议加入 `tests/main-i18n.test.mjs`）

1. 11 个语言键集合完全一致，无空值、无 `undefined`；
2. 值不得等于键名（防止未翻译回显）；
3. 禁用译法正则：`蚂蚁|钻机|乐队|斑点|终结者|噪声地板|夏令时（Dst 语境）|登录簿|个人资料（profile）`；
4. 每个 `SETTINGS_FIELDS.key` 在 11 个语言里都有 `label` 与 `desc`；
5. 每个枚举值都有对应 `option` 键；
6. 大屏 JS/HTML 中不得出现中文（豁免注释与数据源名）；
7. `i18n.js` 中不得再出现重复词典块；
8. 占位符 `{n}` 在译文里必须保留同名的占位符。

---

## 6. 落地顺序与文件影响

| 阶段 | 内容 | 可改文件 | 状态 |
| --- | --- | --- | --- |
| P1 词典内修订 | 22 组术语修订、保留并守卫 71 个传播键、预置 370 个新键 | `public/js/i18n.js`、`tests/i18n-dictionary.test.mjs` | ✅ 已完成（见 §8） |
| P2 设置页 | 79 标签 + 79 说明 + 15 枚举 + 47 骨架，`bi()` → `t()` | `schema.js`、`settings-page.mjs`、`index.html` | ⛔ 等设置页改版完成 |
| P3 大屏 | 49 条 + `<html lang>` + 星期/天气等级 | `bigscreen/index.html`、`wall-*.mjs` | ⛔ 需要模板/JS 改动 |
| P4 主界面残留 | 14 条 title/placeholder/轴标签/表头/底图名 | `index.html`、`records-page.mjs`、`spot-page.mjs`、`main.mjs`、`base-map.mjs` | ⛔ 需要 JS/模板改动 |
| P5 门禁 | 键齐、空值、禁用词、schema 覆盖、中文残留 | `tests/main-i18n.test.mjs`、脚本 | ✅ 可与 P1 同步 |

**本轮可直接落地且不冲突的只有 P1**：只改纯词典 `public/js/i18n.js`。其余等设置页改版结束、你确认后再动。

---

## 7. 附：现有键统计

| 项目 | 数值 |
| --- | --- |
| `LANGS` | 11 |
| `I18N` 原始每语言键数 | 133 |
| `PROP_I18N` 每语言键数 | 47（与 `I18N` 重复 0） |
| `PROP_CARD_I18N` 每语言键数 | 24（与 `I18N` 重复 0） |
| P1 前合并后键数 | 204 |
| `I18N_EXTRA` 新增键数 | 370（zh/en 手写，其余 9 语言英文回退） |
| P1 后每语言键数 | **574** |
| 代码中字面量 `t()` 键 | 83 |
| 字面量缺失键 | 0 |
| `SETTINGS_FIELDS` | 104（ui 4 / map 16 / qso 13 / wall 12 / data 24 / prop 10，含 25 个旧控件） |
| 动态生成设置字段 | 79 |
| 设置页 `bi()` 调用 | 34 对（部分为模板字符串，按 47 条文案计） |
| 大屏 i18n 键 | 0（已预置 `wall.*` 59 键，未接线） |

---

## 8. P1 落地记录（2026-11-10）

### 8.1 术语修订（111 处键值，覆盖审计 §4.8 的 21 组 + 补充统一）

| # | 键 | 修订前 | 修订后 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `records` (zh) | `Spot Records` | `SPOT 记录` | 英文残留 + 大小写 |
| 2 | `tabAll` (zh) | `全部 Spot` | `全部 SPOT` | 术语统一 |
| 3 | `spotsN` (zh) | `n + ' spots'` | `n + ' 条 SPOT'` | 英文残留 |
| 4 | `mySpotSection` (zh/ko) | `本台 Spot` / `내 Spot` | `本台 SPOT` / `내 스폿` | 术语统一 |
| 5 | `subtitle`/`startMon`/`stopMon` (zh) | `Spot…` / `开始监控` | `SPOT…` / `开始监听` | monitoring ≠ 监控 |
| 6 | `mySpotTtl/Max/Popup/Voice` (zh) | `本台 Spot …` | `本台 SPOT …` | 与 §4 术语一致 |
| 7 | `resetConfirm`/`cfgHint`/`askClearDb` (zh) | `Spot …` | `SPOT …` | 英文残留 |
| 8 | `mySpot*` (en) | `My-spot …` | `My spot …` | 连字符不规范 |
| 9 | `myGrid`（11 语言） | `梅登海德` / `Mein Grid` | `梅登黑德` / `Maidenhead-Locator` | 译名与 locator 用词 |
| 10 | `ttlTitle` (zh) | `标记点存活时间` | `标记存活时间` | 与 schema 一致 |
| 11 | `wallTitle` (zh) | `大屏名称` | `大屏标题` | 与 schema 一致 |
| 12 | `spotView` (zh) | `Spot 网格` | `SPOT 分屏` | 避免与 Maidenhead 网格混淆 |
| 13 | `wallProp` (zh) | `传播渲染图` | `传播场` | 与 `Propagation field` 对齐 |
| 14 | `propBestBand` (zh) | `当前最佳波段` | `当前最佳频段` | 波段≠频段 |
| 15 | `pcSfi` (zh/en/ru) | `太阳通量` / `Solar flux` | `太阳通量指数（SFI）` | 补缩写 |
| 16 | `pcSsn`（11 语言） | `黑子数` / `Flecken` / `Taches` | `太阳黑子数（SSN）` / `Sonnenflecken` / `Taches solaires` | 补限定词 |
| 17 | `pcA`（11 语言） | `A 指数` / `A index` | `Ap 指数` / `Ap index` | 行星性指数是 Ap |
| 18 | `rdToa` (zh/en) | `发射角` / `TOA` | `发射仰角` / `Take-off angle` | 术语 |
| 19 | `propLayerMuf`（11 语言） | `传播预测` / `Propagation forecast` | `MUF 场` / `MUF field` | 图层是 MUF 场 |
| 20 | `resetAll` (zh) | `一键清除` | `全部重置` | 与 `Reset all` 对齐 |
| 21 | `lblAge`（11 语言） | `距上次` / `Since` / `Seit` | `距今` / `Ago` / `Vor` | 该列是“多久以前” |
| 22 | `headAll`/`headRec` 第 2/3 列（11 语言） | `监听站 (DE)` / `Spotter (DE)` | `监听台` / `Spotter` | DE 易误读为德国 |
| 23 | `propSetGrid` (zh) | `本机网格` | `本台梅登黑德网格` | 与 #9 一致 |
| 24 | `propApprox` / `propScR` (zh) | `近似预测` / `无线电中断` | `近似预报` / `短波中断（R 级）` | 术语 |
| 25 | `stMults` (ar) | `مضاعفات` | `معاملات` | 竞赛乘数用词 |

> 审计 §4.8 第 22 组（schema 中文标签不规范）本轮不动 `schema.js`，其修正体现在新增的 `settings.field.*.label`（如 `category` → `竞赛组别`、`monitoring` → `监听开关`、`retentionRecordingMonths` → `录制记录保留月数`）。

> 实际落地的键值改动共 **111 处**（zh 36、en 13、de/fr/es/pt/it 各 7、ru/ar 各 8、ko 6、ja 5）。

### 8.2 传播块：保留而非删除

按 §2.4 复核结果，`PROP_I18N`（47）与 `PROP_CARD_I18N`（24）与主词典**零重复**，删除会让传播页失效。本轮：保留两块与合并，仅做上表术语修订；并为新增的 `I18N_EXTRA` 合并加冲突守卫 `I18N_MERGE_DUPLICATES`。

### 8.3 新增键（370 个 / 每语言）

| 命名空间 | 键数 | 内容 |
| --- | --- | --- |
| `settings.domain.*` | 12 | 6 个域的标题 + 说明 |
| `settings.tab.*` | 6 | 设置页 6 个页签 |
| `settings.section.*` | 7 | 分组标题 |
| `settings.action.*` | 8 | 导出/导入/搜索/配置档/重置按钮 |
| `settings.hint.*` | 6 | 分组提示、空搜索结果、无配置档 |
| `settings.flag.*` | 3 | 预览 / 只读 / 需重启 |
| `settings.profile.*` | 7 | 配置档保存、应用、删除、确认 |
| `settings.import.*` | 5 | 导入校验与部分导入 |
| `settings.reset.*` | 2 | 分组重置确认 |
| `settings.field.*.label` | 104 | 与 schema 字段 1:1 |
| `settings.field.*.desc` | 104 | 字段 tooltip（中文首次成文） |
| `settings.field.*.option` | 47 | 12 个枚举字段的全部选项（含 11 种语言名） |
| `wall.*` | 59 | 大屏分组、卡片、图表副标题、倒计时、图层、图例、对手摘要、方位、星期 |

**语言覆盖**：

- `zh`、`en`：**人工撰写**，逐条对齐术语表。
- `de`、`fr`、`es`、`pt`、`ru`、`it`、`ar`、`ko`、`ja`：合并时**回退英文**，键已存在、`t()` 可解析，**待母语校对**。校对时只需在 `I18N_EXTRA` 下补同名语言对象，合并逻辑会自动覆盖。
- 校对优先级建议：`de`（业余无线电用户量大）→ `ja` → `ru` → `fr` → `es` → `pt` → `it` → `ko` → `ar`。

### 8.4 校验用例

新增 [tests/i18n-dictionary.test.mjs](../tests/i18n-dictionary.test.mjs)，8 个用例：

1. 11 种语言键集合完全一致；
2. 无空值、无“值等于键名”（4 个合法小写英文例外白名单）；
3. 每个键的 `{placeholder}` 集合跨语言一致（含函数值与数组值）；
4. 源码四个词典块内**无重复键**（按深度 0 逐语言扫描，不依赖字符串搜索）；
5. `I18N_MERGE_DUPLICATES` 为空，`I18N_EXTRA` zh/en 键集一致且 ≥300；
6. 禁用译法全局扫描：蚂蚁、钻机、乐队、斑点、终结者、夏令时、噪声地板、登录簿、个人资料、梅登海德、最大可用频率；
7. schema 104 字段的 `label`/`desc` 与全部枚举选项在 11 语言中均存在；
8. 代码中 83 个字面量 `t('key')` 在 11 语言中均可解析。

`npm test` 结果：**152 个用例全部通过**（原 144 + 新增 8）。
