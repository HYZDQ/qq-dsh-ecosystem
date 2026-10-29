// 通知主人：写完日记后发一句摘要。
//
// 通道优先级（config.notifyOwner.channels，默认 ["snowluma","bridge"]）：
//   1. snowluma：直接 POST {snowluma.httpUrl}/send_private_msg（OneBot HTTP，带 access_token）。
//      桥接对「自己发的消息」直接忽略（bridge.js 里 user_id === self_id 就 return），
//      所以这条路**不会唤醒 AI、不改桥接 state**，是最干净的通知通道。
//   2. bridge：POST {consoleUrl}/api/send/private（x-console-token + reserved2 的会话 agent token）。
//      注意：桥接发送成功后会 scheduleReplyCheckV2 → 15s 后唤醒 AI 回话，
//      且受模式（只允许 closed-agent/reserved2）/暂停/静默/敏感词/限速约束，因此作为回退通道。
//
// 同日只通知一次；失败进 notify-queue.json，最多 retryMax 次；通知失败不影响日记已写入。
import path from 'node:path';
import { isoWithOffset, dateKeyInZone } from './scheduler.js';
import { redactText } from './logger.js';
import { readBridgeConsoleToken, readJsonFile } from './config.js';
import { writeFileAtomic } from './store.js';

export const NOTIFY_STATE_VERSION = 1;
const STATE_KEEP_DAYS = 90;

export function notifyFiles(config) {
  return {
    state: path.join(config.stateDir, 'notify-state.json'),
    queue: path.join(config.stateDir, 'notify-queue.json')
  };
}

/** 组装给主人的一句话：套模板 + 脱敏 + 截断到 maxChars。 */
export function buildNotifyMessage({ config, dateKey, summary }) {
  const template = String(config.notifyOwner.template || '📔 {date} 日记已写好：{summary}');
  const safeSummary = redactText(String(summary ?? '').replace(/\s+/g, ' ').trim(), {
    enabled: config.redactPatterns !== false
  });
  let message = template.replace(/\{date\}/g, dateKey).replace(/\{summary\}/g, safeSummary);
  message = redactText(message.replace(/\s+/g, ' ').trim(), { enabled: config.redactPatterns !== false });
  const maxChars = config.notifyOwner.maxChars;
  if (Array.from(message).length > maxChars) message = Array.from(message).slice(0, maxChars).join('');
  return message;
}

export function readNotifyState(file) {
  const read = readJsonFile(file);
  if (!read.ok || !read.data || typeof read.data !== 'object' || !read.data.sent || typeof read.data.sent !== 'object') {
    return { version: NOTIFY_STATE_VERSION, sent: {} };
  }
  return { version: NOTIFY_STATE_VERSION, sent: read.data.sent };
}

export function writeNotifyState(file, state, { now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const dates = Object.keys(state.sent ?? {}).sort();
  const keep = dates.slice(-STATE_KEEP_DAYS);
  const sent = {};
  for (const date of keep) sent[date] = state.sent[date];
  const payload = { version: NOTIFY_STATE_VERSION, updatedAt: isoWithOffset(now, timeZone), sent };
  return writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
}

export function readNotifyQueue(file) {
  const read = readJsonFile(file);
  if (!read.ok || !read.data || !Array.isArray(read.data.entries)) return { version: NOTIFY_STATE_VERSION, entries: [] };
  return { version: NOTIFY_STATE_VERSION, entries: read.data.entries };
}

export function writeNotifyQueue(file, queue, { now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const payload = {
    version: NOTIFY_STATE_VERSION,
    updatedAt: isoWithOffset(now, timeZone),
    entries: queue.entries ?? []
  };
  return writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function markSent({ config, file, dateKey, channel, message, now, dryRun }) {
  if (dryRun) return;
  const state = readNotifyState(file);
  state.sent[dateKey] = {
    ok: true,
    at: isoWithOffset(now, config.timezone),
    channel,
    chars: Array.from(message).length
  };
  writeNotifyState(file, state, { now, timeZone: config.timezone });
}

// ───────────────────────── 通道实现 ─────────────────────────

/** SnowLuma OneBot HTTP：只发 ownerQQ 私聊。 */
export async function sendSnowluma({ facts, message, config, fetchImpl = globalThis.fetch }) {
  const httpUrl = String(facts?.snowluma?.httpUrl ?? '').trim().replace(/\/+$/, '');
  const accessToken = String(facts?.snowluma?.accessToken ?? '').trim();
  const ownerQQ = Number(facts?.ownerQQ);
  if (!httpUrl) return { ok: false, channel: 'snowluma', error: 'qq-bridge 未配置 snowluma.httpUrl' };
  if (!Number.isFinite(ownerQQ) || ownerQQ <= 0) return { ok: false, channel: 'snowluma', error: '缺少 ownerQQ' };
  if (!accessToken) return { ok: false, channel: 'snowluma', error: 'qq-bridge 未配置 snowluma.accessToken' };
  const url = new URL(`${httpUrl}/send_private_msg`);
  url.searchParams.set('access_token', accessToken);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: ownerQQ, message }),
      signal: AbortSignal.timeout(config.notifyOwner.timeoutMs)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 忽略非 JSON 响应，下面按 retcode 判失败
    }
    const retcode = Number(json?.retcode);
    const ok = response.ok && retcode === 0;
    return {
      ok,
      channel: 'snowluma',
      status: response.status,
      error: ok ? null : `SnowLuma HTTP ${response.status}${Number.isFinite(retcode) ? ` retcode=${retcode}` : ''}`
    };
  } catch (error) {
    return { ok: false, channel: 'snowluma', error: `SnowLuma 发送失败：${error?.name ?? 'Error'} ${error?.message ?? error}` };
  }
}

