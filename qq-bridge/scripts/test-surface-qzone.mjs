// GEN3 表现面 S2 单测（设计 §7/§17.4/§17.8）：
// - H2 素材白名单：V3 空间上下文 0 群聊消息/0 群昵称/0 群号/0 他人私聊
// - 可见性默认公开回传；H4 状态机 unknown + reconcile 不重发；去重软降权；风格 lint 白名单
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildQzoneWriterContext, QZONE_SOURCE_NOTICE, toQzoneWriterContext } from '../src/surface/qzone-context.js';
import { lintQzoneText, describeLintForRetry, FORBIDDEN_PHRASES, SENSITIVE_TOPICS } from '../src/surface/qzone-lint.js';
import { createQzoneService, visibilityLabel } from '../src/qzone.js';

// ── qzone-context（H2 白名单）──

function fixtureConversation() {
  return new Map([
    ['group:111', { recentMessages: [{ sender: '群友甲', text: '群里的秘密聊天', time: 100 }], activeTopics: ['群话题A'] }],
    ['group:222', { recentMessages: [{ sender: '群友乙', text: '另一个群的原话', time: 101 }], activeTopics: ['群话题B'] }],
    ['group:333', { recentMessages: [{ sender: '群友丙', text: '第三个群的原话', time: 102 }], activeTopics: [] }],
    ['private:100001', {
      recentMessages: [
        { sender: '主人', text: '早上好呀', time: 200 },
        { sender: 'bot', text: '早上好！', time: 201 }
      ],
      activeTopics: ['旅行计划']
    }],
    ['private:200002', { recentMessages: [{ sender: '别人', text: '别人的私聊内容', time: 202 }], activeTopics: ['他人话题'] }]
  ]);
}

test('H2：V3 空间上下文 0 群聊/0 群昵称/0 群号/0 他人私聊（§17.8 素材白名单）', () => {
  const ctx = buildQzoneWriterContext({
    conversation: fixtureConversation(),
    ownerQQ: 100001,
    role: { personaText: '我是小助手' }
  });
  const blob = JSON.stringify(ctx);
  assert.ok(!blob.includes('群友'), '0 群昵称');
  assert.ok(!blob.includes('群里的秘密聊天'), '0 群聊原文');
  assert.ok(!blob.includes('群话题'), '0 群话题');
  assert.ok(!blob.includes('别人的私聊内容'), '0 他人私聊');
  assert.ok(!/group:\d+/.test(blob), '0 群号');
  assert.ok(ctx.recentText.includes('早上好呀'), '主人私聊正常');
  assert.ok(ctx.memoryText.includes('旅行计划'), '主人私聊话题进 memoryText');
  assert.equal(ctx.empty, false);
});

test('H2：没有主人私聊 → 空素材不硬凑；ownerQQ 未配置同样为空', () => {
  const empty = buildQzoneWriterContext({ conversation: new Map(), ownerQQ: 100001 });
  assert.equal(empty.recentText, '');
  assert.equal(empty.memoryText, '');
  assert.equal(empty.empty, true);
  const noOwner = buildQzoneWriterContext({ conversation: fixtureConversation(), ownerQQ: null });
  assert.equal(noOwner.recentText, '', '缺 owner 不拿任何会话凑');
});

test('toQzoneWriterContext 保留旧字段名；QZONE_SOURCE_NOTICE 声明素材边界', () => {
  const c = toQzoneWriterContext({ roleText: 'R', recentText: 'C', memoryText: 'M', materialText: 'MAT' });
  assert.deepEqual(c, { roleText: 'R', recentText: 'C', memoryText: 'M', materialText: 'MAT' });
  const noMat = toQzoneWriterContext({ roleText: 'R', recentText: '', memoryText: '' });
  assert.ok(!('materialText' in noMat), '无素材不带 materialText 字段');
  assert.match(QZONE_SOURCE_NOTICE, /只来自主人的私聊/);
});

// ── qzone-lint（四类硬信号）──

