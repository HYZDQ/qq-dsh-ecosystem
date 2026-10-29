// 时间 / 调度 / 单实例锁。
//
// 所有「今天」「23:30」都按配置时区（默认 Asia/Shanghai）计算，**不依赖本机 TZ**，
// 所以测试可以注入任意 now 来覆盖 23:59 / 00:00 / 跨月 / 跨年边界。
//
// 这里只放纯函数 + 一个极简调度器（不 import 其它本地模块，避免循环依赖）。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 解析 "23:30" → { hour, minute }；非法返回 null。 */
export function parseWriteAt(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 主时区校验：非法时区抛 RangeError，调用方决定回退。 */
export function assertTimeZone(timeZone) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(0));
    return String(timeZone);
  } catch {
    throw new RangeError(`无效时区：${timeZone}`);
  }
}

const partsFormatterCache = new Map();
function partsFormatter(timeZone) {
  const cached = partsFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });
  partsFormatterCache.set(timeZone, formatter);
  return formatter;
}

/** 给定时刻在目标时区的日历字段。 */
export function zonedParts(value, timeZone = DEFAULT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('zonedParts 收到无效时间');
  const parts = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

const pad2 = (value) => String(value).padStart(2, '0');

export function formatDateKey({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** 目标时区里的日期键 YYYY-MM-DD。 */
export function dateKeyInZone(value = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return formatDateKey(zonedParts(value, timeZone));
}

/** 目标时区里的 HH:MM（日志/展示用）。 */
export function clockInZone(value = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(value, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** 目标时区里的 HH:MM:SS。 */
export function clockSecondsInZone(value = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(value, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

/** 某时刻所在时区相对 UTC 的偏移（毫秒，东八区为 +28800000）。 */
export function zoneOffsetMs(value, timeZone = DEFAULT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 把「目标时区的墙上时间」换成真实 UTC 时刻。 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = DEFAULT_TIMEZONE) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = wall - zoneOffsetMs(new Date(wall), timeZone);
  const secondGuess = wall - zoneOffsetMs(new Date(timestamp), timeZone);
  if (secondGuess !== timestamp) timestamp = secondGuess;
  return new Date(timestamp);
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-23" → { year, month, day }；非法返回 null。 */
export function parseDateKey(dateKey) {
  const match = DATE_KEY_RE.exec(String(dateKey ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 回环校验：2026-02-30 这类要判非法
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function isValidDateKey(dateKey) {
  return parseDateKey(dateKey) !== null;
}

/** 日期键加减天数（按 UTC 日历，不涉及时区偏移）。 */
export function addDays(dateKey, days) {
  const parts = parseDateKey(dateKey);
  if (!parts) throw new RangeError(`无效日期：${dateKey}`);
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return formatDateKey({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() });
}

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 中文星期（用 UTC 日历算，与日期键一致）。 */
export function weekdayCN(dateKey) {
  const parts = parseDateKey(dateKey);
  if (!parts) return '';
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return WEEKDAY_NAMES[base.getUTCDay()];
}

/** 目标时区的 ISO 8601（带 +08:00 偏移），用于 frontmatter.generatedAt。 */
export function isoWithOffset(value, timeZone = DEFAULT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = zonedParts(date, timeZone);
  const offsetMinutes = Math.round(zoneOffsetMs(date, timeZone) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${formatDateKey(parts)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** 目标时区某天 00:00:00 的真实时刻。 */
export function midnightInZone(dateKey, timeZone = DEFAULT_TIMEZONE) {
  const parts = parseDateKey(dateKey);
  if (!parts) throw new RangeError(`无效日期：${dateKey}`);
  return zonedTimeToUtc({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** 目标时区某天的 writeAt 时刻。 */
export function writeTimeFor(dateKey, writeAt, timeZone = DEFAULT_TIMEZONE) {
  const parsed = parseWriteAt(writeAt);
  if (!parsed) throw new RangeError(`无效的 writeAt：${writeAt}`);
  const parts = parseDateKey(dateKey);
  if (!parts) throw new RangeError(`无效日期：${dateKey}`);
  return zonedTimeToUtc({ ...parts, ...parsed, second: 0 }, timeZone);
}

/**
 * 上下文时间窗。
 * - 目标日期 = 今天：滚动窗口 [now - lookbackHours, now]
 * - 目标日期 < 今天：整日窗口 [00:00, 次日 00:00)
 */
export function windowForDate({ dateKey, now = new Date(), timeZone = DEFAULT_TIMEZONE, lookbackHours = 24 }) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = dateKeyInZone(nowDate, timeZone);
  const parts = parseDateKey(dateKey);
  if (!parts) throw new RangeError(`无效日期：${dateKey}`);
  if (dateKey > today) throw new RangeError(`不能为未来日期生成日记：${dateKey}`);
  if (dateKey === today) {
    const end = nowDate.getTime();
    return { start: end - Math.max(1, lookbackHours) * 3600000, end, kind: 'rolling' };
  }
  const start = midnightInZone(dateKey, timeZone).getTime();
  const end = midnightInZone(addDays(dateKey, 1), timeZone).getTime();
  return { start, end, kind: 'fullDay' };
}

/** now 之后的下一个 writeAt 时刻（严格大于 now）。 */
export function nextRunAfter(now, writeAt, timeZone = DEFAULT_TIMEZONE) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = dateKeyInZone(nowDate, timeZone);
  const todays = writeTimeFor(today, writeAt, timeZone);
  if (todays.getTime() > nowDate.getTime()) return todays;
  return writeTimeFor(addDays(today, 1), writeAt, timeZone);
}

/** now 是否已过当天的 writeAt。 */
export function isPastWriteTime(now, writeAt, timeZone = DEFAULT_TIMEZONE) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const today = dateKeyInZone(nowDate, timeZone);
  return nowDate.getTime() >= writeTimeFor(today, writeAt, timeZone).getTime();
}

// ───────────────────────────── 单实例锁 ─────────────────────────────

export function readLockFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    if (data && Number.isInteger(data.pid) && data.pid > 0) return data;
    return null;
  } catch {
    return null;
  }
}

/** pid 是否还活着（EPERM 表示存在但无权限发信号 → 视为活着）。 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 取锁：已有存活进程持锁 → { ok:false, holder }；文件损坏/进程已死 → 接管。
 * 用 PID 文件而不是 IPC，重启后不残留。
 */
export function acquireLock({ file, pid = process.pid, timeZone = DEFAULT_TIMEZONE, now = () => new Date() }) {
  const holder = readLockFile(file);
  if (holder && holder.pid !== pid && isProcessAlive(holder.pid)) {
    return { ok: false, holder };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    pid,
    startedAt: isoWithOffset(now(), timeZone),
    previous: holder ? { pid: holder.pid, startedAt: holder.startedAt ?? null } : null
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { ok: true, holder: null, previous: payload.previous };
}

export function releaseLock({ file, pid = process.pid }) {
  const holder = readLockFile(file);
  if (holder && holder.pid !== pid) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── 调度器 ─────────────────────────────

/**
 * 每分钟 tick 一次，每天 writeAt 之后触发一次 onDue；启动时立刻 tick 一次，
 * 所以「启动时已过 22:00 且当天缺失」会当天补写。
 *
 * onDue 返回 { ok, skipped, error }：
 * - 成功/跳过 → 不再重试；
 * - 失败（未跳过）→ 当天内按 retryDelayMs 重试，最多 maxDailyRetries 次；
 * - 跨天后自动重置，绝不跨天补写。
 * fire 里带 running 互斥，慢调用不会重入。
 */
export function startScheduler({
  writeAt = '22:00',
  timeZone = DEFAULT_TIMEZONE,
  tickMs = 60000,
  maxDailyRetries = 2,
  retryDelayMs = 900000,
  logger = null,
  onDue,
  now = () => Date.now(),
  timers = { setInterval, clearInterval, setTimeout, clearTimeout }
}) {
  if (typeof onDue !== 'function') throw new TypeError('startScheduler 需要 onDue');
  const parsed = parseWriteAt(writeAt);
  if (!parsed) throw new RangeError(`无效的 writeAt：${writeAt}`);

  let currentDate = null;
  let fired = false;
  let retries = 0;
  let running = false;
  let stopped = false;
  let retryTimer = null;
  let interval = null;
  let lastDueAt = null;
  let lastResult = null;

  const clearRetry = () => {
    if (retryTimer) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  function rollDate(nowMs) {
    const dateKey = dateKeyInZone(new Date(nowMs), timeZone);
    if (dateKey !== currentDate) {
      currentDate = dateKey;
      fired = false;
      retries = 0;
      clearRetry();
    }
    return dateKey;
  }

  async function fire(dateKey, trigger) {
    if (stopped || running) return null;
    running = true;
    lastDueAt = now();
    let result;
    try {
      result = await onDue({ dateKey, trigger });
    } catch (error) {
      result = { ok: false, error: String(error?.message ?? error) };
    } finally {
      running = false;
    }
    lastResult = { at: now(), dateKey, trigger, ...(result ?? {}) };
    if (result && result.ok === false && !result.skipped) {
      logger?.warn?.(`[scheduler] ${dateKey} 生成失败：${result.error ?? '未知原因'}（不写文件）`);
      if (retries < maxDailyRetries && !stopped) {
        retries += 1;
        logger?.info?.(`[scheduler] ${Math.round(retryDelayMs / 60000)} 分钟后第 ${retries}/${maxDailyRetries} 次重试 ${dateKey}`);
        clearRetry();
        retryTimer = timers.setTimeout(() => {
          retryTimer = null;
          if (stopped) return;
          const todayKey = dateKeyInZone(new Date(now()), timeZone);
          if (todayKey !== dateKey) {
            logger?.info?.('[scheduler] 已跨天，放弃昨天的重试（不跨天补写）');
            return;
          }
          void fire(dateKey, 'retry');
        }, retryDelayMs);
        retryTimer?.unref?.();
      } else {
        logger?.error?.(`[scheduler] ${dateKey} 当日重试次数已用尽，等待下一次调度/手动 --date 补写`);
      }
    }
    return result;
  }

  function tick() {
    if (stopped) return;
    const nowMs = now();
    const dateKey = rollDate(nowMs);
    if (fired) return;
    const due = writeTimeFor(dateKey, writeAt, timeZone).getTime();
    if (nowMs >= due) {
      fired = true;
      void fire(dateKey, 'scheduled');
    }
  }

  function start() {
    if (interval) return { started: true };
    tick();
    interval = timers.setInterval(tick, tickMs);
    interval?.unref?.();
    logger?.info?.(`[scheduler] 已启动：每天 ${writeAt}（${timeZone}）写日记，tick=${Math.round(tickMs / 1000)}s`);
    return { started: true };
  }

  function stop() {
    stopped = true;
    clearRetry();
    if (interval) {
      timers.clearInterval(interval);
      interval = null;
    }
  }

  return {
    start,
    stop,
    tick,
    snapshot: () => ({ currentDate, fired, retries, running, stopped, lastDueAt, lastResult })
  };
}
