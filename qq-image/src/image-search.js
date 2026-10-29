// 图片检索内核：provider 解析、URL/字节安全校验、候选合并与「发送前准备」。
//
// 设计边界（与任务书一致）：
// - 本模块不读 QQ 白名单、不发 QQ、不落盘；只负责「查询 → 候选 → 预览 → 原图」。
// - 所有外部输入（页面 HTML / JSON / URL / 标题）都视为**不可信数据**：只解析、不执行；
//   标题/来源经过控制字符、CQ 码、HTML 标签清洗；来源只保留 hostname（无端口）。
// - 下载统一走 safe-fetch（SSRF 防护 + 多地址故障切换）；本模块再加一层 URL 形状校验
//   （仅 https / 无凭据 / 标准端口）与 Content-Type、magic bytes、像素、字节上限校验。
// - 日志只记 searchId / provider / 计数 / 耗时 / 错误摘要，绝不记查询词、凭据、Cookie。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
// 安全抓取与联网搜索复用 qq-bridge 的**单一实现**（不要复制 SSRF 逻辑：复制就会漂移）。
// 本模块位于工作区的 qq-image/，与桥接仓库 qq-bridge/ 同级。
import { isPrivateIp, safeFetch, safeFetchBuffer } from '../../qq-bridge/src/safe-fetch.js';
import { webSearch } from '../../qq-bridge/src/web-search.js';

// ── 常量 ──────────────────────────────────────────────────────────────────
const PROVIDER_IDS = ['baidu', 'bing', 'webpage-og'];
const DEFAULT_PROVIDERS = ['baidu', 'bing'];
const MAX_TEXT_CHARS = 512000;
const PROVIDER_CANDIDATE_LIMIT = 30;
const OG_MAX_PAGES = 4;
const OG_PAGE_CONCURRENCY = 2;
const PREVIEW_CONCURRENCY = 3;
const SEARCH_WEB_MAX_RESULTS = 6;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_CHARS = 120;
const MAX_QUERY_CHARS = 120;
// ── 反爬 / 占位图内部常量（**不进配置**）─────────────────────────────────
// Baidu 的 gimg 代理偶发返回 52 字节 GIF（占位/跟踪像素）或 1×1 空图；这类字节
// 给视觉模型看没有信息量，发给 QQ 也是浪费。这里划一条内部下限：原始字节 < 2KB
// 或宽/高 < 8 一律视为「不可用图片」。preview 与 prepareSend 共用同一条线。
const MIN_IMAGE_BYTES = 2048;
const MIN_IMAGE_EDGE = 8;
// ── 「表情模式」内部常量（**不进配置**）───────────────────────────────────
// 为什么需要：QQ 的「添加到表情」对图片有额外限制（体积通常要 ≤1MB，部分版本更严；
// 尺寸太大、WebP/GIF 动图帧数太多都会让长按菜单里没有「添加到表情」或保存失败）。
// 而搜索结果原图可能 2~8MB / 2000+px —— 直接发原图时接收方经常存不了。
// 表情模式优先用检索缩略图（通常 20~100KB、500px 左右），并强制下面两条上限；
// 只接受 PNG/JPEG/GIF（WebP 在部分 QQ 版本无法添加为表情）。
const STICKER_MAX_BYTES = 512 * 1024;
const STICKER_MAX_EDGE = 1024;
const STICKER_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif']);
// Baidu acjson 无 cookie 会返回 {"antiFlag":1,"message":"Forbid spider access"}。
// 首页 Set-Cookie 在进程内复用 5 分钟，避免每次搜索都多打一次首页。
const BAIDU_HOME_URL = 'https://image.baidu.com/';
const BAIDU_COOKIE_TTL_MS = 5 * 60 * 1000;
const BAIDU_HOME_MAX_CHARS = 20000;
const IMAGE_EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
});

const DEFAULTS = Object.freeze({
  enabled: true,
  providers: DEFAULT_PROVIDERS,
  maxCandidates: 8,
  previewBytes: 262144,
  maxPerMessage: 3,
  maxBytes: 8388608,
  maxPixels: 64000000,
  maxTotalBytesPerMessage: 20971520,
  safeMode: false,
  // 默认是否按「表情规格」发送（小图 + sub_type=1）。false = 发原图（按用户选择）；
  // 想"机器人发的图都能存成 QQ 表情"时设为 true（桥接侧默认值，MCP 仍可用 asSticker 逐次覆盖）。
  defaultAsSticker: false,
  dailyLimit: 0,
  cooldownMs: 0,
  cacheTtlMinutes: 10,
  dedupeWindowMinutes: 30,
  requestTimeoutMs: 10000,
  userAgent: 'qq-bridge-image/0.2.0'
});

// 数值约束：min / max 为允许区间，非法或越界一律回落默认值并写 warning。
const INT_FIELDS = Object.freeze({
  maxCandidates: { min: 1, max: 20 },
  previewBytes: { min: 65536, max: 1048576 },
  maxPerMessage: { min: 1, max: 5 },
  maxBytes: { min: 262144, max: 20971520 },
  maxPixels: { min: 1000000, max: 64000000 },
  maxTotalBytesPerMessage: { min: 1048576, max: 41943040 },
  dailyLimit: { min: 0, max: 1000 },
  cooldownMs: { min: 0, max: 3600000 },
  cacheTtlMinutes: { min: 1, max: 120 },
  dedupeWindowMinutes: { min: 0, max: 1440 },
  requestTimeoutMs: { min: 3000, max: 30000 }
});

// ── 配置收敛 ──────────────────────────────────────────────────────────────

