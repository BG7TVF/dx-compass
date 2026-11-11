# DX-Compass

基于 Node-RED 的 DX Spot 与竞赛实时监测大屏。通过 **dxwatch.com**（FT8/SSB/DIGI 等）、**reversebeacon.net RBN**（CW，含 dB 信号强度）与 **PSKReporter MQTT v2**（DIGI 实时流）三路公开数据同时监测最多 **9 个呼号**收到的 spot，在地图上实时打点；可选接入 **N1MM+**，显示本台 QSO 地图、竞赛分数与速率。支持多分屏（DVR 风格）、4 套主题、11 种界面语言，所有 spot 与 QSO 记录到 SQLite 用于赛后分析。另提供独立的**只读竞赛大屏**（端口 **5859**），适合现场投屏。

当前版本 **v2.1.0**：设置体系统一为 6 域 104 项并由服务端逐键校验，大屏取景、对手卡片、空间天气轮播与字号阶梯完成重做，11 种语言全部落地。

## 版本更新

### v2.1.0（2026-11-10）

- **大屏世界地图取景**：地图按容器实际尺寸 cover 铺满面板，四周不再出现黑边；默认纬度窗口为 **±85°**，完整保留各大洲陆地，只裁掉南极洲南部极冠；上下纬度可在 Settings → 大屏 调整
- **对手监测改为「呼号大卡 + 频段小格」**：每个对手一张呼号大卡，卡内按活动频段分格显示频率与主攻方向；最多 **9 个对手一屏**且不出现滚动条；呼号以颜色 + 图形（圆点 / 圆环 / 方块 / 三角 / 十字 / 靶心）双重编码，与地图标记一一对应，色觉差异下仍可区分
- **空间天气折线图轮播**：大屏空间天气卡片在同一画布内轮播 8 项指标（SFI、SSN、Kp、Dst、Bz、Bt、太阳风、X 射线）的迷你折线图，停留时间可配置
- **全局字号阶梯**：大屏所有字号统一由 `clamp(最小值, N vh, 上限)` 驱动，随屏高连续缩放；1080p、1440p、4K 以及带浏览器边框的窄高窗口都不会溢出
- **设置体系重构**：`public/shared/settings/schema.js` 成为唯一 schema 来源——104 个键分 6 个域（`ui` / `map` / `qso` / `wall` / `data` / `prop`，`cfgV=3`），覆盖类型、范围、默认值、作用域、迁移标记；服务端逐键校验，非法值回退默认并返回 `warnings` / `rejected`
- **新增 API**：`POST /api/settings/patch` 部分更新（只提交变更键，返回新的 `_rev`），`POST /api/settings/reset` 按域重置；设置页支持导出 / 导入 JSON、按域重置与多配置档（配置档仅保存在本浏览器）
- **新增可配置项**：数据源轮询间隔与逐源开关、SPOT 活动窗口与历史回放窗口、数据保留与自动清理（spots / recording_spots / qsos）、磁盘占用告警、告警 SNR 与距离阈值、提示音、静音时段、地图图层参数（热力半径 / 模糊 / 透明度、大圆采样、标记尺寸与上限、淡出）、大屏轮播与时区、日志级别（error / warn / info / debug）
- **11 种语言完整落地**：zh / en / de / fr / es / pt / ru / it / ar / ko / ja 键集合完全一致（每种 **410 键**），占位符格式统一；新增业余无线电术语表与自动化词典校验（键对齐、占位符、禁用错误译法、未翻译检测），设置页与大屏不再有硬编码文案
- **设置页 UI 扁平化**：单行式「标签 + 说明 + 控件右对齐」列表、可折叠分组、固定页签；所有布尔项统一为滑动开关；移除渐变与重阴影，1366×768 / 1920×1080 / 2560×1440 三档均无横向溢出

> **从 v2.0 升级到 v2.1 必须重启服务**：`/api/settings/patch` 与 `/api/settings/reset` 定义在 `flow.json` 中，只刷新浏览器不会生效。拉取代码后执行 `sudo systemctl restart dx-compass`；只读大屏新增了静态模块白名单项，还需 `sudo systemctl restart dx-compass-wall`。旧数据库与旧设置会自动迁移，无需手工改表。

## 一键安装（复制即用）

在 **Ubuntu 服务器终端**直接粘贴下面一行命令，即可自动完成"下载代码 → 安装依赖 → 启动服务"：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
```

没有 `curl` 时可用 `wget`：

```bash
wget -qO- https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
```

服务器访问 GitHub 困难时，改用 **Gitee 镜像**（国内下载更快）：

```bash
curl -fsSL https://gitee.com/fatman985KG/dx-compass/raw/main/bootstrap-gitee.sh | sudo bash
```

> Gitee 仓库 `https://gitee.com/fatman985KG/dx-compass.git` 是 GitHub 的**自动镜像**：所有开发与更新只提交到 GitHub（`https://github.com/BG7TVF/dx-compass`），Gitee 会自动同步，两个源的代码始终一致。请勿直接在 Gitee 上提交改动（会被同步覆盖），也无需向 Gitee 推送；镜像同步可能有短暂延迟。`bootstrap-gitee.sh` 与 `bootstrap.sh` 功能完全相同，只是下载源指向 Gitee。

脚本会将代码安装到 `/opt/dx-compass`，注册并启动开机自启服务 `dx-compass`（端口 **5758**）。完成后访问：

