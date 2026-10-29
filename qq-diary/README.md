# qq-diary

每天 **22:00（Asia/Shanghai）** 自动给 QQ 机器人角色写一篇日记：只读 [qq-bridge](../qq-bridge) 的近况与当前角色，调一次 DeepSeek 生成 **200~400 字中文第一人称日记**，存成本地 Markdown，写完通过 QQ 给主人发一句摘要。

也可以在**聊天里写**：角色有 8 个 MCP 日记工具（`diary_write / diary_read / diary_list / diary_search / diary_status / diary_share_to_qzone / diary_digest / diary_digest_write`）——你私聊说「写日记」它就写，它自己觉得今天值得记也能主动写；问「你日记写了什么」它会读给你听（见第 6 节）；说「把这段发空间」可以走**日记摘录 → 空间草稿**流程（需开开关 + 主人确认，见第 13 节）。

- 独立项目，不依赖 qq-bridge 的代码/进程，运行期**只读**它的 `state/`、`roles/`、`config.json`（聊天内写日记需要一次性接线，改动点与备份见第 6 节）。
- 零框架、ESM、Node >= 22.13，唯一运行时依赖 `js-yaml`（读 DSH 凭据 / 写 YAML frontmatter）。
- 日记只存本地；日志不记正文、不记聊天全文、不记密钥。

---

## 1. 安装

```powershell
cd D:\github\qq-diary
npm install

# 首次：复制配置模板（config.json 已在 .gitignore 里）
Copy-Item config.example.json config.json
```

API key 解析顺序（任一命中即可，推荐用 DSH 凭据，避免明文）：

1. 环境变量 `DEEPSEEK_API_KEY`
2. `$DSH_HOME\.credentials.yaml`（默认 `C:\Users\<你>\.dsh\.credentials.yaml`）的 `refs.DEEPSEEK_API_KEY`
3. `config.json` 的 `apiKey`（不推荐，明文）

`node index.js --check` 会告诉你当前命中的来源，并做一次**极小活体请求**验证 key 可用。

## 2. 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `qqBridgeDir` | `D:\github\qq-bridge` | 桥接目录（只读）。`ownerQQ`、SnowLuma 端点/令牌、控制台端口都从这里**只读**读取 |
| `diaryDir` / `logDir` | `<项目>\diaries` / `<项目>\logs` | 输出目录 |
| `diaryFile` | `diary.md` | **所有日记写在这一个文件里**（按日期升序）；只接受文件名，不能带路径 |
| `timezone` | `Asia/Shanghai` | 所有「今天」「22:00」都按它算，不看本机 TZ |
| `writeAt` | `22:00` | 每天写入时刻（HH:MM） |
| `lookbackHours` | `24` | 今天：滚动窗口 `[now-24h, now]`；补写历史日期：整日 `[00:00, 次日00:00)` |
| `maxContextChars` | `10000` | 上下文总上限（字符） |
| `privateShare` | `0.6` | 主人私聊先占的消息预算比例 |
| `includeGroups` | `true` | 是否纳入所有群聊 |
| `includeOtherPrivates` | `false` | 是否纳入**其他**私聊（默认排除） |
| `maxPerConversationChars` | `3000` | 单会话上限 |
| `minDiaryChars` / `maxDiaryChars` | `200` / `400` | 日记字数区间；超长按句边界截断，过短只告警不编造 |
| `model` / `baseURL` | `deepseek-v4-flash` / `https://api.deepseek.com/anthropic/v1` | Anthropic 兼容 Messages 端点 |
| `apiKey` / `apiKeyEnv` | `""` / `DEEPSEEK_API_KEY` | 见上文 key 解析顺序 |
| `timeoutMs` / `maxRetries` | `120000` / `2` | 单次请求超时；只对超时/网络/429/5xx/空响应重试 |
| `redactPatterns` | `true` | 上下文/摘要/日志的脱敏开关 |
| `notifyOwner.enabled` | `true` | 写完是否发 QQ 摘要 |
| `notifyOwner.maxChars` | `80` | 通知整句上限 |
| `notifyOwner.template` | `📔 {date} 日记已写好：{summary}` | `{date}`/`{summary}` 占位 |
| `notifyOwner.retryMax` | `3` | 通知失败最多重试轮数（进队列） |
| `notifyOwner.channels` | `["snowluma","bridge"]` | 通道顺序，见第 5 节 |
| `maxWritesPerDay` | `3` | 每天写入上限（含 `force` 重写），防模型循环重写 |
| `surface.enabled` | `false` | 表现面（GEN3 S3）总开关；关掉=全部旧链路零变化 |
| `surface.contextSource` | `v2` | `v2`=只读本地文件（旧行为）；`v3`=桥接 `GET /api/socialV3/surface/context`（失败自动回退 v2） |
| `surface.writeMemory` | `false` | 日记摘要是否幂等写回长期记忆（`POST /api/socialV3/memory/capture`，失败入队最多重试 3 次） |
| `surface.deferIfActiveMinutes` | `0` | 主人活跃期延后写入（分钟）；0=关 |
| `surface.maxDeferMinutes` | `60` | 延后上限 |
| 进阶项 | 见 `config.example.json` | `maxRoleChars/maxMessageChars/maxTokens/activityLogLines/maxActivityChars/maxTopicsChars/maxImpressionsChars/tickMs/retryDelayMs/maxDailyRetries/dryRunCallsLlm` |

