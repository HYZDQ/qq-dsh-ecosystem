// 三代表情语境打分（GEN3 2.4，设计见 docs/design/GEN3_SIMULATION_PLAN.md P2 表 2.4 行）：
// 情绪标签 × tags × 使用反馈 → top-k 挑选 + 「无合适就不发」拦截。
//
// 硬约束：
//   1. 纯函数、零 IO、无隐藏随机（时间一律由调用方传 now，不读系统时钟）；
//   2. 「无合适就不发」：pickStickerOrNone 在 top-1 分数低于 minScore 时返回 null，
//      **绝不随便挑一个凑数**；
//   3. 全部数值保留 3 位小数（确定性，跨机器可比）；
//   4. usage 形状稳定且可 JSON 持久化：{ [stickerId]: { good, bad, lastUsedAt } }。
//
// 打分公式（scoreSticker）：
//   matchScore    = |tags ∩ expected| / |tags ∪ expected|（Jaccard，两集全空 → 0）
//                   expected = 情绪标签（emotion 词）∪ pad 推导出的期望标签（emotionFromPad；
//                   pad 未提供时只有 emotion 词，无任何语境时 expected 为空 → matchScore=0）
//   feedbackScore = (good + 1) / (good + bad + 2)（拉普拉斯平滑正反馈率）
//   baseScore     = clamp(weights.match×matchScore + weights.feedback×feedbackScore, 0, 1)
//   recencyPenalty= 最近 cooldownHours 内用过 → 0.7；之后向 1 线性恢复，
//                   在 halfLifeHours 处恢复满值：0.7 + 0.3 × min(1, (h−cooldown)/(halfLife−cooldown))
//   score         = round3(baseScore × recencyPenalty)

// ──────────────────────────── 常量 ────────────────────────────

/** 情绪标签轴（可扩充）：sticker.tags 与期望标签都在这组词上对齐。 */
export const EMOTION_AXES = Object.freeze(['happy', 'sad', 'angry', 'awkward', 'calm', 'excited', 'neutral']);

/** match / feedback 默认权重（scoreSticker 公式 0.6/0.4 的来源）。 */
export const DEFAULT_WEIGHTS = Object.freeze({ match: 0.6, feedback: 0.4 });

/** 新近罚：最近 cooldownHours 内用过的降权系数（×0.7）。 */
export const RECENCY_COOLDOWN_FACTOR = 0.7;

/** 新近罚默认参数：24 小时内用过降权，168 小时（7 天）恢复满值。 */
export const DEFAULT_COOLDOWN_HOURS = 24;
export const DEFAULT_HALF_LIFE_HOURS = 168;

/** emotionFromText 默认关键词表（neutral 无词表 = 兜底类）；tables 传了就整体覆盖。 */
export const DEFAULT_EMOTION_TABLES = Object.freeze({
  happy: Object.freeze(['开心', '高兴', '哈哈', '笑死', '太好了', '好耶']),
  sad: Object.freeze(['难过', '伤心', '哭了', '呜呜', '失落', '难受']),
  angry: Object.freeze(['生气', '气死', '愤怒', '火大', '可恶', '烦死']),
  awkward: Object.freeze(['尴尬', '社死', '无语', '冷场', '社恐']),
  calm: Object.freeze(['淡定', '平静', '还好', '无所谓', '佛系']),
  excited: Object.freeze(['激动', '兴奋', '太棒', '热血', '燃', '冲啊']),
  neutral: Object.freeze([])
});

// ──────────────────────────── 数值/文本助手 ────────────────────────────

/** 保留 3 位小数（确定性）；-0 归一成 0，避免 deepEqual 把 -0 当不同值。 */
function round3(x) {
  const v = Math.round(Number(x) * 1000) / 1000;
  return v === 0 ? 0 : v;
}

