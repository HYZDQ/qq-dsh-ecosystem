// 表现面统一脱敏（GEN3 表现面 S0，设计 §5.4）：纯文本函数、零 IO。
// 规则合并自 safe-fetch URL 校验、simulation/trace.redactKey、qq-diary logger.redactText，
// 并借鉴 llm-guard 的「先归一化再检测」：零宽/双向控制符先剥，编码包裹（base64、\uXXXX）
// 解码后再跑规则，防止「编码绕过脱敏」。
import crypto from 'node:crypto';

// 不可见格式码点区间：零宽、双向控制、组合用标记——先剥掉，避免视觉伪造与规则绕过。
// 用码点区间而不是正则字面量：不可见字符写进正则类目极易手滑成大范围（曾误吞全部 ASCII）。
const INVISIBLE_RANGES = Object.freeze([
  [0x00AD, 0x00AD], [0x034F, 0x034F], [0x061C, 0x061C], [0x115F, 0x115F],
  [0x17B4, 0x17B5], [0x180B, 0x180E],
  [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x206F],
  [0xFEFF, 0xFEFF]
]);

function stripInvisible(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0);
    let hide = false;
    for (const [lo, hi] of INVISIBLE_RANGES) {
      if (cp >= lo && cp <= hi) { hide = true; break; }
    }
    if (!hide) out += ch;
  }
  return out;
}

const CONTROLS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const CQ_RE = /\[CQ:[^\]]{0,200}\]/g;
const CRED_ASSIGN_RE = /(token|password|passwd|api[_-]?key|authorization|bearer|secret|cookie)\s*[=:：]\s*[^\s,，;；"'）)]{4,}/gi;
const SK_KEY_RE = /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g;
const LONG_HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const WIN_PATH_RE = /(?:[A-Za-z]:\\|\\\\)[^\s"'<>|*?]{2,}/g;
const UNIX_PATH_RE = /(^|[\s"'(=：:])(\/(?:home|root|etc|var|usr|opt|tmp|Users|workspace|github|data)\/[^\s"'<>]+)/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const PHONE_TEST = /1[3-9]\d{9}/;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const EMAIL_TEST = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// QQ 号：5~12 位连续数字；前后不允许出现数字与日期/版本分隔符，金额上下文见下方回调判断。
const QQ_RE = /(?<![\d.\-/:])\d{5,12}(?![\d.\-/:%])/g;
const QQ_TEST = /\d{5,12}/;
const CRED_TEST = /(token|password|passwd|api[_-]?key|authorization|bearer|secret|cookie)\s*[=:：]\s*\S{4,}/i;
const SK_TEST = /(?:sk|pk)-[A-Za-z0-9_-]{8,}/;

/** sha256 前 16 位：trace 里代替任何原文/查询词/正文。 */
export function hashForTrace(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

function collapse(text) {
  return String(text ?? '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 通用表现面脱敏：去控制字符/零宽/CQ 码/凭据/密钥/路径/URL 参数，可选截断。
 * 不做 IO、不抛错；任何输入都返回字符串。maxChars<=0 表示不截断。
 */
export function redactSurfaceText(text, { maxChars = 500 } = {}) {
  let out = stripInvisible(text);
  out = out.replace(CONTROLS_RE, ' ').replace(CQ_RE, '[CQ已隐藏]');
  out = out.replace(CRED_ASSIGN_RE, (m, name) => `${name}=[已脱敏]`);
  out = out.replace(SK_KEY_RE, (m) => `${m.slice(0, 3)}[已脱敏]`);
  out = out.replace(LONG_HEX_RE, '[哈希已脱敏]');
  out = out.replace(WIN_PATH_RE, '[路径已脱敏]');
  out = out.replace(UNIX_PATH_RE, (m, lead, p) => `${lead}[路径已脱敏]`);
  out = out.replace(URL_RE, (m) => `${m.split(/[?#]/)[0]}?[参数已脱敏]`);
  out = collapse(out);
  const max = Number(maxChars);
  if (Number.isFinite(max) && max > 0 && out.length > max) out = `${out.slice(0, max)}…`;
  return out;
}

/**
 * 查询词脱敏：在通用脱敏之上，额外去手机号/QQ 号/邮箱（出网前最后一道）。
 * - 手机号先于 QQ 号替换（11 位手机号也命中 QQ 号规则）；
 * - QQ 号避开日期/金额/版本上下文：与 - / : . 相连、紧跟 ¥/元/万/亿/% 等不替换；
 * - 疑似 base64 / \uXXXX 编码片段解码后检测，命中即整段替换（防编码绕过）。
 */
export function redactQuery(text) {
  let out = redactSurfaceText(text, { maxChars: 0 });
  out = out.replace(PHONE_RE, '[手机号]').replace(EMAIL_RE, '[邮箱]');
  out = out.replace(QQ_RE, (m, offset, whole) => (isQuantityContext(whole, offset, m.length) ? m : '[QQ号]'));
  out = redactEncodedBypass(out);
  return collapse(out);
}

/** 日期/金额/版本上下文：数字两侧是分隔符（构成日期/版本）或紧邻金额单位时不替换。 */
function isQuantityContext(whole, offset, len) {
  const before = whole.slice(Math.max(0, offset - 1), offset);
  const after = whole.slice(offset + len, offset + len + 1);
  if (/[\d.\-/:]/.test(before) || /[\d.\-/:]/.test(after)) return true;
  const around = whole.slice(Math.max(0, offset - 2), offset + len + 2);
  return /[¥￥]/.test(before) || /(元|块|万|亿|岁|%)/.test(around);
}

/** 编码绕过检测：base64 与 \uXXXX 片段解码后若含敏感信息，整段替换。 */
function redactEncodedBypass(text) {
  let out = String(text ?? '');
  out = out.replace(/\b[A-Za-z0-9+/]{12,}={0,2}(?![A-Za-z0-9+/=])/g, (m) => {
    try {
      const decoded = Buffer.from(m, 'base64').toString('utf8');
      if (containsSensitive(decoded)) return '[已脱敏]';
    } catch { /* 非 base64，原样保留 */ }
    return m;
  });
  out = out.replace(/(?:\\u[0-9a-fA-F]{4}){6,}/g, (m) => {
    try {
      const decoded = m.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (containsSensitive(decoded)) return '[已脱敏]';
    } catch { /* 解码失败原样保留 */ }
    return m;
  });
  return out;
}

function containsSensitive(decoded) {
  const s = String(decoded ?? '');
  return PHONE_TEST.test(s) || EMAIL_TEST.test(s) || SK_TEST.test(s) || CRED_TEST.test(s);
}
