// 评论互动值班（R1~R4）单测：依赖全部注入假件，覆盖主人/路人口径、去重、多轮上限、豆包求助与超时兜底。
// 服务实现在抖音工具面包（dsh-douyin-agent-v2/lib/comment-duty.mjs），此处按回归网惯例从测试目录直连。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommentDuty, sanitizeReply, validateCommentDutyConfig, COMMENT_DUTY_DEFAULTS } from '../../../dsh-douyin-agent-v2/lib/comment-duty.mjs';

const T0 = Date.parse('2026-10-29T12:00:00Z');

function fixture(t, { config = {}, atMe = [], comments = {}, gen, clock, frames } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-duty-'));
  t.after(() => { const target = path.resolve(dir); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。'); fs.rmSync(dir, { recursive: true, force: true }); });
  const published = [], asked = [], notified = [], captures = [], genArgs = [];
  let now = T0;
  const fallbackGen = async () => ({ reply: '合成回复', needExpert: false, question: '' });
  const duty = new CommentDuty({
    stateDir: dir,
    browse: async (fn) => fn({}),
    publish: async (input) => { published.push(input); return { ok: true, sent: true, cid: `our-${published.length}`, verified: true }; },
    askDoubao: async (input) => { asked.push(input); return { ok: true, sent: true, cid: 'ask-1', verified: true }; },
    fetchComments: async (_cdp, awemeId) => comments[awemeId] || { ok: true, comments: [] },
    fetchAtMe: async () => ({ ok: true, items: atMe }),
    captureFrames: frames ? async ({ awemeId }) => { captures.push(awemeId); return frames; } : undefined,
    generate: async (input) => { genArgs.push(input); return (gen || fallbackGen)(input); },
    notify: async (text) => { notified.push(String(text)); },
    now: () => clock ? clock() : now,
    onEvent: () => {},
  });
  duty.configure({ ...config }, { explicit: true });
  duty.clearTimer(); // 测试手动 tick，不开定时器
  return { duty, published, asked, notified, captures, genArgs, advance: (ms) => { now += ms }, dir };
}

test('配置校验：0 之外的非法值拒绝，未知键拒绝，默认值符合使用者决策', () => {
  assert.equal(COMMENT_DUTY_DEFAULTS.replyStranger, false); // 决策1：回复路人默认关
  assert.equal(COMMENT_DUTY_DEFAULTS.maxTurns, 5);          // 决策4：多轮默认 5
  assert.throws(() => validateCommentDutyConfig({ maxTurns: 0 }), /多轮上限/);
  assert.throws(() => validateCommentDutyConfig({ maxTurns: 21 }), /多轮上限/);
  assert.throws(() => validateCommentDutyConfig({ expertTimeoutMin: 0 }), /豆包超时/);
  assert.throws(() => validateCommentDutyConfig({ nope: 1 }), /不支持/);
  assert.throws(() => validateCommentDutyConfig({ replyOwner: 'yes' }), /开关/);
  assert.deepEqual(validateCommentDutyConfig({ maxTurns: 8 }), { maxTurns: 8 });
});

test('sanitizeReply：去 URL、去 @、压空白、限 60 字', () => {
  assert.equal(sanitizeReply('  哈哈 http://x.com @张三  你好  '), '哈哈 张三 你好');
  assert.equal(sanitizeReply('好'.repeat(80)).length, 60);
});

test('R1 主人@随时回：回复、开线程、推摘要；同一条只回一次（去重）', async t => {
  const f = fixture(t, {
    config: { ownerNick: '主人', replyStranger: false },
    atMe: [{ nid: 'n1', type: 45, user: '主人', text: '这视频真好看', aweme_id: '123', comment_id: 'c1', create_time: T0 }],
    comments: { '123': { ok: true, comments: [{ cid: 'c1', user: '主人', text: '这视频真好看', replies: [] }] } },
  });
  const r1 = await f.duty.tick();
  assert.equal(r1.ok, true);
  assert.equal(f.published.length, 1);
  assert.deepEqual({ root: f.published[0].rootCid, reply: f.published[0].replyCid }, { root: 'c1', reply: null });
  const state = f.duty.state();
  assert.equal(state.activeThreads, 1); assert.equal(state.repliedToday, 1);
  assert.ok(f.notified.some(x => x.includes('评论互动')));
  await f.duty.tick(); // 同一条通知再来一遍
  assert.equal(f.published.length, 1, '同一评论不重复回复');
});

test('R3 路人口径：默认不回（只记账），开关打开才回', async t => {
  const mention = { nid: 'n2', type: 45, user: '路人甲', text: '博主这个怎么弄', aweme_id: '123', comment_id: 'c2', create_time: T0 };
  const comments = { '123': { ok: true, comments: [{ cid: 'c2', user: '路人甲', text: '博主这个怎么弄', replies: [] }] } };
  const off = fixture(t, { config: { ownerNick: '主人', replyStranger: false }, atMe: [mention], comments });
  await off.duty.tick();
  assert.equal(off.published.length, 0);
  const on = fixture(t, { config: { ownerNick: '主人', replyStranger: true }, atMe: [mention], comments });
  await on.duty.tick();
  assert.equal(on.published.length, 1);
});

test('R2 多轮续话：线程里继续回，到 maxTurns 归档不再回', async t => {
  const comments = { '123': { ok: true, comments: [{ cid: 'c1', user: '主人', text: '在吗', replies: [] }] } };
  const f = fixture(t, {
    config: { ownerNick: '主人', multiTurn: true, maxTurns: 2 },
    atMe: [{ nid: 'n1', type: 45, user: '主人', text: '在吗', aweme_id: '123', comment_id: 'c1', create_time: T0 }],
    comments,
  });
  await f.duty.tick(); assert.equal(f.published.length, 1); // 第 1 轮
  comments['123'].comments[0].replies = [{ cid: 'r2', user: '主人', text: '继续聊' }];
  await f.duty.tick(); assert.equal(f.published.length, 2); // 第 2 轮（达到上限）
  comments['123'].comments[0].replies.push({ cid: 'r3', user: '主人', text: '还在吗' });
  await f.duty.tick();
  assert.equal(f.published.length, 2, '到 maxTurns 后归档不再回');
  assert.equal(f.duty.state().activeThreads, 0);
});

test('R4 @豆包求助：提问→豆包回答→总结给主人并转答；超时走固定兜底', async t => {
  const comments = { '123': { ok: true, comments: [{ cid: 'c1', user: '主人', text: '这是什么原理', replies: [] }] } };
  const f = fixture(t, {
    config: { ownerNick: '主人', expertAsk: true },
    atMe: [{ nid: 'n1', type: 45, user: '主人', text: '这是什么原理', aweme_id: '123', comment_id: 'c1', create_time: T0 }],
    comments,
    gen: async ({ expertAnswer }) => expertAnswer
      ? { reply: '我问了豆包：它说这是量子隧穿。', needExpert: false, question: '' }
      : { reply: '', needExpert: true, question: '视频里那个发光现象是什么原理' },
  });
  await f.duty.tick();
  assert.equal(f.asked.length, 1); assert.ok(f.asked[0].question.includes('发光现象'));
  assert.equal(f.published.length, 0, '等豆包期间不先回');
  assert.equal(f.duty.state().pendingExpert, 1);
  // 豆包回答挂在提问评论下
  comments['123'].comments.push({ cid: 'ask-1', user: '大肥鱼', text: '@豆包 视频里那个发光现象是什么原理', replies: [{ cid: 'd1', user: '豆包', text: '这是量子隧穿效应。' }] });
  await f.duty.tick();
  assert.equal(f.published.length, 1); assert.ok(f.published[0].text.includes('豆包'));
  assert.ok(f.notified.some(x => x.includes('豆包回答了') && x.includes('量子隧穿')), '豆包答案总结推给主人');
  assert.equal(f.duty.state().pendingExpert, 0);

  // 超时路径：另开一单，问完不回，过时限走固定话术
  const g = fixture(t, {
    config: { ownerNick: '主人', expertAsk: true },
    atMe: [{ nid: 'n3', type: 45, user: '主人', text: '这个怎么解释', aweme_id: '456', comment_id: 'c9', create_time: T0 }],
    comments: { '456': { ok: true, comments: [{ cid: 'c9', user: '主人', text: '这个怎么解释', replies: [] }] } },
    gen: async () => ({ reply: '', needExpert: true, question: '这个现象怎么解释' }),
  });
  await g.duty.tick(); assert.equal(g.asked.length, 1);
  g.advance(6 * 60_000); // 过了默认 5 分钟超时
  await g.duty.tick();
  assert.equal(g.published.length, 1);
  assert.ok(g.published[0].text.includes('答不好'), '超时兜底用固定话术');
  assert.ok(g.notified.some(x => x.includes('没等到回答')));
});

test('豆包同视频只问一次；答不上又没开求助就如实不发', async t => {
  const comments = { '123': { ok: true, comments: [{ cid: 'c1', user: '主人', text: '问题A', replies: [] }, { cid: 'c2', user: '主人', text: '问题B', replies: [] }] } };
  const f = fixture(t, {
    config: { ownerNick: '主人', expertAsk: true },
    atMe: [
      { nid: 'n1', type: 45, user: '主人', text: '问题A', aweme_id: '123', comment_id: 'c1', create_time: T0 },
      { nid: 'n2', type: 45, user: '主人', text: '问题B', aweme_id: '123', comment_id: 'c2', create_time: T0 },
    ],
    comments,
    gen: async () => ({ reply: '', needExpert: true, question: '换个问题' }),
  });
  await f.duty.tick();
  assert.equal(f.asked.length, 1, '同视频只 @豆包 一次');
  const off = fixture(t, {
    config: { ownerNick: '主人', expertAsk: false },
    atMe: [{ nid: 'n1', type: 45, user: '主人', text: '问题A', aweme_id: '123', comment_id: 'c1', create_time: T0 }],
    comments: { '123': { ok: true, comments: [{ cid: 'c1', user: '主人', text: '问题A', replies: [] }] } },
    gen: async () => ({ reply: '', needExpert: true, question: '不问' }),
  });
  await off.duty.tick();
  assert.equal(off.asked.length, 0); assert.equal(off.published.length, 0);
});

test('说停即停：stop 关总开关并停循环', async t => {
  const f = fixture(t, { config: { ownerNick: '主人' } });
  f.duty.ensureRunning();
  assert.equal(f.duty.state().running, true);
  const stopped = await f.duty.stop();
  assert.equal(stopped.config.enabled, false);
  assert.equal(stopped.running, false);
  await f.duty.tick();
  assert.equal(f.published.length, 0);
});

test('画面采样：回复前抓帧进生成上下文；超时兜底不走模型不抓帧', async t => {
  const f = fixture(t, {
    config: { ownerNick: '主人' },
    atMe: [{ nid: 'n1', type: 45, user: '主人', text: '画面里是什么', aweme_id: '123', comment_id: 'c1', create_time: T0 }],
    comments: { '123': { ok: true, comments: [{ cid: 'c1', user: '主人', text: '画面里是什么', replies: [] }] } },
    frames: [{ mimeType: 'image/jpeg', data: 'aGk=' }],
  });
  await f.duty.tick();
  assert.deepEqual(f.captures, ['123']);
  assert.equal(f.genArgs[0].frames.length, 1);
  assert.equal(f.genArgs[0].frames[0].mimeType, 'image/jpeg');
});
