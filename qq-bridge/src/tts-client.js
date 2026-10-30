// 本地 TTS（Breeze TTS 2 / audio.cpp）桥接侧客户端。
//
// 设计见 docs/design/VOICE_TTS_INTEGRATION_PLAN.md：
//   - 只跟 WSL 里的 sidecar 说话（默认 http://127.0.0.1:18100），sidecar 再转发给 audiocpp_server；
//   - **不重试**：失败就是失败，由模型改用纯文本（`tts.fallbackToText`）；
//   - 产物写入语音库内的子目录（默认 audio/tts），因此天然通过既有的
//     `voicePathInsideLibrary` / `safeJoinLibrary` 校验，**不需要打开 allowAbsolutePath**。
//
// 本文件只做三件纯函数/薄客户端的事，任何 HTTP 之外的副作用都留给 bridge.js：
//   1) normalizeTtsConfig()：配置归一 + 数值钳制 + outDir 反向校验（越界即降级告警）；
//   2) preprocessTtsText()：§8.5 的朗读文本清洗（去 Markdown/emoji/@、保留 Vocal Events、按句截断）；
//   3) createTtsClient()：/health 与 /tts 的薄封装 + 结构化错误码。

import path from 'node:path';

/** 结构化错误码（与 §12.1 的错误码矩阵一致）。 */
export const TTS_CODES = Object.freeze({
  UNAVAILABLE: 'tts_unavailable',
  TIMEOUT: 'tts_timeout',
  TEXT_TOO_LONG: 'tts_text_too_long',
  BAD_REQUEST: 'tts_bad_request',
  DISABLED: 'tts_disabled',
  ENGINE_ERROR: 'tts_engine_error'
});

export class TtsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 只允许回环地址：本地合成绝不出网（§9 第 1 条）。 */
export function isLoopbackUrl(raw) {
  try {
    const u = new URL(String(raw));
    const host = u.hostname.toLowerCase();
    return (u.protocol === 'http:' || u.protocol === 'https:')
      && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]');
  } catch {
    return false;
  }
}

function clampNum(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 配置归一。**唯一**入口，config.json / 控制台 / 测试都走这里，避免"三份默认值各自漂移"。
 *
 * 反向校验（§7.1）：`outDir` 必须落在 `socialV2.voice.dir` 之内，否则降级为 `<voiceDir>/tts`
 * 并记一条 warning —— 绝不因为配置写错就打开任意路径外发。
 */
export function normalizeTtsConfig(raw, { root, voiceDir } = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const warnings = [];

  const baseUrlRaw = String(cfg.baseUrl ?? '').trim() || 'http://127.0.0.1:18100';
  const baseUrl = baseUrlRaw.replace(/\/+$/, '');
  if (!isLoopbackUrl(baseUrl)) {
    warnings.push(`tts.baseUrl 必须是本机回环地址（当前 ${baseUrlRaw}），已回退 127.0.0.1:18100`);
  }
  const effectiveBaseUrl = isLoopbackUrl(baseUrl) ? baseUrl : 'http://127.0.0.1:18100';

  const rootDir = path.resolve(root ?? '.');
  const libDir = path.resolve(voiceDir ?? path.join(rootDir, 'audio'));
  const wanted = path.resolve(rootDir, String(cfg.outDir ?? 'audio/tts'));
  let outDir = wanted;
  const rel = path.relative(libDir, wanted);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    warnings.push('tts.outDir 不在语音库内，已降级为 <语音库>/tts（不会向语音库外写文件）');
    outDir = path.join(libDir, 'tts');
  }
  const outDirRel = path.relative(libDir, outDir).split(path.sep).join('/') || 'tts';

  const modeRaw = String(cfg.mode ?? 'design').trim().toLowerCase();
  const mode = ['design', 'clone', 'direction'].includes(modeRaw) ? modeRaw : 'design';
  if (!['design', 'clone', 'direction'].includes(modeRaw)) {
    warnings.push(`tts.mode 只能是 design/clone/direction（当前 ${modeRaw}），已按 design`);
  }

  const refAudio = String(cfg.refAudio ?? '').trim();
  if (mode !== 'design' && !refAudio) warnings.push(`${mode} 模式需要 tts.refAudio（参考音频路径，须在 WSL 的 ~/tts/refs 内）`);
  if (mode !== 'design' && !String(cfg.refText ?? '').trim()) warnings.push(`${mode} 模式需要 tts.refText（参考音频逐字稿）`);

  return {
    enabled: cfg.enabled === true,
    baseUrl: effectiveBaseUrl,
    timeoutMs: clampNum(cfg.timeoutMs, 3000, 180000, 30000),
    maxChars: clampNum(cfg.maxChars, 1, 400, 120),
    outDir,
    outDirRel,
    dir: libDir,
    mode,
    voiceDesign: String(cfg.voiceDesign ?? '').trim()
      || '一位温柔自信的年轻女性，声音清晰，语气亲切，表达轻快而富有感染力。',
    refAudio,
    refText: String(cfg.refText ?? '').trim(),
    // 默认克隆音色（音色库里的名字）；空 = 用上面的 voiceDesign 文字描述。
    // 名字是否合法/是否真的存在由 bridge 查登记表时再校验（这里只做字符串归一）。
    voice: String(cfg.voice ?? '').trim(),
    // 分场景默认音色：私聊 / 群聊各自一个名字，空 = 继承上面的 voice。
    voicePrivate: String(cfg.voicePrivate ?? '').trim(),
    voiceGroup: String(cfg.voiceGroup ?? '').trim(),
    instruction: String(cfg.instruction ?? '').trim(),
    cfgScale: clampNum(cfg.cfgScale, 0, 10, 4),
    speed: clampNum(cfg.speed, 0.5, 2, 1),
    keepDays: clampNum(cfg.keepDays, 0, 365, 7),
    fallbackToText: cfg.fallbackToText !== false,
    allowProactive: cfg.allowProactive === true,
    dailyLimit: clampNum(cfg.dailyLimit, 0, 10000, 0),
    warnings
  };
}