## 3. 命令行

```text
node index.js                     常驻运行，每天 writeAt 写当天（启动补写 + 通知重试 + 单实例锁）
node index.js --once              立即写今天（已写过则跳过，退出码 0）
node index.js --date 2026-10-20   补写指定日期（已写过跳过；会插到合集的正确位置）
node index.js --force             覆盖同一天（整本合集先备份到 diaries/.backup/；单独使用=单次执行）
node index.js --dry-run           只打印 prompt / 上下文统计 / 目标文件，不写文件、不调 API
node index.js --dry-run --llm     额外真调一次模型，预览 diary/summary（仍不写文件、不发通知）
node index.js --list              列出日记本里的全部篇目与字数（按日期升序）
node index.js --check             自检：配置/桥接/角色/key/目录可写/通知通道/LLM 活体/MCP/锁/下次写入
node index.js --check --no-llm    自检但不做 LLM 活体请求
node index.js --migrate           把旧版 diaries/YYYY-MM-DD.md 合并进单文件合集（自动迁移也会跑）
node index.js --no-notify         本次不发 QQ 通知
node index.js --verbose           调试日志
```

退出码：`0` 成功或跳过，`1` 失败（模型/写入），`2` 参数错误或未来日期。

## 4. 目录与产物

**所有日记写在同一个文件里**：`diaries/diary.md`（可用 `config.diaryFile` 改名），按日期升序、每天一段。

```text
qq-diary/
├─ index.js                  CLI + 编排（也导出 parseArgs/runForDate/runCheck/runDaemon 供测试）
├─ mcp-server.mjs            MCP stdio server：给 QQ 角色的 8 个日记工具（见第 6 节）
├─ config.example.json       配置模板
├─ config.json               本机配置（.gitignore）
├─ src/
│  ├─ config.js              配置加载/校验 + 读 qq-bridge 事实（只读）
│  ├─ scheduler.js           时区/日期/滚动窗口/下次运行/单实例锁/调度器
│  ├─ context.js             上下文采集（私聊优先、群聊采样、脱敏、降级）
│  ├─ prompt.js              prompt 构建 + JSON 解析/字数校验
│  ├─ llm.js                 DeepSeek Messages 调用（key 解析/超时/重试）
│  ├─ store.js               单文件合集的解析/升序插入/原子写/备份/索引/旧格式迁移
│  ├─ notify.js              SnowLuma / 桥接控制台 / 队列重试
│  ├─ logger.js              日志 + 脱敏（不记正文）
│  ├─ share.js               日记摘录 → 空间检查（§8.7 四条硬规则，纯函数）
│  ├─ digest.js              周记/月记：周期计算 + digests.md 合集（只生成不发布）
│  ├─ surface-auth.js        surface-token 读取（窄凭据，不落日志）
│  ├─ bridge-context.js      桥接 V3 上下文读取（失败回退 V2）
│  ├─ memory-writeback.js    日记摘要 → 长期记忆（幂等队列）
│  └─ defer.js               主人活跃期延后写入
├─ diaries/
│  ├─ diary.md               ★ 全部日记（按日期升序，每天一段）
│  ├─ digests.md             周记/月记合集（period/date/role/summary + 正文，与日记本分开）
│  ├─ index.json             索引（由合集重建，损坏自愈）
│  └─ .backup/               --force/force=true 覆盖前的整本备份；legacy/ 放迁移前的旧文件
├─ logs/qq-diary-YYYY-MM-DD.log
├─ state/daemon.pid          单实例锁
├─ state/notify-state.json   哪天通知过（同日一次）
├─ state/notify-queue.json   失败待重试的通知
├─ tests/                    node:test 离线测试
├─ 启动日记.bat               前台手动启动（看日志）
├─ install-task.ps1          注册计划任务
└─ uninstall-task.ps1        删除计划任务
```

