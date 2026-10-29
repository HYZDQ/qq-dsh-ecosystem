// 三代仿真的注意力/发言决策（GEN3 P0.7 最小规则版 → P1.6 canary 评估）。
// 纯函数、零 IO：features 由桥接从会话状态算好传进来；输出含 decisionPath 便于解释与回归。
//
// 决策优先级（docs/design/GEN3_SIMULATION_PLAN.md 6.2，硬规则在前）：
//   1. 权限/白名单/静默/安全拦截 —— 不在本模块（桥接发送闸门管）；
//   2. 私聊、@、引用 bot、主人消息、拍一拍、直接提问 → speak（注意力层不得判 silent）；
//   3~5. 群聊非直接提及按 salience 与阈值分 speak / wait / silent；
//   false silence 是最高危错误：宁可误插话，不漏回直接提及。
//
// salience = w.addressee*受话人 + w.topic*话题 + w.relationship*关系 + w.urgency*紧急
//            - w.floorPenalty*抢话 - w.recentBotPenalty*刚发言   （钳到 [0,1]）

const DEFAULT_WEIGHTS = Object.freeze({
  addressee: 0.4,
  topic: 0.2,
  relationship: 0.15,
  urgency: 0.15,
  floorPenalty: 0.2,
  recentBotPenalty: 0.2
});

/**
 * 从原始消息数组提取决策特征（全部归一化到 0~1 或布尔）。
 * 入参都是普通数据结构，方便单测与离线回放：
 *   messages      触发本轮的未读消息 [{ sender, userId, text|plain, isSelf, isOwner, quoteTargetIsSelf, hasMedia, time }]
 *   recent        最近消息（同形），用于群活跃度/抢话/刚发言
 *   activeTopics  [{ text }]，用于话题连续性
 *   impressions   memberImpressions（含 u: 键与 aliases），用于关系分
 *   isPrivate     会话是否私聊
 *   botKeywords   触发词表（识别「叫 bot」）
 *   hasPoke       本轮是否由拍一拍触发
 */
export function extractFeatures({ messages = [], recent = [], activeTopics = [], impressions = {}, isPrivate = false, botKeywords = [], hasPoke = false, now = Date.now() } = {}) {
  const texts = messages.map((m) => String(m?.plain ?? m?.text ?? ''));
  const joined = texts.join('\n');
  const kwHit = botKeywords.some((k) => k && joined.includes(k));
  const atSelf = /@[^\s：:，。]+/.test(joined) && kwHit;
  const quotedSelf = messages.some((m) => m?.quoteTargetIsSelf === true);
  const explicitAddressee = !!(kwHit || atSelf || quotedSelf);
  const question = /[?？]|吗|呢|怎么|为什么|能不能|有没有|是不是/.test(joined);
  const owner = isPrivate || messages.some((m) => m?.isOwner === true);
  const urgency = /急|帮忙|救命|出事|赶紧|在吗|速回|崩溃/.test(joined);
  const hasMedia = messages.some((m) => m?.hasMedia === true);
  // 话题连续性：未读文本与进行中话题的字符 2-gram 重合率
  const topicTexts = activeTopics.map((t) => String(t?.text ?? '')).filter(Boolean).join('\n');
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  let topicContinuity = 0;
  if (topicTexts && joined) {
    const a = grams(joined);
    const b = grams(topicTexts);
    let hit = 0;
    for (const g of a) if (b.has(g)) hit += 1;
    topicContinuity = a.size ? Math.min(1, hit / Math.max(8, a.size)) : 0;
  }
  // 关系：按发送者查印象（u: 键 / 姓名键 / aliases 都认），互动次数归一化
  let interaction = 0;
  for (const m of messages) {
    const candidates = [m?.userId ? `u:${m.userId}` : null, String(m?.sender ?? '')].filter(Boolean);
    for (const key of candidates) {
      const entry = impressions?.[key]
        ?? Object.entries(impressions ?? {}).find(([, v]) => Array.isArray(v?.aliases) && v.aliases.includes(String(m?.sender ?? '')))?.[1];
      if (entry) interaction = Math.max(interaction, Number(entry.interactionCount) || 0);
    }
  }
  const relationship = Math.min(1, interaction / 20);
  // 抢话：最近 30 秒别人连续说话 ≥3 条；刚发言：bot 最近 30 秒说过话
  const recent30s = recent.filter((m) => now - Number(m?.time || 0) < 30 * 1000);
  const floor = Math.min(1, recent30s.filter((m) => !m?.isSelf).length / 3);
  const recentBot = recent.some((m) => m?.isSelf && now - Number(m?.time || 0) < 30 * 1000) ? 1 : 0;
  return {
    isPrivate,
    explicitAddressee,
    question,
    owner,
    urgency,
    hasMedia,
    hasPoke,
    topicContinuity: Number(topicContinuity.toFixed(3)),
    relationship: Number(relationship.toFixed(3)),
    floor: Number(floor.toFixed(3)),
    recentBot,
    hour: new Date(now).getHours()
  };
}

