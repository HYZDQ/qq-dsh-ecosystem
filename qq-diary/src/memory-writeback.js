// 日记记忆回写（GEN3_SURFACE_INTEGRATION_PLAN §8.4/S3）：
// 把日记摘要幂等写回桥接长期记忆（POST /api/socialV3/memory/capture，surface-token）。
//
// 规则：
//   · dedupeKey=diary:<date> 幂等——同日重复调用被桥接判 duplicate（不是失败）；
//   · 只写摘要（≤200 字），不写正文；敏感事实（联系方式/地址/健康/财务）不写；
//   · 失败入 state/memory-queue.json 队列，最多重试 3 次；force 重写＝同 key 再报（upsert 语义）。
import fs from 'node:fs';
import path from 'node:path';
import { readSurfaceToken, surfaceHeaders } from './surface-auth.js';

const QUEUE_MAX = 20;
const RETRY_MAX = 3;

/** 敏感事实拦截（§8.4）：联系方式/地址/健康/财务不入记忆。 */
const SENSITIVE_RE = /(手机|电话|微信|QQ号|邮箱|地址|住址|住院|确诊|手术|工资|存款|贷款|银行卡|密码)/;

function queueFile(stateDir) {
  return path.join(String(stateDir ?? ''), 'memory-queue.json');
}

function loadQueue(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(queueFile(stateDir), 'utf8'));
    return Array.isArray(raw) ? raw.slice(-QUEUE_MAX) : [];
  } catch {
    return [];
  }
}

function saveQueue(stateDir, queue) {
  try {
    fs.mkdirSync(path.dirname(queueFile(stateDir)), { recursive: true });
    fs.writeFileSync(queueFile(stateDir), `${JSON.stringify(queue.slice(-QUEUE_MAX), null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 回写一篇日记摘要。
 * @param {boolean} [opts.upsert] force 重写时 true：同 dedupeKey 更新为新摘要（不产生第二条）
 * @returns {{ok:boolean, created?:boolean, queued?:boolean, code?:string, error?:string}}
 */
export async function captureDiaryMemory({
  qqBridgeDir,
  stateDir,
  date,
  summary,
  upsert = false,
  consoleUrl = 'http://127.0.0.1:3100',
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch
} = {}) {
  const text = String(summary ?? '').slice(0, 200);
  if (!text) return { ok: false, code: 'MEMORY_CAPTURE_REJECTED', error: '摘要为空' };
  if (SENSITIVE_RE.test(text)) {
    return { ok: false, code: 'MEMORY_CAPTURE_REJECTED', error: '摘要含敏感事实（联系方式/地址/健康/财务），不写入记忆' };
  }
  const dedupeKey = `diary:${String(date ?? '')}`;
  const payload = {
    kind: 'episode',
    scope: 'agent',
    trust: 'observed',
    text,
    source: 'diary',
    sourceIds: [String(date ?? '')],
    dedupeKey,
    importance: 0.4,
    ...(upsert ? { upsert: true } : {})
  };

  const { token, error: tokenError } = readSurfaceToken(qqBridgeDir);
  if (!token) {
    enqueue(stateDir, payload);
    return { ok: false, queued: true, code: 'MISSING_SURFACE_TOKEN', error: tokenError };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(new URL('/api/socialV3/memory/capture', consoleUrl), {
      method: 'POST',
      headers: surfaceHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.ok) {
      // created:false + duplicate＝幂等命中，按成功处理
      return { ok: true, created: body.created === true, code: body.code ?? null };
    }
    enqueue(stateDir, payload);
    return { ok: false, queued: true, code: body?.code ?? 'MEMORY_CAPTURE_REJECTED', error: body?.error ?? `HTTP ${res.status}` };
  } catch (error) {
    enqueue(stateDir, payload);
    return { ok: false, queued: true, code: 'MEMORY_CAPTURE_REJECTED', error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function enqueue(stateDir, payload) {
  const queue = loadQueue(stateDir);
  const dedupeKey = payload.dedupeKey;
  const existing = queue.find((item) => item.payload?.dedupeKey === dedupeKey);
  if (existing) {
    existing.retries = Math.min(RETRY_MAX, (existing.retries ?? 0)); // 不重复入队，重试交给 flush
    return;
  }
  queue.push({ at: new Date().toISOString(), retries: 0, payload });
  saveQueue(stateDir, queue);
}

/**
 * 重试队列里未完成的回写（启动时/写日记后调用）。
 * 每项最多 3 次；成功或确认 duplicate 后出队。
 */
export async function flushMemoryQueue({ qqBridgeDir, stateDir, consoleUrl = 'http://127.0.0.1:3100', fetchImpl = globalThis.fetch, logger = null } = {}) {
  const queue = loadQueue(stateDir);
  if (!queue.length) return { ok: true, retried: 0, failed: 0 };
  const remaining = [];
  let retried = 0;
  let failed = 0;
  for (const item of queue) {
    if ((item.retries ?? 0) >= RETRY_MAX) { failed += 1; continue; } // 超次数丢弃（留日志不留正文）
    const result = await captureDiaryMemory({
      qqBridgeDir, stateDir: null, // flush 自己管理队列，避免嵌套入队
      date: item.payload?.sourceIds?.[0],
      summary: item.payload?.text,
      consoleUrl, fetchImpl
    });
    retried += 1;
    if (!result.ok) {
      item.retries = (item.retries ?? 0) + 1;
      if (item.retries < RETRY_MAX) remaining.push(item);
      else { failed += 1; logger?.warn?.(`记忆回写重试 ${RETRY_MAX} 次仍失败，放弃：${item.payload?.dedupeKey}`); }
    }
  }
  saveQueue(stateDir, remaining);
  return { ok: true, retried, failed };
}
