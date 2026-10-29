// 三代仿真长期记忆测试（GEN3 1.3 / 1.4）：
// 覆盖 mnemon backend 的 sidecar 真相源、全量对齐幂等、坏文件恢复、运行时缺失降级，
// 以及 V2 → V3 沉淀映射（memory-promote.js）。
// 运行：node scripts/test-simulation-memory-mnemon.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMnemonBackend,
  planMnemonContents,
  DEFAULT_MNEMON_LIMIT_BYTES,
  MNEMON_NAMESPACE,
} from '../src/simulation/memory-mnemon.js';
import { createMemoryStore, SCOPES } from '../src/simulation/memory.js';
import { buildPromotion, parseSessionKey, planPromotion, resolveImpressionUserId } from '../src/simulation/memory-promote.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function mkDir(tag = 'mnemon') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qq-bridge-${tag}-`));
}

// ---- fake dsh-mnemon-source-runtime：与真实实现同契约（同步快照 + 去重 add / 唯一 oldText remove）----
function writeFakeRuntime(dir) {
  const file = path.join(dir, 'fake-mnemon-runtime.mjs');
  fs.writeFileSync(file, `
function dbOf(dataDir) {
  const key = '__mnemonFake:' + dataDir;
  if (!globalThis[key]) globalThis[key] = { entries: [], limitBytes: 0 };
  return globalThis[key];
}
export function createRuntimeMemorySource({ dataDir, memoryLimitBytes } = {}) {
  const db = dbOf(dataDir);
  db.limitBytes = memoryLimitBytes;
  return {
    create() {
      return {
        async manage(req) {
          const input = req && req.input;
          if (req && req.mode === 'read' && req.operation === 'snapshot') {
            return { value: { entries: db.entries.map((e) => ({ ...e })), targets: [] } };
          }
          if (req && req.mode === 'write' && req.operation === 'mutate' && input) {
            if (input.action === 'add') {
              const content = String(input.content).trim().replace(/\\s+/gu, ' ');
              if (db.entries.some((e) => e.target === input.target && e.content === content)) {
                return { ok: true, deduped: true };
              }
              db.entries.push({
                target: input.target,
                content,
                importance: input.importance ?? 'low',
                branches: Array.isArray(input.branches) ? [...input.branches] : []
              });
              return { ok: true };
            }
            if (input.action === 'remove') {
              const text = String(input.oldText).trim().replace(/\\s+/gu, ' ');
              const hits = db.entries.filter((e) => e.content === text);
              if (hits.length !== 1) throw new Error('oldText 命中 ' + hits.length + ' 条');
              db.entries.splice(db.entries.indexOf(hits[0]), 1);
              return { ok: true };
            }
          }
          throw new Error('fake mnemon: 不支持的请求');
        }
      };
    }
  };
}
`, 'utf8');
  return file;
}

const dbOf = (dataDir) => globalThis[`__mnemonFake:${dataDir}`];

function episode(overrides = {}) {
  return {
    id: 'mem_ep_1',
    kind: 'episode',
    scope: 'group',
    groupId: 'group:1',
    text: '昨晚群里聊到猫粮涨价',
    sourceMessageIds: ['seq:1'],
    sourceType: 'group',
    trust: 'candidate',
    observedAt: iso(NOW - DAY),
    expiresAt: iso(NOW + 3650 * DAY),
    ...overrides,
  };
}

async function setup(tag) {
  const dir = mkDir(tag);
  const dataDir = path.join(dir, 'mnemon-data');
  const runtimeEntry = writeFakeRuntime(dir);
  const backend = await createMnemonBackend({
    dir: path.join(dir, 'sidecar'),
    dataDir,
    runtimeEntry,
    namespace: 'v3',
  });
  return { dir, dataDir, backend };
}

test('planMnemonContents：只下沉可移植条目，正文重复按 id 排序加后缀', () => {
  const same = '同一段正文';
  const entries = [
    episode({ id: 'mem_b', text: same }),
    episode({ id: 'mem_a', text: same }),
    episode({ id: 'mem_arch', text: '已归档', deletedAt: iso(NOW) }),
    episode({ id: 'mem_sup', text: '被替代', supersededBy: 'mem_x' }),
    episode({ id: 'mem_exp', text: '已过期', expiresAt: iso(NOW - 1) }),
    episode({ id: 'mem_untrusted', text: '不可信', trust: 'untrusted' }),
  ];
  const plan = planMnemonContents(entries, NOW);
  assert.equal(plan.size, 2, '只有两条同正文条目可下沉');
  assert.equal(plan.get('mem_a'), same);
  assert.equal(plan.get('mem_b'), `${same}（记忆 em_b）`);
  assert.equal(plan.has('mem_arch'), false);
  assert.equal(plan.has('mem_sup'), false);
  assert.equal(plan.has('mem_exp'), false);
  assert.equal(plan.has('mem_untrusted'), false);
});

