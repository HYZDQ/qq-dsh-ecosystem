// 电脑操控事件桥（dsh-douyin-agent §6.3 跨仓库接线）：
// QQ 有效消息到达时落一个事件文件到 DSH 电脑操控运行时的收件箱
//   <stateDir>/computer/events/qq-message-<ts>.json
// DSH 侧 EventBridge 消费后按调度配置触发桌面联动任务（仍受管理员配置/急停/预算/冷却约束）。
// 设计：文件即协议，跨进程零依赖（无 IPC/端口）；失败静默不影响 QQ 主链路；
// 仅记元数据不带消息正文（隐私最小化，正文留在 QQ 侧档案）；15s 节流防事件风暴。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const THROTTLE_MS = 15_000;
let lastDropAt = 0;

// stateDir 解析规则与 dsh-douyin-agent 的 runtime-paths 对齐：
// env.DOUYIN_STATE_DIR 优先，其次 ~/.dsh/douyin-browser/runtime-location.json 记录的位置。
export function resolveComputerEventsDir(env = process.env) {
  const candidates = [];
  if (env.DOUYIN_STATE_DIR) candidates.push(path.join(env.DOUYIN_STATE_DIR, 'computer', 'events'));
  try {
    const locationFile = path.join(os.homedir(), '.dsh', 'douyin-browser', 'runtime-location.json');
    const stored = JSON.parse(fs.readFileSync(locationFile, 'utf8'));
    if (stored && stored.version === 1 && typeof stored.stateDir === 'string') {
      candidates.push(path.join(stored.stateDir, 'computer', 'events'));
    }
  } catch { /* 没有位置记录就继续 */ }
  for (const dir of candidates) {
    try {
      // 收件箱目录可不存在（消费方还没起），但 computer 上级目录必须已在用（否则没有消费方）。
      if (fs.existsSync(path.dirname(dir))) return dir;
    } catch { /* 下一个候选 */ }
  }
  return null;
}

// 会话身份映射（§9.3 红线二次修订的落点）：把 bridge 的「QQ 会话 ↔ DSH 会话」映射发布到
// <computer>/qq-sessions.json，DSH 侧插件按 exec.agent.session.id 反查真实身份（kind/userId），
// 运行时据此把关：群聊/非管理员只有状态工具，管理员私聊才可操控。每次 saveState 同步刷新。
export function publishQqSessionMap(sessions, { env = process.env, now = Date.now } = {}) {
  try {
    const dir = resolveComputerEventsDir(env);
    if (!dir) return false;
    const out = {};
    for (const [key, entry] of Object.entries(sessions || {})) {
      // state.sessions 的值在 bridge 里就是 DSH 会话 ID 字符串（2026-10-27 现网踩坑：
      // 只认 entry?.sessionId 会把字符串值全跳过，发出去一张空映射表，
      // 身份闸 fail-closed 把管理员也拒了）。
      const sessionId = typeof entry === 'string' ? entry : entry?.sessionId;
      if (!sessionId) continue;
      const [kind, ...rest] = String(key).split(':');
      const userId = rest.join(':');
      if (!['private', 'group'].includes(kind) || !userId) continue;
      out[String(sessionId)] = { kind, userId };
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(dir), 'qq-sessions.json'), JSON.stringify({ at: now(), sessions: out }));
    return true;
  } catch {
    return false;
  }
}

export function dropQqMessageEvent(payload, { env = process.env, now = Date.now, throttleMs = THROTTLE_MS } = {}) {
  try {
    if (lastDropAt && now() - lastDropAt < throttleMs) return false;
    const dir = resolveComputerEventsDir(env);
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `qq-message-${now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ at: now(), ...payload }));
    lastDropAt = now();
    return true;
  } catch {
    return false; // 事件桥失败绝不影响 QQ 主链路
  }
}
