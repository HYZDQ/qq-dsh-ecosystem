// 领域包注册表（§7 / §10.1）：内置包 + 外部包（packs.d）+ stateDir/computer/packs.json 启用清单。
// packs.json 形如 { "enabled": ["douyin", "explorer"] }；缺失时默认启用全部内置包，
// 文件损坏按「全部关闭」处理（fail-closed，只影响领域提示注入，不影响 L0/L1 主链路）。
//
// P3 主干-分支接线（2026-10-27）：外部领域包在 stateDir/computer/packs.d/<id>.json 自注册，
// 声明 { id, name, module }，module 指向导出 createPack(deps) 的 ESM 文件（分支插件激活时
// 写入、卸载时清理）。加载失败/声明损坏一律跳过（fail-closed，只损失该分支的提示与路由）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DomainPack } from './domain-pack.mjs';
import { DouyinPack } from './douyin.mjs';
import { BrowserPack } from './browser.mjs';
import { ExplorerPack } from './explorer.mjs';
import { OfficePack } from './office.mjs';

export const PACKS_FILENAME = 'packs.json';
export const PACKS_D_DIRNAME = 'packs.d';
export const BUILTIN_PACKS = Object.freeze([
  { id: 'douyin', create: () => new DouyinPack() },
  { id: 'browser', create: () => new BrowserPack() },
  { id: 'explorer', create: () => new ExplorerPack() },
  { id: 'office', create: () => new OfficePack() },
]);

export class PackRegistry {
  constructor({ stateDir, builtins = BUILTIN_PACKS, deps = {} } = {}) {
    Object.assign(this, { stateDir, builtins, deps });
    this.packs = this.#load();
    this.externalKey = null;
  }

  #load(externals = []) {
    const enabled = this.#enabledIds();
    const builtinPacks = this.builtins.filter((item) => enabled === null || enabled.has(item.id)).map((item) => item.create());
    return [...builtinPacks, ...externals.filter((pack) => enabled === null || enabled.has(pack.id))];
  }

  #externalSpecs() {
    if (!this.stateDir) return [];
    const dir = path.join(this.stateDir, PACKS_D_DIRNAME);
    let files = [];
    try { files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
    const specs = [];
    for (const name of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (parsed?.id && typeof parsed.module === 'string' && parsed.module.trim()) {
          specs.push({ id: String(parsed.id), name: String(parsed.name ?? parsed.id), module: path.resolve(String(parsed.module)) });
        }
      } catch { /* 声明损坏跳过（fail-closed） */ }
    }
    return specs;
  }

  // 外部包按需加载：声明变化才重新实例化（import() 自带模块缓存）。任何失败只损失该分支。
  async ready() {
    const specs = this.#externalSpecs();
    const key = JSON.stringify(specs);
    if (this.externalKey === key) return this.packs;
    this.externalKey = key;
    const externals = [];
    for (const spec of specs) {
      try {
        const mod = await import(pathToFileURL(spec.module).href);
        const pack = typeof mod.createPack === 'function' ? await mod.createPack({ ...this.deps, id: spec.id }) : null;
        if (pack && typeof pack.matches === 'function' && typeof pack.actions === 'function' && typeof pack.plan === 'function') {
          externals.push(pack);
        }
      } catch { /* 加载失败跳过（fail-closed） */ }
    }
    this.packs = this.#load(externals);
    return this.packs;
  }

  // null = 文件缺失（默认全部启用）；Set = 文件生效的启用集合（损坏时为空集）。
  #enabledIds() {
    if (!this.stateDir) return null;
    const file = path.join(this.stateDir, PACKS_FILENAME);
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; return new Set(); }
    try {
      const parsed = JSON.parse(raw);
      const list = parsed?.enabled;
      return Array.isArray(list) ? new Set(list.map(String)) : new Set();
    } catch {
      return new Set();
    }
  }

  list() {
    return this.packs.map((pack) => ({
      id: pack.id,
      actions: pack.actions().map((item) => item.name),
      policyExt: pack.policyExt(),
    }));
  }

  matchFor(ctx = {}) {
    return this.packs.find((pack) => {
      try { return pack.matches(ctx); } catch { return false; }
    }) ?? null;
  }

  // 观察注解：归属包 + 领域提示（§7.1 prompt）。
  hintFor(ctx = {}) {
    const pack = this.matchFor(ctx);
    return pack ? { pack: pack.id, hint: pack.prompt() } : null;
  }

  // P3 goal 路由（§7）：让领域包认领任务目标并产出 L1 步骤计划（含越权自检）。
  // 没有包认领返回 null；认领但计划失败返回带 error 的对象（不抛，调用方决定呈现）。
  planForGoal(goal = '') {
    for (const pack of this.packs) {
      let routed = null;
      try { routed = typeof pack.handlesGoal === 'function' ? pack.handlesGoal(String(goal ?? '')) : null; } catch { continue; }
      if (!routed?.action) continue;
      try {
        const steps = pack.plan(routed.action, routed.args ?? {});
        DomainPack.assertPlanAllowed(steps);
        return { pack: pack.id, action: routed.action, args: routed.args ?? {}, steps, note: routed.note ?? '' };
      } catch (error) {
        return { pack: pack.id, action: routed.action, args: routed.args ?? {}, steps: [], error: error?.message ?? String(error) };
      }
    }
    return null;
  }
}