function normalizeIntegerField(source, key, warnings) {
  const fallback = DEFAULTS[key];
  const rule = INT_FIELDS[key];
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    warnings.push(`imageSearch.${key} 必须是整数，已使用默认值 ${fallback}`);
    return fallback;
  }
  if (value < rule.min || value > rule.max) {
    warnings.push(`imageSearch.${key}=${value} 超出允许范围 ${rule.min}~${rule.max}，已使用默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

function normalizeBooleanField(source, key, warnings) {
  const fallback = DEFAULTS[key];
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    warnings.push(`imageSearch.${key} 必须是布尔值，已使用默认值 ${fallback}`);
    return fallback;
  }
  return value;
}

function normalizeProvidersField(source, warnings) {
  const value = source.providers;
  if (value === undefined) return [...DEFAULT_PROVIDERS];
  if (!Array.isArray(value)) {
    warnings.push('imageSearch.providers 必须是数组，已使用默认值 baidu,bing');
    return [...DEFAULT_PROVIDERS];
  }
  const providers = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string') {
      warnings.push(`imageSearch.providers[${index}] 必须是字符串，已忽略`);
      continue;
    }
    const id = item.trim().toLowerCase();
    if (!PROVIDER_IDS.includes(id)) {
      warnings.push(`imageSearch.providers[${index}] 不是受支持的 provider，已忽略`);
      continue;
    }
    if (!providers.includes(id)) providers.push(id);
  }
  if (providers.length === 0) return [...DEFAULT_PROVIDERS];
  return providers;
}

function normalizeUserAgentField(source, warnings) {
  const value = source.userAgent;
  if (value === undefined) return DEFAULTS.userAgent;
  if (typeof value !== 'string') {
    warnings.push('imageSearch.userAgent 必须是字符串，已使用默认值');
    return DEFAULTS.userAgent;
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    warnings.push('imageSearch.userAgent 长度必须是 1~200，已使用默认值');
    return DEFAULTS.userAgent;
  }
  return trimmed;
}

/**
 * 把 config.json 的 `imageSearch` 原始值收敛成安全可用的配置。
 * 任何越界/类型错误都只产生中文 warning 并回落默认值，**不会抛错**。
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeImageSearchConfig(raw) {
  const warnings = [];
  let source = raw;
  if (source === undefined || source === null) {
    source = {};
  } else if (typeof source !== 'object' || Array.isArray(source)) {
    warnings.push('imageSearch 配置必须是对象，已使用默认值');
    source = {};
  }

  const config = {
    enabled: normalizeBooleanField(source, 'enabled', warnings),
    providers: normalizeProvidersField(source, warnings),
    maxCandidates: normalizeIntegerField(source, 'maxCandidates', warnings),
    previewBytes: normalizeIntegerField(source, 'previewBytes', warnings),
    maxPerMessage: normalizeIntegerField(source, 'maxPerMessage', warnings),
    maxBytes: normalizeIntegerField(source, 'maxBytes', warnings),
    maxPixels: normalizeIntegerField(source, 'maxPixels', warnings),
    maxTotalBytesPerMessage: normalizeIntegerField(source, 'maxTotalBytesPerMessage', warnings),
    safeMode: normalizeBooleanField(source, 'safeMode', warnings),
    defaultAsSticker: normalizeBooleanField(source, 'defaultAsSticker', warnings),
    dailyLimit: normalizeIntegerField(source, 'dailyLimit', warnings),
    cooldownMs: normalizeIntegerField(source, 'cooldownMs', warnings),
    cacheTtlMinutes: normalizeIntegerField(source, 'cacheTtlMinutes', warnings),
    dedupeWindowMinutes: normalizeIntegerField(source, 'dedupeWindowMinutes', warnings),
    requestTimeoutMs: normalizeIntegerField(source, 'requestTimeoutMs', warnings),
    userAgent: normalizeUserAgentField(source, warnings)
  };
  return { config, warnings };
}

/**
 * 读取 `<root>/config.json` 里的 `imageSearch` 段；读不到/解析失败按默认配置。
 * @returns {{config: object, warnings: string[]}}
 */
export function loadImageSearchConfig(root = process.cwd()) {
  let file = {};
  try {
    const base = String(root ?? process.cwd());
    const text = fs.readFileSync(path.join(base, 'config.json'), 'utf8');
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    file = {};
  }
  let raw;
  try {
    raw = file?.imageSearch;
  } catch {
    raw = undefined;
  }
  return normalizeImageSearchConfig(raw);
}

// ── 查询清洗 ──────────────────────────────────────────────────────────────

function stripControlChars(value) {
  return String(value ?? '')
    // 控制字符 + 零宽/Bidi 等不可见格式字符：避免它们在标题/日志里伪装内容。
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, ' ');
}

function stripCqCodes(value) {
  return String(value ?? '').replace(/\[CQ:[^\]]*\]/gi, ' ');
}

function truncateChars(value, max) {
  return Array.from(String(value ?? '')).slice(0, max).join('');
}

/** 去 [CQ:...]、控制字符、折叠空白、trim、≤120 字。非字符串按 String() 处理后同样清洗。 */
export function sanitizeImageQuery(q) {
  let text = stripCqCodes(q);
  text = stripControlChars(text);
  text = text.replace(/\s+/g, ' ').trim();
  return truncateChars(text, MAX_QUERY_CHARS);
}

// ── URL 校验 ──────────────────────────────────────────────────────────────

function invalidUrlError(message) {
  const error = new Error(message);
  error.code = 'INVALID_URL';
  return error;
}

function normalizeAllowedPorts(allowedPorts) {
  const list = Array.isArray(allowedPorts) && allowedPorts.length > 0 ? allowedPorts : ['443'];
  return list.map((port) => String(port));
}

/**
 * 严格校验图片 URL：仅 https、无凭据、端口为空或命中 allowedPorts、绝对 URL，
 * 并且拒绝 localhost/.local/私有 IP 等明显 SSRF 目标（DNS 级校验仍由 safe-fetch 负责）。
 * 失败 throw Error，`error.code === 'INVALID_URL'`。
 */
export function validateImageUrl(raw, { allowedPorts = ['443'] } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw invalidUrlError('图片地址为空');
  if (!/^https?:\/\//i.test(text)) throw invalidUrlError('图片地址必须是绝对 URL');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw invalidUrlError('图片地址不是合法 URL');
  }
  if (url.protocol !== 'https:') throw invalidUrlError('图片地址必须是 https');
  if (url.username || url.password) throw invalidUrlError('图片地址不能包含凭据');
  const hostname = url.hostname.toLowerCase();
  if (!hostname) throw invalidUrlError('图片地址缺少主机名');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw invalidUrlError('图片地址不允许本机/内网主机');
  }
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bareHost) && isPrivateIp(bareHost)) {
    throw invalidUrlError('图片地址不允许内网/本机 IP');
  }
  const port = url.port || '443';
  const ports = normalizeAllowedPorts(allowedPorts);
  if (!ports.includes(port)) throw invalidUrlError(`图片地址端口不被允许（${port}）`);
  return url.toString();
}

/**
 * 宽松的页面 URL 校验（og:image 页面用）：仅 https、无凭据、长度 ≤2048。
 * 失败返回空字符串（调用方按「跳过该页面」处理）。
 */
export function validatePageUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > MAX_URL_LENGTH) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  if (!url.hostname) return '';
  const textUrl = url.toString();
  if (textUrl.length > MAX_URL_LENGTH) return '';
  return textUrl;
}

// ── 图片字节解析 ──────────────────────────────────────────────────────────

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

/** 按 magic bytes 判断 MIME；非 PNG/JPEG/GIF/WebP 返回 ''。 */
export function mimeTypeFromBuffer(buf) {
  const buffer = asBuffer(buf);
  if (!buffer || buffer.length < 3) return '';
  if (buffer.length >= 8) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
      return 'image/png';
    }
    const head = buffer.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  return '';
}

/**
 * 解析 PNG/JPEG/GIF/WebP 的宽高；解析不了返回 null。
 * WebP 覆盖 VP8X / VP8L / VP8 三种容器（防止「图片炸弹」绕过像素上限）。
 */
export function imageSizeFromBuffer(buf) {
  const buffer = asBuffer(buf);
  if (!buffer || buffer.length < 10) return null;
  try {
    // PNG：8 字节签名 + IHDR（宽高在 16/20 偏移）。
    if (buffer.length >= 24 && mimeTypeFromBuffer(buffer) === 'image/png') {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    // GIF：逻辑屏幕描述符（6 字节签名 + 4 字节宽高）。
    const head = buffer.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    // JPEG：遍历标记段，取 SOF0-SOF15（排除 DHT/DAC/DNL/DRI）。
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        if (marker === 0x00 || marker === 0xff) { offset += 1; continue; }
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) return null;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          if (width > 0 && height > 0) return { width, height };
          return null;
        }
        offset += 2 + length;
      }
      return null;
    }
    // WebP：RIFF....WEBP + VP8X / VP8L / VP8 三种容器。
    if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buffer.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buffer.length >= 30) {
        const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
        const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
        return { width, height };
      }
      if (fourcc === 'VP8L' && buffer.length >= 25) {
        const bits = [buffer[21], buffer[22], buffer[23], buffer[24]];
        const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
        const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
        return { width, height };
      }
      if (fourcc === 'VP8 ' && buffer.length >= 30) {
        const width = buffer.readUInt16LE(26) & 0x3fff;
        const height = buffer.readUInt16LE(28) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 校验并描述图片字节：非四种受支持格式时 throw（`error.code === 'NOT_IMAGE'`）。
 * @returns {{ok:true, mimeType:string, ext:string, width:number|null, height:number|null, bytes:number, sha256:string}}
 */
export function inspectImageBytes(buf) {
  const buffer = asBuffer(buf);
  const mimeType = buffer ? mimeTypeFromBuffer(buffer) : '';
  if (!mimeType) {
    const error = new Error('内容不是受支持的图片（PNG/JPEG/GIF/WebP）');
    error.code = 'NOT_IMAGE';
    throw error;
  }
  const size = imageSizeFromBuffer(buffer);
  return {
    ok: true,
    mimeType,
    ext: IMAGE_EXT_BY_MIME[mimeType],
    width: size?.width ?? null,
    height: size?.height ?? null,
    bytes: buffer.length,
    sha256: sha256Hex(buffer)
  };
}

/**
 * Content-Type 白名单：空/未知（undefined、'') 放行（靠 magic bytes 兜底）；
 * 仅 image/png、image/jpeg、image/jpg、image/gif、image/webp 接受。
 */
export function isAcceptableImageContentType(ct) {
  if (ct === undefined || ct === null) return true;
  const raw = String(ct).trim().toLowerCase();
  if (!raw) return true;
  const base = raw.split(';')[0].trim();
  if (!base) return true;
  return ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].includes(base);
}

/**
 * 明显占位/跟踪像素下限（内部常量，**不进配置**）：
 * 原始图片字节 < 2048 或宽/高 < 8 视为不可用。Baidu 的 gimg 代理偶发返回
 * 52 字节 GIF / 1×1 空图，喂给视觉模型没有信息量，发给 QQ 也没有意义。
 * preview 与 prepareSend 共用同一条线；失败分别标 preview:'failed' / failed。
 */
function assertImageNotPlaceholder(buffer, label = '图片') {
  if (buffer.length < MIN_IMAGE_BYTES) {
    throw new Error(`${label}过小（${buffer.length} 字节 < ${MIN_IMAGE_BYTES}），疑似占位图`);
  }
  const size = imageSizeFromBuffer(buffer);
  if (size && (size.width < MIN_IMAGE_EDGE || size.height < MIN_IMAGE_EDGE)) {
    throw new Error(`${label}尺寸过小（${size.width}x${size.height}），疑似占位图`);
  }
}

// ── 不可信文本清洗 ────────────────────────────────────────────────────────

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
});

function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    const key = String(body).toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

/**
 * 标题/来源清洗：解码实体 → 去 CQ 码 → 去脚本/样式/标签 → 去控制字符 → 折叠空白 → ≤120 字。
 * 返回值始终作为纯文本使用，绝不当 HTML/指令执行。
 */
function stripUntrusted(value) {
  let text = decodeHtmlEntities(value);
  text = stripCqCodes(text);
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = stripControlChars(text);
  text = text.replace(/\s+/g, ' ').trim();
  return truncateChars(text, MAX_TITLE_CHARS);
}

function parseTagAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = re.exec(String(tag ?? ''))) !== null) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function firstString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function firstValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    return value;
  }
  return null;
}

function toPositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

function toNonNegativeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num);
}

function hostnameOf(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.hostname ? url.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function cleanHostname(value) {
  let text = stripControlChars(value).trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  text = text.split(/[/?#]/)[0];
  text = text.replace(/:\d+$/, '');
  if (text.startsWith('[') && text.endsWith(']')) return text;
  return /^[a-z0-9.-]+$/.test(text) ? text : '';
}

function normalizeSource(value) {
  const text = stripControlChars(value).trim().toLowerCase();
  return text.replace(/:\d+$/, '');
}

function isHttpUrl(raw) {
  return /^http:\/\//i.test(String(raw ?? '').trim());
}

/** 只接受 https（含协议相对 // 按 https 处理）；返回 .toString() 或 ''。 */
function toHttps(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^data:/i.test(text) || /^javascript:/i.test(text)) return '';
  if (text.startsWith('//')) text = `https:${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function resolveHttpsUrl(raw, base) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^data:/i.test(text) || /^javascript:/i.test(text) || text.startsWith('#')) return '';
  let candidate = text;
  if (text.startsWith('//')) candidate = `https:${text}`;
  try {
    const url = new URL(candidate, base || undefined);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

// ── 候选构造 / 合并 ───────────────────────────────────────────────────────

function makeCandidate(partial = {}) {
  return {
    title: stripUntrusted(partial.title ?? ''),
    thumbUrl: String(partial.thumbUrl ?? ''),
    imageUrl: String(partial.imageUrl ?? ''),
    pageUrl: String(partial.pageUrl ?? ''),
    provider: String(partial.provider ?? ''),
    source: normalizeSource(partial.source ?? ''),
    width: toPositiveInt(partial.width),
    height: toPositiveInt(partial.height),
    bytes: toNonNegativeInt(partial.bytes)
  };
}

function withNote(list, note) {
  try {
    Object.defineProperty(list, 'note', {
      value: note || '',
      enumerable: false,
      configurable: true
    });
  } catch {
    // 数组加属性失败不影响主流程
  }
  return list;
}

function normalizeLimit(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const floored = Math.floor(num);
  if (floored <= 0) return 0;
  return Math.min(floored, 200);
}

function parseJsonLoose(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  try {
    return JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  } catch {
    // 兼容 JSONP / 尾部垃圾：截取最外层大括号再试一次
  }
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeUrlForCompare(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function candidateDedupeKey(candidate) {
  const image = normalizeUrlForCompare(candidate.imageUrl);
  if (image) return `image:${image}`;
  const thumb = normalizeUrlForCompare(candidate.thumbUrl);
  if (thumb) return `thumb:${thumb}`;
  const page = normalizeUrlForCompare(candidate.pageUrl);
  if (page) return `page:${page}|${candidate.width ?? ''}x${candidate.height ?? ''}`;
  return '';
}

/**
 * 按 imageUrl 规范化 → thumbUrl → (pageUrl+尺寸) 去重，保持传入顺序，取前 limit，
 * 并分配 candidateId = 1..N。
 */
export function mergeCandidates(lists, { limit = PROVIDER_CANDIDATE_LIMIT } = {}) {
  const max = normalizeLimit(limit, PROVIDER_CANDIDATE_LIMIT);
  const merged = [];
  const seen = new Set();
  for (const list of Array.isArray(lists) ? lists : []) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const candidate = makeCandidate(item);
      const key = candidateDedupeKey(candidate);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(candidate);
      if (merged.length >= max) break;
    }
    if (merged.length >= max) break;
  }
  return merged.map((candidate, index) => ({ ...candidate, candidateId: index + 1 }));
}

// ── provider 纯解析器（不联网） ──────────────────────────────────────────

/**
 * 百度 acjson 解析。兼容 data[] 里的 thumbURL / middleURL / hoverURL /
 * replaceUrl[].ObjURL / fromPageTitleEnc / fromURLHost / width / height 等字段。
 * 只保留 https；`item.objURL` 是加密字段，**绝不当 imageUrl 使用**。
 * JSON 解析失败返回 []（不抛错）。
 */
export function parseBaiduImageJson(text, { limit = PROVIDER_CANDIDATE_LIMIT } = {}) {
  const max = normalizeLimit(limit, PROVIDER_CANDIDATE_LIMIT);
  const list = [];
  let dropped = 0;
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return withNote(list, '');
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  for (const item of data) {
    if (list.length >= max) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const thumbRaw = firstString(item.thumbURL, item.thumbUrl, item.hoverURL, item.hoverUrl);
    const middleRaw = firstString(item.middleURL, item.middleUrl);
    const pageRaw = firstString(item.fromURL, item.fromUrl, item.purl);
    const replaceRaws = [];
    if (Array.isArray(item.replaceUrl)) {
      for (const entry of item.replaceUrl) {
        if (typeof entry === 'string') replaceRaws.push(entry);
        else if (entry && typeof entry === 'object') {
          replaceRaws.push(firstString(entry.ObjURL, entry.objURL, entry.objUrl));
        }
      }
    }
    for (const rawUrl of [...replaceRaws, middleRaw, thumbRaw]) {
      if (rawUrl && !toHttps(rawUrl)) dropped += 1;
    }
    const imageUrl = toHttps(firstString(...replaceRaws)) || toHttps(middleRaw) || toHttps(thumbRaw);
    if (!imageUrl) continue;
    const thumbUrl = toHttps(thumbRaw) || imageUrl;
    const pageUrl = validatePageUrl(pageRaw);
    const source = cleanHostname(item.fromURLHost) || hostnameOf(pageUrl) || hostnameOf(imageUrl);
    list.push(makeCandidate({
      title: firstString(item.fromPageTitleEnc, item.fromPageTitle, item.title),
      thumbUrl,
      imageUrl,
      pageUrl,
      provider: 'baidu',
      source,
      width: item.width,
      height: item.height,
      bytes: firstValue(item.byteSize, item.bytes, item.fileSize)
    }));
  }
  return withNote(list, dropped > 0 ? `百度图片已丢弃 ${dropped} 个非 https 链接` : '');
}

function parseJsonAttribute(rawAttr) {
  const base = String(rawAttr ?? '');
  if (!base.trim()) return null;
  const attempts = [decodeHtmlEntities(base), decodeHtmlEntities(decodeHtmlEntities(base))];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 尝试下一种反转义结果
    }
  }
  return null;
}

/**
 * Bing 图片结果页解析：从 `m="{...}"` 属性里取 murl/turl/purl/t 字段。
 * HTML 实体先反转义（&quot; &amp;），只保留 https，title 用 t 字段或相邻 alt。
 */
export function parseBingImageHtml(html, { limit = PROVIDER_CANDIDATE_LIMIT } = {}) {
  const source = String(html ?? '');
  const max = normalizeLimit(limit, PROVIDER_CANDIDATE_LIMIT);
  const list = [];
  let dropped = 0;
  const attrRe = /\bm\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let match;
  while (list.length < max && (match = attrRe.exec(source)) !== null) {
    const rawAttr = match[1] ?? match[2] ?? '';
    const entry = parseJsonAttribute(rawAttr);
    if (!entry) continue;
    const murlRaw = firstString(entry.murl, entry.mUrl);
    const turlRaw = firstString(entry.turl, entry.tUrl);
    const purlRaw = firstString(entry.purl, entry.pUrl);
    const imageUrl = toHttps(murlRaw);
    if (!imageUrl) {
      if (murlRaw || turlRaw || purlRaw) dropped += 1;
      continue;
    }
    let title = stripUntrusted(firstString(entry.t, entry.title));
    if (!title) {
      const tail = source.slice(attrRe.lastIndex, attrRe.lastIndex + 2000);
      const altMatch = /<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tail);
      if (altMatch) title = stripUntrusted(altMatch[1] ?? altMatch[2] ?? '');
    }
    const pageUrl = validatePageUrl(purlRaw);
    list.push(makeCandidate({
      title,
      thumbUrl: toHttps(turlRaw) || imageUrl,
      imageUrl,
      pageUrl,
      provider: 'bing',
      source: hostnameOf(pageUrl) || hostnameOf(imageUrl),
      width: entry.width,
      height: entry.height,
      bytes: firstValue(entry.byteSize, entry.bytes, entry.fileSize)
    }));
  }
  return withNote(list, dropped > 0 ? `必应图片已丢弃 ${dropped} 个非 https 链接` : '');
}

