// GEN3 P0.7 回归：注意力决策的硬规则（直接提及永不 silent）、评分公式、可解释输出；
// P1.6 补：连续沉默只告警、拍一拍冷却、wait 提示并入既有段（不新增硬等待）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { actionToSpeakSilent, advanceSilentStreak, decideAttention, extractFeatures, pokeCooldownActive } from '../src/simulation/attention.js';
import { snapshotPrompt } from '../src/simulation/trace.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

const BOT_KW = ['蓝莓球', '鲸鱼'];
const BASE = { botKeywords: BOT_KW, now: 1792800000000 };

test('硬规则：私聊/@/引用bot/主人/拍一拍/提问 一律 speak（false silence 零容忍）', () => {
  assert.equal(decideAttention({ isPrivate: true }).decisionPath, 'private');
  assert.equal(decideAttention({ explicitAddressee: true }).decisionPath, 'explicit-addressee');
  assert.equal(decideAttention({ hasPoke: true }).decisionPath, 'poke');
  assert.equal(decideAttention({ owner: true }).decisionPath, 'owner');
  assert.equal(decideAttention({ question: true }).decisionPath, 'question');
  // 硬规则压过任何低分场景
  assert.equal(decideAttention({ isPrivate: true, floor: 1, recentBot: 1 }).action, 'speak');
});

test('评分：高于 speakThreshold 说、中间 wait、低于 silentThreshold 沉默', () => {
  const cfg = { speakThreshold: 0.55, silentThreshold: 0.25 };
  // 高话题相关（0.9）+ 有关系（0.5）：0.2*0.9+0.15*0.5=0.255 → wait；调高权重后 speak
  const mid = decideAttention({ topicContinuity: 0.9, relationship: 0.5 }, cfg);
  assert.equal(mid.action, 'wait');
  assert.equal(mid.decisionPath, 'salience-wait');
  // 默认权重下非硬规则满分 = 0.2+0.15+0.15 = 0.5 < 0.55，落 wait 区——权重/阈值待 P0.4 语料校准（计划 6.2）
  const high = decideAttention({ topicContinuity: 1, relationship: 1, urgency: true }, cfg);
  assert.equal(high.action, 'wait');
  assert.equal(high.score, 0.5);
  const low = decideAttention({ floor: 1, recentBot: 1 }, cfg);
  assert.equal(low.action, 'silent');
  assert.ok(low.score === 0, '负分钳到 0');
  // speak 分支：自定义权重让 salience 越过发言阈值
  const weighted = decideAttention({ topicContinuity: 1 }, { speakThreshold: 0.55, weights: { topic: 0.6 } });
  assert.equal(weighted.action, 'speak');
});

test('extractFeatures：消息数组 → 归一化特征', () => {
  const now = BASE.now;
  const f = extractFeatures({
    messages: [{ sender: '路人', userId: '111', plain: '蓝莓球 你怎么看？', isOwner: false }],
    recent: [
      { sender: '路人', plain: 'a', isSelf: false, time: now - 5000 },
      { sender: '我', plain: 'b', isSelf: true, time: now - 5000 }
    ],
    activeTopics: [{ text: '你怎么看这个问题的后续' }],
    impressions: { 'u:111': { interactionCount: 40, aliases: ['路人'] } },
    isPrivate: false,
    botKeywords: BOT_KW,
    now
  });
  assert.equal(f.explicitAddressee, true, '叫名字算受话人');
  assert.equal(f.question, true);
  assert.equal(f.urgency, false);
  assert.ok(f.topicContinuity > 0, '话题重合应给分');
  assert.equal(f.relationship, 1, '互动 40 次归一化到 1');
  assert.equal(f.recentBot, 1, '30 秒内 bot 说过话');
  // 私聊 + owner
  const f2 = extractFeatures({ messages: [{ sender: '主人', plain: '你好', isOwner: true }], isPrivate: true, ...BASE });
  assert.equal(f2.isPrivate, true);
  assert.equal(f2.owner, true);
  // 无印象 → 关系 0
  const f3 = extractFeatures({ messages: [{ sender: 'x', plain: '随便' }], impressions: {}, ...BASE });
  assert.equal(f3.relationship, 0);
});

