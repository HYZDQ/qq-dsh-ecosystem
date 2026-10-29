# 网络图片检索与发送（imageSearch）

> 这是从 qq-bridge 拆出的**独立图片插件目录**（工作区里与 `qq-bridge/` 并排）。
>
> - 本目录：`src/image-search.js`（provider/下载/校验/缓存）、`src/mcp-image.js`（MCP 工具）、
>   `scripts/`（离线单测、端点回归、联网 dry-run）。
> - 桥接仓库 `../qq-bridge/`：`src/bridge.js` 的两个端点与发送闸门、`src/safe-fetch.js`（SSRF 防护，
>   本目录复用它而不是复制）、`scripts/setup-dsh.mjs`（注册 `mcp-image`）、preset / 工具白名单 / 配置。
> - MCP 工具读取桥接配置的方式：默认读同级的 `../qq-bridge/config.json` 与 `state/console-token`；
>   换布局时可用环境变量 `QQ_BRIDGE_ROOT=<桥接仓库绝对路径>` 覆盖。
> - 安全基线见 [../qq-bridge/docs/guides/SECURITY_BASELINE.md](../qq-bridge/docs/guides/SECURITY_BASELINE.md)；
>   权限边界见 [../qq-bridge/RULES.md](../qq-bridge/RULES.md)。

## 1. 这个功能做什么

QQ 会话里的 AI **没有生图模型**。当用户说“发两张猫图 / 来点 XX 表情包”时：

1. AI 调 `mcp__image__image_search(query, count)`：桥接按配置顺序联网检索图片候选，
   下载候选**缩略图**并以 MCP image content 返回给视觉模型；
2. 视觉模型**看过缩略图后**挑出真正符合意图的 1~3 张；
3. AI 调 `mcp__image__image_send(searchId, candidateIds)`：桥接下载**原图**、做完整校验，
   然后把 1~3 张图拼成**一条** QQ 消息（多个 `image` 段）发出。

硬性边界（不可关闭）：

- **必须先挑选再发送**：桥接只提供候选，发送必须显式给 `candidateIds`；没有“随机/第一张”模式。
- **不做图片生成**：搜不到、下载失败、全部候选不可用时**如实失败**，不发占位图、不伪造成功。
- **所有外发都走桥接**：白名单 / 模式 / 限流 / 审计一个都不能绕；MCP 是薄封装，不直连 OneBot。
- **图片来源的版权与平台 ToS 风险由使用者承担**：本功能不做许可过滤、不强制加来源/作者署名
  （元数据里保留 `pageUrl` / `provider` / `source` 仅用于排错与追溯，不随图发送）。

## 2. 数据流

```
QQ 消息（私聊 / 白名单群）
  └─ DSH agent（qq-chat-v2 / qq-chat）
       ├─ mcp__image__image_search ──► POST /api/socialV2/image/search
       │      provider 顺序检索 → 合并去重 → 下载缩略图（≤ previewBytes）→ searchId 缓存
       │      ◄── 文本元数据 + 缩略图 image content
       ├─ （视觉模型挑选 1~3 个 candidateId）
       └─ mcp__image__image_send ───► POST /api/socialV2/image/send
              目标校验（白名单/模式/令牌）→ 下载原图 → https/Content-Type/magic bytes/
              大小/像素/总大小/sha256 校验 → 一条消息多个 image 段（base64）→ sendChain
              ◄── messageId + 每张字节/尺寸/来源；部分失败逐条报告
```

## 3. 配置（`config.json` 顶层 `imageSearch`）