test('lintQzoneText：禁用短语/承诺句式/裸链接三类硬信号', () => {
  const bad = lintQzoneText('总的来说今天很开心，我保证明天一定更新 https://example.com/x');
  assert.equal(bad.flagged, true);
  assert.ok(bad.flags.includes('forbidden_phrase'));
  assert.ok(bad.flags.includes('promise'));
  assert.ok(bad.flags.includes('bare_link'));
  assert.equal(bad.sensitiveTopic, false);
  const clean = lintQzoneText('今天天气真好，出去走了走，买了杯奶茶。');
  assert.equal(clean.flagged, false);
  assert.equal(clean.sensitiveTopic, false);
});

test('lintQzoneText：敏感话题命中 → sensitiveTopic（跳过重写），哀悼/医疗/法律/灾难', () => {
  for (const text of ['愿逝者一路走好', '他确诊住院了', '案子开庭了', '地震灾害很严重']) {
    const r = lintQzoneText(text);
    assert.equal(r.sensitiveTopic, true, text);
    assert.ok(r.flags.includes('sensitive_topic'));
  }
  assert.ok(SENSITIVE_TOPICS.length >= 4);
  assert.ok(FORBIDDEN_PHRASES.length > 10);
});

test('describeLintForRetry：只给信号提示，不带原文全文', () => {
  const d = lintQzoneText('总的来说我保证明天一定 https://a.com');
  const hint = describeLintForRetry(d);
  assert.match(hint, /不要用这些词/);
  assert.match(hint, /承诺句式/);
  assert.match(hint, /裸链接/);
  assert.ok(!hint.includes('https://a.com'), '提示不带原文链接');
  assert.equal(describeLintForRetry(lintQzoneText('正常内容')), '');
});

// ── H4 状态机 + 回读（createQzoneService 级）──

function makeClock(start = Date.parse('2026-10-26T10:00:00Z')) {
  let current = start;
  return {
    now: () => current,
    advance(ms) { current += ms; },
    setTimer: () => ({ id: 1 }),
    clearTimer: () => {},
  };
}

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'surface-qzone-'));
}

