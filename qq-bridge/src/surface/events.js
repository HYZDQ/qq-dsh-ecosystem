// 表现面观测事件（GEN3 表现面 S0，设计 §5.2）：SurfaceEvent → trace + token 账本。
//   · 复用 simulation/trace.js 的 writer 口径，但单独落 surface-trace-YYYY-MM-DD.jsonl，
//     避免和聊天回合混在一起；
//   · 字段白名单 + 类型收敛：不记正文、不记搜索词、不记 tid 明文（只记哈希）；
//   · emitSurfaceEvent 失败自兜底——观测不能带崩主链路。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactKey } from '../simulation/trace.js';

/** 事件顶层字段白名单（§5.2 + §17.2.3 成本字段）。其余字段一律丢弃。 */
export const SURFACE_EVENT_FIELDS = Object.freeze([
  'ts', 'surface', 'op', 'keyHash', 'turnId',
  'ok', 'durationMs', 'attempt',
  'trust', 'budget', 'hashes', 'errorCode', 'meta',
  'tokensIn', 'tokensOut', 'modelCalls'
]);

const TRUST_VALUES = new Set(['owner-confirmed', 'observed', 'untrusted']);
const ENUM_RE = /^[a-z0-9_:.-]{1,40}$/i;

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function asHashes(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ENUM_RE.test(k)) continue;
    if (typeof v === 'string' && v) out[k] = v.slice(0, 64);
  }
  return Object.keys(out).length ? out : null;
}

function asBudget(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = typeof input.kind === 'string' && ENUM_RE.test(input.kind) ? input.kind : null;
  if (!kind) return null;
  return { kind, used: asCount(input.used) ?? 0, limit: asCount(input.limit) ?? 0 };
}

function asMeta(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ENUM_RE.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && ENUM_RE.test(v)) out[k] = v; // 枚举字符串，禁止自由文本
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 构建一条 SurfaceEvent（白名单 + 类型收敛）。
 * 会话 key 走 redactKey（private:h_xxxxxxxx），其余标识走调用方给的哈希。
 */
export function buildSurfaceEvent(input = {}) {
  // 'key' 是 keyHash 的输入别名，不算丢弃；其余白名单外字段一律丢弃并留痕。
  const dropped = Object.keys(input).filter((k) => k !== 'key' && !SURFACE_EVENT_FIELDS.includes(k));
  const event = {
    ts: typeof input.ts === 'string' && input.ts ? input.ts : new Date().toISOString(),
    surface: typeof input.surface === 'string' && ENUM_RE.test(input.surface) ? input.surface : null,
    op: typeof input.op === 'string' && ENUM_RE.test(input.op) ? input.op : null,
    keyHash: input.key ? redactKey(input.key) : null,
    turnId: typeof input.turnId === 'string' && input.turnId ? input.turnId.slice(0, 40) : null,
    ok: input.ok === true ? true : (input.ok === false ? false : null),
    durationMs: asCount(input.durationMs),
    attempt: asCount(input.attempt),
    trust: typeof input.trust === 'string' && TRUST_VALUES.has(input.trust) ? input.trust : null,
    budget: asBudget(input.budget),
    hashes: asHashes(input.hashes),
    errorCode: typeof input.errorCode === 'string' && ENUM_RE.test(input.errorCode) ? input.errorCode : null,
    meta: asMeta(input.meta),
    tokensIn: asCount(input.tokensIn),
    tokensOut: asCount(input.tokensOut),
    modelCalls: asCount(input.modelCalls)
  };
  if (dropped.length) event.droppedFields = dropped;
  return event;
}

function ymd(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 表面 trace 落盘器：按日分文件追加 JSONL（state/simulation/surface-trace-YYYY-MM-DD.jsonl）。
 * write/read 不做异常兜底（由 emitSurfaceEvent 或离线脚本决定处理方式）。
 */
export function createSurfaceEventWriter({ dir, now = () => new Date() } = {}) {
  if (!dir) throw new Error('createSurfaceEventWriter 需要 dir');
  return {
    fileFor(date) {
      return path.join(dir, `surface-trace-${ymd(date ?? now())}.jsonl`);
    },
    write(event, date) {
      const file = this.fileFor(date);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
      return file;
    },
    read(date) {
      const file = this.fileFor(date);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    }
  };
}

/** 安全写一条事件：白名单构建 + 异常吞掉记日志，绝不把调用链带崩。返回写入文件或 null。 */
export function emitSurfaceEvent(writer, input, log = () => {}) {
  try {
    return writer.write(buildSurfaceEvent(input));
  } catch (error) {
    log(`surface trace 写入失败：${error?.message ?? error}`);
    return null;
  }
}

/** 内容哈希：sha256 前 16 位，用于 hashes.content / hashes.tid 等字段。 */
export function contentHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}
