// 日记存储：**单文件合集**（所有日记写在同一个 Markdown 里，按日期升序）。
//
// 文件：<diaryDir>/<diaryFile>（默认 diaries/diary.md），结构：
//
//   ---
//   date: '2026-10-22'
//   weekday: 星期四
//   role: 蓝莓球
//   summary: 昨天聊到很晚，今天有点困。
//   ---
//
//   正文……
//
//   ---
//   date: '2026-10-23'
//   ...
//
// 每篇只保留 date / weekday / role / summary 四个 frontmatter 字段 + 正文。
// 覆盖同一日期时先把整个文件备份到 diaries/.backup/，再用原子写整体替换。
// 旧版的「一天一个文件」会在 migrateLegacyDiaries() 里合并进合集，旧文件移入 .backup/legacy/。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'js-yaml';
import { clockSecondsInZone, isoWithOffset, isValidDateKey } from './scheduler.js';
import { countDiaryChars } from './prompt.js';

export const INDEX_VERSION = 2;
export const FRONTMATTER_FIELDS = ['date', 'weekday', 'role', 'summary'];

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 合集文件路径。 */
export function diaryFilePath(config) {
  return path.join(config.diaryDir, config.diaryFile || 'diary.md');
}

/** 旧版「一天一个文件」的路径（仅迁移用）。 */
export function legacyDiaryFilePath(config, dateKey) {
  return path.join(config.diaryDir, `${dateKey}.md`);
}

