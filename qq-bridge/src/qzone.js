// QQ 空间/说说核心模块。
//
// 设计边界（与 RULES.md 一致）：
// - 所有 Qzone 写操作只允许在桥接进程内发生；MCP 只能调桥接 HTTP。
// - 所有图片在桥接内解析成字节并校验，再以 base64:// 交给 SnowLuma；
//   **绝不**把模型给的任意 URL / 本地路径直接转给 SnowLuma 读取。
// - 发布/删除失败不自动重试（SnowLuma 没有幂等键，超时后可能已经提交）。
// - 主动发布必须经过 enabled / 静默时段 / 每日上限 / 最小间隔 / 审计 / 去重。
//
// 本模块不 import bridge.js，时钟/定时器/随机数/图片检索/DSH 起草都由桥接注入，
// 因此可以在 scripts/test-qzone.mjs 里用假时钟与 mock OneBot 离线测试。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SENSITIVE_RE } from './sensitive.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';

export const QZONE_UGC_RIGHTS = Object.freeze([1, 4, 16, 64, 128]);

export const VISIBILITY_LABELS = Object.freeze({
  1: '所有人可见（公开）',
  4: '好友可见',
  16: '部分好友可见',
  64: '仅自己可见',
  128: '部分好友不可见',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_MS = 7 * DAY_MS;
const MAX_DRAFTS = 20;
const MAX_POSTS = 200;
const MAX_FAILURES = 50;
const MAX_TIMEOUT_MS = 2_147_000_000; // Node setTimeout 上限内留余量

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const QZONE_BLOCKED_PATTERNS = [
  [/(?<!\d)1[3-9]\d{9}(?!\d)/, '正文包含手机号'],
  [/(?<!\d)\d{17}[\dXx](?!\d)/, '正文包含身份证号'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '正文包含邮箱地址'],
  [/\b(?:10\.\d{1,3}|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)\d{1,3}\.\d{1,3}\b/, '正文包含内网地址'],
  [/\b(?:file|base64):\/\//i, '正文包含本机/内联文件标记'],
  [/\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i, '正文包含 base64 数据'],
  [/https?:\/\/(?:localhost|127\.|\[::1\])/i, '正文包含本机地址'],
];

export const DEFAULT_QZONE_CONFIG = Object.freeze({
  enabled: false,
  ownerOnly: true,
  defaultUgcRight: 1,
  allowedUgcRights: [...QZONE_UGC_RIGHTS],
  maxContentChars: 1000,
  maxImages: 9,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalImageBytes: 16 * 1024 * 1024,
  localImageDirs: [],
  draftTtlMinutes: 30,
  minIntervalMs: 60_000,
  maxPostsPerDay: 6,
  publishTimeoutMs: 180_000,
  draftPreset: 'qzone-writer',
  workspaceTitle: 'QQ 空间写作',
  draftTimeoutMs: 120_000,
  proactive: {
    enabled: true,
    minIntervalMinutes: 240,
    maxIntervalMinutes: 480,
    maxPerDay: 3,
    // v1.4 主人已定：每天随机 1~3 条「想发就发」。minPerDay>0 时启用每日随机目标
    // （每天首次 tick 抽一次 min~max，发够目标当天即停）；minPerDay=0 保持旧「最多 maxPerDay」行为。
    minPerDay: 0,
    maxChars: 300,
    quietHours: [],
    imageProbability: 0.3,
    maxImages: 3,
    useRecentSearchCache: true,
    searchImagesFromWeb: true,
    notifyOwner: true,
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function qzoneError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, fallback, min, max, label, warnings) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    if (value !== undefined) warnings.push(`${label} 不是数字，已使用默认值 ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, Math.round(n)));
  if (clamped !== Math.round(n)) warnings.push(`${label} 越界，已收敛为 ${clamped}`);
  return clamped;
}

function clampFloat(value, fallback, min, max, label, warnings) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    if (value !== undefined) warnings.push(`${label} 不是数字，已使用默认值 ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, n));
  if (clamped !== n) warnings.push(`${label} 越界，已收敛为 ${clamped}`);
  return clamped;
}

function normalizeQuietHours(raw, warnings) {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('proactive.quietHours 不是数组，已忽略');
    return [...DEFAULT_QZONE_CONFIG.proactive.quietHours];
  }
  const out = [];
  for (const entry of raw) {
    const value = String(entry ?? '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      warnings.push(`proactive.quietHours 条目「${value}」格式无效（应为 HH:MM-HH:MM），已忽略`);
      continue;
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * 启动时收敛 qzone 配置。越界值一律收敛并逐条打 warning，不静默忽略。
 * @param {unknown} raw config.json 的 qzone 段
 * @param {{root?: string, log?: Function}} [options]
 */
export function normalizeQzoneConfig(raw, { root = process.cwd(), log = () => {} } = {}) {
  const warnings = [];
  const file = isPlainObject(raw) ? raw : {};
  const p = isPlainObject(file.proactive) ? file.proactive : {};
  const defaults = DEFAULT_QZONE_CONFIG;
  const config = clone(defaults);

  config.enabled = file.enabled === true;
  config.ownerOnly = file.ownerOnly !== false;
  if (file.ownerOnly === false) {
    // 写操作（发布/删除）仍然只允许 owner；这个字段保留是为了将来读路径的灰度。
    warnings.push('ownerOnly=false 当前不会放宽发布/删除权限：写操作仍仅限 ownerQQ');
  }

  config.defaultUgcRight = clampInt(file.defaultUgcRight, defaults.defaultUgcRight, 1, 128, 'defaultUgcRight', warnings);
  if (!QZONE_UGC_RIGHTS.includes(config.defaultUgcRight)) {
    warnings.push(`defaultUgcRight=${config.defaultUgcRight} 不在允许集合内，已回退为 1`);
    config.defaultUgcRight = 1;
  }
  if (Array.isArray(file.allowedUgcRights)) {
    const allowed = [...new Set(file.allowedUgcRights.map(Number).filter((n) => QZONE_UGC_RIGHTS.includes(n)))];
    if (allowed.length === 0) {
      warnings.push('allowedUgcRights 没有有效值，已回退为全部合法范围');
      config.allowedUgcRights = [...QZONE_UGC_RIGHTS];
    } else {
      config.allowedUgcRights = allowed;
      if (!allowed.includes(config.defaultUgcRight)) {
        warnings.push(`allowedUgcRights 不包含 defaultUgcRight=${config.defaultUgcRight}，已把默认值加入允许集合`);
        config.allowedUgcRights = [...new Set([...allowed, config.defaultUgcRight])].sort((a, b) => a - b);
      }
    }
  } else if (file.allowedUgcRights !== undefined) {
    warnings.push('allowedUgcRights 不是数组，已使用全部合法范围');
    config.allowedUgcRights = [...QZONE_UGC_RIGHTS];
  }

  config.maxContentChars = clampInt(file.maxContentChars, defaults.maxContentChars, 1, 5000, 'maxContentChars', warnings);
  config.maxImages = clampInt(file.maxImages, defaults.maxImages, 0, 9, 'maxImages', warnings);
  config.maxImageBytes = clampInt(file.maxImageBytes, defaults.maxImageBytes, 64 * 1024, 64 * 1024 * 1024, 'maxImageBytes', warnings);
  config.maxTotalImageBytes = clampInt(file.maxTotalImageBytes, defaults.maxTotalImageBytes, config.maxImageBytes, 64 * 1024 * 1024, 'maxTotalImageBytes', warnings);
  config.draftTtlMinutes = clampInt(file.draftTtlMinutes, defaults.draftTtlMinutes, 1, 24 * 60, 'draftTtlMinutes', warnings);
  config.minIntervalMs = clampInt(file.minIntervalMs, defaults.minIntervalMs, 60_000, 7 * DAY_MS, 'minIntervalMs', warnings);
  config.maxPostsPerDay = clampInt(file.maxPostsPerDay, defaults.maxPostsPerDay, 1, 100, 'maxPostsPerDay', warnings);
  config.publishTimeoutMs = clampInt(file.publishTimeoutMs, defaults.publishTimeoutMs, 30_000, 300_000, 'publishTimeoutMs', warnings);
  config.draftTimeoutMs = clampInt(file.draftTimeoutMs, defaults.draftTimeoutMs, 30_000, 300_000, 'draftTimeoutMs', warnings);
  config.draftPreset = typeof file.draftPreset === 'string' && file.draftPreset.trim()
    ? file.draftPreset.trim()
    : defaults.draftPreset;
  config.workspaceTitle = typeof file.workspaceTitle === 'string' && file.workspaceTitle.trim()
    ? file.workspaceTitle.trim()
    : defaults.workspaceTitle;

  config.localImageDirs = [];
  if (Array.isArray(file.localImageDirs)) {
    for (const entry of file.localImageDirs) {
      const value = String(entry ?? '').trim();
      if (!value) continue;
      if (!path.isAbsolute(value)) {
        warnings.push(`localImageDirs 条目「${value}」不是绝对路径，已忽略（白名单只接受绝对路径）`);
        continue;
      }
      const resolved = path.resolve(value);
      if (!config.localImageDirs.some((x) => x.toLowerCase() === resolved.toLowerCase())) {
        config.localImageDirs.push(resolved);
      }
    }
  } else if (file.localImageDirs !== undefined) {
    warnings.push('localImageDirs 不是数组，已忽略');
  }

  config.proactive.enabled = p.enabled !== false;
  config.proactive.minIntervalMinutes = clampInt(p.minIntervalMinutes, defaults.proactive.minIntervalMinutes, 60, 24 * 60, 'proactive.minIntervalMinutes', warnings);
  config.proactive.maxIntervalMinutes = clampInt(p.maxIntervalMinutes, defaults.proactive.maxIntervalMinutes, 60, 24 * 60, 'proactive.maxIntervalMinutes', warnings);
  if (config.proactive.minIntervalMinutes > config.proactive.maxIntervalMinutes) {
    warnings.push('proactive.minIntervalMinutes > maxIntervalMinutes，已交换两者');
    [config.proactive.minIntervalMinutes, config.proactive.maxIntervalMinutes] = [config.proactive.maxIntervalMinutes, config.proactive.minIntervalMinutes];
  }
  config.proactive.maxPerDay = clampInt(p.maxPerDay, defaults.proactive.maxPerDay, 1, config.maxPostsPerDay, 'proactive.maxPerDay', warnings);
  config.proactive.minPerDay = clampInt(p.minPerDay, defaults.proactive.minPerDay, 0, config.proactive.maxPerDay, 'proactive.minPerDay', warnings);
  config.proactive.maxChars = clampInt(p.maxChars, defaults.proactive.maxChars, 20, config.maxContentChars, 'proactive.maxChars', warnings);
  config.proactive.quietHours = normalizeQuietHours(p.quietHours, warnings);
  config.proactive.imageProbability = clampFloat(p.imageProbability, defaults.proactive.imageProbability, 0, 1, 'proactive.imageProbability', warnings);
  config.proactive.maxImages = clampInt(p.maxImages, defaults.proactive.maxImages, 0, config.maxImages, 'proactive.maxImages', warnings);
  config.proactive.useRecentSearchCache = p.useRecentSearchCache !== false;
  config.proactive.searchImagesFromWeb = p.searchImagesFromWeb !== false;
  config.proactive.notifyOwner = p.notifyOwner !== false;

  // root 目前只用于未来把相对路径/工作区路径写进提示，保留参数以免调用方漂移。
  void root;
  for (const warning of warnings) log(`⚠️ qzone 配置已收敛：${warning}`);
  return { config, warnings };
}

export function visibilityLabel(ugcRight) {
  return VISIBILITY_LABELS[Number(ugcRight)] ?? '未知可见范围';
}

/** 正文规范化：去首尾空白、统一换行、压缩行内空白。 */
export function normalizeContent(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去重专用：去掉空白/标点，保留字母、数字与中文，降低“近似内容”误判。 */
export function normalizeForDedupe(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function contentHash(text) {
  return crypto.createHash('sha256').update(normalizeForDedupe(text), 'utf8').digest('hex');
}

function bigramSet(text) {
  const chars = Array.from(text);
  if (chars.length < 2) return new Set(chars);
  const set = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) set.add(`${chars[i]}${chars[i + 1]}`);
  return set;
}

/** 字符 bigram Jaccard 相似度，0~1。 */
export function textSimilarity(a, b) {
  const left = bigramSet(normalizeForDedupe(a));
  const right = bigramSet(normalizeForDedupe(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 归一化后的公共前缀占比；对“只改结尾几个字”的近似说说很有效。 */
export function commonPrefixRatio(a, b) {
  const left = normalizeForDedupe(a);
  const right = normalizeForDedupe(b);
  const min = Math.min(left.length, right.length);
  if (min === 0) return 0;
  let i = 0;
  while (i < min && left[i] === right[i]) i += 1;
  return i / min;
}

/**
 * qzone 专用正文审计：在 SENSITIVE_RE 之外补手机号/邮箱/身份证/内网地址/内联文件。
 * @returns {{ok: boolean, code?: string, reason?: string}}
 */
export function auditQzoneText(text, { knownTokens = [] } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) return { ok: false, code: 'EMPTY', reason: '正文为空' };
  if (SENSITIVE_RE.test(value)) return { ok: false, code: 'SENSITIVE', reason: '正文含敏感信息（路径/凭据等），已拒绝' };
  for (const token of Array.isArray(knownTokens) ? knownTokens : []) {
    if (token && value.includes(String(token))) {
      return { ok: false, code: 'SENSITIVE_TOKEN', reason: '正文包含已知会话令牌，已拒绝' };
    }
  }
  for (const [re, reason] of QZONE_BLOCKED_PATTERNS) {
    if (re.test(value)) return { ok: false, code: 'SENSITIVE', reason };
  }
  return { ok: true };
}

/** 图片 URL 预审计：仅 https、无凭据、无敏感 token、非本机/内网字面量。 */
export function auditQzoneImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, code: 'BAD_URL', reason: '图片 URL 无效' };
  }
  if (url.protocol !== 'https:') return { ok: false, code: 'BAD_URL', reason: '图片 URL 只允许 https' };
  if (url.username || url.password) return { ok: false, code: 'BAD_URL', reason: '图片 URL 不能包含凭据' };
  if (url.port && url.port !== '443') return { ok: false, code: 'BAD_URL', reason: '图片 URL 只允许 443 端口' };
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)) return { ok: false, code: 'BAD_URL', reason: '图片 URL 指向本机地址' };
  if (SENSITIVE_RE.test(url.toString())) return { ok: false, code: 'SENSITIVE_URL', reason: '图片 URL 含敏感信息' };
  if (/[?&](?:token|access_token|api[_-]?key|secret|password|authorization)=/i.test(url.search)) {
    return { ok: false, code: 'SENSITIVE_URL', reason: '图片 URL 查询参数含凭据' };
  }
  return { ok: true, url: url.toString() };
}

export function isQuietHours(now, quietHours) {
  const date = new Date(Number(now) || Date.now());
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const entry of Array.isArray(quietHours) ? quietHours : []) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(entry));
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (start === end) continue;
    if (start < end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end)) return true;
  }
  return false;
}

