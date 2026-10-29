import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DEFINITIONS } from '../tool-definitions.mjs';
import { COMPUTER_TOOL_DEFINITIONS, COMPUTER_WRITE_TOOLS, COMPUTER_TASK_TOOLS, COMPUTER_L2_TOOL_DEFINITIONS } from '../computer/tool-definitions.mjs';
import { ALLOWED_DRIVER_TOOLS, FORBIDDEN_DRIVER_TOOLS } from '../computer/policy.mjs';
import { validateShortcut } from '../computer/act.mjs';
import { assertSafeToolset } from '../computer/driver.mjs';
import { ComputerRuntime } from '../computer/runtime.mjs';

// 回归网 1（docs/computer-agent-development.md §13）：安装后 TOOL_DEFINITIONS 数量与顺序不变。
const GOLDEN_TOOL_NAMES = [
  'douyin_open', 'douyin_search', 'douyin_open_video', 'douyin_next', 'douyin_previous',
  'douyin_status', 'douyin_observe', 'douyin_screenshot', 'douyin_pause', 'douyin_play',
  'douyin_remember', 'douyin_recall',
  'douyin_chat_contacts', 'douyin_chat_status', 'douyin_chat_start', 'douyin_chat_stop', 'douyin_chat_read', 'douyin_chat_observe',
  'douyin_video_limits_status', 'douyin_media_status', 'douyin_listen', 'douyin_forward_video',
  'douyin_persona_status', 'douyin_interest_record',
  'douyin_watch_status', 'douyin_watch_start', 'douyin_watch_stop',
  'douyin_spark_status', 'douyin_spark_start', 'douyin_spark_stop',
  'douyin_report_status', 'douyin_report_generate',
  'douyin_diagnostics', 'douyin_diagnostics_repair',
];

test('契约：TOOL_DEFINITIONS 数量与顺序不变，computer_* 只追加独立分组', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((item) => item.name), GOLDEN_TOOL_NAMES);
  const computerNames = COMPUTER_TOOL_DEFINITIONS.map((item) => item.name);
  assert.deepEqual(computerNames, [
    'computer_status', 'computer_screen', 'computer_observe', 'computer_wait', 'computer_receipts', 'computer_windows',
    'computer_click', 'computer_type', 'computer_key', 'computer_move', 'computer_scroll', 'computer_drag', 'computer_clipboard',
    'computer_browser_observe', 'computer_browser_open', 'computer_browser_click', 'computer_browser_fill', 'computer_browser_download',
    'computer_task_status', 'computer_task_plan', 'computer_task_start', 'computer_task_pause', 'computer_task_resume', 'computer_task_stop',
  ]);
  for (const name of computerNames) assert.match(name, /^computer_/);
  for (const name of GOLDEN_TOOL_NAMES) assert.ok(!computerNames.includes(name), `computer 分组不得覆盖存量工具：${name}`);
});

test('契约：L3 能力永不注册（Shell/注册表/进程/文件系统/系统设置）', () => {
  for (const definition of COMPUTER_TOOL_DEFINITIONS) {
    for (const banned of ['shell', 'registry', 'process', 'settings', 'powershell', 'file']) {
      assert.ok(!definition.name.toLowerCase().includes(banned), `工具名不得包含高危能力：${definition.name}`);
    }
  }
  assert.deepEqual([...COMPUTER_WRITE_TOOLS].sort(), [
    'computer_browser_click', 'computer_browser_download', 'computer_browser_fill', 'computer_browser_open',
    'computer_click', 'computer_clipboard', 'computer_drag', 'computer_key',
    'computer_move', 'computer_scroll', 'computer_type', 'computer_windows',
  ]);
});

