// Prompt 构建 + 模型输出解析 / 字数校验。
//
// 一次调用同时产出 diary 与 summary（JSON），解析失败才退回「全文清洗 + 首句摘要」，
// 这样正常路径不会消耗第二次 API 调用。
import { weekdayCN } from './scheduler.js';

const SENTENCE_END = ['。', '！', '？', '…', '；', '\n'];
const SUMMARY_MAX_CHARS = 40;

/** 中文字数：按 Unicode 码点计，去掉所有空白。 */
export function countDiaryChars(text) {
  return Array.from(String(text ?? '')).filter((ch) => !/\s/.test(ch)).length;
}

/** 清洗模型输出：去代码块/标题/加粗/列表符/包裹引号，压缩空行。 */
export function cleanDiaryText(raw) {
  let text = String(raw ?? '');
  text = text.replace(/```(?:json|markdown|md|text)?/gi, '');
  text = text.replace(/^\s*#+\s*/gm, ''); // 标题符
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/^\s*[-*+]\s+/gm, ''); // 列表符
  text = text.replace(/^\s*日记[:：]\s*/m, '');
  text = text.replace(/^[\s"'“”‘’「」]+/, '').replace(/[\s"'“”‘’「」]+$/, '');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** 按句子边界截断到 maxChars 以内（尽量不截半句）。 */
export function truncateAtSentence(text, maxChars) {
  const chars = Array.from(String(text ?? ''));
  const limit = Math.max(1, Number(maxChars) || 1);
  if (chars.length <= limit) return String(text ?? '').trim();
  const slice = chars.slice(0, limit).join('');
  let cut = -1;
  for (const mark of SENTENCE_END) cut = Math.max(cut, slice.lastIndexOf(mark));
  const trimmed = cut >= Math.floor(limit * 0.6) ? slice.slice(0, cut + 1) : slice;
  return trimmed.trim();
}

/** 校验并规整日记正文：超长按句边界截断，过短只告警（不编造内容去凑字数）。 */
export function normalizeDiary(raw, { minChars = 200, maxChars = 400 } = {}) {
  const warnings = [];
  let diary = cleanDiaryText(raw);
  if (!diary) {
    return { diary: '', chars: 0, warnings: ['diary 为空'] };
  }
  let chars = countDiaryChars(diary);
  if (chars > maxChars) {
    diary = truncateAtSentence(diary, maxChars);
    chars = countDiaryChars(diary);
    warnings.push(`diary 超过 ${maxChars} 字，已按句边界截断（现 ${chars} 字）`);
  }
  if (chars < minChars) warnings.push(`diary 只有 ${chars} 字，低于下限 ${minChars}（照写不补写）`);
  return { diary, chars, warnings };
}

/** 校验并规整一句话摘要：单行、去引号、≤ maxChars。 */
export function normalizeSummary(raw, { maxChars = SUMMARY_MAX_CHARS } = {}) {
  const warnings = [];
  let summary = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’「」]+/, '')
    .replace(/[\s"'“”‘’「」]+$/, '')
    .trim();
  if (!summary) return { summary: '', warnings: ['summary 为空'] };
  if (Array.from(summary).length > maxChars) {
    summary = truncateAtSentence(summary, maxChars);
    if (Array.from(summary).length > maxChars) summary = Array.from(summary).slice(0, maxChars).join('').trim();
    warnings.push(`summary 超过 ${maxChars} 字，已截断`);
  }
  return { summary, warnings };
}

/** 取第一句（摘要兜底用）。 */
export function firstSentence(text, maxChars = SUMMARY_MAX_CHARS) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  let cut = clean.length;
  for (const mark of ['。', '！', '？', '…', '\n']) {
    const index = clean.indexOf(mark);
    if (index >= 0 && index < cut) cut = index + 1;
  }
  return truncateAtSentence(clean.slice(0, cut), maxChars);
}

/** 从模型输出里抠出 JSON 对象：优先代码块，其次首尾大括号。 */
export function extractJsonObject(raw) {
  const text = String(raw ?? '');
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

/** JSON 被截断时尽量救出字符串字段（闭合字符串优先；未闭合则取到 JSON 尾部并反转义）。 */
export function recoverJsonStringField(raw, name) {
  const text = String(raw ?? '');
  const closed = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(text);
  if (closed) {
    try {
      return JSON.parse(`"${closed[1]}"`);
    } catch {
      return closed[1].replace(/\\n/g, '\n');
    }
  }
  // 未闭合（输出被 max_tokens 截断）：从字段名后的引号一直取到结尾或下一个字段
  const loose = new RegExp(`"${name}"\\s*:\\s*"([\\s\\S]*)$`, 'i').exec(text);
  if (!loose) return '';
  let value = loose[1];
  const nextField = value.search(/"\s*,\s*"|"\s*}/);
  if (nextField >= 0) value = value.slice(0, nextField);
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * 解析模型输出。
 * 返回 { diary, summary, chars, parseMode: 'json'|'partial'|'fallback', warnings }
 */
export function parseDiaryResponse(raw, { minChars = 200, maxChars = 400, summaryMaxChars = SUMMARY_MAX_CHARS } = {}) {
  const text = String(raw ?? '').trim();
  const warnings = [];
  const obj = extractJsonObject(text);
  if (obj && typeof obj.diary === 'string') {
    // JSON 合法但 diary 为空：这是模型抽风，**不能**把整段 JSON 当正文写进日记文件
    if (!obj.diary.trim()) {
      return {
        diary: '',
        summary: '',
        chars: 0,
        parseMode: 'json',
        empty: true,
        warnings: ['模型返回的 JSON 里 diary 为空（可能被 max_tokens 截断）']
      };
    }
    const diaryResult = normalizeDiary(obj.diary, { minChars, maxChars });
    const summaryResult = normalizeSummary(typeof obj.summary === 'string' ? obj.summary : '', {
      maxChars: summaryMaxChars
    });
    let summary = summaryResult.summary;
    if (!summary) {
      summary = firstSentence(diaryResult.diary, summaryMaxChars);
      warnings.push('summary 缺失，已用日记首句兜底');
    }
    return {
      diary: diaryResult.diary,
      summary,
      chars: diaryResult.chars,
      parseMode: 'json',
      warnings: [...warnings, ...diaryResult.warnings, ...summaryResult.warnings]
    };
  }

  const partialDiary = recoverJsonStringField(text, 'diary');
  if (partialDiary.trim()) {
    const diaryResult = normalizeDiary(partialDiary, { minChars, maxChars });
    const partialSummary = normalizeSummary(recoverJsonStringField(text, 'summary'), { maxChars: summaryMaxChars });
    return {
      diary: diaryResult.diary,
      summary: partialSummary.summary || firstSentence(diaryResult.diary, summaryMaxChars),
      chars: diaryResult.chars,
      parseMode: 'partial',
      warnings: ['模型输出不是完整 JSON，已从字段中救回内容', ...diaryResult.warnings, ...partialSummary.warnings]
    };
  }

  const diaryResult = normalizeDiary(text, { minChars, maxChars });
  return {
    diary: diaryResult.diary,
    summary: firstSentence(diaryResult.diary, summaryMaxChars),
    chars: diaryResult.chars,
    parseMode: 'fallback',
    warnings: ['模型输出不是 JSON，已按全文清洗 + 首句摘要兜底', ...diaryResult.warnings]
  };
}

/** 角色人设截断：保住开头的核心设定。 */
export function truncateRoleText(roleText, maxChars) {
  const text = String(roleText ?? '').trim();
  if (!text) return '';
  const chars = Array.from(text);
  const limit = Math.max(200, Number(maxChars) || 3000);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join('')}\n（人设后文已按长度截断）`;
}

export function buildSystemPrompt({ role = '助手', roleText = '', maxRoleChars = 3000, minDiaryChars = 200, maxDiaryChars = 400 }) {
  const persona = truncateRoleText(roleText, maxRoleChars);
  const personaBlock = persona
    ? `【角色设定（必须严格遵循语气、性格、称呼习惯）】\n${persona}`
    : '【角色设定】没有可用的人设文件，请使用温和、自然、第一人称的口吻。';
  return [
    `你现在要以第一人称「我」写一篇今天的日记，你就是「${role}」这个角色本人。`,
    personaBlock,
    '【写作规则】',
    `1. 用简体中文写，第一人称，语气、性格、口头习惯必须符合上面的角色设定。`,
    `2. 只能写上下文里真实出现过的人和事；可以写自己的情绪、联想和小感受，但不得编造具体事件、时间、对话细节或别人的想法。`,
    `3. 篇幅 ${minDiaryChars}~${maxDiaryChars} 字（按中文字符计），1~3 段，不要标题、不要 markdown、不要列表、不要署名、不要日期抬头。`,
    `4. 日记不是聊天记录复读：不要逐条复述消息，要像人睡前回顾一天那样自然地写。`,
    `5. 不写任何 API key、token、密码、文件路径、账号、网址、QQ 号等敏感信息；提到群友时用昵称，不要点真名。`,
    `6. 如果上下文很少或没有，就写平静的一天和角色自己的小日常（比如发呆、吃东西、刷视频），不要硬编故事。`,
    `7. 只输出一个 JSON 对象，不要代码块、不要多余解释。`
  ].join('\n');
}

export function buildUserPrompt({ dateKey, weekday = '', contextText = '', contextEmpty = false, minDiaryChars = 200, maxDiaryChars = 400 }) {
  const day = weekday || weekdayCN(dateKey);
  const contextBlock = contextEmpty
    ? '【今天的上下文】今天没有任何聊天上下文（没有人找我说话，群里也安静）。请写「平静的一天」与角色自己的小日常。'
    : `【今天的上下文（只读自 QQ 聊天，已脱敏）】\n${contextText}`;
  return [
    `日期：${dateKey}（${day}）。`,
    '',
    contextBlock,
    '',
    '【输出格式】',
    '只输出一个 JSON 对象，不要代码块、不要任何多余文字：',
    `{"diary":"（${minDiaryChars}~${maxDiaryChars} 字、第一人称中文日记正文，可以有换行）","summary":"（不超过 40 字的一句话摘要，第一人称，读起来自然）"}`,
    '',
    '要求：diary 是完整日记正文；summary 是给主人看的一句通知，不要带引号、不要带 emoji、不要重复日期。'
  ].join('\n');
}

export function buildPrompts({ role = '助手', roleText = '', dateKey, weekday = '', contextText = '', contextEmpty = false, minDiaryChars = 200, maxDiaryChars = 400, maxRoleChars = 3000 }) {
  return {
    system: buildSystemPrompt({ role, roleText, maxRoleChars, minDiaryChars, maxDiaryChars }),
    user: buildUserPrompt({ dateKey, weekday, contextText, contextEmpty, minDiaryChars, maxDiaryChars })
  };
}
