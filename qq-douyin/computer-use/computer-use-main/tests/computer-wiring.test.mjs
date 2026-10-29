// 跨仓库接线（P4b）单测：visionLocate 视觉模型适配器（回复解析/模态校验/无服务为 null）
// 与 EventBridge 事件收件箱（落文件即触发、一次性消费、积压清理、类型过滤）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLocateReply, createVisionLocate } from '../computer/vision-adapter.mjs';
import { EventBridge } from '../computer/tasks/event-bridge.mjs';
import { defaultPolicy } from '../computer/policy.mjs';
import { BrowserDriver } from '../computer/browser-driver.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('parseLocateReply：坐标/gone/none/垃圾输入', () => {
  assert.deepEqual(parseLocateReply('{"x":123,"y":456}'), { x: 123, y: 456 });
  assert.deepEqual(parseLocateReply('看这里 {"x": 10.6, "y": 20.2} 完'), { x: 11, y: 20 }, '夹杂文字也要能解析并取整');
  assert.deepEqual(parseLocateReply('{"gone":true}'), { gone: true });
  assert.equal(parseLocateReply('{"none":true}'), null);
  assert.equal(parseLocateReply('我不确定'), null);
  assert.equal(parseLocateReply('{"x":"abc"}'), null);
});

test('createVisionLocate：无模型路由返回 null；带图片模型返回坐标；不支持图片明确报错', async () => {
  assert.equal(createVisionLocate({}), null, '缺 llm/路由不硬试');

  const chunks = (text) => (async function* () { yield { type: 'text-delta', index: 0, text }; })();
  const makeLlm = (modalities = ['image', 'text']) => ({
    resolveModelInfo: async () => ({ inputModalities: modalities }),
    stream: () => chunks('{"x":300,"y":400}'),
  });
  const attachments = { saveImages: async (imgs) => imgs.map((img, i) => ({ attachmentId: `att-${i}`, ...img })) };
  const agent = { session: { id: 's1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: { provider: 'p', model: 'm' } };

  const locate = createVisionLocate({ llm: makeLlm(), attachments, agent });
  assert.equal(typeof locate, 'function');
  const spot = await locate({ frame: { mimeType: 'image/png', data: Buffer.from('x').toString('base64') }, target: '点赞按钮' });
  assert.deepEqual(spot, { x: 300, y: 400 });

  const noImage = createVisionLocate({ llm: makeLlm(['text']), attachments, agent });
  await assert.rejects(() => noImage({ frame: { mimeType: 'image/png', data: 'eA==' }, target: 'x' }), /不支持图片/);
});

test('EventBridge：events/<type>.json 落文件即触发，一次性消费，积压清理，类型过滤', async () => {
  const stateDir = tmp('event-bridge-');
  const seen = [];
  const bridge = new EventBridge({ stateDir, onEvent: async (type, payload) => { seen.push({ type, payload }); } });

  // 积压事件：start 前落的文件也要消费（手动 drain 路径，不开 watch 避免竞态）
  fs.mkdirSync(path.join(stateDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'events', 'qq-message.json'), JSON.stringify({ from: 'owner', text: 'hi' }));
  assert.equal(await bridge.drain(), 1);
  assert.deepEqual(seen[0], { type: 'qq-message', payload: { from: 'owner', text: 'hi' } });
  assert.equal(fs.existsSync(path.join(stateDir, 'events', 'qq-message.json')), false, '一次性收件箱：触发后删除');

  // 坏载荷按空载荷触发；未知类型忽略；带时间戳文件名可识别
  fs.writeFileSync(path.join(stateDir, 'events', 'douyin-1700000000.json'), '{broken');
  fs.writeFileSync(path.join(stateDir, 'events', 'unknown.json'), '{}');
  assert.equal(await bridge.drain(), 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].type, 'douyin');
  assert.deepEqual(seen[1].payload, {});

  // watch 路径：start 后落文件自动触发
  await bridge.start();
  fs.writeFileSync(path.join(stateDir, 'events', 'file.json'), JSON.stringify({ path: 'x' }));
  for (let i = 0; i < 50 && seen.length < 3; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 3, 'fs.watch 应自动触发');
  assert.equal(seen[2].type, 'file');
  bridge.stop();
});

test('身份闸（§9.3 二次修订）：群聊/未知身份只有状态工具，管理员私聊放行', async () => {
  const stateDir = tmp('identity-gate-');
  const policy = { ...defaultPolicy(), domains: ['douyin.com'], apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['123456789'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const page = {
    url: () => 'https://www.douyin.com/video/1',
    title: async () => '抖音 - 测试',
    isClosed: () => false,
    evaluate: async (js) => (String(js).includes('location.href')
      ? { url: 'https://www.douyin.com/video/1', title: '抖音 - 测试', elements: [] }
      : true),
  };
  const runtime = new ComputerRuntime({
    stateDir, driverFactory: () => { throw new Error('不应启动桌面驱动'); }, sessionProbe: () => false,
    browserDriver: new BrowserDriver({ getPage: async () => page, stateDir }),
  });
  const owner = { channel: 'private', id: '123456789' };
  const stranger = { channel: 'private', id: '10086' };
  const group = { channel: 'group', id: '12345' };
  const unknown = { channel: 'unmapped', id: null };

  assert.equal((await runtime.execute('computer_status', {}, { actor: group })).ok, true, '群聊可查状态');
  assert.equal((await runtime.execute('computer_task_status', {}, { actor: group })).ok, true, '群聊可查任务状态');
  for (const actor of [stranger, group, unknown]) {
    const denied = await runtime.execute('computer_browser_observe', {}, { actor });
    assert.equal(denied.code, 'NOT_ADMIN', `非管理员/未知身份不得观察：${JSON.stringify(actor)} → ${JSON.stringify(denied)}`);
  }
  const allowed = await runtime.execute('computer_browser_observe', {}, { actor: owner });
  assert.equal(allowed.ok, true, '管理员私聊可观察');
  await runtime.dispose();
});

test('EventBridge + runtime：notifyEvent 贯通（文件事件 → 事件调度触发）', async () => {
  const stateDir = tmp('event-rt-');
  const policy = { ...((await import('../computer/policy.mjs')).defaultPolicy()), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['12345'] } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const { ComputerRuntime } = await import('../computer/runtime.mjs');
  const { ScheduleStore } = await import('../computer/tasks/schedules.mjs');
  const store = new ScheduleStore({ stateDir });
  store.setEnabled(true);
  store.configure({ goal: 'qq 消息联动', trigger: { kind: 'event', event: 'qq-message' } });

  const runtime = new ComputerRuntime({
    stateDir,
    driverFactory: () => { throw new Error('事件测试不应启动驱动'); },
    sessionProbe: () => false,
    processProbe: () => [],
  });
  fs.mkdirSync(path.join(stateDir, 'events'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'events', 'qq-message.json'), JSON.stringify({ text: '联动' }));
  await runtime.eventBridge.drain();
  const task = runtime.tasks.current();
  assert.ok(task, '事件触发应创建任务');
  assert.equal(task.mode, 'autonomous');
  assert.match(task.goal, /qq 消息联动/);
  await runtime.dispose();
});
