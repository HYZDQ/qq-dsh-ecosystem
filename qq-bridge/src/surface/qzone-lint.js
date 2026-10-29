// 说说风格复核（GEN3 表现面 S2，设计 §7.4/§17.4 第 8 条）：只用四类硬信号。
//
// 为什么不套聊天侧的 style.js：空间是长文，句长方差/排比检测误报率很高（§7.4 明确）；
// 这里只抓**确定性**的硬信号：短语禁用、敏感话题、承诺句式、裸链接。
// 敏感话题（哀悼/医疗/法律/灾难）命中时**跳过重写**——这类内容不许"卖萌化"。
//
// 纯函数、零 IO。flagged=true 时最多重写 1 次，失败发原稿（调用方控制）。

/** 禁用短语：客服腔 / AI 味 / 空洞总结（与聊天侧禁用词表同源的长文子集）。 */
export const FORBIDDEN_PHRASES = Object.freeze([
  '总的来说', '首先，', '其次，', '最后，', '综上所述', '值得注意的是', '需要注意的是',
  '作为一个AI', '作为 AI', '作为一个 AI', '希望对你有帮助', '希望这对你有帮助',
  '让我们一起', '赋能', '抓手', '闭环', '底层逻辑', '拉开差距', '打开认知',
  '亲们', '家人们', '宝子们', '绝绝子', 'YYDS', 'yyds'
]);

/** 承诺句式：公开内容不许替主人/角色做承诺。 */
export const PROMISE_PATTERNS = Object.freeze([
  /我(?:一定|必定|保证|承诺)/,
  /(?:明天|下次|回头|改天)(?:一定|肯定)/,
  /(?:帮你|替你)(?:办|搞定|处理)/
]);

/** 敏感话题：哀悼 / 医疗 / 法律 / 灾难。命中即 skipRewrite。 */
export const SENSITIVE_TOPICS = Object.freeze([
  /(?:悼念|哀悼|去世|逝世|离世|一路走好|节哀|病逝|讣告)/,
  /(?:确诊|住院|手术|癌症|肿瘤|病危|ICU|抢救|昏迷)/,
  /(?:起诉|判决|拘留|逮捕|立案|开庭|判刑|入狱|维权|官司)/,
  /(?:地震|洪水|泥石流|爆炸|火灾|车祸|空难|遇难|伤亡)/
]);

const BARE_URL_RE = /(?:https?:\/\/|www\.)\S{4,}/gi;

/**
 * 四类硬信号检测。
 * @returns {{flagged:boolean, flags:string[], sensitiveTopic:boolean, details:object}}
 */
export function lintQzoneText(text) {
  const s = String(text ?? '');
  const flags = [];
  const details = { phrases: [], promises: 0, bareUrls: 0, sensitiveHits: [] };

  for (const phrase of FORBIDDEN_PHRASES) {
    if (s.includes(phrase)) {
      details.phrases.push(phrase);
    }
  }
  if (details.phrases.length) flags.push('forbidden_phrase');

  for (const re of PROMISE_PATTERNS) {
    if (re.test(s)) details.promises += 1;
  }
  if (details.promises) flags.push('promise');

  const urls = s.match(BARE_URL_RE) ?? [];
  details.bareUrls = urls.length;
  if (urls.length) flags.push('bare_link');

  let sensitiveTopic = false;
  for (const re of SENSITIVE_TOPICS) {
    const m = s.match(re);
    if (m) {
      sensitiveTopic = true;
      details.sensitiveHits.push(m[0]);
    }
  }
  if (sensitiveTopic) flags.push('sensitive_topic');

  return {
    flagged: flags.length > 0,
    // sensitiveTopic 单独给：调用方据此跳过重写（§7.4 硬约束）
    sensitiveTopic,
    flags,
    details
  };
}

/** 重写提示素材：把命中信号转成给 writer 的 styleFlags 文本（不带原文全文）。 */
export function describeLintForRetry(detected) {
  if (!detected?.flagged) return '';
  const hints = [];
  if (detected.flags.includes('forbidden_phrase')) hints.push(`不要用这些词：${detected.details.phrases.slice(0, 5).join('、')}`);
  if (detected.flags.includes('promise')) hints.push('不要写承诺句式（一定/保证/帮你办）');
  if (detected.flags.includes('bare_link')) hints.push('不要放裸链接');
  return hints.join('；');
}

// ── 日记→空间（S4，设计 §8.7）：他人名字检查 ─────────────────────────────────
// 「涉及他人/隐私的段落拒绝」的可执行口径：正文提及任何「他人」显示名即拒。
// 他人 = 群聊/其他私聊里出现过的发言人（排除自己与主人）。

/** 不算「他人」的占位称呼。 */
const NAME_NOISE = new Set(['我', '主人', '群友', '匿名', '自己', '大家', '有人', '某人', '对方', '楼主', '管理员']);

/**
 * 从 social-v2 会话数据收集「他人」显示名。
 * @param {Map|object} conversations 会话表（key=group:xxx / private:xxx，value.recentMessages[].sender）
 * @param {{ownerQQ?: number|null}} [opts] ownerQQ：主人私聊不算「他人」
 * @returns {string[]} 去重排序后的显示名（长度 ≥ 2 码点）
 */
export function collectKnownMemberNames(conversations, { ownerQQ = null } = {}) {
  const names = new Set();
  const entries = conversations instanceof Map ? [...conversations.entries()] : Object.entries(conversations ?? {});
  const ownerKey = ownerQQ ? `private:${String(ownerQQ)}` : '';
  for (const [key, conversation] of entries) {
    const name = String(key ?? '');
    if (!/^(?:group|private):/.test(name)) continue;
    if (ownerKey && name === ownerKey) continue;
    const messages = Array.isArray(conversation?.recentMessages) ? conversation.recentMessages : [];
    for (const item of messages) {
      if (!item || typeof item !== 'object') continue;
      if (item.isSelf === true || item.isOwner === true) continue;
      const sender = String(item.sender ?? '').trim();
      if (Array.from(sender).length < 2 || NAME_NOISE.has(sender)) continue;
      names.add(sender);
    }
  }
  return [...names].sort();
}

/**
 * 正文提及任何「他人」显示名即拒绝（§8.7：涉及他人/隐私的段落不转公开说说）。
 * @returns {{ok: boolean, code?: string, reason?: string}}
 */
export function lintMemberNames(text, names) {
  const value = String(text ?? '');
  for (const name of Array.isArray(names) ? names : []) {
    const member = String(name ?? '').trim();
    if (Array.from(member).length < 2) continue;
    if (value.includes(member)) {
      return { ok: false, code: 'MEMBER_NAME', reason: `摘录提到「${member}」，涉及他人的段落不能转成公开说说` };
    }
  }
  return { ok: true };
}
