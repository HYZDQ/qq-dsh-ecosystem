// 时间 / 日期边界 + 调度器（假时钟 + 注入 timers）+ 单实例锁。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseWriteAt,
  zonedParts,
  dateKeyInZone,
  weekdayCN,
  isoWithOffset,
  zonedTimeToUtc,
  midnightInZone,
  writeTimeFor,
  windowForDate,
  nextRunAfter,
  isPastWriteTime,
  parseDateKey,
  isValidDateKey,
  addDays,
  acquireLock,
  releaseLock,
  isProcessAlive,
  readLockFile,
  startScheduler
} from '../src/scheduler.js';
import { compareDateAsc, diaryFilePath, legacyDiaryFilePath } from '../src/store.js';
import { cleanupTempRoots, makeFakeTimers, mkTempRoot, FIXED_NOW, flushMicrotasks } from './helpers.js';

after(cleanupTempRoots);

const TZ = 'Asia/Shanghai';
const at = (iso) => new Date(iso);

describe('时间 / 日期边界（Asia/Shanghai）', () => {
  test('23:59:59 与 00:00:00 的 dateKey 归属不同天（且不依赖本机 TZ）', () => {
    assert.equal(dateKeyInZone(at('2026-10-23T23:59:59+08:00'), TZ), '2026-10-23');
    assert.equal(dateKeyInZone(at('2026-10-24T00:00:00+08:00'), TZ), '2026-10-24');
    // 同一时刻用 UTC 表示：15:59:59Z 还是 23 日，16:00:00Z 已是 24 日
    assert.equal(dateKeyInZone(at('2026-10-23T15:59:59Z'), TZ), '2026-10-23');
    assert.equal(dateKeyInZone(at('2026-10-23T16:00:00Z'), TZ), '2026-10-24');
    // UTC 时区下同一时刻归属 23 日
    assert.equal(dateKeyInZone(at('2026-10-23T15:59:59Z'), 'UTC'), '2026-10-23');
    assert.equal(dateKeyInZone(at('2026-10-23T23:59:59Z'), 'UTC'), '2026-10-23');
  });

  test('zonedParts / isoWithOffset / midnight / writeTime 的东八区换算', () => {
    const parts = zonedParts(at('2026-10-23T23:35:00+08:00'), TZ);
    assert.deepEqual(parts, { year: 2026, month: 10, day: 23, hour: 23, minute: 35, second: 0 });
    assert.equal(midnightInZone('2026-10-23', TZ).toISOString(), '2026-10-22T16:00:00.000Z');
    assert.equal(writeTimeFor('2026-10-23', '23:30', TZ).toISOString(), '2026-10-23T15:30:00.000Z');
    assert.equal(isoWithOffset(writeTimeFor('2026-10-23', '23:30', TZ), TZ), '2026-10-23T23:30:00+08:00');
    assert.equal(
      zonedTimeToUtc({ year: 2026, month: 10, day: 23, hour: 23, minute: 30, second: 0 }, TZ).toISOString(),
      '2026-10-23T15:30:00.000Z'
    );
    assert.equal(isoWithOffset(at('2026-10-23T00:00:00+08:00'), TZ), '2026-10-23T00:00:00+08:00');
  });

  test('weekdayCN：用日期键算中文星期', () => {
    assert.equal(weekdayCN('2026-10-23'), '星期五');
    assert.equal(weekdayCN('2026-10-25'), '星期日');
    assert.equal(weekdayCN('2026-02-30'), '');
  });

  test('--date 跨月 / 跨年 / 闰日', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2025-02-28', 1), '2025-03-01');
    assert.throws(() => addDays('2026-02-30', 1), RangeError);
  });

  test('diaryFilePath / legacyDiaryFilePath：单文件合集路径与旧格式路径', () => {
    const root = mkTempRoot();
    const config = { diaryDir: path.join(root, 'diaries'), diaryFile: 'diary.md' };
    assert.equal(diaryFilePath(config), path.join(config.diaryDir, 'diary.md'));
    assert.equal(diaryFilePath({ ...config, diaryFile: '' }), path.join(config.diaryDir, 'diary.md'));
    assert.equal(diaryFilePath({ ...config, diaryFile: 'my-diary.md' }), path.join(config.diaryDir, 'my-diary.md'));
    assert.equal(legacyDiaryFilePath(config, '2026-11-01'), path.join(config.diaryDir, '2026-11-01.md'));
    assert.equal(legacyDiaryFilePath(config, '2027-01-01'), path.join(config.diaryDir, '2027-01-01.md'));
  });

  test('compareDateAsc：跨月/跨年排序与同日期', () => {
    assert.equal(compareDateAsc({ date: '2026-10-31' }, { date: '2026-11-01' }), -1);
    assert.equal(compareDateAsc({ date: '2026-12-31' }, { date: '2027-01-01' }), -1);
    assert.equal(compareDateAsc({ date: '2027-01-01' }, { date: '2026-12-31' }), 1);
    assert.equal(compareDateAsc({ date: '2026-10-23' }, { date: '2026-10-23' }), 0);
  });

  test('parseWriteAt：合法/非法', () => {
    assert.deepEqual(parseWriteAt('23:30'), { hour: 23, minute: 30 });
    assert.deepEqual(parseWriteAt(' 7:05 '), { hour: 7, minute: 5 });
    assert.deepEqual(parseWriteAt('00:00'), { hour: 0, minute: 0 });
    for (const bad of ['24:00', '23:60', '2330', '', 'abc', '23:3', '-1:00', '23:30:00', null, undefined]) {
      assert.equal(parseWriteAt(bad), null, `parseWriteAt(${JSON.stringify(bad)}) 应为 null`);
    }
  });

  test('isValidDateKey：拒绝 2026-02-30 与格式错误', () => {
    assert.equal(isValidDateKey('2026-02-28'), true);
    assert.equal(isValidDateKey('2024-02-29'), true);
    assert.equal(isValidDateKey('2025-02-29'), false);
    assert.equal(isValidDateKey('2026-02-30'), false);
    assert.equal(isValidDateKey('2026-13-01'), false);
    assert.equal(isValidDateKey('2026-2-3'), false);
    assert.equal(isValidDateKey(''), false);
    assert.equal(isValidDateKey(null), false);
    assert.deepEqual(parseDateKey('2026-10-23'), { year: 2026, month: 10, day: 23 });
    assert.equal(parseDateKey('2026-02-30'), null);
  });

  test('windowForDate：今天=滚动窗口、过去=整日窗口、未来抛错', () => {
    const now = at('2026-10-23T12:00:00+08:00');
    const today = windowForDate({ dateKey: '2026-10-23', now, timeZone: TZ, lookbackHours: 24 });
    assert.equal(today.kind, 'rolling');
    assert.equal(today.end, now.getTime());
    assert.equal(today.start, now.getTime() - 24 * 3600000);

    const past = windowForDate({ dateKey: '2026-10-21', now, timeZone: TZ, lookbackHours: 24 });
    assert.equal(past.kind, 'fullDay');
    assert.equal(past.start, Date.parse('2026-10-21T00:00:00+08:00'));
    assert.equal(past.end, Date.parse('2026-10-22T00:00:00+08:00'));

    assert.throws(() => windowForDate({ dateKey: '2026-10-24', now, timeZone: TZ }), /未来/);
    assert.throws(() => windowForDate({ dateKey: '2026-02-30', now, timeZone: TZ }), RangeError);
  });

  test('nextRunAfter / isPastWriteTime 以 23:30 为界', () => {
    assert.equal(isoWithOffset(nextRunAfter(at('2026-10-23T23:31:00+08:00'), '23:30', TZ), TZ), '2026-10-24T23:30:00+08:00');
    assert.equal(isoWithOffset(nextRunAfter(at('2026-10-23T10:00:00+08:00'), '23:30', TZ), TZ), '2026-10-23T23:30:00+08:00');
    assert.equal(isoWithOffset(nextRunAfter(at('2026-10-23T23:30:00+08:00'), '23:30', TZ), TZ), '2026-10-24T23:30:00+08:00');
    assert.equal(isPastWriteTime(at('2026-10-23T23:31:00+08:00'), '23:30', TZ), true);
    assert.equal(isPastWriteTime(at('2026-10-23T23:30:00+08:00'), '23:30', TZ), true);
    assert.equal(isPastWriteTime(at('2026-10-23T23:29:59+08:00'), '23:30', TZ), false);
  });
});

