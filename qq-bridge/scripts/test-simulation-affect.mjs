// GEN3 2.1 PAD 情感回归：事件分类、快慢双速动力学、保守乘数、一键复位、trace 透传、bridge 接线契约。
// 公式与黄金值在这里钉死——它们就是 6.6 的行为规格（只调句长/延迟/表情率/主动概率/插话，不碰事实与权限）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  DEFAULT_EVENT_TABLES,
  EVENT_DELTAS,
  EVENT_KINDS,
  PAD_LIMITS,
  classifyEvent,
  padModulation,
  resetPad,
  stepPad
} from '../src/simulation/affect.js';
import { buildTurnRecord, createTurnRecorder } from '../src/simulation/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const HARNESS_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');

// ──────────────────────────── 常量 ────────────────────────────

test('常量黄金值：PAD 钳制范围、事件清单、七类事件增量（保守幅度锁定）', () => {
  assert.deepEqual(PAD_LIMITS, { min: -1, max: 1 });
  assert.deepEqual([...EVENT_KINDS], ['goodNews', 'badNews', 'praised', 'attacked', 'ignored', 'awkward', 'neutral']);
  assert.deepEqual(EVENT_DELTAS.goodNews, [0.3, 0.2, 0.05]);
  assert.deepEqual(EVENT_DELTAS.badNews, [-0.35, -0.1, -0.15]);
  assert.deepEqual(EVENT_DELTAS.praised, [0.25, 0.15, 0.1]);
  assert.deepEqual(EVENT_DELTAS.attacked, [-0.3, 0.35, -0.2]);
  assert.deepEqual(EVENT_DELTAS.ignored, [-0.15, -0.05, -0.1]);
  assert.deepEqual(EVENT_DELTAS.awkward, [-0.1, 0.15, -0.05]);
  assert.deepEqual(EVENT_DELTAS.neutral, [0, 0, 0]);
  // 幅度保守：每维增量 |Δ| ≤ 0.35，绝不大起大落（情绪化骚扰的第一道闸）
  for (const kind of EVENT_KINDS) {
    for (const v of EVENT_DELTAS[kind]) assert.ok(Math.abs(v) <= 0.35, `${kind} 增量过猛：${v}`);
  }
  assert.equal(DEFAULT_EVENT_TABLES.neutral.length, 0, 'neutral 无词表 = 兜底类');
});

// ──────────────────────────── 事件分类 ────────────────────────────

test('classifyEvent 各类命中：kind/confidence 黄金值', () => {
  assert.deepEqual(classifyEvent('今天有个好消息，开心！'), { kind: 'goodNews', confidence: 1 });
  assert.deepEqual(classifyEvent('我生病了，有点难过'), { kind: 'badNews', confidence: 1 });
  assert.deepEqual(classifyEvent('你被夸了，厉害厉害，太棒了'), { kind: 'praised', confidence: 1 });
  assert.deepEqual(classifyEvent('烦你，闭嘴'), { kind: 'attacked', confidence: 1 });
  assert.deepEqual(classifyEvent('没人理我，已读不回，冷场了'), { kind: 'ignored', confidence: 1 });
  assert.deepEqual(classifyEvent('太尴尬了，社死现场'), { kind: 'awkward', confidence: 1 });
  // 同词多次命中按次计数：'开心'×2 → goodNews 2 / 总 2
  assert.deepEqual(classifyEvent('开心开心'), { kind: 'goodNews', confidence: 1 });
});

test('classifyEvent 无命中 → neutral 且 confidence=0；空文本安全', () => {
  assert.deepEqual(classifyEvent('今天天气不错'), { kind: 'neutral', confidence: 0 });
  assert.deepEqual(classifyEvent(''), { kind: 'neutral', confidence: 0 });
  assert.deepEqual(classifyEvent(null), { kind: 'neutral', confidence: 0 });
});

test('classifyEvent 多类命中取计数最高，confidence=最高/总命中', () => {
  // goodNews 3（好消息/开心/中奖）vs badNews 1（难过）→ goodNews，3/4
  const out = classifyEvent('好消息！开心！中奖了！就是有点难过');
  assert.deepEqual(out, { kind: 'goodNews', confidence: 0.75 });
});