| 字段 | 默认 | 收敛区间 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | 布尔 | 总开关。`false` 时两个端点直接 403，MCP 工具会返回“检索已关闭” |
| `providers` | `["baidu","bing"]` | `baidu` / `bing` / `webpage-og` | 顺序即优先级；非法项被丢弃；全空时回退默认 |
| `maxCandidates` | `8` | 1~20 | 一次检索最多返回多少候选（含预览张数上限） |
| `previewBytes` | `262144`（256 KB） | 64 KB~1 MB | 单张缩略图字节上限 |
| `maxPerMessage` | `3` | 1~5（实际生效再截到 3） | 单条消息最多几张；超出的 `candidateIds` 被截断并提示 |
| `maxBytes` | `8388608`（8 MB） | 256 KB~20 MB | 单张原图字节上限 |
| `maxPixels` | `64000000`（64 MP） | 1 MP~64 MP | 单张像素上限（防图片炸弹） |
| `maxTotalBytesPerMessage` | `20971520`（20 MB） | 1 MB~40 MB | 单条消息总字节上限（超出从末尾截断） |
| `safeMode` | `false` | 布尔 | `false` = 不限制来源。`true` 只做**尽力而为**的收紧（provider 安全搜索参数 + 明显 NSFW 词过滤），不保证效果；**不是**许可过滤 |
| `defaultAsSticker` | `false` | 布尔 | 默认是否按「表情规格」发送（缩略图 ≤512KB/≤1024px + `sub_type=1`）。`true` = 机器人发的图都走表情模式（接收方长按更容易「添加到表情」）；单次调用仍可用 `asSticker` 覆盖 |
| `dailyLimit` | `0` | 0~1000 | **0 = 无每日上限**；>0 时按“会话 × 自然日”计张数。计数在内存里，重启清零 |
| `cooldownMs` | `0` | 0~1 小时 | 同一会话两次发图的最小间隔 |
| `cacheTtlMinutes` | `10` | 1~120 | `searchId` 候选缓存有效期；过期后 `image_send` 返回明确错误 |
| `dedupeWindowMinutes` | `30` | 0~1440 | 同一会话短时间内重复发同一张图（sha256）时跳过 |
| `requestTimeoutMs` | `10000` | 3~30 秒 | 单次抓取/下载（含重定向链）总预算 |
| `userAgent` | `qq-bridge-image/0.2.0` | 1~200 字符 | 检索请求 UA。**Baidu/Bing 需要浏览器 UA 才返回结果**：值不含 `Mozilla` 时桥接会自动改用浏览器 UA（日志会说明），只有你显式填浏览器 UA 才会原样使用 |

启动时会做类型/范围校验并把越界值收敛到默认值，逐条写一行 warning（不会静默忽略）。
`config.example.json` 已同步该段；`config.json` 缺失时会自动按默认值运行。

## 4. provider

| id | 访问方式 | key / 代理 | 说明 |
| --- | --- | --- | --- |
| `baidu` | `image.baidu.com/search/acjson`（JSON，浏览器 UA + `Referer: https://image.baidu.com/`） | 不需要 | 先访问一次 `https://image.baidu.com/` 取 Cookie（百度对无 Cookie 的 acjson 会返回 `{"antiFlag":1,"message":"Forbid spider access"}`），再带 Cookie 请求；Cookie 进程内缓存约 5 分钟。从 `data[]` 取 `thumbURL` / `middleURL` / `replaceUrl[].ObjURL`；新版百度可能加密 `objURL`，此时自动降级到 `middleURL`。只接受 https 结果 |
| `bing` | `cn.bing.com/images/async`（HTML，浏览器 UA） | 不需要 | 解析 `m="{...murl/turl/purl...}"`；只接受 https 结果。**部分网络访问不了 Bing 的缩略图 CDN（`ts*.mm.bing.net` 会被重置）**，此时预览会自动回退去下载原图（仍受 `previewBytes` 限制） |
| `webpage-og` | 复用 `src/web-search.js` 的搜索结果 → 打开前几个网页 → 解析 `og:image` / `twitter:image` / 首图 | 可选（DeepSeek key，没有则走 Bing 搜索） | 兜底用；比图片站慢，建议放在最后 |

- 某个 provider 失败（网络/解析/反爬）**不影响其它 provider**：失败原因记录在返回的 `providers[]` 里，
  桥接按顺序继续下一个；全部失败 → 返回可读错误（含每个 provider 的原因）。
- 搜到 0 条时返回 `candidates: []` 且带 `note`，不会瞎编。

## 5. 候选预览与上下文体积

- 返回给模型的是**缩略图**（`previews[].dataBase64`），不是原图；每张 ≤ `previewBytes`。
- 缩略图下载失败**不致命**：候选仍返回，`preview: "failed"`，模型可凭标题/来源决定是否还发。
- 上下文成本 ≈ `候选数 × 缩略图体积`。默认 8×256 KB 是上限而非实际值；
  若觉得占上下文/token，优先调小 `maxCandidates`（如 6）或 `previewBytes`（如 131072），
  也可以在提示里让模型 `count=4`。

## 6. 下载与校验（缩略图和原图共用）

