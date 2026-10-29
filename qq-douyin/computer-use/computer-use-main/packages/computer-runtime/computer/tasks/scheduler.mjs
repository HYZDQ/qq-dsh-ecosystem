// 本地调度器（§6.3）：定时（interval/daily）与事件（file/qq-message/douyin）触发源。
// 触发只是「何时跑」的信号；任务创建与四道闸由 onDue 回调（运行时 startScheduledTask）负责。
// 语义：触发成功才 markFired；失败（如 COMPUTER_BUSY、STOP）不消耗触发，下一轮重试，跳过日志按 10 分钟节流。
export class LocalScheduler {
  constructor({ store, onDue, checkPoll, now = Date.now, tickMs = 30_000, skipLogGapMs = 10 * 60_000 } = {}) {
    Object.assign(this, { store, onDue, checkPoll, now, tickMs, skipLogGapMs });
    this.timer = null;
    this.lastSkipAt = new Map();
  }

  // 常驻启动（interval unref 不占事件循环）；tick 自行判断全局开关（默认关）。
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // 可直接调用（测试注入时钟）；返回本轮各触发的结果。
  async tick() {
    if (!this.store.state().enabled) return [];
    const at = this.now();
    const results = [];
    for (const entry of this.store.due(at)) results.push(await this.#fire(entry, { trigger: 'schedule' }));
    // 轮询观察（§6.3）：到点检查条件，满足才动作；每次检查都记账（markChecked），
    // 条件不满足不在 everyMs 内重复观察（防刷观察）。
    for (const entry of this.store.pollDue(at)) {
      let met = false;
      try { met = Boolean(await this.checkPoll?.(entry)); } catch { met = false; }
      this.store.markChecked(entry.id, at);
      if (met) results.push(await this.#fire(entry, { trigger: 'poll' }));
    }
    return results;
  }

  // 事件触发（§6.3）：qq-bridge 新消息 / 抖音新动静 / 文件变化都从这里进（入口层调用 notifyEvent）。
  async notifyEvent(type, payload = {}) {
    if (!this.store.state().enabled) return [];
    const at = this.now();
    const results = [];
    for (const entry of this.store.eventMatches(type, at)) results.push(await this.#fire(entry, { trigger: 'event', event: type, payload }));
    return results;
  }

  async #fire(entry, extra = {}) {
    let result;
    try {
      result = await this.onDue?.(entry, extra);
    } catch (error) {
      result = { ok: false, code: error?.code ?? 'TASK_STATE', message: error?.message ?? String(error) };
    }
    if (result?.ok) {
      this.store.markFired(entry.id);
      this.lastSkipAt.delete(entry.id);
      return { id: entry.id, ok: true, taskId: result.taskId };
    }
    // 失败不 markFired（下一轮重试）；同一调度的跳过记录按 skipLogGapMs 节流，避免任务占用期间刷日志。
    const last = this.lastSkipAt.get(entry.id) ?? 0;
    const throttled = this.now() - last < this.skipLogGapMs;
    this.lastSkipAt.set(entry.id, this.now());
    return { id: entry.id, ok: false, code: result?.code ?? 'TASK_STATE', message: result?.message ?? '', throttled };
  }
}
