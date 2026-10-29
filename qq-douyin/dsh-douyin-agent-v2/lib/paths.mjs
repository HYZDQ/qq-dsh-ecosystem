/**
 * lib/paths.mjs —— 运行时路径
 * ============================================================================
 * 规矩：**插件包目录只放代码**，配置 / 凭据 / 状态 / 报告一律落在
 * `$DSH_HOME/douyin-agent/`（可用 `DOUYIN_AGENT_HOME` 覆盖）。
 * ============================================================================
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

/** lib/ 目录 */
export const libDir = dirname(fileURLToPath(import.meta.url))
/** 插件包根 */
export const pluginRoot = join(libDir, '..')

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件家目录 */
export function homeDir() {
  const override = String(process.env.DOUYIN_AGENT_HOME || '').trim()
  return override || join(dshHome(), 'douyin-agent')
}

/** 全部落盘位置（纯计算，不建目录） */
export function paths(home = homeDir()) {
  return {
    home,
    config: join(home, 'config.json'),
    cookie: join(home, 'credentials', 'cookie.txt'),
    account: join(home, 'credentials', 'account.json'),
    credentials: join(home, 'credentials'),
    state: join(home, 'state'),
    out: join(home, 'out'),
    reports: join(home, 'reports'),
    inbox: join(home, 'inbox'),
    memory: join(home, 'memory'),
    logs: join(home, 'logs'),
    chromeProfile: join(home, 'chrome-profile'),
    tools: join(pluginRoot, 'tools'),
    prompts: join(pluginRoot, 'prompts'),
  }
}

/** 家目录 + 必需子目录 */
export function ensureHome(home = homeDir()) {
  const p = paths(home)
  for (const dir of [p.home, p.credentials, p.state, p.out, p.reports, p.inbox, p.memory, p.logs]) {
    mkdirSync(dir, { recursive: true })
  }
  return p
}
