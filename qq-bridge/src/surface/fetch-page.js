// 网页正文提取层（GEN3 表现面 S1，设计 §6.2/H5/§17.3）：safeFetch 之上做
// 字符集解码、内容类型白名单、正文提取、12k 截断、来源哈希、磁盘缓存。
//
// H5 修复点：
//   · 旧实现固定 StringDecoder('utf8')，GBK/GB2312 页面乱码 → 现在按 charset 三级判定解码；
//   · 旧实现返回前 50000 字符 HTML → 现在提取正文 + 12000 字符上限，token 降 30%+。
//
// 安全边界不变：SSRF 防护仍由 safeFetch 负责（逐跳 DNS+私网校验）；
// 本层只在拿到响应后处理内容，不发任何请求头凭据（safeFetch 本身不带 Cookie/Authorization）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeFetchBuffer } from '../safe-fetch.js';

/** content-type 白名单（§17.3）：其余返回 UNSUPPORTED_CONTENT_TYPE。 */
export const CONTENT_TYPE_ALLOWLIST = Object.freeze([
  'text/html', 'text/plain', 'application/json', 'application/xml', 'text/xml'
]);

const DEFAULT_FETCH_MAX_CHARS = 12000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const CACHE_MAX_ENTRIES = 200;

/** 支持的字符集（Node 无 ICU 时逐个降级，绝不抛错）。 */
const SUPPORTED_CHARSETS = ['utf-8', 'utf8', 'gbk', 'gb18030', 'gb2312', 'big5'];

function parseContentType(raw) {
  const s = String(raw ?? '').toLowerCase();
  const mime = s.split(';')[0].trim();
  const m = /charset\s*=\s*"?([\w-]+)"?/.exec(s);
  return { mime, charset: m ? m[1] : null };
}

/** charset 三级判定：content-type → HTML meta 前 2KB → utf-8。 */
export function detectCharset(contentTypeHeader, headBytes) {
  const { charset } = parseContentType(contentTypeHeader);
  if (charset && SUPPORTED_CHARSETS.includes(charset.toLowerCase())) return charset.toLowerCase();
  const head = String(headBytes ?? '').slice(0, 2048);
  const meta = /<meta[^>]{0,200}charset\s*=\s*["']?([\w-]+)/i.exec(head) || /<\?xml[^>]{0,100}encoding\s*=\s*["']([\w-]+)/i.exec(head);
  if (meta && SUPPORTED_CHARSETS.includes(meta[1].toLowerCase())) return meta[1].toLowerCase();
  return 'utf-8';
}

/**
 * 解码字节 → 文本。目标编码不可用（缺 ICU）时回退 UTF-8 并标 charsetFallback。
 * 返回 { text, charset, charsetFallback }。
 */
export function decodeBytes(buffer, charset) {
  const want = String(charset ?? 'utf-8').toLowerCase();
  const label = want === 'utf8' ? 'utf-8' : want === 'gb2312' ? 'gbk' : want;
  try {
    return { text: new TextDecoder(label).decode(buffer), charset: label, charsetFallback: false };
  } catch {
    return { text: new TextDecoder('utf-8').decode(buffer), charset: 'utf-8', charsetFallback: true };
  }
}

/** 正文提取：去 script/style/nav/footer/svg/noscript，保留段落文本；失败回退纯文本截断。 */
export function extractMainText(html, maxChars = DEFAULT_FETCH_MAX_CHARS) {
  try {
    let s = String(html ?? '');
    s = s.replace(/<(script|style|nav|footer|svg|noscript|iframe|form)\b[^>]{0,500}?>[\s\S]{0,20000}?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]{0,5000}?-->/g, ' ');
    // 块级标签转段落分隔，行内标签只去壳
    s = s.replace(/<\/?(p|div|br|li|h[1-6]|section|article|tr)[^>]{0,100}>/gi, '\n');
    s = s.replace(/<[^>]{0,300}>/g, '');
    s = decodeEntities(s);
    // 先去空行再做相邻去重：直接一次 filter 会拿「空行」当前一项，
    // 导致 <p>A</p><p>A</p>（A 之间隔空行）的重复躲过去重。
    const lines = s.split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
      .filter(Boolean);
    s = lines.filter((line, i) => i === 0 || lines[i - 1] !== line).join('\n');
    if (s.trim()) return truncate(s.trim(), maxChars);
  } catch { /* 提取失败走纯文本回退 */ }
  return truncate(decodeEntities(String(html ?? '').replace(/<[^>]{0,300}>/g, ' ')), maxChars);
}

