// GEN3 2.4 表情语境打分回归：公式黄金值（match/feedback/新近罚）、top-k 稳定排序、
// 「无合适就不发」拦截、使用账本纯函数、情绪判定、JSON 可序列化、bridge/harness/config 接线契约。
// 公式与黄金值在这里钉死——时间一律显式传入 now，测试不依赖真实时钟、无隐藏随机。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DEFAULT_COOLDOWN_HOURS,
  DEFAULT_HALF_LIFE_HOURS,
  DEFAULT_WEIGHTS,
  EMOTION_AXES,
  RECENCY_COOLDOWN_FACTOR,
  emotionFromPad,
  emotionFromText,
  normalizeUsage,
  pickStickerOrNone,
  rankStickers,
  recordFeedback,
  recordUse,
  scoreSticker
} from '../src/simulation/sticker-score.js';
import { SOCIAL_V3_SCHEMA } from '../src/simulation/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const HARNESS_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');

// bridge 里 sticker-score.js 的全部本地别名（漏一个 vm 套件就 ReferenceError）
const STICKER_ALIASES = [
  ['simScoreSticker', 'scoreSticker'],
  ['simRankStickers', 'rankStickers'],
  ['simPickStickerOrNone', 'pickStickerOrNone'],
  ['simEmotionFromText', 'emotionFromText'],
  ['simEmotionFromPad', 'emotionFromPad'],
  ['simRecordStickerUse', 'recordUse'],
  ['simRecordStickerFeedback', 'recordFeedback'],
  ['simNormalizeStickerUsage', 'normalizeUsage']
];

// 基准表情：tags 恰好命中 ['happy'] 期望标签 → matchScore=1，无账本 → feedbackScore=0.5
const HAPPY_STICKER = { id: 's1', tags: ['happy'] };

// ──────────────────────────── 常量 ────────────────────────────

test('常量黄金值：情绪轴顺序、默认权重 0.6/0.4、新近罚 0.7 与 24h/168h', () => {
  assert.deepEqual(EMOTION_AXES, ['happy', 'sad', 'angry', 'awkward', 'calm', 'excited', 'neutral']);
  assert.deepEqual(DEFAULT_WEIGHTS, { match: 0.6, feedback: 0.4 });
  assert.equal(RECENCY_COOLDOWN_FACTOR, 0.7);
  assert.equal(DEFAULT_COOLDOWN_HOURS, 24);
  assert.equal(DEFAULT_HALF_LIFE_HOURS, 168);
});

// ──────────────────────────── scoreSticker 公式 ────────────────────────────

test('scoreSticker 公式精确值：match=Jaccard、feedback=拉普拉斯平滑、base=0.6×match+0.4×feedback', () => {
  // A：完全命中期望标签、无使用账本 → 0.6×1 + 0.4×0.5 = 0.8
  assert.deepEqual(
    scoreSticker(HAPPY_STICKER, { emotion: 'happy', pad: [0.5, 0, 0], now: 0 }),
    { score: 0.8, parts: { matchScore: 1, feedbackScore: 0.5, recencyPenalty: 1, baseScore: 0.8, expected: ['happy'] } }
  );
  // B：good=3,bad=1 → feedback=(3+1)/(3+1+2)=0.667 → base=0.6+0.4×0.667=0.867
  assert.deepEqual(
    scoreSticker(HAPPY_STICKER, { emotion: 'happy', pad: [0.5, 0, 0], usage: { s1: { good: 3, bad: 1 } }, now: 0 }),
    { score: 0.867, parts: { matchScore: 1, feedbackScore: 0.667, recencyPenalty: 1, baseScore: 0.867, expected: ['happy'] } }
  );
  // C：emotion ∪ pad 双标签 ['happy','excited']，tags 多一词 'x' → match=2/3=0.667 → base=0.6
  assert.deepEqual(
    scoreSticker({ id: 's1', tags: ['excited', 'happy', 'x'] }, { emotion: 'happy', pad: [0.9, 0.9, 0], now: 0 }),
    { score: 0.6, parts: { matchScore: 0.667, feedbackScore: 0.5, recencyPenalty: 1, baseScore: 0.6, expected: ['happy', 'excited'] } }
  );
  // D：无 tags → Jaccard=0 → base 只剩反馈项 0.4×0.5=0.2
  assert.deepEqual(
    scoreSticker({ id: 's1', tags: [] }, { emotion: 'happy', now: 0 }),
    { score: 0.2, parts: { matchScore: 0, feedbackScore: 0.5, recencyPenalty: 1, baseScore: 0.2, expected: ['happy'] } }
  );
  // E：无任何语境 → expected 为空、match=0（绝不瞎猜情绪）
  assert.deepEqual(
    scoreSticker(HAPPY_STICKER, { now: 0 }),
    { score: 0.2, parts: { matchScore: 0, feedbackScore: 0.5, recencyPenalty: 1, baseScore: 0.2, expected: [] } }
  );
});

