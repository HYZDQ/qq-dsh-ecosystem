# QQ Agent 生态工作区

## 1. 用 AI 部署本项目：提示词模板

想让 AI 编程助手（Trae / Cursor / Claude Code 等）直接帮你把项目部署起来？把下面的提示词整段复制给它，替换〔〕里的内容即可：

```text
我想在 Windows 本机部署开源项目「QQ Agent 生态」（`https://github.com/HYZDQ/qq-dsh-ecosystem`）。
请作为部署助手，按官方 README 的「安装与使用」章节帮我完成，全程分阶段汇报，
每一步都告诉我「验证成功的标志」，命令失败先诊断原因，不要盲目重试。

【我提供的信息】
- 我的 QQ 号（ownerQQ）：〔填写〕
- 允许响应的群号白名单（allow.groups）：〔填写，留空则不响应群消息〕
- 允许响应的私聊 QQ 号白名单（allow.private）：〔填写〕

【部署步骤】
1. 环境检查：Node.js ≥ 22.13；确认 DeepSeek Harness 桌面端已运行
2. SnowLuma（QQ 协议端）由我自己从 `https://github.com/SnowLuma/SnowLuma/releases/latest`
   下载解压（本仓库不分发它），双击 launcher.bat 启动后，指导我在 WebUI 里扫码登录 QQ、
   开启 OneBot WebSocket（默认 3001）与 HTTP API（默认 3000）。
3. 克隆仓库 → cd qq-bridge → npm install → 把 config.example.json 复制为 config.json，
   向我逐项解释后再填写：snowluma.wsUrl / snowluma.httpUrl、ownerQQ、allow 白名单。
   注意 allowAllWhenEmpty 必须保持 false：空白名单 = 机器人不响应任何消息，这是故意的安全默认。
4. 运行 node scripts/setup-dsh.mjs 把工具注册进 DSH，装完提醒我重启 DSH。
5. 启动桥接 npm start（或 start.bat），成功标志：日志出现「SnowLuma 已连接」。
6. 可选插件按需装：qq-image（setup-dsh 已注册，无需单独启动）；
   qq-diary（复制 config.example.json → npm install → node index.js --check → node index.js）；
   qq-douyin 刷抖音 / 电脑操控（见 README「安装与使用」第 6 步）。
7. 仓库里的 .gitkeep 是目录占位文件，请保留；state/history、qq-diary/diaries、
   qq-diary/logs、qq-QQKJ/images 是运行时数据目录，保持为空即可。

【安全红线（必须遵守）】
- 不要把 config.json、state/、聊天记录、日记、照片写进任何文档、截图或 git 提交。
- 不要修改 .gitignore，不要绕过 confirm 校验、熔断、白名单等安全机制。
- 电脑操控写操作「仅管理员私聊可发起」的约束必须保留。

