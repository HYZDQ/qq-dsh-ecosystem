// 任务 checkpoint 落盘与恢复（§6.2 / §6.5）。
// state.json 记状态机与预算，steps.jsonl 记逐步执行；进程重启后 running 任务转 interrupted，需显式恢复。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../policy.mjs';

const TASKS_DIR = 'tasks';
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

export class TaskStore {
  constructor({ stateDir, now = Date.now } = {}) {
    Object.assign(this, { stateDir, now, root: path.join(stateDir, TASKS_DIR) });
  }

  #taskDir(taskId) { return path.join(this.root, taskId); }

  create({ goal, mode = 'manual', budget, policySnapshot = null }) {
    const now = this.now();
    const state = {
      taskId: `tsk-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 4)}`,
      goal: String(goal).trim().slice(0, 2000),
      mode, status: 'queued', createdAt: now, updatedAt: now,
      budget, used: { steps: 0, writes: 0, startedAt: now },
      completedStepKeys: [], lastObservationSummary: null, replanCount: 0,
      policySnapshot, result: null,
    };
    this.save(state);
    return state;
  }

  save(state) {
    const dir = this.#taskDir(state.taskId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: this.now() }, null, 2));
    fs.renameSync(tmp, file);
    return state;
  }

  load(taskId) {
    try { return JSON.parse(fs.readFileSync(path.join(this.#taskDir(taskId), 'state.json'), 'utf8')); }
    catch { throw fail('TASK_STATE', `任务不存在或状态损坏：${taskId}`); }
  }

  appendStep(taskId, step) {
    const dir = this.#taskDir(taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'steps.jsonl'), `${JSON.stringify({ at: this.now(), ...step })}\n`);
  }

  steps(taskId) {
    try {
      return fs.readFileSync(path.join(this.#taskDir(taskId), 'steps.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  }

  // 当前未终结任务（含 paused/interrupted）；同时最多一个（§6.3 maxConcurrentTasks=1）。
  current() {
    try {
      const ids = fs.readdirSync(this.root).sort();
      for (const id of ids) {
        try {
          const state = this.load(id);
          if (!TERMINAL_STATUSES.has(state.status)) return state;
        } catch { /* 跳过损坏目录 */ }
      }
    } catch { /* tasks 目录还不存在 */ }
    return null;
  }

  // 进程启动时：所有未终结任务 → interrupted（§6.2 不自动续跑）。
  markInterrupted() {
    const marked = [];
    try {
      for (const id of fs.readdirSync(this.root)) {
        try {
          const state = this.load(id);
          if (!TERMINAL_STATUSES.has(state.status)) {
            state.status = 'interrupted';
            this.save(state);
            marked.push(state.taskId);
          }
        } catch { /* 跳过损坏目录 */ }
      }
    } catch { /* tasks 目录还不存在 */ }
    return marked;
  }
}