test('scoreSticker 权重可覆盖且 base 钳 [0,1]：weights 不改变 match/feedback 分项', () => {
  // 全押 match：0.6→1.0，base=1×1+0×0.5=1
  assert.deepEqual(
    scoreSticker(HAPPY_STICKER, { emotion: 'happy', now: 0, weights: { match: 1, feedback: 0 } }).parts,
    { matchScore: 1, feedbackScore: 0.5, recencyPenalty: 1, baseScore: 1, expected: ['happy'] }
  );
  // 权重超大 → base 钳 1；负权重按缺省回退
  assert.equal(scoreSticker(HAPPY_STICKER, { emotion: 'happy', now: 0, weights: { match: 5, feedback: 5 } }).score, 1);
  assert.equal(
    scoreSticker(HAPPY_STICKER, { emotion: 'happy', now: 0, weights: { match: -1, feedback: -1 } }).score,
    0.8,
    '负权重回默认 0.6/0.4'
  );
});

test('scoreSticker 新近罚各分支：冷却期内 ×0.7、线性恢复、halfLife 处恢复满值', () => {
  // 基准 base=0.8；lastUsedAt=1000（>0 才计罚）
  const opts = (nowMs, extra = {}) => ({ emotion: 'happy', now: nowMs, usage: { s1: { good: 0, bad: 0, lastUsedAt: 1000 } }, ...extra });
  const HOUR = 3600000;
  // 冷却期（<24h）：0.7 → 0.8×0.7=0.56
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 1 * HOUR)).parts.recencyPenalty, 0.7);
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 1 * HOUR)).score, 0.56);
  // 恰好 24h：恢复起点仍是 0.7
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 24 * HOUR)).parts.recencyPenalty, 0.7);
  // 84h：0.7 + 0.3×(84−24)/(168−24) = 0.825 → 0.66
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 84 * HOUR)).parts.recencyPenalty, 0.825);
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 84 * HOUR)).score, 0.66);
  // 168h 及以后：满值 1 → 0.8（不再增长）
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 168 * HOUR)).parts.recencyPenalty, 1);
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 200 * HOUR)).score, 0.8);
  // 自定义窗口：cooldown=1h、halfLife=2h，1.5h → 0.7+0.3×0.5=0.85 → 0.68
  assert.equal(
    scoreSticker(HAPPY_STICKER, opts(1000 + 1.5 * HOUR, { cooldownHours: 1, halfLifeHours: 2 })).parts.recencyPenalty,
    0.85
  );
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 1.5 * HOUR, { cooldownHours: 1, halfLifeHours: 2 })).score, 0.68);
  // halfLife ≤ cooldown 非法 → 回默认 168（不除零）
  assert.equal(scoreSticker(HAPPY_STICKER, opts(1000 + 84 * HOUR, { halfLifeHours: 5 })).parts.recencyPenalty, 0.825);
});

test('scoreSticker 新近罚口径：lastUsedAt 缺省/0 视为没用过不罚，bad 计数只走反馈项', () => {
  assert.equal(scoreSticker(HAPPY_STICKER, { emotion: 'happy', now: 999999, usage: { s1: { good: 0, bad: 0 } } }).parts.recencyPenalty, 1);
  assert.equal(scoreSticker(HAPPY_STICKER, { emotion: 'happy', now: 999999, usage: { s1: { good: 0, bad: 0, lastUsedAt: 0 } } }).parts.recencyPenalty, 1);
  // bad=4 → feedback=(0+1)/(0+4+2)=0.167 → base=0.6+0.4×0.167=0.667
  assert.deepEqual(
    scoreSticker(HAPPY_STICKER, { emotion: 'happy', now: 0, usage: { s1: { bad: 4 } } }).parts,
    { matchScore: 1, feedbackScore: 0.167, recencyPenalty: 1, baseScore: 0.667, expected: ['happy'] }
  );
});

