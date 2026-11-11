# DX-Compass 设置页调研报告

> 调研对象：`d:\岑溪基地\Node-Red-Contesting-Dashboard`（DX-Compass，Node-RED + 静态前端 + 只读大屏）
> 调研方式：通读前端 `public/`、服务端 `lib/`、Node-RED 流程 `flow.json`、启动配置 `settings.js`/`install.sh`，逐项追踪每个设置项的默认值、校验、存储与真实读取点。
> 所有引用均给出 `文件:行号`。文中“现状值”指代码中写死的常量，不是运行时实测值。

---

## 1. 摘要

1. 设置页（`#configPanel`，`public/index.html:240-449`）目前只有 **4 个页签**：Global / Spot Map / QSO Map / Wall，实际承载 **28 个顶层设置键 + 3 个 TTL 子键 + 12 个频段颜色**（`public/js/settings-model.mjs:20-33`）。
2. 设置**全部是“前端展示类”**：真正被服务端读取的只有 `grid`、`myCall`、`propDxLat/propDxLon` 三项（`lib/propagation/service.js:27-38`、`lib/spots/normalize.js:24-28`）；其余都由浏览器自己消费。数据采集频率、上游源地址、保留期限、告警阈值等**完全没有进入设置体系**。
3. 设置存储是**双写**：`localStorage['dxcompass-settings']` + 服务端 global context `uiSettings`（`lib/settings/service.js:8-14`），再通过 WebSocket `{type:'settings'}` 广播（`flow.json:2376` → `Broadcast spots` `flow.json:430-439`）。`layout`、监控开关、轮播间隔**游离在 schema 之外**。
4. 最大的结构性问题是**服务端零校验、整体覆盖写、无 schema 版本迁移**：`lib/settings/service.js:8-14` 只判断“是不是对象”，任何脏数据都能写入并广播；两个浏览器同时改设置会互相覆盖。
5. 报告给出 **12 条“必做” + 8 条“建议” + 5 条“可选”** 新增设置，并为每条标注现状代码位置、控件、默认值、风险与成本。

---

## 2. 现有设置清单

### 2.1 Global 页签（`public/index.html:255-280`）

| 设置项 | DOM / 键 | 作用与真实读取点 | 存储位置 | 默认值 | 校验规则 | 生效方式 |
|---|---|---|---|---|---|---|
| 界面语言 | `#setLang` / `lang` | 11 种语言文案；`public/js/main.mjs:15-17`、`settings-page.mjs:89-142` | localStorage + `uiSettings` | `'zh'`（`settings-model.mjs:22`） | 必须属于 `UI_LANGUAGES`（`settings-model.mjs:17`、`:39`） | 即时，无需刷新 |
| 主题 | `#setTheme` / `theme` | `document.body.dataset.theme`；`settings-page.mjs:13-16` | 同上 | `'dark'` | `THEMES` 枚举 `dark/light/ocean/amber`（`settings-model.mjs:11`、`:40`） | 即时 |
| 底图 | `#setTiles` / `tiles` | `TILE_PROVIDERS` 选择 OSM / 高德；`settings-page.mjs:59-65` | 同上 | `'osm'` | 键必须存在于 `TILE_PROVIDERS`（`shared/map/base-map.mjs:14-25`、`settings-model.mjs:41`） | 即时，逐格换层 |
| 我的呼号 | `#setMyCall` / `myCall` | ① **服务端会把它自动并入被监控呼号**并用于“我的 SPOT”过滤（`lib/spots/normalize.js:24-28`）；② 本台呼号展示（`qso-page.mjs:531`） | 同上 | `''` | 空或 `/^[A-Z0-9/]{3,12}$/`（`settings-model.mjs:43-46`、`settings-page.mjs:369-372`） | 即时；服务端下一轮采集生效 |
| 我的网格 | `#setGrid` / `grid` | QSO 地图本台位置（`qso-page.mjs:41`）与传播页 DE 点（`lib/propagation/service.js:27-33`） | 同上 | `''` | Maidenhead（`isValidMaidenhead`，`settings-model.mjs:42`） | 即时（传播页会重新请求） |
| 重置全部 | `#btnResetAll` | `POST /api/reset` + `POST /api/callsigns []` + 清 3 个 localStorage 键（`settings-page.mjs:424-437`） | — | — | 二次确认弹窗（自定义暗色 modal） | 立即 `location.reload()` |

### 2.2 Spot Map 页签（`public/index.html:283-313`）

| 设置项 | DOM / 键 | 作用与真实读取点 | 存储位置 | 默认值 | 校验规则 | 生效方式 |
|---|---|---|---|---|---|---|
| 被监控呼号（9 槽） | `.cfg-call` × 9 / 服务端 `monitoredCalls` | 地图格子分配、轮播、历史回放；`lib/settings/service.js:20-32` | 服务端 global `monitoredCalls`（**不在 `uiSettings` 内**） | `[]` | 大写、去空、`slice(0,9)`（`:27`）；前端仅 `maxlength=16` | 保存后重新回填，只对新增呼号做 backfill |
| 标记存活 TTL（CW） | `#ttlCw` / `ttl.CW` | 标记/连线/频段 chip 消失时间；`spot-page.mjs:28` → `settings-model.mjs:98-102` | localStorage + `uiSettings` | `30` 分钟（`settings-model.mjs:9`） | 整数 1–180（`settings-model.mjs:76-79`、`settings-page.mjs:457-468`） | 即时（新标记用新 TTL，旧的按原到期时间） |
| 标记存活 TTL（SSB） | `#ttlSsb` / `ttl.SSB` | 同上；也是未知模式的兜底 | 同上 | `30` | 同上 | 即时 |
| 标记存活 TTL（DIGI） | `#ttlDigi` / `ttl.DIGI` | 同上 | 同上 | `30` | 同上 | 即时 |
| 频段颜色（12 段） | `#bandColors` / `bandColors` | 连线颜色、chip 边框、频段条形图；`bandColorOf()`（`settings-model.mjs:104-108`） | 同上 | 12 个十六进制色（`settings-model.mjs:4-8`） | `/^#[0-9a-fA-F]{6}$/`（`:80-86`） | 即时，含已画连线改色（`spot-page.mjs:451-460`） |