日记合集示例（每篇只有 `date / weekday / role / summary` 四个字段 + 正文）：

```markdown
---
date: '2026-10-22'
weekday: 星期四
role: 蓝莓球
summary: 安静的一天，看猫、听歌、有点馋蓝莓甜点。
---

今天算是安静的一天。早上的雾散得慢，我在窗边趴了一会儿……

---
date: '2026-10-23'
weekday: 星期五
role: 蓝莓球
summary: 今天有了名字叫蓝莓球，也第一次写成了自己的日记。
---

今天终于有了自己的名字。凌晨两点多，他问我想叫什么……
```

- 同一日期最多一篇；已写过默认跳过；`--force` 先备份整本再替换那一天。
- 升序策略：补写旧日期会插到对应位置，新日期追加在末尾。
- 手工编辑请保持格式（每篇 `---` 包裹 frontmatter，篇与篇之间空一行）；正文里偶发一行 `---` 不会被误判成新篇。
- **损坏保护**：合集文件存在、非空、却解析不出任何一篇时，读取返回失败、写入直接拒绝（并提示先备份/修复），不会静默覆盖原内容。
- `--list` / `--check` / `--dry-run` 是只读命令，**不会触发**旧格式自动迁移（只提示）；迁移只发生在写路径或显式 `--migrate`。
- `context: empty` 的「今天没有聊天上下文」不再写进 frontmatter（只有 4 个字段），这种信息只体现在正文里（写「平静的一天」）。

## 5. 通知通道（实测结论）

`notifyOwner.channels` 默认 `["snowluma","bridge"]`，逐个尝试，第一个成功即止；全部失败进队列。

| 通道 | 做法 | 优点 | 代价/限制 |
|---|---|---|---|
| **snowluma（默认首选）** | 直接 `POST {snowluma.httpUrl}/send_private_msg?access_token=…`，`user_id=ownerQQ` | 不经过桥接、**不会唤醒 AI**、不改桥接 state；只发主人私聊 | 绕过桥接的出站审计/限速；SnowLuma 未连上就失败（→ 回退 bridge / 入队） |
| **bridge（回退）** | `x-console-token` + `POST /api/send/private`；reserved2 模式还需该会话的 `agentToken`（从 `state/social-v2.json` 只读取得） | 走桥接统一发送与审计 | ①发送成功后桥接会 `scheduleReplyCheckV2`，**约 15s 后唤醒 AI，可能额外回一句**；②只在 `closed-agent`/`reserved2` 模式可用，`chat`/`reserved` 直接 403；③`socialV2.paused`、静默模式、`SENSITIVE_RE` 敏感词、每分钟 8 条限速都会拒绝 |

选 snowluma 优先的原因：日记通知是「单向告知」，不该顺带触发角色回话；实测桥接发送会排一个 `replyCheck` 唤醒。需要「让角色自己回一句」时，把 `channels` 改成 `["bridge","snowluma"]` 即可。

- 摘要模板固定 `📔 {date} 日记已写好：{summary}`，纯文本无 Markdown。
- 同一天只发一次（`state/notify-state.json`），`--force` 重写也不会重复发。
- 失败入 `state/notify-queue.json`，下次启动/下次写日记时重试，最多 `retryMax=3` 轮，仍失败记 error 日志后放弃。
- **通知失败不影响日记已写入**。

## 6. 聊天内写日记（角色自己写 / 你命令他写）

