#!/usr/bin/env node
// qq-diary 入口：常驻调度 / 单次生成 / 补写 / 自检 / 列表。
//
// 用法：
//   node index.js                 常驻，每天 22:00 写当天日记（+ 启动补写 + 通知重试）
//   node index.js --once          立即写今天（已存在则跳过）
//   node index.js --date YYYY-MM-DD  补写指定日期（已存在跳过，配合 --force 覆盖并备份）
//   node index.js --force         覆盖同日（旧文件备份到 diaries/.backup/）
//   node index.js --dry-run       只打印 prompt/上下文/目标路径，不写文件、不调 API
//   node index.js --dry-run --llm 额外真实调用一次模型，展示将生成的 diary/summary（仍不写文件）
//   node index.js --list          列出已写日记与字数
//   node index.js --check         自检（配置/桥接/角色/key/目录/通知通道/LLM 活体）
//   node index.js --no-notify     本次不发送 QQ 通知
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadBridgeFacts, readBridgeConsoleToken, readJsonFile } from './src/config.js';
import { createLogger, contentHash } from './src/logger.js';
import { collectContext, loadRole } from './src/context.js';
import { buildPrompts, parseDiaryResponse, countDiaryChars } from './src/prompt.js';
import { callLlm, pingLlm, resolveApiKey } from './src/llm.js';
import {
  diaryFilePath,
  countLegacyDiaryFiles,
  findEntry,
  listDiaries,
  migrateLegacyDiaries,
  pathExists,
  readCollection,
  readIndex,
  rebuildIndex,
  upsertEntry
} from './src/store.js';
import {
  dateKeyInZone,
  weekdayCN,
  isoWithOffset,
  nextRunAfter,
  startScheduler,
  acquireLock,
  releaseLock,
  isValidDateKey,
  readLockFile,
  windowForDate
} from './src/scheduler.js';
import { notifyOwner, flushNotifyQueue, probeChannels, notifyFiles, buildNotifyMessage } from './src/notify.js';
// 表现面 S3（GEN3_SURFACE_INTEGRATION_PLAN）：桥接 V3 上下文（失败回退 V2）+ 记忆回写（幂等队列）
import { fetchBridgeContext } from './src/bridge-context.js';
import { captureDiaryMemory, flushMemoryQueue } from './src/memory-writeback.js';
import { deferIfOwnerActive, saveDeferState, clearDeferState } from './src/defer.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** V3 上下文 → prompt 素材文本（memory/topics/recent，各带 trust 已在桥接侧清洗）。 */
function buildV3ContextText(ctx) {
  const parts = [];
  if (Array.isArray(ctx?.memory) && ctx.memory.length) {
    parts.push(`【长期记忆】\n${ctx.memory.map((m) => `- ${m.text}`).join('\n')}`);
  }
  if (Array.isArray(ctx?.topics) && ctx.topics.length) {
    parts.push(`【近期话题】\n${ctx.topics.map((t) => `- ${t.topic}`).join('\n')}`);
  }
  if (Array.isArray(ctx?.recent) && ctx.recent.length) {
    parts.push(`【最近聊天】\n${ctx.recent.map((r) => `${r.sender ? `${r.sender}：` : ''}${r.text}`).join('\n')}`);
  }
  return parts.join('\n');
}

const USAGE = `qq-diary —— 每天 22:00 自动为 QQ 角色写一篇日记

用法：
  node index.js                     常驻运行，每天 22:00 写当天日记
  node index.js --once              立即写今天（已写过则跳过）
  node index.js --date YYYY-MM-DD   补写指定日期（已写过跳过）
  node index.js --force             覆盖同一天（整本合集先备份到 diaries/.backup/）
  node index.js --dry-run           只打印 prompt/上下文/目标文件（不写文件、不调 API）
  node index.js --dry-run --llm     额外调用一次模型，预览将生成的 diary/summary（不写文件）
  node index.js --list              列出日记本里的全部篇目与字数（按日期升序）
  node index.js --check             自检（配置/桥接/角色/key/目录/通知通道/LLM 活体/MCP）
  node index.js --check --no-llm    自检但不做 LLM 活体请求
  node index.js --migrate           把旧版 diaries/YYYY-MM-DD.md 合并进单文件合集
  node index.js --no-notify         本次不发送 QQ 通知
  node index.js --verbose           输出调试日志
  node index.js --help              显示本帮助

所有日记写在同一个文件里（config.diaryFile，默认 diaries/diary.md），按日期升序；
每篇只有 date / weekday / role / summary 四个字段 + 正文。

退出码：0 成功/跳过，1 失败，2 参数错误`;

