// 日记 → 空间摘录检查（GEN3_SURFACE_INTEGRATION_PLAN §8.7，S4）。
//
// 硬规则（即使主人明确要求也全部要过）：
//   1. 摘录必须是日记原文（防转述/夹带/编造）；
//   2. 摘录 ≤ qzone.maxContentChars；
//   3. 日记里来自群聊采样的段落（source=group）不得转成公开说说——群聊原文进了摘录就拒；
//   4. 涉及他人/隐私的段落拒绝（他人显示名 / 号码 / 邮箱 / 路径 / 链接）。
// 发送侧还有桥接的 auditQzoneText + knownMemberNames 兜底（qzone_draft source='diary'）。
//
// 纯函数、零 IO；只做「能不能转」的判定，不做任何发送。

/** 不算「他人」的占位称呼。 */
const NAME_NOISE = new Set(['我', '主人', '群友', '匿名', '自己', '大家', '有人', '某人', '对方', '楼主', '管理员']);

/** 号码/联系方式/路径/链接（公开说说不允许出现）。 */
const PRIVACY_RE = new RegExp(
  String.raw`(?:\b\d{5,}\b|1[3-9]\d{9}|[\w.+-]+@[\w-]+\.[\w.]+|[A-Za-z]:\\|/(?:home|Users|var|etc|root)/|https?://|\b\d{1,3}(?:\.\d{1,3}){3}\b)`
);

/**
 * 注入/指令痕迹（§6.5 五桶：直接指令/角色扮演/工具诱导/间接注入/编码绕过）。
 * 公开说说内容不允许带这些痕迹——即使原文就在日记里也不转。
 */