function extractTitleTag(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  return match ? match[1] : '';
}

/**
 * 页面 og:image / twitter:image / <img src> 解析。相对 URL 用 pageUrl 解析，
 * 只保留 https；title 用 og:title（其次 twitter:title / <title>）。
 */
export function parseOgImageHtml(html, pageUrl) {
  const source = String(html ?? '');
  const page = validatePageUrl(pageUrl);
  const list = [];
  let dropped = 0;
  let title = '';
  let twitterTitle = '';
  const images = [];
  const metaRe = /<meta\b[^>]*>/gi;
  let match;
  while ((match = metaRe.exec(source)) !== null) {
    const attrs = parseTagAttributes(match[0]);
    const key = String(attrs.property || attrs.name || '').trim().toLowerCase();
    const content = attrs.content ?? '';
    if (!key || !content) continue;
    if (key === 'og:title') { if (!title) title = content; continue; }
    if (key === 'twitter:title') { if (!twitterTitle) twitterTitle = content; continue; }
    if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url') {
      images.push(content);
      continue;
    }
    if (key === 'twitter:image' || key === 'twitter:image:src') images.push(content);
  }
  const finalTitle = stripUntrusted(title || twitterTitle || extractTitleTag(source));
  const resolve = (raw) => {
    const url = resolveHttpsUrl(raw, page);
    if (!url && raw) dropped += 1;
    return url;
  };
  for (const raw of images) {
    const url = resolve(raw);
    if (!url) continue;
    list.push(makeCandidate({
      title: finalTitle,
      thumbUrl: url,
      imageUrl: url,
      pageUrl: page,
      provider: 'webpage-og',
      source: hostnameOf(page) || hostnameOf(url)
    }));
  }
  const imgRe = /<img\b[^>]*>/gi;
  let imageTags = 0;
  while (imageTags < 10 && (match = imgRe.exec(source)) !== null) {
    const attrs = parseTagAttributes(match[0]);
    const src = attrs.src ?? '';
    if (!src.trim()) continue;
    imageTags += 1;
    const url = resolve(src);
    if (!url) continue;
    list.push(makeCandidate({
      title: finalTitle,
      thumbUrl: url,
      imageUrl: url,
      pageUrl: page,
      provider: 'webpage-og',
      source: hostnameOf(page) || hostnameOf(url)
    }));
  }
  return withNote(list, dropped > 0 ? `页面图片已丢弃 ${dropped} 个非 https 链接` : '');
}

