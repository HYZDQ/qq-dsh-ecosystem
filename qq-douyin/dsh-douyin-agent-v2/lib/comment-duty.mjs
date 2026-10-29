/**
 * lib/comment-duty.mjs —— 评论互动值班（R1 我@回复 / R2 多轮续话 / R3 路人问答 / R4 @豆包求助）
 * ============================================================================
 * 设计文档：computer-use-main/docs/comment-interaction-dev.md（2026-10-29）
 * 使用者决策：回复路人默认关；不限次数；豆包回答后总结给主人；多轮上限默认 5 轮（可改）。
 *
 * 边界：
 *   - 依赖全部注入（browse/publish/askDoubao/fetchComments/fetchAtMe/generate/notify），
 *     插件与软件两个入口可复用同一实现，测试用假件即可覆盖；
 *   - fail-closed：生成不出来、发布没核实、目标挂载不确定 → 不发，宁可漏回也不发错位置；
 *   - 不限次数（使用者决策），保留的护栏只有：多轮上限、随机发送间隔、同视频 @豆包 只问一次。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const COMMENT_DUTY_DEFAULTS = Object.freeze({
  enabled: true,        // 评论互动总开关（开着就由值班自动拉起）
  replyOwner: true,     // R1/R2：回复主人的 @ 与续话
  multiTurn: true,      // R2：多轮对话
  maxTurns: 5,          // 每条线程最多回几轮（使用者可改）
  replyStranger: false, // R3：回复路人（默认关，使用者决策）
  expertAsk: true,      // R4：答不上时 @豆包 求助
  expertTimeoutMin: 5,  // 等豆包回复的超时（分钟）
  doubaoNick: '豆包',    // 豆包官方账号昵称（@ 弹层按这个找）
  ownerNick: '',        // 主人的抖音昵称（用来区分“我”和路人；空=认不出主人，@一律按路人处理）
  intervalSec: 90,      // 轮询间隔
})

export function validateCommentDutyConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('评论互动设置须为对象。')
  for (const key of Object.keys(value)) if (!Object.hasOwn(COMMENT_DUTY_DEFAULTS, key)) throw new Error(`不支持的评论互动设置：${key}`)
  for (const key of ['enabled', 'replyOwner', 'multiTurn', 'replyStranger', 'expertAsk']) {
    if (key in value && typeof value[key] !== 'boolean') throw new Error(`${key} 须为开关。`)
  }
  if ('maxTurns' in value && (!Number.isSafeInteger(value.maxTurns) || value.maxTurns < 1 || value.maxTurns > 20)) throw new Error('多轮上限须为1至20的整数。')
  if ('expertTimeoutMin' in value && (!Number.isSafeInteger(value.expertTimeoutMin) || value.expertTimeoutMin < 1 || value.expertTimeoutMin > 30)) throw new Error('豆包超时须为1至30分钟。')
  if ('intervalSec' in value && (!Number.isSafeInteger(value.intervalSec) || value.intervalSec < 30 || value.intervalSec > 600)) throw new Error('轮询间隔须为30至600秒。')
  for (const key of ['doubaoNick', 'ownerNick']) {
    if (key in value && (typeof value[key] !== 'string' || value[key].length > 40)) throw new Error(`${key} 须为不超过40字的昵称。`)
  }
  return { ...value }
}

const read = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error('评论互动状态文件损坏，未覆盖原记录。')
  }
}
const write = (file, value) => {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file) } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/** 发送前清洗（风控实践：去 URL、去 @、压空白、限字数） */
export function sanitizeReply(text, maxLen = 60) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

export class CommentDuty {
  constructor({ stateDir, browse, publish, askDoubao, fetchComments, fetchAtMe, generate, notify, now = Date.now, onEvent = () => {} }) {
    for (const [name, fn] of Object.entries({ browse, publish, askDoubao, fetchComments, fetchAtMe, generate })) {
      if (typeof fn !== 'function') throw new Error(`评论互动缺少 ${name} 依赖。`)
    }
    Object.assign(this, { stateDir, browse, publish, askDoubao, fetchComments, fetchAtMe, generate, notify: notify || (async () => {}), now, onEvent })
    this.configFile = path.join(stateDir, 'comment-duty.json')
    this.threadsFile = path.join(stateDir, 'comment-threads.json')
    this.timer = null
    this.busy = false
  }

