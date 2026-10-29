// 电脑操控运行时（P0）：装配 policy / confirm / audit / driver，串行执行桌面动作。
// 设计要点（docs/computer-agent-development.md）：
// - 全部写操作过四道闸：策略（fail-closed）→ 管理员私聊校验（9.3）→ 确认令牌（9.3）→ 收据去重（9.5）
// - 动作后置校验只记录不重试；连续 2 次基础设施失败熔断 30 分钟；STOP 文件三路急停之一
// - 驱动懒启动：computer_status 与关闭状态绝不拉起 Python（§13 回归 2）
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadPolicy, checkWriteAllowed, checkBrowserWriteAllowed, assertAdminControl, CircuitBreaker, stopRequested, fail } from './policy.mjs';
import { ConfirmStore, hashArgs } from './confirm.mjs';
import { AuditLog } from './audit.mjs';
import { parseSnapshotText, buildObservation } from './perceive.mjs';
import { validateShortcut, targetArgs, describeTarget, typeArgs, scrollArgs, dragArgs } from './act.mjs';
import { WindowsMcpDriver, resolveUvx } from './driver.mjs';
import { probeProcessTitles, mergeWindows } from './window-discovery.mjs';
import { sessionLocked } from './session.mjs';
import { PackRegistry } from './packs/registry.mjs';
import { COMPUTER_WRITE_TOOLS, COMPUTER_L2_TOOLS } from './tool-definitions.mjs';
import { execFile, spawn } from 'node:child_process';
import { TaskStore } from './tasks/checkpoint.mjs';
import { TaskStateMachine, stepKeyOf, normalizeBudget, DEFAULT_BUDGET } from './tasks/state-machine.mjs';
import { ScheduleStore } from './tasks/schedules.mjs';
import { LocalScheduler } from './tasks/scheduler.mjs';
import { EventBridge } from './tasks/event-bridge.mjs';
import { VisionFallback, captureFrame } from './vision.mjs';
import { BrowserDriver } from './browser-driver.mjs';

const MUTATING_WINDOWS_ACTIONS = new Set(['launch', 'switch', 'resize']);
// 群聊红线（§9.3，2026-10-26 二次修订）：非管理员私聊/群聊只读这两个状态工具；
// 其余 computer_*（含只读观察）一律要求管理员私聊身份（真实身份由入口层传入 actor）。
const PUBLIC_READ_TOOLS = new Set(['computer_status', 'computer_task_status']);
// L2 系统设置页白名单（§8.3）：只「打开」页面，不修改任何系统开关。
const SETTINGS_PAGES = new Set(['display', 'sound', 'notifications', 'network', 'apps', 'privacy', 'update', 'bluetooth', 'power', 'storage', 'about']);

export class ComputerRuntime {
  constructor({ stateDir, driver = null, driverFactory, now = Date.now, env = process.env, processProbe = probeProcessTitles, sessionProbe = sessionLocked, visionLocate = null, visionCapture = null, browserDriver = null, getBrowserController = null } = {}) {
    if (!stateDir) throw fail('POLICY_INVALID', 'ComputerRuntime 需要 stateDir。');
    Object.assign(this, { stateDir, driver, driverFactory, now, env, processProbe, sessionProbe, visionLocate, visionCapture, browserDriver, getBrowserController });
    this.breaker = new CircuitBreaker({ now });
    this.confirm = new ConfirmStore({ stateDir, now });
    this.audit = new AuditLog({ stateDir, now });
    this.tasks = new TaskStore({ stateDir, now });
    this.machine = new TaskStateMachine({ store: this.tasks, now });
    // 领域包注册表（§7）：packs.json 启用清单 + 内置包；只做归属判断与领域提示注入。
    this.packs = new PackRegistry({ stateDir });
    // P3 定时/事件触发（§6.3）：schedules.json + 本地调度器；默认关，tick 自判开关。
    this.schedules = new ScheduleStore({ stateDir, now });
    this.scheduler = new LocalScheduler({
      store: this.schedules, now,
      onDue: (schedule, extra) => this.startScheduledTask(schedule, extra),
      checkPoll: (entry) => this.#pollConditionMet(entry),
    });
    this.scheduler.start();
    // 事件桥（§6.3 接线）：events/<type>.json 跨进程收件箱 → notifyEvent（qq-bridge/抖音落文件即触发）。
    this.eventBridge = new EventBridge({ stateDir, now, onEvent: (type, payload) => this.notifyEvent(type, payload) });
    this.eventBridge.start();
    // §6.2：进程重启后未终结任务进 interrupted，需显式恢复，不自动续跑。
    this.tasks.markInterrupted();
    // 会话标识：checkpoint 步骤幂等只跳过「之前会话」已完成的步骤（§6.5）。
    this.sessionKey = randomUUID();
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  #policy() {
    const { policy, invalid } = loadPolicy(this.stateDir);
    this.lastPolicyInvalid = invalid;
    return policy;
  }

