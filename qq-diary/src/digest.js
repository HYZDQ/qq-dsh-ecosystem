// 周记/月记（GEN3_SURFACE_INTEGRATION_PLAN §3.2/§12 S4）：只生成、不发布。
//
// - 周记 = 含锚点日期那一周（周一~周日）的日记汇总；月记 = 当月整月；
// - 汇总素材来自日记合集（diary.md），成品存独立文件 diaries/digests.md，互不影响日记本体；
// - 不存在任何发布动作：发布只能由主人确认后走空间流程（diary_share_to_qzone + qzone_draft/publish）。
//
// 存储格式与日记合集同构（YAML frontmatter + 正文），frontmatter 字段：period / date / role / summary。
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'js-yaml';

import { countDiaryChars } from './prompt.js';

export const DIGEST_PERIODS = Object.freeze(['week', 'month']);

/** 周记/月记合集文件：diaries/digests.md。 */
export function digestFilePath(config) {
  return path.join(String(config?.diaryDir ?? 'diaries'), 'digests.md');
}

function parseDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function formatDateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 周期范围（闭区间，YYYY-MM-DD）。
 * week=含 dateKey 的周一~周日；month=当月 1 日~末日。
 * @returns {{period, date, start, end, label}}
 */
export function periodRange({ period, dateKey }) {
  const date = parseDateKey(dateKey);
  if (!date) throw new Error(`无效日期：${dateKey}（应为 YYYY-MM-DD）`);
  if (period === 'week') {
    const offset = (date.getUTCDay() + 6) % 7; // 周一=0
    const start = new Date(date.getTime() - offset * 86_400_000);
    const end = new Date(start.getTime() + 6 * 86_400_000);
    return {
      period,
      date: dateKey,
      start: formatDateKey(start),
      end: formatDateKey(end),
      label: `周记（${formatDateKey(start)} ~ ${formatDateKey(end)}）`
    };
  }
  if (period === 'month') {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return {
      period,
      date: dateKey,
      start: formatDateKey(start),
      end: formatDateKey(end),
      label: `月记（${formatDateKey(start)} ~ ${formatDateKey(end)}）`
    };
  }
  throw new Error(`无效周期：${period}（应为 week 或 month）`);
}

function normalizeDigest(entry) {
  const period = String(entry?.period ?? '').trim();
  if (!DIGEST_PERIODS.includes(period)) throw new RangeError(`无效周期：${entry?.period}`);
  const date = String(entry?.date ?? '').trim();
  if (!parseDateKey(date)) throw new RangeError(`无效日期：${date}`);
  const body = String(entry?.body ?? '').trim();
  return {
    period,
    date,
    role: String(entry?.role ?? ''),
    summary: String(entry?.summary ?? ''),
    body,
    chars: countDiaryChars(body)
  };
}

/** 渲染单篇（period/date/role/summary + 正文）。 */
export function renderDigestEntry(entry) {
  const normalized = normalizeDigest(entry);
  const yamlText = YAML.dump(
    { period: normalized.period, date: normalized.date, role: normalized.role, summary: normalized.summary },
    { lineWidth: -1, noRefs: true, sortKeys: false }
  );
  return `---\n${yamlText}---\n\n${normalized.body}\n`;
}

/** 解析合集：只取 period/date/role/summary；正文里偶然的 `---` 不会误判成新篇。 */
export function parseDigests(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const entries = [];
  const isEntryStart = (index) => {
    if (index < 0 || index >= lines.length) return false;
    if (lines[index].trim() !== '---') return false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const value = lines[cursor].trim();
      if (!value) continue;
      return /^period\s*:/.test(value);
    }
    return false;
  };
  let cursor = 0;
  while (cursor < lines.length) {
    if (!isEntryStart(cursor)) {
      cursor += 1;
      continue;
    }
    cursor += 1;
    const yamlLines = [];
    while (cursor < lines.length && lines[cursor].trim() !== '---') {
      yamlLines.push(lines[cursor]);
      cursor += 1;
    }
    if (cursor >= lines.length) break;
    cursor += 1;
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
    const period = String(meta.period ?? '').trim();
    const date = String(meta.date ?? '').trim();
    if (!DIGEST_PERIODS.includes(period) || !parseDateKey(date)) continue;
    const body = bodyLines.join('\n').trim();
    entries.push({ period, date, role: String(meta.role ?? ''), summary: String(meta.summary ?? ''), body, chars: countDiaryChars(body) });
  }
  entries.sort((a, b) => (a.period === b.period ? a.date.localeCompare(b.date) : a.period.localeCompare(b.period)));
  return entries;
}

/**
 * 读合集：文件不存在=空列表（不是错误）；文件非空但解析不出任何一篇=损坏（拒绝覆盖）。
 */
export function readDigests({ config }) {
  const file = digestFilePath(config);
  try {
    const text = fs.readFileSync(file, 'utf8');
    const entries = parseDigests(text);
    if (!entries.length && text.trim()) {
      return {
        ok: false,
        file,
        entries: [],
        error: '周记/月记合集解析失败（文件非空但读不出任何一篇，可能被外部编辑损坏；已拒绝自动覆盖）',
        exists: true
      };
    }
    return { ok: true, file, entries, error: null, exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, file, entries: [], error: null, exists: false };
    return { ok: false, file, entries: [], error: String(error?.message ?? error), exists: false };
  }
}

/** 写合集（整体原子替换）。 */
export function writeDigests({ config, entries }) {
  const file = digestFilePath(config);
  const sorted = [...(entries ?? [])].map(normalizeDigest)
    .sort((a, b) => (a.period === b.period ? a.date.localeCompare(b.date) : a.period.localeCompare(b.period)));
  const text = sorted.map(renderDigestEntry).join('\n');
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败忽略 */ }
    return { ok: false, file, error: String(error?.message ?? error) };
  }
}

/** 插入或替换某周期的周记/月记（同 period+date 覆盖）。 */
export function upsertDigest({ config, entry, logger = null }) {
  const normalized = normalizeDigest(entry);
  const current = readDigests({ config });
  if (!current.ok) return { ok: false, error: current.error };
  const existing = current.entries.find((item) => item.period === normalized.period && item.date === normalized.date) ?? null;
  const next = current.entries.filter((item) => !(item.period === normalized.period && item.date === normalized.date));
  next.push(normalized);
  const write = writeDigests({ config, entries: next });
  if (!write.ok) {
    logger?.error?.(`[digest] 写周记/月记失败：${write.error}`);
    return { ok: false, error: write.error };
  }
  return { ok: true, entry: normalized, replaced: Boolean(existing), total: next.length };
}

/** 取某周期范围内的日记（闭区间 start~end）。 */
export function collectDigestMaterial(entries, { start, end } = {}) {
  return (entries ?? []).filter((entry) => entry && entry.date >= String(start) && entry.date <= String(end));
}
