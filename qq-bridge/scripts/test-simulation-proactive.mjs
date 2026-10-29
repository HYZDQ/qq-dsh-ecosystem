// GEN3 2.2 主动性回归：作息（quiet hours）、interruptibility 五信号、打扰预算三闸/降频、
// 未尽话题抽取与跟进、trace 透传（与 pad 键共存）、bridge 接线契约。
// 公式与黄金值在这里钉死——它们就是 6.7 的行为规格（时间可注入、无隐藏随机、降频不归零）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  FRESH_WINDOW_MINUTES,
  FOLLOW_UP_FAMILIES,
  INTERRUPT_WEIGHTS,
  backoffFactor,
  belowThreshold,
  budgetState,
  checkBudget,
  consumeBudget,
  extractFollowUps,
  followUpDecision,
  interruptScore,
  markFollowed,
  noteUnanswered,
  quietDecision,
  rollDay
} from '../src/simulation/proactive.js';
import { socialV3Defaults } from '../src/simulation/config.js';
import { buildTurnRecord, createTurnRecorder } from '../src/simulation/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const HARNESS_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');

// bridge 里 proactive.js 的全部本地别名（漏一个 vm 套件就 ReferenceError）
const PROACTIVE_ALIASES = [
  'simQuietDecision',
  'simInterruptScore',
  'simBelowThreshold',
  'simBudgetState',
  'simCheckBudget',
  'simConsumeBudget',
  'simNoteUnanswered',
  'simBackoffFactor',
  'simExtractFollowUps',
  'simFollowUpDecision',
  'simMarkFollowed'
];

// ──────────────────────────── 常量 ────────────────────────────

test('常量黄金值：五信号权重、新鲜度窗口、四族关键词与到期时长', () => {
  assert.deepEqual(INTERRUPT_WEIGHTS, { peerActive: 0.3, groupFlow: 0.25, botFreshness: 0.2, topicAboutBot: 0.15, replyLatency: 0.1 });
  // 权重和必须为 1（分数才有 0~1 口径）
  const sum = Object.values(INTERRUPT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 1);
  assert.equal(FRESH_WINDOW_MINUTES, 30);
  assert.deepEqual(
    FOLLOW_UP_FAMILIES.map((f) => [f.topic, f.expiryHours]),
    [['promise', 12], ['exam', 24], ['sick', 8], ['travel', 24]],
    '承诺 12h、考试/出行 24h、生病 8h；顺序即平手裁决顺序'
  );
});

// ──────────────────────────── 作息（quiet hours）────────────────────────────

test('quietDecision 跨午夜（默认 23→8）各时点黄金值', () => {
  assert.deepEqual(quietDecision({ hour: 23, minute: 30 }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 0 }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 3, minute: 45 }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 7, minute: 59 }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 8, minute: 0 }), { quiet: false, reason: 'awake' });
  assert.deepEqual(quietDecision({ hour: 12 }), { quiet: false, reason: 'awake' });
  assert.deepEqual(quietDecision({ hour: 22, minute: 59 }), { quiet: false, reason: 'awake' });
});

test('quietDecision 例外豁免：atMe/privateChat/isOwner/explicitQuestion 任一为真 → reason=exception', () => {
  for (const flag of ['atMe', 'privateChat', 'isOwner', 'explicitQuestion']) {
    assert.deepEqual(
      quietDecision({ hour: 3, exceptions: { [flag]: true } }),
      { quiet: false, reason: 'exception' },
      `${flag} 例外必须豁免深夜`
    );
  }
  // 例外全假 / 空对象 / 不传 → 走正常作息判定
  assert.deepEqual(quietDecision({ hour: 3, exceptions: { atMe: false, isOwner: false } }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 3, exceptions: {} }), { quiet: true, reason: 'quiet-hours' });
  // 白天 + 例外：结论不变（白天本来就可主动），reason 仍为 exception
  assert.deepEqual(quietDecision({ hour: 12, exceptions: { atMe: true } }), { quiet: false, reason: 'exception' });
});

