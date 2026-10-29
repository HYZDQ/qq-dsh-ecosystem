/**
 * lib/tools.mjs —— 工具实现（P0 第一批）
 * ============================================================================
 * 约定：
 *   - 每个工具的 `parameters` 都是标准 JSON Schema（object + additionalProperties:false）
 *   - 返回值一律是「可无损 JSON 化」的对象；错误用 { ok:false, error }，绝不抛到宿主
 *   - **永不静默降级**：拿不到就写 `ok:false` + 具体原因 + 下一步动作，不编数据
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { credentialInfo, saveCookie, readAccount } from './credential.mjs'
import { ensureChrome, connectCdp, readChromeState } from './browser.mjs'
import { sendToOwner } from './qq.mjs'
import { dayKey, inWindow, readJson, writeJson } from './state.mjs'
import { effectiveWindows } from './config.mjs'
import { loadHistory, isRecent, markSeen, saveHistory } from './history.mjs'
import { appendNote, searchNotes, addInterest, interestSummary, loadInterests } from './memo.mjs'
import { VideoLimits, resolveSharedVideoStateDir } from './video-limits.mjs'
import { PersonaMemory } from './persona-memory.mjs'
import { resolveQqPrivateCard } from './qq-persona.mjs'
import {
  BASE, NOTICE_GROUPS, ensureDouyinPage, fetchFeed, fetchHotSearch, fetchVideoDetail,
  fetchComments, fetchNotices, fetchNoticeCount, fetchAtMe, scoreCandidates, fmtCount,
} from './douyin.mjs'

const empty = () => ({ type: 'object', properties: {}, additionalProperties: false })

const clamp = (v, lo, hi) => {
  const n = Number(v)
  return Math.max(lo, Math.min(Number.isFinite(n) ? Math.trunc(n) : lo, hi))
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

const mouseMove = (cdp, x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
const mouseClick = async (cdp, x, y) => {
  await mouseMove(cdp, x, y)
  await sleepMs(120)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

/**
 * 真实鼠标轨迹 hover。
 * 🔴 抖音的分享图标没有 onClick，是 onMouseEnter 触发的弹层 —— `el.click()` 打不开（实测过）。
 */
async function hoverTrack(cdp, x, y, { from = [20, 20], steps = 8, stepMs = 70 } = {}) {
  await mouseMove(cdp, from[0], from[1])
  await sleepMs(250)
  for (let i = 1; i <= steps; i += 1) {
    const nx = Math.round(from[0] + ((x - from[0]) * i) / steps)
    const ny = Math.round(from[1] + ((y - from[1]) * i) / steps)
    await mouseMove(cdp, nx, ny)
    await sleepMs(stepMs)
  }
  await mouseMove(cdp, x, y)
}

const IM_URL = 'https://www.douyin.com/chat'

/** 会话列表：昵称 / sec_uid / 未读 / 预览 / 点击坐标 */
const IM_CONV_JS = `(() => {
  const out = [];
  document.querySelectorAll('[data-e2e="conversation-item"]').forEach((n) => {
    const fk = Object.keys(n).find((k) => k.indexOf('__reactFiber$') === 0);
    let sec = '', unread = 0;
    if (fk) {
      let f = n[fk], d = 0;
      while (f && d < 14) {
        const p = f.memoizedProps;
        if (p && p.conversation && p.conversation.toParticipantSecUserId) {
          sec = String(p.conversation.toParticipantSecUserId);
          unread = Number(p.conversation.unreadCount) || 0;
          break;
        }
        f = f.return; d++;
      }
    }
    const r = n.getBoundingClientRect();
    const lines = (n.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const tEl = n.querySelector('[class*="ConversationItemtitle"],[class*="ConversationItemTitle"],[class*="nickname"],[class*="Nickname"]');
    let rawNick = (tEl && (tEl.innerText || '').trim()) || lines[0] || '';
    // 昵称和时间在同一行里，剥掉尾部的相对时间/时刻
    const nick = rawNick.replace(/(刚刚|\\d+\\s*分钟前|\\d+\\s*小时前|\\d+\\s*天前|昨天|\\d{1,2}:\\d{2}|\\d{2}-\\d{2})$/, '').trim();
    out.push({
      sec_uid: sec,
      nick: nick.slice(0, 40),
      preview: lines.slice(1).join(' ').slice(0, 90),
      unread,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
      visible: r.width > 40 && r.height > 20 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    });
  });
  return out;
})()`

/**
 * 消息列表读取。
 * 🔴 谁发的判定：看那块 36×36 头像落在列表左半边（对方）还是右半边（我）。
 *    同一人连发时只有最早那条带头像 ⇒ 倒着遍历继承，继承不到的记 unknown（不猜）。
 *    `message.isMyMessage` 恒为 true（对方发的也是），不能用。
 */
const IM_READ_JS = `(() => {
  const listNode = document.querySelector('[class*="messageMessageList"]')
    || document.querySelector('[class*="componentsRightPanel"]') || document.body;
  const lb = listNode.getBoundingClientRect();
  const mid = lb.left + lb.width / 2;
  const out = [];
  const seen = new WeakSet();
  document.querySelectorAll('[class*="messageMessageBox"]').forEach((n) => {
    const fk = Object.keys(n).find((k) => k.indexOf('__reactFiber$') === 0);
    if (!fk) return;
    let f = n[fk], d = 0, found = null;
    while (f && d < 24) {
      const p = f.memoizedProps;
      if (p && p.message && p.message.parsedContent) { found = p.message; break; }
      f = f.return; d++;
    }
    if (!found || seen.has(found)) return;
    seen.add(found);
    const r = n.getBoundingClientRect();
    let side = '';
    const im = Array.from(n.querySelectorAll('img')).find((img) => {
      const b = img.getBoundingClientRect();
      if (b.width < 28 || b.width > 48) return false;
      if (Math.abs(b.width - b.height) > 6) return false;
      const cy = b.top + b.height / 2;
      return cy >= r.top - 2 && cy <= r.bottom + 2;
    });
    if (im) {
      const ib = im.getBoundingClientRect();
      side = (ib.left + ib.width / 2) < mid ? 'them' : 'me';
    }
    const pc = found.parsedContent || {};
    out.push({
      own: side,
      text: String(pc.text || pc.content_title || '').replace(/\\s+/g, ' ').trim(),
      awe: pc.aweType || 0,
      item: pc.itemId ? String(pc.itemId) : '',
    });
  });
  return out;
})()`

/** 右栏当前对端：昵称 + sec_uid（用来核对"点开的是不是目标"） */
const IM_PEER_JS = `(() => {
  const panel = document.querySelector('[class*="componentsRightPanel"]');
  if (!panel) return { ok: false, error: 'no-panel' };
  let sec = '';
  const fk = Object.keys(panel).find((k) => k.indexOf('__reactFiber$') === 0);
  if (fk) {
    let f = panel[fk], d = 0;
    while (f && d < 16) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        const c = p.conversation || p.curConversation;
        if (c && c.toParticipantSecUserId) { sec = String(c.toParticipantSecUserId); break; }
      }
      f = f.return; d++;
    }
  }
  const lines = (panel.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
  return { ok: true, sec_uid: sec, header: lines[0] || '' };
})()`

const IM_EDITOR_JS = `(() => {  const eds = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
  for (const e of eds) {
    const r = e.getBoundingClientRect();
    if (r.width > 80 && r.height > 10) {
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    }
  }
  return null;
})()`

/** 打开私信页并等列表渲染好（列表是懒渲染，必须等出至少一项） */
async function openImPage(cdp) {
  await cdp.navigate(IM_URL)
  await sleepMs(5000)
  for (let i = 0; i < 12; i += 1) {
    const n = Number(await cdp.evaluate(`document.querySelectorAll('[data-e2e="conversation-item"]').length`).catch(() => 0)) || 0
    if (n > 0) return { ok: true, count: n }
    await sleepMs(800)
  }
  return { ok: false, error: '私信会话列表没渲染出来（可能未登录）' }
}

function inheritSender(list) {
  let carry = ''
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].own) carry = list[i].own
    list[i].from = list[i].own || carry || 'unknown'
  }
  return list
}

/** 在会话列表里找目标：优先 sec_uid（不会重名），其次精确昵称，最后宽松包含 */
function findConv(convs, who) {
  if (!Array.isArray(convs) || !convs.length) return { ok: false, error: '会话列表为空' }
  if (!who) return { ok: false, error: '没给目标' }
  const byUid = convs.filter((c) => c.sec_uid && c.sec_uid === who)
  if (byUid.length === 1) return { ok: true, conv: byUid[0] }
  const byNick = convs.filter((c) => c.nick === who)
  if (byNick.length === 1) return { ok: true, conv: byNick[0] }
  if (byNick.length > 1) {
    return {
      ok: false,
      error: `会话列表里有 ${byNick.length} 个同名「${who}」，请改用 sec_uid`,
      candidates: byNick.map((c) => ({ nick: c.nick, sec_uid: c.sec_uid })),
    }
  }
  const loose = convs.filter((c) => c.nick && (c.nick.includes(who) || who.includes(c.nick)))
  if (loose.length === 1) return { ok: true, conv: loose[0], loose: true }
  return {
    ok: false,
    error: `会话列表里没有「${who}」（只列有消息往来的会话）`,
    candidates: convs.slice(0, 10).map((c) => ({ nick: c.nick, sec_uid: c.sec_uid })),
  }
}

const PAGE_STATE_JS = `(() => {
  const v = document.querySelector('video');
  return {
    title: document.title || '',
    url: location.href || '',
    hasVideo: !!v,
    paused: v ? v.paused : null,
    currentTime: v ? Math.round(v.currentTime * 10) / 10 : null,
    duration: v && Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
    text: (document.body && document.body.innerText || '').slice(0, 400),
  };
})()`

/* ─────────────────────────── 小工具 ─────────────────────────── */

function venvPython(home) {
  const p = process.platform === 'win32'
    ? join(home, 'venv', 'Scripts', 'python.exe')
    : join(home, 'venv', 'bin', 'python')
  return existsSync(p) ? p : ''
}

function systemPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]]
  for (const [bin, args] of candidates) {
    try {
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000, windowsHide: true })
      if (r.status === 0) return { bin, version: (r.stdout || r.stderr || '').trim() }
    } catch { /* 换下一个 */ }
  }
  return null
}