// ── 默认抓取器 ───────────────────────────────────────────────────────────

/**
 * 默认抓取器（测试会注入同名桩）：
 * - fetchText: safeFetch，强制 https + 标准端口
 * - fetchBuffer: safeFetchBuffer，强制 https + 标准端口
 * - searchWeb: src/web-search.js 的 webSearch，返回 results 数组
 */
export const defaultImageFetchers = {
  async fetchText(url, {
    headers,
    timeoutMs,
    requireHttps = true,
    allowedPorts = ['443'],
    maxChars = MAX_TEXT_CHARS
  } = {}) {
    // 原样透传 safeFetch 结果（含 `headers`，Baidu 反爬要读首页响应里的 set-cookie）。
    return safeFetch(url, maxChars, { headers, timeoutMs, requireHttps, allowedPorts });
  },

  async fetchBuffer(url, {
    headers,
    timeoutMs,
    requireHttps = true,
    allowedPorts = ['443'],
    maxBytes = DEFAULTS.maxBytes
  } = {}) {
    return safeFetchBuffer(url, maxBytes, { headers, timeoutMs, requireHttps, allowedPorts });
  },

  async searchWeb(query, { maxResults, root } = {}) {
    const options = {};
    if (root !== undefined) options.root = root;
    const limit = Number(maxResults);
    if (Number.isFinite(limit) && limit > 0) options.config = { maxResults: Math.max(1, Math.min(20, Math.round(limit))) };
    const result = await webSearch(query, options);
    return Array.isArray(result?.results) ? result.results : [];
  }
};

