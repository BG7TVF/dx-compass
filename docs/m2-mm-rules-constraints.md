# M2 / MM 规则硬约束核对（原文 + 适用比赛）

> 核对日期：2026-11-11。只收录本次实际抓取到的官方页面/PDF 原文；未抓到的条款明确标注“未核实”，不做转述式补全。
>
> 标记约定：
> - **[规则]** 官方规则原文直接支持；
> - **[解释]** 对原文的计数口径说明，不新增义务；
> - **[实践]** 社区/队伍做法，不是规则要求；
> - **[未核实]** 本次没有拿到原文，不能当作结论使用。

---

## 0. 来源与版本

| 编号 | 来源 | 版本/日期 | 用途 | 链接 |
|---|---|---|---|---|
| S1 | CQ WW DX Contest Rules | 2026 版（SSB 10/24–25，CW 11/28–29） | CQ WW 的 M2 / MM / MS | https://cqww.com/rules/ |
| S2 | CQ WW Rules FAQ | 抓取于 2026-11-11 | CQ WW 的 MS 10 分钟规则解释 | https://cqww.com/rules_faq.htm |
| S3 | CQ WPX Contest Rules | 2026 版（CW 5/30–31） | WPX 的 MULTI-TWO / MULTI-UNLIMITED / MULTI-ONE | https://cqwpx.com/rules/ |
| S4 | CQ WPX Rules FAQ | 抓取于 2026-11-11 | WPX 换波段计数示例 | https://cqwpx.com/rules_faq.htm |
| S5 | ARRL International DX Contest Rules | Version 2.0，2024-01-04；Rules for Entry Version 1.3，2023-11-29 | ARRL DX 的 M2 / MS / MM | https://contests.arrl.org/ContestRules/DX-Rules.pdf |

> 注意：CQ WW / WPX 页面会按年份换版。本文引用的是 2026 版；如果比赛规则页更新，必须重新核对，不能把本文当永久结论。

---

## 1. CQ WW：M2 条款

**适用比赛：CQ WW DX Contest（SSB/CW，2026 版）的 Multi-Two。下列结论不要直接套到 WPX 或 ARRL DX。**

### 1.1 原文（S1，V.C.2）

> "Multi-Two: A maximum of two transmitted signals may be used at any time, and they must be on two different bands. The log must indicate which station/signal made each QSO. Logged QSOs are to be used to count band changes. Each station/signal may make a maximum of 8 band changes in any clock hour (00 through 59 minutes). Total output power must not exceed 1500 watts on any band at any time."

### 1.2 逐项结论

| 问题 | 结论 | 依据 |
|---|---|---|
| 同一时刻最多几个信号 | **2 个**，且必须在**两个不同波段** | S1 V.C.2 原文 |
| 每台每小时 band change 次数 | **每个 station/signal 每小时最多 8 次**，按整点小时 00–59 分计 | S1 V.C.2 原文 |
| band change 怎么计 | **以已记录的 QSO 为准**（"Logged QSOs are to be used to count band changes"） | S1 V.C.2 原文 |
| 10 分钟规则是否适用 | **不适用**。M2 条款没有 10 分钟规则；10 分钟规则只出现在 MS 条款 | 对比 S1 V.C.1 与 V.C.2 |
| 乘数台额外限制 | **M2 条款没有“乘数台”这个规则身份**，因此没有“乘数台不得 CQ / 只能通新乘数”的限制 | S1 V.C.2 原文未出现 multiplier station |
| 日志标注 | 每条 QSO 必须能看出是哪个 station/signal 做的 | S1 V.C.2 原文 |
| 功率 | 任意波段、任意时刻总输出不超过 1500 W | S1 V.C.2 原文 |

### 1.3 band change 的精确定义（把原文和解释分开）

**规则原文只有一句计数依据：**

> "Logged QSOs are to be used to count band changes."（S1 V.C.2）

**可操作的判定 [解释]：**