export function pathExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function compareDateAsc(a, b) {
  const left = String(a?.date ?? '');
  const right = String(b?.date ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 通用原子写：同目录 tmp + fsync + rename（Windows 上 rename 覆盖是原子的）。 */
export function writeFileAtomic(file, content, { renameRetries = 6 } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const cleanup = () => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  };
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // 某些文件系统不支持 fsync，忽略
    }
    fs.closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    cleanup();
    return { ok: false, file, error: String(error?.message ?? error), code: error?.code };
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  // Windows 上杀软/索引器会短暂持有目标文件，rename 可能返回 EPERM/EBUSY；重试而不是直接失败
  let lastError = null;
  for (let attempt = 0; attempt < renameRetries; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return { ok: true, file, bytes, mode: 'rename' };
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(error?.code)) break;
      const wait = Math.min(400, 20 * (attempt + 1));
      const end = Date.now() + wait;
      while (Date.now() < end) {
        // 同步小睡，等占用释放
      }
    }
  }
  // 兜底一：把旧文件改名到旁边的临时名（不丢旧内容）→ 再 rename 新文件 → 删旧临时名。
  const oldName = `${file}.old-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  let oldMoved = false;
  try {
    if (fs.existsSync(file)) {
      fs.renameSync(file, oldName);
      oldMoved = true;
    }
    fs.renameSync(tmp, file);
    if (oldMoved) {
      try {
        fs.unlinkSync(oldName);
      } catch {
        // 旧备份删不掉不影响结果
      }
    }
    return { ok: true, file, bytes, mode: 'rename-after-move', warning: String(lastError?.message ?? lastError) };
  } catch (error) {
    lastError = error;
    if (oldMoved) {
      try {
        if (!fs.existsSync(file)) fs.renameSync(oldName, file);
      } catch {
        // ignore
      }
    }
  }
  // 兜底二：直接覆盖复制（旧文件已被移走时这里只是最后手段）
  try {
    fs.copyFileSync(tmp, file);
    cleanup();
    return { ok: true, file, bytes, mode: 'copy', warning: String(lastError?.message ?? lastError) };
  } catch (error) {
    lastError = error;
  }
  cleanup();
  return { ok: false, file, error: String(lastError?.message ?? lastError), code: lastError?.code };
}

function normalizeEntry(entry) {
  const date = String(entry?.date ?? '').trim();
  if (!isValidDateKey(date)) throw new RangeError(`无效日期：${date}`);
  const body = String(entry?.body ?? '').trim();
  return {
    date,
    weekday: String(entry?.weekday ?? ''),
    role: String(entry?.role ?? ''),
    summary: String(entry?.summary ?? ''),
    body,
    chars: countDiaryChars(body)
  };
}

/** 渲染单篇（只含 date/weekday/role/summary + 正文）。 */
export function renderEntryBlock(entry) {
  const normalized = normalizeEntry(entry);
  const meta = {
    date: normalized.date,
    weekday: normalized.weekday,
    role: normalized.role,
    summary: normalized.summary
  };
  const yamlText = YAML.dump(meta, { lineWidth: -1, noRefs: true, sortKeys: false });
  return `---\n${yamlText}---\n\n${normalized.body}\n`;
}

/** 渲染整个合集：按日期升序，篇与篇之间空一行。 */
export function renderCollection(entries) {
  const sorted = [...(entries ?? [])].map(normalizeEntry).sort(compareDateAsc);
  return sorted.map(renderEntryBlock).join('\n');
}

/**
 * 解析合集。只取 date/weekday/role/summary（旧格式多出来的 model/generatedAt 等字段会被忽略）。
 * 正文里偶然出现的一行 `---` 不会被误判成新篇：只有当其后第一个非空行是 `date:` 时才算新篇。
 */
export function parseCollection(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const entries = [];

  const isEntryStart = (index) => {
    if (index < 0 || index >= lines.length) return false;
    if (lines[index].trim() !== '---') return false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const value = lines[cursor].trim();
      if (!value) continue;
      return /^date\s*:/.test(value);
    }
    return false;
  };

  let cursor = 0;
  while (cursor < lines.length) {
    if (!isEntryStart(cursor)) {
      cursor += 1;
      continue;
    }
    cursor += 1; // 跳过开头的 ---
    const yamlLines = [];
    while (cursor < lines.length && lines[cursor].trim() !== '---') {
      yamlLines.push(lines[cursor]);
      cursor += 1;
    }
    if (cursor >= lines.length) break;
    cursor += 1; // 跳过结尾的 ---
    const bodyLines = [];
    while (cursor < lines.length && !isEntryStart(cursor)) {
      bodyLines.push(lines[cursor]);
      cursor += 1;
    }
    let meta = {};
    try {
      const parsed = YAML.load(yamlLines.join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
    } catch {
      meta = {};
    }
    const date = String(meta.date ?? '').trim();
    if (!isValidDateKey(date)) continue;
    const body = bodyLines.join('\n').trim();
    entries.push({
      date,
      weekday: String(meta.weekday ?? ''),
      role: String(meta.role ?? ''),
      summary: String(meta.summary ?? ''),
      body,
      chars: countDiaryChars(body)
    });
  }
  entries.sort(compareDateAsc);
  return entries;
}

export function findEntry(entries, dateKey) {
  return (entries ?? []).find((entry) => entry?.date === dateKey) ?? null;
}

/**
 * 读合集：文件不存在返回空列表（不是错误）。
 * 文件存在、非空、却解析不出任何一篇 → 视为损坏（ok:false），避免后续写入静默覆盖掉原内容。
 */
export function readCollection({ config }) {
  const file = diaryFilePath(config);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const entries = parseCollection(text);
    if (!entries.length && text.trim()) {
      return {
        ok: false,
        file,
        entries: [],
        error: '合集解析失败（文件非空但读不出任何日记，可能被外部编辑损坏；已拒绝自动覆盖，请先备份/修复 diary.md）',
        exists: true,
        corrupt: true
      };
    }
    return { ok: true, file, entries, error: null, exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, file, entries: [], error: null, exists: false };
    return { ok: false, file, entries: [], error: String(error?.message ?? error), exists: false };
  }
}

/** 写合集（整体原子替换）。 */
export function writeCollection({ config, entries }) {
  const file = diaryFilePath(config);
  return writeFileAtomic(file, renderCollection(entries));
}

/** 覆盖前备份整个合集到 diaries/.backup/。 */
export function backupCollection({ config, now = new Date(), timeZone = 'Asia/Shanghai', keep = 30 }) {
  const file = diaryFilePath(config);
  if (!pathExists(file)) return null;
  const stamp = clockSecondsInZone(now, timeZone).replace(/:/g, '');
  fs.mkdirSync(config.backupDir, { recursive: true });
  // 同一秒内可能连续覆盖：重名时加序号，绝不覆盖已有备份
  let dest = path.join(config.backupDir, `diary.${stamp}.md`);
  let suffix = 1;
  while (pathExists(dest)) {
    dest = path.join(config.backupDir, `diary.${stamp}-${suffix}.md`);
    suffix += 1;
  }
  fs.copyFileSync(file, dest);
  // §17.5 第 8 条：.backup 只保留最近 30 份（超出按修改时间清最旧），不自动删日记本体
  try {
    const backups = fs.readdirSync(config.backupDir)
      .filter((name) => /^diary\..+\.md$/.test(name))
      .map((name) => ({ name, file: path.join(config.backupDir, name), mtime: fs.statSync(path.join(config.backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of backups.slice(keep)) {
      try { fs.unlinkSync(old.file); } catch { /* 清理失败忽略 */ }
    }
  } catch { /* 目录读失败不影响备份结果 */ }
  return dest;
}

/**
 * 插入或替换某天的日记（保持日期升序）。
 * @returns {{ ok, entry, replaced, backupPath, entries, error }}
 */
export function upsertEntry({ config, entry, backup = false, logger = null, now = new Date() }) {
  const normalized = normalizeEntry(entry);
  const current = readCollection({ config });
  if (!current.ok) return { ok: false, error: current.error };
  let backupPath = null;
  const existing = findEntry(current.entries, normalized.date);
  if (existing && backup) {
    try {
      backupPath = backupCollection({ config, now, timeZone: config.timezone });
    } catch (error) {
      logger?.error?.(`[store] 备份日记合集失败，中止覆盖：${error?.message ?? error}`);
      return { ok: false, error: `BACKUP_FAILED：${error?.message ?? error}` };
    }
  }
  const next = current.entries.filter((item) => item.date !== normalized.date);
  next.push(normalized);
  next.sort(compareDateAsc);
  const write = writeCollection({ config, entries: next });
  if (!write.ok) return { ok: false, error: write.error, mode: write.mode };
  return {
    ok: true,
    entry: normalized,
    replaced: Boolean(existing),
    backupPath,
    entries: next,
    mode: write.mode,
    warning: write.warning
  };
}

/** 列全部日记（按日期升序）。 */
export function listDiaries({ config }) {
  return readCollection({ config });
}

// ───────────────────────────── index.json ─────────────────────────────

export function readIndex({ config }) {
  try {
    const text = fs.readFileSync(config.indexFile, 'utf8');
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.entries)) return { ok: false, entries: [], error: 'index 结构无效' };
    return { ok: true, entries: data.entries, error: null, updatedAt: data.updatedAt ?? '' };
  } catch (error) {
    return { ok: false, entries: [], error: error?.code === 'ENOENT' ? 'missing' : String(error?.message ?? error) };
  }
}

export function writeIndex({ config, entries, now = new Date() }) {
  const payload = {
    version: INDEX_VERSION,
    updatedAt: isoWithOffset(now, config.timezone),
    file: config.diaryFile || 'diary.md',
    entries
  };
  return writeFileAtomic(config.indexFile, `${JSON.stringify(payload, null, 2)}\n`);
}

/** 由合集重建 index.json（每次写入后调用，保持索引与文件一致）。 */
export function rebuildIndex({ config, logger = null, now = new Date() }) {
  const collection = readCollection({ config });
  if (!collection.ok) {
    logger?.warn?.(`[store] 读取日记合集失败：${collection.error}`);
    return { ok: false, entries: [], error: collection.error };
  }
  const entries = collection.entries.map((entry) => buildIndexEntry({ entry }));
  const write = writeIndex({ config, entries, now });
  if (!write.ok) logger?.warn?.(`[store] 写 index.json 失败：${write.error}`);
  return { ok: write.ok, entries, error: write.error ?? null, rebuilt: true };
}

export function buildIndexEntry({ entry }) {
  return {
    date: entry.date,
    weekday: entry.weekday,
    role: entry.role,
    summary: entry.summary,
    chars: entry.chars,
    bodyHash: crypto.createHash('sha256').update(String(entry.body ?? ''), 'utf8').digest('hex').slice(0, 12)
  };
}

// ───────────────────────────── 旧格式迁移 ─────────────────────────────

/** 解析旧版「一天一个文件」的 Markdown（frontmatter 里可能有 model/generatedAt/...）。 */
export function parseLegacyDiaryFile(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  if (!raw.startsWith('---\n')) return null;
  const closing = raw.indexOf('\n---', 3);
  if (closing < 0) return null;
  let meta = {};
  try {
    const parsed = YAML.load(raw.slice(4, closing));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {
    meta = {};
  }
  const body = raw.slice(closing + 4).replace(/^\n+/, '').trim();
  const date = String(meta.date ?? '').trim();
  if (!isValidDateKey(date)) return null;
  return {
    date,
    weekday: String(meta.weekday ?? ''),
    role: String(meta.role ?? ''),
    summary: String(meta.summary ?? ''),
    body,
    chars: countDiaryChars(body)
  };
}

/**
 * 把旧版 diaries/YYYY-MM-DD.md 合并进合集文件，旧文件移入 diaries/.backup/legacy/。
 * 幂等：没有旧文件时什么都不做。合集里已有同日期时以合集为准（旧文件只归档）。
 */
export function migrateLegacyDiaries({ config, logger = null, now = new Date() }) {
  let names = [];
  try {
    names = fs.readdirSync(config.diaryDir);
  } catch {
    return { ok: true, migrated: 0, archived: 0, skipped: 0 };
  }
  const legacy = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
  if (!legacy.length) return { ok: true, migrated: 0, archived: 0, skipped: 0 };

  const collection = readCollection({ config });
  if (!collection.ok) return { ok: false, migrated: 0, archived: 0, skipped: legacy.length, error: collection.error };
  const byDate = new Map(collection.entries.map((entry) => [entry.date, entry]));
  let migrated = 0;
  let skipped = 0;
  for (const name of legacy) {
    const file = path.join(config.diaryDir, name);
    try {
      const entry = parseLegacyDiaryFile(fs.readFileSync(file, 'utf8'));
      if (!entry) {
        skipped += 1;
        continue;
      }
      if (byDate.has(entry.date)) {
        skipped += 1;
      } else {
        byDate.set(entry.date, entry);
        migrated += 1;
      }
    } catch (error) {
      skipped += 1;
      logger?.warn?.(`[store] 迁移旧日记 ${name} 失败：${error?.message ?? error}`);
    }
  }

  if (migrated > 0) {
    const write = writeCollection({ config, entries: [...byDate.values()] });
    if (!write.ok) {
      logger?.error?.(`[store] 迁移写合集失败：${write.error}`);
      return { ok: false, migrated: 0, archived: 0, skipped: legacy.length, error: write.error };
    }
    writeIndex({
      config,
      entries: [...byDate.values()].map((entry) => buildIndexEntry({ entry })),
      now
    });
  }

  // 归档旧文件（合集已有同日期的也归档，避免和新文件混淆）
  const legacyDir = path.join(config.backupDir, 'legacy');
  let archived = 0;
  try {
    fs.mkdirSync(legacyDir, { recursive: true });
    for (const name of legacy) {
      try {
        fs.renameSync(path.join(config.diaryDir, name), path.join(legacyDir, name));
        archived += 1;
      } catch (error) {
        logger?.warn?.(`[store] 归档旧日记 ${name} 失败：${error?.message ?? error}`);
      }
    }
  } catch (error) {
    logger?.warn?.(`[store] 创建旧日记归档目录失败：${error?.message ?? error}`);
  }
  logger?.info?.(`[store] 旧格式日记迁移：合并 ${migrated} 篇，归档 ${archived} 个旧文件，跳过 ${skipped} 篇`);
  return { ok: true, migrated, archived, skipped };
}

/** --check 用：统计旧格式文件数量。 */
export function countLegacyDiaryFiles({ config }) {
  try {
    return fs.readdirSync(config.diaryDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).length;
  } catch {
    return 0;
  }
}
