/**
 * lib/credential.mjs —— 抖音 Cookie / 账号信息
 * ============================================================================
 * 🔴 明文只在**进程内存**与 `credentials/cookie.txt` 里出现；
 *    任何日志、工具返回值、HTTP 响应都必须先过 redactCookie()。
 * ============================================================================
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactCookie, readJson, writeJson } from './state.mjs'

export function saveCookie(file, raw) {
  const cookie = String(raw || '').trim()
  if (!cookie) return { ok: false, error: 'Cookie 为空' }
  if (!/sessionid|sid_tt|ttwid|passport/i.test(cookie)) {
    return { ok: false, error: '这串里没有 sessionid / ttwid 之类的关键字段，不像抖音 Cookie' }
  }
  if (/[\r\n]/.test(cookie)) return { ok: false, error: 'Cookie 不能包含换行，请粘成一整行' }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, cookie, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows 上可能无效，忽略 */ }
  return { ok: true, masked: redactCookie(cookie) }
}

export function readCookie(file) {
  try {
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

export function hasCredential(file) {
  return Boolean(readCookie(file))
}

export function credentialInfo(file) {
  try {
    if (!existsSync(file)) return { present: false, bytes: 0, mtime: 0 }
    const st = statSync(file)
    return { present: true, bytes: st.size, mtime: st.mtimeMs, masked: redactCookie(readCookie(file)) }
  } catch {
    return { present: false, bytes: 0, mtime: 0 }
  }
}

export function clearCredential(file) {
  try { rmSync(file, { force: true }); return { ok: true } } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

/** 登录号信息（扫码 / 接口拿到的 uid、昵称、sec_uid） */
export function saveAccount(file, account) {
  const prev = readJson(file, {})
  writeJson(file, { ...prev, ...account, savedAt: Date.now() })
}

export function readAccount(file) {
  return readJson(file, {})
}