- **仅 https**、禁止 URL 内嵌凭据、**端口必须为空或 443**；`data:` / `file:` / 相对路径 / `http:`
  一律拒绝（`e.code = 'INVALID_URL'`）。
- 复用 `src/safe-fetch.js`：域名 DNS 全量解析校验（拒绝 localhost / 私网 / 链路本地 / CGNAT）、
  逐跳重定向重新校验、响应体增量限量、多地址故障切换。
- 校验顺序：HTTP 2xx → `Content-Type`（若存在必须是 `image/*` 且非 SVG；缺失则靠 magic bytes）
  → magic bytes ∈ PNG/JPEG/GIF/WebP → 宽高解析 → 单张 ≤ `maxBytes` → 像素 ≤ `maxPixels`
  → **占位图下限**（原始字节 ≥ 2048 且宽/高 ≥ 8；防止 CDN 的 52 字节跟踪像素/错误图被当成图片发出去）
  → 同批 sha256 去重 → 总字节 ≤ `maxTotalBytesPerMessage`。
- 缩略图下载失败时：先尝试**同一候选的原图**（仍受 `previewBytes` 上限），成功则 `preview: "ok"`；
  都失败才标 `preview: "failed"`（不致命）。
- 图片**不做解码**（不依赖 sharp），压缩炸弹靠「头部宽高 + 字节上限」双重限制。
- 发送时桥接把字节转成 `base64://` 内联到 OneBot `image` 段 —— **绝不把 URL 交给网关**去下载，
  否则会绕过上面的 SSRF/大小校验与审计。

## 7. 缓存 / 去重 / 限额（都是内存态）

| 机制 | 说明 |
| --- | --- |
| `searchId` 缓存 | 每次检索生成一个 id，保存候选（含原图 URL）`cacheTtlMinutes` 分钟；过期/不存在时 `image_send` 返回 410 明确错误 |
| 同消息 sha256 去重 | 一条消息里重复的图只发一次，被跳过的编号在 `skippedDuplicates` 里回报 |
| 会话窗口去重 | `dedupeWindowMinutes` 内同一会话发过的同一张图跳过（`skippedDuplicates`） |
| 每日额度 | `dailyLimit`（0 = 无限，默认）。按会话计**张数**，自然日切换；只有真正发出才计数 |
| 冷却 | `cooldownMs`：同一会话两次发图最小间隔 |
| 发送频率 | 复用 `socialV2.send.maxSendPerMinute/Hour`（一次图片消息算一次发送） |

> 以上计数/缓存**不写 `state/`**，桥接重启即清零。因此“每日额度”不是跨重启的硬账；
> 需要长期配额请用平台侧限制或在 `dailyLimit` 基础上另设。

## 8. 鉴权矩阵（端点口径与 `/api/socialV2/*` 一致）

| 模式 | `image/search` | `image/send` |
| --- | --- | --- |
| `reserved2`（二代） | 可选与会话令牌 | **必须**带会话令牌（唤醒提示里的【会话令牌】）；`key` 可省略，桥接按令牌反查当前会话 |
| `chat` / `reserved`（一代） | 允许无令牌智能体调用 | 无令牌但**必须显式** `key`（`group:群号` / `private:QQ号`），且该聊天**已建立过桥接会话**、命中白名单 |
| `closed-agent` | 同上 | 同上（实际只有 owner 私聊会命中） |

- 目标不在 `allow.private` / `allow.groups` 或模式不允许 → **直接 403，不下载、不发送**。
- 静默模式（`/silent`）下除 owner 私聊外不允许发图。
- 任何发送都在 `sendChain` 里临近发送时再次校验会话/白名单/模式（排队期间权限变化会取消）。

## 9. 端点与工具契约

### `POST /api/socialV2/image/search`

```jsonc
// 请求
{ "query": "柴犬 表情包", "count": 8 }
// 响应
{
  "ok": true,
  "searchId": "…",
  "candidates": [
    { "candidateId": 1, "title": "…", "source": "example.com", "pageUrl": "https://…",
      "width": 800, "height": 600, "bytes": 91234, "preview": "ok" }
  ],
  "previews": [{ "candidateId": 1, "mimeType": "image/jpeg", "dataBase64": "…" }],
  "providers": [{ "id": "baidu", "ok": true, "count": 8 }],
  "note": "可选：为什么是空结果 / 哪些 provider 失败"
}
```

