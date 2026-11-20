# 席位改由电台绑定 + 比赛设置瘦身 · 实施计划

## 背景与目标

席位（seat）今天完全由 N1MM 报文自动识别：`lib/qsos/seat-identity.js` 用
`CN/RN/ST` 指纹串解析出 `席位键 = <台>:<RadioNr>`，设置页「比赛」里再用 `seatCount`/`seatRadios`
兜底生成静态席位，操作员还要在设置里手工维护 `operators` 名单。实际使用中：设备表里已经登记了电台，
席位却要先等报文到达才存在；设置项与报文内容重复（比赛名），改一处忘一处。

本次按用户 4 条要求改造（决策已与用户确认）：

1. **席位绑定从「设置-比赛」搬到「设备-电台属性」**：电台属性里下拉选择所属席位。
2. **席位数量由电台生成**：多台电台可绑同一席位；出现未绑定席位的电台自动 +1 个席位；
   没有未绑定电台且存在空席位时自动删除空席位。
3. **删除设置项 `operators`**：操作员名单由 N1MM 上报自动记录，并新增「操作员记录」列表
   （持久化 + 页面展示）。
4. **报文里能取到的比赛设置删除**：本次只删已确证能取到的 `contestName`
   （ContactInfo `<contestname>` / dynamicresults `<contest>`）；
   `contestStart`/`contestEnd`/`category`/`powerClass`/`contestBands`/`contestModes`/`contestSingleBand`
   报文里没有，**保留**。

## 席位模型（核心设计）

