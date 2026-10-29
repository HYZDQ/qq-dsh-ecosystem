// index.js · runForDate：写入单文件合集 / 跳过 / force 备份整本 / dry-run / LLM 失败 / 无上下文 / 日期边界。
// 全部使用 temp 项目根 + 注入假 fetch（LLM、通知都不发真实请求）。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runForDate } from '../index.js';
import { diaryFilePath, readCollection, findEntry, pathExists } from '../src/store.js';
import { notifyFiles, readNotifyState } from '../src/notify.js';
import {
  cleanupTempRoots,
  createProject,
  conversation,
  msg,
  makeFetchMock,
  jsonResponse,
  llmFetchMock,
  diaryText,
  readEntries,
  readEntry,
  DEFAULT_SUMMARY,
  DEFAULT_ROLE,
  FIXED_NOW,
  FIXED_TODAY,
  FIXED_WEEKDAY,
  OWNER_QQ
} from './helpers.js';

after(cleanupTempRoots);

function projectWithSocial(config = {}) {
  return createProject({
    config,
    social: {
      paused: false,
      conversations: {
        [`private:${OWNER_QQ}`]: conversation([msg('主人说晚安', 30)]),
        'group:30001': conversation([msg('群里在聊晚饭', 20)])
      }
    }
  });
}

function run(project, overrides = {}) {
  return runForDate({
    config: project.config,
    facts: project.facts,
    dateKey: FIXED_TODAY,
    noNotify: true,
    fetchImpl: makeFetchMock(() => jsonResponse({ retcode: 0, data: {} })),
    llmFetchImpl: llmFetchMock({ chars: 300 }),
    now: FIXED_NOW,
    ...overrides
  });
}

/** 合集全文里所有形如 `字段: 值` 的 frontmatter 行字段名（正文不含这种行）。 */
function frontmatterFieldNames(text) {
  return text
    .split('\n')
    .map((line) => /^([A-Za-z][A-Za-z0-9_]*):/.exec(line)?.[1])
    .filter(Boolean);
}