test('sidecar 是同步真相源：save 立即可读，mnemon 异步对齐（add / 幂等 / remove）', async () => {
  const { dataDir, backend } = await setup('mnemon-sync');
  assert.equal(backend.status().available, true);
  assert.equal(backend.status().limitBytes, DEFAULT_MNEMON_LIMIT_BYTES);
  assert.equal(backend.status().namespace, MNEMON_NAMESPACE);

  backend.save('group', [episode()]);
  // 同步契约：save 返回后 load 就能读到（不等 mnemon）
  assert.equal(backend.load('group').length, 1);

  const first = await backend.syncNow();
  assert.equal(first.added, 1);
  assert.equal(first.removed, 0);
  const db = dbOf(dataDir);
  assert.equal(db.entries.length, 1);
  assert.equal(db.entries[0].target, 'memory');
  assert.deepEqual(db.entries[0].branches, ['v3']);
  assert.equal(db.limitBytes, DEFAULT_MNEMON_LIMIT_BYTES, 'memoryLimitBytes 已调大并透传');

  // 幂等：同一状态重复同步不产生新写入
  const second = await backend.syncNow();
  assert.equal(second.added, 0);
  assert.equal(second.removed, 0);
  assert.equal(db.entries.length, 1);

  // 条目消失（归档/被替代）→ mnemon 侧同步删除
  backend.save('group', []);
  const third = await backend.syncNow();
  assert.equal(third.removed, 1);
  assert.equal(db.entries.length, 0);
});

test('非 v3 分区与 target!=memory 的条目不受同步影响', async () => {
  const { dataDir, backend } = await setup('mnemon-isolation');
  const db = dbOf(dataDir);
  db.entries.push({ target: 'user', content: '控制器写的用户档案', branches: ['v3'] });
  db.entries.push({ target: 'memory', content: '别的分支的记忆', branches: ['other'] });

  backend.save('group', [episode()]);
  await backend.syncNow();
  const texts = db.entries.map((e) => e.content);
  assert.deepEqual(texts.sort(), ['别的分支的记忆', '控制器写的用户档案', episode().text].sort());

  backend.save('group', []);
  await backend.syncNow();
  assert.deepEqual(db.entries.map((e) => e.content).sort(), ['别的分支的记忆', '控制器写的用户档案'].sort());
});

test('sidecar 损坏：改名留档后按空库启动（不阻塞、不静默丢）', async () => {
  const dir = mkDir('mnemon-broken');
  const sidecarDir = path.join(dir, 'sidecar');
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarDir, 'memory-sidecar.json'), '{不是 JSON', 'utf8');

  const backend = await createMnemonBackend({
    dir: sidecarDir,
    runtimeEntry: path.join(dir, 'nope.mjs'), // 同时验证运行时缺失降级
  });
  assert.equal(backend.status().available, false);
  assert.match(backend.status().unavailableReason, /找不到 dsh-mnemon/);
  for (const scope of SCOPES) assert.equal(backend.load(scope).length, 0);

  const broken = fs.readdirSync(sidecarDir).filter((f) => f.includes('.broken-'));
  assert.equal(broken.length, 1, '坏文件应改名留档');

  // 运行时不可用时，sidecar 仍可独立工作，同步直接跳过
  backend.save('group', [episode()]);
  assert.equal(backend.load('group').length, 1);
  const result = await backend.syncNow();
  assert.equal(result.skipped, true);
});

test('与 createMemoryStore 组合：写入 / 检索 / 巩固全链路仍由 sidecar 支撑', async () => {
  const { dataDir, backend } = await setup('mnemon-store');
  const store = createMemoryStore({
    dir: path.dirname(backend.status().sidecarFile),
    backend,
    ownerUserId: '999',
    limits: { maxEntries: 12, maxChars: 1800 },
  });
  store.put(episode({ expiresAt: iso(NOW + DAY) }));
  assert.equal(store.query({ groupId: 'group:1', now: NOW }).length, 1);
  assert.equal(store.query({ groupId: 'group:2', now: NOW }).length, 0, 'scope 零泄漏');

  const report = store.consolidateNow({ now: NOW + 3 * DAY });
  assert.ok(report.archivedIds.length >= 1, '过期情景条目被巩固归档');
  await backend.syncNow();
  assert.equal(dbOf(dataDir).entries.length, 0, '归档后从 mnemon 长期层移除');
});

test('parseSessionKey：群 / 私聊 / 未知', () => {
  assert.deepEqual(parseSessionKey('group:123'), { kind: 'group', id: '123' });
  assert.deepEqual(parseSessionKey('private:456'), { kind: 'private', id: '456' });
  assert.equal(parseSessionKey('weird').kind, 'unknown');
  assert.equal(parseSessionKey('').kind, 'unknown');
});

