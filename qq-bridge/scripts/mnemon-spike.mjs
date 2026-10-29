#!/usr/bin/env node
/**
 * scripts/mnemon-spike.mjs —— GEN3_SIMULATION_PLAN.md P0.5「mnemon 写入 spike」决策脚本
 *
 * 回答一个问题：**桥接侧（非模型轮次）能不能可靠地批量写入 dsh-mnemon 长期记忆？**
 * 结果用于在方案 A（长期记忆写 mnemon）与方案 B（桥接自建 JSON/SQLite 存储）之间二选一。
 *
 * 测试七项（对应计划 2.4 / P0.5 行）：
 *   1. 批量写入   —— 连写 5 条（串行 + 并发）是否都成功、有无速率限流/容量限制
 *   2. 重复写入   —— 同 content 写两次会怎样：去重还是重复
 *   3. 权限边界   —— 非 owner 来源能不能写？有没有 trust/来源字段？
 *   4. 读回       —— 写入后能否查到（mnemon_recall 或读存储/投影）
 *   5. 元数据能力 —— 能不能存 source/scope/trust 之类的自定义元数据
 *   6. namespace 隔离 —— 能不能按 namespace=v3 分区、读取时过滤
 *   7. 回滚过滤   —— 能不能批量隐藏/删除 namespace=v3 的记忆
 *
 * 测试策略（按优先级降级，全部不可行的项输出 UNVERIFIED 并说明原因）：
 *   A. 编程接口：直接 import DSH 桌面安装里的 `dsh-mnemon-source-runtime`
 *      （`mnemon_runtime_memory` 工具背后的同一个 controller），在沙箱 dataDir
 *      里跑全套测试，再对真实存储 `~/.mnemon` 做最小写入+强制清理的读回实测。
 *      这就是「桥接侧非模型轮次批量写入」的实证路径。
 *   B. 存储层等价：编程接口不可用时降级为直接读写 `runtime/memories.json`。
 *   C. DSH HTTP API：DSH 在跑时探测鉴权边界与是否存在非模型轮次的工具调用端点。
 *
 * 用法：
 *   node scripts/mnemon-spike.mjs                 # 完整测试（含真实存储最小写入，测完即删）
 *   node scripts/mnemon-spike.mjs --sandbox-only  # 只跑沙箱，不碰 ~/.mnemon 真实存储与 HTTP
 *
 * 安全约束：
 *   - 不向真实 QQ 发消息，不调用 session/prompt（mnemon 工具只在模型轮次可调，
 *     这个 spike 的目的恰恰是绕开模型轮次，故全程零模型调用）。
 *   - 沙箱数据测完删除；真实存储只写带唯一标记的测试条目，finally 里强制清理，
 *     结束时输出脏数据清单（正常情况下为空）。
 *   - 只读引用 src/dsh-client.js 与 dsh-mnemon 安装包，不修改任何现有文件。
 *
 * 退出码：
 *   0 = 硬前提三项（批量写入 / namespace 隔离 / 回滚过滤）全部 PASS
 *   1 = 硬前提中有 FAIL（按计划 2.4 应选方案 B）
 *   3 = 硬前提中有 UNVERIFIED 且无 FAIL（信息不足，需人工补测）
 *   2 = 脚本/环境错误（如找不到 mnemon 实现）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================ 0. 基础工具 ============================

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = new Set(process.argv.slice(2));
const SANDBOX_ONLY = ARGS.has('--sandbox-only');
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const out = (line = '') => console.log(line);
function section(title) {
  out();
  out(`======== ${title} ========`);
}

/** 结果收集：每项 {id, title, status, evidence[], note}。 */
const RESULTS = [];
function verdict(id, title, status, evidence, note = '') {
  RESULTS.push({ id, title, status, evidence, note });
  out(`[${status}] ${id} ${title}`);
  for (const e of evidence) out(`       · ${e}`);
  if (note) out(`       ⤷ ${note}`);
}

/** 稳定化 content（与 dsh-mnemon-source-runtime 一致：去首尾空白 + 连续空白压成单空格）。 */
const normalizeContent = (s) => s.trim().replace(/\s+/gu, ' ');

// ============================ 1. 侦察（只读） ============================

const PROFILE_NODE_MODULES = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules');
const RUNTIME_SOURCE_ENTRY = process.env.DSH_MNEMON_RUNTIME_SOURCE
  || path.join(PROFILE_NODE_MODULES, 'dsh-mnemon-source-runtime', 'lib', 'index.js');
const REAL_DATA_DIR = path.join(os.homedir(), '.mnemon'); // 实测：运行时记忆存储根（memories.json 的落盘位置）
const REAL_MEMORIES_JSON = path.join(REAL_DATA_DIR, 'runtime', 'memories.json');