describe('runForDate：成功路径（写入合集）', () => {
  test('写到 diaries/diary.md，每篇只有 4 个 frontmatter 字段；index v2 生成；noNotify 不发请求', async () => {
    const project = projectWithSocial();
    const notifyMock = makeFetchMock(() => jsonResponse({ retcode: 0, data: {} }));
    const llmMock = llmFetchMock({ chars: 300 });
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      noNotify: true,
      fetchImpl: notifyMock,
      llmFetchImpl: llmMock,
      now: FIXED_NOW
    });

    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.equal(result.date, FIXED_TODAY);
    assert.equal(result.path, diaryFilePath(project.config));
    assert.equal(result.notify, null);
    assert.equal(notifyMock.calls.length, 0, '--no-notify 时不应有任何通知请求');
    assert.equal(llmMock.calls.length, 1, '应调用一次模型');

    // 返回结构：entry 取代 meta/content
    assert.equal(result.meta, undefined);
    assert.equal(result.content, undefined);
    assert.deepEqual(Object.keys(result.entry).sort(), ['body', 'date', 'role', 'summary', 'weekday']);
    assert.equal(result.entry.date, FIXED_TODAY);
    assert.equal(result.entry.weekday, FIXED_WEEKDAY);
    assert.equal(result.entry.role, DEFAULT_ROLE);
    assert.equal(result.entry.summary, DEFAULT_SUMMARY);
    assert.equal(result.entry.body, result.diary);

    const file = project.diaryFile();
    assert.equal(file, path.join(project.config.diaryDir, 'diary.md'));
    assert.equal(pathExists(file), true);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith('---\n'));
    assert.deepEqual(frontmatterFieldNames(text), ['date', 'weekday', 'role', 'summary']);
    for (const forbidden of ['model', 'generatedAt', 'context', 'contextChars', 'source']) {
      assert.ok(!new RegExp(`^${forbidden}:`, 'm').test(text), `合集里不应出现 ${forbidden}:`);
    }
    assert.ok(text.includes(`date: '${FIXED_TODAY}'`));
    assert.ok(text.includes('weekday: 星期五'));
    assert.ok(text.includes(`role: ${DEFAULT_ROLE}`));
    assert.ok(text.includes(`summary: ${DEFAULT_SUMMARY}`));

    const entries = readEntries(project);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].date, FIXED_TODAY);
    assert.ok(entries[0].chars >= 200 && entries[0].chars <= 400, `chars=${entries[0].chars}`);
    assert.equal(entries[0].body, result.diary);

    // index.json v2
    const rawIndex = JSON.parse(fs.readFileSync(project.config.indexFile, 'utf8'));
    assert.equal(rawIndex.version, 2);
    assert.equal(rawIndex.file, 'diary.md');
    assert.equal(rawIndex.entries.length, 1);
    assert.equal(rawIndex.entries[0].date, FIXED_TODAY);
    assert.equal(rawIndex.entries[0].summary, DEFAULT_SUMMARY);
    assert.deepEqual(Object.keys(rawIndex.entries[0]).sort(), ['bodyHash', 'chars', 'date', 'role', 'summary', 'weekday']);

    // 发给模型的 prompt 里应包含日期与角色
    const sentBody = JSON.parse(llmMock.calls[0].options.body);
    assert.ok(sentBody.messages[0].content[0].text.includes(FIXED_TODAY));
    assert.ok(sentBody.system.includes(DEFAULT_ROLE));
  });

  test('默认通知走 snowluma 假 fetch（不访问网络），state 记录成功', async () => {
    const project = projectWithSocial();
    const notifyMock = makeFetchMock((record) => {
      assert.ok(String(record.url).includes('/send_private_msg'));
      return jsonResponse({ retcode: 0, data: { message_id: 1 } });
    });
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      fetchImpl: notifyMock,
      llmFetchImpl: llmFetchMock({ chars: 300 }),
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.notify.ok, true);
    assert.equal(result.notify.channel, 'snowluma');
    assert.equal(notifyMock.calls.length, 1);
    const state = JSON.parse(fs.readFileSync(notifyFiles(project.config).state, 'utf8'));
    assert.equal(state.sent[FIXED_TODAY].ok, true);
  });

  test('同日再跑 → skipped:true，合集文件内容与 mtime 都不变', async () => {
    const project = projectWithSocial();
    await run(project);
    const file = project.diaryFile();
    const beforeText = fs.readFileSync(file, 'utf8');
    const beforeMtime = fs.statSync(file).mtimeMs;

    const second = await run(project);
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'exists');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeText);
    assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
  });

  test('连写两天：补写旧日期插到正确位置（升序）', async () => {
    const project = projectWithSocial();
    await run(project, { dateKey: '2026-10-23' });
    await run(project, { dateKey: '2026-10-22', llmFetchImpl: llmFetchMock({ chars: 240, summary: '22 号摘要。' }) });
    await run(project, { dateKey: '2026-10-21', llmFetchImpl: llmFetchMock({ chars: 230, summary: '21 号摘要。' }) });

    const entries = readEntries(project);
    assert.deepEqual(entries.map((entry) => entry.date), ['2026-10-21', '2026-10-22', '2026-10-23']);
    const text = fs.readFileSync(project.diaryFile(), 'utf8');
    const order = [...text.matchAll(/date: '(\d{4}-\d{2}-\d{2})'/g)].map((match) => match[1]);
    assert.deepEqual(order, ['2026-10-21', '2026-10-22', '2026-10-23']);
    // 3 篇 × 4 个字段，没有多余字段
    assert.deepEqual(frontmatterFieldNames(text), Array(3).fill(['date', 'weekday', 'role', 'summary']).flat());

    const rawIndex = JSON.parse(fs.readFileSync(project.config.indexFile, 'utf8'));
    assert.deepEqual(rawIndex.entries.map((item) => item.date), ['2026-10-21', '2026-10-22', '2026-10-23']);
  });

  test('force:true → 整本备份到 .backup/diary.<HHmmss>.md 后覆盖同一天', async () => {
    const project = projectWithSocial();
    await run(project);
    await run(project, { dateKey: '2026-10-22' });
    const file = project.diaryFile();
    const oldText = fs.readFileSync(file, 'utf8');
    assert.equal(readEntries(project).length, 2);

    const second = await run(project, {
      force: true,
      llmFetchImpl: llmFetchMock({ chars: 260, summary: '第二篇的摘要。' })
    });
    assert.equal(second.ok, true);
    assert.equal(second.written, true);
    assert.ok(second.backupPath, '应返回备份路径');
    assert.equal(path.dirname(second.backupPath), project.config.backupDir);
    assert.match(path.basename(second.backupPath), /^diary\.\d{6}\.md$/);
    assert.equal(fs.readFileSync(second.backupPath, 'utf8'), oldText, '备份必须是整本旧合集');
    assert.equal(readEntries(project).length, 2, '覆盖同一天不应增加篇数');
    assert.equal(readEntry(project, FIXED_TODAY).summary, '第二篇的摘要。');
  });

  test('force:true 但合集里没有这一天 → 不产生备份', async () => {
    const project = projectWithSocial();
    const result = await run(project, { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.backupPath, null);
    assert.equal(fs.existsSync(project.config.backupDir), false);
  });

  test('模型输出被截断（diary 字符串未闭合）→ partial 救回后仍写出可读正文', async () => {
    const project = projectWithSocial();
    const body = diaryText(300);
    const truncated = `{"diary":"${body}`;
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      noNotify: true,
      fetchImpl: makeFetchMock(),
      llmFetchImpl: makeFetchMock(() => jsonResponse({ content: [{ type: 'text', text: truncated }] })),
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.equal(result.parseMode, 'partial');
    const entry = readEntry(project, FIXED_TODAY);
    assert.equal(entry.body, body);
    assert.ok(!entry.body.includes('{"diary"'), '正文里不应残留 JSON 片段');
    assert.ok(entry.summary.length > 0);
  });
});