### 2.3 QSO Map 页签（`public/index.html:316-379`）

| 设置项 | DOM / 键 | 作用与真实读取点 | 存储位置 | 默认值 | 校验规则 | 生效方式 |
|---|---|---|---|---|---|---|
| 比赛类别 | `#setCategory` / `category` | 决定是否显示多机卡片（`qso-page.mjs:412-433`） | localStorage + `uiSettings` | `'SO1R'` | `CONTEST_CATEGORIES = SO1R/SO2R/MS/MM`（`settings-model.mjs:10`、`:48`） | 即时 |
| QSO 自动缩放 | `#setQsoAutoFit` / `qsoAutoFit` | `fitQsoMap`（`qso-page.mjs:72-81`） | 同上 | `true` | 布尔 | 即时 |
| 本台→QSO 大圆连线 | `#setQsoLines` / `qsoLines` | `qso-page.mjs:113` | 同上 | `true` | 布尔 | 即时，重建地图 |
| 语音告警 | `#setQsoVoice` / `qsoVoiceAlert` | `qso-page.mjs:570` | 同上 | `true` | 布尔 | 即时，关闭时 `speechSynthesis.cancel()` |
| QSO 标记上限 | `#setQsoMax` / `qsoMax` | 超出即丢最旧标记（`qso-page.mjs:132`） | 同上 | `1500` | 整数 200–4000（`settings-model.mjs:49-50`、`settings-page.mjs:385`） | 即时 |
| 我的 SPOT 标记寿命 | `#setMySpotTtl` / `mySpotTtl` | `qso-page.mjs:166,186` | 同上 | `30` 分钟 | 整数 1–180（`:55-56`） | 即时（重算 `_dieAt`） |
| 我的 SPOT 标记上限 | `#setMySpotMax` / `mySpotMax` | `trimMySpots`（`qso-page.mjs:173-183`） | 同上 | `300` | 整数 10–2000（`:57-58`） | 即时 |
| 我的 SPOT 弹窗 | `#setMySpotPopup` / `mySpotPopup` | `qso-page.mjs:553` | 同上 | `true` | 布尔 | 即时 |
| 我的 SPOT 语音 | `#setMySpotVoice` / `mySpotVoice` | `qso-page.mjs:552` | 同上 | `true` | 布尔 | 即时 |
| QRZ 用户名 | `#setQrzUser` | 登录换 XML Key（`flow.json:2007-2065`） | **flow context `qrzuser`**（`lib/settings/service.js:41-43`） | 空 | 非空字符串 | 保存后触发登录节点 |
| QRZ 密码 | `#setQrzPass` | 同上 | **flow context `qrzpass`（明文）** | 空 | 用户名+密码都必填（`service.js:38-40`） | 保存后 `qrzkey=null` 重新登录 |

### 2.4 Wall 页签（`public/index.html:381-439`）

| 设置项 | DOM / 键 | 作用与真实读取点 | 存储位置 | 默认值 | 校验规则 | 生效方式 |
|---|---|---|---|---|---|---|
| 大屏标题 | `#setWallTitle` / `wallTitle` | `public/bigscreen/wall-page.mjs:88` | localStorage + `uiSettings` | `'DX-COMPASS'` | trim 后 ≤24 字符（`settings-model.mjs:63-65`、`settings-page.mjs:398`） | 大屏 60s 拉取一次（`wall-page.mjs:194`） |
| 倒计时开关 | `#setWallTimerOn` / `wallTimerOn` | `wall-cards.mjs:25-31` | 同上 | `false` | 布尔 | 同上 |
| 倒计时开始/结束 | `#setWallTimerStart/End` | `wall-cards.mjs:27-28`，按 UTC 解析 | 同上 | `''` | `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/`（`:70-72`） | 同上 |
| 叠加模式 | `#setWallMode` / `wallMode` | `all` 全开 / `cycle` 逐层轮播（`wall-page.mjs:99-117`） | 同上 | `'all'` | 枚举 `all/cycle`（`:69`） | 同上 |
| 图层开关（6 个） | `#setWallProp/Aurora/Weather/Qso/MySpot/DxSpot` / `wallLayers` | `WALL_LAYERS` 过滤（`settings-model.mjs:12-16`） | 同上 | `['prop','qso','myspot','dxspot']` | 只保留白名单键（`:66-68`） | 同上 |

### 2.5 不在设置页、但属于“设置”的运行时状态

| 项 | 存储 | 位置 | 说明 |
|---|---|---|---|
| 布局 1×1/2×2/3×3 | **仅 localStorage** `dxcompass-settings.layout` | `settings-page.mjs:48-50`、`shared/data/settings.mjs:24` | 保存时显式剔除，不跨设备 |
| 监控开关 | **仅 localStorage** `dxcompass-monitoring` | `spot-page.mjs:20,424` | 刷新后本地恢复，再向服务端 `POST /api/monitoring` |
| 轮播间隔（3–600s，默认 15） | **仅 localStorage** `dxcompass-rot-sec` | `spot-page.mjs:24,509-523`、`index.html:129` | 不在 schema、不校验、不广播 |
| 录音计划（UTC，一次性） | 服务端 global `recording` | `lib/monitoring/recording.js:11-36`、`flow.json:1030-1067` | 面板在右侧 Records 栏，不在设置页 |
| 传播投影/图层/DX 点 | localStorage + `uiSettings` | `propagation-page.mjs:16-17,1084-1105` | 控件在传播页工具条（`index.html:80-83`） |
| N1MM 输入端口 | `flow.json` 写死 | `flow.json:1340,1437,1635` = UDP 12060/12061/12062 | 无法通过 UI 修改 |

---

## 3. 设置链路：存储、同步与生效

```
用户改动 → settings-page.mjs:274-314 (bind*Setting)
        → save()  :37-42 立即写 localStorage
        → 600ms 防抖（:41）→ pushNow() :28-35
        → POST /api/settings (shared/data/settings.mjs:15-26，剔除 layout)
        → lib/settings/service.js:12 global.set('uiSettings', body)
        → flow.json:2376 第二路输出 → WS 节点 “Broadcast spots”（flow.json:430-439）广播 {type:'settings'}
        → 其他浏览器 applyRemote() settings-page.mjs:154-221
```