// ── §8.5 文本预处理 ────────────────────────────────────────────────────────
// 顺序不可颠倒：先清洗 → 再经 style 改写（在 bridge 里做）→ 最后截断。

const CODE_BLOCK_RE = /```[\s\S]*?```/g;           // 代码块整段丢弃（念出来毫无意义）
const MD_LINK_RE = /\[([^\]]*)\]\((?:[^)]+)\)/g;   // [文字](url) → 文字
const MD_MARK_RE = /[#*_~`>|]+/g;                  // Markdown 标记符
const CQ_CODE_RE = /\[CQ:[^\]]*\]/g;               // OneBot CQ 码（含 [CQ:at,qq=...]）
const AT_MENTION_RE = /@[^\s@]+(?:[\s\u3000]|$)/g; // @昵称 → 删除
const URL_RE = /https?:\/\/\S+/gi;                 // 裸链接 → 删除（协议头 + 内容）
// emoji / 符号：覆盖常见区段（含变体选择符与零宽连接符），保留中文标点与括号
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;
// 颜文字：括号内只有符号/假名/空格且不含汉字，如 (｀・ω・´)、(≧▽≦)
const KAOMOJI_RE = /[（(][^（）()\u4e00-\u9fa5]{0,12}[)）]/g;
const VOCAL_EVENT_RE = /\[(笑|叹气|咳嗽|清嗓子|哭|哼|喘气|生气|小声)\]|【(笑|叹气|咳嗽|清嗓子|哭|哼|喘气|生气|小声)】/g;
// `[笑](url)`：链接语法包着的发音指令（模型偶尔会这么写）
const VOCAL_LINK_RE = /\[(笑|叹气|咳嗽|清嗓子|哭|哼|喘气|生气|小声)\]\([^)]*\)/g;

/**
 * 把聊天文本变成"朗读文本"。
 * - 保留 `[笑]`/`[叹气]` 等 Vocal Events（这是发音指令，不是装饰）；
 * - 保留数字与英文缩写（不改写成"一百二十三"）；
 * - 截断优先落在句末标点，避免半句话被切。
 */