/** 非法数字回退 fallback，负数钳 0（good/bad/时间戳都走它）。 */
function nonNeg(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** 标签归一：字符串小写去空白；空串丢弃。 */
function normLabel(value) {
  return String(value ?? '').trim().toLowerCase();
}

// ──────────────────────────── 情绪来源 ────────────────────────────

/**
 * PAD → 期望标签集（情绪标签轴上的词，写清映射；恰好命中一档，数组恒定长 1）。
 *
 * 映射（阈值 0.3，p/a/d 为 pad 三分量，缺维/非法按 0）：
 *   p ≥  0.3  → 高唤醒？a ≥ 0.3 → ['excited']，否则 ['happy']
 *   p ≤ -0.3  → 高唤醒？a ≥ 0.3 → ['angry']，否则 ['sad']
 *   |p| < 0.3 → d ≤ -0.3 → ['awkward']（失控/不自在）；
 *               a ≤ -0.3 → ['calm']（低唤醒平静）；否则 ['neutral']
 *
 * @param {number[]} [pad] [p, a, d]（缺维/非法补 0）
 * @returns {string[]} 期望标签集（EMOTION_AXES 里的词）
 */
export function emotionFromPad(pad) {
  const src = Array.isArray(pad) ? pad : [];
  const [p, a, d] = [0, 1, 2].map((i) => {
    const n = Number(src[i]);
    return Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : 0;
  });
  if (p >= 0.3) return [a >= 0.3 ? 'excited' : 'happy'];
  if (p <= -0.3) return [a >= 0.3 ? 'angry' : 'sad'];
  if (d <= -0.3) return ['awkward'];
  if (a <= -0.3) return ['calm'];
  return ['neutral'];
}

/**
 * 文本 → 情绪标签判定（照 affect.js 的 classifyEvent 写法：关键词命中计数，纯规则无隐藏随机）。
 *
 * 公式：
 *   counts[axis] = 该轴关键词在 text 里的出现次数（子串计数，同词多次命中计多次）；
 *   取 counts 最高的轴；**平手按 EMOTION_AXES 声明顺序取先者**（确定性）；
 *   confidence = maxHits / totalHits（命中占比，3 位小数）；
 *   全表无命中 → { emotion: 'neutral', confidence: 0 }。
 *
 * @param {string} text 待判定文本（通常是最近消息）
 * @param {object} [opts]
 * @param {object} [opts.tables] 关键词表（axis → 词数组），**传了就整体覆盖内置表**；
 *   未列出的轴视为无词表，未知轴名忽略（emotion 只会落在 EMOTION_AXES 里）
 * @returns {{ emotion: string, confidence: number }}
 */
export function emotionFromText(text, { tables } = {}) {
  const src = String(text ?? '');
  const effective = tables && typeof tables === 'object' ? tables : DEFAULT_EMOTION_TABLES;
  let total = 0;
  let max = 0;
  let emotion = 'neutral';
  for (const axis of EMOTION_AXES) {
    const words = Array.isArray(effective[axis]) ? effective[axis] : [];
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
    // 严格大于才换：平手保留 EMOTION_AXES 顺序在先者
    if (hits > max) {
      max = hits;
      emotion = axis;
    }
  }
  if (max <= 0) return { emotion: 'neutral', confidence: 0 };
  return { emotion, confidence: round3(max / total) };
}

/**
 * 期望标签集 = emotion 词 ∪ emotionFromPad(pad) 标签（去重、小写归一、按 EMOTION_AXES 顺序稳定输出）。
 * emotion 可传单个标签或数组（空串丢弃；自由词也保留，便于扩充标签轴）。
 * **pad 只在传了数组时才并入映射标签**：pad 缺失 = 没有 PAD 语境，不硬塞 'neutral' 稀释匹配分。
 */
export function expectedLabels({ emotion, pad } = {}) {
  const words = Array.isArray(emotion) ? emotion : (emotion === undefined || emotion === null ? [] : [emotion]);
  const set = new Set(words.map(normLabel).filter(Boolean));
  if (Array.isArray(pad)) for (const label of emotionFromPad(pad)) set.add(label);
  return [...set].sort((a, b) => {
    const ia = EMOTION_AXES.indexOf(a);
    const ib = EMOTION_AXES.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

// ──────────────────────────── 使用反馈账本 ────────────────────────────

/** 单条账本归一：{ good, bad, lastUsedAt } 全部钳非负数，多余字段丢弃。 */
function normalizeUsageEntry(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    good: Math.floor(nonNeg(src.good)),
    bad: Math.floor(nonNeg(src.bad)),
    lastUsedAt: nonNeg(src.lastUsedAt)
  };
}

/**
 * usage 归一（读盘/入参边界）：{ [stickerId]: { good, bad, lastUsedAt } }。
 * 空 id 丢弃；非法条目收敛成计数 0；输出与 JSON 序列化结果一致（可直接落盘）。
 */
export function normalizeUsage(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    const key = String(id ?? '').trim();
    if (!key) continue;
    out[key] = normalizeUsageEntry(entry);
  }
  return out;
}

/**
 * 记录一次「使用」：lastUsedAt = now（新近罚的账本）。纯函数，返回新对象不改入参。
 * good/bad 计数不动（反馈走 recordFeedback）。
 *
 * @param {object} usage 现有账本（{ [stickerId]: { good, bad, lastUsedAt } }）
 * @param {string} stickerId 表情 id（空串抛错，防把账记到 '' 上）
 * @param {object} [opts]
 * @param {number} [opts.now=0] 使用时间戳（毫秒；纯函数不读时钟，缺省 0）
 */
export function recordUse(usage, stickerId, { now = 0 } = {}) {
  const id = String(stickerId ?? '').trim();
  if (!id) throw new Error('stickerId 不能为空');
  const next = normalizeUsage(usage);
  const old = normalizeUsageEntry(next[id]);
  next[id] = { good: old.good, bad: old.bad, lastUsedAt: nonNeg(now) };
  return next;
}

/**
 * 记录一次「反馈」：kind='good'|'bad' 对应计数 +1。纯函数，返回新对象不改入参。
 * lastUsedAt 不动（新近罚只看「用过」，反馈不算使用；now 仅为接口对称保留）。
 */
export function recordFeedback(usage, stickerId, kind, { now = 0 } = {}) {
  const id = String(stickerId ?? '').trim();
  if (!id) throw new Error('stickerId 不能为空');
  const k = String(kind ?? '').trim();
  if (k !== 'good' && k !== 'bad') throw new Error(`kind 必须是 good / bad（收到 ${k || '空'}）`);
  void now;
  const next = normalizeUsage(usage);
  const old = normalizeUsageEntry(next[id]);
  next[id] = {
    good: old.good + (k === 'good' ? 1 : 0),
    bad: old.bad + (k === 'bad' ? 1 : 0),
    lastUsedAt: old.lastUsedAt
  };
  return next;
}

// ──────────────────────────── 打分 ────────────────────────────

/**
 * 单个表情的语境打分（公式见文件头）。
 *
 * @param {{ id: string, tags?: string[] }} sticker 表情条目（用 id 关联 usage、tags 参与匹配）
 * @param {object} [opts]
 * @param {string|string[]} [opts.emotion] 情绪标签（emotionFromText 的 emotion，或任意标签词/数组）
 * @param {number[]} [opts.pad] PAD 三分量（与 emotion 一起推导期望标签）
 * @param {object} [opts.usage] 使用反馈账本（{ [stickerId]: { good, bad, lastUsedAt } }）
 * @param {{ match?: number, feedback?: number }} [opts.weights] 权重（默认 0.6/0.4）
 * @param {number} [opts.now=0] 当前时间戳（毫秒；纯函数不读时钟）
 * @param {number} [opts.cooldownHours=24] 新近罚窗口（该窗口内用过 ×0.7）
 * @param {number} [opts.halfLifeHours=168] 新近罚恢复满值的时长（冷却结束后线性恢复）
 * @returns {{ score: number, parts: { matchScore: number, feedbackScore: number, recencyPenalty: number, baseScore: number, expected: string[] } }}
 */
export function scoreSticker(sticker, { emotion, pad, usage, weights, now = 0, cooldownHours = DEFAULT_COOLDOWN_HOURS, halfLifeHours = DEFAULT_HALF_LIFE_HOURS } = {}) {
  const entry = sticker && typeof sticker === 'object' ? sticker : {};
  const expected = expectedLabels({ emotion, pad });
  const tags = (Array.isArray(entry.tags) ? entry.tags : []).map(normLabel).filter(Boolean);
  // matchScore = Jaccard：|tags ∩ expected| / |tags ∪ expected|，两集全空 → 0
  const tagSet = new Set(tags);
  const expSet = new Set(expected);
  const union = new Set([...tagSet, ...expSet]);
  let hits = 0;
  for (const t of tagSet) if (expSet.has(t)) hits += 1;
  const matchScore = union.size === 0 ? 0 : round3(hits / union.size);
  // feedbackScore = 拉普拉斯平滑正反馈率 (good+1)/(good+bad+2)
  const id = String(entry.id ?? '').trim();
  const book = normalizeUsageEntry(usage && typeof usage === 'object' ? usage[id] : null);
  const feedbackScore = round3((book.good + 1) / (book.good + book.bad + 2));
  // recencyPenalty：cooldownHours 内用过 ×0.7，之后向 1 线性恢复，halfLifeHours 处满值
  let recencyPenalty = 1;
  if (book.lastUsedAt > 0) {
    const w = Number(cooldownHours);
    const h = Number(halfLifeHours);
    const cooldown = Number.isFinite(w) && w > 0 ? w : DEFAULT_COOLDOWN_HOURS;
    const halfLife = Number.isFinite(h) && h > cooldown ? h : Math.max(cooldown + 1, DEFAULT_HALF_LIFE_HOURS);
    const elapsedHours = (nonNeg(now) - book.lastUsedAt) / 3600000;
    if (elapsedHours < cooldown) recencyPenalty = RECENCY_COOLDOWN_FACTOR;
    else recencyPenalty = round3(RECENCY_COOLDOWN_FACTOR + (1 - RECENCY_COOLDOWN_FACTOR) * Math.min(1, (elapsedHours - cooldown) / (halfLife - cooldown)));
  }
  // baseScore = clamp(0.6×match + 0.4×feedback, 0, 1)（weights 可覆盖）
  const wSrc = weights && typeof weights === 'object' ? weights : {};
  const wMatch = Number.isFinite(Number(wSrc.match)) && Number(wSrc.match) >= 0 ? Number(wSrc.match) : DEFAULT_WEIGHTS.match;
  const wFeedback = Number.isFinite(Number(wSrc.feedback)) && Number(wSrc.feedback) >= 0 ? Number(wSrc.feedback) : DEFAULT_WEIGHTS.feedback;
  const baseScore = round3(Math.min(1, Math.max(0, wMatch * matchScore + wFeedback * feedbackScore)));
  return {
    score: round3(baseScore * recencyPenalty),
    parts: {
      matchScore,
      feedbackScore,
      recencyPenalty,
      baseScore,
      expected
    }
  };
}

// ──────────────────────────── 排序 / 挑选 ────────────────────────────

/**
 * 全库打分排序取 top-k：score 降序，**同分按 id 升序稳定排序**（不靠运气）。
 *
 * @param {Array<{ id: string, tags?: string[] }>} stickers 表情条目数组
 * @param {object} [opts] scoreSticker 的入参 + { topK=3 }
 * @returns {Array<{ sticker: object, score: number, parts: object }>} 前 top-k 条
 */
export function rankStickers(stickers, opts = {}) {
  const list = Array.isArray(stickers) ? stickers.filter((s) => s && typeof s === 'object' && String(s.id ?? '').trim()) : [];
  const rawK = Number(opts.topK);
  const topK = Number.isFinite(rawK) && rawK >= 1 ? Math.floor(rawK) : 3;
  return list
    .map((sticker) => ({ sticker, ...scoreSticker(sticker, opts) }))
    .sort((a, b) => (b.score - a.score) || (String(a.sticker.id) < String(b.sticker.id) ? -1 : (String(a.sticker.id) > String(b.sticker.id) ? 1 : 0)))
    .slice(0, topK);
}

/**
 * 语境挑选或「不发」：top-1 分数 ≥ minScore 才给结果；否则 { sticker: null, reason: 'no-suitable' }。
 * **无合适就不发，不许随便挑一个凑数**（空库/全不达标一律返回 null）。
 *
 * @param {Array<object>} stickers 表情条目数组
 * @param {object} [opts] rankStickers 的入参
 * @param {object} [opts2]
 * @param {number} [opts2.minScore=0.3] 最低可发分数（0~1，非法回默认 0.3）
 * @returns {{ sticker: object, score: number } | { sticker: null, reason: 'no-suitable' }}
 */
export function pickStickerOrNone(stickers, opts = {}, { minScore = 0.3 } = {}) {
  const rawMin = Number(minScore);
  const bar = Number.isFinite(rawMin) ? Math.min(1, Math.max(0, rawMin)) : 0.3;
  const top = rankStickers(stickers, { ...opts, topK: 1 })[0] ?? null;
  if (!top || top.score < bar) return { sticker: null, reason: 'no-suitable' };
  return { sticker: top.sticker, score: top.score };
}