/** HTML 实体解码（与 web-search.js 同语义的轻量版）。 */
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec) => safeFromCode(parseInt(dec, 10)))
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
}

function safeFromCode(cp) {
  return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
}

function truncate(s, maxChars) {
  return maxChars > 0 && s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** 内容哈希：sha256 前 16 位（trace 用，不落原文）。 */
export function pageHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

function extractTitle(html) {
  const m = /<title[^>]{0,100}>([\s\S]{0,300}?)<\/title>/i.exec(String(html ?? ''));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/**
 * 抓取网页正文（web_fetch 的新实现）。
 * @returns {{ok, sourceId, url, finalUrl, status, contentType, charset, charsetFallback,
 *            title, text, chars, truncated, contentHash, trust, fetchedAt, cached}}
 * 失败抛稳定错误码语义：UNSUPPORTED_CONTENT_TYPE / SEARCH_FETCH_TOO_LARGE（调用方转响应）。
 */
export async function fetchPage(url, {
  maxChars = DEFAULT_FETCH_MAX_CHARS,
  cacheDir = null,
  cacheTtlMs = CACHE_TTL_MS,
  now = Date.now(),
  // 可注入 fetcher（测试用）：默认 safeFetchBuffer（SSRF 防护 + 逐跳 DNS/私网校验）
  fetchImpl = safeFetchBuffer
} = {}) {
  const cacheKey = cacheDir ? crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32) : null;
  const cacheFile = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : null;

  // 磁盘缓存（§17.3）：只缓存抓取结果；0600；TTL 10 分钟
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (raw && now - raw.at < cacheTtlMs) return { ...raw.value, cached: true };
    } catch { /* 缓存损坏按未命中处理 */ }
  }

  // maxBytes 放宽到 2MB：正文提取前的 HTML 可能较大，字符上限在提取后才生效
  const fetched = await fetchImpl(url, 2 * 1024 * 1024);
  const { mime } = parseContentType(fetched.contentType);
  if (mime && !CONTENT_TYPE_ALLOWLIST.includes(mime)) {
    const err = new Error(`不支持的内容类型：${mime}`);
    err.code = 'UNSUPPORTED_CONTENT_TYPE';
    throw err;
  }

  const head = fetched.buffer.slice(0, 2048).toString('latin1');
  const charset = detectCharset(fetched.contentType, head);
  const { text: decoded, charsetFallback } = decodeBytes(fetched.buffer, charset);

  const isHtml = mime === 'text/html' || (!mime && /<html|<body|<p[\s>]/i.test(decoded.slice(0, 2000)));
  const text = isHtml ? extractMainText(decoded, maxChars) : truncate(decoded.trim(), maxChars);
  const result = {
    ok: true,
    sourceId: `src_${crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16)}`,
    url: String(url),
    finalUrl: fetched.url,
    status: fetched.statusCode,
    contentType: fetched.contentType || mime || '',
    charset,
    charsetFallback,
    title: isHtml ? extractTitle(decoded) : '',
    text,
    chars: text.length,
    truncated: text.length >= maxChars,
    contentHash: pageHash(text),
    trust: 'untrusted',
    fetchedAt: new Date(now).toISOString(),
    cached: false
  };

  if (cacheFile) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(cacheFile, `${JSON.stringify({ at: now, value: { ...result } }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      // 超条目数时清最旧（按 mtime）
      const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      if (files.length > CACHE_MAX_ENTRIES) {
        const sorted = files
          .map((f) => ({ f, m: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
          .sort((a, b) => a.m - b.m);
        for (const { f } of sorted.slice(0, files.length - CACHE_MAX_ENTRIES)) {
          try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* 清理失败忽略 */ }
        }
      }
    } catch { /* 缓存写失败不影响返回 */ }
  }
  return result;
}

export { DEFAULT_FETCH_MAX_CHARS, CACHE_TTL_MS };
