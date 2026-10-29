// store.js：单文件合集存储（所有日记写在 diaries/diary.md，按日期升序，每篇 4 个 frontmatter 字段）。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  INDEX_VERSION,
  FRONTMATTER_FIELDS,
  diaryFilePath,
  legacyDiaryFilePath,
  compareDateAsc,
  pathExists,
  writeFileAtomic,
  renderEntryBlock,
  renderCollection,
  parseCollection,
  findEntry,
  readCollection,
  writeCollection,
  backupCollection,
  upsertEntry,
  listDiaries,
  readIndex,
  writeIndex,
  rebuildIndex,
  buildIndexEntry,
  parseLegacyDiaryFile,
  migrateLegacyDiaries,
  countLegacyDiaryFiles
} from '../src/store.js';
import { cleanupTempRoots, createProject, diaryText, readEntry, readEntries, FIXED_NOW } from './helpers.js';

after(cleanupTempRoots);

const entryFor = (date, extra = {}) => ({
  date,
  weekday: '星期五',
  role: '蓝莓球',
  summary: `${date} 的摘要。`,
  body: diaryText(220),
  ...extra
});

function legacyText(date, { summary = `${date} 旧摘要`, body = '旧格式正文。', extraFields = true } = {}) {
  const lines = ['---', `date: '${date}'`, 'weekday: 星期五', 'role: 蓝莓球'];
  if (extraFields) {
    lines.push(
      'model: deepseek-v4-flash',
      'generatedAt: 2026-10-23T23:35:00+08:00',
      'context: normal',
      'contextChars: 123',
      'source: qq-bridge(只读)'
    );
  }
  lines.push(`summary: ${summary}`, '---', '', body, '');
  return lines.join('\n');
}

describe('常量 / 路径 / 排序', () => {
  test('INDEX_VERSION=2、FRONTMATTER_FIELDS 只有 date/weekday/role/summary', () => {
    assert.equal(INDEX_VERSION, 2);
    assert.deepEqual(FRONTMATTER_FIELDS, ['date', 'weekday', 'role', 'summary']);
  });

  test('diaryFilePath：默认 diary.md，可配置文件名；legacyDiaryFilePath 保留旧路径', () => {
    const project = createProject();
    assert.equal(diaryFilePath(project.config), path.join(project.config.diaryDir, 'diary.md'));
    assert.equal(diaryFilePath({ ...project.config, diaryFile: 'my.md' }), path.join(project.config.diaryDir, 'my.md'));
    assert.equal(diaryFilePath({ ...project.config, diaryFile: '' }), path.join(project.config.diaryDir, 'diary.md'));
    assert.equal(legacyDiaryFilePath(project.config, '2026-11-01'), path.join(project.config.diaryDir, '2026-11-01.md'));
  });

  test('compareDateAsc：跨月/跨年/同日期', () => {
    assert.equal(compareDateAsc({ date: '2026-10-21' }, { date: '2026-10-22' }), -1);
    assert.equal(compareDateAsc({ date: '2026-12-31' }, { date: '2027-01-01' }), -1);
    assert.equal(compareDateAsc({ date: '2026-11-01' }, { date: '2026-10-31' }), 1);
    assert.equal(compareDateAsc({ date: '2026-10-23' }, { date: '2026-10-23' }), 0);
    assert.equal(compareDateAsc({}, { date: '2026-10-23' }), -1);
  });
});