1. 只看这个 station/signal **自己已记录的 QSO 序列**，不看另一台、不看 VFO 转动、不看接收。
2. 相邻两条已记录 QSO 的波段不同，计 **1 次** band change。
3. 计数时点落在**新波段第一条 QSO 被记录的那个整点小时**（00–59 分）；跨整点时，前一条在 59 分、后一条在 00 分，算新小时的第 1 次。
4. 20m → 40m → 20m 是 **2 次**，不是 1 次；这一点 WPX 规则给了明确例子（S3 VI.C.1："a change from 20 meters to 40 meters and then back to 20 meters counts as two band changes"），CQ WW 的“按 logged QSO 计”得到同样结果。
5. **不能**把“发射机切换”“天线切换”“VFO 变化”当成 band change；CQ WW 只认已记录 QSO。

> 边界说明 [解释]：CQ WW 2026 规则没有给 band change 下更细的定义，只给了计数依据。上面 1–5 是从该依据 + WPX 的明确示例推出的操作口径；如果赛事委员会另有 FAQ 解释，以委员会解释为准。

### 1.4 10 分钟规则：只属于 MS，不属于 M2

CQ WW MS 原文（S1 V.C.1）：

> "Only one transmitted signal on one band permitted during any 10-minute period (run station/signal). Exception: One — and only one — other transmitted signal (multiplier station/signal) may be used during any 10-minute period, if — and only if — it is on a different band from the run transmitter and the station worked is a new multiplier. The run and multiplier transmitters are governed by independent 10-minute rules. Ten-minute periods begin with the first QSO on a band. The log must indicate which station/signal (run or multiplier) made each QSO. The multiplier station/signal may not call CQ (solicit contacts)."

由此得到：

- **[规则]** 10 分钟规则是 **CQ WW MS 专属**：run 信号在一个波段至少待 10 分钟；乘数台信号受**独立的** 10 分钟规则约束。
- **[规则]** 10 分钟从该波段**第一个 QSO** 起算。
- **[规则]** M2 没有这条规则；M2 只有“两台不同波段 + 每台每小时 8 次”的约束。
- **[规则]** “乘数台不得 CQ”只出现在 CQ WW MS；M2 条款没有这句话。

### 1.5 M2 的“乘数台”到底存不存在

- **[规则]** 不存在规则意义上的乘数台。M2 的两个 station/signal 都可以是 run，也都可以去通乘数；规则只要求两台在不同波段、各自记账。
- **[实践]** 队伍通常仍会把其中一台叫“乘数台/猎台”，让它多做 S&P、少 CQ；这是**战术分工**，不是规则身份。它可以 CQ，也可以通非乘数台，只要不违反两台不同波段和 8 次/小时。
- **[实践]** 反过来，如果队伍把“乘数台不得 CQ”当成 M2 规则，会错误地限制自己；这条只在 CQ WW MS 成立。

### 1.6 适用于 M2 的通用条款（容易漏）

| 条款 | 原文 | 对 M2 的影响 |
|---|---|---|
| 同一波段只能一个信号 | "Only one signal on a band is allowed at any time. When two or more transmitters are present on the same band, a hardware device MUST be used to prevent more than one signal at any one time. Alternating CQs on two or more frequencies on a band is not permitted."（S1 IX.7） | 两台不能同波段；同波段多机必须有硬件互锁；禁止同一波段两个频率轮流 CQ |
| 一个呼号一个 entry | "A different call sign must be used for each entry. Only the entrant's call sign may be used to aid the entrant's score."（S1 IX.2） | 两个 station/signal 共用同一个参赛呼号，不能各用各的呼号 |
| 全波段 | "Multi-Operator Categories (all-band operation only)"（S1 V.C） | M2 不能报单波段 |
| 台址 | 所有发射机、接收机、功放必须在直径 500 m 内（S1 VIII.1） | 远程收发机不能在台址外 |

---

## 2. CQ WW：MM 条款

**适用比赛：CQ WW DX Contest（SSB/CW，2026 版）的 Multi-Multi。**

### 2.1 原文（S1，V.C.3）

> "Multi-Multi: The six contest bands may be activated simultaneously. Only one transmitted signal per band is permitted at any time. Total output power must not exceed 1500 watts on any band at any time."

### 2.2 逐项结论