function hasMediaDeps(py) {
  if (!py) return false
  try {
    const r = spawnSync(py, ['-c', 'import curl_cffi, httpx; print("ok")'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    return r.status === 0 && /ok/.test(r.stdout || '')
  } catch {
    return false
  }
}

function tailFile(file, lines = 40) {
  try {
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trim().split('\n').slice(-lines)
  } catch {
    return []
  }
}

function cookieStringFromCdp(cookies) {
  const list = Array.isArray(cookies) ? cookies : []
  const keep = list.filter((c) => {
    const d = String(c?.domain || '')
    return /(^|\.)douyin\.com$/i.test(d) || /(^|\.)iesdouyin\.com$/i.test(d)
  })
  const seen = new Set()
  const parts = []
  for (const c of keep) {
    const n = String(c?.name || '')
    if (!n || seen.has(n)) continue
    seen.add(n)
    parts.push(`${n}=${c?.value ?? ''}`)
  }
  return parts.join('; ')
}

/** 把一轮结果渲染成 Markdown（日报与清单共用） */
function renderList(rec) {
  const rows = Array.isArray(rec.top) ? rec.top : []
  return [
    `# 抖音清单 ${rec.day || dayKey()}`,
    '',
    `采集：${JSON.stringify(rec.meta || [])}`,
    `硬筛跳过：${JSON.stringify(rec.dropped || {})}`,
    `扫描 ${rec.scanned ?? 0} · 打分后 ${rec.scored ?? rows.length} · 去重跳过 ${rec.skippedSeen ?? 0} · 取 ${rows.length}`,
    '',
    ...rows.flatMap((x, i) => [
      `### ${x.aweme_id}`,
      `- ${i + 1}. ${x.desc}`,
      `- ${x.author} · ${x.duration_s ?? '?'}s · 赞${fmtCount(x.digg)} 评${fmtCount(x.comment)} 藏${fmtCount(x.collect)} · ${x.age_h < 900 ? `${x.age_h} 小时前` : '时间未知'}`,
      `- ${x.share_url}`,
      '',
    ]),
  ].join('\n')
}

/**
 * 开浏览器 → 连 CDP → 确保停在抖音域 → 干活 → 只关连接（不关进程）。
 * 一律有头（visible）：无头会被抖音风控拦验证码中间页（2026-10-28 现网踩坑）。
 */
// 2026-10-28 修「接不上」：无头模式被抖音风控拦（验证码中间页）。浏览链一律改
// 有头（visible）——风控友好、窗口可见可手动验证；验证码页返回可行动错误并自动唤人。
async function withDouyin(svc, fn, { mode = 'visible', startUrl = BASE + '/', reuseAny = false } = {}) {
  const b = await ensureChrome({ ...svc.browserOpts(mode), startUrl, reuseAny })
  if (!b.ok) return { ok: false, stage: 'browser', error: b.error }
  let cdp
  try {
    cdp = await connectCdp(b.port)
  } catch (e) {
    return { ok: false, stage: 'cdp', error: String(e?.message || e) }
  }
  try {
    const page = await ensureDouyinPage(cdp, svc.log.log)
    if (!page?.ok) return { ok: false, stage: 'page', error: page?.error || '页面未就绪' }
    if (page.blocked) {
      const t = String(await cdp.evaluate('document.title || ""').catch(() => ''))
      if (/验证码/.test(t)) {
        return flagLoginLost(svc, { ok: false, verificationRequired: true, stage: 'captcha', error: '抖音出了「验证码中间页」风控。请在打开的抖音窗口里手动完成一次验证（点选/滑块），我这边会自动继续；验证过一次后一般就不再拦。' })
      }
    }
    return flagLoginLost(svc, await fn(cdp, b))
  } catch (e) {
    return { ok: false, stage: 'run', error: String(e?.message || e) }
  } finally {
    try { cdp.close() } catch { /* 忽略 */ }
  }
}

/**
 * 发一条评论或楼中楼回复（页面内 fetch，复用签名/Cookie）+ 回读核实。
 * 2026-10-29 修「楼中楼挂错位置」（社区实测坑）：reply_id 必须是**根评论 cid**、
 * reply_to_reply_id 才是目标子评论 cid；两个都填子评论会“返回成功但挂错位置”。
 */
async function publishComment(cdp, { awemeId, text, rootCid = '', replyCid = '' }) {
  const id = String(awemeId || '').trim(), body = String(text || '').trim()
  const root = String(rootCid || '').trim(), target = String(replyCid || '').trim()
  if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
  if (!body) return { ok: false, error: 'text 不能为空' }
  const query = new URLSearchParams({ ...COMMON, app_name: 'aweme' })
  const form = new URLSearchParams({
    ...COMMON,
    aweme_id: id,
    text: body,
    text_extra: '[]',
    aweme_type: '0',
    channel_id: '0',
    city: '',
    sticker_id: '',
    is_fold: '0',
  })
  if (root || target) {
    const rootId = root || target
    form.set('reply_id', rootId)
    form.set('reply_to_reply_id', target || rootId)
  }
  const res = await cdp.evaluate(`(async () => {
    try {
      const r = await fetch(${JSON.stringify(`/aweme/v1/web/comment/publish/?${query.toString()}`)}, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: ${JSON.stringify(form.toString())},
      });
      const t = await r.text();
      let json = null;
      try { json = JSON.parse(t); } catch (e) {}
      return { status: r.status, json, excerpt: json ? '' : String(t).slice(0, 200) };
    } catch (e) { return { status: 0, error: String(e && e.message || e) }; }
  })()`, { timeoutMs: 40000 })
  if (!res || res.status === 0) return { ok: false, stage: 'post', error: res?.error || '请求没有返回' }
  if (!res.json) return { ok: false, stage: 'post', error: `接口没返回 JSON（HTTP ${res.status}）：${res.excerpt || ''}` }
  const code = res.json.status_code
  if (code !== 0 && code !== undefined && code !== null) {
    return { ok: false, stage: 'post', error: `接口 status_code=${code}`, data: { status_msg: res.json.status_msg || '', status_code: code } }
  }
  const cid = String(res.json.comment?.cid || res.json.cid || '')
  // 回读核实：等两秒再翻一次评论列表（顶层 + 楼中楼），看正文有没有真的出现
  await sleepMs(2500)
  const back = await fetchComments(cdp, id, { pages: 1 })
  const probe = body.slice(0, 12)
  const hit = (back.comments || []).find((c) => c.text.includes(probe))
    || (back.comments || []).flatMap((c) => c.replies || []).find((c) => c.text.includes(probe))
  return {
    ok: true,
    sent: true,
    cid,
    verified: Boolean(hit),
    readback: hit ? { cid: hit.cid, text: hit.text.slice(0, 60) } : null,
    note: hit ? '' : '接口返回成功，但回读评论列表没看到这条（可能分页没翻到或还在审核）',
  }
}

// 登录态失效自动唤人（2026-10-27 新增）：工具结果出现登录失效/需验证/被拦截时，
// 主动给 QQ 主人发提醒（30 分钟冷却），不再只留一句干巴巴的工具报错。
const loginLostNotice = { lastAt: 0 };
const dutyState = { timer: null, watchRunning: false, startedAt: 0 };
function flagLoginLost(svc, out) {
  try {
    if (!out || typeof out !== 'object') return out;
    if (!(out.loginRequired || out.verificationRequired || out.blocked)) return out;
    if (Date.now() - loginLostNotice.lastAt < 30 * 60 * 1000) return out;
    loginLostNotice.lastAt = Date.now();
    const kind = out.verificationRequired ? '需要人工验证（风控）' : out.blocked ? '访问被拦截（风控）' : '登录态已失效';
    void (async () => {
      try { const conn = svc.bridge(); await sendToOwner(conn, `⚠️ 抖音${kind}：请在专用抖音窗口重新扫码登录或完成验证，我才能继续干活。`, { maxChars: 200, gapMs: 0 }); } catch { /* 唤人失败不阻塞工具 */ }
    })();
  } catch { /* 忽略 */ }
  return out;
}

/* ─────────────────────────── 工具 ─────────────────────────── */

export function createTools(svc) {
  const { log, paths: P, getCfg, saveCfg, readDay } = svc

  // 额度闸（主干-分支重组 P1）：浏览/观看链与 computer-use 共用一套「刷视频轮次」时钟
  // （见 video-limits.mjs 头注释）。轮次开启只能由用户在控制台/CLI 显式操作——设计红线。
  let limits = null
  try { limits = new VideoLimits({ stateDir: resolveSharedVideoStateDir(P.state) }) } catch { limits = null }
  const browseGate = (name) => {
    if (!limits) return { ok: false, error: '刷视频额度闸不可用（状态目录不可访问），已拒绝浏览动作', hint: '检查 ~/.dsh/douyin-browser 状态目录权限' }
    try {
      const verdict = limits.beforeAction('dsh', name)
      return verdict.allowed ? null : { ok: false, error: verdict.reason, hint: '开始新一轮只能由用户在控制台或 CLI 操作' }
    } catch (error) {
      return { ok: false, error: `刷视频额度闸不可用：${error?.message ?? error}` }
    }
  }

  // P2b 收编：额度轮次状态工具随 video-limits 一起归本包（computer-use 侧已停注册同名）。
  const limitsStatusTool = {
    name: 'douyin_video_limits_status',
    description: '读取自定义刷视频时间段、单轮时长及剩余时间。开始新一轮只能由用户在控制台或CLI操作。',
    parameters: empty(),
    async execute() {
      if (!limits) return { ok: false, error: '额度状态不可读（状态目录不可访问）' }
      try { return { ok: true, ...limits.state() } } catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    },
  }

  // P2b 收编：共享人格存储（与 computer-use 侧共用，见副本头注释）。
  let personaMemory = null
  try { personaMemory = new PersonaMemory() } catch { personaMemory = null }

  // 人格来源接入 QQ 私聊人格与角色（2026-10-27）：设置页人格编辑器已删除，人格卡跟随
  // qq-bridge 的 roles/<名>.md（current-role.json 的私聊槽，解析语义与 bridge 一致）；
  // 兴趣/观察仍由共享记忆单独记录，不受人格切换影响。同步失败不阻塞工具。
  const syncQqPersona = () => {
    try {
      const card = resolveQqPrivateCard()
      if (card?.text && personaMemory) {
        personaMemory.saveManualText({ text: card.text, expectedRevision: personaMemory.snapshot().revision }, { explicit: true })
      }
    } catch { /* 沿用共享存储现有卡 */ }
  }
  syncQqPersona()

  // P2b-3 引擎委托（2026-10-27）：lib/engine/ 是 computer-use 抖音引擎的迁移副本（self-contained
  // 零改写，与 computer-use 侧共用同一套状态/记忆存储）。chat_* / media_* / forward_video 的全部
  // 语义（跨进程锁、租约、额度复核、许可名单）都在引擎的 controller.execute 里，这里只做委托。
  let enginePromise = null
  const getEngine = () => {
    enginePromise ??= (async () => {
      const { BrowserController } = await import('./engine/core.mjs')
      return new BrowserController({ source: 'dsh', personaMemory })
    })()
    return enginePromise
  }
  const engineCall = async (name, args, exec = {}) => {
    try {
      const controller = await getEngine()
      const r = await controller.execute(name, args, { signal: exec.signal })
      return flagLoginLost(svc, typeof r === 'object' && r !== null ? { ok: r.ok !== false, ...r } : { ok: true, result: r })
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) }
    }
  }

  // P2b-3 收编：私信 / 音频 / 转发（computer-use 侧已停注册同名，语义由 engine 委托承载）。
  const chatContactsTool = {
    name: 'douyin_chat_contacts',
    description: '读取本机抖音私信联系人元数据并核对关注关系，不读取其他会话正文。',
    parameters: empty(),
    execute: (args = {}, exec = {}) => engineCall('douyin_chat_contacts', args, exec),
  }

  const chatStatusTool = {
    name: 'douyin_chat_status',
    description: '读取私信自动回复的许可名单、运行状态、预算和暂停原因。',
    parameters: empty(),
    execute: (args = {}, exec = {}) => engineCall('douyin_chat_status', args, exec),
  }

  const chatStartTool = {
    name: 'douyin_chat_start',
    description: '按已核对的本机许可名单启动私信自动回复，只处理启动后新消息。需要用户明确要求启动，不修改许可名单。',
    parameters: empty(),
    execute: (args = {}, exec = {}) => engineCall('douyin_chat_start', args, exec),
  }

  const chatStopTool = {
    name: 'douyin_chat_stop',
    description: '停止正在运行的私信自动回复，取消待生成回复并保留发送核对记录。',
    parameters: empty(),
    execute: (args = {}, exec = {}) => engineCall('douyin_chat_stop', args, exec),
  }

  const chatReadTool = {
    name: 'douyin_chat_read',
    description: '读取许可名单内一个指定联系人的私信。名单外、身份歧义或群聊会拒绝。',
    parameters: {
      type: 'object',
      properties: { recipientId: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['recipientId'],
      additionalProperties: false,
    },
    execute: (args = {}, exec = {}) => engineCall('douyin_chat_read', args, exec),
  }

  const chatObserveTool = {
    name: 'douyin_chat_observe',
    description: '读取许可名单内指定表情或分享卡片的实际画面；分享视频只在允许的刷视频时间内采样，不能把封面当成看完整条作品。',
    parameters: {
      type: 'object',
      properties: {
        recipientId: { type: 'string', minLength: 1, maxLength: 500 },
        messageId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['recipientId', 'messageId'],
      additionalProperties: false,
    },
    execute: (args = {}, exec = {}) => engineCall('douyin_chat_observe', args, exec),
  }

  const forwardTool = {
    name: 'douyin_forward_video',
    description: '为用户明确选择的好友转发当前作品或公开作品链接。实际发送由本机转发按钮的可信授权入口执行，自动回复和普通视频模型不能发起转发。',
    parameters: {
      type: 'object',
      properties: {
        recipientId: { type: 'string', minLength: 1, maxLength: 500 },
        url: { type: 'string', maxLength: 1000 },
      },
      required: ['recipientId'],
      additionalProperties: false,
    },
    execute: (args = {}, exec = {}) => engineCall('douyin_forward_video', args, exec),
  }

  // P2b-3 收编：自主观看 / 自检（照抄 computer-use getWatch/getDiagnostics 的装配语义：
  // 观看启动时把 DSH 模型路由包成 decisionProvider；自检挂同款服务清单）。
  let watchPromise = null
  const getWatchService = async (exec, starting) => {
    if (!watchPromise) {
      watchPromise = (async () => {
        const controller = await getEngine()
        const { AutonomousWatch } = await import('./engine/autonomous-watch.mjs')
        return new AutonomousWatch({
          controller, videoLimits: controller.limits(), personaMemory,
          commentService: await controller.getComments(), reportService: await controller.getReport(),
          source: 'dsh', config: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
        })
      })().catch((error) => { watchPromise = null; throw error })
    }
    const watch = await watchPromise
    if (starting) {
      if (watch.state().worker?.alive) throw new Error('已有自主观看在运行，请先停止。')
      const route = exec.agent?.session?.requestHeader?.()?.config ?? exec.agent?.options ?? {}
      watch.config.model = route.model || 'deepseek-flash'
      watch.agent.config.model = watch.config.model
      const { createNativeWatchDecision } = await import('./engine/native-watch-decision.mjs')
      const opt = (name) => { try { return svc.ctx?.get?.(name) } catch { return undefined } }
      watch.decisionProvider = createNativeWatchDecision({ llm: opt('llm'), attachments: opt('attachments'), agent: exec.agent })
      personaMemory?.initialize?.({ importLegacy: false })
      syncQqPersona()
    }
    return watch
  }

  const watchStatusTool = {
    name: 'douyin_watch_status',
    description: '读取两入口共用的自主观看状态、当前有限轮次与模型请求预算。不会开始观看。',
    parameters: empty(),
    async execute(args = {}, exec = {}) {
      try { return { ok: true, ...await (await getWatchService(exec, false)).state() } }
      catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    },
  }

  const watchStartTool = {
    name: 'douyin_watch_start',
    description: '按用户要求开始持续自主观看：在当天规定时段内一直刷（自动新开/续接轮次，模型请求无上限），直到时段结束或用户说停。已在观看时只补记持续观看意图。',
    parameters: {
      type: 'object',
      properties: { maxRequests: { type: 'integer', minimum: 0, maximum: 10000, description: '本轮模型请求上限；0=无上限（默认）' } },
      additionalProperties: false,
    },
    async execute(args = {}, exec = {}) {
      try {
        const watch = await getWatchService(exec, true)
        return { ok: true, ...await watch.start({ startSession: true, maxRequests: args.maxRequests ?? 0, continuous: true }, { explicit: true }) }
      } catch (error) {
        if (/已有自主观看在运行|另一个入口已有自主观看运行/.test(String(error?.message || ''))) {
          try { return { ok: true, ...await (await getWatchService(exec, false)).enableContinuous({ explicit: true }), note: '已在观看；已设为持续观看（当天规定时段内自动续轮）。' } } catch { /* 落回原错误 */ }
        }
        return { ok: false, error: error?.message ?? String(error) }
      }
    },
  }

  const watchStopTool = {
    name: 'douyin_watch_stop',
    description: '按用户要求停止自主观看并暂停视频，同时结束持续观看（说停即停，不再自动续轮）；不结束或重启其他服务。',
    parameters: empty(),
    async execute(args = {}, exec = {}) {
      try { return { ok: true, ...await (await getWatchService(exec, false)).stop({ explicit: true }) } }
      catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    },
  }

  const personaStatusTool = {
    name: 'douyin_persona_status',
    description: '读取软件与插件共用的最新大肥鱼人格卡、自己的兴趣和有来源的观看记录。人格与记忆不授予额外工具权限。',
    parameters: empty(),
    async execute() {
      if (!personaMemory) return { ok: false, error: '共享人格目录不可访问' }
      try { syncQqPersona(); return { ok: true, ...personaMemory.snapshot() } } catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    },
  }

  const statusTool = {
    name: 'douyin_status',
    description: '读取本插件当前状态：登录态、今日跑了几轮/挑了几条、额度、时段、浏览器模式、到 QQ 的投递通道是否通。不会启动任何抓取。',
    parameters: empty(),
    async execute() {
      const cfg = getCfg()
      const day = readDay()
      const w = effectiveWindows(cfg)
      const now = inWindow(w)
      const chrome = readChromeState(join(P.state, 'chrome.json'))
      const venv = venvPython(P.home)
      let bridge = { ok: false, error: '未检测' }
      try { bridge = await svc.bridgeStatus() } catch (e) { bridge = { ok: false, error: String(e?.message || e) } }
      return {
        ok: true,
        version: svc.version,
        enabled: cfg.enabled,
        login: credentialInfo(P.cookie),
        account: readAccount(P.account),
        today: { day: dayKey(), runs: day.runs || 0, picked: day.picked || 0, perDay: cfg.perDay },
        schedule: { peakValley: cfg.peakValley, windows: w, hitNow: now ? (now.label || `${now.start}-${now.end}`) : null },
        browser: chrome ? { mode: chrome.mode, port: chrome.port, pid: chrome.pid } : null,
        python: { venv: Boolean(venv), deps: venv ? hasMediaDeps(venv) : false },
        bridge: {
          ok: bridge.ok === true,
          mode: bridge.mode || '',
          ownerQQ: bridge.ownerQQ ? String(bridge.ownerQQ).replace(/^(\d{2})\d+(\d{2})$/, '$1****$2') : null,
          error: bridge.error || '',
        },
        options: {
          autoSend: cfg.autoSend,
          notifyMode: cfg.notifyMode,
          mediaEnabled: cfg.mediaEnabled,
          autoreplyEnabled: cfg.autoreplyEnabled,
          sparkEnabled: cfg.sparkEnabled,
        },
      }
    },
  }

  const configTool = {
    name: 'douyin_config',
    description: '读 / 改本插件设置；也可以直接存抖音 Cookie。不给 patch 且不给 cookie 就是读。只认 schema 里有的字段，未知键会被丢弃。',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'object', additionalProperties: true, description: '要改的字段' },
        cookie: { type: 'string', description: '整行抖音 Cookie（F12 → Network → 任意 douyin.com 请求 → Request Headers → Cookie）' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const out = { ok: true }
      if (typeof args.cookie === 'string' && args.cookie.trim()) {
        out.cookie = saveCookie(P.cookie, args.cookie)
      }
      if (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
        const r = await saveCfg(args.patch)
        out.saved = r
      }
      out.config = getCfg()
      out.windows = effectiveWindows(getCfg())
      out.credential = credentialInfo(P.cookie)
      return out
    },
  }

  const doctorTool = {
    name: 'douyin_doctor',
    description: '全链路自检：浏览器、登录态、Python 依赖、qq-bridge 投递通道、目录权限。返回逐项结论与下一步动作，不启动抓取也不发消息。',
    parameters: empty(),
    async execute() {
      const cfg = getCfg()
      const base = svc.doctorBase()
      const checks = []
      const add = (key, ok, detail, action = '') => checks.push({ key, ok, detail, action })

      add('node', true, `Node ${base.node}`)
      add('home', true, base.home)
      add('browser', Boolean(base.browser), base.browser || '没找到 Chrome / Edge', base.browser ? '' : '在设置里填浏览器路径')
      const cred = base.credential
      add('cookie', true, cred.present
        ? `已存（${cred.bytes} 字节，${cred.masked}）`
        : '未存（读数据走浏览器登录态，这一项只给后续的接口脚本用）')

      const py = venvPython(P.home)
      add('python', Boolean(py), py || '插件家目录里还没有 venv', py ? '' : '调用 douyin_setup 装环境（只有看画面/转写才需要）')
      add('python-deps', py ? hasMediaDeps(py) : false, py ? (hasMediaDeps(py) ? 'curl_cffi / httpx 可用' : '缺 curl_cffi / httpx') : 'venv 未装', py ? '重新调用 douyin_setup' : '')

      const b = base.bridge
      add('qq-bridge', Boolean(b.root), b.root || '没找到 qq-bridge 目录', b.root ? '' : '设环境变量 QQ_BRIDGE_ROOT')
      add('bridge-token', Boolean(b.token), b.token ? `已取到（来源：${b.tokenFrom}）` : '拿不到控制台令牌', b.token ? '' : '在设置里填 bridgeToken')
      add('owner', Boolean(b.ownerQQ), b.ownerQQ ? `已配置（${String(b.ownerQQ).replace(/^(\d{2})\d+(\d{2})$/, '$1****$2')}）` : 'qq-bridge 的 ownerQQ 为空', b.ownerQQ ? '' : '在 qq-bridge 控制台设置 ownerQQ')

      const alive = await svc.bridgeStatus().catch((e) => ({ ok: false, error: String(e?.message || e) }))
      add('bridge-reachable', alive.ok === true, alive.ok ? `模式 ${alive.mode}` : (alive.error || '连不上'), alive.ok ? '' : '确认 qq-bridge 已启动（默认 127.0.0.1:3100）')
      if (alive.ok && alive.mode !== 'closed-agent') {
        add('bridge-mode', false, `当前模式是 ${alive.mode}，外发只允许 closed-agent`, '在 qq-bridge 控制台把模式切到 closed-agent')
      } else if (alive.ok) {
        add('bridge-mode', true, 'closed-agent')
      }

      const chrome = readChromeState(join(P.state, 'chrome.json'))
      add('chrome-state', true, chrome ? `${chrome.mode} · port ${chrome.port} · pid ${chrome.pid}` : '当前没有运行中的实例')

      const failed = checks.filter((c) => !c.ok)
      return {
        ok: failed.length === 0,
        plugin: { version: svc.version, configFile: base.configFile },
        checks,
        failed: failed.map((c) => c.key),
        next: failed.map((c) => c.action).filter(Boolean),
      }
    },
  }

  const loginTool = {
    name: 'douyin_login',
    description: '抖音登录：action=open 起一次有头浏览器让你扫码；action=capture 把已扫码的登录态取下来存进插件；action=status 只看有没有存过。扫码是唯一需要你亲手做的步骤。',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['open', 'capture', 'status'], description: '默认 status' } },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const action = ['open', 'capture'].includes(args.action) ? args.action : 'status'
      if (action === 'status') {
        return { ok: true, credential: credentialInfo(P.cookie), chrome: readChromeState(join(P.state, 'chrome.json')) }
      }

      if (action === 'open') {
        const r = await ensureChrome({ ...svc.browserOpts('visible'), startUrl: 'https://www.douyin.com/' })
        if (!r.ok) return { ok: false, error: r.error }
        log.log(`登录取码：拉起有头浏览器 port=${r.port}`)
        return {
          ok: true,
          port: r.port,
          hint: '浏览器已打开抖音。请扫码/验证码登录，完成后调用 douyin_login(action="capture") 保存登录态。',
        }
      }

      const st = readChromeState(join(P.state, 'chrome.json'))
      if (!st?.port) return { ok: false, error: '没有可用的浏览器实例，请先 douyin_login(action="open")' }
      const cdp = await connectCdp(st.port)
      try {
        const cookies = await cdp.evaluate('document.cookie').catch(() => '')
        const all = await cdp.send('Network.getAllCookies', {})
        const raw = cookieStringFromCdp(all?.cookies) || String(cookies || '')
        if (!raw) return { ok: false, error: '没取到抖音 Cookie，可能还没登录完成' }
        const saved = saveCookie(P.cookie, raw)
        if (!saved.ok) return { ok: false, error: saved.error }
        const title = await cdp.evaluate('document.title').catch(() => '')
        log.log(`登录态已保存：${saved.masked}`)
        return { ok: true, saved: saved.masked, pageTitle: String(title || ''), hint: '登录态已保存，可以关掉有头窗口了。' }
      } finally {
        cdp.close()
      }
    },
  }

  const scoutTool = {
    name: 'douyin_scout',
    description: '刷一轮：拉推荐流 + 热榜候选，按结构化字段（文案/互动/时长/时效）打分，出一份清单。只读，不碰评论与私信。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '取前几条，默认用设置的 maxPerRun' },
        pages: { type: 'integer', minimum: 1, maximum: 5, description: '推荐流翻几页，默认 3' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_scout')
      if (gate) return gate
      const cfg = getCfg()
      const limit = clamp(args.limit ?? cfg.maxPerRun, 1, 30)
      const pages = clamp(args.pages ?? 3, 1, 5)
      const r = await withDouyin(svc, async (cdp) => {
        const feed = await fetchFeed(cdp, { pages })
        const hot = await fetchHotSearch(cdp)
        const bag = new Map([...feed.bag, ...hot.bag])
        const { rows, dropped } = scoreCandidates([...bag.values()], {
          minDescLen: cfg.minDescLen,
          minComments: cfg.minComments,
          keywords: cfg.keywords,
        })
        if (!bag.size) {
          return {
            ok: false,
            stage: 'empty',
            error: '两条采集路都没拿到作品。多半是登录态失效：先 douyin_login(action="open") 扫码，再 capture。',
            meta: [...feed.meta, { src: 'hot-search', error: hot.error || '无数据' }],
          }
        }
        const top = rows.slice(0, limit)
        const meta = [...feed.meta, { src: 'hot-search', new: hot.bag.size, error: hot.error || '' }]
        writeJson(join(P.state, 'scout.json'), { at: Date.now(), meta, dropped, total: rows.length, rows: top })
        const md = [
          `# 抖音清单 ${dayKey()}`,
          '',
          `采集：${JSON.stringify(meta)}`,
          `硬筛跳过：${JSON.stringify(dropped)}（阈值 文案≥${cfg.minDescLen} 字 / 评论≥${cfg.minComments}）`,
          `去重后 ${rows.length} 条，取前 ${top.length}`,
          '',
          ...top.flatMap((x, i) => [
            `### ${x.aweme_id}`,
            `- ${i + 1}. ${x.desc}`,
            `- ${x.author} · ${x.duration_s ?? '?'}s · 赞${fmtCount(x.digg)} 评${fmtCount(x.comment)} 藏${fmtCount(x.collect)} · ${x.age_h < 900 ? `${x.age_h}小时前` : '时间未知'}`,
            `- ${x.share_url}`,
            '',
          ]),
        ].join('\n')
        try { writeFileSync(join(P.out, `scout-${dayKey()}.md`), md, 'utf8') } catch { /* 落盘失败不影响返回 */ }
        return {
          ok: true,
          meta,
          dropped,
          scanned: bag.size,
          total: rows.length,
          rows: top.map((x) => ({
            aweme_id: x.aweme_id,
            desc: x.desc.slice(0, 160),
            author: x.author,
            duration_s: x.duration_s,
            digg: x.digg,
            comment: x.comment,
            collect: x.collect,
            share: x.share,
            age_h: x.age_h,
            score: x.score,
            share_url: x.share_url,
          })),
        }
      })
      if (r.ok) {
        const day = readDay()
        svc.bumpDay({ runs: (day.runs || 0) + 1 })
      }
      return r
    },
  }

  const videoTool = {
    name: 'douyin_video',
    description: '取单条作品的详情：文案、标签、作者、时长、互动数据、官方分享链接。只要 aweme_id，不用打开浏览器窗口。',
    parameters: {
      type: 'object',
      properties: { aweme_id: { type: 'string', minLength: 10, maxLength: 30, description: '19 位作品 ID' } },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_video')
      if (gate) return gate
      const id = String(args.aweme_id || '').trim()
      if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
      const r = await withDouyin(svc, async (cdp) => {
        const d = await fetchVideoDetail(cdp, id)
        if (!d.ok) {
          return { ok: false, error: d.error, hint: '作品可能已删除、私密，或登录态失效' }
        }
        return { ok: true, video: d.video }
      })
      return r
    },
  }

  const commentsTool = {
    name: 'douyin_comments',
    description: '读某条作品下的评论（含 cid、点赞数、是否回复）。只读，用于判断氛围或找要回复的那条。',
    parameters: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', minLength: 10, maxLength: 30 },
        pages: { type: 'integer', minimum: 1, maximum: 4, description: '翻几页，默认 2' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回多少条，默认 20' },
      },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_comments')
      if (gate) return gate
      const id = String(args.aweme_id || '').trim()
      if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
      const pages = clamp(args.pages ?? 2, 1, 4)
      const limit = clamp(args.limit ?? 20, 1, 50)
      return withDouyin(svc, async (cdp) => {
        const r = await fetchComments(cdp, id, { pages })
        if (!r.ok) return { ok: false, error: r.error, stage: 'fetch' }
        const top = [...r.comments].sort((a, b) => b.digg - a.digg).slice(0, limit)
        return {
          ok: true,
          aweme_id: id,
          total: r.comments.length,
          has_more: r.has_more,
          top,
        }
      })
    },
  }

  const noticesTool = {
    name: 'douyin_notices',
    description: '读抖音通知（互动/评论/粉丝/系统），附带未读计数。只读。',
    parameters: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'integer' }, description: `分组，默认 ${NOTICE_GROUPS.join('/')}` },
        limit: { type: 'integer', minimum: 1, maximum: 60, description: '返回多少条，默认 30' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const groups = Array.isArray(args.groups) && args.groups.length ? args.groups.map(Number).filter(Number.isFinite) : NOTICE_GROUPS
      const limit = clamp(args.limit ?? 30, 1, 60)
      return withDouyin(svc, async (cdp) => {
        const counts = await fetchNoticeCount(cdp)
        const r = await fetchNotices(cdp, { groups })
        return {
          ok: r.ok,
          counts: counts.ok ? counts.counts : {},
          countError: counts.ok ? '' : counts.error,
          n: r.items.length,
          warnings: r.warnings,
          items: r.items.slice(0, limit),
        }
      })
    },
  }

  const atMeTool = {
    name: 'douyin_at_me',
    description: '只取「评论区 @ 我」的通知（type 45/46），带作品链接与评论 id，方便后续回复。只读。',
    parameters: empty(),
    async execute() {
      return withDouyin(svc, async (cdp) => {
        const r = await fetchAtMe(cdp)
        return { ok: r.ok, n: r.items.length, items: r.items, warnings: r.warnings || [] }
      })
    },
  }

  const runTool = {
    name: 'douyin_run',
    description: '跑一轮值班：采集候选 → 打分 → 去重（7 天内推过的不再推）→ 出精选清单。默认只返回清单、不发送；deliver=true 才把摘要发到主人 QQ。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '本轮挑几条，默认 perDay' },
        pages: { type: 'integer', minimum: 1, maximum: 5, description: '推荐流翻几页，默认 3' },
        deliver: { type: 'boolean', description: '是否把清单摘要直接发到主人 QQ（需要 autoSend 与 closed-agent）' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_run')
      if (gate) return gate
      const cfg = getCfg()
      const limit = clamp(args.limit ?? cfg.perDay, 1, 20)
      const pages = clamp(args.pages ?? 3, 1, 5)
      const histFile = join(P.state, 'recommended.json')

      const r = await withDouyin(svc, async (cdp) => {
        const feed = await fetchFeed(cdp, { pages })
        const hot = await fetchHotSearch(cdp)
        const bag = new Map([...feed.bag, ...hot.bag])
        const { rows, dropped } = scoreCandidates([...bag.values()], {
          minDescLen: cfg.minDescLen,
          minComments: cfg.minComments,
          keywords: cfg.keywords,
        })
        if (!bag.size) {
          return {
            ok: false,
            stage: 'empty',
            error: '没拿到作品。多半是登录态失效或撞上风控：先 douyin_login(action="open") 过一次验证。',
            meta: [...feed.meta, { src: 'hot-search', error: hot.error || '无数据' }],
          }
        }

        const history = loadHistory(histFile)
        const fresh = rows.filter((x) => !isRecent(history, x.aweme_id))
        const skippedSeen = rows.length - fresh.length
        const top = fresh.slice(0, limit)
        if (top.length) saveHistory(histFile, markSeen(history, top.map((x) => x.aweme_id)))

        const rec = {
          at: Date.now(),
          day: dayKey(),
          meta: [...feed.meta, { src: 'hot-search', new: hot.bag.size, error: hot.error || '' }],
          dropped,
          scanned: bag.size,
          scored: rows.length,
          skippedSeen,
          top,
        }
        writeJson(join(P.state, `run-${dayKey()}.json`), rec)
        writeJson(join(P.state, 'scout.json'), rec)
        try { writeFileSync(join(P.out, `scout-${dayKey()}.md`), renderList(rec), 'utf8') } catch { /* 落盘失败不影响 */ }

        return {
          ok: true,
          scanned: bag.size,
          scored: rows.length,
          skippedSeen,
          dropped,
          picked: top.length,
          rows: top.map((x) => ({
            aweme_id: x.aweme_id,
            desc: x.desc.slice(0, 200),
            author: x.author,
            duration_s: x.duration_s,
            digg: x.digg,
            comment: x.comment,
            collect: x.collect,
            age_h: x.age_h,
            score: x.score,
            share_url: x.share_url,
            web_url: x.web_url,
          })),
        }
      })

      if (!r.ok) return r

      const day = readDay()
      svc.bumpDay({ runs: (day.runs || 0) + 1, picked: (day.picked || 0) + r.picked })

      if (args.deliver === true && r.picked > 0) {
        if (!cfg.autoSend) return { ...r, delivered: false, deliverError: 'autoSend 已关闭' }
        const text = [
          '今天刷到这几条，你看看有没有兴趣：',
          ...r.rows.map((x, i) => `${i + 1}. ${x.desc.slice(0, 60)}\n${x.share_url}`),
        ].join('\n\n')
        const conn = svc.bridge()
        const probe = await svc.bridgeStatus()
        if (!probe.ok) return { ...r, delivered: false, deliverError: probe.error || '连不上 qq-bridge' }
        if (probe.mode !== 'closed-agent') return { ...r, delivered: false, deliverError: `当前模式 ${probe.mode} 不允许外发` }
        const sent = await sendToOwner(conn, text, { maxChars: 500, gapMs: 1200 })
        return { ...r, delivered: sent.ok, deliverError: sent.error || '' }
      }
      return r
    },
  }

  const shotTool = {
    name: 'douyin_screenshot',
    description: '截一张抖音当前画面（可指定作品 id），存成 PNG 并返回文件路径。按设置决定是否拉起有头窗口。',
    parameters: {
      type: 'object',
      properties: { aweme_id: { type: 'string', description: '可选：19 位作品 id，给了就先打开这条' } },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_screenshot')
      if (gate) return gate
      const cfg = getCfg()
      const wantVisible = cfg.visibleForObserve === true
      const id = String(args.aweme_id || '').trim()
      return withDouyin(svc, async (cdp, b) => {
        if (/^\d{10,25}$/.test(id)) {
          await cdp.navigate(`${BASE}/video/${id}`)
          await sleepMs(4500)
        }
        const b64 = await cdp.screenshot()
        if (!b64) return { ok: false, error: '截图失败（页面可能还没渲染完）' }
        const file = join(P.out, `shot-${Date.now()}.png`)
        writeFileSync(file, Buffer.from(b64, 'base64'))
        const page = await cdp.evaluate(PAGE_STATE_JS).catch(() => ({}))
        return { ok: true, file, mode: b.mode, page }
      }, { mode: wantVisible ? 'visible' : 'headless', reuseAny: !wantVisible })
    },
  }

  const observeTool = {
    name: 'douyin_observe',
    description: '观察当前抖音画面 N 秒（1–10）：返回前后两帧截图路径、播放进度与页面文字。画面内容要靠支持图像输入的模型自己看，本工具不做识别。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', minimum: 1, maximum: 10, description: '观察秒数，默认 4' },
        aweme_id: { type: 'string', description: '可选：先打开这条作品' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_observe')
      if (gate) return gate
      const cfg = getCfg()
      const wantVisible = cfg.visibleForObserve === true
      const seconds = Math.max(1, Math.min(Number(args.seconds) || 4, 10))
      const id = String(args.aweme_id || '').trim()
      return withDouyin(svc, async (cdp, b) => {
        if (/^\d{10,25}$/.test(id)) {
          await cdp.navigate(`${BASE}/video/${id}`)
          await sleepMs(4000)
        }
        const before = await cdp.evaluate(PAGE_STATE_JS).catch(() => ({}))
        const shotA = await cdp.screenshot()
        await sleepMs(Math.round(seconds * 1000))
        const after = await cdp.evaluate(PAGE_STATE_JS).catch(() => ({}))
        const shotB = await cdp.screenshot()

        const stamp = Date.now()
        const frames = []
        for (const [name, b64] of [['a', shotA], ['b', shotB]]) {
          if (!b64) continue
          const file = join(P.out, `observe-${stamp}-${name}.png`)
          writeFileSync(file, Buffer.from(b64, 'base64'))
          frames.push(file)
        }
        const advanced = (before.currentTime !== null && after.currentTime !== null)
          ? Math.round((after.currentTime - before.currentTime) * 10) / 10
          : null
        return {
          ok: frames.length > 0,
          mode: b.mode,
          seconds,
          frames,
          playback: { before, after, advanced_s: advanced },
          note: advanced !== null && advanced <= 0.2 ? '播放进度几乎没动，可能暂停或没加载出来' : '',
        }
      }, { mode: wantVisible ? 'visible' : 'headless', reuseAny: !wantVisible })
    },
  }

  const rememberTool = {
    name: 'douyin_remember',
    description: '把主人明确要求记住的内容写进本插件记忆。凭据、本机路径、长号码会被自动抹掉，不要存推测当成事实。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 4000, description: '要记住的内容' },
        kind: { type: 'string', maxLength: 40, description: '分类，如 preference / fact / video' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，最多 6 个' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const r = appendNote(join(P.memory, 'notes.jsonl'), {
        content: args.content,
        kind: args.kind || 'note',
        tags: args.tags,
        source: 'agent',
      })
      return r.ok ? { ok: true, saved: r.row.content.length, kind: r.row.kind } : r
    },
  }

  const recallTool = {
    name: 'douyin_recall',
    description: '检索本插件记忆（不给 query 就返回最近几条）。只读，不访问 QQ 聊天记录。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300, description: '检索词' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '默认 10' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const limit = clamp(args.limit ?? 10, 1, 30)
      const rows = searchNotes(join(P.memory, 'notes.jsonl'), args.query, limit)
      return {
        ok: true,
        n: rows.length,
        items: rows.map((r) => ({ at: r.at, kind: r.kind, tags: r.tags, content: r.content })),
      }
    },
  }

  const personaTool = {
    name: 'douyin_persona',
    description: '读取本插件的人设卡、自己的兴趣台账与最近记忆。人设只从插件自带文件（或主人改过的 home/persona.md）读，绝不读外部目录。',
    parameters: empty(),
    async execute() {
      const custom = join(P.home, 'persona.md')
      const file = existsSync(custom) ? custom : join(P.prompts, 'persona.md')
      let text = ''
      try { text = readFileSync(file, 'utf8') } catch { /* 读不到就给空 */ }
      const interests = interestSummary(join(P.state, 'interests.json'))
      const recent = searchNotes(join(P.memory, 'notes.jsonl'), '', 5)
      return {
        ok: Boolean(text),
        source: existsSync(custom) ? 'home/persona.md' : 'prompts/persona.md',
        persona: text.slice(0, 3000),
        interests,
        recent: recent.map((r) => ({ kind: r.kind, content: r.content })),
      }
    },
  }

  const interestTool = {
    name: 'douyin_interest_record',
    description: '按真实观看证据更新我自己的兴趣。必须有 evidenceId（观看记录/行为证据），不能拿主人偏好或私信内容当自己的兴趣。',
    parameters: {
      type: 'object',
      properties: {
        evidenceId: { type: 'string', minLength: 1, maxLength: 90, description: '证据 id（如 aweme_id 或观察记录 id）' },
        topic: { type: 'string', minLength: 1, maxLength: 80, description: '主题词' },
        signal: { type: 'string', enum: ['like', 'dislike', 'neutral'] },
        reflection: { type: 'string', minLength: 4, maxLength: 600, description: '为什么（要写具体，不许空话）' },
      },
      required: ['evidenceId', 'topic', 'signal', 'reflection'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      return addInterest(join(P.state, 'interests.json'), args)
    },
  }

  const shareCardTool = {
    name: 'douyin_share_card',
    description: '用抖音自己的「分享给朋友」把作品以卡片发给好友。必须 confirm:true 才真的发送；不给 confirm 只返回将要发给谁。重名时必须给 to_id（sec_uid）。',
    parameters: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', minLength: 10, maxLength: 30 },
        to: { type: 'string', maxLength: 40, description: '抖音好友昵称；不给就用设置里的 dmTo' },
        to_id: { type: 'string', maxLength: 200, description: '可选 sec_uid，昵称重名时用' },
        reason: { type: 'string', maxLength: 600, description: '可选：分享成功后紧跟着发给主人的一句"这视频怎么样"' },
        confirm: { type: 'boolean', description: '必须为 true 才真的发送' },
      },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const cfg = getCfg()
      const id = String(args.aweme_id || '').trim()
      if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
      const who = String(args.to || cfg.dmTo || '').trim()
      const wantUid = String(args.to_id || cfg.dmToId || '').trim()
      if (!who) return { ok: false, error: '没指定发给谁：先在设置里填 dmTo（抖音好友昵称），或传 to' }
      if (args.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: '需要 confirm:true 才真的发送',
          wouldSend: { aweme_id: id, to: who, sec_uid: wantUid },
        }
      }
      if (!cfg.autoSend) return { ok: false, error: 'autoSend 已关闭，不执行外发' }

      const result = await withDouyin(svc, async (cdp) => {
        await cdp.navigate(`${BASE}/video/${id}`)
        await sleepMs(7000)

        const icon = await cdp.evaluate(`(() => {
          var ic = document.querySelector('[data-e2e="video-share-icon-container"]');
          if (!ic) return null;
          var r = ic.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`)
        if (!icon?.x) {
          return { ok: false, stage: 'icon', error: '视频页没渲染出分享图标（多半是未登录或撞上风控）' }
        }

        await hoverTrack(cdp, icon.x, icon.y)
        await sleepMs(2000)

        const panel = await cdp.evaluate(`(() => {
          var sc = document.querySelector('[data-e2e="video-share-container"]');
          return sc ? (sc.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) : '';
        })()`)
        if (!panel) return { ok: false, stage: 'panel', error: '分享面板没展开（hover 轨迹可能被打断）' }

        const raw = await cdp.evaluate(`(function () {
          var who = ${JSON.stringify(who)};
          var sc = document.querySelector('[data-e2e="video-share-container"]');
          if (!sc) return JSON.stringify({ err: 'no-panel' });
          function secOf(node) {
            var fk = Object.keys(node).find(function (k) { return k.indexOf('__reactFiber$') === 0; });
            if (!fk) return '';
            var f = node[fk], d = 0;
            while (f && d < 14) {
              var p = f.memoizedProps;
              if (p && typeof p === 'object') {
                for (var k in p) { var v = p[k]; if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid); }
              }
              f = f.return; d++;
            }
            return '';
          }
          var nodes = Array.prototype.slice.call(sc.querySelectorAll('div,span,p'))
            .filter(function (e) { return (e.innerText || '').trim() === who; })
            .sort(function (a, b) { return a.getBoundingClientRect().width - b.getBoundingClientRect().width; });
          if (!nodes.length) return JSON.stringify({ err: 'no-name', text: (sc.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) });
          var out = [];
          nodes.forEach(function (nameNode) {
            var row = nameNode;
            for (var i = 0; i < 6 && row; i++) {
              var btns = Array.prototype.slice.call(row.querySelectorAll('div,span,button'))
                .filter(function (e) { return (e.innerText || '').trim() === '分享'; });
              if (btns.length) {
                var b = btns[0], r = b.getBoundingClientRect();
                if (r.width > 16 && r.height > 12) {
                  out.push({ nick: who, sec_uid: secOf(row) || secOf(nameNode), btn: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } });
                }
                break;
              }
              row = row.parentElement;
            }
          });
          var seen = {}, uniq = [];
          out.forEach(function (o) { var k = o.sec_uid || (o.btn.x + ',' + o.btn.y); if (!seen[k]) { seen[k] = 1; uniq.push(o); } });
          return JSON.stringify({ candidates: uniq });
        })()`)

        let found
        try { found = JSON.parse(raw || '{}') } catch { found = {} }
        const candidates = Array.isArray(found.candidates) ? found.candidates : []
        if (found.err === 'no-name') {
          return { ok: false, stage: 'match', error: `分享面板里没有「${who}」这一行`, panel, hint: '分享面板只列最近联系人；先在抖音里和这个人聊一句再试' }
        }
        if (!candidates.length) return { ok: false, stage: 'match', error: '找到了名字但没找到它那一行的「分享」按钮', panel }

        let pick = null
        if (wantUid) pick = candidates.find((c) => c.sec_uid === wantUid) || null
        if (!pick && candidates.length === 1) pick = candidates[0]
        if (!pick && !wantUid && candidates.length > 1) {
          return {
            ok: false,
            stage: 'ambiguous',
            error: `面板里有 ${candidates.length} 个同名「${who}」，需要指定 sec_uid`,
            candidates: candidates.map((c) => ({ sec_uid: c.sec_uid, btn: c.btn })),
            panel,
          }
        }
        if (!pick) return { ok: false, stage: 'ambiguous', error: '指定的 sec_uid 不在候选里', candidates, panel }

        /**
         * 🔴 实测（2026-10-24）：这一行的「分享」按钮**只认原生 JS click**。
         *    CDP 的 dispatchMouseEvent 落在它身上（elementFromPoint 确认命中的就是它）
         *    也毫无反应，面板不动、也没有任何提示 —— 之前因此一直返回"假成功"。
         *    分享**图标**反过来只认真实鼠标 hover，所以两步必须分开。
         */
        const clickedRaw = await cdp.evaluate(`(function () {
          var who = ${JSON.stringify(who)};
          var target = ${JSON.stringify(pick.sec_uid || '')};
          var sc = document.querySelector('[data-e2e="video-share-container"]');
          if (!sc) return JSON.stringify({ err: 'no-panel' });
          function secOf(node) {
            var fk = Object.keys(node).find(function (k) { return k.indexOf('__reactFiber$') === 0; });
            if (!fk) return '';
            var f = node[fk], d = 0;
            while (f && d < 14) {
              var p = f.memoizedProps;
              if (p && typeof p === 'object') {
                for (var k in p) { var v = p[k]; if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid); }
              }
              f = f.return; d++;
            }
            return '';
          }
          var nodes = Array.prototype.slice.call(sc.querySelectorAll('div,span,p'))
            .filter(function (e) { return (e.innerText || '').trim() === who; });
          for (var ni = 0; ni < nodes.length; ni++) {
            var row = nodes[ni], hit = null;
            for (var i = 0; i < 6 && row; i++) {
              var bs = Array.prototype.slice.call(row.querySelectorAll('div,span,button'))
                .filter(function (e) { return (e.innerText || '').trim() === '分享'; });
              if (bs.length) { hit = bs[0]; break; }
              row = row.parentElement;
            }
            if (!hit) continue;
            if (target && secOf(row) && secOf(row) !== target) continue;
            hit.click();
            return JSON.stringify({ clicked: true, sec_uid: secOf(row) || '' });
          }
          return JSON.stringify({ err: 'no-btn' });
        })()`)

        let clicked
        try { clicked = JSON.parse(clickedRaw || '{}') } catch { clicked = {} }
        if (!clicked.clicked) {
          return { ok: false, stage: 'click', error: clicked.err === 'no-btn' ? '找不到那一行的分享按钮' : '面板已关闭，没点上', panel }
        }

        // 用抖音自己的「分享成功」提示做核实（比"点过了"可靠）
        let toast = ''
        for (let i = 0; i < 6; i += 1) {
          await sleepMs(400)
          toast = await cdp.evaluate(`(() => (/分享成功/.test(document.body.innerText || '') ? '分享成功' : ''))()`).catch(() => '')
          if (toast) break
        }

        log.log(`分享卡片：aweme=${id} to=${who} sec_uid=${clicked.sec_uid || '-'} 提示=${toast || '未捕获'}`)
        return {
          ok: Boolean(toast),
          sent: Boolean(toast),
          to: who,
          sec_uid: clicked.sec_uid || '',
          verified: Boolean(toast),
          toast,
          error: toast ? '' : '点击已发出，但没等到「分享成功」提示 —— 大概率没真正发出去',
        }
      }, { mode: 'visible', reuseAny: false })

      /**
       * 「先卡片，后文字」：分享成功之后，再把"这视频怎么样"发给主人。
       * 顺序不能反 —— 反过来主人先看到一句评价、却不知道该看哪条。
       */
      const reason = String(args.reason || '').trim()
      if (!reason || !result?.ok) return result
      const conn = svc.bridge()
      const probe = await svc.bridgeStatus()
      if (!probe.ok) return { ...result, reasonSent: false, reasonError: probe.error || '连不上 qq-bridge' }
      await sleepMs(1500)
      const sentText = await sendToOwner(conn, reason, { maxChars: 500, gapMs: 1200 })
      if (!sentText.ok) log.warn(`分享后的说明没发出去：${sentText.error}`)
      return { ...result, reasonSent: sentText.ok, reasonError: sentText.error || '' }
    },
  }

  const commentReplyTool = {
    name: 'douyin_comment_reply',
    description: '回复某条评论，或给作品发一条新评论。必须 confirm:true 才真的发；发完会回读评论列表核实是否出现。楼中楼回复要给 root_cid（根评论）+ reply_id（目标子评论）。',
    parameters: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', minLength: 10, maxLength: 30 },
        text: { type: 'string', minLength: 1, maxLength: 300, description: '评论正文' },
        reply_id: { type: 'string', maxLength: 30, description: '可选：要回复的那条评论 cid；不给就是发一条新评论' },
        root_cid: { type: 'string', maxLength: 30, description: '可选：楼中楼的根评论 cid（回复子评论时给，保证挂对位置）' },
        confirm: { type: 'boolean', description: '必须为 true 才真的发送' },
      },
      required: ['aweme_id', 'text'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const cfg = getCfg()
      const id = String(args.aweme_id || '').trim()
      const text = String(args.text || '').trim()
      const replyId = String(args.reply_id || '').trim()
      const rootCid = String(args.root_cid || '').trim()
      if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
      if (!text) return { ok: false, error: 'text 不能为空' }
      if (args.confirm !== true) {
        return {
          ok: false,
          needsConfirm: true,
          error: '需要 confirm:true 才真的发送',
          wouldPost: { aweme_id: id, text, reply_id: replyId || null, root_cid: rootCid || null },
        }
      }
      if (!cfg.autoSend) return { ok: false, error: 'autoSend 已关闭，不执行外发' }

      return withDouyin(svc, async (cdp) => {
        const result = await publishComment(cdp, { awemeId: id, text, rootCid, replyCid: replyId })
        log.log(`评论提交：aweme=${id} cid=${result.cid || '-'} 回读=${result.verified ? '见到' : '没见到'}`)
        return result
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const imReadTool = {
    name: 'douyin_im_read',
    description: '读抖音私信。不给 with 只列会话（昵称/sec_uid/未读/预览）；给了 with（昵称或 sec_uid）就打开那个会话并读出消息，标出每条是谁发的。只读。',
    parameters: {
      type: 'object',
      properties: {
        with: { type: 'string', maxLength: 200, description: '好友昵称或 sec_uid' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回多少条，默认 30' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const who = String(args.with || '').trim()
      const limit = clamp(args.limit ?? 30, 1, 50)
      return withDouyin(svc, async (cdp) => {
        const page = await openImPage(cdp)
        if (!page.ok) return { ok: false, stage: 'page', error: page.error }
        const convs = await cdp.evaluate(IM_CONV_JS) || []
        const brief = convs.slice(0, limit).map((c) => ({ nick: c.nick, sec_uid: c.sec_uid, unread: c.unread, preview: c.preview }))
        // 永不静默降级：DOM 里有节点但尺寸为 0 = 页面根本没挂载私信视图，别返回空数组冒充"没有消息"
        const rendered = convs.filter((c) => c.w > 40 && c.h > 20)
        if (!rendered.length) {
          return {
            ok: false,
            stage: 'render',
            error: '私信会话节点在 DOM 里但没渲染出来 —— 抖音这次没把私信视图挂载出来（顶栏「消息」入口点不进去）。sec_uid 列表仍可参考。',
            conversations: brief,
          }
        }
        if (!who) return { ok: true, count: rendered.length, conversations: brief }

        const found = findConv(rendered, who)
        if (!found.ok) return { ok: false, stage: 'match', error: found.error, candidates: found.candidates || [], conversations: brief }
        const conv = found.conv
        if (conv.visible === false) return { ok: false, stage: 'view', error: '这个会话项不在可视区（可能被陌生人列表挡住）' }

        await mouseClick(cdp, conv.x, conv.y)
        await sleepMs(2500)
        const raw = await cdp.evaluate(IM_READ_JS)
        const msgs = inheritSender(Array.isArray(raw) ? raw : [])
        return {
          ok: true,
          with: { nick: conv.nick, sec_uid: conv.sec_uid },
          count: msgs.length,
          messages: msgs.slice(-limit),
        }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const dmTool = {
    name: 'douyin_dm',
    description: '给抖音好友发一条私信文字。必须 confirm:true 才真的发；发完回读会话核实。注意：对方回复/关注你之前，抖音只允许发一条文字消息。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', maxLength: 40, description: '好友昵称；不给就用设置里的 dmTo' },
        to_id: { type: 'string', maxLength: 200, description: '可选 sec_uid（重名时用）' },
        text: { type: 'string', minLength: 1, maxLength: 500, description: '要发的内容' },
        confirm: { type: 'boolean', description: '必须为 true 才真的发送' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const cfg = getCfg()
      const text = String(args.text || '').trim()
      const who = String(args.to || cfg.dmTo || '').trim()
      const uidRaw = String(args.to_id || cfg.dmToId || '').trim()
      // 只认真正像 sec_uid 的值：这一栏被填成 QQ 号时会永远匹配不上，别拿它去顶昵称
      const uid = /^(MS4wLjABAA|11-\d{6,})/.test(uidRaw) ? uidRaw : ''
      if (!text) return { ok: false, error: 'text 不能为空' }
      if (!who && !uid) return { ok: false, error: '没指定发给谁：设置里填 dmTo，或传 to / to_id' }
      if (args.confirm !== true) {
        return { ok: false, needsConfirm: true, error: '需要 confirm:true 才真的发送', wouldSend: { to: who, sec_uid: uid, text } }
      }
      if (!cfg.autoSend) return { ok: false, error: 'autoSend 已关闭，不执行外发' }

      return withDouyin(svc, async (cdp) => {
        const page = await openImPage(cdp)
        if (!page.ok) return { ok: false, stage: 'page', error: page.error }
        const convs = await cdp.evaluate(IM_CONV_JS) || []
        const rendered = convs.filter((c) => c.w > 40 && c.h > 20)
        if (!rendered.length) {
          return { ok: false, stage: 'render', error: '私信会话没渲染出来（抖音没挂载私信视图），发不了' }
        }
        const found = findConv(rendered, uid || who)
        if (!found.ok) return { ok: false, stage: 'match', error: found.error, candidates: found.candidates || [] }
        const conv = found.conv

        await mouseClick(cdp, conv.x, conv.y)
        await sleepMs(2500)

        /**
         * 🔴 二次核对：点开的必须是目标那个人。
         *    参考实现踩过三个真实事故：已开会话误判、昵称 includes 匹配、屏外点击无反应但报成功。
         *    这里用右栏头部的 sec_uid（拿不到就退回昵称包含）核对，对不上就中止，宁可不发。
         */
        const peer = await cdp.evaluate(IM_PEER_JS).catch(() => null)
        if (!peer?.ok) {
          return { ok: false, stage: 'peer', error: '会话打开了但读不到右栏信息，无法核对身份，已中止' }
        }
        if (conv.sec_uid && peer.sec_uid && peer.sec_uid !== conv.sec_uid) {
          return {
            ok: false,
            stage: 'peer-mismatch',
            error: `打开的会话不是目标：右栏 sec_uid 与「${conv.nick}」不一致，已中止`,
            peer,
          }
        }
        if (!peer.sec_uid && peer.header && conv.nick && !peer.header.includes(conv.nick)) {
          return {
            ok: false,
            stage: 'peer-mismatch',
            error: `右栏昵称「${peer.header}」与目标「${conv.nick}」对不上，已中止`,
            peer,
          }
        }

        const editor = await cdp.evaluate(IM_EDITOR_JS)
        if (!editor) return { ok: false, stage: 'editor', error: '会话打开了但没找到输入框' }

        await mouseClick(cdp, editor.x, editor.y)
        await sleepMs(400)
        await cdp.send('Input.insertText', { text })
        await sleepMs(500)
        for (const type of ['keyDown', 'keyUp']) {
          await cdp.send('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            ...(type === 'keyDown' ? { text: '\r' } : {}),
          })
        }
        await sleepMs(3000)

        const rawAfter = await cdp.evaluate(IM_READ_JS)
        const after = inheritSender(Array.isArray(rawAfter) ? rawAfter : [])
        const probe = text.slice(0, 10)
        const hit = after.filter((m) => m.from === 'me' && m.text.includes(probe)).slice(-1)[0]
        log.log(`私信已提交：to=${conv.nick} 回读=${hit ? '见到' : '没见到'}`)
        return {
          ok: true,
          sent: true,
          to: { nick: conv.nick, sec_uid: conv.sec_uid },
          verified: Boolean(hit),
          readback: hit ? hit.text.slice(0, 80) : null,
          note: hit ? '' : '没在会话里回读到这条。可能被「只能发一条文字消息」限制拦住，或还在发送中。',
        }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  /* ─────────────── 自动化：只做「能真的做到」的部分 ─────────────── */

  const autoFile = join(P.state, 'autoreply.json')
  const sparkFile = join(P.state, 'spark.json')

  // P2b 收编：火花状态读本包自己的续火花台账（computer-use 侧已停注册同名）。
  const sparkStatus = {
    name: 'douyin_spark_status',
    description: '只读续火花状态：许可好友、每日次数、已发送记录与运行开关。不发送任何消息。',
    parameters: empty(),
    async execute() {
      const cfg = getCfg()
      const st = readJson(sparkFile, {})
      return {
        ok: true,
        enabled: st.enabled === true,
        contacts: st.contacts || [],
        perDay: cfg.sparkPerDay ?? null,
        sent: st.sent || {},
        startedAt: st.startedAt ?? null,
        stoppedAt: st.stoppedAt ?? null,
      }
    },
  }

  const sparkStart = {
    name: 'douyin_spark_start',
    description: '开启续火花：每天把当轮最值得看的一条用分享卡片发给许可好友（每好友每天一次）。需要先把好友昵称配进 contacts。',
    parameters: {
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          description: '许可好友（{nick} 或 {nick, sec_uid}），不给就用设置里的 sparkContacts',
          items: { type: 'object', additionalProperties: true },
        },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const cfg = getCfg()
      const raw = Array.isArray(args.contacts) && args.contacts.length
        ? args.contacts
        : (cfg.sparkContacts || []).map((n) => ({ nick: n }))
      const contacts = raw
        .map((c) => ({ nick: String(c?.nick || '').trim().slice(0, 40), sec_uid: String(c?.sec_uid || '').trim() }))
        .filter((c) => c.nick)
        .slice(0, 10)
      if (!contacts.length) return { ok: false, error: '没有许可好友：传 contacts，或先在设置里填 sparkContacts' }
      const conn = svc.bridge()
      if (conn.missing.length) return { ok: false, error: conn.missing.join('；') }
      const st = { enabled: true, contacts, sent: readJson(sparkFile, {}).sent || {}, startedAt: Date.now() }
      writeJson(sparkFile, st)
      log.log(`续火花已开启（${contacts.length} 位好友）`)
      return { ok: true, contacts, perDay: cfg.sparkPerDay, note: '每天把当轮第一条用分享卡片发过去；没有当轮数据就跳过' }
    },
  }

  const sparkStop = {
    name: 'douyin_spark_stop',
    description: '关闭续火花，保留已发送记录。',
    parameters: empty(),
    async execute() {
      const st = readJson(sparkFile, {})
      writeJson(sparkFile, { ...st, enabled: false, stoppedAt: Date.now() })
      log.log('续火花已关闭')
      return { ok: true, stopped: true }
    },
  }

  /* ─────────────── 推荐流：卡片流 + 翻页游标 ─────────────── */

  const FEED_URL = `${BASE}/?recommend=1&from_nav=1`
  const feedFile = join(P.state, 'feed.json')

  /** 读「推荐」页当前这一条：作品 id（或直播房间号）+ 文案 + 播放状态 */
  const RECO_ITEM_JS = `(() => {
    const v = document.querySelector('video');
    if (!v) return { err: 'no-video' };
    let n = v, ids = [], desc = '', caption = '';
    for (let d = 0; d < 14 && n; d++) {
      const fk = Object.keys(n).find((k) => k.indexOf('__reactFiber$') === 0);
      if (fk) {
        let f = n[fk], k2 = 0;
        while (f && k2 < 16) {
          const p = f.memoizedProps;
          if (p && typeof p === 'object') {
            for (const key of Object.keys(p)) {
              const val = p[key];
              if (typeof val === 'string' && /^\\d{19}$/.test(val)) ids.push({ key, val });
              else if (val && typeof val === 'object') {
                if (val.awemeId) ids.push({ key: 'awemeId', val: String(val.awemeId) });
                if (val.aweme_id) ids.push({ key: 'aweme_id', val: String(val.aweme_id) });
                if (!caption && typeof val.desc === 'string' && val.desc.trim().length > 4) caption = val.desc.replace(/\\s+/g, ' ').slice(0, 120);
              }
            }
          }
          f = f.return; k2++;
        }
      }
      if (!desc && n.innerText) desc = n.innerText.replace(/\\s+/g, ' ').slice(0, 120);
      n = n.parentElement;
    }
    const aweme = ids.find((x) => x.key === 'awemeId' || x.key === 'aweme_id');
    const room = ids.find((x) => x.key === 'roomId');
    return {
      paused: v.paused,
      ct: Math.round(v.currentTime * 10) / 10,
      aweme_id: aweme ? aweme.val : '',
      room_id: room ? room.val : '',
      desc: caption || desc,
    };
  })()`

  const readCardsJs = `(() => {
    const seen = new Set();
    const out = [];
    document.querySelectorAll('[data-aweme-id]').forEach((n) => {
      const id = String(n.getAttribute('data-aweme-id') || '');
      if (!/^\\d{15,25}$/.test(id) || seen.has(id)) return;
      const r = n.getBoundingClientRect();
      if (r.width < 80 || r.height < 60) return;
      seen.add(id);
      const lines = (n.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
      out.push({
        aweme_id: id,
        text: lines[0] || '',
        lines: lines.slice(0, 4),
        y: Math.round(r.top),
      });
    });
    return out;
  })()`

  const pickDesc = (lines) => {
    const cand = (lines || []).filter((l) => !/^\d{1,2}:\d{2}$/.test(l) && !['共创', '置顶', '广告', '热榜'].includes(l))
    return (cand.sort((a, b) => b.length - a.length)[0] || '').slice(0, 80)
  }

  const feedTool = {
    name: 'douyin_feed',
    description: '打开抖音推荐页，读当前屏的推荐卡片（作品 id + 文案 + 作者），并把候选存成游标。想多看几屏就加大 scrolls。之后用 douyin_next 一条条往下走。',
    parameters: {
      type: 'object',
      properties: {
        scrolls: { type: 'integer', minimum: 0, maximum: 8, description: '往下翻几屏加载更多，默认 0（只看当前屏）' },
        limit: { type: 'integer', minimum: 1, maximum: 40, description: '最多收多少条，默认 20' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_feed')
      if (gate) return gate
      const limit = clamp(args.limit ?? 20, 1, 40)
      const scrolls = clamp(args.scrolls ?? 0, 0, 8)

      return withDouyin(svc, async (cdp) => {
        await cdp.navigate(FEED_URL)
        await sleepMs(9000)
        const item = await cdp.evaluate(RECO_ITEM_JS)
        if (!item || item.err) return { ok: false, stage: 'empty', error: '推荐页没读到正在播放的视频（可能未登录或被风控）' }
        writeJson(feedFile, { at: Date.now(), cursor: 1, last: item })
        return {
          ok: true,
          index: 1,
          type: item.aweme_id ? 'video' : (item.room_id ? 'live' : 'unknown'),
          aweme_id: item.aweme_id,
          room_id: item.room_id,
          desc: item.desc,
          playing: { paused: item.paused, currentTime: item.ct },
          hint: '不喜欢就调 douyin_next（往下滑一条）；喜欢就 douyin_observe 看画面，再 douyin_share_card / douyin_comment_mention',
        }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const nextTool = {
    name: 'douyin_next',
    description: '在「推荐」流里往下滑一条（模拟滚轮），返回新的一条。不喜欢就连续调用它换视频；遇到直播默认返回直播信息（可用 douyin_live_open 进入直播间）。',
    parameters: {
      type: 'object',
      properties: {
        skip_live: { type: 'boolean', description: '遇到直播自动再滑一次跳过；默认 false（返回直播信息）' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_next')
      if (gate) return gate
      return withDouyin(svc, async (cdp) => {
        // 先确保还在推荐页（中途可能被别的工具导航走）
        const host = String(await cdp.evaluate('location.href').catch(() => ''))
        if (!/douyin\.com\/\?recommend=1/.test(host)) {
          await cdp.navigate(FEED_URL)
          await sleepMs(7000)
        }
        const skipLive = args.skip_live === true
        let last = null
        for (let i = 0; i < (skipLive ? 3 : 1); i += 1) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 420, deltaX: 0, deltaY: 820 })
          await sleepMs(2800)
          last = await cdp.evaluate(RECO_ITEM_JS)
          if (!last || last.err) break
          if (!last.room_id || !skipLive) break
        }
        if (!last || last.err) return { ok: false, stage: 'read', error: '下滑后没读到正在播放的视频' }
        const st = readJson(feedFile, { cursor: 0 })
        const cursor = (Number(st.cursor) || 0) + 1
        writeJson(feedFile, { ...st, at: Date.now(), cursor, last })
        return {
          ok: true,
          index: cursor,
          type: last.aweme_id ? 'video' : (last.room_id ? 'live' : 'unknown'),
          aweme_id: last.aweme_id,
          room_id: last.room_id,
          desc: last.desc,
          playing: { paused: last.paused, currentTime: last.ct },
        }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  /* ───────── 2026-10-27 新增：点赞 / 收藏 / 直播间 ───────── */

  /** 点击当前视频页侧栏按钮（点赞/收藏）：矩形中心 CDP 真实鼠标点击。 */
  async function clickPlayerButton(cdp, selector, label) {
    const hit = await cdp.evaluate(`(() => {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)
    if (!hit?.x) return { ok: false, error: `当前页面找不到${label}按钮（确认正在看视频且已登录）` }
    await mouseClick(cdp, hit.x, hit.y)
    await sleepMs(900)
    return { ok: true }
  }

  const likeTool = {
    name: 'douyin_like',
    description: '点赞当前打开的视频；传 video_id 会先打开该视频再点赞。',
    parameters: {
      type: 'object',
      properties: { video_id: { type: 'string', description: '要点赞的视频编号（aweme_id）；不传则点赞当前页面的视频' } },
      additionalProperties: false,
    },
    async execute(args = {}) {
      if (policy.warnOnly) return { ok: false, error: warnOnlyMessage('点赞') }
      return withDouyin(svc, async (cdp) => {
        if (args.video_id) {
          const id = String(args.video_id)
          if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
          await cdp.navigate(`${BASE}/video/${id}`)
          await sleepMs(5000)
        }
        const hit = await clickPlayerButton(cdp, '[data-e2e="video-player-like"], [data-e2e="feed-like-video"]', '点赞')
        return hit.ok ? { ok: true, liked: true, video_id: args.video_id || null } : hit
      })
    },
  }

  const collectTool = {
    name: 'douyin_collect',
    description: '收藏当前打开的视频；传 video_id 会先打开该视频再收藏。',
    parameters: {
      type: 'object',
      properties: { video_id: { type: 'string', description: '要收藏的视频编号（aweme_id）；不传则收藏当前页面的视频' } },
      additionalProperties: false,
    },
    async execute(args = {}) {
      if (policy.warnOnly) return { ok: false, error: warnOnlyMessage('收藏') }
      return withDouyin(svc, async (cdp) => {
        if (args.video_id) {
          const id = String(args.video_id)
          if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
          await cdp.navigate(`${BASE}/video/${id}`)
          await sleepMs(5000)
        }
        const hit = await clickPlayerButton(cdp, '[data-e2e="video-player-collect"], [data-e2e="feed-collect-video"]', '收藏')
        return hit.ok ? { ok: true, collected: true, video_id: args.video_id || null } : hit
      })
    },
  }

  const liveOpenTool = {
    name: 'douyin_live_open',
    description: '进入抖音直播间（room_id 取自 douyin_feed / douyin_next 返回的 room_id，也可直接给 live.douyin.com 链接）。',
    parameters: {
      type: 'object',
      properties: { room_id: { type: 'string', description: '直播间房间号（web_rid）或完整 live.douyin.com 链接' } },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const raw = String(args.room_id || '').trim()
      if (!raw) return { ok: false, error: '缺少 room_id' }
      const url = /^https?:\/\//.test(raw) ? raw : `https://live.douyin.com/${encodeURIComponent(raw)}`
      return withDouyin(svc, async (cdp) => {
        await cdp.navigate(url)
        await sleepMs(6000)
        const title = String(await cdp.evaluate('document.title || ""').catch(() => '')) || ''
        return { ok: true, live: true, url, title }
      })
    },
  }

  const liveObserveTool = {
    name: 'douyin_live_observe',
    description: '截取当前直播间的画面，并读取标题与页面上的在线人数等文本（弹幕不解析，看图判断）。',
    parameters: empty(),
    async execute() {
      return withDouyin(svc, async (cdp) => {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }).catch(() => null)
        const facts = await cdp.evaluate(`(() => {
          var t = document.title || '';
          var body = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300);
          return { title: t, body: body };
        })()`).catch(() => null)
        return { ok: true, live: true, title: facts?.title || '', text: facts?.body || '', frame: shot?.data ? { mimeType: 'image/jpeg', data: shot.data } : null }
      })
    },
  }

  /* ───────── P2b-2 浏览基础件（2026-10-27 收编；computer-use 侧已停注册同名）───────── */

  const openTool = {
    name: 'douyin_open',
    description: '打开抖音网页版推荐流，返回当前正在播放的一条。等价于 douyin_feed(scrolls=0)。',
    parameters: empty(),
    execute: () => feedTool.execute({ scrolls: 0 }),
  }

  const openVideoTool = {
    name: 'douyin_open_video',
    description: '打开指定作品页（19 位 aweme_id），返回打开后的页面与播放状态。',
    parameters: {
      type: 'object',
      properties: { aweme_id: { type: 'string', minLength: 10, maxLength: 30 } },
      required: ['aweme_id'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_open_video')
      if (gate) return gate
      const id = String(args.aweme_id || '').trim()
      if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
      return withDouyin(svc, async (cdp, b) => {
        await cdp.navigate(`${BASE}/video/${id}`)
        await sleepMs(4500)
        const page = await cdp.evaluate(PAGE_STATE_JS).catch(() => ({}))
        return { ok: true, aweme_id: id, mode: b.mode, page }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const SEARCH_ITEMS_JS = `(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const m = String(a.getAttribute('href') || '').match(/\\/video\\/(\\d{10,25})/);
      if (!m || out.some((x) => x.aweme_id === m[1])) continue;
      out.push({ aweme_id: m[1], text: (a.textContent || '').trim().slice(0, 60) });
      if (out.length >= 20) break;
    }
    return out;
  })()`

  const searchTool = {
    name: 'douyin_search',
    description: '在抖音搜索关键词，返回搜索结果页可见的作品卡片（id+文案）。只读，不自动打开任何一条。',
    parameters: {
      type: 'object',
      properties: { keyword: { type: 'string', minLength: 1, maxLength: 40 } },
      required: ['keyword'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const gate = browseGate('douyin_search')
      if (gate) return gate
      const keyword = String(args.keyword || '').trim().slice(0, 40)
      if (!keyword) return { ok: false, error: 'keyword 不能为空' }
      return withDouyin(svc, async (cdp, b) => {
        await cdp.navigate(`${BASE}/search/${encodeURIComponent(keyword)}`)
        await sleepMs(6500)
        const items = await cdp.evaluate(SEARCH_ITEMS_JS).catch(() => null)
        return { ok: Array.isArray(items), keyword, count: Array.isArray(items) ? items.length : 0, items: Array.isArray(items) ? items : [], mode: b.mode }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const previousTool = {
    name: 'douyin_previous',
    description: '在「推荐」流里往回滑一条（模拟滚轮向上），返回回到的那条。',
    parameters: empty(),
    async execute() {
      const gate = browseGate('douyin_previous')
      if (gate) return gate
      return withDouyin(svc, async (cdp) => {
        const host = String(await cdp.evaluate('location.href').catch(() => ''))
        if (!/douyin\.com\/\?recommend=1/.test(host)) {
          await cdp.navigate(FEED_URL)
          await sleepMs(7000)
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 420, deltaX: 0, deltaY: -820 })
        await sleepMs(2800)
        const item = await cdp.evaluate(RECO_ITEM_JS)
        if (!item || item.err) return { ok: false, stage: 'read', error: '上滑后没读到正在播放的视频' }
        const st = readJson(feedFile, { cursor: 1 })
        const cursor = Math.max(1, (Number(st.cursor) || 1) - 1)
        writeJson(feedFile, { ...st, at: Date.now(), cursor, last: item })
        return {
          ok: true,
          index: cursor,
          type: item.aweme_id ? 'video' : (item.room_id ? 'live' : 'unknown'),
          aweme_id: item.aweme_id,
          room_id: item.room_id,
          desc: item.desc,
          playing: { paused: item.paused, currentTime: item.ct },
        }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const PLAY_JS = `(() => { const v = document.querySelector('video'); if (!v) return { err: 'no-video' }; const p = v.play(); if (p && p.catch) p.catch(() => {}); return { paused: v.paused, ct: v.currentTime }; })()`
  const PAUSE_JS = `(() => { const v = document.querySelector('video'); if (!v) return { err: 'no-video' }; v.pause(); return { paused: v.paused, ct: v.currentTime }; })()`

  const playTool = {
    name: 'douyin_play',
    description: '播放当前抖音视频，并返回实际播放状态。',
    parameters: empty(),
    async execute() {
      const gate = browseGate('douyin_play')
      if (gate) return gate
      return withDouyin(svc, async (cdp) => {
        const r = await cdp.evaluate(PLAY_JS).catch(() => null)
        if (!r || r.err) return { ok: false, error: '没找到可播放的视频（页面可能不在作品/推荐流上）' }
        return { ok: true, playing: { paused: r.paused, currentTime: r.ct } }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const pauseTool = {
    name: 'douyin_pause',
    description: '暂停当前抖音视频。',
    parameters: empty(),
    async execute() {
      // douyin_pause 在 video-limits 的 READ_ACTIONS 豁免名单里（只停不看），闸恒放行。
      const gate = browseGate('douyin_pause')
      if (gate) return gate
      return withDouyin(svc, async (cdp) => {
        const r = await cdp.evaluate(PAUSE_JS).catch(() => null)
        if (!r || r.err) return { ok: false, error: '没找到可暂停的视频' }
        return { ok: true, playing: { paused: r.paused, currentTime: r.ct } }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  const mentionTool = {
    name: 'douyin_comment_mention',
    description: '在作品评论区发一条评论并 @ 指定的人（默认 @ 主人）。@ 必须走真实 UI 点选，接口补不出来。preview:true 只打开输入框、打出 @ 并返回弹层候选，不发送。',
    parameters: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', minLength: 10, maxLength: 30 },
        text: { type: 'string', minLength: 1, maxLength: 200, description: '评论正文（不含 @）' },
        mention: { type: 'string', maxLength: 40, description: '要 @ 的昵称，默认用设置里的 mentionName' },
        reply_cid: { type: 'string', maxLength: 30, description: '可选：回复这条评论（cid），而不是发新评论' },
        reply_text: { type: 'string', maxLength: 60, description: '可选：没有 cid 时按正文片段找那条评论' },
        preview: { type: 'boolean', description: '只验证 UI 流程，不发送' },
        confirm: { type: 'boolean', description: '必须为 true 才真的发送' },
      },
      required: ['aweme_id', 'text'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const cfg = getCfg()
      const id = String(args.aweme_id || '').trim()
      const text = String(args.text || '').trim()
      const who = String(args.mention || cfg.mentionName || '').trim()
      if (!/^\d{10,25}$/.test(id)) return { ok: false, error: 'aweme_id 必须是纯数字' }
      if (!text) return { ok: false, error: 'text 不能为空' }
      if (!who) return { ok: false, error: '没指定要 @ 谁：设置里填 mentionName（你的抖音昵称），或传 mention' }
      if (args.preview !== true && args.confirm !== true) {
        return { ok: false, needsConfirm: true, error: '需要 confirm:true 才真的发送（preview:true 可只看不发）', wouldPost: { aweme_id: id, text, mention: who } }
      }
      if (args.preview !== true && !cfg.autoSend) return { ok: false, error: 'autoSend 已关闭，不执行外发' }

      return withDouyin(svc, async (cdp) => {
        const replyCidEarly = String(args.reply_cid || '').trim()
        // 带 comment_id 打开时，抖音会把那条评论定位出来（否则它在懒加载列表里翻不到）
        const navUrl = replyCidEarly
          ? `${BASE}/video/${id}?comment_id=${encodeURIComponent(replyCidEarly)}`
          : `${BASE}/video/${id}`
        await cdp.navigate(navUrl)
        await sleepMs(6500)

        /**
         * 回复模式（reply_cid / reply_text）：先点那条评论下面的「回复」，评论区会就地展开一个编辑框。
         * 不指定就走「发新评论」：点占位符展开编辑器。
         */
        const replyCid = String(args.reply_cid || '').trim()
        const replyText = String(args.reply_text || '').trim()
        if (replyCid || replyText) {
          const findJs = `(function () {
            var cid = ${JSON.stringify(replyCid)};
            var piece = ${JSON.stringify(replyText)};
            var items = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"], [class*="commentItem"], [class*="comment-item"]'));
            function cidOf(n) {
              var fk = Object.keys(n).find(function (k) { return k.indexOf('__reactFiber$') === 0; });
              if (!fk) return '';
              var f = n[fk], d = 0;
              while (f && d < 16) {
                var p = f.memoizedProps;
                if (p && typeof p === 'object') {
                  if (p.comment && p.comment.cid) return String(p.comment.cid);
                  if (p.cid) return String(p.cid);
                }
                f = f.return; d++;
              }
              return '';
            }
            var target = null;
            if (cid) target = items.find(function (n) { return cidOf(n) === cid; });
            if (!target && piece) target = items.find(function (n) { return (n.innerText || '').indexOf(piece) >= 0; });
            if (!target) return JSON.stringify({ err: 'no-comment', scanned: items.length });
            try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
            var btns = Array.prototype.slice.call(target.querySelectorAll('div,span'))
              .filter(function (e) { return (e.innerText || '').trim() === '回复' && e.getBoundingClientRect().width > 10; });
            var b = btns[0];
            if (!b) return JSON.stringify({ err: 'no-reply-btn' });
            var r = b.getBoundingClientRect();
            return JSON.stringify({ ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
          })()`

          // 🔴 先让评论区进入视口：评论是懒加载的，不滚出来一个节点都没有（参考实现的关键一步）
          try {
            await cdp.evaluate(`(function () {
              var el = document.querySelector('#comment-input-container');
              if (el) el.scrollIntoView({ block: 'center' });
              return 1;
            })()`)
          } catch { /* 滚不动就继续 */ }
          await sleepMs(1600)

          // 评论是懒加载的：没找到就往下滚再找，最多 8 轮
          let t = {}
          for (let i = 0; i < 8; i += 1) {
            try { t = JSON.parse(await cdp.evaluate(findJs) || '{}') } catch { t = {} }
            if (t.ok) break
            await cdp.evaluate(`(() => {
              const l = document.querySelector('[class*="commentList"], [class*="comment-list"]');
              if (l) l.scrollTop += 900; else window.scrollBy(0, 900);
              return 1;
            })()`)
            await sleepMs(1300)
          }
          if (!t.ok) {
            return {
              ok: false,
              stage: 'reply-target',
              error: t.err === 'no-reply-btn' ? '找到那条评论了，但它下面没有「回复」按钮' : '评论区里没找到要回复的那条评论（可能没加载到）',
            }
          }
          await mouseClick(cdp, t.x, t.y)
          await sleepMs(1800)
        } else {
          const box = await cdp.evaluate(`(function () {
            var el = document.querySelector('#comment-input-container');
            if (!el) return null;
            try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
            var r = el.getBoundingClientRect();
            if (r.width < 60 || r.height < 10) return null;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`)
          if (!box) return { ok: false, stage: 'editor', error: '找不到评论输入框（评论区可能没展开）' }
          await mouseClick(cdp, box.x, box.y)
          await sleepMs(1500)
        }

        // 找到真正的 DraftJS 编辑器并聚焦（回复模式下它已经在了）
        let realEditor = null
        for (let i = 0; i < 3 && !realEditor; i += 1) {
          realEditor = await cdp.evaluate(`(function () {
            var el = document.querySelector('.public-DraftEditor-content') || document.querySelector('[contenteditable="true"]');
            if (!el) return null;
            var r = el.getBoundingClientRect();
            if (r.width < 60 || r.height < 10) return null;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`)
          if (!realEditor) await sleepMs(1000)
        }
        if (!realEditor) return { ok: false, stage: 'editor-expand', error: '评论框没展开成 DraftJS 编辑器' }
        await mouseClick(cdp, realEditor.x, realEditor.y)
        await sleepMs(700)

        // 打 @：必须用键盘事件，execCommand 不会触发弹层。⚠️ 不要带 Shift 修饰位
        for (const type of ['keyDown', 'keyUp']) {
          await cdp.send('Input.dispatchKeyEvent', {
            type,
            key: '@',
            code: 'Digit2',
            text: type === 'keyDown' ? '@' : undefined,
            windowsVirtualKeyCode: 50,
            nativeVirtualKeyCode: 50,
          })
        }
        await sleepMs(1800)

        /**
         * 找弹层那一行：参考实现的做法是**只看叶子节点、innerText 精确等于昵称、取最窄的那个**。
         * 之前按"面板宽度区间"去枚举候选，抓到的是左侧导航和播放数据 —— 完全跑偏。
         */
        const popupRaw = await cdp.evaluate(`(function () {
          var NAME = ${JSON.stringify(who)};
          var rows = [];
          document.querySelectorAll('div,span,li,p').forEach(function (e) {
            if (e.children.length) return;
            var t = (e.innerText || '').trim();
            if (!t || t.length > 30) return;
            var r = e.getBoundingClientRect();
            if (!(r.width > 4 && r.height > 8)) return;
            rows.push({ nick: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) });
          });
          var hits = rows.filter(function (x) { return x.nick === NAME; }).sort(function (a, b) { return a.w - b.w; });
          if (hits.length) return JSON.stringify({ match: hits[0], candidates: [] });
          var ed = document.querySelector('.public-DraftEditor-content');
          var top = ed ? ed.getBoundingClientRect().top : 0;
          var near = rows.filter(function (x) { return x.y < top && x.y > top - 460 && x.w >= 40 && x.w <= 400; });
          var seen = {}, uniq = [];
          near.forEach(function (o) { if (!seen[o.nick]) { seen[o.nick] = 1; uniq.push(o.nick); } });
          return JSON.stringify({ match: null, candidates: uniq.slice(0, 20) });
        })()`)
        let found = {}
        try { found = JSON.parse(popupRaw || '{}') } catch { found = {} }
        const match = found.match || null
        const candidates = Array.isArray(found.candidates) ? found.candidates : []

        if (args.preview === true) {
          return { ok: Boolean(match || candidates.length), preview: true, matched: match ? match.nick : '', candidates }
        }
        if (!match) {
          return { ok: false, stage: 'mention', error: `@ 弹层里没找到「${who}」（可能没互关，或昵称不对）`, candidates }
        }

        await mouseClick(cdp, match.x, match.y)   // 真实点选，只有这样才能保住 sec_uid
        await sleepMs(900)

        const filled = await cdp.evaluate(`(function () {
          var ed = document.querySelector('.public-DraftEditor-content') || document.querySelector('#comment-input-container [contenteditable="true"]');
          if (!ed) return false;
          ed.focus();
          document.execCommand('insertText', false, ${JSON.stringify(` ${text}`)});
          return true;
        })()`)
        if (!filled) return { ok: false, stage: 'fill', error: '正文没填进去' }
        await sleepMs(600)

        /**
         * 发送按钮：页面上有 4 个 fill=FE2C55 的 svg（顶栏、播放器、点赞、发送）。
         * 🔴 实测：直接取第一个会点到顶栏图标 —— 必须挑**和编辑器同一行、且在它右侧**的那个。
         */
        const sendBtn = await cdp.evaluate(`(function () {
          var ed = document.querySelector('.public-DraftEditor-content');
          if (!ed) return null;
          var er = ed.getBoundingClientRect();
          var cx = er.x + er.width / 2, cy = er.y + er.height / 2;
          var best = null, bestD = 1e9;
          document.querySelectorAll('svg').forEach(function (s) {
            var html = String(s.outerHTML || '');
            if (!/FE2C55/i.test(html)) return;
            var r = s.getBoundingClientRect();
            if (r.width < 20 || r.height < 20) return;
            if (r.x < cx) return;
            var d = Math.abs(r.y + r.height / 2 - cy);
            if (d < 90 && d < bestD) { bestD = d; best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }
          });
          return best;
        })()`)
        if (!sendBtn) return { ok: false, stage: 'send-btn', error: '找不到发送按钮（编辑器右侧的红色箭头）' }

        await mouseClick(cdp, sendBtn.x, sendBtn.y)
        if (!(await cdp.evaluate(`(function(){ var ed=document.querySelector('.public-DraftEditor-content'); return ed ? (ed.innerText||'').length : 0; })()`))) {
          // 没清空输入框通常意味着没点成功，再对同一个坐标补一次原生 click
          await cdp.evaluate(`(function () {
            var el = document.elementFromPoint(${sendBtn.x}, ${sendBtn.y});
            if (!el) return false;
            var t = el.closest('button,div,span') || el;
            t.click();
            return true;
          })()`)
        }
        await sleepMs(3000)

        const back = await fetchComments(cdp, id, { pages: 1 })
        const probe = text.slice(0, 8)
        let hit = (back.comments || []).find((c) => c.text.includes(probe))
        // 回复是挂在父评论下面的：顶层列表里找不到时，去 replies 里再找一遍
        if (!hit) {
          for (const c of back.comments || []) {
            const r = (c.replies || []).find((x) => x.text.includes(probe))
            if (r) { hit = { ...r, parent: c.cid }; break }
          }
        }
        log.log(`评论+@ 提交：aweme=${id} mention=${match.nick} 回读=${hit ? '看到' : '没看到'}`)
        // 已发出就不是失败：列表暂时回读不到多为「审核中」（2026-10-26 实测发出的评论回读为空但 @ 通知已送达），
        // 标 verified:false 并给提示，而不是把整个调用报成失败。
        return {
          ok: true,
          sent: true,
          mention: match.nick,
          cid: hit?.cid || '',
          verified: Boolean(hit),
          readback: hit ? hit.text.slice(0, 80) : null,
          note: hit ? '' : '已发送，评论列表暂未回读到（可能还在审核），请稍后人工确认',
        }
      }, { mode: 'visible', reuseAny: false })
    },
  }

  /**
   * 评论互动值班（2026-10-29，设计文档 computer-use-main/docs/comment-interaction-dev.md）：
   *   R1 我@随时回 / R2 多轮续话 / R3 路人问答（默认关）/ R4 答不上 @豆包 求助。
   * 使用者决策：不限次数；豆包回答后总结给主人；多轮上限默认 5（设置里可改）。
   */
  const modelRoute = { provider: 'deepseek-official', model: 'deepseek-flash' }
  let commentDutyPromise = null
  const parseCommentGen = (raw) => {
    const s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    for (const candidate of [s, (/\{[\s\S]*\}/.exec(s) || [])[0]]) {
      if (!candidate) continue
      try {
        const o = JSON.parse(candidate)
        return { reply: String(o.reply || ''), needExpert: o.needExpert === true, question: String(o.question || '') }
      } catch { /* 试下一个 */ }
    }
    return { reply: s.slice(0, 60), needExpert: false, question: '' }
  }
  const generateCommentReply = async ({ commentText, commentUser, isOwner, expertAnswer }) => {
    let llm
    try { llm = svc.ctx?.get?.('llm') } catch { llm = undefined }
    if (!llm || typeof llm.stream !== 'function') throw new Error('DSH 模型服务不可用，未生成评论回复。')
    const persona = String(personaMemory?.context?.() || '').slice(0, 1200)
    const system = [
      '你是大肥鱼，正在抖音评论区公开回复。只输出一行 JSON（不要代码块）：{"reply":"回复内容","needExpert":false,"question":""}',
      '规则：reply 不超过 60 字，口语化、真诚、像真人评论；不带链接、不带@、不带话题标签。',
      '答不上、不确定、或问题涉实时信息时，needExpert 置 true，把想问豆包的具体问题放进 question（不超过 80 字）。',
      expertAnswer ? '豆包已给出参考答案，把它口语化总结给对方，可以提一句“我问了豆包”。' : '',
      `你的人格：${persona}`,
    ].filter(Boolean).join('\n')
    const user = `${commentUser}${isOwner ? '（主人）' : ''} 在评论区说：「${commentText}」${expertAnswer ? `豆包的参考答案：「${expertAnswer}」` : ''}`
    const messages = [{ id: `cmt-${Date.now()}-${Math.random().toString(36).slice(2)}`, role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'plugin', plugin: 'douyin-browser', form: 'snapshot', sections: [] } }]
    let text = '', finish
    for await (const chunk of llm.stream({ provider: modelRoute.provider, model: modelRoute.model, messages, system, maxTokens: 400 })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !text) text += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind !== 'stop') throw new Error(`评论回复生成未完整返回（${finish?.kind || '缺少完成标记'}），未发布。`)
    return parseCommentGen(text)
  }
  const getCommentDuty = () => {
    commentDutyPromise ??= (async () => {
      const { CommentDuty } = await import('./comment-duty.mjs')
      return new CommentDuty({
        stateDir: resolveSharedVideoStateDir(P.state),
        browse: (fn) => withDouyin(svc, fn, { mode: 'visible', reuseAny: false }),
        publish: (input) => withDouyin(svc, (cdp) => publishComment(cdp, input), { mode: 'visible', reuseAny: false }),
        askDoubao: async ({ awemeId, question }) => {
          let nick = '豆包'
          try {
            const saved = JSON.parse(readFileSync(join(resolveSharedVideoStateDir(P.state), 'comment-duty.json'), 'utf8'))
            nick = saved.doubaoNick || nick
          } catch { /* 用回退昵称 */ }
          return mentionTool.execute({ aweme_id: awemeId, text: question, mention: nick, confirm: true })
        },
        fetchComments: (cdp, id, opts) => fetchComments(cdp, id, opts),
        fetchAtMe: (cdp) => fetchAtMe(cdp),
        generate: generateCommentReply,
        notify: async (text) => { try { const conn = svc.bridge(); await sendToOwner(conn, text, { maxChars: 800, gapMs: 1200 }) } catch { /* 通知失败不阻塞值班 */ } },
        onEvent: (event) => { try { log.log(`comment-duty ${event.type}: ${event.message || ''}`) } catch { /* 日志失败忽略 */ } },
      })
    })().catch((error) => { commentDutyPromise = null; throw error })
    return commentDutyPromise
  }

  const commentDutyStatusTool = {
    name: 'douyin_comment_duty_status',
    description: '读取评论互动值班的状态与设置：回复开关、多轮上限、今日已回、活动线程、豆包求助进度。只读。',
    parameters: empty(),
    async execute() {
      try { return { ok: true, ...(await getCommentDuty()).state() } }
      catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    },
  }

  const commentDutyStartTool = {
    name: 'douyin_comment_duty_start',
    description: '按用户要求开启评论互动值班：自动回复主人@、线程续话；答不上时按设置向豆包求助。用户说停才停。',
    parameters: empty(),
    async execute(args = {}, exec = {}) {
      try {
        const route = exec.agent?.session?.requestHeader?.()?.config ?? exec.agent?.options ?? {}
        if (route.provider) modelRoute.provider = route.provider
        if (route.model) modelRoute.model = route.model
        const duty = await getCommentDuty()
        const state = duty.configure({ enabled: true }, { explicit: true })
        duty.ensureRunning()
        return { ok: true, ...state }
      } catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    },
  }

  const commentDutyStopTool = {
    name: 'douyin_comment_duty_stop',
    description: '按用户要求停止评论互动值班（说停即停，不再自动回复评论）。',
    parameters: empty(),
    async execute() {
      try { return { ok: true, ...(await getCommentDuty()).stop() } }
      catch (error) { return { ok: false, error: error?.message ?? String(error) } }
    },
  }

  const askExpertTool = {
    name: 'douyin_ask_expert',
    description: '在作品评论区发一条评论 @豆包 官方账号提问（走真实 UI 点选艾特）。豆包回复通常一分钟内、偶尔不回，同一条视频一般只回复一次。必须 confirm:true 才发。',
    parameters: {
      type: 'object',
      properties: {
        aweme_id: { type: 'string', minLength: 10, maxLength: 30 },
        question: { type: 'string', minLength: 1, maxLength: 80, description: '要问豆包的问题（一句话）' },
        confirm: { type: 'boolean', description: '必须为 true 才真的发送' },
      },
      required: ['aweme_id', 'question'],
      additionalProperties: false,
    },
    async execute(args = {}) {
      let nick = '豆包'
      try { nick = (await getCommentDuty()).config().doubaoNick || nick } catch { /* 用回退昵称 */ }
      return mentionTool.execute({ aweme_id: args.aweme_id, text: String(args.question || '').trim().slice(0, 80), mention: nick, confirm: args.confirm })
    },
  }


  // 撞名收口（2026-10-27，主干-分支重组 P2a）：douyin_status / observe / screenshot / remember /
  // recall / next / spark_start / spark_stop 这 8 个曾与 computer-use 同名的工具**正式归本包注册**
  // （computer-use 侧已停注册同名，DSH 工具面不再有双份）。语义裁决：
  //   · status 用本包「插件状态」版（登录态/轮次/额度/时段/投递通道）；
  //   · observe / screenshot 用本包采样版（前后帧截图 + 播放进度），观看链全部过轮次闸；
  //   · remember / recall 用本包记忆；spark 用本包火花问候。
  // P2b/P3 继续把 computer-use 剩余抖音功能收编进本包，主干只留 computer_* 运行时。
  // P2b 补：video_limits_status / spark_status / interest_record / persona_status /
  // report_status / report_generate 也已由本包收编（computer-use 侧停注册同名；
  // interest_record 是第 9 个撞名，赢家为本包的证据制兴趣台账）。
  // P2b-2 补：浏览基础件 open/search/open_video/previous/play/pause 也已由本包实现并注册
  //（本包 CDP 版；computer-use 侧停注册同名）。
  // P2b-3 补：chat_* / media_* / forward_video / watch_* / diagnostics* 已由本包收编（engine 委托）。
  // 至此抖音工具面全部归本包；computer-use 只留 computer_* 主干。
  // 2026-10-27 界面精简：douyin_media_status / douyin_listen（音频与密钥）、
  // douyin_report_status / douyin_report_generate（观看日报）、douyin_diagnostics /
  // douyin_diagnostics_repair（自检与用量）六个功能已按使用者要求删除。
  // ── 值班定时器（2026-10-27 新增）────────────────────────────────────
  // ①「永久启用」：私信自动回复与主动问候只要许可开着就自动拉起（设置页只留开关）。
  // ②「每轮结束摘要推送」：自主观看由运行转停止时，把本轮观察要点发给 QQ 主人。
  if (!dutyState.timer) {
    dutyState.timer = setInterval(() => {
      void (async () => {
        try {
          const status = await engineCall('douyin_watch_status', {}).catch(() => null);
          const running = Boolean(status?.ok && (status.running || status.starting || status.worker?.alive));
          if (running) { dutyState.watchRunning = true; dutyState.startedAt = dutyState.startedAt || Date.now(); }
          else if (dutyState.watchRunning) {
            dutyState.watchRunning = false;
            const since = dutyState.startedAt; dutyState.startedAt = 0;
            try {
              const snap = personaMemory?.snapshot?.();
              const obs = (snap?.recentObservations || []).filter(o => !since || Date.parse(o.observedAt || o.at || 0) >= since).slice(0, 5);
              const conn = svc.bridge();
              // 2026-10-29 使用者反馈「停下来莫名其妙」：摘要必须带上停止原因；持续观看中注明继续。
              const why = String(status?.lastError || '').trim().slice(0, 120);
              const more = Number(status?.continuousUntil || 0) > Date.now() ? '，继续观看中' : '';
              await sendToOwner(conn, `📺 本轮自主观看结束了${why ? `（${why}）` : ''}${more}${obs.length ? `，看了这些：\n${obs.map(o => `· ${(o.text || o.title || '').slice(0, 50)}`).join('\n')}` : '。'}`, { maxChars: 800, gapMs: 1200 });
            } catch { /* 摘要失败不影响值班 */ }
          }
          const chat = await engineCall('douyin_chat_status', {}).catch(() => null);
          if (chat?.ok && !chat.running && (chat.policy?.allowlist || []).length) await engineCall('douyin_chat_start', {}).catch(() => {});
          const spark = await engineCall('douyin_spark_status', {}).catch(() => null);
          if (spark?.ok && spark.enabled && !spark.running) await engineCall('douyin_spark_start', {}).catch(() => {});
          // ④ 评论互动值班（2026-10-29）：许可开着就自动拉起（DSH 重启后自恢复）。
          try { const duty = await getCommentDuty(); if (duty.config().enabled) duty.ensureRunning() } catch { /* 值班自检失败静默 */ }
        } catch { /* 值班自检失败静默 */ }
      })();
    }, 60_000);
    dutyState.timer.unref?.();
  }

  return [statusTool, configTool, doctorTool, loginTool,
    scoutTool, videoTool, commentsTool, noticesTool, atMeTool, runTool,
    shotTool, observeTool, rememberTool, recallTool, personaTool, interestTool, shareCardTool,
    commentReplyTool, mentionTool, imReadTool, dmTool,
    commentDutyStatusTool, commentDutyStartTool, commentDutyStopTool, askExpertTool,
    sparkStatus, sparkStart, sparkStop,
    feedTool, openTool, openVideoTool, searchTool, nextTool, previousTool, playTool, pauseTool,
    likeTool, collectTool, liveOpenTool, liveObserveTool,
    limitsStatusTool, personaStatusTool,
    chatContactsTool, chatStatusTool, chatStartTool, chatStopTool, chatReadTool, chatObserveTool,
    forwardTool,
    watchStatusTool, watchStartTool, watchStopTool]
}