test('classifyEvent 平手按 EVENT_KINDS 顺序取先者（确定性，不靠运气）', () => {
  // goodNews 1 vs badNews 1 → 声明顺序在先的 goodNews；confidence = 1/2
  assert.deepEqual(classifyEvent('好消息，但也有点生病了'), { kind: 'goodNews', confidence: 0.5 });
  // badNews 1 vs praised 1 → badNews 在前
  assert.deepEqual(classifyEvent('生病了，但是被夸了'), { kind: 'badNews', confidence: 0.5 });
});

test('classifyEvent tables 覆盖内置词表（传了就整体替换，内置词不再命中）', () => {
  const tables = { praised: ['开心'], neutral: [] };
  assert.deepEqual(classifyEvent('开心', { tables }), { kind: 'praised', confidence: 1 });
  // 内置表里 '开心'/'好消息'/'中奖'→goodNews，整体覆盖后都不得再命中
  assert.deepEqual(classifyEvent('好消息', { tables }), { kind: 'neutral', confidence: 0 });
  assert.deepEqual(classifyEvent('中奖', { tables }), { kind: 'neutral', confidence: 0 });
  // 自定义表内的多类命中：confidence = 最高/总命中 = 1/2，平手按 EVENT_KINDS 顺序取先（badNews 排在 praised 前）
  assert.deepEqual(
    classifyEvent('开心，好消息', { tables: { praised: ['开心'], badNews: ['好消息'] } }),
    { kind: 'badNews', confidence: 0.5 }
  );
  // 未知类名忽略：结果 kind 只落在 EVENT_KINDS 里
  assert.ok(EVENT_KINDS.includes(classifyEvent('随便', { tables: { 外星类: ['随便'] } }).kind));
});

// ──────────────────────────── 双速动力学 ────────────────────────────

test('stepPad 黄金值：快变量事件增量（eventScale 缩放）+ 钳制 [-1,1]', () => {
  // 缺省 state 从中性起步：goodNews ×1 → pad=[0.3,0.2,0.05]，baseline 跟随 10% → [0.03,0.02,0.005]
  assert.deepEqual(stepPad(undefined, { kind: 'goodNews' }), {
    pad: [0.3, 0.2, 0.05],
    baseline: [0.03, 0.02, 0.005],
    lastKind: 'goodNews',
    lastAt: 0
  });
  // eventScale=2 放大事件增量：badNews [-0.7,-0.2,-0.3]，elapsedHours=0 不回归
  assert.deepEqual(stepPad(resetPad(), { kind: 'badNews', eventScale: 2 }), {
    pad: [-0.7, -0.2, -0.3],
    baseline: [-0.07, -0.02, -0.03],
    lastKind: 'badNews',
    lastAt: 0
  });
  // 上钳：[0.9,0,0] + [0.3,0.2,0.05]×5 = [2.4, 1, 0.25] → [1, 1, 0.25]
  const high = stepPad({ pad: [0.9, 0, 0], baseline: [0, 0, 0] }, { kind: 'goodNews', eventScale: 5 });
  assert.deepEqual(high.pad, [1, 1, 0.25]);
  assert.deepEqual(high.baseline, [0.1, 0.1, 0.025]);
  // 下钳：-0.95 + [-1.2, 1.4, -0.8] = [-2.15, 0.45, -1.75] → [-1, 0.45, -1]
  const low = stepPad({ pad: [-0.95, -0.95, -0.95], baseline: [0, 0, 0] }, { kind: 'attacked', eventScale: 4 });
  assert.deepEqual(low.pad, [-1, 0.45, -1]);
  assert.deepEqual(low.baseline, [-0.1, 0.045, -0.1]);
});