关键事实：

- **服务端不校验、不补默认值**：`lib/settings/service.js:8-14` 只拒绝非对象。默认值只存在于前端 `defaultSettings()`（`settings-model.mjs:20-33`），服务端 `get` 返回原样 `uiSettings`。
- **整体覆盖写**：`saveSettings()` 发送整份对象（仅删 `layout`），`global.set` 整份替换。两个浏览器同时改不同项会**最后写入者覆盖全部**。
- **读取方**：`lib/propagation/service.js:188-191` 每次快照读取 `uiSettings`（所以 DE 点、DX 点即时生效）；`lib/spots/normalize.js:26` 读取 `myCall` 参与过滤。**TTL、主题、地图行为等服务端完全不读**。
- **持久化**：`settings.js:37-41` 使用 `localfilesystem` context storage，重启后保留；`settings.js:15` `credentialSecret: false`，QRZ 密码经 `flow.set` 落盘为明文。
- **需要重启才能改的项**：`flow.json` 中 inject 节点的 `repeat`（dxwatch 30s / RBN 10s / PSKR 同步 120s / 录音 tick 30s / 清理 3600s / 传播采集 300s）以及 UDP 端口，均**只能改 flow.json 并重启 Node-RED**。
- **死端点**：`GET/POST /api/config`（`flow.json:601-694`）返回空对象 / `{success:true}`，前端已无任何引用（全仓搜索 `/api/config` 无命中），可视为历史残留。

---

## 4. 当前设置体系的结构性问题

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| P1 | 服务端零校验、零默认值 | `lib/settings/service.js:8-14` | 脏数据可写入并被 WS 广播；非浏览器客户端（curl/脚本）可写入任意字段；服务端消费者（`propagation/service.js:34-36`）只能各自兜底 |
| P2 | 无统一 schema | 默认值/枚举/范围散落在 `settings-model.mjs`、`index.html`、`service.js`、`wall-page.mjs:36-42` | 四处各写一份默认值，新增一项要改 3–4 个文件；大屏有自己的兜底默认（`wall-page.mjs:36-42`） |
| P3 | 整体覆盖写，无合并/冲突处理 | `settings.mjs:23-25`、`service.js:12` | 多浏览器/多操作员同时配置会丢设置；无 `updatedAt`、无 ETag |
| P4 | 设置项散落 | 布局/监控/轮播在 localStorage（`spot-page.mjs:20,24`）；传播在传播页；录音在 Records 栏；比赛类别在 QSO 页签 | 用户找不到；无法导出/备份；更换浏览器后行为不一致 |
| P5 | 无迁移机制 | 仅 `cfgV: 2` + 一条 Mercator 迁移（`settings-model.mjs:60-61`） | 键改名/默认值调整会静默回到默认，旧值丢失 |
| P6 | 校验不一致 | 数字用 clamp 但无提示（`settings-page.mjs:302-314`）；文本用 `null` 静默还原（`:274-290`）；服务端不校验 | 用户不知道为何输入被改；不同入口规则不同 |
| P7 | 无“分域重置/导出/导入” | 只有全量重置（`settings-page.mjs:424-437`） | 调错一个值只能全部重来；无法备份比赛现场配置 |
| P8 | 明文凭据 | `settings.js:15`、`service.js:41-43` | QRZ 密码以明文存在 flow context 文件 |
| P9 | 无鉴权 + 全开 CORS | `settings.js:44-48` `httpNodeCors`，且 `/api/settings`、`/api/callsigns` 无任何鉴权（`flow.json:2321-2403`） | 同一网络内任何人都能改被监控呼号/大屏配置 |
| P10 | 大量业务参数根本没有设置入口 | 见附录 A（65 条硬编码） | 现场只能改代码/重启，违背“大屏产品化”定位 |
| P11 | 保存无失败反馈/无 flush | `pushNow()` 捕获异常后返回 `null`（`settings-page.mjs:33`），`save()` 无 toast；无 `beforeunload` flush | 后端 502 时用户以为已保存，实际上只有本机 localStorage 生效 |
| P12 | 轮播间隔不在 schema 内且不校验 | `spot-page.mjs:519` 仅 clamp 3–600，输入非数字回落 3 | 无法跨设备同步，也无法与“被监控呼号数/格子数”联动推导 |

---

## 5. 新增设置建议

> 每条格式：**设置项名称** ｜ 现状与代码位置 ｜ 为什么需要可配置 ｜ 控件 ｜ 默认值 ｜ 影响范围与风险 ｜ 实现成本。

### 5.1 必做（12 条）

#### B1. 数据源轮询间隔与启用开关

- **现状**：dxwatch 30s（`flow.json:277`）、RBN 10s（`:790`）、PSKReporter 订阅同步 120s（`:973`）、传播采集 300s（`:2422`），全部写死在 inject 节点；每次请求条数 `r=200` 写死在 URL（`lib/spots/service.js:34,65`）。改一次要改 flow.json 并重启。
- **为什么**：比赛高峰期需要更快刷新（RBN 5s），平日或弱网需要降频省流；上游封禁/WAF 限流时需要临时降频而不停机；离线演练需要完全关闭采集。
- **控件**：3 个数字输入（秒）+ 3 个开关；范围 5–300s。
- **默认值**：dxwatch 30 / RBN 10 / PSKR 120（保持现状）。
- **影响与风险**：中。需要把 inject 周期改为可重配的定时器（或改为 `setInterval` 节点 + 设置变更时重建），并给上游加最小间隔保护，避免用户设成 1s 打爆 RBN；PSKR 订阅同步不能低于 30s。
- **成本**：中（服务端定时器改造 + 设置下发到流程）。

#### B2. SPOT 活跃窗口与服务端“1 小时”上限

