// 任务状态机与预算（§6.1 / §6.2 / §6.4 / §6.5）。
// 状态：queued → running → (paused | waiting_human | interrupted | done | failed | cancelled)
// 步骤 key = hash(action + target + argsHash)；已完成步骤恢复后跳过，保证重启不重复执行。
// 预算：maxSteps / maxWallMs / maxWrites 超限自动暂停（BUDGET_EXHAUSTED）。
import { createHash } from 'node:crypto';
import { fail } from '../policy.mjs';

export const DEFAULT_BUDGET = Object.freeze({ maxSteps: 30, maxWallMs: 600_000, maxModelCalls: 60, maxWrites: 80 });

const TRANSITIONS = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['paused', 'waiting_human', 'interrupted', 'done', 'failed', 'cancelled', 'running'],
  waiting_human: ['running', 'paused', 'cancelled', 'failed', 'interrupted'],
  paused: ['running', 'cancelled', 'failed'],
  interrupted: ['running', 'cancelled', 'failed'],
  done: [], failed: [], cancelled: [],
};

export function stepKeyOf(action, target, args) {
  return createHash('sha256').update(JSON.stringify([action, target ?? '', args ?? {}])).digest('hex').slice(0, 32);
}

export function normalizeBudget(budget) {
  const merged = { ...DEFAULT_BUDGET, ...(budget ?? {}) };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) throw fail('BUDGET_EXHAUSTED', `预算参数 ${name} 必须是正整数。`);
    if (value > DEFAULT_BUDGET[name] * 100) throw fail('BUDGET_EXHAUSTED', `预算参数 ${name} 超出允许范围。`);
  }
  return merged;
}

export class TaskStateMachine {
  constructor({ store, now = Date.now } = {}) {
    Object.assign(this, { store, now });
  }

  transition(state, status, { result = undefined } = {}) {
    if (!(TRANSITIONS[state.status] ?? []).includes(status)) {
      throw fail('TASK_STATE', `任务状态不允许从 ${state.status} 变为 ${status}。`);
    }
    state.status = status;
    if (result !== undefined) state.result = result;
    return this.store.save(state);
  }

  // 每个工具调用记一步；写动作额外计数。返回是否继续（false = 预算耗尽已自动暂停）。
  account(state, { write = false } = {}) {
    state.used.steps += 1;
    if (write) state.used.writes += 1;
    const wallMs = this.now() - state.used.startedAt;
    const exhausted = state.used.steps > state.budget.maxSteps
      || state.used.writes > state.budget.maxWrites
      || wallMs > state.budget.maxWallMs;
    if (exhausted) {
      this.transition(state, 'paused', { result: 'budget_exhausted' });
      throw fail('BUDGET_EXHAUSTED', `任务预算耗尽（步数 ${state.used.steps}/${state.budget.maxSteps}，写 ${state.used.writes}/${state.budget.maxWrites}，时长 ${Math.round(wallMs / 1000)}s），已自动暂停。`, '可 computer_task_resume 放宽后续写操作，或 computer_task_stop 结束。');
    }
    this.store.save(state);
    return true;
  }

  // 幂等短路（§6.5「已完成步骤重启后跳过」）：只跳过**之前会话**（checkpoint 恢复前）
  // 已完成的步骤；同一会话内的重复操作（如计算器连点两次 7）必须照常执行。
  skipIfDone(state, key, sessionKey) {
    return (state.completedStepKeys ?? []).includes(key)
      && this.store.steps(state.taskId).some((step) => step.key === key && step.sessionKey !== sessionKey);
  }

  markStepDone(state, key, step) {
    state.completedStepKeys = [...new Set([...(state.completedStepKeys ?? []), key])];
    this.store.appendStep(state.taskId, { key, ...step });
    return this.store.save(state);
  }
}