### `POST /api/socialV2/image/send`

```jsonc
// 请求
{ "searchId": "…", "candidateIds": [1, 3], "token": "…",   // reserved2 必填
  "replyToMessageId": 123456, "atUserId": 10001,             // 可选
  "asSticker": false,                                        // 可选：表情包模式（见下）
  "dryRun": false }
// 响应
{
  "ok": true, "key": "private:…", "searchId": "…", "messageId": 9001,
  "sent": [{ "candidateId": 1, "bytes": 91234, "width": 800, "height": 600,
             "mimeType": "image/jpeg", "source": "example.com", "pageUrl": "https://…" }],
  "failed": [{ "candidateId": 3, "reason": "图片超过大小限制（8388608 字节）" }],
  "skippedDuplicates": [2], "truncated": false, "totalBytes": 91234,
  "asSticker": false, "stickerFallback": false, "note": "可选"
}
```

- `dryRun: true`：真实下载/校验，但**不调用 OneBot**；返回 `wouldSend`。
- **表情模式 `asSticker: true`**（用户说“表情包/表情/斗图/想存成表情”时应传）：
  - 优先用检索**缩略图**（通常 20~100KB、500px 左右），并强制 `≤512KB`、`最长边 ≤1024`、
    格式 PNG/JPEG/GIF（WebP 排除），发送时给 `image` 段加 `sub_type=1`（QQ 按表情处理）；
  - 这样接收方长按图片通常就有「添加到表情」，且保存不会因体积/尺寸失败；
  - 候选都不满足表情规格时自动回退成普通图片发送（`stickerFallback: true` + `note` 提示）；
  - QQ 各版本对自定义表情的限制不同（常见 ≤1MB、部分更严），若仍存不了，换一张更小的候选
    （`image_search` 返回的 `bytes` 可参考）或让模型重新搜。
- 部分失败：只发成功项，逐条报告 `failed[].reason`；**全部失败**：不发消息，返回可读错误（HTTP 502）。
- 候选过期：HTTP 410，错误信息提示重新 `image_search`。

### MCP 工具（serverName = `image`）

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `mcp__image__image_search` | `query`（必填）、`count`（1~8，默认 8） | 文本元数据 + N 个缩略图 image content |
| `mcp__image__image_send` | `searchId`、`candidateIds`（1~3）、`key`（reserved2 可省）、`token`、`replyToMessageId`、`atUserId`、`asSticker`（表情包模式）、`dryRun` | 文本 JSON（含 messageId / sent / failed / asSticker / stickerFallback） |

## 10. 日志与可观测

- 桥接日志（`state/bridge.log`）会记录：`searchId`、候选数、可预览数、成功的 provider、
  耗时、发送张数、总字节、失败候选数、`messageId`。
- 活动日志（`state/qq-activity.log`）只记“检索到 N 张候选 / 发送 N 张图片”，**不记图片 URL 查询串、
  不记 token**；错误文本先过敏感信息脱敏再落日志。

## 11. 排错

| 现象 | 原因与处理 |
| --- | --- |
| `图片检索已关闭（imageSearch.enabled=false）` | `config.json` 的 `imageSearch.enabled` 为 false，改成 true 并重启桥接 |
| 返回 0 个候选，`providers[].error` 有内容 | 该 provider 网络/反爬失败；看错误后换 `providers` 顺序或加 `webpage-og`；确认本机能访问对应站点 |
| 候选有、预览全 `failed` | 缩略图 URL 失效或防盗链；模型可换关键词重搜；桥接日志有具体原因 |
| `image_send` 410“候选不存在/已过期” | `searchId` 超过 `cacheTtlMinutes`（默认 10 分钟）或桥接重启过；重新 `image_search` |
| 收到的图长按**没有/点不了「添加到表情」** | 图太大或尺寸超限（QQ 自定义表情常见 ≤1MB、部分版本更严）。让用户说“表情包/存成表情”，模型会传 `asSticker:true`，改用缩略图（≤512KB/≤1024px、`sub_type=1`）发送；仍不行就换一张更小的候选（看 `image_search` 的 `bytes`） |
| `目标不在当前模式允许范围内` | 目标不在 `allow.private`/`allow.groups`，或当前模式不允许（如 closed-agent 只能 owner 私聊） |
| `目标聊天尚未建立桥接会话` | 一代 `chat`/`closed-agent` 模式的收紧：先在该聊天里跟机器人对过话 |
| `reserved2 模式发图必须携带会话令牌` | 模型没传 `token`；检查唤醒提示里的【会话令牌】是否已注入 |
| `发送频率超限` / `发图冷却中` | 命中 `socialV2.send.maxSendPerMinute/Hour` 或 `cooldownMs`，稍后再试 |
| `图片超过大小限制` / `像素超限` | 原图超过 `maxBytes` / `maxPixels`；换一张候选，或按需调整配置（不建议放大上限） |
| MCP 工具执行期被拒“不在 QQ 桥接白名单内” | `plugins/qq-agent-presets/qq-tool-restrict.mjs` 的 `SAFE_PREFIXES` 缺 `mcp__image__`，补齐后重跑 `setup-dsh` 并重启 DSH |

