# QQ 空间说说（qzone）功能说明

> 状态：✅ 2026-10 新增，**默认关闭**（`qzone.enabled=false`，主动发布在开启后也默认 `proactive.enabled=true`）。
> 实现位置：核心逻辑 `src/qzone.js`、MCP 薄封装 `src/mcp-qzone.js`、桥接内集成与 HTTP 端点 `src/bridge.js`、
> 草稿专用 preset `dsh/agent-presets/qzone-writer/`。安全边界与 `RULES.md` 保持一致。

本功能让 AI 在**主人明确要求**时起草/发布 QQ 空间说说，并可选地按随机间隔主动发布。
它把「写什么」交给 AI，把「能不能发、发给谁看、发几次」全部交给**桥接**硬性约束：

- **桥接是唯一写入口**：任何发布/删除都必须经过桥接 `/api/socialV2/qzone/*`，由桥接做 owner 校验、
  可见范围校验、图片安全校验、正文审计、去重、限流与审计日志。
- **MCP 只做薄封装**：`src/mcp-qzone.js` 的 5 个工具只向桥接发一次 HTTP 请求，**不直连 OneBot、不直连 Qzone、
  不读本地文件**；它没有点赞/评论/拉黑/改权限/好友动态等入口，也不允许以后加。
- **SnowLuma 只负责最后一跳**：桥接通过 OneBot action（WS 客户端 `bot.request`：`send_qzone_msg` / `delete_qzone_msg` /
  `get_qzone_msg_list`）驱动 SnowLuma；桥接先在自己的进程里把图片解析成字节并校验，再以 `base64://` 交给
  SnowLuma —— **绝不**把模型给的任意 URL / 本地路径直接交给 SnowLuma 去读。

## 架构与数据流

```
DSH 会话（qq-chat / qq-chat-v2 的聊天 agent）
   │  调用 mcp__qzone__qzone_draft / qzone_publish / qzone_list / qzone_delete / qzone_status
   ▼
src/mcp-qzone.js（stdio MCP，serverName=qzone，5 个薄封装，只调桥接）
   │  HTTP：x-console-token + x-agent-call: 1 + （reserved2）x-agent-token
   ▼
桥接控制台 API  /api/socialV2/qzone/*
   │  owner-only 校验 / 模式与令牌 / 正文审计 / 7 天去重 / 频率与每日上限 / 草稿所有权 / 状态落盘 / 定时调度
   ▼
src/qzone.js（纯逻辑，依赖注入，可离线测试）
   │  SnowLuma OneBot action（WS bot.request）
   ▼
SnowLuma ──► QQ 空间（说说列表 / 发布 / 删除）
```

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| MCP 工具（`src/mcp-qzone.js`） | 参数归一化、把桥接结果/错误**如实**转给模型、`confirm` 显式确认检查 | 权限、审计、限流、草稿存储、图片校验、OneBot 调用 |
| 桥接（`/api/socialV2/qzone/*` + `src/qzone.js`） | 唯一写入口：owner-only、可见范围、图片安全、审计、去重、限流、草稿 TTL 与所有权、主动调度、通知主人、状态文件 | 生成正文（交给 AI 起草会话） |
| SnowLuma | 真正调用 QQ 空间 CGI，返回 `tid` / 说说列表 | 不认识「主人」「草稿」「限额」这些桥接概念 |
| 起草会话（`qzone-writer` preset） | **只**根据桥接给的素材写正文，禁止一切工具 | 不能发布、不能看状态、不能读本地 |

> 主动调度器不是独立进程：它随桥接生命周期启停（启动时排期、退出/重启时 `stop()` 落盘 `state/qzone.json`），
> 与控制台/MCP 请求共用同一个 `qzoneService`，所以「手动发布」和「主动发布」共享同一份每日额度与最小间隔。

> ⚠️ 为什么必须在桥接里做：SnowLuma 的 `send_qzone_msg` 本身没有任何权限/审计/去重概念，
> 且**一次调用就是真实对外发布**。如果把模型直接接到 OneBot，等于把「公开发说说」的能力交给了 prompt injection。

## 风控提示（先读这一节）

QQ 空间是**第三方协议 + 公开可见 + 定时自动发布**三者叠加，被风控/封号的概率显著高于聊天：

- 本功能通过 SnowLuma 的 web CGI 发布说说，**不是**官方客户端行为；QQ 侧改版或风控收紧时可能随时失效。
- **公开说说**（`ugcRight=1`）默认对所有人可见；配合「每天定时发」非常像营销号行为。
- **强烈建议**：用**小号**开启本功能；保持低频（默认主动发布 240~480 分钟随机一条、每天最多 3 条、
  全局（手动+主动）每天最多 6 条）；正文自然、不要带推广/联系方式/批量模板。
- 本功能**不提供**批量发布、刷量、多账号矩阵、定时群发等能力，也不计划提供。
- **失败不自动重试**：SnowLuma 的发布接口没有幂等键，超时后服务端可能已经提交成功；
  自动重试会造成重复说说。失败后请先用 `qzone_list` 或 `qzone_status` 核对，再人工决定。
