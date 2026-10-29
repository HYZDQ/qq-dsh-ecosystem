/**
 * lib/douyin.mjs —— 抖音只读接口（**全部在真实页面上下文里发请求**）
 * ============================================================================
 * 为什么不在 Node 里直接 fetch：
 *   ① 抖音的 Web 接口需要页面侧签名（a_bogus / x-secsdk-web-signature）与
 *      真实浏览器的 TLS 指纹；Node 的 fetch 两样都没有。
 *   ② 无头 Chrome 里的页面本身已经加载了 secsdk，XHR/fetch 会被它自动补签名。
 *   ⇒ 所以：**读也走页面**，一条路径、一套登录态，不额外依赖 Python 与 jsdom。
 *
 * 接口事实（端点、参数、字段）来自 dsh-douyin-scroll 的实测脚本，逻辑重新实现。
 * ============================================================================
 */
import { BROWSER_UA } from './browser.mjs'

export const BASE = 'https://www.douyin.com'
export const COMMON = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  pc_client_type: '1',
  version_code: '190500',
  version_name: '19.5.0',
  cookie_enabled: 'true',
  screen_width: '1920',
  screen_height: '1080',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '141.0.0.0',
  engine_name: 'Blink',
  engine_version: '141.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  platform: 'PC',
}

/** 通知分组：700 互动 / 960 评论 / 401 粉丝 / 601 系统 */
export const NOTICE_GROUPS = [700, 960, 401, 601]

export function qs(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 隐藏无头痕迹：navigator.webdriver / languages / plugins / window.chrome */
const STEALTH_SRC = `
try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] }); } catch (e) {}
try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (e) {}
try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
`

/**
 * 在导航**之前**注入最小反检测补丁（只隐藏 webdriver 之类，**不改 UA**）。
 * 🔴 不要再加 `Network.setUserAgentOverride`：实测它会让抖音下发降级前端，
 *    评论编辑器 / 私信列表都不挂载。参考实现全程没有 UA 覆写，反而正常。
 */
export async function applyStealth(cdp) {
  try { await cdp.send('Page.enable', {}) } catch { /* 忽略 */ }
  try { await cdp.send('Runtime.enable', {}) } catch { /* 忽略 */ }
  try { await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SRC }) } catch { /* 忽略 */ }
}

/** 页面是否停在验证码/空壳页 */
async function pageLooksBlocked(cdp) {
  const title = String(await cdp.evaluate('document.title').catch(() => ''))
  const body = String(await cdp.evaluate('document.body ? document.body.innerText.slice(0,80) : ""').catch(() => ''))
  return /验证码|captcha|安全验证/i.test(title) || (!body.trim() && !title.trim())
}

/** 页面停在抖音域内且不是验证码页才发请求（否则同源 Cookie 与签名都不成立） */
export async function ensureDouyinPage(cdp, log, url = BASE + '/') {
  await applyStealth(cdp)

  const host = String(await cdp.evaluate('location.hostname').catch(() => ''))
  const onDouyin = /(^|\.)douyin\.com$/i.test(host)

  if (!onDouyin || await pageLooksBlocked(cdp)) {
    log?.(`页面需要重新进入抖音（当前 ${host || 'about:blank'}）`)
    await cdp.navigate(url)
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const ready = String(await cdp.evaluate('document.readyState').catch(() => ''))
      if (ready === 'complete') break
      await sleep(400)
    }
    await sleep(1500)
    if (await pageLooksBlocked(cdp)) {
      // 再来一次：有些情况下首帧是中间页，第二次导航才吃到正常页
      await cdp.navigate(url)
      await sleep(3500)
      if (await pageLooksBlocked(cdp)) {
        /**
         * 🔴 实测：首页经常停在「验证码中间页」，但**具体页面照样能用**
         *    （同一实例直接开 /video/<id> 就正常渲染）。所以这里不再硬失败，
         *    只带 warning 继续；真拿不到数据时下游会给出具体错误。
         */
        log?.('首页停在验证码中间页，继续尝试目标页面')
        return { ok: true, blocked: true, warning: '首页停在验证码中间页（目标页面可能仍可用）' }
      }
    }
  }

  const now = String(await cdp.evaluate('location.hostname').catch(() => ''))
  if (!/(^|\.)douyin\.com$/i.test(now)) return { ok: false, error: `导航后仍不在抖音域（${now || '未知'}）` }
  return { ok: true, reused: onDouyin }
}

/**
 * 在页面里 fetch 一个抖音接口，返回解析后的 JSON。
 * 永不抛：失败一律 { ok:false, error }。
 */
