/**
 * lib/outbound.mjs —— 写操作的底座：并发锁 / 会话体检熔断 / 发送收据
 * ============================================================================
 * 三个机制解决的问题（都是真实踩过的坑）：
 *   ① 并发锁：定时器与工具同时点浏览器 → 互相打断、点到一半换人
 *   ② 熔断：连续失败（风控/掉登录/面板不挂）时继续硬发只会更糟 → 停 30 分钟
 *   ③ 收据：同一条内容重复调用会重复发（模型重试、agent 复读）→ 24 小时内去重
 *
 * 全部落在插件家目录的 state/ 下，不写插件包目录。
 * ============================================================================
 */
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from './state.mjs'

const GUARD_FAILS = 2               // 连续失败几次熔断
const GUARD_TRIP_MS = 30 * 60 * 1000 // 熔断时长
const RECEIPT_TTL_MS = 24 * 3600 * 1000
const RECEIPT_KEEP_MS = 7 * 24 * 3600 * 1000
const LOCK_STALE_MS = 10 * 60 * 1000

export function createOutbound({ dir, log } = {}) {
  const guardFile = join(dir, 'outbound-guard.json')
  const receiptFile = join(dir, 'outbound-receipts.json')
  const lockFile = join(dir, 'outbound.lock')
  let chain = Promise.resolve()

  /** 内容指纹：同类型 + 同目标 + 同内容 */
  const key = ({ type, target, content }) => createHash('sha1')
    .update(`${type}|${target}|${String(content || '')}`)
    .digest('hex')

  const checkGuard = () => {
    const g = readJson(guardFile, {})
    const until = Number(g.trippedUntil) || 0
    if (until > Date.now()) {
      return {
        ok: false,
        tripped: true,
        until,
        error: `写操作熔断中（到 ${new Date(until).toLocaleString()}）。原因：连续失败 ${g.failures || 0} 次，最近一次「${g.lastError || ''}」`,
      }
    }
    return { ok: true }
  }

  const noteSuccess = () => {
    writeJson(guardFile, { failures: 0, trippedUntil: 0, lastError: '', at: Date.now() })
  }

  const noteFailure = (error) => {
    const g = readJson(guardFile, {})
    const failures = (Number(g.failures) || 0) + 1
    const tripped = failures >= GUARD_FAILS
    writeJson(guardFile, {
      failures,
      trippedUntil: tripped ? Date.now() + GUARD_TRIP_MS : 0,
      lastError: String(error || '').slice(0, 200),
      at: Date.now(),
    })
    if (tripped) log?.warn?.(`写操作连续失败 ${failures} 次，熔断 30 分钟：${String(error || '').slice(0, 80)}`)
  }

  const findReceipt = (k) => {
    const all = readJson(receiptFile, {})
    const r = all[k]
    if (!r) return null
    if (Date.now() - (Number(r.at) || 0) > RECEIPT_TTL_MS) return null
    return r
  }

  const saveReceipt = (k, meta) => {
    const all = readJson(receiptFile, {})
    const now = Date.now()
    for (const [kk, v] of Object.entries(all)) {
      if (now - (Number(v?.at) || 0) > RECEIPT_KEEP_MS) delete all[kk]
    }
    all[k] = { ...meta, at: now }
    writeJson(receiptFile, all)
  }

  /** 文件锁：跨进程也安全（CLI 测试与插件同时跑时有用） */
  const acquire = async (timeoutMs = 120000) => {
    const started = Date.now()
    for (;;) {
      try {
        const fd = openSync(lockFile, 'wx')
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
        closeSync(fd)
        return true
      } catch {
        try {
          const st = statSync(lockFile)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { unlinkSync(lockFile); continue }
        } catch { /* 锁刚被释放 */ }
        if (Date.now() - started > timeoutMs) return false
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  }

  const release = () => { try { unlinkSync(lockFile) } catch { /* 已经没了 */ } }

  /** 进程内也串行：两个工具同时调用时排队，不抢浏览器 */
  const withLock = (label, fn, opts = {}) => {
    const run = async () => {
      const got = await acquire(opts.timeoutMs)
      if (!got) return { ok: false, stage: 'lock', error: '另一个写操作正在执行（等锁超时），请稍后再试' }
      try {
        log?.log?.(`写操作开始：${label}`)
        return await fn()
      } finally {
        release()
      }
    }
    const p = chain.then(run, run)
    chain = p.then(() => {}, () => {})
    return p
  }

  return { key, checkGuard, noteSuccess, noteFailure, findReceipt, saveReceipt, withLock }
}
