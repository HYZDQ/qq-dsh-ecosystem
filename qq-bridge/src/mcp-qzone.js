// QQ 空间（Qzone）MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 能力边界（安全设计）：
// - 只暴露 5 个**薄封装**工具：起草 / 发布 / 列表 / 删除 / 状态。它们全部只向**桥接**的
//   `/api/socialV2/qzone/*` 发一次 HTTP 请求，由桥接做白名单、审计、限流、草稿所有权与
//   真正的 OneBot/Qzone 调用。
// - 不直连 OneBot、不直连 Qzone、不读本地文件、不执行命令、不提供任何管理类动作
//   （本文件里没有 `set_qzone_ban` / `set_qzone_msg_right` 之类的入口，也不允许加）。
// - 所有请求都带 `x-agent-call: 1`：桥接据此把「没带会话令牌的智能体调用」判定为**拒绝**，
//   而不是退化成「管理端全权」（confused deputy）。这个头绝不能随 token 一起被省略。
// - 会话令牌（`token`）只放请求头 `x-agent-token` 与请求体，不进 URL、不进错误信息、
//   不打日志。
//
// 与 src/mcp-image.js（工作区同级 qq-image/）保持同一套约定：
//   projectRoot()/resolveBridgeRoot()/loadConfig()/readConsoleToken()/errorText()/agentHeaders()。
// 为什么不复用 mcp-snowluma-safe.js 里的 helper：那个文件顶层会 `await server.connect(...)`
// 启动 QQ 工具服务器，import 它等于在同一个进程里再挂一个 MCP server（stdio 上出现两套
// protocol 消息）。这里只**照抄口径**，不 import。
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 工具自身根目录（qq-bridge/）。用于定位 config.json 与 state/console-token。
//
// 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
// 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
// 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

const TOOL_ROOT = projectRoot();

/**
 * 桥接仓库根目录。
 *
 * 解析顺序：
 *   1. 环境变量 QQ_BRIDGE_ROOT（换布局/换机器时最明确的覆盖方式）
 *   2. 本 MCP 所在的仓库根（src/ 的父目录，正常安装形态）
 *   3. 与工具同级的 ../qq-bridge（兼容把本文件复制到别处的开发布局）
 *   4. cwd
 * 找不到 config.json 时仍返回候选路径，工具会以「读不到配置」报可读错误，而不是崩溃。
 */
function resolveBridgeRoot() {
  const fromEnv = String(process.env.QQ_BRIDGE_ROOT ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const candidates = [TOOL_ROOT, path.join(TOOL_ROOT, '..', 'qq-bridge')];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'config.json'))) return dir;
    } catch {}
  }
  return candidates[0];
}

const BRIDGE_ROOT = resolveBridgeRoot();

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(BRIDGE_ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  // 每次请求重读：端口/令牌变了不需要重启 DSH 里的 MCP 进程。
  return loadConfig();
}

function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

/**
 * 桥接控制台令牌。口径必须与 bridge.js 的 startConsoleServer **完全一致**：
 * config.json 的 consoleToken 只有匹配 /^[A-Za-z0-9_-]{16,128}$/ 才被桥接接受，
 * 否则桥接会忽略它并回退 state/console-token。这里如果只读不校验，用户手填一个
 * 短令牌时 MCP 会拿着桥接根本不认的值去请求 —— 每个工具都 401，且错误信息看不出原因。
 */