## 12. 安装

图片插件自己的依赖（MCP SDK / zod）要**在本目录装一次**（`setup-dsh` 只登记路径，不装依赖）：

```bash
cd ../qq-image
npm install            # 生成 qq-image/node_modules；换机器/删过 node_modules 后必须重跑
```

注册 MCP / 生成 preset patch / 写配置在**桥接仓库**里做：

```bash
cd ../qq-bridge
node scripts/build-agent-preset-patches.mjs      # 重新生成两代 preset 的 patch
node scripts/setup-dsh.mjs desktop               # 写入 desktop profile（幂等）
# 重启 DSH（让新的 mcp-image server 会话生效）
```

`setup-dsh` 会把 `mcp-image` 的启动脚本指向
`<工作区>/qq-image/src/mcp-image.js`（绝对路径），因此**移动 qq-image 目录后必须重跑一次
`setup-dsh`**，否则 DSH 里的 MCP 路径会指向旧位置。

重启后在**私聊**里说“发 2 张猫图”，观察 AI 是否先 `image_search`（缩略图进入上下文）、
再 `image_send`，最终收到**一条含 2 张图**的 QQ 消息；白名单群同理。

### 测试命令

在本目录（`qq-image/`）下：

```bash
node scripts/test-image-search.mjs       # 离线单测：provider 解析/SSRF/magic bytes/上限/TTL/配置收敛
node scripts/test-image-endpoints.mjs    # 离线端点回归：鉴权矩阵/多 image 段/base64/去重/部分失败/dryRun
node scripts/test-image-search-e2e.mjs   # 真实联网 dry-run（检索+下载校验，不发 QQ；可传查询词）
```

或在桥接仓库里走快捷脚本（等价）：

```bash
cd ../qq-bridge
npm run test:image / npm run test:image:endpoints / npm run test:image:e2e
npm run test:audit                       # 全量回归（含上面两个离线测试；不含 e2e）
```

`test:image:e2e` 默认查询「猫」，也可指定：`node scripts/test-image-search-e2e.mjs "柴犬 表情包"`；
无网络环境用 `QQ_BRIDGE_TEST_NETWORK=0 node scripts/test-image-search-e2e.mjs` 跳过。

## 13. 回滚

1. 回滚桥接侧改动：在 `../qq-bridge` 里
   `git restore src/bridge.js src/safe-fetch.js scripts/setup-dsh.mjs config.example.json`
   （以及 preset / patch / 工具清单 / 本插件迁移相关的测试与文档改动）；
2. 删除本目录 `qq-image/`（图片插件的全部文件都在这里，删掉即卸载插件本体）；
3. 从 `../qq-bridge/config.json` 删除 `imageSearch` 段（迁移/改动前已备份为
   `config.json.bak-<时间戳>`）；
4. 重跑 `node scripts/setup-dsh.mjs desktop`（会移除 `mcp-image` 条目）并重启 DSH；
5. 本功能**不写 `state/`**，无需数据迁移。

## 14. 已知限制 / 后续（P1）

- 候选排序仍是“provider 顺序 + 去重”，没有按分辨率/横竖图/相关性重排；相似图只按 URL 去重。
- 没有图片压缩（不依赖 sharp）：超大图直接拒绝而不是降采样。
- 发送失败不会自动换候选重试（当前只报告失败，由模型决定是否换一张再发）。
- `safeMode` 只是尽力而为，不保证过滤成人内容；需要更强过滤请自行加 provider 或后置检测。
- 只有内存态额度；桥接重启后每日计数清零。
