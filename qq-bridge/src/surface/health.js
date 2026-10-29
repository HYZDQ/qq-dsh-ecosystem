// 表现面健康视图（GEN3 表现面 S0，设计 §17.2.2）：/api/socialV3/surface/status 的数据形状。
//
// 纯函数：数据由调用方注入（预算、最近事件、各面运行态），这里只做「安全投影」——
//   · 不返回说说正文、日记正文、搜索词；
//   · 哈希只给前 16 位（输入侧已是 hashForTrace/trace.idHash 的 16 位，这里再截一层防御）；
//   · 缺数据填 null/占位，不猜状态。
import { surfaceConfigSection, surfaceEnabled } from './registry.js';

const HASH_RE = /^[0-9a-f]{8,64}$/i;

/** 哈希投影：只保留合法十六进制并截到 16 位；其余一律 null。 */
function hash16(value) {
  const s = String(value ?? '');
  return HASH_RE.test(s) ? s.slice(0, 16) : null;
}

function budgetView(input) {
  if (!input || typeof input !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  return {
    hourUsed: num(input.hourUsed ?? input.usedHour),
    hourLimit: num(input.hourLimit ?? input.limitHour),
    dayUsed: num(input.dayUsed ?? input.usedDay),
    dayLimit: num(input.dayLimit ?? input.limitDay)
  };
}

/** 最近一次事件投影：只留时间/结果/枚举，不留正文。 */
function lastView(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    at: typeof input.at === 'string' ? input.at : (typeof input.ts === 'string' ? input.ts : null),
    ok: input.ok === true ? true : (input.ok === false ? false : null),
    op: typeof input.op === 'string' ? input.op.slice(0, 40) : null,
    provider: typeof input.provider === 'string' ? input.provider.slice(0, 40) : null,
    cached: input.cached === true ? true : (input.cached === false ? false : null),
    degraded: input.degraded === true ? true : (input.degraded === false ? false : null),
    errorCode: typeof input.errorCode === 'string' ? input.errorCode.slice(0, 60) : null
  };
}

function lastPublishView(input) {
  if (!input || typeof input !== 'object') return null;
  return {
    state: typeof input.state === 'string' ? input.state.slice(0, 20) : null,
    tidHash: hash16(input.tidHash ?? input.tid),
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : null,
    verifiedAt: typeof input.verifiedAt === 'string' ? input.verifiedAt : null
  };
}

/**
 * 构建表现面健康快照（控制台/排障视图，不返回正文）。
 * @param {object} opts
 * @param {object} opts.cfg            完整配置（含 socialV3.enabled / modules.surface / surface.*）
 * @param {object} [opts.budgets]      { web, qzone, diary } → budget.peek() 形状
 * @param {object} [opts.lastEvents]   { web, qzone, diary } → SurfaceEvent/运行摘要
 * @param {object} [opts.runtime]      { qzone: {...}, diary: {...} } 各面运行态（S2/S3 接线）
 * @param {object} [opts.cost]         cost.snapshot()（可选）
 * @param {number} [opts.now]
 */
export function buildSurfaceStatus({ cfg = {}, budgets = {}, lastEvents = {}, runtime = {}, cost = null, now = Date.now() } = {}) {
  const socialV3 = cfg.socialV3 ?? {};
  const surfaceCfg = socialV3.surface ?? {};
  const qzoneCfg = surfaceCfg.qzone ?? {};
  const diaryCfg = surfaceCfg.diary ?? {};
  const webCfg = surfaceCfg.webSearch ?? {};
  const rtQzone = runtime.qzone && typeof runtime.qzone === 'object' ? runtime.qzone : {};
  const rtDiary = runtime.diary && typeof runtime.diary === 'object' ? runtime.diary : {};

  return {
    ok: true,
    builtAt: new Date(now).toISOString(),
    moduleOn: socialV3.modules?.surface === true,
    schemaVersion: 1,
    surfaces: {
      web: {
        enabled: surfaceEnabled(cfg, 'web'),
        budget: budgetView(budgets.web),
        last: lastView(lastEvents.web),
        draftMaterialPerDay: Number.isFinite(Number(webCfg.draftMaterialPerDay)) ? Number(webCfg.draftMaterialPerDay) : null
      },
      qzone: {
        enabled: surfaceEnabled(cfg, 'qzone'),
        mode: typeof socialV3.mode === 'string' ? socialV3.mode : null,
        contextSource: typeof qzoneCfg.contextSource === 'string' ? qzoneCfg.contextSource : null,
        defaultVisibility: typeof rtQzone.defaultVisibility === 'string' ? rtQzone.defaultVisibility : null,
        proactive: {
          // v1.4 主人已定：每天随机 1~3 条、想发就发（proactiveApproval 默认 false）
          enabled: rtQzone.proactive?.enabled === true,
          approval: qzoneCfg.proactiveApproval === true,
          minPerDay: Number.isFinite(Number(qzoneCfg.proactiveMinPerDay)) ? Number(qzoneCfg.proactiveMinPerDay) : null,
          maxPerDay: Number.isFinite(Number(qzoneCfg.proactiveMaxPerDay)) ? Number(qzoneCfg.proactiveMaxPerDay) : null,
          nextRunAt: typeof rtQzone.proactive?.nextRunAt === 'string' ? rtQzone.proactive.nextRunAt : null
        },
        lastPublish: lastPublishView(rtQzone.lastPublish),
        quota: {
          usedToday: Number.isFinite(Number(rtQzone.quota?.usedToday)) ? Number(rtQzone.quota.usedToday) : null,
          limit: Number.isFinite(Number(rtQzone.quota?.limit)) ? Number(rtQzone.quota.limit) : null
        },
        unknownCount: Number.isFinite(Number(rtQzone.unknownCount)) ? Math.max(0, Math.round(Number(rtQzone.unknownCount))) : 0
      },
      diary: {
        enabled: surfaceEnabled(cfg, 'diary'),
        contextSource: typeof diaryCfg.contextSource === 'string' ? diaryCfg.contextSource : null,
        writeAt: typeof rtDiary.writeAt === 'string' ? rtDiary.writeAt : '22:00',
        lastRun: rtDiary.lastRun && typeof rtDiary.lastRun === 'object'
          ? {
            at: typeof rtDiary.lastRun.at === 'string' ? rtDiary.lastRun.at : null,
            ok: rtDiary.lastRun.ok === true ? true : (rtDiary.lastRun.ok === false ? false : null),
            date: typeof rtDiary.lastRun.date === 'string' ? rtDiary.lastRun.date : null
          }
          : null,
        nextRunAt: typeof rtDiary.nextRunAt === 'string' ? rtDiary.nextRunAt : null,
        memoryQueue: Number.isFinite(Number(rtDiary.memoryQueue)) ? Math.max(0, Math.round(Number(rtDiary.memoryQueue))) : 0
      }
    },
    cost: cost && typeof cost === 'object'
      ? {
        day: typeof cost.day === 'string' ? cost.day : null,
        total: cost.total && typeof cost.total === 'object' ? cost.total : null,
        overBudget: cost.overBudget === true
      }
      : null
  };
}

/** 面配置段名校验导出（health 与 bridge 共用同一判定）。 */
export { surfaceConfigSection };
