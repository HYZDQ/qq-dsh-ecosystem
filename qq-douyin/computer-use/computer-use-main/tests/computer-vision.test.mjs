// 视觉兜底闭环（§4.1 / P3）单测：闭环语义、预算、两次定位失败报人工、独立虚拟光标（定位不碰指针）、
// runtime 结构化优先 / 视觉兜底 / 策略开关 / VISION_UNAVAILABLE。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VisionFallback, captureFrame } from '../computer/vision.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { defaultPolicy } from '../computer/policy.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const FRAME = { mimeType: 'image/png', data: 'AAAA' };
const actor = { channel: 'private', id: '12345' };

test('闭环：截图→定位→提交→再截图确认；定位是纯像素计算不碰指针', async () => {
  const captured = [];
  const committed = [];
  const located = [];
  const vision = new VisionFallback({
    capture: async () => { captured.push(1); return FRAME; },
    locate: async ({ frame, target }) => {
      located.push({ sameFrame: frame === FRAME, target });
      return located.length === 1 ? { x: 100, y: 200 } : { x: 105, y: 205 };
    },
    commit: async (x, y) => { committed.push([x, y]); },
  });
  const result = await vision.cycle({ target: '点赞按钮' });
  assert.equal(result.ok, true);
  assert.equal(result.perceptionPath, 'vision');
  assert.equal(result.verified, true, '复核定位在原位附近 → verified');
  assert.deepEqual(committed, [[100, 200]], '提交只发生一次，且只在定位之后');
  assert.equal(captured.length, 2, '闭环两次截图（前后）');
  assert.ok(located.every((item) => item.sameFrame && item.target === '点赞按钮'));
});

test('闭环：连续两次定位失败即报人工；目标消失（gone）也算有效确认', async () => {
  const committed = [];
  const miss = new VisionFallback({
    capture: async () => FRAME,
    locate: async () => null,
    commit: async (x, y) => committed.push([x, y]),
  });
  await assert.rejects(() => miss.cycle({ target: '不存在' }), (error) => {
    assert.equal(error.code, 'ELEMENT_NOT_FOUND');
    assert.match(error.message, /人工/);
    return true;
  });
  assert.equal(committed.length, 0, '定位失败绝不点击');

  const gone = new VisionFallback({
    capture: async () => FRAME,
    locate: async ({ frame }) => (frame === FRAME ? { x: 10, y: 10 } : { gone: true }),
    commit: async () => {},
  });
  const result = await gone.cycle({ target: '关闭' });
  assert.equal(result.verified, true, '目标消失也算确认（如点击关闭）');
});

test('闭环：无视觉提供者 VISION_UNAVAILABLE；超预算 ACTION_TIMEOUT', async () => {
  await assert.rejects(() => new VisionFallback({ commit: async () => {} }).cycle({ target: 'x' }),
    (error) => error.code === 'VISION_UNAVAILABLE');

  let clock = 0;
  const slow = new VisionFallback({
    now: () => (clock += 9_000), // 每步 +9s，第二步起超 15s 预算（§1.6）
    capture: async () => FRAME,
    locate: async () => ({ x: 1, y: 1 }),
    commit: async () => {},
  });
  await assert.rejects(() => slow.cycle({ target: 'x' }), (error) => error.code === 'ACTION_TIMEOUT');
});

test('截图双通道：注入 capture 优先，无注入时驱动无帧走 PowerShell 兜底', async () => {
  const injected = await captureFrame({ capture: async () => FRAME });
  assert.equal(injected, FRAME);
  const fromDriver = await captureFrame({ driver: { callTool: async () => ({ ok: true, frames: [FRAME] }) } });
  assert.equal(fromDriver, FRAME);
});

// ── runtime 集成 ────────────────────────────────────────────────────────────