// ──────────────────────────── rankStickers / pickStickerOrNone ────────────────────────────

test('rankStickers 稳定排序与 top-k：score 降序、同分按 id 升序、非法 topK 回 3、小数截断', () => {
  const lib = [
    { id: 'b1', tags: ['happy'] },
    { id: 'a2', tags: ['happy'] },
    { id: 'c3', tags: [] }
  ];
  const opts = { emotion: 'happy', now: 0 };
  // 同分 0.8 的 b1/a2 → id 升序 a2 在前；c3=0.2 排最后
  const top2 = rankStickers(lib, { ...opts, topK: 2 });
  assert.deepEqual(top2.map((r) => r.sticker.id), ['a2', 'b1']);
  assert.deepEqual(top2.map((r) => r.score), [0.8, 0.8]);
  // topK 缺省 / 0 / NaN → 3（全量）
  for (const topK of [undefined, 0, NaN, 'x']) {
    assert.deepEqual(rankStickers(lib, { ...opts, topK }).map((r) => r.sticker.id), ['a2', 'b1', 'c3'], `topK=${topK} 回默认 3`);
  }
  // 小数 topK 向下截断：2.9 → 2
  assert.deepEqual(rankStickers(lib, { ...opts, topK: 2.9 }).map((r) => r.sticker.id), ['a2', 'b1']);
  // 无 id / 非对象条目直接剔除，不参与排序
  assert.deepEqual(rankStickers([{ id: ' ' }, null, 42, ...lib], { ...opts }).map((r) => r.sticker.id), ['a2', 'b1', 'c3']);
});

test('pickStickerOrNone 的 minScore 拦截：达标才发，无合适返回 null 绝不凑数', () => {
  const lib = [
    { id: 'b1', tags: ['happy'] },
    { id: 'a2', tags: ['happy'] },
    { id: 'c3', tags: [] }
  ];
  const opts = { emotion: 'happy', now: 0 };
  // 边界：top-1=0.8 恰好等于 minScore → 放行（≥ 才发）
  assert.deepEqual(pickStickerOrNone(lib, opts, { minScore: 0.8 }), { sticker: lib[1], score: 0.8 });
  // 高于 top-1 → 不发
  assert.deepEqual(pickStickerOrNone(lib, opts, { minScore: 0.85 }), { sticker: null, reason: 'no-suitable' });
  // 空库 / 全不达标 → 不发
  assert.deepEqual(pickStickerOrNone([], opts, { minScore: 0 }), { sticker: null, reason: 'no-suitable' });
  assert.deepEqual(pickStickerOrNone([{ id: 'c3', tags: [] }], opts, { minScore: 0.3 }), { sticker: null, reason: 'no-suitable' });
  // minScore 非法回默认 0.3；超界钳 [0,1]（2→1 必拦、-1→0 必发）
  assert.deepEqual(pickStickerOrNone(lib, opts, { minScore: NaN }), { sticker: lib[1], score: 0.8 });
  assert.deepEqual(pickStickerOrNone(lib, opts, { minScore: 2 }), { sticker: null, reason: 'no-suitable' });
  assert.deepEqual(pickStickerOrNone(lib, opts, { minScore: -1 }), { sticker: lib[1], score: 0.8 });
});

// ──────────────────────────── 情绪判定 ────────────────────────────