test('quietDecision 参数化区间：同日区间/跨午夜自定义/起止相同=无深夜区间', () => {
  // 同日区间 [13, 14)
  assert.deepEqual(quietDecision({ hour: 12, minute: 59, quietFrom: 13, quietTo: 14 }), { quiet: false, reason: 'awake' });
  assert.deepEqual(quietDecision({ hour: 13, quietFrom: 13, quietTo: 14 }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 14, quietFrom: 13, quietTo: 14 }), { quiet: false, reason: 'awake' });
  // 自定义跨午夜 [1, 5)
  assert.deepEqual(quietDecision({ hour: 0, quietFrom: 1, quietTo: 5 }), { quiet: false, reason: 'awake' });
  assert.deepEqual(quietDecision({ hour: 1, quietFrom: 1, quietTo: 5 }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 4, quietFrom: 1, quietTo: 5 }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 5, quietFrom: 1, quietTo: 5 }), { quiet: false, reason: 'awake' });
  // 起止相同 = 无深夜区间（恒不 quiet）
  assert.deepEqual(quietDecision({ hour: 23, quietFrom: 23, quietTo: 23 }), { quiet: false, reason: 'awake' });
});

test('quietDecision 口径边界：weekday/minute 只透传不判定、非法 hour 按 0 保守落进深夜', () => {
  // weekday 不改判定（节假日/周末例外由调用方折进 exceptions，模块不做日历 IO）
  assert.deepEqual(quietDecision({ hour: 23, weekday: 6 }), quietDecision({ hour: 23, weekday: 1 }));
  assert.deepEqual(quietDecision({ hour: 12, weekday: 0 }), { quiet: false, reason: 'awake' });
  // minute 不参与整点边界：7:59 仍深夜、8:00 起非深夜
  assert.deepEqual(quietDecision({ hour: 7, minute: 59 }), { quiet: true, reason: 'quiet-hours' });
  // 非法 hour 按 0 处理（默认区间 0 点在深夜 → 保守不主动）
  assert.deepEqual(quietDecision({ hour: NaN }), { quiet: true, reason: 'quiet-hours' });
  assert.deepEqual(quietDecision({ hour: 'x' }), { quiet: true, reason: 'quiet-hours' });
  // 缺省入参安全（hour 缺省 0 → 默认区间深夜）
  assert.deepEqual(quietDecision(), { quiet: true, reason: 'quiet-hours' });
});

// ──────────────────────────── interruptibility ────────────────────────────

test('interruptScore 五信号加权黄金值（保留 3 位小数）', () => {
  // 缺省：只有 botFreshness=1（Infinity→1）作数 → 0.2×1 = 0.2
  assert.deepEqual(
    { all: interruptScore(), zero: interruptScore({ botSpokeMinutesAgo: 0 }) },
    { all: 0.2, zero: 0 }
  );
  // 0.3×0.8 + 0.25×0.4 + 0.2×(15/30) + 0.15×1 + 0.1×0 = 0.59
  const score = interruptScore({ recentPeerActive: 0.8, groupFlow: 0.4, botSpokeMinutesAgo: 15, topicAboutBot: 1 });
  assert.equal(score, 0.59);
  // 平台提供回复延迟信号：+ 0.1×0.6 = 0.65
  assert.equal(
    interruptScore({ recentPeerActive: 0.8, groupFlow: 0.4, botSpokeMinutesAgo: 15, topicAboutBot: 1, replyLatencyKnown: true, replyLatencyScore: 0.6 }),
    0.65
  );
  // 3 位小数：0.3×0.333 + 0.25×0.333 + 0.2×1 = 0.38315 → 0.383
  assert.equal(interruptScore({ recentPeerActive: 0.333, groupFlow: 0.333 }), 0.383);
});

