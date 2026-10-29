# 通用电脑操控 Agent 开发文档

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.5（补齐 P1 工具面 move/scroll/drag/wait/close、错误码全集、回归网与验收清单；融合 dsh-orb / dsh-computer-use / dsh-doyourweb 调研与 P0/P1 真机实测修订） |
| 编写日期 | 2026-10-25（v0.4 修订 2026-10-26；v0.5 修订 2026-10-26） |
| 项目定位 | DSH 宿主内的**自主电脑操控运行时**——自主操作电脑上的**所有软件**（桌面应用、浏览器、自绘界面），抖音只是其中一个领域包 |
| 速度红线 | 结构化感知主路径必须秒级（UIA ≤2s、DOM ≤1s）；视觉仅兜底（≤15s，且仅在结构化失败/无名目标时启用），任何主路径动作不得以视觉为前置 |
| 现有载体 | dsh-douyin-agent 1.4.4（工具目录 v14） |
| 目标版本 | 模块化落地 1.5.x → 独立包 2.0 |
| 运行环境 | Windows 11、Node ≥ 22.13、DSH 0.2.0-rc.2 |
| 上游组件 | Windows-MCP 0.7.1（UIA + 键鼠，MIT）、Playwright（沿用） |

---

## 1. 定位变更

### 1.1 v0.1 的问题

v0.1 把桌面操控写成"抖音插件的可选扩展"，导致三个错位：

- **能力面太窄**：只暴露 6 个工具，无法支撑跨应用任务。
- **架构错位**：把"电脑"当作抖音功能的补丁，而不是底座。
- **自主性缺失**：只有单步动作，没有任务状态、断点、预算和恢复。

### 1.2 v0.2 的定位

> 本项目要做的是：**一个能在 Windows 上自主操作所有软件的 Agent 运行时**——
> 任意桌面应用、浏览器、自绘界面（游戏/播放器/图标面板）都是它的操作对象；
> 抖音、浏览器、Office、资源管理器只是它可调用的"领域包/适配器"。
> **速度是硬约束**：主路径（结构化感知）必须秒级；视觉只做兜底，不得成为主流程的前置。

具体表现为：

- 感知覆盖**整个桌面**：任意窗口、任意应用、任意控件，不限于抖音 DOM。
- 动作覆盖**通用输入**：点击、输入、快捷键、滚动、拖拽、窗口与应用生命周期。
- 任务覆盖**多步长流程**：规划、执行、校验、失败重规划、断点恢复、预算与停止条件。
- 抖音从"主体"降级为 `douyin` 领域包，现有 `douyin_*` 工具保持兼容。

### 1.3 目标

1. 在 Windows 11 上自主操控**所有软件**（桌面应用、浏览器、自绘界面），完成跨应用多步任务；结构化感知主路径保持秒级，视觉兜底不得拖慢主流程。
2. 具备任务级自治：可手动触发、定时触发、事件触发，可暂停/恢复/中止。
3. 感知与动作分层可替换：UIA → DOM → OCR → 视觉，逐级降级。
4. 抖音等既有能力作为领域包接入，不破坏现有工具与测试。
5. 安全可审计：分级权限、确认、预算、收据、全局急停。

### 1.4 非目标

- 不做无人值守的**高风险**操作（支付、删除、权限变更、系统设置）。
- 不做跨平台（Linux/macOS）。
- 不训练自有 GUI 模型；视觉模型只作为感知兜底。
- 不替代宿主的文件读写工具；本模块只处理 GUI 文件对话框。

### 1.5 外部项目对照与采纳（2026-10-26 调研）

| 项目 | 强项 | 本项目采纳 |
| --- | --- | --- |
| `dsh-orb` | 悬浮球宿主 + Computer Use 预设打包；多轨道 agent 各配模型 | 入口形态参考（可选悬浮球入口）；预设打包思路用于 P4 独立包发布 |
| `dsh-computer-use` | 纯视觉闭环：截图 → 识图定位 → 点击/输入 → 再截图核实；独立虚拟光标 | **P3 视觉兜底按此闭环实施**（截图→认图标→坐标点击→再截图确认），仅在结构化失败/无名目标时触发 |
| `dsh-doyourweb` | 插件 + 浏览器扩展通道，复用用户**已登录**的 Chrome/Edge 标签页，DOM 级控制 | `browser` 领域包（P1.7）参考其标签页复用通道；登录态不搬家 |

三者均为互补生态：它们证明"视觉全能但慢、浏览器内 DOM 最准、预设/入口可外置"——本项目的差异化是**结构化主路径（秒级）+ 按需视觉兜底**的混合架构，以及任务级自治与安全护栏。

### 1.6 速度契约（硬约束，P0/P1 真机实测为基线）

| 感知/动作 | SLA | 实测基线（2026-10-26） |
| --- | --- | --- |
| UIA 观察（`computer_observe`） | ≤ 2s（重载 ≤45s 上限） | 892ms ~ 1.1s（百级元素） |
| DOM 观察（browser 包） | ≤ 1s | —— |
| OCR / 视觉兜底 | ≤ 15s，且仅兜底时调用 | 未启用 |
| 单步动作（click/type/key） | ≤ 3s | 点击回执 ~1-2s |
| 窗口发现 | 三源兜底 ≤ 8s | 列表漏行时走进程表 + switch 激活 |

速度规则：①主路径禁止把视觉/OCR 放在动作前置；②只读观察允许一次自愈重试，写动作失败不重试；③动作后置校验用"尽力观察"（不计熔断预算、失败只影响 verified）；④驱动会话常驻复用（空闲 10 分钟回收），禁止每步重启子进程；⑤观察到目标即返回（到货即返），不做固定长等待。

---

## 2. 能力全景

```text
┌─────────────────────────────────────────────────────────────┐
│ L4 自治层   触发（手动/定时/事件）· 任务队列 · 预算 · 停止条件 │
├─────────────────────────────────────────────────────────────┤
│ L3 任务层   规划 · 步骤状态机 · 校验 · 重规划 · 断点恢复       │
├─────────────────────────────────────────────────────────────┤
│ L2 领域层   douyin · browser · office · explorer · 自定义      │
├─────────────────────────────────────────────────────────────┤
│ L1 动作层   click · type · key · scroll · drag · app · shell   │
├─────────────────────────────────────────────────────────────┤
│ L0 感知层   UIA 控件树 · 截图 · 窗口枚举 · DOM · OCR · 视觉    │
└─────────────────────────────────────────────────────────────┘
              ▲ 全部受 policy / audit / kill switch 约束
```

设计原则：**上层可以调用下层，下层永远不知道上层存在**。领域包不得直接操作键鼠，必须走 L1 动作层，这样权限与审计只有一个入口。

---

## 3. 总体架构

### 3.1 组件图

```text
┌──────────────────────────── DSH 宿主 ─────────────────────────────┐
│                                                                  │
│  模型 ──tool_call──▶ dsh-plugin.mjs                               │
│                        │                                         │
│                        ├─ computer-tool-definitions.mjs           │
│                        └─ ComputerRuntime                         │
│                             ├─ tasks/    任务状态机、预算、断点      │
│                             ├─ perceive/ UIA / 截图 / OCR / 视觉    │
│                             ├─ act/      动作封装、输入法、窗口      │
│                             ├─ policy/   分级权限、白名单、急停      │
│                             ├─ audit/    收据、去重、日志            │
│                             ├─ packs/    douyin / browser / office  │
│                             └─ drivers/  windows-mcp / playwright   │
│                                    │                              │
└────────────────────────────────────┼──────────────────────────────┘
                                     │ 子进程 / 现有浏览器
                        ┌────────────▼─────────────┐
                        │ windows-mcp  (Python/UIA)│
                        │ Playwright   (Edge)      │
                        └────────────┬─────────────┘
                                     │ Win32 API / CDP
                        ┌────────────▼─────────────┐
                        │ Windows 11 桌面与应用     │
                        └──────────────────────────┘
```

