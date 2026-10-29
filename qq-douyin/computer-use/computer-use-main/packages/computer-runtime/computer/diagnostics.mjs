// 电脑操控运行时自检项（§11.2 / §3.2）：注册进既有自检报告（diagnostics.mjs 的 runDiagnostics）。
// 原则：只读探测——不启动驱动子进程（回归网 2）、不执行写动作、不触发任务、不改任何文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPolicy } from './policy.mjs';
import { assertSafeToolset, resolveUvx } from './driver.mjs';
import { sessionLocked } from './session.mjs';

const resolution = (kind, steps = [], action) => ({ kind, steps, ...(action ? { action } : {}) });

// 由 runDiagnostics 传入它的 check(id, label, action) 注册器；返回值形状与既有检查一致。
export async function registerComputerChecks(check, { stateDir, env = process.env, sessionProbe = sessionLocked, probePython } = {}) {
  await check('computer_uv', 'uv 与驱动入口（§11.2）', () => {
    resolveUvx(env);
    return { message: 'uvx 可执行；windows-mcp 解释器由 uv 管理（懒启动，自检不拉起子进程）。' };
  });

  await check('computer_python', 'Python 解释器（§11.2）', () => {
    let version = null;
    if (probePython) version = probePython();
    else {
      try {
        const out = execFileSync('python', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        version = /^\D*(\d+\.\d+\.\d+)/.exec(String(out))?.[1] ?? null;
      } catch { version = null; }
    }
    if (!version) return { message: 'PATH 未发现 python；windows-mcp 解释器由 uv 管理，不受本机 Python 影响。' };
    const [major, minor] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && minor < 10)) {
      return { status: 'fail', code: 'PYTHON_TOO_OLD', message: `PATH 上的 Python ${version} 过旧（需要 3.10+）。`, resolution: resolution('user', ['windows-mcp 解释器由 uv 管理；本机 Python 请升级到 3.10+。']) };
    }
    return { message: `PATH Python ${version}；windows-mcp 实际解释器由 uv 管理。` };
  });

  await check('computer_mcp', 'windows-mcp 驱动会话（§11.2）', () => {
    const file = path.join(stateDir, 'drivers.json');
    if (!fs.existsSync(file)) return { message: '驱动未启动（按需懒启动，属正常；自检不冷启动）。' };
    let state = null;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = null; }
    if (!state) return { status: 'fail', code: 'MCP_START_FAILED', message: 'drivers.json 损坏，无法确认驱动状态。', resolution: resolution('user', ['删除 computer/drivers.json 后下次调用会重新拉起驱动。']) };
    if (state.status === 'failed') {
      return { status: 'fail', code: 'MCP_START_FAILED', message: `上次驱动启动失败（已自动重启 ${state.restarts ?? 0} 次）。`, resolution: resolution('user', ['检查 uv 与 windows-mcp 安装后重启 DSH。']) };
    }
    return { message: `驱动会话状态 ${state.status}（pid ${state.pid ?? '无'}）。`, evidence: { pid: state.pid ?? null, restarts: state.restarts ?? 0 } };
  });

  await check('computer_toolset', '驱动工具白名单（§11.2）', () => {
    assertSafeToolset();
    return { message: '高危驱动工具不在映射白名单，泄漏防护在位。' };
  });

  await check('computer_policy', '电脑操控策略（§11.2）', () => {
    const { policy, invalid } = loadPolicy(stateDir);
    if (invalid) {
      return { status: 'fail', code: 'POLICY_INVALID', message: 'policy.json 损坏或非法，已按默认值（fail-closed）处理。', resolution: resolution('user', ['在设置页「电脑操控」重新保存策略；修复前写操作一律拒绝。']) };
    }
    const gaps = [];
    if (!policy.control.adminIds.length) gaps.push('adminIds 为空：任务控制与写操作全部拒绝');
    if (!policy.apps.length) gaps.push('apps 白名单为空：写操作全部拒绝');
    return {
      status: gaps.length ? 'warning' : 'pass',
      code: gaps.length ? 'POLICY_RESTRICTED' : 'POLICY_OK',
      message: gaps.length ? `${gaps.join('；')}（fail-closed）。` : `profile=${policy.profile}，apps ${policy.apps.length} 项，管理员已配置。`,
      resolution: gaps.length ? resolution('user', ['在设置页「电脑操控」补齐管理员与应用白名单。']) : resolution('none'),
      evidence: { profile: policy.profile, enabled: policy.enabled === true, apps: policy.apps.length, adminConfigured: policy.control.adminIds.length > 0 },
    };
  });

  await check('computer_session', '桌面会话（§11.2）', () => {
    if (sessionProbe()) {
      return { status: 'fail', code: 'SESSION_LOCKED', message: '会话已锁定或安全桌面激活，写操作与自治触发都会被拦下。', resolution: resolution('user', ['解锁桌面后恢复任务（§6.4）。']) };
    }
    return { message: '会话未锁定。' };
  });

  await check('computer_runtime', '运行态：急停/熔断/调度', () => {
    const stop = fs.existsSync(path.join(stateDir, 'STOP'));
    let schedules = { enabled: false, count: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'schedules.json'), 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.schedules)) schedules = { enabled: parsed.enabled === true, count: parsed.schedules.length };
    } catch { /* 无调度文件或损坏：按未启用报告 */ }
    const parts = [];
    if (stop) parts.push('STOP 急停生效');
    parts.push(schedules.enabled ? `定时/事件触发已启用（${schedules.count} 条调度）` : '定时/事件触发未启用（默认）');
    return {
      status: stop ? 'warning' : 'pass',
      code: stop ? 'STOP_ACTIVE' : 'RUNTIME_OK',
      message: parts.join('；') + '。',
      resolution: stop ? resolution('user', ['确认无需急停后删除 computer/STOP 文件恢复。']) : resolution('none'),
      evidence: { stop, schedules },
    };
  });
}