test('契约：驱动映射层只走白名单，高危驱动工具永不可达', () => {
  assert.equal(assertSafeToolset([...ALLOWED_DRIVER_TOOLS]), true);
  for (const name of FORBIDDEN_DRIVER_TOOLS) {
    assert.ok(!ALLOWED_DRIVER_TOOLS.includes(name), `白名单不得包含高危驱动工具：${name}`);
    assert.throws(() => assertSafeToolset([name]), (error) => error.code === 'TOOLSET_LEAK');
  }
  for (const required of ['Snapshot', 'Screenshot', 'Click', 'Type', 'Shortcut', 'App']) {
    assert.ok(ALLOWED_DRIVER_TOOLS.includes(required), `P0 映射需要驱动工具：${required}`);
  }
});

test('契约：写工具描述带管理员与确认令牌约束（提示词层防线）', () => {
  for (const name of COMPUTER_WRITE_TOOLS) {
    const definition = COMPUTER_TOOL_DEFINITIONS.find((item) => item.name === name);
    assert.ok(definition.description.includes('确认'), `${name} 描述需包含确认流程`);
  }
  const click = COMPUTER_TOOL_DEFINITIONS.find((item) => item.name === 'computer_click');
  assert.ok(click.description.includes('管理员'));
  assert.ok(click.parameters.properties.confirmToken, '写工具必须声明 confirmToken 参数');
  for (const name of COMPUTER_TASK_TOOLS) {
    const definition = COMPUTER_TOOL_DEFINITIONS.find((item) => item.name === name);
    assert.ok(definition.description.includes('管理员'), `${name} 描述需包含管理员限制`);
  }
});

test('契约：computer_wait 归 L0（无确认令牌）；关闭窗口只允许 close 受控通道', () => {
  const wait = COMPUTER_TOOL_DEFINITIONS.find((item) => item.name === 'computer_wait');
  assert.ok(!COMPUTER_WRITE_TOOLS.includes('computer_wait'), '纯等待无桌面副作用，不得按写工具走确认');
  assert.equal(wait.parameters.properties.confirmToken, undefined);
  const windows = COMPUTER_TOOL_DEFINITIONS.find((item) => item.name === 'computer_windows');
  assert.ok(windows.parameters.properties.action.enum.includes('close'));
  // 回归网：模型侧快捷键白名单必须继续拒绝 alt+f4，关闭窗口仅 computer_windows close 内部通道可发。
  assert.throws(() => validateShortcut('alt+f4'), (error) => error.code === 'TITLE_DENIED');
});

test('契约：创建的工具定义与目录一致，输出走统一原生 schema', async () => {
  const { createComputerToolDefinitions } = await import('../dsh-plugin.mjs');
  const definitions = createComputerToolDefinitions({ ctx: {}, getRuntime: async () => { throw new Error('不应触发'); } });
  assert.equal(definitions.length, COMPUTER_TOOL_DEFINITIONS.length);
  assert.deepEqual(definitions.map((item) => item.name), COMPUTER_TOOL_DEFINITIONS.map((item) => item.name));
  for (const definition of definitions) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.output.schema.required.includes('imageStatus'), true);
  }
  // L2（§8.3）只在 includeL2（profile=power）时追加，且不进常驻目录金名单。
  const withL2 = createComputerToolDefinitions({ ctx: {}, getRuntime: async () => { throw new Error('不应触发'); }, includeL2: true });
  assert.equal(withL2.length, COMPUTER_TOOL_DEFINITIONS.length + COMPUTER_L2_TOOL_DEFINITIONS.length);
  for (const definition of COMPUTER_L2_TOOL_DEFINITIONS) {
    assert.ok(!COMPUTER_TOOL_DEFINITIONS.includes(definition), 'L2 定义不得混入常驻目录');
  }
});

test('回归网 2：关闭状态不产生 computer/drivers.json、不启动 Python', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-closed-'));
  const runtime = new ComputerRuntime({
    stateDir,
    driverFactory: () => { throw new Error('关闭状态不得创建驱动'); },
  });
  const status = await runtime.execute('computer_status', {});
  assert.equal(status.ok, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'drivers.json')), false);
  await runtime.dispose();
});