/**
 * 发言决策。返回：
 *   action: 'speak' | 'wait' | 'silent'
 *   score: salience（0~1）
 *   reason / decisionPath: 可解释依据（进 trace，供回归与调参）
 */
export function decideAttention(features, attentionCfg = {}) {
  const f = features ?? {};
  const speakThreshold = Number(attentionCfg.speakThreshold ?? 0.55);
  const silentThreshold = Number(attentionCfg.silentThreshold ?? 0.25);
  const w = { ...DEFAULT_WEIGHTS, ...(attentionCfg.weights ?? {}) };
  // 硬规则：直接提及类永远 speak（false silence 是最高危错误）
  if (f.isPrivate) return { action: 'speak', score: 1, reason: '私聊直接进生成', decisionPath: 'private' };
  if (f.explicitAddressee) return { action: 'speak', score: 1, reason: '@/叫名字/引用 bot', decisionPath: 'explicit-addressee' };
  if (f.hasPoke) return { action: 'speak', score: 1, reason: '拍一拍', decisionPath: 'poke' };
  if (f.owner) return { action: 'speak', score: 1, reason: '主人消息', decisionPath: 'owner' };
  if (f.question) return { action: 'speak', score: 1, reason: '直接提问', decisionPath: 'question' };
  // 评分（6.2 公式）
  const raw = (w.addressee * (f.explicitAddressee ? 1 : 0))
    + (w.topic * Number(f.topicContinuity || 0))
    + (w.relationship * Number(f.relationship || 0))
    + (w.urgency * (f.urgency ? 1 : 0))
    - (w.floorPenalty * Number(f.floor || 0))
    - (w.recentBotPenalty * Number(f.recentBot || 0));
  const score = Math.min(1, Math.max(0, Number(raw.toFixed(3))));
  if (score >= speakThreshold) return { action: 'speak', score, reason: `salience ${score} ≥ 发言阈值`, decisionPath: 'salience-speak' };
  if (score >= silentThreshold) return { action: 'wait', score, reason: `salience ${score} 介于两阈值之间`, decisionPath: 'salience-wait' };
  return { action: 'silent', score, reason: `salience ${score} < 沉默阈值`, decisionPath: 'salience-silent' };
}

/** shadow 记录用：决策动作折算成二元标签（wait 归入「会说话」侧）。 */
export function actionToSpeakSilent(action) {
  return action === 'silent' ? 'silent' : 'speak';
}

/**
 * 连续沉默计数（6.2 规则 4）：只用于触发「重新评估/告警」，**绝不强制发言**。
 * 非 silent 立即清零；warned 由调用方在达到阈值时置 true，用于告警去重。
 */
export function advanceSilentStreak(prev, action) {
  if (action !== 'silent') return { silentStreak: 0, warned: false };
  return {
    silentStreak: Math.max(0, Number(prev?.silentStreak) || 0) + 1,
    warned: prev?.warned === true
  };
}

/**
 * 拍一拍冷却（6.2 规则 3）：冷却期内重复拍一拍不重复唤醒（防连拍刷屏）。
 * 只在 attention canary 闸门内使用；lastAt 缺失（首次拍）不算冷却中。
 */
export function pokeCooldownActive(lastAt, now = Date.now(), cooldownMs = 0) {
  const ms = Math.max(0, Number(cooldownMs) || 0);
  const last = Number(lastAt) || 0;
  return ms > 0 && last > 0 && now - last < ms;
}

/**
 * 受话人推断（与语料自动标注同一套规则，单一实现）：
 *   me      —— 引用 bot（quoteTargetIsSelf）、叫 bot 名字/关键词、私聊；
 *   other   —— 明确 @ 别人、引用别人；
 *   unknown —— 其余（多人群聊大多数轮次没有显式受话人）。
 */
export function inferAddressee(messages = [], { isPrivate = false, botKeywords = [] } = {}) {
  // 逐条判定（顺序与语料自动标注一致：引用bot > 叫bot > @别人 > 引用别人 > 私聊 > 未知），
  // 多条聚合时 me 优先（漏回是最危错误）；单条输入与语料标注逐位一致。
  let sawOther = false;
  for (const m of messages) {
    const text = String(m?.plain ?? m?.text ?? '');
    if (m?.quoteTargetIsSelf === true) return 'me';
    if (botKeywords.some((k) => k && text.includes(k))) return 'me';
    const atMatch = text.match(/@([^\s：:，。]+)/);
    if (atMatch && !botKeywords.some((k) => atMatch[1].includes(k))) sawOther = true;
    else if (m?.quoteTargetIsSelf === false && /\[引用/.test(text)) sawOther = true;
    else if (isPrivate) return 'me';
  }
  return sawOther ? 'other' : 'unknown';
}
