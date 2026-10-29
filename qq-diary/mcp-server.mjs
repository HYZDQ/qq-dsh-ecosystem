#!/usr/bin/env node
// MCP stdio server：把「写日记 / 读日记」暴露给 QQ 角色（以及 DSH 里的其它会话）。
//
// 挂载方式（见 README「聊天内写日记」一节）：
//   ~/.dsh/profiles/<profile>/cordis.patch.yml 里加一条 @deepseek-ai/dsh-mcp-client：
//     serverName: diary, transport: stdio, command: <node>, args: [<本文件>]
//   QQ 预设的工具白名单（qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs）需要放行
//   mcp__diary__ 前缀，否则角色调用会在执行期被拒。
//
// 协议：MCP stdio = 每行一个 JSON-RPC 2.0 消息。**stdout 只能写协议消息**，
// 日志走文件（echo:false）与 stderr，否则会污染协议流。
//
// 工具：
//   diary_write   写日记（正文由角色自己写；本工具负责校验/存盘/更新索引/发摘要）
//   diary_read    读某天日记
//   diary_list    列最近日记
//   diary_search  按关键词搜日记
//   diary_status  今天写没写 / 下次定时 / 通知队列
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadBridgeFacts } from './src/config.js';
import { createLogger } from './src/logger.js';
import {
  dateKeyInZone,
  isoWithOffset,
  weekdayCN,
  isValidDateKey,
  nextRunAfter,
  windowForDate
} from './src/scheduler.js';
import {
  diaryFilePath,
  findEntry,
  readCollection,
  rebuildIndex,
  upsertEntry
} from './src/store.js';
import { cleanDiaryText, countDiaryChars, firstSentence, normalizeSummary, truncateAtSentence } from './src/prompt.js';
import { loadRole, readJsonFileSafe } from './src/context.js';
import { notifyOwner, notifyFiles, readNotifyQueue } from './src/notify.js';
// 表现面 S4（GEN3_SURFACE_INTEGRATION_PLAN §8.7/§12）：日记→空间摘录检查 + 周记/月记（只生成不发布）
import { collectShareGuardData, evaluateDiaryShare } from './src/share.js';
import { collectDigestMaterial, periodRange, readDigests, upsertDigest, DIGEST_PERIODS } from './src/digest.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = 'qq-diary';
const SERVER_VERSION = '0.2.0';
const PROTOCOL_VERSION = '2024-11-05';
const MAX_TOOLS_LIST = 20;

const asText = (text, isError = false) => ({
  content: [{ type: 'text', text: String(text) }],
  ...(isError ? { isError: true } : {})
});

