/**
 * lib/state.mjs —— 小工具：JSON 读写、日期键、时段判断
 * ============================================================================
 * 只做"不抛异常"的读写；写盘用临时文件 + rename，避免半截 JSON。
 * ============================================================================
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 本地日期键 YYYY-MM-DD */
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时间键 HH:MM */
export function clockKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 'HH:MM' → 分钟数 */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/**
 * 当前时间是否落在某个时段里。支持跨零点（23:00–02:00）。
 * @param {{start:string,end:string,label?:string}[]} windows
 */
export function inWindow(windows, now = new Date()) {
  const cur = now.getHours() * 60 + now.getMinutes()
  for (const w of windows || []) {
    const s = minutesOf(w?.start)
    const e = minutesOf(w?.end)
    if (s === null || e === null) continue
    if (s === e) continue
    if (s < e) {
      if (cur >= s && cur < e) return w
    } else if (cur >= s || cur < e) {
      return w
    }
  }
  return null
}

/** 内置默认时段：中午 12:00–14:00、夜间 18:00–09:00 */
export const DEFAULT_WINDOWS = [
  { start: '12:00', end: '14:00', label: '中午' },
  { start: '18:00', end: '09:00', label: '夜间' },
]

/** Cookie 脱敏：日志与工具返回值里绝不出现明文 */
export function redactCookie(cookie) {
  const s = String(cookie || '').trim()
  if (!s) return ''
  const pairs = s.split(';').map((x) => x.trim()).filter(Boolean)
  const keep = ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'odin_tt']
  const out = []
  for (const pair of pairs) {
    const i = pair.indexOf('=')
    if (i < 0) continue
    const k = pair.slice(0, i)
    const v = pair.slice(i + 1)
    out.push(keep.includes(k) ? `${k}=***${v.slice(-4)}` : `${k}=***`)
  }
  return out.slice(0, 8).join('; ') + (pairs.length > 8 ? ` …(+${pairs.length - 8})` : '')
}