const SAMPLE_UIA = `
    Focused Window:
    Name              Depth  Status       Width    Height     Handle
--------------  -------  ---------  -------  --------  ---------
抖音 - Microsoft Edge    12  Maximized     1200      800  12345678

    Opened Windows:
    Name                            Depth  Status       Width    Height     Handle
------------------------------  -------  ---------  -------  --------  ---------
抖音 - Microsoft Edge                    12  Maximized     1200      800  12345678

    List of Interactive Elements:
    # id|window|control_type|name|coords|metadata
0|抖音 - Microsoft Edge|按钮|点赞按钮|(600,400)|{"has_focused": 1}
1|抖音 - Microsoft Edge|按钮|评论按钮|(600,500)|{"has_focused": 0}

    List of Scrollable Elements:
    No scrollable elements`;

function setup({ sample = SAMPLE_UIA, policyPatch = {}, visionLocate = null } = {}) {
  const stateDir = tmp('computer-vision-');
  const policy = { ...defaultPolicy(), apps: ['msedge.exe'], control: { channel: 'private', adminIds: ['12345'] }, ...policyPatch };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  const calls = [];
  const driver = {
    child: { pid: 1 }, restarts: 0, calls,
    async callTool(name, args) { calls.push({ name, args }); return { ok: true, text: sample, frames: [] }; },
    async close() {},
  };
  const runtime = new ComputerRuntime({
    stateDir, driverFactory: () => driver, sessionProbe: () => false, processProbe: () => [],
    visionLocate,
    visionCapture: async () => FRAME,
  });
  return { runtime, calls };
}

test('runtime：UIA 同名元素优先走结构化点击，视觉绝不进常规路径（§1.6）', async () => {
  let locateCalls = 0;
  const { runtime, calls } = setup({ visionLocate: async () => { locateCalls += 1; return { x: 1, y: 1 }; } });
  const first = await runtime.execute('computer_click', { target: '点赞' }, { actor });
  const done = await runtime.execute('computer_click', { target: '点赞', confirmToken: first.confirmToken }, { actor });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(locateCalls, 0, '有 UIA 同名元素时不得走视觉');
  assert.ok(calls.some((call) => call.name === 'Click'), '走的是结构化点击');
  await runtime.dispose();
});

test('runtime：UIA 盲区走视觉闭环，返回 perceptionPath=vision 与收据', async () => {
  const spots = [{ x: 300, y: 400 }, { x: 302, y: 402 }];
  let locateCalls = 0;
  const { runtime, calls } = setup({
    visionLocate: async () => spots[Math.min(locateCalls++, 1)],
  });
  const first = await runtime.execute('computer_click', { target: '神秘图标' }, { actor });
  assert.equal(first.needsConfirm, true);
  const done = await runtime.execute('computer_click', { target: '神秘图标', confirmToken: first.confirmToken }, { actor });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.perceptionPath, 'vision');
  assert.equal(done.x, 300);
  assert.equal(done.verified, true);
  assert.ok(done.receiptId);
  assert.ok(calls.some((call) => call.name === 'Click' && call.args.loc[0] === 300), '最终提交是坐标点击');
  await runtime.dispose();
});

test('runtime：视觉输入（type+target）提交走 Type；策略关/无提供者 VISION_UNAVAILABLE', async () => {
  const { runtime, calls } = setup({ visionLocate: async ({ target }) => (target ? { x: 50, y: 60 } : null) });
  const first = await runtime.execute('computer_type', { text: '你好', target: '搜索框' }, { actor });
  const done = await runtime.execute('computer_type', { text: '你好', target: '搜索框', confirmToken: first.confirmToken }, { actor });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.perceptionPath, 'vision');
  assert.ok(calls.some((call) => call.name === 'Type' && call.args.text === '你好' && call.args.loc[0] === 50));
  await runtime.dispose();

  const off = setup({ policyPatch: { allowVisionFallback: false }, visionLocate: async () => ({ x: 1, y: 1 }) });
  const denied = await off.runtime.execute('computer_click', { target: '神秘图标' }, { actor });
  assert.equal(denied.code, 'VISION_UNAVAILABLE', JSON.stringify(denied));
  await off.runtime.dispose();

  const none = setup();
  const missing = await none.runtime.execute('computer_click', { target: '神秘图标' }, { actor });
  assert.equal(missing.code, 'VISION_UNAVAILABLE');
  await none.runtime.dispose();
});
