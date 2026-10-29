/**
 * dsh-douyin-agent —— host 半端
 * ============================================================================
 * 定位：**主人私聊里的抖音助手**。
 *   主人（qq-bridge 的 ownerQQ）在 QQ 私聊里说「去看看抖音」→ DSH 会话里
 *   的 agent 调本插件工具 → 插件用无头浏览器/接口采集 → 把值得的用
 *   「自己的话 + 抖音分享卡片」发回主人 QQ。
 *
 * 边界：
 *   - 只服务主人私聊（closed-agent 模式），群聊一律不碰。
 *   - 读用接口，写用无头页内 fetch；**只有看画面/扫码**才起有头窗口。
 *   - 外发一律有闸：工具要 `confirm`，后台跑一轮要 `autoSend`。
 *
 * 落盘：`$DSH_HOME/douyin-agent/`（配置 / 凭据 / 状态 / 报告 / 记忆）
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureHome, paths, pluginRoot } from './lib/paths.mjs'
import { dayKey, inWindow, readJson, writeJson } from './lib/state.mjs'
import { DEFAULTS, normalize, effectiveWindows } from './lib/config.mjs'
import { dropDouyinEvent } from './lib/computer-event.mjs'
import { createLogger } from './lib/log.mjs'
import { credentialInfo } from './lib/credential.mjs'
import { resolveBridge, bridgeStatus, sendToOwner } from './lib/qq.mjs'
import { findBrowser } from './lib/browser.mjs'
import { createTools } from './lib/tools.mjs'
import { registerPack, unregisterPack } from './lib/pack.mjs'
import { resolveRuntimePaths } from './lib/engine/runtime-paths.mjs'
import { createOutbound } from './lib/outbound.mjs'

export const name = 'douyin-agent'
export const inject = ['webServer', 'tools', 'settings']

/**
 * 🔴 每个字段都必须 `.extra('volatile', true)`：
 *    DSH 的 settings.update() 只认 volatile 字段，缺了这个标记写设置会抛
 *    "Plugin entry … has no volatile fields"。
 *    另外两个前提：loader entry 的 id 必须等于命名空间 `douyin-agent`，且本模块导出 Config。
 */
export const Config = !z ? undefined : z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).extra('volatile', true),
  perDay: z.natural().default(DEFAULTS.perDay).extra('volatile', true),
  maxPerRun: z.natural().default(DEFAULTS.maxPerRun).extra('volatile', true),
  peakValley: z.boolean().default(DEFAULTS.peakValley).extra('volatile', true),
  windows: z.array(z.object({
    start: z.string().default(''),
    end: z.string().default(''),
    label: z.string().default(''),
  })).default([]).extra('volatile', true),
  keywords: z.array(z.string()).default([]).extra('volatile', true),
  minDescLen: z.natural().default(DEFAULTS.minDescLen).extra('volatile', true),
  minComments: z.natural().default(DEFAULTS.minComments).extra('volatile', true),
  autoSend: z.boolean().default(DEFAULTS.autoSend).extra('volatile', true),
  notifyMode: z.string().default(DEFAULTS.notifyMode).extra('volatile', true),
  ownerQQ: z.string().default('').extra('volatile', true),
  bridgeBase: z.string().default('').extra('volatile', true),
  bridgeToken: z.string().default('').extra('volatile', true),
  autoreplyEnabled: z.boolean().default(false).extra('volatile', true),
  autoreplyContacts: z.array(z.string()).default([]).extra('volatile', true),
  autoreplyEverySec: z.natural().default(DEFAULTS.autoreplyEverySec).extra('volatile', true),
  sparkEnabled: z.boolean().default(false).extra('volatile', true),
  sparkContacts: z.array(z.string()).default([]).extra('volatile', true),
  sparkPerDay: z.natural().default(1).extra('volatile', true),
  mediaEnabled: z.boolean().default(false).extra('volatile', true),
  visibleForObserve: z.boolean().default(true).extra('volatile', true),
  dmTo: z.string().default('').extra('volatile', true),
  dmToId: z.string().default('').extra('volatile', true),
  mentionName: z.string().default('').extra('volatile', true),
  chromePath: z.string().default('').extra('volatile', true),
  chromePort: z.natural().default(0).extra('volatile', true),
})

const HOME = ensureHome()
const P = paths()
const log = createLogger(join(P.logs, 'agent.log'))

