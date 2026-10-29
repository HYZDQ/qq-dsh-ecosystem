// notify.js：通知通道（snowluma 优先 / bridge 回退）、同日去重、失败入队与队列重试。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  notifyFiles,
  buildNotifyMessage,
  readNotifyState,
  writeNotifyState,
  readNotifyQueue,
  writeNotifyQueue,
  sendSnowluma,
  sendBridge,
  notifyOwner,
  flushNotifyQueue,
  probeChannels
} from '../src/notify.js';
import { addDays } from '../src/scheduler.js';
import {
  cleanupTempRoots,
  createProject,
  makeFetchMock,
  jsonResponse,
  writeJsonFile,
  writeTextFile,
  FIXED_NOW,
  FIXED_TODAY,
  OWNER_QQ,
  SNOWLUMA_TOKEN,
  CONSOLE_TOKEN,
  AGENT_TOKEN
} from './helpers.js';

after(cleanupTempRoots);

const DATE_KEY = FIXED_TODAY;

function notifyProject(configOverrides = {}, { agentToken = AGENT_TOKEN } = {}) {
  return createProject({
    config: {
      notifyOwner: {
        enabled: true,
        maxChars: 80,
        retryMax: 3,
        channels: ['snowluma', 'bridge'],
        timeoutMs: 5000
      },
      ...configOverrides
    },
    social: {
      paused: false,
      conversations: {
        [`private:${OWNER_QQ}`]: { recentMessages: [], ...(agentToken ? { agentToken } : {}) }
      }
    }
  });
}