test('interruptScore botFreshness 扣分：刚说过话→0，min(1, minutes/30)，很久/没说过→1', () => {
  assert.equal(interruptScore({ botSpokeMinutesAgo: 0 }), 0);
  assert.equal(interruptScore({ botSpokeMinutesAgo: 15 }), 0.1, '15min → 新鲜度 0.5 → 0.2×0.5');
  assert.equal(interruptScore({ botSpokeMinutesAgo: 30 }), 0.2);
  assert.equal(interruptScore({ botSpokeMinutesAgo: 999 }), 0.2, '窗口外封顶 1');
  assert.equal(interruptScore({ botSpokeMinutesAgo: Infinity }), 0.2, 'Infinity = 没说过/很久 → 不扣分');
  assert.equal(interruptScore({ botSpokeMinutesAgo: -5 }), 0, '负分钟按 0');
  assert.equal(FRESH_WINDOW_MINUTES, 30, '窗口口径锁定');
});

test('interruptScore 回复延迟不伪造：平台不提供时该信号记 0 且不受 replyLatencyScore 影响', () => {
  // known=false：replyLatencyScore=1 也不作数（不伪造）
  assert.equal(interruptScore({ replyLatencyScore: 1 }), 0.2);
  assert.equal(interruptScore({ replyLatencyKnown: false, replyLatencyScore: 1 }), 0.2);
  // known=true：0.1×clamp01(score) 作数
  assert.equal(interruptScore({ replyLatencyKnown: true, replyLatencyScore: 1 }), 0.3);
  assert.equal(interruptScore({ replyLatencyKnown: true, replyLatencyScore: 2 }), 0.3, '超界钳 1');
  assert.equal(interruptScore({ replyLatencyKnown: true, replyLatencyScore: NaN }), 0.2, '非法信号按 0');
});

test('interruptScore 边界：信号钳 [0,1]、总分钳 [0,1]；belowThreshold 严格小于才算低', () => {
  // 全满 → 0.3+0.25+0.2+0.15+0.1 = 1
  assert.equal(interruptScore({ recentPeerActive: 5, groupFlow: 5, botSpokeMinutesAgo: 999, topicAboutBot: 5, replyLatencyKnown: true, replyLatencyScore: 5 }), 1);
  // 全负/非法 → 0
  assert.equal(interruptScore({ recentPeerActive: -1, groupFlow: -1, botSpokeMinutesAgo: -5, topicAboutBot: -1, replyLatencyKnown: true, replyLatencyScore: -1 }), 0);
  assert.equal(interruptScore({ recentPeerActive: NaN, groupFlow: 'x' }), 0.2, '非法信号按 0，botFreshness 缺省仍 1');
  // belowThreshold：严格小于
  assert.equal(belowThreshold(0.29, 0.3), true);
  assert.equal(belowThreshold(0.3, 0.3), false, '等于阈值不算低');
  assert.equal(belowThreshold(0.35), false, '阈值缺省 0.3');
  assert.equal(belowThreshold(NaN, 0.5), true, '非法分数按 0');
  assert.equal(belowThreshold(0.2, NaN), true, '非法阈值回默认 0.3');
});

// ──────────────────────────── 打扰预算 ────────────────────────────

test('budgetState 初始形状黄金值（缺省 state 各操作安全）', () => {
  assert.deepEqual(budgetState(), { dayKey: null, groupCounts: {}, userCounts: {}, lastAt: {}, unanswered: {} });
  assert.deepEqual(checkBudget(undefined, { groupKey: 'group:1', dayKey: 'd1', now: 0 }), { allow: true, reason: 'ok' }, '空 state 必须可判定');
  assert.equal(backoffFactor(undefined, 'group:1'), 1);
  assert.deepEqual(consumeBudget(undefined, { groupKey: 'group:1', dayKey: 'd1', now: 0 }).groupCounts, { 'group:1': 1 });
});