section('侦察：dsh-mnemon 是什么');
{
  const probe = (p) => (fs.existsSync(p) ? '存在' : '缺失');
  let version = '?';
  try { version = JSON.parse(fs.readFileSync(path.join(PROFILE_NODE_MODULES, 'dsh-mnemon', 'package.json'), 'utf8')).version; } catch { /* 忽略 */ }
  out(`dsh-mnemon 安装位置 : ${path.join(PROFILE_NODE_MODULES, 'dsh-mnemon')}（版本 ${version}）`);
  out(`运行时记忆存储      : ${REAL_MEMORIES_JSON}（${probe(REAL_MEMORIES_JSON)}）`);
  out('                    纯 JSON 文件。schema: { version, entries[]{ content, created_at, updated_at,');
  out('                    target(memory|user), importance(critical|normal|low), 可选 branches[](≤16 个,');
  out('                    字符集 [A-Za-z0-9._/-]), 可选 origin{machine,label,at} } —— 这是 mnemon_runtime_memory 的落盘层');
  out(`项目档案（documents）: ${path.join(REAL_DATA_DIR, 'documents')}（${probe(path.join(REAL_DATA_DIR, 'documents'))}）— mnemon_document_search 检索的对象`);
  out(`记忆空间（spaces）  : ${path.join(REAL_DATA_DIR, 'data')}/<spaceId>/mnemon.db（SQLite）+ .dsh-memory-bodies.json 注册表`);
  out(`                    （${probe(path.join(REAL_DATA_DIR, 'data'))} / ${probe(path.join(REAL_DATA_DIR, '.dsh-memory-bodies.json'))}）— mnemon_recall / mnemon_remember 检索的对象`);
  const cliCandidates = [
    process.env.MNEMON_CLI_PATH,
    path.join(os.homedir(), 'go', 'bin', 'mnemon.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mnemon', 'mnemon.exe'),
    path.join(process.env.ProgramFiles || '', 'mnemon', 'mnemon.exe'),
  ].filter(Boolean);
  const cliFound = cliCandidates.filter((p) => fs.existsSync(p));
  out(`mnemon CLI         : ${cliFound.length ? cliFound.join(', ') : '未安装 —— 记忆空间层（mnemon_recall/remember 的后端）当前不可用'}`);
  out(`编程接口            : ${fs.existsSync(RUNTIME_SOURCE_ENTRY) ? 'dsh-mnemon-source-runtime 导出 createRuntimeMemorySource()（manage() = mnemon_runtime_memory 同一 controller）' : '未找到'}`);
  out('工具注册方式        : 不是 MCP server。dsh-mnemon 是 DSH 插件（cordis），向宿主注册「memory tools」');
  out('                    （mnemon_runtime_memory / mnemon_recall / mnemon_document_search / mnemon_remember …），');
  out('                    仅在模型轮次暴露给模型。桥接要直写只能走编程接口或存储层（本 spike 实测两者）。');
}

// ============================ 2. 加载编程接口（或降级存储层） ============================

section('加载编程接口');
let runtimeModule = null;
try {
  if (!fs.existsSync(RUNTIME_SOURCE_ENTRY)) throw new Error(`找不到 ${RUNTIME_SOURCE_ENTRY}`);
  runtimeModule = await import(pathToFileURL(RUNTIME_SOURCE_ENTRY).href);
  out(`✅ 已加载编程接口：${RUNTIME_SOURCE_ENTRY}`);
  out(`   导出: ${Object.keys(runtimeModule).join(', ')}`);
} catch (e) {
  out(`❌ 编程接口不可用（${e.message}），降级为存储层等价测试（直接读写 memories.json）`);
}

/**
 * 测试用存储抽象：
 *   official —— 走 dsh-mnemon-source-runtime 的 manage()/project()（与 mnemon_runtime_memory 工具同一条代码路径）
 *   raw-json —— 直接读写 runtime/memories.json 的存储层等价实现（仅当编程接口不可用时使用）
 */