describe('runForDate：dry-run', () => {
  test('dryRun:true → 不写合集、不调 LLM、不通知', async () => {
    const project = projectWithSocial();
    const llmMock = makeFetchMock(() => {
      throw new Error('dry-run 不应调用 LLM');
    });
    const notifyMock = makeFetchMock(() => {
      throw new Error('dry-run 不应通知');
    });
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      dryRun: true,
      fetchImpl: notifyMock,
      llmFetchImpl: llmMock,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.previewOnly, true);
    assert.equal(result.entry, undefined);
    assert.equal(llmMock.calls.length, 0);
    assert.equal(notifyMock.calls.length, 0);
    assert.equal(pathExists(project.diaryFile()), false);
    assert.equal(pathExists(project.config.indexFile), false);
  });

  test('dryRun + withLlm → 调用 LLM 但不写文件', async () => {
    const project = projectWithSocial();
    const llmMock = llmFetchMock({ chars: 300 });
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      dryRun: true,
      withLlm: true,
      noNotify: true,
      fetchImpl: makeFetchMock(),
      llmFetchImpl: llmMock,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldWrite, true);
    assert.equal(llmMock.calls.length, 1);
    assert.ok(result.diary.length > 0);
    assert.equal(pathExists(project.diaryFile()), false);
  });

  test('config.dryRunCallsLlm=true 时 dry-run 也会调用 LLM', async () => {
    const project = projectWithSocial();
    project.config.dryRunCallsLlm = true;
    const llmMock = llmFetchMock({ chars: 300 });
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      dryRun: true,
      noNotify: true,
      fetchImpl: makeFetchMock(),
      llmFetchImpl: llmMock,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(llmMock.calls.length, 1);
    assert.equal(pathExists(project.diaryFile()), false);
  });

  test('dryRun + 合集里已有这一天 → 不提前跳过，仍做预览且不改动文件', async () => {
    const project = projectWithSocial();
    await run(project);
    const file = project.diaryFile();
    const before = fs.readFileSync(file, 'utf8');
    const beforeMtime = fs.statSync(file).mtimeMs;

    const llmMock = makeFetchMock(() => {
      throw new Error('dry-run 不应调用 LLM');
    });
    const notifyMock = makeFetchMock(() => {
      throw new Error('dry-run 不应通知');
    });
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      dryRun: true,
      fetchImpl: notifyMock,
      llmFetchImpl: llmMock,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.previewOnly, true);
    assert.equal(result.skipped, undefined, 'dry-run 不应因为已存在而跳过');
    assert.equal(result.exists, true);
    assert.ok(result.prompts.system.length > 0);
    assert.ok(result.prompts.user.includes(FIXED_TODAY));
    assert.equal(llmMock.calls.length, 0);
    assert.equal(notifyMock.calls.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
  });

  test('dryRun + withLlm + 已存在 → 给出预览但绝不覆盖旧合集', async () => {
    const project = projectWithSocial();
    await run(project);
    const file = project.diaryFile();
    const before = fs.readFileSync(file, 'utf8');

    const llmMock = llmFetchMock({ chars: 260, summary: '预览用摘要。' });
    const result = await runForDate({
      config: project.config,
      facts: project.facts,
      dateKey: FIXED_TODAY,
      dryRun: true,
      withLlm: true,
      noNotify: true,
      fetchImpl: makeFetchMock(),
      llmFetchImpl: llmMock,
      now: FIXED_NOW
    });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldWrite, true);
    assert.equal(result.exists, true);
    assert.equal(result.summary, '预览用摘要。');
    assert.equal(llmMock.calls.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'dry-run 不得覆盖已有合集');
  });
});