test('shadow 折算：wait 归 speak 侧，silent 才算沉默', () => {
  assert.equal(actionToSpeakSilent('speak'), 'speak');
  assert.equal(actionToSpeakSilent('wait'), 'speak');
  assert.equal(actionToSpeakSilent('silent'), 'silent');
});

test('连续沉默：达到阈值只告警不强制发言；非 silent 立即清零', () => {
  let s = advanceSilentStreak(undefined, 'silent');
  assert.deepEqual(s, { silentStreak: 1, warned: false });
  s = advanceSilentStreak(s, 'silent');
  assert.equal(s.silentStreak, 2);
  s.warned = true; // 模拟 bridge 达到阈值后的告警去重标记
  s = advanceSilentStreak(s, 'silent');
  assert.equal(s.warned, true, '告警标记必须保留，避免每轮刷日志');
  assert.deepEqual(advanceSilentStreak(s, 'speak'), { silentStreak: 0, warned: false }, '一说话就清零');
  assert.deepEqual(advanceSilentStreak(s, 'wait'), { silentStreak: 0, warned: false }, 'wait 不算连续沉默');
});

test('拍一拍冷却：冷却内拦截、冷却外放行、0/缺失不拦截', () => {
  const now = 1792800000000;
  assert.equal(pokeCooldownActive(0, now, 60000), false, '首次拍不冷却');
  assert.equal(pokeCooldownActive(now - 1000, now, 60000), true, '冷却内');
  assert.equal(pokeCooldownActive(now - 60000, now, 60000), false, '恰好到期放行');
  assert.equal(pokeCooldownActive(now - 1000, now, 0), false, '关闭冷却');
  assert.equal(pokeCooldownActive(undefined, now, 60000), false);
});

test('wait 决策：只把提示并入【首回复节奏】段，不新增段、不产生硬等待', async () => {
  const h = await bridgeHarness();
  try {
    const key = 'group:123456789';
    const waitPrompt = h.buildWakePromptV2(key, 'probability', { action: 'wait', score: 0.4, reason: '介于两阈值之间' });
    const speakPrompt = h.buildWakePromptV2(key, 'probability', { action: 'speak', score: 1, reason: '直接提及' });
    assert.ok(waitPrompt.includes('【注意力判断】'), 'wait 必须提示先观察再决定');
    assert.ok(!speakPrompt.includes('【注意力判断】'), 'speak 不得带等待提示');
    assert.deepEqual(
      snapshotPrompt(waitPrompt).segments.map((s) => s.name),
      snapshotPrompt(speakPrompt).segments.map((s) => s.name),
      'wait 提示只能并进既有段，不能新增 prompt 段'
    );
  } finally {
    await h.close();
  }
});

test('bridge 接线：沉默计数/拍一拍冷却/wait 提示都已挂进唤醒链路', () => {
  assert.match(BRIDGE_SRC, /advanceSilentStreak\(simAttentionStreak\.get/, '连续沉默计数必须接线');
  assert.match(BRIDGE_SRC, /maxSilentTurnsBeforeReevaluate/, '阈值必须取自 config');
  assert.match(BRIDGE_SRC, /只告警不强制发言/, '只告警口径必须写进代码');
  assert.match(BRIDGE_SRC, /pokeCooldownActive\(simPokeCooldownAt\.get/, '拍一拍冷却必须接线');
  assert.match(BRIDGE_SRC, /outcome: 'poke-cooldown'/, '冷却拦截必须写 trace');
  assert.match(BRIDGE_SRC, /attentionGate\?\.action === 'wait'/, 'wait 提示必须从闸门传给 prompt');
});