describe('renderEntryBlock / renderCollection / parseCollection', () => {
  test('单篇只渲染 4 个 frontmatter 字段 + 正文', () => {
    const text = renderEntryBlock(entryFor('2026-10-23'));
    assert.ok(text.startsWith('---\n'));
    assert.ok(text.includes("date: '2026-10-23'"));
    assert.ok(text.includes('weekday: 星期五'));
    assert.ok(text.includes('role: 蓝莓球'));
    assert.ok(text.includes('summary: 2026-10-23 的摘要。'));
    for (const forbidden of ['model', 'generatedAt', 'context', 'contextChars', 'source']) {
      assert.ok(!new RegExp(`^${forbidden}:`, 'm').test(text), `不应出现 ${forbidden}:`);
    }
  });

  test('renderCollection + parseCollection 往返一致（含 chars）', () => {
    const entries = [entryFor('2026-10-23'), entryFor('2026-10-21')];
    const parsed = parseCollection(renderCollection(entries));
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map(({ date, weekday, role, summary, body }) => ({ date, weekday, role, summary, body })),
      entries
        .slice()
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map(({ date, weekday, role, summary, body }) => ({ date, weekday, role, summary, body }))
    );
    for (const entry of parsed) {
      assert.ok(entry.chars > 0);
      assert.equal(entry.chars, Array.from(entry.body.replace(/\s+/g, '')).length);
    }
  });

  test('合集按日期升序，篇与篇之间空一行', () => {
    const text = renderCollection([entryFor('2026-10-23'), entryFor('2026-10-22'), entryFor('2026-10-21')]);
    const dates = [...text.matchAll(/date: '(\d{4}-\d{2}-\d{2})'/g)].map((match) => match[1]);
    assert.deepEqual(dates, ['2026-10-21', '2026-10-22', '2026-10-23']);
    assert.ok(text.includes('\n\n---\n'), '篇之间应有空行');
  });

  test('parseCollection 容忍 CRLF', () => {
    const text = renderCollection([entryFor('2026-10-22')]);
    const parsed = parseCollection(text.replace(/\n/g, '\r\n'));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].date, '2026-10-22');
  });

  test('正文里出现一行 --- 不会被误判成新篇', () => {
    const body = `${diaryText(120)}\n---\n${diaryText(80)}`;
    const text = renderCollection([{ ...entryFor('2026-10-22'), body }, entryFor('2026-10-23')]);
    const parsed = parseCollection(text);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed.map((entry) => entry.date), ['2026-10-22', '2026-10-23']);
    assert.ok(parsed[0].body.includes('---'), '正文里的 --- 应保留在正文里');
  });

  test('旧格式多出来的 frontmatter 字段被忽略（只留 4 个）', () => {
    const text = legacyText('2026-10-21');
    const parsed = parseCollection(text);
    assert.equal(parsed.length, 1);
    assert.deepEqual(Object.keys(parsed[0]).sort(), ['body', 'chars', 'date', 'role', 'summary', 'weekday']);
    assert.equal(parsed[0].date, '2026-10-21');
  });

  test('空内容 / 纯垃圾 → 空数组，不抛', () => {
    assert.deepEqual(parseCollection(''), []);
    assert.deepEqual(parseCollection('随便一段没有 frontmatter 的文字\n第二行'), []);
    assert.deepEqual(parseCollection(null), []);
  });

  test('findEntry 按日期精确匹配；没有返回 null', () => {
    const entries = [entryFor('2026-10-21'), entryFor('2026-10-23')];
    assert.equal(findEntry(entries, '2026-10-23').date, '2026-10-23');
    assert.equal(findEntry(entries, '2026-10-22'), null);
    assert.equal(findEntry(null, '2026-10-22'), null);
  });
});