export function preprocessTtsText(input, { maxChars = 120 } = {}) {
  let text = String(input ?? '');
  // 0) 先把 Vocal Events 摘出来换成占位符：`[笑](url)` 这种"链接语法包着发音指令"
  //    会被后面的 Markdown 处理吃掉方括号，导致「笑」变成普通字（念出来就不笑了）。
  // `[笑](url)` 是"发音指令被写成了 Markdown 链接"，先把 url 摘掉、方括号留下。
  text = text.replace(VOCAL_LINK_RE, '[$1]');
  const keep = [];
  text = text.replace(VOCAL_EVENT_RE, (m) => {
    keep.push(m);
    return `\u0000${keep.length - 1}\u0000`;
  });
  // 1) 代码块 / Markdown / CQ 码 / 链接
  text = text.replace(CODE_BLOCK_RE, ' ');
  text = text.replace(CQ_CODE_RE, ' ');
  text = text.replace(MD_LINK_RE, '$1');
  text = text.replace(URL_RE, ' ');
  // 1.5) 去掉被掏空后剩下的空括号（`[笑](url)` 这类链接语法的残骸 → 别让引擎念出括号）
  text = text.replace(/\(\s*\)|（\s*）/g, ' ');
  // 2) emoji / 颜文字（在去标点之前，颜文字识别依赖括号原样）
  text = text.replace(EMOJI_RE, ' ');
  text = text.replace(KAOMOJI_RE, ' ');
  // 3) @昵称
  text = text.replace(AT_MENTION_RE, ' ');
  // 4) 其余 Markdown 标记符（`#` `*` 等——但 Vocal Events 的方括号要留住）
  text = text.replace(MD_MARK_RE, ' ');
  // 4.5) 还原 Vocal Events
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)] ?? ' ');
  // 5) 空白归一
  text = text.replace(/[\t\u00a0\u3000]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  // 6) 截断：优先句末标点
  const limit = Math.max(1, Number(maxChars) || 120);
  if (text.length > limit) {
    const head = text.slice(0, limit);
    const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
      head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'), head.lastIndexOf('，'));
    text = cut > limit * 0.4 ? head.slice(0, cut + 1) : head;
  }
  return text.trim();
}

/** 把 Vocal Events 之外的方括号内容去掉（模型偶尔会写 [旁白] 之类，念出来很怪）。 */
export function stripUnknownBracketTags(text) {
  const keep = [];
  const masked = String(text ?? '').replace(VOCAL_EVENT_RE, (m) => {
    keep.push(m);
    return `\u0000${keep.length - 1}\u0000`;
  }).replace(/\[[^\]]{1,12}\]/g, ' ');
  return masked.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)] ?? '').trim();
}

/**
 * 薄 HTTP 客户端。**不重试**（沿用「失败不重试」约定），超时用 AbortSignal。
 */
export function createTtsClient({ baseUrl, timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(baseUrl ?? 'http://127.0.0.1:18100').replace(/\/+$/, '');

  async function request(pathname, { method = 'GET', body = null, timeout = timeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}${pathname}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout)
      });
    } catch (error) {
      const msg = String(error?.message ?? error);
      const timedOut = error?.name === 'TimeoutError' || /timeout|aborted/i.test(msg);
      throw new TtsError(timedOut ? TTS_CODES.TIMEOUT : TTS_CODES.UNAVAILABLE,
        timedOut ? `合成服务超时（${timeout}ms）` : `合成服务不可用：${msg}`, { cause: error });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const code = typeof data?.code === 'string' ? data.code : TTS_CODES.ENGINE_ERROR;
      throw new TtsError(code, data?.error ? String(data.error) : `合成服务返回 HTTP ${res.status}`, { status: res.status });
    }
    return data;
  }

  return {
    baseUrl: base,
    /** 探活：/health 永远不抛（连不上就是 ready=false）。 */
    async health({ timeout = Math.min(5000, timeoutMs) } = {}) {
      try {
        return await request('/health', { timeout });
      } catch (error) {
        return { ok: false, ready: false, error: `${error?.code ?? TTS_CODES.UNAVAILABLE}: ${error?.message ?? error}` };
      }
    },
    /** 合成一段语音；返回 { ok, relPath, path, bytes, durationSec, elapsedMs, cached }。 */
    async synthesize(params) {
      return request('/tts', { method: 'POST', body: params, timeout: timeoutMs });
    },
    /**
     * 导入参考音频（音色克隆）：sidecar 用 ffmpeg 转成 24k 单声道 wav 落到 refs 目录。
     * 返回 { ok, file, name, durationSec, bytes }；失败原样抛 TtsError（不重试）。
     */
    async importRef({ name, audio, timeout = Math.min(60000, timeoutMs) } = {}) {
      return request('/refs', { method: 'POST', body: { name, audio }, timeout });
    }
  };
}
