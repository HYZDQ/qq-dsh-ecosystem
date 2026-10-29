/**
 * lib/config.mjs —— 插件配置的默认值、归一化与钳制
 * ============================================================================
 * 三个来源（优先级从低到高）：
 *   1. 这里的 DEFAULTS
 *   2. DSH 原生设置页（volatile 字段）
 *   3. 插件家的 config.json
 * 落盘只写 config.json；设置页那一侧由 index.js 调 ctx.settings.update 同步。
 * ============================================================================
 */
import { DEFAULT_WINDOWS } from './state.mjs'

export const NOTIFY_MODES = ['toast', 'qq', 'both']

export const DEFAULTS = {
  /** 总开关：关掉后定时器不跑、工具仍可手动调 */
  enabled: true,
  /** 每天最多挑几条 */
  perDay: 5,
  /** 每次最多筛几个候选 */
  maxPerRun: 12,
  /** 自定义时段；空数组 = 用内置 DEFAULT_WINDOWS */
  windows: [],
  /** 是否启用谷时自动跑 */
  peakValley: false,
  /** 关注关键词 */
  keywords: [],
  /** 文案短于 N 字且评论少 ⇒ 跳过 */
  minDescLen: 12,
  /** 评论数低于 N 且文案短 ⇒ 跳过 */
  minComments: 3,
  /** 后台跑一轮时允许外发（私信/卡片/评论） */
  autoSend: true,
  /** 通知方式 */
  notifyMode: 'toast',
  /** 主人 QQ（空 = 从 qq-bridge 的 config.json 读 ownerQQ） */
  ownerQQ: '',
  /** qq-bridge 地址（空 = 自动探测 http://127.0.0.1:3100） */
  bridgeBase: '',
  /** qq-bridge 控制台令牌（空 = 从 qq-bridge config.json / state/console-token 读） */
  bridgeToken: '',
  /** 私信自动回复 */
  autoreplyEnabled: false,
  autoreplyContacts: [],
  autoreplyEverySec: 60,
  /** 续火花 */
  sparkEnabled: false,
  sparkContacts: [],
  sparkPerDay: 1,
  /** 音频转写 */
  mediaEnabled: false,
  /** 看画面时是否允许拉起有头窗口 */
  visibleForObserve: true,
  /** 抖音分享卡片默认发给谁（昵称） */
  dmTo: '',
  /** 上面那个人的 sec_uid（重名时必须填） */
  dmToId: '',
  /** 评论区要 @ 的人（抖音昵称，通常是主人自己） */
  mentionName: '',
  /** Chrome 路径（空 = 自动探测） */
  chromePath: '',
  /** CDP 端口（0 = 自动挑空闲端口） */
  chromePort: 0,
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const num = (v, d) => (Number.isFinite(Number(v)) && typeof v !== 'object' ? Number(v) : d)
/** 严格取字符串：宿主可能把未赋值的字段传成对象，直接 String() 会变成 "[object Object]" */
const str = (v, d) => (typeof v === 'string' ? v : d)
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const arr = (v, d) => (Array.isArray(v) ? v : d)

/** 把任意输入钳成合法配置；未知键丢弃 */
export function normalize(patch) {
  const p = isObj(patch) ? patch : {}
  const out = {}
  if ('enabled' in p) out.enabled = bool(p.enabled, DEFAULTS.enabled)
  if ('perDay' in p) out.perDay = Math.max(0, Math.min(Math.trunc(num(p.perDay, DEFAULTS.perDay)), 100))
  if ('maxPerRun' in p) out.maxPerRun = Math.max(1, Math.min(Math.trunc(num(p.maxPerRun, DEFAULTS.maxPerRun)), 60))
  if ('peakValley' in p) out.peakValley = bool(p.peakValley, DEFAULTS.peakValley)
  if ('keywords' in p) out.keywords = arr(p.keywords, []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 40)
  if ('minDescLen' in p) out.minDescLen = Math.max(0, Math.min(Math.trunc(num(p.minDescLen, DEFAULTS.minDescLen)), 500))
  if ('minComments' in p) out.minComments = Math.max(0, Math.min(Math.trunc(num(p.minComments, DEFAULTS.minComments)), 100000))
  if ('autoSend' in p) out.autoSend = bool(p.autoSend, DEFAULTS.autoSend)
  if ('notifyMode' in p) out.notifyMode = NOTIFY_MODES.includes(p.notifyMode) ? p.notifyMode : DEFAULTS.notifyMode
  if ('ownerQQ' in p) out.ownerQQ = str(p.ownerQQ, '').replace(/\D/g, '').slice(0, 20)
  if ('bridgeBase' in p) out.bridgeBase = str(p.bridgeBase, '').trim().slice(0, 200)
  if ('bridgeToken' in p) out.bridgeToken = str(p.bridgeToken, '').trim().slice(0, 200)
  if ('autoreplyEnabled' in p) out.autoreplyEnabled = bool(p.autoreplyEnabled, DEFAULTS.autoreplyEnabled)
  if ('autoreplyContacts' in p) out.autoreplyContacts = arr(p.autoreplyContacts, []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 50)
  if ('autoreplyEverySec' in p) out.autoreplyEverySec = Math.max(15, Math.min(Math.trunc(num(p.autoreplyEverySec, DEFAULTS.autoreplyEverySec)), 600))
  if ('sparkEnabled' in p) out.sparkEnabled = bool(p.sparkEnabled, DEFAULTS.sparkEnabled)
  if ('sparkContacts' in p) out.sparkContacts = arr(p.sparkContacts, []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 10)
  if ('sparkPerDay' in p) out.sparkPerDay = Math.max(1, Math.min(Math.trunc(num(p.sparkPerDay, DEFAULTS.sparkPerDay)), 5))
  if ('mediaEnabled' in p) out.mediaEnabled = bool(p.mediaEnabled, DEFAULTS.mediaEnabled)
  if ('visibleForObserve' in p) out.visibleForObserve = bool(p.visibleForObserve, DEFAULTS.visibleForObserve)
  if ('dmTo' in p) out.dmTo = str(p.dmTo, '').trim().slice(0, 40)
  if ('dmToId' in p) out.dmToId = str(p.dmToId, '').trim().slice(0, 200)
  if ('mentionName' in p) out.mentionName = str(p.mentionName, '').trim().slice(0, 40)
  if ('chromePath' in p) out.chromePath = str(p.chromePath, '').trim().slice(0, 500)
  if ('chromePort' in p) out.chromePort = Math.max(0, Math.min(Math.trunc(num(p.chromePort, 0)), 65535))
  if ('windows' in p) {
    out.windows = arr(p.windows, [])
      .map((w) => ({ start: String(w?.start ?? '').trim(), end: String(w?.end ?? '').trim(), label: String(w?.label ?? '').trim().slice(0, 20) }))
      .filter((w) => /^\d{1,2}:\d{2}$/.test(w.start) && /^\d{1,2}:\d{2}$/.test(w.end))
      .slice(0, 8)
  }
  return out
}

/** 合并成完整配置 */
export function withDefaults(base) {
  return { ...DEFAULTS, ...normalize(base), windows: normalize(base).windows ?? DEFAULTS.windows }
}

/** 实际生效的时段 */
export function effectiveWindows(cfg) {
  return Array.isArray(cfg?.windows) && cfg.windows.length ? cfg.windows : DEFAULT_WINDOWS
}
