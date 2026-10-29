/**
 * lib/browser.mjs —— 双模式浏览器（默认无头 / 按需有头）
 * ============================================================================
 * 一个 profile 只能被一个实例占用，所以两种模式**互斥**：
 *   要切模式就先关掉当前实例，再用同一个 `user-data-dir` 重开 —— 登录态因此不会丢。
 *
 * 状态落在 `<家>/state/chrome.json`：{ pid, port, mode, startedAt }。
 * CDP 走 `--remote-allow-origins=*`，否则新版 Chrome 会拒掉非浏览器客户端的 WS。
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readJson, writeJson } from './state.mjs'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

/**
 * 不再覆写 UA。
 * 🔴 2026-10-24 实测结论：之前为了绕验证码加了 `--user-agent=Chrome/141`，
 *    结果抖音按这个 UA 下发了一套**降级前端** —— 评论输入框永远不挂 DraftJS 编辑器、
 *    私信列表永远是 0 尺寸。去掉 UA 覆写（跟参考实现一致）后，编辑器立刻正常挂载。
 *    验证码页在已登录的 profile 上不会再挡路，所以这条覆盖本来就不该留。
 */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export function findBrowser(explicit = '') {
  const want = String(explicit || '').trim()
  if (want) return existsSync(want) ? want : ''
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p
  return ''
}

function isPortFree(port) {
  const r = spawnSync(process.platform === 'win32' ? 'netstat' : 'true', process.platform === 'win32' ? ['-ano'] : [], {
    encoding: 'utf8',
    timeout: 4000,
    windowsHide: true,
  })
  if (r.status !== 0 || !r.stdout) return true
  return !new RegExp(`[:.]${port}\\s`).test(r.stdout)
}

function pickPort(preferred = 0) {
  if (preferred) return preferred
  for (let p = 9333; p < 9400; p += 1) if (isPortFree(p)) return p
  return 9333
}

async function probe(port) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 1200)
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal })
    clearTimeout(t)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 等 CDP 端口就绪（最多 ~15 秒） */
async function waitReady(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await probe(port)
    if (v) return v
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

export function readChromeState(file) {
  return readJson(file, null)
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch { /* 已经退了 */ }
}

export function stopChrome(stateFile, log) {
  const st = readChromeState(stateFile)
  if (!st?.pid) return { ok: true, stopped: false }
  killTree(st.pid)
  try { rmSync(stateFile, { force: true }) } catch { /* 忽略 */ }
  log?.(`已关闭 ${st.mode === 'visible' ? '有头' : '无头'} Chrome（pid=${st.pid}）`)
  return { ok: true, stopped: true }
}

/**
 * 确保当前有一个可用的实例；必要时切换模式。
 * @param {'headless'|'visible'} mode
 * @param {boolean} reuseAny 为 true 时，只要现有实例活着就复用（读数据时用）——
 *   否则会把用户刚打开的有头登录窗口关掉，体验很差。
 */
export async function ensureChrome({
  mode = 'headless',
  browserPath = '',
  profileDir,
  stateFile,
  port = 0,
  startUrl = 'https://www.douyin.com/',
  log,
  timeoutMs = 20000,
  reuseAny = false,
} = {}) {
  const exe = findBrowser(browserPath)
  if (!exe) return { ok: false, error: '没找到 Chrome / Edge，可在设置里填浏览器路径' }

  const prev = readChromeState(stateFile)
  if (prev?.pid) {
    const alive = prev.port ? await probe(prev.port) : null
    if (alive && (prev.mode === mode || reuseAny)) {
      return { ok: true, port: prev.port, mode: prev.mode, reused: true, browser: exe }
    }
    stopChrome(stateFile, log)
  }

  const chosen = pickPort(Number(port) || 0)
  mkdirSync(profileDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${chosen}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    '--window-size=1440,900',
  ]
  if (mode === 'headless') args.push('--headless=new')
  args.push(startUrl)

  let child
  try {
    child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: mode === 'headless' })
    child.unref()
  } catch (e) {
    return { ok: false, error: `启动浏览器失败：${e?.message || e}` }
  }

  const ver = await waitReady(chosen, timeoutMs)
  if (!ver) {
    killTree(child.pid)
    return { ok: false, error: `浏览器起来了但 CDP ${chosen} 没响应（可能 profile 被占用）` }
  }

  const state = {
    pid: child.pid,
    port: chosen,
    mode,
    browser: exe,
    browserVersion: ver?.Browser || '',
    startedAt: Date.now(),
  }
  writeJson(stateFile, state)
  log?.(`已启动${mode === 'headless' ? '无头' : '有头'} Chrome（pid=${child.pid} port=${chosen}）`)
  return { ok: true, ...state, reused: false }
}

/**
 * 极简 CDP 客户端（一条 WS 连接，按 id 配对请求）
 */
export async function connectCdp(port) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 5000)
  let list
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal })
    list = await res.json()
  } finally {
    clearTimeout(t)
  }
  const page = (Array.isArray(list) ? list : []).find((x) => x?.type === 'page' && x.webSocketDebuggerUrl)
  if (!page) throw new Error('没有可用的页面目标（浏览器可能还没打开抖音）')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`CDP 连接失败：${e?.message || 'error'}`)) }, { once: true })
  })

  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg?.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message || 'CDP 错误'}${msg.error.data ? ` (${msg.error.data})` : ''}`))
      else resolve(msg.result)
    }
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    try { ws.send(JSON.stringify({ id, method, params })) } catch (e) { pending.delete(id); reject(e) }
  })

  // 参考实现连上就 enable Page + Runtime；Runtime 没开时个别页面求值行为会不一致
  try { await send('Page.enable', {}) } catch { /* 忽略 */ }
  try { await send('Runtime.enable', {}) } catch { /* 忽略 */ }

  return {
    send,
    close: () => { try { ws.close() } catch { /* 忽略 */ } },
    async evaluate(expression, { awaitPromise = true, timeoutMs = 20000 } = {}) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        timeout: timeoutMs,
        userGesture: true,
      })
      if (r?.exceptionDetails) {
        const d = r.exceptionDetails
        throw new Error(d.exception?.description || d.text || '页面内脚本抛错')
      }
      return r?.result?.value
    },
    async navigate(url) {
      await send('Page.enable', {})
      await send('Page.navigate', { url })
    },
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      return r?.data || ''
    },
  }
}

/** 组合封装：确保浏览器 + 连上 CDP，用完关连接（不关进程） */
export async function withPage(opts, fn) {
  const b = await ensureChrome(opts)
  if (!b.ok) return { ok: false, error: b.error }
  const cdp = await connectCdp(b.port)
  try {
    const value = await fn(cdp, b)
    return { ok: true, port: b.port, mode: b.mode, value }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    cdp.close()
  }
}