function makeService({ clock = makeClock(), requestQzone, onPublished = null, onSurfaceEvent = null, softDedupeSources = null } = {}) {
  const stateDir = tmpState();
  return createQzoneService({
    root: tmpState(),
    stateDir,
    config: {
      enabled: true, defaultUgcRight: 1, maxPostsPerDay: 10, minIntervalMs: 0, draftTtlMinutes: 30,
      proactive: { enabled: false, maxPerDay: 3, quietHours: [] }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    requestQzone: requestQzone ?? (async (action, params) => {
      if (action === 'send_qzone_msg') return { tid: 'tid-1', time: Math.floor(clock.now() / 1000) };
      if (action === 'get_qzone_msg_list') return { total: 0, msglist: [] };
      return null;
    }),
    draftWithAgent: async () => '今天也是元气满满的一天。',
    notifyOwner: async () => {},
    isQqOnline: async () => true,
    log: () => {},
    activity: () => {},
    redact: (s) => String(s),
    onPublished, onSurfaceEvent, softDedupeSources,
  });
}

test('H4：发布后回读 verified/miss/unknown 三态 + miss 不重发 + 记忆回写带 verification', async () => {
  const clock = makeClock();
  const published = [];
  // verified：listPosts 对上 contentHash
  const verifiedSvc = makeService({
    clock,
    requestQzone: async (action, params) => {
      if (action === 'send_qzone_msg') return { tid: 'tid-v', time: Math.floor(clock.now() / 1000) };
      if (action === 'get_qzone_msg_list') return { total: 1, msglist: [{ tid: 'tid-v', content: '今天也是元气满满的一天。', time: 1 }] };
      return null;
    },
    onPublished: async (info) => published.push(info)
  });
  const draft = await verifiedSvc.createDraft({ content: '今天也是元气满满的一天。', source: 'manual' });
  const r = await verifiedSvc.publishDraft({ draftId: draft.draftId, confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.verification, 'verified');
  assert.equal(r.verified, true);
  assert.match(r.note, /已发布且已核实/);
  assert.equal(published.length, 1);
  assert.equal(published[0].verification, 'verified');

  // miss：listPosts 空 → 不重发（send 恰好 1 次），返回明说「未核实」
  let sends = 0;
  const missSvc = makeService({
    clock,
    requestQzone: async (action) => {
      if (action === 'send_qzone_msg') { sends += 1; return { tid: 'tid-m', time: 1 }; }
      return { total: 0, msglist: [] };
    }
  });
  const d2 = await missSvc.createDraft({ content: '另一条说说内容哦', source: 'manual' });
  const r2 = await missSvc.publishDraft({ draftId: d2.draftId, confirm: true });
  assert.equal(r2.ok, true);
  assert.equal(r2.verification, 'miss');
  assert.equal(r2.verified, false);
  assert.match(r2.note, /未核实/);
  assert.equal(sends, 1, 'miss 绝不重发');
});

test('H4：超时 → ok:false, state:unknown，媒体保留，0 次自动重发', async () => {
  const clock = makeClock();
  let sends = 0;
  const svc = makeService({
    clock,
    requestQzone: async (action) => {
      if (action === 'send_qzone_msg') { sends += 1; throw new Error('socket hang up'); }
      return { total: 0, msglist: [] };
    }
  });
  const draft = await svc.createDraft({ content: '超时测试的说说内容', source: 'manual', images: [] });
  const r = await svc.publishDraft({ draftId: draft.draftId, confirm: true });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unknown');
  assert.equal(r.code, 'QZONE_UNKNOWN_STATE');
  assert.equal(sends, 1, 'unknown 不重发');
  const st = svc.status();
  assert.equal(st.lastPublish.state, 'unknown');
  assert.ok(st.unknownCount >= 1, '控制台红点计数');
});

test('H4：reconcile 只读核对——对上转 published，对不上保持 unknown，绝不重发', async () => {
  const clock = makeClock();
  let sends = 0;
  let listContent = '';
  const svc = makeService({
    clock,
    requestQzone: async (action) => {
      if (action === 'send_qzone_msg') { sends += 1; throw new Error('ETIMEDOUT'); }
      return { total: 1, msglist: listContent ? [{ tid: 'tid-x', content: listContent, time: 1 }] : [] };
    }
  });
  const draft = await svc.createDraft({ content: '核对测试的说说内容呀', source: 'manual' });
  await svc.publishDraft({ draftId: draft.draftId, confirm: true }); // → unknown
  // 空列表 → 保持 unknown
  let rec = await svc.reconcilePublish();
  assert.equal(rec.state, 'unknown');
  assert.equal(rec.changed, false);
  // 列表里出现同内容 → 转 published（证据＝contentHash）
  listContent = '核对测试的说说内容呀';
  rec = await svc.reconcilePublish();
  assert.equal(rec.state, 'published');
  assert.equal(rec.changed, true);
  assert.equal(sends, 1, 'reconcile 全程 0 重发');
});

test('默认公开不变：ugcRight=1 → visibility「所有人可见（公开）」，返回值显式回传', async () => {
  const clock = makeClock();
  const svc = makeService({ clock });
  assert.equal(visibilityLabel(1), '所有人可见（公开）');
  const draft = await svc.createDraft({ content: '公开可见性测试内容哦', source: 'manual' });
  assert.equal(draft.ugcRight, 1);
  assert.match(draft.visibility, /^所有人可见/);
  const r = await svc.publishDraft({ draftId: draft.draftId, confirm: true });
  assert.equal(r.ugcRight, 1);
  assert.match(r.visibility, /^所有人可见/);
  assert.match(svc.status().defaultVisibility, /^所有人可见/);
});

test('去重软降权：与最近话题/日记高度重合 → 主动发布跳过本轮（soft_duplicate），手动不硬拦', async () => {
  const clock = makeClock();
  const stateDir = tmpState();
  const sends = [];
  const svc = createQzoneService({
    root: tmpState(), stateDir,
    config: {
      enabled: true, defaultUgcRight: 1, maxPostsPerDay: 10, minIntervalMs: 0, draftTtlMinutes: 30,
      proactive: { enabled: true, maxPerDay: 3, minIntervalMinutes: 240, maxIntervalMinutes: 480, quietHours: [], imageProbability: 0, maxImages: 0, maxChars: 300 }
    },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5,
    requestQzone: async (action, params) => {
      if (action === 'send_qzone_msg') { sends.push(params); return { tid: 't', time: 1 }; }
      return { total: 0, msglist: [] };
    },
    draftWithAgent: async () => '今天也是元气满满的一天。',
    notifyOwner: async () => {}, isQqOnline: async () => true, log: () => {}, activity: () => {},
    redact: (s) => String(s),
    softDedupeSources: async () => ['今天也是元气满满的一天'],
  });
  // 手动发布（内容与 tick 生成稿不同，避免硬去重干扰）：软重合不硬拦
  const draft = await svc.createDraft({ content: '晚上吃了火锅，好满足', source: 'manual' });
  const r = await svc.publishDraft({ draftId: draft.draftId, confirm: true });
  assert.equal(r.ok, true, '手动发布不硬拦');
  clock.advance(10 * 60_000); // 过掉 minIntervalMs 限流，专注测软降权
  // 主动发布 tick：软重合 → 跳过本轮不发送
  const tick = await svc.tick({ source: 'proactive' });
  assert.equal(tick.skipped, 'soft_duplicate');
  assert.equal(sends.length, 1, 'tick 未发送（只有手动那 1 次）');
});

test('风格复核钩子：stylePass 传入后 lint 命中触发重写（最多 1 次），敏感话题不改写', async () => {
  const clock = makeClock();
  let drafts = 0;
  const stateDir = tmpState();
  const svc = createQzoneService({
    root: tmpState(), stateDir,
    config: { enabled: true, defaultUgcRight: 1, maxPostsPerDay: 10, minIntervalMs: 0, proactive: { enabled: false } },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5,
    requestQzone: async (action) => (action === 'send_qzone_msg' ? { tid: 't', time: 1 } : { total: 0, msglist: [] }),
    draftWithAgent: async (args) => {
      drafts += 1;
      if (args?.styleRetry) return '今天出去走了走，心情不错。'; // 重写稿：无硬信号
      return '总的来说今天很开心。'; // 原稿：命中禁用短语
    },
    notifyOwner: async () => {}, isQqOnline: async () => true, log: () => {}, activity: () => {},
    redact: (s) => String(s),
    stylePass: true,
  });
  const draft = await svc.createDraft({ askAiToDraft: true, source: 'manual' });
  assert.equal(drafts, 2, '原稿 + 恰好 1 次重写');
  assert.equal(draft.content, '今天出去走了走，心情不错。', '采用重写稿');
  assert.ok(!draft.content.includes('总的来说'));

  // 敏感话题：lint 命中但不改写（原稿直发）
  let sensitiveDrafts = 0;
  const svc2 = createQzoneService({
    root: tmpState(), stateDir: tmpState(),
    config: { enabled: true, defaultUgcRight: 1, maxPostsPerDay: 10, minIntervalMs: 0, proactive: { enabled: false } },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5,
    requestQzone: async (action) => (action === 'send_qzone_msg' ? { tid: 't', time: 1 } : { total: 0, msglist: [] }),
    draftWithAgent: async () => { sensitiveDrafts += 1; return '愿逝者一路走好，节哀。'; },
    notifyOwner: async () => {}, isQqOnline: async () => true, log: () => {}, activity: () => {},
    redact: (s) => String(s),
    stylePass: true,
  });
  const s2 = await svc2.createDraft({ askAiToDraft: true, source: 'manual' });
  assert.equal(sensitiveDrafts, 1, '敏感话题不触发重写');
  assert.equal(s2.content, '愿逝者一路走好，节哀。');
});

test('proactiveApproval：只出草稿+通知带 draftId，0 次自动发送（§7.8 canary 观察期）', async () => {
  const clock = makeClock();
  const sends = [];
  const notes = [];
  const stateDir = tmpState();
  const svc = createQzoneService({
    root: tmpState(), stateDir,
    config: {
      enabled: true, defaultUgcRight: 1, maxPostsPerDay: 10, minIntervalMs: 0, draftTtlMinutes: 30,
      proactive: { enabled: true, maxPerDay: 3, minIntervalMinutes: 240, maxIntervalMinutes: 480, quietHours: [], imageProbability: 0, maxImages: 0, maxChars: 300 }
    },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5,
    requestQzone: async (action, params) => {
      if (action === 'send_qzone_msg') { sends.push(params); return { tid: 't', time: 1 }; }
      return { total: 0, msglist: [] };
    },
    draftWithAgent: async () => '待确认的主动发布内容哦',
    notifyOwner: async (text) => notes.push(text),
    isQqOnline: async () => true, log: () => {}, activity: () => {},
    redact: (s) => String(s),
    proactiveApproval: true,
  });
  const tick = await svc.tick({ source: 'proactive' });
  assert.equal(tick.pendingApproval, true);
  assert.ok(tick.draftId, '返回 draftId');
  assert.equal(sends.length, 0, '0 次自动发送');
  assert.ok(notes.some((n) => n.includes(tick.draftId) && n.includes('待确认')), '通知带 draftId');
});

test('§17.4 门禁：手动发布间隔（manual_gap）与话题时间窗（skipIfTopicRecentHours）', async () => {
  const clock = makeClock();
  const sends = [];
  const requestQzone = async (action, params) => {
    if (action === 'send_qzone_msg') { sends.push(params); return { tid: 't', time: Math.floor(clock.now() / 1000) }; }
    return { total: 0, msglist: [] };
  };
  const stateDir = tmpState();
  const svc = createQzoneService({
    root: tmpState(), stateDir,
    config: {
      enabled: true, defaultUgcRight: 1, maxPostsPerDay: 10, minIntervalMs: 0, draftTtlMinutes: 30,
      proactive: { enabled: true, maxPerDay: 3, minIntervalMinutes: 240, maxIntervalMinutes: 480, quietHours: [], imageProbability: 0, maxImages: 0, maxChars: 300 }
    },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5,
    requestQzone,
    draftWithAgent: async () => '今天出去玩了一趟很开心',
    notifyOwner: async () => {}, isQqOnline: async () => true, log: () => {}, activity: () => {},
    redact: (s) => String(s),
    minGapAfterManualPostMs: 2 * 3600_000,
    skipIfTopicRecentHours: 6,
    softDedupeSources: async () => [{ text: '今天出去玩了一趟很开心', at: clock.now() }]
  });
  // 主人刚手动发过 → manual_gap 跳过
  const draft = await svc.createDraft({ content: '主人自己发的说说内容', source: 'manual' });
  await svc.publishDraft({ draftId: draft.draftId, confirm: true });
  clock.advance(10 * 60_000);
  const tick1 = await svc.tick({ source: 'proactive' });
  assert.equal(tick1.skipped, 'manual_gap', '手动发布间隔内不发');
  // 间隔过了但话题还在 6h 窗口内 → soft_duplicate 降权
  clock.advance(3 * 3600_000);
  const tick2 = await svc.tick({ source: 'proactive' });
  assert.equal(tick2.skipped, 'soft_duplicate', '话题窗口内回避');
  assert.equal(sends.length, 1, '全程只有手动那 1 次发送');
});

test('§17.4 图片策略：webImages=false 时绝不走网络搜图（只用本机/主人图）', async () => {
  const clock = makeClock();
  let webSearchCalls = 0;
  const fakeImageSearch = {
    listRecentCandidates: () => { webSearchCalls += 1; return [{ searchId: 's', candidateId: 1 }]; },
    search: async () => { webSearchCalls += 1; return { searchId: 's', candidates: [{ candidateId: 1 }] }; },
    prepareSend: async () => ({ selected: [{ buffer: Buffer.from('img') }] })
  };
  const stateDir = tmpState();
  const svc = createQzoneService({
    root: tmpState(), stateDir,
    config: {
      enabled: true, defaultUgcRight: 1, maxPostsPerDay: 10, minIntervalMs: 0, draftTtlMinutes: 30,
      proactive: {
        enabled: true, maxPerDay: 3, minIntervalMinutes: 240, maxIntervalMinutes: 480,
        quietHours: [], imageProbability: 1, maxImages: 3, maxChars: 300,
        useRecentSearchCache: true, searchImagesFromWeb: true
      }
    },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, random: () => 0.5,
    requestQzone: async (action) => (action === 'send_qzone_msg' ? { tid: 't', time: 1 } : { total: 0, msglist: [] }),
    draftWithAgent: async () => '配图策略测试内容哦',
    notifyOwner: async () => {}, isQqOnline: async () => true, log: () => {}, activity: () => {},
    redact: (s) => String(s),
    imageSearch: fakeImageSearch,
    webImages: false,
  });
  const tick = await svc.tick({ source: 'proactive', dryRun: true });
  assert.equal(tick.images, 0, 'webImages=false 时无网络图');
  assert.equal(webSearchCalls, 0, '网络搜图 0 次调用');
});