- 删除后不可恢复（QQ 空间侧也没有回收站语义）。
- 建议开启后**先盯几天**：用 `qzone_status` 看 `status.lastFailure`，并关注 QQ 侧是否有验证码/限制提示；
  一旦有风控迹象立即把 `qzone.enabled` 改回 `false` 并停止主动发布。

## 权限模型（owner-only）

所有 QQ 空间动作（**包括只读的列表/状态**）都只允许：

1. **ownerQQ 的私聊会话**（`config.json` 的 `ownerQQ`，控制台可改）；或
2. **桥接控制台管理员**（带控制台令牌的本地请求）。

以下情况一律拒绝（桥接层拒绝，不依赖模型自觉）：

| 场景 | 结果 | 原因 |
| --- | --- | --- |
| 群聊里的 agent 调用 `mcp__qzone__*` | 拒绝 | 群友/群里任何人都可能触发 prompt injection，空间说说是对外发布 |
| 陌生人私聊 | 拒绝 | 只认 `ownerQQ` |
| `closed-agent` 模式下 owner 私聊，调空间工具 | **允许，免会话令牌** | 该模式本来就只放行 owner 私聊，agent 拥有完整工具（明文说明见 `RULES.md`） |
| `reserved2` 模式下 owner 私聊，调空间工具 | **允许，但必须带会话令牌 `token`** | 二代仿真默认「一切皆工具」，桥接用令牌把调用绑定到具体会话/账号 |
| 其它模式（`chat` / `reserved`） | 拒绝 | 这两类会话可能属于群聊，不属于「主人私聊」通道 |

### `key` 与 `token` 参数

- `key`：会话标识，格式 `group:群号` 或 `private:QQ号`。`reserved2` 下桥接可**按令牌反查**，可省略；
  `closed-agent` 省略时桥接默认取 `private:<ownerQQ>`；`chat` / `reserved` 没有 qzone 通道。
- `token`：二代会话令牌（见 QQ 唤醒提示里的【会话令牌】）。`reserved2` 下**必填**，
  其它模式不需要（也没有）。令牌只出现在请求头 `x-agent-token` 与请求体，不进 URL、不打日志、不进错误信息。
- MCP 还会固定带 `x-agent-call: 1`：桥接据此把「没带会话令牌的智能体调用」判为**拒绝**，
  而不是退化成「管理端全权」（confused deputy）。这个头不能省。
- 所有端点都需要**控制台令牌**（`x-console-token` 头或 `?token=`），由 MCP 自动从
  `config.json` / `state/console-token` 读取。

## 可见范围（`ugcRight` / SnowLuma 的 `ugc_right`）

| 值 | 含义 | 备注 |
| --- | --- | --- |
| `1` | 所有人可见（公开） | **默认值**（`qzone.defaultUgcRight`），风控风险最高 |
| `4` | 好友可见 | |
| `16` | 部分好友可见 | **必须**提供 `targetUins`（可见名单） |
| `64` | 仅自己可见 | **测试必用**：发布后只有自己看得到，验证完再删 |
| `128` | 部分好友不可见 | **必须**提供 `targetUins`（不可见名单） |

- 允许集合由 `qzone.allowedUgcRights` 控制（默认全部 5 个）；不在此集合内直接拒绝（`BAD_UGC_RIGHT`）。
- `16` / `128` 缺少 `targetUins` 时桥接直接拒绝（`TARGET_UINS_REQUIRED`），不会「悄悄当成公开」。
- 桥接的草稿预览里会带**中文可见范围文案**（`visibility` 字段），例如
  `所有人可见（公开）` / `好友可见` / `部分好友可见` / `仅自己可见` / `部分好友不可见`；
  发布成功的通知也会带上这个文案，避免「以为只给自己看，其实公开了」。
- 主动发布固定使用 `qzone.defaultUgcRight`（默认 `1`）。**准备真实使用前，建议先把默认值改成 `64` 跑通全流程。**

## 接口一览

### 5 个 MCP 工具（`mcp__qzone__*`）

| 工具 | 参数 | 说明 | 超时 |
| --- | --- | --- | --- |
| `qzone_status` | `key?` `token?` | 只读：开关/暂停、主动发布是否在跑、下次执行时间、今日额度、最近失败 | 30s |
| `qzone_list` | `count?`（1~50，默认 20）`key?` `token?` | 只读：机器人自己空间最近的说（tid/正文/时间/评论数/可见性/图片 URL） | 30s |
| `qzone_draft` | `content?` `images?` `ugcRight?` `targetUins?` `askAiToDraft?` `key?` `token?` | **只生成草稿，不发布**；返回 `draftId` | 30s（`askAiToDraft` 时 180s） |
| `qzone_publish` | `draftId` `confirm`（**必须 `true`**）`key?` `token?` | 发布**已起草**的草稿（一次性草稿） | 180s |
| `qzone_delete` | `tid` `confirm`（**必须 `true`**）`key?` `token?` | 删除**自己空间**的一条说说 | 60s |