test('checkBudget 三闸各自拒绝：per-group/day、per-user/day、同目标冷却', () => {
  // ① per-group/day：当日该群 1 次已达上限 1
  const afterGroup = consumeBudget(budgetState(), { groupKey: 'group:1', dayKey: 'd1', now: 1000 });
  assert.deepEqual(checkBudget(afterGroup, { groupKey: 'group:1', dayKey: 'd1', now: 2000, perGroupDaily: 1 }), { allow: false, reason: 'per-group-daily' });
  // 上限 2 时还能发
  assert.deepEqual(checkBudget(afterGroup, { groupKey: 'group:1', dayKey: 'd1', now: 2000, perGroupDaily: 2 }), { allow: true, reason: 'ok' });
  // 上限 0 = 今天一律不主动
  assert.deepEqual(checkBudget(budgetState(), { groupKey: 'group:1', dayKey: 'd1', now: 0, perGroupDaily: 0 }), { allow: false, reason: 'per-group-daily' });
  // ② per-user/day
  const afterUser = consumeBudget(budgetState(), { userKey: 'private:2', dayKey: 'd1', now: 1000 });
  assert.deepEqual(checkBudget(afterUser, { userKey: 'private:2', dayKey: 'd1', now: 2000, perUserDaily: 1 }), { allow: false, reason: 'per-user-daily' });
  // ③ 同目标冷却：冷却 60s 内拒绝、到点放行
  const afterCool = consumeBudget(budgetState(), { groupKey: 'group:1', dayKey: 'd1', now: 1000 });
  assert.deepEqual(checkBudget(afterCool, { groupKey: 'group:1', dayKey: 'd1', now: 60999, perGroupDaily: 3, cooldownMs: 60000 }), { allow: false, reason: 'cooldown' });
  assert.deepEqual(checkBudget(afterCool, { groupKey: 'group:1', dayKey: 'd1', now: 61000, perGroupDaily: 3, cooldownMs: 60000 }), { allow: true, reason: 'ok' });
  // 闸序：群上限先于用户上限先于冷却
  const bothFull = consumeBudget(consumeBudget(budgetState(), { groupKey: 'group:1', userKey: 'private:2', dayKey: 'd1', now: 1000 }), { groupKey: 'group:1', userKey: 'private:2', dayKey: 'd1', now: 1001 });
  assert.deepEqual(
    checkBudget(bothFull, { groupKey: 'group:1', userKey: 'private:2', dayKey: 'd1', now: 2000, perGroupDaily: 2, perUserDaily: 2, cooldownMs: 60000 }),
    { allow: false, reason: 'per-group-daily' }
  );
  // 换日未 rollDay 也不误拒（当日计数只在 dayKey 相同时作数）
  assert.deepEqual(checkBudget(afterGroup, { groupKey: 'group:1', dayKey: 'd2', now: 2000, perGroupDaily: 1 }), { allow: true, reason: 'ok' });
});

test('consumeBudget 纯函数：不改入参、返回新对象、计数/冷却记账正确、换日自动清零', () => {
  const s0 = budgetState();
  const snap = JSON.stringify(s0);
  const s1 = consumeBudget(s0, { groupKey: 'group:1', userKey: 'private:2', dayKey: 'd1', now: 1000 });
  assert.equal(JSON.stringify(s0), snap, '入参必须原封不动');
  assert.notEqual(s1, s0, '返回新对象');
  assert.deepEqual(s1, {
    dayKey: 'd1',
    groupCounts: { 'group:1': 1 },
    userCounts: { 'private:2': 1 },
    lastAt: { 'group:1': 1000 },
    unanswered: {}
  });
  // 累加：同日第二次 → 2
  const s2 = consumeBudget(s1, { groupKey: 'group:1', dayKey: 'd1', now: 2000 });
  assert.deepEqual(s2.groupCounts, { 'group:1': 2 });
  assert.equal(s2.lastAt['group:1'], 2000);
  // 换日自动清零当日计数，保留 lastAt/unanswered
  const withUn = noteUnanswered(s2, 'group:1');
  const s3 = consumeBudget(withUn, { groupKey: 'group:1', dayKey: 'd2', now: 999999 });
  assert.equal(s3.dayKey, 'd2');
  assert.deepEqual(s3.groupCounts, { 'group:1': 1 }, '换日后从 0 起记 1');
  assert.deepEqual(s3.unanswered, { 'group:1': 1 }, '未回应计数跨日保留');
  assert.equal(s3.lastAt['group:1'], 999999);
});