function dispatchFetch({ snowlumaOk = true, mode = 'closed-agent', paused = false, bridgeOk = true, statusOk = true } = {}) {
  return makeFetchMock((record) => {
    const url = String(record.url);
    if (url.includes('/send_private_msg')) {
      return snowlumaOk
        ? jsonResponse({ retcode: 0, data: { message_id: 1 } })
        : jsonResponse({ retcode: 1200, msg: 'bad access token' });
    }
    if (url.endsWith('/api/status')) {
      return statusOk ? jsonResponse({ mode, socialV2Paused: paused }) : jsonResponse({ error: 'console down' }, 500);
    }
    if (url.endsWith('/api/send/private')) {
      return bridgeOk ? jsonResponse({ ok: true }) : jsonResponse({ ok: false, error: 'send failed' });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

const ownerArgs = (project, fetchImpl, extra = {}) => ({
  config: project.config,
  facts: project.facts,
  dateKey: DATE_KEY,
  summary: '今天和大家聊了会儿天。',
  fetchImpl,
  now: FIXED_NOW,
  ...extra
});

describe('buildNotifyMessage', () => {
  test('套模板、脱敏、截断到 maxChars', () => {
    const project = notifyProject({ notifyOwner: { enabled: true, maxChars: 80, retryMax: 3, channels: ['snowluma'], timeoutMs: 5000 } });
    const message = buildNotifyMessage({
      config: project.config,
      dateKey: DATE_KEY,
      summary: String.raw`文件在 C:\Users\x\a.txt 里，token: abc123`
    });
    assert.ok(message.includes(DATE_KEY));
    assert.ok(!message.includes('Users'), message);
    assert.ok(!message.includes('abc123'), message);
    assert.ok(message.includes('[路径]'), message);
    assert.ok(message.includes('[已隐藏]'), message);

    const shortProject = notifyProject({ notifyOwner: { enabled: true, maxChars: 30, retryMax: 3, channels: ['snowluma'], timeoutMs: 5000 } });
    const truncated = buildNotifyMessage({ config: shortProject.config, dateKey: DATE_KEY, summary: '很长'.repeat(100) });
    assert.ok(Array.from(truncated).length <= 30, `len=${Array.from(truncated).length}`);
  });
});

describe('notifyOwner：snowluma 优先 + 同日去重', () => {
  test('snowluma 成功 → ok:true，state 记录 date + ok + channel，只发一次请求', async () => {
    const project = notifyProject();
    const fetchMock = dispatchFetch();
    const result = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'snowluma');
    assert.equal(fetchMock.calls.length, 1);
    const url = String(fetchMock.calls[0].url);
    assert.ok(url.includes('/send_private_msg'), url);
    assert.ok(url.includes(`access_token=${SNOWLUMA_TOKEN}`), url);
    const body = JSON.parse(fetchMock.calls[0].options.body);
    assert.equal(body.user_id, OWNER_QQ);
    assert.ok(body.message.includes(DATE_KEY));

    const state = JSON.parse(fs.readFileSync(notifyFiles(project.config).state, 'utf8'));
    assert.equal(state.sent[DATE_KEY].ok, true);
    assert.equal(state.sent[DATE_KEY].channel, 'snowluma');
    assert.ok(state.sent[DATE_KEY].at);
    assert.ok(state.sent[DATE_KEY].chars > 0);
  });

  test('同日第二次 → skipped:true 且不再发请求', async () => {
    const project = notifyProject();
    const fetchMock = dispatchFetch();
    await notifyOwner(ownerArgs(project, fetchMock));
    const second = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already-sent');
    assert.equal(fetchMock.calls.length, 1);
  });

  test('enabled=false → 跳过且不发请求', async () => {
    const project = notifyProject({ notifyOwner: { enabled: false, maxChars: 80, retryMax: 3, channels: ['snowluma'], timeoutMs: 5000 } });
    const fetchMock = dispatchFetch();
    const result = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'disabled');
    assert.equal(fetchMock.calls.length, 0);
  });

  test('dryRun → 只返回文本，不发请求、不写 state', async () => {
    const project = notifyProject();
    const fetchMock = dispatchFetch();
    const result = await notifyOwner(ownerArgs(project, fetchMock, { dryRun: true }));
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.skipped, true);
    assert.ok(result.message.length > 0);
    assert.equal(fetchMock.calls.length, 0);
    assert.equal(fs.existsSync(notifyFiles(project.config).state), false);
  });
});

describe('notifyOwner：snowluma 失败 → bridge 回退', () => {
  test('先 GET /api/status 再 POST /api/send/private，都带 x-console-token', async () => {
    const project = notifyProject();
    const fetchMock = dispatchFetch({ snowlumaOk: false, mode: 'closed-agent' });
    const result = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'bridge');
    assert.equal(fetchMock.calls.length, 3);
    assert.ok(String(fetchMock.calls[0].url).includes('/send_private_msg'));

    const statusCall = fetchMock.calls[1];
    assert.ok(String(statusCall.url).endsWith('/api/status'), String(statusCall.url));
    assert.equal(statusCall.options.headers['x-console-token'], CONSOLE_TOKEN);

    const sendCall = fetchMock.calls[2];
    assert.ok(String(sendCall.url).endsWith('/api/send/private'), String(sendCall.url));
    assert.equal(sendCall.options.headers['x-console-token'], CONSOLE_TOKEN);
    const body = JSON.parse(sendCall.options.body);
    assert.equal(body.userId, OWNER_QQ);
    assert.ok(body.message.includes(DATE_KEY));

    const attempts = result.attempts.map((item) => item.channel);
    assert.deepEqual(attempts, ['snowluma', 'bridge']);
    const state = JSON.parse(fs.readFileSync(notifyFiles(project.config).state, 'utf8'));
    assert.equal(state.sent[DATE_KEY].channel, 'bridge');
  });

  test('reserved2 模式必须在 /api/send/private body 里带会话 agent token', async () => {
    const project = notifyProject();
    const fetchMock = dispatchFetch({ snowlumaOk: false, mode: 'reserved2' });
    const result = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(result.ok, true);
    assert.equal(result.channel, 'bridge');
    const body = JSON.parse(fetchMock.calls[2].options.body);
    assert.equal(body.token, AGENT_TOKEN);
  });

  test('bridge 在 mode=chat 时失败（不允许 /api/send/*）', async () => {
    const project = notifyProject();
    const fetchMock = dispatchFetch({ snowlumaOk: false, mode: 'chat' });
    const result = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(result.ok, false);
    assert.equal(result.queued, true);
    assert.match(String(result.error), /不允许/);
    // 只调用了 snowluma 与 status，没有 POST send
    assert.equal(fetchMock.calls.length, 2);
  });

  test('bridge 缺 console-token → 直接失败', async () => {
    const project = notifyProject({ notifyOwner: { enabled: true, maxChars: 80, retryMax: 3, channels: ['bridge'], timeoutMs: 5000 } });
    fs.rmSync(path.join(project.bridgeDir, 'state', 'console-token'), { force: true });
    const fetchMock = dispatchFetch({ mode: 'closed-agent' });
    const result = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(result.ok, false);
    assert.match(String(result.error), /console-token/);
    assert.equal(fetchMock.calls.length, 0);
  });
});

