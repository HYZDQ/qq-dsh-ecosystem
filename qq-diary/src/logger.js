// 文本脱敏 + 文件日志。
//
// 硬性要求：日志里不能出现 API key、控制台/会话令牌、日记正文全文、原始聊天全文。
// 因此这里做两件事：
//   1. redactText() 把「长得像路径/凭据/令牌」的片段换成占位符（聊天上下文、摘要、错误都用它）；
//   2. createLogger() 注册已知敏感串（key、token）后，所有日志行先 maskSecrets 再落盘。
// 调用侧仍然要自律：正文只记长度与 hash，不记全文。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dateKeyInZone, clockSecondsInZone, DEFAULT_TIMEZONE } from './scheduler.js';

const MIN_SECRET_LENGTH = 8;

const REDACT_RULES = [
  // URL 上的 access_token=... / token=...
  { re: /([?&](?:access_token|accessToken|token)=)[^&\s#]+/g, to: (_m, prefix) => `${prefix}***` },
  // 裸 sk- 密钥
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, to: () => '[密钥]' },
  // Windows 盘符路径（含空格前的部分）
  { re: /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]*/g, to: () => '[路径]' },
  // UNC 路径
  { re: /\\\\[^\\\s"'<>|]+\\[^\s"'<>|]*/g, to: () => '[路径]' },
  // Unix 常见目录
  { re: /(?<![A-Za-z0-9])\/(?:home|Users|etc|var|root|opt)\/[^\s"'<>|]*/g, to: () => '[路径]' },
  // 凭据赋值：token: xxx / api_key=xxx / password：xxx
  {
    re: /(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?(?:token|key)|credential|会话令牌|控制台令牌)(["']?\s*[:=：]\s*["']?)([^\s，。；、"']{3,})/gi,
    to: (_m, sep) => `[凭据]${sep}[已隐藏]`
  },
  // 32 位以上的十六进制串（会话令牌/哈希），先红线掉再说
  { re: /\b[0-9a-f]{32,}\b/gi, to: () => '[令牌]' }
];

/** 脱敏任意文本。enabled=false 时原样返回（config.redactPatterns=false）。 */
export function redactText(text, { enabled = true } = {}) {
  const raw = String(text ?? '');
  if (!enabled) return raw;
  let value = raw;
  for (const rule of REDACT_RULES) value = value.replace(rule.re, rule.to);
  return value;
}

/** 把已知敏感串（key/token）替换成 ***；短于 8 字符的忽略，避免误伤普通词。 */
export function maskSecrets(text, secrets = []) {
  let value = String(text ?? '');
  for (const secret of secrets) {
    const s = String(secret ?? '');
    if (s.length < MIN_SECRET_LENGTH) continue;
    if (!value.includes(s)) continue;
    value = value.split(s).join('***');
  }
  return value;
}

/** 内容指纹：日志里用 hash 代替正文全文。 */
export function contentHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 创建日志器。任何一次写盘失败都不会抛出（降级为只输出到 stdout），
 * 因为日志失败不该让写日记失败。
 */
export function createLogger({
  logDir,
  timeZone = DEFAULT_TIMEZONE,
  now = () => new Date(),
  secrets = [],
  echo = true,
  minLevel = 'info',
  prefix = 'qq-diary'
} = {}) {
  let knownSecrets = [...secrets].filter((s) => typeof s === 'string' && s.length > 0);
  const minWeight = LEVEL_WEIGHT[minLevel] ?? LEVEL_WEIGHT.info;

  const sanitize = (text) => maskSecrets(redactText(text, { enabled: true }), knownSecrets);

  function line(level, message) {
    const at = now();
    const stamp = clockSecondsInZone(at, timeZone);
    const dateKey = dateKeyInZone(at, timeZone);
    const body = sanitize(String(message ?? '')).replace(/\r?\n/g, ' ⏎ ');
    return { text: `[${stamp}] [${level.toUpperCase()}] ${body}`, dateKey };
  }

  function write(level, message) {
    if ((LEVEL_WEIGHT[level] ?? 99) < minWeight) return;
    const { text, dateKey } = line(level, message);
    if (echo) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(text);
    }
    if (!logDir) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, `${prefix}-${dateKey}.log`), `${text}\n`, 'utf8');
    } catch {
      // 日志目录不可写：降级为只输出控制台，绝不打断主流程
    }
  }

  const logger = {
    debug: (msg) => write('debug', msg),
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    /** 追加敏感串（例如启动后解析到的 key），后续日志自动打码。 */
    addSecret(secret) {
      if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH && !knownSecrets.includes(secret)) {
        knownSecrets.push(secret);
      }
    },
    redact: (text) => sanitize(text),
    hash: contentHash,
    fileFor(at = now()) {
      return logDir ? path.join(logDir, `${prefix}-${dateKeyInZone(at, timeZone)}.log`) : '';
    },
    get secrets() {
      return [...knownSecrets];
    }
  };
  return logger;
}
