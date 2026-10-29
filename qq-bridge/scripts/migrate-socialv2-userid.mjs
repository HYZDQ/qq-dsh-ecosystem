#!/usr/bin/env node
/**
 * GEN3 P0.6：social-v2.json 迁移——memberImpressions 姓名键 → userId 键（+aliases），加 schemaVersion。
 *
 * 不提前锁死记忆 A/B（不建 simulation.db）；旧数据只收编不丢弃：
 *   · 能从消息里解析出 userId 的姓名键条目 → 合并进 u:<userId>（traits 并集、次数相加、别名记录）；
 *   · 解析不到的**原样保留**（姓名键只读兼容，bridge 读取路径照样展示）；
 *   · 顶层打 schemaVersion=2。
 *
 * 安全：先备份再写（state/social-v2.json.bak-<ts>），原子写（临时文件+rename），
 * 幂等（重复执行无变化、不重复合并），--rollback 一键还原备份（回滚不丢数据）。
 *
 * 用法：
 *   node scripts/migrate-socialv2-userid.mjs                    # 迁移（自动备份）
 *   node scripts/migrate-socialv2-userid.mjs --state <file>     # 指定文件（测试用）
 *   node scripts/migrate-socialv2-userid.mjs --rollback         # 还原最新备份
 *   node scripts/migrate-socialv2-userid.mjs --rollback <bak>   # 还原指定备份
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = { state: path.join(ROOT, 'state', 'social-v2.json'), rollback: false, backup: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--state') args.state = path.resolve(argv[++i] ?? '');
    else if (a === '--rollback') args.rollback = true;
    else rest.push(a);
  }
  if (args.rollback && rest.length) args.backup = path.resolve(rest[0]);
  return args;
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 会话内 显示名→userId 映射（recent+unread，取最先出现）。 */
function nameToUserId(conv) {
  const map = new Map();
  for (const m of [...(conv.recentMessages ?? []), ...(conv.unread ?? [])]) {
    if (!m || m.isSelf) continue;
    const name = String(m.sender ?? '').trim();
    if (name && m.userId && !map.has(name)) map.set(name, String(m.userId));
  }
  return map;
}

function mergeInto(entry, name, legacy) {
  const traits = Array.isArray(entry?.traits) ? entry.traits.slice(0, 10) : [];
  for (const t of (Array.isArray(legacy?.traits) ? legacy.traits : [])) {
    const s = String(t ?? '').slice(0, 50);
    if (s && !traits.includes(s)) traits.push(s);
  }
  const aliases = Array.isArray(entry?.aliases) ? entry.aliases.slice(0, 10) : [];
  if (name && !aliases.includes(name)) aliases.push(name);
  return {
    ...legacy,
    ...entry,
    traits: traits.slice(0, 10),
    aliases,
    interactionCount: (Number(entry?.interactionCount) || 0) + (Number(legacy?.interactionCount) || 0),
    lastSeenAt: Math.max(Number(entry?.lastSeenAt) || 0, Number(legacy?.lastSeenAt) || 0) || Date.now()
  };
}

function migrate(obj) {
  let moved = 0;
  let kept = 0;
  for (const conv of Object.values(obj.conversations ?? {})) {
    const im = conv.memberImpressions && typeof conv.memberImpressions === 'object' ? conv.memberImpressions : null;
    if (!im) continue;
    const uidByName = nameToUserId(conv);
    for (const name of Object.keys(im)) {
      if (name.startsWith('u:')) continue;
      const uid = uidByName.get(name);
      if (!uid) {
        kept += 1;
        continue;
      }
      const key = `u:${uid}`;
      const legacy = im[name];
      im[key] = key in im ? mergeInto(im[key], name, legacy) : mergeInto(null, name, legacy);
      delete im[name];
      moved += 1;
    }
  }
  obj.schemaVersion = 2;
  return { moved, kept };
}

function latestBackup(stateFile) {
  const dir = path.dirname(stateFile);
  const base = path.basename(stateFile);
  const cands = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.bak-`))
    .sort();
  return cands.length ? path.join(dir, cands[cands.length - 1]) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.state)) {
    console.error(`找不到状态文件：${args.state}`);
    process.exitCode = 1;
    return;
  }
  if (args.rollback) {
    const bak = args.backup || latestBackup(args.state);
    if (!bak || !fs.existsSync(bak)) {
      console.error('没有可还原的备份');
      process.exitCode = 1;
      return;
    }
    fs.copyFileSync(bak, args.state);
    console.log(`✅ 已还原备份：${bak} → ${args.state}`);
    return;
  }
  const original = fs.readFileSync(args.state, 'utf8');
  const obj = JSON.parse(original);
  const { moved, kept } = migrate(obj);
  const next = `${JSON.stringify(obj, null, 2)}\n`;
  if (next === original) {
    console.log('✓ 已是目标形态，无需迁移（幂等）');
    return;
  }
  const bak = `${args.state}.bak-${Date.now()}`;
  fs.copyFileSync(args.state, bak);
  atomicWriteJson(args.state, obj);
  console.log(`迁移完成：收编 ${moved} 条到 u:<userId> 键，保留 ${kept} 条姓名键（无法解析 userId）`);
  console.log(`备份：${bak}（--rollback 可还原）`);
}

main();
