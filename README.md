# DX-Compass

基于 Node-RED 的多呼号 DX Spot 实时监测大屏。通过 **dxwatch.com** 公开数据流（HTTPS 轮询，无需登录 DX Cluster、无需 telnet）同时监测最多 **9 个呼号**收到的 spot，在地图上实时打点显示，支持硬盘录像机（DVR）风格的多分屏切换，并将所有 spot 记录到数据库用于赛后分析。

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

## 功能特性

- **多分屏布局**：`1×1` / `1×2` / `2×2` / `3×3` 自由切换，一个呼号对应一张地图，最多同时监测 9 个呼号
- **实时打点**：每 30 秒从 dxwatch.com 拉取全球聚合 spot，解析报告人（DE）位置后在地图上标点，数据自动流入，无需任何连接配置
- **历史回溯**：新添加被监测呼号时，自动回溯该呼号最近 7 天（最多 150 条）的 spot
- **标点存活 1 小时**：每个标记 1 小时后自动消失，颜色按信号强度区分（绿 / 黄 / 红）
- **完整记录**：每条 spot 记录时间、频率、报告人、模式（CW/DIGI/PHONE）、FT8 信号 SNR、距离等，存入 SQLite
- **赛后分析**：记录面板支持按呼号筛选、一键导出 CSV
- **距离计算**：直接使用 dxwatch 附带的呼号经纬度 + Haversine 公式，计算报告人相对本台的距离（公里/英里），不依赖第三方定位接口
- **独立共存**：可与服务器上已有的 Node-RED / Node-Red-Contesting-Dashboard 实例完全独立运行

## 技术架构

```
dxwatch.com (HTTPS/JSON, 30s 轮询) ──► Node-RED 流程 ──► 按监测呼号过滤
                                   ├──► 内置经纬度 + Haversine 距离计算
                                   ├──► FT8 信号 / 模式解析
                                   ├──► SQLite 持久化记录（spot_id 去重）
                                   └──► WebSocket 实时推送 ──► 前端多地图大屏
```

- **后端**：Node-RED（HTTPS 轮询、HTTP REST API、WebSocket、SQLite）
- **数据源**：dxwatch.com 的公开 spot 接口 `/dxsd1/s.php`（聚合全球 DX Cluster；非官方公开接口，请保持 30 秒的轻量轮询）
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
│   └── js/app.js
└── LICENSE
```

## 环境要求

- **操作系统**：Ubuntu 22.04 / 24.04（Debian 系）
- **Node.js**：>= 18（安装脚本会自动检测并安装 Node.js 20 LTS）
- **内存**：建议 512MB 以上
- **网络**：服务器需能访问 `https://dxwatch.com`（出站 HTTPS 443）；无需 telnet、无需集群账号
- **端口**：对外放行 **5758**（TCP）

## 一键部署（推荐）

安装脚本已处理好环境检测、依赖安装、systemd 服务注册，并与服务器上已有的 Node-RED 实例**四重隔离、互不影响**。

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
4. 在项目目录内本地安装 npm 依赖（默认源失败自动切换国内 npmmirror 镜像）
5. 注册并启动 systemd 服务 `dx-compass`（开机自启）
6. 等待端口就绪并输出访问地址

脚本可重复执行（幂等），日志会明确提示不会触碰已有的 `nodered` 服务与 `~/.node-red` 目录。

### 访问

- **监测大屏**：`http://<服务器IP>:5758/`
- **Node-RED 编辑器**：`http://<服务器IP>:5758/red`

> 云服务器请在安全组 / 防火墙放行 TCP 5758 端口：
> `sudo ufw allow 5758/tcp`

## 与已有 Node-RED 共存说明

本项目不使用全局的 `~/.node-red`，通过独立参数与现有实例隔离：

| 隔离项 | 已有 Node-RED | DX-Compass |
| --- | --- | --- |
| systemd 服务 | `nodered`（不修改） | `dx-compass`（新建） |
| 监听端口 | 1880（不修改） | **5758** |
| userDir | `~/.node-red`（不修改） | 项目目录本身 |
| 依赖 | 原有 node_modules | 项目内独立 `node_modules` |

## 首次使用配置

1. 浏览器打开监测大屏 `http://<服务器IP>:5758/`
2. 点击右上角 **Config**，填入 **Home latitude / longitude**（本台经纬度，用于计算到各报告台的距离），点 **Save**
3. 在每个分屏的呼号输入框中填入要监测的呼号，回车确认：
   - 系统立即开始接收实时 spot（每 30 秒刷新）
   - 同时自动回溯该呼号最近 7 天的历史 spot，地图和 Records 面板很快就会有数据
4. 无需任何集群地址、登录呼号或 Connect 操作——数据源开箱即用

> 数据来自 dxwatch.com 的公开聚合接口，延迟约 30 秒。FT8/FT4 的 SNR 信号报告会显示；普通 CW/SSB spot 本身不携带信号强度，对应列为空属正常。

## 服务管理

```bash
sudo systemctl status dx-compass       # 查看状态
sudo systemctl restart dx-compass      # 重启
sudo systemctl stop dx-compass         # 停止
sudo systemctl disable dx-compass      # 取消开机自启
journalctl -u dx-compass -f            # 实时查看日志
```

数据库文件 `dxcompass.db`、上下文目录 `.context/` 在首次运行后生成于项目目录，均已在 `.gitignore` 中忽略。

## 数据与导出

- 所有匹配的 spot 写入 SQLite `spots` 表，字段含：`spot_id`（数据源唯一 ID，用于去重）、`timestamp`（时间）、`monitored_call`（被监测呼号）、`de`（报告人）、`freq`（频率）、`spot_call`、`mode`（CW/DIGI/PHONE）、`signal`（RST）、`snr`（FT8 dB）、`lat`/`lon`、`distance_km`/`distance_miles`、`comment`
- 大屏右上角 **Records** 面板可按呼号查询并一键 **Export CSV**，用于赛后分析
- REST API：
  - `GET  /api/config` / `POST /api/config`：读取 / 保存配置（本台经纬度）
  - `GET  /api/callsigns` / `POST /api/callsigns`：读取 / 保存监测呼号列表（POST 新呼号会自动触发历史回溯）
  - `GET  /api/spots?call=呼号&limit=数量`：查询记录

## 常见问题

**0. 一键命令下载失败（服务器需代理访问 GitHub）？**

先下载引导脚本，再带代理变量执行（按实际代理端口修改）：

```bash
curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh -o /tmp/dxc-bootstrap.sh
sudo https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 bash /tmp/dxc-bootstrap.sh
```

代理变量会被后续的 git / npm 步骤继承；npm 部分还会自动切换国内镜像重试。

**1. 大屏打开正常但收不到 spot？**

- 数据源是服务器端轮询，先确认服务器能访问数据源：`curl -I https://dxwatch.com/dxsd1/s.php?s=0&r=1`
- 等待最多 30 秒（轮询周期）；可在 Node-RED 编辑器（`/red`）查看 `Fetch dxwatch spots` 节点状态与日志
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

**4. 地图底图加载慢？**

底图来自 OpenStreetMap，服务器或浏览器需能访问外网；地图打点和记录功能不依赖底图加载。

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
