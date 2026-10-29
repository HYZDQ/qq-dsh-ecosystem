#!/usr/bin/env node
// QQ 空间/说说离线测试。
//
// 不联网、不发真实说说、不启动 DSH/OneBot：
// - 用 mock requestQzone 记录 send_qzone_msg / delete_qzone_msg 调用；
// - 用假时钟 / 假定时器测试主动调度器；
// - 用临时目录测试草稿、白名单图片、state 持久化。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  QZONE_UGC_RIGHTS,
  auditQzoneText,
  createQzoneService,
  isQuietHours,
  normalizeQzoneConfig,
  readLocalImage,
  textSimilarity,
} from '../src/qzone.js';
import { collectKnownMemberNames, lintMemberNames } from '../src/surface/qzone-lint.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=',
  'base64'
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-qzone-test-'));
const stateDir = path.join(tempRoot, 'state');
const imageDir = path.join(tempRoot, 'images');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(imageDir, { recursive: true });
fs.writeFileSync(path.join(imageDir, 'one.png'), PNG_1X1);
fs.writeFileSync(path.join(tempRoot, 'outside.png'), PNG_1X1);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error?.stack ?? error?.message ?? error}`);
  }
}

function makeClock(start = new Date('2026-10-22T12:00:00+08:00').getTime()) {
  let current = start;
  const timers = new Map();
  let seq = 1;
  return {
    now: () => current,
    setTimer: (fn, ms) => {
      const id = seq++;
      timers.set(id, { at: current + Math.max(0, Number(ms) || 0), fn });
      return { id, unref() {} };
    },
    clearTimer: (handle) => {
      if (handle && typeof handle === 'object') timers.delete(handle.id);
    },
    advance(ms) {
      current += Math.max(0, Number(ms) || 0);
      const due = [...timers.entries()].filter(([, t]) => t.at <= current).sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        timers.delete(id);
        t.fn();
      }
    },
    timers,
    setNow(value) { current = value; },
  };
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    localImageDirs: [imageDir],
    minIntervalMs: 60_000,
    maxPostsPerDay: 10,
    draftTtlMinutes: 30,
    maxImages: 9,
    maxImageBytes: 8 * 1024 * 1024,
    maxTotalImageBytes: 16 * 1024 * 1024,
    proactive: {
      enabled: true,
      minIntervalMinutes: 240,
      maxIntervalMinutes: 480,
      maxPerDay: 3,
      maxChars: 300,
      quietHours: [],
      imageProbability: 0,
      maxImages: 0,
      useRecentSearchCache: false,
      notifyOwner: true,
    },
    ...overrides,
  };
}

function makeService({ config = baseConfig(), clock = makeClock(), requestQzone, draftWithAgent, imageSearch = null, ...serviceOptions } = {}) {
  const calls = [];
  const notifications = [];
  const activity = [];
  const service = createQzoneService({
    root: tempRoot,
    stateDir,
    config,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    requestQzone: requestQzone ?? (async (action, params) => {
      calls.push({ action, params });
      if (action === 'send_qzone_msg') return { tid: `tid-${calls.length}`, time: Math.floor(clock.now() / 1000) };
      if (action === 'get_qzone_msg_list') return { total: 0, msglist: [] };
      if (action === 'delete_qzone_msg') return null;
      throw new Error(`unexpected action ${action}`);
    }),
    imageSearch,
    draftWithAgent: draftWithAgent ?? (async () => '今天天气不错，出去走走。'),
    notifyOwner: async (text) => { notifications.push(text); },
    isQqOnline: async () => true,
    activity: (line) => activity.push(line),
    log: () => {},
    knownTokens: ['known-agent-token'],
    redact: (s) => String(s),
    ...serviceOptions,
  });
  return { service, calls, notifications, activity, clock };
}

function cleanState() {
  for (const name of fs.readdirSync(stateDir)) {
    if (name === 'qzone.json' || name === 'qzone-media') {
      fs.rmSync(path.join(stateDir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}

try {
  await test('配置收敛：默认值、越界值、非法图片目录', () => {
    const { config, warnings } = normalizeQzoneConfig({
      enabled: true,
      defaultUgcRight: 32,
      allowedUgcRights: [1, 64, 999],
      maxContentChars: 99999,
      localImageDirs: ['relative/path', imageDir],
      proactive: { minIntervalMinutes: 600, maxIntervalMinutes: 60, maxChars: 1 },
    }, { root: tempRoot });
    assert.equal(config.enabled, true);
    assert.equal(config.defaultUgcRight, 1);
    assert.deepEqual(config.allowedUgcRights, [1, 64]);
    assert.equal(config.maxContentChars, 5000);
    assert.deepEqual(config.localImageDirs, [imageDir]);
    assert.equal(config.proactive.minIntervalMinutes, 60);
    assert.equal(config.proactive.maxIntervalMinutes, 600);
    assert.equal(config.proactive.maxChars, 20);
    assert.ok(warnings.length >= 4);
    assert.ok(QZONE_UGC_RIGHTS.includes(64));
  });

  await test('正文审计：敏感信息/手机号/邮箱/路径/已知 token 拒绝', () => {
    assert.equal(auditQzoneText('今天天气不错').ok, true);
    assert.equal(auditQzoneText('C:\\Users\\Administrator\\secret.txt').ok, false);
    assert.equal(auditQzoneText('联系我 13800138000').ok, false);
    assert.equal(auditQzoneText('发到 test@example.com').ok, false);
    assert.equal(auditQzoneText('内网 192.168.1.2').ok, false);
    assert.equal(auditQzoneText('token=abcdef123').ok, false);
    assert.equal(auditQzoneText('known-agent-token', { knownTokens: ['known-agent-token'] }).ok, false);
  });

  await test('去重相似度与静默时段', () => {
    assert.ok(textSimilarity('今天天气不错，出去走走', '今天天气不错，出去散步') > 0.5);
    assert.ok(textSimilarity('今天天气不错', '完全不同的一句话') < 0.85);
    assert.equal(isQuietHours(new Date('2026-10-22T02:00:00+08:00').getTime(), ['00:00-08:00']), true);
    assert.equal(isQuietHours(new Date('2026-10-22T09:00:00+08:00').getTime(), ['00:00-08:00']), false);
    assert.equal(isQuietHours(new Date('2026-10-22T23:00:00+08:00').getTime(), ['22:00-02:00']), true);
  });

  await test('本机图片：白名单内通过，白名单外/穿越/符号链接拒绝', () => {
    const good = readLocalImage({ file: path.join(imageDir, 'one.png'), dirs: [imageDir], maxBytes: 1024 * 1024 });
    assert.equal(good.mime, 'image/png');
    assert.throws(() => readLocalImage({ file: path.join(tempRoot, 'outside.png'), dirs: [imageDir], maxBytes: 1024 * 1024 }), /白名单/);
    assert.throws(() => readLocalImage({ file: path.join(imageDir, '..', 'outside.png'), dirs: [imageDir], maxBytes: 1024 * 1024 }), /白名单/);
    const link = path.join(imageDir, 'link.png');
    try {
      fs.symlinkSync(path.join(imageDir, 'one.png'), link);
      assert.throws(() => readLocalImage({ file: link, dirs: [imageDir], maxBytes: 1024 * 1024 }), /符号链接/);
    } catch (error) {
      if (!/EPERM|EACCES|privilege|不支持的/i.test(String(error?.message ?? error))) throw error;
      console.log('SKIP 符号链接测试（当前 Windows 权限不允许创建 symlink）');
    }
  });

  await test('草稿 → 确认 → 发布 → 一次性；state 持久化', async () => {
    cleanState();
    const { service, calls, notifications } = makeService();
    const preview = await service.createDraft({ content: '今天天气不错，出去走走。', images: [path.join(imageDir, 'one.png')], ugcRight: 64 });
    assert.match(preview.draftId, /^[a-f0-9]{32}$/);
    assert.equal(preview.ugcRight, 64);
    assert.equal(preview.imageCount, 1);
    assert.equal(calls.length, 0);
    const result = await service.publishDraft({ draftId: preview.draftId, confirm: true });
    assert.equal(result.tid, 'tid-1');
    assert.equal(calls[0].action, 'send_qzone_msg');
    assert.equal(calls[0].params.ugc_right, 64);
    assert.match(calls[0].params.images[0], /^base64:\/\//);
    assert.ok(notifications.some((n) => n.includes('tid-1')));
    await assert.rejects(() => service.publishDraft({ draftId: preview.draftId, confirm: true }), /一次性/);
    const restarted = makeService().service;
    assert.equal(restarted.status().today.total, 1);
    assert.equal(restarted.status().inFlight, false);
  });

  await test('发布必须 confirm=true；过期/字数/可见范围校验', async () => {
    cleanState();
    const clock = makeClock();
    const { service } = makeService({ clock });
    const draft = await service.createDraft({ content: '测试草稿', ugcRight: 1 });
    await assert.rejects(() => service.publishDraft({ draftId: draft.draftId, confirm: false }), /confirm/);
    clock.advance(31 * 60_000);
    await assert.rejects(() => service.publishDraft({ draftId: draft.draftId, confirm: true }), /过期/);
    await assert.rejects(() => service.createDraft({ content: 'x'.repeat(1001) }), /超过上限/);
    await assert.rejects(() => service.createDraft({ content: '部分好友', ugcRight: 16 }), /targetUins/);
    await assert.rejects(() => service.createDraft({ content: '非法权限', ugcRight: 32 }), /不在允许集合/);
  });

  await test('敏感正文/图片数量/白名单外图片拒绝', async () => {
    cleanState();
    const { service } = makeService();
    await assert.rejects(() => service.createDraft({ content: 'C:\\Users\\x\\secret.txt' }), /敏感|拒绝/);
    await assert.rejects(() => service.createDraft({ content: '图太多', images: Array.from({ length: 10 }, () => path.join(imageDir, 'one.png')) }), /最多 9 张/);
    await assert.rejects(() => service.createDraft({ content: '白名单外', images: [path.join(tempRoot, 'outside.png')] }), /白名单/);
    await assert.rejects(() => service.createDraft({ content: '明文图', images: ['http://example.com/a.png'] }), /只允许 https/);
  });

  await test('AI 起草：失败/超长/空内容不生成草稿', async () => {
    cleanState();
    const failing = makeService({ draftWithAgent: async () => { throw new Error('writer timeout'); } }).service;
    await assert.rejects(() => failing.createDraft({ askAiToDraft: true }), /AI 起草失败/);
    const tooLong = makeService({ draftWithAgent: async () => '长'.repeat(1001) }).service;
    await assert.rejects(() => tooLong.createDraft({ askAiToDraft: true }), /超过/);
    const empty = makeService({ draftWithAgent: async () => '   ' }).service;
    await assert.rejects(() => empty.createDraft({ askAiToDraft: true }), /为空/);
  });

  await test('日记→空间（S4 §8.7）：开关默认关 + 他人名字检查 + 禁 AI 起草冒充摘录', async () => {
    cleanState();
    // 默认关：source='diary' 一律拒绝
    const off = makeService().service;
    await assert.rejects(
      () => off.createDraft({ content: '晚上煮了碗面，加了两个蛋，味道比想象中好。', source: 'diary' }),
      /未开启/
    );
    const on = makeService({ diaryShareEnabled: true, knownMemberNames: ['小明', '阿花'] }).service;
    // 即使主人要求：提到他人名字的摘录也要过 knownMemberNames 检查
    await assert.rejects(
      () => on.createDraft({ content: '小明晚上请我吃了碗面，味道比想象中好。', source: 'diary' }),
      /小明/
    );
    // AI 起草冒充摘录：拒绝
    await assert.rejects(() => on.createDraft({ source: 'diary', askAiToDraft: true }), /AI 起草/);
    // 干净摘录成草稿：draft.source='diary'；发布历史也记 diary
    const preview = await on.createDraft({ content: '晚上煮了碗面，加了两个蛋，味道比想象中好。', source: 'diary' });
    assert.equal(preview.source, 'diary');
    const result = await on.publishDraft({ draftId: preview.draftId, confirm: true });
    assert.equal(result.tid, 'tid-1');
    // 普通草稿不受他人名字检查影响（V2 行为不变）
    const manual = await on.createDraft({ content: '小明今天请我吃了碗面。' });
    assert.equal(manual.source, 'manual');
  });

  await test('他人名字收集与检查（qzone-lint）', () => {
    const conversations = new Map([
      ['group:30001', {
        recentMessages: [
          { text: 'hi', sender: '小明' },
          { text: 'hi', sender: '我', isSelf: true },
          { text: 'hi', sender: '主人', isOwner: true },
          { text: 'hi', sender: '群友' },
          { text: 'hi', sender: 'x' },
        ]
      }],
      ['private:10001', { recentMessages: [{ text: 'hi', sender: '主人', isOwner: true }] }],
    ]);
    const names = collectKnownMemberNames(conversations, { ownerQQ: 10001 });
    assert.deepEqual(names, ['小明']);
    assert.equal(lintMemberNames('今天和小明吃饭', names).ok, false);
    assert.equal(lintMemberNames('今天天气不错', names).ok, true);
    assert.equal(lintMemberNames('说明一下情况', ['明']).ok, true); // 单字名忽略
    assert.equal(lintMemberNames('今天和阿花聊天', ['小明', '阿花']).code, 'MEMBER_NAME');
  });

  await test('发布限流/每日上限/7 天去重', async () => {
    cleanState();
    const clock = makeClock();
    const { service } = makeService({ clock, config: baseConfig({ maxPostsPerDay: 2 }) });
    const first = await service.createDraft({ content: '第一条说说内容' });
    await service.publishDraft({ draftId: first.draftId, confirm: true });
    const second = await service.createDraft({ content: '第二条完全不同的说说' });
    await assert.rejects(() => service.publishDraft({ draftId: second.draftId, confirm: true }), /频繁/);
    clock.advance(61_000);
    await service.publishDraft({ draftId: second.draftId, confirm: true });
    const third = await service.createDraft({ content: '第三条内容' });
    await assert.rejects(() => service.publishDraft({ draftId: third.draftId, confirm: true }), /频繁|上限/);

    cleanState();
    const clock2 = makeClock();
    const { service: service2 } = makeService({ clock: clock2 });
    const a = await service2.createDraft({ content: '今天去公园散步，看到很多花。' });
    await service2.publishDraft({ draftId: a.draftId, confirm: true });
    clock2.advance(61_000);
    const b = await service2.createDraft({ content: '今天去公园散步，看到许多花。' });
    await assert.rejects(() => service2.publishDraft({ draftId: b.draftId, confirm: true }), /相同或近似/);
  });

  await test('主动发布：dry-run 不调用 send_qzone_msg；停用/静默/离线跳过', async () => {
    cleanState();
    const clock = makeClock();
    const { service, calls } = makeService({ clock, config: baseConfig({ proactive: { ...baseConfig().proactive, imageProbability: 0, quietHours: [] } }) });
    const dry = await service.tick({ dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.wouldPublish, true);
    assert.equal(calls.length, 0);

    service.setProactiveEnabled(false);
    const disabled = await service.tick({ dryRun: true });
    assert.equal(disabled.skipped, 'disabled');

    const quietClock = makeClock(new Date('2026-10-22T02:00:00+08:00').getTime());
    cleanState();
    const quietService = makeService({
      clock: quietClock,
      config: baseConfig({ proactive: { ...baseConfig().proactive, quietHours: ['00:00-08:00'] } }),
    }).service;
    const quiet = await quietService.tick({ dryRun: true });
    assert.equal(quiet.skipped, 'quiet');

    const offlineService = createQzoneService({
      root: tempRoot,
      stateDir,
      config: baseConfig({ proactive: { ...baseConfig().proactive, quietHours: [] } }),
      now: quietClock.now,
      setTimer: quietClock.setTimer,
      clearTimer: quietClock.clearTimer,
      requestQzone: async () => ({ tid: 'x' }),
      draftWithAgent: async () => '不想发',
      isQqOnline: async () => false,
      notifyOwner: async () => {},
      log: () => {},
    });
    const offline = await offlineService.tick({ dryRun: true });
    assert.equal(offline.skipped, 'offline');
  });

  await test('主动发布：成功写 tid/通知；失败不重试', async () => {
    cleanState();
    const clock = makeClock();
    let failOnce = true;
    const calls = [];
    const notifications = [];
    const service = createQzoneService({
      root: tempRoot,
      stateDir,
      config: baseConfig({ proactive: { ...baseConfig().proactive, quietHours: [], imageProbability: 0 } }),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      requestQzone: async (action, params) => {
        calls.push(action);
        if (failOnce) {
          failOnce = false;
          throw new Error('qzone publish failed: code=-10000');
        }
        if (action === 'get_qzone_msg_list') {
          // H4 发布后回读：列表里带同内容 → verification=verified
          return { total: 1, msglist: [{ tid: 'tid-proactive', content: '今天也好好生活。', time: Math.floor(clock.now() / 1000) }] };
        }
        return { tid: 'tid-proactive', time: Math.floor(clock.now() / 1000) };
      },
      draftWithAgent: async () => '今天也好好生活。',
      notifyOwner: async (text) => { notifications.push(text); },
      isQqOnline: async () => true,
      log: () => {},
    });
    const failed = await service.tick();
    assert.equal(failed.ok, false);
    assert.match(failed.error, /qzone publish failed/);
    assert.equal(calls.length, 1);
    assert.ok(notifications.some((n) => n.includes('失败')));
    const ok = await service.tick();
    assert.equal(ok.ok, true);
    assert.equal(ok.tid, 'tid-proactive');
    // H4：成功后多一次 get_qzone_msg_list 回读；失败不重试（send 恰好 2 次）
    assert.equal(calls.filter((a) => a === 'send_qzone_msg').length, 2);
    assert.equal(calls.filter((a) => a === 'get_qzone_msg_list').length, 1);
    assert.equal(ok.verified, true, '回读对上应 verified');
    assert.ok(notifications.some((n) => n.includes('tid-proactive')));
  });

  await test('主动调度器：start 设置定时器，停用清除，状态可持久化', async () => {
    cleanState();
    const clock = makeClock();
    const { service } = makeService({ clock });
    service.start();
    const first = service.status().proactive.nextRunAt;
    assert.ok(first > clock.now());
    assert.equal(clock.timers.size, 1);
    service.setProactiveEnabled(false);
    assert.equal(service.status().proactive.effective, false);
    assert.equal(clock.timers.size, 0);
    service.setProactiveEnabled(true);
    assert.equal(service.status().proactive.effective, true);
    assert.equal(clock.timers.size, 1);
    service.stop();
    assert.equal(clock.timers.size, 0);

    const configuredOff = makeService({
      clock: makeClock(),
      config: baseConfig({ proactive: { ...baseConfig().proactive, enabled: false } }),
    }).service;
    configuredOff.setProactiveEnabled(true);
    assert.equal(configuredOff.status().proactive.effective, true);
    configuredOff.stop();
  });

  await test('删除说说：confirm + tid 校验 + 状态记录', async () => {
    cleanState();
    const { service, calls, notifications } = makeService();
    await assert.rejects(() => service.deletePost({ tid: 'tid-x', confirm: false }), /confirm/);
    await assert.rejects(() => service.deletePost({ tid: '', confirm: true }), /tid/);
    const result = await service.deletePost({ tid: 'tid-x', confirm: true });
    assert.equal(result.tid, 'tid-x');
    assert.equal(calls[0].action, 'delete_qzone_msg');
    assert.ok(notifications.some((n) => n.includes('已删除')));
  });

  await test('config.example.json 的 qzone 出厂默认：关闭、公开、4~8 小时、每天 3 条', () => {
    const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    assert.equal(example.qzone.enabled, false);
    assert.equal(example.qzone.defaultUgcRight, 1);
    assert.deepEqual(example.qzone.allowedUgcRights, [1, 4, 16, 64, 128]);
    assert.deepEqual(example.qzone.localImageDirs, []);
    assert.equal(example.qzone.proactive.minIntervalMinutes, 240);
    assert.equal(example.qzone.proactive.maxIntervalMinutes, 480);
    assert.equal(example.qzone.proactive.maxPerDay, 3);
    assert.deepEqual(example.qzone.proactive.quietHours, []);
    assert.equal(example.qzone.proactive.notifyOwner, true);
    assert.equal(example.qzone.proactive.searchImagesFromWeb, true);
  });

  await test('图片检索缓存输入：searchId/candidateIds 走 prepareSend', async () => {
    cleanState();
    const imageSearch = {
      prepareSend: async ({ searchId, candidateIds }) => ({
        selected: [{
          candidateId: candidateIds[0],
          buffer: PNG_1X1,
          mimeType: 'image/png',
          ext: 'png',
          bytes: PNG_1X1.length,
          sha256: 'sha',
          source: 'fixture',
        }],
        failed: [],
        duplicates: [],
        truncated: false,
      }),
      listRecentCandidates: () => [],
    };
    const { service } = makeService({ imageSearch });
    const preview = await service.createDraft({ content: '带搜图', images: [{ searchId: 's1', candidateIds: [1] }] });
    assert.equal(preview.imageCount, 1);
  });

  await test('主动发布配图：无近期缓存/本机图时可联网检索', async () => {
    cleanState();
    const clock = makeClock();
    const searchQueries = [];
    const imageSearch = {
      listRecentCandidates: () => [],
      search: async ({ query }) => {
        searchQueries.push(query);
        return { searchId: 'live-search', candidates: [{ candidateId: 1 }, { candidateId: 2 }] };
      },
      prepareSend: async ({ candidateIds }) => ({
        selected: candidateIds.slice(0, 1).map((candidateId) => ({
          candidateId,
          buffer: PNG_1X1,
          mimeType: 'image/png',
          ext: 'png',
          bytes: PNG_1X1.length,
          sha256: 'fixture',
        })),
        failed: [],
        duplicates: [],
        truncated: false,
      }),
    };
    const { service } = makeService({
      clock,
      imageSearch,
      config: baseConfig({
        localImageDirs: [],
        proactive: { ...baseConfig().proactive, quietHours: [], imageProbability: 1, maxImages: 1 },
      }),
    });
    const result = await service.tick({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.images, 1);
    assert.equal(searchQueries.length, 1);
    assert.ok(searchQueries[0].length > 0);
  });

  await test('端点鉴权矩阵：owner 私聊/console 通过，群聊/无 token/敏感内容拒绝', async () => {
    const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
    const h = await bridgeHarness({
      config: {
        qzone: {
          enabled: true,
          proactive: { enabled: false },
          localImageDirs: [],
        },
      },
    });
    const qzoneCalls = [];
    h.bot.request = async (action, params) => {
      qzoneCalls.push({ action, params });
      if (action === 'send_qzone_msg') return { status: 'ok', retcode: 0, data: { tid: 'tid-endpoint', time: 1 } };
      if (action === 'get_qzone_msg_list') {
        return { status: 'ok', retcode: 0, data: { total: 1, msglist: [{ tid: 'tid-endpoint', content: 'x', time: 1, comment_num: 0, is_private: false, images: [] }] } };
      }
      if (action === 'delete_qzone_msg') return { status: 'ok', retcode: 0, data: null };
      return { status: 'ok', retcode: 0, data: null };
    };
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const postJson = (pathname, body, headers = {}) => new Promise((resolve, reject) => {
      const payload = JSON.stringify(body ?? {});
      const request = http.request({
        host: '127.0.0.1', port, path: pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          resolve({ status: response.statusCode, body: parsed });
        });
      });
      request.on('error', reject);
      request.setTimeout(8000, () => request.destroy(new Error(`request hung: ${pathname}`)));
      request.end(payload);
    });
    const getJson = (pathname, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, path: pathname, method: 'GET', headers,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          resolve({ status: response.statusCode, body: parsed });
        });
      });
      request.on('error', reject);
      request.setTimeout(8000, () => request.destroy(new Error(`request hung: ${pathname}`)));
      request.end();
    });
    const consoleHeaders = { 'x-console-token': 'fixture-console-token' };
    const agentHeaders = { ...consoleHeaders, 'x-agent-call': '1' };
    try {
      h.setMode('closed-agent');
      let response = await postJson('/api/socialV2/qzone/draft', { content: '端点测试正文', key: 'private:123' }, agentHeaders);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const draftId = response.body.draftId;
      assert.ok(draftId);

      response = await postJson('/api/socialV2/qzone/publish', { draftId, confirm: false, key: 'private:123' }, agentHeaders);
      assert.equal(response.status, 400);
      assert.equal(qzoneCalls.filter((c) => c.action === 'send_qzone_msg').length, 0);

      response = await postJson('/api/socialV2/qzone/publish', { draftId, confirm: true, key: 'private:123' }, agentHeaders);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.tid, 'tid-endpoint');
      assert.equal(qzoneCalls.filter((c) => c.action === 'send_qzone_msg').length, 1);

      response = await postJson('/api/socialV2/qzone/draft', { content: '群聊冒充', key: 'group:456' }, agentHeaders);
      assert.equal(response.status, 403);

      response = await postJson('/api/socialV2/qzone/draft', { content: 'C:\\Users\\x\\secret.txt', key: 'private:123' }, agentHeaders);
      assert.equal(response.status, 403);

      response = await getJson('/api/socialV2/qzone/status', agentHeaders);
      assert.equal(response.status, 200);
      assert.equal(response.body.status.enabled, true);

      response = await getJson('/api/socialV2/qzone/list?count=5', agentHeaders);
      assert.equal(response.status, 200);
      assert.equal(response.body.total, 1);

      response = await postJson('/api/socialV2/qzone/proactive', { enabled: false }, agentHeaders);
      assert.equal(response.status, 403);
      response = await postJson('/api/socialV2/qzone/proactive', { enabled: false }, consoleHeaders);
      assert.equal(response.status, 200);

      h.setMode('reserved2');
      response = await postJson('/api/socialV2/qzone/draft', { content: '无令牌', key: 'private:123' }, agentHeaders);
      assert.equal(response.status, 403);

      response = await postJson('/api/socialV2/qzone/draft', { content: '错误令牌', key: 'private:123' }, { ...agentHeaders, 'x-agent-token': 'wrong-token' });
      assert.equal(response.status, 403);

      const st = h.getSocialV2State('private:123');
      response = await postJson('/api/socialV2/qzone/draft', { content: '有效令牌草稿' }, { ...agentHeaders, 'x-agent-token': st.agentToken });
      assert.equal(response.status, 200, JSON.stringify(response.body));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    }
  });
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
