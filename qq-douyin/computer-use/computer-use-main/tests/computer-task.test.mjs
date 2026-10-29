import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { defaultPolicy } from '../computer/policy.mjs';
import { TaskStore } from '../computer/tasks/checkpoint.mjs';
import { stepKeyOf, normalizeBudget, DEFAULT_BUDGET } from '../computer/tasks/state-machine.mjs';

const SNAPSHOT_SAMPLE = `
    Cursor Position: (100, 100)

    Focused Window:
    Name              Depth  Status       Width    Height     Handle
--------------  -------  ---------  -------  --------  ---------
无标题 - 记事本       12  Maximized     1200      800  12345678

    Opened Windows:
    Name                            Depth  Status       Width    Height     Handle
------------------------------  -------  ---------  -------  --------  ---------
无标题 - 记事本                       12  Maximized     1200      800  12345678

    List of Interactive Elements:
    # id|window|control_type|name|coords|metadata
0|无标题 - 记事本|按钮|保存|(800,540)|{"has_focused": 0}

    List of Scrollable Elements:
    No scrollable elements`;

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const ACTOR = { channel: 'private', id: '12345' };

function setup({ budget } = {}) {
  const stateDir = tmp('computer-task-');
  const policy = { ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['12345'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const calls = [];
  const driver = {
    calls, child: { pid: 1 }, restarts: 0,
    async callTool(name, args) { calls.push({ name, args }); return { ok: true, text: SNAPSHOT_SAMPLE, frames: [] }; },
    async close() {},
  };
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  return { stateDir, runtime, driver, budget };
}

async function click(runtime, label, actor = ACTOR) {
  const first = await runtime.execute('computer_click', { label }, { actor });
  assert.equal(first.needsConfirm, true, JSON.stringify(first));
  return runtime.execute('computer_click', { label, confirmToken: first.confirmToken }, { actor });
}

test('任务生命周期：启动→暂停→恢复→完成，非法转换拒绝', async () => {
  const { runtime, driver } = setup();
  const started = await runtime.execute('computer_task_start', { goal: '测试任务' }, { actor: ACTOR });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.status, 'running');
  assert.ok(started.taskId);

  const status = await runtime.execute('computer_task_status', {});
  assert.equal(status.status, 'running');
  assert.equal(status.goal, '测试任务');

  const paused = await runtime.execute('computer_task_pause', {}, { actor: ACTOR });
  assert.equal(paused.status, 'paused');
  assert.equal((await runtime.execute('computer_task_pause', {}, { actor: ACTOR })).code, 'TASK_STATE');

  const resumed = await runtime.execute('computer_task_resume', {}, { actor: ACTOR });
  assert.equal(resumed.status, 'running');
  const stopped = await runtime.execute('computer_task_stop', { completed: true }, { actor: ACTOR });
  assert.equal(stopped.status, 'done');
  assert.ok(stopped.receiptId);
  assert.equal((await runtime.execute('computer_task_resume', {}, { actor: ACTOR })).code, 'TASK_STATE');
  await runtime.dispose();
});

test('任务控制红线：仅管理员可发起/暂停/恢复/结束，status 只读可查', async () => {
  const { runtime } = setup();
  for (const actor of [undefined, { channel: 'group', id: '12345' }, { channel: 'private', id: '66' }]) {
    const denied = await runtime.execute('computer_task_start', { goal: 'x' }, { actor });
    assert.equal(denied.code, 'NOT_ADMIN', JSON.stringify(denied));
  }
  const readonly = await runtime.execute('computer_task_status', {});
  assert.equal(readonly.ok, true);
  assert.equal(readonly.status, 'idle');
  await runtime.dispose();
});

test('同一时刻仅一个任务：COMPUTER_BUSY，结束后可再开', async () => {
  const { runtime } = setup();
  await runtime.execute('computer_task_start', { goal: '第一个' }, { actor: ACTOR });
  const conflict = await runtime.execute('computer_task_start', { goal: '第二个' }, { actor: ACTOR });
  assert.equal(conflict.code, 'COMPUTER_BUSY');
  await runtime.execute('computer_task_stop', {}, { actor: ACTOR });
  const next = await runtime.execute('computer_task_start', { goal: '第二个' }, { actor: ACTOR });
  assert.equal(next.ok, true);
  await runtime.dispose();
});

test('预算：超限自动暂停并 BUDGET_EXHAUSTED，恢复后可继续', async () => {
  const { runtime } = setup();
  await runtime.execute('computer_task_start', { goal: '预算测试', budget: { maxSteps: 2, maxWrites: 5 } }, { actor: ACTOR });
  await click(runtime, 0);   // 2 步（needsConfirm + 执行）
  const overflow = await runtime.execute('computer_observe', {});
  assert.equal(overflow.code, 'BUDGET_EXHAUSTED', JSON.stringify(overflow));
  const status = await runtime.execute('computer_task_status', {});
  assert.equal(status.status, 'paused');
  assert.equal(status.result, 'budget_exhausted');
  const resumed = await runtime.execute('computer_task_resume', {}, { actor: ACTOR });
  assert.equal(resumed.status, 'running');
  await runtime.dispose();
});

test('重启恢复：interrupted → resume，之前会话已完成步骤不重复执行（§6.5）', async () => {
  const { stateDir, runtime, driver } = setup();
  await runtime.execute('computer_task_start', { goal: '幂等测试' }, { actor: ACTOR });
  // 同一会话内重复点击是合法的：两次都执行。
  const first = await click(runtime, 5);
  const repeat = await click(runtime, 5);
  assert.equal(first.ok, true);
  assert.equal(repeat.ok, true);
  assert.equal(driver.calls.filter((call) => call.name === 'Click').length, 2);
  await runtime.dispose();

  // 模拟进程重启：新运行时把未终结任务标为 interrupted，不自动续跑。
  const calls2 = [];
  const driver2 = {
    calls: calls2, child: { pid: 2 }, restarts: 0,
    async callTool(name, args) { calls2.push({ name, args }); return { ok: true, text: SNAPSHOT_SAMPLE, frames: [] }; },
    async close() {},
  };
  const runtime2 = new ComputerRuntime({ stateDir, driverFactory: () => driver2, sessionProbe: () => false });
  const interrupted = await runtime2.execute('computer_task_status', {});
  assert.equal(interrupted.status, 'interrupted');
  const resumed = await runtime2.execute('computer_task_resume', {}, { actor: ACTOR });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.completedSteps, 1);

  // 同步骤（label 5）：之前会话已完成 ⇒ 幂等跳过，不落驱动。
  const skipped = await click(runtime2, 5);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.receiptId, first.receiptId);
  assert.equal(calls2.filter((call) => call.name === 'Click').length, 0);

  // 新步骤照常执行。
  const fresh = await click(runtime2, 9);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.skipped, undefined);
  assert.equal(calls2.filter((call) => call.name === 'Click').length, 1);
  await runtime2.dispose();
});