describe('notifyOwner：两通道都失败 → 入队', () => {
  test('入队 notify-queue.json，attempts 递增；达到 retryMax 后丢弃', async () => {
    const project = notifyProject();
    const fetchMock = dispatchFetch({ snowlumaOk: false, mode: 'chat' });
    const first = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(first.ok, false);
    assert.equal(first.queued, true);
    assert.equal(first.attempts, 1);
    const queueFile = notifyFiles(project.config).queue;
    const queued = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(queued.entries.length, 1);
    assert.equal(queued.entries[0].date, DATE_KEY);
    assert.equal(queued.entries[0].attempts, 1);
    assert.ok(queued.entries[0].lastError);
    assert.ok(queued.entries[0].lastAttemptAt);
    assert.equal(fs.existsSync(notifyFiles(project.config).state), false);

    const second = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(second.ok, false);
    assert.equal(second.attempts, 2);
    assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8')).entries[0].attempts, 2);

    // 第三次：到 retryMax=3 → 丢弃并移出队列
    const third = await notifyOwner(ownerArgs(project, fetchMock));
    assert.equal(third.ok, false);
    assert.equal(third.dropped, true);
    assert.equal(third.queued, false);
    assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8')).entries.length, 0);
  });
});

describe('flushNotifyQueue', () => {
  test('重试成功 → 移出队列并写 state', async () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    writeNotifyQueue(files.queue, { entries: [{ date: DATE_KEY, message: '补发的消息', attempts: 1 }] });
    const fetchMock = dispatchFetch();
    const result = await flushNotifyQueue({ config: project.config, facts: project.facts, fetchImpl: fetchMock, now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.equal(result.pending, 0);
    assert.equal(result.dropped, 0);
    assert.equal(readNotifyQueue(files.queue).entries.length, 0);
    const state = JSON.parse(fs.readFileSync(files.state, 'utf8'));
    assert.equal(state.sent[DATE_KEY].ok, true);
    assert.equal(fetchMock.calls.length, 1);
  });

  test('再次失败 → attempts 递增；达到 retryMax 丢弃且不抛', async () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    writeNotifyQueue(files.queue, { entries: [{ date: DATE_KEY, message: '补发的消息', attempts: 2 }] });
    const fetchMock = dispatchFetch({ snowlumaOk: false, mode: 'chat' });
    const result = await flushNotifyQueue({ config: project.config, facts: project.facts, fetchImpl: fetchMock, now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(result.sent, 0);
    assert.equal(result.dropped, 1);
    assert.equal(result.pending, 0);
    assert.equal(readNotifyQueue(files.queue).entries.length, 0);
  });

  test('未达 retryMax → 保留在队列并递增 attempts', async () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    writeNotifyQueue(files.queue, { entries: [{ date: DATE_KEY, message: '补发的消息', attempts: 1 }] });
    const fetchMock = dispatchFetch({ snowlumaOk: false, mode: 'chat' });
    const result = await flushNotifyQueue({ config: project.config, facts: project.facts, fetchImpl: fetchMock, now: FIXED_NOW });
    assert.equal(result.pending, 1);
    assert.equal(result.dropped, 0);
    const entries = readNotifyQueue(files.queue).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].attempts, 2);
    assert.ok(entries[0].lastError);
  });

  test('队列里的日期已通知过 → 直接移出，不再发请求', async () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    writeNotifyState(files.state, { sent: { [DATE_KEY]: { ok: true, at: 'x', channel: 'snowluma', chars: 10 } } });
    writeNotifyQueue(files.queue, { entries: [{ date: DATE_KEY, message: '重复', attempts: 1 }] });
    const fetchMock = dispatchFetch();
    const result = await flushNotifyQueue({ config: project.config, facts: project.facts, fetchImpl: fetchMock, now: FIXED_NOW });
    assert.equal(result.sent, 0);
    assert.equal(result.pending, 0);
    assert.equal(fetchMock.calls.length, 0);
    assert.equal(readNotifyQueue(files.queue).entries.length, 0);
  });

  test('enabled=false 时不处理队列', async () => {
    const project = notifyProject({ notifyOwner: { enabled: false, maxChars: 80, retryMax: 3, channels: ['snowluma'], timeoutMs: 5000 } });
    const files = notifyFiles(project.config);
    writeNotifyQueue(files.queue, { entries: [{ date: DATE_KEY, message: 'x', attempts: 1 }] });
    const fetchMock = dispatchFetch();
    const result = await flushNotifyQueue({ config: project.config, facts: project.facts, fetchImpl: fetchMock, now: FIXED_NOW });
    assert.equal(result.skipped, true);
    assert.equal(fetchMock.calls.length, 0);
  });

  test('结构非法条目计入 dropped 并 warn，其余条目照常处理', async () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    writeJsonFile(files.queue, {
      version: 1,
      entries: [{ bogus: true }, { date: DATE_KEY, message: '正常消息', attempts: 1 }]
    });
    const warns = [];
    const logger = { debug() {}, info() {}, warn: (message) => warns.push(String(message)), error() {} };
    const fetchMock = dispatchFetch();
    const result = await flushNotifyQueue({
      config: project.config,
      facts: project.facts,
      logger,
      fetchImpl: fetchMock,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.dropped, 1);
    assert.equal(result.sent, 1);
    assert.equal(result.pending, 0);
    assert.ok(warns.some((message) => message.includes('结构非法')), warns.join('|'));
    assert.equal(readNotifyQueue(files.queue).entries.length, 0);
  });
});

