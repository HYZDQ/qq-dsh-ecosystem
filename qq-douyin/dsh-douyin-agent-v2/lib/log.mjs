/**
 * lib/log.mjs —— 追加式日志（带脱敏与大小轮转）
 * ============================================================================
 * 规矩：**Cookie / 令牌 / 本机绝对路径一律先脱敏再进日志**。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

const RULES = [
  [/(cookie\s*[:=：]\s*)[^\r\n]+/gi, '$1***'],
  [/((?:access[_-]?token|api[_-]?key|console[_-]?token|token|password|secret)\s*[:=：]\s*)[^\s,;，；"']+/gi, '$1***'],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***'],
  [/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer ***'],
  [/\b[A-Za-z]:[\\/][^\r\n"'<>|;，；]+/g, '[本机路径]'],
]

export function scrub(text) {
  let out = String(text ?? '')
  for (const [re, rep] of RULES) out = out.replace(re, rep)
  return out
}

export function createLogger(file) {
  const write = (level, msg) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
      } catch { /* 轮转失败不影响写入 */ }
      const line = `${new Date().toISOString()} [${level}] ${scrub(msg)}\n`
      appendFileSync(file, line, 'utf8')
    } catch { /* 日志写不进去也不能影响主流程 */ }
  }
  return {
    file,
    log: (m) => write('info', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  }
}
