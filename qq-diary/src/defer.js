// 活跃期延后（GEN3_SURFACE_INTEGRATION_PLAN §17.5 第 4 条）：
// 生成日记时若主人最近 N 分钟还在说话，先延后到安静或上限（maxDeferMinutes）。
//
// 语义：
//   · 跨零点仍按触发时的「前一天」生成（dateKey 在触发瞬间固定，延后不改日期）；
//   · 延后状态写 state/diary-defer.json，进程重启后可继续补写 pendingDate；
//   · deferIfActiveMinutes=0（默认）＝关闭，零行为变化（v1.4 建议先关观察）。
import fs from 'node:fs';
import path from 'node:path';

function deferFile(config) {
  return path.join(String(config.stateDir ?? ''), 'diary-defer.json');
}

export function loadDeferState(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(deferFile(config), 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.pendingDate === 'string') return raw;
  } catch { /* 无文件/损坏按无延后处理 */ }
  return null;
}

export function saveDeferState(config, state) {
  try {
    fs.mkdirSync(path.dirname(deferFile(config)), { recursive: true });
    fs.writeFileSync(deferFile(config), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function clearDeferState(config) {
  try { fs.unlinkSync(deferFile(config)); } catch { /* 不存在即已清 */ }
}

/**
 * 主人最近一次说话时间（owner 私聊的最新消息时间戳，毫秒）。
 * 读桥接 state/social-v2.json（只读）；任何异常返回 0（不延后，宁可按时写）。
 */
export function ownerLastActiveAt(config, ownerQQ) {
  try {
    const file = path.join(String(config.qqBridgeDir ?? ''), 'state', 'social-v2.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const convs = raw?.conversations;
    const ownerKey = ownerQQ ? `private:${String(ownerQQ)}` : '';
    const st = convs instanceof Map ? convs.get(ownerKey) : convs?.[ownerKey];
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    let last = 0;
    for (const m of recent) last = Math.max(last, Number(m?.time) || 0);
    return last;
  } catch {
    return 0;
  }
}

/** sleep（可注入 timers，便于测试）。 */
const sleep = (ms, timers) => new Promise((resolve) => {
  const t = timers?.setTimeout ?? setTimeout;
  t(resolve, ms);
});

/**
 * 活跃期延后：主人还在说话就等，直到安静（deferIfActiveMinutes 内无新消息）或超上限。
 * @returns {{deferredMs:number, reason:'quiet'|'max'|'off'|'not-active'}}
 */
export async function deferIfOwnerActive({
  config,
  ownerQQ,
  logger = null,
  now = () => Date.now(),
  checkIntervalMs = 60_000,
  timers = null
} = {}) {
  const deferMinutes = Number(config?.surface?.deferIfActiveMinutes) > 0 ? Number(config.surface.deferIfActiveMinutes) : 0;
  const maxDeferMinutes = Number(config?.surface?.maxDeferMinutes) > 0 ? Number(config.surface.maxDeferMinutes) : 60;
  if (deferMinutes <= 0) return { deferredMs: 0, reason: 'off' };

  const deferWindowMs = deferMinutes * 60_000;
  const maxDeferMs = maxDeferMinutes * 60_000;
  const startedAt = now();
  const lastActive = ownerLastActiveAt(config, ownerQQ);
  if (!lastActive || startedAt - lastActive > deferWindowMs) return { deferredMs: 0, reason: 'not-active' };

  logger?.info?.(`[defer] 主人最近 ${Math.round((startedAt - lastActive) / 60000)} 分钟内还在说话，延后生成（最多 ${maxDeferMinutes} 分钟）`);
  while (now() - startedAt < maxDeferMs) {
    await sleep(Math.min(checkIntervalMs, maxDeferMs - (now() - startedAt)), timers);
    const active = ownerLastActiveAt(config, ownerQQ);
    if (!active || now() - active > deferWindowMs) {
      return { deferredMs: now() - startedAt, reason: 'quiet' };
    }
  }
  return { deferredMs: now() - startedAt, reason: 'max' };
}