### 3.2 与现有代码的关系

| 现有文件 | 新角色 |
| --- | --- |
| `dsh-plugin.mjs` | 继续注册工具；新增 `computer_*` 与任务工具；`douyin_*` 不变 |
| `core.mjs` | 保留为抖音领域包的控制器，被 `packs/douyin` 包裹 |
| `tool-definitions.mjs` | 不动；抖音包继续使用 |
| `browser-*.mjs` / `playwright-runtime.mjs` | 升级为通用 `browser` 驱动，抖音包复用 |
| `runtime-paths.mjs` / `task-limits.mjs` | 复用 `stateDir` 与预算模型 |
| `diagnostics.mjs` | 增加运行时自检项 |

安全机制**直接复用现有实现，不另起炉灶**：熔断（连续 2 次基础设施失败熔断 30 分钟）、发送收据去重（24h 内同目标同内容）、进程内并发锁、confirm 校验 + 发送后回读核实 + 失败不重试——这些已随抖音写链路落地并经过现网验证，`computer_*` 的 L1/L2 写操作沿用同一套模块与同一套语义。

### 3.3 包的演进路线（绞杀者模式）

```text
阶段 A（1.5.x）：插件内新增 computer/ 目录，先跑通
阶段 B（1.6）：抽到 workspace 包 packages/computer-runtime，插件改为本地依赖
阶段 C（2.0）：发布 @dsh/computer-runtime，dsh-douyin-agent 作为其领域包
```

三个阶段对外工具名不变（`computer_*` / `douyin_*`），因此调用方无感。

**阶段 B 实现状态（P4a，2026-10-26）**：`packages/computer-runtime`（`@dsh/computer-runtime` 0.1.0）已抽出——全部运行模块迁入包目录（`packages/computer-runtime/computer/`，内部相对导入原样），包自带 `package.json`/`exports`/`index.mjs` 公开导出面（运行时、策略、工具目录、领域包、调度、浏览器/视觉驱动、自检）。落地形态取**包内包**：包暂置于插件内、原 `computer/` 路径变一行 re-export 垫片（既有导入与测试零改动），以同时满足①发行白名单"相对闭包不得逃出发行包"②热加载不依赖 node_modules。阶段 C（2.0）：包目录迁出为独立仓库/npm 发布，垫片各改一行裸导入即完成切换。

---

## 4. 感知层

### 4.1 感知链路（逐级降级）

| 优先级 | 方式 | 适用 | 成本 | 失败信号 |
| --- | --- | --- | --- | --- |
| 1 | UIA 控件树 | 原生 Win32/WPF/UWP 应用 | 低 | 树为空、控件无名称 |
| 2 | DOM / 无障碍树 | 浏览器页面 | 低 | 页面无响应、跨域 iframe |
| 3 | OCR | Canvas、自绘界面、老应用 | 中 | 文字识别置信度低 |
| 4 | 视觉模型 grounding | 游戏、远程桌面、异常界面 | 高 | 连续两次定位失败 |

每次观察返回 `perceptionPath` 字段（`uia|dom|ocr|vision`），便于定位问题。**默认禁止直接跳到视觉**，只有前三级都失败且 `allowVisionFallback=true` 才启用。
**已知盲区与触发（2026-10-26 抖音网页实测）**：①无名图标按钮（点赞/评论/收藏/分享类纯图标）UIA 读不到语义——此时走「截图→识图认图标→坐标点击→再截图确认」的视觉闭环（`dsh-computer-use` 模式）；②自绘/游戏/远程桌面同理；③视觉兜底仅在上述场景触发，不得进入常规路径（见 1.6 速度契约）。浏览器内图标栏另有"见鼠标才出现"的影院态，需先悬停唤出再观察。

**视觉闭环实现状态（P3c，2026-10-26）**：`computer/vision.mjs` 已落地——`computer_click/type` 新增 `target` 描述参数：**结构化优先**（UIA 有同名元素自动回走 UIA 老路，视觉绝不进常规路径），盲区才进闭环；闭环 = 截图（驱动 Screenshot + PowerShell CopyFromScreen 双通道）→ `locate` 识图定位（**独立虚拟光标语义**：纯像素计算，不移动真实指针）→ 坐标提交（唯一真实指针动作）→ 再截图确认（目标仍在原位附近或 `gone` 均算有效）。硬约束全带：单次闭环 ≤15s 预算、连续两次定位失败即报人工、`allowVisionFallback=false` 或未接定位提供者一律 `VISION_UNAVAILABLE`。视觉模型接入点：`new ComputerRuntime({ visionLocate })`，`locate({ frame, target }) → { x, y, gone? }`。

### 4.2 观察内容

`computer_observe` 返回：

```json
{
  "ok": true,
  "activeApp": "notepad.exe",
  "activeWindow": { "title": "无标题 - 记事本", "rect": [120, 80, 900, 600] },
  "windows": [
    { "app": "msedge.exe", "title": "抖音", "focused": false, "display": 0 }
  ],
  "elements": [
    { "id": "e-3f8a1c02d4", "label": 17, "name": "保存", "role": "Button", "rect": [812, 540, 60, 28], "patterns": ["Invoke"] }
  ],
  "truncated": false,
  "perceptionPath": "uia",
  "frames": [{ "mimeType": "image/png", "bytes": 48213, "time": 1761370000000 }]
}
```

约定：

- `elements[].id` 是**跨观察稳定的元素 id**（窗口+角色+名称+坐标 哈希派生）；`label` 为当次观察标注号（仅快照内有效，传给驱动使用）。写动作必须持稳定 id，执行前在**最新观察**中重新解析——直接拿旧标注号会因元素树变化错位（现网已踩坑）。
- `patterns` 用于优先调用 `Invoke`/`Value` 等 UIA 模式，而不是模拟点击。
- 图片只返回 attachment ref，不返回 base64。
- 多显示器用 `display` 索引；坐标统一为物理像素，截图缩放不影响坐标。

### 4.3 窗口与进程识别

- 进程名来自 Win32，不信任模型自报。
- 提供 `computer_windows`：枚举、切换、移动、缩放、置顶；**只读部分不需要确认**。
- 窗口发现**三源兜底**（windows-mcp 枚举系统性漏行，现网已踩坑：2026-10-26 实测 WPS 窗口只出现在 `Focused Window`，`Opened Windows` 列表漏掉它）：`computer_windows list` 已实现三源合并（`computer/window-discovery.mjs`）——① Focused Window（优先，带 handle）→ ② Opened Windows（带重试）→ ③ 系统进程表 `tasklist /v` 真实窗口标题（只读、Node 侧执行、不经驱动），按标题去重，`source` 字段标注来源，消息窗/占位窗按标题剔噪；④ 失败再走 `switch` 按标题激活（另一套 Windows API）。`switch` 仅激活已存在窗口、无可破坏性，允许绕过列表存在性校验。
- 窗口发现的两个已知盲区（2026-10-26 实测）：①③都有覆盖不到的窗口——`tasklist` 的 `MainWindowTitle` 对 **explorer 类 shell 进程失明**（取不到标题），②的 UIA 列表又会**随机漏行**；此时用④ `switch` 激活目标，**Focused Window 段实测从不漏行**，从焦点窗口即可取回目标。另：`tasklist` 按控制台代码页（GBK）输出，必须先 `chcp 65001` 再按 UTF-8 解码，否则中文标题解成「合法但错误」的字符（无替换符可查），标题正则全部失配。
- 锁屏/远程桌面断开时标记 `SESSION_LOCKED` 并暂停任务，不猜测继续。