  config() { return { ...COMMENT_DUTY_DEFAULTS, ...validateCommentDutyConfig(read(this.configFile, {})) } }

  configure(patch, { explicit = false } = {}) {
    if (!explicit) throw new Error('评论互动设置需要明确保存。')
    const merged = validateCommentDutyConfig({ ...this.config(), ...patch })
    fs.mkdirSync(path.dirname(this.configFile), { recursive: true })
    write(this.configFile, merged)
    // 只管配置，不隐式拉起循环（启动由工具/值班显式 ensureRunning，避免配置写入带出后台任务）。
    if (!merged.enabled) this.clearTimer()
    return this.state()
  }

  threads() {
    const value = read(this.threadsFile, { version: 1, threads: {}, expert: {}, seen: [], repliedDay: {} })
    if (value?.version !== 1 || typeof value.threads !== 'object' || typeof value.expert !== 'object' || !Array.isArray(value.seen)) throw new Error('评论互动线程记录损坏，未覆盖原记录。')
    if (value.seen.length > 4000) value.seen = value.seen.slice(-3000)
    return value
  }

  saveThreads(value) { fs.mkdirSync(path.dirname(this.threadsFile), { recursive: true }); write(this.threadsFile, value) }

  state() {
    const cfg = this.config(), t = this.threads()
    const active = Object.values(t.threads).filter(th => th.status === 'active').length
    const pendingExpert = Object.values(t.expert).filter(e => e && !e.answered).length
    const day = new Date(this.now()).toISOString().slice(0, 10)
    return {
      protocol: 'comment-duty-v1',
      config: cfg,
      running: Boolean(this.timer),
      activeThreads: active,
      repliedToday: t.repliedDay[day] || 0,
      pendingExpert,
    }
  }