test('emotionFromPad 七档映射与边界：p±0.3 含边界、d/a 次级判定、缺维/非法按 0', () => {
  assert.deepEqual(emotionFromPad([0.5, 0, 0]), ['happy']);
  assert.deepEqual(emotionFromPad([0.5, 0.5, 0]), ['excited']);
  assert.deepEqual(emotionFromPad([-0.5, 0, 0]), ['sad']);
  assert.deepEqual(emotionFromPad([-0.5, 0.5, 0]), ['angry']);
  assert.deepEqual(emotionFromPad([0, 0, -0.5]), ['awkward']);
  assert.deepEqual(emotionFromPad([0, -0.5, 0]), ['calm']);
  assert.deepEqual(emotionFromPad([0, 0, 0]), ['neutral']);
  // 边界含等号：p=0.3 → happy、p=-0.3 → sad；d=-0.3 → awkward
  assert.deepEqual(emotionFromPad([0.3, 0, 0]), ['happy']);
  assert.deepEqual(emotionFromPad([-0.3, 0, 0]), ['sad']);
  assert.deepEqual(emotionFromPad([0.29, 0, -0.3]), ['awkward']);
  // p 判定优先于 d/a（正向情绪不被低 d 翻成 awkward）
  assert.deepEqual(emotionFromPad([0.5, -0.5, -0.5]), ['happy']);
  // 缺维/非法/缺省 → 全 0 → neutral
  assert.deepEqual(emotionFromPad(), ['neutral']);
  assert.deepEqual(emotionFromPad([]), ['neutral']);
  assert.deepEqual(emotionFromPad([NaN, 'x', undefined]), ['neutral']);
  // 超界钳 [-1,1]：[2,2,-2] → [1,1,-1] → excited
  assert.deepEqual(emotionFromPad([2, 2, -2]), ['excited']);
});

test('emotionFromText 关键词判定：命中计数取最高、平手按 EMOTION_AXES 顺序、confidence=命中占比', () => {
  // 开心+哈哈 2 命中全在 happy → confidence 1
  assert.deepEqual(emotionFromText('今天好开心，哈哈'), { emotion: 'happy', confidence: 1 });
  // 平手 1:1 → 按轴顺序 happy 先于 sad → happy
  assert.deepEqual(emotionFromText('开心但是有点难过'), { emotion: 'happy', confidence: 0.5 });
  // 2:1 → happy，confidence=2/3=0.667
  assert.deepEqual(emotionFromText('开心，哈哈，难过'), { emotion: 'happy', confidence: 0.667 });
  // 同词多次命中计多次（非重叠子串）
  assert.deepEqual(emotionFromText('哈哈哈哈'), { emotion: 'happy', confidence: 1 });
  // 无命中 → neutral 且 confidence=0
  assert.deepEqual(emotionFromText('普通的一句话'), { emotion: 'neutral', confidence: 0 });
  assert.deepEqual(emotionFromText(''), { emotion: 'neutral', confidence: 0 });
});

test('emotionFromText tables 整体覆盖内置表：未知轴忽略、未列轴视为无词表', () => {
  // 覆盖后 '开心' 判成 angry；未知轴 zzz 不参与
  assert.deepEqual(emotionFromText('我开心', { tables: { angry: ['开心'], zzz: ['开心'] } }), { emotion: 'angry', confidence: 1 });
  // 覆盖后内置表不再生效（'哈哈' 不再命中 happy）
  assert.deepEqual(emotionFromText('哈哈', { tables: { angry: ['生气'] } }), { emotion: 'neutral', confidence: 0 });
});

// ──────────────────────────── 使用账本 ────────────────────────────

test('recordUse/recordFeedback 纯函数：返回新对象不改入参，计数与 lastUsedAt 各管各的', () => {
  const usage = { s1: { good: 2, bad: 1, lastUsedAt: 5 } };
  // recordUse 只更新 lastUsedAt
  const afterUse = recordUse(usage, 's1', { now: 123 });
  assert.deepEqual(afterUse, { s1: { good: 2, bad: 1, lastUsedAt: 123 } });
  assert.deepEqual(usage, { s1: { good: 2, bad: 1, lastUsedAt: 5 } }, '入参不许被改');
  // recordFeedback 只加计数，不动 lastUsedAt
  const afterGood = recordFeedback(usage, 's1', 'good', { now: 999 });
  assert.deepEqual(afterGood, { s1: { good: 3, bad: 1, lastUsedAt: 5 } });
  const afterBad = recordFeedback(usage, 's1', 'bad', { now: 999 });
  assert.deepEqual(afterBad, { s1: { good: 2, bad: 2, lastUsedAt: 5 } });
  // 空账本起步
  assert.deepEqual(recordUse({}, 's2', { now: 7 }), { s2: { good: 0, bad: 0, lastUsedAt: 7 } });
  assert.deepEqual(recordFeedback({}, 's2', 'good'), { s2: { good: 1, bad: 0, lastUsedAt: 0 } });
});