test('stepPad 黄金值：慢回归比例 min(1, elapsed/decay) 与 baseline 10% 移动', () => {
  // ratio=3/6=0.5：pad 向 baseline 回撤一半 → [0.4, 0.2, -0.1]，再 baseline 跟随 10% → [0.22, 0.02, -0.01]
  assert.deepEqual(stepPad({ pad: [0.6, 0.4, -0.2], baseline: [0.2, 0, 0] }, { kind: 'neutral', elapsedHours: 3, decayHours: 6 }), {
    pad: [0.4, 0.2, -0.1],
    baseline: [0.22, 0.02, -0.01],
    lastKind: 'neutral',
    lastAt: 0
  });
  // ratio=1.5/6=0.25：[0.6,0.4,-0.2] → [0.5, 0.3, -0.15]
  const quarter = stepPad({ pad: [0.6, 0.4, -0.2], baseline: [0.2, 0, 0] }, { kind: 'neutral', elapsedHours: 1.5, decayHours: 6 });
  assert.deepEqual(quarter.pad, [0.5, 0.3, -0.15]);
  assert.deepEqual(quarter.baseline, [0.23, 0.03, -0.015]);
});

test('stepPad 边界：elapsed≥decay 全额回归；decayHours 下限 0.5h；非法 kind 当 neutral', () => {
  const st = { pad: [0.6, 0.4, -0.2], baseline: [0.2, 0, 0] };
  // ratio=1：pad 直接回到 baseline，baseline 不动（pad 已等于 baseline）
  assert.deepEqual(stepPad(st, { kind: 'neutral', elapsedHours: 6, decayHours: 6 }), {
    pad: [0.2, 0, 0],
    baseline: [0.2, 0, 0],
    lastKind: 'neutral',
    lastAt: 0
  });
  // elapsed 超出也封顶 1，不会过冲到 baseline 另一侧
  assert.deepEqual(stepPad(st, { kind: 'neutral', elapsedHours: 999, decayHours: 6 }).pad, [0.2, 0, 0]);
  // decayHours=0 → max(0.5, 0)=0.5，ratio=0.25/0.5=0.5：[0.4,0,0] → [0.2,0,0]
  const capped = stepPad({ pad: [0.4, 0, 0], baseline: [0, 0, 0] }, { kind: 'neutral', elapsedHours: 0.25, decayHours: 0 });
  assert.deepEqual(capped.pad, [0.2, 0, 0]);
  assert.deepEqual(capped.baseline, [0.02, 0, 0]);
  // 非法事件类型按 neutral 处理（不炸、不乱加增量）
  assert.deepEqual(stepPad(resetPad(), { kind: '外星事件' }), {
    pad: [0, 0, 0],
    baseline: [0, 0, 0],
    lastKind: 'neutral',
    lastAt: 0
  });
});

