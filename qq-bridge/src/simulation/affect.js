// 三代仿真情感模块（GEN3 2.1，设计见 docs/design/GEN3_SIMULATION_PLAN.md 6.6 节）：
// PAD 三维情绪（pleasure 愉悦 / arousal 唤醒 / dominance 掌控感）+ 快慢双速动力学 + 事件评估 + 保守乘数。
//
// 硬约束（6.6 全部落在纯函数里）：
//   1. 情绪只调制句长/延迟/表情率/主动概率/是否敢插话，**不覆盖事实、不改权限、不改许可名单**；
//   2. 幅度保守：乘数全部钳 [0.8, 1.2]，modulationScale=0 一键归零；
//   3. 双速动力学：快变量（事件增量）+ 慢回归（向 baseline 回撤）+ baseline 缓慢跟随（差的 10%）；
//   4. PAD 每维钳 [-1, 1]，全部数值保留 3 位小数（确定性，无隐藏随机）；
//   5. 可一键复位（resetPad 返回中性 state）。
//
// 全模块零 IO、纯函数、无隐藏随机（关键词表/系数全部入参可调）。

// ──────────────────────────── 常量 ────────────────────────────

/** PAD 每维取值范围：钳制 [-1, 1]。 */
export const PAD_LIMITS = Object.freeze({ min: -1, max: 1 });

/** 事件类型清单（顺序即平手裁决顺序：先声明者胜）。 */
export const EVENT_KINDS = Object.freeze(['goodNews', 'badNews', 'praised', 'attacked', 'ignored', 'awkward', 'neutral']);

/**
 * 事件 → PAD 保守增量 [p, a, d]（6.6「幅度保守，默认小系数」）。
 * 例：被骂 attacked [-0.3, 0.35, -0.2] —— 不愉悦、高度唤醒、掌控感下降。
 */
export const EVENT_DELTAS = Object.freeze({
  goodNews: Object.freeze([0.3, 0.2, 0.05]),
  badNews: Object.freeze([-0.35, -0.1, -0.15]),
  praised: Object.freeze([0.25, 0.15, 0.1]),
  attacked: Object.freeze([-0.3, 0.35, -0.2]),
  ignored: Object.freeze([-0.15, -0.05, -0.1]),
  awkward: Object.freeze([-0.1, 0.15, -0.05]),
  neutral: Object.freeze([0, 0, 0])
});

/** 内置关键词表（classifyEvent 默认；可用 options.tables 整体覆盖）。neutral 无词表 = 兜底类。 */
export const DEFAULT_EVENT_TABLES = Object.freeze({
  goodNews: Object.freeze(['好消息', '开心', '中奖']),
  badNews: Object.freeze(['坏消息', '难过', '生病']),
  praised: Object.freeze(['夸', '厉害', '太棒']),
  attacked: Object.freeze(['骂', '烦你', '闭嘴']),
  ignored: Object.freeze(['没人理', '冷场', '已读不回']),
  awkward: Object.freeze(['尴尬', '社死']),
  neutral: Object.freeze([])
});

// ──────────────────────────── 数值助手 ────────────────────────────

/** 钳 PAD 单维到 [-1, 1]。 */
function clampPad(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(PAD_LIMITS.max, Math.max(PAD_LIMITS.min, n));
}

/** 保留 3 位小数（确定性）；-0 归一成 0，避免 deepEqual 把 -0 当不同值。 */
function round3(x) {
  const v = Math.round(Number(x) * 1000) / 1000;
  return v === 0 ? 0 : v;
}

/** 任意输入收敛成 3 维钳制向量（缺维/非法值补 0）；不共享入参数组引用。 */
function toVec3(value) {
  const src = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((i) => clampPad(src[i]));
}

/** state 归一：空/缺省从 { pad:[0,0,0], baseline:[0,0,0], lastKind:'neutral' } 起步，拷贝不共享引用。 */
function normalizeState(state) {
  const src = state && typeof state === 'object' ? state : {};
  return {
    pad: toVec3(src.pad),
    baseline: toVec3(src.baseline),
    lastKind: EVENT_DELTAS[src.lastKind] ? src.lastKind : 'neutral',
    lastAt: Number.isFinite(Number(src.lastAt)) ? Number(src.lastAt) : 0
  };
}

// ──────────────────────────── 事件评估 ────────────────────────────

/**
 * 事件分类：关键词表命中计数判定（纯规则，无隐藏随机）。
 *
 * 公式：
 *   counts[kind] = 该类关键词在 text 里的出现次数（子串计数，同词多次命中计多次）；
 *   取 counts 最高的类；**平手按 EVENT_KINDS 声明顺序取先者**（确定性）；
 *   confidence = maxHits / totalHits（命中占比，保留 3 位小数）；
 *   全表无命中 → { kind: 'neutral', confidence: 0 }。
 *
 * @param {string} text 待判定文本（通常是对方消息）
 * @param {object} [opts]
 * @param {object} [opts.tables] 关键词表（kind → 词数组），**传了就整体覆盖内置表**（便于测试钉口径）；
 *   未列出的类视为无词表，未知类名忽略（结果 kind 只会落在 EVENT_KINDS 里）
 * @returns {{ kind: string, confidence: number }}
 */
export function classifyEvent(text, { tables } = {}) {
  const src = String(text ?? '');
  const effective = tables && typeof tables === 'object' ? tables : DEFAULT_EVENT_TABLES;
  let total = 0;
  let max = 0;
  let kind = 'neutral';
  for (const k of EVENT_KINDS) {
    const words = Array.isArray(effective[k]) ? effective[k] : [];
    let hits = 0;
    for (const raw of words) {
      const w = String(raw ?? '').trim();
      if (!w) continue;
      let idx = src.indexOf(w);
      while (idx >= 0) {
        hits += 1;
        idx = src.indexOf(w, idx + w.length);
      }
    }
    total += hits;
    // 严格大于才换：平手保留 EVENT_KINDS 顺序在先者
    if (hits > max) {
      max = hits;
      kind = k;
    }
  }
  if (max <= 0) return { kind: 'neutral', confidence: 0 };
  return { kind, confidence: round3(max / total) };
}