describe('readCollection / writeCollection', () => {
  test('缺失文件 → ok:true、exists:false、空列表；不是错误', () => {
    const project = createProject();
    const collection = readCollection({ config: project.config });
    assert.equal(collection.ok, true);
    assert.equal(collection.exists, false);
    assert.deepEqual(collection.entries, []);
    assert.equal(collection.error, null);
    assert.equal(collection.file, diaryFilePath(project.config));
  });

  test('写入后读回（升序）；无残留 tmp', () => {
    const project = createProject();
    const write = writeCollection({ config: project.config, entries: [entryFor('2026-10-23'), entryFor('2026-10-21')] });
    assert.equal(write.ok, true);
    assert.equal(write.mode, 'rename');
    const collection = readCollection({ config: project.config });
    assert.equal(collection.exists, true);
    assert.deepEqual(collection.entries.map((entry) => entry.date), ['2026-10-21', '2026-10-23']);
    assert.deepEqual(fs.readdirSync(project.config.diaryDir).filter((name) => name.endsWith('.tmp')), []);
    assert.equal(pathExists(diaryFilePath(project.config)), true);
  });

  test('listDiaries 是 readCollection 的别名（升序）', () => {
    const project = createProject();
    writeCollection({ config: project.config, entries: [entryFor('2026-10-22'), entryFor('2026-10-21')] });
    const listed = listDiaries({ config: project.config });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.entries.map((entry) => entry.date), ['2026-10-21', '2026-10-22']);
  });

  test('合集内容损坏（非空但无 frontmatter）→ ok:false，拒绝后续自动覆盖', () => {
    const project = createProject();
    fs.mkdirSync(project.config.diaryDir, { recursive: true });
    fs.writeFileSync(diaryFilePath(project.config), '乱七八糟的内容，没有 frontmatter\n', 'utf8');
    const collection = readCollection({ config: project.config });
    assert.equal(collection.ok, false);
    assert.equal(collection.exists, true);
    assert.equal(collection.corrupt, true);
    assert.deepEqual(collection.entries, []);
    assert.match(collection.error, /解析失败|损坏/);
    // 损坏时写入必须失败、且不动原文件，避免静默丢数据
    const before = fs.readFileSync(diaryFilePath(project.config), 'utf8');
    const result = upsertEntry({ config: project.config, entry: entryFor('2026-10-23'), now: FIXED_NOW });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(diaryFilePath(project.config), 'utf8'), before);
  });

  test('空文件（0 字节）→ ok:true、空列表（不是损坏）', () => {
    const project = createProject();
    fs.mkdirSync(project.config.diaryDir, { recursive: true });
    fs.writeFileSync(diaryFilePath(project.config), '', 'utf8');
    const collection = readCollection({ config: project.config });
    assert.equal(collection.ok, true);
    assert.equal(collection.exists, true);
    assert.deepEqual(collection.entries, []);
  });
});

describe('upsertEntry：升序插入 / 同日期替换 / 整本备份', () => {
  test('先写 23 再写 22 → 22 在前（升序插入）', () => {
    const project = createProject();
    const first = upsertEntry({ config: project.config, entry: entryFor('2026-10-23'), now: FIXED_NOW });
    assert.equal(first.ok, true);
    assert.equal(first.replaced, false);
    assert.equal(first.backupPath, null);
    assert.deepEqual(first.entries.map((entry) => entry.date), ['2026-10-23']);

    const second = upsertEntry({ config: project.config, entry: entryFor('2026-10-22'), now: FIXED_NOW });
    assert.equal(second.ok, true);
    assert.equal(second.replaced, false);
    assert.deepEqual(second.entries.map((entry) => entry.date), ['2026-10-22', '2026-10-23']);
    assert.deepEqual(readEntries(project).map((entry) => entry.date), ['2026-10-22', '2026-10-23']);
    assert.equal(fs.existsSync(project.config.backupDir), false, '插入新日期不应备份');
  });

  test('同日期再写 → replaced:true 且内容替换、不重复', () => {
    const project = createProject();
    upsertEntry({ config: project.config, entry: entryFor('2026-10-22', { summary: '旧摘要' }), now: FIXED_NOW });
    upsertEntry({ config: project.config, entry: entryFor('2026-10-23'), now: FIXED_NOW });
    const replaced = upsertEntry({
      config: project.config,
      entry: entryFor('2026-10-22', { summary: '新摘要', body: diaryText(260) }),
      now: FIXED_NOW
    });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.replaced, true);
    const entries = readEntries(project);
    assert.equal(entries.length, 2);
    assert.equal(entries.find((entry) => entry.date === '2026-10-22').summary, '新摘要');
    const text = fs.readFileSync(project.diaryFile(), 'utf8');
    assert.equal((text.match(/date: '2026-10-22'/g) ?? []).length, 1);
  });

  test('backup=true → 先备份整个合集到 .backup/diary.<HHmmss>.md', () => {
    const project = createProject();
    upsertEntry({ config: project.config, entry: entryFor('2026-10-22'), now: FIXED_NOW });
    upsertEntry({ config: project.config, entry: entryFor('2026-10-23'), now: FIXED_NOW });
    const before = fs.readFileSync(project.diaryFile(), 'utf8');

    const result = upsertEntry({ config: project.config, entry: entryFor('2026-10-22', { summary: '重写' }), backup: true, now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(result.replaced, true);
    assert.ok(result.backupPath, '应返回备份路径');
    assert.equal(path.dirname(result.backupPath), project.config.backupDir);
    assert.match(path.basename(result.backupPath), /^diary\.\d{6}\.md$/);
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), before, '备份必须是整本旧合集');
    assert.equal(readEntries(project).length, 2);
    assert.equal(readEntry(project, '2026-10-22').summary, '重写');
  });

  test('backup=false 时同日期替换不备份；无旧文件时 backup=true 也不备份', () => {
    const project = createProject();
    upsertEntry({ config: project.config, entry: entryFor('2026-10-22', { summary: '旧' }), now: FIXED_NOW });
    const noBackup = upsertEntry({ config: project.config, entry: entryFor('2026-10-22', { summary: '新' }), now: FIXED_NOW });
    assert.equal(noBackup.backupPath, null);
    assert.equal(fs.existsSync(project.config.backupDir), false);

    const noExisting = upsertEntry({ config: project.config, entry: entryFor('2026-10-24'), backup: true, now: FIXED_NOW });
    assert.equal(noExisting.ok, true);
    assert.equal(noExisting.backupPath, null);
  });

  test('日期格式非法 → 抛 RangeError', () => {
    const project = createProject();
    for (const bad of ['2026-2-3', '2026/10/23', 'not-a-date', '']) {
      assert.throws(() => upsertEntry({ config: project.config, entry: entryFor(bad), now: FIXED_NOW }), RangeError, `应拒绝 ${bad}`);
    }
  });
});

