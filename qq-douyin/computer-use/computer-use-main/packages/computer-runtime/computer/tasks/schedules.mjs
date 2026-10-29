// 定时/事件调度配置（§6.3 / §10.1）：stateDir/schedules.json。
// 默认 enabled:false（§6.3 定时/事件触发默认关）；文件损坏按全关处理（fail-closed）。
// 触发类型：interval（每 everyMs 毫秒）/ daily（每天 HH:MM）/ event（file=文件变化、qq-message=qq-bridge 新消息、douyin=抖音新动静）
//          / poll（每 everyMs 观察一次，condition 满足才动作——§6.3 轮询观察）。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../policy.mjs';
import { normalizeBudget } from './state-machine.mjs';

export const SCHEDULES_FILENAME = 'schedules.json';
const MIN_EVERY_MS = 5_000;
const KINDS = new Set(['interval', 'daily', 'event', 'poll']);
const EVENTS = new Set(['file', 'qq-message', 'douyin']);
const DEFAULT_EVENT_COOLDOWN_MS = 60_000;

export class ScheduleStore {
  constructor({ stateDir, now = Date.now } = {}) {
    Object.assign(this, { stateDir, now, file: path.join(stateDir, SCHEDULES_FILENAME) });
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.schedules)) return { enabled: false, schedules: [] };
      return { enabled: parsed.enabled === true, schedules: parsed.schedules };
    } catch {
      return { enabled: false, schedules: [] };
    }
  }

  #write(data) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
    return data;
  }

  state() {
    const data = this.#read();
    return {
      enabled: data.enabled,
      count: data.schedules.length,
      schedules: data.schedules.map((item) => ({
        id: item.id, goal: item.goal, trigger: item.trigger, enabled: item.enabled !== false,
        lastRunAt: item.lastRunAt ?? null, lastCheckAt: item.lastCheckAt ?? null, nextRunAt: this.nextRunAt(item),
      })),
    };
  }

  #validate(entry) {
    const goal = String(entry?.goal ?? '').trim();
    if (!goal || goal.length > 500) throw fail('POLICY_INVALID', '调度需要 1..500 字的任务目标。');
    const trigger = entry?.trigger;
    if (!trigger || !KINDS.has(trigger.kind)) throw fail('POLICY_INVALID', `trigger.kind 必须是 ${[...KINDS].join('/')} 之一。`);
    if (trigger.kind === 'interval' || trigger.kind === 'poll') {
      const everyMs = Number(trigger.everyMs);
      if (!Number.isSafeInteger(everyMs) || everyMs < MIN_EVERY_MS) throw fail('POLICY_INVALID', `${trigger.kind} 的 everyMs 必须是 ≥${MIN_EVERY_MS} 的整数。`);
    }
    if (trigger.kind === 'poll') {
      const condition = trigger.condition ?? {};
      const patterns = [condition.titlePattern, condition.elementPattern].filter((item) => item !== undefined);
      if (!patterns.length) throw fail('POLICY_INVALID', 'poll 需要 condition.titlePattern 或 condition.elementPattern。');
      for (const pattern of patterns) {
        if (typeof pattern !== 'string') throw fail('POLICY_INVALID', 'condition 模式必须是正则字符串。');
        try { new RegExp(pattern); } catch { throw fail('POLICY_INVALID', `condition 正则非法：${pattern}`); }
      }
    }
    if (trigger.kind === 'daily' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(trigger.dailyAt ?? ''))) {
      throw fail('POLICY_INVALID', 'daily 的 dailyAt 必须是 HH:MM（00:00-23:59）。');
    }
    if (trigger.kind === 'event') {
      if (!EVENTS.has(trigger.event)) throw fail('POLICY_INVALID', `event 必须是 ${[...EVENTS].join('/')} 之一。`);
      const cooldownMs = Number(trigger.cooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS);
      if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw fail('POLICY_INVALID', 'cooldownMs 必须是非负整数。');
    }
    normalizeBudget(entry?.budget); // 预算参数校验（§6.1），非法直接抛
    return goal;
  }

  // upsert：带 id 更新既有条目，不带 id 新建。
  configure(input = {}) {
    const data = this.#read();
    const goal = this.#validate(input);
    const existing = input.id ? data.schedules.find((item) => item.id === String(input.id)) : null;
    const entry = {
      id: existing?.id ?? `sch-${randomUUID().slice(0, 8)}`,
      goal,
      trigger: input.trigger,
      budget: normalizeBudget(input.budget),
      enabled: input.enabled !== false,
      createdAt: existing?.createdAt ?? this.now(),
      lastRunAt: existing?.lastRunAt ?? null,
    };
    if (existing) Object.assign(existing, entry);
    else data.schedules.push(entry);
    this.#write(data);
    return this.state();
  }

  // 全局开关（§6.3 默认关）。
  setEnabled(enabled) {
    const data = this.#read();
    data.enabled = Boolean(enabled);
    this.#write(data);
    return this.state();
  }

  remove(id) {
    const data = this.#read();
    const before = data.schedules.length;
    data.schedules = data.schedules.filter((item) => item.id !== String(id));
    if (data.schedules.length === before) throw fail('TASK_STATE', `调度不存在：${id}`);
    this.#write(data);
    return this.state();
  }

  nextRunAt(entry, at = this.now()) {
    if (!entry || entry.enabled === false) return null;
    const trigger = entry.trigger ?? {};
    const base = Math.max(Number(entry.lastCheckAt) || 0, Number(entry.lastRunAt) || 0, Number(entry.createdAt) || 0);
    if (trigger.kind === 'interval' || trigger.kind === 'poll') return base + Number(trigger.everyMs);
    if (trigger.kind === 'daily') {
      const [h, m] = String(trigger.dailyAt).split(':').map(Number);
      const next = new Date(at);
      next.setHours(h, m, 0, 0);
      if (next.getTime() <= at || next.getTime() <= (Number(entry.lastRunAt) || 0)) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    return null;
  }

  due(at = this.now()) {
    return this.#read().schedules.filter((item) => {
      if (item.enabled === false || item.trigger?.kind === 'event' || item.trigger?.kind === 'poll') return false;
      return (this.nextRunAt(item, at) ?? Infinity) <= at;
    });
  }

  // 轮询观察（§6.3）：到点该「看一眼」的 poll 条目；是否动作由 condition 检查决定。
  pollDue(at = this.now()) {
    return this.#read().schedules.filter((item) => {
      if (item.enabled === false || item.trigger?.kind !== 'poll') return false;
      const base = Math.max(Number(item.lastCheckAt) || 0, Number(item.lastRunAt) || 0, Number(item.createdAt) || 0);
      return base + Number(item.trigger.everyMs) <= at;
    });
  }

  // 每次检查都记账（无论条件是否满足），未满足也不在 everyMs 内重复观察。
  markChecked(id, at = this.now()) {
    const data = this.#read();
    const entry = data.schedules.find((item) => item.id === id);
    if (!entry) return null;
    entry.lastCheckAt = at;
    this.#write(data);
    return entry;
  }

  // 事件触发：命中类型且冷却期外（防止消息风暴连发）；从未触发过直接放行。
  eventMatches(type, at = this.now()) {
    return this.#read().schedules.filter((item) => {
      if (item.enabled === false || item.trigger?.kind !== 'event' || item.trigger?.event !== type) return false;
      if (item.lastRunAt === undefined || item.lastRunAt === null) return true;
      const cooldownMs = Number(item.trigger.cooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS);
      return Number(item.lastRunAt) + cooldownMs <= at;
    });
  }

  markFired(id, at = this.now()) {
    const data = this.#read();
    const entry = data.schedules.find((item) => item.id === id);
    if (!entry) return null;
    entry.lastRunAt = at;
    this.#write(data);
    return entry;
  }
}
