// GEN3 1.5 人设锚点回归：锚点文本黄金值、重锚节奏、漂移监测、轻量 PICon 自称一致性、
// prompt snapshot（锚点并入【你的身份】段且受 token 预算钳制）、trace 透传、bridge 接线契约。
// 锚点文本与评分公式在这里钉死——它们就是 6.1 的行为规格。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ANCHOR_CAPS,
  buildAnchorText,
  detectDrift,
  extractStyleStats,
  shouldReanchor
} from '../src/simulation/persona.js';
import { buildTurnRecord, createTurnRecorder, snapshotPrompt } from '../src/simulation/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const HARNESS_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');

const BASE = '【你的身份】你是「小鲸」（QQ 1）。';

// ──────────────────────────── 锚点渲染 ────────────────────────────

test('buildAnchorText 黄金值：说话特征/红线/关系一段式拼接（锚点文本锁定）', () => {
  const out = buildAnchorText({
    baseText: BASE,
    speechFeatures: ['元气开朗', '不说教'],
    redLines: ['不冷战', '不解释技术'],
    relations: ['小明', '小红'],
    maxChars: 500,
    full: true
  });
  assert.equal(out, `${BASE}人设锚点：说话特征「元气开朗、不说教」；红线「不冷战、不解释技术」；关系「小明、小红」。`);
});

test('buildAnchorText compact 原样返回 baseText；素材全空时 full 也只回 baseText', () => {
  const compact = buildAnchorText({ baseText: BASE, speechFeatures: ['元气开朗'], full: false });
  assert.equal(compact, BASE);
  assert.equal(buildAnchorText({ baseText: BASE, full: true }), BASE, '无素材不产生空锚点尾巴');
  assert.equal(buildAnchorText({ full: true }), '', 'baseText 缺省安全');
});

test('buildAnchorText 条数封顶：说话特征≤5、红线≤3、关系≤2', () => {
  const out = buildAnchorText({
    baseText: '',
    speechFeatures: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
    redLines: ['r1', 'r2', 'r3', 'r4'],
    relations: ['a', 'b', 'c'],
    full: true
  });
  assert.ok(out.includes('f5') && !out.includes('f6'), `说话特征应封顶 ${ANCHOR_CAPS.speechFeatures} 条`);
  assert.ok(out.includes('r3') && !out.includes('r4'), `红线应封顶 ${ANCHOR_CAPS.redLines} 条`);
  assert.ok(out.includes('「a、b」') && !out.includes('c'), `关系应封顶 ${ANCHOR_CAPS.relations} 条`);
});

test('buildAnchorText 预算钳制：先丢末段（关系→红线），单段仍超才硬截断', () => {
  // 全段尾巴 44 字 > 25：丢「关系」剩 34 仍超，再丢「红线」剩 20 ≤ 25，保留说话特征段。
  const out = buildAnchorText({
    baseText: 'B',
    speechFeatures: ['元气开朗', '不说教'],
    redLines: ['不冷战', '不解释技术'],
    relations: ['小明', '小红'],
    maxChars: 25,
    full: true
  });
  assert.equal(out, 'B人设锚点：说话特征「元气开朗、不说教」。');
  // 单段仍超预算：硬截断到恰好 maxChars 字并以 … 收尾。
  const hard = buildAnchorText({
    baseText: '',
    speechFeatures: ['一二三四五六七八九十十一十二'],
    maxChars: 20,
    full: true
  });
  assert.equal(hard.length, 20, '硬截断后尾巴恰好 maxChars 字');
  assert.ok(hard.endsWith('…'));
});

// ──────────────────────────── 重锚节奏 ────────────────────────────

test('shouldReanchor：首轮必锚、每 N 轮一锚、连续漂移强锚、其余不锚', () => {
  assert.deepEqual(shouldReanchor({ turnCount: 0, everyTurns: 10 }), { reanchor: true, reason: 'first' });
  assert.deepEqual(shouldReanchor({ turnCount: 10, everyTurns: 10 }), { reanchor: true, reason: 'every-n' });
  assert.deepEqual(shouldReanchor({ turnCount: 5, everyTurns: 10 }), { reanchor: false, reason: null });
  assert.deepEqual(
    shouldReanchor({ turnCount: 5, everyTurns: 10, driftStreak: 1, driftStreakNeed: 2 }),
    { reanchor: false, reason: null },
    '单轮漂移抖动不算'
  );
  assert.deepEqual(
    shouldReanchor({ turnCount: 5, everyTurns: 10, driftStreak: 2, driftStreakNeed: 2 }),
    { reanchor: true, reason: 'drift' }
  );
  assert.deepEqual(
    shouldReanchor({ turnCount: 10, everyTurns: 10, driftStreak: 2, driftStreakNeed: 2 }),
    { reanchor: true, reason: 'drift' },
    '漂移强锚优先于周期锚'
  );
});