- **现状**：`fresh` 判定写死 3600s（`lib/spots/service.js:155,242,271`），前端按模式 TTL 渲染（`settings-model.mjs:98-102`），但服务端入库不看 TTL；大屏对手窗口固定 30min（`wall-opponents.mjs:191`）。
- **为什么**：不同比赛节奏（VHF 短促 vs HF 长传播）需要不同活跃窗口；用户调大 TTL 到 180 分钟时，服务端仍只回放 60 分钟，出现“地图有 TTL、历史却没有数据”的不一致。
- **控件**：数字（分钟）1–180，“服务端回放窗口”；另加一个“写入数据库但不在图上渲染”的说明性开关（当前是隐含行为）。
- **默认值**：60（保持硬性上限语义）。
- **影响与风险**：中高。服务端回放窗口变大会增加 `/api/spots` 与首屏回放负载；必须与数据库保留策略联动（见 B8），否则查询变慢。
- **成本**：中（`lib/spots/service.js` 接收设置 + 查询层索引）。

#### B3. 地图图层与标注显示开关

- **现状**：晨昏线固定每分钟刷新（`shared/map/terminator.mjs:72`）、热力图在 CW/DIGI 下强制开启且参数写死（`spot-page.mjs:96-98`）、大圆连线固定 64 采样（`:233`）、标记点大小/颜色固定（`:221,228`）、大屏只画海岸线（无开关）。
- **为什么**：弱性能终端（树莓派/老投影）需要关掉热力图与晨昏线；白天演示需要临时隐藏夜罩；裁判席只想看连线不想看散点；投影仪色差需要调点大小。
- **控件**：6 个开关（热力图 / 晨昏线 / 大圆连线 / 被监听点 / 监听站 / 频段 chip）+ 1 个数字（标记直径 8–24px）。
- **默认值**：全开；直径 14/12px（现状）。
- **影响与风险**：低。纯前端开关，但要保证关闭热力图后 `updateHeat()` 不继续计算（省 CPU），且布局切换后开关状态不丢。
- **成本**：低。

#### B4. 告警阈值与提示方式

- **现状**：弹窗固定 8s（`qso-page.mjs:13`）、语音速率 1.05/音量 1（`:510-511`）、换频阈值 >1kHz 才播报（`:562`）、无 SNR/距离门槛、无静音时段。
- **为什么**：夜间值守需要“只在 SNR ≥ X 或距离 ≥ Y 时响”；多人操作员需要不同语言/语速；比赛现场不希望每 10 秒被无关弱信号打断。
- **控件**：数字（弹窗秒数 2–30、SNR 阈值 -20..+30、距离阈值 0–20000km）+ 滑块（语速 0.6–1.6、音量 0–1）+ 时间区间（静音时段，UTC 或本地）+ 开关（仅播报本台/仅播报新频段）。
- **默认值**：8s / 无 SNR 门槛 / 无距离门槛 / 1.05 / 1.0 / 无静音。
- **影响与风险**：低。语音参数是浏览器 `SpeechSynthesisUtterance` 属性，跨浏览器表现略有差异；静音时段要用本地时区并允许跨零点。
- **成本**：低。

#### B5. 全局刷新节奏（前端 tick / 轮询）

- **现状**：淡出 tick 10s（`main.mjs:71-75`）、剪枝 30s（`:76`）、Records 15s（`records-page.mjs:207`）、传播 60s（`propagation-page.mjs:1055,1114`）、大屏 60/30/30/15/60s（`wall-page.mjs:190-194`）。
- **为什么**：大屏需要“秒级感”，后台笔记本需要“省电”；上游 SWPC 有速率限制，频繁拉取会被 429。
- **控件**：5 个下拉（1s/2s/5s/10s/30s/60s）或数字秒。
- **默认值**：保持现状（10/30/15/60）。
- **影响与风险**：中。tick 低于 1s 会明显增加 CPU；传播轮询低于 60s 会打到 SWPC 限流（采集端自身有 4–20 分钟缓存，见 `collector.js:34-36`，前端调快也不会真的多拿数据，需在 UI 提示）。
- **成本**：低–中（纯前端，但要把 setInterval 统一成可重配 poller）。

#### B6. 对手分析窗口与展示数量

- **现状**：对手窗口 30min（`wall-opponents.mjs:191-192`）、方向集中度阈值 0.4（`:195`）、频段排名表固定 13 段（`:183-184`）。
- **为什么**：大屏“对手”卡片是比赛决策核心；不同比赛（CQWW vs Field Day）关注窗口不同；小屏需要减少行数。
- **控件**：数字（窗口 5–120 分钟）、数字（最多显示几路对手 3–12）、开关（是否显示方向罗盘）。
- **默认值**：30 / 6 / 开。
- **影响与风险**：低。只影响大屏渲染，不改变数据采集；窗口变大会增加聚合耗时，需保留当前 O(n) 单遍实现。
- **成本**：低。

#### B7. 大屏轮播节奏与地图范围

- **现状**：图层轮播固定 10s（`wall-page.mjs:112`）、空间天气轮播 8s（`wall-charts.mjs:10`）、纬度范围写死 -85..85（`wall-map.mjs:28-29`）、大屏配置 60s 才同步（`wall-page.mjs:194`）。
- **为什么**：现场演示需要“每个图层停留 20s”；南半球台站需要调整纬度范围以放大本地；操作员改完配置希望 10s 内看到效果。
- **控件**：数字（图层停留 3–60s）、数字（空间天气停留 3–30s）、两个数字（地图北/南纬 -90..90）、数字（配置同步 10–300s）。
- **默认值**：10 / 8 / 85 / -85 / 60。
- **影响与风险**：中。纬度范围影响投影与航线裁剪（`wall-map.mjs` 有跨极截断逻辑），设成极端值会造成大陆裁切，需要夹紧并给出预设（全球/北半球/欧亚）。
- **成本**：低–中。

#### B8. 数据保留与清理策略

- **现状**：`recording_spots` 固定保留 2 个月（`lib/storage/recording-sql.js:17`，每小时清理 `flow.json:1078`）；`spots` **永不清理**；`qsos` **永不清理**；查询默认上限 spots 1000（`spot-sql.js:10`）、recording 1000（`recording-sql.js:10`）、qso 200（`qso-sql.js:22`）。
- **为什么**：长期运行（多站部署、连续赛事）下 `spots` 会无界增长，SQLite 文件膨胀、`/api/spots` 变慢；有些站点出于隐私要求只保留 7 天；有些需要保留整季。
- **控件**：数字（spots 保留天数 0=永久 / 7–365）、数字（recording 保留月数 1–12）、数字（qso 保留天数）、开关（是否自动清理）、按钮（立即清理）。
- **默认值**：spots 永久 / recording 2 个月 / qso 永久（保持现状）。
- **影响与风险**：中高。清理是破坏性操作，必须有二次确认与“清理前先备份”提示；`spots` 增加按 `timestamp` 的索引，否则删除慢。
- **成本**：中（新增清理 SQL + 定时任务 + 索引）。