describe('backupCollection', () => {
  test('合集不存在 → null；存在 → .backup/diary.<HHmmss>.md 且内容一致', () => {
    const project = createProject();
    assert.equal(backupCollection({ config: project.config, now: FIXED_NOW }), null);

    upsertEntry({ config: project.config, entry: entryFor('2026-10-23'), now: FIXED_NOW });
    const before = fs.readFileSync(project.diaryFile(), 'utf8');
    const backupPath = backupCollection({ config: project.config, now: FIXED_NOW, timeZone: 'Asia/Shanghai' });
    assert.ok(backupPath);
    assert.match(path.basename(backupPath), /^diary\.233500\.md$/);
    assert.equal(fs.readFileSync(backupPath, 'utf8'), before);
  });
});

describe('index.json v2', () => {
  test('rebuildIndex 由合集生成 v2 索引（date/weekday/role/summary/chars/bodyHash）', () => {
    const project = createProject();
    upsertEntry({ config: project.config, entry: entryFor('2026-10-23'), now: FIXED_NOW });
    upsertEntry({ config: project.config, entry: entryFor('2026-10-21'), now: FIXED_NOW });
    const rebuilt = rebuildIndex({ config: project.config, now: FIXED_NOW });
    assert.equal(rebuilt.ok, true);
    assert.deepEqual(rebuilt.entries.map((item) => item.date), ['2026-10-21', '2026-10-23']);

    const raw = JSON.parse(fs.readFileSync(project.config.indexFile, 'utf8'));
    assert.equal(raw.version, 2);
    assert.equal(raw.file, 'diary.md');
    assert.ok(raw.updatedAt);
    assert.equal(raw.entries.length, 2);
    for (const item of raw.entries) {
      assert.deepEqual(Object.keys(item).sort(), ['bodyHash', 'chars', 'date', 'role', 'summary', 'weekday']);
      assert.match(item.bodyHash, /^[0-9a-f]{12}$/);
      assert.ok(item.chars > 0);
      assert.equal(item.weekday, '星期五');
      assert.equal(item.role, '蓝莓球');
    }

    const index = readIndex({ config: project.config });
    assert.equal(index.ok, true);
    assert.equal(index.entries.length, 2);
    assert.equal(index.updatedAt, '2026-10-23T23:35:00+08:00');
  });

  test('writeIndex 写 v2 结构；readIndex 缺失/损坏', () => {
    const project = createProject();
    const write = writeIndex({
      config: project.config,
      entries: [buildIndexEntry({ entry: entryFor('2026-10-23') })],
      now: FIXED_NOW
    });
    assert.equal(write.ok, true);
    const raw = JSON.parse(fs.readFileSync(project.config.indexFile, 'utf8'));
    assert.equal(raw.version, INDEX_VERSION);
    assert.equal(raw.file, 'diary.md');

    const missing = readIndex({ config: { ...project.config, indexFile: path.join(project.root, 'no-index.json') } });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'missing');

    fs.writeFileSync(project.config.indexFile, '{ broken', 'utf8');
    const broken = readIndex({ config: project.config });
    assert.equal(broken.ok, false);
    assert.ok(broken.error);
  });
});

