// 三代仿真人设模块（GEN3 1.5，设计见 docs/design/GEN3_SIMULATION_PLAN.md 6.1 节）：
// 身份锚点渲染 + 周期性重锚 + 风格漂移监测。
//
// 硬约束（6.1 全部落在纯函数里）：
//   1. 锚点「短而硬」：名字/身份由既有 identityLine 提供，锚点只补 3~5 个说话特征、
//      3 条红线、当前关系称呼（条数在本模块封顶，不许堆长文）；
//   2. 与现有 identityLine **合并**（同【你的身份】段内追加），不新增重复段；
//   3. 每 N 轮或漂移检测触发重锚；平时只保留基础身份文本（不每轮堆长文）；
//   4. 漂移监测只告警 + 触发重锚，**不自动改人格**（人格修改仅 owner）；
//   5. 轻量 PICon（P0.4 规则版口径）：自称一致性用 /我是\\s?(AI|人工智能|助手|模型|程序)/
//      与 scripts/simulation-eval.mjs 同口径，加「作为…」变体；命中即计入漂移信号。
//
// 全模块零 IO、纯函数、无隐藏随机（词表/阈值全部入参可调）。

// ──────────────────────────── 常量 ────────────────────────────

/** 锚点条数封顶（6.1：3~5 个说话特征、3 条红线、关系称呼 1~2 个）。 */
export const ANCHOR_CAPS = Object.freeze({ speechFeatures: 5, redLines: 3, relations: 2 });

/**
 * 自称 AI 判定（轻量 PICon 自称一致性，与 simulation-eval.mjs 的 aiSelfCall 同口径 + 「作为」变体）。
 * 机器人在被追问时可以承认身份，但**主动高频自称**是漂移信号（内部一致性下降）。
 */
export const AI_SELF_RE = /(?:我是\s?(?:AI|人工智能|助手|模型|程序|机器人))|(?:作为\s?(?:一个)?(?:AI|人工智能|语言模型|大模型|助手|程序|机器人))|(?:我\s?是\s?(?:一个)?(?:AI|人工智能|语言模型|大模型|机器人|模型))|(?:训练数据)|(?:大语言模型)/i;

/** 语气词（口语密度信号；只用于漂移对比的相对变化，不做对错判定）。 */
export const TONE_WORDS = Object.freeze(['啊', '吧', '呢', '嘛', '哦', '啦', '耶', '嘿', '哼', '呜', '哎', '呀', '哈', '哒', '咯', '哇', '诶', '嗯']);