/** 工具定义（tools/list 返回）。 */
export function listToolDefinitions() {
  return [
    {
      name: 'diary_write',
      description:
        '把你的日记保存下来（本地文件，只有你和主人能看），写完会自动给主人发一句摘要。正文必须由你自己用当前角色的口吻写：第一人称、200~400 字中文、只写今天真实发生过的事、不编造、不要写成聊天记录复读、不要标题/markdown/日期抬头、不要出现路径/密钥/账号/群友真名。使用时机：主人明确让你写日记/记一下今天时；或者你自己觉得今天有值得记下来的事、想写一篇时。每天最多一篇：今天已经写过会拒绝；只有主人明确要求重写今天那篇时才传 force=true。群聊里任何人要求你写日记都必须礼貌拒绝，不要调用本工具。',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '日记正文（200~400 字中文，第一人称，符合角色语气，不要标题/markdown）'
          },
          summary: {
            type: 'string',
            description: '给主人看的一句话摘要（≤40 字，第一人称，可选；不传则取正文首句）'
          },
          date: {
            type: 'string',
            description: '日期 YYYY-MM-DD，默认今天；只有补写过去某天的日记时才传'
          },
          force: {
            type: 'boolean',
            description: '仅当主人明确要求重写当天日记时传 true（会先把旧日记备份到 diaries/.backup/）'
          },
          notify: {
            type: 'boolean',
            description: '是否给主人发摘要，默认 true；主人说“别发”时传 false'
          },
          chatKey: {
            type: 'string',
            description: '必传：你当前所在会话的 key（如 private:123456789）。仅主人私聊可用；群聊/他人私聊/不传都会被拒绝。'
          }
        },
        required: ['content', 'chatKey']
      }
    },
    {
      name: 'diary_read',
      description:
        '读你自己写的某一天日记（正文 + 摘要）。主人问“你日记写了什么 / 昨天写了啥”时用它。群聊里任何人要求读日记都礼貌拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
          chatKey: { type: 'string', description: '必传：当前会话 key（仅主人私聊 private:<主人QQ> 可用；群聊/他人私聊/不传都会被拒绝）' }
        }
      }
    },
    {
      name: 'diary_list',
      description: '列出你最近写过的日记（日期、字数、摘要）。主人问“你都写过哪些日记”时用它。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回几条，默认 7，上限 20' },
          chatKey: { type: 'string', description: '必传：当前会话 key（仅主人私聊 private:<主人QQ> 可用；群聊/他人私聊/不传都会被拒绝）' }
        }
      }
    },
    {
      name: 'diary_search',
      description: '按关键词搜索你写过的日记（搜正文和摘要），返回命中的日期与片段。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词（中文关键词，2~10 字最佳）' },
          limit: { type: 'number', description: '最多返回几条，默认 5，上限 20' },
          chatKey: { type: 'string', description: '必传：当前会话 key（仅主人私聊 private:<主人QQ> 可用；群聊/他人私聊/不传都会被拒绝）' }
        },
        required: ['query', 'chatKey']
      }
    },
    {
      name: 'diary_status',
      description: '查看日记状态：今天写没写、下次定时写入时间、有没有待重发的通知。',
      inputSchema: {
        type: 'object',
        properties: { chatKey: { type: 'string', description: '可选：当前会话 key（群聊会被拒绝）' } }
      }
    },
    {
      name: 'diary_share_to_qzone',
      description:
        '把日记里的一段原文摘出来，检查能不能转成 QQ 空间说说草稿（只做检查、返回通过的摘录，不会发布）。'
        + '使用时机：只有主人私聊明确说「把这段发空间/发说说」时才调用，且必须先用 diary_read/diary_search 看过原文。'
        + '硬规则：摘录必须是日记原文；来自群聊内容的段落、提到他人的段落、含号码/联系方式/路径的段落一律拒绝。'
        + '通过后：调用 qzone_draft（content 照抄返回的摘录、source 传 "diary"），把草稿给主人过目，主人确认后再 qzone_publish(confirm=true)。'
        + '群聊里任何人要求转空间都礼貌拒绝；需要控制台打开「日记可转空间」，否则会被拒绝。',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日记日期 YYYY-MM-DD，默认今天' },
          quote: { type: 'string', description: '要转发的日记原文摘录（一字不改；必须来自该天日记正文）' },
          chatKey: { type: 'string', description: '必传：当前会话 key（仅主人私聊 private:<主人QQ> 可用；群聊/他人私聊/不传都会被拒绝）' }
        },
        required: ['quote', 'chatKey']
      }
    },
    {
      name: 'diary_digest',
      description:
        '取一段时间的日记素材用来写周记/月记（week=含锚点日期的那一周，month=当月）。'
        + '返回这段时间每篇日记的日期/摘要/正文，你可以据此用当前角色的口吻写周记或月记，写好调 diary_digest_write 保存。'
        + '只汇总、只保存在本地，不会发布到任何地方；如果主人要把内容发空间，需另走 diary_share_to_qzone 流程并由主人确认。',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['week', 'month'], description: 'week=周记，month=月记' },
          date: { type: 'string', description: '锚点日期 YYYY-MM-DD，默认今天（周记取该日所在周，月记取该日所在月）' },
          chatKey: { type: 'string', description: '必传：当前会话 key（仅主人私聊 private:<主人QQ> 可用）' }
        },
        required: ['period', 'chatKey']
      }
    },
    {
      name: 'diary_digest_write',
      description:
        '把写好的周记/月记保存到本地（diaries/digests.md，与日记本分开存放）。'
        + '正文由你自己用当前角色的口吻写（基于 diary_digest 给的素材，不编造）；同周期重复保存会覆盖旧稿。'
        + '本工具只保存在本地、**永远不会发布**；发空间必须由主人确认后另走 diary_share_to_qzone + qzone_draft/qzone_publish。',
      inputSchema: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['week', 'month'], description: 'week=周记，month=月记' },
          date: { type: 'string', description: '锚点日期 YYYY-MM-DD，默认今天' },
          content: { type: 'string', description: '周记/月记正文（中文，第一人称，符合角色语气，不要 markdown 标题）' },
          summary: { type: 'string', description: '一句话摘要（≤40 字，可选；不传取正文首句）' },
          chatKey: { type: 'string', description: '必传：当前会话 key（仅主人私聊 private:<主人QQ> 可用）' }
        },
        required: ['period', 'content', 'chatKey']
      }
    }
  ];
}