/**
 * 桥接控制台：x-console-token + POST /api/send/private。
 * reserved2 模式必须带该会话的 agent token（从 social-v2.json 只读取得）。
 * 注意副作用：成功后桥接会安排 replyCheck 唤醒，AI 可能额外回一句。
 */
export async function sendBridge({ facts, config, message, fetchImpl = globalThis.fetch }) {
  const qqBridgeDir = String(config.qqBridgeDir ?? '');
  const ownerQQ = Number(facts?.ownerQQ);
  const consoleToken = readBridgeConsoleToken(qqBridgeDir);
  if (!Number.isFinite(ownerQQ) || ownerQQ <= 0) return { ok: false, channel: 'bridge', error: '缺少 ownerQQ' };
  if (!consoleToken) return { ok: false, channel: 'bridge', error: '缺 state/console-token（控制台未初始化）' };
  const base = `http://127.0.0.1:${Number(facts?.consolePort) || 3100}`;
  const timeoutMs = config.notifyOwner.timeoutMs;
  try {
    const statusResponse = await fetchImpl(`${base}/api/status`, {
      headers: { 'x-console-token': consoleToken },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!statusResponse.ok) return { ok: false, channel: 'bridge', error: `控制台 /api/status HTTP ${statusResponse.status}` };
    let status = null;
    try {
      status = await statusResponse.json();
    } catch {
      status = null;
    }
    const mode = String(status?.mode ?? '');
    if (mode !== 'reserved2' && mode !== 'closed-agent') {
      return { ok: false, channel: 'bridge', error: `桥接当前模式 ${mode || '未知'} 不允许 /api/send/*` };
    }
    if (status?.socialV2Paused === true) return { ok: false, channel: 'bridge', error: '桥接已暂停，拒绝发送' };
    let agentToken = '';
    if (mode === 'reserved2') {
      const social = readJsonFile(path.join(qqBridgeDir, 'state', 'social-v2.json'));
      agentToken = String(social?.data?.conversations?.[`private:${ownerQQ}`]?.agentToken ?? '').trim();
      if (!agentToken) {
        return { ok: false, channel: 'bridge', error: 'reserved2 模式需要会话 agent token，但 social-v2.json 里没有（AI 可能已重启）' };
      }
    }
    const body = { userId: ownerQQ, message, ...(agentToken ? { token: agentToken } : {}) };
    const response = await fetchImpl(`${base}/api/send/private`, {
      method: 'POST',
      headers: { 'x-console-token': consoleToken, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }
    const ok = response.ok && json?.ok === true;
    return {
      ok,
      channel: 'bridge',
      status: response.status,
      mode,
      error: ok ? null : `控制台 /api/send/private HTTP ${response.status} ${json?.error ?? ''}`.trim()
    };
  } catch (error) {
    return { ok: false, channel: 'bridge', error: `桥接控制台发送失败：${error?.name ?? 'Error'} ${error?.message ?? error}` };
  }
}

async function sendWithChannels({ config, facts, message, fetchImpl, logger }) {
  const attempts = [];
  for (const channel of config.notifyOwner.channels) {
    const result =
      channel === 'snowluma'
        ? await sendSnowluma({ facts, message, config, fetchImpl })
        : await sendBridge({ facts, config, message, fetchImpl });
    attempts.push({ channel, ok: Boolean(result.ok), error: result.error ?? null, mode: result.mode ?? null });
    if (result.ok) {
      if (channel === 'bridge') {
        logger?.warn?.('[notify] 已通过桥接控制台发送：桥接会安排 replyCheck 唤醒，角色可能额外回一句');
      }
      return { ok: true, channel, attempts };
    }
    logger?.warn?.(`[notify] 通道 ${channel} 失败：${result.error}`);
  }
  return { ok: false, channel: null, attempts };
}

/**
 * 通知主人（同日一次）。失败不抛异常：返回 { ok:false, queued, error }。
 * dryRun 只返回将要发送的文本，不发请求。
 */
export async function notifyOwner({
  config,
  facts,
  logger = null,
  dateKey,
  summary,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  force = false
}) {
  const files = notifyFiles(config);
  if (!config.notifyOwner.enabled) {
    logger?.info?.('[notify] notifyOwner.enabled=false，跳过通知');
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  const message = buildNotifyMessage({ config, dateKey, summary });
  if (!force) {
    const state = readNotifyState(files.state);
    const previous = state.sent?.[dateKey];
    if (previous?.ok) {
      logger?.info?.(`[notify] ${dateKey} 已通知过（${previous.channel ?? '?'} @ ${previous.at ?? '?'}），同日不重复`);
      return { ok: true, skipped: true, reason: 'already-sent', message };
    }
  }
  if (dryRun) {
    logger?.info?.(`[notify] dry-run：将发送「${message}」`);
    return { ok: true, dryRun: true, skipped: true, message, channels: config.notifyOwner.channels };
  }

  const sent = await sendWithChannels({ config, facts, message, fetchImpl, logger });
  if (sent.ok) {
    markSent({ config, file: files.state, dateKey, channel: sent.channel, message, now, dryRun });
    logger?.info?.(`[notify] 已通过 ${sent.channel} 通知主人：${Array.from(message).length} 字`);
    return { ok: true, channel: sent.channel, message, attempts: sent.attempts };
  }

  // 全部通道失败 → 入队，等下次启动/下次写日记重试
  const queue = readNotifyQueue(files.queue);
  const existing = queue.entries.find((entry) => entry?.date === dateKey);
  const attempts = (Number(existing?.attempts) || 0) + 1;
  const errorText = sent.attempts.map((item) => `${item.channel}:${item.error}`).join(' | ').slice(0, 500);
  if (attempts >= config.notifyOwner.retryMax) {
    queue.entries = queue.entries.filter((entry) => entry?.date !== dateKey);
    writeNotifyQueue(files.queue, queue, { now, timeZone: config.timezone });
    logger?.error?.(`[notify] ${dateKey} 通知失败已达上限 ${config.notifyOwner.retryMax} 次，放弃：${errorText}`);
    return { ok: false, queued: false, dropped: true, message, attempts, error: errorText };
  }
  const entry = {
    date: dateKey,
    message,
    attempts,
    lastError: errorText,
    lastAttemptAt: isoWithOffset(now, config.timezone)
  };
  queue.entries = [...queue.entries.filter((item) => item?.date !== dateKey), entry];
  const written = writeNotifyQueue(files.queue, queue, { now, timeZone: config.timezone });
  logger?.warn?.(`[notify] ${dateKey} 通知失败（第 ${attempts}/${config.notifyOwner.retryMax} 次），已入队重试${written.ok ? '' : '（但队列写入失败）'}`);
  return { ok: false, queued: true, message, attempts, error: errorText };
}

/** 启动/写完日记后重试队列里的失败通知。 */
export async function flushNotifyQueue({ config, facts, logger = null, fetchImpl = globalThis.fetch, now = new Date() }) {
  if (!config.notifyOwner.enabled) return { ok: true, skipped: true, sent: 0, pending: 0 };
  const files = notifyFiles(config);
  const queue = readNotifyQueue(files.queue);
  if (!queue.entries.length) return { ok: true, sent: 0, pending: 0 };
  const remaining = [];
  let sentCount = 0;
  let dropped = 0;
  for (const entry of queue.entries) {
    if (!entry || typeof entry.date !== 'string' || typeof entry.message !== 'string') {
      dropped += 1;
      logger?.warn?.('[notify] 队列里有结构非法的条目，已丢弃');
      continue;
    }
    const state = readNotifyState(files.state);
    if (state.sent?.[entry.date]?.ok) {
      logger?.info?.(`[notify] 队列中的 ${entry.date} 已通知过，移出队列`);
      continue;
    }
    if ((Number(entry.attempts) || 0) >= config.notifyOwner.retryMax) {
      logger?.error?.(`[notify] 队列中的 ${entry.date} 已重试 ${entry.attempts} 次，放弃`);
      dropped += 1;
      continue;
    }
    const result = await sendWithChannels({ config, facts, message: entry.message, fetchImpl, logger });
    if (result.ok) {
      markSent({ config, file: files.state, dateKey: entry.date, channel: result.channel, message: entry.message, now });
      sentCount += 1;
      logger?.info?.(`[notify] 队列补偿发送成功：${entry.date} via ${result.channel}`);
      continue;
    }
    entry.attempts = (Number(entry.attempts) || 0) + 1;
    entry.lastError = result.attempts.map((item) => `${item.channel}:${item.error}`).join(' | ').slice(0, 500);
    entry.lastAttemptAt = isoWithOffset(now, config.timezone);
    if (entry.attempts >= config.notifyOwner.retryMax) {
      dropped += 1;
      logger?.error?.(`[notify] 队列中的 ${entry.date} 第 ${entry.attempts} 次失败，放弃：${entry.lastError}`);
      continue;
    }
    remaining.push(entry);
    logger?.warn?.(`[notify] 队列重试 ${entry.date} 仍失败（${entry.attempts}/${config.notifyOwner.retryMax}），继续排队`);
  }
  writeNotifyQueue(files.queue, { entries: remaining }, { now, timeZone: config.timezone });
  return { ok: true, sent: sentCount, pending: remaining.length, dropped };
}

/** --check 的只读探测：SnowLuma 登录信息 + 桥接控制台状态（不发任何消息）。 */
export async function probeChannels({ config, facts, fetchImpl = globalThis.fetch }) {
  const result = {
    snowluma: { ok: false, detail: '' },
    bridge: { ok: false, detail: '', mode: '', paused: null, agentToken: false }
  };
  const httpUrl = String(facts?.snowluma?.httpUrl ?? '').replace(/\/+$/, '');
  const accessToken = String(facts?.snowluma?.accessToken ?? '');
  if (httpUrl && accessToken) {
    try {
      const url = new URL(`${httpUrl}/get_login_info`);
      url.searchParams.set('access_token', accessToken);
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(config.notifyOwner.timeoutMs)
      });
      let json = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      const userId = Number(json?.data?.user_id);
      result.snowluma = {
        ok: response.ok && Number(json?.retcode) === 0 && Number.isFinite(userId),
        detail: response.ok && Number(json?.retcode) === 0 ? `已登录 QQ ${Number.isFinite(userId) ? userId : '?'}${json?.data?.nickname ? `（${json.data.nickname}）` : ''}` : `HTTP ${response.status} retcode=${json?.retcode ?? '?'}`,
        userId: Number.isFinite(userId) ? userId : null
      };
    } catch (error) {
      result.snowluma = { ok: false, detail: `探测失败：${error?.name ?? 'Error'} ${error?.message ?? error}` };
    }
  } else {
    result.snowluma = { ok: false, detail: 'qq-bridge 未配置 snowluma.httpUrl / accessToken' };
  }

  const consoleToken = readBridgeConsoleToken(config.qqBridgeDir);
  const base = `http://127.0.0.1:${Number(facts?.consolePort) || 3100}`;
  if (consoleToken) {
    try {
      const response = await fetchImpl(`${base}/api/status`, {
        headers: { 'x-console-token': consoleToken },
        signal: AbortSignal.timeout(config.notifyOwner.timeoutMs)
      });
      let json = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      const ownerQQ = Number(facts?.ownerQQ);
      let agentToken = false;
      if (Number.isFinite(ownerQQ) && ownerQQ > 0) {
        const social = readJsonFile(path.join(String(config.qqBridgeDir ?? ''), 'state', 'social-v2.json'));
        agentToken = Boolean(social?.data?.conversations?.[`private:${ownerQQ}`]?.agentToken);
      }
      result.bridge = {
        ok: response.ok,
        detail: response.ok ? `控制台可达，模式 ${json?.mode ?? '?'}，paused=${json?.socialV2Paused ?? '?'}` : `HTTP ${response.status}`,
        mode: String(json?.mode ?? ''),
        paused: json?.socialV2Paused ?? null,
        agentToken
      };
    } catch (error) {
      result.bridge = {
        ...result.bridge,
        ok: false,
        detail: `控制台不可达：${error?.name ?? 'Error'} ${error?.message ?? error}`
      };
    }
  } else {
    result.bridge = { ...result.bridge, ok: false, detail: '缺 state/console-token' };
  }
  return result;
}
