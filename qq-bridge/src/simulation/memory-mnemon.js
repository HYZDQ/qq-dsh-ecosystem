// 三代仿真记忆层 · mnemon backend（GEN3 1.3，按 P0.5 定案的方案 A）。
//
// 为什么分两处存（P0.5 实测结论）：
//   1. mnemon 的 runtime 记忆本（`runtime/memories.json`）字段是白名单：
//      content / created_at / updated_at / target / importance / branches / origin，
//      自定义的 trust / scope / sourceMessageIds 会被清洗，且 controller 任意一次写入都会整文件重写；
//   2. mnemon 没有写入身份校验（任何本机进程都能写），所以「谁写的、可信到什么程度」只能由桥接把关。
// 因此：
//   mnemon  —— 只存正文，统一打 branches:["v3"] 分区（可整区隐藏 / 逐条回滚）。
//   sidecar —— 存完整条目（id/kind/scope/trust/sourceMessageIds/生命周期…），是桥接侧的唯一真相源。
//
// 契约：实现 createMemoryStore 需要的 { scopes(), load(scope), save(scope, entries) }。
// load/save 是同步的（store 内部全程同步），mnemon 是异步的 —— 所以 sidecar 同步落盘、
// mnemon 侧走「串行队列 + 全量对齐」，失败只告警，绝不回灌到 store 或阻塞聊天主链路。
//
// 幂等：对齐时按 (id 排序 → 正文去重) 生成期望集合，与 mnemon 现有 v3 条目做差集；
// 同一状态重复同步不会产生写入。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCOPES, atomicWriteJson } from './memory.js';

/** mnemon 分区名；所有桥接写入的记忆都带这个分支标记。 */
export const MNEMON_NAMESPACE = 'v3';
/** 默认容量（字节）。mnemon 原生默认 memory 只给 10240，长期记忆明显不够；
 *  三代要求记忆本「无限容量、想记就记」—— 1MB 是 mnemon runtime 的硬上限，直接开满。 */
export const DEFAULT_MNEMON_LIMIT_BYTES = 1024 * 1024;
export const MAX_MNEMON_LIMIT_BYTES = 1024 * 1024;

/** 与 dsh-mnemon-source-runtime 一致的归一化：去首尾空白 + 连续空白压成单空格。 */
function normalizeContent(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** dsh-mnemon 编程接口的默认安装路径（DSH 桌面 profile 内）。 */
export function defaultRuntimeEntry(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return path.join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-mnemon-source-runtime', 'lib', 'index.js');
}

/** 条目是否该出现在长期层（已归档 / 被替代 / 已过期 / untrusted 一律不下沉）。 */
function isPortable(entry, nowMs) {
  if (!entry || entry.trust === 'untrusted') return false;
  if (entry.deletedAt || entry.supersededBy) return false;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) return false;
  if (entry.validTo && Date.parse(entry.validTo) <= nowMs) return false;
  return Boolean(entry.text);
}

/**
 * 期望集合 → mnemon 正文映射。
 * mnemon 去重键是 (target, content)，且 remove 要求 oldText 唯一命中，
 * 所以正文重复时按 id 排序给后来者加后缀，保证「一条记忆一个唯一正文」且两次结果一致。
 */