describe('runForDate：LLM 失败', () => {
  test('HTTP 500 → ok:false 且不生成合集', async () => {
    const project = projectWithSocial({ maxRetries: 0 });
    const result = await run(project, { llmFetchImpl: makeFetchMock(() => jsonResponse({ error: { message: 'boom' } }, 500)) });
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP_ERROR/);
    assert.equal(pathExists(project.diaryFile()), false);
  });

  test('超时 → ok:false 且不生成合集', async () => {
    const project = projectWithSocial({ maxRetries: 0 });
    const result = await run(project, {
      llmFetchImpl: makeFetchMock(() => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      })
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /TIMEOUT/);
    assert.equal(pathExists(project.diaryFile()), false);
  });

  test('空内容 → ok:false 且不生成合集', async () => {
    const project = projectWithSocial({ maxRetries: 0 });
    const result = await run(project, { llmFetchImpl: makeFetchMock(() => jsonResponse({ content: [] })) });
    assert.equal(result.ok, false);
    assert.match(result.error, /EMPTY_RESPONSE/);
    assert.equal(pathExists(project.diaryFile()), false);
  });

  test('空白文本 → EMPTY_RESPONSE；合法 JSON 但 diary 为空 → EMPTY_DIARY', async () => {
    const blankProject = projectWithSocial({ maxRetries: 0 });
    const blank = await run(blankProject, {
      llmFetchImpl: makeFetchMock(() => jsonResponse({ content: [{ type: 'text', text: '   ' }] }))
    });
    assert.equal(blank.ok, false);
    assert.match(blank.error, /EMPTY_RESPONSE/);
    assert.equal(pathExists(blankProject.diaryFile()), false);

    const emptyDiaryProject = projectWithSocial({ maxRetries: 0 });
    const emptyDiary = await run(emptyDiaryProject, {
      llmFetchImpl: makeFetchMock(() =>
        jsonResponse({ content: [{ type: 'text', text: JSON.stringify({ diary: '', summary: '模型抽风了' }) }] })
      )
    });
    assert.equal(emptyDiary.ok, false);
    assert.match(emptyDiary.error, /EMPTY_DIARY/);
    assert.equal(pathExists(emptyDiaryProject.diaryFile()), false);
    assert.equal(pathExists(emptyDiaryProject.config.indexFile), false);
  });
});

describe('runForDate：上下文与日期边界', () => {
  test('social-v2 缺失 → 仍写出合集；合集里不写 context 等字段', async () => {
    const project = createProject();
    const result = await run(project);
    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.equal(result.context.empty, true);
    const entry = readEntry(project, FIXED_TODAY);
    assert.ok(entry);
    assert.deepEqual(Object.keys(entry).sort(), ['body', 'chars', 'date', 'role', 'summary', 'weekday']);
    const text = fs.readFileSync(project.diaryFile(), 'utf8');
    assert.ok(!/^context:/m.test(text), '合集里不应写 context 字段');
    assert.ok(!/^contextChars:/m.test(text));
  });

  test('未来日期 → ok:false 且不写合集', async () => {
    const project = projectWithSocial();
    const result = await run(project, { dateKey: '2026-10-24' });
    assert.equal(result.ok, false);
    assert.match(result.error, /未来日期/);
    assert.equal(pathExists(project.diaryFile()), false);
  });

  test('非法日期键 → ok:false 且不写合集', async () => {
    const project = projectWithSocial();
    const result = await run(project, { dateKey: '2026-02-30' });
    assert.equal(result.ok, false);
    assert.match(result.error, /无效日期/);
    assert.equal(fs.existsSync(project.diaryFile()), false);
  });

  test('过去日期可补写，且插到正确位置（整日窗口）', async () => {
    const project = projectWithSocial();
    await run(project, { dateKey: '2026-10-23' });
    const result = await run(project, { dateKey: '2026-10-21' });
    assert.equal(result.ok, true);
    assert.equal(result.written, true);
    assert.deepEqual(readEntries(project).map((entry) => entry.date), ['2026-10-21', '2026-10-23']);
    assert.equal(findEntry(readEntries(project), '2026-10-21').date, '2026-10-21');
    assert.equal(readCollection({ config: project.config }).exists, true);
  });
});