// ──────────────────────────── PAD 双速动力学 ────────────────────────────

/**
 * PAD 一步推进（双速动力学，纯函数不改入参）：
 *   ① 快变量：pad += EVENT_DELTAS[kind] × eventScale（每维钳 [-1, 1]）；
 *   ② 慢回归：pad 向 baseline 回撤，回撤比例 ratio = min(1, elapsedHours / max(0.5, decayHours))；
 *      （elapsedHours ≥ decayHours 时 ratio=1 全额回归；decayHours 下限 0.5h 防除零/过陡）
 *   ③ baseline 向 pad 缓慢移动：baseline += (pad − baseline) × 0.1（步长 = 两者差的 10%）。
 *
 * state 为空/缺省时从 { pad:[0,0,0], baseline:[0,0,0], lastKind:'neutral' } 起步。
 * 返回新对象 { pad, baseline, lastKind, lastAt }（lastAt = now 透传，供调用方推算下次 elapsedHours）。
 * 全部数值保留 3 位小数（确定性）。
 *
 * @param {{ pad?: number[], baseline?: number[], lastKind?: string, lastAt?: number }} [state]
 * @param {object} [opts]
 * @param {string} [opts.kind='neutral'] 事件类型（EVENT_DELTAS 里没有的按 neutral 处理）
 * @param {number} [opts.elapsedHours=0] 距上次推进的小时数（拿不到就 0）
 * @param {number} [opts.decayHours=6] 慢回归时长（下限 0.5h）
 * @param {number} [opts.eventScale=1] 事件增量缩放（保守乘数入口）
 * @param {number} [opts.now=0] 当前时间戳（只透传进 lastAt，不参与计算）
 */
export function stepPad(state, { kind = 'neutral', elapsedHours = 0, decayHours = 6, eventScale = 1, now = 0 } = {}) {
  const cur = normalizeState(state);
  const eventKind = EVENT_DELTAS[kind] ? kind : 'neutral';
  const delta = EVENT_DELTAS[eventKind];
  const scale = Number.isFinite(Number(eventScale)) ? Number(eventScale) : 1;
  const eh = Math.max(0, Number.isFinite(Number(elapsedHours)) ? Number(elapsedHours) : 0);
  const dh = Math.max(0.5, Number.isFinite(Number(decayHours)) ? Number(decayHours) : 6);
  const ratio = Math.min(1, eh / dh);
  // ① 快变量：事件增量 × eventScale，每维钳 [-1, 1]
  const fast = cur.pad.map((v, i) => clampPad(v + delta[i] * scale));
  // ② 慢回归：向 baseline 回撤 min(1, elapsedHours / max(0.5, decayHours))
  const pad = fast.map((v, i) => clampPad(v + (cur.baseline[i] - v) * ratio));
  // ③ baseline 向 pad 缓慢移动（步长 = 两者差的 10%）
  const baseline = cur.baseline.map((v, i) => clampPad(v + (pad[i] - v) * 0.1));
  return {
    pad: pad.map(round3),
    baseline: baseline.map(round3),
    lastKind: eventKind,
    lastAt: Number.isFinite(Number(now)) ? Number(now) : 0
  };
}

// ──────────────────────────── 保守乘数 ────────────────────────────

/**
 * PAD → 行为乘数（保守调制，只调句长/延迟/表情率/主动概率/是否敢插话，不碰事实与权限）。
 *
 * 公式（p/a/d 为 pad 三分量，已先钳 [-1,1]；scale = modulationScale）：
 *   sentenceLenFactor = 1 + scale × ( p×0.5 + a×0.2)   （愉悦/高唤醒 → 句子更长）
 *   delayFactor       = 1 + scale × (−p×0.5 − d×0.2)   （低落/失控 → 回复更慢）
 *   emojiFactor       = 1 + scale × ( p×0.6)           （愉悦 → 表情更多）
 *   proactiveFactor   = 1 + scale × ( p×0.4 + d×0.2)   （愉悦/有掌控 → 更敢主动）
 *   interruptFactor   = 1 + scale × ( d×0.6 + a×0.2)   （掌控感高才敢插话）
 * 全部钳制 [0.8, 1.2] 并保留 3 位小数；modulationScale=0 时五因子全为 1（可一键归零）。
 *
 * @param {number[]} pad [p, a, d]
 * @param {object} [opts]
 * @param {number} [opts.modulationScale=0.3] 调制幅度（0=不调制；默认保守）
 */
export function padModulation(pad, { modulationScale = 0.3 } = {}) {
  const [p, a, d] = toVec3(pad);
  const scale = Number.isFinite(Number(modulationScale)) ? Number(modulationScale) : 0.3;
  const factor = (raw) => round3(Math.min(1.2, Math.max(0.8, 1 + scale * raw)));
  return {
    sentenceLenFactor: factor(p * 0.5 + a * 0.2),
    delayFactor: factor(-p * 0.5 - d * 0.2),
    emojiFactor: factor(p * 0.6),
    proactiveFactor: factor(p * 0.4 + d * 0.2),
    interruptFactor: factor(d * 0.6 + a * 0.2)
  };
}

/** 一键复位：返回中性 state（PAD/基线全 0，无事件）。 */
export function resetPad() {
  return { pad: [0, 0, 0], baseline: [0, 0, 0], lastKind: 'neutral', lastAt: 0 };
}