#### B9. 统一设置 schema + 服务端校验 + 默认值回退

- **现状**：服务端只判断对象（`lib/settings/service.js:8-14`）；默认值只在前端（`settings-model.mjs:20-33`）；大屏另写一份默认（`wall-page.mjs:36-42`）。
- **为什么**：这是 B1–B8、S1–S8 全部落地的前提；没有服务端校验，新增的采集类设置会被任意值污染，且无法保证“老客户端写入不认识的键不会破坏新客户端”。
- **控件**：无 UI，属于架构项。
- **默认值**：以 `defaultSettings()` 为唯一来源，抽成 `public/shared/settings/schema.mjs` 由前后端共用（Node 端用 `require` 不了 ESM 时，生成一份 JSON 或 UMD 包装）。
- **影响与风险**：高（改动面广）。风险集中在迁移：必须保留 `cfgV` 并新增逐版本迁移函数，且服务端 `get` 对缺失键补默认、对非法值回落默认。
- **成本**：中–高（一次性）。

#### B10. 设置导出 / 导入 / 分域重置

- **现状**：只有“重置全部”（`settings-page.mjs:424-437`），会同时清 localStorage 与后端 `uiSettings`、呼号。
- **为什么**：比赛现场换机器、换浏览器、多人共用一台大屏；误改一个值不应全部重来；也需要“把配置发给队友”。
- **控件**：按钮（导出 JSON / 导入 JSON / 重置当前页签 / 重置全部）。
- **默认值**：—。
- **影响与风险**：中。导入必须走 B9 的校验；导出不得包含 QRZ 密码；重置应分域（Global / Spot / QSO / Wall / 传播）。
- **成本**：低（前端为主）。

#### B11. 时间与时区显示

- **现状**：UTC 时钟每秒刷新且不可配（`main.mjs:67-70`）；表格时间统一按本地格式（`ui.mjs` `formatTime`）；录音时间强制 UTC（`recording.js:26`）；大屏倒计时强制 UTC（`wall-cards.mjs:27-28`）。
- **为什么**：中国台站日常看本地时间，比赛规则看 UTC；有些操作员需要 12 小时制；跨时区多人协作需要明确标注。
- **控件**：下拉（UTC / 本地 / 两者并排）、开关（12/24 小时）、开关（是否显示秒）。
- **默认值**：UTC（保持现状）+ 24 小时 + 显示秒。
- **影响与风险**：低–中。涉及 `formatTime`、Records 表头、大屏时钟、录音表；必须统一走一个格式化函数，避免各页各写一套。
- **成本**：中（触及面广但逻辑简单）。

#### B12. 录音调度的保留与自动清理

- **现状**：调度为一次性 UTC 区间（`recording.js:11-36`），清理固定 2 个月（`recording-sql.js:17`），状态存 global，重启恢复。
- **为什么**：多日赛事需要“每天同一时段自动录”，目前只能一次性设置；不同站点磁盘大小差异大，2 个月可能撑爆分区（项目已有磁盘写满教训）。
- **控件**：开关（重复/一次性）、下拉（重复周期：每天/每周）、数字（保留月数 1–12）、数字（磁盘占用告警阈值 %）。
- **默认值**：一次性 / 2 个月 / 无告警。
- **影响与风险**：中。重复调度需要处理跨月与“错过开始时间”的补录策略；磁盘告警需要服务端读 `statfs`。
- **成本**：中。

### 5.2 建议（8 条）

#### S1. 传播模型与频段条件阈值

- **现状**：频段条件分级写死 `f > 0.97*muf → Closed`、`head > 0.55 → Good`、`> 0.25 → Fair`（`lib/propagation/model.js:474-479`）；10 个 HF 频段写死（`:8-13`）；MUF 透明度/夜罩/图例写死在共享常量（`forecast-view.mjs:16-22`）。
- **为什么**：不同操作员对“Good/Fair”的主观标准不同；VHF 台站需要 6m/2m；大屏投影偏暗时需要调夜罩透明度。
- **控件**：4 个数字（Closed/Good/Fair 阈值）+ 多选频段 + 2 个滑块（MUF 透明度、夜罩）。
- **默认值**：0.97 / 0.55 / 0.25；10 段；77/255、0.18。
- **风险与成本**：中。阈值改变会让历史截图不可比；频段列表变更会影响矩阵列数与底条宽度。成本低（常量改读设置），但需前后端同时改。

#### S2. 上游数据源地址、超时与并发

- **现状**：SWPC 15 个 URL 写死（`collector.js:38-53`）、Open-Meteo（`:59-62`）、HamQSL、kc2g、USGS（`geo.js:51`）、GAMBIT（`gambit.js:25`）；超时 25s（`collector.js:94`）、并发 4（`:434`）、缓存 TTL 4/10/20/30min（`:34-36,70`）、USGS 10min（`geo.js:8`）。
- **为什么**：国内访问 SWPC 偶发超时，需要代理或镜像；比赛现场断外网时需要“只用本地缓存”；上游改域名时需要不停机切换。
- **控件**：文本框（基地址，可留空=默认）+ 数字（超时 5–60s）+ 数字（并发 1–8）+ 开关（离线只用缓存）。
- **默认值**：默认地址、25s、4、关。
- **风险与成本**：中高。任意 URL 会带来 SSRF 风险，必须只允许 https + 白名单域；改并发会触发 WAF。成本中。

#### S3. 多台站信息与 N1MM 输入端口