  #driver() {
    if (this.disposed) throw fail('COMPUTER_DISABLED', '运行时已卸载。');
    this.driver ??= this.driverFactory ? this.driverFactory() : new WindowsMcpDriver({ stateDir: this.stateDir, env: this.env });
    return this.driver;
  }

  // 串行锁（§9.5）：同一时刻仅一个桌面动作。
  #serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  async #infra(call) {
    this.breaker.check();
    try {
      const result = await call();
      this.breaker.recordSuccess();
      return result;
    } catch (error) {
      if (['MCP_START_FAILED', 'ACTION_TIMEOUT', 'UV_NOT_FOUND'].includes(error?.code)) this.breaker.recordFailure();
      throw error;
    }
  }

  async #observeRaw() {
    try {
      return await this.#observeOnce();
    } catch (error) {
      // 只读观察允许一次自愈重试（§5.3「失败不重试」只约束写动作）；
      // 桌面窗口多/应用冷启动时 UIA 遍历偶发超时，重试成功即清零熔断计数，避免误熔断。
      return await this.#observeOnce();
    }
  }

  async #observeOnce() {
    const result = await this.#infra(() => this.#driver().callTool('Snapshot', { use_ui_tree: true, use_vision: false, use_annotation: true }, { timeoutMs: 45_000 }));
    if (!result.ok) throw fail('ACTION_TIMEOUT', `观察失败：${result.text.slice(0, 200)}`);
    return { parsed: parseSnapshotText(result.text), raw: result };
  }

  // 动作后置校验（§5.3）用的尽力观察：失败只影响 verified 标记，
  // 不计熔断、不重试——校验是尽力而为，不能反过来把正常调用熔断掉。
  async #softObserve() {
    try {
      const result = await this.#driver().callTool('Snapshot', { use_ui_tree: true, use_vision: false, use_annotation: true }, { timeoutMs: 45_000 });
      return result.ok ? parseSnapshotText(result.text) : null;
    } catch { return null; }
  }

  async execute(name, args = {}, { actor, signal } = {}) {
    const policy = this.#policy();
    if (!['computer_status'].includes(name) && !policy.enabled) throw fail('COMPUTER_DISABLED', '电脑操控运行时未开启。', '在设置里开启电脑操控。');
    try {
      // 身份闸（§9.3 红线）：显式传入 actor 的入口（QQ 等）一律按真实身份把关——
      // 群聊/非管理员私聊只有 computer_status / computer_task_status；其余需管理员私聊。
      // 不传 actor = 内部/控制台路径（沿用 adminActor 语义）。放在 try 内：失败按返回通道给 {ok:false,code}。
      if (actor && !PUBLIC_READ_TOOLS.has(name)) assertAdminControl(policy, actor);
      const result = await this.#serialize(() => {
        // 锁屏检测（§4.3/§6.4）：写操作与 L2 系统级在锁定会话下一律 SESSION_LOCKED，不猜测继续。
        if ((COMPUTER_WRITE_TOOLS.includes(name) || COMPUTER_L2_TOOLS.includes(name)) && this.sessionProbe()) {
          throw fail('SESSION_LOCKED', '会话已锁定或断开，写操作被拦下（§4.3）。', '解锁桌面后重试。');
        }
        return this.#dispatch(name, args, { actor, signal, policy });
      });
      this.audit.log({ tool: name, ok: result.ok !== false, code: result.code ?? null, target: result.target ?? null });
      return result;
    } catch (error) {
      const failure = { ok: false, tool: name, code: error?.code ?? 'ACTION_TIMEOUT', message: error?.message ?? String(error), hint: error?.hint };
      this.audit.log({ tool: name, ok: false, code: failure.code });
      // §4.3：命中锁定时把 running 任务转 paused，不带着半截状态继续猜。
      const task = this.tasks.current();
      if (failure.code === 'SESSION_LOCKED' && task?.status === 'running') {
        task.used.pausedAt = this.now();
        this.machine.transition(task, 'paused');
      }
      return failure;
    }
  }

  async #dispatch(name, args, { actor, signal, policy }) {
    switch (name) {
      case 'computer_status': return this.#status();
      case 'computer_task_plan': return this.#taskPlan(args, { actor, policy });
      case 'computer_screen': return this.#taskScoped(name, false, () => this.#screen(args));
      case 'computer_observe': return this.#taskScoped(name, false, () => this.#observe(args));
      case 'computer_windows': return this.#taskScoped(name, args.action !== 'list', () => this.#windows(args, { actor, signal, policy }));
      case 'computer_click': return this.#taskScoped(name, true, () => this.#write('click', args, { actor, signal, policy }));
      case 'computer_type': return this.#taskScoped(name, true, () => this.#write('type', args, { actor, signal, policy }));
      case 'computer_key': return this.#taskScoped(name, true, () => this.#write('key', args, { actor, signal, policy }));
      case 'computer_move': return this.#taskScoped(name, true, () => this.#write('move', args, { actor, signal, policy }));
      case 'computer_scroll': return this.#taskScoped(name, true, () => this.#write('scroll', args, { actor, signal, policy }));
      case 'computer_drag': return this.#taskScoped(name, true, () => this.#drag(args, { actor, signal, policy }));
      case 'computer_wait': return this.#taskScoped(name, false, () => this.#wait(args));
      case 'computer_receipts': return this.#taskScoped(name, false, () => this.#receipts(args));
      case 'computer_browser_observe': return this.#taskScoped(name, false, () => this.#browserObserve(args));
      case 'computer_browser_open': return this.#taskScoped(name, true, () => this.#browserWrite('open', args, { actor, signal, policy }));
      case 'computer_browser_click': return this.#taskScoped(name, true, () => this.#browserWrite('click', args, { actor, signal, policy }));
      case 'computer_browser_fill': return this.#taskScoped(name, true, () => this.#browserWrite('fill', args, { actor, signal, policy }));
      case 'computer_browser_download': return this.#taskScoped(name, true, () => this.#browserWrite('download', args, { actor, signal, policy }));
      case 'computer_clipboard': return this.#taskScoped(name, args.action === 'write', () => this.#clipboard(args, { actor, signal, policy }));
      case 'computer_task_status': return this.#taskStatus();
      case 'computer_task_start': return this.#taskStart(args, { actor, policy });
      case 'computer_task_pause': return this.#taskPause({ actor, policy });
      case 'computer_task_resume': return this.#taskResume({ actor, policy });
      case 'computer_task_stop': return this.#taskStop(args, { actor, policy });
      case 'computer_shell': return this.#taskScoped(name, true, () => this.#shell(args, { actor, signal, policy }));
      case 'computer_settings': return this.#taskScoped(name, true, () => this.#settings(args, { actor, signal, policy }));
      default: throw fail('TOOLSET_LEAK', `未知工具：${name}`);
    }
  }

  // 任务记账（§6.1 预算）：running 任务内每个工具调用记一步，写动作另计；超限自动暂停并 BUDGET_EXHAUSTED。
  async #taskScoped(name, write, run) {
    const task = this.tasks.current();
    if (task && task.status === 'running') this.machine.account(task, { write });
    return run();
  }

  #taskView(state) {
    if (!state) return { taskId: null, status: 'idle', message: '当前没有任务。' };
    const wallMs = this.now() - state.used.startedAt;
    return {
      taskId: state.taskId, goal: state.goal, status: state.status, mode: state.mode,
      createdAt: state.createdAt, result: state.result,
      budget: state.budget,
      used: { steps: state.used.steps, writes: state.used.writes, wallMs },
      remaining: {
        steps: Math.max(0, state.budget.maxSteps - state.used.steps),
        writes: Math.max(0, state.budget.maxWrites - state.used.writes),
        wallMs: Math.max(0, state.budget.maxWallMs - wallMs),
      },
      completedSteps: (state.completedStepKeys ?? []).length,
    };
  }

  // L0 只读任务状态（§8.1）：群聊可查（9.3 红线的只读上限之一）。
  #taskStatus() {
    return { ok: true, tool: 'computer_task_status', ...this.#taskView(this.tasks.current()) };
  }

  // P3 主干-分支路由（§7）：goal → 领域包 action → L1 步骤计划。只读规划，不执行任何动作。
  // 计划步骤经 DomainPack.assertPlanAllowed 越权自检（registry.planForGoal 内做）。
  async #taskPlan(args, { actor, policy }) {
    assertAdminControl(policy, actor);
    await this.packs.ready();
    const goal = String(args.goal ?? '').trim() || this.tasks.current()?.goal || '';
    if (!goal) throw fail('TASK_STATE', '规划需要任务目标：传 goal，或先 computer_task_start。');
    const routed = this.packs.planForGoal(goal);
    const packs = this.packs.list().map((item) => ({ id: item.id, actions: item.actions }));
    if (!routed) {
      return { ok: true, tool: 'computer_task_plan', goal, pack: null, action: null, steps: [], packs, note: '没有领域包认领这个目标；可用通用 computer_* 工具逐步完成。' };
    }
    return { ok: true, tool: 'computer_task_plan', goal, ...routed, packs };
  }

  // P3 定时/事件触发（§6.3）：触发源只决定「何时跑」；任务由管理员预先配置的 schedule 派生。
  // 四道闸：①策略开启且无 STOP ②预算归一 ③mode=autonomous（只可 L0/L1，L2 未注册不可达）
  // ④不可逆动作（§9.2）不在 L0/L1 面内。触发前已有任务（含 paused/interrupted）则跳过不消耗触发。
  startScheduledTask(schedule, extra = {}) {
    const policy = this.#policy();
    const audit = (ok, code = null) => this.audit.log({ tool: 'schedule_due', ok, code, target: schedule?.id ?? '' });
    if (!policy.enabled) { audit(false, 'COMPUTER_DISABLED'); return { ok: false, code: 'COMPUTER_DISABLED', message: '电脑操控运行时未开启。' }; }
    if (stopRequested(this.stateDir)) { audit(false, 'COMPUTER_DISABLED'); return { ok: false, code: 'COMPUTER_DISABLED', message: '急停 STOP 生效，触发被拦下。' }; }
    if (this.sessionProbe()) { audit(false, 'SESSION_LOCKED'); return { ok: false, code: 'SESSION_LOCKED', message: '会话锁定，触发跳过（§6.4）。' }; }
    const existing = this.tasks.current();
    if (existing) { audit(false, 'COMPUTER_BUSY'); return { ok: false, code: 'COMPUTER_BUSY', message: `已有任务 ${existing.taskId}（${existing.status}），触发跳过。` }; }
    const state = this.tasks.create({
      goal: schedule.goal,
      mode: 'autonomous',
      budget: normalizeBudget(schedule.budget),
      policySnapshot: {
        profile: policy.profile, apps: policy.apps, controlChannel: policy.control.channel,
        scheduleId: schedule.id, trigger: extra.trigger ?? 'schedule', event: extra.event ?? null,
      },
    });
    this.machine.transition(state, 'running');
    audit(true);
    return { ok: true, taskId: state.taskId, trigger: extra.trigger ?? 'schedule', ...this.#taskView(state) };
  }

  // 事件入口（§6.3）：qq-bridge 新消息 / 抖音新动静 / 文件变化由入口层调用。
  notifyEvent(type, payload = {}) {
    return this.scheduler.notifyEvent(type, payload);
  }

  // 轮询观察（§6.3）：condition 满足才动作。titlePattern 命中任一窗口标题（三源合并清单），
  // elementPattern 命中任一 UIA 元素名；两者都给则都要满足。观察失败按「不满足」处理（不动作）。
  async #pollConditionMet(entry) {
    const condition = entry?.trigger?.condition ?? {};
    if (!condition.titlePattern && !condition.elementPattern) return false;
    try {
      const { parsed } = await this.#observeRaw();
      const titleOk = condition.titlePattern
        ? this.#mergedWindows(parsed).some((item) => new RegExp(condition.titlePattern).test(item.title))
        : true;
      const elementOk = condition.elementPattern
        ? parsed.elements.some((item) => new RegExp(condition.elementPattern).test(item.name))
        : true;
      return titleOk && elementOk;
    } catch {
      return false;
    }
  }

  #taskStart(args, { actor, policy }) {
    assertAdminControl(policy, actor);
    const existing = this.tasks.current();
    if (existing) throw fail('COMPUTER_BUSY', `已有任务 ${existing.taskId}（${existing.status}），同一时刻仅一个任务。`, '先 computer_task_resume 恢复或 computer_task_stop 结束它。');
    const goal = String(args.goal ?? '').trim();
    if (!goal) throw fail('TASK_STATE', '任务目标不能为空。');
    const state = this.tasks.create({
      goal,
      budget: normalizeBudget(args.budget),
      // 策略快照随任务落盘（§6.4）；安全拒绝仍以当前策略为准（fail-closed 优先）。
      policySnapshot: { profile: policy.profile, apps: policy.apps, controlChannel: policy.control.channel },
    });
    this.machine.transition(state, 'running');
    this.audit.log({ tool: 'computer_task_start', ok: true, target: state.taskId });
    return { ok: true, tool: 'computer_task_start', ...this.#taskView(state) };
  }

  #taskPause({ actor, policy }) {
    assertAdminControl(policy, actor);
    const state = this.tasks.current();
    if (!state) throw fail('TASK_STATE', '当前没有任务。');
    if (!['running', 'waiting_human'].includes(state.status)) throw fail('TASK_STATE', `任务 ${state.taskId} 当前状态 ${state.status}，不能暂停。`);
    state.used.pausedAt = this.now();
    this.machine.transition(state, 'paused');
    return { ok: true, tool: 'computer_task_pause', ...this.#taskView(state) };
  }

  #taskResume({ actor, policy }) {
    assertAdminControl(policy, actor);
    const state = this.tasks.current();
    if (!state) throw fail('TASK_STATE', '当前没有任务。');
    if (!['paused', 'interrupted'].includes(state.status)) throw fail('TASK_STATE', `任务 ${state.taskId} 当前状态 ${state.status}，不能恢复。`);
    // 暂停时长不计入墙钟预算（§6.5 剩余预算）。
    if (state.used.pausedAt) {
      state.used.startedAt += this.now() - state.used.pausedAt;
      delete state.used.pausedAt;
    }
    this.machine.transition(state, 'running');
    return { ok: true, tool: 'computer_task_resume', ...this.#taskView(state) };
  }

  #taskStop(args, { actor, policy }) {
    assertAdminControl(policy, actor);
    const state = this.tasks.current();
    if (!state) throw fail('TASK_STATE', '当前没有任务。');
    const completed = args.completed === true;
    this.machine.transition(state, completed ? 'done' : 'cancelled', { result: completed ? 'done' : 'stopped' });
    const receipt = this.audit.receipt({
      tool: 'computer_task_stop', action: 'task_stop', target: state.taskId,
      textHash: hashArgs({ completed }), ok: true, verified: true, allowDuplicate: false,
    });
    return { ok: true, tool: 'computer_task_stop', receiptId: receipt.receiptId, deduped: receipt.deduped, ...this.#taskView(state) };
  }

  // L0 只读：不启动驱动、不落盘 drivers.json。
  #status() {
    let uvFound = true;
    try { resolveUvx(this.env); } catch { uvFound = false; }
    const policy = this.#policy();
    return {
      ok: true, tool: 'computer_status',
      enabled: policy.enabled === true,
      profile: policy.profile,
      invalidPolicy: this.lastPolicyInvalid === true,
      adminConfigured: policy.control.adminIds.length > 0,
      controlChannel: policy.control.channel,
      appsConfigured: policy.apps.length > 0,
      stop: stopRequested(this.stateDir),
      circuit: this.breaker.state(),
      schedules: this.schedules.state(),
      driver: { uvFound, running: Boolean(this.driver?.child), restarts: this.driver?.restarts ?? 0 },
    };
  }

  async #screen() {
    // 截图双通道（vision.mjs）：windows-mcp Screenshot 现网会挂起 30s+，这里 4s 不回就走 PowerShell 兜底。
    const frame = await captureFrame({ driver: this.#driver() });
    return { ok: true, tool: 'computer_screen', summary: '整屏截图已获取', frames: [frame], perceptionPath: 'screen' };
  }

  async #observe(args = {}) {
    const { parsed, raw } = await this.#observeRaw();
    // 截图同走双通道（§5.3 现网踩坑：驱动 Screenshot 挂起 30s 超时）。
    const frames = args.screenshot ? [await captureFrame({ driver: this.#driver() })] : [];
    // 领域包注解（§7.1）：按活动窗口归属注入 prompt，帮模型带上领域约束。
    await this.packs.ready();
    const domain = this.packs?.hintFor({ title: parsed.activeWindow?.title ?? '' }) ?? null;
    return { tool: 'computer_observe', ...buildObservation(parsed, frames), domain, frames, summary: raw.text.slice(0, 400) };
  }

  // 窗口发现三源合并（§4.3）：Snapshot 的 Opened Windows 会系统性漏行（WPS 等窗口只出现在
  // Focused Window 里），所以清单 = 焦点窗口 ∪ Opened Windows ∪ 进程表真实标题，按标题去重。
  #mergedWindows(parsed) {
    return mergeWindows({
      focus: parsed?.activeWindow ?? null,
      listed: parsed ? buildObservation(parsed).windows : [],
      processes: this.processProbe ? this.processProbe() : [],
    });
  }

  async #windows(args = {}, { actor, signal, policy }) {
    const action = args.action ?? 'list';
    if (action === 'list') {
      const { parsed } = await this.#observeRaw();
      return { ok: true, tool: 'computer_windows', action, windows: this.#mergedWindows(parsed), perceptionPath: parsed.perceptionPath };
    }
    if (action === 'close') return this.#closeWindow(args, { actor, signal, policy });
    if (!MUTATING_WINDOWS_ACTIONS.has(action)) throw fail('ELEMENT_NOT_FOUND', `不支持的窗口动作：${action}`);
    checkWriteAllowed(policy, this.stateDir, { title: '' });
    assertAdminControl(policy, actor);
    // launch 的 name 必须命中策略 apps 白名单（全名或基名，忽略大小写）；
    // switch/resize 除 apps 外还允许当前真实窗口标题（切到已存在窗口风险低）。
    const name = String(args.name ?? '');
    const matchesApps = policy.apps.some((item) => {
      const entry = String(item).toLowerCase();
      const base = entry.split(/[\\/]/).pop();
      const targetName = name.toLowerCase();
      return entry === targetName || base === targetName || entry === targetName.split(/[\\/]/).pop();
    });
    let allowed = matchesApps;
    // switch 仅激活已存在窗口（无可破坏性），且窗口列表偶发漏行，信任驱动自身的窗口匹配。
    if (!allowed && action === 'switch' && name) allowed = true;
    if (!allowed && action !== 'launch' && name) {
      const { parsed } = await this.#observeRaw();
      allowed = this.#mergedWindows(parsed).some((item) => item.title === name);
    }
    if (!allowed) throw fail('TARGET_NOT_ALLOWED', `目标 ${name || '(空)'} 不在策略 apps 白名单内。`, '在 policy.json 的 apps 中登记允许的应用。');
    const target = describeTarget({ elementName: args.name ?? '' });
    return this.#confirmThenRun({
      tool: 'computer_windows', action, target, args,
      run: async ({ textHash, stepKey }) => {
        const task = this.tasks.current();
        const inTask = Boolean(task && task.status === 'running');
        if (inTask && this.machine.skipIfDone(task, stepKey, this.sessionKey)) {
          const done = this.tasks.steps(task.taskId).find((item) => item.key === stepKey);
          return { ok: true, tool: 'computer_windows', action, target, skipped: true, reason: '该步骤在之前的会话已完成，按 checkpoint 幂等跳过', receiptId: done?.receiptId ?? null, verified: true, frames: [] };
        }
        // switch 先按三源清单解析精确标题（驱动的模糊匹配会拉错窗，现网踩坑：说切资源管理器拉起 Edge）。
        let switchTitle = null;
        if (action === 'switch' && name) {
          const seen = await this.#observeRaw().catch(() => null);
          const merged = seen ? this.#mergedWindows(seen.parsed) : [];
          const hit = merged.find((item) => item.title === name)
            ?? merged.find((item) => new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(item.title));
          if (hit) switchTitle = hit.title;
        }
        let result = await this.#infra(() => this.#driver().callTool('App', {
          mode: action, name: switchTitle ?? args.name,
          ...(args.width && args.height ? { window_size: [args.width, args.height] } : {}),
          ...(args.x !== undefined && args.y !== undefined ? { window_loc: [args.x, args.y] } : {}),
        }, { signal }));
        // launch 兜底（现网踩坑：驱动按开始菜单查找，Win11 商店版别名常漏——
        // 'notepad.exe' 报 "Notepad.Exe not found in start menu"）：apps 白名单已把关，直接 spawn。
        if (action === 'launch' && /not found/i.test(result.text ?? '')) {
          try {
            spawn(String(args.name), [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            result = { ...result, text: `驱动启动未命中（开始菜单查找失败），已 spawn 兜底：${result.text}` };
          } catch (error) {
            throw fail('ACTION_TIMEOUT', `启动失败：${error?.message ?? error}`);
          }
        }
        // switch 后置核验：焦点窗口必须就是目标（核验失败如实报，不假装成功）。
        const after = await this.#softObserve();
        if (action === 'switch' && switchTitle && after?.activeWindow?.title !== switchTitle) {
          throw fail('VERIFY_FAILED', `switch 后焦点是「${after?.activeWindow?.title ?? '未知'}」而非「${switchTitle}」。`, '重新 computer_windows list 确认窗口后重试。');
        }
        // 动作后置校验（§5.3）与收据（回归网 3：L1 返回必须含 receiptId）；校验不计熔断预算。
        const verified = Boolean(after?.activeWindow);
        const receipt = this.audit.receipt({ tool: 'computer_windows', action, target, textHash, ok: true, verified });
        if (inTask) this.machine.markStepDone(task, stepKey, { sessionKey: this.sessionKey, tool: 'computer_windows', action, target, receiptId: receipt.receiptId });
        return {
          ok: true, tool: 'computer_windows', action, target,
          message: result.text.slice(0, 200),
          receiptId: receipt.receiptId, deduped: receipt.deduped, verified: receipt.verified,
          frames: result.frames ?? [],
        };
      },
    });
  }

  // 关闭窗口（§5.1）：windows-mcp 没有关闭窗口的驱动工具（Process kill 属 L3 永久禁用），
  // 因此走受控通道「switch 到目标 → 核验焦点标题 → alt+f4」。alt+f4 在 computer_key 白名单里
  // 被拒（DENIED_COMBOS），仅此内部路径可发，且发送前必须核验焦点确为目标窗口，核验失败不发送。
  // 关闭语义与点关闭按钮一致：应用可弹「保存更改」对话框，verified 只反映窗口是否消失。
  async #closeWindow(args, { actor, signal, policy }) {
    checkWriteAllowed(policy, this.stateDir, { title: '' });
    assertAdminControl(policy, actor);
    const name = String(args.name ?? '');
    if (!name) throw fail('ELEMENT_NOT_FOUND', 'close 需要目标窗口名（name）。', '先 computer_windows list 确认窗口标题。');
    const { parsed } = await this.#observeRaw();
    // 按精确标题在三源合并清单里匹配当前真实窗口（Snapshot 单一来源会漏行，见 window-discovery）。
    const match = this.#mergedWindows(parsed).find((item) => item.title === name);
    if (!match) throw fail('ELEMENT_NOT_FOUND', `未找到要关闭的窗口：${name}`, '先 computer_windows list 确认窗口标题。');
    checkWriteAllowed(policy, this.stateDir, { title: match.title });
    const target = `关闭窗口 ${match.title}`;
    return this.#confirmThenRun({
      tool: 'computer_windows', action: 'close', target, args,
      run: async ({ textHash, stepKey }) => {
        const task = this.tasks.current();
        const inTask = Boolean(task && task.status === 'running');
        if (inTask && this.machine.skipIfDone(task, stepKey, this.sessionKey)) {
          const done = this.tasks.steps(task.taskId).find((item) => item.key === stepKey);
          return { ok: true, tool: 'computer_windows', action: 'close', target, skipped: true, reason: '该步骤在之前的会话已完成，按 checkpoint 幂等跳过', receiptId: done?.receiptId ?? null, verified: true, frames: [] };
        }
        await this.#infra(() => this.#driver().callTool('App', { mode: 'switch', name: match.title }, { signal }));
        const focus = await this.#softObserve();
        if (focus?.activeWindow?.title !== match.title) {
          throw fail('VERIFY_FAILED', `关闭前置核验失败：焦点窗口是「${focus?.activeWindow?.title ?? '未知'}」而非「${match.title}」，已放弃发送关闭键。`, '重新 computer_observe 确认目标后重试。');
        }
        const result = await this.#infra(() => this.#driver().callTool('Shortcut', { shortcut: 'alt+f4' }, { signal }));
        const after = await this.#softObserve();
        const stillOpen = Boolean(after) && this.#mergedWindows(after).some((item) => item.title === match.title);
        const verified = Boolean(after) && !stillOpen;
        const receipt = this.audit.receipt({ tool: 'computer_windows', action: 'close', target, textHash, ok: true, verified });
        if (inTask) this.machine.markStepDone(task, stepKey, { sessionKey: this.sessionKey, tool: 'computer_windows', action: 'close', target, receiptId: receipt.receiptId });
        return {
          ok: true, tool: 'computer_windows', action: 'close', target,
          message: result.text.slice(0, 200),
          receiptId: receipt.receiptId, deduped: receipt.deduped, verified: receipt.verified,
          frames: result.frames ?? [],
        };
      },
    });
  }

  async #write(action, args, { actor, signal, policy }) {
    checkWriteAllowed(policy, this.stateDir, { title: '' });
    assertAdminControl(policy, actor);
    // 视觉兜底（§4.1）：给了 target 描述且无元素/坐标 → 视觉分支（内部结构化优先）。
    if ((action === 'click' || action === 'type') && args.target && args.elementId === undefined && args.label === undefined && !Number.isFinite(args.x)) {
      return this.#visionWrite(action, args, { actor, signal, policy });
    }
    if (action === 'key') validateShortcut(args.keys);
    else if (action === 'scroll') scrollArgs(args); // 滚动目标可省略，先校验方向与次数
    else if (args.elementId === undefined) targetArgs(args);
    if (action === 'type' && !String(args.text ?? '').length) throw fail('INPUT_UNSUPPORTED', '输入文本不能为空。');

    const { parsed } = await this.#observeRaw();
    const title = parsed.activeWindow?.title ?? '';
    checkWriteAllowed(policy, this.stateDir, { title });
    // 稳定元素 id（§4.2）：在本次观察里重新解析出当次标注号再点/输入——
    // 直接拿旧观察的标注号会因元素树变化而错位（现网已踩坑）。
    let resolved = args;
    if (args.elementId !== undefined && action !== 'key') {
      const match = parsed.elements.find((item) => item.stableId === args.elementId);
      if (!match) throw fail('ELEMENT_NOT_FOUND', '元素已失效（稳定 id 不在当前观察中），请重新 computer_observe 后再试。');
      resolved = { ...args, label: match.id, elementName: match.name };
    }
    const hasTarget = resolved.elementId !== undefined || resolved.label !== undefined || Number.isFinite(resolved.x);
    const target = action === 'key'
      ? `组合键 ${validateShortcut(args.keys)}`
      : hasTarget
        ? describeTarget({ ...resolved, elementName: resolved.elementName ?? (resolved.label !== undefined ? (parsed.elements.find((item) => item.id === resolved.label)?.name ?? '') : '') })
        : '当前光标位置';

    return this.#confirmThenRun({
      tool: `computer_${action}`, action, target, args,
      run: async ({ textHash, stepKey }) => {
        const task = this.tasks.current();
        const inTask = Boolean(task && task.status === 'running');
        // checkpoint 步骤幂等（§6.5）：只跳过之前会话已完成的步骤，不重复执行。
        if (inTask && this.machine.skipIfDone(task, stepKey, this.sessionKey)) {
          const done = this.tasks.steps(task.taskId).find((item) => item.key === stepKey);
          return { ok: true, tool: `computer_${action}`, target, skipped: true, reason: '该步骤在之前的会话已完成，按 checkpoint 幂等跳过', receiptId: done?.receiptId ?? null, verified: true, frames: [] };
        }
        const driverCall = action === 'click'
          ? this.#driver().callTool('Click', { ...targetArgs(resolved), button: args.button ?? 'left', clicks: args.count ?? 1 }, { signal })
          : action === 'type'
            ? this.#driver().callTool('Type', typeArgs(resolved), { signal })
            : action === 'move'
              ? this.#driver().callTool('Move', { ...targetArgs(resolved) }, { signal })
              : action === 'scroll'
                ? this.#driver().callTool('Scroll', scrollArgs(resolved), { signal })
                : this.#driver().callTool('Shortcut', { shortcut: validateShortcut(args.keys) }, { signal });
        const result = await this.#infra(() => driverCall);
        if (!result.ok) throw fail(action === 'type' ? 'INPUT_UNSUPPORTED' : 'ELEMENT_NOT_FOUND', `动作未成功：${result.text.slice(0, 200)}`);
        // 动作后置校验（§5.3）：只记录不重试，且不计熔断预算。
        const after = await this.#softObserve();
        const verified = Boolean(after?.activeWindow) && !policy.titleDeny.some((word) => word && after.activeWindow.title.includes(word));
        const receipt = this.audit.receipt({
          tool: `computer_${action}`, app: parsed.activeWindow?.title ?? '', action, target,
          textHash, ok: true, verified,
        });
        if (inTask) this.machine.markStepDone(task, stepKey, { sessionKey: this.sessionKey, tool: `computer_${action}`, action, target, receiptId: receipt.receiptId });
        return {
          ok: true, tool: `computer_${action}`, target, verified: receipt.verified,
          receiptId: receipt.receiptId, deduped: receipt.deduped, perceptionPath: parsed.perceptionPath,
          frames: result.frames ?? [],
        };
      },
    });
  }

  // 视觉兜底写（§4.1 / P3，dsh-computer-use 模式）：target 描述 → 截图→识图→提交→再截图确认。
  // 结构化优先（§1.6）：最新观察里有同名元素就回走 UIA 老路，视觉绝不进常规路径。
  async #visionWrite(action, args, { actor, signal, policy }) {
    const label = String(args.target ?? '').trim();
    const { parsed } = await this.#observeRaw();
    checkWriteAllowed(policy, this.stateDir, { title: parsed.activeWindow?.title ?? '' });
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = parsed.elements.find((item) => item.name && new RegExp(escaped, 'i').test(item.name));
    if (named) {
      // UIA 有同名元素：翻译成稳定 id 回到结构化路径（一次递归，目标分支不再命中）。
      return this.#write(action, { ...args, target: undefined, elementId: named.stableId }, { actor, signal, policy });
    }
    if (policy.allowVisionFallback !== true) throw fail('VISION_UNAVAILABLE', '策略未开启视觉兜底（allowVisionFallback=false）。', '如需视觉兜底，在 policy.json 开启 allowVisionFallback。');
    if (typeof this.visionLocate !== 'function') throw fail('VISION_UNAVAILABLE', '未接入视觉定位提供者（vision.locate）。', '在宿主接线视觉模型后启用（§4.1）。');
    const target = `视觉定位「${label}」`;
    return this.#confirmThenRun({
      tool: `computer_${action}`, action: `${action}_vision`, target, args,
      run: async ({ textHash, stepKey }) => {
        const task = this.tasks.current();
        const inTask = Boolean(task && task.status === 'running');
        if (inTask && this.machine.skipIfDone(task, stepKey, this.sessionKey)) {
          const done = this.tasks.steps(task.taskId).find((item) => item.key === stepKey);
          return { ok: true, tool: `computer_${action}`, target, skipped: true, reason: '该步骤在之前的会话已完成，按 checkpoint 幂等跳过', receiptId: done?.receiptId ?? null, verified: true, frames: [] };
        }
        const commit = action === 'type'
          ? async (x, y) => {
            const result = await this.#infra(() => this.#driver().callTool('Type', {
              text: String(args.text ?? ''), loc: [x, y], clear: args.replace === true, caret_position: 'end',
            }, { signal }));
            if (!result.ok) throw fail('INPUT_UNSUPPORTED', `视觉输入未成功：${result.text.slice(0, 120)}`);
            return result;
          }
          : undefined; // 默认提交 = 坐标点击
        const result = await this.#vision().cycle({ target: label, commit });
        const receipt = this.audit.receipt({
          tool: `computer_${action}`, app: parsed.activeWindow?.title ?? '', action: `${action}_vision`, target,
          textHash, ok: true, verified: result.verified,
        });
        if (inTask) this.machine.markStepDone(task, stepKey, { sessionKey: this.sessionKey, tool: `computer_${action}`, action: `${action}_vision`, target, receiptId: receipt.receiptId });
        return {
          ok: true, tool: `computer_${action}`, target,
          perceptionPath: 'vision', x: result.x, y: result.y,
          verified: receipt.verified,
          receiptId: receipt.receiptId, deduped: receipt.deduped,
          frames: result.frames ?? [],
        };
      },
    });
  }

  // 视觉闭环装配：截图/提交走驱动（截图失败有 PowerShell 兜底），定位由注入的视觉模型提供。
  #vision() {
    return new VisionFallback({
      locate: this.visionLocate,
      capture: this.visionCapture,
      driver: this.visionCapture ? undefined : this.#driver(),
      commit: async (x, y) => {
        const result = await this.#infra(() => this.#driver().callTool('Click', { loc: [x, y], button: 'left', clicks: 1 }));
        if (!result.ok) throw fail('ELEMENT_NOT_FOUND', `视觉点击未成功：${result.text.slice(0, 120)}`);
        return result;
      },
    });
  }

  // 拖拽（§5.1）：驱动 Move(drag=true) 是「从当前光标拖到目标」，故先悬停到 from 再拖到 to。
  // from/to 都在最新观察里重新解析稳定 id；收据与步骤幂等同 #write。
  async #drag(args, { actor, signal, policy }) {
    checkWriteAllowed(policy, this.stateDir, { title: '' });
    assertAdminControl(policy, actor);
    if (!args.from || typeof args.from !== 'object' || !args.to || typeof args.to !== 'object') {
      throw fail('ELEMENT_NOT_FOUND', '拖拽需要 from 与 to 两个目标。', '每个目标可用元素 id、标注号或坐标 x,y。');
    }
    const { parsed } = await this.#observeRaw();
    const title = parsed.activeWindow?.title ?? '';
    checkWriteAllowed(policy, this.stateDir, { title });
    const resolveSide = (side, which) => {
      if (side.elementId === undefined) return { ...side };
      const match = parsed.elements.find((item) => item.stableId === side.elementId);
      if (!match) throw fail('ELEMENT_NOT_FOUND', `拖拽${which}元素已失效（稳定 id 不在当前观察中），请重新 computer_observe 后再试。`);
      return { ...side, label: match.id, elementName: match.name };
    };
    const fromResolved = resolveSide(args.from, '起点');
    const toResolved = resolveSide(args.to, '落点');
    const { from, to } = dragArgs({ from: fromResolved, to: toResolved });
    const target = `从 ${describeTarget(fromResolved)} 拖到 ${describeTarget(toResolved)}`;

    return this.#confirmThenRun({
      tool: 'computer_drag', action: 'drag', target, args,
      run: async ({ textHash, stepKey }) => {
        const task = this.tasks.current();
        const inTask = Boolean(task && task.status === 'running');
        if (inTask && this.machine.skipIfDone(task, stepKey, this.sessionKey)) {
          const done = this.tasks.steps(task.taskId).find((item) => item.key === stepKey);
          return { ok: true, tool: 'computer_drag', target, skipped: true, reason: '该步骤在之前的会话已完成，按 checkpoint 幂等跳过', receiptId: done?.receiptId ?? null, verified: true, frames: [] };
        }
        // 两次鼠标动作之间不得插入其他指针操作（串行锁已保证）。
        await this.#infra(() => this.#driver().callTool('Move', from, { signal }));
        const result = await this.#infra(() => this.#driver().callTool('Move', { ...to, drag: true }, { signal }));
        if (!result.ok) throw fail('ELEMENT_NOT_FOUND', `拖拽未成功：${result.text.slice(0, 200)}`);
        const after = await this.#softObserve();
        const verified = Boolean(after?.activeWindow) && !policy.titleDeny.some((word) => word && after.activeWindow.title.includes(word));
        const receipt = this.audit.receipt({
          tool: 'computer_drag', app: parsed.activeWindow?.title ?? '', action: 'drag', target,
          textHash, ok: true, verified,
        });
        if (inTask) this.machine.markStepDone(task, stepKey, { sessionKey: this.sessionKey, tool: 'computer_drag', action: 'drag', target, receiptId: receipt.receiptId });
        return {
          ok: true, tool: 'computer_drag', target, verified: receipt.verified,
          receiptId: receipt.receiptId, deduped: receipt.deduped, perceptionPath: parsed.perceptionPath,
          frames: result.frames ?? [],
        };
      },
    });
  }

  // 等待（§8.1 L0）：纯等待，无桌面副作用，不走确认令牌；在运行时内睡，不占用驱动。
  async #wait(args = {}) {
    const ms = Number(args.ms);
    if (!Number.isInteger(ms) || ms < 1 || ms > 10_000) throw fail('INPUT_UNSUPPORTED', 'ms 必须是 1..10000 的整数。');
    await new Promise((resolve) => { setTimeout(resolve, ms); });
    return { ok: true, tool: 'computer_wait', waitedMs: ms };
  }

  // 收据查询（§8.1 L0）：只读审计收据，不含明文输入/剪贴板/截图。
  #receipts(args = {}) {
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('INPUT_UNSUPPORTED', 'limit 必须是 1..100 的整数。');
    return { ok: true, tool: 'computer_receipts', receipts: this.audit.recent(limit) };
  }

  // 通用浏览器驱动（B 方案）：复用现有 Playwright CDP 通道（登录态不搬家），懒装配。
  #browser() {
    this.browserDriver ??= new BrowserDriver({ getController: this.getBrowserController, stateDir: this.stateDir });
    return this.browserDriver;
  }

  async #browserObserve(args = {}) {
    const result = await this.#browser().observe({ urlPattern: args.urlPattern, titlePattern: args.titlePattern });
    return { tool: 'computer_browser_observe', ...result };
  }

  // 网页写（L1，B 方案）：闸门 = enabled/STOP + 标题黑名单 + domains 目标白名单 + 管理员 + 两段式确认；
  // 与桌面写同一套收据/预算/锁屏/步骤幂等。open 的目标域按目的 URL 校验，其余按当前页 URL。
  async #browserWrite(action, args, { actor, signal, policy }) {
    assertAdminControl(policy, actor);
    const browser = this.#browser();
    const preview = await browser.observe({ urlPattern: args.urlPattern, titlePattern: args.titlePattern });
    const targetUrl = action === 'open' ? String(args.url ?? '') : (preview.url ?? '');
    checkBrowserWriteAllowed(policy, this.stateDir, { title: preview.title ?? '', url: targetUrl });
    const target = action === 'open'
      ? `打开 ${targetUrl}`
      : `${action === 'click' ? '点击' : action === 'fill' ? '填写' : '下载'} ${String(args.ref ?? '')}${action === 'fill' ? ` ← ${String(args.text ?? '').slice(0, 20)}` : ''}`;
    return this.#confirmThenRun({
      tool: `computer_browser_${action}`, action: `browser_${action}`, target, args,
      run: async ({ textHash, stepKey }) => {
        const task = this.tasks.current();
        const inTask = Boolean(task && task.status === 'running');
        if (inTask && this.machine.skipIfDone(task, stepKey, this.sessionKey)) {
          const done = this.tasks.steps(task.taskId).find((item) => item.key === stepKey);
          return { ok: true, tool: `computer_browser_${action}`, target, skipped: true, reason: '该步骤在之前的会话已完成，按 checkpoint 幂等跳过', receiptId: done?.receiptId ?? null, verified: true, frames: [] };
        }
        const match = { urlPattern: args.urlPattern, titlePattern: args.titlePattern };
        const result = action === 'open'
          ? await browser.open({ url: args.url, match })
          : action === 'click'
            ? await browser.click({ ref: args.ref, match })
            : action === 'fill'
              ? await browser.fill({ ref: args.ref, text: args.text, replace: args.replace, match })
              : await browser.download({ ref: args.ref, filename: args.filename, match });
        // 后置校验（§5.3）：下载核验落盘；其余以返回 ok 为准（DOM 动作本身带回执字段）。
        const verified = action === 'download' ? Boolean(result.file) : true;
        const receipt = this.audit.receipt({
          tool: `computer_browser_${action}`, app: preview.title ?? '', action: `browser_${action}`, target,
          textHash, ok: true, verified,
        });
        if (inTask) this.machine.markStepDone(task, stepKey, { sessionKey: this.sessionKey, tool: `computer_browser_${action}`, action: `browser_${action}`, target, receiptId: receipt.receiptId });
        return {
          ok: true, tool: `computer_browser_${action}`, target,
          receiptId: receipt.receiptId, deduped: receipt.deduped, verified: receipt.verified,
          ...result, frames: [],
        };
      },
    });
  }

  // L2 门（§8.3）：①自治任务内一律 AUTONOMY_FORBIDDEN（回归网 5）②power 档存在性
  // （shell 另需 allowShell=true）③管理员私聊（9.3）。都过才进入两段式确认。
  #l2Gate(name, { actor, policy }) {
    const task = this.tasks.current();
    if (task?.mode === 'autonomous' && ['running', 'waiting_human'].includes(task.status)) {
      throw fail('AUTONOMY_FORBIDDEN', `自治任务内禁止调用 L2 工具 ${name}（§8.3）。`, 'L2 一律排队等待人工确认。');
    }
    if (name === 'computer_shell' && !(policy.profile === 'power' && policy.allowShell === true)) {
      throw fail('TARGET_NOT_ALLOWED', 'computer_shell 仅在 profile=power 且 allowShell=true 时存在。', '在 policy.json 提升 profile 并开启 allowShell。');
    }
    if (name === 'computer_settings' && policy.profile !== 'power') {
      throw fail('TARGET_NOT_ALLOWED', 'computer_settings 仅在 profile=power 时存在。', '在 policy.json 提升 profile。');
    }
    assertAdminControl(policy, actor);
    return true;
  }

  // L2 PowerShell（§8.3）：Node 侧子进程执行（驱动的 Shell 工具属 L3 永久禁用，不可达）。
  // 15 秒超时、输出截断 4000 字；收据只记命令 hash，不落明文（§11.1）。
  async #shell(args, { actor, signal, policy }) {
    this.#l2Gate('computer_shell', { actor, policy });
    const command = String(args.command ?? '').trim();
    if (!command) throw fail('INPUT_UNSUPPORTED', 'command 不能为空。');
    return this.#confirmThenRun({
      tool: 'computer_shell', action: 'shell', target: 'PowerShell 命令', args,
      run: async ({ textHash }) => {
        const { code, stdout, stderr } = await new Promise((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
            { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
            (error, out, err) => resolve({ code: error?.code ?? 0, stdout: String(out ?? ''), stderr: String(err ?? '') }));
        });
        const receipt = this.audit.receipt({ tool: 'computer_shell', action: 'shell', target: 'PowerShell 命令', textHash, ok: true, verified: true });
        return {
          ok: true, tool: 'computer_shell', exitCode: code,
          stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000),
          receiptId: receipt.receiptId, deduped: receipt.deduped, verified: true, frames: [],
        };
      },
    });
  }

  // L2 系统设置页（§8.3）：只「打开」白名单页面（ms-settings: URI），不修改任何系统开关。
  async #settings(args, { actor, signal, policy }) {
    this.#l2Gate('computer_settings', { actor, policy });
    const page = String(args.page ?? '').trim().toLowerCase();
    if (!SETTINGS_PAGES.has(page)) {
      throw fail('TARGET_NOT_ALLOWED', `设置页 ${page || '(空)'} 不在白名单内。`, `可用：${[...SETTINGS_PAGES].join('、')}`);
    }
    return this.#confirmThenRun({
      tool: 'computer_settings', action: 'settings_open', target: `ms-settings:${page}`, args,
      run: async ({ textHash }) => {
        await new Promise((resolve, reject) => {
          execFile('cmd', ['/c', 'start', '', `ms-settings:${page}`], { windowsHide: true, timeout: 10_000 }, (error) => {
            if (error) reject(fail('ACTION_TIMEOUT', `打开设置页失败：${error?.message ?? error}`));
            else resolve();
          });
        });
        const receipt = this.audit.receipt({ tool: 'computer_settings', action: 'settings_open', target: `ms-settings:${page}`, textHash, ok: true, verified: true });
        return { ok: true, tool: 'computer_settings', page, receiptId: receipt.receiptId, deduped: receipt.deduped, verified: true, frames: [] };
      },
    });
  }

  // 剪贴板（§8.2 L1）：读写都要确认令牌（读操作可能泄露密钥）；收据只记 hash 不记内容。
  async #clipboard(args, { actor, signal, policy }) {
    checkWriteAllowed(policy, this.stateDir, { title: '' });
    assertAdminControl(policy, actor);
    const action = args.action === 'write' ? 'write' : 'read';
    return this.#confirmThenRun({
      tool: 'computer_clipboard', action: `clipboard_${action}`, target: action === 'write' ? '剪贴板写入' : '剪贴板读取', args,
      run: async ({ textHash }) => {
        const result = await this.#infra(() => this.#driver().callTool('Clipboard',
          action === 'write' ? { mode: 'set', text: String(args.text ?? '') } : { mode: 'get' }, { signal }));
        if (!result.ok) throw fail('INPUT_UNSUPPORTED', `剪贴板操作失败：${result.text.slice(0, 200)}`);
        const receipt = this.audit.receipt({
          tool: 'computer_clipboard', action: `clipboard_${action}`, target: action, textHash, ok: true, verified: true,
        });
        return {
          ok: true, tool: 'computer_clipboard', action,
          text: action === 'read' ? result.text.slice(0, 4000) : undefined,
          receiptId: receipt.receiptId, deduped: receipt.deduped, verified: true, frames: [],
        };
      },
    });
  }

  // 两段式确认（§9.3）：首次返回 needsConfirm + 摘要 + 令牌；携带令牌且绑定一致才执行。
  // 绑定与步骤 key 的参数哈希都剔除 confirmToken，保证两次调用哈希一致。
  // 注意：GUI 重复操作是合法的（如计算器连点两次 7），不做收据跳过；
  // 「重启后不重复执行已完成步骤」由 run 内的 checkpoint 步骤幂等实现（§6.5）。
  async #confirmThenRun({ tool, action, target, args, run }) {
    const bare = { ...args };
    delete bare.confirmToken;
    const argsHash = hashArgs({ action, target, args: bare });
    const textHash = hashArgs(bare);
    if (args.confirmToken === undefined || args.confirmToken === null || args.confirmToken === '') {
      const issued = this.confirm.issue({ tool, argsHash, summary: `即将执行 ${tool}：${target}` });
      return { ok: true, needsConfirm: true, tool, action, target, summary: issued.summary, confirmToken: issued.token, expiresAt: issued.expiresAt };
    }
    this.confirm.consume({ tool, argsHash, token: String(args.confirmToken) });
    return run({ textHash, stepKey: argsHash });
  }

  // DSH 控制台会话按 §9.3 视作管理员私聊（入口层前提）；QQ 等其他入口必须自行提供 actor 并在入口层校验。
  // adminIds 为空时返回空 id，随后 assertAdminControl 按 fail-closed 拒绝（NOT_ADMIN）。
  adminActor() {
    const policy = this.#policy();
    return { channel: 'private', id: policy.control.adminIds[0] ?? null, via: 'dsh-console' };
  }

  async dispose() {
    this.disposed = true;
    this.scheduler?.stop();
    this.eventBridge?.stop();
    await this.queue.catch(() => {});
    await this.driver?.close?.().catch(() => {});
  }
}

export function computerStateDir(root) {
  return path.join(root, 'computer');
}

export function ensureComputerDir(root) {
  const dir = computerStateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