---

## 5. 动作层

### 5.1 动作清单

| 动作 | 实现 | 备注 |
| --- | --- | --- |
| 点击 | UIA `Invoke` 优先，否则元素中心 `Click` | 坐标点击是最后手段 |
| 输入 | 焦点元素 `Type`；中文走剪贴板粘贴 | 见 5.2 |
| 快捷键 | 白名单组合 | 禁止系统级危险组合 |
| 移动/悬停 | `computer_move`（驱动 `Move`，不点击） | 图标工具栏"见鼠标才出现"的场景先悬停唤出（抖音实测） |
| 滚动 | `computer_scroll`（`direction` + `times`，目标可省略=当前光标位置） | 记录滚动前后状态 |
| 拖拽 | `computer_drag`（`from`/`to` 各支持元素 id 或坐标） | 驱动 `Move(drag=true)` 从当前光标拖到落点，故先悬停到 `from` 再拖到 `to`；需要校验落点 |
| 等待 | `computer_wait`（1..10000ms） | 无桌面副作用，运行时内完成，不占驱动，归 L0 |
| 应用 | 启动/切换/关闭/调整窗口（`computer_windows` 变更动作） | 仅 allowlist 内可执行文件；关闭走受控通道，见 5.4 |
| 剪贴板 | 读/写 | 读操作可能泄露密钥，需确认 |
| 系统命令 | PowerShell | L2 高危，默认关闭，不进入自治 |

点击的现网教训（抖音分享面板已验证）：**部分 Web 控件不响应 CDP/驱动派发的鼠标事件，只认原生 `element.click()` 或 UIA `Invoke`**。因此动作层点击顺序固定为「UIA Invoke → 原生 click 调用 → 元素中心坐标点击」，派发鼠标事件只在前三者均不可用时兜底；任何写动作都必须回读核实（toast、状态变化），失败不重试。坐标系为 **UIA 空间**（≈屏幕像素 × DPI 比例，本机实测 1.5125，截图缩放不改变该空间）；GUI 重复操作（如计算器连点两次 7）是合法动作，**不做收据跳过**——24h 收据去重只适用于对外发送类一次性动作。

### 5.2 中文输入的工程约束

Windows 的 `SendInput` 不保证走输入法候选，直接打字会出现拼音或丢失。策略：

1. 优先 UIA `ValuePattern.SetValue`（原生输入框）。
2. 不支持时，写剪贴板 + `ctrl+v`，粘贴后立即恢复原剪贴板（若原内容非敏感）。
3. 两者都失败则返回 `INPUT_UNSUPPORTED`，不反复重试。

### 5.3 动作后置校验

每个写动作执行后自动观察一次，比较：

- 目标元素是否仍存在、名称是否变化
- 窗口标题、焦点应用是否变化
- 可选 OCR 文本差异

结果写入 `verified: true|false`。`verified:false` 只记录，不自动重试——与现有抖音链路的"失败不重试"保持一致。

### 5.4 关闭窗口的受控通道

windows-mcp 没有关闭窗口的驱动工具（`Process kill` 属 L3 永久禁用），因此 `computer_windows action=close` 走自建受控通道：

1. 按**精确窗口标题**在最新观察的窗口清单中定位目标（清单不含进程名），找不到返回 `ELEMENT_NOT_FOUND`；
2. 目标窗口标题过策略检查（标题黑名单）；
3. `switch` 到目标窗口，**复核焦点标题确为目标**，不一致返回 `VERIFY_FAILED` 且不发送任何关闭按键；
4. 发送 `alt+f4`（与点击关闭按钮同语义：应用可弹"保存更改"对话框）；
5. 复核窗口是否消失写入 `verified`，收据落盘。

`alt+f4` 在 `computer_key` 白名单里被永久拒绝（`DENIED_COMBOS`），**只有这条内部通道**可发，且发送前必须通过第 3 步的焦点核验；close 不终止进程（进程终止属 L3）。

---

## 6. 任务运行时（自治核心）

### 6.1 任务模型

```json
{
  "taskId": "tsk-20261025-0003",
  "goal": "把 Downloads 里的截图按月份归档，并用 Excel 汇总数量",
  "mode": "manual",
  "pack": null,
  "budget": { "maxSteps": 30, "maxWallMs": 600000, "maxModelCalls": 60, "maxWrites": 80 },
  "policySnapshot": { "profile": "standard", "apps": ["explorer.exe", "excel.exe"] }
}
```

`mode` ∈ `manual | autonomous`。自治模式只能执行 L0/L1 动作，L2 一律排队等待人工确认。

### 6.2 状态机

```text
queued
  └─▶ observing ─▶ acting ─▶ verifying
                        │         │
                        │         ├─ 成功 ─▶ 下一步 / done
                        │         └─ 失败 ─▶ replanning（最多 2 次）
                        │                       └─▶ failed
                        ├─ 需要人工 ─▶ waiting_human
                        └─ 预算/停止 ─▶ paused / cancelled
```

状态落盘，每步一个 checkpoint；进程重启后任务进入 `interrupted`，需显式恢复，不自动续跑。

### 6.3 自主性来源

| 触发方式 | 说明 | 默认 |
| --- | --- | --- |
| 手动 | **管理员私聊**发起（9.3 红线，其他来源一律拒绝） | 开 |
| 定时 | `stateDir/computer/schedules.json`，本地调度器 | 关 |
| 事件 | 文件变化、qq-bridge 新消息、抖音新动静 | 关 |
| 轮询观察 | 周期性 `observe` + 变化检测，满足条件才动作 | 关 |

所有自治触发生效前都要过四道闸：**策略快照、预算、目标白名单、无不可逆动作**。任务控制入口（发起/确认/暂停/恢复/中止）不区分触发方式，一律执行 9.3 的管理员私聊校验；定时/事件只是"何时跑"的信号源，任务本身仍由管理员预先配置并可随时叫停。

**实现状态（P3a，2026-10-26）**：定时/事件/轮询观察均已落地——`stateDir/computer/schedules.json`（`ScheduleStore`：interval/daily/event/poll 四类触发，条目校验 + 预算归一 + 事件冷却防消息风暴）+ 本地调度器（`LocalScheduler`：tick 自判全局开关默认关、触发成功才消耗、失败不消耗可重试且跳过日志节流）+ 事件入口（`runtime.notifyEvent(type)`：`qq-message`/`douyin`/`file` 三类）+ 轮询观察（`poll` 触发：每 `everyMs` 观察一次，`condition.titlePattern`/`elementPattern` 满足才动作，检查记账防刷观察）。四道闸在 `runtime.startScheduledTask`：策略开启且无 STOP、无在跑任务、预算归一、`mode=autonomous`（只可 L0/L1，L2 未注册不可达）；**会话锁定（SESSION_LOCKED）同样拦触发**（§6.4）。**跨仓库接线已完成（P4b，2026-10-26）**：事件以**文件即协议**贯通（`<stateDir>/computer/events/<type>-<ts>.json` → `EventBridge` 消费 → `notifyEvent`）——qq-bridge 在入站公共点落 `qq-message`（`src/computer-event-bridge.js`，只记元数据+15s 节流+失败静默），抖音 v2 在「自动盯梢」发现新动静时落 `douyin`（`lib/computer-event.mjs`，同语义），`file` 类型任何进程落文件即触发。

