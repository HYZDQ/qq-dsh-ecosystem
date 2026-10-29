// 上下文采集（严格只读 qq-bridge）。
//
// 输入：qq-bridge 的 state/social-v2.json、state/current-role.json、roles/<role>.md、
//       state/qq-activity.log（全部只读）。
// 输出：一段给模型看的脱敏文本（≤ config.maxContextChars 字）+ 统计信息。
//
// 预算规则（私聊优先）：
//   总预算 10000 字 −（话题/印象/活动日志的预留） = 消息预算
//   主人私聊先占 消息预算 × privateShare（默认 60%），每会话另受 maxPerConversationChars 限制
//   剩余预算给群聊（按会话均分，最近消息优先 + 等距采样）
//   其他私聊默认排除
// 数据缺失/损坏/被占用 → 降级为空上下文并记日志，绝不抛异常打断日记生成。
import fs from 'node:fs';
import path from 'node:path';
import { dateKeyInZone, zonedParts, windowForDate } from './scheduler.js';
import { truncateRoleText } from './prompt.js';
import { redactText } from './logger.js';

const DEFAULT_DELAYS = [40, 120, 320];
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

const sleepSync = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 同步小睡：只在读状态文件被占用时用，最多几百毫秒
  }
};

/** 读 JSON（容忍 BOM/占用/损坏）；返回 { ok, data, error }。 */
export function readJsonFileSafe(file, { retries = 3, delays = DEFAULT_DELAYS, sleep = sleepSync } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      return { ok: true, data, error: null, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (error?.code === 'ENOENT') return { ok: false, data: null, error: 'missing', code: 'ENOENT', attempts: attempt + 1 };
      const retryable = error instanceof SyntaxError || BUSY_CODES.has(error?.code);
      if (!retryable || attempt === retries) break;
      sleep(delays[attempt] ?? 200);
    }
  }
  return {
    ok: false,
    data: null,
    error: String(lastError?.message ?? lastError),
    code: lastError?.code ?? (lastError instanceof SyntaxError ? 'BAD_JSON' : 'UNKNOWN'),
    attempts: retries + 1
  };
}

/** 会话归类：owner 私聊 / 群聊 / 其他私聊 / 忽略。 */
export function classifyConversation(key, ownerQQ, includeOtherPrivates = false) {
  const value = String(key ?? '');
  if (!value) return 'ignored';
  if (ownerQQ && value === `private:${ownerQQ}`) return 'owner';
  if (value.startsWith('group:')) return 'group';
  if (value.startsWith('private:')) return includeOtherPrivates ? 'otherPrivate' : 'excludedPrivate';
  return 'ignored';
}

const PLACEHOLDER_RE = /^(?:\[(?:图片|表情|动画表情|语音|视频|文件|转发消息|引用|卡片|位置|音乐)\])+$/;

/** 清洗单条消息文本：去转发/引用 id、归一表情占位、压缩空白。 */
export function cleanMessageText(raw) {
  let text = String(raw ?? '');
  text = text.replace(/\[转发消息 id=[^\]]*\]/gi, '[转发消息]');
  text = text.replace(/\[表情\d+\]/g, '[表情]');
  text = text.replace(/\[动画表情\]/g, '[表情]');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export function isPlaceholderOnly(text) {
  const cleaned = cleanMessageText(text);
  if (!cleaned) return true;
  return PLACEHOLDER_RE.test(cleaned);
}

/** 把会话的 recentMessages 规整成窗口内的时间升序消息。 */
export function normalizeMessages(conversation, { start, end, ownerQQ = null, who = 'group' } = {}) {
  const raw = Array.isArray(conversation?.recentMessages) ? conversation.recentMessages : [];
  const messages = [];
  let media = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const time = Number(item.time);
    if (!Number.isFinite(time) || time < start || time >= end) continue;
    const text = cleanMessageText(item.text ?? item.plain ?? '');
    if (!text || isPlaceholderOnly(text)) {
      if (item.hasMedia || (Array.isArray(item.media) && item.media.length)) media += 1;
      continue;
    }
    const sender = item.isSelf === true ? '我' : String(item.sender ?? '').trim() || (who === 'owner' ? '主人' : '群友');
    messages.push({
      time,
      who: who === 'owner' ? (item.isSelf === true ? '我' : '主人') : sender,
      isSelf: item.isSelf === true,
      isOwner: item.isOwner === true,
      text
    });
  }
  messages.sort((a, b) => a.time - b.time);
  return { messages, media };
}

