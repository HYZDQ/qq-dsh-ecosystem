/**
 * lib/qq.mjs —— 往 qq-bridge 投递（本插件唯一的外发出口）
 * ============================================================================
 * 通道：qq-bridge 的 **操作者** 面（`x-console-token`），不是会话令牌面。
 *   只有 `closed-agent` 模式下才允许发消息，且只允许发给 owner 本人 ——
 *   这正是本插件的定位（主人私聊），群聊一律不碰。
 *
 * 端点：POST {base}/api/send/private   body { userId, message }
 * 鉴权：header `x-console-token`
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pluginRoot } from './paths.mjs'
import { readJson } from './state.mjs'

/** qq-bridge 仓库根：环境变量 → 与本插件并排的常见位置 → DSH 家目录 */
export function locateBridgeRoot() {
  const candidates = []
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p) }
  push(process.env.QQ_BRIDGE_ROOT)
  push(resolve(pluginRoot, '..', '..', 'qq-bridge'))     // d:\github\qq-douyin\..\..\qq-bridge
  push(resolve(pluginRoot, '..', '..', '..', 'qq-bridge'))
  push('D:/github/qq-bridge')
  push(join(homedir(), 'qq-bridge'))
  return candidates.find((p) => existsSync(join(p, 'config.json'))) || ''
}

export function readBridgeConfig(root) {
  if (!root) return {}
  return readJson(join(root, 'config.json'), {})
}

/** 控制台令牌：插件配置 → qq-bridge config.json → state/console-token */
function resolveToken(root, bridgeConfig, override) {
  const direct = typeof override === 'string' ? override.trim() : ''
  if (direct && /^[\x21-\x7e]+$/.test(direct)) return { token: direct, from: 'config' }
  const cfgToken = String(bridgeConfig?.consoleToken || '').trim()
  if (cfgToken) return { token: cfgToken, from: 'qq-bridge/config.json' }
  try {
    const f = join(root, 'state', 'console-token')
    if (existsSync(f)) {
      const t = readFileSync(f, 'utf8').trim()
      if (t) return { token: t, from: 'qq-bridge/state/console-token' }
    }
  } catch { /* 没有就算了 */ }
  return { token: '', from: 'none' }
}

/**
 * 解析投递连接参数。返回的 `missing` 里列出还缺什么，工具层据此给可执行的下一步。
 */
export function resolveBridge(cfg = {}) {
  const root = locateBridgeRoot()
  const bridgeConfig = readBridgeConfig(root)
  const port = Number(bridgeConfig?.consolePort) || 3100
  const rawBase = String(cfg.bridgeBase || '').trim().replace(/\/+$/, '')
  // 只接受真正的 http(s) 地址；宿主偶尔会把未赋值字段传成对象，String() 会得到 "[object Object]"
  const base = /^https?:\/\/[^\s]+$/.test(rawBase) ? rawBase : `http://127.0.0.1:${port}`
  const { token, from } = resolveToken(root, bridgeConfig, cfg.bridgeToken)
  const ownerQQ = String(cfg.ownerQQ || bridgeConfig?.ownerQQ || '').replace(/\D/g, '')
  const missing = []
  if (!root) missing.push('找不到 qq-bridge 目录（可设 QQ_BRIDGE_ROOT）')
  if (!token) missing.push('拿不到 qq-bridge 控制台令牌（可在设置里填）')
  if (!ownerQQ) missing.push('拿不到主人 QQ（qq-bridge 的 ownerQQ 为空）')
  return { root, base, token, tokenFrom: from, ownerQQ, missing }
}

async function call(conn, path, { method = 'POST', body, timeoutMs = 20000 } = {}) {
  const url = `${conn.base}${path}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-console-token': conn.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 500) } }
    return { ok: res.ok && data?.ok !== false, status: res.status, data, error: res.ok ? (data?.error || '') : (data?.error || `HTTP ${res.status}`) }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e?.name === 'AbortError' ? '请求超时' : String(e?.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 只读探活：拿运行模式与 owner */
export async function bridgeStatus(conn) {
  if (conn.missing.length) return { ok: false, error: conn.missing.join('；'), missing: conn.missing }
  const r = await call(conn, '/api/status', { method: 'GET', timeoutMs: 8000 })
  if (!r.ok) return { ok: false, error: r.error, status: r.status }
  return {
    ok: true,
    mode: r.data?.mode || '',
    ownerQQ: r.data?.ownerQQ ?? null,
    dshReady: r.data?.dshReady === true,
    paused: r.data?.socialV2Paused === true,
  }
}

/** 按字数切成多条，优先在标点处断（不把一句话拆成半句） */
export function splitMessage(text, maxChars = 500) {
  const src = String(text ?? '').trim()
  if (!src) return []
  if (src.length <= maxChars) return [src]
  const out = []
  let rest = src
  const soft = /[。！？!?；;…\n]/
  while (rest.length > maxChars) {
    let cut = -1
    for (let i = maxChars; i >= Math.floor(maxChars * 0.5); i -= 1) {
      if (soft.test(rest[i - 1])) { cut = i; break }
    }
    if (cut < 0) cut = maxChars
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 给主人发一条文本（超长自动分条 + 间隔）。
 * @returns {Promise<{ok:boolean, sent:number[], error?:string}>}
 */
export async function sendToOwner(conn, text, { maxChars = 500, gapMs = 1200 } = {}) {
  if (conn.missing.length) return { ok: false, sent: [], error: conn.missing.join('；') }
  const chunks = splitMessage(text, maxChars)
  if (!chunks.length) return { ok: false, sent: [], error: '内容为空' }
  const sent = []
  for (let i = 0; i < chunks.length; i += 1) {
    if (i > 0) await sleep(gapMs)
    const r = await call(conn, '/api/send/private', {
      body: { userId: conn.ownerQQ, message: chunks[i] },
    })
    if (!r.ok) return { ok: false, sent, error: r.error || `第 ${i + 1} 条发送失败`, status: r.status }
    sent.push(chunks[i].length)
  }
  return { ok: true, sent }
}