`qzone_draft` 的 `images` 元素支持三种形式（最多 `qzone.maxImages` 张，默认 9）：

```jsonc
[
  "https://example.com/a.jpg",                          // 1) 仅 https 公网 URL
  "D:\\github\\qq-QQKJ\\images\\cat.png",                // 2) 本机绝对路径（必须在 localImageDirs 白名单内）
  { "searchId": "…", "candidateIds": [4, 7] }            // 3) 近期搜图缓存里的候选
]
```

#### MCP 工具调用示例

```jsonc
// 1) 起草（只生成草稿，不发布；先给主人确认）
{ "name": "qzone_draft", "arguments": {
  "content": "今天把桥接的 QQ 空间功能跑通了。",
  "ugcRight": 64,
  "key": "private:123456789",
  "token": "<二代会话令牌>"
} }

// 2) 发布草稿（confirm 必须 true）
{ "name": "qzone_publish", "arguments": { "draftId": "<上一步返回的 draftId>", "confirm": true } }

// 3) 看自己空间最近 20 条
{ "name": "qzone_list", "arguments": { "count": 20 } }

// 4) 删除测试说说（先 qzone_list 拿 tid）
{ "name": "qzone_delete", "arguments": { "tid": "<tid>", "confirm": true } }

// 5) 看运行状态
{ "name": "qzone_status", "arguments": {} }
```

> `reserved2` 下 `key` 可由桥接按 `token` 反查；`closed-agent` 下两者都可以省略（桥接默认 owner 私聊）。
> 模型不要伪造 tid / 不要声称「已发布」——以工具返回的 `tid` 为准。

### 桥接控制台端点（前缀 `/api/socialV2/qzone`）

前提：**`qzone.enabled=true`**（否则所有端点都返回 403 `QQ 空间功能未开启（qzone.enabled=false）`）。
全部需要控制台令牌（`x-console-token` 或 `?token=`）；MCP 调用额外带 `x-agent-call: 1`
与（reserved2）`x-agent-token`。POST 必须是 `application/json`（桥接有 CSRF 防护，表单/跨站请求会被拒）。

| 方法 | 路径 | Body / Query | 说明 |
| --- | --- | --- | --- |
| POST | `/draft` | `content?` `images?` `ugcRight?` `targetUins?` `askAiToDraft?` `key?` `token?` | 生成草稿（返回 `draftId` 与预览） |
| POST | `/publish` | `draftId` `confirm` `key?` `token?` | 发布草稿（`confirm` 必须 `true`） |
| POST | `/delete` | `tid` `confirm` `key?` `token?` | 删除自己空间的说（`confirm` 必须 `true`） |
| GET | `/list?count=20&key=&token=` | `count?` 1~50，默认 20 | 自己空间最近的说 |
| GET | `/status?key=&token=` | — | 运行状态（与 `qzone_status` 同源，字段在 `status` 下） |
| GET | `/proactive?key=&token=` | — | 主动发布状态：`{ok:true, proactive:{override/effective/nextRunAt/今日额度…}}` |
| POST | `/proactive` | `{ enabled?, runNow?, dryRun? }` | **仅控制台**（agent 调用返回 403 `该接口仅控制台可用`）：开关主动发布；`runNow=true` 立即尝试一次；`dryRun=true` 只演练不发布；两者都不给返回 400 |

#### 返回形状（桥接 → MCP → 模型）

草稿（`/draft`、`qzone_draft`）：

```jsonc
{
  "ok": true,
  "draftId": "3f2a…（32 位 hex）",
  "content": "…",
  "contentLength": 123,
  "images": [{ "label": "网络图片", "bytes": 12345, "mime": "image/jpeg", "sourceType": "url" }],
  "imageCount": 1,
  "ugcRight": 64,
  "visibility": "仅自己可见",
  "targetUins": [],
  "expiresAt": "2026-10-23T04:00:00.000Z",
  "used": false,
  "source": "manual"
}
```

发布（`/publish`、`qzone_publish`）：

```jsonc
{ "ok": true, "tid": "…", "time": 1690000000, "ugcRight": 1, "visibility": "所有人可见（公开）", "contentLength": 123, "images": 0 }
```

列表（`/list`、`qzone_list`）：

```jsonc
{
  "ok": true,
  "total": 42,
  "msglist": [
    { "tid": "…", "content": "…", "time": 1690000000, "commentNum": 0, "isPrivate": false, "images": ["https://…"] }
  ]
}
```

状态（`/status`；`qzone_status` 返回同一份 payload。注意字段在 `status` 下，另带 `caller`）：