### 6.4 停止条件

- `stateDir/computer/STOP` 存在
- 用户中断 / `computer_task_stop`
- 预算耗尽（步数、时长、模型调用、写次数）
- 连续 2 次基础设施失败（熔断 30 分钟）
- 命中危险目标（标题黑名单、UAC、凭据管理器）
- 会话锁定或显示器休眠

### 6.5 恢复与幂等

- 步骤 key = `hash(action + target + argsHash)`；已完成步骤重启后跳过。
- 每个 checkpoint 记录：当前步骤、已完成集合、上次观察摘要、剩余预算。
- 恢复时先重新观察，不复用旧元素 id。

---

## 7. 领域包

### 7.1 接口

```js
export class DomainPack {
  id;                       // 'douyin' | 'browser' | 'office'
  matches(ctx) {}           // 判断当前窗口/URL 是否属于本包
  observe(ctx) {}           // 领域专属结构化观察
  actions() {}              // 领域动作清单
  prompt() {}               // 给模型的领域提示
  policyExt() {}            // 领域附加限制
}
```

约束：领域包**只能通过 L1 动作层执行**，不得直接持有鼠标键盘句柄，不得绕过 policy。

### 7.2 抖音包迁移映射

| 现有工具 | 新归属 |
| --- | --- |
| `douyin_open` | `browser` 驱动 + `douyin` 包导航 |
| `douyin_status` / `douyin_screenshot` | `computer_observe` + douyin 观察器 |
| `douyin_next` / `douyin_previous` | douyin 包动作（`douyin_search` 已在现网移除——web 端无可用搜索接口，迁移时**不恢复**） |
| `douyin_play` / `douyin_pause` | douyin 包动作 |
| `douyin_remember` / `douyin_recall` | 复用现有 memory |
| `douyin_chat_*` | douyin 包动作，保留许可名单与收据 |
| `douyin_watch_*` / `douyin_spark_*` / `douyin_report_*` | 任务运行时的定时任务 + douyin 包动作 |

迁移原则：**先包一层，不改语义**。`douyin_*` 工具对外签名不变，内部改为调用运行时，避免一次性重写。

抖音包（及 browser 驱动）必须继承的现网硬约束：

1. 注入 `navigator.webdriver`、`plugins` 等反检测补丁，否则接口返回空数据。
2. **禁止覆写浏览器 User-Agent**——自定义 UA 会导致抖音下发降级前端，评论编辑器、私信列表无法挂载。
3. 评论区是懒加载：定位目标评论前必须先滚动触发渲染，否则 DOM 节点不存在。
4. 带 @ 的公开评论可能进审核队列，回读校验按"已提交成功"判定，不强求评论列表立即可见。
5. 私信发送前二次核对对端 `sec_uid`，不一致则中止；分享卡片遵循"先卡片、间隔几秒再发文字"的固定顺序。

### 7.3 内置包规划

| 包 | 能力 | 优先级 |
| --- | --- | --- |
| `browser` | 通用网页导航、表单、下载（Playwright） | P1 |
| `douyin` | 现有全部能力 | P2 |
| `office` | Excel/Word 结构化操作优先，GUI 兜底 | P3 |
| `explorer` | 文件选择框、目录整理、属性 | P2 |
| `custom` | 用户用 YAML 声明窗口匹配与动作序列 | P3 |

---

## 8. 工具面与权限分级

统一前缀 `computer_`；`douyin_*` 继续保留。工具按风险分级，**分级决定是否需要确认、是否允许自治**。

### 8.1 L0 只读（无需确认，可自治）

| 工具 | 作用 |
| --- | --- |
| `computer_status` | 运行时、驱动、策略、预算、熔断状态 |
| `computer_screen` | 单屏/多屏截图，返回 attachment ref |
| `computer_observe` | 窗口 + 控件树 + 可选截图/OCR |
| `computer_wait` | 等待 `ms`（1..10000）；纯等待无桌面副作用，故不走确认（v0.5 修正：原列 L1 属分类缺陷） |
| `computer_windows` | 枚举窗口（`action=list` 只读） |
| `computer_task_status` | 任务状态、进度、剩余预算 |
| `computer_receipts` | 查询历史收据（默认最近 20 条） |
| `computer_browser_observe` | DOM 级页面观察：URL、标题、交互元素（`ref` 跨观察稳定）——B 方案网页通道，只读 |

### 8.2 L1 桌面写（确认后可自治）

| 工具 | 关键参数 |
| --- | --- |
| `computer_click` | `elementId` 或 `x,y` 或 `target`（视觉兜底）、`button`、`count` |
| `computer_type` | `text`、`elementId?` 或 `target?`、`replace?` |
| `computer_key` | `keys`（白名单组合） |
| `computer_move` | 移动/悬停（不点击）；图标栏"见鼠标才出现"场景必备 |
| `computer_scroll` | `elementId?`、`direction(up/down/left/right)`、`times(1..20)`；目标可省略=当前光标位置 |
| `computer_drag` | `from`、`to`（各为 `elementId` 或 `label` 或 `x,y`） |
| `computer_windows` | 变更动作 `action=launch/switch/resize/close`、`name`（close 为受控关闭通道，见 5.4） |
| `computer_clipboard` | `action=read/write` |
| `computer_browser_open/click/fill/download` | 网页写（B 方案）：导航 / 点击（原生 `element.click()`）/ 表单填写 / 下载核验；目标白名单用 `policy.domains`（域名后缀匹配，空=全拒 fail-closed），确认令牌与收据同桌面写 |

### 8.3 L2 系统级（每次显式确认，禁止自治）

| 工具 | 说明 |
| --- | --- |
| `computer_shell` | PowerShell；`profile=power` 且 `allowShell=true` 才存在 |
| `computer_settings` | 打开系统设置页、修改系统开关（P3，谨慎） |

**实现状态（P3b，2026-10-26）**：两工具已实现——注册时按 `profile=power` 决定可见性（`includeL2`，独立分组不进常驻目录），运行时每次调用复核三关：①自治任务内 `AUTONOMY_FORBIDDEN` ②档位存在性（shell 另需 `allowShell`）③管理员私聊，之后仍走两段式确认。`computer_shell` 由 Node 侧子进程执行（驱动的 `Shell` 属 L3 永久禁用），15s 超时、输出截断、收据只记命令 hash；`computer_settings` 当前只支持**打开**白名单设置页（ms-settings: URI），不修改任何系统开关。

### 8.4 L3 永久禁用（不注册、不可见）

注册表读写、进程终止/注入、UAC 与安全中心弹窗、凭据管理器、驱动安装、计划任务创建、服务控制。

契约测试断言 `listTools()` 中不存在这些能力。

### 8.5 任务工具

| 工具 | 作用 |
| --- | --- |
| `computer_task_start` | 创建并启动任务（含目标、预算、模式） |
| `computer_task_pause` | 暂停当前任务，保留 checkpoint |
| `computer_task_resume` | 从 checkpoint 恢复 |
| `computer_task_stop` | 中止并落盘收据 |
| `computer_task_plan` | 只生成计划，不执行（可选） |