function clampLimit(value, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TOOLS_LIST, Math.max(1, Math.round(n)));
}

function isGroupChatKey(key) {
  return typeof key === 'string' && key.trim().startsWith('group:');
}

/**
 * H3 owner 鉴权（GEN3_SURFACE_INTEGRATION_PLAN §8.5）：只有主人私聊可读写日记。
 * 旧逻辑只拒 `group:`，不传 chatKey 或任意 `private:<别人>` 都放行——任何私聊都能读写日记。
 * 现在：群聊拒、缺 chatKey 拒、非主人私聊拒、未配置 ownerQQ 拒（失败关闭）。
 * token 只有能反解成 owner 私聊 key 才放行（keyForToken 注入），光有 token 不够。
 * @returns {string|null} 拒绝原因；null=放行
 */
function assertOwnerPrivate({ chatKey, ownerQQ, token, keyForToken } = {}) {
  if (isGroupChatKey(chatKey)) return '群聊不写/不读日记';
  const ownerKey = ownerQQ ? `private:${String(ownerQQ)}` : '';
  if (!ownerKey) return '未配置 ownerQQ，日记功能不可用';
  const key = typeof chatKey === 'string' ? chatKey.trim() : '';
  if (key === ownerKey) return null;
  if (token && typeof keyForToken === 'function' && keyForToken(token) === ownerKey) return null;
  if (!key) return '缺少 chatKey：只有主人私聊（private:<主人QQ>）可以访问日记';
  return '只有主人私聊可以访问日记';
}

/**
 * 创建服务实例（纯函数式，方便单测；不碰 stdin/stdout）。
 * @returns {{ listTools, callTool, handleMessage, close }}
 */