- 监测大屏：`http://<服务器IP>:5758/`
- Node-RED 编辑器：`http://<服务器IP>:5758/red`
- 只读竞赛大屏（`install.sh` 一并部署，见[只读大屏](#只读大屏wall-display)）：`http://<服务器IP>:5859/`

> 该命令可**重复执行**：已安装时会自动更新代码到最新版本后重新部署。
> 服务器通过代理访问 GitHub 时：先下载脚本再带代理变量运行，见文末[常见问题](#常见问题)。
> 云服务器记得在安全组放行 **TCP 5758** 与 **TCP 5859**（大屏）。

**没有 root 权限？** 去掉 `sudo` 即可按当前用户安装到自己的家目录（见[方式三：普通用户免 root 安装](#方式三普通用户免-root安装)）：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | bash

# 或使用 Gitee 镜像源
curl -fsSL https://gitee.com/fatman985KG/dx-compass/raw/main/bootstrap-gitee.sh | bash
```

## 功能特性

- **多分屏布局**：`1×1` / `2×2` / `3×3` 自由切换，一个呼号对应一张地图，最多同时监测 9 个呼号；呼号多于可见窗口时支持自动轮询翻页
- **只读竞赛大屏**：`npm run wall` 在端口 **5859** 独立渲染一块竞赛墙（U 型版面：单张地图居中，环境 / 电台 / 成绩 / 对手四组卡片环绕，页眉带 UTC 时钟与倒计时）；地图按面板 cover 铺满、无黑边，对手按「呼号大卡 + 频段小格」排布，最多 9 个对手一屏，呼号以颜色 + 图形双重区分，空间天气卡片在 8 项指标折线图间自动轮播，字号随屏高阶梯缩放；只代理 6 个只读接口、不提供任何写操作；标题、图层、叠加方式、轮播、地图纬度窗口与倒计时在 Settings → 大屏 配置，所有浏览器共享
- **实时打点**：每 30 秒从 dxwatch.com 拉取全球聚合 spot（FT8/SSB/DIGI 等），每 10 秒从 reversebeacon.net RBN 拉取 CW skimmer spot（含真实 SNR dB），DIGI 另有 PSKReporter MQTT 实时流，解析报告人（DE）位置后在地图上标点，数据自动流入，无需任何连接配置
- **历史回溯**：新添加被监测呼号时，自动回溯该呼号最近 7 天（最多 150 条）的 spot
- **标点存活时间可配置**：标记按模式（CW / SSB / DIGI）分别设置存活时间（默认各 30 分钟），随存活时间线性淡出直至消失；标记颜色按频段区分，均可在 Settings 中自定义
- **频段热力图**：CW / DIGI 模式按频段生成热力图，强度随 SNR 与标记存活时间变化；点击频段框切换对应频段热力图
- **晨昏线**：所有地图实时显示灰线（昼夜分界线）与夜半球阴影，每分钟自动刷新
- **录制功能**：手动或定时（UTC，一次性）录制 spot 到独立 `recording_spots` 表，录制记录最长保留两个月，超期每小时自动清理；All Spots / Recorded 两个视图可用同一 **Export CSV** 按钮按当前视图导出
- **一键清除**：Settings → 全局 → 一键清除，停止监控/录制，删除全部界面设置（含 QRZ.com 凭据）、监听呼号以及 spots / qsos / recording_spots 三张表数据，相当于恢复出厂状态（不可撤销）
- **完整记录**：每条 spot 记录时间、频率、报告人、模式（CW/DIGI/PHONE）、信号强度（CW 的 SNR dB 来自 RBN；FT8 的 SNR 来自 dxwatch）、距离等，存入 SQLite
- **赛后分析**：记录面板支持按呼号筛选、一键导出 CSV
- **距离计算**：直接使用数据源附带的呼号经纬度 + Haversine 公式，计算报告人相对本台的距离（公里/英里），不依赖第三方定位接口
- **多语言界面**：支持中文 / English / Deutsch / Français / Español / Português / Русский / Italiano / العربية / 한국어 / 日本語 共 11 种界面语言，文案独立在 `public/js/i18n.js`；每种语言 410 个键完全对齐，并使用统一的业余无线电术语表（如 spot → SPOT、band → 频段、wall → 大屏），`npm test` 会拒绝键缺失、占位符不一致与已知错误译法
- **4 套主题**：**黑暗**（默认）、**明亮**（浅色底，适合白天或投影）、**深海**、**琥珀**，在 Settings → 全局 即时切换；整套配色（工具栏、面板、表格、弹窗、地图底色）随主题变化
- **多人协作**：监听呼号、标记存活时间、频段颜色、底图、主题、提醒开关等设置保存在服务器端，修改后经 WebSocket 实时同步到所有打开的浏览器；分屏布局（1×1/2×2/3×3）只保存在各自浏览器
- **统一设置体系**：104 项设置由 `public/shared/settings/schema.js` 单点定义（6 个域：全局 / Spot 地图 / QSO 地图 / 大屏 / 数据 / 传播），服务端逐键校验、非法值回退默认并回报被拒绝的键；`POST /api/settings/patch` 只提交变更项，`POST /api/settings/reset` 按域恢复默认；设置页支持关键字搜索、导出 / 导入 JSON、按域重置与多配置档，所有布尔项为滑动开关
- **本台 Spot 提醒**：本台呼号出现在 spot 上时，QSO 地图以红色标记标出（可选），并可与弹窗（8 秒自动消失）和语音播报「you get a new spot」一起开启；提醒与普通 Spot 监控独立开关，标记存活时间与最多显示数量可调，语音按当前界面语言播报
- **底图可切换**：OpenStreetMap 与高德地图（中国大陆网络环境可用），切换后所有地图显示约定保持不变；Leaflet 本体已内置在 `public/vendor/leaflet/`，页面不依赖任何外部 CDN
- **N1MM+ 本台集成**（可选）：接收 N1MM+ UDP 广播后，QSO 视图顶部条实时显示最新的 RUN/S&P、频率、对方呼号、RST 与交换信息，右侧面板显示当前电台频率/模式/TX、当前总分（QSO/乘数/点数/Score）、上一个 QSO 与 QSO 速率图表；一键切换全屏 **QSO 地图**，每个 QSO 按频段着色并从本台位置画大圆线，新乘数带 M 徽章，全部持久化到 `qsos` 表
- **传播地图**：独立第三视图，Canvas 世界地图（Mercator / 方位投影 / Robinson）+ 传播预测 / 天气 / 极光 三种背景 + 实时晨昏线；右侧面板汇总空间天气指数（SFI、SSN、Kp、A、Bz、Bt、太阳风、X 射线、Dst、极光、DRAP，均带历史曲线）、NOAA R/S/G、HamQSL 频段条件、DE→DX 24 小时可用性矩阵与全球 MUF 读数

## 技术架构

```
dxwatch.com   (HTTPS/JSON, 30s 轮询, FT8/SSB/DIGI 等) ──┐
                                                       │
reversebeacon.net (HTTPS/JSON, 10s 轮询, CW 含 dB) ────┤
                                                       ├──► Node-RED 流程 ──► 按监测呼号过滤
PSKReporter     (MQTT v2 实时流, DIGI) ────────────────┘        ├──► 内置经纬度 + Haversine 距离计算
                                                                ├──► 模式 / 信号强度解析（跨源去重）
N1MM+           (UDP 12060-12062, 本台 QSO/电台/记分) ────────► ├──► SQLite 持久化记录（spot_id 去重）
                                                                └──► WebSocket 实时推送 ──► 前端多地图大屏
```

- **后端**：Node-RED 只保留流程与 HTTP/WS/SQLite 适配；业务统一由 `lib/index.js` 的 `dx` 入口导出，Spot/QSO、监控录制、设置、存储和传播分别位于 `lib/` 对应模块
- **设置**：`public/shared/settings/schema.js` 是唯一 schema（6 域 104 键，`cfgV=3`），浏览器与 Node 共用同一份校验/迁移逻辑；`lib/settings/service.js` 负责保存、合并、广播与分域重置，设置页只按 schema 渲染
- **传播预测**：`lib/propagation/` 统一采集空间天气并计算 MUF 网格、频段条件、路径矩阵和读数；`/api/prop` 返回原始快照及同一 `forecast`，页面不再各自实现预测公式
- **只读大屏**：`bigscreen/server.js` 为独立 HTTP 服务（默认 5859），只代理 6 个 GET 接口和精确白名单中的前端模块，无写操作
- **数据源**：
  - dxwatch.com 公开 spot 接口 `/dxsd1/s.php`（聚合全球 DX Cluster，30 秒轮询）
  - reversebeacon.net RBN 接口 `/spots.php`（全球 CW skimmer 网络，10 秒轮询，每条含 SNR dB 与 WPM；启动时自动从 `main.php` 提取版本参数，失效自动重取）
  - 两者均为非官方公开接口，请保持内置的轻量轮询节奏；同一条 CW spot 若同时出现在两个源中会被自动去重
- **前端**：原生 HTML/CSS/ES Module + Leaflet（`public/vendor/leaflet/`，本地内置、不依赖 CDN）；`public/shared/` 统一数据访问、监控、地理和地图能力，页面只负责交互与渲染
- **数据库**：SQLite（`dxcompass.db`，运行时自动创建），schema 和 SQL 统一由 `lib/storage/` 管理

## 目录结构

```
dx-compass/
├── flow.json          # Node-RED 流程与薄适配器（不再承载业务公式或 SQL）
├── settings.js        # 端口、静态目录、context 持久化及统一 dx facade
├── package.json       # 运行依赖与 npm test
├── flow_cred.json     # 凭据文件（为空）
├── install.sh         # Ubuntu 一键安装脚本（依赖 + systemd 服务）
├── bootstrap.sh       # GitHub 一键引导脚本
├── bootstrap-gitee.sh # Gitee 镜像引导脚本
├── bigscreen/
│   └── server.js      # 5859 只读服务：精确静态白名单 + 6 个只读代理接口
├── lib/
│   ├── index.js       # 后端统一 dx 入口
│   ├── radio/         # 频段、距离方位、Maidenhead
│   ├── spots/         # 三源 Spot 归一化、去重、订阅和游标
│   ├── qsos/          # N1MM、QSO 坐标与 QRZ
│   ├── monitoring/    # 多标签监控与 UTC 录制
│   ├── settings/      # 设置、监测呼号、QRZ 配置与重置
│   ├── storage/       # 唯一 schema 和 SQL 构造位置
│   ├── maintenance/   # 保留期清理与磁盘占用告警
│   └── propagation/   # 采集器、USGS、统一预测模型和 forecast 缓存
├── public/
│   ├── index.html
│   ├── js/
│   │   ├── main.mjs    # 主面板启动入口
│   │   ├── pages/      # Spot / QSO / Records / Settings / Propagation 页面控制器
│   │   └── i18n.js     # 11 种界面语言
│   ├── shared/
│   │   ├── core/       # 唯一 HTTP / WS / Beacon、事件、UTC、I18N 适配
│   │   ├── data/       # 设置、Spot、QSO、电台、传播 repositories / stores
│   │   ├── monitoring/ # 监控心跳和统一轮询器
│   │   ├── geo/        # 地理、大圆、换日线、Maidenhead
│   │   ├── map/        # Leaflet、离线底图、投影、晨昏线、图层
│   │   ├── propagation/# 服务器 forecast 的插值与展示选择器
│   │   └── settings/   # 唯一设置 schema（6 域、校验与迁移）
│   ├── bigscreen/      # 大屏 module 入口、地图、卡片、图表、对手模块
│   ├── data/           # 离线海岸线与国家边界
│   └── vendor/         # 本地 Leaflet / leaflet-heat
├── docs/              # 设置审计报告、i18n 术语表与缺口审计
├── tests/             # node:test 单元、契约及架构约束测试
└── LICENSE
```

## 模块化边界与扩展规则

后续改进必须扩展对应模块，不得在页面中另建数据来源或计算公式：

- **新 Spot / QSO 数据源或字段**：在 `lib/spots` / `lib/qsos` 归一化；需要持久化时只修改 `lib/storage`。`flow.json` 仅做消息适配。
- **监控、录制、设置**：分别使用 `lib/monitoring`、`lib/settings`；浏览器侧只能调用 `public/shared/monitoring` 和 `public/shared/data`。
- **地图、大圆、网格、晨昏线**：使用 `public/shared/map` 与 `public/shared/geo`，这些模块不得访问网络。
- **短波预测**：只修改 `lib/propagation/model.js`；原始采集在 `collector.js`，DTO 与缓存在 `service.js`。页面只能读取 `/api/prop` 的 `forecast` 并渲染。
- **新页面**：从 `public/shared/data` 注入 repository，从共享 map/geo 获取绘制能力；禁止直接 `fetch`、`new WebSocket`、`sendBeacon`，禁止复制预测公式。
- **5859**：只读边界不变；新增前端模块必须逐个加入 `bigscreen/server.js` 白名单并补测试。

运行全部单元、契约和架构检查：

```bash
npm test
```

架构测试会拒绝页面直接传输、map 网络访问、data 操作 DOM、SQL 离开 `lib/storage`、预测公式离开 `lib/propagation/model.js`，以及 Node-RED function 节点重新包含业务公式。

## 添加新语言

界面文案已独立到 [public/js/i18n.js](public/js/i18n.js)（在 `index.html` 中先于 `main.mjs` 加载），新增语言无需改动应用逻辑：

1. 在 `LANGS` 数组末尾追加语言代码（如 `'nl'`）
2. 在 `LANG_NAMES` 中补充该语言的母语名称（会显示在 Settings 的语言下拉框中）
3. 在 `I18N` 中复制英文块，新增该语言条目并翻译全部 410 个键（键名必须与英文块完全一致，占位符如 `{name}` 不得改动）
4. 术语以 [docs/i18n-glossary-and-gap-audit.md](docs/i18n-glossary-and-gap-audit.md) 的业余无线电术语表为准（spot → SPOT、band → 频段、RIG → 电台、ANT → 天线等）
5. 运行 `npm test`：`tests/i18n-dictionary.test.mjs` 会校验键集合对齐、空值、占位符、重复键、禁用错误译法（蚂蚁 / 钻机 / 乐队 / 斑点 / 终结者等）以及未翻译条目
6. 刷新页面即可在 Settings → 全局 → Language 中选择

> 阿拉伯语保持 `document dir=ltr`，仅对文本做右对齐（`body.lang-ar`），不整页镜像，避免地图与面板布局被翻转。

## 环境要求

- **操作系统**：Ubuntu 22.04 / 24.04（Debian 系）
- **Node.js**：>= 18（系统级安装会自动检测并安装 Node.js 20 LTS；免 root 用户安装需提前自备）
- **内存**：建议 512MB 以上
- **网络**：服务器需能访问 `https://dxwatch.com` 与 `https://www.reversebeacon.net`（出站 HTTPS 443）；无需 telnet、无需集群账号
- **端口**：对外放行 **5758**（TCP）

## 一键部署（推荐）

安装脚本已处理好环境检测、依赖安装与 systemd 服务注册。

### 方式一：一行命令（自动下载 + 安装）

在服务器终端直接执行（详见顶部[一键安装](#一键安装复制即用)）：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
```

引导脚本会自动安装 git/curl、克隆代码到 `/opt/dx-compass`（已安装则更新到最新版），随后调用 `install.sh` 完成全部部署。

访问 GitHub 受限时，把上面的 `bootstrap.sh` 换成 Gitee 镜像脚本即可（参数、目录与服务完全相同）：

```bash
curl -fsSL https://gitee.com/fatman985KG/dx-compass/raw/main/bootstrap-gitee.sh | sudo bash
```

> Gitee 是 GitHub 的自动镜像，更新只需推送到 GitHub，Gitee 会自动同步。

### 方式二：手动下载代码后安装

```bash
# 直接在服务器上克隆
cd /opt
sudo git clone https://github.com/BG7TVF/dx-compass.git
# 或使用 Gitee 镜像：sudo git clone https://gitee.com/fatman985KG/dx-compass.git
cd dx-compass

# 或用 scp 上传本项目后进入目录，然后执行：
sudo bash install.sh
```

安装脚本会自动完成：

1. 校验系统与必要文件，检查 **5758** 端口是否被占用
2. 安装系统编译工具（SQLite 原生模块需要 `build-essential`）
3. 检测 / 安装 Node.js（已有 ≥18 直接使用，否则通过 NodeSource 安装 20 LTS）
4. 在项目目录内本地安装 npm 依赖（默认源失败自动切换国内 npmmirror 镜像，含 node-gyp 头文件与 sqlite3 预编译二进制镜像，并校验原生模块可加载）
5. 预初始化 SQLite 数据库结构（spots / recording_spots 建表兜底）
6. 注册并启动 systemd 服务 `dx-compass`（开机自启）
7. 等待端口就绪、校验数据库 API 可用，并输出访问地址

脚本可重复执行（幂等）。

### 方式三：普通用户免 root 安装

任何登录用户都可以在自己的家目录部署一份，**完全不需要 sudo**：安装到 `~/dx-compass`，并注册为 `systemctl --user` 服务。

```bash
# 一行安装（不带 sudo）
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | bash

# 或使用 Gitee 镜像源（不带 sudo）
curl -fsSL https://gitee.com/fatman985KG/dx-compass/raw/main/bootstrap-gitee.sh | bash

# 或指定目录 / 分支
DX_COMPASS_DIR=$HOME/dx-compass DX_COMPASS_BRANCH=main bash bootstrap.sh
```

前置条件（因无 root 权限安装这些组件）：

- 已安装 **Node.js >= 18**（可用 nvm / fnm 装到家目录）
- 已安装 **git**、**curl**
- 建议已安装编译工具（`build-essential python3 make g++`），否则 sqlite3 原生模块可能无法编译；脚本检测缺失时会提示

安装完成后服务由当前用户管理：

```bash
systemctl --user status dx-compass     # 查看状态
systemctl --user restart dx-compass    # 重启
systemctl --user stop dx-compass       # 停止
journalctl --user -u dx-compass -f     # 日志
```

> 脚本会尝试 `loginctl enable-linger <用户>` 让服务在退出登录后继续运行；若失败会提示管理员执行 `sudo loginctl enable-linger <用户>`。
> 同一台机器上多人使用时，5758 端口只能被一套实例占用；如已被占用，需调整 `settings.js` 的 `uiPort`（见文末常见问题）。

### 关于 git 目录属主（dubious ownership）

安装目录归属于**执行安装脚本的账号**（`sudo` 安装即 root），服务也以同一账号运行，因此安装、更新、手动 `git pull` 都是同一个属主，不会触发 git 的属主检查。

**2026-11 之前安装的旧实例**曾把目录 chown 给专用用户 `dxcompass`，导致 root 手动拉取时报：

```
fatal: detected dubious ownership in repository at '/opt/dx-compass'
```

升级到新版即可自动修复——`bootstrap.sh` / `install.sh` 会把整个目录属主改回安装账号（root）：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
```

或只改属主、不重装：

```bash
sudo chown -R root:root /opt/dx-compass
```

### 访问

- **监测大屏**：`http://<服务器IP>:5758/`
- **Node-RED 编辑器**：`http://<服务器IP>:5758/red`
- **只读竞赛大屏**：`http://<服务器IP>:5859/`，安装脚本已部署为 `dx-compass-wall.service`，见[只读大屏](#只读大屏wall-display)

> 云服务器请在安全组 / 防火墙放行 TCP 5758 端口：
> `sudo ufw allow 5758/tcp`
> 使用 5859 大屏时同样放行：`sudo ufw allow 5859/tcp`

## 首次使用配置

1. 浏览器打开监测大屏 `http://<服务器IP>:5758/`
2. 点击左上角 **☰ 菜单 → Settings**，在 **Spot 地图** 页的呼号槽位中填入要监测的呼号，点 **Save**
3. 点击右侧 **Records** 面板顶部的 **▶ 开始监控** 按钮启动监控：
   - 系统立即开始接收实时 spot（CW 每 10 秒、其它模式每 30 秒刷新）
   - 同时自动从数据源回溯该呼号最近 7 天的历史 spot，地图和 Records 面板很快就会有数据
4. 无需任何集群地址、登录呼号或 Connect 操作——数据源开箱即用

> Settings 为整页六标签（共 104 项，均由 schema 渲染）：**全局**（界面语言 11 种、主题 4 套、底图源 OSM/高德、本台呼号与网格、时区 / 12 小时制 / 秒、一键清除）、**Spot 地图**（监测呼号、各模式标记存活时间、频段颜色、自动适配、晨昏线、热力图与标记尺寸）、**QSO 地图**（竞赛组别 SO1R/SO2R/MS/MM、自动缩放、本台 Spot 提醒、告警阈值与提示音、静音时段、QRZ 凭据）、**大屏**（名称、图层、叠加方式、轮播节奏、地图纬度窗口、倒计时开关与起止时间）、**数据**（三个数据源的开关与轮询间隔、历史回放窗口、保留期与自动清理、磁盘告警、日志级别）、**传播**（投影、默认图层、预报阈值与渲染参数）。设置保存在服务器端并实时同步给所有浏览器（含 5859 只读大屏），仅分屏布局与配置档保存在本机。

> 数据来自 dxwatch.com 与 reversebeacon.net 的公开接口。CW spot 由 RBN skimmer 网络提供，带真实 SNR（dB）与发报速度（WPM）；FT8/FT4 的 SNR 来自 dxwatch；普通 SSB spot 本身不携带信号强度，对应列为空属正常。

## N1MM+ 本台集成（比赛实时状态）

在 N1MM+ 竞赛日志软件中开启 UDP 广播后，可切换到全屏 QSO 地图（顶栏与本台状态栏只在 QSO 视图显示，Spot 视图保持简洁）：

- **状态栏**：按已上报电台动态生成的频率 / 模式 / TX 卡片（SO2R / MS / MM 下多台并列）、当前总分（QSO 数 / 乘数 / 点数 / Score）、上一个 QSO
- **QSO 地图**：与 Spot 视图各有独立按钮，一键全屏切换；进入 QSO 视图后自动隐藏布局（1×1/2×2/3×3）、轮询、开始监控等 Spot 专用控件；每个 QSO 一个按频段着色的永久标记，从本台位置画大圆线连接；新乘数（Multiplier）带黄色 M 徽章；QSO 持久化在 SQLite `qsos` 表，浏览器刷新与服务重启后自动恢复
- **QSO 顶部实时条**：地图上方显示最新 QSO —— RUN / S&P 状态（由 N1MM RadioInfo 实时判断）、频率、对方呼号、信号报告（RST 收发）、交换信息，以及频段/模式/操作员/相对时间
- **竞赛组别支持**：Settings → QSO 地图 可选择 SO1R / SO2R / MS / MM；QSO 面板按已上报的电台动态生成频率卡片，SO2R / MS / MM 下每台电台一张（R1、R2、R3…），顶部条同步显示全部电台频率，页面刷新后自动回填
- **新 Spot 弹窗提醒**：QSO 地图下，被监听呼号触发内置告警规则时弹出提示（呼号、频段、模式、频率、监听站 DE、SNR、时间），8 秒后自动消失；任何时刻只存在一个弹窗，新提示会直接覆盖旧内容并重置计时，绝不叠加；可在 Settings → QSO 地图 中开关
- **语音提醒（Web Speech API）**：由告警模块统一下发——只对 Settings 中监听的对手告警，按「新频率（超出 `freqDeltaKhz`）/ 新频段（原有波段仍在 TTL 内）/ 换频段（原有波段已超出 TTL）」三类播报；多波段来回切换按波段组合短时去重，不会反复播报；我的 SPOT 在 30 秒窗口内合并为一次（N≥2 播「你有 N 条新 SPOT」）；新的播报会打断上一条，绝不排队；语音仍受 `voiceRate` / `voiceVolume` 与静音时段约束
- **本台 Spot 提醒**：本台呼号被别人 spot 时，QSO 地图以红点标出（有本台网格时同时画红色大圆线）；可独立开启弹窗与语音「you get a new spot」，语音随当前界面语言播报；标记存活时间与最多显示数量可调，与对手告警互不影响
- **采集常开**：Spot 采集与 PSKR 订阅不再依赖「开始监听」开关，服务启动后即持续运行；监听呼号新增后无需任何按钮即可生效
- **QSO 视图右侧面板**：按电台动态显示频率/模式/TX 卡片、当前分数（QSO/乘数/点数/Score）、上一个 QSO，以及最近 60 分钟的 QSO 速率柱状图（5 分钟一根柱，按墙钟整点对齐不抖动）、QSO/分钟图、按操作员与按频段统计条形图；Spot Records 面板仅在 Spot 视图显示
- **设置分页**：Settings 面板分为 **全局**（语言、主题、底图源、本台呼号与网格、时间显示）/ **Spot 地图**（监测呼号、标记存活时间、频段颜色、图层参数）/ **QSO 地图**（竞赛组别、自动缩放、本台 Spot 提醒、告警阈值与提示音、静音时段、QRZ 凭据）/ **大屏**（名称、图层、叠加方式、轮播、纬度窗口、倒计时）/ **数据**（数据源开关与轮询、保留期清理、磁盘告警、日志级别）/ **传播**（投影、图层、阈值）六页；页签固定顶部并支持关键字搜索、导出 / 导入 JSON、按域重置与多配置档
- QSO 坐标**优先从 QRZ.com 查询**（与原 n1mm_dashboard 项目一致，需在 Settings 中配置 QRZ 用户名/密码，需 QRZ XML 订阅）；未配置或查询失败时依次回退到通联中的 gridsquare 字段、已积累的 spot 坐标库

配置方法：

1. 大屏 **Settings → My grid (Maidenhead)** 填入本台梅登海德网格（4 或 6 位，如 `OM89VX`），用于 QSO 地图的本台标记与连线
2. N1MM+：**Options → Configure ports, mode controls, Winkey… → Broadcast Data** 选项卡，勾选并填写（`<服务器IP>` 为运行 DX-Compass 的机器）：
   - **Contacts** → `<服务器IP>`，端口 `12061`（QSO 增删改）
   - **Radio** → `<服务器IP>`，端口 `12060`（频率/模式/TX 状态）
   - **Score** → `<服务器IP>`，端口 `12062`（竞赛记分）
3. 服务器防火墙放行 UDP：`sudo ufw allow 12060:12062/udp`
4. （可选）大屏 **Settings** 填入 **QRZ.com 用户名 / 密码**（需 QRZ XML Data 订阅），QSO 坐标将优先从 QRZ.com 查询；凭据保存在服务器端 Node-RED 上下文中，密码不会回显
5. N1MM+ 产生 QSO、频率变化或记分更新时大屏实时刷新

### 远程 relay（N1MM 与服务器不在同一网段）

N1MM 的 UDP 广播不出公网时，在本机运行 relay：它监听 UDP 12060，把原始 XML 包转发到服务器的 HTTP 接入端点。

1. 服务器 **Settings → QSO 地图 → N1MM HTTP 接入令牌** 填一个随机字符串（或给服务设置环境变量 `DX_N1MM_TOKEN`）；留空则 HTTP 接入关闭，UDP 直连不受影响
2. 本机安装 Node.js 18+，在仓库目录运行：

```bash
node scripts/n1mm-relay.mjs --host <服务器IP> --token <同一个令牌>
# 或使用环境变量
#   DX_N1MM_HOST / DX_N1MM_PORT / DX_N1MM_TOKEN
```

3. N1MM+：**Config → Configure Ports… → Broadcast Data**，把 Contacts / Radio / Score 的目标改为本机 `127.0.0.1`，端口分别为 `12061` / `12060` / `12062`
4. Windows 防火墙需允许 `node.exe` 监听 UDP 12060（首次运行会弹窗）
5. relay 自带断线缓存与指数退避；`--help` 可查看全部参数。服务器返回 401 表示令牌不一致，503 表示服务器尚未配置令牌

## 传播地图（Propagation）

菜单中的 **Propagation** 是独立于 Spot / QSO 的第三个全屏视图：左侧为 Canvas 世界地图，右侧停靠传播数据面板。进入该视图后自动隐藏 Spot 专用控件（布局、轮询、开始监控、Spot 计数）。

**地图**

- **投影**：Mercator / 方位投影（以本台网格为中心）/ Robinson，三者均按 cover 语义铺满画布（无信箱黑边），可随时切换并保存到浏览器设置
- **背景层**：**传播预测**（全球电离层台站 foF2/MUF3000 实测 + 纬度/季节气候学回填生成的连续 MUF 色洗，海洋区域同样着色，双线性插值平滑、无网格块）/ **天气**（Open-Meteo 全球温度网格）/ **极光**（NOAA OVATION 极光概率）
- **晨昏线**：与 Spot/QSO 地图同一套太阳赤纬算法，夜半球半透明黑罩 + 灰色分界线，每分钟刷新；春分/秋分附近（|赤纬| < 0.6°）自动切换为经线模式，避免极点抖动
- **交互**：鼠标悬停显示经纬度；点击地图设置 DX 位置（持久化到浏览器设置，用于点对点路径与 DX 天气）
- 本台位置（DE）取自 Settings 中的 Maidenhead 网格

**数据面板**

- **空间天气卡片**（各带历史迷你曲线）：SFI、SSN、Kp、A、Bz、Bt、太阳风速度、质子密度、X 射线、Dst、极光概率、DRAP；Kp ≥ 4 / Bz ≤ −5 / Dst ≤ −50 等阈值以警示色标出
- **NOAA R / S / G** 三级事件标度
- **统一模型频段条件**：10 个 HF 频段的日间 / 夜间 Good / Fair / Poor，由服务器传播模型计算
- **DE → DX 点对点矩阵**：10 个 HF 频段 × 24 小时可用性（当前小时列高亮，每行最优小时描边），并按当前小时给出最佳频段
- **全球读数**：MUF @ DE、全球最高 MUF 台站、MUF @ DX、极光最大值、DRAP @ DE / DX、TOA（最佳发射仰角）、DX 天气

**数据来源**

| 数据 | 来源 |
| --- | --- |
| Kp、Dst、10.7cm 通量、黑子数、X 射线、太阳风/IMF、OVATION 极光、DRAP、R/S/G | NOAA SWPC 公开 JSON / 文本接口 |
| 当前 SFI/SSN/Kp/X 射线/极光与 HF 频段条件 | HamQSL `solarxml.php` |
| 全球 MUF / foF2（电离层台站实测） | prop.kc2g.com `stations.json` |
| 全球天气网格 | Open-Meteo `forecast` |

**实现与接口**

- `lib/propagation/collector.js` 通过 `dx` facade 接入 Node-RED；**Propagation** 流程每 5 分钟采集一次，原始结果缓存在 global 上下文 `propData`
- 前端每 60 秒经共享 propagation repository 请求 `GET /api/prop`（`Cache-Control: no-store`）；接口返回原始快照和服务器统一计算的 `forecast`（MUF 网格、频段条件、路径矩阵、各洲最佳频段及 DE/DX 读数），失败源保留上一次的值并在面板标注
- 预测按各源 fetched 时间、HOME/DX、UTC 小时与地磁数据时间缓存；传播页和大屏只做插值、投影与着色，不再分别实现预测公式
- 各级缓存有效期：太阳风 / 极光 / X 射线等大文件 20 分钟，小数据集 4 分钟，天气 10 分钟（避免对公开接口造成压力）
- **点对点矩阵与可用性为近似模型**（依据 MUF、DRAP 吸收、路径昼夜太阳高度角与距离的启发式计算，面板标注「approximate forecast」），不是 VOACAP 的输出；需要精确预测时请以专业软件为准
- 无台站覆盖的路径不再使用单一全球标量：MUF 估值为「SFI 基准 × 该纬度正午太阳高度」的气候学值，再按该点当时的太阳天顶角恢复昼夜变化，因此会随纬度（赤道高、极区低）与季节（冬季低、夏季高）自然变化；有实测台站时按距离加权混合

## 只读大屏（Wall Display）

面向竞赛现场的第三块屏，与 5758 的监测界面并行运行：只订阅数据，不提供任何操作。

**启动**

`install.sh` 会把它部署成独立服务 **`dx-compass-wall.service`**（开机自启、跟随 `dx-compass` 启动），装好后直接访问 `http://<服务器IP>:5859/` 即可；手动运行或自定义端口时：

```bash
npm run wall                 # 默认监听 5859，上游 http://127.0.0.1:5758
# 自定义端口 / 上游（Node-RED 在别的机器或端口时）
BIGSCREEN_PORT=5860 BIGSCREEN_UPSTREAM=http://127.0.0.1:5758 node bigscreen/server.js
```

上游 Node-RED 需先在 5758 正常运行。云服务器除 `ufw` / `firewalld` 外，还需要在云厂商**安全组**放行 TCP 5859，否则外网访问会连接超时。

**只读边界**

- 只接受 `GET` / `HEAD`，其它方法一律 405
- 只代理 `/api/settings`、`/api/callsigns`、`/api/spots`、`/api/qsos`、`/api/station/state`、`/api/prop` 六个读接口；其它路径在大屏服务上直接 404，不会透传到 Node-RED
- 静态文件按固定文件名提供（页面、样式、脚本、陆地轮廓），不做目录遍历
- 不写数据库、不改流程、不动全局上下文，适合长期挂在场边

**版面**

- **页眉**：大屏名称、倒计时（可选）、UTC / 本地时钟与日期（随时区设置切换）
- **地图**：单张 Mercator 世界地图，按面板实际宽高 cover 铺满、无黑边；离线海岸线底图 + 深海底色，叠加 MUF 色洗、晨昏线、极光 / 天气底图，以及 QSO / 我方 SPOT / 对手 SPOT 三个矢量层（大圆航线 + 频段配色）
- **左栏**：空间天气卡片，8 项指标（SFI、SSN、Kp、Dst、Bz、Bt、太阳风、X 射线）的迷你折线图自动轮播；下方为放大的频段条件
- **右栏**：各操作员 / 各频段 QSO 横向条形图；对手监测按「呼号大卡 + 频段小格」排布，最多 9 个对手一屏，呼号颜色 + 图形双重区分
- **底部**：电台频率卡、QSO 速率（最近 12 小时）、QSO 与 SPOT 每分钟趋势（各 60 分钟）

**设置（Settings → 大屏）**

- 大屏名称（最多 24 字符）
- 倒计时：开关 + 开始时间 + 结束时间，均按 **UTC** 解释（与页眉时钟一致）；只填结束时间时直接从当前倒计时到结束，结束后显示「已结束」
- 1 级图层：传播渲染图 / 极光 / 天气；2 级图层：QSO 地图 / 我方 SPOT / 对手 SPOT
- 叠加方式：全部叠加，或自动轮播（逐层轮换）；可调逐层停留时间与空间天气轮播停留时间
- 地图纬度窗口：上 / 下纬度（默认 **+85° / −85°**），用于按场地投影比例裁掉不必要的极区
- 时区：UTC 或浏览器本地时间，影响页眉时钟、日期与趋势横轴

**说明**

- 地图固定 Mercator 且不可交互，默认纬度窗口 **+85° / −85°**：完整保留各大洲，只裁掉南极洲极冠；地图以 cover 语义铺满面板，左右不留黑边（宽屏时仅裁掉两侧海洋）
- 底图只画海岸线（不画国界），避免大屏上出现细碎杂线
- 航线按大圆绘制：跨越换日线时在边缘断开并从另一侧续画；跨极区航线在纬度窗口上边缘截断，避免被投影钳制后压成贴顶横线
- 对手大卡内按活动频段分格：同一台站在多个频段同时被 spot 时逐格显示频段、频率与主攻方向；1080p 下 9 个对手一屏不滚动，超出屏高时由卡片内部滚动
- 大屏每 60 秒拉取一次共享设置，在主界面改完设置无需刷新大屏即可生效

## 服务管理

系统级安装（`sudo`）：

```bash
sudo systemctl status dx-compass       # 查看状态
sudo systemctl restart dx-compass      # 重启
sudo systemctl stop dx-compass         # 停止
sudo systemctl disable dx-compass      # 取消开机自启
journalctl -u dx-compass -f            # 实时查看日志
```

按用户安装（方式三，无需 sudo）：

```bash
systemctl --user status dx-compass     # 查看状态
systemctl --user restart dx-compass    # 重启
systemctl --user stop dx-compass       # 停止
systemctl --user disable dx-compass    # 取消开机自启
journalctl --user -u dx-compass -f     # 实时查看日志
```

两种模式均**不会**修改系统已有的 Node-RED（如 1880 端口 / `nodered` 服务）或 `~/.node-red`。

数据库文件 `dxcompass.db`、上下文目录 `.context/` 在首次运行后生成于项目目录，均已在 `.gitignore` 中忽略。

## 数据与导出

- 所有匹配的 spot 写入 SQLite `spots` 表，字段含：`spot_id`（数据源唯一 ID，用于去重；RBN 记录为负数）、`timestamp`（时间）、`monitored_call`（被监测呼号）、`de`（报告人）、`freq`（频率）、`spot_call`、`mode`（CW/DIGI/PHONE）、`signal`（RST）、`snr`（CW/FT8 的 dB）、`lat`/`lon`、`distance_km`/`distance_miles`、`comment`
- 右侧 **Records** 面板可按呼号查询，**Export CSV** 按当前标签导出（All Spots 导出全部 spot，Recorded 导出本次录制），用于赛后分析
- REST API：
  - `GET  /api/config` / `POST /api/config`：读取 / 保存配置（本台经纬度）
  - `GET  /api/callsigns` / `POST /api/callsigns`：读取 / 保存监测呼号列表（POST 新呼号会自动触发历史回溯）
  - `GET  /api/settings`：读取共享设置（已按 schema 补齐默认值并剔除仅本机项）
  - `POST /api/settings`：整包保存共享设置（旧客户端兼容），保存后经 WebSocket 广播给所有客户端
  - `POST /api/settings/patch`：部分更新，body 为 `{"__patch": {"theme": "ocean"}}`；服务端逐键校验，返回 `settings`、新的 `_rev`、`warnings` 与被拒绝的 `rejected`
  - `POST /api/settings/reset`：按域重置，body 为 `{"domain": "ui|map|qso|wall|data|prop|all"}`；重置结果同样广播给所有客户端
  - `GET  /api/spots?call=呼号&limit=数量`：查询记录
  - `POST /api/spots/clear`：仅清空 spots 表（保留录制数据）
  - `GET  /api/qsos?limit=数量`：查询本台 QSO 记录（N1MM+ 集成）
  - `GET  /api/station/state`：返回全部已上报电台的状态映射（`radios`）与最近一次竞赛记分（N1MM+ 集成）
  - `GET  /api/qrz/config` / `POST /api/qrz/config`：读取 / 保存 QRZ.com 凭据（密码不回显）
  - `POST /api/reset`：清空 spots / qsos / recording_spots 三张表与电台/记分状态（Settings 的一键清除会同时清空监听呼号与全部设置）
  - `GET  /api/alert-rules` / `POST /api/alert-rules` / `PUT /api/alert-rules/:id` / `DELETE /api/alert-rules/:id`：条件告警规则增删改查；`GET /api/alert-rules/hits` 返回最近命中。规则没有编辑页面，只能通过接口维护
  - 对手提醒本身是内置规则，不需要先建规则行：只对监听呼号生效，按「新频率 / 新频段 / 换频段」判定（频率阈值 `freqDeltaKhz`，TTL 用每模式存活时间），波段组合短时去重；`alert_rules` 只作为可选附加过滤，存在规则行时需命中至少一条才下发
  - 创建规则请求体：`name`（必填，≤60 字符）与至少一个正向条件 `call` / `prefix` / `dxcc` / `cqZone` / `ituZone` / `band` / `mode` / `source` / `from` `to`（UTC）/ `snrMin` `snrMax` / `wpmMin` `wpmMax`；可选排除条件 `notCall` / `notDxcc` / `notBand` / `notMode` / `notSource`；动作开关 `popup` / `voice` / `sound`，默认 `enabled: true`。示例：`curl -X POST http://<host>/api/alert-rules -H 'Content-Type: application/json' -d '{"name":"20m DX","band":["20m"],"voice":true}'`（`band` 为数组，其余列表字段同理）

## 常见问题

**0. 一键命令下载失败（服务器需代理访问 GitHub）？**

先下载引导脚本，再带代理变量执行（按实际代理端口修改）：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh -o /tmp/dxc-bootstrap.sh
sudo https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 bash /tmp/dxc-bootstrap.sh
```

代理变量会被后续的 git / npm 步骤继承；npm 部分还会自动切换国内镜像重试。

如果服务器完全无法访问 GitHub，可直接使用 Gitee 镜像脚本（无需代理）：

```bash
curl -fsSL https://gitee.com/fatman985KG/dx-compass/raw/main/bootstrap-gitee.sh | sudo bash
```

**0b. 更新时报 `detected dubious ownership in repository`？**

旧版安装把目录属主设成了专用用户 `dxcompass`。见[关于 git 目录属主](#关于-git-目录属主dubious-ownership)：重跑一次一键安装即可自动把属主改回 root，或手动 `sudo chown -R root:root /opt/dx-compass`。

**1. 大屏打开正常但收不到 spot？**

- 数据源是服务器端轮询，先确认服务器能访问数据源：`curl -I https://dxwatch.com/dxsd1/s.php?s=0&r=1` 与 `curl -I https://www.reversebeacon.net/main.php`
- 等待最多 30 秒（轮询周期）；可在 Node-RED 编辑器（`/red`）查看 `Fetch dxwatch spots` / `Fetch RBN spots` 节点状态与日志
- 被监测呼号必须近期（活跃时段约几分钟内）有真实 spot 上报才会打点；输入呼号时会自动回溯最近 7 天记录，可先打开 **Records** 面板确认历史数据
- 极少数冷门呼号可能长时间无人点到，属正常现象

**2. 5758 端口无法访问？**

- 检查服务状态：`sudo systemctl status dx-compass`
- 云服务器检查安全组是否放行 5758；本机防火墙：`sudo ufw allow 5758/tcp`
- 若端口被其他程序占用，修改 `settings.js` 中的 `uiPort` 后重启服务

**3. npm 安装慢或失败？**

安装脚本已内置国内镜像自动重试。手动安装可执行：

```bash
cd /opt/dx-compass
npm install --omit=dev --registry=https://registry.npmmirror.com
```

**4. 地图底图加载慢或无法加载？**

默认底图为 OpenStreetMap，国内网络环境可在 **Settings → Base map** 切换为**高德地图**；切换即时生效，所有标记、连线、热力图与晨昏线保持不变。地图打点和记录功能本身不依赖底图加载。底图瓦片由浏览器直接从所选瓦片服务获取，因此浏览端需要能访问该瓦片服务（国内建议用高德）。

页面所用的 Leaflet 已内置在 `public/vendor/leaflet/`，不再依赖 unpkg 等外部 CDN；若底图整块空白（连缩放按钮都没有），说明是静态文件没更新，重新 `git pull` 后重启服务即可。

**5. 如何修改端口？**

编辑 `settings.js` 的 `uiPort`，同时更新 systemd 单元中引用（重新运行 `sudo bash install.sh` 即可），再放行对应防火墙端口。

**6. 只读大屏 5859 打不开或一直空白？**

- 5859 是**独立服务**（`dx-compass-wall.service`），与 5758 的 `dx-compass` 分开管理：
  `sudo systemctl status dx-compass-wall` / `sudo systemctl restart dx-compass-wall` / `sudo journalctl -u dx-compass-wall -f`
- 老版本安装没有这个服务：到 `/opt/dx-compass` 执行 `git pull` 后重新运行 `sudo bash install.sh` 即可补装
- 云服务器外网访问超时，多半是**安全组未放行 TCP 5859**（`ufw` 放行只能解决本机防火墙）：`sudo ufw allow 5859/tcp` 之后仍需在云控制台放行入方向 5859
- 页面能打开但没有数据：先在 5758 的监测页确认 spot / QSO 正常；大屏只代理 6 个只读接口，上游 Node-RED 未运行时所有数据请求都会返回 502
- 端口 / 上游可用环境变量调整：`BIGSCREEN_PORT=5860 BIGSCREEN_UPSTREAM=http://127.0.0.1:5758 node bigscreen/server.js`（systemd 部署时改单元的 `Environment=`）

**7. 升级到 v2.1 后保存设置报 404，或设置页缺少「数据 / 传播」页签？**

- v2.1 新增的 `/api/settings/patch`、`/api/settings/reset` 写在 `flow.json` 里，**浏览器刷新不会重新加载流程**。拉取代码后必须重启：`sudo systemctl restart dx-compass`；只读大屏引用了新增静态模块，还需 `sudo systemctl restart dx-compass-wall`
- 静态文件已更新但流程未重启时，前端会自动回退到旧的 `POST /api/settings` 整包保存，功能不中断，但拿不到逐键校验与按域重置
- 若使用 Gitee 镜像，请等镜像同步完成后再执行安装脚本；安装脚本本身可重复执行，会一并更新代码、依赖与服务

## 本地开发 / 手动运行（不使用 systemd）

```bash
npm install
npx node-red -u . -s settings.js
# 访问 http://localhost:5758/

# 另开一个终端启动只读大屏（需 5758 已在运行）
npm run wall
# 访问 http://localhost:5859/
```

## 许可证

[MIT](LICENSE)