任务工具仅**管理员私聊**可调用（见 9.3 红线）；群聊或非管理员调用一律返回 `NOT_ADMIN` 并记审计日志，不看提示词怎么说。

**身份落点（2026-10-26 二次修订）**：红线**不限模式**——二代/三代仿真的**管理员私聊**同样可下命令操控电脑（使用者明确要求）。真实身份由 qq-bridge 发布的「DSH 会话 ↔ QQ 会话」映射（`computer/qq-sessions.json`）经 `exec.agent.session.id` 反查传入 `actor`，运行时 `execute` 统一把关：群聊/非管理员/未知身份只有 `computer_status`/`computer_task_status`，管理员私聊才可观察与操作；QQ 桥在跑但查不到映射的会话按**未知身份 fail-closed**。仿真守卫（qq-tool-restrict）放行全部 `computer_*`（注册期无法区分会话身份，藏工具会误伤管理员私聊），pwsh/fs 等本地执行工具仍按 L7 铁律双拒。

### 8.6 返回约定

```json
{
  "ok": true,
  "tool": "computer_click",
  "taskId": "tsk-20261025-0003",
  "step": 4,
  "target": { "app": "notepad.exe", "elementId": "elem-17", "name": "保存" },
  "verified": true,
  "receiptId": "rcp-20261025-0017",
  "perceptionPath": "uia",
  "frames": [{ "mimeType": "image/png", "bytes": 48213 }]
}
```

失败：`{ ok:false, code, message, hint, evidence?: frames }`。图片一律转 attachment ref。

---

## 9. 安全模型

### 9.1 四级权限

| 级别 | 确认 | 自治 | 示例 |
| --- | --- | --- | --- |
| L0 只读 | 否 | 允许 | 观察、截图、状态 |
| L1 桌面写 | 一次性令牌 | 允许（预算内） | 点击、输入、切窗 |
| L2 系统级 | 每次显式确认 | **禁止** | Shell、系统设置 |
| L3 高危 | — | — | 注册表、进程、UAC |

### 9.2 不可逆动作清单

无论什么模式，以下动作必须人工确认，且不允许批量：

发送消息/邮件、支付、删除文件、修改权限、安装软件、同意条款、提交表单、关闭未保存文档。

### 9.3 确认机制

- 一次性令牌，TTL 60 秒，单次使用。
- 绑定 `{taskId, action, target, argsHash, policySnapshot}`；任一变化即失效。
- 第一次调用返回 `needsConfirm` + 摘要（人话描述要做什么），第二次调用携带令牌执行。

**确认与任务控制的红线（2026-10-26 定）**：**只有管理员私聊才能控制机器人执行任务**。qq-bridge 现网"群聊/私聊同等权限、任何人可驱动"的约定**不适用于桌面任务**——桌面操控等于点击你的电脑，控制权必须收口：

1. 任务的发起、确认（令牌签发/消费）、暂停、恢复、中止，**仅接受管理员身份的私聊指令**。管理员**统一取 qq-bridge 白名单的 owner**：`policy.json` 的 `adminIds` 直接填 owner 的 QQ 号，两处是同一个人，不另维护第二套管理员名单（可加 consoleToken 二次校验）。
2. 群聊消息一律**不触发任何任务与桌面写操作**，无论发送者是谁；最多只读查询（`computer_status` / `computer_task_status`）。
3. 非管理员的私聊同样拒绝任务控制，返回 `NOT_ADMIN`，并记审计日志。
4. 身份校验发生在**入口层**（消息进调度器之前），不是工具层——避免"工具没鉴权、靠提示词约束"的假安全。

### 9.4 策略

```json
{
  "profile": "standard",
  "enabled": true,
  "control": { "channel": "private", "adminIds": [] },
  "apps": ["notepad.exe", "explorer.exe", "msedge.exe", "excel.exe"],
  "titleDeny": ["DSH", "1Password", "Bitwarden", "银行", "UAC"],
  "allowShell": false,
  "allowVisionFallback": true,
  "autonomy": {
    "enabled": false,
    "maxConcurrentTasks": 1,
    "maxStepsPerTask": 30,
    "maxWritesPerHour": 80
  }
}
```

- `apps` 为空 → 所有写操作拒绝（fail-closed）。
- `adminIds` 直接填 **qq-bridge 白名单 owner（管理员）的 QQ 号**，与 qq-bridge 侧统一为同一人、单一来源，不另维护独立的管理员名单；为空 → **所有任务控制拒绝**（fail-closed）。
- `control.channel` 固定为 `private`；若被改为 `group` 或 `any`，运行时拒绝启动并报 `POLICY_INVALID`。
- `profile` ∈ `safe | standard | power`；`safe` 只有 L0。
- 策略快照随任务落盘，运行中改配置不影响已在跑的任务。

### 9.5 熔断、去重、串行、急停

以下机制与抖音写链路**共用同一套实现**（见 3.2），保证两类写操作行为一致：

| 机制 | 规则 |
| --- | --- |
| 熔断 | 连续 2 次基础设施失败 → 30 分钟 |
| 去重 | 24h 内同 `{app, action, target, textHash}` 返回既有收据 |
| 串行 | 同一时刻仅一个桌面动作；并发返回 `COMPUTER_BUSY` |
| 急停 | `STOP` 文件 / 设置页按钮 / `computer_task_stop`，三者等效 |
| 审计 | 所有 L1/L2 动作写收据，保留 7 天截图证据 |

---

## 10. 配置与存储

### 10.1 配置文件

`stateDir/computer/policy.json`（策略）、`schedules.json`（定时/事件调度）、`packs.json`（启用的领域包）。

`schedules.json` 形如（全局 `enabled` 默认 `false`，即触发默认关）：

```json
{
  "enabled": true,
  "schedules": [
    { "id": "sch-1a2b3c4d", "goal": "巡检桌面并记录变化",
      "trigger": { "kind": "interval", "everyMs": 3600000 },
      "budget": { "maxSteps": 30, "maxWrites": 20, "maxWallMs": 600000, "maxModelCalls": 60 },
      "enabled": true, "createdAt": 1793010000000, "lastRunAt": null },
    { "id": "sch-5e6f7a8b", "goal": "qq 消息到达时的桌面联动",
      "trigger": { "kind": "event", "event": "qq-message", "cooldownMs": 60000 }, "enabled": true }
  ]
}
```

`trigger.kind` ∈ `interval`（`everyMs` ≥ 5000）/ `daily`（`dailyAt` HH:MM）/ `event`（`event` ∈ `file|qq-message|douyin`，`cooldownMs` 默认 60000 防消息风暴）。

### 10.2 目录结构

```text
stateDir/computer/
├── policy.json
├── schedules.json
├── packs.json
├── confirm.json                 # 未消费令牌
├── STOP                         # 急停
├── tasks/<taskId>/
│   ├── state.json               # 状态机与预算
│   ├── steps.jsonl              # 逐步记录
│   └── artifacts/               # 截图与证据
├── receipts.jsonl
└── drivers.json                 # 子进程 pid、版本、重启次数
```

### 10.3 驱动配置

```json
{
  "command": "uvx",
  "args": ["windows-mcp==0.7.1"],
  "env": {
    "WINDOWS_MCP_SCREENSHOT_SCALE": "0.5",
    "WINDOWS_MCP_SCREENSHOT_BACKEND": "auto",
    "ANONYMIZED_TELEMETRY": "false"
  }
}
```