export const INJECTION_PATTERNS = Object.freeze([
  /(?:忽略|无视|忘记|丢掉)(?:之前|上面|以上|先前)?的?(?:指令|要求|规则|设定|限制)/,
  /ignore\s+(?:all\s+|previous\s+|prior\s+|above\s+)?(?:instructions|prompts|rules|settings)/i,
  /(?:不要|别|无需)(?:遵守|理会|管|受)[^，。！？\n]{0,6}(?:规则|设定|限制|约束)/,
  /(?:你现在|从现在起|接下来你)(?:要|必须)?(?:是|变成|扮演)/,
  /(?:扮演|假装成?|冒充)[^。！？\n]{0,12}(?:角色|助手|客服|机器人|管理员|主人|官方|不受限制)/,
  /(?:system|assistant|user|human)\s*[：:]\s*/i,
  /<\|[^|]*\|>|\[[A-Z_]{3,}\]/,
  /\bmcp__|tools?\/call|jsonrpc|function_call/i,
  /\b(?:qzone_|diary_|web_|computer_|memory_)[a-z_]+/i,
  /(?:调用|执行|运行|触发)\s*(?:工具|命令|指令|接口|api)/i,
  /(?:DAN\s*mode|jailbreak|越狱|超级模式)/i,
  /(?:base64|rot13|\\u[0-9a-fA-F]{4}|&#\d{1,5};|%[0-9a-fA-F]{2})/i,
  /(?:发|寄|给)\s*(?:到|给)?\s*[\w.+-]+@|密码|口令|token|api[_-]?key/i
]);

/** 注入痕迹检测。 */
export function lintInjection(text) {
  const value = String(text ?? '');
  for (const re of INJECTION_PATTERNS) {
    const hit = value.match(re);
    if (hit) return { ok: false, code: 'INJECTION', hit: hit[0] };
  }
  return { ok: true };
}

/** 归一化：去掉全部空白，做「原文是否包含」的宽松比对。 */
export function normalizeForMatch(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

/**
 * 从 social-v2 会话数据收集「群聊采样文本 + 他人显示名」。
 * - groupTexts：窗口内的群聊消息原文（归一化后 ≥ 6 码点），用于 source=group 判定；
 * - knownNames：所有会话（不限窗口）里的他人显示名，用于涉他人判定。
 *
 * @param {Map|object} conversations 会话表（key=group:xxx / private:xxx）
 * @param {{ownerQQ?: number|null, start?: number, end?: number}} opts
 * @returns {{groupTexts: string[], knownNames: string[]}}
 */
export function collectShareGuardData({ conversations, ownerQQ = null, start = 0, end = Number.MAX_SAFE_INTEGER } = {}) {
  const groupTexts = [];
  const knownNames = new Set();
  const ownerKey = ownerQQ ? `private:${String(ownerQQ)}` : '';
  const entries = conversations instanceof Map ? [...conversations.entries()] : Object.entries(conversations ?? {});
  for (const [key, conversation] of entries) {
    const id = String(key ?? '');
    const isGroup = id.startsWith('group:');
    if (!isGroup && !id.startsWith('private:')) continue;
    if (ownerKey && id === ownerKey) continue; // 主人私聊不算「他人」来源
    const raw = Array.isArray(conversation?.recentMessages) ? conversation.recentMessages : [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (item.isSelf === true || item.isOwner === true) continue;
      const sender = String(item.sender ?? '').trim();
      if (Array.from(sender).length >= 2 && !NAME_NOISE.has(sender)) knownNames.add(sender);
    }
    if (!isGroup) continue;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const time = Number(item.time);
      if (!Number.isFinite(time) || time < start || time >= end) continue;
      const text = normalizeForMatch(item.text ?? item.plain ?? '');
      if (Array.from(text).length >= 6) groupTexts.push(text);
    }
  }
  return { groupTexts, knownNames: [...knownNames].sort() };
}

/**
 * 摘录能否转成公开说说（§8.7 四条硬规则）。
 *
 * @param {{body: string, quote: string, groupTexts?: string[], knownNames?: string[], maxContentChars?: number}} args
 *   body=日记正文，quote=要转发的摘录原文
 * @returns {{ok: true, content: string} | {ok: false, code: string, reason: string}}
 */
export function evaluateDiaryShare({ body, quote, groupTexts = [], knownNames = [], maxContentChars = 1000 } = {}) {
  const raw = String(quote ?? '').trim();
  if (!raw) return { ok: false, code: 'EMPTY', reason: '摘录为空：请把日记里要发空间的那段原文传进来' };
  const normQuote = normalizeForMatch(raw);
  const normBody = normalizeForMatch(body);
  if (!normQuote || !normBody.includes(normQuote)) {
    return { ok: false, code: 'NOT_IN_DIARY', reason: '摘录必须是日记原文（一字不改的片段），不能转述、改写或夹带别的内容' };
  }
  const limit = Number(maxContentChars) > 0 ? Number(maxContentChars) : 1000;
  if (raw.length > limit) {
    return { ok: false, code: 'TOO_LONG', reason: `摘录 ${raw.length} 字超过空间正文上限 ${limit} 字，请摘更短的一段` };
  }
  const injection = lintInjection(raw);
  if (!injection.ok) {
    return { ok: false, code: 'INJECTION', reason: '摘录含指令/注入/编码痕迹，不能转成公开说说' };
  }
  for (const text of Array.isArray(groupTexts) ? groupTexts : []) {
    const groupText = normalizeForMatch(text);
    if (Array.from(groupText).length >= 6 && normQuote.includes(groupText)) {
      return { ok: false, code: 'FROM_GROUP', reason: '这段摘录含有群聊内容（source=group），群聊采样段不能转成公开说说' };
    }
  }
  for (const name of Array.isArray(knownNames) ? knownNames : []) {
    const member = String(name ?? '').trim();
    if (Array.from(member).length < 2) continue;
    if (raw.includes(member)) {
      return { ok: false, code: 'MENTIONS_OTHERS', reason: `摘录提到「${member}」，涉及他人的段落不能转成公开说说` };
    }
  }
  if (PRIVACY_RE.test(raw)) {
    return { ok: false, code: 'PRIVACY', reason: '摘录含号码/联系方式/路径/链接等隐私信息，不能转成公开说说' };
  }
  return { ok: true, content: raw };
}
