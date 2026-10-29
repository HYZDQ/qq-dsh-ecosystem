/**
 * lib/memo.mjs —— 记忆与兴趣
 * ============================================================================
 * 两个文件，职责分开：
 *   `memory/notes.jsonl`  逐条追加的记忆（追加写，坏了也只丢最后一行）
 *   `state/interests.json` 兴趣台账（按 topic 聚合，带证据 id）
 *
 * 🔴 写之前一律过 scrub：凭据、本机路径、长数字不进记忆。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readJson, writeJson } from './state.mjs'
import { scrub } from './log.mjs'

const MAX_NOTES = 5000

export function appendNote(file, { content, kind = 'note', source = 'agent', tags = [] }) {
  const text = scrub(String(content || '')).trim()
  if (!text) return { ok: false, error: '内容为空' }
  mkdirSync(dirname(file), { recursive: true })
  const row = {
    at: Date.now(),
    kind: String(kind || 'note').slice(0, 40),
    source: String(source || 'agent').slice(0, 40),
    tags: Array.isArray(tags) ? tags.map((t) => String(t).slice(0, 20)).slice(0, 6) : [],
    content: text.slice(0, 4000),
  }
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
  return { ok: true, row }
}

export function readNotes(file) {
  try {
    if (!existsSync(file)) return []
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const rows = []
    for (const line of lines.slice(-MAX_NOTES)) {
      try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    return rows
  } catch {
    return []
  }
}

export function searchNotes(file, query, limit = 10) {
  const q = String(query || '').trim().toLowerCase()
  const rows = readNotes(file)
  const hit = q
    ? rows.filter((r) => `${r.content || ''} ${(r.tags || []).join(' ')} ${r.kind || ''}`.toLowerCase().includes(q))
    : rows
  return hit.slice(-limit).reverse()
}

/* ─────────────────────────── 兴趣 ─────────────────────────── */

export function loadInterests(file) {
  const data = readJson(file, null)
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return { items: [], evidence: {} }
  return { items: data.items, evidence: data.evidence && typeof data.evidence === 'object' ? data.evidence : {} }
}

export function addInterest(file, { evidenceId, topic, signal, reflection }) {
  const id = String(evidenceId || '').trim()
  const t = String(topic || '').trim().slice(0, 80)
  const sig = ['like', 'dislike', 'neutral'].includes(signal) ? signal : 'neutral'
  const why = scrub(String(reflection || '')).trim().slice(0, 600)
  if (!id || !t) return { ok: false, error: 'evidenceId 与 topic 必填' }
  if (why.length < 4) return { ok: false, error: 'reflection 太短，至少写清楚为什么' }

  const data = loadInterests(file)
  // 同一条证据只记一次（防止 agent 复读同一条记录刷分）
  if (data.evidence[id]) {
    return { ok: true, duplicate: true, topic: data.evidence[id].topic, note: '这条证据已经记过，未重复写入' }
  }

  const now = Date.now()
  let item = data.items.find((x) => x.topic === t)
  if (!item) {
    item = { topic: t, like: 0, dislike: 0, neutral: 0, lastAt: now, reflections: [] }
    data.items.push(item)
  }
  item[sig] = (item[sig] || 0) + 1
  item.lastAt = now
  item.reflections = [...(item.reflections || []), why].slice(-5)

  data.evidence[id] = { topic: t, signal: sig, at: now }
  const evIds = Object.keys(data.evidence)
  if (evIds.length > 2000) {
    for (const key of evIds.slice(0, evIds.length - 2000)) delete data.evidence[key]
  }
  data.items.sort((a, b) => (b.like - b.dislike) - (a.like - a.dislike))
  data.items = data.items.slice(0, 200)
  writeJson(file, data)
  return { ok: true, topic: t, signal: sig }
}

/** 兴趣摘要（给人设用）：喜欢 / 不喜欢各取前几条 */
export function interestSummary(file, top = 6) {
  const { items } = loadInterests(file)
  const liked = items.filter((x) => x.like > x.dislike).slice(0, top).map((x) => x.topic)
  const disliked = items.filter((x) => x.dislike > x.like).slice(0, top).map((x) => x.topic)
  return { liked, disliked, total: items.length }
}