// ── provider 执行（联网部分，测试注入桩） ────────────────────────────────

function providerHeaders(providerId, query, config) {
  const headers = { 'user-agent': config.userAgent };
  if (providerId === 'baidu') headers.referer = 'https://image.baidu.com/';
  else if (providerId === 'bing') headers.referer = `https://cn.bing.com/images/search?q=${encodeURIComponent(query)}`;
  return headers;
}

function buildBaiduImageUrl(query) {
  const params = new URLSearchParams();
  const pairs = {
    tn: 'resultjson_com',
    ipn: 'rj',
    ct: '201326592',
    fp: 'result',
    word: query,
    queryWord: query,
    cl: '2',
    lm: '-1',
    ie: 'utf-8',
    oe: 'utf-8',
    st: '-1',
    ic: '0',
    face: '0',
    istype: '2',
    nc: '1',
    pn: '0',
    rn: '30',
    gsm: '1e'
  };
  for (const [key, value] of Object.entries(pairs)) params.set(key, value);
  return `https://image.baidu.com/search/acjson?${params.toString()}`;
}

function buildBingImageUrl(query) {
  const params = new URLSearchParams({ q: query, first: '0', count: '30', mmasync: '1' });
  return `https://cn.bing.com/images/async?${params.toString()}`;
}

/**
 * 统一 fetchText 返回形态：string 或 safeFetch 结果对象。
 * 返回 `{ body, headers }` —— Baidu 反爬需要读首页响应里的 Set-Cookie；
 * 旧桩只返回字符串时 headers 视为空对象（向后兼容）。
 */
async function callFetchText(fetchText, url, options) {
  const result = await fetchText(url, options);
  if (typeof result === 'string') return { body: result, headers: {} };
  if (result && typeof result === 'object') {
    if (Number.isFinite(result.statusCode) && (result.statusCode < 200 || result.statusCode >= 300)) {
      throw new Error(`抓取失败：HTTP ${result.statusCode}`);
    }
    if (typeof result.body === 'string') {
      const headers = result.headers && typeof result.headers === 'object' ? result.headers : {};
      return { body: result.body, headers };
    }
  }
  throw new Error('抓取结果为空');
}

/** 统一 fetchBuffer 返回形态：Buffer/Uint8Array 或 safeFetchBuffer 结果对象。 */
async function callFetchBuffer(fetchBuffer, url, options) {
  const result = await fetchBuffer(url, options);
  let buffer = null;
  let contentType = '';
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
    buffer = asBuffer(result);
  } else if (result && typeof result === 'object') {
    if (Number.isFinite(result.statusCode) && (result.statusCode < 200 || result.statusCode >= 300)) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    contentType = result.contentType ?? '';
    buffer = asBuffer(result.buffer);
  }
  if (!buffer || buffer.length === 0) throw new Error('图片内容为空');
  return { buffer, contentType };
}

async function callSearchWeb(searchWeb, query, options) {
  const result = await searchWeb(query, options);
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.results)) return result.results;
  return [];
}

/** 从响应头里提取可回放的 Cookie（只取 name=value，忽略属性；兼容 set-cookie 数组）。 */
function cookieFromResponseHeaders(headers) {
  const raw = headers?.['set-cookie'] ?? headers?.['Set-Cookie'];
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const pairs = [];
  for (const item of items) {
    const first = String(item ?? '').split(';')[0].trim();
    if (!first || !first.includes('=')) continue;
    pairs.push(first);
  }
  return [...new Set(pairs)].join('; ');
}

function baiduHomeHeaders(config) {
  return { 'user-agent': config.userAgent, referer: BAIDU_HOME_URL };
}

function baiduAcjsonHeaders(query, config, cookie) {
  const headers = {
    'user-agent': config.userAgent,
    referer: `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(query)}`,
    'x-requested-with': 'XMLHttpRequest',
    accept: 'text/plain, */*; q=0.01'
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

/**
 * 取/复用 Baidu 首页 Cookie（服务实例内缓存 5 分钟，避免每次搜索都打首页）。
 * 拿不到 cookie 不抛错：继续裸请求 acjson，由调用方按 antiFlag/0 条处理。
 */
async function ensureBaiduCookie(ctx) {
  const cache = ctx.baiduCookie;
  const current = ctx.now();
  if (cache && cache.value && current - cache.at < BAIDU_COOKIE_TTL_MS) return cache.value;
  try {
    const home = await callFetchText(ctx.fetchText, BAIDU_HOME_URL, {
      headers: baiduHomeHeaders(ctx.config),
      maxChars: BAIDU_HOME_MAX_CHARS,
      timeoutMs: ctx.config.requestTimeoutMs
    });
    const cookie = cookieFromResponseHeaders(home.headers);
    if (cache) {
      cache.value = cookie;
      cache.at = cookie ? current : 0;
    }
    return cookie;
  } catch {
    if (cache) {
      cache.value = '';
      cache.at = 0;
    }
    return '';
  }
}

/** 识别 antiFlag / 空结果，返回可读中文原因（不含 cookie、查询串）。 */
function baiduAntiFlagReason(body) {
  const text = String(body ?? '').trim();
  if (!text) return '百度图片返回空响应';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (Number(parsed.antiFlag) === 1) return '百度图片返回反爬校验（antiFlag），本次没有候选';
      if (Array.isArray(parsed.data) && parsed.data.length === 0) return '百度图片没有返回结果';
    }
  } catch {
    // 非 JSON：走关键字兜底
  }
  if (/forbid\s+spider|antiFlag/i.test(text)) return '百度图片返回反爬校验（antiFlag），本次没有候选';
  return '';
}