- **现状**：UDP 12060/12061/12062 写死（`flow.json:1340,1437,1635`）；`radioStates` 已按 `radioNr` 动态存（`lib/qsos/service.js:10-14`），但无法配置台站名/操作员。
- **为什么**：多机位（SO2R/MS）场地端口冲突时需要改；大屏要显示“主叫台/系数台”名称。
- **控件**：3 个数字（端口）+ 文本（台站名）+ 文本（操作员）。
- **默认值**：12060/12061/12062、空。
- **风险与成本**：中。端口改动要重启 Node-RED（UDP 节点不支持热改），需在 UI 明确标注“需重启”。成本中。

#### S4. 网络代理与 User-Agent

- **现状**：UA 写死 `DX-Compass/2.0 ...`（`collector.js:33`）、dxwatch/RBN 伪装桌面 Chrome UA（`lib/spots/service.js:7-18`）。
- **为什么**：企业网/校园网必须走 HTTP 代理；上游按 UA 封禁时需要更换。
- **控件**：文本（HTTP(S) 代理 URL）、文本（UA 覆盖）。
- **默认值**：空、现状 UA。
- **风险与成本**：中。代理配置错误会让所有采集失败，需要“测试连接”按钮。成本中。

#### S5. 地图取景行为

- **现状**：自动适配最大缩放 7 级（`base-map.mjs:12`）、边界内边距 0.08（`:163`）、世界最小缩放按覆盖计算（`:154-160`）、滚轮可缩放但会被下次自动适配覆盖。
- **为什么**：大屏观看距离远，7 级可能太近导致频繁跳动；单格显示器需要更保守的适配。
- **控件**：数字（最大适配层级 3–10）、数字（内边距 0–0.3）、开关（是否允许手动缩放覆盖自动适配）。
- **默认值**：7 / 0.08 / 允许。
- **风险与成本**：低。层级过高会把单点放大到看不出位置；需保留“不得低于世界覆盖缩放”的约束。成本低。

#### S6. 视觉密度与配色微调

- **现状**：频段颜色已可配（`settings-model.mjs:4-8`），但热力图渐变（`spot-page.mjs:97-98`）、QSO 点大小（`qso-page.mjs:121-126`，固定 12px）、大屏频段色（`wall-opponents.mjs:25`）写死。
- **为什么**：投影仪色偏、色弱用户、不同频段习惯配色。
- **控件**：颜色选择器（热力图 6 个停靠点）、数字（QSO 点直径 6–20px）、开关（高对比模式）。
- **默认值**：现状。
- **风险与成本**：低。颜色可读性风险由用户自担，需提供“恢复默认”。

#### S7. 被监控呼号槽位的标签与顺序

- **现状**：9 个槽位只有呼号本身（`index.html:287-295`），服务端 `slice(0,9)`（`service.js:27`）；槽位顺序即地图格子顺序（`spot-page.mjs:298-306`）。
- **为什么**：对手多时 9 个不够；需要给对手加备注（“主要对手/系数台”）；需要拖动排序以匹配大屏布局。
- **控件**：文本（备注，≤24 字）+ 拖拽排序 + 数字（槽位上限 9–27）。
- **默认值**：9、无备注、按输入顺序。
- **风险与成本**：中。扩容要同步 `MAX_CELLS`（`spot-page.mjs:12`）与 PSKR 订阅数量（每个呼号一个 MQTT 订阅，`service.js:320-340`），订阅过多会被 broker 限流。成本中。

#### S8. 日志与诊断

- **现状**：Node-RED 控制台 `info`（`settings.js:54-60`），无 UI；采集错误只进 `node.warn`（`flow.json:1056` 等）。
- **为什么**：现场排障需要看“上游是否失败/哪个源 degraded”（`propagation/service.js:74-86` 已有 degraded 标记但只在 API 里）。
- **控件**：下拉（error/warn/info/debug）+ 开关（在设置页显示最近 20 条采集错误）+ 按钮（下载诊断包）。
- **默认值**：info、关。
- **风险与成本**：低。debug 级日志会快速写满磁盘（项目已踩过），需要在 UI 警告并自动 30 分钟后回落。

### 5.3 可选（5 条）

| # | 设置项 | 现状 | 场景 | 控件 | 成本 |
|---|---|---|---|---|---|
| O1 | 键盘快捷键开关与映射 | 无 | 大屏值守快速切页/切布局 | 开关 + 只读映射表 | 低 |
| O2 | 自定义告警音 | 仅 TTS（`qso-page.mjs:504-516`） | 嘈杂环境听不清语音 | 文件选择 | 中 |
| O3 | 大屏截图/导出 | 无 | 赛后复盘、发群 | 按钮（PNG/PDF） | 中 |
| O4 | 主题令牌自定义 | 4 套固定主题（`settings-model.mjs:11`） | 客户 VI 色 | 颜色选择器 × 6 | 中 |
| O5 | 多配置档（比赛/日常） | 无 | 一套设备跑不同赛事 | 下拉 + 另存为 | 中 |

---

## 6. 前端展示类 vs 服务端/数据采集类

| 分类 | 设置项 | 存储 | 校验位置 | 生效方式 | 改动成本 |
|---|---|---|---|---|---|
| **纯前端** | 语言、主题、TTL、频段色、QSO 显示、告警、我的 SPOT、地图图层、刷新节奏、时间格式、大屏视觉 | localStorage + `uiSettings` | 前端 `sanitizeSettings` | 即时 | 只需前端读取；广播已具备 |
| **前端 + 服务端读取** | `grid`、`myCall`、`propDxLat/Lon` | `uiSettings` | 前端有效，服务端各自兜底 | 下一次请求生效 | 需服务端读取并加默认 |
| **服务端/数据采集** | 轮询间隔、上游地址、代理、保留期限、清理、UDP 端口、录音重复、PSKR 订阅数、日志级别 | `uiSettings` + flow 配置 | **必须服务端校验** | 定时器重建 / 需重启 | 需改 `lib/settings/service.js` + `flow.json` 定时器 + 重启提示 |

落地建议：