function msUntilQuietEnd(now, quietHours) {
  const date = new Date(Number(now) || Date.now());
  const minutes = date.getHours() * 60 + date.getMinutes();
  let best = 0;
  for (const entry of Array.isArray(quietHours) ? quietHours : []) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(entry));
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    const inRange = start < end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
    if (!inRange) continue;
    const deltaMinutes = end > minutes ? end - minutes : 24 * 60 - minutes + end;
    const wait = deltaMinutes * 60_000 + 60_000;
    if (best === 0 || wait < best) best = wait;
  }
  return best;
}

function imageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function assertImageBuffer(buf, maxBytes, label = '图片') {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw qzoneError('BAD_IMAGE', `${label}为空`, 400);
  if (buf.length > maxBytes) throw qzoneError('BAD_IMAGE', `${label}超过单张大小上限（${buf.length} > ${maxBytes} 字节）`, 400);
  if (!looksLikeImageBuffer(buf)) throw qzoneError('BAD_IMAGE', `${label}不是有效图片（PNG/JPEG/GIF/WebP）`, 400);
  const info = imageMime(buf);
  if (!info) throw qzoneError('BAD_IMAGE', `${label}无法识别图片格式`, 400);
  return info;
}

function isInsideDir(rootDir, target) {
  const rel = path.relative(rootDir, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertNoSymlinkComponents(rootReal, originalPath) {
  const rel = path.relative(rootReal, path.resolve(originalPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw qzoneError('IMAGE_PATH_ESCAPE', '图片路径不在白名单目录内', 403);
  }
  let current = rootReal;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw qzoneError('IMAGE_PATH_MISSING', '图片路径不存在或不可读', 400);
    }
    if (stat.isSymbolicLink()) throw qzoneError('IMAGE_SYMLINK', '图片路径包含符号链接，已拒绝', 403);
  }
}

/**
 * 读取并校验白名单目录里的本机图片。
 * @returns {{buffer: Buffer, mime: string, ext: string, bytes: number, sha256: string, label: string}}
 */
export function readLocalImage({ file, dirs, maxBytes }) {
  const raw = String(file ?? '').trim();
  if (!raw) throw qzoneError('BAD_IMAGE', '本机图片路径为空', 400);
  if (!path.isAbsolute(raw)) throw qzoneError('IMAGE_PATH_ESCAPE', '本机图片只接受绝对路径，且必须位于白名单目录内', 403);
  const ext = path.extname(raw).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw qzoneError('BAD_IMAGE', `不支持的图片扩展名：${ext || '(无)'}`, 400);
  let targetReal;
  try {
    targetReal = fs.realpathSync(raw);
  } catch {
    throw qzoneError('IMAGE_PATH_MISSING', '图片路径不存在或不可读', 400);
  }
  const candidates = Array.isArray(dirs) ? dirs : [];
  if (candidates.length === 0) throw qzoneError('IMAGE_DIR_EMPTY', '未配置 qzone.localImageDirs，已拒绝本机图片', 403);
  let matchedRoot = '';
  for (const dir of candidates) {
    let rootReal;
    try {
      rootReal = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (isInsideDir(rootReal, targetReal)) {
      matchedRoot = rootReal;
      break;
    }
  }
  if (!matchedRoot) throw qzoneError('IMAGE_PATH_ESCAPE', '图片不在 qzone.localImageDirs 白名单目录内', 403);
  assertNoSymlinkComponents(matchedRoot, raw);
  let stat;
  try {
    stat = fs.statSync(targetReal);
  } catch {
    throw qzoneError('IMAGE_PATH_MISSING', '图片路径不存在或不可读', 400);
  }
  if (!stat.isFile()) throw qzoneError('BAD_IMAGE', '本机图片路径不是文件', 400);
  if (stat.size <= 0 || stat.size > maxBytes) throw qzoneError('BAD_IMAGE', `图片大小超限（${stat.size} 字节）`, 400);
  const buffer = fs.readFileSync(targetReal);
  assertImageBuffer(buffer, maxBytes, '本机图片');
  const info = imageMime(buffer);
  return {
    buffer,
    mime: info.mime,
    ext: info.ext,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    label: `本机:${path.basename(raw)}`,
  };
}

function normalizeImageInputs(images, maxImages) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw qzoneError('BAD_IMAGE', 'images 必须是数组', 400);
  if (images.length > maxImages) throw qzoneError('BAD_IMAGE', `最多 ${maxImages} 张图片`, 400);
  const out = [];
  for (const item of images) {
    if (typeof item === 'string') {
      const value = item.trim();
      if (!value) throw qzoneError('BAD_IMAGE', '图片项不能为空', 400);
      if (/^https?:\/\//i.test(value)) out.push({ type: 'url', url: value });
      else out.push({ type: 'local', file: value });
      continue;
    }
    if (isPlainObject(item)) {
      if (item.searchId) {
        const candidateIds = item.candidateIds ?? (item.candidateId !== undefined ? [item.candidateId] : []);
        if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
          throw qzoneError('BAD_IMAGE', '搜图候选必须提供 candidateIds', 400);
        }
        out.push({ type: 'search', searchId: String(item.searchId), candidateIds: candidateIds.map(Number) });
        continue;
      }
      if (item.url) {
        out.push({ type: 'url', url: String(item.url) });
        continue;
      }
      if (item.path || item.file) {
        out.push({ type: 'local', file: String(item.path ?? item.file) });
        continue;
      }
    }
    throw qzoneError('BAD_IMAGE', '无法识别的图片项：需要 URL、本机绝对路径或 {searchId,candidateIds}', 400);
  }
  return out;
}

function bufferToImageEntry(buffer, maxBytes, label, sourceType) {
  assertImageBuffer(buffer, maxBytes, label);
  const info = imageMime(buffer);
  return {
    buffer,
    mime: info.mime,
    ext: info.ext,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sourceType,
    label,
  };
}

/**
 * 把 URL / 白名单本机路径 / 搜图候选解析为图片字节。
 * 只返回已校验的 buffer；调用方决定写临时文件还是直接 base64。
 */
export async function resolveImageInputs(images, {
  config,
  imageSearch = null,
  maxImages = config?.maxImages ?? 9,
  maxBytes = config?.maxImageBytes ?? 8 * 1024 * 1024,
  maxTotalBytes = config?.maxTotalImageBytes ?? 16 * 1024 * 1024,
  fetchBuffer = safeFetchBuffer,
} = {}) {
  const descriptors = normalizeImageInputs(images, maxImages);
  const out = [];
  let total = 0;
  for (const desc of descriptors) {
    let items = [];
    if (desc.type === 'url') {
      const audit = auditQzoneImageUrl(desc.url);
      if (!audit.ok) throw qzoneError(audit.code, audit.reason, 403);
      const result = await fetchBuffer(audit.url, maxBytes, {
        requireHttps: true,
        allowedPorts: ['443'],
        timeoutMs: 20_000,
      });
      items.push(bufferToImageEntry(result.buffer, maxBytes, '网络图片', 'url'));
    } else if (desc.type === 'local') {
      items.push(readLocalImage({ file: desc.file, dirs: config.localImageDirs, maxBytes }));
    } else if (desc.type === 'search') {
      if (!imageSearch || typeof imageSearch.prepareSend !== 'function') {
        throw qzoneError('IMAGE_SEARCH_UNAVAILABLE', '近期搜图缓存不可用', 503);
      }
      const selected = await imageSearch.prepareSend({ searchId: desc.searchId, candidateIds: desc.candidateIds });
      for (const item of selected.selected ?? []) {
        items.push(bufferToImageEntry(item.buffer, maxBytes, `搜图候选#${item.candidateId}`, 'search'));
      }
      if (items.length === 0) {
        const reasons = (selected.failed ?? []).map((x) => x.reason).filter(Boolean).slice(0, 3).join('；');
        throw qzoneError('IMAGE_SEARCH_EMPTY', `搜图候选不可用${reasons ? `：${reasons}` : ''}`, 400);
      }
      if (selected.truncated) {
        const remaining = Math.max(0, maxImages - out.length);
        if (items.length > remaining) items = items.slice(0, remaining);
      }
    }
    for (const item of items) {
      if (out.length >= maxImages) {
        throw qzoneError('BAD_IMAGE', `最多 ${maxImages} 张图片`, 400);
      }
      total += item.bytes;
      if (total > maxTotalBytes) {
        throw qzoneError('BAD_IMAGE', `图片总大小超过上限（${total} > ${maxTotalBytes} 字节）`, 400);
      }
      out.push(item);
    }
  }
  return out;
}

function defaultState() {
  return {
    version: 1,
    proactiveEnabled: null,
    lastPostAt: 0,
    lastAttemptAt: 0,
    inFlight: false,
    posts: [],
    drafts: [],
    failures: [],
    // 发布状态机（H4，§17.1）：{state:'sending'|'published'|'unknown'|'failed', tidHash, contentHash, startedAt, verifiedAt}
    lastPublish: null,
    // v1.4 每日随机发布目标：{day:'YYYY-MM-DD', value:min~max}
    proactiveTarget: null,
  };
}

function normalizeLoadedState(raw) {
  const state = defaultState();
  if (!isPlainObject(raw)) return state;
  state.proactiveEnabled = typeof raw.proactiveEnabled === 'boolean' ? raw.proactiveEnabled : null;
  state.lastPostAt = Number(raw.lastPostAt) || 0;
  state.lastAttemptAt = Number(raw.lastAttemptAt) || 0;
  state.inFlight = raw.inFlight === true;
  if (Array.isArray(raw.posts)) {
    state.posts = raw.posts
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        tid: String(p.tid ?? ''),
        at: Number(p.at) || 0,
        contentHash: String(p.contentHash ?? ''),
        contentLen: Number(p.contentLen) || 0,
        normalized: String(p.normalized ?? ''),
        ugcRight: Number(p.ugcRight) || 1,
        source: p.source === 'proactive' ? 'proactive' : 'manual',
        images: Math.max(0, Number(p.images) || 0),
        deletedAt: Number(p.deletedAt) || 0,
      }))
      .filter((p) => p.tid)
      .slice(-MAX_POSTS);
  }
  if (Array.isArray(raw.drafts)) {
    state.drafts = raw.drafts
      .filter((d) => d && typeof d === 'object' && d.draftId)
      .map((d) => ({
        draftId: String(d.draftId),
        content: String(d.content ?? ''),
        images: Array.isArray(d.images) ? d.images.filter((img) => img && img.file).map((img) => ({
          file: String(img.file),
          bytes: Number(img.bytes) || 0,
          mime: String(img.mime ?? ''),
          sha256: String(img.sha256 ?? ''),
          sourceType: ['url', 'local', 'search'].includes(img.sourceType) ? img.sourceType : 'local',
          label: String(img.label ?? '图片'),
        })) : [],
        ugcRight: Number(d.ugcRight) || 1,
        targetUins: Array.isArray(d.targetUins) ? d.targetUins.map(Number).filter((n) => n > 0) : [],
        createdAt: Number(d.createdAt) || 0,
        expiresAt: Number(d.expiresAt) || 0,
        used: d.used === true,
        attemptedAt: Number(d.attemptedAt) || 0,
        source: d.source === 'proactive' ? 'proactive' : 'manual',
        // H4 草稿状态机：draft → sending → published | unknown | failed
        state: ['draft', 'sending', 'published', 'unknown', 'failed'].includes(d.state) ? d.state : (d.used ? 'published' : 'draft'),
        // unknown 时保留媒体 24h（§17.1 H4）：别在"其实已发出"的场景把图片丢了
        mediaKeepUntil: Number(d.mediaKeepUntil) || 0,
      }))
      .slice(-MAX_DRAFTS);
  }
  if (raw.lastPublish && typeof raw.lastPublish === 'object') {
    const lp = raw.lastPublish;
    state.lastPublish = {
      state: ['sending', 'published', 'unknown', 'failed'].includes(lp.state) ? lp.state : 'failed',
      tidHash: String(lp.tidHash ?? ''),
      contentHash: String(lp.contentHash ?? ''),
      startedAt: Number(lp.startedAt) || 0,
      verifiedAt: Number(lp.verifiedAt) || 0,
    };
  }
  if (raw.proactiveTarget && typeof raw.proactiveTarget === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.proactiveTarget.day ?? ''))) {
    state.proactiveTarget = {
      day: String(raw.proactiveTarget.day),
      value: Math.max(1, Number(raw.proactiveTarget.value) || 1),
    };
  }
  if (Array.isArray(raw.failures)) {
    state.failures = raw.failures
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({
        at: Number(f.at) || 0,
        source: f.source === 'proactive' ? 'proactive' : (f.source === 'delete' ? 'delete' : 'manual'),
        reason: String(f.reason ?? '').slice(0, 300),
      }))
      .slice(-MAX_FAILURES);
  }
  return state;
}