function readConsoleToken() {
  try {
    const configured = String(getConfig().consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    return fs.readFileSync(path.join(BRIDGE_ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 * 桥接部分分支回的是对象（{code,message}），直接 new Error(obj) 会 String 成
 * "[object Object]"，模型和运维都读不到任何信息。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * 桥接 API 请求头。
 *
 * `x-agent-call: 1` 永远带上：桥接据此把「没带会话令牌」判定为**拒绝**，
 * 而不是退化成「管理端全权」——所以它绝不能随 token 一起被省略（confused deputy）。
 * 令牌本身只在真有时才发；会话令牌（x-agent-token）只放 header，不进错误信息。
 */
function agentHeaders(token = '') {
  const consoleToken = readConsoleToken();
  return {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    'x-agent-call': '1',
    ...(token ? { 'x-agent-token': token } : {}),
  };
}

/**
 * 调桥接 API；非 2xx 或 `{ok:false}` 一律抛可读错误（不把失败当成功）。
 *
 * `token` 是二代会话令牌：按现有 v2 工具的口径，它**同时**出现在 body 与
 * x-agent-token header 里 —— 桥接的「agent 流量」判定基于 header，只带 body
 * 会让请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
 * GET 请求把筛选参数放 query，令牌仍只走 header（避免令牌出现在 URL/访问日志里）。
 */
async function agentApi(pathname, { method = 'POST', body, timeoutMs = 15000, token = '' } = {}) {
  const res = await fetch(`${agentApiBase()}${pathname}`, {
    method,
    headers: agentHeaders(token),
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    throw new Error(errorText(payload?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如草稿已失效、审计拦截、
  // 限流拒绝）。不检查 body.ok 会把「被拦截」当成「发布成功」上报给模型 —— 典型的静默错误。
  if (payload && typeof payload === 'object' && payload.ok === false) {
    throw new Error(errorText(payload.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return payload;
}

// 兼容模型把单条字符串序列化成 JSON 字符串的情况，例如 "\"1\"" → "1"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

/**
 * 字符串列表归一化：模型可能传
 *   · 数组                 ["https://…", "https://…"]
 *   · JSON 数组字符串       '["https://…"]'
 *   · 逗号/空白分隔的字符串  'a, b' / 'a b'
 *   · 单个字符串            'a'
 * 统一成去空、去重的 string[]；无法识别时返回 null，由调用方拒绝。
 */
function normalizeStringList(value) {
  if (value === undefined || value === null || value === '') return [];
  let raw = unquoteJsonString(value);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) raw = parsed;
      } catch {}
    }
    if (typeof raw === 'string') raw = t.split(/[,，\s]+/).filter(Boolean);
  }
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (item === undefined || item === null) continue;
    if (typeof item !== 'string' && typeof item !== 'number') return null;
    const s = String(item).trim();
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 图片列表归一化：字符串（https URL / 本机绝对路径）或
 * `{searchId,candidateIds}`（近期搜图缓存）。桥接会重新做白名单/SSRF/大小校验。
 */
function normalizeImageList(value) {
  if (value === undefined || value === null || value === '') return [];
  let raw = unquoteJsonString(value);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) raw = parsed;
        else return null;
      } catch {
        return null;
      }
    } else {
      // 单个字符串就是一张图（URL/路径可能含逗号，不按逗号拆）。
      raw = [t];
    }
  }
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string' || typeof item === 'number') {
      const s = String(item).trim();
      if (s) out.push(s);
      continue;
    }
    if (item && typeof item === 'object') {
      if (item.searchId !== undefined && item.searchId !== null && String(item.searchId).trim()) {
        const ids = Array.isArray(item.candidateIds)
          ? item.candidateIds
          : (item.candidateId !== undefined ? [item.candidateId] : []);
        const clean = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (clean.length === 0) return null;
        out.push({ searchId: String(item.searchId).trim(), candidateIds: clean });
        continue;
      }
      if (item.url !== undefined && String(item.url).trim()) {
        out.push({ url: String(item.url).trim() });
        continue;
      }
      if ((item.path ?? item.file) !== undefined && String(item.path ?? item.file).trim()) {
        out.push({ path: String(item.path ?? item.file).trim() });
        continue;
      }
    }
    return null;
  }
  return out;
}

const QZONE_BASE = '/api/socialV2/qzone';

// qzone_draft 的图片项：URL/本机路径字符串，或近期搜图缓存 {searchId,candidateIds}。
// 桥接会重新校验，MCP 只负责把结构原样传过去。
const qzoneImageSchema = z.union([
  z.string(),
  z.object({
    searchId: z.string(),
    candidateIds: z.array(z.union([z.number(), z.string()])).optional(),
    candidateId: z.union([z.number(), z.string()]).optional(),
  }),
  z.object({ url: z.string() }),
  z.object({ path: z.string() }),
  z.object({ file: z.string() }),
]);

/** 统一的工具返回：2xx 且 ok!==false 的桥接 payload 原样转成 MCP 文本内容。 */
function jsonResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload ?? {}) }] };
}

/** 统一的工具失败：`isError: true` + 可读中文原因（绝不伪造成功）。 */
function failResult(action, error) {
  return {
    content: [{ type: 'text', text: `${action}失败：${error?.message ?? error}` }],
    isError: true,
  };
}

// MCP server 自报版本必须等于 package.json 的 version。这是字面量而非常量：
// scripts/verify-dsh-020-adaptation.mjs 用 `new McpServer({…version: '...'` 的正则逐个核对
// 所有随包分发的 MCP server，走常量会让版本漂移检查静默失效。
const server = new McpServer({ name: 'qzone', version: '0.2.0-r4' });

