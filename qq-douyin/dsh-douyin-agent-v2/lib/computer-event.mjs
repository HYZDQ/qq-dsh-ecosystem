// 电脑操控事件桥（dsh-douyin-agent §6.3 跨插件接线）：
// 抖音侧发现「新动静」（评论/@/通知等 fresh 条目）时落事件文件到 DSH 电脑操控运行时收件箱
//   <stateDir>/computer/events/douyin-<ts>.json
// DSH 侧 EventBridge 消费后按调度配置触发桌面联动任务（仍受管理员配置/急停/预算/冷却约束）。
// 设计：文件即协议，跨插件/跨进程零依赖；失败静默不影响抖音主链路；只记条数等元数据不带正文；15s 节流。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const THROTTLE_MS = 15_000
let lastDropAt = 0

// stateDir 解析与 dsh-douyin-agent 的 runtime-paths / qq-bridge 的 computer-event-bridge 对齐。
export function resolveComputerEventsDir(env = process.env) {
  const candidates = []
  if (env.DOUYIN_STATE_DIR) candidates.push(path.join(env.DOUYIN_STATE_DIR, 'computer', 'events'))
  try {
    const locationFile = path.join(os.homedir(), '.dsh', 'douyin-browser', 'runtime-location.json')
    const stored = JSON.parse(fs.readFileSync(locationFile, 'utf8'))
    if (stored && stored.version === 1 && typeof stored.stateDir === 'string') {
      candidates.push(path.join(stored.stateDir, 'computer', 'events'))
    }
  } catch { /* 没有位置记录就继续 */ }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.dirname(dir))) return dir
    } catch { /* 下一个候选 */ }
  }
  return null
}

export function dropDouyinEvent(payload, { env = process.env, now = Date.now, throttleMs = THROTTLE_MS } = {}) {
  try {
    if (lastDropAt && now() - lastDropAt < throttleMs) return false
    const dir = resolveComputerEventsDir(env)
    if (!dir) return false
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `douyin-${now()}.json`)
    fs.writeFileSync(file, JSON.stringify({ at: now(), ...payload }))
    lastDropAt = now()
    return true
  } catch {
    return false // 事件桥失败绝不影响抖音主链路
  }
}