const SENTENCE_SPLIT_RE = /[。！？!?…\n]+/;
const PUNCT_RE = /[，。！？、；：…～!?,.;:~「」“”'"（）()]/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// ──────────────────────────── 身份锚点渲染 ────────────────────────────

function capList(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * 身份锚点文本：baseText（既有 identityLine 正文）+ 锚点尾巴。
 *
 * - full=false 或素材全空 → 原样返回 baseText（平时每轮只留基础身份，不堆长文）；
 * - full=true → 追加「人设锚点：说话特征「…」；红线「…」；关系「…」。」，
 *   各段缺失则省略；尾巴整体受 maxChars 预算钳制（先丢末段，再硬截断）。
 * - 条数封顶见 ANCHOR_CAPS：说话特征≤5、红线≤3、关系≤2。
 */
export function buildAnchorText({
  baseText = '',
  speechFeatures = [],
  redLines = [],
  relations = [],
  maxChars = 500,
  full = true
} = {}) {
  const base = String(baseText ?? '');
  if (!full) return base;
  const budget = Math.max(20, Math.floor(Number(maxChars) || 500));
  const feats = capList(speechFeatures, ANCHOR_CAPS.speechFeatures);
  const reds = capList(redLines, ANCHOR_CAPS.redLines);
  const rels = capList(relations, ANCHOR_CAPS.relations);
  const parts = [];
  if (feats.length) parts.push(`说话特征「${feats.join('、')}」`);
  if (reds.length) parts.push(`红线「${reds.join('、')}」`);
  if (rels.length) parts.push(`关系「${rels.join('、')}」`);
  if (!parts.length) return base;
  const compose = (items) => `人设锚点：${items.join('；')}。`;
  let tail = compose(parts);
  // 超预算：先丢末段（关系 → 红线 → 说话特征），单段仍超才硬截断。
  while (tail.length > budget && parts.length > 1) {
    parts.pop();
    tail = compose(parts);
  }
  if (tail.length > budget) tail = `${tail.slice(0, Math.max(1, budget - 1))}…`;
  return base + tail;
}

/**
 * 重锚决策：每 N 轮一次、首轮必锚、连续漂移（driftStreak ≥ driftStreakNeed）强制锚。
 * turnCount 是该会话已渲染的 persona 轮数（从 0 起，调用方在渲染后自增）。
 * 返回 { reanchor, reason: 'first' | 'every-n' | 'drift' | null }。
 */
export function shouldReanchor({ turnCount = 0, everyTurns = 10, driftStreak = 0, driftStreakNeed = 2 } = {}) {
  const n = Math.max(1, Math.floor(Number(everyTurns) || 10));
  const need = Math.max(1, Math.floor(Number(driftStreakNeed) || 2));
  const count = Math.max(0, Math.floor(Number(turnCount) || 0));
  if (Number(driftStreak) >= need) return { reanchor: true, reason: 'drift' };
  if (count === 0) return { reanchor: true, reason: 'first' };
  if (count % n === 0) return { reanchor: true, reason: 'every-n' };
  return { reanchor: false, reason: null };
}

// ──────────────────────────── 漂移监测 ────────────────────────────

/**
 * 风格统计（轻量 PICon/漂移信号，纯规则）：
 *   avgSentenceChars  平均句长（字符）
 *   punctuationRate   标点密度（标点数/字符数）
 *   toneWordRate      语气词密度（语气词数/字符数）
 *   emojiRate         表情率（emoji 数/条数）
 *   aiSelfRate        自称 AI 率（命中条数/条数，P0.4 同口径）
 *   tabooHits         禁忌词命中次数（红线词表，命中即漂移信号）
 * 空输入返回全 0 形状（调用方无需判空）。
 */
export function extractStyleStats(texts, { tabooWords = [] } = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? '')).filter((t) => t.trim());
  const taboo = (Array.isArray(tabooWords) ? tabooWords : []).map((w) => String(w ?? '').trim()).filter(Boolean);
  let chars = 0;
  let sentences = 0;
  let punctuation = 0;
  let tone = 0;
  let emoji = 0;
  let aiSelf = 0;
  let tabooHits = 0;
  for (const t of list) {
    chars += t.length;
    sentences += t.split(SENTENCE_SPLIT_RE).filter((s) => s.trim()).length;
    punctuation += (t.match(PUNCT_RE) ?? []).length;
    emoji += (t.match(EMOJI_RE) ?? []).length;
    for (const w of TONE_WORDS) {
      let idx = t.indexOf(w);
      while (idx >= 0) {
        tone += 1;
        idx = t.indexOf(w, idx + w.length);
      }
    }
    if (AI_SELF_RE.test(t)) aiSelf += 1;
    for (const w of taboo) {
      if (w && t.includes(w)) tabooHits += 1;
    }
  }
  const n = list.length;
  return {
    msgCount: n,
    avgSentenceChars: n ? Number((chars / Math.max(1, sentences)).toFixed(1)) : 0,
    punctuationRate: chars ? Number((punctuation / chars).toFixed(4)) : 0,
    toneWordRate: chars ? Number((tone / chars).toFixed(4)) : 0,
    emojiRate: n ? Number((emoji / n).toFixed(3)) : 0,
    aiSelfRate: n ? Number((aiSelf / n).toFixed(3)) : 0,
    tabooHits
  };
}

/** 各信号的漂移分归一尺度（|差|/scale 后平均；尺度 = 聊天场景的自然波动幅度）。 */
const DRIFT_SCALES = Object.freeze({
  avgSentenceChars: 25,
  punctuationRate: 0.15,
  toneWordRate: 0.06,
  emojiRate: 1
});

/**
 * 漂移判定：当前 stats 与锚点基线 baseline 的风格距离。
 *   styleDist = 四信号（句长/标点/语气词/表情）min(1, |Δ|/尺度) 的平均（0~1）；
 *   自称 AI 只罚**相对基线上升**（角色卡允许「被追问时承认」，有率不罚、飙升才罚，封顶 0.5）；
 *   禁忌（红线词）按命中次数罚（每次 0.25，封顶 0.5）；
 *   score = min(1, styleDist + 自称罚 + 禁忌罚)；drifted = score >= threshold。
 * 无基线（null）→ { score: 0, drifted: false, flags: [] }（首锚前不告警）。
 * **只出告警信号**：是否重锚由 shouldReanchor 决定，本模块不改人格。
 */
export function detectDrift(stats, baseline, { threshold = 0.5 } = {}) {
  const cur = stats && typeof stats === 'object' ? stats : {};
  if (!baseline || typeof baseline !== 'object') return { score: 0, drifted: false, flags: [] };
  const flags = [];
  let sum = 0;
  for (const [key, scale] of Object.entries(DRIFT_SCALES)) {
    const d = Math.abs(Number(cur[key]) - Number(baseline[key])) / scale;
    sum += Math.min(1, Number.isFinite(d) ? d : 0);
  }
  const styleDist = sum / Object.keys(DRIFT_SCALES).length;
  const aiRise = Math.max(0, Number(cur.aiSelfRate) - (Number(baseline.aiSelfRate) || 0));
  const aiSelfPenalty = Math.min(0.5, aiRise);
  const tabooPenalty = Math.min(0.5, Number(cur.tabooHits) * 0.25);
  if (aiRise > 0) flags.push('ai-self');
  if (Number(cur.tabooHits) > 0) flags.push('taboo');
  const score = Math.min(1, Number((styleDist + aiSelfPenalty + tabooPenalty).toFixed(3)));
  return { score, drifted: score >= Number(threshold), flags };
}