/** 解析 CLI 参数（纯函数，便于测试）。 */
export function parseArgs(argv = []) {
  const opts = {
    mode: 'daemon',
    date: '',
    force: false,
    dryRun: false,
    withLlm: false,
    list: false,
    check: false,
    help: false,
    noNotify: false,
    verbose: false,
    quiet: false,
    liveLlm: true,
    migrate: false,
    unknown: []
  };
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--once') opts.mode = 'once';
    else if (arg === '--date') {
      opts.mode = 'date';
      opts.date = String(args[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--date=')) {
      opts.mode = 'date';
      opts.date = arg.slice('--date='.length);
    } else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--llm') opts.withLlm = true;
    else if (arg === '--list') opts.list = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--no-notify') opts.noNotify = true;
    else if (arg === '--no-llm') opts.liveLlm = false;
    else if (arg === '--migrate') opts.migrate = true;
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else opts.unknown.push(arg);
  }
  // 只有 --once / --date 才是一次性任务；--force / --dry-run / --llm / --no-notify 都是
  // 「这一次生成」的修饰符，若没显式指定 --once/--date，就按单次执行处理，
  // 避免 `node index.js --force` 误入常驻模式（会占着单实例锁一直不退出）。
  if (opts.mode === 'daemon' && (opts.force || opts.dryRun || opts.withLlm || opts.noNotify)) {
    opts.mode = 'once';
  }
  return opts;
}

function describeContextStats(context, timeZone = 'Asia/Shanghai') {
  const stats = context?.stats ?? {};
  const lines = [
    `  上下文：${context?.chars ?? 0}/${stats.budget ?? '?'} 字，${context?.empty ? 'empty（今天没有聊天上下文）' : 'normal'}`,
    `  窗口：${stats.windowStart ? isoWithOffset(new Date(stats.windowStart), timeZone) : '?'} ~ ${stats.windowEnd ? isoWithOffset(new Date(stats.windowEnd), timeZone) : '?'}`,
    `  消息：${stats.messages ?? 0} 条（媒体 ${stats.media ?? 0}，私聊 ${stats.ownerPrivateMessages ?? 0}，群 ${stats.groups ?? 0} 个，其他私聊排除 ${stats.otherPrivatesExcluded ?? 0}）`,
    `  话题 ${stats.topics ?? 0} / 印象 ${stats.impressions ?? 0} / 活动日志 ${stats.activityLines ?? 0} 行`
  ];
  return lines.join('\n');
}

/**
 * 生成（或预览）指定日期的日记。
 * 返回结构化结果；绝不抛异常（除参数错误外）。
 */
export async function runForDate({
  config,
  facts = {},
  logger = null,
  dateKey = '',
  force = false,
  dryRun = false,
  withLlm = false,
  noNotify = false,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  llmFetchImpl = fetchImpl
}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const target = dateKey || dateKeyInZone(nowDate, config.timezone);
  if (!isValidDateKey(target)) return { ok: false, error: `无效日期：${target}（要求 YYYY-MM-DD）` };
  const todayKey = dateKeyInZone(nowDate, config.timezone);
  if (target > todayKey) return { ok: false, error: `不能为未来日期生成日记：${target}` };

  const file = diaryFilePath(config);
  const collection = readCollection({ config });
  const exists = Boolean(findEntry(collection.entries, target));
  // dry-run 的目的就是看 prompt/上下文，不该因为「这一天已写」就直接跳过预览；
  // 真正会写文件时才跳过（--force 覆盖，--dry-run 永不写）。
  if (exists && !force && !dryRun) {
    logger?.info?.(`[run] ${target} 合集里已有这一天的日记 ${file} ，跳过（--force 可覆盖）`);
    return { ok: true, skipped: true, reason: 'exists', date: target, path: file };
  }

  const role = loadRole({ qqBridgeDir: config.qqBridgeDir, maxRoleChars: config.maxRoleChars, logger });
  let context = collectContext({ config, facts, dateKey: target, now: nowDate, logger });
  // 表现面 S3：contextSource=v3 时优先取桥接 V3 上下文（记忆/主人私聊素材），
  // 失败/超时自动回退上面的 V2 文件读取——绝不因桥接不可用而生成空日记（§8.3 验收）。
  let contextSourceUsed = 'v2';
  if (config.surface?.enabled === true && config.surface.contextSource === 'v3') {
    // window.{start,end,kind} 原样传递（§17.5 第 3 条）：今天=滚动 24h、过去=整日窗口，
    // 语义由 scheduler.windowForDate 单一来源，桥接只透传不改写。
    const win = windowForDate({ dateKey: target, now: nowDate, timeZone: config.timezone, lookbackHours: config.lookbackHours });
    const v3 = await fetchBridgeContext({
      qqBridgeDir: config.qqBridgeDir,
      date: target,
      window: { start: win.start, end: win.end, kind: win.kind },
      fetchImpl
    });
    if (v3.ok && v3.context) {
      contextSourceUsed = 'v3';
      // V3 素材并入上下文文本（带 trust 标签的素材已在桥接侧清洗）；V2 本地素材仍保留兜底
      const v3Text = buildV3ContextText(v3.context);
      context = {
        ...context,
        text: v3Text ? `${v3Text}\n\n${context.text}`.slice(0, config.maxContextChars) : context.text,
        empty: context.empty && !v3Text,
        source: 'v3'
      };
    } else {
      logger?.warn?.(`[run] ${target} 桥接 V3 上下文不可用，回退 V2 文件上下文：${v3.error ?? ''}`);
    }
  }
  const weekday = weekdayCN(target);
  const prompts = buildPrompts({
    role: role.role,
    roleText: role.roleText,
    dateKey: target,
    weekday,
    contextText: context.text,
    contextEmpty: context.empty,
    minDiaryChars: config.minDiaryChars,
    maxDiaryChars: config.maxDiaryChars,
    maxRoleChars: config.maxRoleChars
  });

  const base = {
    date: target,
    path: file,
    role: role.role,
    roleOk: role.ok,
    weekday,
    context,
    prompts,
    exists
  };

  const shouldCallLlm = !dryRun || withLlm || config.dryRunCallsLlm === true;
  if (!shouldCallLlm) {
    logger?.info?.(`[run] dry-run：${target} 目标 ${file}，上下文 ${context.chars} 字（${context.empty ? 'empty' : 'normal'}），未调用模型`);
    return { ok: true, dryRun: true, previewOnly: true, ...base };
  }

  const llm = await callLlm({
    system: prompts.system,
    user: prompts.user,
    config,
    fetchImpl: llmFetchImpl,
    logger
  });
  if (!llm.ok) {
    logger?.error?.(`[run] ${target} 模型调用失败（${llm.error?.code}）：${llm.error?.message}；不写文件，等待重试`);
    return { ok: false, error: `${llm.error?.code ?? 'LLM_ERROR'}：${llm.error?.message ?? '未知错误'}`, llm, ...base };
  }
  logger?.info?.(`[llm] ${target} 生成完成：${llm.durationMs}ms，attempts=${llm.attempts}，key=${llm.source}，usage=${JSON.stringify(llm.usage ?? {})}`);

  const parsed = parseDiaryResponse(llm.text, {
    minChars: config.minDiaryChars,
    maxChars: config.maxDiaryChars
  });
  for (const warning of parsed.warnings) logger?.warn?.(`[run] ${target} ${warning}`);
  if (parsed.parseMode !== 'json') logger?.warn?.(`[run] ${target} 模型输出不是标准 JSON（parseMode=${parsed.parseMode}），已回退解析`);
  if (!parsed.diary) {
    logger?.error?.(`[run] ${target} 解析后的日记为空，不写文件`);
    return { ok: false, error: 'EMPTY_DIARY：解析后的日记为空', ...base };
  }

  // 合集里每篇只保留 date / weekday / role / summary + 正文
  const entry = {
    date: target,
    weekday,
    role: role.role,
    summary: parsed.summary,
    body: parsed.diary
  };
  const resultBase = {
    ...base,
    llm: { durationMs: llm.durationMs, attempts: llm.attempts, source: llm.source, usage: llm.usage ?? null },
    diary: parsed.diary,
    chars: parsed.chars,
    summary: parsed.summary,
    parseMode: parsed.parseMode,
    entry,
    warnings: parsed.warnings
  };

  if (dryRun) {
    logger?.info?.(`[run] dry-run：${target} 将写入 ${file}（${parsed.chars} 字），摘要「${parsed.summary}」；未写文件、未通知`);
    return { ok: true, dryRun: true, wouldWrite: true, ...resultBase };
  }

  const upsert = upsertEntry({ config, entry, backup: exists && force, logger, now: nowDate });
  if (!upsert.ok) {
    logger?.error?.(`[run] ${target} 写入失败：${upsert.error}`);
    return { ok: false, error: `WRITE_FAILED：${upsert.error}`, ...resultBase };
  }
  if (upsert.mode && upsert.mode !== 'rename') {
    logger?.warn?.(`[run] ${target} 原子 rename 失败，已用兜底方式写入（mode=${upsert.mode}）：${upsert.warning ?? ''}`);
  }
  const backupPath = upsert.backupPath ?? null;
  if (backupPath) logger?.info?.(`[run] ${target} 已备份旧版合集到 ${backupPath}`);
  logger?.info?.(
    `[run] ${target} 已写入 ${file} （${parsed.chars} 字，上下文 ${context.chars} 字，合集共 ${upsert.entries.length} 篇，正文 hash=${contentHash(parsed.diary)}）`
  );

  rebuildIndex({ config, logger, now: nowDate });

  // 表现面 S3：日记摘要幂等写回长期记忆（surface-token；失败入队重试，不影响日记本身）
  let memoryWriteback = null;
  if (config.surface?.enabled === true && config.surface.writeMemory === true) {
    memoryWriteback = await captureDiaryMemory({
      qqBridgeDir: config.qqBridgeDir,
      stateDir: config.stateDir,
      date: target,
      summary: parsed.summary,
      upsert: force === true, // force 重写 → 同 dedupeKey 更新为新摘要，不产生第二条
      fetchImpl
    });
    if (!memoryWriteback.ok) {
      logger?.warn?.(`[run] ${target} 记忆回写${memoryWriteback.queued ? '已入队' : '失败'}：${memoryWriteback.error ?? ''}`);
      // 启动队列重试（最多 3 次），不阻断
      void flushMemoryQueue({ qqBridgeDir: config.qqBridgeDir, stateDir: config.stateDir, fetchImpl, logger }).catch(() => {});
    }
  }

  let notify = null;
  if (!noNotify) {
    notify = await notifyOwner({
      config,
      facts,
      logger,
      dateKey: target,
      summary: parsed.summary,
      fetchImpl,
      now: nowDate
    });
    if (!notify.ok) logger?.warn?.(`[run] ${target} 通知主人失败（${notify.queued ? '已入队' : '未入队'}）：${notify.error ?? ''}`);
  } else {
    logger?.info?.(`[run] ${target} --no-notify：跳过通知`);
  }

  return { ok: true, written: true, backupPath, notify, memoryWriteback, contextSource: contextSourceUsed, ...resultBase };
}

/** --check：自检。返回 { ok, checks }，任何 FAIL 让进程退出码为 1。 */
export async function runCheck({
  config,
  facts,
  logger,
  warnings = [],
  fetchImpl = globalThis.fetch,
  liveLlm = true,
  llmFetchImpl = fetchImpl,
  now = new Date()
}) {
  const checks = [];
  const add = (name, ok, detail, level = ok ? 'ok' : 'fail') => {
    checks.push({ name, ok, detail, level });
  };

  add('config.json', true, `${config.configFile}（writeAt=${config.writeAt}，tz=${config.timezone}）`);
  for (const warning of warnings) add('config 警告', false, warning, 'warn');

  const bridgeConfig = path.join(config.qqBridgeDir, 'config.json');
  add('qq-bridge 目录', pathExists(config.qqBridgeDir), config.qqBridgeDir);
  add('qq-bridge/config.json', pathExists(bridgeConfig), bridgeConfig);
  add('qq-bridge 事实', facts.ok, facts.ok ? `ownerQQ=${facts.ownerQQ ?? '?'}，snowluma=${facts.snowluma?.httpUrl || '未配置'}` : `读取失败：${facts.error}`);

  const socialPath = path.join(config.qqBridgeDir, 'state', 'social-v2.json');
  const social = readJsonFile(socialPath);
  if (social.ok) {
    const conversations = social.data?.conversations ?? {};
    const ownerKey = facts.ownerQQ ? `private:${facts.ownerQQ}` : '';
    const owner = ownerKey ? conversations[ownerKey] : null;
    add(
      'state/social-v2.json',
      true,
      `会话 ${Object.keys(conversations).length} 个；owner 私聊 ${owner ? `${owner.recentMessages?.length ?? 0} 条` : '缺失'}；paused=${social.data?.paused ?? '?'}`
    );
  } else {
    add('state/social-v2.json', false, social.error === 'missing' ? '文件缺失（上下文会降级为空）' : `读取/解析失败：${social.error}`, 'warn');
  }

  const role = loadRole({ qqBridgeDir: config.qqBridgeDir, maxRoleChars: config.maxRoleChars, logger });
  add('角色', role.ok, role.ok ? `${role.role}（${role.roleText.length} 字）` : `${role.role}（人设缺失，将用默认口吻）`, role.ok ? 'ok' : 'warn');
  add('state/qq-activity.log', pathExists(path.join(config.qqBridgeDir, 'state', 'qq-activity.log')), '活动日志（可选）', pathExists(path.join(config.qqBridgeDir, 'state', 'qq-activity.log')) ? 'ok' : 'warn');

  const dirs = [config.diaryDir, config.logDir, config.stateDir, config.backupDir];
  let writable = true;
  const dirDetails = [];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.check-${process.pid}-${Date.now()}.tmp`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      dirDetails.push(`${dir} 可写`);
      // 新文件可能被杀软/索引器短暂占用（Windows 上 unlink 会 EBUSY），重试几次再放弃
      let removed = false;
      for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
        try {
          fs.unlinkSync(probe);
          removed = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
        }
      }
      if (!removed) logger?.warn?.(`[check] 探测文件 ${probe} 删除失败（不影响可写结论，可手动清理）`);
    } catch (error) {
      writable = false;
      dirDetails.push(`${dir} 不可写（${error?.message ?? error}）`);
    }
  }
  add('目录可写', writable, dirDetails.join('；'));

  const keyInfo = resolveApiKey({ config });
  add('LLM key', Boolean(keyInfo.key), keyInfo.key ? `来源 ${keyInfo.source}` : 'env / ~/.dsh/.credentials.yaml / config.apiKey 均未找到');
  if (keyInfo.key && liveLlm) {
    const ping = await pingLlm({ config, fetchImpl: llmFetchImpl });
    add('LLM 活体', ping.ok, ping.ok ? `${ping.durationMs}ms，model=${config.model}` : `${ping.error?.code}：${ping.error?.message}`);
  } else if (!liveLlm) {
    add('LLM 活体', true, '已跳过（--no-llm）', 'warn');
  }

  const channels = await probeChannels({ config, facts, fetchImpl });
  add('通知通道 snowluma', channels.snowluma.ok, channels.snowluma.detail, channels.snowluma.ok ? 'ok' : 'warn');
  add(
    '通知通道 bridge',
    channels.bridge.ok,
    `${channels.bridge.detail}${channels.bridge.agentToken ? '，agent token 就绪' : '，缺 agent token（reserved2 无法发送）'}`,
    channels.bridge.ok ? 'ok' : 'warn'
  );
  const usable = config.notifyOwner.channels.filter((channel) => (channel === 'snowluma' ? channels.snowluma.ok : channels.bridge.ok));
  add('通知通道结论', usable.length > 0, usable.length ? `将使用 ${usable[0]}` : '两条通道都不可用（日记仍会写，通知入队重试）', usable.length ? 'ok' : 'warn');
  add('通知开关', true, config.notifyOwner.enabled ? `enabled，同日一次，失败最多尝试 ${config.notifyOwner.retryMax} 次（含首发）` : '已关闭（notifyOwner.enabled=false）', config.notifyOwner.enabled ? 'ok' : 'warn');

  // 聊天内写日记（MCP server）接线检查：profile 注册 + QQ 预设白名单 + server 文件
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  let patchFiles = [];
  try {
    patchFiles = fs
      .readdirSync(path.join(dshHome, 'profiles'))
      .map((profileName) => path.join(dshHome, 'profiles', profileName, 'cordis.patch.yml'))
      .filter((file) => pathExists(file));
  } catch {
    patchFiles = [];
  }
  const registered = patchFiles.filter((file) => {
    try {
      return fs.readFileSync(file, 'utf8').includes('mcp-diary');
    } catch {
      return false;
    }
  });
  add(
    '聊天内写日记（MCP）',
    registered.length > 0,
    registered.length
      ? `已在 DSH profile 注册（${registered.map((file) => path.basename(path.dirname(file))).join('/')}）：diary_write / diary_read / diary_list / diary_search / diary_status / diary_share_to_qzone / diary_digest / diary_digest_write`
      : `未注册：$DSH_HOME/profiles/<profile>/cordis.patch.yml 里缺 mcp-diary（聊天里不能写日记）`,
    registered.length ? 'ok' : 'warn'
  );
  const guardFile = path.join(config.qqBridgeDir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  let guardOk = false;
  try {
    guardOk = fs.readFileSync(guardFile, 'utf8').includes("'mcp__diary__'");
  } catch {
    guardOk = false;
  }
  add(
    '日记工具白名单',
    guardOk,
    guardOk ? 'qq-chat-v2 预设的 qq-tool-restrict 已放行 mcp__diary__' : 'qq-tool-restrict 未放行 mcp__diary__（角色调用会被执行期拒绝）',
    guardOk ? 'ok' : 'warn'
  );
  const serverFile = path.join(ROOT, 'mcp-server.mjs');
  add('mcp-server.mjs', pathExists(serverFile), serverFile, pathExists(serverFile) ? 'ok' : 'fail');

  const lockFile = readLockFile(config.lockFile);
  if (lockFile) {
    add('单实例锁', true, `已有进程持有（pid ${lockFile.pid}，${lockFile.startedAt ?? '?'}）`, 'warn');
  } else {
    add('单实例锁', true, '当前无守护进程运行');
  }

  const todayKey = dateKeyInZone(now, config.timezone);
  const collection = readCollection({ config });
  const todayEntry = findEntry(collection.entries, todayKey);
  add(
    '今天日记',
    true,
    todayEntry
      ? `已写入合集（${todayEntry.chars} 字，摘要：${todayEntry.summary || '（无）'}）`
      : `尚未写入（合集 ${collection.file}，共 ${collection.entries.length} 篇）`
  );
  add('日记合集', true, `${collection.file}：${collection.entries.length} 篇，升序 ${collection.entries[0]?.date ?? '-'} → ${collection.entries[collection.entries.length - 1]?.date ?? '-'}`);
  const legacyCount = countLegacyDiaryFiles({ config });
  add('旧格式文件', true, legacyCount ? `发现 ${legacyCount} 个旧版 diaries/YYYY-MM-DD.md，运行 --migrate 合并` : '无（全部在单文件合集里）', legacyCount ? 'warn' : 'ok');
  add('下次写入', true, `${isoWithOffset(nextRunAfter(now, config.writeAt, config.timezone), config.timezone)}（Asia/Shanghai）`);
  const queue = readJsonFile(notifyFiles(config).queue);
  const pending = Array.isArray(queue.data?.entries) ? queue.data.entries.length : 0;
  add('通知队列', true, pending ? `${pending} 条待重试` : '空', pending ? 'warn' : 'ok');

  return { ok: checks.every((check) => check.level !== 'fail'), checks };
}

function printChecks(checks) {
  const icon = { ok: '[OK]  ', warn: '[WARN]', fail: '[FAIL]' };
  for (const check of checks) {
    console.log(`${icon[check.level] ?? '[INFO]'} ${check.name}：${check.detail}`);
  }
}

/** --list：列出合集里的日记（按日期升序）。 */
export function runList({ config, logger }) {
  const collection = readCollection({ config });
  if (!collection.ok) {
    console.error(`读取日记合集失败：${collection.error}`);
    return 1;
  }
  const index = readIndex({ config });
  console.log(`日记合集：${collection.file}`);
  console.log(
    `共 ${collection.entries.length} 篇（按日期升序）；index.json ${index.ok ? `正常（${index.entries.length} 条）` : `异常（${index.error}），下次写入会自动重建`}`
  );
  if (!collection.entries.length) return 0;
  console.log('');
  for (const entry of collection.entries) {
    console.log(`${entry.date}  ${entry.chars} 字  ${entry.summary || '（无摘要）'}`);
  }
  return 0;
}

/** 常驻模式：单实例锁 + 每分钟 tick + 启动补写 + 通知队列重试。 */
export async function runDaemon({ config, facts, logger, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const lock = acquireLock({ file: config.lockFile, timeZone: config.timezone, now });
  if (!lock.ok) {
    logger?.warn?.(`[daemon] 已有实例在运行（pid ${lock.holder?.pid ?? '?'}，启动于 ${lock.holder?.startedAt ?? '?'}），本次直接退出`);
    return { ok: true, skipped: true, reason: 'locked', holder: lock.holder ?? null };
  }
  if (lock.previous) logger?.warn?.(`[daemon] 接管了上一次残留的锁（旧 pid ${lock.previous.pid}）`);
  logger?.info?.(`[daemon] 启动 pid=${process.pid}`);

  let keepAlive = null;
  const cleanup = () => {
    releaseLock({ file: config.lockFile, pid: process.pid });
    if (keepAlive) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  };
  const handleSignal = (signal) => {
    logger?.info?.(`[daemon] 收到 ${signal}，退出`);
    cleanup();
    process.exit(0);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  await flushNotifyQueue({ config, facts, logger, fetchImpl, now: now() });

  const scheduler = startScheduler({
    writeAt: config.writeAt,
    timeZone: config.timezone,
    tickMs: config.tickMs,
    maxDailyRetries: config.maxDailyRetries,
    retryDelayMs: config.retryDelayMs,
    logger,
    now: () => now().getTime(),
    onDue: async ({ dateKey, trigger }) => {
      logger?.info?.(`[scheduler] 触发 ${dateKey}（${trigger}）`);
      // 活跃期延后（§17.5 第 4 条，默认关）：主人还在说话就等安静/到上限。
      // dateKey 在触发瞬间已固定——即使延后跨零点，仍写「前一天」（整日窗口覆盖完整一天）。
      const defer = await deferIfOwnerActive({ config, ownerQQ: facts.ownerQQ, logger, now: () => now().getTime() });
      if (defer.deferredMs > 0) {
        logger?.info?.(`[scheduler] ${dateKey} 已延后 ${Math.round(defer.deferredMs / 60000)} 分钟（${defer.reason}），继续生成`);
      }
      const result = await runForDate({ config, facts, logger, dateKey, fetchImpl, now: now() });
      if (result.ok && !result.skipped) {
        clearDeferState(config);
        await flushNotifyQueue({ config, facts, logger, fetchImpl, now: now() });
      } else if (!result.ok) {
        // 失败留延后痕迹（重启后调度器按当天缺失自动补写，不新增机制）
        saveDeferState(config, { pendingDate: dateKey, at: new Date(now()).toISOString() });
      }
      return result;
    }
  });
  scheduler.start();

  keepAlive = setInterval(() => {}, 1 << 29);
  // 让调用方（测试/嵌入）能主动停：返回 stop 句柄
  return {
    ok: true,
    running: true,
    scheduler,
    stop() {
      scheduler.stop();
      cleanup();
    }
  };
}

/** 打印 dry-run 预览（prompt + 上下文统计 + 目标路径）。 */
function printDryRun(result, config) {
  const timeZone = config?.timezone ?? 'Asia/Shanghai';
  const prompts = result.prompts ?? { system: '（无）', user: '（无）' };
  console.log(`\n=== dry-run ${result.date} ===`);
  console.log(`角色：${result.role}${result.roleOk ? '' : '（人设缺失，使用默认口吻）'}`);
  console.log(`目标文件：${result.path}${result.exists ? '（已存在，正式运行会跳过；--force 覆盖前会备份）' : ''}`);
  console.log(describeContextStats(result.context, timeZone));
  if (result.context?.errors?.length) console.log(`上下文降级原因：${result.context.errors.join('；')}`);
  if (result.context?.empty) {
    console.log('上下文字段：无聊天上下文 → 仍会写「平静的一天」，frontmatter context=empty');
  }
  console.log('\n--- system prompt ---');
  console.log(prompts.system);
  console.log('\n--- user prompt ---');
  console.log(prompts.user);
  if (result.diary !== undefined) {
    console.log('\n--- 模型将生成的 diary（预览，未写文件） ---');
    console.log(result.diary);
    const minChars = config?.minDiaryChars ?? 200;
    const maxChars = config?.maxDiaryChars ?? 400;
    const okLength = result.chars >= minChars && result.chars <= maxChars;
    console.log(`\n字数：${result.chars}（区间 ${minChars}~${maxChars}，${okLength ? '达标' : '越界'}）`);
    console.log('\n--- summary（通知预览） ---');
    console.log(result.summary);
    const message = config
      ? buildNotifyMessage({ config, dateKey: result.date, summary: result.summary })
      : `📔 ${result.date} 日记已写好：${result.summary}`;
    console.log(`\n将发送：${message}`);
  } else {
    console.log('\n（未调用模型。加 --llm 可真实生成预览；正式运行会调用一次模型）');
  }
}

function resolveDateForRun(opts, config, now) {
  const todayKey = dateKeyInZone(now, config.timezone);
  if (opts.mode !== 'date') return { ok: true, dateKey: todayKey };
  if (!isValidDateKey(opts.date)) {
    console.error(`--date 需要 YYYY-MM-DD 格式（收到 ${JSON.stringify(opts.date)}）`);
    return { ok: false };
  }
  if (opts.date > todayKey) {
    console.error(`不能为未来日期生成日记：${opts.date}（今天 ${todayKey}）`);
    return { ok: false };
  }
  return { ok: true, dateKey: opts.date };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.unknown.length) {
    console.error(`未知参数：${opts.unknown.join(' ')}`);
    console.log(USAGE);
    return 2;
  }

  const { config, warnings } = loadConfig({ root: ROOT });
  const logger = createLogger({
    logDir: config.logDir,
    timeZone: config.timezone,
    minLevel: opts.verbose ? 'debug' : 'info',
    echo: !opts.quiet
  });
  for (const warning of warnings) logger.warn(`[config] ${warning}`);

  const facts = loadBridgeFacts(config.qqBridgeDir);
  if (!facts.ok) logger.warn(`[config] 读取 qq-bridge/config.json 失败：${facts.error}`);

  const keyInfo = resolveApiKey({ config });
  if (keyInfo.key) logger.addSecret(keyInfo.key);
  const consoleToken = readBridgeConsoleToken(config.qqBridgeDir);
  if (consoleToken) logger.addSecret(consoleToken);
  if (facts.snowluma?.accessToken) logger.addSecret(facts.snowluma.accessToken);

  const now = new Date();

  // 旧版「一天一个文件」→ 单文件合集：写路径（daemon/once/date/force）启动时自动迁移一次（幂等）。
  // --list / --check / --dry-run 是只读命令，只提示不迁移，避免「dry-run 承诺不写文件」被打破。
  const writePath = !opts.list && !opts.check && !opts.dryRun;
  const legacyCount = countLegacyDiaryFiles({ config });
  if (opts.migrate || (writePath && legacyCount > 0)) {
    const migration = migrateLegacyDiaries({ config, logger, now });
    if (opts.migrate) {
      if (migration.ok) {
        console.log(`迁移完成：合并 ${migration.migrated} 篇，归档 ${migration.archived} 个旧文件，跳过 ${migration.skipped} 篇。`);
        console.log(`日记合集：${diaryFilePath(config)}`);
      } else {
        console.error(`迁移失败：${migration.error ?? '未知错误'}`);
        return 1;
      }
      if (argv.includes('--migrate')) return 0;
    }
  } else if (legacyCount > 0) {
    logger.warn(`[store] 发现 ${legacyCount} 个旧格式日记文件（diaries/YYYY-MM-DD.md），本次为只读命令不做迁移；运行 node index.js --migrate 合并进合集`);
  }

  if (opts.list) return runList({ config, logger });

  if (opts.check) {
    const result = await runCheck({
      config,
      facts,
      logger,
      warnings,
      liveLlm: opts.liveLlm,
      now
    });
    console.log(`qq-diary 自检（${isoWithOffset(now, config.timezone)}）\n`);
    printChecks(result.checks);
    console.log(`\n结论：${result.ok ? '通过（FAIL 0 个）' : '存在 FAIL 项，请按上面提示处理'}`);
    return result.ok ? 0 : 1;
  }

  const resolved = resolveDateForRun(opts, config, now);
  if (!resolved.ok) return 2;

  if (opts.mode === 'daemon') {
    if (!opts.dryRun) {
      const daemon = await runDaemon({ config, facts, logger, now: () => new Date() });
      if (daemon.skipped) console.log('已有 qq-diary 实例在运行，本次退出。');
      return daemon.ok ? 0 : 1;
    }
    // --dry-run 附带常驻模式时按单次预览处理：不写文件、不常驻
  }

  await flushNotifyQueue({ config, facts, logger, now });

  const result = await runForDate({
    config,
    facts,
    logger,
    dateKey: resolved.dateKey,
    force: opts.force,
    dryRun: opts.dryRun,
    withLlm: opts.withLlm,
    noNotify: opts.noNotify,
    now
  });

  if (opts.dryRun && result.ok) {
    printDryRun(result, config);
    return 0;
  }
  if (result.skipped) {
    console.log(`跳过：${result.date} 已有日记（${result.path}）。如需覆盖请加 --force（会先备份到 diaries/.backup/）。`);
    return 0;
  }
  if (!result.ok) {
    console.error(`失败：${result.error}`);
    console.error('未写入文件；下一次调度/启动会重试。');
    return 1;
  }
  console.log(`已写入：${result.path}`);
  console.log(`日期：${result.date}（${result.weekday}）  角色：${result.role}  字数：${result.chars}`);
  console.log(`上下文：${result.context.chars} 字（${result.context.empty ? 'empty' : 'normal'}）  摘要：${result.summary}`);
  if (result.backupPath) console.log(`整本合集备份：${result.backupPath}`);
  if (result.notify) {
    if (result.notify.skipped) console.log(`通知：跳过（${result.notify.reason ?? 'dry-run'}）`);
    else if (result.notify.ok) console.log(`通知：已发送（${result.notify.channel}）`);
    else console.log(`通知：失败（${result.notify.queued ? '已入队重试' : '未入队'}）${result.notify.error ? `：${result.notify.error}` : ''}`);
  } else {
    console.log('通知：未发送（--no-notify）');
  }
  return 0;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = await main();
  process.exitCode = code;
}
