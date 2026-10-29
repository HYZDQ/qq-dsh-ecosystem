// S4 周记/月记（GEN3_SURFACE_INTEGRATION_PLAN §12）：只生成、不发布。
// 周期计算 / 本地合集存取 / diary_digest 与 diary_digest_write 工具行为。
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createDiaryServer } from '../mcp-server.mjs';
import {
  collectDigestMaterial,
  digestFilePath,
  parseDigests,
  periodRange,
  readDigests,
  upsertDigest
} from '../src/digest.js';
import { upsertEntry } from '../src/store.js';
import {
  FIXED_NOW,
  FIXED_TODAY,
  GROUP_ID,
  OWNER_QQ,
  cleanupTempRoots,
  createProject,
  diaryText
} from './helpers.js';

after(cleanupTempRoots);

describe('periodRange', () => {
  it('week=周一~周日（含锚点日所在周）', () => {
    // 2026-10-23 是星期五 → 2026-10-19（周一）~ 2026-10-25（周日）
    const range = periodRange({ period: 'week', dateKey: '2026-10-23' });
    assert.equal(range.start, '2026-10-19');
    assert.equal(range.end, '2026-10-25');
    assert.ok(range.label.includes('周记'));
  });

  it('month=当月 1 日~末日', () => {
    const range = periodRange({ period: 'month', dateKey: '2026-10-23' });
    assert.equal(range.start, '2026-10-01');
    assert.equal(range.end, '2026-10-31');
  });

  it('非法日期/周期抛错', () => {
    assert.throws(() => periodRange({ period: 'week', dateKey: '2026-13-01' }), /无效日期/);
    assert.throws(() => periodRange({ period: 'year', dateKey: '2026-10-23' }), /无效周期/);
  });
});

describe('周记/月记本地合集', () => {
  it('upsert → 读回一致；同周期覆盖；不同周期共存', () => {
    const project = createProject({ config: { notifyOwner: { enabled: false } } });
    const first = upsertDigest({
      config: project.config,
      entry: { period: 'week', date: '2026-10-23', role: '蓝莓球', summary: '这周挺安稳', body: '这一周过得挺安稳。' }
    });
    assert.equal(first.ok, true);
    assert.equal(first.replaced, false);
    const second = upsertDigest({
      config: project.config,
      entry: { period: 'week', date: '2026-10-23', role: '蓝莓球', summary: '这周很安稳', body: '这一周过得很安稳。' }
    });
    assert.equal(second.replaced, true);
    upsertDigest({
      config: project.config,
      entry: { period: 'month', date: '2026-10-23', role: '蓝莓球', summary: '十月小结', body: '十月也过完了。' }
    });
    const read = readDigests({ config: project.config });
    assert.equal(read.ok, true);
    assert.equal(read.entries.length, 2);
    const week = read.entries.find((entry) => entry.period === 'week');
    assert.equal(week.summary, '这周很安稳');
    assert.equal(week.body, '这一周过得很安稳。');
    assert.equal(week.role, '蓝莓球');
    // 文件确实落在 diaries/digests.md（与日记本 diary.md 分开）
    assert.ok(fs.existsSync(digestFilePath(project.config)));
    assert.notEqual(digestFilePath(project.config), project.diaryFile());
  });

  it('collectDigestMaterial 只取闭区间内的日记', () => {
    const entries = [
      { date: '2026-10-18' }, { date: '2026-10-19' }, { date: '2026-10-25' }, { date: '2026-10-26' }
    ];
    const picked = collectDigestMaterial(entries, periodRange({ period: 'week', dateKey: '2026-10-23' }));
    assert.deepEqual(picked.map((entry) => entry.date), ['2026-10-19', '2026-10-25']);
  });

  it('合集损坏时拒绝覆盖（ok:false）', () => {
    const project = createProject({ config: { notifyOwner: { enabled: false } } });
    fs.mkdirSync(path.dirname(digestFilePath(project.config)), { recursive: true });
    fs.writeFileSync(digestFilePath(project.config), '不是任何合集格式', 'utf8');
    const read = readDigests({ config: project.config });
    assert.equal(read.ok, false);
    const write = upsertDigest({
      config: project.config,
      entry: { period: 'week', date: '2026-10-23', role: '蓝莓球', summary: 's', body: 'b' }
    });
    assert.equal(write.ok, false);
  });

  it('parseDigests 忽略正文里的 --- 与非法条目', () => {
    const text = [
      '---', 'period: week', "date: '2026-10-23'", 'role: 蓝莓球', 'summary: ok', '---', '',
      '正文里有一行', '---', '不接 period 的不算新篇', '',
      '---', 'period: bad', "date: '2026-10-23'", '---', '',
      '尾巴属于坏条目'
    ].join('\n');
    const entries = parseDigests(text);
    assert.equal(entries.length, 1);
    assert.ok(entries[0].body.includes('不接 period 的不算新篇'));
    assert.ok(!entries[0].body.includes('尾巴属于坏条目'));
  });
});