test('rollDay 换日清零当日计数并保留未回应计数/冷却时间', () => {
  let s = consumeBudget(budgetState(), { groupKey: 'group:1', userKey: 'private:2', dayKey: 'd1', now: 1000 });
  s = noteUnanswered(s, 'group:1');
  const rolled = rollDay(s, 'd2');
  assert.deepEqual(rolled, {
    dayKey: 'd2',
    groupCounts: {},
    userCounts: {},
    lastAt: { 'group:1': 1000 },
    unanswered: { 'group:1': 1 }
  });
  // 纯函数：入参不动
  assert.equal(s.dayKey, 'd1');
  assert.deepEqual(s.groupCounts, { 'group:1': 1 });
});

test('noteUnanswered 连续计数 + backoffFactor 递减到 0.25 封底（降频不归零）', () => {
  let s = budgetState();
  assert.equal(backoffFactor(s, 'group:1'), 1, '0 次未回应 → 因子 1');
  const golden = [0.75, 0.5, 0.25, 0.25, 0.25];
  for (const want of golden) {
    const next = noteUnanswered(s, 'group:1');
    assert.notEqual(next, s, 'noteUnanswered 必须返回新对象');
    s = next;
    assert.equal(backoffFactor(s, 'group:1'), want);
  }
  // 计数到 100 仍封底 0.25（绝不归零 = 主动机会永不消失）
  let big = budgetState();
  for (let i = 0; i < 100; i += 1) big = noteUnanswered(big, 'group:1');
  assert.equal(backoffFactor(big, 'group:1'), 0.25);
  // 目标隔离：别的目标不受连击影响
  assert.equal(backoffFactor(big, 'group:2'), 1);
  // 纯函数：入参不动
  assert.deepEqual(budgetState(), { dayKey: null, groupCounts: {}, userCounts: {}, lastAt: {}, unanswered: {} });
});

// ──────────────────────────── 未尽话题 ────────────────────────────

test('extractFollowUps 四族命中：topic/expiryHours/confidence/source 黄金值', () => {
  // 单族（承诺）：confidence = 1/2 = 0.5；due = now + 12h，过期 = due + 12h
  assert.deepEqual(extractFollowUps('回头跟你说', { now: 1000, source: 'group:9' }), [
    { topic: 'promise', confidence: 0.5, expiryHours: 12, source: 'group:9', createdAt: 1000, dueAt: 43201000, expiresAt: 86401000, attempts: 0 }
  ]);
  // 考试族（24h）：'明天考试' 只命中考试（'明天说' 不匹配）
  assert.deepEqual(extractFollowUps('明天考试记得带笔', { now: 0 }), [
    { topic: 'exam', confidence: 0.5, expiryHours: 24, source: null, createdAt: 0, dueAt: 86400000, expiresAt: 172800000, attempts: 0 }
  ]);
  // 生病族（8h）：同族多词命中仍只算一族
  assert.deepEqual(extractFollowUps('有点发烧，不舒服', { now: 0 }).map((i) => [i.topic, i.confidence, i.dueAt]), [['sick', 0.5, 28800000]]);
  // 出行族（24h）
  assert.deepEqual(extractFollowUps('我下周出差', { now: 0 }).map((i) => [i.topic, i.expiryHours]), [['travel', 24]]);
});