- 锁定上游版本，升级必须先过契约测试。
- Electron 宿主不继承 PATH，`command` 必须为 `uv.exe`/`uvx.exe` 绝对路径。
- 空闲 10 分钟回收子进程；同会话最多自动重启 2 次。

---

## 11. 可观测性与诊断

### 11.1 日志字段

```json
{ "at": 1761370000000, "taskId": "tsk-...", "step": 4, "tool": "computer_click",
  "app": "notepad.exe", "action": "invoke", "perceptionPath": "uia",
  "ok": true, "verified": true, "latencyMs": 412, "receiptId": "rcp-..." }
```

禁止记录：完整输入文本（只记 hash 与前 8 字符）、截图内容、窗口中的业务数据、剪贴板内容。

### 11.2 自检项

| 检查 | 失败码 | 建议 |
| --- | --- | --- |
| `uv` 可执行 | `UV_NOT_FOUND` | 安装或配绝对路径 |
| Python 版本 | `PYTHON_TOO_OLD` | 由 uv 管理解释器 |
| MCP 握手 | `MCP_START_FAILED` | 首次超时可重试一次 |
| 高危工具泄漏 | `TOOLSET_LEAK` | 阻止启用 |
| 策略文件可读 | `POLICY_INVALID` | 恢复默认并提示 |
| 会话未锁定 | `SESSION_LOCKED` | 解锁后恢复任务 |

**实现状态（P3d，2026-10-26）**：`computer/diagnostics.mjs` 已落地并挂进既有 `runDiagnostics` 报告（`douyin_diagnostics` 自动带上）——上述六项全覆盖，另加 `computer_runtime`（STOP 急停 `STOP_ACTIVE` / 调度启用态）与 `computer_policy` 的 fail-closed 告警（adminIds/apps 为空）。原则：**纯只读**——不冷启动驱动（回归网 2）、不写任何文件（computer 目录不存在则整组跳过）、失败项一律带处理建议；`computer_mcp` 只读 `drivers.json` 会话状态，真实握手留给运行期。

---

## 12. 错误码

| 码 | 含义 | 处理 |
| --- | --- | --- |
| `COMPUTER_DISABLED` | 运行时未开启 / STOP 急停生效 | 到设置页开启 / 删除 STOP |
| `CONFIRM_REQUIRED` | 写操作缺令牌：**不报错**，返回 `{ok:true, needsConfirm:true, confirmToken}` | 返回摘要 + 令牌，同参携带令牌再调用 |
| `CONFIRM_EXPIRED` / `CONFIRM_MISMATCH` | 令牌失效（TTL 60s）或绑定参数已变化 | 重新发起 |
| `NOT_ADMIN` | 非管理员或非私聊发起任务控制/写操作 | 拒绝并记审计日志 |
| `POLICY_INVALID` | policy.json 损坏/非法，或运行时装配缺参 | 恢复默认值并提示用户修复 |
| `TARGET_NOT_ALLOWED` | 目标不在白名单 | 拒绝并记录 |
| `TITLE_DENIED` | 命中危险标题或系统级危险快捷键 | 拒绝并暂停 1 分钟 |
| `ELEMENT_NOT_FOUND` | 元素/窗口 id 失效或目标缺失 | 重新观察 |
| `INPUT_UNSUPPORTED` | 中文/富文本输入失败、按键/参数不受支持 | 换剪贴板策略或人工 |
| `ACTION_TIMEOUT` | 单步超时（驱动默认 30s，观察 45s） | 返回证据，不重试 |
| `VERIFY_FAILED` | 动作后复核不一致；close 前置焦点核验失败（不发送关闭键） | 标记收据，等待人工 |
| `COMPUTER_BUSY` | 并发动作 / 已有任务在跑 | 等待当前动作结束 |
| `BUDGET_EXHAUSTED` | 预算耗尽或预算参数非法 | 暂停任务 |
| `TASK_STATE` | 任务不存在 / 状态机不允许该迁移 | 按 §6.2 允许的迁移重试 |
| `SESSION_LOCKED` | 锁屏/断开（P3 接入） | 暂停，解锁后恢复 |
| `CIRCUIT_OPEN` | 熔断中 | 30 分钟后半开 |
| `MCP_START_FAILED` | 驱动启动失败 / 提前退出 / 通信中断 | 检查 uv 与 windows-mcp；计入熔断 |
| `UV_NOT_FOUND` | 找不到 uvx.exe | 安装 uv 或配置 DOUYIN_COMPUTER_UVX |
| `TOOLSET_LEAK` | 高危驱动工具被触达 / 未知工具名 | 拒绝执行并报警 |
| `AUTONOMY_FORBIDDEN` | 自治任务内调用 L2 系统级工具（回归网 5） | 拒绝；L2 一律排队等人工确认 |
| `VISION_UNAVAILABLE` | 视觉兜底未启用（allowVisionFallback=false）或未接视觉定位提供者 | 用结构化目标，或接线视觉模型 |
| `BROWSER_UNAVAILABLE` | 网页通道未接/专用浏览器未连接 | 先打开已登录的专用浏览器 |

---

## 13. 测试计划

| 层级 | 内容 | 说明 |
| --- | --- | --- |
| 单元 | 令牌、白名单、预算、状态机、敏感文本 | 纯逻辑，无 IO |
| 契约 | `listTools()` 对账；断言 L3 不存在；锁定 0.7.1 schema | 每次升级必跑 |
| 集成 | 记事本输入保存、计算器运算、资源管理器归档 | `COMPUTER_LIVE=1` 才跑 |
| 跨应用 | 浏览器下载 → 资源管理器 → Excel 汇总 | 手动 + 集成 |
| 故障 | 杀子进程、连续失败熔断、`STOP`、锁屏 | 必须覆盖 |
| 恢复 | 任务中途重启，checkpoint 恢复 | 校验不重复执行 |
| 回归 | 现有 `douyin_*` 与全部测试 | `pnpm test` |

新增回归网约束：

1. 安装后 `TOOL_DEFINITIONS` 数量与顺序不变。
2. 关闭状态不产生 `computer/drivers.json`，不启动 Python。
3. 所有 L1/L2 返回必须含 `receiptId`。
4. 返回体不得出现 `data:image/` 或超长 base64。
5. 自治模式调用 L2 必须被拒绝（`AUTONOMY_FORBIDDEN`）。
6. 一键启动/安装类 PowerShell 脚本必须以 **UTF-8 with BOM** 保存（PowerShell 5.1 遇无 BOM 的中文注释会解析崩溃，现网已踩坑）。
7. 涉及默认值/等待参数的改动必须**四处同步**：`policy.json`（或 config）、工具 schema 描述、提示词、回归测试——沿用现有约定，任一不同步即视为回归。
8. 桌面写动作的收据必须能回读核实；测试中"发送成功但未核实"不得计为通过。
9. 权限入口必须过回归：群聊发起任务、非管理员私聊发起任务、`adminIds` 为空时发起任务，三种情况都必须返回 `NOT_ADMIN` / 拒绝，且写入审计日志。
10. 关闭窗口只允许 `computer_windows action=close` 受控通道：发送 `alt+f4` 前必须核验焦点标题，核验失败返回 `VERIFY_FAILED` 且**不发送**任何关闭按键；`computer_key` 白名单持续拒绝 `alt+f4`（契约测试锁定）。
11. `computer_wait` 不得进入写工具集合（无确认令牌、无收据）；`computer_receipts` 返回不得含明文输入、剪贴板内容或截图。

