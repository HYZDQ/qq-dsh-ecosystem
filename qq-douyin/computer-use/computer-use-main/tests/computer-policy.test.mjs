import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPolicy, loadPolicy, updatePolicy, assertAdminControl, checkWriteAllowed, CircuitBreaker, stopRequested, fail } from '../computer/policy.mjs';
import { ConfirmStore, hashArgs } from '../computer/confirm.mjs';
import { AuditLog } from '../computer/audit.mjs';
import { validateShortcut, targetArgs, typeArgs, describeTarget, scrollArgs, dragArgs } from '../computer/act.mjs';
import { parseSnapshotText, buildObservation } from '../computer/perceive.mjs';
import { parseTasklistCsv, mergeWindows } from '../computer/window-discovery.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';
import { WindowsMcpDriver, assertSafeToolset, normalizeResult } from '../computer/driver.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const SNAPSHOT_SAMPLE = `
    Cursor Position: (1495, 829)

    Active Desktop:
    Name
---------
Desktop 1

    Focused Window:
    Name              Depth  Status       Width    Height     Handle
--------------  -------  ---------  -------  --------  ---------
无标题 - 记事本       12  Maximized     1200      800  12345678

    Opened Windows:
    Name                            Depth  Status       Width    Height     Handle
------------------------------  -------  ---------  -------  --------  ---------
无标题 - 记事本                       12  Maximized     1200      800  12345678
Agent [管理员]                       17  Minimized        0         0  599723952

    List of Interactive Elements:
    # id|window|control_type|name|coords|metadata