test('extractFollowUps 多族命中：confidence=命中族数/2 封顶 1，顺序按族声明序', () => {
  // 两族（承诺 + 出行）→ confidence 1；promise 排前（FAMILIES 声明序）
  const two = extractFollowUps('我明天出差，回头再聊', { now: 1000, source: 's' });
  assert.deepEqual(two.map((i) => [i.topic, i.confidence, i.dueAt]), [
    ['promise', 1, 43201000],
    ['travel', 1, 86401000]
  ]);
  // 三族（承诺 + 考试 + 出行）→ 3/2 封顶 1
  const three = extractFollowUps('考试完回家，答应你回头说', { now: 0 });
  assert.deepEqual(three.map((i) => [i.topic, i.confidence]), [
    ['promise', 1],
    ['exam', 1],
    ['travel', 1]
  ]);
  // 四族全命中
  const four = extractFollowUps('我发烧了，明天考试，考完回家，回头答应你说细节', { now: 0 });
  assert.deepEqual(four.map((i) => i.topic), ['promise', 'exam', 'sick', 'travel']);
  assert.ok(four.every((i) => i.confidence === 1));
});

test('extractFollowUps 无命中返回 []，空/非法文本安全', () => {
  assert.deepEqual(extractFollowUps('今天天气不错', { now: 0 }), []);
  assert.deepEqual(extractFollowUps(''), []);
  assert.deepEqual(extractFollowUps(null), []);
  assert.deepEqual(extractFollowUps(undefined), []);
});

test('followUpDecision：到期未跟进才追（返回 { item, due }），未到期/过期都不追', () => {
  const items = extractFollowUps('回头跟你说', { now: 1000, source: 's' }); // due 43201000 / 过期 86401000
  assert.equal(followUpDecision(items, { now: 1000 }), null, '未到期不追');
  assert.equal(followUpDecision(items, { now: 43200999 }), null, '差 1ms 也不算到期');
  const due = followUpDecision(items, { now: 43201000 });
  assert.deepEqual(due, { item: items[0], due: 43201000 }, '到期即追，due = item.dueAt');
  assert.equal(followUpDecision(items, { now: 86401000 }), null, '过期放下，不反复追问');
  // 多项：先到期的先追；过期的让位给下一个
  const two = extractFollowUps('我明天出差，回头再聊', { now: 1000 });
  assert.equal(followUpDecision(two, { now: 43201000 }).item.topic, 'promise', '承诺先到期先追');
  assert.equal(followUpDecision(two, { now: 86401000 }).item.topic, 'travel', '承诺过期放下，追出行');
  assert.equal(followUpDecision([], { now: 999999999 }), null);
  assert.equal(followUpDecision(null, { now: 0 }), null);
});

test('followUpDecision：尝试次数 ≥ followUpMax 就放下；markFollowed 记尝试次数（纯函数）', () => {
  const items = extractFollowUps('回头跟你说', { now: 1000 });
  const once = markFollowed(items, 'promise');
  assert.deepEqual(once.map((i) => i.attempts), [1]);
  assert.deepEqual(items.map((i) => i.attempts), [0], 'markFollowed 不得改入参');
  assert.notEqual(once, items, '返回新数组');
  const twice = markFollowed(once, 'promise');
  assert.deepEqual(twice.map((i) => i.attempts), [2]);
  // followUpMax=2：尝试 2 次后放下
  assert.equal(followUpDecision(twice, { now: 43201000, followUpMax: 2 }), null, 'attempt≥followUpMax 放下');
  // followUpMax=3：还能追一次
  assert.equal(followUpDecision(twice, { now: 43201000, followUpMax: 3 }).item.topic, 'promise');
  // 无命中 topic：原样拷贝、attempts 不变
  const untouched = markFollowed(twice, '外星话题');
  assert.deepEqual(untouched.map((i) => i.attempts), [2]);
  assert.notEqual(untouched, twice, '无命中也要返回新数组');
});

// ──────────────────────────── trace 透传 ────────────────────────────