// ───────────────────────────── 调度器 ─────────────────────────────

function setupScheduler({ startNow, writeAt = '23:30', onDue, maxDailyRetries = 2, retryDelayMs = 1000 } = {}) {
  let clock = startNow.getTime();
  const timers = makeFakeTimers();
  const calls = [];
  const scheduler = startScheduler({
    writeAt,
    timeZone: TZ,
    tickMs: 60000,
    maxDailyRetries,
    retryDelayMs,
    now: () => clock,
    timers,
    onDue: async (ctx) => {
      calls.push(ctx);
      return onDue ? onDue(ctx, calls.length) : { ok: true };
    }
  });
  return {
    scheduler,
    timers,
    calls,
    setClock(iso) {
      clock = (iso instanceof Date ? iso : new Date(iso)).getTime();
    },
    advance(ms) {
      clock += ms;
    }
  };
}

describe('调度器（假时钟 + 注入 timers）', () => {
  test('启动时已过 23:30 且当天缺失 → 立即触发一次；当天不再重复', async () => {
    const h = setupScheduler({ startNow: at('2026-10-23T23:31:00+08:00') });
    h.scheduler.start();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].dateKey, '2026-10-23');
    assert.equal(h.calls[0].trigger, 'scheduled');
    assert.equal(h.scheduler.snapshot().fired, true);
    assert.equal(h.scheduler.snapshot().currentDate, '2026-10-23');

    // 同一天后续 tick 不再触发
    h.setClock('2026-10-23T23:50:00+08:00');
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);
    h.scheduler.stop();
    assert.equal(h.scheduler.snapshot().stopped, true);
    assert.equal(h.timers.intervalCount, 0);
  });

  test('未到点不触发；到点才触发（23:29:59 → 23:30:00）', async () => {
    const h = setupScheduler({ startNow: at('2026-10-23T10:00:00+08:00') });
    h.scheduler.start();
    await flushMicrotasks();
    assert.equal(h.calls.length, 0);
    assert.equal(h.scheduler.snapshot().fired, false);

    h.setClock('2026-10-23T23:29:59+08:00');
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 0);

    h.setClock('2026-10-23T23:30:00+08:00');
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].dateKey, '2026-10-23');
    h.scheduler.stop();
  });

  test('跨天后重新允许触发（一天一次，各天独立）', async () => {
    const h = setupScheduler({ startNow: at('2026-10-23T23:31:00+08:00') });
    h.scheduler.start();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);

    h.setClock('2026-10-24T23:31:00+08:00');
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].dateKey, '2026-10-24');
    assert.equal(h.scheduler.snapshot().fired, true);
    h.scheduler.stop();
  });

  test('不跨天补写：22 日 23:30 未跑，23 日 00:10 启动不应写 22 日', async () => {
    const h = setupScheduler({ startNow: at('2026-10-23T00:10:00+08:00') });
    h.scheduler.start();
    await flushMicrotasks();
    h.setClock('2026-10-23T00:11:00+08:00');
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 0);
    assert.equal(h.scheduler.snapshot().currentDate, '2026-10-23');
    // 当天到点后写的是 23 日，绝不是 22 日
    h.setClock('2026-10-23T23:30:30+08:00');
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].dateKey, '2026-10-23');
    assert.ok(!h.calls.some((call) => call.dateKey === '2026-10-22'));
    h.scheduler.stop();
  });

  test('onDue 失败 → 按 maxDailyRetries 重试，用尽后停止', async () => {
    const h = setupScheduler({
      startNow: at('2026-10-23T23:31:00+08:00'),
      maxDailyRetries: 2,
      retryDelayMs: 5000,
      onDue: () => ({ ok: false, error: 'boom' })
    });
    h.scheduler.start();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.timeoutCount, 1);
    assert.deepEqual(h.timers.timeoutDelays, [5000]);
    assert.equal(h.scheduler.snapshot().retries, 1);

    h.timers.runTimeouts();
    await flushMicrotasks();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].trigger, 'retry');
    assert.equal(h.timers.timeoutCount, 1);
    assert.equal(h.scheduler.snapshot().retries, 2);

    h.timers.runTimeouts();
    await flushMicrotasks();
    assert.equal(h.calls.length, 3);
    assert.equal(h.timers.timeoutCount, 0, '重试次数用尽后不应再排重试');
    assert.equal(h.scheduler.snapshot().retries, 2);
    assert.equal(h.scheduler.snapshot().lastResult.ok, false);

    // 同一天 tick 不会因为失败再次触发（已 fired）
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 3);
    h.scheduler.stop();
  });

  test('onDue 成功则不排重试；抛异常按失败处理并重试', async () => {
    const ok = setupScheduler({ startNow: at('2026-10-23T23:31:00+08:00'), onDue: () => ({ ok: true }) });
    ok.scheduler.start();
    await flushMicrotasks();
    assert.equal(ok.calls.length, 1);
    assert.equal(ok.timers.timeoutCount, 0);
    ok.scheduler.stop();

    const boom = setupScheduler({
      startNow: at('2026-10-23T23:31:00+08:00'),
      maxDailyRetries: 1,
      onDue: () => {
        throw new Error('synthetic failure');
      }
    });
    boom.scheduler.start();
    await flushMicrotasks();
    assert.equal(boom.calls.length, 1);
    assert.equal(boom.timers.timeoutCount, 1);
    boom.timers.runTimeouts();
    await flushMicrotasks();
    assert.equal(boom.calls.length, 2);
    assert.equal(boom.timers.timeoutCount, 0);
    boom.scheduler.stop();
  });

  test('重试跨天放弃（绝不补写昨天）', async () => {
    const h = setupScheduler({
      startNow: at('2026-10-23T23:31:00+08:00'),
      maxDailyRetries: 2,
      retryDelayMs: 1000,
      onDue: () => ({ ok: false, error: 'boom' })
    });
    h.scheduler.start();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.timeoutCount, 1);

    h.setClock('2026-10-24T00:10:00+08:00');
    h.timers.runTimeouts();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1, '跨天后不应为 23 日再触发一次');
    h.scheduler.stop();
  });

  test('stop 后 tick / 定时器都不再触发', async () => {
    const h = setupScheduler({ startNow: at('2026-10-23T23:31:00+08:00') });
    h.scheduler.start();
    await flushMicrotasks();
    h.scheduler.stop();
    h.scheduler.tick();
    h.timers.runIntervals();
    await flushMicrotasks();
    assert.equal(h.calls.length, 1);
    assert.equal(h.scheduler.snapshot().stopped, true);
  });

  test('非法 writeAt / 缺 onDue 直接抛错', () => {
    assert.throws(() => startScheduler({ writeAt: '25:00', onDue: () => {} }), RangeError);
    assert.throws(() => startScheduler({ writeAt: '23:30' }), TypeError);
  });
});