| 问题 | 结论 | 依据 |
|---|---|---|
| 每波段同时几个信号 | **每个波段 1 个**；六个比赛波段可同时工作 | S1 V.C.3 原文 |
| 是否共用同一呼号 | **是**。MM 是一个 entry，所有发射机使用同一个参赛呼号 | S1 IX.2；V.C 的 multi-operator 定义 |
| 有无 band change 限制 | **没有**。MM 条款没有次数/时间锁；只有“每波段一个信号” | S1 V.C.3 原文 |
| 10 分钟规则 | **不适用** | 只出现在 V.C.1 MS |
| 乘数台限制 | **没有**乘数台规则身份 | V.C.3 原文未出现 |
| 功率 | 任意波段、任意时刻不超过 1500 W | S1 V.C.3 原文 |

> **[解释]** “共用同一呼号”是从“一个 entry 一个呼号”推出的：规则原文写的是 "A different call sign must be used for each entry. Only the entrant's call sign may be used to aid the entrant's score."（S1 IX.2），并没有逐字写“所有发射机必须使用同一呼号”。MM 是一个 entry，因此不能每个波段各用呼号；但引用时不要把这句话当成规则原文。
>
> **[解释]** MM 的“无 band change 限制”不等于“可以同波段多信号”。同波段仍然只能一个信号，且通用条款要求硬件互锁（S1 IX.7）。

---

## 3. CQ WPX：MULTI-TWO / MULTI-UNLIMITED / MULTI-ONE

**适用比赛：CQ WPX Contest（SSB/CW，2026 版）。WPX 的 MM 对应组叫 MULTI-UNLIMITED，不是 MULTI-MULTI。**

### 3.1 MULTI-TWO（M2）原文（S3，VI.C.2）

> "A maximum of two transmitted signals is permitted at any time on two different bands. Both transmitters may work any station. A station may only be worked once per band regardless of which transmitter is used. The log must indicate which transmitter made each QSO (column 81 of CABRILLO QSO template for CQ contests). Each transmitter may make a maximum of eight (8) band changes in any clock hour (00 through 59 minutes). Use a separate serial number sequence for each band. Total output power of each transmitted signal must not exceed 1500 watts."

### 3.2 MULTI-UNLIMITED（WPX 的 MM 对应组）原文（S3，VI.C.3）

> "A maximum of six transmitted signals, one per band, at any one time. Six bands may be activated simultaneously. Use a separate serial number sequence for each band. Total output power of each transmitted signal must not exceed 1500 watts."

### 3.3 MULTI-ONE（WPX 的 MS）原文（S3，VI.C.1）

> "Only one transmitted signal is permitted at any time. A maximum of ten (10) band changes may be made in any clock hour (00 through 59 minutes). For example, a change from 20 meters to 40 meters and then back to 20 meters counts as two band changes. Use a single serial number sequence for the entire log."

### 3.4 band change 计数（WPX FAQ，S4）

> "The band change occurs at the time the first QSO on the new band is logged. This counts as 3 band changes in the 13z hour."

示例原文：

```
1259 15m
1300 20m <- band change from 15m to 20m
1310 15m <- band change from 20m to 15m
1359 40m <- band change from 15m to 40m
1400 10m
```

**[规则]** 13z 小时内计 3 次：1300（15→20）、1310（20→15）、1359（15→40）；1400 属于 14z，不在 13z 计数。

### 3.5 WPX 的关键差异

- **[规则]** M2 **两台都可以通任何台**（"Both transmitters may work any station"），同一台站每波段只能通一次。
- **[规则]** M2 **每波段独立序号**，不是全日志一个序号。
- **[规则]** M2 日志必须标“哪个发射机”做了这条 QSO（Cabrillo 第 81 列）。
- **[规则]** WPX 的 MULTI-ONE **只有一个信号**，没有 CQ WW MS 那种“另一个乘数台信号”例外；它用“每小时 10 次”而不是 10 分钟锁。
- **[规则]** WPX MULTI-UNLIMITED 最多 **6 个信号，每波段 1 个**，无 band change 限制。

---