async function fetchBaiduAcjson(ctx) {
  const cookie = await ensureBaiduCookie(ctx);
  return callFetchText(ctx.fetchText, buildBaiduImageUrl(ctx.query), {
    headers: baiduAcjsonHeaders(ctx.query, ctx.config, cookie),
    maxChars: MAX_TEXT_CHARS,
    timeoutMs: ctx.config.requestTimeoutMs
  });
}

/**
 * Baidu：先 GET 首页取 Set-Cookie，再带 Cookie/Referer/x-requested-with/accept 请求 acjson。
 * antiFlag 或 0 条时清 cookie 重试一次；仍失败也只返回 0 条 + note（provider 不抛错）。
 */
async function runBaiduProvider(ctx) {
  const notes = [];
  let response = await fetchBaiduAcjson(ctx);
  let list = parseBaiduImageJson(response.body, { limit: PROVIDER_CANDIDATE_LIMIT });
  let reason = list.length === 0 ? baiduAntiFlagReason(response.body) : '';
  if (list.length === 0) {
    if (ctx.baiduCookie) {
      ctx.baiduCookie.value = '';
      ctx.baiduCookie.at = 0;
    }
    try {
      response = await fetchBaiduAcjson(ctx);
      list = parseBaiduImageJson(response.body, { limit: PROVIDER_CANDIDATE_LIMIT });
      reason = list.length > 0 ? '' : (baiduAntiFlagReason(response.body) || '百度图片没有返回结果');
    } catch (error) {
      reason = `百度图片重试失败：${summarizeError(error)}`;
    }
  }
  const parseNote = String(list.note ?? '');
  if (parseNote) notes.push(parseNote);
  if (list.length === 0 && reason) notes.push(reason);
  return withNote(list, notes.join('；'));
}

async function runBingProvider(ctx) {
  const response = await callFetchText(ctx.fetchText, buildBingImageUrl(ctx.query), {
    headers: providerHeaders('bing', ctx.query, ctx.config),
    maxChars: MAX_TEXT_CHARS,
    timeoutMs: ctx.config.requestTimeoutMs
  });
  return parseBingImageHtml(response.body, { limit: PROVIDER_CANDIDATE_LIMIT });
}

async function runWebpageOgProvider(ctx) {
  const results = await callSearchWeb(ctx.searchWeb, ctx.query, { maxResults: SEARCH_WEB_MAX_RESULTS });
  const pages = [];
  for (const item of results) {
    const page = validatePageUrl(item?.url ?? item?.link);
    if (page && !pages.includes(page)) pages.push(page);
    if (pages.length >= OG_MAX_PAGES) break;
  }
  const pageLists = new Array(pages.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < pages.length) {
      const index = cursor;
      cursor += 1;
      const page = pages[index];
      try {
        const response = await callFetchText(ctx.fetchText, page, {
          headers: { 'user-agent': ctx.config.userAgent },
          maxChars: MAX_TEXT_CHARS,
          timeoutMs: ctx.config.requestTimeoutMs
        });
        pageLists[index] = parseOgImageHtml(response.body, page);
      } catch {
        // 单页失败不致命：og:image 属于「尽力而为」的兜底来源
        pageLists[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(OG_PAGE_CONCURRENCY, pages.length) }, () => worker()));
  const combined = [];
  const notes = [];
  for (const list of pageLists) {
    if (!Array.isArray(list)) continue;
    for (const candidate of list) combined.push(candidate);
    if (list.note) notes.push(list.note);
  }
  return withNote(combined, notes.join('；'));
}

const PROVIDER_RUNNERS = Object.freeze({
  baidu: runBaiduProvider,
  bing: runBingProvider,
  'webpage-og': runWebpageOgProvider
});

// ── 错误 / 日志摘要 ───────────────────────────────────────────────────────

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 错误摘要 ≤200 字；抹掉 URL 的 query/fragment，避免把敏感查询串写进日志。 */
function summarizeError(value) {
  let text = String(value?.message ?? value ?? '').trim();
  text = text.replace(/https?:\/\/[^\s"'`<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '[url]';
    }
  });
  return truncateChars(text, 200);
}

function clampCount(value, max) {
  if (value === undefined || value === null) return max;
  const num = Number(value);
  if (!Number.isFinite(num)) return max;
  const rounded = Math.round(num);
  if (rounded < 1) return 1;
  return Math.min(rounded, max);
}

function normalizeServiceConfig(value) {
  let raw = value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const looksLikeImageSearch = Object.keys(DEFAULTS).some((key) => Object.hasOwn(raw, key));
    if (!looksLikeImageSearch && Object.hasOwn(raw, 'imageSearch')) raw = raw.imageSearch;
  }
  return normalizeImageSearchConfig(raw).config;
}

// ── 服务 ──────────────────────────────────────────────────────────────────

