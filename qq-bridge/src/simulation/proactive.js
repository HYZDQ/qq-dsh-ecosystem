// 三代仿真主动性模块（GEN3 2.2，设计见 docs/design/GEN3_SIMULATION_PLAN.md 6.7 节）：
// 作息（quiet hours）+ interruptibility 五信号 + 打扰预算（per-group/per-user/冷却/未回应降频）+ 未尽话题跟进。
//
// 硬约束（6.7 / 8.1 全部落在纯函数里）：
//   1. 时间可注入：now/hour/dayKey 全部由调用方传入（Asia/Shanghai 口径由调用方换算好再传），
//      模块不做时区 IO、不读系统时钟、无隐藏随机；
//   2. 与 socialV2.proactive 共存（8.1）：V2 概率判定在前、本模块预算闸叠加其后；
//      V2 概率模型是回退路径，模块关闭时零改动；
//   3. 预算「降频不归零」：连续未回应按 backoffFactor 拉长冷却（因子下限 0.25 = 最多 4 倍冷却），
//      绝不把主动概率/预算直接清零；
//   4. 未尽话题「没人接就放下」：跟进尝试封顶 followUpMax、过期即弃，不反复追问；
//   5. 全部数值保留 3 位小数（确定性，跨机器可比）。
//
// 全模块零 IO、纯函数、无隐藏随机（关键词族/权重/时长全部是导出常量或入参）。

// ──────────────────────────── 常量 ────────────────────────────

/** interruptibility 五信号权重（和为 1）：对方活跃/群流/bot 新鲜度/话题相关/回复延迟。 */
export const INTERRUPT_WEIGHTS = Object.freeze({
  peerActive: 0.3,
  groupFlow: 0.25,
  botFreshness: 0.2,
  topicAboutBot: 0.15,
  replyLatency: 0.1
});

/** bot「刚说过话」扣分窗口（分钟）：botFreshness = min(1, minutes / 30)，刚说完 → 0（不插嘴）。 */
export const FRESH_WINDOW_MINUTES = 30;

/**
 * 未尽话题关键词族（顺序即 followUpDecision 的平手裁决顺序：先声明者先追）。
 * expiryHours = 到期跟进时点（考试/出行 24h、承诺 12h、生病 8h）；
 * 过期时点 = 到期 + 一个同周期（宽限），再没人接就放下。
 */
export const FOLLOW_UP_FAMILIES = Object.freeze([
  Object.freeze({ topic: 'promise', expiryHours: 12, words: Object.freeze(['回头', '改天', '下次', '明天说', '答应你']) }),
  Object.freeze({ topic: 'exam', expiryHours: 24, words: Object.freeze(['考试', '测验', '期末']) }),
  Object.freeze({ topic: 'sick', expiryHours: 8, words: Object.freeze(['生病', '发烧', '感冒', '不舒服']) }),
  Object.freeze({ topic: 'travel', expiryHours: 24, words: Object.freeze(['出差', '旅游', '回家', '出发']) })
]);

// ──────────────────────────── 数值助手 ────────────────────────────

/** 钳 [0, 1]；非有限数按 0（不伪造信号）。 */
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 保留 3 位小数（确定性）；-0 归一成 0，避免 deepEqual 把 -0 当不同值。 */
function round3(x) {
  const v = Math.round(Number(x) * 1000) / 1000;
  return v === 0 ? 0 : v;
}

/** 小时归一到 [0, 23] 整数；非有限数回 fallback（hour 缺省回 0 = 保守落进深夜）。 */
function toHour23(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return ((Math.floor(n) % 24) + 24) % 24;
}