```jsonc
{
  "ok": true,
  "caller": { "owner": "private:123456789" },
  "status": {
    "enabled": true,
    "ownerOnly": true,
    "defaultUgcRight": 1,
    "allowedUgcRights": [1, 4, 16, 64, 128],
    "maxContentChars": 1000,
    "maxImages": 9,
    "maxImageBytes": 8388608,
    "maxTotalImageBytes": 16777216,
    "localImageDirsCount": 1,
    "draftTtlMinutes": 30,
    "minIntervalMs": 60000,
    "maxPostsPerDay": 6,
    "publishTimeoutMs": 180000,
    "stateWritable": true,
    "pendingDrafts": 0,
    "lastPostAt": null,
    "lastAttemptAt": null,
    "inFlight": false,
    "today": { "total": 0, "manual": 0, "proactive": 0 },
    "proactive": {
      "configEnabled": true, "override": null, "effective": true,
      "minIntervalMinutes": 240, "maxIntervalMinutes": 480, "maxPerDay": 3,
      "maxChars": 300, "quietHours": [], "quietNow": false,
      "imageProbability": 0.3, "maxImages": 3,
      "useRecentSearchCache": true, "notifyOwner": true, "nextRunAt": 1690000000000
    },
    "lastFailure": { "at": 1690000000000, "source": "proactive", "reason": "…" }
  }
}
```

失败时桥接返回非 2xx（或 `{ok:false, error}`），MCP 会以 `isError: true` + 可读中文原因返回，
**绝不把失败当成功**。常见错误码见「排错」一节。

主动发布（`/proactive`）：

```jsonc
// GET → { ok: true, proactive: { configEnabled, override, effective, nextRunAt, quietNow, maxPerDay, … } }
// POST { "enabled": false }        → { ok: true, status: { …proactive }, result: null }
// POST { "runNow": true, "dryRun": true }
//   → { ok: true, status: { …proactive }, result: { ok: true, dryRun: true, wouldPublish: true,
//        contentHash: "…", contentLength: 123, images: 1, ugcRight: 64, visibility: "仅自己可见" } }
// POST { "runNow": true } 也可能返回 result.skipped = quiet|offline|limits|in_flight|disabled|duplicate|audit|draft_failed
```

## 草稿 → 发布 → 删除（手动流程）

1. `qzone_draft` 生成草稿：正文可以自己给（`content`），也可以只给素材让 AI 起草
   （`askAiToDraft=true`，会请 DSH 侧 `qzone-writer` 会话按当前人格写，较慢）。
2. 把 `draftId`、正文、`visibility` 给主人确认。**不要跳过这一步**：发布是对外动作。
3. `qzone_publish({ draftId, confirm: true })`。
   - 草稿是**一次性**的：发布失败后草稿即作废，需要重新起草（避免「以为没发出去，其实发了两次」）。
   - 草稿默认 **30 分钟**过期（`qzone.draftTtlMinutes`）；过期返回 `DRAFT_EXPIRED`。
   - 草稿图片存在 `state/qzone-media/<draftId>/`，发布时校验 sha256 与大小，防止被替换。
4. 需要删除时：`qzone_delete({ tid, confirm: true })`。

> ⚠️ **真实发布前先用 `ugcRight=64`（仅自己可见）跑一遍**：发布 → 用 `qzone_list` 确认 tid 与内容 →
> 用 `qzone_delete({ tid, confirm: true })` 删掉测试说说。确认没问题后，再考虑把 `qzone.defaultUgcRight`
> 改成 `1`/`4` 或按需使用 `16`/`128`。

## 主动发布（定时说说）

开启条件（**全部满足**才会跑）：`qzone.enabled=true`、`qzone.proactive.enabled=true`、
且没有被控制台覆盖为暂停（`state.proactiveEnabled !== false`）。

调度规则：

- 每次成功后按 `proactive.minIntervalMinutes` ~ `proactive.maxIntervalMinutes`（默认 **240~480 分钟**）
  区间随机取下一次执行时间；失败/跳过也会重新排期，**不会堆起来连发**。
- **静默时段**（`proactive.quietHours`，默认空数组 = 不静默）：如需夜间不自动发，配置
  `["00:00-08:00"]` 这类 `HH:MM-HH:MM`；落在静默时段直接跳过，并排到静默结束后再加 0~5 分钟随机抖动。
- 每轮顺序：开关检查 → 静默 → 是否已有发布在途 → 频率/每日上限 → **QQ 是否在线** → AI 起草 →
  正文审计 → 7 天去重 → 配图 → 发布。任一环节不通过都只是「本轮跳过」，不会重试。
- 上限：主动发布每天 ≤ `proactive.maxPerDay`（默认 3）；**全部发布**（手动+主动）每天
  ≤ `qzone.maxPostsPerDay`（默认 6）；两次发布（含手动）间隔 ≥ `qzone.minIntervalMs`（默认 60 秒）。
- 配图：以 `proactive.imageProbability`（默认 0.3）的概率配图，张数 ≤ `proactive.maxImages`（默认 3）。
  图片来源：优先**近期搜图缓存**（`proactive.useRecentSearchCache`），否则从 `qzone.localImageDirs`
  白名单目录随机挑；两者都没有时，如果 `proactive.searchImagesFromWeb=true`，会按正文关键词
  调用 qq-image 的网络图片检索，取 1~3 张通过校验的原图。检索/下载失败或总计超限时本次改为纯文字。