0|无标题 - 记事本|编辑|文本编辑器|(600,400)|{"has_focused": 1}
1|无标题 - 记事本|菜单|文件|(60,10)|{"has_focused": 0}

    List of Scrollable Elements:
    No scrollable elements`;

function adminPolicy(stateDir, { adminIds = ['12345'], apps = ['notepad.exe'] } = {}) {
  const policy = { ...defaultPolicy(), apps, control: { channel: 'private', adminIds } };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify(policy));
  return policy;
}

function fakeDriver(sample = SNAPSHOT_SAMPLE) {
  const calls = [];
  return {
    calls, child: { pid: 4242 }, restarts: 0,
    // 与 driver.normalizeResult 后的形状一致：text 为已解包的纯文本。
    async callTool(name, args) { calls.push({ name, args }); return { ok: true, text: sample, frames: [] }; },
    async close() {},
  };
}

test('策略默认 fail-closed：apps 为空拒绝全部写操作', () => {
  const stateDir = tmp('computer-policy-');
  const policy = defaultPolicy();
  assert.deepEqual(policy.apps, []);
  assert.throws(() => checkWriteAllowed(policy, stateDir), (error) => error.code === 'TARGET_NOT_ALLOWED');
});

test('updatePolicy（设置页 P2）：白名单字段合并落盘，非法输入 POLICY_INVALID 不落盘', () => {
  const stateDir = tmp('computer-update-');
  const next = updatePolicy(stateDir, { enabled: true, profile: 'power', apps: ['notepad.exe'], control: { adminIds: ['12345'] } });
  assert.equal(next.profile, 'power');
  assert.deepEqual(next.apps, ['notepad.exe']);
  assert.deepEqual(loadPolicy(stateDir).policy.control.adminIds, ['12345']);
  // 部分更新不影响其他字段
  const patched = updatePolicy(stateDir, { apps: ['calc.exe'] });
  assert.equal(patched.profile, 'power');
  assert.deepEqual(patched.apps, ['calc.exe']);
  assert.throws(() => updatePolicy(stateDir, { profile: 'god' }), (error) => error.code === 'POLICY_INVALID');
  assert.throws(() => updatePolicy(stateDir, { apps: 'not-array' }), (error) => error.code === 'POLICY_INVALID');
  assert.throws(() => updatePolicy(stateDir, { control: { channel: 'group' } }), (error) => error.code === 'POLICY_INVALID');
  // 非法更新不落盘：仍是上一次合法值
  assert.deepEqual(loadPolicy(stateDir).policy.apps, ['calc.exe']);
});

test('adminIds 为空或来源不合法一律 NOT_ADMIN（9.3 红线）', () => {
  const base = { ...defaultPolicy(), control: { channel: 'private', adminIds: ['12345'] } };
  assert.equal(assertAdminControl(base, { channel: 'private', id: '12345' }), true);
  assert.equal(assertAdminControl(base, { channel: 'private', id: 12345 }), true);
  assert.throws(() => assertAdminControl(base, undefined), (error) => error.code === 'NOT_ADMIN');
  assert.throws(() => assertAdminControl(base, { channel: 'group', id: '12345' }), (error) => error.code === 'NOT_ADMIN');
  assert.throws(() => assertAdminControl(base, { channel: 'private', id: '99999' }), (error) => error.code === 'NOT_ADMIN');
  const empty = { ...defaultPolicy(), control: { channel: 'private', adminIds: [] } };
  assert.throws(() => assertAdminControl(empty, { channel: 'private', id: '12345' }), (error) => error.code === 'NOT_ADMIN');
});

test('policy.json：缺失时落盘默认值；channel 非 private 视为非法并恢复默认', () => {
  const stateDir = tmp('computer-load-');
  const first = loadPolicy(stateDir);
  assert.equal(first.invalid, false);
  assert.equal(first.policy.control.channel, 'private');
  assert.ok(fs.existsSync(path.join(stateDir, 'policy.json')));
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify({ control: { channel: 'group', adminIds: ['1'] } }));
  const second = loadPolicy(stateDir);
  assert.equal(second.invalid, true);
  assert.equal(second.policy.control.channel, 'private');
  fs.writeFileSync(path.join(stateDir, 'policy.json'), '{broken');
  assert.equal(loadPolicy(stateDir).invalid, true);
});

test('写操作闸门：未开启/STOP 急停/标题黑名单', () => {
  const stateDir = tmp('computer-gate-');
  const policy = { ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['1'] } };
  assert.equal(checkWriteAllowed(policy, stateDir, { title: '无标题 - 记事本' }), true);
  assert.throws(() => checkWriteAllowed({ ...policy, enabled: false }, stateDir, { title: 'x' }), (error) => error.code === 'COMPUTER_DISABLED');
  assert.throws(() => checkWriteAllowed(policy, stateDir, { title: '1Password - 保险库' }), (error) => error.code === 'TITLE_DENIED');
  fs.writeFileSync(path.join(stateDir, 'STOP'), '1');
  assert.equal(stopRequested(stateDir), true);
  assert.throws(() => checkWriteAllowed(policy, stateDir, { title: '记事本' }), (error) => error.code === 'COMPUTER_DISABLED');
});

test('熔断：连续 2 次基础设施失败熔断 30 分钟，成功即清零', () => {
  let t = 1_000;
  const breaker = new CircuitBreaker({ now: () => t });
  breaker.check();
  breaker.recordFailure();
  breaker.check();
  breaker.recordFailure();
  assert.equal(breaker.state().open, true);
  assert.throws(() => breaker.check(), (error) => error.code === 'CIRCUIT_OPEN');
  t += 30 * 60_000 + 1;
  assert.equal(breaker.state().open, false);
  breaker.recordFailure();
  breaker.recordSuccess();
  breaker.recordFailure();
  assert.equal(breaker.state().open, false);
});

test('确认令牌：单次使用、TTL 60 秒、绑定参数变化即失效', () => {
  const stateDir = tmp('computer-confirm-');
  let t = 10_000;
  const store = new ConfirmStore({ stateDir, now: () => t });
  const argsHash = hashArgs({ action: 'click', target: '标注 0' });
  const issued = store.issue({ tool: 'computer_click', argsHash, summary: '点击 保存' });
  assert.ok(issued.token);
  assert.throws(() => store.consume({ tool: 'computer_click', argsHash, token: 'wrong' }), (error) => error.code === 'CONFIRM_MISMATCH');
  assert.equal(store.consume({ tool: 'computer_click', argsHash, token: issued.token }), true);
  assert.throws(() => store.consume({ tool: 'computer_click', argsHash, token: issued.token }), (error) => error.code === 'CONFIRM_MISMATCH');

  const second = store.issue({ tool: 'computer_click', argsHash, summary: '点击 保存' });
  assert.throws(() => store.consume({ tool: 'computer_click', argsHash: 'changed', token: second.token }), (error) => error.code === 'CONFIRM_MISMATCH');

  const third = store.issue({ tool: 'computer_click', argsHash, summary: '点击 保存' });
  t += 61_000;
  assert.throws(() => store.consume({ tool: 'computer_click', argsHash, token: third.token }), (error) => error.code === 'CONFIRM_EXPIRED');
});

test('收据：GUI 写动作每次记新收据；allowDuplicate=false 才 24h 去重', () => {
  const stateDir = tmp('computer-receipt-');
  let t = 100_000;
  const audit = new AuditLog({ stateDir, now: () => t });
  const key = { tool: 'computer_click', action: 'click', target: '标注 0', textHash: 'abc' };
  const first = audit.receipt({ ...key, app: '记事本', ok: true, verified: true });
  assert.equal(first.deduped, false);
  // GUI 重复点击合法：默认每次执行都记新收据，只是标注 duplicateOf。
  const second = audit.receipt({ ...key, app: '记事本', ok: true, verified: true });
  assert.equal(second.deduped, false);
  assert.equal(second.duplicateOf, first.receiptId);
  assert.notEqual(second.receiptId, first.receiptId);
  // 对外发送类一次性动作用 allowDuplicate=false：24h 内返回既有收据。
  const send = { tool: 'computer_task_stop', action: 'task_stop', target: 'tsk-1', textHash: 'x' };
  const sendFirst = audit.receipt({ ...send, ok: true, verified: true, allowDuplicate: false });
  const sendSecond = audit.receipt({ ...send, ok: true, verified: true, allowDuplicate: false });
  assert.equal(sendSecond.deduped, true);
  assert.equal(sendSecond.receiptId, sendFirst.receiptId);
  t += 24 * 60 * 60_000 + 1;
  const sendThird = audit.receipt({ ...send, ok: true, verified: true, allowDuplicate: false });
  assert.equal(sendThird.deduped, false);
  assert.notEqual(sendThird.receiptId, sendFirst.receiptId);
});

test('快捷键白名单：常用组合放行，系统级危险组合拒绝', () => {
  assert.equal(validateShortcut('ctrl+s'), 'ctrl+s');
  assert.equal(validateShortcut('Shift + F3'), 'shift+f3');
  assert.equal(validateShortcut('enter'), 'enter');
  for (const denied of ['alt+f4', 'win+l', 'ctrl+alt+delete', 'ctrl+shift+esc', 'win+r']) {
    assert.throws(() => validateShortcut(denied), (error) => error.code === 'TITLE_DENIED', denied);
  }
  assert.throws(() => validateShortcut('hyper+x'), (error) => error.code === 'INPUT_UNSUPPORTED');
  assert.throws(() => validateShortcut(''), (error) => error.code === 'INPUT_UNSUPPORTED');
});

test('目标参数：label 与坐标二选一，描述不含明文长文本', () => {
  assert.deepEqual(targetArgs({ label: 3 }), { label: 3 });
  assert.deepEqual(targetArgs({ x: 10, y: 20 }), { loc: [10, 20] });
  assert.throws(() => targetArgs({}), (error) => error.code === 'ELEMENT_NOT_FOUND');
  assert.deepEqual(typeArgs({ text: '你好', label: 1, replace: true }), { text: '你好', label: 1, clear: true, caret_position: 'end' });
  assert.match(describeTarget({ label: 2, elementName: '保存' }), /保存/);
});

test('滚动/拖拽参数：方向映射、次数边界、from/to 二元校验', () => {
  assert.deepEqual(scrollArgs({ direction: 'down', times: 2, label: 5 }), { label: 5, type: 'vertical', direction: 'down', wheel_times: 2 });
  assert.deepEqual(scrollArgs({ direction: 'left', x: 10, y: 20 }), { loc: [10, 20], type: 'horizontal', direction: 'left', wheel_times: 1 });
  assert.deepEqual(scrollArgs({}), { type: 'vertical', direction: 'down', wheel_times: 1 }, '无目标时在当前光标位置滚动');
  assert.throws(() => scrollArgs({ direction: 'diagonal' }), (error) => error.code === 'INPUT_UNSUPPORTED');
  assert.throws(() => scrollArgs({ times: 0 }), (error) => error.code === 'INPUT_UNSUPPORTED');
  assert.deepEqual(dragArgs({ from: { label: 1 }, to: { x: 5, y: 6 } }), { from: { label: 1 }, to: { loc: [5, 6] } });
  assert.throws(() => dragArgs({ from: { label: 1 } }), (error) => error.code === 'ELEMENT_NOT_FOUND');
  assert.throws(() => dragArgs({ from: {}, to: {} }), (error) => error.code === 'ELEMENT_NOT_FOUND');
});

test('窗口发现三源合并：进程表解析剔噪、焦点窗口优先、按标题去重（§4.3）', () => {
  const csv = [
    '"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"',
    '"wps.exe","45952","Console","1","100,000 K","Running","user","0:00:00","工作簿1 - WPS Office"',
    '"notepad.exe","111","Console","1","10,000 K","Running","user","0:00:00","无标题 - 记事本"',
    '"foo.exe","222","Console","1","10,000 K","Running","user","0:00:00","OleMainThreadWndName"',
    '"bar.exe","333","Console","1","10,000 K","Running","user","0:00:00","N/A"',
    '"baz.exe","444","Console","1","10,000 K","Running","user","0:00:00","{2A335767-FC94-417F-ABC4-B4122ADBEE60}"',
  ].join('\n');
  const rows = parseTasklistCsv(csv);
  assert.deepEqual(rows.map((item) => item.title), ['工作簿1 - WPS Office', '无标题 - 记事本'], '消息窗/占位窗必须剔除');

  // 现网形态：WPS 窗口只出现在 Focused Window，Opened Windows 漏行——合并后可见。
  const focus = { title: '工作簿1 - WPS Office', handle: 3149288, status: 'Maximized', width: 2560, height: 1599 };
  const merged = mergeWindows({ focus, listed: [{ app: 'QQ', title: 'QQ', handle: 656732, focused: false }], processes: rows });
  assert.deepEqual(merged.map((item) => item.title), ['工作簿1 - WPS Office', 'QQ', '无标题 - 记事本']);
  assert.equal(merged[0].source, 'uia-focus');
  assert.equal(merged[0].focused, true);
  assert.equal(merged[2].source, 'process');
  assert.equal(merged[2].handle, null);
});

test('Snapshot 解析：焦点窗口、窗口列表与元素标注坐标', () => {
  const parsed = parseSnapshotText(SNAPSHOT_SAMPLE);
  assert.equal(parsed.activeWindow.title, '无标题 - 记事本');
  assert.equal(parsed.activeWindow.handle, 12345678);
  assert.equal(parsed.windows.length, 2);
  assert.deepEqual(parsed.cursor, [1495, 829]);
  assert.equal(parsed.elements.length, 2);
  assert.deepEqual(parsed.elements[0].point, [600, 400]);
  assert.equal(parsed.elements[0].focused, true);
  assert.equal(parsed.elements[1].name, '文件');
  const observation = buildObservation(parsed);
  assert.equal(observation.perceptionPath, 'uia');
  assert.equal(observation.ok, true);
  assert.equal(observation.windows[0].focused, true);
});

test('驱动白名单：高危工具映射即 TOOLSET_LEAK，调用前拦截', async () => {
  assert.equal(assertSafeToolset(['Snapshot', 'Click']), true);
  assert.throws(() => assertSafeToolset(['Snapshot', 'Registry']), (error) => error.code === 'TOOLSET_LEAK');
  const driver = new WindowsMcpDriver({
    stateDir: tmp('computer-driver-'), command: 'uvx-never',
    spawnImpl: () => { throw new Error('不应启动子进程'); },
  });
  await assert.rejects(driver.callTool('PowerShell', { command: 'dir' }), (error) => error.code === 'TOOLSET_LEAK');
  await assert.rejects(driver.callTool('Registry', { mode: 'get' }), (error) => error.code === 'TOOLSET_LEAK');
  const normalized = normalizeResult({ content: [{ type: 'text', text: '["行一","行二"]' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] });
  assert.equal(normalized.text, '行一\n行二');
  assert.equal(normalized.frames.length, 1);
});

test('运行时关闭/未观察状态不落盘 drivers.json，status 不拉起驱动', async () => {
  const stateDir = tmp('computer-idle-');
  adminPolicy(stateDir);
  const driver = fakeDriver();
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const status = await runtime.execute('computer_status', {});
  assert.equal(status.ok, true);
  assert.equal(status.enabled, true);
  assert.equal(status.adminConfigured, true);
  assert.equal(driver.calls.length, 0);
  assert.equal(fs.existsSync(path.join(stateDir, 'drivers.json')), false);
  await runtime.dispose();
});

test('运行时写操作全流程：needsConfirm → 携带令牌执行 → 收据去重', async () => {
  const stateDir = tmp('computer-flow-');
  adminPolicy(stateDir);
  const driver = fakeDriver();
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const actor = { channel: 'private', id: '12345' };

  const first = await runtime.execute('computer_click', { label: 1 }, { actor });
  assert.equal(first.needsConfirm, true);
  assert.ok(first.confirmToken);
  assert.match(first.summary, /computer_click/);
  // 首次调用允许只读观察（生成摘要与标题黑名单校验），但绝不能发生写动作。
  assert.equal(driver.calls.filter((call) => call.name === 'Click').length, 0);

  const second = await runtime.execute('computer_click', { label: 1, confirmToken: first.confirmToken }, { actor });
  assert.equal(second.ok, true);
  assert.equal(second.deduped, false);
  assert.ok(second.receiptId);
  assert.equal(second.verified, true);
  assert.equal(driver.calls.some((call) => call.name === 'Click' && call.args.label === 1), true);

  // GUI 重复操作合法：第三次同样参数照常执行（各自独立收据），不会被去重跳过。
  const third = await runtime.execute('computer_click', { label: 1 }, { actor });
  assert.equal(third.needsConfirm, true);
  const thirdDone = await runtime.execute('computer_click', { label: 1, confirmToken: third.confirmToken }, { actor });
  assert.equal(thirdDone.ok, true);
  assert.notEqual(thirdDone.receiptId, second.receiptId);
  assert.equal(driver.calls.filter((call) => call.name === 'Click').length, 2);

  const keyFirst = await runtime.execute('computer_key', { keys: 'ctrl+s' }, { actor });
  assert.equal(keyFirst.needsConfirm, true);
  const keyDone = await runtime.execute('computer_key', { keys: 'ctrl+s', confirmToken: keyFirst.confirmToken }, { actor });
  assert.equal(keyDone.ok, true);
  assert.equal(driver.calls.some((call) => call.name === 'Shortcut' && call.args.shortcut === 'ctrl+s'), true);
  await runtime.dispose();
});

test('运行时新工具：move/scroll/drag 走确认收据，wait/receipts 归 L0，close 先核验焦点再发关闭键', async () => {
  const stateDir = tmp('computer-extra-');
  adminPolicy(stateDir);
  const calls = [];
  let closed = false;
  const closedSample = SNAPSHOT_SAMPLE.split('无标题 - 记事本').join('已关闭窗口');
  const driver = {
    child: { pid: 1 }, restarts: 0, calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'Shortcut' && args.shortcut === 'alt+f4') closed = true;
      return { ok: true, text: closed ? closedSample : SNAPSHOT_SAMPLE, frames: [] };
    },
    async close() {},
  };
  // 进程表窗口源注入空实现：单测不依赖真机窗口（本机可能真开着「无标题 - 记事本」）。
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, processProbe: () => [], sessionProbe: () => false });
  const actor = { channel: 'private', id: '12345' };

  // move / scroll / drag：两段式确认 + 收据，驱动参数按映射展开。
  const move = await runtime.execute('computer_move', { label: 0 }, { actor });
  assert.equal(move.needsConfirm, true);
  const moveDone = await runtime.execute('computer_move', { label: 0, confirmToken: move.confirmToken }, { actor });
  assert.equal(moveDone.ok, true);
  assert.ok(moveDone.receiptId);
  assert.ok(calls.some((call) => call.name === 'Move' && call.args.label === 0 && !call.args.drag));

  const scroll = await runtime.execute('computer_scroll', { direction: 'down', times: 2 }, { actor });
  const scrollDone = await runtime.execute('computer_scroll', { direction: 'down', times: 2, confirmToken: scroll.confirmToken }, { actor });
  assert.equal(scrollDone.ok, true);
  assert.ok(calls.some((call) => call.name === 'Scroll' && call.args.wheel_times === 2 && call.args.type === 'vertical'));

  const drag = await runtime.execute('computer_drag', { from: { label: 0 }, to: { x: 5, y: 6 } }, { actor });
  const dragDone = await runtime.execute('computer_drag', { from: { label: 0 }, to: { x: 5, y: 6 } , confirmToken: drag.confirmToken }, { actor });
  assert.equal(dragDone.ok, true);
  const moveCalls = calls.filter((call) => call.name === 'Move');
  assert.deepEqual(moveCalls.at(-2).args, { label: 0 });
  assert.deepEqual(moveCalls.at(-1).args, { loc: [5, 6], drag: true });

  // wait / receipts：L0 无确认令牌、wait 不触达驱动。
  const before = calls.length;
  const waited = await runtime.execute('computer_wait', { ms: 5 });
  assert.equal(waited.ok, true);
  assert.equal(waited.waitedMs, 5);
  assert.equal(waited.needsConfirm, undefined);
  assert.equal(calls.length, before, 'computer_wait 不占用驱动');
  const receipts = await runtime.execute('computer_receipts', { limit: 50 });
  assert.equal(receipts.ok, true);
  assert.ok(receipts.receipts.length >= 3);
  assert.ok(receipts.receipts.every((item) => typeof item.textHash === 'string' && item.text === undefined));

  // close 受控通道：switch → 焦点核验 → alt+f4，顺序固定；关闭后窗口消失记 verified。
  const closing = await runtime.execute('computer_windows', { action: 'close', name: '无标题 - 记事本' }, { actor });
  assert.equal(closing.needsConfirm, true);
  const closed2 = await runtime.execute('computer_windows', { action: 'close', name: '无标题 - 记事本', confirmToken: closing.confirmToken }, { actor });
  assert.equal(closed2.ok, true);
  assert.equal(closed2.verified, true);
  const switchIndex = calls.findIndex((call) => call.name === 'App' && call.args.mode === 'switch');
  const altIndex = calls.findIndex((call) => call.name === 'Shortcut' && call.args.shortcut === 'alt+f4');
  assert.ok(switchIndex >= 0 && altIndex > switchIndex, '先 switch 再发 alt+f4');
  assert.equal(calls.filter((call) => call.name === 'Shortcut' && call.args.shortcut === 'alt+f4').length, 1);
  await runtime.dispose();
});

test('运行时拒绝路径：NOT_ADMIN、令牌绑定变化、危险快捷键', async () => {
  const stateDir = tmp('computer-deny-');
  adminPolicy(stateDir);
  const driver = fakeDriver();
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });

  const group = await runtime.execute('computer_click', { label: 1 }, { actor: { channel: 'group', id: '12345' } });
  assert.equal(group.code, 'NOT_ADMIN');
  const stranger = await runtime.execute('computer_click', { label: 1 }, { actor: { channel: 'private', id: '66' } });
  assert.equal(stranger.code, 'NOT_ADMIN');
  const missing = await runtime.execute('computer_click', { label: 1 }, {});
  assert.equal(missing.code, 'NOT_ADMIN');
  assert.equal(driver.calls.length, 0);

  const actor = { channel: 'private', id: '12345' };
  const issued = await runtime.execute('computer_click', { label: 1 }, { actor });
  const drifted = await runtime.execute('computer_click', { label: 2, confirmToken: issued.confirmToken }, { actor });
  assert.equal(drifted.code, 'CONFIRM_MISMATCH');

  const danger = await runtime.execute('computer_key', { keys: 'alt+f4' }, { actor });
  assert.equal(danger.code, 'TITLE_DENIED');
  await runtime.dispose();
});

test('运行时 fail-closed：adminIds 为空时写操作全部 NOT_ADMIN', async () => {
  const stateDir = tmp('computer-noadmin-');
  adminPolicy(stateDir, { adminIds: [] });
  const driver = fakeDriver();
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const result = await runtime.execute('computer_click', { label: 1 }, { actor: { channel: 'private', id: '12345' } });
  assert.equal(result.code, 'NOT_ADMIN');
  await runtime.dispose();
});

test('后置校验失败不计熔断：动作成功但校验超时，verified=false 且后续调用照常（§5.3）', async () => {
  const stateDir = tmp('computer-softverify-');
  adminPolicy(stateDir);
  let snapshotCount = 0;
  const driver = {
    child: { pid: 1 }, restarts: 0, calls: [],
    async callTool(name, args) {
      this.calls.push({ name, args });
      if (name === 'Snapshot') {
        snapshotCount += 1;
        if (snapshotCount === 3) throw fail('ACTION_TIMEOUT', '校验超时'); // 点击后的后置校验失败
      }
      return { ok: true, text: SNAPSHOT_SAMPLE, frames: [] };
    },
    async close() {},
  };
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const actor = { channel: 'private', id: '12345' };
  const first = await runtime.execute('computer_click', { label: 1 }, { actor });
  const second = await runtime.execute('computer_click', { label: 1, confirmToken: first.confirmToken }, { actor });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.verified, false);
  const after = await runtime.execute('computer_observe', {});
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(runtime.breaker.state().open, false);
  await runtime.dispose();
});

test('熔断贯通：连续基础设施失败后写操作返回 CIRCUIT_OPEN', async () => {
  const stateDir = tmp('computer-circuit-');
  adminPolicy(stateDir);
  const driver = {
    child: { pid: 1 }, restarts: 0, calls: [],
    async callTool(name) { throw fail('MCP_START_FAILED', '驱动未运行'); },
    async close() {},
  };
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const actor = { channel: 'private', id: '12345' };
  await runtime.execute('computer_observe', {}, { actor });
  await runtime.execute('computer_observe', {}, { actor });
  const blocked = await runtime.execute('computer_observe', {}, { actor });
  assert.equal(blocked.code, 'CIRCUIT_OPEN');
  await runtime.dispose();
});

test('未知工具直接拒绝（TOOLSET_LEAK），不落到驱动', async () => {
  const stateDir = tmp('computer-unknown-');
  adminPolicy(stateDir);
  const driver = fakeDriver();
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const result = await runtime.execute('computer_registry', { key: 'x' }, {});
  assert.equal(result.code, 'TOOLSET_LEAK');
  assert.equal(driver.calls.length, 0);
  await runtime.dispose();
});

test('运行时窗口写操作：name 不在 apps 白名单内 TARGET_NOT_ALLOWED', async () => {
  const stateDir = tmp('computer-launch-');
  adminPolicy(stateDir);
  const driver = fakeDriver();
  const runtime = new ComputerRuntime({ stateDir, driverFactory: () => driver, sessionProbe: () => false });
  const actor = { channel: 'private', id: '12345' };
  const denied = await runtime.execute('computer_windows', { action: 'launch', name: 'calc.exe' }, { actor });
  assert.equal(denied.code, 'TARGET_NOT_ALLOWED');
  assert.equal(driver.calls.length, 0);
  const allowed = await runtime.execute('computer_windows', { action: 'launch', name: 'NOTEPAD.EXE' }, { actor });
  assert.equal(allowed.needsConfirm, true);
  await runtime.dispose();
});