---

## 14. 分批实施

### P0：通用感知 + 基础动作（可演示）

- `computer_status / screen / observe / windows(list)`
- `computer_click / type / key / move / scroll / drag / wait / receipts`（v0.5 补齐 move/scroll/drag/wait/receipts）
- policy fail-closed + 审计日志
- 契约测试、单元测试

验收：能观察任意应用并完成"打开记事本 → 输入 → 保存"。**状态：已完成**（2026-10-26 真机验证记事本、计算器）。

### P1：任务运行时 + 跨应用

- 状态机、checkpoint、预算、恢复、重规划
- `computer_task_*` 四个工具
- 窗口生命周期：`computer_windows` launch/switch/resize/close（close 受控通道见 5.4）
- 跨应用任务：资源管理器 + Excel
- `browser` 领域包（把现有 Playwright 抽象出来）

验收：跨应用任务可暂停/恢复；进程重启后不重复执行已完成步骤。**状态：已完成**（状态机/预算/幂等单测全绿；真机通过记事本、计算器含暂停恢复、资源管理器归档 + WPS 汇总表落盘——窗口发现缺口修复后 2026-10-26 复测通过）。

### P2：领域包体系 + 抖音迁移

- `DomainPack` 接口与 `packs.json`（`stateDir/computer/packs.json` 启用清单）
- `douyin` 包包裹现有 `core.mjs`；`douyin_*` 签名不变（阶段 A「先包一层」：归属判断 + 领域提示 + 附加限制，实际执行仍走既有工具链）
- `explorer` 包（文件对话框、目录整理——动作产出 L1 步骤计划，包不碰键鼠）
- 设置页：开关、白名单、急停、收据列表（`SETTINGS_SECTIONS`「电脑操控」栏目 + `/api/douyin-browser/computer/*` 端点）

验收：抖音全部现有测试通过；跨应用任务可以"网页 → 桌面"串联。**状态：已完成**（领域包接口/注册表/抖音包/browser 包/explorer 包/office 包/设置页 API 全部落地，71 项 computer 测试全绿）。`browser` 工具面已按 **B 方案**定稿并实施（2026-10-26）：`computer_browser_observe/open/click/fill/download` 并入现有分级（§8.1/8.2），复用同一套四道闸/确认/收据/预算；DOM 级驱动 `computer/browser-driver.mjs` 复用现有 Playwright CDP 通道（登录态不搬家、不覆写 UA），目标白名单 `policy.domains`（域名后缀匹配，空=全拒）。

### P3：自治与视觉兜底

- 定时/事件触发；变化检测轮询——**已完成**（P3a：schedules.json 四类触发 + 本地调度器 + notifyEvent + 轮询条件检测，见 §6.3）
- 会话锁定检测（SESSION_LOCKED）——**已完成**：锁屏/安全桌面进程探测，锁定拦写、任务自动暂停、触发跳过（§4.3/§6.4）
- L2 `computer_shell` / `computer_settings` ——**已完成**（P3b，见 §8.3：power 档存在性 + AUTONOMY_FORBIDDEN + 两段式确认）
- OCR 与视觉兜底（`allowVisionFallback`）——**闭环与模型接线均已完成**（P3c/P4b，见 §4.1）：`target` 描述参数 + 结构化优先 + 截图→识图→提交→再截图确认，15s 预算、两次失败报人工、独立虚拟光标；`visionLocate` 已由 `vision-adapter.mjs` 接到 DSH 模型路由（复用 llm.stream + attachments，模型须支持图片输入，否则 VISION_UNAVAILABLE）
- `office` 包——**已完成**（GUI 配方阶段：inputCell/saveAs 的 L1 计划 + 真机实测 prompt；结构化操作优先留待后续）
- 自检与诊断完善——**已完成**（P3d，见 §11.2：六项检查 + 运行态/策略告警，挂进 douyin_diagnostics 报告）

验收：定时任务连续运行 24 小时无泄漏；视觉兜底只在 UIA 失败时触发。

### P4：独立包与多任务

- 抽出 `packages/computer-runtime` 并发布——**阶段 B 已完成**（P4a：包内包形态 + 垫片零改动切换，见 §3.3；npm 发布属阶段 C/2.0）
- 多窗口并行任务（默认关闭，需独立虚拟桌面或 VM）

---

## 15. 兼容与迁移

| 风险点 | 策略 |
| --- | --- |
| `douyin_*` 语义变化 | 先包一层，不改签名；逐个替换内部实现 |
| 工具目录数量 | 现有 34 项保持不变，新工具追加到独立分组 |
| 设置页 | 新增"电脑操控"子页，不复用抖音页字段 |
| 数据目录 | 新数据放 `stateDir/computer/`，不读写旧 `douyin-browser` |
| 发布 | 1.5.x 保持插件内模块；2.0 再拆包，避免提前改依赖 |

### 主干-分支重组（2026-10-27 起）

目标：`dsh-douyin-agent`（v2）收编全部抖音功能、成为唯一抖音面；本项目瘦身为主干
（computer_* 运行时 + 任务引擎 + DomainPack 注册表），通过 DomainPack 契约操控分支完成任务。

- **P1（已落地）**：
  - 撞名裁决：`douyin_status/observe/screenshot/remember/recall/next/spark_start/spark_stop`
    8 个与 v2 同名的工具由本项目独占注册（DSH 撞名时生效的本来就是本项目的实现），
    v2 侧暂不注册这 8 个名字——工具面零双份、行为零变化，"谁在干活"不再含糊。
  - 额度闸统一：v2 新增 `lib/video-limits.mjs`（本项目 video-limits.mjs 的迁移副本），
    与本项目**共用同一套轮次状态文件**（stateDir 下 video-policy/sessions，一个时钟）；
    v2 的 `douyin_feed/video/comments/scout/run` 全部接入轮次闸，消除"feed 不受限、
    observe 被拒"的不一致。"轮次只能人工开启"的红线原样保留。
  - QQ 守卫（qq-tool-restrict）白名单补 `douyin_scout`（只读采集）；
    `douyin_config/login/setup/ask_expert/autoreply_*` 按 fail-closed 不放行。
- **P2b（已落地）**：抖音工具面全部归 v2（56 个工具，本包不再注册任何 `douyin_*`）：
  - 功能收编：`video_limits_status / spark_status / interest_record / persona_status /
    report_status / report_generate`（persona-memory / daily-report 迁移副本，共享同一份
    记忆/日报存储）+ 浏览基础件 `open / search / open_video / previous / play / pause`
    （v2 自有 CDP 实现，观看链过轮次闸，pause 沿用 READ_ACTIONS 豁免）；
  - **引擎迁移副本** `v2/lib/engine/`（53 文件 self-contained 零改写：core 控制器、观看/私信/
    媒体/转发/自检全栈），与本包共用同一套状态/记忆存储（runtime-location 解析）；
    `chat_* / media_* / forward_video / watch_* / diagnostics*` 经 engine 委托承载
    （跨进程锁、租约、额度复核、许可名单语义零丢失；自主观看启动时用 DSH 模型路由包
    decisionProvider）；
  - 状态文件保持共享不搬家（独立软件 app.mjs 仍在本包使用同套数据）；物理去重随 P3 清理。