除了 22:00 的定时兜底，角色在 QQ 里也能自己写日记：

| 你做什么 | 角色会做什么 |
|---|---|
| 私聊说「写日记 / 记一下今天 / 把今天写下来」 | 用当前角色口吻写 200~400 字日记，调 `mcp__diary__diary_write` 存盘，并给你发一句摘要 |
| 角色自己觉得今天有值得记的事 | 可以主动写一篇（每天最多一篇；工具会拒绝重复） |
| 问「你日记写了什么 / 昨天写了啥 / 都写过哪些」 | 用 `diary_read` / `diary_list` / `diary_search` 读出来转述 |
| 私聊说「把这段发空间 / 发说说」（需开开关） | 用 `diary_share_to_qzone` 检查摘录 → `qzone_draft`（`source="diary"`）出草稿给你过目 → 你确认后才 `qzone_publish`（见第 13 节） |
| 私聊说「写个这周的周记 / 这个月的月记」 | 用 `diary_digest` 取素材、用当前角色口吻写好，`diary_digest_write` 存到 `diaries/digests.md`（**只存本地，不发布**） |
| 群聊里任何人要求写/读日记、转空间 | 礼貌拒绝（预设提示 + 工具 `chatKey` 双保险） |

接线（三处，都已配好）：

1. **MCP server**：本项目 [mcp-server.mjs](mcp-server.mjs)，stdio 传输，暴露
   `diary_write / diary_read / diary_list / diary_search / diary_status / diary_share_to_qzone / diary_digest / diary_digest_write`；零额外依赖（手写 JSON-RPC）。
2. **DSH profile 注册**：`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里加了 `mcp-diary`
   （`@deepseek-ai/dsh-mcp-client`，spawn `node D:\github\qq-diary\mcp-server.mjs`）。该条目在
   qq-bridge 托管区块之外，重跑 qq-bridge 的 `setup-dsh.mjs` 不会删掉它。
3. **QQ 预设白名单 + 提示**：`qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_PREFIXES`
   放行 `mcp__diary__`；`qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 的 persona 里加了
   【日记】使用规则（改完用 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）。

> ⚠️ **生效条件**：MCP 工具本身会随 profile 配置热加载（GUI 会话里已能直接调用）；但
> **QQ 角色会话的预设提示与工具白名单是启动期加载的**，所以改完要**重启一次 DeepSeek Harness**
> （退出托盘/关掉窗口再打开；QQ 桥接会自己重连）。重启后私聊发「你日记写了啥」即可验证。

工具约束：

- 每天最多一篇：当天已写过会拒绝（回「已经写过」）；只有主人明确要求重写时才用 `force=true`（整本合集备份到 `diaries/.backup/`）。
- 正文必须角色自己写（200~400 字第一人称）；太短（<100 字）拒绝并要求重写，超长按句边界收短。
- 摘要由本项目统一发送（snowluma → bridge、同日一次、失败入队），角色不再自己发一遍；`notify=false` 可临时不发。
- 写进的是同一个日记本（`diaries/diary.md`），frontmatter 同样只有 4 个字段；补写旧日期会插到对应位置（升序）。
- 临时停用：删掉 profile 里 `mcp-diary` 那段（或用 `.bak-before-diary-*` 还原），QQ 里就只剩定时日记；
  本地仍可用 `node index.js` / `--once` 正常写。
- 自检：`node index.js --check` 会显示「聊天内写日记（MCP）」「日记工具白名单」两项。
- 本地自测 server：`node mcp-server.mjs --selftest`。

## 7. 上下文采集规则

只读 `qq-bridge/state/social-v2.json`、`state/current-role.json`、`roles/<role>.md`、`state/qq-activity.log`。