test('stepPad 纯函数：不改入参、返回新对象、数值 3 位小数、lastAt 透传 now', () => {
  const input = { pad: [0.6, 0.4, -0.2], baseline: [0.2, 0, 0], lastKind: 'praised', lastAt: 1000 };
  const snapshot = JSON.stringify(input);
  const out = stepPad(input, { kind: 'praised', elapsedHours: 1.7777, decayHours: 6, now: 123456 });
  assert.equal(JSON.stringify(input), snapshot, '入参必须原封不动');
  assert.notEqual(out.pad, input.pad, '返回新数组，不共享引用');
  assert.equal(out.lastAt, 123456, 'now 透传进 lastAt');
  // 1.7777h / 6h → ratio 0.296283…；结果必须是 3 位小数（确定性，跨机器可比）
  const three = (v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-9;
  for (const v of [...out.pad, ...out.baseline]) assert.ok(three(v), `非 3 位小数：${v}`);
  // 链式累进：上一步输出当下一步输入，两轮后状态仍有限且钳在 [-1,1]
  const out2 = stepPad(out, { kind: 'awkward', elapsedHours: 2, decayHours: 6 });
  for (const v of [...out2.pad, ...out2.baseline]) assert.ok(v >= -1 && v <= 1);
});

// ──────────────────────────── 保守乘数 ────────────────────────────

test('padModulation 五因子公式精确断言（默认 scale 0.3，pad=[0.5,0.2,0.4]）', () => {
  const m = padModulation([0.5, 0.2, 0.4]);
  assert.deepEqual(m, {
    sentenceLenFactor: 1.087, // 1 + 0.3×(0.5×0.5 + 0.2×0.2) = 1.087
    delayFactor: 0.901,       // 1 + 0.3×(−0.5×0.5 − 0.4×0.2) = 0.901
    emojiFactor: 1.09,        // 1 + 0.3×(0.5×0.6) = 1.09
    proactiveFactor: 1.084,   // 1 + 0.3×(0.5×0.4 + 0.4×0.2) = 1.084
    interruptFactor: 1.084    // 1 + 0.3×(0.4×0.6 + 0.2×0.2) = 1.084
  });
  // 低落/失控 → 回复更慢：pad=[-0.5,-0.2,-0.4] 时 delayFactor > 1、其余 < 1
  const down = padModulation([-0.5, -0.2, -0.4]);
  assert.deepEqual(down, {
    sentenceLenFactor: 0.913,
    delayFactor: 1.099,
    emojiFactor: 0.91,
    proactiveFactor: 0.916,
    interruptFactor: 0.916
  });
});

test('padModulation：modulationScale=0 一键归零全 1（极端 PAD 也不动）', () => {
  for (const pad of [[0, 0, 0], [1, 1, 1], [-1, -1, -1], [1, -1, 1]]) {
    assert.deepEqual(padModulation(pad, { modulationScale: 0 }), {
      sentenceLenFactor: 1,
      delayFactor: 1,
      emojiFactor: 1,
      proactiveFactor: 1,
      interruptFactor: 1
    }, `scale=0 时 pad=${pad} 必须全 1`);
  }
});

test('padModulation：五因子全部钳制 [0.8,1.2]（scale=3 + 满幅 PAD 也不越界）', () => {
  const high = padModulation([1, 1, 1], { modulationScale: 3 });
  assert.deepEqual(high, {
    sentenceLenFactor: 1.2,
    delayFactor: 0.8,
    emojiFactor: 1.2,
    proactiveFactor: 1.2,
    interruptFactor: 1.2
  });
  const low = padModulation([-1, -1, -1], { modulationScale: 3 });
  assert.deepEqual(low, {
    sentenceLenFactor: 0.8,
    delayFactor: 1.2,
    emojiFactor: 0.8,
    proactiveFactor: 0.8,
    interruptFactor: 0.8
  });
});

test('padModulation：保留 3 位小数；pad 缺维/非法按 0 处理', () => {
  assert.deepEqual(padModulation([0.333, 0.333, 0.333], { modulationScale: 0.3 }), {
    sentenceLenFactor: 1.07,  // 1.06993 → 1.07
    delayFactor: 0.93,        // 0.93007 → 0.93
    emojiFactor: 1.06,        // 1.05994 → 1.06
    proactiveFactor: 1.06,
    interruptFactor: 1.08     // 1.07992 → 1.08
  });
  // 缺维补 0：只给 p → a/d 按 0
  assert.deepEqual(padModulation([0.5]), {
    sentenceLenFactor: 1.075,
    delayFactor: 0.925,
    emojiFactor: 1.09,
    proactiveFactor: 1.06,
    interruptFactor: 1
  });
  assert.deepEqual(padModulation(undefined), padModulation([0, 0, 0]), 'pad 缺省安全 = 中性');
  // 非法 scale 回落默认 0.3（NaN 不许把乘数变 NaN）
  assert.deepEqual(padModulation([0.5, 0.2, 0.4], { modulationScale: NaN }), padModulation([0.5, 0.2, 0.4]));
});

// ──────────────────────────── 一键复位 ────────────────────────────

test('resetPad：返回中性 state（PAD/基线全 0，无事件）', () => {
  assert.deepEqual(resetPad(), { pad: [0, 0, 0], baseline: [0, 0, 0], lastKind: 'neutral', lastAt: 0 });
  // 复位后再推进等价于从零起步（可一键复位 = 随时回到行为基线）
  assert.deepEqual(stepPad(resetPad(), { kind: 'goodNews' }), stepPad(undefined, { kind: 'goodNews' }));
  assert.deepEqual(padModulation(resetPad().pad), {
    sentenceLenFactor: 1,
    delayFactor: 1,
    emojiFactor: 1,
    proactiveFactor: 1,
    interruptFactor: 1
  });
});

// ──────────────────────────── trace 透传 ────────────────────────────

test('trace 透传：state 字段进白名单并随 queueDelivery→onTurnEnd 落盘', () => {
  const decision = {
    pad: [0.3, 0.2, 0.05],
    kind: 'goodNews',
    applied: false,
    modulation: padModulation([0.3, 0.2, 0.05])
  };
  const rec = buildTurnRecord({ key: 'group:1', state: { pad: decision.pad, kind: decision.kind, applied: decision.applied, modulation: decision.modulation } });
  assert.deepEqual(rec.state, decision);
  assert.equal(rec.droppedFields, undefined, 'state 不得进 droppedFields');

  const written = [];
  const recorder = createTurnRecorder({ writer: { write: (r) => { written.push(r); return 'f'; } } });
  recorder.queueDelivery('s1', { key: 'group:1', wakeReason: 'msg', promptText: '【唤醒】k', state: decision });
  recorder.onTurnStart('s1', 't1');
  recorder.onTurnEnd('s1', { reasonKind: 'turn-end', textChars: 5 });
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].state, decision, 'queueDelivery→turn 链必须透传 state');
  assert.ok(written[0].promptSnapshot, 'prompt 快照仍在');
  // 不传 state 的回合保持 null（persona/attention 契约不变）
  recorder.queueDelivery('s2', { key: 'group:1', wakeReason: 'msg', promptText: '【唤醒】k' });
  recorder.onTurnStart('s2', 't2');
  recorder.onTurnEnd('s2', { reasonKind: 'turn-end' });
  assert.equal(written[1].state, null);
});

