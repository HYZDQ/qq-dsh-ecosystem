// 表现面软预算（GEN3 表现面 S0，设计 §5.3）：按 Asia/Shanghai 自然日/自然小时计数。
//   · 软预算不是安全边界：超限返回稳定错误码语义（ok:false），不抛裸异常；
//   · 文件写失败只降级（diskOk:false）继续用内存计数，观测不能带崩主链路；
//   · 搜索在 MCP 进程内计数、空间/日记在桥接进程内计数，各自持实例，计数文件不共享。
import fs from 'node:fs';
import path from 'node:path';

const SH_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai 固定 +08:00（无夏令时）

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 时间戳 → 上海自然日 'YYYY-MM-DD'。 */
export function dayKeyOf(ts) {
  const d = new Date(ts + SH_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 时间戳 → 上海自然小时 'YYYY-MM-DDTHH'。 */
export function hourKeyOf(ts) {
  const d = new Date(ts + SH_OFFSET_MS);
  return `${dayKeyOf(ts)}T${pad(d.getUTCHours())}`;
}

/** 下一个上海自然日 0 点 / 自然小时整点的时间戳。 */
function nextDayAt(ts) {
  const d = new Date(ts + SH_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  return Date.UTC(y, m, day + 1) - SH_OFFSET_MS;
}

function nextHourAt(ts) {
  const d = new Date(ts + SH_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1) - SH_OFFSET_MS;
}

function emptyCounts() {
  return {};
}

/**
 * 创建表现面预算实例。
 * @param {object} opts
 * @param {string} [opts.file]  快照文件路径（可选；缺省 = 纯内存）
 * @param {object} opts.limits  { [kind]: { hour?: number, day?: number } }
 * @param {() => number} [opts.now]
 */
export function createSurfaceBudget({ file, limits = {}, now = () => Date.now() } = {}) {
  let diskOk = true;
  let corrupt = false;
  let dayKey = dayKeyOf(now());
  let hourKey = hourKeyOf(now());
  let counts = emptyCounts();

  if (file && fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && typeof raw.dayKey === 'string' && raw.counts && typeof raw.counts === 'object') {
        dayKey = raw.dayKey;
        hourKey = typeof raw.hourKey === 'string' ? raw.hourKey : hourKey;
        counts = raw.counts;
      } else {
        corrupt = true;
      }
    } catch {
      corrupt = true; // 文件损坏：内存计数继续，告警标记保留
    }
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ dayKey, hourKey, counts }, null, 2)}\n`, 'utf8');
      diskOk = true;
    } catch {
      diskOk = false; // 只降级不抛：内存计数继续生效
    }
  }

  function rollover(ts) {
    const d = dayKeyOf(ts);
    const h = hourKeyOf(ts);
    if (d !== dayKey) {
      dayKey = d;
      hourKey = h;
      counts = emptyCounts(); // 日切：全部清零
      return;
    }
    if (h !== hourKey) {
      hourKey = h;
      for (const entry of Object.values(counts)) {
        if (entry && typeof entry === 'object') entry.hour = 0; // 小时切：只清小时计数
      }
    }
  }

  function usedOf(kind) {
    const entry = counts[kind];
    const day = entry && Number.isFinite(entry.day) ? entry.day : 0;
    const hour = entry && Number.isFinite(entry.hour) ? entry.hour : 0;
    return { day, hour };
  }

  return {
    /**
     * 计数 +1（或 +n）。返回 { ok, used, limit, resetAt, usedDay, usedHour, code? }。
     * 超限不抛错：ok:false + code:'SURFACE_BUDGET_EXCEEDED' + resetAt 供调用方稳定拒绝。
     */
    charge(kind, n = 1) {
      const ts = now();
      rollover(ts);
      const limit = (limits && limits[kind]) || {};
      const used = usedOf(kind);
      const inc = Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
      if (Number.isFinite(limit.day) && limit.day >= 0 && used.day + inc > limit.day) {
        return {
          ok: false, code: 'SURFACE_BUDGET_EXCEEDED', kind,
          used: used.day, limit: limit.day, usedDay: used.day, usedHour: used.hour,
          resetAt: new Date(nextDayAt(ts)).toISOString()
        };
      }
      if (Number.isFinite(limit.hour) && limit.hour >= 0 && used.hour + inc > limit.hour) {
        return {
          ok: false, code: 'SURFACE_BUDGET_EXCEEDED', kind,
          used: used.hour, limit: limit.hour, usedDay: used.day, usedHour: used.hour,
          resetAt: new Date(nextHourAt(ts)).toISOString()
        };
      }
      if (!counts[kind] || typeof counts[kind] !== 'object') counts[kind] = { day: 0, hour: 0 };
      counts[kind].day = used.day + inc;
      counts[kind].hour = used.hour + inc;
      persist();
      const limitForKind = Number.isFinite(limit.day) ? limit.day : (Number.isFinite(limit.hour) ? limit.hour : null);
      return {
        ok: true, kind, used: counts[kind].day, limit: limitForKind,
        usedDay: counts[kind].day, usedHour: counts[kind].hour,
        resetAt: new Date(nextDayAt(ts)).toISOString()
      };
    },

    /** 不计数查看：各 kind 当前用量、限额与重置时间。 */
    peek() {
      const ts = now();
      rollover(ts);
      const out = {};
      for (const kind of Object.keys(limits)) {
        const limit = limits[kind] || {};
        const used = usedOf(kind);
        out[kind] = {
          usedDay: used.day,
          usedHour: used.hour,
          limitDay: Number.isFinite(limit.day) ? limit.day : null,
          limitHour: Number.isFinite(limit.hour) ? limit.hour : null,
          dayResetAt: new Date(nextDayAt(ts)).toISOString(),
          hourResetAt: new Date(nextHourAt(ts)).toISOString()
        };
      }
      return out;
    },

    /** 落盘快照状态：供 health/status 展示，不含正文。 */
    snapshot() {
      return { dayKey, hourKey, diskOk, corrupt, counts: JSON.parse(JSON.stringify(counts)) };
    }
  };
}