function createOfficialStore(dataDir) {
  const source = runtimeModule.createRuntimeMemorySource({ dataDir });
  const inst = source.create({ configuration: {}, sourceInstanceKey: `qq-bridge-mnemon-spike-${RUN_ID}` });
  return {
    kind: 'official',
    inst,
    async add({ content, target = 'memory', importance = 'normal', branches }) {
      const input = { action: 'add', target, content, importance };
      if (branches?.length) input.branches = branches;
      const r = await inst.manage({ mode: 'write', operation: 'mutate', confirmed: true, input });
      return r.value;
    },
    async remove({ oldText, target = 'memory' }) {
      const r = await inst.manage({ mode: 'write', operation: 'mutate', confirmed: true, input: { action: 'remove', target, oldText } });
      return r.value;
    },
    async snapshot() {
      const r = await inst.manage({ mode: 'read', operation: 'snapshot', input: null });
      return { revision: r.revision, entries: r.value.entries ?? [], targets: r.value.targets ?? {} };
    },
    /**
     * namespace 读取过滤的「模型视角」实测：借 project() 让 controller 用 git 分支做过滤
     * （语义：带 branches 的条目只在分支匹配的视图里可见，无 branches 的条目对所有视图可见）。
     * 返回 { visible, hidden, text }；git/投影不可用时返回 { unavailable: 原因 }。
     * git 探测仓库建在沙箱里（不污染真实存储），由调用方负责整体清理。
     */
    async branchView(branch, revision, gitProbeRoot) {
      const gitDir = path.join(gitProbeRoot, branch);
      try {
        fs.mkdirSync(gitDir, { recursive: true });
        if (!fs.existsSync(path.join(gitDir, '.git'))) {
          execFileSync('git', ['init', gitDir], { stdio: 'ignore', windowsHide: true });
          execFileSync('git', ['-C', gitDir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`], { stdio: 'ignore', windowsHide: true });
        }
      } catch (e) {
        return { unavailable: `git 不可用: ${e.message}` };
      }
      try {
        const r = await inst.project({
          includeProjection: true,
          scope: { workspaceId: gitDir },
          expectedRevision: revision,
          mode: 'compact',
          maxCharacters: 60000,
        });
        const text = r.fragments?.[0]?.text ?? '';
        const hidden = Number(/\((\d+) branch-scoped entr/.exec(text)?.[1] ?? 0);
        return { visible: r.presentation?.visibleItems ?? 0, hidden, text };
      } catch (e) {
        return { unavailable: `投影调用失败: ${e.message}` };
      }
    },
  };
}

function createRawStore(dataDir) {
  const file = path.join(dataDir, 'runtime', 'memories.json');
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: 1, entries: [] }; }
  };
  const write = (obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    fs.renameSync(tmp, file);
  };
  return {
    kind: 'raw-json',
    async add({ content, target = 'memory', importance = 'normal', branches }) {
      const obj = read();
      const norm = normalizeContent(content);
      if (obj.entries.some((e) => e.target === target && e.content === norm)) {
        return { success: true, message: 'Entry already exists (no duplicate added).' };
      }
      const now = new Date().toISOString();
      obj.entries.push({ content: norm, created_at: now, updated_at: now, target, importance, ...(branches?.length ? { branches } : {}) });
      write(obj);
      return { success: true, message: 'Entry added.' };
    },
    async remove({ oldText, target = 'memory' }) {
      const obj = read();
      const hits = obj.entries.map((e, i) => (e.target === target && e.content.includes(oldText) ? i : -1)).filter((i) => i >= 0);
      const exact = hits.filter((i) => obj.entries[i].content === oldText);
      const idx = exact[0] ?? (hits.length === 1 ? hits[0] : undefined);
      if (idx === undefined) return { success: false, message: hits.length === 0 ? 'No entry matches.' : 'Multiple entries match; use a unique substring.' };
      const [removed] = obj.entries.splice(idx, 1);
      write(obj);
      return { success: true, message: 'Entry removed.', removed: removed.content };
    },
    async snapshot() {
      const obj = read();
      return { revision: 'raw', entries: obj.entries, targets: {} };
    },
    async branchView(branch) {
      const { entries } = await this.snapshot();
      const visible = entries.filter((e) => e.target === 'user' || !e.branches?.length || e.branches.includes(branch));
      return { visible: visible.length, hidden: entries.length - visible.length, text: visible.map((e) => e.content).join('\n') };
    },
  };
}

// ============================ 3. 七项测试（沙箱） ============================

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mnemon-spike-'));
const GIT_PROBE_ROOT = path.join(sandbox, 'git-probe'); // project() 过滤实测用的临时 git 仓库根
out(`\n沙箱 dataDir: ${sandbox}`);

const official = runtimeModule ? createOfficialStore(sandbox) : null;
const store = official ?? createRawStore(sandbox);
out(`测试通道: ${store.kind === 'official' ? '编程接口（与 mnemon_runtime_memory 工具同一 controller）' : '存储层等价（直接读写 memories.json）'}`);

const cleanupLog = []; // 真实存储脏数据记录（正常为空）

try {
  // ---------- 1. 批量写入 ----------
  section('测试 1/7：批量写入（连写 5 条，串行 + 5 条并发）');
  {
    const evidence = [];
    let okCount = 0;
    const t0 = Date.now();
    for (let i = 1; i <= 5; i++) {
      const r = await store.add({ content: `【spike-${RUN_ID}】串行批量条目 ${i}`, target: 'memory', importance: 'low' });
      if (r.success) okCount++;
      else evidence.push(`串行第 ${i} 条失败: ${r.message}`);
    }
    const seqMs = Date.now() - t0;
    const t1 = Date.now();
    const parallel = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      store.add({ content: `【spike-${RUN_ID}】并发批量条目 ${i + 1}`, target: 'memory', importance: 'low' })
        .then((r) => r.success).catch(() => false)));
    const parMs = Date.now() - t1;
    okCount += parallel.filter(Boolean).length;
    const snap = await store.snapshot();
    const landed = snap.entries.filter((e) => e.content.includes(`spike-${RUN_ID}`)).length;
    evidence.push(`串行 5 条用时 ${seqMs}ms、并发 5 条用时 ${parMs}ms，成功 ${okCount}/10，落盘 ${landed} 条 —— 无速率限流（controller 内部队列化提交，无 429/退避）`);
    if (official) {
      // 容量上限探测（唯一的「限制」是字节容量，不是速率）：把 memory 上限压到 300 字节连写大条目
      const capSource = runtimeModule.createRuntimeMemorySource({ dataDir: path.join(sandbox, 'cap'), memoryLimitBytes: 300 });
      const capInst = capSource.create({ configuration: {}, sourceInstanceKey: `cap-${RUN_ID}` });
      let capError = '';
      try {
        for (let i = 0; i < 10; i++) {
          await capInst.manage({ mode: 'write', operation: 'mutate', confirmed: true, input: { action: 'add', target: 'memory', content: `容量探测条目 ${i} ${'x'.repeat(120)}`, importance: 'low' } });
        }
      } catch (e) {
        capError = e.message;
      }
      evidence.push(capError
        ? `容量上限（非速率限流）：${capError.slice(0, 130)}…；默认上限 memory 10240 字节 / user 4096 字节，可配到最大 1MB，单条 ≤8192 字节`
        : '⚠ 容量探测 10 条未触发上限（预期应触发）');
    } else {
      evidence.push('存储层等价模式下容量限制以代码常量为准：memory 10240 字节 / user 4096 字节，单条 ≤8192 字节（RUNTIME_MEMORY_LIMITS）');
    }
    verdict('1', '批量写入', landed === 10 ? 'PASS' : 'FAIL', evidence,
      '注意字节容量：GEN3 批量写摘要前要么配大 memoryLimitBytes（≤1MB），要么自己做压缩归档（compact-and-mutate）。');
  }

  // ---------- 2. 重复写入 ----------
  section('测试 2/7：重复写入（同 content 写两次）');
  {
    const evidence = [];
    const content = `【spike-${RUN_ID}】重复写入探测条目`;
    const r1 = await store.add({ content, target: 'memory', importance: 'low' });
    const r2 = await store.add({ content, target: 'memory', importance: 'low' });
    const r3 = await store.add({ content: `  ${content}  `, target: 'memory', importance: 'critical' }); // 空白变体 + 不同重要度
    const r4 = await store.add({ content, target: 'user', importance: 'low' }); // 同文不同 target
    const snap = await store.snapshot();
    const sameMemory = snap.entries.filter((e) => e.target === 'memory' && normalizeContent(e.content) === normalizeContent(content));
    const sameUser = snap.entries.filter((e) => e.target === 'user' && normalizeContent(e.content) === normalizeContent(content));
    evidence.push(`首次写入: "${r1.message}"`);
    evidence.push(`原样重写: "${r2.message}"`);
    evidence.push(`空白变体 + 不同 importance 重写: "${r3.message}"（${r3.message.includes('already exists') ? '空白归一化后仍去重；importance 不参与去重判定' : '重复入库'}）`);
    evidence.push(`同文写到 target=user: "${r4.message}" —— 去重按 (target, content) 二元组，跨 target 不去重`);
    evidence.push(`库里同文条目数: target=memory ${sameMemory.length} 条、target=user ${sameUser.length} 条`);
    const dedupOk = r1.message && r2.message.includes('already exists') && r3.message.includes('already exists') && sameMemory.length === 1;
    verdict('2', '重复写入', dedupOk ? 'PASS' : 'FAIL', evidence,
      '结论：精确去重（content 空白归一化后全等才去重，键是 target+content）。近似/语义去重要桥接侧自己做。');
  }

  // ---------- 5. 元数据能力（先测，namespace 测试要复用其结论） ----------
  section('测试 5/7：元数据能力（source/scope/trust 能不能存）');
  {
    const evidence = [];
    let status;
    if (official) {
      // (a) 走工具同款 mutate 入口，夹带 source/scope/trust/namespace 字段，看是否被接受/保留
      const token = `【spike-${RUN_ID}】元数据夹带条目`;
      let addError = '';
      try {
        await official.inst.manage({
          mode: 'write', operation: 'mutate', confirmed: true,
          input: {
            action: 'add', target: 'memory', content: token, importance: 'low',
            source: 'qq-bridge', scope: 'group:12345', trust: 'high', namespace: 'v3', // 故意夹带自定义元数据
          },
        });
      } catch (e) {
        addError = e.message;
      }
      let snap = await store.snapshot();
      let entry = snap.entries.find((e) => e.content.includes(token));
      evidence.push(addError
        ? `(a) mutate 入口夹带 source/scope/trust/namespace：写入被拒（${addError.slice(0, 100)}）`
        : `(a) mutate 入口夹带 source/scope/trust/namespace：写入未报错但字段被静默丢弃，落盘字段仅 {${entry ? Object.keys(entry).sort().join(',') : '?'}}`);
      // (b) 存储层直接塞自定义字段 + origin/branches，观察官方读取路径保留谁
      const file = path.join(sandbox, 'runtime', 'memories.json');
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      const now = new Date().toISOString();
      obj.entries.push({
        content: `【spike-${RUN_ID}】存储层夹带条目`, created_at: now, updated_at: now,
        target: 'memory', importance: 'low',
        source: 'qq-bridge', scope: 'group:12345', trust: 'high', namespace: 'v3', // 自定义字段
        origin: { machine: 'bridge-host', label: 'qq-bridge/gen3', at: now },       // 官方 origin 结构
        branches: ['meta-probe'],                                                     // 官方 branches 字段
      });
      fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
      snap = await store.snapshot();
      entry = snap.entries.find((e) => e.content.includes('存储层夹带条目'));
      evidence.push(`(b) 存储层塞入自定义字段后经官方读取路径回读：存活字段 {${entry ? Object.keys(entry).sort().join(',') : '?'}}`);
      // (c) 关键一步：让 controller 做任意一次正常写入（整文件重写），再看自定义字段在盘上还剩什么
      await store.add({ content: `【spike-${RUN_ID}】触发 controller 重写的探针条目`, target: 'memory', importance: 'low' });
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      const smuggledDisk = onDisk.entries.find((e) => e.content.includes('存储层夹带条目'));
      const diskKeys = smuggledDisk ? Object.keys(smuggledDisk).sort().join(',') : '(未找到)';
      evidence.push(`(c) controller 任意一次写入会整文件重写，重写后盘上残留字段 {${diskKeys}} —— 自定义字段是易失的`);
      const customSurvives = !!(entry && entry.source && entry.trust && entry.scope);
      status = customSurvives ? 'PASS' : 'FAIL';
      evidence.push(`结论：schema 白名单仅 content/created_at/updated_at/target/importance/branches/origin；origin 只有 {machine,label,at} 三个字符串且 mutate 入口不支持写 origin（只能存储层写）`);
      evidence.push('旁路可行（计划 2.4 允许）：桥接自存 sidecar（memoryId/sourceMessageIds/scope/trust/namespace），或把来源拼进 origin.label / content 前缀');
    } else {
      evidence.push('编程接口不可用：无法实测官方读取路径的字段白名单与易失性（存储层等价实现不做剥离模拟）');
      evidence.push('代码层证据（dsh-mnemon-source-runtime parseEntry 白名单）：content/created_at/updated_at/target/importance/branches/origin');
      status = 'UNVERIFIED';
    }
    verdict('5', '元数据能力', status, evidence,
      'mnemon 原生没有 source/scope/trust 概念 → 2.4 条件 2 只能满足「旁路保存」那一半（sidecar 由桥接自存）。');
  }

  // ---------- 6. namespace 隔离 ----------
  section('测试 6/7：namespace 隔离（namespace=v3 分区 + 读取过滤）');
  {
    const evidence = [];
    const v3Token = `【spike-${RUN_ID}】namespace-v3 专属条目`;
    const plainToken = `【spike-${RUN_ID}】无命名空间条目`;
    await store.add({ content: v3Token, target: 'memory', importance: 'low', branches: ['v3'] });
    await store.add({ content: plainToken, target: 'memory', importance: 'low' });
    const snap = await store.snapshot();
    const byNs = snap.entries.filter((e) => e.branches?.includes('v3') && e.content.includes(RUN_ID));
    evidence.push(`存储层分区：branches:["v3"] 标记的测试条目 ${byNs.length} 条，可按 branches 字段精确过滤`);
    const v3View = await store.branchView('v3', snap.revision, GIT_PROBE_ROOT);
    const mainView = await store.branchView('main', snap.revision, GIT_PROBE_ROOT);
    if (!v3View.unavailable && !mainView.unavailable) {
      const v3Seen = v3View.text.includes(v3Token);
      const v3SeenInMain = mainView.text.includes(v3Token);
      const plainInMain = mainView.text.includes(plainToken);
      const plainInV3 = v3View.text.includes(plainToken);
      evidence.push(`读取过滤（controller 投影实测）：branch=v3 视图含 v3 条目=${v3Seen}、含无标记条目=${plainInV3}`);
      evidence.push(`branch=main 视图含 v3 条目=${v3SeenInMain}（应为 false）、含无标记条目=${plainInMain}、本次隐藏 ${mainView.hidden} 条`);
      evidence.push('语义借 git 分支过滤：带 branches 的条目按分支匹配过滤，未标记条目对所有视图可见（全量可见=泄漏面）');
      verdict('6', 'namespace 隔离', v3Seen && !v3SeenInMain ? 'PASS' : 'FAIL', evidence,
        'PASS 带条件：namespace=v3 用 branches:["v3"] 承载即可分区+读取过滤；但 target=user 条目不过滤、未标记条目全可见，桥接写入必须每条都带 namespace 标记。独立命名空间还有 memory-spaces 命名 store（<spaceId>/mnemon.db，天然隔离），但需要 mnemon CLI（本机未安装）。');
    } else {
      evidence.push(`投影级过滤未实测（${v3View.unavailable ?? mainView.unavailable}）；存储层按 branches 过滤已验证可用`);
      verdict('6', 'namespace 隔离', byNs.length === 1 ? 'PASS' : 'FAIL', evidence,
        '投影级（模型视角）过滤未实测，但存储层分区/过滤可用，桥接读取时自行过滤即可。');
    }
  }

  // ---------- 7. 回滚过滤 ----------
  section('测试 7/7：回滚过滤（批量隐藏/删除 namespace=v3 的记忆）');
  {
    const evidence = [];
    const snap = await store.snapshot();
    const v3Entries = snap.entries.filter((e) => e.branches?.includes('v3') && e.content.includes(RUN_ID));
    // (a) 批量隐藏：读取时过滤（投影/存储层），不动数据
    const mainView = await store.branchView('main', snap.revision, GIT_PROBE_ROOT);
    if (!mainView.unavailable) {
      const leaked = v3Entries.filter((e) => mainView.text.includes(e.content.slice(0, 24)));
      evidence.push(`(a) 批量隐藏：branch=main 读取视图一次隐藏 ${mainView.hidden} 条 branch-scoped 条目，v3 测试条目泄漏 ${leaked.length} 条`);
    } else {
      evidence.push(`(a) 批量隐藏：存储层按 branches 过滤即隐藏视图（投影级未实测：${mainView.unavailable}）`);
    }
    // (b) 批量删除：官方入口逐条 remove（无批量删除 API），oldText 用唯一全文
    let removed = 0;
    for (const e of v3Entries) {
      const r = await store.remove({ oldText: normalizeContent(e.content), target: 'memory' });
      if (r.success) removed++;
    }
    const after = await store.snapshot();
    const left = after.entries.filter((e) => e.branches?.includes('v3') && e.content.includes(RUN_ID));
    evidence.push(`(b) 批量删除：官方入口无批量 API，逐条 remove 共 ${removed}/${v3Entries.length} 条成功，剩余 v3 测试条目 ${left.length} 条`);
    evidence.push('补充：存储层可一次性重写 memories.json 过滤掉目标条目（等价批量删除），但绕过 controller 的锁/修订协议，DSH 在跑时有并发覆写风险，不建议在真实存储上用');
    verdict('7', '回滚过滤', left.length === 0 ? 'PASS' : 'FAIL', evidence,
      'PASS：隐藏=读取过滤（即时、零破坏、可恢复）；删除=逐条 remove（oldText 需唯一命中）或存储层批量过滤。');
  }

  // ---------- 4. 读回 ----------
  section('测试 4/7：读回（写入后能不能查到）');
  {
    const evidence = [];
    const snap = await store.snapshot();
    const mine = snap.entries.filter((e) => e.content.includes(`spike-${RUN_ID}`));
    evidence.push(`存储回读：snapshot 命中本 spike 写入的条目 ${mine.length} 条`);
    let projOk = null;
    const view = await store.branchView('v3', snap.revision, GIT_PROBE_ROOT);
    if (!view.unavailable) {
      projOk = view.text.includes(`spike-${RUN_ID}`);
      evidence.push(`投影回读（模型上下文视图 MNEMON RUNTIME MEMORY SNAPSHOT）：${projOk ? '能看到写入条目（写入即对模型可见）' : '看不到'}`);
    } else {
      evidence.push(`投影回读未实测（${view.unavailable}）`);
    }
    evidence.push('mnemon_recall 路径 UNVERIFIED：它是模型轮次内才能调的工具（无 HTTP/CLI 直调口，见 C 组探测），且检索的是「记忆空间」（mnemon.db）而不是 runtime 记忆本 —— runtime 条目不进 recall 索引，读回只能走 snapshot/投影');
    const ok = mine.length > 0 && projOk !== false;
    verdict('4', '读回', ok ? 'PASS' : 'FAIL', evidence,
      '读回通道：编程接口 snapshot() / 投影文本 / 直接读 memories.json 均可；mnemon_recall 与 runtime 记忆本无关。');
  }

  // ---------- 3. 权限边界 ----------
  section('测试 3/7：权限边界（非 owner 来源能不能写？有没有 trust/来源字段？）');
  {
    const evidence = [
      '存储层：memories.json 无 owner/trust/source 字段、无写入身份校验 —— 任何本机进程（含桥接）都能写，也无法记录「谁写的」',
      '工具入口：mnemon_runtime_memory 的 input schema 只有 action/target/content/oldText/importance/branches（additionalProperties:false）—— 无 trust 参数可传',
      '宿主层：DSH HTTP API 有会话 Cookie 鉴权（C 组实测传输边界），但那是传输层防护；拿到会话的调用方写记忆不设防',
      '提示词层：条目内容注入时被标注为 untrusted data（防提示注入），防内容不防写入',
    ];
    verdict('3', '权限边界', 'FAIL', evidence,
      'FAIL 指「没有 trust/owner 能力」：无法按来源授权或标记信任。方案 A 若上马，trust/scope 必须走桥接 sidecar（2.4 的「旁路保存」）。');
  }

  // ============================ 4. 真实存储最小实测 ============================

  if (!SANDBOX_ONLY && official) {
    section('真实存储实测（~/.mnemon，最小写入 + 强制清理）');
    const realStore = createOfficialStore(REAL_DATA_DIR);
    const tag = `【mnemon-spike 自检 ${RUN_ID}】`;
    const content = `${tag}桥接侧非模型轮次写入实测条目，测完即删`;
    const baseline = await realStore.snapshot();
    const baselineContents = new Set(baseline.entries.map((e) => e.content));
    out(`基线条目数: ${baseline.entries.length}（memory 用量 ${baseline.targets?.memory?.used ?? '?'} / ${baseline.targets?.memory?.limit ?? '?'} 字节）`);
    try {
      const r1 = await realStore.add({ content, target: 'memory', importance: 'low' });
      out(`写入 -> ${r1.message}`);
      const r2 = await realStore.add({ content, target: 'memory', importance: 'low' });
      out(`重复写入 -> ${r2.message}（${r2.message.includes('already exists') ? '真实存储同样精确去重' : '⚠ 真实存储未去重'}）`);
      const snap = await realStore.snapshot();
      const found = snap.entries.filter((e) => e.content.includes(RUN_ID));
      out(`读回：snapshot 命中 ${found.length} 条`);
      const view = await realStore.branchView('v3', snap.revision, GIT_PROBE_ROOT);
      out(view.unavailable
        ? `投影读回未实测（${view.unavailable}）`
        : `投影读回（模型上下文视图）：${view.text.includes(tag) ? '✅ 能看到（桥接写入即对模型可见）' : '❌ 看不到'}`);
      out(`真实库 memory 用量: ${snap.targets?.memory?.used ?? '?'} / ${snap.targets?.memory?.limit ?? '?'} 字节`);
    } finally {
      // 强制清理：删掉本 spike 写入的一切
      const snap = await realStore.snapshot();
      for (const e of snap.entries.filter((x) => x.content.includes(RUN_ID))) {
        const r = await realStore.remove({ oldText: normalizeContent(e.content), target: e.target });
        out(`清理 -> ${r.message}${r.removed ? `: ${r.removed.slice(0, 40)}…` : ''}`);
      }
      const after = await realStore.snapshot();
      const leftover = after.entries.filter((e) => e.content.includes(RUN_ID) || e.content.includes(tag));
      const foreign = after.entries.filter((e) => !baselineContents.has(e.content) && !e.content.includes(RUN_ID));
      out(`清理后条目数: ${after.entries.length}（基线 ${baseline.entries.length}），残留测试条目 ${leftover.length} 条`);
      if (leftover.length) {
        out('⚠ 以下测试条目未能自动清理，请手工删除（oldText 见上）：');
        for (const e of leftover) out(`   - [${e.target}] ${e.content}`);
        cleanupLog.push(`真实存储残留测试条目 ${leftover.length} 条（含标记 ${tag}，见上）`);
      }
      if (foreign.length) {
        out(`ℹ 清理窗口期内出现 ${foreign.length} 条非本 spike 的新条目（可能是 DSH 正常写入），未触碰`);
      }
    }
  } else if (!SANDBOX_ONLY && !official) {
    out('\n（编程接口不可用，跳过真实存储实测：存储层直写真实 memories.json 有并发覆写风险，不冒这个险）');
  }

  // ============================ 5. DSH HTTP API 探测 ============================

  if (!SANDBOX_ONLY) {
    section('DSH HTTP API 探测（鉴权边界 / 有无非模型轮次工具调用端点）');
    let base = process.env.DSH_BASE_URL;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
      base = base || cfg?.dsh?.baseUrl;
    } catch { /* 配置读不到就用环境变量 */ }
    if (!base) {
      out('未配置 dsh.baseUrl 且无 DSH_BASE_URL，跳过 HTTP 探测');
    } else {
      out(`DSH baseUrl: ${base}`);
      const rpcCall = async (endpoint, args, cookie) => {
        try {
          const res = await fetch(`${base}/api/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
            body: JSON.stringify({ type: 'client-request', rpcId: `mnemon-spike-${Math.random().toString(36).slice(2, 8)}`, method: endpoint, payload: { args } }),
            signal: AbortSignal.timeout(5000),
          });
          const text = await res.text();
          let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 160); }
          return { status: res.status, body };
        } catch (e) {
          return { status: 0, body: `连接失败: ${e.message}` };
        }
      };
      const unauth = await rpcCall('agentPresets/list', {});
      out(`无凭据调用 agentPresets/list -> HTTP ${unauth.status} ${JSON.stringify(unauth.body).slice(0, 120)}`);
      let cookie = null;
      try {
        const client = await import(pathToFileURL(path.join(REPO_ROOT, 'src', 'dsh-client.js')).href);
        cookie = client.discoverDshSessionCookie(base);
      } catch (e) {
        out(`会话 Cookie 铸造失败（${e.message}）`);
      }
      let authOk = false;
      if (cookie) {
        const auth = await rpcCall('agentPresets/list', {}, cookie);
        authOk = auth.status === 200;
        out(`带会话 Cookie 调用 -> HTTP ${auth.status} ${JSON.stringify(auth.body).slice(0, 120)}`);
      }
      // 探测是否存在「非模型轮次直接调工具/写记忆」的 HTTP 端点
      const probes = ['tool/call', 'tools/call', 'mcp/call', 'memory/mutate', 'mnemon/mutate', 'runtime/mutate'];
      const probeResults = [];
      for (const ep of probes) {
        const r = await rpcCall(ep, {}, cookie ?? undefined);
        probeResults.push(`${ep}=${r.status}`);
      }
      out(`通用工具/记忆直调端点探测: ${probeResults.join(' | ')}`);
      const anyTool = probeResults.some((s) => /=200$/.test(s));
      out(anyTool
        ? '⚠ 存在疑似可用的直调端点（见上），需人工复核'
        : '结论：DSH HTTP API 只有 session/workspace/settings/agentPresets 等会话 RPC，mnemon 工具无直调端点 —— 桥接写记忆只能走编程接口（或让模型在轮次里调工具，那不是本 spike 要的）');
      out(`鉴权边界证据：无 Cookie ${unauth.status === 401 || unauth.status === 403 ? `被拒（HTTP ${unauth.status}）` : `返回 HTTP ${unauth.status}`}；带 Cookie ${authOk ? '可调用' : '未验证'}`);
    }
  }

  // ============================ 6. 汇总与退出码 ============================

  section('七项结果汇总');
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
    const r = RESULTS.find((x) => x.id === id);
    if (r) out(`  ${r.status.padEnd(11)} ${r.id}. ${r.title}`);
  }
  const HARD = ['1', '6', '7']; // 计划 2.4 硬前提：批量写入 / namespace 隔离 / 回滚过滤
  const hardResults = HARD.map((id) => RESULTS.find((x) => x.id === id)).filter(Boolean);
  const hardPass = hardResults.length === 3 && hardResults.every((r) => r.status === 'PASS');
  const hardFail = hardResults.some((r) => r.status === 'FAIL');
  out();
  out(`硬前提（批量写入 / namespace 隔离 / 回滚过滤）: ${hardPass ? '全部 PASS' : hardFail ? '有 FAIL' : '有 UNVERIFIED'}`);
  out(`A/B 建议: ${hardPass ? '方案 A（长期记忆写 mnemon + 桥接 sidecar 元数据）可行' : hardFail ? '方案 B（桥接自建 JSON/SQLite 存储）' : '信息不足，需补测'}`);

  if (cleanupLog.length) {
    section('脏数据清单');
    for (const line of cleanupLog) out(`  ⚠ ${line}`);
  } else {
    out('\n脏数据清单: 空（沙箱已删、真实存储测试条目已清）');
  }

  const code = hardPass ? 0 : hardFail ? 1 : 3;
  out(`\n退出码: ${code}`);
  process.exitCode = code;
} finally {
  // 清理沙箱（含 git-probe、容量探测等一切临时数据）
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