test('shouldReanchor 20 轮节奏：everyTurns=10 时只在第 0/10 轮锚', () => {
  const hits = [];
  for (let t = 0; t < 20; t += 1) {
    const d = shouldReanchor({ turnCount: t, everyTurns: 10 });
    if (d.reanchor) hits.push(`${t}:${d.reason}`);
  }
  assert.deepEqual(hits, ['0:first', '10:every-n']);
});

// ──────────────────────────── 漂移监测 ────────────────────────────

test('extractStyleStats：句长/标点/语气词/表情/自称/禁忌各信号口径', () => {
  const empty = extractStyleStats([]);
  assert.deepEqual(empty, {
    msgCount: 0, avgSentenceChars: 0, punctuationRate: 0, toneWordRate: 0, emojiRate: 0, aiSelfRate: 0, tabooHits: 0
  });
  const st = extractStyleStats(['今天天气真好呀。出去玩啦！']);
  assert.equal(st.msgCount, 1);
  assert.equal(st.avgSentenceChars, 6.5); // 13 字 / 2 句
  assert.equal(st.toneWordRate, 0.1538);  // 呀、啦 / 13 字
  assert.equal(st.punctuationRate, 0.1538); // 。！ / 13 字
  const emoji = extractStyleStats(['好耶🎉']);
  assert.equal(emoji.emojiRate, 1);
  const taboo = extractStyleStats(['我们不冷战好不好'], { tabooWords: ['不冷战', '不存在的'] });
  assert.equal(taboo.tabooHits, 1);
});

test('轻量 PICon 自称一致性：与 simulation-eval 同口径（我是X 族必中），正常文本不误报', () => {
  // P0.4 eval 的自称正则（scripts/simulation-eval.mjs lightStyle）：口径必须兼容。
  const EVAL_AI_RE = /我是\s?(AI|人工智能|助手|模型|程序)/;
  for (const t of ['我是AI', '我是人工智能', '我是助手', '我是模型', '我是程序']) {
    assert.equal(extractStyleStats([t]).aiSelfRate, 1, `自称判定漏了：${t}`);
    assert.ok(EVAL_AI_RE.test(t), '与 eval 口径不一致');
  }
  assert.equal(extractStyleStats(['作为一个AI模型呀']).aiSelfRate, 1, '「作为…」变体计入');
  const normal = extractStyleStats(['今天一起吃蛋糕呀！', '好耶，贴贴～', '哼不理你了']);
  assert.equal(normal.aiSelfRate, 0, '正常闲聊不得误报自称');
});

test('detectDrift：无基线不告警、同形零分、风格剧变必漂移', () => {
  assert.deepEqual(detectDrift(extractStyleStats(['x']), null), { score: 0, drifted: false, flags: [] });
  const baseline = { avgSentenceChars: 5, punctuationRate: 0.1, toneWordRate: 0.02, emojiRate: 0, aiSelfRate: 0, tabooHits: 0 };
  const same = detectDrift({ ...baseline }, baseline, { threshold: 0.5 });
  assert.deepEqual(same, { score: 0, drifted: false, flags: [] });
  // 单信号拉满（句长 5→30）：styleDist=0.25，不足以单独触发
  const one = detectDrift({ ...baseline, avgSentenceChars: 30 }, baseline, { threshold: 0.5 });
  assert.equal(one.score, 0.25);
  assert.equal(one.drifted, false);
  // 四信号全拉满：styleDist=1 → 必漂移
  const all = detectDrift({
    avgSentenceChars: 30, punctuationRate: 0.31, toneWordRate: 0.14, emojiRate: 2, aiSelfRate: 0, tabooHits: 0
  }, baseline, { threshold: 0.5 });
  assert.equal(all.score, 1);
  assert.equal(all.drifted, true);
});

test('detectDrift：自称 AI 只罚相对基线上升；禁忌按次计罚并置 flag', () => {
  const baseline = { avgSentenceChars: 5, punctuationRate: 0.1, toneWordRate: 0.02, emojiRate: 0, aiSelfRate: 0.1, tabooHits: 0 };
  // 基线本就有 0.1 自称率（角色卡允许被追问时承认）：持平不罚、不 flag
  const stable = detectDrift({ ...baseline }, baseline, { threshold: 0.5 });
  assert.deepEqual(stable, { score: 0, drifted: false, flags: [] });
  // 飙升到 0.6：罚 0.5 封顶 → drift
  const rise = detectDrift({ ...baseline, aiSelfRate: 0.6 }, baseline, { threshold: 0.5 });
  assert.equal(rise.score, 0.5);
  assert.equal(rise.drifted, true);
  assert.deepEqual(rise.flags, ['ai-self']);
  // 禁忌命中 1 次 flag 不漂移，2 次（0.5）漂移
  const taboo1 = detectDrift({ ...baseline, tabooHits: 1 }, baseline, { threshold: 0.5 });
  assert.equal(taboo1.score, 0.25);
  assert.equal(taboo1.drifted, false);
  assert.deepEqual(taboo1.flags, ['taboo']);
  const taboo2 = detectDrift({ ...baseline, tabooHits: 2 }, baseline, { threshold: 0.5 });
  assert.equal(taboo2.score, 0.5);
  assert.equal(taboo2.drifted, true);
});