export function createDiaryServer({ config, facts, logger = null, now = () => new Date(), notifyFetchImpl = globalThis.fetch }) {
  const log = logger ?? createLogger({ logDir: null, echo: false, timeZone: config?.timezone });
  const factsValue = facts ?? {};
  // H3：统一 owner 鉴权（群聊拒、缺 chatKey 拒、非主人私聊拒）
  const ownerCheck = (args) => assertOwnerPrivate({ chatKey: args?.chatKey, ownerQQ: factsValue.ownerQQ });
  // §17.5 第 6 条：每日写入上限（含 force），防模型循环重写；进程内计数（重启重置可接受，非安全边界）
  const writeCountByDate = new Map();
  const maxWritesPerDay = Number(config?.maxWritesPerDay) > 0 ? Number(config.maxWritesPerDay) : 3;
  const nowDate = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };

  function resolveDate(args) {
    const today = dateKeyInZone(nowDate(), config.timezone);
    const raw = typeof args?.date === 'string' ? args.date.trim() : '';
    if (!raw) return { ok: true, dateKey: today, today };
    if (!isValidDateKey(raw)) return { ok: false, error: `日期格式不对：${raw}（应为 YYYY-MM-DD）` };
    if (raw > today) return { ok: false, error: `不能写未来日期的日记（${raw} > 今天 ${today}）` };
    return { ok: true, dateKey: raw, today };
  }

  function toolDiaryWrite(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    const resolved = resolveDate(args);
    if (!resolved.ok) return asText(resolved.error, true);
    const { dateKey } = resolved;

    let diary = cleanDiaryText(args.content ?? '');
    if (!diary) return asText('日记正文是空的，写点今天真实发生的事再调用一次。', true);
    let chars = countDiaryChars(diary);
    const minChars = Number(config.minDiaryChars) || 200;
    const maxChars = Number(config.maxDiaryChars) || 400;

    if (chars < Math.floor(minChars / 2)) {
      return asText(
        `日记太短了（现在 ${chars} 字，要求 ${minChars}~${maxChars} 字）。请用当前角色的口吻把今天的事写得更完整一点（细节、感受、小日常），不要编造，然后再调用一次 diary_write。`,
        true
      );
    }
    let lengthNote = '';
    if (chars > maxChars) {
      const originalChars = chars;
      diary = truncateAtSentence(diary, maxChars);
      chars = countDiaryChars(diary);
      lengthNote = `，原文 ${originalChars} 字已按句边界收短`;
    } else if (chars < minChars) {
      lengthNote = '，略低于下限按原样保存';
    }

    const file = diaryFilePath(config);
    const collection = readCollection({ config });
    const existing = findEntry(collection.entries, dateKey);
    if (existing && args.force !== true) {
      return asText(
        `${dateKey} 的日记已经写过了（${existing.chars} 字，摘要：${existing.summary || '（无）'}）。每天最多一篇，今天不用再写；如果主人明确要求重写这一天，再传 force=true（会先把整本日记备份）。`
      );
    }
    // 每日写入上限（含 force）：DIARY_WRITE_LIMIT 稳定拒绝，防循环重写
    const writesToday = writeCountByDate.get(dateKey) ?? 0;
    if (writesToday >= maxWritesPerDay) {
      return asText(`今天已写入 ${writesToday} 次（上限 ${maxWritesPerDay} 次/天，含 force 重写），不再写入。`, true);
    }

    const role = loadRole({ qqBridgeDir: config.qqBridgeDir, maxRoleChars: config.maxRoleChars, logger: log });
    const summaryResult = normalizeSummary(
      typeof args.summary === 'string' && args.summary.trim() ? args.summary : firstSentence(diary, 40),
      { maxChars: 40 }
    );
    const summary = summaryResult.summary || firstSentence(diary, 40) || '今天也记了一笔';
    const upsert = upsertEntry({
      config,
      entry: {
        date: dateKey,
        weekday: weekdayCN(dateKey),
        role: role.role,
        summary,
        body: diary
      },
      backup: Boolean(existing) && args.force === true,
      logger: log,
      now: nowDate()
    });
    if (!upsert.ok) return asText(`保存日记失败：${upsert.error}`, true);
    writeCountByDate.set(dateKey, writesToday + 1);
    if (upsert.mode && upsert.mode !== 'rename') {
      log.warn(`[mcp] 原子 rename 失败，已用兜底方式写入（mode=${upsert.mode}）：${upsert.warning ?? ''}`);
    }
    rebuildIndex({ config, logger: log, now: nowDate() });

    let notifyText = '';
    const backupNote = upsert.backupPath ? ' 旧版合集已备份。' : '';
    const total = upsert.entries.length;
    if (config.notifyOwner.enabled && args.notify !== false) {
      // 同步等通知结果：角色需要知道“主人到底收到没有”，失败也要如实说
      const notifyPromise = notifyOwner({
        config,
        facts: factsValue,
        logger: log,
        dateKey,
        summary,
        fetchImpl: notifyFetchImpl,
        now: nowDate()
      });
      if (typeof notifyPromise?.then === 'function') {
        return notifyPromise.then((result) => {
          if (result?.ok && result.skipped) notifyText = `主人今天已经收到过摘要了（${result.reason ?? 'already-sent'}），没有重复发。`;
          else if (result?.ok) notifyText = `已经给主人发了一句摘要（${result.channel ?? '未知通道'}）。`;
          else notifyText = `日记已保存，但摘要发送失败${result?.queued ? '，已进重试队列' : ''}；可以过一会儿再试，或告诉主人“日记写好了”。`;
          return asText(
            `已把 ${dateKey}（${weekdayCN(dateKey)}）的日记写进日记本（${chars} 字${lengthNote}，现在共 ${total} 篇）。摘要：${summary}。${notifyText}${backupNote}`
          );
        });
      }
      return asText(`已把 ${dateKey} 的日记写进日记本（${chars} 字${lengthNote}，共 ${total} 篇）。摘要：${summary}。${backupNote}`);
    }
    return asText(`已把 ${dateKey}（${weekdayCN(dateKey)}）的日记写进日记本（${chars} 字${lengthNote}，共 ${total} 篇）。摘要：${summary}。没有给主人发通知。${backupNote}`);
  }

  function toolDiaryRead(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    const resolved = resolveDate(args);
    if (!resolved.ok) return asText(resolved.error, true);
    const collection = readCollection({ config });
    if (!collection.ok) return asText(`读日记失败：${collection.error}`, true);
    const entry = findEntry(collection.entries, resolved.dateKey);
    if (!entry) return asText(`${resolved.dateKey} 没有日记。`);
    return asText(
      `${resolved.dateKey}（${entry.weekday || weekdayCN(resolved.dateKey)}）的日记，${entry.chars} 字：\n\n${entry.body}\n\n（摘要：${entry.summary || '（无）'}）`
    );
  }

  function toolDiaryList(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    const limit = clampLimit(args.limit, 7);
    const collection = readCollection({ config });
    if (!collection.ok) return asText(`列日记失败：${collection.error}`, true);
    if (!collection.entries.length) return asText('还没有写过日记。');
    const shown = collection.entries.slice(-limit);
    const lines = shown.map((entry) => `${entry.date}（${entry.chars} 字）${entry.summary || '（无摘要）'}`);
    return asText(`日记本共 ${collection.entries.length} 篇，最近 ${shown.length} 篇（按日期升序）：\n${lines.join('\n')}`);
  }

  function toolDiarySearch(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    const query = String(args.query ?? '').trim();
    if (!query) return asText('搜索词不能为空。', true);
    const limit = clampLimit(args.limit, 5);
    const collection = readCollection({ config });
    if (!collection.ok) return asText(`搜索失败：${collection.error}`, true);
    const hits = [];
    for (const entry of collection.entries) {
      if (hits.length >= limit) break;
      const inSummary = String(entry.summary ?? '').includes(query);
      const index = entry.body.indexOf(query);
      if (!inSummary && index < 0) continue;
      const start = Math.max(0, index - 40);
      const excerpt = String(entry.body).slice(start, start + 120).replace(/\s+/g, ' ');
      hits.push(`${entry.date}（${entry.chars} 字）：…${excerpt}…`);
    }
    if (!hits.length) return asText(`没有找到包含「${query}」的日记。`);
    return asText(`找到 ${hits.length} 篇含「${query}」的日记：\n${hits.join('\n')}`);
  }

  function toolDiaryStatus(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    const today = dateKeyInZone(nowDate(), config.timezone);
    const collection = readCollection({ config });
    if (!collection.ok) return asText(`查日记状态失败：${collection.error}`, true);
    const entry = findEntry(collection.entries, today);
    const todayText = entry
      ? `今天已写（${entry.chars} 字，摘要：${entry.summary || '（无）'}），日记本共 ${collection.entries.length} 篇。`
      : `今天还没写，日记本共 ${collection.entries.length} 篇。`;
    let nextText = '';
    try {
      const upcoming = nextRunAfter(nowDate(), config.writeAt, config.timezone);
      nextText = `下一次定时写入：${isoWithOffset(upcoming, config.timezone)}`;
    } catch {
      nextText = '定时写入时间未知。';
    }
    const queue = readNotifyQueue(notifyFiles(config).queue);
    const pending = Array.isArray(queue.entries) ? queue.entries.length : 0;
    return asText(`${todayText}${nextText}。待重发的摘要：${pending} 条。`);
  }

  /** S4：收集某天日记窗口内的「群聊采样文本 + 他人显示名」（只读 social-v2.json）。 */
  function shareGuardForDate(dateKey) {
    const socialPath = path.join(String(config.qqBridgeDir ?? ''), 'state', 'social-v2.json');
    const social = readJsonFileSafe(socialPath);
    const conversations = social.ok && social.data && typeof social.data.conversations === 'object' ? social.data.conversations : {};
    let win = { start: 0, end: Number.MAX_SAFE_INTEGER };
    try {
      win = windowForDate({ dateKey, now: nowDate(), timeZone: config.timezone, lookbackHours: config.lookbackHours });
    } catch { /* 窗口计算失败退化成不限窗口（只会更严，不会更松） */ }
    return collectShareGuardData({ conversations, ownerQQ: factsValue.ownerQQ, start: win.start, end: win.end });
  }

  /** S4（§8.7）：日记摘录 → 空间草稿的检查（只检查、返回摘录；发布永远由主人确认走 qzone_publish）。 */
  function toolDiaryShareToQzone(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    if (factsValue.diaryShareEnabled !== true) {
      return asText('日记转空间未开启：请主人在桥接控制台打开「表现面 → 日记可转空间」（socialV3.surface.diary.shareToQzone）后再试。', true);
    }
    const resolved = resolveDate(args);
    if (!resolved.ok) return asText(resolved.error, true);
    const quote = String(args.quote ?? '').trim();
    if (!quote) return asText('摘录不能为空：把日记里要发空间的那段原文传给 quote。', true);
    const collection = readCollection({ config });
    if (!collection.ok) return asText(`读日记失败：${collection.error}`, true);
    const entry = findEntry(collection.entries, resolved.dateKey);
    if (!entry) return asText(`${resolved.dateKey} 没有日记。`, true);
    const guard = shareGuardForDate(resolved.dateKey);
    const verdict = evaluateDiaryShare({
      body: entry.body,
      quote,
      groupTexts: guard.groupTexts,
      knownNames: guard.knownNames,
      maxContentChars: Number(factsValue.qzoneMaxContentChars) || 1000
    });
    if (!verdict.ok) {
      // 日志只记拒绝码，不记正文（项目红线）
      log.info?.(`[mcp] 摘录转空间被拒：${verdict.code}`);
      return asText(`这段摘录不能转成公开说说（${verdict.code}）：${verdict.reason}`, true);
    }
    return asText(
      `摘录检查通过（${countDiaryChars(verdict.content)} 字）。可以转成空间草稿的内容如下（原文照抄，不要改写）：\n`
      + `<<<\n${verdict.content}\n>>>\n`
      + '下一步：调用 qzone_draft，content 用上面这段原文，source 传 "diary"；把草稿给主人过目，主人明确确认后再 qzone_publish(confirm=true)。不要自行发布。'
    );
  }

  function resolvePeriod(args) {
    const period = String(args?.period ?? '').trim();
    if (!DIGEST_PERIODS.includes(period)) return { ok: false, error: `周期不对：${args?.period}（应为 week 或 month）` };
    return { ok: true, period };
  }

  /** S4：周记/月记素材（只汇总，不发布）。 */
  function toolDiaryDigest(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    const periodResult = resolvePeriod(args);
    if (!periodResult.ok) return asText(periodResult.error, true);
    const resolved = resolveDate(args);
    if (!resolved.ok) return asText(resolved.error, true);
    let range;
    try {
      range = periodRange({ period: periodResult.period, dateKey: resolved.dateKey });
    } catch (error) {
      return asText(String(error?.message ?? error), true);
    }
    const collection = readCollection({ config });
    if (!collection.ok) return asText(`读日记失败：${collection.error}`, true);
    const material = collectDigestMaterial(collection.entries, range);
    if (!material.length) return asText(`${range.label}没有日记可汇总。`);
    const lines = material.map((entry) => `【${entry.date} ${entry.weekday || weekdayCN(entry.date)}】${entry.summary || '（无摘要）'}\n${entry.body}`);
    return asText(
      `${range.label}共 ${material.length} 篇日记：\n\n${lines.join('\n\n')}\n\n`
      + '（以上是素材：请用当前角色的口吻写成一篇周记/月记，写好调 diary_digest_write 保存；只保存在本地，不会发布。）'
    );
  }

  /** S4：周记/月记保存（只写本地合集，无任何发布动作）。 */
  function toolDiaryDigestWrite(args = {}) {
    const denied = ownerCheck(args);
    if (denied) return asText(denied, true);
    const periodResult = resolvePeriod(args);
    if (!periodResult.ok) return asText(periodResult.error, true);
    const resolved = resolveDate(args);
    if (!resolved.ok) return asText(resolved.error, true);
    let range;
    try {
      range = periodRange({ period: periodResult.period, dateKey: resolved.dateKey });
    } catch (error) {
      return asText(String(error?.message ?? error), true);
    }
    let body = cleanDiaryText(args.content ?? '');
    if (!body) return asText('正文是空的，写点这个周期真实发生的事再调用一次。', true);
    const maxChars = periodResult.period === 'month' ? 4000 : 2000;
    let lengthNote = '';
    const chars = countDiaryChars(body);
    if (chars > maxChars) {
      body = truncateAtSentence(body, maxChars);
      lengthNote = `，原文 ${chars} 字已按句边界收短`;
    }
    const role = loadRole({ qqBridgeDir: config.qqBridgeDir, maxRoleChars: config.maxRoleChars, logger: log });
    const summaryResult = normalizeSummary(
      typeof args.summary === 'string' && args.summary.trim() ? args.summary : firstSentence(body, 40),
      { maxChars: 40 }
    );
    const summary = summaryResult.summary || firstSentence(body, 40) || '这段时间也记了一笔';
    const upsert = upsertDigest({
      config,
      entry: { period: periodResult.period, date: resolved.dateKey, role: role.role, summary, body },
      logger: log
    });
    if (!upsert.ok) return asText(`保存失败：${upsert.error}`, true);
    return asText(
      `已把${range.label}保存到本地周记/月记合集（${countDiaryChars(body)} 字${lengthNote}，${upsert.replaced ? '覆盖了旧稿' : '新增一篇'}）。摘要：${summary}。`
      + '只保存在本地，没有发布到任何地方。'
    );
  }

  const tools = {
    diary_write: toolDiaryWrite,
    diary_read: toolDiaryRead,
    diary_list: toolDiaryList,
    diary_search: toolDiarySearch,
    diary_status: toolDiaryStatus,
    diary_share_to_qzone: toolDiaryShareToQzone,
    diary_digest: toolDiaryDigest,
    diary_digest_write: toolDiaryDigestWrite
  };

  function callTool(name, args = {}) {
    const tool = tools[name];
    if (!tool) return asText(`未知工具：${name}`, true);
    try {
      return tool(args ?? {});
    } catch (error) {
      log.error(`[mcp] 工具 ${name} 异常：${error?.message ?? error}`);
      return asText(`工具执行失败：${error?.message ?? error}`, true);
    }
  }

  return {
    listTools: () => listToolDefinitions(),
    callTool,
    handleMessage,
    toolNames: Object.keys(tools),
    close() {}
  };

  /** 处理一条 JSON-RPC 消息；通知类返回 null。 */
  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = message;
    if (id === undefined || id === null) {
      // 通知（notifications/initialized 等）不需要回复
      if (method === 'notifications/cancelled') log.debug?.(`[mcp] cancelled ${params?.requestId ?? ''}`);
      return null;
    }
    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
          }
        };
      }
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: listToolDefinitions() } };
      if (method === 'tools/call') {
        const name = String(params?.name ?? '');
        const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        const result = await callTool(name, args);
        return { jsonrpc: '2.0', id, result };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (error) {
      log.error(`[mcp] 处理 ${method} 失败：${error?.message ?? error}`);
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } };
    }
  }
}

