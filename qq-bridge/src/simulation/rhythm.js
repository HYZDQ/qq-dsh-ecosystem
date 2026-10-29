// 三代仿真节奏 seam（GEN3 P0.3）：从 bridge.js main() 抽出的纯函数（**逐字搬移，行为不变**）。
//
// 双跑过渡（P0.3）：旧实现以 Legacy 副本保留在 bridge.js 里，QQ_BRIDGE_SIM_DUALRUN=1 时
// 同随机序列双跑对比、不一致以旧为准并告警；P1.x 确认稳定后删除 Legacy 副本与开关。
// 所有随机都走可注入的 rng（默认 Math.random）——确定性测试与双跑同序列对比都靠它。

/** [min,max] 闭区间随机整数；min>max 自动交换。 */
export function randInt(min, max, rng = Math.random) {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + rng() * (max - min + 1));
}

/** 气泡间隔钳制：下限 100ms，且落在 [burstIntervalMinMs, maxGapMs] 内。 */
export function clampGapV2(ms, sendCfg) {
  const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
  const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
  return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
}

/**
 * 计算多条消息的气泡间隔（messages.length-1 个延迟；最后一条之后不再等）。
 * gapMode：'fixed'（用 gaps 数组或 gapMs）| 'byLength'（按上一泡字数）| 其余/'auto'（随机长短间隔）。
 */
export function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg, rng = Math.random) {
  const delays = [];
  if (!messages || messages.length <= 1) return delays;
  const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
  if (mode === 'fixed') {
    if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
      for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
    } else {
      const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
      for (let i = 0; i < messages.length - 1; i++) delays.push(g);
    }
  } else if (mode === 'byLength') {
    const base = Number(sendCfg.gapBaseMs) || 800;
    const perChar = Number(sendCfg.gapPerCharMs) || 20;
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      delays.push(clampGapV2(base + chars * perChar, sendCfg));
    }
  } else {
    const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
    for (let i = 0; i < messages.length - 1; i += 1) {
      const useLong = longProb > 0 && rng() < longProb;
      const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
      const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
      delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max), rng), sendCfg));
    }
  }
  return delays;
}

/**
 * P1.1 节奏校准：打字模型气泡间隔（GEN3 计划 6.4）。
 *
 *   第 i 泡间隔 = clamp( think(200~800ms)
 *                     + typing(上一泡字数 ÷ cpm × 60000 × jitter±20%)
 *                     + hesitate(0~1500ms，长文/敏感/低亲密才加) , 300, 5000 )
 *   cpm = cpmMin + (cpmMax-cpmMin) × relationship，深夜 ×0.8；
 *   单轮总延迟 ≤ maxTotalDelayMs（超出按比例缩放）。
 *
 * 返回值形状与 computeGapsV2 一致（messages.length-1 个间隔），可直接替换 auto 路径。
 * 首泡始终立即发（秒回硬约束）：本模块不产出「首泡前延迟」，也不提供对应参数。
 */
export function planDelaysV3(messages, {
  cpmMin = 40,
  cpmMax = 100,
  maxTotalDelayMs = 5000,
  relationship = 0,
  lateNight = false,
  sensitive = false,
  rng = Math.random
} = {}) {
  const delays = [];
  if (!messages || messages.length <= 1) return delays;
  const rel = Math.min(1, Math.max(0, Number(relationship) || 0));
  let cpm = Number(cpmMin) + (Number(cpmMax) - Number(cpmMin)) * rel;
  cpm = Math.min(400, Math.max(20, cpm));
  if (lateNight) cpm *= 0.8;
  for (let i = 0; i < messages.length - 1; i += 1) {
    const chars = Math.max(1, String(messages[i] ?? '').length);
    const think = 200 + rng() * 600;
    const jitter = 0.8 + rng() * 0.4;
    const typing = (chars / cpm) * 60000 * jitter;
    const hesitant = sensitive || chars > 60 || rel < 0.3;
    const hesitate = hesitant ? rng() * 1500 : 0;
    delays.push(Math.min(5000, Math.max(300, Math.round(think + typing + hesitate))));
  }
  const budget = Math.max(0, Number(maxTotalDelayMs) || 5000);
  const total = delays.reduce((a, b) => a + b, 0);
  if (budget > 0 && total > budget) {
    const scale = budget / total;
    for (let i = 0; i < delays.length; i += 1) delays[i] = Math.round(delays[i] * scale);
  }
  return delays;
}

/**
 * P1.1 气泡数上限（6.4）：超出 maxBubbles 时把剩余气泡按原顺序合并进最后一泡，
 * **不丢内容**（宁可变长也不静默截断）。maxBubbles 非法（≤0/非数字）时原样返回。
 * 非数组输入原样返回，调用方无需先判类型。
 */
export function capBubbles(messages, maxBubbles) {
  if (!Array.isArray(messages)) return messages;
  const max = Math.floor(Number(maxBubbles));
  if (!Number.isFinite(max) || max <= 0 || messages.length <= max) return messages;
  const kept = messages.slice(0, max - 1);
  const rest = messages.slice(max - 1).join('');
  return [...kept, rest];
}