export async function pageJson(cdp, path, { timeoutMs = 25000, retry = 1 } = {}) {
  const expr = `(async () => {
    try {
      const r = await fetch(${JSON.stringify(path)}, {
        credentials: 'include',
        headers: { 'accept': 'application/json, text/plain, */*' },
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 不是 JSON */ }
      return { status: r.status, ok: r.ok, json, excerpt: json ? '' : String(text).slice(0, 300) };
    } catch (e) {
      return { status: 0, ok: false, json: null, excerpt: String(e && e.message || e) };
    }
  })()`

  let last = { ok: false, error: '未知错误' }
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    let r
    try {
      r = await cdp.evaluate(expr, { timeoutMs })
    } catch (e) {
      last = { ok: false, error: `页面内请求失败：${e?.message || e}` }
      await sleep(800)
      continue
    }
    if (!r) { last = { ok: false, error: '页面内请求没有返回' }; continue }
    if (!r.json) {
      const blank = !r.excerpt
      last = {
        ok: false,
        status: r.status,
        error: blank
          ? `接口返回 HTTP ${r.status} 但 body 为空 —— 多半是被风控挡了或登录态失效，先 douyin_login(action="open") 过一次验证`
          : `接口没返回 JSON（HTTP ${r.status}）：${String(r.excerpt).slice(0, 160)}`,
      }
      await sleep(800)
      continue
    }
    const code = r.json.status_code
    if (code !== undefined && code !== 0 && code !== null) {
      last = { ok: false, error: `接口 status_code=${code}`, status_code: code, status: r.status }
      await sleep(800)
      continue
    }
    return { ok: true, json: r.json, status: r.status }
  }
  return last
}

/* ─────────────────────────── 归一化 ─────────────────────────── */

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 递归把响应里所有"长得像 aweme"的对象收进 Map（接口结构经常变，靠特征识别更稳） */
export function collectAwemes(obj, bag = new Map()) {
  if (Array.isArray(obj)) {
    for (const v of obj) collectAwemes(v, bag)
  } else if (obj && typeof obj === 'object') {
    if (obj.aweme_id && ('desc' in obj || 'statistics' in obj)) {
      bag.set(String(obj.aweme_id), obj)
    } else {
      for (const v of Object.values(obj)) collectAwemes(v, bag)
    }
  }
  return bag
}

export function normalizeAweme(a) {
  const st = a.statistics || {}
  const author = a.author || {}
  const si = a.share_info || {}
  const dur = num(a.duration || (a.video && a.video.duration) || 0)
  const shareUrl = si.share_url || a.share_url || `https://www.iesdouyin.com/share/video/${a.aweme_id}/`
  return {
    aweme_id: String(a.aweme_id),
    desc: String(a.desc || '').trim(),
    author: String(author.nickname || ''),
    sec_uid: String(author.sec_uid || ''),
    duration_s: dur ? Math.round((dur / 1000) * 10) / 10 : null,
    digg: num(st.digg_count),
    comment: num(st.comment_count),
    collect: num(st.collect_count),
    share: num(st.share_count),
    create_time: num(a.create_time),
    share_url: shareUrl,
    share_desc: String(si.share_link_desc || '').replace('%s', shareUrl).trim(),
    web_url: `${BASE}/video/${a.aweme_id}`,
  }
}

/**
 * 打分与硬筛。判据只用结构化字段（文案/互动/时长/时间），不看画面。
 * @returns {{rows:object[], dropped:object}}
 */
export function scoreCandidates(awemes, { minDescLen = 12, minComments = 3, keywords = [], now = Date.now() / 1000 } = {}) {
  const dropped = { noDesc: 0, tooShort: 0, shortAndQuiet: 0 }
  const kws = (keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean)
  const rows = []
  for (const a of awemes) {
    const row = normalizeAweme(a)
    if (!row.desc) { dropped.noDesc += 1; continue }
    if (row.duration_s !== null && row.duration_s < 12) { dropped.tooShort += 1; continue }
    if (row.desc.length < minDescLen && row.comment < minComments) { dropped.shortAndQuiet += 1; continue }

    const ageH = row.create_time ? Math.max(0, (now - row.create_time) / 3600) : 999
    const ratio = row.digg ? row.comment / row.digg : 0
    let score = row.digg + row.comment * 2 + row.collect * 3 + row.share * 2
    if (ratio >= 0.02 && ratio <= 0.25) score *= 1.25
    if (ageH <= 72) score *= 1.15
    // 关注关键词：文案里命中的按个数加权（只加权、不硬筛，避免把池子筛空）
    let hits = 0
    if (kws.length) {
      const text = row.desc.toLowerCase()
      for (const k of kws) if (text.includes(k)) hits += 1
      if (hits) score *= 1 + Math.min(hits, 3) * 0.25
    }
    rows.push({
      ...row,
      comment_ratio: Math.round(ratio * 10000) / 10000,
      age_h: Math.round(ageH * 10) / 10,
      keyword_hits: hits,
      score: Math.round(score),
    })
  }
  rows.sort((x, y) => y.score - x.score)
  return { rows, dropped }
}

export function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return String(v)
}

/* ─────────────────────────── 具体接口 ─────────────────────────── */

export async function fetchFeed(cdp, { pages = 3, count = 20 } = {}) {
  const bag = new Map()
  const meta = []
  for (let i = 1; i <= pages; i += 1) {
    const path = `/aweme/v1/web/tab/feed/?${qs({ ...COMMON, count, refresh_index: i })}`
    const r = await pageJson(cdp, path)
    if (!r.ok) { meta.push({ src: `feed#${i}`, error: r.error }); continue }
    const before = bag.size
    collectAwemes(r.json, bag)
    meta.push({ src: `feed#${i}`, new: bag.size - before })
    await sleep(1000)
  }
  return { ok: meta.some((m) => !m.error), bag, meta }
}