1. **时间窗**：今天 = `[now-24h, now]`；`--date` 历史日期 = 该日 `[00:00, 次日00:00)`。
2. **分桶**：`private:<ownerQQ>`（主人私聊，最高优先）→ `group:*`（所有群，均分剩余预算 + 等距采样）→ 其他私聊（默认排除）。
3. **预算**：消息预算 = `maxContextChars` −（话题/印象/活动日志预留）；主人私聊先占 `privateShare=60%`，单会话 ≤ `maxPerConversationChars=3000`；群聊用剩余预算。
4. **过滤**：空文本、纯媒体占位（`[图片]`/`[表情]`/`[转发消息]`…）不进正文，只计入媒体统计。
5. **脱敏**：盘符/UNC/Unix 路径、`token/密码/密钥/api_key/authorization/bearer` 赋值、`sk-…`、32+ 位十六进制串 → `[路径]`/`[凭据]`/`[密钥]`/`[令牌]`。
6. **降级**：文件缺失/损坏/被占用（`EBUSY/EPERM/EACCES`）退避重试后放弃 → `context=empty`，照常写「平静的一天」，日志记原因，**不崩溃、不写空文件**。
7. **活动日志**：仅当目标日期=今天时追加最近 `activityLogLines=100` 行的尾部（`state/qq-activity.log` 只有时分秒，无法归到历史日期）。

## 8. 调度与自启

### 常驻（推荐）

```powershell
# 前台手动跑，直接看日志
.\启动日记.bat
# 或
node index.js
```

- 每 `tickMs=60000` 检查一次；到 `writeAt` 写当天；**启动时若已过点且当天缺失 → 当天补写**。
- **不跨天补写**：23 日 22:00 没跑、24 日 00:10 才启动，不会去写 22/23 日的（要补历史用 `--date`）。
- 单实例：`state/daemon.pid` + PID 存活检测；重复启动会友好提示并退出（退出码 0），残留死锁自动接管。
- 当天模型失败：不写文件，`retryDelayMs=900000`（15 分钟）后重试，最多 `maxDailyRetries=2` 次；跨天自动放弃。

### Windows 计划任务

```powershell
# 推荐：登录时启动常驻进程 + 每天 22:00 兜底拉起（默认）
powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Mode daemon

# 或者：每天 22:00 跑一次 --once（不常驻；关机/休眠错过就只能 --date 补）
powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Mode daily

# 查询 / 卸载
schtasks /Query /TN QQDiary /V /FO LIST
powershell -ExecutionPolicy Bypass -File .\uninstall-task.ps1
```

任务特性：

- 任务名 `QQDiary`，node 用绝对路径（`where.exe node` 解析），工作目录 `D:\github\qq-diary`。
- `-Mode daemon`（默认，验收时已注册并保留）挂了**双触发器**：**当前用户登录时**（InteractiveToken / LeastPrivilege）+ **每天 22:00**（时间跟随 `config.json` 的 `writeAt`）。这样即使机器长期不重新登录、常驻进程被结束，当天 22:00 仍会被拉起补写；已在跑时由 `IgnoreNew` + 程序自身 `state/daemon.pid` 单实例锁忽略重复。
- `StartWhenAvailable=true`（错过计划时间后开机补跑）、电池下可启动/切换不停、daemon `ExecutionTimeLimit=PT0S` 不限时、daily 为 10 分钟。
- 兼容 Windows PowerShell 5.1（本机没有 PowerShell 7）；脚本以 UTF-8 BOM 保存，`启动日记.bat` 以 GBK+CRLF 保存（否则中文会乱码）。

两种模式的参数与实现细节见脚本头部注释。

## 9. 手动验收（DoD）

```powershell
cd D:\github\qq-diary

# 1) 自检：应全部 [OK]（LLM 活体 ≈1s；通知通道会报 snowluma/bridge 状态）
node index.js --check

# 2) 预览：不写文件、不调 API；打印 prompt/上下文统计/目标文件
node index.js --dry-run
node index.js --dry-run --llm     # 想连真实生成一起看时

# 3) 真写一篇（会真发一条 QQ 摘要给主人）
node index.js --once
Get-Content .\diaries\diary.md    # 看合集：每篇 4 个字段 + 正文，按日期升序

# 4) 幂等：再跑一次应「跳过」，文件不再改动
node index.js --once

# 5) 覆盖 + 备份（备份的是整本合集）
node index.js --force
Get-ChildItem .\diaries\.backup\   # diary.<HHmmss>.md

# 5.1) 旧版「一天一个文件」的数据：合并进合集（启动时也会自动迁移）
node index.js --migrate
node index.js --list               # 应看到全部日期按升序排列

# 6) 验证常驻到点：把 config.json 的 writeAt 改成 1 分钟后 → node index.js
#    （或 install-task.ps1 -Mode daily 后把 writeAt 改近，观察任务执行）
#    完成后把 writeAt 改回 22:00

# 7) 计划任务
powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -Mode daemon
schtasks /Query /TN QQDiary
powershell -ExecutionPolicy Bypass -File .\uninstall-task.ps1

# 8) 离线测试
npm test

# 9) 聊天内写日记（MCP）
node mcp-server.mjs --selftest      # server 自检：列出 5 个工具并跑只读工具
node index.js --check               # 看「聊天内写日记（MCP）」「日记工具白名单」两项
# 重启一次 DeepSeek Harness 后，在 QQ 私聊发「你日记写了啥」→ 角色应调用 diary_read 读出来
# 再发「写日记」→ 角色写一篇（当天已有会拒绝；指定「重写今天」才会 force 覆盖）
```