- **P3（已落地，2026-10-27）**：主干-分支接线完成：
  - 外部领域包即插即用：`stateDir/computer/packs.d/<id>.json` 声明
    `{ id, name, module }`，主干 PackRegistry 动态加载分支导出的 `createPack(deps)`
    （坏声明/坏模块 fail-closed 跳过）；分支插件激活自注册、卸载自清理；
  - v2 分支包 `v2/lib/pack.mjs`：实现 DomainPack 契约
    （matches/observe/actions/prompt/policyExt/plan/handlesGoal），plan() 只产出
    主干 L1 步骤（越权步骤被 `DomainPack.assertPlanAllowed` 拒绝，TOOLSET_LEAK）；
  - 任务引擎 goal 路由：新工具 **`computer_task_plan`**（只读规划、管理员私聊）——
    goal → 领域包认领 → L1 计划；没有包认领返回空计划与包清单；
    回归网 `tests/p3-branch-pack.test.mjs`（4 例：外部包加载/越权自检/真实分支包
    端到端/注册面零 douyin_* 对账）。
  - **独立软件归属决策**：app.mjs 控制页 + 大肥鱼桌面 UI **暂留本包**（引擎同源副本
    继续服务它）；状态文件保持共享（runtime-location 解析），物理去重延后到独立软件
    归属最终调整时。DSH 工具面上"只保留 v2"已达成。
- **P4 验收（2026-10-27 自动化部分完成）**：computer-use 全量 558 例（含 P3 新增 4 例）
  + v2 冒烟 56 工具零撞名 + QQ 守卫 8/8 全绿；实机链路清单（重启 DSH、/reset、
  私聊下令操控电脑、额度闸、真机写工具、24h 长跑）留人工验收。
- **界面精简（2026-10-27 使用者要求）**：删除「音频与密钥 / 观看日报 / 自检与用量」三个
  功能（设置栏目、客户端渲染块、`/media/*` `/reports/*` `/diagnostics*` 路由、
  `douyin_media_status / douyin_listen / douyin_report_* / douyin_diagnostics*` 六个工具）；
  同轮修复"打开抖音"白屏/报错（endpoint 陈旧 pid 竞态、孤儿专用窗口复用、导航重试）。

---

## 16. 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
| --- | --- | --- | --- |
| GUI 操作继承登录态 | 账号与数据风险 | 独立 Windows 用户/VM、标题黑名单 | 写 `STOP` |
| 自治任务失控 | 误操作扩散 | 预算 + 不可逆清单 + L2 禁止自治 | `computer_task_stop` |
| 中文输入失败 | 任务卡住 | UIA Value → 剪贴板 → 报错 | 人工接管 |
| DPI/多屏坐标偏移 | 点错目标 | 元素 id 优先、物理像素 | 重新观察 |
| 上游 schema 变更 | 调用失败 | 锁版本 + 契约测试 | 回退 `mcpArgs` |
| 子进程残留 | 资源占用 | 空闲回收 + 退出强杀 | 结束 python 进程 |
| 包拆分引入回归 | 现有功能受损 | 分阶段 + 每阶段回归 | 保留阶段 A 的实现 |

回滚原则：**只关开关，不删数据**。

---

## 17. 验收清单

- [x] 默认安装后，现有工具目录、设置页、全部测试与 1.4.4 一致（34 项 `TOOL_DEFINITIONS` 金名单契约锁定；2026-10-26 全量回归零新增失败——唯一失败 `task-limits-http` 为并行偶发，单独重跑 5/5 过）。
- [x] 关闭状态无 Python 子进程、无 `computer/drivers.json`（回归网 2 锁定）。
- [x] 完成 3 个跨应用任务：记事本 ✓、计算器 ✓（7×8=56，含暂停恢复）、资源管理器归档 + WPS 汇总表 ✓（2026-10-26 窗口发现缺口修复后真机通过）。
- [x] 任务可暂停、恢复；重启后不重复已完成步骤（状态机单测 + 真机计算器任务）。
- [x] 自治模式下 L2 调用被拒绝（L2 工具未注册即天然不可达；P3 注册后过 `AUTONOMY_FORBIDDEN` 回归）。
- [x] 群聊、非管理员私聊发起任务被拒绝（`NOT_ADMIN`），仅管理员私聊可发起/确认/管理任务。
- [x] 白名单为空时所有写操作被拒绝。
- [x] 每次 L1/L2 动作都有 `receiptId` 与 `verified`。
- [x] `listTools()` 中不存在注册表、进程终止、UAC、凭据管理等能力。
- [x] 日志与对话中无 base64、无完整输入文本、无剪贴板内容（收据只记 hash 与前 8 字）。
- [x] 抖音全部现有测试通过，`douyin_*` 工具签名未变（2026-10-26 全量回归验证，失败项仅上述并行偶发）。
- [x] v0.5 工具面齐备：`computer_move / scroll / drag / wait / receipts` 与 `computer_windows close` 受控通道全部实现并过契约/单测。

---

## 附录 A：安装

```powershell
# 1. 安装 uv（一次性）
winget install astral-sh.uv

# 2. 预热依赖
uvx windows-mcp==0.7.1 --help

# 3. 确认绝对路径（Electron 宿主必须）
where.exe uvx
```

## 附录 B：驱动接入骨架

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: policy.driver.command,
  args: policy.driver.args,
  env: { ...process.env, ...policy.driver.env },
});
const client = new Client({ name: 'dsh-computer', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const leaked = tools.filter((t) => FORBIDDEN.has(t.name));
if (leaked.length) throw new Error(`TOOLSET_LEAK: ${leaked.map((t) => t.name).join(',')}`);

// 参数以 listTools() 的 schema 为准，不硬编码猜测
await client.callTool({ name: 'Snapshot', arguments: { use_vision: false } });
```

## 附录 C：目录与文件清单

```text
computer/
├── runtime.mjs              运行时装配、生命周期、驱动管理
├── tasks/state-machine.mjs  任务状态机、预算、断点
├── tasks/checkpoint.mjs     落盘与恢复
├── perceive/uia.mjs         UIA 观察与元素 id 映射
├── perceive/screen.mjs      截图、多屏、DPI
├── perceive/ocr.mjs         OCR（P3）
├── perceive/vision.mjs      视觉兜底（P3）
├── act/input.mjs            点击、输入、快捷键、拖拽
├── act/ime.mjs              中文输入策略
├── act/window.mjs           窗口与应用生命周期
├── policy/policy.mjs        分级权限、白名单、不可逆清单
├── policy/confirm.mjs       一次性令牌
├── audit/receipts.mjs       收据与去重
├── audit/logger.mjs         结构化日志
├── packs/douyin.mjs         抖音领域包（包裹 core.mjs）
├── packs/browser.mjs        浏览器领域包（包裹 Playwright）
├── packs/explorer.mjs       资源管理器领域包
└── tool-definitions.mjs     全部 computer_* 工具 schema

tests/computer-policy.test.mjs
tests/computer-contract.test.mjs
tests/computer-task.test.mjs
tests/computer-live.test.mjs
```

---

## 参考

- [Windows-MCP 官方文档（PyPI 0.7.1）](https://pypi.org/project/windows-mcp/0.7.1/)
- [Windows-MCP 仓库](https://github.com/CursorTouch/Windows-MCP)
- [@ui-tars/sdk（视觉兜底）](https://www.npmjs.com/package/@ui-tars/sdk)
- 项目内：[插件说明](plugin.md)、[发布说明 1.4.4](features-1.4.4.md)、[后续功能](next-features.md)