// ───────────────────────────── 单实例锁 ─────────────────────────────

describe('单实例锁', () => {
  const lockFile = () => path.join(mkTempRoot(), 'state', 'daemon.pid');

  test('acquireLock 两次：同 pid 可覆盖', () => {
    const file = lockFile();
    const first = acquireLock({ file, pid: process.pid, now: () => FIXED_NOW });
    assert.equal(first.ok, true);
    assert.equal(first.previous, null);
    assert.equal(readLockFile(file).pid, process.pid);

    const second = acquireLock({ file, pid: process.pid, now: () => FIXED_NOW });
    assert.equal(second.ok, true);
    assert.equal(second.previous.pid, process.pid);
    assert.equal(readLockFile(file).pid, process.pid);
  });

  test('acquireLock 不同 pid 且原进程存活 → ok:false，且不覆盖持有者', () => {
    const file = lockFile();
    assert.equal(acquireLock({ file, pid: process.pid, now: () => FIXED_NOW }).ok, true);
    const otherPid = process.pid + 400000;
    const result = acquireLock({ file, pid: otherPid, now: () => FIXED_NOW });
    assert.equal(result.ok, false);
    assert.equal(result.holder.pid, process.pid);
    assert.equal(readLockFile(file).pid, process.pid);
  });

  test('损坏的 pid 文件可接管（不抛异常）', () => {
    const file = lockFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'this-is-not-json', 'utf8');
    assert.equal(readLockFile(file), null);
    const taken = acquireLock({ file, pid: process.pid, now: () => FIXED_NOW });
    assert.equal(taken.ok, true);
    assert.equal(taken.previous, null);

    fs.writeFileSync(file, JSON.stringify({ pid: 'not-a-number' }), 'utf8');
    assert.equal(readLockFile(file), null);
    const taken2 = acquireLock({ file, pid: process.pid, now: () => FIXED_NOW });
    assert.equal(taken2.ok, true);
  });

  test('原进程已死 → 接管并记录 previous', () => {
    const file = lockFile();
    // 起一个立刻退出的子进程拿一个「确定已死」的 pid；极少数 pid 复用情况下多试几次
    let deadPid = null;
    for (let attempt = 0; attempt < 3 && deadPid === null; attempt += 1) {
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      if (child.pid > 0 && isProcessAlive(child.pid) === false) deadPid = child.pid;
    }
    assert.ok(deadPid, '未能取得一个已死亡 pid');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: deadPid, startedAt: '2026-10-23T10:00:00+08:00' }), 'utf8');
    const result = acquireLock({ file, pid: process.pid, now: () => FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(result.previous.pid, deadPid);
    assert.equal(readLockFile(file).pid, process.pid);
  });

  test('isProcessAlive：当前进程活着，明显非法/不存在的 pid 为 false', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive('abc'), false);
  });

  test('releaseLock 只删自己的锁', () => {
    const file = lockFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ pid: 424242 })}\n`, 'utf8');
    assert.equal(releaseLock({ file, pid: process.pid }), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(releaseLock({ file, pid: 424242 }), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(releaseLock({ file, pid: process.pid }), false);
  });
});
