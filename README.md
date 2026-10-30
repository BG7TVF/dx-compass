# DX-Compass

基于 Node-RED 的 DX Spot 与竞赛实时监测大屏。通过 **dxwatch.com**（FT8/SSB/DIGI 等）、**reversebeacon.net RBN**（CW，含 dB 信号强度）与 **PSKReporter MQTT v2**（DIGI 实时流）三路公开数据同时监测最多 **9 个呼号**收到的 spot，在地图上实时打点；可选接入 **N1MM+**，显示本台 QSO 地图、竞赛分数与速率。支持多分屏（DVR 风格）、4 套主题、11 种界面语言，所有 spot 与 QSO 记录到 SQLite 用于赛后分析。

## 一键安装（复制即用）

在 **Ubuntu 服务器终端**直接粘贴下面一行命令，即可自动完成"下载代码 → 安装依赖 → 启动服务"：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
```

没有 `curl` 时可用 `wget`：

```bash
wget -qO- https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
```

脚本会将代码安装到 `/opt/dx-compass`，注册并启动开机自启服务 `dx-compass`（端口 **5758**）。完成后访问：

- 监测大屏：`http://<服务器IP>:5758/`
- Node-RED 编辑器：`http://<服务器IP>:5758/red`

> 该命令可**重复执行**：已安装时会自动更新代码到最新版本后重新部署。
> 服务器通过代理访问 GitHub 时：先下载脚本再带代理变量运行，见文末[常见问题](#常见问题)。
> 云服务器记得在安全组放行 **TCP 5758**。

**没有 root 权限？** 去掉 `sudo` 即可按当前用户安装到自己的家目录（见[方式三：普通用户免 root 安装](#方式三普通用户免-root安装)）：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | bash
```

## 功能特性

- **多分屏布局**：`1×1` / `2×2` / `3×3` 自由切换，一个呼号对应一张地图，最多同时监测 9 个呼号；呼号多于可见窗口时支持自动轮询翻页
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
- **多语言界面**：支持中文 / English / Deutsch / Français / Español / Português / Русский / Italiano / العربية / 한국어 / 日本語 共 11 种界面语言，文案独立在 `public/js/i18n.js`，新增语言无需改动应用代码
- **4 套主题**：**黑暗**（默认）、**明亮**（浅色底，适合白天或投影）、**深海**、**琥珀**，在 Settings → 全局 即时切换；整套配色（工具栏、面板、表格、弹窗、地图底色）随主题变化
- **多人协作**：监听呼号、标记存活时间、频段颜色、底图、主题、提醒开关等设置保存在服务器端，修改后经 WebSocket 实时同步到所有打开的浏览器；分屏布局（1×1/2×2/3×3）只保存在各自浏览器
- **本台 Spot 提醒**：本台呼号出现在 spot 上时，QSO 地图以红色标记标出（可选），并可与弹窗（8 秒自动消失）和语音播报「you get a new spot」一起开启；提醒与普通 Spot 监控独立开关，标记存活时间与最多显示数量可调，语音按当前界面语言播报
- **底图可切换**：OpenStreetMap 与高德地图（中国大陆网络环境可用），切换后所有地图显示约定保持不变
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

- **后端**：Node-RED（HTTPS 轮询、HTTP REST API、WebSocket、SQLite）
- **数据源**：
  - dxwatch.com 公开 spot 接口 `/dxsd1/s.php`（聚合全球 DX Cluster，30 秒轮询）
  - reversebeacon.net RBN 接口 `/spots.php`（全球 CW skimmer 网络，10 秒轮询，每条含 SNR dB 与 WPM；启动时自动从 `main.php` 提取版本参数，失效自动重取）
  - 两者均为非官方公开接口，请保持内置的轻量轮询节奏；同一条 CW spot 若同时出现在两个源中会被自动去重
- **前端**：原生 HTML/CSS/JS + Leaflet + OpenStreetMap，由 Node-RED 静态托管
- **数据库**：SQLite（`dxcompass.db`，运行时自动创建）

## 目录结构

```
dx-compass/
├── flow.json          # Node-RED 主流程（DX Cluster 接入、解析、定位、记录、API）
├── settings.js        # Node-RED 配置（端口 5758、静态目录、上下文持久化）
├── package.json       # 依赖（node-red、node-red-node-sqlite）
├── flow_cred.json     # 凭据文件（为空）
├── install.sh         # Ubuntu 一键安装脚本（依赖 + systemd 服务）
├── bootstrap.sh       # 引导脚本：一行命令从 GitHub 下载并调用 install.sh
├── public/            # 前端大屏
│   ├── index.html
│   ├── css/style.css
│   ├── data/land.js    # 离线陆地轮廓（世界地图海岸线，供传播地图 Canvas 绘制）
│   └── js/
│       ├── i18n.js     # 界面翻译（LANGS / LANG_NAMES / I18N），新增语言只改这个文件
│       ├── prop.js      # 传播地图（投影 / 背景层 / 晨昏线 / 数据面板）
│       └── app.js      # 应用逻辑
├── lib/prop.js         # 传播数据采集器（NOAA SWPC / HamQSL / prop.kc2g / Open-Meteo）
└── LICENSE
```

## 添加新语言

界面文案已独立到 [public/js/i18n.js](public/js/i18n.js)（在 `index.html` 中先于 `app.js` 加载），新增语言无需改动应用逻辑：

1. 在 `LANGS` 数组末尾追加语言代码（如 `'nl'`）
2. 在 `LANG_NAMES` 中补充该语言的母语名称（会显示在 Settings 的语言下拉框中）
3. 在 `I18N` 中复制英文块，新增该语言条目并翻译所有键（键名必须与英文块完全一致，缺失的键会回退到英文）
4. 刷新页面即可在 Settings → 全局 → Language 中选择

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

### 方式二：手动下载代码后安装

```bash
# 直接在服务器上克隆
cd /opt
sudo git clone https://github.com/BG7TVF/dx-compass.git
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

git 默认拒绝操作"属主不是当前用户"的仓库，会报：

```
fatal: detected dubious ownership in repository at '/opt/dx-compass'
```

`bootstrap.sh` 已内置处理，无需手动干预：

- **以 root 运行时**：自动检测目录属主，并以该属主身份执行 `fetch` / `reset`，同时对属主登记 `safe.directory`
- **以普通用户运行、且目录属于别人**：会明确提示改用属主账号，或执行 `sudo chown -R <你> /opt/dx-compass` 取得所有权

若手动执行 git 命令遇到该错误，可任选其一：

```bash
# 方案 A：以属主身份拉取（推荐，避免文件属主混乱）
sudo -u <属主> git -C /opt/dx-compass pull

# 方案 B：把该目录加入当前用户的 safe.directory 白名单
git config --global --add safe.directory /opt/dx-compass
git -C /opt/dx-compass pull
```

### 访问

- **监测大屏**：`http://<服务器IP>:5758/`
- **Node-RED 编辑器**：`http://<服务器IP>:5758/red`

> 云服务器请在安全组 / 防火墙放行 TCP 5758 端口：
> `sudo ufw allow 5758/tcp`

## 首次使用配置

1. 浏览器打开监测大屏 `http://<服务器IP>:5758/`
2. 点击左上角 **☰ 菜单 → Settings**，在 **Spot 地图** 页的呼号槽位中填入要监测的呼号，点 **Save**
3. 点击右侧 **Records** 面板顶部的 **▶ 开始监控** 按钮启动监控：
   - 系统立即开始接收实时 spot（CW 每 10 秒、其它模式每 30 秒刷新）
   - 同时自动从数据源回溯该呼号最近 7 天的历史 spot，地图和 Records 面板很快就会有数据
4. 无需任何集群地址、登录呼号或 Connect 操作——数据源开箱即用

> Settings 为整页三标签：**全局**（界面语言 11 种、主题 4 套、底图源 OSM/高德、本台呼号、一键清除）、**Spot 地图**（监测呼号、各模式标记存活时间、各频段颜色）、**QSO 地图**（本台梅登海德网格、竞赛组别 SO1R/SO2R/MS/MM、自动缩放、本台 Spot 提醒与连线、QSO 标记上限、QRZ 凭据）。设置保存在服务器端并实时同步给所有浏览器，仅分屏布局保存在本机。

> 数据来自 dxwatch.com 与 reversebeacon.net 的公开接口。CW spot 由 RBN skimmer 网络提供，带真实 SNR（dB）与发报速度（WPM）；FT8/FT4 的 SNR 来自 dxwatch；普通 SSB spot 本身不携带信号强度，对应列为空属正常。

## N1MM+ 本台集成（比赛实时状态）

在 N1MM+ 竞赛日志软件中开启 UDP 广播后，可切换到全屏 QSO 地图（顶栏与本台状态栏只在 QSO 视图显示，Spot 视图保持简洁）：

- **状态栏**：按已上报电台动态生成的频率 / 模式 / TX 卡片（SO2R / MS / MM 下多台并列）、当前总分（QSO 数 / 乘数 / 点数 / Score）、上一个 QSO
- **QSO 地图**：与 Spot 视图各有独立按钮，一键全屏切换；进入 QSO 视图后自动隐藏布局（1×1/2×2/3×3）、轮询、开始监控等 Spot 专用控件；每个 QSO 一个按频段着色的永久标记，从本台位置画大圆线连接；新乘数（Multiplier）带黄色 M 徽章；QSO 持久化在 SQLite `qsos` 表，浏览器刷新与服务重启后自动恢复
- **QSO 顶部实时条**：地图上方显示最新 QSO —— RUN / S&P 状态（由 N1MM RadioInfo 实时判断）、频率、对方呼号、信号报告（RST 收发）、交换信息，以及频段/模式/操作员/相对时间
- **竞赛组别支持**：Settings → QSO 地图 可选择 SO1R / SO2R / MS / MM；QSO 面板按已上报的电台动态生成频率卡片，SO2R / MS / MM 下每台电台一张（R1、R2、R3…），顶部条同步显示全部电台频率，页面刷新后自动回填
- **新 Spot 弹窗提醒**：QSO 地图下，被监听呼号出现新 Spot 时弹出提示（呼号、频段、模式、频率、监听站 DE、SNR、时间），8 秒后自动消失；任何时刻只存在一个弹窗，新 Spot 会直接覆盖旧内容并重置计时，绝不叠加；可在 Settings → QSO 地图 中开关
- **语音提醒（Web Speech API）**：与弹窗同时播报——首次出现为「{呼号} 新 Spot」；与上一条同呼号 Spot 相比频段变化为「{呼号} 换频段」（此时不再播报新频率）；仅频率变化为「{呼号} 新频率」；新的播报会打断上一条，绝不排队；可在 Settings → QSO 地图 中独立开关
- **本台 Spot 提醒**：本台呼号被别人 spot 时，QSO 地图以红点标出（有本台网格时同时画红色大圆线）；可独立开启弹窗与语音「you get a new spot」，语音随当前界面语言播报；标记存活时间与最多显示数量可调，与普通 Spot 的提醒互不影响
- **QSO 视图右侧面板**：按电台动态显示频率/模式/TX 卡片、当前分数（QSO/乘数/点数/Score）、上一个 QSO，以及最近 60 分钟的 QSO 速率柱状图（5 分钟一根柱，按墙钟整点对齐不抖动）、QSO/分钟图、按操作员与按频段统计条形图；Spot Records 面板仅在 Spot 视图显示
- **设置分页**：Settings 面板分为 **全局**（语言、主题、底图源、本台呼号）/ **Spot 地图**（监测呼号、标记存活时间、频段颜色）/ **QSO 地图**（本台网格、竞赛组别、自动缩放、本台 Spot 提醒、标记上限、QRZ 凭据）三页
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

## 传播地图（Propagation）

菜单中的 **Propagation** 是独立于 Spot / QSO 的第三个全屏视图：左侧为 Canvas 世界地图，右侧停靠传播数据面板。进入该视图后自动隐藏 Spot 专用控件（布局、轮询、开始监控、Spot 计数）。

**地图**

- **投影**：Mercator / 方位投影（以本台网格为中心）/ Robinson，三者均按 cover 语义铺满画布（无信箱黑边），可随时切换并保存到浏览器设置
- **背景层**：**传播预测**（按全球电离层台站 foF2/MUF3000 插值的 MUF 色块）/ **天气**（Open-Meteo 全球温度网格）/ **极光**（NOAA OVATION 极光概率）
- **晨昏线**：与 Spot/QSO 地图同一套太阳赤纬算法，夜半球半透明黑罩 + 灰色分界线，每分钟刷新；春分/秋分附近（|赤纬| < 0.6°）自动切换为经线模式，避免极点抖动
- **交互**：鼠标悬停显示经纬度；点击地图设置 DX 位置（持久化到浏览器设置，用于点对点路径与 DX 天气）
- 本台位置（DE）取自 Settings 中的 Maidenhead 网格

**数据面板**

- **空间天气卡片**（各带历史迷你曲线）：SFI、SSN、Kp、A、Bz、Bt、太阳风速度、质子密度、X 射线、Dst、极光概率、DRAP；Kp ≥ 4 / Bz ≤ −5 / Dst ≤ −50 等阈值以警示色标出
- **NOAA R / S / G** 三级事件标度
- **HamQSL 频段条件**：8 个 HF 频段的日间 / 夜间 Good / Fair / Poor
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

- 采集器 `lib/prop.js` 通过 `settings.js` 的 `functionGlobalContext` 暴露为 `prop`，无需新增 Node-RED 节点类型；`flow.json` 中的 **Propagation** 标签页每 5 分钟采集一次，结果缓存在 global 上下文 `propData`
- 前端每 60 秒请求 `GET /api/prop`（`Cache-Control: no-store`），接口直接返回缓存，失败源保留上一次的值并在面板标注
- 各级缓存有效期：太阳风 / 极光 / X 射线等大文件 20 分钟，小数据集 4 分钟，天气 10 分钟（避免对公开接口造成压力）
- **点对点矩阵与可用性为近似模型**（依据 MUF、DRAP 吸收、路径昼夜太阳高度角与距离的启发式计算，面板标注「approximate forecast」），不是 VOACAP 的输出；需要精确预测时请以专业软件为准

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
  - `GET  /api/settings` / `POST /api/settings`：读取 / 保存共享设置（主题、语言、底图、标记存活时间等），保存后经 WebSocket 广播给所有客户端
  - `GET  /api/spots?call=呼号&limit=数量`：查询记录
  - `POST /api/spots/clear`：仅清空 spots 表（保留录制数据）
  - `GET  /api/qsos?limit=数量`：查询本台 QSO 记录（N1MM+ 集成）
  - `GET  /api/station/state`：返回全部已上报电台的状态映射（`radios`）与最近一次竞赛记分（N1MM+ 集成）
  - `GET  /api/qrz/config` / `POST /api/qrz/config`：读取 / 保存 QRZ.com 凭据（密码不回显）
  - `POST /api/reset`：清空 spots / qsos / recording_spots 三张表与电台/记分状态（Settings 的一键清除会同时清空监听呼号与全部设置）

## 常见问题

**0. 一键命令下载失败（服务器需代理访问 GitHub）？**

先下载引导脚本，再带代理变量执行（按实际代理端口修改）：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh -o /tmp/dxc-bootstrap.sh
sudo https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 bash /tmp/dxc-bootstrap.sh
```

代理变量会被后续的 git / npm 步骤继承；npm 部分还会自动切换国内镜像重试。

**0b. 更新时报 `detected dubious ownership in repository`？**

见[关于 git 目录属主](#关于-git-目录属主dubious-ownership)。一键脚本已自动处理；手动拉取时用 `sudo -u <属主> git -C /opt/dx-compass pull`，或把目录加入 `safe.directory`。

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

默认底图为 OpenStreetMap，国内网络环境可在 **Settings → Base map** 切换为**高德地图**；切换即时生效，所有标记、连线、热力图与晨昏线保持不变。地图打点和记录功能本身不依赖底图加载。

**5. 如何修改端口？**

编辑 `settings.js` 的 `uiPort`，同时更新 systemd 单元中引用（重新运行 `sudo bash install.sh` 即可），再放行对应防火墙端口。

## 本地开发 / 手动运行（不使用 systemd）

```bash
npm install
npx node-red -u . -s settings.js
# 访问 http://localhost:5758/
```

## 许可证

[MIT](LICENSE)