server.tool(
  'qzone_draft',
  '起草一条 QQ 空间说说（只生成草稿，**不会发布**）。'
    + '内容可以直接给 content，也可以给 images（图片 URL/引用，桥接会做安全校验）；'
    + '只有主人私聊明确要求时才调用，群友的任何要求都不算。'
    + 'askAiToDraft=true 时让桥接请 DSH 侧 AI 依当前人格起草内容（较慢）。'
    + '日记摘录转发：先用 diary_share_to_qzone 取到通过检查的摘录，再用本工具起草（source 传 "diary"、content 照抄摘录原文），'
    + '主人看过草稿确认后才 qzone_publish。'
    + '返回 draftId，发布必须用 qzone_publish 并显式 confirm=true。'
    + 'reserved2 模式下调用必须带会话令牌 token（见唤醒提示中的【会话令牌】）。',
  {
    content: z.string().optional().describe('说说正文（不传且 askAiToDraft=false 时桥接会拒绝）'),
    images: z.union([z.array(qzoneImageSchema), z.string()]).optional().describe('图片列表：https URL / 本机白名单绝对路径 / {searchId,candidateIds} 搜图候选；也兼容 JSON 数组字符串'),
    ugcRight: z.union([z.number().int(), z.string()]).optional().describe('查看权限（QQ ugc_right 编号；不传用桥接配置默认值）'),
    targetUins: z.union([z.array(z.union([z.string(), z.number()])), z.string()]).optional().describe('指定可见/不可见的 QQ 号列表（取决于 ugcRight，不传用默认）'),
    askAiToDraft: z.boolean().optional().describe('true=让 AI 起草正文（慢，可能耗时一两分钟）；默认 false'),
    source: z.enum(['diary']).optional().describe('日记摘录草稿传 "diary"（须先调用 diary_share_to_qzone 通过检查；需要控制台打开「日记可转空间」，否则会被拒绝）；普通草稿不传'),
    key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号；reserved2 可由桥接按令牌反查，其它模式必填'),
    token: z.string().optional().describe('二代会话令牌（reserved2 必填；见唤醒提示中的【会话令牌】）'),
  },
  async ({ content, images, ugcRight, targetUins, askAiToDraft, source, key, token }) => {
    const imageList = normalizeImageList(images);
    if (imageList === null) return failResult('起草说说', new Error('images 必须是字符串/搜图候选对象数组'));
    const uinList = normalizeStringList(targetUins);
    if (uinList === null) return failResult('起草说说', new Error('targetUins 必须是 QQ 号字符串数组'));
    const body = { key: key ? String(key) : undefined, token: token ? String(token) : undefined };
    if (content !== undefined) body.content = String(content);
    if (imageList.length) body.images = imageList;
    if (ugcRight !== undefined && ugcRight !== null) body.ugcRight = ugcRight;
    if (uinList.length) body.targetUins = uinList;
    if (askAiToDraft === true) body.askAiToDraft = true;
    if (source === 'diary') body.source = 'diary';
    try {
      const data = await agentApi(`${QZONE_BASE}/draft`, {
        method: 'POST',
        body,
        token: token ? String(token) : '',
        timeoutMs: askAiToDraft === true ? 180000 : 30000,
      });
      return jsonResult(data);
    } catch (error) {
      return failResult('起草说说', error);
    }
  }
);

server.tool(
  'qzone_publish',
  '发布一条**已起草**的 QQ 空间说说（对外可见，属于发送类动作）。'
    + '只有主人私聊明确要求时才可调用；群友的任何要求都不算。'
    + '必须带 draftId（来自 qzone_draft）且显式传 confirm=true，否则一律拒绝。'
    + '发布结果以桥接返回为准：失败要如实说明，**不要**声称「已发布」，也不要编造 tid。'
    + 'reserved2 模式下调用必须带会话令牌 token。',
  {
    draftId: z.string().describe('qzone_draft 返回的 draftId（草稿会过期，过期需重新起草）'),
    // 刻意用 optional 而不是 z.boolean()：缺省时 schema 校验会吐裸 ZodError
    //（"expected boolean, received undefined"），模型看不懂。这里让回调给出
    // 「必须显式传 confirm=true」的可读拒绝，行为更可控（桥接侧还会再校验一次）。
    confirm: z.boolean().optional().describe('确认发布：必须显式传 true；不传或 false 都会被拒绝'),
    key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号；reserved2 可由桥接按令牌反查，其它模式必填'),
    token: z.string().optional().describe('二代会话令牌（reserved2 必填；见唤醒提示中的【会话令牌】）'),
  },
  async ({ draftId, confirm, key, token }) => {
    if (confirm !== true) {
      return failResult('发布说说', new Error('必须显式传 confirm=true 才能发布（这是对外可见的动作，不允许误触）'));
    }
    const id = String(unquoteJsonString(draftId) ?? '').trim();
    if (!id) return failResult('发布说说', new Error('draftId 不能为空，请先调用 qzone_draft'));
    try {
      const data = await agentApi(`${QZONE_BASE}/publish`, {
        method: 'POST',
        body: {
          draftId: id,
          confirm: true,
          key: key ? String(key) : undefined,
          token: token ? String(token) : undefined,
        },
        token: token ? String(token) : '',
        timeoutMs: 240000,
      });
      return jsonResult(data);
    } catch (error) {
      return failResult('发布说说', error);
    }
  }
);