describe('state / queue 读写健壮性', () => {
  test('writeNotifyQueue 的 updatedAt 用注入 now + 时区（与 state 同格式）', () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    const write = writeNotifyQueue(files.queue, { entries: [] }, { now: FIXED_NOW, timeZone: 'Asia/Shanghai' });
    assert.equal(write.ok, true);
    const raw = JSON.parse(fs.readFileSync(files.queue, 'utf8'));
    assert.equal(raw.updatedAt, '2026-10-23T23:35:00+08:00');
    assert.match(raw.updatedAt, /\+08:00$/);
  });

  test('损坏或缺失时回退为空结构', () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    fs.mkdirSync(path.dirname(files.state), { recursive: true });
    writeTextFile(files.state, '{ broken');
    writeTextFile(files.queue, '[]');
    assert.deepEqual(readNotifyState(files.state), { version: 1, sent: {} });
    assert.deepEqual(readNotifyQueue(files.queue), { version: 1, entries: [] });
    assert.deepEqual(readNotifyState(path.join(project.root, 'nope.json')).sent, {});
  });

  test('writeNotifyState 保留最近 90 个日期', () => {
    const project = notifyProject();
    const files = notifyFiles(project.config);
    const sent = {};
    const dates = [];
    for (let index = 0; index < 100; index += 1) {
      const date = addDays('2026-01-01', index);
      dates.push(date);
      sent[date] = { ok: true };
    }
    writeNotifyState(files.state, { sent });
    const state = readNotifyState(files.state);
    assert.equal(Object.keys(state.sent).length, 90);
    assert.equal(state.sent[dates[dates.length - 1]].ok, true);
    assert.equal(state.sent[dates[0]], undefined);
    assert.equal(state.sent[dates[9]], undefined);
    assert.equal(state.sent[dates[10]].ok, true);
  });
});

describe('通道底层实现', () => {
  test('sendSnowluma：缺 httpUrl / ownerQQ / token 时明确失败', async () => {
    const project = notifyProject();
    const noUrl = await sendSnowluma({ facts: { ownerQQ: OWNER_QQ, snowluma: {} }, message: 'x', config: project.config, fetchImpl: dispatchFetch() });
    assert.equal(noUrl.ok, false);
    assert.match(noUrl.error, /httpUrl/);

    const noOwner = await sendSnowluma({
      facts: { ownerQQ: null, snowluma: { httpUrl: 'http://127.0.0.1:1', accessToken: 'x-token-123456' } },
      message: 'x',
      config: project.config,
      fetchImpl: dispatchFetch()
    });
    assert.equal(noOwner.ok, false);
    assert.match(noOwner.error, /ownerQQ/);

    const noToken = await sendSnowluma({
      facts: { ownerQQ: OWNER_QQ, snowluma: { httpUrl: 'http://127.0.0.1:1' } },
      message: 'x',
      config: project.config,
      fetchImpl: dispatchFetch()
    });
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /accessToken/);
  });

  test('probeChannels：只读探测 snowluma / bridge 状态', async () => {
    const project = notifyProject();
    const fetchMock = makeFetchMock((record) => {
      const url = String(record.url);
      if (url.includes('/get_login_info')) return jsonResponse({ retcode: 0, data: { user_id: OWNER_QQ, nickname: '小号' } });
      if (url.endsWith('/api/status')) return jsonResponse({ mode: 'reserved2', socialV2Paused: false });
      throw new Error(`unexpected ${url}`);
    });
    const channels = await probeChannels({ config: project.config, facts: project.facts, fetchImpl: fetchMock });
    assert.equal(channels.snowluma.ok, true);
    assert.ok(channels.snowluma.detail.includes(String(OWNER_QQ)));
    assert.equal(channels.bridge.ok, true);
    assert.equal(channels.bridge.mode, 'reserved2');
    assert.equal(channels.bridge.agentToken, true);
  });
});