## 4. ARRL DX：M2 / MS / MM

**适用比赛：ARRL International DX Contest（CW/Phone，Rules v2.0）。ARRL 的 M2 配额是 6 次/小时/发射机，不是 CQ WW/WPX 的 8 次。**

### 4.1 原文（S5）

Special Rules 6.1：

> "Multioperator, Single Transmitter stations are limited to ten (10) band changes per clock hour; Multioperator, Two Transmitter stations are limited to six (6) band changes per clock hour per transmitter. Violation of this rule will result in the entry being reclassified in the Multioperator, Multitransmitter category."

HCAT.4.2（MS）：

> "HCAT.4.2.1. Only one transmitted signal is allowed at any time."
> "HCAT.4.2.2. Stations are limited to a maximum of ten (10) band changes during any clock hour. Violation of this rule will result in the entry category being changed to Multioperator, Multitransmitter."

HCAT.4.3（M2）：

> "HCAT.4.3.1. Only two transmitted signals are allowed at any time and must be on different bands."
> "HCAT.4.3.2. Each transmitter is limited to a maximum of six (6) band changes in any clock hour. Unused band changes may not be transferred between transmitters. Violation of this rule will result in the entry category being changed to Multioperator, Multitransmitter."
> "HCAT.4.3.3. Both transmitters may contact any station. A station may only be contacted once per band regardless of which transmitter is used."
> "HCAT.4.3.4. The submitted log must indicate which transmitter made each contact."

HCAT.4.4（MM）：

> "HCAT.4.4.1. One transmitted signal is allowed per band at any time."

类别表脚注：

> "Multiple signals are not allowed on the same band, regardless of category or mode."

### 4.2 逐项结论

| 问题 | 结论 | 依据 |
|---|---|---|
| ARRL M2 信号数 | 2 个，必须不同波段 | HCAT.4.3.1 |
| ARRL M2 band change | **每台每小时 6 次**；未用配额**不能转让** | HCAT.4.3.2 / 6.1 |
| ARRL M2 两台能否通任何台 | 能；每台站每波段只能通一次 | HCAT.4.3.3 |
| ARRL M2 日志 | 必须标哪个发射机 | HCAT.4.3.4 |
| ARRL M2 超限后果 | **降组为 Multioperator, Multitransmitter** | HCAT.4.3.2 / 6.1 |
| ARRL MS 信号数 | 1 个；**没有第二个乘数台信号例外** | HCAT.4.2.1 |
| ARRL MS band change | 每小时 10 次；超限降组 MM | HCAT.4.2.2 / 6.1 |
| ARRL MM | 每波段 1 个信号；**无 band change 限制** | HCAT.4.4.1 |
| ARRL MM 呼号 | 一个 entry 一个呼号；呼号必须体现 DXCC 实体 | Rules 6.2 |

---

## 5. 三家对照：哪些结论只适用于特定比赛

### 5.1 对照表

| 项目 | CQ WW | CQ WPX | ARRL DX |
|---|---|---|---|
| M2 最大信号数 | 2，不同波段 | 2，不同波段 | 2，不同波段 |
| M2 band change 上限 | **8/小时/station-signal** | **8/小时/transmitter** | **6/小时/transmitter** |
| M2 配额能否互借 | 规则未说可借；按“每台”独立理解 | 按“每 transmitter”独立 | **明文不可转让** |
| M2 两台是否都能通任何台 | 未禁止；两台都可有 run/mult 行为 | **明文可以** | **明文可以** |
| M2 日志标注发射机 | 要求 | 要求（Cabrillo 第 81 列） | 要求 |
| M2 每波段独立序号 | 无此概念（交换是 CQ Zone） | **要求** | 无此概念（交换是州/省或功率） |
| M2 是否有“乘数台”规则身份 | 无 | 无 | 无 |
| MS 最大信号数 | **2**（run + multiplier） | **1** | **1** |
| MS 换波段约束 | **10 分钟锁**（run/mult 各自独立） | **10 次/小时** | **10 次/小时** |
| MS 乘数台可否 CQ | **不可以**（仅 CQ WW） | 无乘数台例外 | 无乘数台例外 |
| 超限后果 | 委员会裁量（规则未写降组） | WPX FAQ：违规发射机在恢复合规前的所有 QSO 删除 | **降组 MM** |
| MM 信号数 | 6 波段各 1 | 最多 6，每波段 1 | 6 波段各 1 |
| MM band change 限制 | **无** | **无** | **无** |
| MM 呼号 | 一个 entry 一个呼号 | 一个 entry 一个呼号 | 一个 entry 一个呼号 |