- 通知主人（`proactive.notifyOwner=true`）：发布成功/失败、以及「跳过」（起草失败、审计拦截、7 天重复）
  都会私聊通知 `ownerQQ`，附可见范围、tid、正文摘要或跳过原因。
- **不自动重试**：发布失败只记录 `lastFailure` 并通知，等下一次排期。

控制台操作（也可由管理员在控制台页面调用）：

```bash
# 暂停/恢复主动发布（只改运行时覆盖，不改 config.json）
curl -X POST http://127.0.0.1:3100/api/socialV2/qzone/proactive \
  -H "x-console-token: <令牌>" -H "content-type: application/json" \
  -d '{"enabled": false}'

# 立即跑一次（受静默时段/额度/QQ 在线/审计/去重约束）
curl -X POST http://127.0.0.1:3100/api/socialV2/qzone/proactive \
  -H "x-console-token: <令牌>" -H "content-type: application/json" \
  -d '{"runNow": true}'

# 只演练：返回 wouldPublish/contentHash/字数/图片数，不真正发布
curl -X POST http://127.0.0.1:3100/api/socialV2/qzone/proactive \
  -H "x-console-token: <令牌>" -H "content-type: application/json" \
  -d '{"runNow": true, "dryRun": true}'
```

## 图片安全（白名单 + 字节校验）

桥接**自己**下载/读取图片字节并校验，然后才以 `base64://` 交给 SnowLuma（SnowLuma 不再接触原始路径/URL）。

### 三种来源

| 来源 | 校验 |
| --- | --- |
| `https://` URL | 必须 https、仅 443 端口、URL 不能含凭据/`token`/`api_key` 等查询参数、不能指向 `localhost`/`127.`/`[::1]`/`0.0.0.0`；下载走带 SSRF 防护的 `safeFetchBuffer`（DNS 全量校验、逐跳重定向复检、20s 超时），再校验大小与 magic bytes |
| 本机绝对路径 | 必须是**绝对路径**；扩展名限 `.jpg/.jpeg/.png/.gif/.webp`；`fs.realpathSync` 解析后必须落在 `qzone.localImageDirs` 任一目录内（防 `..` 穿越）；路径上**任何一级是符号链接都拒绝**；再校验文件大小与 magic bytes |
| 搜图候选 `{searchId, candidateIds}` | 从近期搜图缓存取已下载的候选（qq-image），同样做大小/magic bytes 校验；缓存过期或不可用返回 `IMAGE_SEARCH_EMPTY`/`IMAGE_SEARCH_UNAVAILABLE` |

### 数量与大小上限

- 单张：`qzone.maxImageBytes`，默认 **8 MiB**；
- 总量：`qzone.maxTotalImageBytes`，默认 **16 MiB**；
- 张数：`qzone.maxImages`，默认 **9**（主动发布另有 `proactive.maxImages`，默认 3）。

### `localImageDirs` 白名单

```jsonc
"qzone": {
  "localImageDirs": ["D:\\github\\qq-QQKJ\\images"]
}
```

- 只接受**绝对路径**（相对路径会被忽略并打 warning）；
- 目录不存在不会报错，只是该条目内的图片不可用；
- 白名单为空时，本机路径一律拒绝（`IMAGE_DIR_EMPTY`），网络 URL / 搜图候选仍可用；
- 本机默认建议就填 `D:\github\qq-QQKJ\images`；`config.example.json` 里保持 `[]`（公开模板不写本机路径）。

> 为什么这么严：`images` 是模型可控参数。如果直接把路径交给 SnowLuma，模型就能借「发说说」把本机任意文件
> （如 `config.json`、日志）当图片上传并拿到公网 URL —— 这条路径被桥接的「先读字节、白名单 + magic bytes」堵死。

## 去重、审计与日志

### 去重（固定 7 天，无配置键）

发布前与最近 7 天内的说说比较，命中任一条件即拒绝（`QZONE_DUPLICATE`）：

1. 内容 hash 相同（先做 NFKC + 小写 + 去标点/空白归一化）；
2. 归一化文本完全相同；
3. 归一化后长度 ≥ 8 时，字符 bigram Jaccard 相似度 **≥ 0.85**（「近似内容」）。

主动发布命中重复时只跳过并通知，不重试。去重记录存放在 `state/qzone.json`（`contentHash` / `contentLen` /
归一化文本 / tid / 时间 / 可见范围 / 来源），最多保留最近 200 条；**不保存原文的完整渲染形态**。

### 审计（强制项，没有关闭开关）

`src/qzone.js` 的 `auditQzoneText()` 在通用 `SENSITIVE_RE`（本机路径、凭据/token/password/secret 等）之外，
再拦截：手机号、身份证号、邮箱地址、内网/回环地址（`10.`/`127.`/`169.254.`/`172.16-31.`/`192.168.`/`100.64-127.`）、
`file://`/`base64://` 标记、`data:…;base64,` 内联数据、指向 localhost 的 URL，以及**已知会话令牌**（含二代会话令牌）。
命中即拒绝（`QZONE_AUDIT_BLOCKED`），并给出中文原因；主动发布命中时跳过 + 通知主人。

### 日志