describe('旧格式迁移：parseLegacyDiaryFile / migrateLegacyDiaries / countLegacyDiaryFiles', () => {
  test('parseLegacyDiaryFile：只取 4 个字段 + 正文；非法返回 null', () => {
    const entry = parseLegacyDiaryFile(legacyText('2026-10-21', { summary: '旧摘要', body: '旧正文。' }));
    assert.equal(entry.date, '2026-10-21');
    assert.equal(entry.weekday, '星期五');
    assert.equal(entry.role, '蓝莓球');
    assert.equal(entry.summary, '旧摘要');
    assert.equal(entry.body, '旧正文。');
    assert.equal(parseLegacyDiaryFile('没有 frontmatter'), null);
    assert.equal(parseLegacyDiaryFile('---\ndate: 2026-02-30\n---\n\nx\n'), null);
  });

  test('迁移：合并进合集、合集已有日期以合集为准、旧文件归档、幂等', () => {
    const project = createProject();
    fs.mkdirSync(project.config.diaryDir, { recursive: true });
    upsertEntry({ config: project.config, entry: entryFor('2026-10-21', { summary: '合集里的 21 号' }), now: FIXED_NOW });
    fs.writeFileSync(path.join(project.config.diaryDir, '2026-10-21.md'), legacyText('2026-10-21', { summary: '旧文件的 21 号' }), 'utf8');
    fs.writeFileSync(path.join(project.config.diaryDir, '2026-10-22.md'), legacyText('2026-10-22', { summary: '旧文件的 22 号' }), 'utf8');
    fs.writeFileSync(path.join(project.config.diaryDir, '2026-10-23.md'), '坏文件没有 frontmatter', 'utf8');

    assert.equal(countLegacyDiaryFiles({ config: project.config }), 3);
    const result = migrateLegacyDiaries({ config: project.config, now: FIXED_NOW });
    assert.equal(result.ok, true);
    assert.equal(result.migrated, 1, '只新增 22 号');
    assert.equal(result.skipped, 2, '21 号已存在 + 23 号坏文件');
    assert.equal(result.archived, 3, '所有旧文件都归档');

    const entries = readEntries(project);
    assert.deepEqual(entries.map((entry) => entry.date), ['2026-10-21', '2026-10-22']);
    assert.equal(entries.find((entry) => entry.date === '2026-10-21').summary, '合集里的 21 号');
    const archived = fs.readdirSync(path.join(project.config.backupDir, 'legacy'));
    assert.deepEqual(archived.sort(), ['2026-10-21.md', '2026-10-22.md', '2026-10-23.md']);
    assert.equal(countLegacyDiaryFiles({ config: project.config }), 0);

    const again = migrateLegacyDiaries({ config: project.config, now: FIXED_NOW });
    assert.equal(again.ok, true);
    assert.deepEqual(
      { migrated: again.migrated, archived: again.archived, skipped: again.skipped },
      { migrated: 0, archived: 0, skipped: 0 }
    );
    assert.equal(readEntries(project).length, 2);
  });

  test('目录不存在时 count/migrate 都不抛', () => {
    const project = createProject();
    assert.equal(countLegacyDiaryFiles({ config: project.config }), 0);
    const result = migrateLegacyDiaries({ config: project.config, now: FIXED_NOW });
    assert.deepEqual(
      { ok: result.ok, migrated: result.migrated, archived: result.archived, skipped: result.skipped },
      { ok: true, migrated: 0, archived: 0, skipped: 0 }
    );
  });
});