1. 先做 B9（schema + 服务端校验），否则后面所有采集类设置都会变成“写进去但没人保证格式”。
2. 服务端新增 `lib/settings/schema.js`，导出 `DEFAULTS`、`sanitize()`、`migrate()`；`service.save()` 改为 `sanitize(body)` 后存储，`service.get()` 返回 `sanitize(stored)`（补默认）。
3. 前端 `settings-model.mjs` 改为从同一份 schema 生成，删除重复的默认值（`settings-model.mjs:20-33`）。
4. 采集类设置通过 `global.get('uiSettings')` 在每次 tick 时读取（而不是启动时读取一次），这样无需重启即可生效；只有 UDP 端口必须重启。
5. 增加 `PATCH /api/settings`（只合并提交的键）或带 `updatedAt` 的乐观锁，解决 P3。

---

## 7. 建议的设置 schema 形态（示例）

```json
{
  "cfgV": 3,
  "ui": { "lang": "zh", "theme": "dark", "timeZone": "utc", "hour12": false },
  "map": {
    "tiles": "osm", "autoFitMaxZoom": 7, "fitPad": 0.08,
    "layers": { "terminator": true, "heat": true, "greatCircle": true },
    "markerSize": { "spotter": 12, "monitored": 14 }
  },
  "spots": {
    "ttl": { "CW": 30, "SSB": 30, "DIGI": 30 },
    "serverWindowMin": 60,
    "poll": { "dxwatchSec": 30, "rbnSec": 10, "pskrSyncSec": 120 },
    "sources": { "dxwatch": true, "rbn": true, "pskr": true }
  },
  "qso": {
    "category": "SO1R", "maxMarkers": 1500, "lines": true, "autoFit": true,
    "mySpot": { "ttlMin": 30, "max": 300, "popup": true, "voice": true }
  },
  "alerts": {
    "popupMs": 8000, "snrMin": null, "distanceKmMin": null,
    "voice": { "rate": 1.05, "volume": 1, "quietHours": null }
  },
  "wall": {
    "title": "DX-COMPASS", "mode": "all",
    "layers": ["prop", "qso", "myspot", "dxspot"],
    "cycleSec": 10, "spaceDwellSec": 8, "syncSec": 60,
    "map": { "topLat": 85, "bottomLat": -85 },
    "timer": { "on": false, "start": "", "end": "" }
  },
  "prop": { "proj": "robinson", "layer": "muf", "dx": { "lat": 40, "lon": -100 } },
  "retention": { "spotsDays": 0, "recordingMonths": 2, "qsoDays": 0 }
}
```

校验要点：所有数值必须 `Number.isFinite` 且落在闭区间；枚举必须命中白名单；颜色必须 `#RRGGBB`；时间必须 ISO `YYYY-MM-DDTHH:mm`；未知键丢弃；缺失键补默认；`cfgV` 低版本走迁移链。

---

## 8. 优先级排序依据

| 档位 | 排序依据 |
|---|---|
| **必做（B1–B12）** | ① 影响面：跨设备/跨角色（B1/B2/B8/B9）、影响现场可用性（B5/B6/B7）；② 现状缺失最明显（有硬编码、有重启门槛）；③ 已有部分实现、改造成本可控（B3/B4/B10/B11）；④ B9 是其余条目的地基，必须先做。 |
| **建议（S1–S8）** | 影响面中等、偏“专家调参”或需要服务端配合；S2/S3 需要重启或安全加固，成本高于收益，排在必做之后。 |
| **可选（O1–O5）** | 体验增强、非比赛必需，且都能在核心设置稳定后增量实现。 |

---

## 9. 附录 A：硬编码业务参数索引（建议纳入设置）

### 9.1 前端

| # | 参数 | 现状值 | 位置 | 建议键 |
|---|---|---|---|---|
| 1 | 自动适配最大缩放 | 7 | `public/shared/map/base-map.mjs:12` | `map.autoFitMaxZoom` |
| 2 | 适配内边距 | 0.08 | `base-map.mjs:163` | `map.fitPad` |
| 3 | 底图源 | OSM / 高德 | `base-map.mjs:14-25` | *(已有 `tiles`)* |
| 4 | 晨昏线刷新 | 60s | `public/shared/map/terminator.mjs:72` | `map.terminatorSec` |
| 5 | 标记淡出 tick | 10s | `public/js/main.mjs:71-75` | `map.fadeSec` |
| 6 | SPOT 剪枝 | 30s | `main.mjs:76` | `spots.pruneSec` |
| 7 | UTC 时钟 | 1s | `main.mjs:67-70` | `ui.clockSec` |
| 8 | 地图格子上限 | 9 | `public/js/pages/spot-page.mjs:12` | `spots.maxCells` |
| 9 | 历史回放条数 | 500 | `spot-page.mjs:13` | `spots.historyLimit` |
| 10 | 单格标记上限 | 500 | `spot-page.mjs:251` | `spots.cellMarkerMax` |
| 11 | 热力图参数 | r38/b28/o0.3/z7 | `spot-page.mjs:96-98` | `map.heat.*` |
| 12 | SNR→权重 | `(snr+25)/40` | `spot-page.mjs:89` | `map.heat.snrSpan` |
| 13 | 大圆采样点 | 64 | `spot-page.mjs:233`、`qso-page.mjs:114,159` | `map.gcSamples` |
| 14 | 轮播间隔 | 3–600s，默认 15 | `spot-page.mjs:24,519-521` | `spots.rotSec`（并入 schema） |
| 15 | 弹窗时长 | 8s | `public/js/pages/qso-page.mjs:13` | `alerts.popupMs` |
| 16 | QSO 速率分桶 | 5min × 12 | `qso-page.mjs:14-15` | `qso.rateBucketMin` |
| 17 | 每分钟分桶 | 30 | `qso-page.mjs:16` | `qso.minBuckets` |
| 18 | QSO 历史条数 | 500 | `qso-page.mjs:479` | `qso.historyLimit` |
| 19 | 语音速率/音量 | 1.05 / 1 | `qso-page.mjs:510-511` | `alerts.voice.*` |
| 20 | 换频播报阈值 | >1 kHz | `qso-page.mjs:562` | `alerts.freqDeltaKhz` |
| 21 | Records 刷新 | 15s | `public/js/pages/records-page.mjs:207` | `records.refreshSec` |
| 22 | CSV 导出上限 | 10000 | `records-page.mjs:173` | `records.exportLimit` |
| 23 | SPOT 拉取默认上限 | 1000 | `public/shared/data/spots.mjs:19` | `spots.apiLimit` |
| 24 | 传播轮询 | 60s | `public/js/pages/propagation-page.mjs:1055,1114` | `prop.pollSec` |
| 25 | 大屏图层轮播 | 10s | `public/bigscreen/wall-page.mjs:112` | `wall.cycleSec` |
| 26 | 大屏轮询 | 60/30/30/15/60s | `wall-page.mjs:190-194` | `wall.*.pollSec` |
| 27 | 对手窗口 | 30min | `public/bigscreen/wall-opponents.mjs:191` | `wall.opponentWindowMin` |
| 28 | 方向集中度 | 0.4 | `wall-opponents.mjs:195` | `wall.concentrationMin` |
| 29 | 空间天气停留 | 8s | `public/bigscreen/wall-charts.mjs:10` | `wall.spaceDwellSec` |
| 30 | 大屏纬度范围 | -85..85 | `public/bigscreen/wall-map.mjs:28-29` | `wall.map.topLat/bottomLat` |
| 31 | 心跳/剪枝 | 30s / 120s | `public/shared/monitoring/client.mjs:9-10` | `monitor.heartbeatSec` |