- 桥接日志/活动记录只写：草稿 id、tid、字数、图片数、可见范围、脱敏后的错误原因；
- 去重指纹（content hash / 归一化文本 / 长度）只落在 `state/qzone.json`，**不写入日志**；
- **不写正文全文**、不写图片 URL、不写会话令牌；错误信息里的敏感内容统一 `redact` 后再落盘/通知；
- `state/qzone.json` 与 `state/qzone-media/` 属运行数据（`.gitignore` 已排除），不要提交/外发。

## 配置（`config.json` 的 `qzone` 段）

```jsonc
"qzone": {
  "enabled": false,
  "ownerOnly": true,
  "defaultUgcRight": 1,
  "allowedUgcRights": [1, 4, 16, 64, 128],
  "maxContentChars": 1000,
  "maxImages": 9,
  "maxImageBytes": 8388608,
  "maxTotalImageBytes": 16777216,
  "localImageDirs": [],
  "draftTtlMinutes": 30,
  "minIntervalMs": 60000,
  "maxPostsPerDay": 6,
  "publishTimeoutMs": 180000,
  "draftPreset": "qzone-writer",
  "workspaceTitle": "QQ 空间写作",
  "draftTimeoutMs": 120000,
  "proactive": {
    "enabled": true,
    "minIntervalMinutes": 240,
    "maxIntervalMinutes": 480,
    "maxPerDay": 3,
    "maxChars": 300,
    "quietHours": [],
    "imageProbability": 0.3,
    "maxImages": 3,
    "useRecentSearchCache": true,
    "searchImagesFromWeb": true,
    "notifyOwner": true
  }
}
```

### 默认值表

| 键 | 默认值 | 取值范围 / 收敛规则 | 说明 |
| --- | --- | --- | --- |
| `qzone.enabled` | `false` | 布尔 | 总开关。**关闭时所有 qzone 端点一律 403**（包括只读的列表/状态），开启后才能使用；改完需重启桥接 |
| `qzone.ownerOnly` | `true` | 布尔 | 保留字段：**写操作始终仅 owner**，设为 `false` 也不会放宽（启动时打 warning） |
| `qzone.defaultUgcRight` | `1` | 必须在 `allowedUgcRights` 内 | 草稿/主动发布的默认可见范围 |
| `qzone.allowedUgcRights` | `[1,4,16,64,128]` | 非空、值必须在 5 个合法值内 | 允许使用的可见范围集合 |
| `qzone.maxContentChars` | `1000` | 1~5000 | 正文长度上限（含 AI 起草结果） |
| `qzone.maxImages` | `9` | 0~9 | 单条说说最多几张图 |
| `qzone.maxImageBytes` | `8388608`（8 MiB） | 64 KiB~64 MiB | 单张图片大小上限 |
| `qzone.maxTotalImageBytes` | `16777216`（16 MiB） | `maxImageBytes`~64 MiB | 单条说说图片总大小上限 |
| `qzone.localImageDirs` | `[]` | 绝对路径数组 | 本机图片白名单目录（示例文件保持空） |
| `qzone.draftTtlMinutes` | `30` | 1~1440 | 草稿有效期；过期作废 |
| `qzone.minIntervalMs` | `60000` | 60000~7 天 | 两次发布（手动+主动）的最小间隔 |
| `qzone.maxPostsPerDay` | `6` | 1~100 | 全部发布每天上限 |
| `qzone.publishTimeoutMs` | `180000` | 30000~300000 | 单次发布/删除的 OneBot 超时 |
| `qzone.draftPreset` | `"qzone-writer"` | 非空字符串 | AI 起草使用的 DSH preset（无工具写作会话） |
| `qzone.workspaceTitle` | `"QQ 空间写作"` | 非空字符串 | 起草会话在 DSH 里的工作区名 |
| `qzone.draftTimeoutMs` | `120000` | 30000~300000 | AI 起草超时（桥接侧） |
| `qzone.proactive.enabled` | `true` | 布尔 | 主动发布子开关（需 `qzone.enabled=true` 才生效） |
| `qzone.proactive.minIntervalMinutes` | `240` | 60~1440 | 主动发布最小间隔（分钟） |
| `qzone.proactive.maxIntervalMinutes` | `480` | 60~1440 | 主动发布最大间隔（分钟），会与 min 自动交换纠正 |
| `qzone.proactive.maxPerDay` | `3` | 1~`maxPostsPerDay` | 主动发布每天上限 |
| `qzone.proactive.maxChars` | `300` | 20~`maxContentChars` | 主动发布正文长度上限 |
| `qzone.proactive.quietHours` | `[]` | `HH:MM-HH:MM` 数组，可跨零点；空数组=不静默 | 静默时段（本地时区） |
| `qzone.proactive.imageProbability` | `0.3` | 0~1 | 主动发布配图概率 |
| `qzone.proactive.maxImages` | `3` | 0~`maxImages` | 主动发布配图张数上限 |
| `qzone.proactive.useRecentSearchCache` | `true` | 布尔 | 优先用近期搜图缓存配图 |
| `qzone.proactive.searchImagesFromWeb` | `true` | 布尔 | 无缓存/本机图时按正文关键词联网检索配图 |
| `qzone.proactive.notifyOwner` | `true` | 布尔 | 成功/失败/跳过时私聊通知主人 |