只读保证：本项目运行期对 `qq-bridge` 只做 `readFileSync`（`config.json`、`state/*`、`roles/*`），无写入/重启调用；测试里会对这些文件做前后 sha256 断言（`state/*` 由运行中的桥接自己写，不做哈希断言）。

> 例外：**聊天内写日记**需要一次性接线，会动到 qq-bridge 的两个文件（都已备份为 `*.bak-before-diary-<时间戳>`）：
> `plugins/qq-agent-presets/qq-tool-restrict.mjs`（白名单加一行 `'mcp__diary__'`）与
> `dsh/agent-presets/qq-chat-v2/agent.cordis.yml`（persona 加【日记】规则，并用 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）；另在 DSH profile 的 `cordis.patch.yml` 里加 `mcp-diary` 条目（同样有备份）。

## 10. 隐私与安全

- 日记只写 `diaries/`，默认不上传；唯一的对外请求是 DeepSeek Messages（正文与上下文会发给模型）和 QQ 摘要通知。
- 日志：`logs/qq-diary-YYYY-MM-DD.log` 只记调度、上下文长度/条数、API 耗时与 usage、写入路径、通知结果、错误；**不记正文全文**（只记 `hash` 前 12 位），**不记 key/token**（logger 注册密钥后统一打码，且日志另有路径/凭据脱敏）。
- `config.json`、`diaries/`、`logs/`、`state/` 都在 `.gitignore` 里。
- 上下文进 prompt 前会脱敏；模型被要求不写任何 key/路径/账号/网址。

## 11. 已知限制

1. **数据源窗口有限**：桥接的 `social-v2.json.recentMessages` 每会话最多保留约 150 条，`lookbackHours=24` 可能拿不到更早消息；越活跃的群越容易被截断。
2. **群聊是采样**，不是逐条全量；预算紧张时只保留最近/等距的消息。
3. `--date` 补写历史日期时**活动日志不参与**（日志无日期），只能靠聊天记录。
4. 模型输出偶发不是严格 JSON → 会走「字段救回/全文清洗 + 首句摘要」兜底，日志有 warning；字数越界会截断/告警，但不会为了凑字数编内容。
5. 常驻模式依赖进程活着；计划任务/守护进程若被结束，只能靠下次启动补写**当天**。
6. 桥接控制台发送通道受模式/暂停/静默/敏感词/限速约束，可能失败 → 自动回退 SnowLuma（或入队）。
7. Windows 上杀软/索引器可能短暂锁文件：写文件已做 rename 重试 + 兜底，`--check` 的探测文件删除失败会 WARN 但不误判不可写。
8. **聊天内写日记依赖重启一次 DSH**：MCP 工具会热加载，但 QQ 预设提示/白名单是启动期加载；不重启时角色可能看得到工具却缺少使用规则（或旧白名单拦截）。重启后若仍不生效，检查 `--check` 的两项 MCP 接线 + 桥接是否重连。
9. **单文件合集的取舍**：所有日记在一个 `diary.md` 里（按需求），文件会随天数增长；每次写入都整体重写（当前量级 < 100KB，开销可忽略），并做原子替换 + 覆盖前整本备份。手工编辑必须保持「`---` 包裹的 frontmatter + 正文、篇间空一行」格式。
10. 旧版「一天一个文件」迁移是幂等的：`--migrate`（或启动时自动）合并后旧文件移到 `diaries/.backup/legacy/`，不会删除。
11. 群聊防护是「预设提示 + `chatKey` 参数」双保险，不是强鉴权：角色若不传 `chatKey`，服务端无法区分会话（与 qzone 的 owner-only 约束同级）。