test('recordUse/recordFeedback 入参防呆：stickerId 为空、kind 非 good/bad 一律抛错', () => {
  assert.throws(() => recordUse({}, ''), /stickerId 不能为空/);
  assert.throws(() => recordUse({}, '   '), /stickerId 不能为空/);
  assert.throws(() => recordFeedback({}, 's1', 'meh'), /kind 必须是 good \/ bad/);
  assert.throws(() => recordFeedback({}, 's1', ''), /kind 必须是 good \/ bad/);
});

test('usage 归一与 JSON 可序列化：非法计数/时间戳清洗归零、空 id 丢弃、round-trip 无损', () => {
  assert.deepEqual(
    normalizeUsage({ s1: { good: -5, bad: 'x', lastUsedAt: NaN, extra: 1 }, ' ': { good: 1 } }),
    { s1: { good: 0, bad: 0, lastUsedAt: 0 } }
  );
  assert.deepEqual(normalizeUsage(null), {});
  assert.deepEqual(normalizeUsage([1, 2]), {});
  // 浮点计数截断为整数
  assert.deepEqual(normalizeUsage({ s1: { good: 2.9, bad: 1.2 } }), { s1: { good: 2, bad: 1, lastUsedAt: 0 } });
  // JSON round-trip 无损（可直接落 state/sticker-usage.json）
  const book = recordUse(recordFeedback({}, 's1', 'good'), 's1', { now: 42 });
  assert.deepEqual(JSON.parse(JSON.stringify(book)), book);
});

// ──────────────────────────── bridge 接线契约 ────────────────────────────

test('bridge 契约：sendStickerV2 闸门旁路结构——模块关闭整段跳过、异常放行 V2、发送成功才记账', () => {
  const fnIdx = BRIDGE_SRC.indexOf('async function sendStickerV2');
  assert.ok(fnIdx > 0, '找不到 sendStickerV2');
  // 闸门调用必须在发送前（const url = entry.url 之前）且位于 sendStickerV2 体内
  const gateCall = 'const gate = simStickerGateV2(key, entry.id, { allowSkip: options.allowSkip !== false });';
  const gateIdx = BRIDGE_SRC.indexOf(gateCall);
  const urlIdx = BRIDGE_SRC.indexOf('const url = entry.url;');
  assert.ok(gateIdx > fnIdx && urlIdx > gateIdx, '闸门必须在 sendStickerV2 发送动作之前');
  // 旁路结构：整段包在 if (simStickerOn(key)) 里，关闭时 V2 路径零改动
  assert.ok(BRIDGE_SRC.includes('if (simStickerOn(key)) {'));
  assert.ok(BRIDGE_SRC.includes("const simStickerOn = (key) => simV3.moduleOn('sticker') && simV3.canaryAllowed(simKeyOf(key));"));
  // 拦截分支：无合适就不发
  assert.ok(BRIDGE_SRC.includes("if (gate.skipped) return { entry: null, messageId: null, skipped: true, reason: 'no-suitable' };"));
  // 闸门异常兜底放行（绝不破坏默认路径）
  assert.ok(BRIDGE_SRC.includes("log('simV3 sticker 闸门失败（放行 V2 发送）:'"));
  // 发送成功后才记使用账本
  assert.ok(BRIDGE_SRC.includes('simRecordStickerUse(Object.fromEntries(simStickerUsage), entry.id, { now: Date.now() })'));
});

