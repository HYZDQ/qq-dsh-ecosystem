// L2 系统级（§8.3）单测：power 档存在性、AUTONOMY_FORBIDDEN（回归网 5）、管理员与确认令牌、
// 设置页白名单；shell 真跑一条无害命令验证执行链与收据（只记 hash）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { defaultPolicy } from '../computer/policy.mjs';
import { COMPUTER_L2_TOOL_DEFINITIONS, COMPUTER_L2_TOOLS } from '../computer/tool-definitions.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const actor = { channel: 'private', id: '12345' };

function setup(policyPatch = {}) {
  const stateDir = tmp('computer-l2-');
  const policy = { ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['12345'] }, ...policyPatch };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  return new ComputerRuntime({ stateDir, driverFactory: () => { throw new Error('L2 测试不应启动驱动'); }, sessionProbe: () => false });
}

test('L2 存在性：非 power 档一律 TARGET_NOT_ALLOWED，shell 另需 allowShell', async () => {
  const standard = setup();
  const denied1 = await standard.execute('computer_shell', { command: 'dir' }, { actor });
  assert.equal(denied1.code, 'TARGET_NOT_ALLOWED', JSON.stringify(denied1));
  const denied2 = await standard.execute('computer_settings', { page: 'display' }, { actor });
  assert.equal(denied2.code, 'TARGET_NOT_ALLOWED');
  await standard.dispose();

  const power = setup({ profile: 'power' }); // 未开 allowShell
  const denied3 = await power.execute('computer_shell', { command: 'dir' }, { actor });
  assert.equal(denied3.code, 'TARGET_NOT_ALLOWED', 'shell 必须同时 allowShell=true');
  await power.dispose();
});

test('AUTONOMY_FORBIDDEN（回归网 5）：自治任务内 L2 一律拒绝', async () => {
  const runtime = setup({ profile: 'power', allowShell: true });
  const started = runtime.startScheduledTask({ id: 'sch-l2', goal: '自治演练' });
  assert.equal(started.ok, true);
  assert.equal(runtime.tasks.current().mode, 'autonomous');

  const shell = await runtime.execute('computer_shell', { command: 'dir' }, { actor });
  assert.equal(shell.code, 'AUTONOMY_FORBIDDEN', JSON.stringify(shell));
  const settings = await runtime.execute('computer_settings', { page: 'display' }, { actor });
  assert.equal(settings.code, 'AUTONOMY_FORBIDDEN');
  await runtime.dispose();
});

test('L2 shell 全流程：两段式确认 → 真执行 → 收据只记 hash；设置页白名单拦截', async () => {
  const runtime = setup({ profile: 'power', allowShell: true });

  // 群聊/非管理员一律 NOT_ADMIN（9.3）
  const group = await runtime.execute('computer_shell', { command: 'dir' }, { actor: { channel: 'group', id: '12345' } });
  assert.equal(group.code, 'NOT_ADMIN');

  const first = await runtime.execute('computer_shell', { command: 'echo l2-ok' }, { actor });
  assert.equal(first.needsConfirm, true, JSON.stringify(first));
  const done = await runtime.execute('computer_shell', { command: 'echo l2-ok', confirmToken: first.confirmToken }, { actor });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.ok(done.receiptId);
  assert.match(done.stdout, /l2-ok/);

  // 收据只记命令 hash，不落明文（§11.1）
  const receipts = runtime.audit.recent(5);
  const shellReceipt = receipts.find((item) => item.tool === 'computer_shell');
  assert.ok(shellReceipt);
  assert.ok(shellReceipt.textHash && shellReceipt.textHash.length >= 16);
  assert.ok(!JSON.stringify(shellReceipt).includes('l2-ok'), '收据不得含命令明文');

  // 设置页白名单
  const badPage = await runtime.execute('computer_settings', { page: 'hacked' }, { actor });
  assert.equal(badPage.code, 'TARGET_NOT_ALLOWED');
  await runtime.dispose();
});

test('L2 工具目录：独立分组、描述含确认与自治禁令', () => {
  assert.deepEqual([...COMPUTER_L2_TOOLS], ['computer_shell', 'computer_settings']);
  assert.deepEqual(COMPUTER_L2_TOOL_DEFINITIONS.map((item) => item.name), ['computer_shell', 'computer_settings']);
  for (const definition of COMPUTER_L2_TOOL_DEFINITIONS) {
    assert.ok(definition.description.includes('确认'), `${definition.name} 描述需含确认流程`);
    assert.ok(definition.description.includes('自治'), `${definition.name} 描述需含自治禁令`);
    assert.ok(definition.parameters.properties.confirmToken, `${definition.name} 必须声明 confirmToken`);
  }
});
