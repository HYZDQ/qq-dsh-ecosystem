// P3 定时/事件触发（§6.3）单测：schedules.json 配置、due/nextRun、事件冷却、调度器触发语义、四道闸。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduleStore } from '../computer/tasks/schedules.mjs';
import { LocalScheduler } from '../computer/tasks/scheduler.mjs';
import { parseTasklistImages, sessionLocked } from '../computer/session.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { defaultPolicy } from '../computer/policy.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('ScheduleStore：默认关、条目校验、持久化、due/nextRun 语义', () => {
  const dir = tmp('schedules-');
  const now = () => clock;
  let clock = 1_000_000;
  const store = new ScheduleStore({ stateDir: dir, now });
  assert.equal(store.state().enabled, false, '定时触发默认关（§6.3）');

  assert.throws(() => store.configure({ goal: '', trigger: { kind: 'interval', everyMs: 60_000 } }), (e) => e.code === 'POLICY_INVALID');
  assert.throws(() => store.configure({ goal: 'x', trigger: { kind: 'nope' } }), (e) => e.code === 'POLICY_INVALID');
  assert.throws(() => store.configure({ goal: 'x', trigger: { kind: 'interval', everyMs: 10 } }), (e) => e.code === 'POLICY_INVALID');
  assert.throws(() => store.configure({ goal: 'x', trigger: { kind: 'daily', dailyAt: '25:00' } }), (e) => e.code === 'POLICY_INVALID');
  assert.throws(() => store.configure({ goal: 'x', trigger: { kind: 'event', event: 'bad' } }), (e) => e.code === 'POLICY_INVALID');

  const state = store.configure({ goal: '每小时巡检', trigger: { kind: 'interval', everyMs: 3_600_000 } });
  assert.equal(state.count, 1);
  const id = state.schedules[0].id;
  assert.equal(state.schedules[0].nextRunAt, 1_000_000 + 3_600_000);

  // 持久化：新实例读到同一份
  const again = new ScheduleStore({ stateDir: dir, now });
  assert.equal(again.state().schedules[0].goal, '每小时巡检');
  assert.deepEqual(again.due(clock), [], '未到期不触发');
  clock += 3_600_001;
  assert.equal(again.due(clock).length, 1, '到期触发');
  again.markFired(id, clock);
  assert.deepEqual(again.due(clock), [], '触发后消耗');
  assert.equal(again.state().schedules[0].nextRunAt, clock + 3_600_000);

  // daily：明天同一时刻
  const daily = store.configure({ goal: '每天汇总', trigger: { kind: 'daily', dailyAt: '08:30' } });
  const dailyId = daily.schedules.find((item) => item.goal === '每天汇总').id;
  const dailyNext = store.state().schedules.find((item) => item.id === dailyId).nextRunAt;
  assert.ok(dailyNext > clock && dailyNext <= clock + 86_400_000);

  store.remove(id);
  assert.equal(store.state().count, 1);
  assert.throws(() => store.remove('sch-none'), (e) => e.code === 'TASK_STATE');
});

test('ScheduleStore：事件触发带冷却，setEnable 全局开关', () => {
  const dir = tmp('schedules-event-');
  let clock = 0;
  const store = new ScheduleStore({ stateDir: dir, now: () => clock });
  store.configure({ goal: 'qq 消息来了', trigger: { kind: 'event', event: 'qq-message', cooldownMs: 60_000 } });
  assert.equal(store.eventMatches('qq-message').length, 1);
  assert.equal(store.eventMatches('douyin').length, 0);
  const [entry] = store.eventMatches('qq-message');
  store.markFired(entry.id, clock);
  assert.equal(store.eventMatches('qq-message').length, 0, '冷却期内不重复触发');
  clock += 60_001;
  assert.equal(store.eventMatches('qq-message').length, 1, '冷却结束恢复');
  const off = store.setEnabled(true);
  assert.equal(off.enabled, true);
  store.setEnabled(false);
  assert.equal(store.state().enabled, false);
});

test('LocalScheduler：到期触发一次即消耗；失败不消耗可重试；全局关不触发；事件分发', async () => {
  const dir = tmp('scheduler-');
  let clock = 0;
  const store = new ScheduleStore({ stateDir: dir, now: () => clock });
  const fired = [];
  let busy = true;
  const scheduler = new LocalScheduler({
    store, now: () => clock,
    onDue: async (entry) => {
      if (busy) return { ok: false, code: 'COMPUTER_BUSY', message: '占用中' };
      fired.push(entry.id);
      return { ok: true, taskId: 'tsk-x' };
    },
  });

  assert.deepEqual(await scheduler.tick(), [], '全局关（默认）不触发');
  store.setEnabled(true);
  store.configure({ goal: '巡检', trigger: { kind: 'interval', everyMs: 5_000 } });
  clock += 5_000; // 推进到首次到期

  const [busyResult] = await scheduler.tick();
  assert.equal(busyResult.ok, false);
  assert.equal(busyResult.code, 'COMPUTER_BUSY');
  assert.equal(store.state().schedules[0].lastRunAt, null, '失败不消耗触发');

  busy = false;
  const [ok] = await scheduler.tick();
  assert.equal(ok.ok, true);
  assert.equal(fired.length, 1);
  assert.ok(store.state().schedules[0].lastRunAt !== null, '成功才消耗');
  assert.deepEqual(await scheduler.tick(), [], '未到期不重复');

  // 事件分发
  store.configure({ goal: '抖音动静', trigger: { kind: 'event', event: 'douyin' } });
  const events = await scheduler.notifyEvent('douyin', { kind: 'like' });
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
  const none = await scheduler.notifyEvent('douyin', {});
  assert.deepEqual(none, [], '冷却期内事件不重复触发');
});

