// GEN3 P0.3 节奏 seam 回归：randInt / clampGapV2 / computeGapsV2 的黄金值钉死行为，
// rng 注入可确定性复现；并契约检查 bridge.js 保留旧实现 + 双跑开关在位。
// 抽取的验收是「行为不变」——黄金值就是抽取前的行为规格。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { capBubbles, clampGapV2, computeGapsV2, planDelaysV3, randInt } from '../src/simulation/rhythm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

/** 定值序列 rng：每次调用按序取值（尾部循环），让随机路径完全可复现。 */
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

const SEND_CFG = {
  burstIntervalMinMs: 1000,
  burstIntervalMaxMs: 3000,
  maxGapMs: 10000,
  gapBaseMs: 800,
  gapPerCharMs: 20,
  longGapProbability: 0.5,
  longGapMinMs: 5000,
  longGapMaxMs: 8000
};

test('randInt：闭区间、rng 可注入、min/max 交换对称', () => {
  assert.equal(randInt(5, 10, seqRng([0])), 5, 'rng=0 取下界');
  assert.equal(randInt(5, 10, seqRng([0.9999])), 10, 'rng≈1 取上界');
  assert.equal(randInt(5, 5, seqRng([0.7])), 5, '同界恒等');
  assert.equal(randInt(10, 5, seqRng([0])), 5, 'min>max 自动交换后取下界');
  // 默认 rng：大量抽样必须全部落在闭区间内
  for (let i = 0; i < 200; i += 1) {
    const v = randInt(3, 7);
    assert.ok(Number.isInteger(v) && v >= 3 && v <= 7);
  }
});

test('clampGapV2：100ms 下限 + 配置区间钳制 + 取整', () => {
  const cfg = { burstIntervalMinMs: 1000, maxGapMs: 10000 };
  assert.equal(clampGapV2(5, cfg), 1000, '低于区间取 burstIntervalMinMs');
  assert.equal(clampGapV2(99999, cfg), 10000, '高于区间取 maxGapMs');
  assert.equal(clampGapV2(undefined, cfg), 1000, '空值回区间下限');
  assert.equal(clampGapV2(1500.6, cfg), 1501, '区间内四舍五入');
  assert.equal(clampGapV2(800.6, cfg), 1000, '取整后低于区间仍顶到下限');
  // 配置缺省时下限 300 / 上限 10000
  assert.equal(clampGapV2(5, {}), 300);
  assert.equal(clampGapV2(99999, {}), 10000);
});

test('computeGapsV2：0/1 条消息无延迟', () => {
  assert.deepEqual(computeGapsV2([], 'auto', undefined, undefined, SEND_CFG), []);
  assert.deepEqual(computeGapsV2(['a'], 'auto', undefined, undefined, SEND_CFG), []);
  assert.deepEqual(computeGapsV2(null, 'auto', undefined, undefined, SEND_CFG), []);
});

test('computeGapsV2 fixed：gaps 数组逐个钳制；缺数组用 gapMs；空 gapMs 回 burstIntervalMinMs', () => {
  const msgs = ['a', 'bb', 'ccc'];
  assert.deepEqual(computeGapsV2(msgs, 'fixed', undefined, [5000, 20000], SEND_CFG), [5000, 10000], 'gaps 钳到 maxGapMs');
  assert.deepEqual(computeGapsV2(msgs, 'fixed', 2500, [1], SEND_CFG), [2500, 2500], 'gaps 不够长时用 gapMs');
  assert.deepEqual(computeGapsV2(msgs, 'fixed', undefined, undefined, SEND_CFG), [1000, 1000], '空 gapMs 回 burstIntervalMinMs');
});

test('computeGapsV2 byLength：base + 字数×perChar，字数至少按 1 算', () => {
  // 用 burstIntervalMinMs=300 的区间，让 820/840 落在区间内不被下限顶掉
  const cfg = { ...SEND_CFG, burstIntervalMinMs: 300 };
  const msgs = ['a', 'bb', ''];
  // 延迟[i] 由 messages[i] 字数决定：1 字→800+20=820；2 字→800+40=840
  assert.deepEqual(computeGapsV2(msgs, 'byLength', undefined, undefined, cfg), [820, 840]);
  // 空串按 1 字算
  assert.deepEqual(computeGapsV2(['', 'a'], 'byLength', undefined, undefined, cfg), [820]);
  // 超长串钳到 maxGapMs
  const long = ['x'.repeat(1000), 'b'];
  assert.deepEqual(computeGapsV2(long, 'byLength', undefined, undefined, cfg), [10000]);
});

