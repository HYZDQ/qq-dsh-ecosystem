/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`，拿不到就降级
 * ============================================================================
 * 为什么不能裸 import：
 *   `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools` 是 optional peer，
 *   桌面版 profile（autoInstallPeers: false）**不会装**，裸 import 会让整条插件
 *   在 import 阶段就失败 —— 表现是「1 entry did not activate」且没有任何工具。
 *
 * 策略：
 *   ① 先按候选根目录从宿主树里解析（跟宿主用同一份，行为最一致）
 *   ② 拿不到就 bare import（靠插件自己 dependencies 装的那份）
 *   ③ schemastery 彻底拿不到 ⇒ 返回 null：插件照常加载，只是没有 Config
 *   ④ defineTool 拿不到 ⇒ 用本地等价实现（只补 additionalProperties 校验）
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginRoot } from './paths.mjs'

const SELF_MODULES = join(pluginRoot, 'node_modules', '@deepseek-ai')

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')

  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

async function fromHostTree(name, notes) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      notes.push(`${name}: 宿主树 ${root}`)
      return mod
    } catch { /* 换下一个 */ }
  }
  return null
}

function localDefineTool(options, notes) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  notes.push(`dsh-tools 不可用，工具 ${options.name} 使用本地等价实现`)
  return options
}

export async function loadHostDeps() {
  const notes = []

  let z = null
  let zMod = await fromHostTree('schemastery', notes)
  if (!zMod) {
    try {
      zMod = await import('@deepseek-ai/schemastery')
      notes.push('schemastery: 使用插件自带依赖')
    } catch (e) {
      notes.push(`schemastery 不可用（${e?.code || ''}）：插件照常加载，但设置页会降级`)
    }
  }
  z = zMod?.default ?? zMod ?? null

  let dtMod = await fromHostTree('dsh-tools', notes)
  if (!dtMod) {
    try {
      dtMod = await import('@deepseek-ai/dsh-tools')
      notes.push('dsh-tools: 使用插件自带依赖')
    } catch {
      notes.push('dsh-tools 不可用：使用本地等价实现')
      dtMod = null
    }
  }
  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, notes))

  return { z, defineTool, notes }
}