/** 计数归一：非负整数。 */
function toCount(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

// ──────────────────────────── 作息（quiet hours）────────────────────────────

/**
 * 作息闸：深夜区间不主动（6.7「深夜默认不主动」）。**固定 Asia/Shanghai 口径**：
 * hour/minute/weekday 是调用方已换算好的本地时刻，本函数不做时区 IO。
 *
 * 规则：
 *   - 深夜区间 [quietFrom, quietTo)（小时粒度），支持跨午夜：quietFrom > quietTo（如 23→8）
 *     时 quiet ⇔ hour ≥ quietFrom || hour < quietTo；不跨午夜（如 13→14）时
 *     quiet ⇔ quietFrom ≤ hour < quietTo；quietFrom === quietTo 视为无深夜区间（恒不 quiet）；
 *   - exceptions（如 { atMe, privateChat, isOwner, explicitQuestion }）**任一为真**
 *     → { quiet: false, reason: 'exception' }（例外优先于作息）；
 *   - 返回 { quiet, reason }，reason ∈ 'exception' | 'quiet-hours' | 'awake'；
 *   - hour 非法按 0 处理（保守落进深夜）；minute 只作口径透传（当前边界按整点），
 *     weekday 透传不做日历（节假日/周末例外由调用方折算进 exceptions）。
 *
 * @param {object} [opts]
 * @param {number} [opts.hour=0] 本地小时 0~23（调用方换算）
 * @param {number} [opts.minute=0] 本地分钟（透传，不参与整点边界）
 * @param {number} [opts.weekday=0] 星期 0~6（透传，不做日历 IO）
 * @param {number} [opts.quietFrom=23] 深夜起点 0~23
 * @param {number} [opts.quietTo=8] 深夜终点 0~23
 * @param {object} [opts.exceptions] 例外开关（任一为真即豁免深夜）
 * @returns {{ quiet: boolean, reason: string }}
 */
export function quietDecision({ hour, minute, weekday, quietFrom = 23, quietTo = 8, exceptions } = {}) {
  if (exceptions && typeof exceptions === 'object' && Object.values(exceptions).some((v) => !!v)) {
    return { quiet: false, reason: 'exception' };
  }
  const hh = toHour23(hour, 0);
  const from = toHour23(quietFrom, 23);
  const to = toHour23(quietTo, 8);
  let quiet;
  if (from === to) quiet = false; // 起止相同 = 无深夜区间
  else if (from > to) quiet = hh >= from || hh < to; // 跨午夜（23→8）
  else quiet = hh >= from && hh < to; // 同日区间（如 13→14）
  return { quiet, reason: quiet ? 'quiet-hours' : 'awake' };
}

// ──────────────────────────── interruptibility ────────────────────────────

/**
 * 可打断度五信号加权（6.7「综合成 0~1 分数，低于阈值不主动」）。信号全部归一 [0, 1]：
 *
 *   score = 0.30×recentPeerActive        对方最近活跃度（入参归一）
 *         + 0.25×groupFlow               群里多人连续对话程度（入参归一）
 *         + 0.20×botFreshness            bot 新鲜度 = min(1, botSpokeMinutesAgo/30)；
 *                                        bot 刚说过话 → 0（扣分不插嘴），没说过/很久 → 1；
 *         + 0.15×topicAboutBot           当前话题是否与 bot 相关（入参归一）
 *         + 0.10×replyLatency            回复延迟信号：replyLatencyKnown=true 才取
 *                                        clamp01(replyLatencyScore)，**平台不提供时记 0 且不伪造**。
 *
 * 结果钳 [0, 1] 保留 3 位小数（确定性）；NaN/缺省信号一律按 0（不伪造）。
 *
 * @param {object} [opts]
 * @param {number} [opts.recentPeerActive=0] 对方最近活跃度 0~1
 * @param {number} [opts.groupFlow=0] 群聊流量/多人对话程度 0~1
 * @param {number} [opts.botSpokeMinutesAgo=Infinity] bot 上次发言距今分钟数（Infinity=很久/没说过）
 * @param {number} [opts.topicAboutBot=0] 话题与 bot 相关度 0~1
 * @param {boolean} [opts.replyLatencyKnown=false] 平台是否提供回复延迟信号
 * @param {number} [opts.replyLatencyScore=0] 回复延迟信号 0~1（只在 known=true 时作数）
 * @returns {number} 0~1，保留 3 位小数
 */
export function interruptScore({
  recentPeerActive = 0,
  groupFlow = 0,
  botSpokeMinutesAgo = Infinity,
  topicAboutBot = 0,
  replyLatencyKnown = false,
  replyLatencyScore = 0
} = {}) {
  const minutes = Number(botSpokeMinutesAgo);
  // Infinity/NaN/缺省 = bot 早说过话或根本没说过 → 新鲜度 1（不扣分）；负数按 0
  const freshness = !Number.isFinite(minutes) ? 1 : Math.min(1, Math.max(0, minutes) / FRESH_WINDOW_MINUTES);
  const latency = replyLatencyKnown === true ? clamp01(replyLatencyScore) : 0;
  const raw =
    INTERRUPT_WEIGHTS.peerActive * clamp01(recentPeerActive) +
    INTERRUPT_WEIGHTS.groupFlow * clamp01(groupFlow) +
    INTERRUPT_WEIGHTS.botFreshness * freshness +
    INTERRUPT_WEIGHTS.topicAboutBot * clamp01(topicAboutBot) +
    INTERRUPT_WEIGHTS.replyLatency * latency;
  return round3(Math.min(1, Math.max(0, raw)));
}

/**
 * 阈值判定辅助：score < threshold → true（严格小于才算「低于阈值」）。
 * threshold 缺省 0.3（与 config proactive.interruptThreshold 默认一致），非法回 0.3。
 */
export function belowThreshold(score, threshold = 0.3) {
  const t = Number(threshold);
  return clamp01(score) < (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.3);
}

// ──────────────────────────── 打扰预算 ────────────────────────────

/**
 * 预算初始形状：
 *   dayKey       当日计数所属日期（调用方给的字符串，如 '2026-10-25'）
 *   groupCounts  groupKey → 当日已主动次数（per-group/day）
 *   userCounts   userKey → 当日已主动次数（per-user/day）
 *   lastAt       targetKey → 上次主动时间戳（冷却判定）
 *   unanswered   targetKey → 连续未回应次数（降频依据，跨日保留）
 */
export function budgetState() {
  return { dayKey: null, groupCounts: {}, userCounts: {}, lastAt: {}, unanswered: {} };
}

/** state 归一：空/缺省从 budgetState() 起步，拷贝不共享引用（所有预算操作都是纯函数）。 */
function normalizeBudget(state) {
  const src = state && typeof state === 'object' ? state : {};
  const copyMap = (m) => (m && typeof m === 'object' ? { ...m } : {});
  return {
    dayKey: typeof src.dayKey === 'string' && src.dayKey ? src.dayKey : null,
    groupCounts: copyMap(src.groupCounts),
    userCounts: copyMap(src.userCounts),
    lastAt: copyMap(src.lastAt),
    unanswered: copyMap(src.unanswered)
  };
}

function countOf(map, key) {
  return toCount(map?.[key], 0);
}

/**
 * 预算三闸（6.7「per-group/day、per-user/day、冷却时间」），按序判定，任一不过即拒：
 *   ① per-group/day：当日该群已主动次数 ≥ perGroupDaily → { allow: false, reason: 'per-group-daily' }
 *      （perGroupDaily=0 = 该群今天一律不主动）；
 *   ② per-user/day：同理 → 'per-user-daily'；
 *   ③ 同目标冷却：now − lastAt[target] < cooldownMs → 'cooldown'（target = groupKey || userKey）。
 * 全过 → { allow: true, reason: 'ok' }。
 *
 * 当日计数只在 state.dayKey === dayKey 时作数（换日还没 rollDay 也不误拒）；
 * groupKey/userKey 缺省的那一闸自动跳过。不改入参。
 *
 * @param {object} [state] budgetState() 形状
 * @param {object} [opts]
 * @param {string} [opts.groupKey] 群目标键（调用方字符串，私聊场景传 null）
 * @param {string} [opts.userKey] 用户目标键（私聊场景传会话键，群场景传 null）
 * @param {string} [opts.dayKey] 当日日期键（调用方给的字符串）
 * @param {number} [opts.now=0] 当前时间戳
 * @param {number} [opts.perGroupDaily=3] 每群每日上限
 * @param {number} [opts.perUserDaily=1] 每人每日上限
 * @param {number} [opts.cooldownMs=0] 同目标冷却毫秒（不传 = 无冷却）
 * @returns {{ allow: boolean, reason: string }}
 */
export function checkBudget(state, { groupKey = null, userKey = null, dayKey = null, now = 0, perGroupDaily = 3, perUserDaily = 1, cooldownMs = 0 } = {}) {
  const s = normalizeBudget(state);
  const day = dayKey == null ? null : String(dayKey);
  const sameDay = s.dayKey !== null && s.dayKey === day;
  const gk = groupKey == null ? '' : String(groupKey);
  const uk = userKey == null ? '' : String(userKey);
  const gMax = toCount(perGroupDaily, 3);
  const uMax = toCount(perUserDaily, 1);
  if (gk && (sameDay ? countOf(s.groupCounts, gk) : 0) >= gMax) return { allow: false, reason: 'per-group-daily' };
  if (uk && (sameDay ? countOf(s.userCounts, uk) : 0) >= uMax) return { allow: false, reason: 'per-user-daily' };
  const target = gk || uk;
  const last = target ? Number(s.lastAt[target]) : NaN;
  const nowN = Number(now);
  const cd = Math.max(0, Number(cooldownMs) || 0);
  if (cd > 0 && target && Number.isFinite(last) && Number.isFinite(nowN) && nowN - last < cd) {
    return { allow: false, reason: 'cooldown' };
  }
  return { allow: true, reason: 'ok' };
}

/**
 * 记账一次主动（纯函数，返回新 state，不改入参）：
 *   当日计数 +1（groupKey/userKey 各自）、lastAt[target] = now（target = groupKey || userKey）。
 * dayKey 与 state 不一致时自动换日清零当日计数（等价先 rollDay，保留 unanswered/lastAt）。
 */
export function consumeBudget(state, { groupKey = null, userKey = null, dayKey = null, now = 0 } = {}) {
  const s = normalizeBudget(state);
  const day = dayKey == null ? null : String(dayKey);
  if (s.dayKey !== day) {
    s.dayKey = day;
    s.groupCounts = {};
    s.userCounts = {};
  }
  const gk = groupKey == null ? '' : String(groupKey);
  const uk = userKey == null ? '' : String(userKey);
  if (gk) s.groupCounts[gk] = countOf(s.groupCounts, gk) + 1;
  if (uk) s.userCounts[uk] = countOf(s.userCounts, uk) + 1;
  const target = gk || uk;
  const nowN = Number(now);
  if (target) s.lastAt[target] = Number.isFinite(nowN) ? nowN : 0;
  return s;
}

/**
 * 记一次「主动发出后没人接」：unanswered[targetKey] +1（纯函数，返回新 state）。
 * 计数只增不减（连续未回应），复位靠 rollDay 之外的重建/清表。
 */
export function noteUnanswered(state, targetKey) {
  const s = normalizeBudget(state);
  const k = targetKey == null ? '' : String(targetKey);
  if (k) s.unanswered[k] = countOf(s.unanswered, k) + 1;
  return s;
}

/**
 * 降频因子（6.7「连续未回应 → 自动降频」）：
 *   backoffFactor = max(0.25, 1 − 0.25 × 连续未回应次数)（0 次=1、1 次=0.75、2 次=0.5、3 次起=0.25 封底）。
 * 「降频不归零」：下限 0.25，绝不把主动机会直接清掉。保留 3 位小数。
 */
export function backoffFactor(state, targetKey) {
  const s = normalizeBudget(state);
  const n = countOf(s.unanswered, String(targetKey ?? ''));
  return round3(Math.max(0.25, 1 - 0.25 * n));
}

/**
 * 换日清零（纯函数，返回新 state）：groupCounts/userCounts 清空、dayKey 更新；
 * **保留** unanswered（连续未回应连击跨日继续）与 lastAt（冷却跨日继续）。
 */
export function rollDay(state, dayKey) {
  const s = normalizeBudget(state);
  s.dayKey = dayKey == null ? null : String(dayKey);
  s.groupCounts = {};
  s.userCounts = {};
  return s;
}

// ──────────────────────────── 未尽话题 ────────────────────────────

/**
 * 从未尽话题关键词族抽跟进项（6.7「承诺/待跟进/考试/生病/出行」）。
 *
 * 规则：
 *   - 每命中一个族出一条 { topic, confidence, expiryHours, source, createdAt, dueAt, expiresAt, attempts }；
 *   - confidence = min(1, 命中族数 / 2)（命中族越多越可信，封顶 1），保留 3 位小数；
 *   - expiryHours：考试/出行 24h、承诺 12h、生病 8h；
 *     dueAt = now + expiryHours（到期跟进时点）、expiresAt = now + 2×expiryHours（宽限一个周期，
 *     之后没人接/没机会就放下）；
 *   - attempts 从 0 起（markFollowed 记尝试次数）；source 透传（会话/消息来源标识）。
 * 无命中返回 []。
 *
 * @param {string} text 对方消息文本
 * @param {object} [opts]
 * @param {number} [opts.now=0] 当前时间戳（可注入，不读时钟）
 * @param {string} [opts.source] 来源标识（透传）
 * @returns {Array<{topic: string, confidence: number, expiryHours: number, source: string|null, createdAt: number, dueAt: number, expiresAt: number, attempts: number}>}
 */
export function extractFollowUps(text, { now = 0, source } = {}) {
  const src = String(text ?? '');
  const at = Number.isFinite(Number(now)) ? Number(now) : 0;
  const hits = FOLLOW_UP_FAMILIES.filter((fam) => fam.words.some((w) => src.includes(w)));
  if (!hits.length) return [];
  const confidence = round3(Math.min(1, hits.length / 2));
  return hits.map((fam) => {
    const ms = fam.expiryHours * 3600000;
    return {
      topic: fam.topic,
      confidence,
      expiryHours: fam.expiryHours,
      source: source == null ? null : String(source),
      createdAt: at,
      dueAt: at + ms,
      expiresAt: at + 2 * ms,
      attempts: 0
    };
  });
}

/**
 * 跟进决策（6.7「到期/次日跟进；没人接就放下，不反复追问」）：
 * 待跟进项里**到期未跟进（now ≥ dueAt）且尝试次数 < followUpMax 且未过期（now < expiresAt）**
 * 的第一条 → { item, due }（due = item.dueAt），按数组顺序（= 命中族声明顺序）先到先追；
 * 没有 → null。已过期/尝试到上限的项自动跳过（放下，不反复追问）。
 */
export function followUpDecision(items, { now = 0, followUpMax = 2 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const at = Number.isFinite(Number(now)) ? Number(now) : 0;
  const max = toCount(followUpMax, 2);
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (countOf(item, 'attempts') >= max) continue; // 尝试到上限：放下
    const due = Number(item.dueAt);
    if (!Number.isFinite(due) || at < due) continue; // 未到期：不追
    const exp = Number(item.expiresAt);
    if (Number.isFinite(exp) && at >= exp) continue; // 过期：放下
    return { item, due };
  }
  return null;
}

/**
 * 记一次跟进尝试（纯函数，返回新数组，不改入参）：topic 匹配的第一条 attempts +1，
 * 其余项拷贝返回（不共享引用）；topic 无命中时原样拷贝返回。
 */
export function markFollowed(state, topic) {
  const list = Array.isArray(state) ? state : [];
  const key = String(topic ?? '');
  let done = false;
  return list.map((item) => {
    const copy = item && typeof item === 'object' ? { ...item } : item;
    if (!done && copy && typeof copy === 'object' && String(copy.topic ?? '') === key) {
      done = true;
      copy.attempts = countOf(item, 'attempts') + 1;
    }
    return copy;
  });
}