test('trace 透传：proactive 决策与 pad 键共存（合并不覆盖），随 queueDelivery→onTurnEnd 落盘', () => {
  const state = {
    pad: [0.3, 0.2, 0.05],
    kind: 'goodNews',
    applied: true,
    modulation: { proactiveFactor: 1.1 },
    proactive: { quiet: false, score: 0.59, allowed: true, reason: 'follow-up' }
  };
  const rec = buildTurnRecord({ key: 'group:1', state });
  assert.deepEqual(rec.state, state, 'state 顶层白名单放行，pad 与 proactive 键必须共存');
  assert.deepEqual(rec.state.pad, [0.3, 0.2, 0.05], '合并不得覆盖 pad');
  assert.equal(rec.droppedFields, undefined, 'state 不得进 droppedFields');

  const written = [];
  const recorder = createTurnRecorder({ writer: { write: (r) => { written.push(r); return 'f'; } } });
  recorder.queueDelivery('s1', { key: 'group:1', wakeReason: 'proactiveCheck', promptText: '【主动机会】k', state });
  recorder.onTurnStart('s1', 't1');
  recorder.onTurnEnd('s1', { reasonKind: 'turn-end', textChars: 5 });
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].state, state, 'queueDelivery→turn 链必须透传合并后的 state');
  assert.deepEqual(written[0].state.proactive, { quiet: false, score: 0.59, allowed: true, reason: 'follow-up' });
  // 只有 proactive 决策（无 affect）时 state 也不丢
  recorder.queueDelivery('s2', { key: 'group:1', wakeReason: 'proactiveCheck', promptText: '【主动机会】k', state: { proactive: { quiet: true, score: 0.2, allowed: false, reason: 'quiet-hours' } } });
  recorder.onTurnStart('s2', 't2');
  recorder.onTurnEnd('s2', { reasonKind: 'turn-end' });
  assert.deepEqual(written[1].state, { proactive: { quiet: true, score: 0.2, allowed: false, reason: 'quiet-hours' } });
});

// ──────────────────────────── 配置契约 ────────────────────────────

test('配置契约：主动性 4 个新参数入 schema，modules.proactive 默认关', () => {
  const d = socialV3Defaults();
  assert.equal(d.modules.proactive, false, 'modules.proactive 必须默认关（关闭时零行为变化）');
  assert.deepEqual(
    {
      quietFrom: d.proactive.quietFrom,
      quietTo: d.proactive.quietTo,
      interruptThreshold: d.proactive.interruptThreshold,
      cooldownMinutes: d.proactive.cooldownMinutes
    },
    { quietFrom: 23, quietTo: 8, interruptThreshold: 0.3, cooldownMinutes: 90 }
  );
});

// ──────────────────────────── 接线契约 ────────────────────────────

test('bridge 接线契约：simProactiveStep 与 simAffectStep 并排调用、状态表与闸门定义', () => {
  // buildWakePromptV2 里调用 simProactiveStep（不改 prompt 文本，只推进决策）
  assert.ok(/simProactiveStep\(key, st\);/.test(BRIDGE_SRC), 'buildWakePromptV2 必须调用 simProactiveStep');
  assert.ok(BRIDGE_SRC.includes('const simProactiveState = new Map()'), 'bridge 必须有主动性状态表');
  assert.ok(
    BRIDGE_SRC.includes("const simProactiveOn = (key) => simV3.moduleOn('proactive') && simV3.canaryAllowed(simKeyOf(key))"),
    'proactive 闸门 = modules.proactive + canary 命中'
  );
  // 模块关闭即返回 null（零行为变化的第一道）
  assert.ok(BRIDGE_SRC.includes("if (!simV3.moduleOn('proactive')) return null;"), 'simProactiveStep 必须模块关即短路');
  // queueDelivery：state 与 P2.1 键合并（不覆盖 pad），proactive 子键形状固定
  assert.ok(BRIDGE_SRC.includes('state: affectDecision'), 'queueDelivery 的 state 必须继续带 affect 决策');
  assert.ok(/pad: affectDecision\.pad, kind: affectDecision\.kind, applied: affectDecision\.applied/.test(BRIDGE_SRC), 'affect 的 state 键不许改');
  assert.ok(
    BRIDGE_SRC.includes('proactive: { quiet: proactiveDecision.quiet, score: proactiveDecision.score, allowed: proactiveDecision.allowed, reason: proactiveDecision.reason }'),
    'state.proactive 形状 = { quiet, score, allowed, reason }'
  );
  // 发出后记账：consumeBudget + markFollowed
  assert.ok(BRIDGE_SRC.includes('simProactiveCommit(key, gateFollowUp)'), '发出后必须调用记账');
  assert.ok(BRIDGE_SRC.includes('simConsumeBudget(') && BRIDGE_SRC.includes('simMarkFollowed('), '记账必须走 consumeBudget + markFollowed');
});