describe('diary_digest / diary_digest_write 工具', () => {
  function makeServer() {
    const project = createProject({ config: { notifyOwner: { enabled: false } } });
    for (const date of ['2026-10-19', '2026-10-23']) {
      upsertEntry({
        config: project.config,
        entry: { date, weekday: '星期五', role: '蓝莓球', summary: `${date} 摘要`, body: diaryText(220) }
      });
    }
    const server = createDiaryServer({ config: project.config, facts: project.facts, now: () => FIXED_NOW });
    return { project, server };
  }

  const call = (server, name, args = {}) =>
    server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: { chatKey: `private:${OWNER_QQ}`, ...args } }
    });
  const textOf = (response) => response?.result?.content?.[0]?.text ?? '';

  it('week 汇总返回范围内日记素材', async () => {
    const { server } = makeServer();
    const response = await call(server, 'diary_digest', { period: 'week', date: FIXED_TODAY });
    assert.notEqual(response.result.isError, true, textOf(response));
    const text = textOf(response);
    assert.ok(text.includes('2026-10-19'), text);
    assert.ok(text.includes('2026-10-23'), text);
    assert.ok(text.includes('不会发布'), text);
  });

  it('空周期提示没有日记；非法周期拒绝', async () => {
    const { server } = makeServer();
    const empty = await call(server, 'diary_digest', { period: 'month', date: '2026-09-15' });
    assert.notEqual(empty.result.isError, true, textOf(empty));
    assert.ok(textOf(empty).includes('没有日记'), textOf(empty));
    const bad = await call(server, 'diary_digest', { period: 'year' });
    assert.equal(bad.result.isError, true);
  });

  it('digest_write 保存到 digests.md 并声明不发布', async () => {
    const { project, server } = makeServer();
    const response = await call(server, 'diary_digest_write', {
      period: 'week',
      date: FIXED_TODAY,
      content: '这一周过得挺安稳，白天写写东西，晚上煮了碗面。',
      summary: '安稳的一周'
    });
    assert.notEqual(response.result.isError, true, textOf(response));
    const text = textOf(response);
    assert.ok(text.includes('不会发布') || text.includes('没有发布'), text);
    const read = readDigests({ config: project.config });
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].period, 'week');
    assert.equal(read.entries[0].summary, '安稳的一周');
  });

  it('群聊/他人私聊/缺 chatKey 一律拒绝（H3）', async () => {
    const { server } = makeServer();
    for (const chatKey of [`group:${GROUP_ID}`, 'private:20002', '']) {
      for (const name of ['diary_digest', 'diary_digest_write']) {
        const response = await call(server, name, { period: 'week', content: '内容', chatKey });
        assert.equal(response.result.isError, true, `${name} ${chatKey}`);
      }
    }
  });

  it('空正文拒绝保存', async () => {
    const { server } = makeServer();
    const response = await call(server, 'diary_digest_write', { period: 'week', content: '  ' });
    assert.equal(response.result.isError, true);
  });
});