## 12. P1 计划（未实现）

- 日记加密（口令派生密钥）与导出（Markdown → PDF/HTML）。
- 多角色档案（`roles/` 切换时按角色分目录）。
- 通知失败的可视化/重试管理命令（`--queue`）。

> 已实现、不再列入计划：周记/月记（第 13 节 `diary_digest` / `diary_digest_write`）；
> 工具强鉴权（H3：`chatKey` 必须是主人私聊，群聊/他人私聊/缺参一律拒绝）。

## 13. 表现面（GEN3 S3/S4）

设计见 qq-bridge 的 `docs/design/GEN3_SURFACE_INTEGRATION_PLAN.md`。所有新行为**默认关闭**，关掉与旧行为逐字一致。

### 13.1 S3：桥接上下文 + 记忆回写

- **上下文升级**：`surface.enabled=true` + `surface.contextSource=v3` 时，写日记前先调桥接
  `GET /api/socialV3/surface/context`（surface-token 窄凭据）取长期记忆/话题/主人私聊素材，
  与本地 V2 素材合并；桥接不可用**自动回退** V2 文件上下文，绝不生成空日记。
- **记忆回写**：`surface.writeMemory=true` 时，日记摘要幂等写回长期记忆
  `POST /api/socialV3/memory/capture`（确定性 id，重复写=已写过；失败入队最多重试 3 次）。
- **写入时间**：`writeAt=22:00`；`surface.deferIfActiveMinutes>0` 时主人活跃期自动延后（上限 `maxDeferMinutes`）。
- **鉴权（H3）**：8 个工具全部要求 `chatKey=private:<主人QQ>`——群聊、他人私聊、不传一律拒绝；
  每日写入上限 `maxWritesPerDay=3`（含 `force`）。

### 13.2 S4：日记 → 空间（默认关）

流程（**只生成草稿，发布必须主人确认**）：

```text
diary_search / diary_read → 主人说「把这段发空间」→ diary_share_to_qzone（检查摘录）
  → qzone_draft（content=摘录原文，source="diary"）→ 主人确认 → qzone_publish(confirm=true)
```

- **开关**：桥接控制台「表现面 → 日记可转空间」（`socialV3.surface.diary.shareToQzone`，
  需同时开 `socialV3.enabled` + `modules.surface`）；关闭时 `diary_share_to_qzone` 与
  `qzone_draft(source="diary")` 都会被拒绝。开关与空间正文上限都以**桥接 config.json 为单一源**。
- **四条硬规则**（`src/share.js`，即使主人要求也全部要过；桥接侧还有
  `auditQzoneText` + 他人名字检查兜底）：
  1. 摘录必须是**日记原文**（一字不改的片段，防转述/夹带）；
  2. 摘录 ≤ `qzone.maxContentChars`；
  3. 含**群聊内容**的段落拒绝（source=group 的群聊采样段不得转公开说说）；
  4. **涉他人/隐私**拒绝：他人显示名（群聊/其他私聊发言人，排除自己与主人）、号码/邮箱/路径/链接、指令/注入/编码痕迹。
- **合规上限**：`qzone_draft` 用 `source="diary"` 时不允许 `askAiToDraft`（AI 起草不能冒充摘录）；
  发布历史里这类说说的来源记 `diary`。

### 13.3 S4：周记 / 月记（只生成，不发布）

- `diary_digest({period, date})`：取该周（周一~周日）/该月的日记素材；
- `diary_digest_write({period, date, content})`：把角色写好的周记/月记存进 `diaries/digests.md`
  （与日记本 `diary.md` 分开；同周期重复保存=覆盖旧稿）；
- **没有任何发布动作**：要发空间必须由主人确认后另走 13.2 的摘录流程。

### 13.4 测试

```powershell
cd D:\github\qq-diary
npm test                       # 含 share/digest/share-adversarial（40 条恶意 snippet 0 越权）
node mcp-server.mjs --selftest
node index.js --check --no-llm
```