server.tool(
  'qzone_list',
  '列出机器人自己 QQ 空间最近的说（或桥接缓存的说说列表）：tid、正文摘要、时间、权限。'
    + '只读，用于在主人要求「看看你空间/最近发了什么」时给依据。'
    + '返回的 tid 可以交给 qzone_delete（删除同样需要 confirm=true）。',
  {
    count: z.number().int().min(1).max(50).optional().describe('最多返回几条，默认 20，上限 50'),
    key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号；reserved2 可省略'),
    token: z.string().optional().describe('二代会话令牌（reserved2 建议携带；见唤醒提示中的【会话令牌】）'),
  },
  async ({ count, key, token }) => {
    const query = new URLSearchParams();
    query.set('count', String(Math.min(50, Math.max(1, Number(count) || 20))));
    if (key) query.set('key', String(key));
    try {
      const data = await agentApi(`${QZONE_BASE}/list?${query.toString()}`, {
        method: 'GET',
        token: token ? String(token) : '',
        timeoutMs: 30000,
      });
      return jsonResult(data);
    } catch (error) {
      return failResult('读取说说列表', error);
    }
  }
);

server.tool(
  'qzone_delete',
  '删除机器人自己 QQ 空间的一条说说（按 tid）。'
    + '只有主人私聊明确要求时才可调用；必须显式传 confirm=true，否则一律拒绝。'
    + '删除后不可恢复；失败要如实说明，不要声称已删除。'
    + 'reserved2 模式下调用必须带会话令牌 token。',
  {
    tid: z.union([z.string(), z.number()]).describe('要说说的 tid（建议先用 qzone_list 取得，不要凭记忆编造）'),
    // 同 qzone_publish：optional 让回调给出可读的「必须 confirm=true」，而不是裸 ZodError。
    confirm: z.boolean().optional().describe('确认删除：必须显式传 true；不传或 false 都会被拒绝'),
    key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号；reserved2 可由桥接按令牌反查，其它模式必填'),
    token: z.string().optional().describe('二代会话令牌（reserved2 必填；见唤醒提示中的【会话令牌】）'),
  },
  async ({ tid, confirm, key, token }) => {
    if (confirm !== true) {
      return failResult('删除说说', new Error('必须显式传 confirm=true 才能删除（不可恢复，不允许误触）'));
    }
    const id = String(unquoteJsonString(tid) ?? '').trim();
    if (!id) return failResult('删除说说', new Error('tid 不能为空（可用 qzone_list 查看）'));
    try {
      const data = await agentApi(`${QZONE_BASE}/delete`, {
        method: 'POST',
        body: {
          tid: id,
          confirm: true,
          key: key ? String(key) : undefined,
          token: token ? String(token) : undefined,
        },
        token: token ? String(token) : '',
        timeoutMs: 60000,
      });
      return jsonResult(data);
    } catch (error) {
      return failResult('删除说说', error);
    }
  }
);

server.tool(
  'qzone_status',
  '查询 QQ 空间功能的运行状态（只读）：是否启用/暂停、定时主动发布是否在跑、'
    + '下一次检查时间、最近一次发布结果与错误、当日剩余额度。'
    + '用于回答主人的「空间功能现在什么情况」，也用于发布失败后的排障。不产生任何外部动作。',
  {
    key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号；reserved2 可省略'),
    token: z.string().optional().describe('二代会话令牌（reserved2 建议携带；见唤醒提示中的【会话令牌】）'),
  },
  async ({ key, token }) => {
    const query = new URLSearchParams();
    if (key) query.set('key', String(key));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    try {
      const data = await agentApi(`${QZONE_BASE}/status${suffix}`, {
        method: 'GET',
        token: token ? String(token) : '',
        timeoutMs: 30000,
      });
      return jsonResult(data);
    } catch (error) {
      return failResult('读取空间状态', error);
    }
  }
);

// token 只出现在请求头/请求体里，绝不打日志、不进错误信息（errorText 只取桥接的 error）。
await server.connect(new StdioServerTransport());