test('轻量 PICon 全链路：人设一致文本零漂移；自称+禁忌文本必被标记', () => {
  const redLines = ['不冷战', '不解释技术', '不说教'];
  const good = ['今天一起吃蛋糕呀！', '好耶，贴贴～', '哼不理你了，才没有生气'];
  const goodStats = extractStyleStats(good, { tabooWords: redLines });
  assert.equal(goodStats.aiSelfRate, 0);
  assert.equal(goodStats.tabooHits, 0);
  assert.deepEqual(detectDrift(goodStats, goodStats, { threshold: 0.5 }), { score: 0, drifted: false, flags: [] });
  // 红线按词面命中（t.includes），bad 文本必须真实包含红线词
  const bad = ['我是AI模型，训练数据就不解释技术了', '哼，不冷战是不可能的，你也有不对'];
  const badStats = extractStyleStats(bad, { tabooWords: redLines });
  const drift = detectDrift(badStats, goodStats, { threshold: 0.5 });
  assert.ok(drift.flags.includes('ai-self'), '自称 AI 必置 flag');
  assert.ok(drift.flags.includes('taboo'), '红线命中必置 flag');
  assert.equal(drift.drifted, true);
});

// ──────────────────────────── prompt snapshot / trace ────────────────────────────

test('prompt snapshot：锚点并入【你的身份】段，不新增段；尾巴受 token 预算钳制', () => {
  const anchorLine = buildAnchorText({
    baseText: BASE,
    speechFeatures: ['元气开朗', '不说教'],
    redLines: ['不冷战', '不解释技术'],
    relations: ['小明'],
    maxChars: 30,
    full: true
  });
  const prompt = `${anchorLine}\n\n【此刻状态】未读 1 条\n\n`;
  const snap = snapshotPrompt(prompt);
  assert.deepEqual(snap.segments.map((s) => s.name), ['你的身份', '此刻状态'], '锚点不得新增 prompt 段');
  const identity = snap.segments.find((s) => s.name === '你的身份');
  const baseSeg = snapshotPrompt(`${BASE}\n\n【此刻状态】未读 1 条\n\n`).segments.find((s) => s.name === '你的身份');
  const tailChars = identity.chars - baseSeg.chars;
  assert.ok(tailChars > 0 && tailChars <= 30, `锚点尾巴 ${tailChars} 字必须落在 30 字预算内`);
});

test('trace 透传：persona 字段进白名单并随 queueDelivery→turn 落盘', () => {
  const decision = { anchorMode: 'full', reanchorReason: 'every-n', driftScore: 0.2, drifted: false, driftFlags: [] };
  const rec = buildTurnRecord({ key: 'group:1', persona: decision });
  assert.deepEqual(rec.persona, decision);
  assert.equal(rec.droppedFields, undefined, 'persona 不得进 droppedFields');

  const written = [];
  const recorder = createTurnRecorder({ writer: { write: (r) => { written.push(r); return 'f'; } } });
  recorder.queueDelivery('s1', { key: 'group:1', wakeReason: 'msg', promptText: `${BASE}\n\n`, persona: decision });
  recorder.onTurnStart('s1', 't1');
  recorder.onTurnEnd('s1', { reasonKind: 'turn-end', textChars: 12 });
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].persona, decision);
  assert.ok(written[0].promptSnapshot, 'prompt 快照仍在');
});

// ──────────────────────────── 接线契约 ────────────────────────────

test('bridge 接线契约：buildWakePromptV2 走 persona 身份段，决策随 queueDelivery 落 trace', () => {
  assert.ok(BRIDGE_SRC.includes('simPersonaIdentityLine'), 'bridge 必须有 persona 身份段入口');
  assert.ok(/const identityLine = simPersonaIdentityLine\(key, st\);/.test(BRIDGE_SRC), 'buildWakePromptV2 必须用 persona 身份段');
  assert.ok(BRIDGE_SRC.includes('simBuildAnchorText'), 'bridge 必须调用锚点渲染');
  assert.ok(BRIDGE_SRC.includes('persona: personaDecision'), 'queueDelivery 必须带上 persona 决策');
  // vm harness 必须注入同名绑定，否则 vm 套件会在运行到使用点炸 ReferenceError
  for (const name of ['simBuildAnchorText', 'simShouldReanchor', 'simExtractStyleStats', 'simDetectDrift']) {
    assert.ok(HARNESS_SRC.includes(`${name}: simulationPersona.`), `harness 缺少 ${name} 绑定`);
  }
});