test('bridge 契约：闸门三分支（no-suitable / fallback-v2 / ok·ok-top / ok-explicit 不偷换）与 trace 脱敏合并', () => {
  // ① 无合适就不发；allowSkip=false 才回落 V2 照发
  assert.ok(BRIDGE_SRC.includes("decide(allowSkip ? 'no-suitable' : 'fallback-v2'"));
  // ② 目标达标放行原选择（ok-top=原选择即 top-1）
  assert.ok(BRIDGE_SRC.includes("decide(picked.sticker.id === requested.id ? 'ok-top' : 'ok'"));
  // ③ 目标不达标：原样放行显式选择，绝不偷换 top-1（2026-10-27 修复：旧 rerank 曾把
  //    主人点名的表情偷换成「同分按 id 升序」的凑数 top-1）
  assert.ok(BRIDGE_SRC.includes("decide('ok-explicit', requested?.id ?? null, requestedScore);"));
  assert.ok(!BRIDGE_SRC.includes("decide('rerank'"), '闸门不得再有 rerank 偷换分支');
  assert.ok(BRIDGE_SRC.includes('const picked = simPickStickerOrNone(stickerEntries, opts, { minScore });'));
  // trace：id 落盘前 hashId 脱敏
  assert.ok(BRIDGE_SRC.includes('chosen: chosenId ? simHashId(chosenId) : null'));
  assert.ok(BRIDGE_SRC.includes("hashId as simHashId"));
  // state 与 P2.1/P2.2 键合并不覆盖（pad/proactive 原行保留，sticker 为附加子键）
  assert.ok(BRIDGE_SRC.includes('state: affectDecision || proactiveDecision || stickerDecision'));
  assert.ok(BRIDGE_SRC.includes('...(stickerDecision ? { sticker: stickerDecision } : {})'));
  assert.ok(BRIDGE_SRC.includes('...(affectDecision ? { pad: affectDecision.pad, kind: affectDecision.kind, applied: affectDecision.applied, modulation: affectDecision.modulation } : {})'));
});

test('bridge 契约：usage 账本原子写持久化、反馈/查询端点、send-sticker 拦截回执', () => {
  // 账本落 state/sticker-usage.json（tmp+rename 原子写；读失败只读不写）
  assert.ok(BRIDGE_SRC.includes("const STICKER_USAGE_FILE = path.join(STATE_DIR, 'sticker-usage.json');"));
  assert.ok(BRIDGE_SRC.includes('fs.renameSync(tmp, STICKER_USAGE_FILE);'));
  assert.ok(BRIDGE_SRC.includes('if (!simStickerUsageWritable) return;'));
  // 反馈端点（仅控制台）：kind 校验 + 记账落盘；查询端点回账本
  assert.ok(BRIDGE_SRC.includes("url.pathname === '/api/socialV3/sticker/feedback'"));
  assert.ok(BRIDGE_SRC.includes("url.pathname === '/api/socialV3/sticker/usage'"));
  assert.ok(BRIDGE_SRC.includes("if (kind !== 'good' && kind !== 'bad')"));
  assert.ok(BRIDGE_SRC.includes('simRecordStickerFeedback(Object.fromEntries(simStickerUsage), stickerId, kind,'));
  // send-sticker 端点：拦截后不写 recentMessages、回滚发送频率、回执说明原因
  assert.ok(BRIDGE_SRC.includes('if (sent.skipped) {'));
  assert.ok(BRIDGE_SRC.includes('st.sendTimes.splice(skipIdx, 1);'));
  assert.ok(BRIDGE_SRC.includes("sendJson({ ok: true, key, sticker: null, sent: 0, skipped: 1, reason: 'no-suitable', quoted: quotedInfo });"));
});

test('harness 契约：simulationStickerScore 绑定逐名齐全（漏一个 vm 套件就 ReferenceError）', () => {
  assert.ok(HARNESS_SRC.includes("import * as simulationStickerScore from '../src/simulation/sticker-score.js';"));
  for (const [alias, fn] of STICKER_ALIASES) {
    assert.ok(HARNESS_SRC.includes(`${alias}: simulationStickerScore.${fn},`), `harness 缺绑定 ${alias}: simulationStickerScore.${fn}`);
  }
  assert.ok(HARNESS_SRC.includes('simHashId: simulationTrace.hashId,'), 'harness 缺 simHashId 绑定');
});

test('config 契约：modules.sticker 默认关 + 表情组 3 参数默认值（3 / 0.3 / 1440 分钟）', () => {
  const byPath = Object.fromEntries(SOCIAL_V3_SCHEMA.map((e) => [e.path, e]));
  assert.equal(byPath['modules.sticker']?.default, false, 'modules.sticker 必须默认关');
  assert.equal(byPath['sticker.topK']?.default, 3);
  assert.equal(byPath['sticker.minScore']?.default, 0.3);
  assert.equal(byPath['sticker.cooldownMinutes']?.default, 1440);
});