### 5.2 只能适用于特定比赛的结论（务必不要泛化）

1. **[规则] “10 分钟规则”只适用于 CQ WW MS。**
   - 不适用于 CQ WW M2（M2 是 8 次/小时）。
   - 不适用于 WPX MULTI-ONE / ARRL DX MS（这两家是 10 次/小时）。
2. **[规则] “乘数台不得 CQ、只能通新乘数、必须与 run 不同波段”只适用于 CQ WW MS。**
   - 不适用于 M2；不适用于 WPX / ARRL 的 MS（它们没有第二个乘数台信号）。
3. **[规则] “M2 每小时 8 次”只适用于 CQ WW M2 与 WPX MULTI-TWO。**
   - ARRL DX M2 是 **6 次**。
4. **[规则] “未用配额不可转让”是 ARRL DX 明文。**
   - CQ WW / WPX 只写“每台/每 transmitter 最多 N 次”，没有“可转让”表述；按独立配额理解，但不要引用 ARRL 的“不可转让”原文去解释另外两家。
5. **[规则] “每波段独立序号”只适用于 WPX MULTI-TWO / MULTI-UNLIMITED / MULTI-DISTRIBUTED。**
   - CQ WW M2 交换是 CQ Zone，不存在序号；ARRL DX 交换是州/省或功率，也不存在序号。
6. **[规则] “超限降组 MM”是 ARRL DX 明文。**
   - CQ WW 规则写的是委员会可裁量；WPX FAQ 写的是删除违规发射机的 QSO，不是降组。
7. **[规则] “band change 以 logged QSO 计”在 CQ WW 是明文；WPX 由 FAQ 示例明确；ARRL DX 规则正文只给“每小时 N 次”，没有给 band change 定义。**
   - 因此，把“按 logged QSO 计数”说成三家通用规则是不严谨的；对 ARRL DX 只能作为操作口径 [解释]，并注明规则正文未定义。
8. **[规则] MM 三家都没有 band change 限制，但“每波段一个信号”三家都成立。**
   - 不要把“MM 无限制”理解成“可以同波段多信号”。

---

## 6. 未核实项（不得当作结论）

| 项目 | 状态 | 说明 |
|---|---|---|
| CQ WW 对 M2 band change 的 FAQ 级细化解释 | **[未核实]** | 本次抓到 CQ WW FAQ，但未取到 M2 专门段落；只使用规则原文“Logged QSOs are to be used to count band changes”。 |
| ARRL DX 对 band change 的正式定义 | **[未核实]** | ARRL DX Rules v2.0 正文未给定义；未抓取 ARRL 通用 HF 规则中的定义。 |
| IARU HF、WAE、CQ 160 的 M2/MM 条款 | **[未核实]** | 本次未核对；不要把本文 CQ WW 结论套到这些比赛。 |
| 各赛事对“remote operation / multi-distributed”的额外限制 | **[未核实]** | 本文只覆盖 CQ WW / WPX / ARRL DX 的 M2、MM、MS 核心条款。 |

---

## 7. 一句话结论

- **M2 的硬约束是“两台、两波段、每台每小时 8 次（ARRL 为 6 次）、按已记录 QSO 计 band change”；M2 没有 10 分钟规则，也没有规则意义上的乘数台。**
- **MM 的硬约束是“每波段一个信号、六波段可同时、共用一个参赛呼号、无 band change 限制”。**
- **10 分钟规则、乘数台禁 CQ、每波段独立序号、超限降组，分别只属于 CQ WW MS、CQ WW MS、WPX M2/MM、ARRL DX，不能跨比赛混用。**