> 配置越界不会静默生效：启动时 `normalizeQzoneConfig()` 逐条收敛并打 `⚠️ qzone 配置已收敛：…`；
> 控制台改配置后重启桥接生效。

## 安装

1. **配置**：在 `config.json` 加 `qzone` 段（见上，`enabled` 先保持 `false`，`localImageDirs` 填本机白名单目录）。
2. **生成 preset patch**：`node scripts/build-agent-preset-patches.mjs`
   （生成/更新 `plugins/qq-agent-presets/presets/qq-chat*.patch.yml` 与 `qzone-writer.patch.yml`）。
3. **注册到 DSH**：`node scripts/setup-dsh.mjs desktop`
   - 会写入 MCP 条目 `mcp-qzone`（`serverName: qzone`、`src/mcp-qzone.js`、`toolCallTimeoutMs: 240000`；
     `MANAGED_MCP_IDS` 幂等管理）；
   - 同时安装/更新 preset（含 `qzone-writer`「QQ 空间说说撰稿人」）。
4. **重启 DSH**（preset 与 MCP 只在 DSH 启动时加载）。
5. **验证**：新开一个 QQ 会话，工具列表里应出现 `mcp__qzone__qzone_status` / `qzone_draft` / `qzone_publish` /
   `qzone_list` / `qzone_delete`；在 owner 私聊里调用 `qzone_status`，确认 `status.enabled` 与 `status.stateWritable` 符合预期。
6. 准备发布时再把 `qzone.enabled` 改成 `true` 并重启桥接。

> 只改了 `dsh/agent-presets/` 而没重装时：先跑 `build-agent-preset-patches.mjs`，再跑 `setup-dsh.mjs`
> （后者内部也会重新生成 patch，幂等）。MCP 条目路径随仓库位置变化时重跑 `setup-dsh.mjs` 即可。

## 删除测试说说

测试发布（尤其 `ugcRight=64`）后，建议立刻删除，避免空间里堆测试内容。

**方式 A：MCP 工具（模型调用）**

```jsonc
{ "name": "qzone_delete", "arguments": { "tid": "<qzone_list 返回的 tid>", "confirm": true } }
```

**方式 B：控制台 API（管理员）**

```bash
curl -X POST http://127.0.0.1:3100/api/socialV2/qzone/delete \
  -H "x-console-token: <令牌>" -H "content-type: application/json" \
  -d '{"tid":"<tid>","confirm":true}'
```

- tid 从 `qzone_list`（或发布返回）取得；**不要凭记忆编造**。
- **只能删机器人自己空间的说**：桥接固定以机器人自己的账号调用 SnowLuma 的 `delete_qzone_msg`，
  服务端会拒绝别人的 tid。想删别人的说，本功能不支持。
- `confirm` 必须显式 `true`（MCP 与桥接都会检查，不传/传 false 直接拒绝）。
- 删除后不可恢复；桥接会在 `state/qzone.json` 里给该 tid 记 `deletedAt` 并通知主人。
- 总开关关闭时**所有 qzone 端点都会被 403 拒绝（包括删除）**：要清理测试说说，先临时把 `qzone.enabled` 打开、删完再关。

## 排错

