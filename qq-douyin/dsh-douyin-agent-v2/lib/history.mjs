/**
 * lib/history.mjs —— 已推荐作品的去重台账
 * ============================================================================
 * 目的：一轮里挑过的作品，N 天内不再推给主人（人设里写了「同一个作者/同一类内容
 * 连着出现只挑一条」，这条是它的机械保障）。
 * ============================================================================
 */
import { readJson, writeJson } from './state.mjs'

const DEFAULT_DAYS = 7

export function loadHistory(file) {
  const h = readJson(file, null)
  if (!h || typeof h !== 'object' || !h.items || typeof h.items !== 'object') return { items: {} }
  return h
}

/** 是否在去重窗口内 */
export function isRecent(history, awemeId, days = DEFAULT_DAYS, now = Date.now()) {
  const at = Number(history.items?.[awemeId]) || 0
  return at > 0 && now - at < days * 24 * 3600 * 1000
}

/** 标记已推荐，并顺手剪掉过期记录 */
export function markSeen(history, awemeIds, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const items = { ...(history.items || {}) }
  for (const id of awemeIds) if (id) items[String(id)] = now
  const cutoff = now - days * 24 * 3600 * 1000
  for (const [id, at] of Object.entries(items)) if (!(Number(at) >= cutoff)) delete items[id]
  return { items }
}

export function saveHistory(file, history) {
  writeJson(file, history)
}