### 9.2 服务端 / 采集

| # | 参数 | 现状值 | 位置 | 建议键 |
|---|---|---|---|---|
| 32 | dxwatch 轮询 | 30s | `flow.json:277` | `spots.poll.dxwatchSec` |
| 33 | RBN 轮询 | 10s | `flow.json:790` | `spots.poll.rbnSec` |
| 34 | PSKR 订阅同步 | 120s | `flow.json:973` | `spots.poll.pskrSyncSec` |
| 35 | 录音 tick | 30s | `flow.json:1036` | `recording.tickSec` |
| 36 | 录音清理周期 | 3600s | `flow.json:1078` | `retention.purgeSec` |
| 37 | 传播采集周期 | 300s | `flow.json:2422` | `prop.collectSec` |
| 38 | dxwatch 单次条数 | `r=200` | `lib/spots/service.js:34,44` | `spots.batchSize` |
| 39 | 回填窗口/条数 | 7 天 / 150 | `lib/spots/service.js:110` | `spots.backfillDays/Max` |
| 40 | 前端 fresh 窗口 | 3600s | `service.js:155,242` | `spots.freshSec` |
| 41 | seenIds 上限 | 2000 | `service.js:163` | `spots.seenMax` |
| 42 | PSKR 未来容差 | 120s | `service.js:270` | `spots.pskrFutureSec` |
| 43 | 去重分桶/剪枝 | 180s / 900s | `lib/spots/normalize.js:45,50` | `spots.dedupSec/pruneSec` |
| 44 | spots 查询默认 | 1000 | `lib/storage/spot-sql.js:10` | `spots.apiLimit` |
| 45 | recording 查询默认 | 1000 | `lib/storage/recording-sql.js:10` | `recording.apiLimit` |
| 46 | 录音保留 | 2 个月 | `recording-sql.js:17` | `retention.recordingMonths` |
| 47 | qso 查询默认 | 200 | `lib/storage/qso-sql.js:22` | `qso.apiLimit` |
| 48 | 监控客户端 TTL | 120s | `lib/monitoring/service.js:9` | `monitor.clientTtlSec` |
| 49 | 呼号上限 | 9 | `lib/settings/service.js:27` | `spots.maxCallsigns` |
| 50 | SWPC/第三方源 | 15 个 URL | `lib/propagation/collector.js:38-53` | `prop.sources.*` |
| 51 | 天气源 | Open-Meteo 66 点 | `collector.js:57-62` | `prop.wx.*` |
| 52 | 缓存 TTL | 4/10/20/30min | `collector.js:34-36,70` | `prop.cache.*` |
| 53 | 抓取超时 | 25s | `collector.js:94` | `prop.fetchTimeoutMs` |
| 54 | 抓取并发 | 4 | `collector.js:434` | `prop.fetchConcurrency` |
| 55 | USGS TTL/超时 | 10min / 10s | `lib/propagation/geo.js:8,13` | `prop.geo.*` |
| 56 | GAMBIT 地址/节流 | lgdc.uml.edu / 15s / 4 天 | `lib/gambit.js:25-28` | `prop.gambit.*` |
| 57 | 传播频段表 | 10 段 | `lib/propagation/model.js:8-13` | `prop.bands` |
| 58 | 跳距/网格步长 | 3000km / 6°×10° | `model.js:25-27` | `prop.hopKm/gridStep` |
| 59 | 频段条件阈值 | 0.97 / 0.55 / 0.25 | `model.js:474-479` | `prop.cond.*` |
| 60 | DX 默认点 | 40, -100 | `lib/propagation/service.js:34-35` | *(已有 `propDx*`)* |
| 61 | N1MM UDP 端口 | 12060/12061/12062 | `flow.json:1340,1437,1635` | `qso.udpPorts` |
| 62 | PSKR MQTT | 1883 | `flow.json:878` | `spots.pskrBroker` |
| 63 | 应用端口 | 5758 | `settings.js:7`、`install.sh:29` | 环境变量 |
| 64 | 大屏端口 | 5859 | `bigscreen/server.js:26`、`install.sh:30` | `BIGSCREEN_PORT` |
| 65 | Node 堆上限 | 256MB | `install.sh:354` | systemd 环境变量 |

---

## 10. 结论

- **现有设置覆盖面“够用但不专业”**：语言、主题、底图、TTL、频段色、QSO 显示、告警开关、大屏图层这些“看得见”的项都在；但**所有决定数据质量与现场适应性的参数都写死在代码/流程里**。
- **最该先做的不是加控件，而是补地基**：B9（统一 schema + 服务端校验 + 默认回退）→ B10（导出/导入/分域重置）→ B1/B2/B8（采集与保留）→ B3/B4/B5（体验与告警）。这五组做完，其余建议都只是“往 schema 里加键”。
- **风险排序**：数据保留（B8，破坏性）> 采集频率（B1，可能触发上游封禁）> 明文凭据/无鉴权（P8/P9）> 大屏纬度范围（B7，可能裁切大陆）> 其余。