test('预算参数校验与默认值（§6.1）', () => {
  assert.deepEqual(DEFAULT_BUDGET, { maxSteps: 30, maxWallMs: 600_000, maxModelCalls: 60, maxWrites: 80 });
  assert.equal(normalizeBudget(undefined).maxSteps, 30);
  assert.equal(normalizeBudget({ maxSteps: 5 }).maxSteps, 5);
  assert.throws(() => normalizeBudget({ maxSteps: 0 }), (error) => error.code === 'BUDGET_EXHAUSTED');
  assert.throws(() => normalizeBudget({ maxWrites: 10 ** 9 }), (error) => error.code === 'BUDGET_EXHAUSTED');
  assert.equal(typeof stepKeyOf('click', '标注 0', { label: 0 }), 'string');
  assert.equal(stepKeyOf('click', 'a', { label: 1 }), stepKeyOf('click', 'a', { label: 1 }));
  assert.notEqual(stepKeyOf('click', 'a', { label: 1 }), stepKeyOf('click', 'a', { label: 2 }));
});

test('checkpoint 落盘：steps.jsonl 记录步骤与收据，state.json 记录预算余量', async () => {
  const { stateDir, runtime } = setup();
  const started = await runtime.execute('computer_task_start', { goal: '落盘测试' }, { actor: ACTOR });
  await click(runtime, 0);
  const store = new TaskStore({ stateDir });
  const state = store.load(started.taskId);
  assert.equal(state.status, 'running');
  assert.equal(state.used.steps, 2);
  assert.equal(state.used.writes, 2);
  assert.equal(state.completedStepKeys.length, 1);
  const steps = store.steps(started.taskId);
  assert.equal(steps.length, 1);
  assert.ok(steps[0].receiptId);
  assert.ok(fs.existsSync(path.join(stateDir, 'tasks', started.taskId, 'state.json')));
  await runtime.dispose();
});