/**
 * 创建图片检索服务。所有 I/O 都可注入，便于离线单测。
 *
 * @param {object} options
 * @param {() => any} [options.getConfig]     返回 imageSearch 配置（或整份 config）
 * @param {Function} [options.fetchText]      抓文本，签名同 defaultImageFetchers.fetchText
 * @param {Function} [options.fetchBuffer]    抓字节，签名同 defaultImageFetchers.fetchBuffer
 * @param {Function} [options.searchWeb]      联网搜索，签名同 defaultImageFetchers.searchWeb
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 */
export function createImageSearchService({
  getConfig = () => loadImageSearchConfig(process.cwd()).config,
  fetchText = defaultImageFetchers.fetchText,
  fetchBuffer = defaultImageFetchers.fetchBuffer,
  searchWeb = defaultImageFetchers.searchWeb,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  const cache = new Map(); // searchId -> { searchId, createdAt, expiresAt, candidates }
  // Baidu 首页 Cookie 缓存（服务实例内、约 5 分钟）：进程内复用，重启即失效，不落盘。
  const baiduCookie = { value: '', at: 0 };

  async function readConfig() {
    let value;
    try {
      value = await getConfig();
    } catch (error) {
      throw codedError('CONFIG_ERROR', `读取图片检索配置失败：${summarizeError(error)}`);
    }
    return normalizeServiceConfig(value);
  }

  function getCachedSearch(searchId) {
    const key = String(searchId ?? '');
    const entry = cache.get(key);
    if (!entry) throw codedError('SEARCH_NOT_FOUND', '图片搜索结果不存在，请重新搜索');
    if (now() >= entry.expiresAt) throw codedError('SEARCH_EXPIRED', '图片搜索结果已过期，请重新搜索');
    return entry;
  }

  function downloadHeaders(candidate, config) {
    const headers = { 'user-agent': config.userAgent };
    if (candidate.provider === 'baidu') headers.referer = 'https://image.baidu.com/';
    else if (candidate.provider === 'bing') headers.referer = 'https://cn.bing.com/';
    else if (candidate.pageUrl) headers.referer = candidate.pageUrl;
    return headers;
  }

  /** 下载单张预览并校验（previewBytes / Content-Type / magic bytes / 占位图下限）。 */
  async function downloadPreview(rawUrl, candidate, config) {
    const url = validateImageUrl(rawUrl, { allowedPorts: ['443'] });
    const result = await callFetchBuffer(fetchBuffer, url, {
      headers: downloadHeaders(candidate, config),
      maxBytes: config.previewBytes,
      timeoutMs: config.requestTimeoutMs,
      requireHttps: true,
      allowedPorts: ['443']
    });
    if (result.buffer.length > config.previewBytes) {
      throw new Error(`缩略图超过大小上限（${result.buffer.length} 字节）`);
    }
    if (!isAcceptableImageContentType(result.contentType)) throw new Error('缩略图内容类型不是图片');
    const mimeType = mimeTypeFromBuffer(result.buffer);
    if (!mimeType) throw new Error('缩略图不是有效图片');
    assertImageNotPlaceholder(result.buffer, '缩略图');
    return { buffer: result.buffer, mimeType };
  }

  /**
   * 预览兜底：先试 thumbUrl，失败（CDN 被重置/占位图/类型不对）后按同样 previewBytes
   * 上限再试 imageUrl。两者都失败才标 preview:'failed'（不致命）。
   */
  async function loadPreview(candidate, config, searchId) {
    const attempts = [];
    for (const raw of [candidate.thumbUrl, candidate.imageUrl]) {
      if (raw && !attempts.includes(raw)) attempts.push(raw);
    }
    for (let index = 0; index < attempts.length; index += 1) {
      try {
        const downloaded = await downloadPreview(attempts[index], candidate, config);
        return {
          preview: 'ok',
          bytes: downloaded.buffer.length,
          entry: {
            candidateId: candidate.candidateId,
            mimeType: downloaded.mimeType,
            dataBase64: downloaded.buffer.toString('base64')
          }
        };
      } catch (error) {
        log(`image-search ${searchId} preview candidate=${candidate.candidateId} attempt=${index + 1} failed: ${summarizeError(error)}`);
      }
    }
    const fallbackBytes = typeof candidate.bytes === 'number' && candidate.bytes > 0 ? candidate.bytes : 0;
    return { preview: 'failed', bytes: fallbackBytes, entry: null };
  }

  async function loadPreviews(candidates, config, searchId) {
    const results = new Array(candidates.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await loadPreview(candidates[index], config, searchId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, candidates.length) }, () => worker()));
    return results;
  }

  async function downloadOriginal(candidate, config) {
    const url = validateImageUrl(candidate.imageUrl || candidate.thumbUrl, { allowedPorts: ['443'] });
    const result = await callFetchBuffer(fetchBuffer, url, {
      headers: downloadHeaders(candidate, config),
      maxBytes: config.maxBytes,
      timeoutMs: config.requestTimeoutMs,
      requireHttps: true,
      allowedPorts: ['443']
    });
    if (result.buffer.length > config.maxBytes) {
      throw new Error(`图片超过大小上限（${result.buffer.length} 字节 > ${config.maxBytes}）`);
    }
    if (!isAcceptableImageContentType(result.contentType)) throw new Error('图片内容类型不被接受');
    const info = inspectImageBytes(result.buffer);
    if (!info.width || !info.height) throw new Error('无法识别图片尺寸');
    if (info.width * info.height > config.maxPixels) {
      throw new Error(`图片像素超过上限（${info.width}x${info.height} > ${config.maxPixels}）`);
    }
    assertImageNotPlaceholder(result.buffer, '图片');
    return {
      candidateId: candidate.candidateId,
      buffer: result.buffer,
      mimeType: info.mimeType,
      ext: info.ext,
      width: info.width,
      height: info.height,
      bytes: result.buffer.length,
      sha256: info.sha256,
      source: candidate.source,
      pageUrl: candidate.pageUrl,
      provider: candidate.provider
    };
  }

  /**
   * 表情模式下载：优先检索缩略图（几十 KB），失败再试原图，并强制「QQ 可保存为表情」的规格。
   * 与 downloadOriginal 的区别：这里不接受超大/超尺寸/WebP 的图（宁可失败让调用方回退成普通图片），
   * 因为表情模式的目标就是"发出去之后接收方长按能添加到表情"。
   */
  async function downloadStickerSource(candidate, config) {
    const attempts = [];
    for (const raw of [candidate.thumbUrl, candidate.imageUrl]) {
      if (raw && !attempts.includes(raw)) attempts.push(raw);
    }
    const failures = [];
    for (const raw of attempts) {
      try {
        const url = validateImageUrl(raw, { allowedPorts: ['443'] });
        const result = await callFetchBuffer(fetchBuffer, url, {
          headers: downloadHeaders(candidate, config),
          maxBytes: STICKER_MAX_BYTES,
          timeoutMs: config.requestTimeoutMs,
          requireHttps: true,
          allowedPorts: ['443']
        });
        if (!isAcceptableImageContentType(result.contentType)) throw new Error('内容类型不是图片');
        const info = inspectImageBytes(result.buffer);
        if (!info.width || !info.height) throw new Error('无法识别图片尺寸');
        if (result.buffer.length > STICKER_MAX_BYTES) throw new Error(`超过表情大小上限（${result.buffer.length} 字节）`);
        if (Math.max(info.width, info.height) > STICKER_MAX_EDGE) throw new Error(`尺寸超过表情上限（${info.width}x${info.height}）`);
        if (!STICKER_MIME_TYPES.includes(info.mimeType)) throw new Error(`格式不适合做表情（${info.mimeType}）`);
        assertImageNotPlaceholder(result.buffer, '表情图片');
        return {
          candidateId: candidate.candidateId,
          buffer: result.buffer,
          mimeType: info.mimeType,
          ext: info.ext,
          width: info.width,
          height: info.height,
          bytes: result.buffer.length,
          sha256: info.sha256,
          source: candidate.source,
          pageUrl: candidate.pageUrl,
          provider: candidate.provider,
          sticker: true
        };
      } catch (error) {
        failures.push(summarizeError(error));
      }
    }
    throw new Error(failures.length > 0 ? `不适合做表情（${failures.join('；')}）` : '没有可用的表情图');
  }

  /**
   * 执行一次图片搜索：按配置顺序调用 provider → 合并去重 → 下载缩略图 → 写入内存缓存。
   * 空 query / 配置关闭为硬错误；单个 provider 或单张缩略图失败都不致命。
   */
  async function search({ query, count } = {}) {
    const cleanQuery = sanitizeImageQuery(query);
    if (!cleanQuery) throw codedError('INVALID_ARGUMENT', '图片搜索关键词不能为空');
    const config = await readConfig();
    if (config.enabled === false) throw codedError('DISABLED', '图片搜索已在配置中关闭');
    const targetCount = clampCount(count, config.maxCandidates);
    const searchId = randomUUID();
    const lists = [];
    const notes = [];
    const providers = [];

    for (const providerId of config.providers) {
      const startedAt = now();
      try {
        const runner = PROVIDER_RUNNERS[providerId];
        if (typeof runner !== 'function') throw new Error(`不支持的 provider：${providerId}`);
        const list = await runner({ query: cleanQuery, config, fetchText, fetchBuffer, searchWeb, now, baiduCookie });
        const itemCount = Array.isArray(list) ? list.length : 0;
        providers.push({ id: providerId, ok: true, count: itemCount });
        if (Array.isArray(list)) {
          lists.push(list);
          if (list.note) notes.push(String(list.note));
        }
        log(`image-search ${searchId} provider=${providerId} ok count=${itemCount} ${Math.max(0, now() - startedAt)}ms`);
      } catch (error) {
        const message = summarizeError(error);
        providers.push({ id: providerId, ok: false, count: 0, error: message });
        log(`image-search ${searchId} provider=${providerId} failed ${Math.max(0, now() - startedAt)}ms: ${message}`);
      }
    }

    const merged = mergeCandidates(lists, { limit: config.maxCandidates }).slice(0, targetCount);
    const previewResults = await loadPreviews(merged, config, searchId);
    const candidates = merged.map((candidate, index) => {
      const previewResult = previewResults[index] ?? { preview: 'failed', bytes: 0, entry: null };
      return {
        candidateId: candidate.candidateId,
        title: candidate.title,
        source: candidate.source,
        pageUrl: candidate.pageUrl,
        width: candidate.width,
        height: candidate.height,
        bytes: previewResult.bytes,
        preview: previewResult.preview
      };
    });
    const previews = previewResults
      .filter((result) => result && result.preview === 'ok' && result.entry)
      .map((result) => result.entry);

    const createdAt = now();
    cache.set(searchId, {
      searchId,
      createdAt,
      expiresAt: createdAt + config.cacheTtlMinutes * 60000,
      candidates: merged.map((candidate) => ({ ...candidate }))
    });

    const result = { searchId, candidates, previews, providers };
    if (candidates.length === 0) {
      // 0 条不是异常：把 provider 的可读原因（如 Baidu antiFlag）带进 note，方便模型/日志判断。
      const reasons = [...new Set(notes.map((item) => String(item ?? '').trim()).filter(Boolean))];
      result.note = reasons.length > 0 ? `没有搜到可用的图片：${reasons.join('；')}` : '没有搜到可用的图片';
    } else if (notes.length > 0) result.note = [...new Set(notes)].join('；');
    log(`image-search ${searchId} done candidates=${candidates.length} previews=${previews.length} providers=${providers.filter((item) => item.ok).length}/${providers.length}`);
    return result;
  }

  /** 读取缓存里的搜索结果。不存在/过期分别 throw SEARCH_NOT_FOUND / SEARCH_EXPIRED。 */
  async function getSearch(searchId) {
    const entry = getCachedSearch(searchId);
    return {
      searchId: entry.searchId,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      candidates: entry.candidates.map((candidate) => ({ ...candidate }))
    };
  }

  /**
   * 发送前准备：按 candidateIds 下载原图，做 Content-Type/magic bytes/尺寸/像素/字节/
   * 总大小/去重校验。部分失败不抛错，全部失败返回 selected: []。
   *
   * asSticker=true 时改用「表情模式」：优先缩略图并强制 QQ 表情可保存规格（见 STICKER_*），
   * 不满足的候选记 failed，由调用方决定是否回退成普通图片发送。
   */
  async function prepareSend({ searchId, candidateIds, asSticker = false } = {}) {
    const entry = getCachedSearch(searchId);
    const config = await readConfig();
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      throw codedError('INVALID_ARGUMENT', 'candidateIds 必须是非空数组');
    }
    const uniqueIds = [];
    for (const value of candidateIds) {
      if (!Number.isInteger(value)) throw codedError('INVALID_ARGUMENT', 'candidateIds 只能包含整数');
      if (!uniqueIds.includes(value)) uniqueIds.push(value);
    }
    let selectedIds = uniqueIds;
    let truncated = false;
    if (selectedIds.length > config.maxPerMessage) {
      selectedIds = selectedIds.slice(0, config.maxPerMessage);
      truncated = true;
    }
    const byId = new Map(entry.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const selected = [];
    const failed = [];
    const duplicates = [];
    const seenHashes = new Set();

    for (const candidateId of selectedIds) {
      const candidate = byId.get(candidateId);
      if (!candidate) {
        failed.push({ candidateId, reason: '候选不存在' });
        continue;
      }
      try {
        const item = asSticker === true
          ? await downloadStickerSource(candidate, config)
          : await downloadOriginal(candidate, config);
        if (seenHashes.has(item.sha256)) {
          duplicates.push(candidateId);
          continue;
        }
        seenHashes.add(item.sha256);
        selected.push(item);
      } catch (error) {
        failed.push({ candidateId, reason: summarizeError(error) });
      }
    }

    // 总字节上限：从末尾移除直到总量不超限（与「只发一部分」的语义一致）。
    let totalBytes = selected.reduce((sum, item) => sum + item.bytes, 0);
    let removed = 0;
    while (selected.length > 0 && totalBytes > config.maxTotalBytesPerMessage) {
      const dropped = selected.pop();
      totalBytes -= dropped.bytes;
      removed += 1;
    }
    let note;
    if (removed > 0) {
      truncated = true;
      note = `图片总大小超过上限（${config.maxTotalBytesPerMessage} 字节），已省略末尾 ${removed} 张`;
    }
    return { selected, failed, duplicates, truncated, ...(note ? { note } : {}) };
  }

  /**
   * 列出近期仍有效的搜图候选（供 QQ 空间主动配图等内部功能复用）。
   * 只返回 searchId + candidateId 与少量展示元数据；真正的下载/校验仍走 prepareSend。
   */
  function listRecentCandidates({ limit = 20 } = {}) {
    const current = now();
    const max = Math.max(1, Math.min(100, Number(limit) || 20));
    const entries = [...cache.values()]
      .filter((entry) => entry && Array.isArray(entry.candidates) && current < entry.expiresAt)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    const out = [];
    for (const entry of entries) {
      for (const candidate of entry.candidates) {
        out.push({
          searchId: entry.searchId,
          candidateId: candidate.candidateId,
          title: candidate.title,
          source: candidate.source,
          pageUrl: candidate.pageUrl,
          provider: candidate.provider,
          width: candidate.width,
          height: candidate.height,
        });
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  return {
    search,
    getSearch,
    prepareSend,
    listRecentCandidates,
    size: () => cache.size,
    clearExpired: () => {
      let removed = 0;
      for (const [key, entry] of cache) {
        if (now() >= entry.expiresAt) {
          cache.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    reset: () => {
      cache.clear();
    }
  };
}