test('bridge 接线契约：V2 概率判定在 V3 预算闸之前，模块关闭时整闸旁路', () => {
  const start = BRIDGE_SRC.indexOf('function scheduleProactiveCheckV2(key) {');
  assert.ok(start >= 0, 'scheduleProactiveCheckV2 必须存在');
  const body = BRIDGE_SRC.slice(start, start + 6000);
  const v2Idx = body.indexOf('Math.random() < prob');
  const v3Idx = body.indexOf('simProactiveOn(key)');
  assert.ok(v2Idx >= 0, 'V2 概率判定（Math.random() < prob）必须保留在 scheduleProactiveCheckV2');
  assert.ok(v3Idx >= 0, 'V3 预算闸（simProactiveOn）必须接在 scheduleProactiveCheckV2');
  assert.ok(v2Idx < v3Idx, 'V2 概率判定必须在 V3 闸之前（8.1 共存口径：先 V2 后 V3）');
  // V2 四系数判定原样保留（nightFactor/recentReplyFactor/floodFactor/pendingThoughtsFactor）
  for (const factor of ['nightFactor', 'recentReplyFactor', 'floodFactor', 'pendingThoughtsFactor']) {
    assert.ok(body.includes(factor), `V2 系数 ${factor} 不许动`);
  }
  // 闸门包在 simProactiveOn(key) 里：模块关闭/canary 未命中完全旁路
  assert.ok(/if \(wantProactive && simProactiveOn\(key\)\)/.test(body), 'V3 闸必须由 simProactiveOn 把守');
  assert.ok(body.includes('simProactiveStep(key, st)'), '闸内必须走 simProactiveStep 的决策链');
  assert.ok(/!gateDecision \|\| !gateDecision\.allowed/.test(body), '任一闸不过就不主动');
  // 决策链四步在 simProactiveStep 里依次出现（quiet → 阈值 → 预算 → 未尽话题）
  const stepStart = BRIDGE_SRC.indexOf('function simProactiveStep(key, st) {');
  const stepBody = BRIDGE_SRC.slice(stepStart, stepStart + 9000);
  const chain = ['simQuietDecision(', 'simBelowThreshold(', 'simCheckBudget(', 'simFollowUpDecision('];
  let prev = -1;
  for (const call of chain) {
    const idx = stepBody.indexOf(call);
    assert.ok(idx >= 0, `决策链缺少 ${call}`);
    assert.ok(idx > prev, `决策链顺序错：${call} 必须在上一步之后`);
    prev = idx;
  }
});

test('harness 绑定契约：bridge 用到的每个本地别名都注入 simulationProactive 导出', () => {
  assert.ok(HARNESS_SRC.includes("import * as simulationProactive from '../src/simulation/proactive.js';"), 'harness 必须 import proactive.js');
  for (const name of PROACTIVE_ALIASES) {
    assert.ok(BRIDGE_SRC.includes(name), `bridge 必须用到别名 ${name}`);
    assert.ok(HARNESS_SRC.includes(`${name}: simulationProactive.`), `harness 缺少 ${name} 绑定`);
  }
});