// ──────────────────────────── 接线契约 ────────────────────────────

test('bridge 接线契约：simAffectStep 推进状态、queueDelivery 带 state、乘数闸门与复位端点', () => {
  // buildWakePromptV2 里调用 simAffectStep（不改 prompt 文本，只推进状态）
  assert.ok(/simAffectStep\(key, st\);/.test(BRIDGE_SRC), 'buildWakePromptV2 必须调用 simAffectStep');
  assert.ok(BRIDGE_SRC.includes('const simAffectState = new Map()'), 'bridge 必须有 affect 状态表');
  assert.ok(BRIDGE_SRC.includes('const simAffectOn = (key) => simV3.moduleOn(\'affect\') && simV3.canaryAllowed(simKeyOf(key))'), 'affect 闸门 = modules.affect + canary 命中');
  // queueDelivery 必须带上 state（pad/kind/applied/modulation 整包）
  assert.ok(BRIDGE_SRC.includes('state: affectDecision'), 'queueDelivery 必须带上 affect 决策');
  assert.ok(/pad: affectDecision\.pad, kind: affectDecision\.kind, applied: affectDecision\.applied/.test(BRIDGE_SRC), 'state 形状 = pad/kind/applied');
  assert.ok(BRIDGE_SRC.includes('modulation: affectDecision.modulation'), '句长/表情率/interrupt 因子入 trace 供 2.3/2.2');
  // 乘数生效点：仅 simAffectOn(key) 为真才乘；V2 默认路径不动
  assert.ok(BRIDGE_SRC.includes('delayFactor'), '延迟乘数生效点（computeGapsForSend V3 路径）');
  assert.ok(BRIDGE_SRC.includes('proactiveFactor'), '主动概率乘数生效点（scheduleProactiveCheckV2）');
  assert.ok(BRIDGE_SRC.includes('return computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);'), 'V2 默认路径必须原样保留');
  // 一键复位端点（照 memory/consolidate 模式）
  assert.ok(BRIDGE_SRC.includes("'/api/socialV3/affect/reset'"), '必须有 affect 一键复位端点');
  assert.ok(BRIDGE_SRC.includes('simResetPad()'), '复位必须走 resetPad 回中性');
  // vm harness 必须注入同名绑定，否则 vm 套件会在运行到使用点炸 ReferenceError
  for (const name of ['simClassifyEvent', 'simStepPad', 'simPadModulation', 'simResetPad']) {
    assert.ok(HARNESS_SRC.includes(`${name}: simulationAffect.`), `harness 缺少 ${name} 绑定`);
  }
});