function todayStart(now) {
  const d = new Date(Number(now) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 创建 Qzone 服务（含主动调度器）。
 *
 * 所有外部副作用都通过参数注入：
 * - requestQzone(action, params, {timeoutMs})：桥接调用 SnowLuma OneBot action
 * - draftWithAgent({source,maxChars,context})：桥接 DSH 写作会话
 * - contextProvider({source})：桥接最近聊天/记忆/角色
 * - imageSearch：qq-image 的 createImageSearchService 实例
 * - notifyOwner(text, meta)：桥接私聊通知
 * - isQqOnline()：桥接 QQ 在线检查
 */
export function createQzoneService({
  root = process.cwd(),
  stateDir,
  config: rawConfig = {},
  configAlreadyNormalized = false,
  log = () => {},
  activity = () => {},
  now = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  requestQzone,
  imageSearch = null,
  contextProvider = async () => ({}),
  draftWithAgent = async () => { throw qzoneError('DRAFT_UNAVAILABLE', '未配置 AI 起草器', 503); },
  notifyOwner = async () => {},
  isQqOnline = async () => true,
  knownTokens = [],
  redact = (value) => String(value ?? ''),
  fetchBuffer = safeFetchBuffer,
  // ── 表现面 S2 钩子（GEN3_SURFACE_INTEGRATION_PLAN）：全部可选，缺省零行为变化 ──
  // onPublished({tid, content, source, ugcRight, verification})：发布后记忆回写（§7.7）
  onPublished = null,
  // onSurfaceEvent(event)：观测事件（§5.2），失败自兜底
  onSurfaceEvent = null,
  // softDedupeSources()：去重扩展（§7.6）——最近主人私聊话题/日记摘要，软对比降权用
  softDedupeSources = null,
  // stylePass：风格复核（§7.4），命中硬信号最多重写 1 次
  stylePass = false,
  // notifyPreview：通知带正文前 60 字（§17.4 第 7 条），默认只发 tid/可见性
  notifyPreview = false,
  // proactiveApproval（§7.8）：true 时主动发布只出草稿+通知主人带 draftId，不自动发（仅 canary 观察期用）
  proactiveApproval = false,
  // webImages（§17.4 第 5 条）：false（V3 默认）只用本机目录/主人给的图，禁止网络搜图；true 时图片记 imageSource
  webImages = true,
  // skipIfTopicRecentHours（§17.4 第 6 条）：最近 N 小时聊天出现过的 topic 不重复发（0=关）
  skipIfTopicRecentHours = 0,
  // minGapAfterManualPostMs（§17.4 第 6 条）：主人手动发过说说后，机器人至少等这么久再发（0=关）
  minGapAfterManualPostMs = 0,
  // ── S4（§8.7 日记→空间）：source='diary' 的草稿需要显式开关 + 他人名字检查 ──
  // diaryShareEnabled：socialV3.surface.diary.shareToQzone（默认关，关掉后日记摘录不能起草）
  diaryShareEnabled = false,
  // knownMemberNames：「他人」显示名列表（数组或函数，同 knownTokens 口径）
  knownMemberNames = [],
} = {}) {
  if (!stateDir) throw new Error('createQzoneService 需要 stateDir');
  if (typeof requestQzone !== 'function') throw new Error('createQzoneService 需要 requestQzone');

  const stateFile = path.join(stateDir, 'qzone.json');
  const mediaDir = path.join(stateDir, 'qzone-media');
  const normalized = configAlreadyNormalized
    ? { config: rawConfig, warnings: [] }
    : normalizeQzoneConfig(rawConfig, { root, log });
  let config = normalized.config;
  const currentKnownTokens = () => (typeof knownTokens === 'function' ? (knownTokens() ?? []) : knownTokens);
  const currentKnownMemberNames = () => (typeof knownMemberNames === 'function' ? (knownMemberNames() ?? []) : knownMemberNames);

  let state = defaultState();
  let writable = true;
  try {
    if (fs.existsSync(stateFile)) {
      const text = fs.readFileSync(stateFile, 'utf8');
      state = normalizeLoadedState(JSON.parse(text.replace(/^\uFEFF/, '')));
    }
  } catch (error) {
    writable = false;
    log(`⚠️ state/qzone.json 读取失败，已降级为只读（不会覆盖原文件）：${error?.message ?? error}`);
  }
  // 进程重启后，上一次进程留下的 in-flight 不可能还在跑（桥接有单实例锁）。
  // 不清掉会让主动发布永久被判 busy；保留 lastAttemptAt 供状态/去重观察。
  if (state.inFlight) {
    state.inFlight = false;
    log('qzone 清理上次进程遗留的 in-flight 标记');
  }
  // H4：启动时 lastPublish 还是 sending ＝ 上个进程死在发布途中，结果未知 → 转 unknown 并补一次回读核对。
  if (state.lastPublish && state.lastPublish.state === 'sending') {
    state.lastPublish.state = 'unknown';
    log('qzone 上次发布停在 sending：转 unknown（结果未知，启动后补一次 reconcile，不自动重发）');
  }

  let timer = null;
  let nextRunAt = 0;
  let ticking = false;
  let stopped = true;

  // H4 常量与工具：tid 只落哈希（§11 红线：trace/状态不记 tid 明文）；unknown 媒体保留 24h。
  const UNKNOWN_MEDIA_KEEP_MS = 24 * 3600 * 1000;
  const hashTid = (tid) => contentHash(String(tid ?? ''));
  /** 超时/断网/无响应＝结果未知（可能已发出）；4xx/审计/重复等明确失败照旧走 failed。 */
  function isUnknownPublishError(error) {
    if (!error) return false;
    if (error.code === 'QZONE_UNKNOWN_STATE') return true;
    const raw = String(error?.message ?? error);
    if (error.code === 'QZONE_NO_TID') return true; // 服务端可能已发出但没回 tid
    return /timeout|timed\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|socket hang up|network|abort/i.test(raw);
  }

  function saveState() {
    if (!writable) return false;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, stateFile);
      return true;
    } catch (error) {
      log(`保存 state/qzone.json 失败：${error?.message ?? error}`);
      return false;
    }
  }

  function assertWritable() {
    if (!writable) {
      throw qzoneError('QZONE_STATE_READONLY', 'state/qzone.json 处于只读降级状态，请修复后重启桥接', 503);
    }
  }

  function cleanupDraftMedia(draftId) {
    try {
      fs.rmSync(path.join(mediaDir, draftId), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      log(`清理草稿图片失败（${draftId}）：${error?.message ?? error}`);
    }
  }

  function cleanupExpiredDrafts() {
    const current = now();
    let changed = false;
    for (const draft of state.drafts) {
      if (draft.used && current - (draft.attemptedAt || draft.createdAt || 0) > config.draftTtlMinutes * 60_000) {
        cleanupDraftMedia(draft.draftId);
        draft.mediaCleaned = true;
        changed = true;
      } else if (!draft.used && draft.expiresAt > 0 && current >= draft.expiresAt) {
        cleanupDraftMedia(draft.draftId);
        draft.mediaCleaned = true;
        changed = true;
      }
    }
    const before = state.drafts.length;
    state.drafts = state.drafts.filter((d) => !d.mediaCleaned).slice(-MAX_DRAFTS);
    if (state.drafts.length !== before) changed = true;
    if (changed) saveState();
  }

  function countToday(predicate) {
    const start = todayStart(now());
    return state.posts.filter((p) => p.at >= start && predicate(p)).length;
  }

  function isDuplicate(text) {
    const normalized = normalizeForDedupe(text);
    const hash = contentHash(text);
    const current = now();
    for (const post of state.posts) {
      if (!post.at || current - post.at > DEDUPE_WINDOW_MS) continue;
      if (post.contentHash && post.contentHash === hash) return { duplicate: true, matched: 'hash' };
      if (post.normalized && normalized && post.normalized === normalized) return { duplicate: true, matched: 'text' };
      if (normalized.length >= 8 && post.normalized) {
        if (commonPrefixRatio(post.normalized, normalized) >= 0.7) return { duplicate: true, matched: 'prefix' };
        if (textSimilarity(post.normalized, normalized) >= 0.85) return { duplicate: true, matched: 'similar' };
      }
    }
    return { duplicate: false };
  }

  /**
   * 去重扩展（§7.6/§17.4 第 6 条）：与最近主人私聊话题/日记摘要高度重合 → **降权不硬拦**。
   * 手动发布只提示；主动发布降权到「跳过本轮」（不直接拒绝，下轮可能换话题）。
   * skipIfTopicRecentHours>0 时只比对该时间窗内的来源（{text,at} 项；纯字符串视为当前）。
   */
  async function softDuplicate(text) {
    if (typeof softDedupeSources !== 'function') return { overlap: false, matched: '' };
    let sources = [];
    try { sources = (await softDedupeSources()) ?? []; } catch { return { overlap: false, matched: '' }; }
    const normalized = normalizeForDedupe(text);
    const windowMs = skipIfTopicRecentHours > 0 ? skipIfTopicRecentHours * 3600_000 : 0;
    for (const raw of sources) {
      const src = raw && typeof raw === 'object' ? raw : { text: String(raw ?? ''), at: 0 };
      if (windowMs > 0 && src.at && now() - src.at > windowMs) continue; // 过了时间窗的话题不再回避
      const s = normalizeForDedupe(String(src.text ?? ''));
      if (s.length >= 4 && (normalized.includes(s) || s.includes(normalized) || textSimilarity(s, normalized) >= 0.6)) {
        return { overlap: true, matched: s.slice(0, 40) };
      }
    }
    return { overlap: false, matched: '' };
  }

  function assertCanPublish(source) {
    if (!config.enabled) throw qzoneError('QZONE_DISABLED', 'QQ 空间功能未开启（qzone.enabled=false）', 403);
    if (state.inFlight) throw qzoneError('QZONE_BUSY', '上一次说说发布仍在进行中，请稍后', 409);
    const current = now();
    if (state.lastPostAt > 0 && current - state.lastPostAt < config.minIntervalMs) {
      const wait = Math.max(1, Math.ceil((config.minIntervalMs - (current - state.lastPostAt)) / 1000));
      throw qzoneError('QZONE_RATE_LIMIT', `发布过于频繁：请约 ${wait} 秒后再试（qzone.minIntervalMs=${config.minIntervalMs}）`, 429);
    }
    if (countToday(() => true) >= config.maxPostsPerDay) {
      throw qzoneError('QZONE_DAILY_LIMIT', `今天已达到发布上限（${config.maxPostsPerDay} 条/天）`, 429);
    }
    if (source === 'proactive' && countToday((p) => p.source === 'proactive') >= proactiveDailyTarget()) {
      throw qzoneError('QZONE_PROACTIVE_DAILY_LIMIT', `主动发布今天已达到当日目标（${proactiveDailyTarget()} 条/天）`, 429);
    }
  }

  /**
   * v1.4 每日随机目标：minPerDay>0 时每天首次查询抽一次 [minPerDay, maxPerDay] 的目标并落 state，
   * 发够即停（"每天随机 1~3 条"）；minPerDay=0 保持旧「最多 maxPerDay」行为。
   */
  function proactiveDailyTarget() {
    if (!(config.proactive.minPerDay > 0)) return config.proactive.maxPerDay;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (state.proactiveTarget?.day !== day) {
      const min = config.proactive.minPerDay;
      const max = Math.max(min, config.proactive.maxPerDay);
      state.proactiveTarget = { day, value: min + Math.floor(random() * (max - min + 1)) };
      saveState();
    }
    return state.proactiveTarget.value;
  }

  function recordFailure(source, error) {
    const reason = redact(String(error?.message ?? error ?? '未知错误')).slice(0, 300);
    state.failures.push({ at: now(), source, reason });
    if (state.failures.length > MAX_FAILURES) state.failures = state.failures.slice(-MAX_FAILURES);
    state.inFlight = false;
    saveState();
  }

  function recordPost({ tid, time, content, ugcRight, source, images }) {
    const at = Number(time) > 0 ? Number(time) * 1000 : now();
    state.posts.push({
      tid: String(tid),
      at: at > 0 ? at : now(),
      contentHash: contentHash(content),
      contentLen: String(content).length,
      normalized: normalizeForDedupe(content),
      ugcRight: Number(ugcRight) || 1,
      source: source === 'proactive' ? 'proactive' : source === 'diary' ? 'diary' : 'manual',
      images: Number(images) || 0,
      deletedAt: 0,
    });
    if (state.posts.length > MAX_POSTS) state.posts = state.posts.slice(-MAX_POSTS);
    state.lastPostAt = now();
    state.lastAttemptAt = now();
    state.inFlight = false;
    saveState();
  }

  async function notify(text, meta = {}) {
    if (config.proactive.notifyOwner === false) return;
    try {
      await notifyOwner(String(text), meta);
    } catch (error) {
      log(`qzone 通知主人失败：${error?.message ?? error}`);
    }
  }

  /** 观测事件（§5.2）：失败自兜底，绝不影响发布链路。 */
  function emitSurfaceEvent(event) {
    if (typeof onSurfaceEvent !== 'function') return;
    try { onSurfaceEvent(event); } catch (error) { log(`qzone SurfaceEvent 发射失败：${error?.message ?? error}`); }
  }

  /** 记忆回写（§7.7）：失败只告警不影响发布结果；幂等由调用方 dedupeKey 保证。 */
  async function capturePublishedMemory({ tid, content, source, ugcRight, verification }) {
    if (typeof onPublished !== 'function') return;
    try {
      await onPublished({ tid, content, source, ugcRight, verification });
    } catch (error) {
      log(`qzone 记忆回写失败（不影响发布结果）：${error?.message ?? error}`);
    }
  }

  /**
   * 发布后回读核实（H4/§7.5）：listPosts 匹配 tid + contentHash。
   * 返回 'verified' | 'miss' | 'unknown'——**任何情况都不重试、不重复发布**。
   */
  async function verifyPublished({ tid, expectedHash, withinMs = 30_000 }) {
    try {
      const list = await Promise.race([
        listPosts({ count: 10 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('回读超时')), Math.max(1000, withinMs)).unref?.())
      ]);
      const rows = Array.isArray(list?.msglist) ? list.msglist : [];
      const hit = rows.find((item) => String(item?.tid ?? '') === String(tid));
      if (!hit) return 'miss';
      if (expectedHash && contentHash(String(hit.content ?? '')) !== expectedHash) return 'miss';
      return 'verified';
    } catch (error) {
      log(`qzone 发布后回读未完成（状态未知，不重试）：${error?.message ?? error}`);
      return 'unknown';
    }
  }

  /** 把 lastPublish 推进到某个状态（H4 状态机：单向，unknown → published 只能由回读证据触发）。 */
  function setLastPublish(stateName, patch = {}) {
    const prev = state.lastPublish;
    // 禁止 unknown → draft 回退；sending → 其他只允许前进
    state.lastPublish = {
      state: stateName,
      tidHash: String(patch.tidHash ?? prev?.tidHash ?? ''),
      contentHash: String(patch.contentHash ?? prev?.contentHash ?? ''),
      startedAt: Number(patch.startedAt ?? prev?.startedAt ?? now()),
      verifiedAt: Number(patch.verifiedAt ?? prev?.verifiedAt ?? 0),
    };
    saveState();
    return state.lastPublish;
  }

  /**
   * reconcile（H4）：只读核对「结果未知」的发布，绝不写发送、绝不自动重发。
   * 拿 listPosts 与 lastPublish 的 contentHash 比对：对上 → published+verified；对不上 → 保持 unknown（人工核对）。
   */
  async function reconcilePublish({ count = 10 } = {}) {
    const lp = state.lastPublish;
    if (!lp || (lp.state !== 'unknown' && lp.state !== 'sending')) {
      return { ok: true, state: lp?.state ?? 'none', changed: false, note: '没有待核对的未知发布' };
    }
    try {
      const list = await listPosts({ count });
      const rows = Array.isArray(list?.msglist) ? list.msglist : [];
      // 证据优先级（§H4）：contentHash（幂等键）> tidHash > 保持 unknown
      const hit = rows.find((item) => lp.contentHash && contentHash(String(item?.content ?? '')) === lp.contentHash)
        ?? (lp.tidHash ? rows.find((item) => contentHash(String(item?.tid ?? '')) === lp.tidHash) : null);
      if (hit) {
        setLastPublish('published', { tidHash: lp.tidHash || hashTid(hit.tid), verifiedAt: now() });
        log(`qzone reconcile：未知发布已核实为已发出（${new Date(lp.startedAt).toISOString()}）`);
        return { ok: true, state: 'published', changed: true, verified: true };
      }
      // 没对上：24h 内可以再试；超窗保持 unknown 交人工（不猜、不重发）
      return {
        ok: true, state: 'unknown', changed: false,
        note: '回读未找到对应说说；请手动打开空间核对（不会自动重发）'
      };
    } catch (error) {
      return { ok: true, state: 'unknown', changed: false, note: `回读失败：${redact(String(error?.message ?? error))}` };
    }
  }

  async function generateContent(source, maxChars) {
    let context = {};
    try {
      context = (await contextProvider({ source })) ?? {};
    } catch (error) {
      log(`qzone 上下文收集失败：${error?.message ?? error}`);
      context = {};
    }
    let text;
    try {
      text = await draftWithAgent({ source, maxChars, context });
    } catch (error) {
      throw qzoneError('QZONE_DRAFT_FAILED', `AI 起草失败：${error?.message ?? error}`, 502);
    }
    const cleaned = normalizeContent(text)
      .replace(/^```[\w-]*\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .trim();
    if (!cleaned) throw qzoneError('QZONE_DRAFT_EMPTY', 'AI 起草结果为空，已跳过', 502);
    if (cleaned.length > maxChars) {
      throw qzoneError('QZONE_DRAFT_TOO_LONG', `AI 起草结果超过 ${maxChars} 字，已跳过（不截断半成品）`, 502);
    }
    const audit = auditQzoneText(cleaned, { knownTokens: currentKnownTokens() });
    if (!audit.ok) throw qzoneError('QZONE_AUDIT_BLOCKED', audit.reason, 403);
    // 风格复核（§7.4）：只用四类硬信号；命中且非敏感话题时最多重写 1 次，失败发原稿
    if (stylePass) {
      try {
        const { lintQzoneText, describeLintForRetry } = await import('./surface/qzone-lint.js');
        const detected = lintQzoneText(cleaned);
        if (detected.flagged && !detected.sensitiveTopic) {
          for (let attempt = 1; attempt <= 1; attempt += 1) {
            try {
              const retry = await draftWithAgent({
                source, maxChars, context,
                styleFlags: describeLintForRetry(detected),
                styleRetry: attempt,
              });
              const retryCleaned = normalizeContent(retry)
                .replace(/^```[\w-]*\s*/i, '')
                .replace(/\s*```$/, '')
                .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
                .trim();
              if (!retryCleaned || retryCleaned.length > maxChars) break; // 重写不合格：保留原稿
              const retryAudit = auditQzoneText(retryCleaned, { knownTokens: currentKnownTokens() });
              const retryLint = lintQzoneText(retryCleaned);
              if (retryAudit.ok && !retryLint.flagged) return retryCleaned;
              break; // 重写仍命中：发原稿（§7.4 硬约束：重写最多 1 次）
            } catch {
              break; // 重写失败发原稿
            }
          }
        }
      } catch (error) {
        log(`qzone 风格复核跳过：${error?.message ?? error}`);
      }
    }
    return cleaned;
  }

  function draftPreview(draft) {
    return {
      draftId: draft.draftId,
      content: draft.content,
      contentLength: draft.content.length,
      images: draft.images.map((img) => ({ label: img.label, bytes: img.bytes, mime: img.mime, sourceType: img.sourceType })),
      imageCount: draft.images.length,
      ugcRight: draft.ugcRight,
      visibility: visibilityLabel(draft.ugcRight),
      targetUins: draft.targetUins,
      expiresAt: new Date(draft.expiresAt).toISOString(),
      used: draft.used,
      source: draft.source,
    };
  }

  async function createDraft({ content, images = [], ugcRight, targetUins = [], askAiToDraft = false, source = 'manual' } = {}) {
    assertWritable();
    if (!config.enabled) throw qzoneError('QZONE_DISABLED', 'QQ 空间功能未开启（qzone.enabled=false）', 403);
    // S4（§8.7 日记→空间）：摘录草稿——开关默认关；必须给原文 content（不允许 AI 起草冒充摘录）
    if (source === 'diary') {
      if (!diaryShareEnabled) {
        throw qzoneError('DIARY_SHARE_DISABLED', '日记转空间未开启（socialV3.surface.diary.shareToQzone=false），不能用日记摘录起草说说', 403);
      }
      if (askAiToDraft) throw qzoneError('DIARY_SHARE_NO_AI', '日记摘录必须给原文 content，不能用 AI 起草代替摘录', 400);
    }
    const right = ugcRight === undefined || ugcRight === null ? config.defaultUgcRight : Number(ugcRight);
    if (!config.allowedUgcRights.includes(right)) {
      throw qzoneError('BAD_UGC_RIGHT', `可见范围 ${right} 不在允许集合内（${config.allowedUgcRights.join('/')}）`, 400);
    }
    const uins = Array.isArray(targetUins) ? targetUins.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
    if ((right === 16 || right === 128) && uins.length === 0) {
      throw qzoneError('TARGET_UINS_REQUIRED', `可见范围 ${right} 必须提供 targetUins`, 400);
    }
    let text = normalizeContent(content);
    if (!text && askAiToDraft) text = await generateContent(source, config.maxContentChars);
    if (!text) throw qzoneError('EMPTY_CONTENT', '草稿正文为空：请提供 content 或 askAiToDraft=true', 400);
    if (text.length > config.maxContentChars) {
      throw qzoneError('CONTENT_TOO_LONG', `正文超过上限（${text.length} > ${config.maxContentChars} 字）`, 400);
    }
    const audit = auditQzoneText(text, { knownTokens: currentKnownTokens() });
    if (!audit.ok) throw qzoneError('QZONE_AUDIT_BLOCKED', audit.reason, 403);
    if (source === 'diary') {
      // §8.7：即使主人要求，也要先过 auditQzoneText（上面）+ knownMemberNames 检查
      const { lintMemberNames } = await import('./surface/qzone-lint.js');
      const memberCheck = lintMemberNames(text, currentKnownMemberNames());
      if (!memberCheck.ok) throw qzoneError('QZONE_AUDIT_BLOCKED', memberCheck.reason, 403);
    }
    const resolvedImages = await resolveImageInputs(images, { config, imageSearch, fetchBuffer });
    if (resolvedImages.length > config.maxImages) throw qzoneError('BAD_IMAGE', `最多 ${config.maxImages} 张图片`, 400);

    const draftId = crypto.randomBytes(16).toString('hex');
    const draftDir = path.join(mediaDir, draftId);
    const storedImages = [];
    try {
      if (resolvedImages.length > 0) fs.mkdirSync(draftDir, { recursive: true, mode: 0o700 });
      for (let i = 0; i < resolvedImages.length; i += 1) {
        const image = resolvedImages[i];
        const fileName = `${i}.${image.ext}`;
        fs.writeFileSync(path.join(draftDir, fileName), image.buffer, { mode: 0o600 });
        storedImages.push({
          file: fileName,
          bytes: image.bytes,
          mime: image.mime,
          sha256: image.sha256,
          sourceType: image.sourceType,
          label: image.label,
        });
      }
    } catch (error) {
      cleanupDraftMedia(draftId);
      throw error;
    }

    const createdAt = now();
    const draft = {
      draftId,
      content: text,
      images: storedImages,
      ugcRight: right,
      targetUins: uins,
      createdAt,
      expiresAt: createdAt + config.draftTtlMinutes * 60_000,
      used: false,
      attemptedAt: 0,
      source: source === 'proactive' ? 'proactive' : source === 'diary' ? 'diary' : 'manual',
    };
    state.drafts.push(draft);
    if (state.drafts.length > MAX_DRAFTS) {
      const dropped = state.drafts.splice(0, state.drafts.length - MAX_DRAFTS);
      for (const item of dropped) cleanupDraftMedia(item.draftId);
    }
    saveState();
    log(`qzone 草稿已创建：${draftId}（${text.length} 字，${storedImages.length} 图，${visibilityLabel(right)}）`);
    activity(`[qzone] 草稿 ${draftId}：${text.length} 字，${storedImages.length} 图，${visibilityLabel(right)}`);
    return draftPreview(draft);
  }

  function findDraft(draftId) {
    return state.drafts.find((d) => d.draftId === String(draftId ?? ''));
  }

  function readDraftImages(draft) {
    const out = [];
    for (const img of draft.images) {
      const file = path.join(mediaDir, draft.draftId, img.file);
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch {
        throw qzoneError('DRAFT_IMAGE_MISSING', `草稿图片已丢失：${img.label}`, 410);
      }
      if (buffer.length !== img.bytes) throw qzoneError('DRAFT_IMAGE_CHANGED', `草稿图片大小变化：${img.label}`, 409);
      const sha = crypto.createHash('sha256').update(buffer).digest('hex');
      if (img.sha256 && sha !== img.sha256) throw qzoneError('DRAFT_IMAGE_CHANGED', `草稿图片内容变化：${img.label}`, 409);
      assertImageBuffer(buffer, config.maxImageBytes, img.label);
      out.push({ ...img, buffer });
    }
    const total = out.reduce((sum, item) => sum + item.bytes, 0);
    if (total > config.maxTotalImageBytes) throw qzoneError('BAD_IMAGE', '草稿图片总大小超过上限', 400);
    return out;
  }

  async function publishDraft({ draftId, confirm, source = 'manual' } = {}) {
    assertWritable();
    if (confirm !== true) throw qzoneError('CONFIRM_REQUIRED', '发布必须显式 confirm=true', 400);
    const draft = findDraft(draftId);
    if (!draft) throw qzoneError('DRAFT_NOT_FOUND', '草稿不存在或已过期', 404);
    if (draft.used) throw qzoneError('DRAFT_USED', '草稿已使用（一次性）', 409);
    if (draft.expiresAt > 0 && now() >= draft.expiresAt) {
      cleanupDraftMedia(draft.draftId);
      draft.mediaCleaned = true;
      saveState();
      throw qzoneError('DRAFT_EXPIRED', '草稿已过期（TTL 30 分钟）', 410);
    }
    const text = normalizeContent(draft.content);
    const audit = auditQzoneText(text, { knownTokens: currentKnownTokens() });
    if (!audit.ok) throw qzoneError('QZONE_AUDIT_BLOCKED', audit.reason, 403);
    const duplicate = isDuplicate(text);
    if (duplicate.duplicate) throw qzoneError('QZONE_DUPLICATE', '7 天内已发布过相同或近似内容，已拒绝', 409);
    assertCanPublish(source);

    const images = readDraftImages(draft);
    draft.used = true;
    draft.state = 'sending';
    draft.attemptedAt = now();
    state.inFlight = true;
    state.lastAttemptAt = now();
    // H4：先把 lastPublish 记成 sending——进程崩溃后启动时可据此判定「可能已发出」
    setLastPublish('sending', { tidHash: '', contentHash: contentHash(text), startedAt: now(), verifiedAt: 0 });
    saveState();

    try {
      const data = await requestQzone('send_qzone_msg', {
        content: text,
        ...(images.length ? { images: images.map((img) => `base64://${img.buffer.toString('base64')}`) } : {}),
        ugc_right: draft.ugcRight,
        ...(draft.targetUins.length ? { target_uins: draft.targetUins } : {}),
      }, { timeoutMs: config.publishTimeoutMs });
      const tid = String(data?.tid ?? '').trim();
      if (!tid) throw qzoneError('QZONE_NO_TID', '发布响应缺少 tid，按失败处理（不谎报成功）', 502);
      recordPost({ tid, time: data?.time, content: text, ugcRight: draft.ugcRight, source: draft.source === 'diary' ? 'diary' : source, images: images.length });

      // 发布后回读核实（H4/§7.5）：miss/unknown 都**不重试、不重复发布**
      const verification = await verifyPublished({ tid, expectedHash: contentHash(text) });
      if (verification === 'verified') {
        setLastPublish('published', { tidHash: hashTid(tid), verifiedAt: now() });
        draft.state = 'published';
      } else if (verification === 'unknown') {
        setLastPublish('unknown', { tidHash: hashTid(tid) });
        draft.state = 'unknown';
        draft.mediaKeepUntil = now() + UNKNOWN_MEDIA_KEEP_MS;
      } else {
        // miss：已发出但回读没对上——不重发，通知主人手动核对
        setLastPublish('published', { tidHash: hashTid(tid) });
        draft.state = 'published';
      }
      // miss 也回写（发布调用本身成功了），但把 verification 带给调用方判断
      await capturePublishedMemory({ tid, content: text, source, ugcRight: draft.ugcRight, verification });

      if (draft.state !== 'unknown') {
        cleanupDraftMedia(draft.draftId);
        draft.mediaCleaned = true;
      }
      saveState();
      const verifyLabel = verification === 'verified' ? '已发布且已核实' : (verification === 'miss' ? '已发布但未核实（请手动看空间，不会重发）' : '已发布，核实状态未知（不重试）');
      log(`qzone ${verifyLabel}：${tid}（${text.length} 字，${images.length} 图，${visibilityLabel(draft.ugcRight)}）`);
      activity(`[qzone] ${verifyLabel} tid=${tid}：${text.length} 字，${images.length} 图，${visibilityLabel(draft.ugcRight)}`);
      const previewLine = notifyPreview ? `\n正文：${text.slice(0, 60)}${text.length > 60 ? '…' : ''}` : '';
      await notify(`【QQ 空间】${verifyLabel}\n${visibilityLabel(draft.ugcRight)}\ntid：${tid}${previewLine}`, { tid, source, ugcRight: draft.ugcRight, verification });
      emitSurfaceEvent({
        surface: 'qzone', op: 'publish', ok: true, source,
        hashes: { tid: hashTid(tid), content: contentHash(text) },
        meta: { verification: verification === 'verified' ? 'verified' : (verification === 'miss' ? 'miss' : 'unknown'), images: images.length, ugcRight: draft.ugcRight }
      });
      return {
        ok: true, tid, time: data?.time ?? null,
        ugcRight: draft.ugcRight, visibility: visibilityLabel(draft.ugcRight),
        contentLength: text.length, images: images.length,
        // §7.5：返回必须明说核实结果，禁止模型自行声称成功
        verified: verification === 'verified',
        verification,
        note: verification === 'verified' ? '已发布且已核实' : (verification === 'miss' ? '已发布但未核实，请手动查看空间（不会自动重发）' : '已发布，核实状态未知（不会自动重发）'),
      };
    } catch (error) {
      // H4：超时/断网可能是「其实已发出」——记 unknown、保留媒体 24h、不谎报失败
      const unknownState = isUnknownPublishError(error);
      if (unknownState) {
        setLastPublish('unknown', { tidHash: '' });
        draft.state = 'unknown';
        draft.mediaKeepUntil = now() + UNKNOWN_MEDIA_KEEP_MS;
        saveState();
        log(`qzone 发布结果未知（不重试，媒体保留 24h）：${redact(String(error?.message ?? error))}`);
        activity(`[qzone] 发布结果未知：${redact(String(error?.message ?? error)).slice(0, 120)}`);
        await notify(`【QQ 空间】发布结果未知（可能已发出，请手动看空间；不会自动重发）\n${redact(String(error?.message ?? error)).slice(0, 200)}`, { source, unknown: true });
        emitSurfaceEvent({
          surface: 'qzone', op: 'publish', ok: false, source,
          errorCode: 'QZONE_UNKNOWN_STATE',
          meta: { images: images.length, ugcRight: draft.ugcRight }
        });
        return {
          ok: false, state: 'unknown', code: 'QZONE_UNKNOWN_STATE',
          error: redact(String(error?.message ?? error)),
          note: '发布请求结果未知：可能已发出，请手动查看空间；24 小时内可用 qzone_list(reconcile=true) 核对，不会自动重发。',
          ugcRight: draft.ugcRight, visibility: visibilityLabel(draft.ugcRight),
        };
      }
      recordFailure(source, error);
      draft.state = 'failed';
      setLastPublish('failed', { tidHash: '' });
      cleanupDraftMedia(draft.draftId);
      draft.mediaCleaned = true;
      saveState();
      log(`qzone 发布失败：${redact(String(error?.message ?? error))}`);
      activity(`[qzone] 发布失败：${redact(String(error?.message ?? error)).slice(0, 120)}`);
      await notify(`【QQ 空间】发布失败\n${redact(String(error?.message ?? error)).slice(0, 200)}`, { source, error: true });
      emitSurfaceEvent({
        surface: 'qzone', op: 'publish', ok: false, source,
        errorCode: 'QZONE_PUBLISH_FAILED',
        meta: { images: images.length, ugcRight: draft.ugcRight }
      });
      throw error;
    }
  }

  async function deletePost({ tid, confirm } = {}) {
    assertWritable();
    if (confirm !== true) throw qzoneError('CONFIRM_REQUIRED', '删除必须显式 confirm=true', 400);
    const value = String(tid ?? '').trim();
    if (!value) throw qzoneError('BAD_TID', 'tid 不能为空', 400);
    try {
      await requestQzone('delete_qzone_msg', { tid: value }, { timeoutMs: config.publishTimeoutMs });
      const post = state.posts.find((p) => p.tid === value);
      if (post) post.deletedAt = now();
      saveState();
      log(`qzone 已删除说说：${value}`);
      activity(`[qzone] 已删除说说 tid=${value}`);
      await notify(`【QQ 空间】已删除说说 tid：${value}`, { tid: value, source: 'delete' });
      return { ok: true, tid: value };
    } catch (error) {
      recordFailure('delete', error);
      log(`qzone 删除失败：${redact(String(error?.message ?? error))}`);
      await notify(`【QQ 空间】删除失败 tid=${value}\n${redact(String(error?.message ?? error)).slice(0, 200)}`, { tid: value, source: 'delete', error: true });
      throw error;
    }
  }

  async function listPosts({ count = 20 } = {}) {
    const num = Math.min(50, Math.max(1, Number(count) || 20));
    const data = await requestQzone('get_qzone_msg_list', { pos: 0, num }, { timeoutMs: 20_000 });
    const msglist = Array.isArray(data?.msglist) ? data.msglist : [];
    return {
      total: Number(data?.total) || msglist.length,
      msglist: msglist.map((item) => ({
        tid: String(item?.tid ?? ''),
        content: String(item?.content ?? ''),
        time: Number(item?.time) || 0,
        commentNum: Number(item?.comment_num) || 0,
        isPrivate: item?.is_private === true,
        images: Array.isArray(item?.images) ? item.images.map(String) : [],
      })),
    };
  }

  function effectiveProactiveEnabled() {
    if (!config.enabled) return false;
    // 控制台显式开关优先于配置默认值：停用后立刻生效，重新启用也不需要改 config 重启。
    if (typeof state.proactiveEnabled === 'boolean') return state.proactiveEnabled;
    return config.proactive.enabled;
  }

  function status() {
    const current = now();
    const todayManual = countToday((p) => p.source === 'manual');
    const todayProactive = countToday((p) => p.source === 'proactive');
    // H4：unknownCount 供控制台红点（§16 待定 4 建议进）；lastPublish.tidHash 只给哈希
    const unknownCount = (state.lastPublish?.state === 'unknown' ? 1 : 0)
      + state.drafts.filter((d) => d.state === 'unknown' && d.mediaKeepUntil > current).length;
    return {
      enabled: config.enabled,
      ownerOnly: true,
      defaultUgcRight: config.defaultUgcRight,
      allowedUgcRights: config.allowedUgcRights,
      maxContentChars: config.maxContentChars,
      maxImages: config.maxImages,
      maxImageBytes: config.maxImageBytes,
      maxTotalImageBytes: config.maxTotalImageBytes,
      localImageDirsCount: config.localImageDirs.length,
      draftTtlMinutes: config.draftTtlMinutes,
      minIntervalMs: config.minIntervalMs,
      maxPostsPerDay: config.maxPostsPerDay,
      publishTimeoutMs: config.publishTimeoutMs,
      stateWritable: writable,
      pendingDrafts: state.drafts.filter((d) => !d.used && d.expiresAt > current).length,
      lastPostAt: state.lastPostAt || null,
      lastAttemptAt: state.lastAttemptAt || null,
      inFlight: state.inFlight,
      lastPublish: state.lastPublish ? {
        state: state.lastPublish.state,
        tidHash: state.lastPublish.tidHash || null,
        startedAt: state.lastPublish.startedAt ? new Date(state.lastPublish.startedAt).toISOString() : null,
        verifiedAt: state.lastPublish.verifiedAt ? new Date(state.lastPublish.verifiedAt).toISOString() : null,
      } : null,
      unknownCount,
      defaultVisibility: visibilityLabel(config.defaultUgcRight),
      today: { total: todayManual + todayProactive, manual: todayManual, proactive: todayProactive },
      proactive: {
        configEnabled: config.proactive.enabled,
        override: state.proactiveEnabled,
        effective: effectiveProactiveEnabled(),
        minIntervalMinutes: config.proactive.minIntervalMinutes,
        maxIntervalMinutes: config.proactive.maxIntervalMinutes,
        maxPerDay: config.proactive.maxPerDay,
        maxChars: config.proactive.maxChars,
        quietHours: config.proactive.quietHours,
        quietNow: isQuietHours(current, config.proactive.quietHours),
        imageProbability: config.proactive.imageProbability,
        maxImages: config.proactive.maxImages,
        useRecentSearchCache: config.proactive.useRecentSearchCache,
        searchImagesFromWeb: config.proactive.searchImagesFromWeb,
        notifyOwner: config.proactive.notifyOwner,
        nextRunAt: nextRunAt || null,
      },
      lastFailure: state.failures.length ? state.failures[state.failures.length - 1] : null,
    };
  }

  function randomIntervalMs() {
    const min = config.proactive.minIntervalMinutes * 60_000;
    const max = config.proactive.maxIntervalMinutes * 60_000;
    const span = Math.max(0, max - min);
    return min + Math.floor(random() * (span + 1));
  }

  function clearScheduled() {
    if (timer !== null) {
      try { clearTimer(timer); } catch {}
      timer = null;
    }
    nextRunAt = 0;
  }

  function schedule(delayMs) {
    clearScheduled();
    if (!effectiveProactiveEnabled()) return;
    const delay = Math.max(60_000, Math.min(MAX_TIMEOUT_MS, Math.round(Number(delayMs) || 0)));
    nextRunAt = now() + delay;
    timer = setTimer(() => {
      timer = null;
      nextRunAt = 0;
      void tick({ source: 'proactive' }).catch((error) => {
        log(`qzone 主动发布 tick 异常：${error?.message ?? error}`);
        // 任何未预期异常都必须重新排下一窗口，否则一次异常会让调度器永久停摆。
        if (effectiveProactiveEnabled()) schedule(randomIntervalMs());
      });
    }, delay);
    timer?.unref?.();
  }

  function start() {
    stopped = false;
    cleanupExpiredDrafts();
    if (!effectiveProactiveEnabled()) {
      clearScheduled();
      return;
    }
    const current = now();
    const quietDelay = msUntilQuietEnd(current, config.proactive.quietHours);
    schedule(quietDelay > 0 ? quietDelay + Math.floor(random() * 5 * 60_000) : randomIntervalMs());
    log(`qzone 主动发布已启动：下一次约 ${new Date(nextRunAt).toLocaleString()}（间隔 ${config.proactive.minIntervalMinutes}~${config.proactive.maxIntervalMinutes} 分钟）`);
  }

  function stop() {
    stopped = true;
    clearScheduled();
    saveState();
  }

  function setProactiveEnabled(enabled) {
    state.proactiveEnabled = enabled === true;
    saveState();
    if (state.proactiveEnabled) start();
    else clearScheduled();
    log(`qzone 主动发布已${state.proactiveEnabled ? '启用' : '停用'}（state/qzone.json 覆盖）`);
    return status();
  }

  function applyConfig(nextRaw) {
    const next = normalizeQzoneConfig(nextRaw, { root, log }).config;
    const wasProactive = effectiveProactiveEnabled();
    config = next;
    if (effectiveProactiveEnabled()) start();
    else if (wasProactive) clearScheduled();
    return status();
  }

  function proactiveImageQuery(content) {
    const text = String(content ?? '')
      .replace(/[https?:\/\/\S]+/gi, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '生活 日常';
    return Array.from(text).slice(0, 24).join('');
  }

  async function pickProactiveImages(content = '') {
    if (config.proactive.maxImages <= 0) return [];
    if (random() >= config.proactive.imageProbability) return [];
    const wanted = Math.max(1, Math.min(config.proactive.maxImages, config.maxImages));
    const picked = [];

    if (webImages && config.proactive.useRecentSearchCache && imageSearch && typeof imageSearch.listRecentCandidates === 'function') {
      try {
        const candidates = imageSearch.listRecentCandidates({ limit: Math.max(8, wanted * 4) })
          .filter((c) => c && c.searchId && Number.isInteger(c.candidateId));
        if (candidates.length > 0) {
          const chosen = [];
          const used = new Set();
          while (chosen.length < wanted && used.size < candidates.length) {
            const item = candidates[Math.floor(random() * candidates.length)];
            const key = `${item.searchId}:${item.candidateId}`;
            if (used.has(key)) continue;
            used.add(key);
            chosen.push(item);
          }
          for (const item of chosen) {
            try {
              const images = await resolveImageInputs([{
                searchId: item.searchId,
                candidateIds: [item.candidateId],
              }], { config, imageSearch, fetchBuffer, maxImages: 1 });
              if (images[0]) picked.push(images[0]);
            } catch (error) {
              log(`qzone 主动配图候选不可用：${error?.message ?? error}`);
            }
            if (picked.length >= wanted) break;
          }
        }
      } catch (error) {
        log(`qzone 读取近期搜图缓存失败：${error?.message ?? error}`);
      }
    }

    if (picked.length === 0 && config.localImageDirs.length > 0) {
      const files = [];
      for (const dir of config.localImageDirs) {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (!IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
            files.push(path.join(dir, entry.name));
          }
        } catch {}
      }
      for (let i = 0; i < wanted && files.length > 0; i += 1) {
        const index = Math.floor(random() * files.length);
        const [file] = files.splice(index, 1);
        try {
          picked.push(readLocalImage({ file, dirs: config.localImageDirs, maxBytes: config.maxImageBytes }));
        } catch (error) {
          log(`qzone 主动配图本机文件不可用：${error?.message ?? error}`);
          i -= 1;
        }
      }
    }

    // 没有近期搜图缓存、白名单目录也没有图时，按正文关键词做一次网络图片检索。
    // 这是“主动发布可以配网图”的兜底；失败就退回纯文字，绝不硬发占位图。
    // webImages=false（V3 默认）时整个网络分支跳过：只用本机目录/主人给的图（§17.4 第 5 条）。
    if (picked.length === 0 && webImages && config.proactive.searchImagesFromWeb
      && imageSearch && typeof imageSearch.search === 'function') {
      try {
        const query = proactiveImageQuery(content);
        const result = await imageSearch.search({ query, count: Math.max(4, wanted * 3) });
        const ids = (result.candidates ?? [])
          .map((candidate) => candidate.candidateId)
          .filter((id) => Number.isInteger(id))
          .slice(0, Math.max(wanted * 2, 4));
        if (ids.length > 0) {
          const prepared = await imageSearch.prepareSend({ searchId: result.searchId, candidateIds: ids });
          for (const item of prepared.selected ?? []) {
            if (picked.length >= wanted) break;
            // imageSource='web'（§17.4 第 5 条）：开启网络图时记录来源，便于审计
            picked.push(bufferToImageEntry(item.buffer, config.maxImageBytes, `网络搜图#${item.candidateId}`, 'url'));
          }
        }
        log(`qzone 主动配图网络检索 searchId=${result.searchId} candidates=${(result.candidates ?? []).length} picked=${picked.length}`);
      } catch (error) {
        log(`qzone 主动配图网络检索失败，本次改为纯文字：${error?.message ?? error}`);
      }
    }

    const total = picked.reduce((sum, item) => sum + item.bytes, 0);
    if (total > config.maxTotalImageBytes) {
      log('qzone 主动配图总大小超限，本次改为纯文字');
      return [];
    }
    return picked.slice(0, wanted);
  }

  async function tick({ source = 'proactive', dryRun = false } = {}) {
    if (ticking) return { ok: true, skipped: 'busy' };
    if (!effectiveProactiveEnabled()) {
      clearScheduled();
      return { ok: true, skipped: 'disabled' };
    }
    ticking = true;
    try {
      const current = now();
      if (isQuietHours(current, config.proactive.quietHours)) {
        schedule(msUntilQuietEnd(current, config.proactive.quietHours) + Math.floor(random() * 5 * 60_000));
        return { ok: true, skipped: 'quiet' };
      }
      if (state.inFlight) {
        schedule(randomIntervalMs());
        return { ok: true, skipped: 'in_flight' };
      }
      try {
        assertCanPublish('proactive');
      } catch (error) {
        schedule(randomIntervalMs());
        return { ok: true, skipped: 'limits', reason: error?.message ?? String(error) };
      }
      // §17.4 第 6 条：主人手动发过说说后，机器人至少等 minGapAfterManualPostMs 再发
      if (minGapAfterManualPostMs > 0) {
        const lastManual = [...state.posts].reverse().find((p) => p.source === 'manual');
        if (lastManual?.at && now() - lastManual.at < minGapAfterManualPostMs) {
          schedule(randomIntervalMs());
          return { ok: true, skipped: 'manual_gap', reason: '主人刚发过说说，稍后再发' };
        }
      }
      let online = false;
      try {
        online = (await isQqOnline()) === true;
      } catch (error) {
        log(`qzone 检查 QQ 在线状态失败：${error?.message ?? error}`);
      }
      if (!online) {
        log('qzone 主动发布跳过：QQ 不在线');
        schedule(randomIntervalMs());
        return { ok: true, skipped: 'offline' };
      }

      let content;
      try {
        content = await generateContent('proactive', config.proactive.maxChars);
      } catch (error) {
        recordFailure('proactive', error);
        log(`qzone 主动发布跳过：${error?.message ?? error}`);
        await notify(`【QQ 空间】主动发布已跳过\n原因：${redact(String(error?.message ?? error)).slice(0, 200)}`, { source: 'proactive', skipped: true });
        schedule(randomIntervalMs());
        return { ok: true, skipped: 'draft_failed', reason: error?.message ?? String(error) };
      }
      const audit = auditQzoneText(content, { knownTokens: currentKnownTokens() });
      if (!audit.ok) {
        recordFailure('proactive', qzoneError('QZONE_AUDIT_BLOCKED', audit.reason, 403));
        await notify(`【QQ 空间】主动发布已跳过\n原因：${audit.reason}`, { source: 'proactive', skipped: true });
        schedule(randomIntervalMs());
        return { ok: true, skipped: 'audit', reason: audit.reason };
      }
      const duplicate = isDuplicate(content);
      if (duplicate.duplicate) {
        log(`qzone 主动发布跳过：7 天内已有近似内容（${duplicate.matched}）`);
        await notify('【QQ 空间】主动发布已跳过\n原因：7 天内已发布过相同或近似内容', { source: 'proactive', skipped: true });
        schedule(randomIntervalMs());
        return { ok: true, skipped: 'duplicate' };
      }
      // §7.6 去重扩展：与最近主人私聊话题/日记摘要高度重合 → 降权跳过本轮（不硬拦，下轮再试）
      const soft = await softDuplicate(content);
      if (soft.overlap) {
        log(`qzone 主动发布降权跳过：与最近话题/日记高度重合（${soft.matched}）`);
        schedule(randomIntervalMs());
        return { ok: true, skipped: 'soft_duplicate' };
      }
      const images = await pickProactiveImages(content);
      if (dryRun) {
        return {
          ok: true,
          dryRun: true,
          wouldPublish: true,
          contentHash: contentHash(content),
          contentLength: content.length,
          images: images.length,
          ugcRight: config.defaultUgcRight,
          visibility: visibilityLabel(config.defaultUgcRight),
        };
      }
      // §7.8：proactiveApproval=true（仅 canary 观察期）→ 只出草稿通知主人，不自动发
      if (proactiveApproval) {
        const draft = await createDraft({ content, images: [], ugcRight: config.defaultUgcRight, source: 'proactive' });
        log(`qzone 主动发布待确认：草稿 ${draft.draftId}（${content.length} 字）`);
        await notify(`【QQ 空间】主动发布草稿待确认\ndraftId：${draft.draftId}\n确认后用 qzone_publish 发布`, { draftId: draft.draftId, source: 'proactive', approval: true });
        schedule(randomIntervalMs());
        return { ok: true, pendingApproval: true, draftId: draft.draftId, contentLength: content.length };
      }
      assertCanPublish('proactive');
      state.inFlight = true;
      state.lastAttemptAt = now();
      saveState();
      try {
        const data = await requestQzone('send_qzone_msg', {
          content,
          ...(images.length ? { images: images.map((img) => `base64://${img.buffer.toString('base64')}`) } : {}),
          ugc_right: config.defaultUgcRight,
        }, { timeoutMs: config.publishTimeoutMs });
        const tid = String(data?.tid ?? '').trim();
        if (!tid) throw qzoneError('QZONE_NO_TID', '发布响应缺少 tid，按失败处理（不谎报成功）', 502);
        recordPost({ tid, time: data?.time, content, ugcRight: config.defaultUgcRight, source: 'proactive', images: images.length });
        // H4：主动发布同样回读核实；miss/unknown 不重发
        const verification = await verifyPublished({ tid, expectedHash: contentHash(content) });
        setLastPublish(verification === 'unknown' ? 'unknown' : 'published', { tidHash: hashTid(tid), verifiedAt: verification === 'verified' ? now() : 0 });
        await capturePublishedMemory({ tid, content, source: 'proactive', ugcRight: config.defaultUgcRight, verification });
        const verifyLabel = verification === 'verified' ? '已发布且已核实' : (verification === 'miss' ? '已发布但未核实（不会重发）' : '已发布，核实状态未知（不重试）');
        log(`qzone 主动发布${verifyLabel}：${tid}（${content.length} 字，${images.length} 图，${visibilityLabel(config.defaultUgcRight)}）`);
        activity(`[qzone] 主动发布${verifyLabel} tid=${tid}：${content.length} 字，${images.length} 图，${visibilityLabel(config.defaultUgcRight)}`);
        const previewLine = notifyPreview ? `\n正文：${content.slice(0, 60)}${content.length > 60 ? '…' : ''}` : '';
        await notify(`【QQ 空间】主动发布${verifyLabel}\n${visibilityLabel(config.defaultUgcRight)}\ntid：${tid}${previewLine}`, { tid, source: 'proactive', ugcRight: config.defaultUgcRight, verification });
        emitSurfaceEvent({
          surface: 'qzone', op: 'publish', ok: true, source: 'proactive',
          hashes: { tid: hashTid(tid), content: contentHash(content) },
          meta: { verification: verification === 'verified' ? 'verified' : (verification === 'miss' ? 'miss' : 'unknown'), images: images.length, ugcRight: config.defaultUgcRight }
        });
        schedule(randomIntervalMs());
        return { ok: true, tid, ugcRight: config.defaultUgcRight, visibility: visibilityLabel(config.defaultUgcRight), contentLength: content.length, images: images.length, verified: verification === 'verified', verification };
      } catch (error) {
        // H4：主动发布超时也可能是「其实已发出」——记 unknown、不谎报失败、不重发
        if (isUnknownPublishError(error)) {
          setLastPublish('unknown', { tidHash: '' });
          log(`qzone 主动发布结果未知（不重试）：${redact(String(error?.message ?? error))}`);
          activity(`[qzone] 主动发布结果未知：${redact(String(error?.message ?? error)).slice(0, 120)}`);
          await notify(`【QQ 空间】主动发布结果未知（可能已发出，请手动看空间；不会自动重发）`, { source: 'proactive', unknown: true });
          emitSurfaceEvent({ surface: 'qzone', op: 'publish', ok: false, source: 'proactive', errorCode: 'QZONE_UNKNOWN_STATE' });
          schedule(randomIntervalMs());
          return { ok: false, state: 'unknown', code: 'QZONE_UNKNOWN_STATE', error: redact(String(error?.message ?? error)) };
        }
        recordFailure('proactive', error);
        setLastPublish('failed', { tidHash: '' });
        log(`qzone 主动发布失败：${redact(String(error?.message ?? error))}`);
        activity(`[qzone] 主动发布失败：${redact(String(error?.message ?? error)).slice(0, 120)}`);
        await notify(`【QQ 空间】主动发布失败\n${redact(String(error?.message ?? error)).slice(0, 200)}`, { source: 'proactive', error: true });
        emitSurfaceEvent({ surface: 'qzone', op: 'publish', ok: false, source: 'proactive', errorCode: 'QZONE_PUBLISH_FAILED' });
        schedule(randomIntervalMs());
        return { ok: false, error: redact(String(error?.message ?? error)) };
      }
    } finally {
      ticking = false;
    }
  }

  async function runNow({ dryRun = false } = {}) {
    if (!config.enabled) throw qzoneError('QZONE_DISABLED', 'QQ 空间功能未开启', 403);
    if (!config.proactive.enabled) throw qzoneError('QZONE_PROACTIVE_DISABLED', '主动发布未开启', 403);
    return tick({ source: 'proactive', dryRun });
  }

  return {
    config: () => config,
    state: () => state,
    start,
    stop,
    applyConfig,
    setProactiveEnabled,
    status,
    createDraft,
    publishDraft,
    deletePost,
    listPosts,
    tick,
    runNow,
    isDuplicate,
    reconcilePublish,
    _cleanupExpiredDrafts: cleanupExpiredDrafts,
    // 测试用：允许假时钟推进后手动清理
    _test: { cleanupDraftMedia, stateFile, mediaDir },
  };
}