test('buildPromotion：话题沉淀为 24h 情景记忆，群来源信任封顶 candidate', () => {
  const built = buildPromotion({
    key: 'group:123',
    category: 'activeTopic',
    content: '在聊国庆去哪玩',
    extra: { lastMentionAt: NOW },
    st: { recentMessages: [{ messageId: 'm1', userId: '456', sender: '小明', text: '国庆去哪玩' }] },
    now: NOW,
  });
  assert.equal(built.action, 'promote');
  assert.equal(built.candidate.kind, 'episode');
  assert.equal(built.candidate.scope, 'group');
  assert.equal(built.candidate.groupId, '123');
  assert.equal(built.candidate.trust, 'candidate');
  assert.deepEqual(built.candidate.sourceMessageIds, ['m1']);
  assert.deepEqual(built.candidate.structured, { key: 'active_topic', value: '在聊国庆去哪玩' });
  assert.equal(built.candidate.expiresAt, iso(NOW + DAY));
});

test('buildPromotion：印象按 userId 归档，私聊落 user scope', () => {
  const st = {
    memberImpressions: { 'u:456': { traits: ['手冲很讲究', '话不多'], aliases: ['小明'], lastSeenAt: NOW - 1000 } },
  };
  assert.equal(resolveImpressionUserId(st, '小明'), '456');
  const built = buildPromotion({
    key: 'group:123',
    category: 'memberImpression',
    content: '手冲很讲究',
    extra: { target: '小明', traits: ['手冲很讲究', '话不多'], lastSeenAt: NOW - 1000 },
    st,
    now: NOW,
  });
  assert.equal(built.action, 'promote');
  assert.equal(built.candidate.scope, 'group');
  assert.equal(built.candidate.userId, '456');
  assert.equal(built.candidate.subjectId, '456');
  assert.equal(built.candidate.text, '小明：手冲很讲究、话不多');
  assert.equal(built.candidate.expiresAt, null, '关系档案长期保留');

  const priv = buildPromotion({
    key: 'private:456',
    category: 'memberImpression',
    content: '手冲很讲究',
    extra: { target: '小明', traits: ['手冲很讲究'] },
    st: {},
    now: NOW,
  });
  assert.equal(priv.action, 'promote');
  assert.equal(priv.candidate.scope, 'user');
  assert.equal(priv.candidate.trust, 'observed');
});

test('buildPromotion：念头 / 主人私聊 / 解析不到 userId 一律 skip', () => {
  assert.equal(buildPromotion({ key: 'group:1', category: 'pendingThought', content: '想插一句' }).reason, 'internal-thought');
  assert.equal(buildPromotion({ key: 'private:999', category: 'activeTopic', content: '主人说周末搬家', ownerUserId: '999' }).reason, 'owner-private');
  assert.equal(buildPromotion({ key: 'group:1', category: 'memberImpression', content: '很活跃', extra: { target: '陌生人' }, st: {} }).reason, 'no-user-id');
  assert.equal(buildPromotion({ key: 'group:1', category: 'activeTopic', content: '   ' }).reason, 'empty-text');
});

test('planPromotion：insert / no-change / supersede', () => {
  const candidate = buildPromotion({ key: 'group:1', category: 'activeTopic', content: '聊猫粮', now: NOW }).candidate;
  assert.equal(planPromotion({ candidate, existing: [] }).op, 'insert');

  const same = { ...candidate, id: 'mem_old', observedAt: iso(NOW - 1000) };
  assert.equal(planPromotion({ candidate, existing: [same] }).op, 'no-change');

  const changed = { ...candidate, id: 'mem_old2', structured: { key: 'active_topic', value: '聊狗粮' }, observedAt: iso(NOW - 1000) };
  const planned = planPromotion({ candidate, existing: [changed] });
  assert.equal(planned.op, 'supersede');
  assert.equal(planned.supersededId, 'mem_old2');

  // 别的群 / 别的类别不算同簇
  const other = { ...candidate, id: 'mem_other', groupId: '2', observedAt: iso(NOW) };
  assert.equal(planPromotion({ candidate, existing: [other] }).op, 'insert');
});

test('bridge 接线：shadow / 只读锁 / 名单为空时记忆不预热、不巩固、不可手动巩固', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(src, /const simMemoryCanaryActive = \(\) => \{/, '必须有统一的记忆可写闸门');
  assert.match(src, /simV3Cfg\.shadowReadOnly === true\) return false/, '只读锁必须参与闸门');
  assert.match(src, /simV3Cfg\.mode === 'canary' \|\| simV3Cfg\.mode === 'on'/, 'shadow 模式必须被排除');
  // 启动预热/夜间巩固/手动巩固三处都必须用同一个闸门，而不是只看 moduleOn。
  // 断言钉的是「闸门结构」不钉行尾：工作区文件被 IDE/git 归一成 CRLF 时 `\r?\n` 一样过。
  assert.match(src, /if \(simMemoryCanaryActive\(\)\) \{\r?\n\s+void ensureSimMemory\(\)/, '启动预热必须走 canary 闸门');
  assert.match(src, /if \(!simMemoryCanaryActive\(\)\) return;/, '定时巩固必须走 canary 闸门');
  assert.match(src, /\/api\/socialV3\/memory\/consolidate[\s\S]{0,400}simMemoryCanaryActive\(\)/, '手动巩固必须走 canary 闸门');
  assert.match(src, /if \(simMemoryCanaryActive\(\)\) backend\.syncNow\(\)/, '只在可写期对齐 mnemon');
});
