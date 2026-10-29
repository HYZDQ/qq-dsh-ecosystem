// 电脑操控自检项（§11.2）单测：六项检查的通过/失败/告警语义，纯只读（不拉起驱动、不创建文件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerComputerChecks } from '../computer/diagnostics.mjs';
import { defaultPolicy } from '../computer/policy.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// 复刻 runDiagnostics 的 check 注册器语义：返回值直接进报告，抛错按 UNAVAILABLE 兜底。
function collector() {
  const checks = [];
  return {
    checks,
    async check(id, label, action) {
      try {
        const value = await action();
        checks.push({ id, label, status: value.warning ? 'warning' : 'pass', ...value });
      } catch {
        checks.push({ id, label, status: 'fail', code: `${id.toUpperCase()}_UNAVAILABLE`, message: '检查未完成。' });
      }
    },
    find(id) { return checks.find((item) => item.id === id); },
  };
}

function writePolicy(stateDir, patch = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), JSON.stringify({ ...defaultPolicy(), apps: ['notepad.exe'], control: { channel: 'private', adminIds: ['12345'] }, ...patch }));
}

test('§11.2 六项自检：健康态全过，语义与失败码对齐文档', async () => {
  const stateDir = tmp('diag-ok-');
  writePolicy(stateDir);
  const c = collector();
  await registerComputerChecks(c.check, { stateDir, sessionProbe: () => false, probePython: () => '3.11.0' });
  assert.deepEqual(c.checks.map((item) => item.id), [
    'computer_uv', 'computer_python', 'computer_mcp', 'computer_toolset', 'computer_policy', 'computer_session', 'computer_runtime',
  ]);
  for (const item of c.checks) assert.notEqual(item.status, 'fail', JSON.stringify(item));
  assert.equal(c.find('computer_policy').code, 'POLICY_OK');
  assert.equal(c.find('computer_session').status, 'pass');
  assert.match(c.find('computer_mcp').message, /懒启动|未启动/, '自检不得冷启动驱动（回归网 2）');
});

test('§11.2 失败码：PYTHON_TOO_OLD / MCP_START_FAILED / POLICY_INVALID / SESSION_LOCKED / STOP_ACTIVE', async () => {
  const stateDir = tmp('diag-fail-');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'policy.json'), '{broken');
  fs.writeFileSync(path.join(stateDir, 'drivers.json'), JSON.stringify({ status: 'failed', restarts: 2 }));
  fs.writeFileSync(path.join(stateDir, 'STOP'), 'x');
  const c = collector();
  await registerComputerChecks(c.check, { stateDir, sessionProbe: () => true, probePython: () => '3.8.0' });
  assert.equal(c.find('computer_python').code, 'PYTHON_TOO_OLD');
  assert.equal(c.find('computer_mcp').code, 'MCP_START_FAILED');
  assert.equal(c.find('computer_policy').code, 'POLICY_INVALID');
  assert.equal(c.find('computer_session').code, 'SESSION_LOCKED');
  assert.equal(c.find('computer_session').status, 'fail');
  assert.equal(c.find('computer_runtime').code, 'STOP_ACTIVE');
  assert.equal(c.find('computer_runtime').status, 'warning');
  assert.ok(c.find('computer_policy').resolution.steps.length, '失败项必须带处理建议');
});

test('§11.2 告警态：adminIds/apps 为空 fail-closed 告警；工具白名单泄漏即失败', async () => {
  const stateDir = tmp('diag-warn-');
  writePolicy(stateDir, { apps: [], control: { channel: 'private', adminIds: [] } });
  const c = collector();
  await registerComputerChecks(c.check, { stateDir, sessionProbe: () => false });
  const policy = c.find('computer_policy');
  assert.equal(policy.status, 'warning');
  assert.equal(policy.code, 'POLICY_RESTRICTED');
  assert.match(policy.message, /fail-closed/);
  assert.equal(c.find('computer_python').message.includes('uv 管理'), true, 'PATH 无 python 时不算失败');

  // 损坏的 drivers.json → MCP_START_FAILED
  fs.writeFileSync(path.join(stateDir, 'drivers.json'), 'not-json');
  const c2 = collector();
  await registerComputerChecks(c2.check, { stateDir, sessionProbe: () => false });
  assert.equal(c2.find('computer_mcp').code, 'MCP_START_FAILED');
});