export function planMnemonContents(entries, nowMs = Date.now()) {
  const sorted = [...entries].filter((e) => isPortable(e, nowMs)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map();
  const plan = new Map();
  for (const entry of sorted) {
    const base = normalizeContent(entry.text);
    if (!base) continue;
    const seen = (used.get(base) || 0) + 1;
    used.set(base, seen);
    plan.set(entry.id, seen === 1 ? base : `${base}（记忆 ${String(entry.id).slice(-4)}）`);
  }
  return plan;
}

/**
 * 创建 mnemon 后端。
 * @param {{
 *   dir: string,                    // sidecar 目录
 *   dataDir?: string,               // mnemon 数据根，默认 ~/.mnemon
 *   memoryLimitBytes?: number,
 *   namespace?: string,
 *   runtimeEntry?: string,          // 可覆盖（测试注入 fake 实现）
 *   instanceKey?: string,
 *   log?: (...args:any[]) => void
 * }} options
 */
export async function createMnemonBackend(options = {}) {
  const dir = options.dir;
  if (!dir || typeof dir !== 'string') throw new Error('createMnemonBackend 需要 dir（sidecar 目录）');
  const dataDir = options.dataDir || path.join(os.homedir(), '.mnemon');
  const namespace = options.namespace || MNEMON_NAMESPACE;
  const runtimeEntry = options.runtimeEntry || defaultRuntimeEntry();
  const instanceKey = options.instanceKey || 'qq-bridge-gen3';
  const log = typeof options.log === 'function' ? options.log : () => { };
  const limitRaw = Number(options.memoryLimitBytes);
  const memoryLimitBytes = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(MAX_MNEMON_LIMIT_BYTES, Math.max(1024, Math.round(limitRaw)))
    : DEFAULT_MNEMON_LIMIT_BYTES;

  const sidecarFile = path.join(dir, 'memory-sidecar.json');
  const cache = new Map(); // scope -> entries（内存真相，load 只读它）
  let inst = null;
  let available = false;
  let unavailableReason = '';
  let lastSyncAt = 0;
  let lastSyncError = '';
  let lastSyncReport = null;
  let closing = false;

  // ---- sidecar 读写（同步、原子）----

  function loadSidecar() {
    let raw;
    try {
      raw = fs.readFileSync(sidecarFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error(`记忆 sidecar 读取失败：${sidecarFile}（${error.message}）`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 坏文件不阻塞启动：改名留档，从空开始（数据可人工找回，不静默丢）
      const broken = `${sidecarFile}.broken-${Date.now()}`;
      try { fs.renameSync(sidecarFile, broken); } catch { }
      log(`记忆 sidecar 无法解析，已改名留档：${broken}`);
      return;
    }
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (!SCOPES.includes(entry?.scope)) continue;
      if (!cache.has(entry.scope)) cache.set(entry.scope, []);
      cache.get(entry.scope).push(entry);
    }
  }

  function writeSidecar() {
    const entries = [];
    for (const scope of SCOPES) entries.push(...(cache.get(scope) || []));
    atomicWriteJson(sidecarFile, {
      schemaVersion: 1,
      namespace,
      updatedAt: new Date().toISOString(),
      entries,
    });
  }

  // ---- mnemon 串行同步队列 ----

  let chain = Promise.resolve();
  let dirty = false;
  let pendingPromise = null;
  let pendingTotals = null; // 本轮队列的累计结果（多次 pass 合并，syncNow 用它给确定性报告）

  function enqueueSync() {
    if (!available || closing) return;
    dirty = true;
    if (pendingPromise) return;
    pendingTotals = { namespace, desired: 0, added: 0, removed: 0, failures: [], limitBytes: memoryLimitBytes };
    pendingPromise = chain.then(async () => {
      // 合并窗口内的多次 save：跑完一遍若期间又脏了，再补一遍
      while (dirty && available && !closing) {
        dirty = false;
        try {
          lastSyncReport = await syncAll();
          lastSyncAt = Date.now();
          lastSyncError = '';
          pendingTotals.desired = lastSyncReport.desired;
          pendingTotals.added += lastSyncReport.added;
          pendingTotals.removed += lastSyncReport.removed;
          if (lastSyncReport.failures?.length) pendingTotals.failures.push(...lastSyncReport.failures);
        } catch (error) {
          lastSyncError = error?.message ?? String(error);
          log('mnemon 记忆同步失败（仅告警，sidecar 已落盘）:', lastSyncError);
        }
      }
    }).finally(() => {
      pendingPromise = null;
    });
  }

  async function syncAll() {
    const nowMs = Date.now();
    const all = [];
    for (const scope of SCOPES) for (const entry of cache.get(scope) || []) all.push(entry);
    const plan = planMnemonContents(all, nowMs);
    const wantTexts = new Set([...plan.values()].map(normalizeContent));

    const snap = await inst.manage({ mode: 'read', operation: 'snapshot', input: null });
    const existing = (snap?.value?.entries ?? []).filter((e) => e
      && e.target === 'memory'
      && Array.isArray(e.branches)
      && e.branches.includes(namespace));
    const existingTexts = new Set(existing.map((e) => normalizeContent(e.content)));

    let added = 0;
    let removed = 0;
    const failures = [];
    for (const content of plan.values()) {
      if (existingTexts.has(normalizeContent(content))) continue;
      try {
        await inst.manage({
          mode: 'write', operation: 'mutate', confirmed: true,
          input: { action: 'add', target: 'memory', content, importance: 'low', branches: [namespace] },
        });
        added += 1;
      } catch (error) {
        failures.push(`add「${content.slice(0, 24)}」: ${error?.message ?? error}`);
      }
    }
    for (const entry of existing) {
      const text = normalizeContent(entry.content);
      if (wantTexts.has(text)) continue;
      try {
        await inst.manage({
          mode: 'write', operation: 'mutate', confirmed: true,
          input: { action: 'remove', target: 'memory', oldText: text },
        });
        removed += 1;
      } catch (error) {
        // oldText 命中多条（被非 v3 内容撞上）时不强删，留待人工处理
        failures.push(`remove「${text.slice(0, 24)}」: ${error?.message ?? error}`);
      }
    }
    return { namespace, desired: plan.size, added, removed, failures, limitBytes: memoryLimitBytes };
  }

  // ---- 初始化 ----

  try {
    loadSidecar();
  } catch (error) {
    log('mnemon 记忆 sidecar 加载失败，按空库启动:', error?.message ?? error);
  }

  if (!fs.existsSync(runtimeEntry)) {
    unavailableReason = `找不到 dsh-mnemon 编程接口：${runtimeEntry}`;
  } else {
    try {
      const mod = await import(pathToFileURL(runtimeEntry).href);
      if (typeof mod.createRuntimeMemorySource !== 'function') {
        throw new Error('dsh-mnemon-source-runtime 未导出 createRuntimeMemorySource');
      }
      const source = mod.createRuntimeMemorySource({ dataDir, memoryLimitBytes });
      inst = source.create({ configuration: {}, sourceInstanceKey: instanceKey });
      if (!inst || typeof inst.manage !== 'function') throw new Error('mnemon source.create() 未返回可用实例');
      available = true;
    } catch (error) {
      unavailableReason = `dsh-mnemon 编程接口加载失败：${error?.message ?? error}`;
    }
  }
  if (!available) log(`mnemon 长期记忆不可用（${unavailableReason}）；sidecar 仍可独立工作`);

  const backend = {
    scopes: () => [...SCOPES],

    load(scope) {
      return clone(cache.get(scope) || []);
    },

    save(scope, entries) {
      if (!SCOPES.includes(scope)) throw new Error(`未知记忆作用域：${scope}`);
      cache.set(scope, clone(Array.isArray(entries) ? entries : []));
      writeSidecar();
      enqueueSync();
    },

    /** 观测：当前后端状态（控制台/验收用）。 */
    status() {
      const counts = {};
      let total = 0;
      for (const scope of SCOPES) {
        const n = (cache.get(scope) || []).length;
        counts[scope] = n;
        total += n;
      }
      return {
        backend: 'mnemon+sidecar',
        available,
        unavailableReason,
        namespace,
        dataDir,
        sidecarFile,
        limitBytes: memoryLimitBytes,
        total,
        byScope: counts,
        lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
        lastSyncError: lastSyncError || null,
        lastSyncReport,
        pending: Boolean(pendingPromise),
      };
    },

    /** 等队列排空（测试/验收用；聊天链路不等它）。 */
    async syncNow() {
      if (!available) return { skipped: true, reason: unavailableReason };
      dirty = true;
      enqueueSync();
      if (pendingPromise) await pendingPromise;
      return pendingTotals ?? lastSyncReport ?? { skipped: true, reason: 'no-change' };
    },

    /** 整体回滚：清空 mnemon 里的 v3 分区（sidecar 保留，便于人工审计）。 */
    async purge() {
      if (!available) return { skipped: true, reason: unavailableReason };
      const snap = await inst.manage({ mode: 'read', operation: 'snapshot', input: null });
      const targets = (snap?.value?.entries ?? []).filter((e) => e
        && e.target === 'memory'
        && Array.isArray(e.branches)
        && e.branches.includes(namespace));
      let removed = 0;
      const failures = [];
      for (const entry of targets) {
        try {
          await inst.manage({
            mode: 'write', operation: 'mutate', confirmed: true,
            input: { action: 'remove', target: 'memory', oldText: normalizeContent(entry.content) },
          });
          removed += 1;
        } catch (error) {
          failures.push(`${normalizeContent(entry.content).slice(0, 24)}: ${error?.message ?? error}`);
        }
      }
      return { namespace, removed, failures };
    },

    close() {
      closing = true;
    },
  };

  return backend;
}
