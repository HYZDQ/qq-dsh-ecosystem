// P3 主干-分支接线回归网（2026-10-27）：
//  1. 外部领域包（packs.d 声明）即插即用；坏声明/坏模块 fail-closed 跳过；
//  2. goal → 领域包 action → L1 步骤计划路由，越权计划被 TOOLSET_LEAK 拒绝；
//  3. 真实分支包（v2 的 lib/pack.mjs）经 computer_task_plan 端到端：管理员闸 + 计划产出；
//  4. 注册面零 douyin_*（P2b 收口对账：TOOL_DEFINITIONS 里的抖音名字全部在 MIGRATED_TO_V2）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackRegistry } from '../computer/packs/registry.mjs';
import { TOOL_DEFINITIONS } from '../tool-definitions.mjs';
import { defaultPolicy } from '../computer/policy.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { MIGRATED_TO_V2 } from '../dsh-plugin.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const HERE = path.dirname(fileURLToPath(import.meta.url));
// tests/ → computer-use-main → computer-use → qq-douyin（改名后多了一层，三级向上）。
const V2_PACK = path.resolve(HERE, '..', '..', '..', 'dsh-douyin-agent-v2', 'lib', 'pack.mjs');

function writeSpec(stateDir, id, module, name = id) {
  const dir = path.join(stateDir, 'packs.d');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, name, module }));
}

test('外部包：packs.d 声明即插即用；坏声明/坏模块 fail-closed 跳过', async () => {
  const stateDir = tmp('packs-d-');
  const mod = path.join(stateDir, 'branch.mjs');
  fs.writeFileSync(mod, [
    'export function createPack() {',
    '  return {',
    "    id: 'demo',",
    '    matches: () => true,',
    "    actions: () => [{ name: 'open' }],",
    "    prompt: () => 'demo 提示',",
    '    policyExt: () => ({ deny: [], requireConfirm: [] }),',
    "    handlesGoal: (goal) => (/demo/.test(goal) ? { action: 'open' } : null),",
    '    plan: () => [{ tool: \'computer_wait\', args: { ms: 1 } }],',
    '  };',
    '}',
  ].join('\n'));
  writeSpec(stateDir, 'demo', mod);
  writeSpec(stateDir, 'badmod', path.join(stateDir, 'nope.mjs'));
  fs.mkdirSync(path.join(stateDir, 'packs.d'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'packs.d', 'broken.json'), '{broken');

  const registry = new PackRegistry({ stateDir, builtins: [] });
  await registry.ready();
  assert.deepEqual(registry.list().map((item) => item.id), ['demo'], '只有完好的声明被加载');
  assert.equal(registry.matchFor({ title: '随便什么窗口' })?.id, 'demo');
  assert.equal(registry.hintFor({ title: 'x' })?.hint, 'demo 提示');

  const routed = registry.planForGoal('跑一下 demo');
  assert.equal(routed.pack, 'demo');
  assert.equal(routed.action, 'open');
  assert.deepEqual(routed.steps, [{ tool: 'computer_wait', args: { ms: 1 } }]);
  assert.equal(registry.planForGoal('完全无关的目标'), null);
});

test('goal 路由：越权计划步骤被 TOOLSET_LEAK 拒绝（计划为空 + error）', async () => {
  const stateDir = tmp('packs-d2-');
  const mod = path.join(stateDir, 'evil.mjs');
  fs.writeFileSync(mod, [
    'export function createPack() {',
    '  return {',
    "    id: 'evil',",
    '    matches: () => false,',
    "    actions: () => [{ name: 'x' }],",
    '    plan: () => [{ tool: \'computer_shell\', args: {} }],',
    "    handlesGoal: () => ({ action: 'x' }),",
    '  };',
    '}',
  ].join('\n'));
  writeSpec(stateDir, 'evil', mod);
  const registry = new PackRegistry({ stateDir, builtins: [] });
  await registry.ready();
  const routed = registry.planForGoal('随便');
  assert.equal(routed.steps.length, 0, '越权步骤不得进入计划');
  assert.match(String(routed.error), /越权/);
});

test('真实分支包：v2 的 pack 经 computer_task_plan 端到端（管理员闸 + L1 计划）', async () => {
  assert.ok(fs.existsSync(V2_PACK), `分支包应存在：${V2_PACK}`);
  const stateDir = tmp('p3-e2e-');
  const policy = { ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['123456789'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  writeSpec(stateDir, 'douyin', V2_PACK, 'dsh-douyin-agent');

  const runtime = new ComputerRuntime({
    stateDir,
    driverFactory: () => { throw new Error('规划不应启动桌面驱动'); },
    sessionProbe: () => false,
    processProbe: () => [],
  });

  const denied = await runtime.execute('computer_task_plan', { goal: '刷抖音' }, { actor: { channel: 'group', id: '12345' } });
  assert.equal(denied.code, 'NOT_ADMIN', '任务规划仅管理员私聊');

  const plan = await runtime.execute('computer_task_plan', { goal: '去刷抖音看看有什么' }, { actor: { channel: 'private', id: '123456789' } });
  assert.equal(plan.ok, true);
  assert.equal(plan.pack, 'douyin');
  assert.equal(plan.action, 'browse');
  assert.ok(plan.steps.length > 0, '计划要有 L1 步骤');
  for (const step of plan.steps) assert.match(step.tool, /^computer_/);

  const unknown = await runtime.execute('computer_task_plan', { goal: '整理桌面图标' }, { actor: { channel: 'private', id: '123456789' } });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.pack, null, '没有包认领时返回空计划而不是报错');
  await runtime.dispose();
});

test('注册面零 douyin_*：P2b 收口对账（抖音名字必须全部在 MIGRATED_TO_V2）', () => {
  const douyinNames = TOOL_DEFINITIONS.map((item) => item.name).filter((name) => name.startsWith('douyin_'));
  assert.ok(douyinNames.length > 0, '目录里应保留抖音工具定义（内部栈仍用）');
  for (const name of douyinNames) {
    assert.ok(MIGRATED_TO_V2.has(name), `抖音工具未迁 v2 会被双注册：${name}`);
  }
  const registered = TOOL_DEFINITIONS.map((item) => item.name).filter((name) => !MIGRATED_TO_V2.has(name));
  assert.deepEqual(registered.filter((name) => name.startsWith('douyin_')), [], '注册面不得再有 douyin_*');
});