export async function fetchHotSearch(cdp) {
  const path = `/aweme/v1/web/hot/search/list/?${qs({ ...COMMON, detail_list: 1 })}`
  const r = await pageJson(cdp, path)
  if (!r.ok) return { ok: false, bag: new Map(), error: r.error }
  const bag = collectAwemes(r.json)
  return { ok: true, bag, raw: r.json }
}

export async function fetchVideoDetail(cdp, awemeId) {
  const path = `/aweme/v1/web/aweme/detail/?${qs({ ...COMMON, aweme_id: awemeId })}`
  const r = await pageJson(cdp, path)
  if (!r.ok) return { ok: false, error: r.error }
  const bag = collectAwemes(r.json)
  const a = bag.get(String(awemeId))
  if (!a) return { ok: false, error: '接口没有返回这条作品' }
  return { ok: true, video: normalizeAweme(a), raw: r.json }
}

export async function fetchComments(cdp, awemeId, { pages = 3, count = 20 } = {}) {
  const seen = new Set()
  const list = []
  let hasMore = false
  for (let page = 0; page < pages; page += 1) {
    const path = `/aweme/v1/web/comment/list/?${qs({ ...COMMON, aweme_id: awemeId, count, cursor: page * count, item_type: 0 })}`
    const r = await pageJson(cdp, path)
    if (!r.ok) return { ok: list.length > 0, comments: list, error: r.error, partial: true }
    const cs = Array.isArray(r.json.comments) ? r.json.comments : []
    let fresh = 0
    for (const c of cs) {
      const cid = String(c.cid || '')
      if (!cid || seen.has(cid)) continue
      seen.add(cid)
      fresh += 1
      list.push({
        cid,
        user: String(c.user?.nickname || ''),
        text: String(c.text || '').replace(/\n/g, ' '),
        digg: num(c.digg_count),
        create_time: num(c.create_time),
        reply_id: c.reply_id ? String(c.reply_id) : '',
        replies: (Array.isArray(c.reply_comment) ? c.reply_comment : []).slice(0, 6).map((rr) => ({
          cid: String(rr.cid || ''),
          user: String(rr.user?.nickname || ''),
          text: String(rr.text || '').replace(/\n/g, ' '),
        })),
      })
    }
    hasMore = r.json.has_more === true || r.json.has_more === 1
    await sleep(900)
    if (!fresh || !hasMore) break
  }
  return { ok: true, comments: list, has_more: hasMore }
}

export async function fetchNoticeCount(cdp) {
  const path = `/aweme/v1/web/notice/count/?${qs({ ...COMMON, is_new_notice: 1, need_social_count: 1 })}`
  const r = await pageJson(cdp, path)
  if (!r.ok) return { ok: false, error: r.error }
  const counts = {}
  for (const c of r.json.notice_count || []) counts[String(c.group)] = num(c.count)
  return { ok: true, counts }
}

function normalizeNotice(it, group) {
  const sch = String(it.schema_url || '')
  const m = /aweme_id=(\d+)/.exec(sch) || /video\/(\d+)/.exec(sch)
  const cm = /(?:cid|comment_id)=(\d+)/.exec(sch)
  const awemeId = m ? m[1] : ''
  return {
    nid: String(it.nid || ''),
    type: num(it.type),
    group,
    user: String(it.user?.nickname || it.from_user?.nickname || ''),
    text: String(it.content || it.title || it.text || '').trim().slice(0, 200),
    create_time: num(it.create_time),
    aweme_id: awemeId,
    video_url: awemeId ? `${BASE}/video/${awemeId}` : '',
    comment_id: cm ? cm[1] : '',
    schema_url: sch,
  }
}

export async function fetchNotices(cdp, { groups = NOTICE_GROUPS, count = 20 } = {}) {
  const items = []
  const warnings = []
  const seen = new Set()
  for (const g of groups) {
    const path = `/aweme/v1/web/notice/?${qs({ ...COMMON, is_new_notice: 1, is_mark_read: 0, count, min_time: 0, group: g, notice_group: g })}`
    const r = await pageJson(cdp, path)
    if (!r.ok) { warnings.push(`group=${g} ${r.error}`); continue }
    for (const it of r.json.notice_list_v2 || []) {
      const nid = String(it.nid || '')
      if (!nid || seen.has(nid)) continue
      seen.add(nid)
      items.push(normalizeNotice(it, g))
    }
    await sleep(1000)
  }
  items.sort((a, b) => b.create_time - a.create_time)
  return { ok: items.length > 0 || warnings.length === 0, items, warnings }
}

/** 「评论区 @ 我」：type 45/46 */
export async function fetchAtMe(cdp) {
  const r = await fetchNotices(cdp, { groups: [960, 700] })
  const at = (r.items || []).filter((x) => x.type === 45 || x.type === 46)
  return { ok: r.ok, items: at, warnings: r.warnings || [] }
}