test('四道闸：STOP/未开启/任务占用时触发不建任务；正常触发建 autonomous 任务', () => {
  const stateDir = tmp('schedules-gates-');
  const policy = { ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['12345'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => { throw new Error('触发不应启动驱动'); }, sessionProbe: () => false });
  const schedule = { id: 'sch-test', goal: '巡检桌面', budget: { maxSteps: 10, maxWrites: 5, maxWallMs: 60_000, maxModelCalls: 10 } };

  const started = runtime.startScheduledTask(schedule, { trigger: 'schedule' });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'running');
  assert.equal(runtime.tasks.current().mode, 'autonomous');

  const busy = runtime.startScheduledTask(schedule);
  assert.equal(busy.code, 'COMPUTER_BUSY', '已有任务时触发跳过');

  fs.writeFileSync(path.join(stateDir, 'STOP'), 'x');
  const stopped = runtime.startScheduledTask({ ...schedule, id: 'sch-2' });
  assert.equal(stopped.code, 'COMPUTER_DISABLED', 'STOP 急停拦下触发');
  fs.rmSync(path.join(stateDir, 'STOP'));

  // computer_status 暴露调度摘要
  const status = runtime.execute('computer_status', {});
  return status.then((result) => {
    assert.equal(result.ok, true);
    assert.ok(result.schedules, 'status 应含 schedules 摘要');
    return runtime.dispose();
  });
});

test('轮询观察（poll 触发）：条件满足才动作，检查记账防刷', async () => {
  const dir = tmp('schedules-poll-');
  let clock = 0;
  const store = new ScheduleStore({ stateDir: dir, now: () => clock });
  assert.throws(() => store.configure({ goal: 'x', trigger: { kind: 'poll', everyMs: 5_000 } }), (e) => e.code === 'POLICY_INVALID', 'poll 必须带条件');
  assert.throws(() => store.configure({ goal: 'x', trigger: { kind: 'poll', everyMs: 5_000, condition: { titlePattern: '([' } } }), (e) => e.code === 'POLICY_INVALID', '正则非法要拦');

  store.setEnabled(true);
  const state = store.configure({ goal: '等下载完成', trigger: { kind: 'poll', everyMs: 5_000, condition: { titlePattern: '下载完成' } } });
  const id = state.schedules[0].id;

  const fired = [];
  let met = false;
  const scheduler = new LocalScheduler({
    store, now: () => clock,
    checkPoll: () => met,
    onDue: async () => { fired.push(1); return { ok: true, taskId: 'tsk-poll' }; },
  });

  clock += 5_000;
  assert.deepEqual(await scheduler.tick(), [], '条件不满足不动作');
  assert.equal(store.state().schedules.find((item) => item.id === id).lastCheckAt, clock, '检查已记账');
  assert.deepEqual(await scheduler.tick(), [], 'everyMs 内不重复观察');

  met = true;
  clock += 5_000;
  const [result] = await scheduler.tick();
  assert.equal(result.ok, true);
  assert.equal(fired.length, 1);
});

test('SESSION_LOCKED（§4.3）：锁屏进程探测 + 检测失败 fail-closed', () => {
  const csv = (images) => ['"Image Name","PID","Session Name","Session#","Mem Usage"']
    .concat(images.map((name) => `"${name}","1","Console","1","1,000 K"`)).join('\n');
  assert.deepEqual([...parseTasklistImages(csv(['notepad.exe', 'LockApp.exe']))], ['notepad.exe', 'lockapp.exe']);
  assert.equal(sessionLocked({ exec: () => csv(['LockApp.exe']) }), true, '锁屏宿主 = 锁定');
  assert.equal(sessionLocked({ exec: () => csv(['LogonUI.exe']) }), true, '安全桌面/UAC = 锁定');
  assert.equal(sessionLocked({ exec: () => csv(['notepad.exe']) }), false);
  assert.equal(sessionLocked({ exec: () => { throw new Error('tasklist 挂了'); } }), true, '检测失败按锁定处理（fail-closed，宁停不猜）');
});

test('SESSION_LOCKED 贯通：锁定拦写、running 任务自动暂停、定时触发跳过', async () => {
  const stateDir = tmp('schedules-lock-');
  const policy = { ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['12345'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  let locked = false;
  const runtime = new ComputerRuntime({
    stateDir,
    driverFactory: () => { throw new Error('锁定测试不应启动驱动'); },
    sessionProbe: () => locked,
  });
  const actor = { channel: 'private', id: '12345' };

  const started = await runtime.execute('computer_task_start', { goal: '锁屏演练' }, { actor });
  assert.equal(started.status, 'running');

  locked = true;
  const blocked = await runtime.execute('computer_click', { label: 0 }, { actor });
  assert.equal(blocked.code, 'SESSION_LOCKED', JSON.stringify(blocked));
  assert.equal(runtime.tasks.current().status, 'paused', '锁定时 running 任务应转 paused');

  const trigger = runtime.startScheduledTask({ id: 'sch-lock', goal: 'x' });
  assert.equal(trigger.code, 'SESSION_LOCKED');

  // 只读不受限
  const status = await runtime.execute('computer_task_status', {});
  assert.equal(status.ok, true);
  await runtime.dispose();
});