test('computeGapsV2 auto：rng 序列驱动，长短间隔逐项可复现（黄金值）', () => {
  const msgs = ['a', 'bb', 'ccc'];
  // rng 顺序：i=0 先判 longProb（0.4<0.5 → 长间隔）再 randInt（0.25 → floor(5000+0.25*3001)=5750）
  //           i=1 判 longProb（0.9<0.5 不成立 → 短间隔）再 randInt（0.1 → floor(1000+0.1*2001)=1200）
  const rng = seqRng([0.4, 0.25, 0.9, 0.1]);
  assert.deepEqual(computeGapsV2(msgs, 'auto', undefined, undefined, SEND_CFG, rng), [5750, 1200]);
  // 同一序列再跑必须完全一致（确定性）
  const rng2 = seqRng([0.4, 0.25, 0.9, 0.1]);
  assert.deepEqual(computeGapsV2(msgs, 'auto', undefined, undefined, SEND_CFG, rng2), [5750, 1200]);
  // longGapProbability=0 时完全不进长间隔分支（longProb>0 短路，不消费判定随机数）
  const noLong = { ...SEND_CFG, longGapProbability: 0 };
  const rng3 = seqRng([0.5]);
  // 2 条消息 → 1 个延迟：useLong 恒 false，直接 randInt(1000,3000)：rng 0.5 → floor(1000+0.5*2001)=2000
  assert.deepEqual(computeGapsV2(['a', 'bb'], 'auto', undefined, undefined, noLong, rng3), [2000]);
});

test('computeGapsV2：未知 gapMode 走 auto 路径', () => {
  const rng = seqRng([0.4, 0.25, 0.9, 0.1]);
  assert.deepEqual(computeGapsV2(['a', 'bb', 'ccc'], 'weird', undefined, undefined, SEND_CFG, rng), [5750, 1200]);
});

test('planDelaysV3（P1.1 打字模型）：确定性黄金值、预算缩放、犹豫分支、钳制', () => {
  // 空/单条
  assert.deepEqual(planDelaysV3([], {}), []);
  assert.deepEqual(planDelaysV3(['a'], {}), []);
  // rng 全 0：think=200、jitter=0.8；relationship=1 → cpm=100；无犹豫
  // gap0: 200 + 5/100*60000*0.8 = 2600；gap1: 200 + 6/100*60000*0.8 = 3080
  const base = { cpmMin: 40, cpmMax: 100, relationship: 1, maxTotalDelayMs: 30000 };
  assert.deepEqual(planDelaysV3(['你好呀朋友', '今天天气不错', '出去玩吗'], { ...base, rng: seqRng([0, 0, 0, 0]) }), [2600, 3080]);
  // 总预算缩放：单泡间隔 1160 压到预算 500
  assert.deepEqual(planDelaysV3(['ab', 'cd'], { ...base, maxTotalDelayMs: 500, rng: seqRng([0, 0]) }), [500]);
  // 低亲密（rel<0.3）触发犹豫：think=200 + typing=1/46*60000*0.8≈1043 + hesitate=1500 → 2743
  assert.deepEqual(planDelaysV3(['你', '好'], { ...base, relationship: 0.1, rng: seqRng([0, 0, 1]) }), [2743]);
  // 超长泡触发 5000 上限钳制
  assert.deepEqual(planDelaysV3(['x'.repeat(200), 'b'], { ...base, rng: seqRng([0, 0]) }), [5000]);
});

test('capBubbles（maxBubbles）：超限合并进最后一泡、不丢内容、非法参数原样返回', () => {
  assert.deepEqual(capBubbles(['a', 'b', 'c', 'd'], 3), ['a', 'b', 'cd'], '多余内容按顺序并入最后一泡');
  assert.deepEqual(capBubbles(['a', 'b', 'c'], 5), ['a', 'b', 'c'], '未超限原样返回');
  assert.deepEqual(capBubbles(['a', 'b', 'c'], 1), ['abc'], '上限 1 = 全部合并');
  assert.deepEqual(capBubbles(['a', 'b', 'c'], 0), ['a', 'b', 'c'], '非法上限不截断');
  assert.deepEqual(capBubbles(['a', 'b', 'c'], undefined), ['a', 'b', 'c']);
  assert.equal(capBubbles(null, 3), null, '非数组原样返回');
});

test('bridge.js 契约：旧路径保留 + 双跑开关在位，调用点名字未变', () => {
  assert.ok(BRIDGE_SRC.includes('computeGapsV2Legacy'), '旧实现副本必须保留');
  assert.ok(BRIDGE_SRC.includes('clampGapV2Legacy') && BRIDGE_SRC.includes('randIntLegacy'));
  assert.ok(BRIDGE_SRC.includes("QQ_BRIDGE_SIM_DUALRUN === '1'"), '双跑开关必须在位');
  assert.ok(BRIDGE_SRC.includes('已以旧实现为准'), '不一致时必须以旧实现为准');
  assert.ok(BRIDGE_SRC.includes("from './simulation/rhythm.js'"), '必须从 seam 模块抽取');
  // 双跑对比不能吞掉告警
  assert.ok(BRIDGE_SRC.includes('[sim-dualrun]'));
  // P1.1 maxBubbles 必须在发送链路生效（canary 节奏模块内）
  assert.match(BRIDGE_SRC, /simCapBubbles\(messages, simV3Cfg\.rhythm\?\.maxBubbles\)/, '气泡上限必须接线');
});