席位实体 = 可命名的槽位，持久化在 Node-RED global ctx `seatRegistry.seats`（与 `identities` 同一份
context，`contextStorage: localfilesystem` 已落盘，见 [settings.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/settings.js#L38-L43)）：

```js
// 席位实体：只存稳定的 id 与人工改过的名字，其余全部派生
{id: 's1', name: '1 台', renamed: true, created_ts, updated_ts}
```

电台设备通过 `config.seat_id` 绑定实体（多台可选同一个；空 = 未绑定）。

派生函数 `deriveSeats({devices, entities, liveKeys})`（新增在
[seat-identity.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/seat-identity.js)）：

1. 实体按 id 排序；未被任何电台绑定的实体排在"空槽"里。
2. 遍历 `type==='radio'` 的设备：`config.seat_id` 命中实体 → 该实体收下表内电台；
   未绑定 → 占用一个空槽，无空槽可用时给出**虚拟席位** `v:<device_id>`（跟着电台走，天然稳定，
   电台被绑定或删除后自动消失，即"自动 +1 席位"，且不写回设备表）。
3. 没有未绑定电台时，把"零电台 + 零实时键"的实体从持久列表里删掉（即"自动删除空白席位"）。
4. 实时席位键 → 实体：`ownership.seatForRadio(radio, seats)`（
   [ownership.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/devices/ownership.js)）
   给出电台当前的真实键，键挂到该电台所属实体上；`displayName`（现有改名能力）继续用作展示名，
   实体名优先。

输出结构（`/api/seats` 与设备快照共用）：

```js
{id, name, seat_ids: [...], radio_ids: [...], radios: [{id,name,online}],
 keys: ['BG7TVF-2:1'], virtual: true|false}
```

## 实施步骤

### A. 服务端席位实体（lib/qsos/seat-identity.js）

- `getRegistry` 增加 `seats: []` 与 `next_no`；`ensure()` 时保留旧字段。
- 新增 `deriveSeats(global, {devices, liveViews})`：上面 4 步 + 剪枝，纯函数不落库（除剪枝删除）。
- 新增 `applyAction` 分支：`{action:'seat-rename', seat_id, name}`、`{action:'seat-bind', seat_id, key}`
  （把现有 `bind` 语义挂到实体上，写入 `identities[key].seat_id`）。
- `list(global)` 返回值加 `seats`，并保留 `identities`（改名/绑定 UI 需要）。
- 一次性迁移（项目规则要求）：首版没有实体时，按旧 `seatCount` 生成 `s1..sN` 实体名，
  旧 `seatRadios`（席位号→电台）映射成对应电台的 `config.seat_id` 写入设备表；
  迁移一次后写 `seatRegistry.migrated.seats_v1 = true`。迁移代码放 `lib/qsos/service.js` 的
  `restoreStates` 附近（启动时执行，见 [service.js L172](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L171-L181)）。

### B. 设备层（lib/devices）

- [model.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/devices/model.js#L132-L154)：`radio` 类型 config 允许
  `seat_id`（字符串，空值=未绑定）；`normalizeDevice` 对 radio 校验该值存在于实体列表可选（不存在则清空，避免脏绑定）。
- [service.js snapshot](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/devices/service.js#L455-L473)：
  radio 的 `pub.seat_id` 输出绑定实体、`pub.seat` 继续输出实时键；新增快照字段 `seats`（`deriveSeats` 结果），
  供设备页席位面板与电台下拉直接使用。
- [ownership.js project](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/devices/ownership.js#L167-L210)：
  `seats` 数组每项补 `seat_id`/`name`（由传入的实体映射得到），让三色系与展示名统一；
  未识别桶（`LOCAL:1`）仍保留在最后。

### C. 比赛设置瘦身（public/shared/settings/schema.js 及消费方）

- 删除 4 个字段：`contestName`、`operators`、`seatCount`、`seatRadios`
  （[schema.js L344-L541、L542-L599](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/settings/schema.js#L344-L599)），
  同步 `defaults` 与 `normalizeSettings` 的对应校验块（`raw.seatRadios` 段）。
- 新增 `qso.resolveContest(global)`：优先 `radioStates`/最近 QSO 事件里记下的 `lastContest`
  （在 [qsos/ingest.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/ingest.js#L48-L59) 的 qso 分支与
  `saveScore` 里 `global.set('lastContest', {contest, ts})`），
  其次 `score_state.contest`（启动 [stateQuery](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/n1mm-sql.js#L82-L88) 已带回），
  `/api/station/state` payload 增加 `contest`。
- 消费方逐个改用 `state.contest`（拿不到时传空串，规则引擎已有"规则库未收录则跳过"的分支）：
  [advice/engine.js L277](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/advice/engine.js#L277)、
  `engine.js` 电台分配建议（`seatCount`/`seatRadios` → `seats`）、
  [analysis/multipliers.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/analysis/multipliers.js)、
  [analysis/band-opening-tracker.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/analysis/band-opening-tracker.js)、
  [alerts/engine.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/alerts/engine.js)。
- flow.json 中读取这四个 key 的 function 节点（`Select-String -Path flow.json -Pattern 'seatCount|seatRadios|\.operators|contestName'`）
  一并改；改完必须跑 `node --test tests/architecture.test.js`（它断言 flow 接线）。

### D. 操作员自动记录 + 记录页列表

- [n1mm-sql.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/storage/n1mm-sql.js#L38-L45)：
  `operator_sessions` 加列 `source TEXT`（`radioinfo`/`contactinfo`），走 `addMissingColumns` 幂等迁移；
  新增 `sessionQuery()`：按 seat 分组取全部上岗行（`seat, operator, start_ts, source`，倒序限量）。
- [service.js saveRadio](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/lib/qsos/service.js#L101-L134)：
  保持"仅 OpCall 变化才记一行"；`ingest.js` 的 qso 分支新增：`qso.operator` 与该席位当前操作员不一致时
  也记一行（source=`contactinfo`），避免每条 QSO 灌表。
- 新增 `GET /api/operators`（flow.json，紧跟 `dxseat000000001` 那组节点）：返回
  `{ok, sessions: [...], current: {seat: operator}}`，`end_ts` 由同席位下一条记录的开始时间推出。
- [records-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/records-page.mjs)：加「操作员记录」区块
  （列：上岗时间 / 席位名 / 操作员 / 收工时间 / 来源），复用页面已有的表格与筛选样式；
  [public/shared/data](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/shared/data) 里按 `station.mjs` 的写法加 `fetchOperators()`。

### E. 前端设置页 / 设备页 / OP 页

- [settings-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/settings-page.mjs)：
  删 `seatCount`/`seatRadios`/`operators`/`contestName` 的 WALL_CHECKS 条目；
  「席位识别」区（`#seatIdentitiesSection`，L1653 起）整体搬到设备页席位面板（改名/绑定按钮语义不变，
  请求仍走 `/api/seats`）；设置页比赛 tab 顶部加一行提示：比赛名由 N1MM 报文自动取得，
  当前值展示 `state.contest`。
- [devices-page.mjs](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/devices-page.mjs)：
  电台表单（`configFields` 调用处 L1461-1463）加「所属席位」下拉（选项来自快照 `seats`，含"自动/未绑定"）；
  `collectForm` L2165 收集 `config.seat_id`；`seatsHtml()` L1724-1789 改成渲染 `deriveSeats` 结果
  （席位名可改、显示绑定电台与实时键），提示文案 `dev.devices.radioSeatHint` 相应改写。
- [op-page.mjs seatChoices()](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/pages/op-page.mjs#L145-L173)：
  数据源换成设备快照 `seats`（席位名 + 绑定电台）与 `snap.ownership.seats`，不再读 `settings.seatCount/seatRadios/operators`。
- [i18n.js](file:///d:/岑溪基地/Node-Red-Contesting-Dashboard/public/js/i18n.js)：删对应键（zh 4821-4911、en 6793-6884 区段），
  新增席位/操作员记录相关键，中英文对称。

## 验收

- `node --test tests/seat-identity.test.js tests/m2-seat.test.js tests/n1mm-ingest.test.js tests/devices.test.js`
  → 再 `npm test` 全绿（当前基线 610 pass）。
- 新增/改写用例：
  - 未绑定电台 → 席位列表自动 +1；绑定后不重复增加；删掉电台 → 席位自动消失；
  - 两台电台绑同一席位 → 一个席位两条实时键；
  - 无未绑定电台且席位零电台零活动 → 实体被自动删除；
  - `contestName` 删除后 `/api/station/state.contest` 来自报文，界面标题正确；
  - `/api/operators` 记录 RadioInfo 换人 + ContactInfo 新操作员，且不会每条 QSO 灌一行。
- 浏览器验收（`browser_use`）：设备页电台属性绑定席位并保存 → OP 页席位下拉与设备页席位面板一致；
  设置页比赛 tab 不再出现四个已删项；记录页操作员记录有数据。
- 部署：中文提交 → `git push origin main` → 服务器 `git pull --ff-only` → `systemctl restart dx-compass` →
  线上核对 `/api/seats`、`/api/station/state`、`/api/operators`。

## 风险与对策

- **flow.json 改动面大**：先 `Select-String` 定位全部四个键的引用，改完用
  `tests/architecture.test.js` + `node -e "JSON.parse(...)"` 校验 JSON 合法，避免整个 flows 起不来。
- **席位 id 稳定性**：实体 id 永不复用（`next_no` 单调递增），虚拟席位 id 绑电台 device_id，
  避免改名/删台后实时键挂错席位。
- **规则引擎失去 contest 名**：`contest` 为空时相关规则本就有"未收录比赛跳过"的分支，
  不会误判；开台后首条 QSO/分数报文即补上。
