# DX-Compass

基于 Node-RED 的多呼号 DX Spot 实时监测大屏。连接 DX Cluster（DXSpider），同时监测最多 **9 个呼号**收到的 spot，在地图上实时打点显示，支持硬盘录像机（DVR）风格的多分屏切换，并将所有 spot 记录到数据库用于赛后分析。

## 功能特性

- **多分屏布局**：`1×1` / `1×2` / `2×2` / `3×3` 自由切换，一个呼号对应一张地图，最多同时监测 9 个呼号
- **实时打点**：通过 Telnet 接收 DX Cluster 的 spot，解析报告人（DE）位置后在地图上标点
- **标点存活 1 小时**：每个标记 1 小时后自动消失，颜色按信号强度区分（绿 / 黄 / 红）
- **完整记录**：每条 spot 记录时间、频率、报告人、模式（CW/DIGI）、信号强度、SNR、距离等，存入 SQLite
- **赛后分析**：记录面板支持按呼号筛选、一键导出 CSV
- **距离计算**：基于 HamDB 呼号坐标 + Haversine 公式，计算报告人相对本台的距离（公里/英里）
- **独立共存**：可与服务器上已有的 Node-RED / Node-Red-Contesting-Dashboard 实例完全独立运行

## 技术架构

```
DX Cluster (telnet) ──► Node-RED 流程 ──► 解析/过滤
                                   ├──► HamDB 地理定位 + 距离计算
                                   ├──► SQLite 持久化记录
                                   └──► WebSocket 实时推送 ──► 前端多地图大屏
```

- **后端**：Node-RED（Telnet 接入、HTTP REST API、WebSocket、SQLite）
- **前端**：原生 HTML/CSS/JS + Leaflet + OpenStreetMap，由 Node-RED 静态托管
- **数据库**：SQLite（`dxcompass.db`，运行时自动创建）

## 目录结构

```
dx-compass/
├── flow.json          # Node-RED 主流程（DX Cluster 接入、解析、定位、记录、API）
├── settings.js        # Node-RED 配置（端口 5758、静态目录、上下文持久化）
├── package.json       # 依赖（node-red、node-red-node-sqlite）
├── flow_cred.json     # 凭据文件（为空）
├── install.sh         # Ubuntu 一键安装脚本
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
- **网络**：服务器需能访问 DX Cluster（默认 `dxc.ve7cc.net:23`）和 `api.hamdb.org`
- **端口**：对外放行 **5758**（TCP）

## 一键部署（推荐）

安装脚本已处理好环境检测、依赖安装、systemd 服务注册，并与服务器上已有的 Node-RED 实例**四重隔离、互不影响**。

### 1. 上传代码

将整个项目目录上传到服务器，例如 `/opt/dx-compass`：

```bash
sudo mkdir -p /opt/dx-compass
# 方式一：用 scp 上传（在本地执行）
scp -r ./* user@<服务器IP>:/opt/dx-compass/

# 方式二：直接在服务器上克隆
cd /opt
sudo git clone https://github.com/BG7TVF/dx-compass.git
cd dx-compass
```

### 2. 执行一键安装

```bash
cd /opt/dx-compass
sudo bash install.sh
```

脚本会自动完成：

1. 校验系统与必要文件，检查 **5758** 端口是否被占用
2. 安装系统编译工具（SQLite 原生模块需要 `build-essential`）
3. 检测 / 安装 Node.js（已有 ≥18 直接使用，否则通过 NodeSource 安装 20 LTS）
4. 在项目目录内本地安装 npm 依赖（默认源失败自动切换国内 npmmirror 镜像）
5. 注册并启动 systemd 服务 `dx-compass`（开机自启）
6. 等待端口就绪并输出访问地址

脚本可重复执行（幂等），日志会明确提示不会触碰已有的 `nodered` 服务与 `~/.node-red` 目录。

### 3. 访问

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
2. 点击右上角 **Config**：
   - **Your callsign (login)**：登录 DX Cluster 用的你的呼号
   - **DX cluster server / port**：集群地址，默认 `dxc.ve7cc.net` / `23`
   - **Home latitude / longitude**：本台经纬度（用于计算距离）
3. 保存后点击 **Connect** 连接集群
4. 在每个分屏的呼号输入框中填入要监测的呼号，即开始在对应地图上打点

常用备用集群：`w3lpl.net:7373`、`dxc.nc7j.com:23`。

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

- 所有匹配的 spot 写入 SQLite `spots` 表，字段含：`timestamp`（时间）、`monitored_call`（被监测呼号）、`de`（报告人）、`freq`（频率）、`spot_call`、`mode`（CW/DIGI/PHONE）、`signal`（信号报告）、`snr`（dB）、`lat`/`lon`、`distance_km`/`distance_miles`、`comment`
- 大屏右上角 **Records** 面板可按呼号查询并一键 **Export CSV**，用于赛后分析
- REST API：
  - `GET  /api/config` / `POST /api/config`：读取 / 保存配置
  - `GET  /api/callsigns` / `POST /api/callsigns`：读取 / 保存监测呼号列表
  - `GET  /api/spots?call=呼号&limit=数量`：查询记录
  - `POST /api/connect`：触发重新连接集群

## 常见问题

**1. 大屏打开正常但收不到 spot？**

- 在 Node-RED 编辑器（`/red`）查看 `DX Cluster` 节点状态，确认 telnet 已连接
- 确认 Config 中登录呼号已填写、集群地址端口正确，点击 **Connect**
- 确认服务器能访问集群端口（`telnet dxc.ve7cc.net 23`）
- 被监测呼号必须有真实 spot 上报后才会打点

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