function pluginVersion() {
  try {
    const f = join(pluginRoot, 'package.json')
    return String(JSON.parse(readFileSync(f, 'utf8')).version || '')
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  const signature = ['perDay', 'maxPerRun', 'notifyMode', 'autoSend']

  let settingsRow = { at: 0, row: null }
  const describeRow = (fresh = false) => {
    const now = Date.now()
    if (!fresh && now - settingsRow.at < 3000) return settingsRow.row
    let row = null
    try {
      const rows = ctx.settings?.describe?.() || []
      row = rows.find((r) => r?.value && signature.every((k) => k in r.value)) || null
    } catch (e) {
      log.warn(`读 DSH 设置表单失败：${e?.message ?? e}`)
    }
    settingsRow = { at: now, row }
    return row
  }

  const fromHost = () => normalize(config || {})
  const fromDisk = () => normalize(readJson(P.config, {}))
  const cfg = { ...DEFAULTS, ...fromHost(), ...fromDisk() }
  if (!Array.isArray(cfg.windows)) cfg.windows = []
  // 宿主偶尔会把未赋值的字段传成对象（String() 会变成 "[object Object]"）——
  // 真出现过：bridgeBase / chromePath 变字符串 "[object Object]"，导致浏览器路径永远找不到。
  {
    const weird = Object.entries(cfg).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    if (weird.length) log.warn(`配置里有非预期对象值，已按默认值处理：${weird.map(([k]) => k).join(', ')}`)
  }

  const saveCfg = async (patch) => {
    const clean = normalize(patch)
    Object.assign(cfg, clean)
    const onDisk = readJson(P.config, {})
    const merged = { ...onDisk, ...clean }
    // 空值不许覆盖磁盘上已有的非空值（设置页 blur 会把空串推上来）
    for (const k of ['ownerQQ', 'bridgeToken', 'bridgeBase']) {
      if (!String(clean[k] ?? '').trim() && String(onDisk[k] ?? '').trim()) merged[k] = onDisk[k]
    }
    writeJson(P.config, merged)
    Object.assign(cfg, merged)

    const row = describeRow()
    let host = { ok: false, error: 'DSH 没有可写的设置表单（只落在插件自己的 config.json）' }
    if (row?.ns && typeof ctx.settings?.update === 'function') {
      try {
        await ctx.settings.update(row.ns, clean, row.revision)
        host = { ok: true, ns: row.ns }
      } catch (e) {
        try {
          const fresh = describeRow(true)
          await ctx.settings.update(fresh.ns, clean, fresh.revision)
          host = { ok: true, ns: fresh.ns, retried: true }
        } catch (e2) {
          host = { ok: false, error: String(e2?.message ?? e2) }
          log.warn(`写 DSH 设置失败：${host.error}`)
        }
      }
    }
    return { ok: true, host }
  }

  /* ─────────────── 每日状态 ─────────────── */
  const dayFile = join(P.state, 'day.json')
  const readDay = () => {
    const st = readJson(dayFile, {})
    const today = dayKey()
    if (st.day === today) return st
    const next = { day: today, runs: 0, picked: 0, windows: {} }
    writeJson(dayFile, next)
    return next
  }
  const bumpDay = (patch) => {
    const st = readDay()
    const next = { ...st, ...patch, windows: { ...(st.windows || {}), ...(patch.windows || {}) } }
    writeJson(dayFile, next)
    return next
  }

  const svc = {
    ctx,
    log,
    paths: P,
    version: pluginVersion(),
    outbound: createOutbound({ dir: P.state, log }),
    getCfg: () => cfg,
    saveCfg,
    readDay,
    bumpDay,
    effectiveWindows: () => effectiveWindows(cfg),
    inWindowNow: () => inWindow(effectiveWindows(cfg)),
    bridge: () => resolveBridge(cfg),
    bridgeStatus: () => bridgeStatus(resolveBridge(cfg)),
    browserOpts: (mode) => ({
      mode,
      browserPath: cfg.chromePath,
      profileDir: P.chromeProfile,
      stateFile: join(P.state, 'chrome.json'),
      port: cfg.chromePort,
      log: log.log,
    }),
    doctorBase: () => ({
      pluginVersion: pluginVersion(),
      node: process.version,
      home: P.home,
      browser: findBrowser(cfg.chromePath),
      credential: credentialInfo(P.cookie),
      bridge: resolveBridge(cfg),
      configFile: P.config,
      configExists: existsSync(P.config),
      windows: effectiveWindows(cfg),
    }),
    /** 值班链（P1 接入）：目前只占位，接入后由它起一轮采集并投递 */
    requestRun: async (reason) => ({ ok: false, error: `值班链未接入（P1）：${reason}` }),
  }

  /* ─────────────── 工具注册 ─────────────── */
  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safeJson = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const toolSpecs = createTools(svc)
  const toolsByName = new Map(toolSpecs.map((t) => [t.name, t]))

  /**
   * 写操作统一护栏（在注册处集中包一层，避免每个工具各写一份）：
   *   熔断检查 → 收据去重 → 加锁执行 → 成功记账 / 失败计数
   */
  const WRITE_TOOLS = new Set([
    'douyin_dm',
    'douyin_share_card',
    'douyin_comment_reply',
    'douyin_comment_mention',
  ])

  /** 只有基础设施类失败才计入熔断；「找不到人」「重名」这类是输入问题，不该把整个写通道停掉 */
  const INFRA_STAGES = new Set([
    'browser', 'cdp', 'page', 'run', 'render', 'icon', 'panel', 'click',
    'editor', 'editor-expand', 'fill', 'send-btn', 'post', 'peer', 'reply-target',
  ])

  const executeWrite = async (spec, args, exec) => {
    const ob = svc.outbound
    const guard = ob.checkGuard()
    if (!guard.ok) return { ok: false, blocked: true, tripped: true, until: guard.until, error: guard.error }

    const target = String(args.to || args.mention || args.recipientId || '')
    const content = [args.text || args.message || '', args.aweme_id || ''].filter(Boolean).join('|')
    const key = ob.key({ type: spec.name, target, content })
    const dup = ob.findReceipt(key)
    if (dup) {
      return {
        ok: false,
        duplicate: true,
        error: `同一内容 24 小时内已经发过（${new Date(dup.at).toLocaleString()}），没有重复发送`,
        receipt: dup,
      }
    }

    const r = await ob.withLock(spec.name, () => spec.execute(args, exec))
    // 只要真发出去了（sent:true）就记账：回读失败（如评论在审核）不等于没发，
    // 漏记会让 24h 去重拦不住、重跑就重复发送（2026-10-26 现网踩坑）。
    if (r?.ok || r?.sent === true) {
      ob.noteSuccess()
      ob.saveReceipt(key, { type: spec.name, target, preview: content.slice(0, 40) })
    } else if (r?.stage && r.stage !== 'lock' && INFRA_STAGES.has(r.stage)) {
      ob.noteFailure(r.error || '未知失败')
    }
    return r
  }

  let registered = 0
  for (const spec of toolSpecs) {
    try {
      const isWrite = WRITE_TOOLS.has(spec.name)
      ctx.tools.register(defineTool({
        ...spec,
        output: textOutput,
        async execute(args = {}, exec) {
          try {
            // preview 只验证 UI、不发送，不该被熔断/去重挡住
            const guarded = isWrite && args.preview !== true
            return safeJson(guarded ? await executeWrite(spec, args, exec) : await spec.execute(args, exec))
          } catch (e) {
            log.error(`工具 ${spec.name} 抛错：${e?.stack || e}`)
            return { ok: false, error: String(e?.message || e) }
          }
        },
      }))
      registered += 1
    } catch (e) {
      log.error(`工具 ${spec.name} 注册失败：${e?.message ?? e}`)
    }
  }

  /* ─────────────── HTTP 路由（设置页用） ─────────────── */
  const sendJson = (res, status, body) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    } catch { /* 连接已断 */ }
  }
  const readBody = async (req) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    try { return JSON.parse(text) } catch { return {} }
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    const call = async (toolName, args) => {
      const t = toolsByName.get(toolName)
      if (!t) return { ok: false, error: `未实现的工具 ${toolName}` }
      return safeJson(await t.execute(args || {}))
    }

    if (req.method === 'GET' && path === '/api/douyin-agent/config') {
      return sendJson(res, 200, { ok: true, config: cfg, windows: effectiveWindows(cfg) })
    }
    if (req.method === 'POST' && path === '/api/douyin-agent/config') {
      const body = await readBody(req)
      const r = await saveCfg(body?.patch || body || {})
      return sendJson(res, 200, { ok: true, ...r, config: cfg })
    }
    if (req.method === 'GET' && path === '/api/douyin-agent/status') {
      return sendJson(res, 200, await call('douyin_status', {}))
    }
    if (req.method === 'POST' && path === '/api/douyin-agent/doctor') {
      return sendJson(res, 200, await call('douyin_doctor', {}))
    }
    if (req.method === 'POST' && path === '/api/douyin-agent/login') {
      const body = await readBody(req)
      return sendJson(res, 200, await call('douyin_login', { action: body?.action || 'status' }))
    }
    if (req.method === 'POST' && path === '/api/douyin-agent/setup') {
      return sendJson(res, 200, await call('douyin_setup', {}))
    }
    if (req.method === 'POST' && path === '/api/douyin-agent/cookie') {
      const body = await readBody(req)
      return sendJson(res, 200, await call('douyin_config', { cookie: body?.cookie }))
    }
    if (req.method === 'GET' && path === '/api/douyin-agent/log') {
      const n = Math.max(1, Math.min(Number(url.searchParams.get('lines')) || 120, 500))
      const file = join(P.logs, 'agent.log')
      let lines = []
      try {
        if (existsSync(file)) lines = readFileSync(file, 'utf8').trim().split('\n').slice(-n)
      } catch { /* 读不到就算了 */ }
      return sendJson(res, 200, { ok: true, lines })
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/douyin-agent',
      handler: async (req, res) => {
        try {
          await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e?.message || e) })
        }
      },
    }), 'douyin-agent: /api/douyin-agent 路由')
  } catch (e) {
    log.warn(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  /* ─────────────── 谷时定时器 ─────────────── */
  let lastTick = ''
  const tick = () => {
    try {
      if (!cfg.enabled || !cfg.peakValley) return
      const w = svc.inWindowNow()
      if (!w) return
      const st = readDay()
      const key = `${dayKey()}|${w.label || `${w.start}-${w.end}`}`
      if (lastTick === key || st.windows?.[key]) return
      if ((st.picked || 0) >= (cfg.perDay || 0)) return
      lastTick = key
      bumpDay({ windows: { [key]: Date.now() } })
      log.log(`谷时窗口命中（${key}）`)
      Promise.resolve(svc.requestRun('schedule'))
        .then((r) => { if (!r?.ok) log.warn(`本轮没跑成：${r?.error || '未知原因'}`) })
        .catch((e) => log.error(`值班链抛错：${e?.message ?? e}`))
    } catch (e) {
      // 定时器回调里的异常必须自己兜住：未捕获异常会杀掉整个宿主进程
      log.error(`定时器异常：${e?.message ?? e}`)
    }
  }
  const timer = setInterval(tick, 60_000)
  ctx.effect(() => () => clearInterval(timer), 'douyin-agent: 谷时定时器')

  /* ─────────────── P3 主干-分支接线：领域包自注册 ─────────────── */
  // 把抖音领域包写进主干（computer-use）的 packs.d 注册表，任务引擎即可按 goal 路由到
  // 本包的 L1 计划；主干不可用/写失败时静默跳过（只损失领域路由，不影响工具面）。
  try {
    const computerStateDir = resolveRuntimePaths().stateDir
    registerPack(computerStateDir)
    ctx.effect(() => () => unregisterPack(computerStateDir), 'douyin-agent: 主干领域包注册')
  } catch (e) {
    log.warn(`主干领域包注册跳过：${e?.message ?? e}`)
  }

  /* ─────────────── 自动盯梢 / 续火花 ─────────────── */
  const autoFile = join(P.state, 'autoreply.json')
  const sparkFile = join(P.state, 'spark.json')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let lastAutoAt = 0
  let lastSparkAt = 0

  const notifyOwner = async (text) => {
    const conn = resolveBridge(cfg)
    if (conn.missing.length) return { ok: false, error: conn.missing.join('；') }
    const st = await bridgeStatus(conn)
    if (!st.ok) return { ok: false, error: st.error || '连不上 qq-bridge' }
    if (st.mode !== 'closed-agent') return { ok: false, error: `当前模式 ${st.mode} 不允许外发` }
    return sendToOwner(conn, text, { maxChars: 500, gapMs: 1200 })
  }

  const autoTick = async () => {
    try {
      const st = readJson(autoFile, {})
      if (!st.enabled) return
      if (Date.now() - lastAutoAt < (Number(st.everySec) || 120) * 1000) return
      lastAutoAt = Date.now()
      const tool = toolsByName.get('douyin_notices')
      if (!tool) return
      const r = await tool.execute({ limit: 20 })
      if (!r?.ok) { log.warn(`自动盯梢读取失败：${r?.error || '未知'}`); return }
      const seen = new Set(st.seen || [])
      const since = Number(st.since) || 0
      const fresh = (r.items || []).filter((it) => it.nid && !seen.has(it.nid) && Number(it.create_time) * 1000 >= since)
      if (!fresh.length) return
      for (const it of fresh) seen.add(it.nid)
      writeJson(autoFile, { ...st, seen: [...seen].slice(-500) })
      const lines = fresh.slice(0, 8).map((it, i) => {
        const meta = [
          it.aweme_id ? `aweme_id=${it.aweme_id}` : '',
          it.comment_id ? `reply_cid=${it.comment_id}` : '',
        ].filter(Boolean).join(' ')
        return `${i + 1}. ${it.user || '有人'}：${(it.text || '').slice(0, 60)}`
          + `${meta ? `\n（${meta}）` : ''}`
          + `${it.video_url ? `\n${it.video_url}` : ''}`
      })
      const tip = '要回就直接用 douyin_comment_mention(aweme_id=…, reply_cid=…, text=…, confirm=true)，不用再去翻评论。'
      // 电脑操控事件桥（§6.3 跨插件接线）：发现新动静即落事件文件，DSH 侧可按调度触发桌面联动。
      // 只记条数等元数据不带正文，失败静默不影响抖音主链路。
      dropDouyinEvent({ count: fresh.length, kinds: [...new Set(fresh.map((it) => it.kind || 'notice'))].slice(0, 5) })
      const sent = await notifyOwner(`抖音有新动静（${fresh.length} 条）：\n\n${lines.join('\n')}\n\n${tip}`)
      if (!sent.ok) log.warn(`自动盯梢推送失败：${sent.error}`)
      else log.log(`自动盯梢已推送 ${fresh.length} 条`)
    } catch (e) {
      log.error(`自动盯梢异常：${e?.message ?? e}`)
    }
  }

  const sparkTick = async () => {
    try {
      const st = readJson(sparkFile, {})
      if (!st.enabled) return
      if (Date.now() - lastSparkAt < 30 * 60 * 1000) return
      const hour = new Date().getHours()
      if (hour < 9 || hour >= 22) return
      lastSparkAt = Date.now()
      const today = dayKey()
      const rec = readJson(join(P.state, `run-${today}.json`), null)
      const v = rec?.top?.[0]
      if (!v) { log.warn('续火花：今天还没有跑过一轮，跳过'); return }
      const share = toolsByName.get('douyin_share_card')
      if (!share) return
      const sentMap = { ...(st.sent || {}) }
      for (const c of st.contacts || []) {
        if (!c?.nick) continue
        const key = `${today}|${c.nick}`
        if (sentMap[key]) continue
        const r = await share.execute({ aweme_id: v.aweme_id, to: c.nick, to_id: c.sec_uid || '', confirm: true })
        if (r?.ok) {
          sentMap[key] = Date.now()
          log.log(`续火花：已给 ${c.nick} 发分享卡片`)
          await sleep(4000)
        } else {
          log.warn(`续火花：给 ${c.nick} 发送失败（${r?.error || '未知'}）`)
        }
      }
      writeJson(sparkFile, { ...st, sent: sentMap })
    } catch (e) {
      log.error(`续火花异常：${e?.message ?? e}`)
    }
  }

  const autoTimer = setInterval(autoTick, 30_000)
  ctx.effect(() => () => clearInterval(autoTimer), 'douyin-agent: 自动盯梢定时器')
  const sparkTimer = setInterval(sparkTick, 5 * 60_000)
  ctx.effect(() => () => clearInterval(sparkTimer), 'douyin-agent: 续火花定时器')

  log.log(`已挂载 v${svc.version}（家=${P.home}，工具=${registered}，谷时=${cfg.peakValley ? '开' : '关'}）`)
  if (hostDeps.notes.length) log.log(`宿主依赖：${hostDeps.notes.join(' / ')}`)
}