【汇报方式】
- 每完成一个阶段停下来汇报结果与下一步计划，我确认后再继续。
```

> 💡 提示：把「验证成功的标志」和「安全红线」写进提示词，能防止 AI 一口气跑完却不验证、或好心办坏事泄露隐私。QQ 号等隐私值只填进本地 `config.json`，不要贴进公开对话。

## 2. 特殊目录说明

这几个目录在仓库里**只保留空文件夹**（`.gitkeep` 占位），实际内容只存在你自己的电脑上，永远不会被上传：

| 目录 | 用途 |
|---|---|
| `qq-bridge/state/history/` | **私聊与群聊的历史聊天记录**归档目录（按 `private_*.md` / `group_*.md` 保存） |
| `qq-diary/diaries/` 与 `qq-diary/logs/` | **每日日记**的存放位置：`diaries/` 存日记正文与索引，`logs/` 存写日记的运行日志 |
| `qq-QQKJ/images/` | **主人供片目录**：你想让机器人发布 QQ 空间说说时用哪些本机照片，就把图片放进这里（本机图片白名单）；机器人也会自己上网搜索图片用于空间内容，这个目录是「主人主动指定素材」的专属渠道，留空不影响其他功能 |

## 3. 开篇

把 **QQ 消息接入 DeepSeek Harness（DSH）AI agent** 的一套自托管工具：QQ 好友/群聊的消息变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）发回 QQ。在 QQ 里即可让 AI 联网搜索、搜图发图、保存表情包、写日记、发表 QQ 空间说说、发语音、刷抖音，以及在管理员授权下操控电脑完成跨应用自动化任务。

> ⚠️ 本项目是独立的第三方互操作性项目，与腾讯公司及 QQ 无任何隶属、合作、授权或背书关系。使用非官方协议工具接入平台可能违反平台条款并导致账号风险，请仅用于个人学习研究，风险自负。详见 [qq-bridge/RULES.md](qq-bridge/RULES.md)。

---

## 4. 目录结构与模块

```
├── qq-bridge/     核心桥接 + Web 控制台 + MCP 工具集（主仓库）
├── qq-image/      网络图片检索与发送插件
├── qq-diary/      角色日记（定时 + 聊天内写日记）
├── qq-douyin/     刷抖音插件 + 通用电脑操控运行时
├── qq-QQKJ/       QQ 空间说说的本机配图白名单目录（images/）
├── SnowLuma/      第三方运行时（不随仓库分发，自行下载）
└── 一键启动QQ桥接.bat   Windows 一键启动脚本
```

### 4.1 [qq-bridge/](qq-bridge/) —— 核心桥接

> 📌 归属说明：qq-bridge 是 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的项目，整体由 Derpyu520 制作；其中**发表 QQ 空间说说**与**第三代仿真**两个功能由 HYZDQ 制作，其余部分均为原作者作品。

QQ ↔ DSH 的消息桥接、会话管理、工具封装与安全闸门。

**核心运行时（src/）**

| 模块 | 功能 |
|---|---|
| `bridge.js` | 主进程：SnowLuma/OneBot 连接、消息收发、会话生命周期、白名单/黑名单（fail-closed）、发送限速、熔断与自愈 |
| `dsh-client.js` | DSH Web API 客户端：Cookie 离线铸造鉴权、斜杠 RPC、`remote.mux` 事件流，兼容 DSH 0.1.2/0.1.5 协议 |
| `mcp-snowluma-safe.js` | QQ 收发 MCP 工具（`qq_send_message` 等）：只暴露聊天动作、禁管理类操作，发送走桥接闸门 + confirm 校验 + 收据去重 |
| `mcp-web-search-safe.js` | 联网工具：只读 `web_search` / `web_fetch`，查询词清洗、内网地址拦截，优先走 DSH 同源 DeepSeek 搜索 |
| `mcp-qzone.js` + `qzone.js` | **QQ 空间说说**（详见下方独立小节） |
| `send-voice-lib.js` | QQ 语音合成与发送（ffprobe 探测、音量处理），供桥接与独立语音工具复用 |
| `sticker-lib.js` | 表情包知识库：QQ 收藏表情合并、emoji/md5/url 查找、备注标签搜索、按语境生成表情策略注入 |
| `role-card.js` | 角色卡/人格系统（群聊/私聊分卡的「人格分裂」模式） |
| `slang-learner.js` | 网络用语/梗学习，降低 AI 味 |
| `sensitive.js` / `safe-fetch.js` | 敏感内容检测拦截 / 带 SSRF 防护的联网抓取 |
| `forward.js` / `history-archive.js` | 消息转发 / 会话历史归档 |
| `md-to-plain.js` / `model-prices.js` / `qq-model-view.js` | Markdown 渲染 / 模型价格表 / 用量花费视图 |
| `computer-event-bridge.js` | 电脑操控事件桥（消费抖音新动静事件，触发桌面联动任务） |
| `mcp-host-server.js` | MCP 工具宿主 |

**QQ 空间说说**（HYZDQ 制作）—— 让 AI 拥有能发说说的 QQ 空间：

- **5 个 MCP 工具**：`qzone_draft`（起草，返回 draftId）→ `qzone_publish`（发布，必须带 draftId + `confirm=true`）→ `qzone_list`（查最近说说）→ `qzone_delete`（删除，需 confirm）→ `qzone_status`（状态查询）
- **草稿 → 主人确认 → 发布 → 回读核实** 的完整闭环：草稿 30 分钟过期，发布必须显式确认，MCP 只是薄封装（全部经桥接 `/api/socialV2/qzone/*`，带 `x-agent-call` 防 confused deputy，不直连 OneBot）
- **主动发布**：每天随机 1~3 条「想发就发」（240~480 分钟随机间隔），支持静默时段、每日上限（6 条）、正文上限 1000 字
- **配图**：支持 URL / 本机白名单目录图片（`qq-QQKJ/images`）/ 联网搜图候选，最多 9 张、单张 8MB；主动发布配图概率 30%
- **安全**：`auditQzoneText` 发布前审计正文敏感内容、`auditQzoneImageUrl` 校验配图、本机图片白名单校验；起草走专用预设 `qzone-writer`
- 配置集中在 `config.json` 的 `qzone.*`，默认关闭（`enabled: false`），完整字段见 [docs/guides/QZONE.md](qq-bridge/docs/guides/QZONE.md)

**其他目录**

| 模块 | 功能 |
|---|---|
| `plugins/qq-agent-presets/` | DSH agent 预设管理：`qq-chat`（一代）、`qq-chat-v2`（二代仿真/reserved2）、`qq-chat-v3`（三代仿真）、`qzone-writer`（空间起草），含工具白名单与安全边界约束 |
| `plugins/qq-mode-console/` + `public/console.html` | 本地 Web 控制台（`http://127.0.0.1:3100`）：运行总览、会话与审批、人格与角色、三代仿真参数、黑话词库、令牌与花费、访问与安全、调试与运维 |
| `src/simulation/` | 三代仿真（GEN3）9 模块：`rhythm` 打字节奏 / `style` 去 AI 味 / `memory` 长期记忆 / `persona` 人设锚点 / `attention` 注意力 / `affect` 情感 / `proactive` 主动性 / `sticker` 表情 / `surface` 表现面，配置单一源 `socialV3.*`，支持灰度与一键回滚 |
| `src/surface/` | 表现面（Surface）统一接入层：搜索脱敏、预算控制、日记→空间草稿、周记月记生成等跨面协同 |
| `dsh/agent-presets/` | 预设定义文件（agent.cordis.yml 提示词等） |
| `scripts/` | 安装器（`setup-dsh.mjs`）、预设构建、隐私扫描（`privacy-scan.mjs`）、100+ 项回归测试（`test-*.mjs`） |
| `docs/` | 使用文档与指南（安装、空间说说、安全基线、控制台测试等） |

### 4.2 [qq-image/](qq-image/) —— 网络图片检索与发送

搜真图发真图：`image_search` 联网检索候选 → 视觉模型看过缩略图后挑选 → `image_send` 下载原图发出。必须先挑选再发送，搜不到如实失败，所有外发走桥接闸门。

### 4.3 [qq-diary/](qq-diary/) —— 角色日记

每天 22:00 自动给 QQ 角色写一篇 200~400 字第一人称日记，存本地 Markdown，写完给主人发摘要；聊天里说「写日记」也能写，带 8 个 `diary_*` MCP 工具，可走日记摘录 → 空间草稿流程。

### 4.4 [qq-douyin/](qq-douyin/) —— 刷抖音 + 通用电脑操控

包含两个子模块，通过**主干-分支架构**打通：`computer-use` 是主干（通用电脑操控运行时），`dsh-douyin-agent-v2` 是分支（抖音领域包），两者共享人格记忆与额度账本。

#### ① `dsh-douyin-agent-v2/` —— 刷抖音插件

DSH 插件（cordis，host 半端）。主人（ownerQQ）在 QQ 私聊说「去看看抖音」→ agent 调 `douyin_*` 工具用无头浏览器/接口采集 → 把值得的内容用「自己的话 + 抖音分享卡片」发回 QQ。只服务主人私聊，群聊一律不碰；读用接口、写用无头页内 fetch，只有看画面/扫码才起有头浏览器。

**工具面**（`lib/engine/tool-definitions.mjs` + `lib/tools.mjs`）：

| 工具组 | 功能 |
|---|---|
| `douyin_open` / `douyin_search` / `douyin_open_video` | 打开推荐流、搜索、打开指定视频 |
| `douyin_next` / `douyin_previous` / `douyin_pause` / `douyin_play` | 换片、暂停、播放 |
| `douyin_status` / `douyin_observe` / `douyin_screenshot` | 页面状态、元素观察、看真实画面 |
| `douyin_video` / `douyin_comments` / `douyin_feed` / `douyin_scout` | 视频详情、评论区、逛流、巡查 |
| `douyin_comment_reply` / `douyin_comment_mention` | 回复评论、回复并 @（走原生 UI，对方才收到通知） |
| `douyin_notices` / `douyin_at_me` / `douyin_im_read` / `douyin_dm` | 新动静、评论区 @我、私信读取/发送（发送前二次核对对端） |
| `douyin_chat_*`（`chat_contacts/status/start/stop/read/observe`） | 私信联系人、自动回复管理、聊天读取与观察 |
| `douyin_tell_owner` / `douyin_report` / `douyin_video_limits_status` | 分享给主人（卡片先发文字后发）、日报、额度查询 |
| `douyin_run` / `douyin_autoreply_*` / `douyin_spark_*` | 后台自主刷、私信自动回复、主动分享（默认关闭，外发带 confirm） |
| `douyin_remember` / `douyin_recall` / `douyin_persona` / `douyin_login` / `douyin_setup` / `douyin_doctor` / `douyin_config` | 记忆、人格、登录（扫码拉有头浏览器）、配置、自检 |

**自主引擎**（`lib/engine/`）：`autonomous-watch.mjs` 自主观看（按人格兴趣自己搜索/换片/决定继续或停）、`autonomous-comments.mjs` 自主评论（默认每日 3 次、单轮 1 次、同一作品只评一次）、`autonomous-share.mjs` 主动分享（基于共同观察证据）、`chat-agent.mjs` / `api-agent.mjs` 双执行通道、`browser-host.mjs` / `browser-launcher.mjs` 浏览器宿主与 CDP 启动。

**共享层**（与 computer-use 主干同源，2026-10-27 重组）：

- `lib/pack.mjs` —— **抖音领域包**，实现 DomainPack 契约（`matches/observe/actions/prompt/policyExt/plan/handlesGoal`），供 computer-runtime 调用
- `lib/persona-memory.mjs` —— 共享人格卡 / 观看证据 / 兴趣台账（软件版与插件版共用）
- `lib/video-limits.mjs` —— 刷视频轮次额度（单轮时长 + 每日时段 + 人工开新一轮）
- `lib/daily-report.mjs` —— 观看日报（按留存的观察/行为证据生成 Markdown）
- `lib/qq-persona.mjs` —— **人格直接跟随 qq-bridge 角色系统**（读 `state/current-role.json`，人格分裂模式取私聊卡）
- `lib/computer-event.mjs` —— 跨插件事件桥：抖音「新动静」落事件文件 → 电脑操控运行时收件箱 → 触发桌面联动任务（仍受管理员配置/急停/预算/冷却约束）

**安全边界**：外发工具一律带 `confirm` 闸门，每日/每轮次数上限，24 小时同目标同内容去重，连续失败熔断，数据独立存 `$DSH_HOME/douyin-agent/`。

#### ② `computer-use/` —— 通用电脑操控 Agent 运行时

自主操作 Windows 电脑上的**所有软件**（桌面应用、浏览器、自绘界面），抖音只是其中一个领域包。核心实现在 `packages/computer-runtime`（根 `computer/` 目录为兼容垫片）。结构化感知主路径秒级（UIA ≤2s、DOM ≤1s），视觉仅兜底（截图→识图→点击→再截图确认）。

**工具面**（25 个 `computer_*`，按安全等级分组）：

| 工具组 | 功能 |
|---|---|
| 感知：`computer_status` / `computer_screen` / `computer_observe` / `computer_wait` / `computer_receipts` / `computer_windows` | 状态、截图、元素观察（稳定 id 跨观察有效）、等待、回执、窗口列表 |
| 操作：`computer_click` / `computer_type` / `computer_key` / `computer_move` / `computer_scroll` / `computer_drag` / `computer_clipboard` | 点击/输入（中文走剪贴板粘贴）/快捷键/移动/滚动/拖拽/剪贴板 |
| 浏览器：`computer_browser_observe` / `_open` / `_click` / `_fill` / `_download` | 浏览器域操作 |
| 任务：`computer_task_start` / `_status` / `_pause` / `_resume` / `_stop` | 任务状态机（checkpoint、预算、幂等） |
| L2 系统级：`computer_shell` / `computer_settings` | 本地命令与运行设置（仅 `power` profile + 确认） |

**领域包**（`packs/registry.mjs`）：内置 `douyin` / `browser` / `explorer` / `office` 领域包，`packs.json` 启用清单 + `packs.d/` 外部领域包加载机制；抖音领域包即分支端的 `lib/pack.mjs`。

**任务状态机**（`tasks/state-machine.mjs`）：`computer_task_start` 带 `budget`（`maxSteps` / `maxWrites` / `maxWallMs`），每个工具调用记账，写操作额外计数，预算耗尽自动暂停（`BUDGET_EXHAUSTED`），支持暂停/恢复/中止与 checkpoint 断点。

**安全机制**（fail-closed）：

- 桌面写操作**仅管理员私聊可发起**（群聊/非管理员一律拒绝）；首次调用返回 `needsConfirm`，携带确认令牌（工具/参数匹配、未过期）二次调用才执行
- `apps` / `domains` 白名单 + 标题黑名单 + STOP 急停开关；锁屏/关窗等系统级危险快捷键永久拒绝
- 全程审计日志（`audit.mjs`），策略核心见 `policy.mjs` 的 `assertAdminControl()` / `checkWriteAllowed()`

**其他**：`desktop/` 为独立 Windows 桌面软件版（对话式下任务），`skill/SKILL.md` 为 agent 技能说明，开发文档见 [docs/computer-agent-development.md](qq-douyin/computer-use/computer-use-main/docs/computer-agent-development.md)。

> ⚠️ computer-use 主干包源自第三方适配项目（package 名 `dsh-douyin-browser-local`，上游 [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent)），其上扩展了通用电脑操控运行时；上游版权归原作者，详见该仓库说明。

### 4.5 [qq-QQKJ/images/](qq-QQKJ/) —— 空间配图白名单目录

QQ 空间说说的本机图片白名单：发布说说携带的本机图片必须落在该目录内才被接受，也是主动发布自动配图的取图目录。不可删除，留空不影响其他功能（详见第 2 节「特殊目录说明」）。

---

## 5. 环境要求

- Node.js ≥ 22.13
- 运行中的 **DeepSeek Harness Web**（DSH，默认 `http://127.0.0.1:3080`）
- **SnowLuma**（QQ 协议端，第三方，不随本仓库分发）：从 <https://github.com/SnowLuma/SnowLuma/releases/latest> 下载解压，双击 `launcher.bat`
- Windows（主要测试平台）

## 6. 安装与使用（从零开始）

1. **确认 DSH 已运行**：浏览器打开 `http://127.0.0.1:3080`
2. **装桥接**：`cd qq-bridge && npm install && copy config.example.json config.json`，填好 `snowluma` 端点、`ownerQQ`、`allow` 白名单（空白名单不响应任何消息）
3. **DSH 端安装**：`node scripts/setup-dsh.mjs`，装完**必须重启 DSH**
4. **启动 SnowLuma**：WebUI 里扫码登录 QQ、开启 OneBot WebSocket（默认 3001）与 HTTP API（默认 3000）
5. **启动桥接**：`npm start`（崩溃自动重启用 `start.bat` / 根目录一键启动脚本），看到「SnowLuma 已连接」即成功
6. **可选插件**：
   - qq-image：`setup-dsh.mjs` 已注册 `mcp-image`，无需单独启动
   - qq-diary：`cd qq-diary && npm install && copy config.example.json config.json && node index.js --check && node index.js`
   - qq-douyin 刷抖音：DSH 插件形式安装（`dsh plugin add`），登录抖音后私聊指挥
   - qq-douyin 电脑操控：经由 DSH 安装 computer-runtime，在管理员私聊发起任务

## 7. 使用入口

| 入口 | 说明 |
|---|---|
| QQ 私聊 / 白名单群 | 聊天、搜索、发图、写日记、发说说、发语音 |
| 主人 QQ 私聊 | 指挥刷抖音（「去看看抖音」）、发起/确认/暂停/恢复/中止电脑操控任务（群聊与非管理员一律拒绝） |
| Web 控制台 `http://127.0.0.1:3100` | 模式切换（一代/二代/三代仿真）、白名单、人格编辑、仿真参数、审计 |

## 8. 测试

```bash
cd qq-bridge && npm run test:audit && npm run test:token    # 桥接回归（100+ 项 test-*.mjs）
cd qq-image  && npm test                                    # 图片检索单测
cd qq-diary  && npm test                                    # 日记测试
cd qq-douyin\computer-use\computer-use-main && npm test     # 电脑操控契约/策略/回归测试
cd qq-douyin\dsh-douyin-agent-v2 && npm run check           # 抖音插件语法自检（npm run doctor 环境自检）
```

## 9. 安全与隐私

- **fail-closed**：空白名单不响应任何消息；对外写操作（消息/评论/私信/说说）统一受 confirm 校验、熔断、去重、审计日志保护
- **数据本地化**：`config.json`、`state/`、日记、聊天记录、抖音数据（`$DSH_HOME/douyin-agent/`）全部只存本地；仓库只保留空文件夹（`.gitkeep`），聊天记录/日记/照片永远不会随仓库分发
- 电脑操控写操作仅管理员私聊可发起，携带确认令牌二次确认，危险快捷键永久拒绝
- 权限边界见 [qq-bridge/RULES.md](qq-bridge/RULES.md)

## 10. 许可证

- 本工作区自研代码：MIT（子仓库 [qq-bridge/LICENSE](qq-bridge/LICENSE) 同为 MIT）
- qq-bridge 归属：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（其中 QQ 空间说说、第三代仿真由 HYZDQ 制作）
- computer-use 主干包含第三方组件（上游 [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent)、Windows-MCP、Playwright），版权归原作者，遵循其各自许可
- SnowLuma 为第三方软件（源码可见非商业许可 + EULA），不随本仓库分发，请至官方渠道获取
- 图片检索/转发的版权与平台 ToS 风险由使用者承担