/** 启动 stdio 服务；返回 { stop }。 */
export function serveStdio({ server, input = process.stdin, output = process.stdout, logger = null }) {
  const write = (message) => {
    if (!message) return;
    output.write(`${JSON.stringify(message)}\n`);
  };
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const text = String(line ?? '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // 解析错误也排队，保证响应顺序与请求顺序一致
      chain = chain.then(() =>
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      );
      return;
    }
    chain = chain
      .then(() => server.handleMessage(message))
      .then((response) => write(response))
      .catch((error) => {
        logger?.error?.(`[mcp] 处理消息失败：${error?.message ?? error}`);
        write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } });
      });
  });
  return {
    stop() {
      try {
        rl.close();
      } catch {
        // ignore
      }
    }
  };
}

/** 本地自检：不依赖 DSH，直接跑一轮 initialize / tools/list / 每个只读工具。 */
async function selftest() {
  const { config, warnings } = loadConfig({ root: ROOT });
  const facts = loadBridgeFacts(config.qqBridgeDir);
  const logger = createLogger({ logDir: config.logDir, timeZone: config.timezone, echo: false });
  const server = createDiaryServer({ config, facts, logger });
  const init = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'selftest' } } });
  console.log('initialize:', JSON.stringify(init.result));
  const toolsList = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  console.log('tools:', toolsList.result.tools.map((tool) => tool.name).join(', '));
  // H3：工具必须传主人私聊 chatKey——自检按真实调用方式传 key
  const ownerKey = facts.ownerQQ ? `private:${String(facts.ownerQQ)}` : '';
  for (const [index, [name, args]] of [
    ['diary_status', { chatKey: ownerKey }],
    ['diary_list', { chatKey: ownerKey, limit: 3 }],
    ['diary_read', { chatKey: ownerKey }],
    ['diary_digest', { chatKey: ownerKey, period: 'week' }]
  ].entries()) {
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 10 + index, method: 'tools/call', params: { name, arguments: args } });
    const text = response.result?.content?.[0]?.text ?? '';
    console.log(`${name}:`, text.slice(0, 300), response.result?.isError ? '(isError)' : '');
  }
  console.log('config warnings:', warnings.length ? warnings.join('；') : '（无）');
  console.log('qqBridge facts ok:', facts.ok, 'ownerQQ:', facts.ownerQQ);
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    await selftest();
    process.exitCode = 0;
  } else if (argv.includes('--help')) {
    console.log(`qq-diary MCP server（stdio）

用法：
  node mcp-server.mjs              作为 MCP stdio server 运行（由 DSH 的 mcp-client 拉起）
  node mcp-server.mjs --selftest   本地自检：列出工具并跑一遍只读工具
  node mcp-server.mjs --help       本帮助

工具：diary_write / diary_read / diary_list / diary_search / diary_status
⚠️ stdout 是 MCP 协议流，日志只写 logs/ 与 stderr。`);
    process.exitCode = 0;
  } else {
    const { config } = loadConfig({ root: ROOT });
    const facts = loadBridgeFacts(config.qqBridgeDir);
    const logger = createLogger({ logDir: config.logDir, timeZone: config.timezone, echo: false });
    const server = createDiaryServer({ config, facts, logger });
    const transport = serveStdio({ server, logger });
    logger.info(`[mcp] ${SERVER_NAME} stdio server 启动（pid=${process.pid}，工具 ${server.toolNames.join('/')}）`);
    process.on('SIGINT', () => {
      transport.stop();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      transport.stop();
      process.exit(0);
    });
    process.stdin.on('end', () => {
      transport.stop();
      process.exit(0);
    });
  }
}