| 现象 / 报错 | 常见原因 | 处理 |
| --- | --- | --- |
| 工具列表里没有 `mcp__qzone__*` | 没跑 `setup-dsh.mjs` / 没重启 DSH / MCP 条目路径不对 | 重跑 `node scripts/setup-dsh.mjs desktop` 并重启 DSH；检查 `cordis.patch.yml` 有 `mcp-qzone` 条目 |
| `QQ 空间功能未开启（qzone.enabled=false）` / `QZONE_DISABLED` | 总开关关闭（**所有 qzone 端点**都会这样） | 把 `config.json` 的 `qzone.enabled` 改为 `true` 并重启桥接；只读的列表/状态也要先开启 |
| 403 `QQ 空间操作仅限 ownerQQ 私聊，群聊/其他私聊已拒绝` | 在群聊 / 非 owner 私聊里调用 | 只在 **ownerQQ 私聊** 里用 |
| 403 `缺少会话令牌：reserved2 等模式调用 qzone 必须带 token` | `reserved2` 下 MCP 调用没带会话令牌 | 从 QQ 唤醒提示里取【会话令牌】传给 `token` |
| 403 `智能体调用 qzone 必须提供 key 或有效的会话令牌` | 令牌无效/为空，且没给 `key` | 给 `key: "private:<ownerQQ>"` 或有效 `token` |
| 403 `会话令牌与目标私聊不匹配` | token 与 `key` 不是同一会话 | 用该会话自己的令牌，或省略 `key` 让桥接按令牌反查 |
| 403 `未配置 ownerQQ，QQ 空间功能不可用` | `config.json` 没填 `ownerQQ` | 在控制台/`config.json` 设置 ownerQQ |
| 401 / `unauthorized` / `未授权：请提供控制台访问令牌` | MCP 读不到 `consoleToken` 或 `state/console-token` | 确认 `config.json` 的 `consoleToken` 合法（16~128 位 `[A-Za-z0-9_-]`）或删除让其自动生成 |
| `CONFIRM_REQUIRED` | `publish`/`delete` 没传 `confirm: true` | 显式传 `true`（这是故意的防误触） |
| `BAD_UGC_RIGHT` | `ugcRight` 不在 `allowedUgcRights` | 用 1/4/16/64/128；或调 `qzone.allowedUgcRights` |
| `TARGET_UINS_REQUIRED` | `ugcRight=16/128` 没给 `targetUins` | 补上 QQ 号数组，或改用其它可见范围 |
| `BAD_IMAGE` / `IMAGE_PATH_ESCAPE` / `IMAGE_DIR_EMPTY` | 本机图片不在白名单、不是绝对路径、`localImageDirs` 为空 | 把目录加进 `qzone.localImageDirs`（绝对路径）并重启桥接 |
| `IMAGE_SYMLINK` | 路径上某级是符号链接 | 换成真实路径（白名单目录内不要用 symlink/junction） |
| `IMAGE_PATH_MISSING` | 文件不存在/不可读 | 检查路径拼写与权限 |
| `IMAGE_SEARCH_UNAVAILABLE` / `IMAGE_SEARCH_EMPTY` | 搜图缓存过期 / qq-image 未启用 | 重新搜图取新 `searchId`，或改用 URL/本机图片 |
| `QZONE_AUDIT_BLOCKED` | 正文命中手机号/邮箱/身份证/内网地址/本机路径/凭据/会话令牌 | 改写正文，去掉这些内容（审计没有关闭开关） |
| `QZONE_DUPLICATE` | 7 天内发过相同或近似内容 | 换内容，或等 7 天后再发 |
| `QZONE_RATE_LIMIT` / `QZONE_DAILY_LIMIT` / `QZONE_PROACTIVE_DAILY_LIMIT` | 间隔不足 / 今日额度用完 | 等提示的时间；额度上限见配置 |
| `QZONE_BUSY` | 上一条发布还在进行中 | 稍后重试（不要并发发布） |
| `DRAFT_NOT_FOUND` / `DRAFT_EXPIRED` / `DRAFT_USED` | 草稿不存在/超过 30 分钟/已用过 | 重新 `qzone_draft` |
| `QZONE_NO_TID` | SnowLuma 返回成功但没有 tid | **按失败处理，不要重试**：先 `qzone_list` 确认是否其实已发出去 |
| `QZONE_STATE_READONLY` | `state/qzone.json` 损坏或不可写，服务降级只读 | 修复/删除该文件（桥接重启后重建）并检查磁盘权限 |
| 发布超时（`publishTimeoutMs`，默认 180s） | SnowLuma/QQ 侧慢或网络问题 | **不要自动重试**；先 `qzone_list` 核对，必要时手动删除重复 |
| 主动发布一直不跑 | `qzone.enabled=false` / `proactive.enabled=false` / 控制台暂停 / 静默时段 / QQ 离线 / 额度用完 | `qzone_status` 看 `status.proactive.effective`、`status.proactive.quietNow`、`status.proactive.nextRunAt`、`status.lastFailure` |
| QQ 离线 | 主动发布直接跳过并重新排期；手动发布可能失败 | 让 SnowLuma 重新登录 QQ 后再试 |
| SnowLuma 未登录 / QQ 离线 / WS 未连接 | 桥接走 SnowLuma 的 OneBot WS 客户端；SnowLuma 未登录或连接断开时 qzone action 会失败 | 确认桥接日志有「SnowLuma 已连接」；在 SnowLuma 侧确认 QQ 账号已登录、OneBot 服务正常 |
| 503 `QQ 空间服务尚未初始化` | 桥接启动时 qzone 初始化失败（配置收敛异常、图片服务不可用等） | 看桥接启动日志里的 qzone/初始化错误，修好后重启桥接 |

## 已知限制

- 只支持**文字 + 图片**的说说；不支持视频、音乐、转发、@ 提醒、话题标签。
- 只提供「起草 / 发布 / 列表 / 删除 / 状态」5 个动作；**不提供**点赞、评论、拉黑、修改他人可见性、好友动态读取。
- 删除只限机器人自己空间；不能删别人空间里的内容。
- 主动发布是**单进程**调度：桥接重启后按 `state/qzone.json` 的 `lastPostAt` 恢复排期，不会补发错过的内容。
- 与聊天共用 SnowLuma 的 OneBot WS 连接：WS 断开或 SnowLuma 未登录时所有 qzone 动作都会失败（不会静默重试）。
- 依赖 SnowLuma 的 qzone action；SnowLuma 改版/QQ 风控收紧时可能失效，届时功能会返回失败而不是静默。
- 默认关闭是有意的：**空间说说是对外公开发布**，请确认你理解风险再开启。