function logDatePrefix(parts) {
  return `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function formatMessageLine(message, { dateKey, timeZone, maxMessageChars, redact }) {
  const parts = zonedParts(message.time, timeZone);
  const clock = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  const sameDay = dateKeyInZone(new Date(message.time), timeZone) === dateKey;
  const stamp = sameDay ? clock : `${logDatePrefix(parts)} ${clock}`;
  const who = String(message.who ?? '群友').slice(0, 16);
  let text = String(message.text ?? '').replace(/\s+/g, ' ').trim();
  // 按码点截断，避免切断 emoji 的代理对
  const chars = Array.from(text);
  if (chars.length > maxMessageChars) text = `${chars.slice(0, maxMessageChars).join('')}…`;
  text = redactText(text, { enabled: redact });
  return `${stamp} ${who}: ${text}`;
}

/** 等距采样：覆盖整个窗口，保留最新一条。 */
export function pickEvenly(messages, count) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1, Math.floor(count));
  if (list.length <= limit) return [...list];
  if (limit === 1) return [list[list.length - 1]];
  const picked = [];
  const step = (list.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i += 1) {
    const index = Math.round(i * step);
    if (picked.length && picked[picked.length - 1].time === list[index].time) continue;
    picked.push(list[index]);
  }
  return picked;
}

/** 在预算内取行：从最新往前装，再翻转回时间顺序；至少保留最新一条。 */
export function fitLines(messages, budget, renderLine) {
  if (!Array.isArray(messages) || messages.length === 0 || budget <= 0) return { lines: [], used: 0 };
  const lines = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const line = renderLine(messages[i]);
    const cost = line.length + 1;
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
  }
  if (!lines.length) {
    const line = renderLine(messages[messages.length - 1]);
    const clipped = Array.from(line).slice(0, Math.max(0, budget)).join('');
    if (clipped) {
      lines.push(clipped);
      used = clipped.length;
    }
  }
  lines.reverse();
  return { lines, used };
}

function section(title, lines) {
  if (!lines.length) return '';
  return `【${title}】\n${lines.join('\n')}`;
}

function clipText(text, maxChars) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= maxChars) return String(text ?? '');
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/** 读活动日志尾部若干行（只读）。 */
export function readActivityLog({ qqBridgeDir, lines = 100, logger = null }) {
  const file = path.join(String(qqBridgeDir ?? ''), 'state', 'qq-activity.log');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const all = text.split(/\r?\n/).filter((line) => line.trim());
    return { ok: true, lines: num(lines) > 0 ? all.slice(-Math.floor(lines)) : [], error: null };
  } catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.(`[context] 读活动日志失败：${error?.message ?? error}`);
    return { ok: false, lines: [], error: error?.code === 'ENOENT' ? 'missing' : String(error?.message ?? error) };
  }
}

function num(value) {
  return Number(value) || 0;
}

/** 读角色：current-role.json → roles/<role>.md。缺失用空人设兜底。
 * 「人格分裂」语义（qq-bridge schema v2）：日记素材以主人私聊为主，固定读私聊卡
 * `roles.private ?? role`；群聊卡（roles.group）不进日记。 */
export function loadRole({ qqBridgeDir, maxRoleChars = 3000, logger = null, sleep } = {}) {
  const dir = String(qqBridgeDir ?? '');
  const roleState = readJsonFileSafe(path.join(dir, 'state', 'current-role.json'), { retries: 2, ...(sleep ? { sleep } : {}) });
  const slots = roleState.data?.roles && typeof roleState.data.roles === 'object' ? roleState.data.roles : {};
  // 私聊卡优先（split 开关与否都一样：日记永远跟私聊走），旧格式无 slots 时回退 role 字段。
  let role = typeof slots.private === 'string' ? slots.private.trim() : '';
  if (!role && typeof roleState.data?.role === 'string') role = roleState.data.role.trim();
  const errors = [];
  if (!roleState.ok) {
    errors.push(`current-role.json ${roleState.error === 'missing' ? '缺失' : '读取失败'}：${roleState.error}`);
  }
  if (!role) {
    role = '助手';
    errors.push('current-role.json 没有 role 字段，回退「助手」');
  }
  let roleText = '';
  const roleFile = path.join(dir, 'roles', `${role}.md`);
  try {
    roleText = fs.readFileSync(roleFile, 'utf8').trim();
  } catch (error) {
    errors.push(`角色文件 roles/${role}.md 不可读：${error?.code === 'ENOENT' ? 'missing' : (error?.message ?? error)}`);
  }
  if (errors.length) logger?.warn?.(`[context] 角色信息降级：${errors.join('；')}`);
  return {
    role,
    roleText: truncateRoleText(roleText, maxRoleChars),
    roleFile,
    mode: typeof roleState.data?.mode === 'string' ? roleState.data.mode : '',
    ok: Boolean(roleText),
    errors
  };
}

function collectTopics(conversations, ownerQQ, includeOtherPrivates, { redact, maxChars }) {
  const items = [];
  const pushTopic = (text, extra = '') => {
    const cleaned = redactText(String(text ?? '').replace(/\s+/g, ' ').trim(), { enabled: redact });
    if (!cleaned) return;
    items.push(clipText(`${cleaned}${extra}`, 160));
  };

  const ordered = [];
  for (const [key, conversation] of conversations) {
    const kind = classifyConversation(key, ownerQQ, includeOtherPrivates);
    if (kind === 'owner') ordered.unshift([key, conversation, kind]);
    else if (kind === 'group' || kind === 'otherPrivate') ordered.push([key, conversation, kind]);
  }
  for (const [, conversation] of ordered) {
    const topics = Array.isArray(conversation?.activeTopics) ? conversation.activeTopics : [];
    for (const topic of topics) {
      const participants = Array.isArray(topic?.participants) ? topic.participants.filter((p) => typeof p === 'string') : [];
      pushTopic(topic?.text, participants.length ? `（${participants.slice(0, 3).join('、')}）` : '');
    }
    const thoughts = Array.isArray(conversation?.pendingThoughts) ? conversation.pendingThoughts : [];
    for (const thought of thoughts) {
      if (typeof thought?.text === 'string') pushTopic(thought.text);
    }
  }
  return items.slice(0, Math.max(0, Math.floor(maxChars / 20)));
}

function collectImpressions(conversations, ownerQQ, includeOtherPrivates, { redact, maxChars }) {
  const items = [];
  for (const [key, conversation] of conversations) {
    const kind = classifyConversation(key, ownerQQ, includeOtherPrivates);
    if (kind === 'ignored' || kind === 'excludedPrivate') continue;
    const impressions = conversation?.memberImpressions;
    if (!impressions || typeof impressions !== 'object') continue;
    for (const [name, impression] of Object.entries(impressions)) {
      const traits = Array.isArray(impression?.traits) ? impression.traits.filter((t) => typeof t === 'string' && t.trim()) : [];
      if (!traits.length) continue;
      const who = redactText(String(name ?? '').slice(0, 16), { enabled: redact });
      items.push(clipText(`${who}：${traits.slice(0, 2).join('；')}`, 140));
    }
  }
  return items.slice(0, Math.max(0, Math.floor(maxChars / 20)));
}

function renderActivityLines(lines, { dateKey, timeZone, todayKey, redact, maxChars }) {
  if (dateKey !== todayKey) return [];
  const rendered = [];
  for (const raw of lines) {
    const text = redactText(String(raw ?? '').replace(/\s+/g, ' ').trim(), { enabled: redact });
    if (!text) continue;
    rendered.push(`- ${clipText(text, 200)}`);
  }
  // 从尾部往前装，保证最近的日志优先
  const picked = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const cost = rendered[i].length + 1;
    if (used + cost > maxChars) break;
    picked.push(rendered[i]);
    used += cost;
  }
  picked.reverse();
  return picked;
}

/**
 * 采集上下文。
 * @returns {{ text, chars, empty, stats, errors, role }}
 */
export function collectContext({ config, facts = {}, dateKey, now = new Date(), logger = null }) {
  const errors = [];
  const timeZone = config.timezone;
  const nowDate = now instanceof Date ? now : new Date(now);
  const todayKey = dateKeyInZone(nowDate, timeZone);
  const ownerQQ = Number.isFinite(Number(facts.ownerQQ)) ? Number(facts.ownerQQ) : null;

  let window;
  try {
    window = windowForDate({ dateKey, now: nowDate, timeZone, lookbackHours: config.lookbackHours });
  } catch (error) {
    errors.push(String(error?.message ?? error));
    return {
      text: '',
      chars: 0,
      empty: true,
      stats: { windowStart: null, windowEnd: null, kind: 'invalid', conversations: 0, messages: 0, media: 0 },
      errors
    };
  }

  const socialPath = path.join(String(config.qqBridgeDir ?? ''), 'state', 'social-v2.json');
  const social = readJsonFileSafe(socialPath);
  if (!social.ok) {
    errors.push(`social-v2.json ${social.error === 'missing' ? '缺失' : `读取失败（${social.error}）`}`);
    logger?.warn?.(`[context] ${errors[errors.length - 1]}，按 context=empty 降级`);
  }
  const conversations = new Map();
  const rawConversations = social.ok && social.data && typeof social.data.conversations === 'object' ? social.data.conversations : {};
  for (const [key, value] of Object.entries(rawConversations)) conversations.set(key, value);

  const redact = config.redactPatterns !== false;
  const maxMessageChars = config.maxMessageChars;
  const renderLine = (message) => formatMessageLine(message, { dateKey, timeZone, maxMessageChars, redact });

  // 1) 归一 + 按会话分类
  const privateEntries = [];
  const groupEntries = [];
  const otherPrivateEntries = [];
  let mediaTotal = 0;
  let messageTotal = 0;

  for (const [key, conversation] of conversations) {
    const kind = classifyConversation(key, ownerQQ, config.includeOtherPrivates);
    if (kind === 'ignored' || kind === 'excludedPrivate') continue;
    const { messages, media } = normalizeMessages(conversation, {
      start: window.start,
      end: window.end,
      ownerQQ,
      who: kind === 'owner' ? 'owner' : 'group'
    });
    mediaTotal += media;
    messageTotal += messages.length;
    if (!messages.length) continue;
    const entry = { key, kind, messages, media, latest: messages[messages.length - 1].time };
    if (kind === 'owner') privateEntries.push(entry);
    else if (kind === 'group') groupEntries.push(entry);
    else otherPrivateEntries.push(entry);
  }
  groupEntries.sort((a, b) => b.latest - a.latest);

  const topics = collectTopics(conversations, ownerQQ, config.includeOtherPrivates, {
    redact,
    maxChars: config.maxTopicsChars
  });
  const impressions = collectImpressions(conversations, ownerQQ, config.includeOtherPrivates, {
    redact,
    maxChars: config.maxImpressionsChars
  });

  const hasChat = messageTotal > 0 || topics.length > 0;
  if (!hasChat) {
    const finished = {
      text: '',
      chars: 0,
      empty: true,
      stats: {
        windowStart: window.start,
        windowEnd: window.end,
        kind: window.kind,
        conversations: conversations.size,
        messages: 0,
        media: mediaTotal,
        ownerPrivateMessages: 0,
        groups: 0,
        otherPrivatesExcluded: config.includeOtherPrivates ? 0 : [...conversations.keys()].filter((key) => classifyConversation(key, ownerQQ, false) === 'excludedPrivate').length,
        activityLines: 0,
        topics: 0,
        impressions: impressions.length,
        chars: 0,
        budget: config.maxContextChars,
        privateChars: 0
      },
      errors
    };
    logger?.info?.(
      `[context] 窗口 ${new Date(window.start).toISOString()} ~ ${new Date(window.end).toISOString()}：会话 ${conversations.size} 个，窗口内 0 条可用消息 → context=empty`
    );
    return finished;
  }

  // 2) 预算分配
  const totalBudget = config.maxContextChars;
  const reserveTopics = topics.length ? Math.min(config.maxTopicsChars, config.maxTopicsChars) : 0;
  const reserveImpressions = impressions.length ? Math.min(config.maxImpressionsChars, config.maxImpressionsChars) : 0;
  const activityRaw = readActivityLog({ qqBridgeDir: config.qqBridgeDir, lines: config.activityLogLines, logger });
  const activityLines = renderActivityLines(activityRaw.lines, {
    dateKey,
    timeZone,
    todayKey,
    redact,
    maxChars: config.maxActivityChars
  });
  const reserveActivity = activityLines.length ? Math.min(config.maxActivityChars, config.maxActivityChars) : 0;
  const messageBudget = Math.max(0, totalBudget - reserveTopics - reserveImpressions - reserveActivity);

  const sections = [];

  // 3) 主人私聊（优先，先占 privateShare）
  const privateBudget = Math.max(0, Math.min(config.maxPerConversationChars, Math.floor(messageBudget * config.privateShare)));
  let privateUsed = 0;
  const privateLines = [];
  for (const entry of privateEntries) {
    const remaining = privateBudget - privateUsed;
    if (remaining <= 0) break;
    const title = entry.key === `private:${ownerQQ}` ? '主人私聊' : `私聊 ${entry.key.replace(/^private:/, '')}`;
    const header = `【${title}】`;
    const fit = fitLines(entry.messages, remaining - header.length - 1, renderLine);
    if (!fit.lines.length) continue;
    privateLines.push(header, ...fit.lines);
    privateUsed += header.length + 1 + fit.used;
  }
  if (privateLines.length) sections.push(privateLines.join('\n'));

  // 4) 群聊（占剩余预算，按会话均分）
  if (config.includeGroups && groupEntries.length) {
    let groupBudget = Math.max(0, messageBudget - privateUsed);
    const groupLines = [];
    for (let index = 0; index < groupEntries.length; index += 1) {
      const remainingGroups = groupEntries.length - index;
      const share = Math.floor(groupBudget / remainingGroups);
      if (share <= 40) break;
      const entry = groupEntries[index];
      const title = `群聊 ${entry.key.replace(/^group:/, '')}`;
      const candidates = pickEvenly(entry.messages, Math.max(6, Math.min(40, Math.floor(share / 18))));
      const fit = fitLines(candidates, share, renderLine);
      if (!fit.lines.length) continue;
      groupLines.push(`【${title}】`, ...fit.lines);
      groupBudget -= fit.used;
    }
    if (groupLines.length) sections.push(groupLines.join('\n'));
  }

  // 5) 其他私聊（默认排除；开启后仅用剩余预算）
  if (config.includeOtherPrivates && otherPrivateEntries.length) {
    const used = sections.join('\n\n').length;
    let budget = Math.max(0, messageBudget - used);
    const lines = [];
    for (const entry of otherPrivateEntries) {
      if (budget <= 40) break;
      const fit = fitLines(entry.messages, Math.min(config.maxPerConversationChars, budget), renderLine);
      if (!fit.lines.length) continue;
      lines.push(`【私聊 ${entry.key.replace(/^private:/, '')}】`, ...fit.lines);
      budget -= fit.used;
    }
    if (lines.length) sections.push(lines.join('\n'));
  }

  // 6) 话题 / 印象 / 活动日志
  if (topics.length) {
    const picked = [];
    let used = 0;
    for (const topic of topics) {
      const line = `- ${topic}`;
      if (used + line.length + 1 > reserveTopics) break;
      picked.push(line);
      used += line.length + 1;
    }
    if (picked.length) sections.push(section('近期话题', picked));
  }
  if (impressions.length) {
    const picked = [];
    let used = 0;
    for (const item of impressions) {
      const line = `- ${item}`;
      if (used + line.length + 1 > reserveImpressions) break;
      picked.push(line);
      used += line.length + 1;
    }
    if (picked.length) sections.push(section('我记住的人', picked));
  }
  if (activityLines.length) {
    const picked = [];
    let used = 0;
    for (let i = activityLines.length - 1; i >= 0; i -= 1) {
      const cost = activityLines[i].length + 1;
      if (used + cost > reserveActivity) break;
      picked.push(activityLines[i]);
      used += cost;
    }
    picked.reverse();
    if (picked.length) sections.push(section('最近活动', picked));
  }

  let text = sections.filter(Boolean).join('\n\n');

  // 7) 硬上限兜底（理论上不会触发，触发了就按「群聊 → 私聊尾部」顺序裁）
  if (text.length > totalBudget) {
    const groupsIndex = text.indexOf('【群聊');
    if (groupsIndex > 0 && groupsIndex < text.length - 10) {
      const head = text.slice(0, groupsIndex).trimEnd();
      const tailStart = text.indexOf('【近期话题】');
      const tail = tailStart > groupsIndex ? `\n\n${text.slice(tailStart)}` : '';
      text = `${head}${tail}`;
    }
    if (text.length > totalBudget) {
      text = Array.from(text).slice(0, totalBudget).join('');
    }
    errors.push('上下文超过总上限，已按群聊→私聊尾部顺序裁剪');
    privateUsed = Math.min(privateUsed, text.length);
  }

  const result = {
    text,
    chars: text.length,
    empty: false,
    stats: {
      windowStart: window.start,
      windowEnd: window.end,
      kind: window.kind,
      conversations: conversations.size,
      countedConversations: privateEntries.length + groupEntries.length + otherPrivateEntries.length,
      messages: messageTotal,
      media: mediaTotal,
      ownerPrivateMessages: privateEntries.reduce((sum, entry) => sum + entry.messages.length, 0),
      groups: groupEntries.length,
      otherPrivatesExcluded: config.includeOtherPrivates ? 0 : [...conversations.keys()].filter((key) => classifyConversation(key, ownerQQ, false) === 'excludedPrivate').length,
      activityLines: activityLines.length,
      topics: topics.length,
      impressions: impressions.length,
      chars: text.length,
      budget: totalBudget,
      privateChars: privateUsed
    },
    errors
  };
  logger?.info?.(
    `[context] 窗口 ${new Date(window.start).toISOString()} ~ ${new Date(window.end).toISOString()}：会话 ${conversations.size} 个、消息 ${messageTotal} 条（媒体 ${mediaTotal}）、群 ${groupEntries.length} 个；上下文 ${result.chars}/${totalBudget} 字`
  );
  return result;
}