  ensureRunning() {
    if (this.timer || !this.config().enabled) return
    const interval = this.config().intervalSec * 1000
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, interval)
    this.timer.unref?.()
    void this.tick().catch(() => {})
  }

  clearTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  /** 说停即停：关总开关并停循环。 */
  stop() { this.clearTimer(); return this.configure({ enabled: false }, { explicit: true }) }

  async tick() {
    if (this.busy) return { ok: true, skipped: true }
    this.busy = true
    const actions = []
    try {
      const cfg = this.config()
      if (!cfg.enabled) return { ok: true, disabled: true }
      const t = this.threads()
      await this.browse(async (cdp) => {
        const at = await this.fetchAtMe(cdp)
        const mentions = (at.items || []).filter(x => x.aweme_id && x.comment_id && x.user !== cfg.doubaoNick && !t.seen.includes(x.comment_id))
        const awemeIds = new Set(mentions.map(x => x.aweme_id))
        for (const th of Object.values(t.threads)) if (th.status === 'active') awemeIds.add(th.aweme_id)
        for (const [awemeId, e] of Object.entries(t.expert)) if (e && !e.answered) awemeIds.add(awemeId)
        const cache = new Map()
        const commentsOf = async (awemeId) => {
          if (!cache.has(awemeId)) cache.set(awemeId, await this.fetchComments(cdp, awemeId, { pages: 2 }))
          return cache.get(awemeId)
        }
        const day = new Date(this.now()).toISOString().slice(0, 10)

        // ④ 通用回复动作：生成 → 发布 → 回读核实 → 记账（超时兜底用固定话术，不走模型）
        const replyOnce = async ({ awemeId, rootCid, replyCid, question, questionUser, isOwner, expertAnswer, timeout = false }) => {
          let text = ''
          if (timeout) text = '这个问题我暂时答不好，回头研究明白了再来聊。'
          else {
            let out
            try { out = await this.generate({ commentText: question, commentUser: questionUser, isOwner, expertAnswer }) }
            catch (error) { this.onEvent({ type: 'comment_duty.generate_failed', message: error.message || String(error) }); return null }
            text = sanitizeReply(out?.reply)
            if (!text) {
              if (cfg.expertAsk && out?.needExpert && out.question) return { expertQuestion: String(out.question).slice(0, 80) }
              return null
            }
          }
          const sent = await this.publish({ awemeId, text, rootCid, replyCid })
          if (!sent?.ok) { this.onEvent({ type: 'comment_duty.publish_failed', message: sent?.error || '发布没核实' }); return null }
          t.repliedDay[day] = (t.repliedDay[day] || 0) + 1
          return { text, sent }
        }

        // ① 豆包应答/超时（R4）
        for (const [awemeId, e] of Object.entries(t.expert)) {
          if (!e || e.answered) continue
          const r = await commentsOf(awemeId)
          const askRoot = (r.comments || []).find(x => x.cid === e.askCid)
          const answer = (askRoot?.replies || []).find(c => c.user === cfg.doubaoNick && c.cid !== e.askCid)
          const followUp = async (expertAnswer, timeout = false) => {
            const target = e.threadRoot && t.threads[e.threadRoot]?.status === 'active'
              ? { rootCid: t.threads[e.threadRoot].rootCid, replyCid: e.askerCid || null }
              : { rootCid: e.rootCid, replyCid: e.replyCid || null }
            if (!target.rootCid) return
            const done = await replyOnce({ awemeId, ...target, question: e.askerQuestion || e.question, questionUser: e.askerUser || '', isOwner: e.askerIsOwner === true, expertAnswer, timeout })
            if (done?.sent && e.threadRoot && t.threads[e.threadRoot]) {
              const th = t.threads[e.threadRoot]
              th.turns += 1; th.ourCids.push(done.sent.cid || randomUUID()); if (e.askerCid) th.seen.push(e.askerCid)
            }
          }
          if (answer) {
            e.answered = true; e.answerText = answer.text; e.answeredAt = this.now()
            const summary = `🧠 豆包回答了「${String(e.question).slice(0, 40)}」：${String(answer.text).slice(0, 140)}`
            actions.push({ type: 'expert_answer', awemeId, summary })
            await followUp(answer.text)
            await this.notify(summary) // 使用者决策：豆包回答后总结给我
          } else if (this.now() > e.deadline) {
            e.answered = true; e.timedOut = true
            actions.push({ type: 'expert_timeout', awemeId, question: e.question })
            await followUp('', true)
            await this.notify(`🧠 「${String(e.question).slice(0, 40)}」问了豆包没等到回答，已如实回复提问者。`)
          }
        }

        // ② @我（R1 主人 / R3 路人）
        for (const m of mentions) {
          t.seen.push(m.comment_id)
          const isOwner = Boolean(cfg.ownerNick) && m.user === cfg.ownerNick
          if (!isOwner) {
            if (!cfg.replyStranger) { actions.push({ type: 'mention_skipped', user: m.user }); continue } // 决策1：路人默认不回
          } else if (!cfg.replyOwner) continue
          const r = await commentsOf(m.aweme_id)
          let rootCid = '', replyCid = null
          const asRoot = (r.comments || []).find(c => c.cid === m.comment_id)
          if (asRoot) rootCid = asRoot.cid
          else {
            const parent = (r.comments || []).find(c => (c.replies || []).some(rr => rr.cid === m.comment_id))
            if (parent) { rootCid = parent.cid; replyCid = m.comment_id }
          }
          if (!rootCid) { this.onEvent({ type: 'comment_duty.target_unresolved', message: `@我评论 ${m.comment_id} 没定位到挂载位置，跳过。` }); continue } // fail-closed
          const done = await replyOnce({ awemeId: m.aweme_id, rootCid, replyCid, question: m.text, questionUser: m.user, isOwner })
          if (done?.expertQuestion) {
            const asked = await this.askExpert({ awemeId: m.aweme_id, question: done.expertQuestion, thread: null, rootCid, replyCid, threads: t, asker: { cid: m.comment_id, user: m.user, text: m.text, isOwner } })
            if (asked) actions.push({ type: 'expert_asked', awemeId: m.aweme_id })
          } else if (done?.sent) {
            t.threads[rootCid] = {
              aweme_id: m.aweme_id, rootCid, kind: isOwner ? 'owner' : 'stranger',
              participants: [m.user], turns: 1, status: 'active',
              ourCids: [done.sent.cid || randomUUID()], seen: [m.comment_id], updatedAt: this.now(),
            }
            actions.push({ type: 'replied', awemeId: m.aweme_id, to: m.user, text: done.text })
          }
          await sleepMs(3000 + Math.floor(Math.random() * 5000)) // 风控：随机间隔
        }

        // ③ 线程续话（R2）
        for (const th of Object.values(t.threads)) {
          if (th.status !== 'active') continue
          if (!cfg.multiTurn || th.turns >= cfg.maxTurns) { th.status = 'archived'; continue }
          const r = await commentsOf(th.aweme_id)
          const root = (r.comments || []).find(c => c.cid === th.rootCid)
          const replies = [...(root?.replies || []), ...(r.comments || []).filter(c => c.reply_id === th.rootCid && c.cid !== th.rootCid)]
          for (const f of replies) {
            if (th.seen.includes(f.cid) || th.ourCids.includes(f.cid) || f.user === cfg.doubaoNick) continue
            th.seen.push(f.cid)
            const isOwner = Boolean(cfg.ownerNick) && f.user === cfg.ownerNick
            const isParticipant = th.participants.includes(f.user)
            if (!isOwner && !isParticipant && !cfg.replyStranger) continue
            const done = await replyOnce({ awemeId: th.aweme_id, rootCid: th.rootCid, replyCid: f.cid, question: f.text, questionUser: f.user, isOwner })
            if (done?.expertQuestion) {
              const asked = await this.askExpert({ awemeId: th.aweme_id, question: done.expertQuestion, thread: th, rootCid: th.rootCid, replyCid: f.cid, threads: t, asker: { cid: f.cid, user: f.user, text: f.text, isOwner } })
              if (asked) actions.push({ type: 'expert_asked', awemeId: th.aweme_id })
            } else if (done?.sent) {
              th.turns += 1
              th.ourCids.push(done.sent.cid || randomUUID())
              if (!th.participants.includes(f.user)) th.participants.push(f.user)
              actions.push({ type: 'replied', awemeId: th.aweme_id, to: f.user, text: done.text, turns: th.turns })
            }
            await sleepMs(3000 + Math.floor(Math.random() * 5000))
            if (th.turns >= cfg.maxTurns) { th.status = 'archived'; break }
          }
          th.updatedAt = this.now()
        }
      })
      this.saveThreads(t)
      const real = actions.filter(a => ['replied', 'expert_asked', 'expert_answer', 'expert_timeout'].includes(a.type))
      if (real.length) {
        const lines = real.map(a => a.type === 'replied' ? `· 回了 ${a.to}：${a.text}` : a.type === 'expert_asked' ? '· 向豆包提了问' : `· ${a.summary || '豆包求助有结果'}`)
        await this.notify(`📮 评论互动：\n${lines.join('\n')}`).catch(() => {})
      }
      return { ok: true, actions }
    } catch (error) {
      this.onEvent({ type: 'comment_duty.error', message: error?.message || String(error) })
      return { ok: false, error: error?.message || String(error) }
    } finally { this.busy = false }
  }

  /** R4：@豆包 提问（走真实 UI 点选的艾特流程），记录等待状态。threads 由 tick 持有时传入，避免两份状态互相覆盖。 */
  async askExpert({ awemeId, question, thread, asker, rootCid, replyCid, threads }) {
    const t = threads || this.threads()
    const cfg = this.config()
    const existing = t.expert[awemeId]
    if (existing && !existing.answered) return false // 同视频已挂着一次提问，等它出结果
    if (existing?.answered && !existing.timedOut) return false // 豆包单视频基本只回一次，不重复问
    let sent
    try { sent = await this.askDoubao({ awemeId, question }) }
    catch (error) { this.onEvent({ type: 'comment_duty.expert_ask_failed', message: error?.message || String(error) }); return false }
    if (!sent?.ok) return false
    t.expert[awemeId] = {
      question, askCid: sent.cid || '', askedAt: this.now(), deadline: this.now() + cfg.expertTimeoutMin * 60_000, answered: false,
      threadRoot: thread?.rootCid || null,
      rootCid: rootCid || thread?.rootCid || null, replyCid: replyCid || null,
      askerCid: asker?.cid || null, askerUser: asker?.user || '', askerQuestion: asker?.text || question, askerIsOwner: asker?.isOwner === true,
    }
    if (!threads) this.saveThreads(t)
    return true
  }
}