describe('writeFileAtomic（Windows 占用兜底）', () => {
  test('正常路径 mode=rename，无残留 .tmp', () => {
    const project = createProject();
    const file = path.join(project.root, 'atomic', 'x.md');
    const result = writeFileAtomic(file, '内容');
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'rename');
    assert.equal(fs.readFileSync(file, 'utf8'), '内容');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), []);
  });

  test('rename 首次 EPERM → rename-after-move，旧内容不丢', () => {
    const project = createProject();
    const file = path.join(project.config.diaryDir, 'diary.md');
    assert.equal(writeFileAtomic(file, '旧内容').ok, true);
    const originalRename = fs.renameSync;
    let blocked = 0;
    fs.renameSync = (from, to) => {
      if (blocked < 1 && String(from).endsWith('.tmp') && to === file) {
        blocked += 1;
        throw Object.assign(new Error('EPERM: synthetic lock'), { code: 'EPERM' });
      }
      return originalRename(from, to);
    };
    try {
      const result = writeFileAtomic(file, '新内容', { renameRetries: 1 });
      assert.equal(result.ok, true);
      assert.equal(result.mode, 'rename-after-move');
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '新内容');
    assert.deepEqual(
      fs.readdirSync(project.config.diaryDir).filter((name) => name.includes('.old-') || name.endsWith('.tmp')),
      []
    );
  });

  test('rename 一直失败 → mode=copy；全失败 → ok:false 且旧内容保留', () => {
    const project = createProject();
    const file = path.join(project.config.diaryDir, 'diary.md');
    assert.equal(writeFileAtomic(file, '旧内容').ok, true);

    const originalRename = fs.renameSync;
    const originalCopy = fs.copyFileSync;
    fs.renameSync = () => {
      throw Object.assign(new Error('EPERM: synthetic lock'), { code: 'EPERM' });
    };
    try {
      const copied = writeFileAtomic(file, '新内容', { renameRetries: 1 });
      assert.equal(copied.ok, true);
      assert.equal(copied.mode, 'copy');
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '新内容');

    fs.renameSync = () => {
      throw Object.assign(new Error('EPERM: synthetic lock'), { code: 'EPERM' });
    };
    fs.copyFileSync = () => {
      throw Object.assign(new Error('EPERM: synthetic copy'), { code: 'EPERM' });
    };
    try {
      const failed = writeFileAtomic(file, '再新内容', { renameRetries: 1 });
      assert.equal(failed.ok, false);
      assert.ok(failed.error);
    } finally {
      fs.renameSync = originalRename;
      fs.copyFileSync = originalCopy;
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '新内容', '两次都失败时旧内容必须还在');
    assert.deepEqual(fs.readdirSync(project.config.diaryDir).filter((name) => name.endsWith('.tmp')), []);
  });
});

describe('buildIndexEntry', () => {
  test('v2 索引条目字段与 bodyHash', () => {
    const entry = entryFor('2026-10-23');
    entry.chars = undefined; // 让 buildIndexEntry 用传入 entry.chars（测试里补上）
    const withChars = { ...entry, chars: 123 };
    const item = buildIndexEntry({ entry: withChars });
    assert.deepEqual(Object.keys(item).sort(), ['bodyHash', 'chars', 'date', 'role', 'summary', 'weekday']);
    assert.equal(item.date, '2026-10-23');
    assert.equal(item.weekday, '星期五');
    assert.equal(item.role, '蓝莓球');
    assert.equal(item.summary, withChars.summary);
    assert.equal(item.chars, 123);
    assert.equal(item.bodyHash, crypto.createHash('sha256').update(withChars.body, 'utf8').digest('hex').slice(0, 12));
  });
});

describe('回归：日期合法性 / 备份不覆盖', () => {
  test('upsertEntry 拒绝日历上不存在的日期（2026-02-30）', () => {
    const project = createProject();
    assert.throws(
      () => upsertEntry({ config: project.config, entry: entryFor('2026-02-30'), now: FIXED_NOW }),
      /无效日期/
    );
    assert.equal(pathExists(diaryFilePath(project.config)), false);
  });

  test('同一秒内连续备份不会互相覆盖', () => {
    const project = createProject();
    writeCollection({ config: project.config, entries: [entryFor('2026-10-22')] });
    const first = backupCollection({ config: project.config, now: FIXED_NOW });
    writeCollection({ config: project.config, entries: [entryFor('2026-10-23')] });
    const second = backupCollection({ config: project.config, now: FIXED_NOW });
    assert.notEqual(first, second);
    assert.equal(pathExists(first), true);
    assert.equal(pathExists(second), true);
    // 第一份备份保留的是第一次写入时的内容
    assert.equal(readCollection({ config: project.config }).entries[0].date, '2026-10-23');
    const firstBackup = fs.readFileSync(first, 'utf8');
    assert.match(firstBackup, /date: '2026-10-22'/);
  });
});
