// MCP server（mcp-server.mjs）测试：协议握手、工具清单、写/读/列/搜/状态、失败分支、stdio 传输。
// 日记存储为单文件合集（diaries/diary.md），每篇 4 个 frontmatter 字段。
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PassThrough } from 'node:stream';

import { createDiaryServer, serveStdio, listToolDefinitions } from '../mcp-server.mjs';
import { countDiaryChars } from '../src/prompt.js';
import { findEntry, readCollection } from '../src/store.js';
import {
  FIXED_NOW,
  FIXED_TODAY,
  OWNER_QQ,
  cleanupTempRoots,
  createProject,
  diaryText,
  jsonResponse,
  makeFetchMock,
  readEntries,
  readJsonFileSync
} from './helpers.js';

after(cleanupTempRoots);

function makeServer(projectOptions = {}, serverOptions = {}) {
  const project = createProject({
    config: { notifyOwner: { enabled: false }, ...projectOptions.config },
    ...projectOptions
  });
  const server = createDiaryServer({
    config: project.config,
    facts: project.facts,
    now: () => FIXED_NOW,
    notifyFetchImpl: serverOptions.notifyFetchImpl ?? makeFetchMock(),
    ...serverOptions
  });
  return { project, server };
}

// H3 契约：工具必须传 chatKey=private:<ownerQQ>（不传/群聊/他人私聊一律拒绝）。
// 测试默认注入主人私聊 key；测鉴权边界的用例显式传自己的 chatKey 覆盖。
const OWNER_CHAT_KEY = `private:${OWNER_QQ}`;
const call = (server, name, args = {}) => server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { chatKey: OWNER_CHAT_KEY, ...args } } });
const textOf = (response) => response?.result?.content?.[0]?.text ?? '';
const isError = (response) => response?.result?.isError === true;
const entry = (project, dateKey = FIXED_TODAY) => findEntry(readCollection({ config: project.config }).entries, dateKey);

describe('MCP 协议握手', () => {
  it('initialize 返回协议版本与 serverInfo', async () => {
    const { server } = makeServer();
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.equal(response.id, 7);
    assert.equal(response.result.serverInfo.name, 'qq-diary');
    assert.equal(typeof response.result.protocolVersion, 'string');
    assert.equal(response.result.capabilities.tools.listChanged, false);
  });

  it('通知（无 id）不产生响应', async () => {
    const { server } = makeServer();
    const response = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(response, null);
  });

  it('ping 与未知方法', async () => {
    const { server } = makeServer();
    assert.deepEqual((await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' })).result, {});
    const unknown = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' });
    assert.equal(unknown.error.code, -32601);
  });

  it('非法消息返回 -32600', async () => {
    const { server } = makeServer();
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 9, foo: 'bar' });
    assert.equal(response.error.code, -32600);
  });
});

describe('tools/list', () => {
  it('暴露 8 个日记工具且 schema 合法', async () => {
    const { server } = makeServer();
    const response = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = response.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      'diary_write', 'diary_read', 'diary_list', 'diary_search', 'diary_status',
      'diary_share_to_qzone', 'diary_digest', 'diary_digest_write'
    ]);
    const writeTool = tools.find((tool) => tool.name === 'diary_write');
    assert.equal(writeTool.inputSchema.type, 'object');
    assert.deepEqual(writeTool.inputSchema.required, ['content', 'chatKey'], 'H3：chatKey 必传（主人私聊）');
    assert.ok(writeTool.inputSchema.properties.content);
    assert.ok(writeTool.inputSchema.properties.force);
    assert.ok(writeTool.description.includes('每天最多一篇'));
    assert.deepEqual(listToolDefinitions().map((tool) => tool.name), tools.map((tool) => tool.name));
  });
});

describe('diary_write', () => {
  it('正常写入：合集文件 + 4 字段 frontmatter + v2 index + 返回文案', async () => {
    const { project, server } = makeServer();
    const content = diaryText(300);
    const response = await call(server, 'diary_write', { content, summary: '今天很平静' });
    assert.equal(isError(response), false, textOf(response));
    const text = textOf(response);
    assert.ok(text.includes(FIXED_TODAY), text);
    assert.ok(text.includes('写进日记本'), text);
    assert.ok(/共 1 篇/.test(text), text);
    assert.ok(text.includes('没有给主人发通知'), text);
    const expectedChars = countDiaryChars(content);
    assert.ok(text.includes(`${expectedChars} 字`), text);

    const file = project.diaryFile();
    assert.equal(file, path.join(project.config.diaryDir, 'diary.md'));
    assert.ok(fs.existsSync(file));
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.startsWith('---\n'));
    assert.ok(raw.includes(`date: '${FIXED_TODAY}'`));
    assert.ok(raw.includes('weekday: 星期五'));
    assert.ok(raw.includes('role: 蓝莓球'));
    assert.ok(raw.includes('summary: 今天很平静'));
    assert.ok(raw.includes(content.slice(0, 20)));
    for (const forbidden of ['source', 'model', 'generatedAt', 'context', 'contextChars']) {
      assert.ok(!new RegExp(`^${forbidden}:`, 'm').test(raw), `合集里不应出现 ${forbidden}:`);
    }

    const written = entry(project);
    assert.ok(written);
    assert.deepEqual(Object.keys(written).sort(), ['body', 'chars', 'date', 'role', 'summary', 'weekday']);
    assert.equal(written.chars, expectedChars);

    const index = readJsonFileSync(path.join(project.diaryDir, 'index.json'));
    assert.equal(index.version, 2);
    assert.equal(index.file, 'diary.md');
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].date, FIXED_TODAY);
    assert.equal(index.entries[0].chars, expectedChars);
    assert.deepEqual(Object.keys(index.entries[0]).sort(), ['bodyHash', 'chars', 'date', 'role', 'summary', 'weekday']);
  });

  it('不传 summary 时用正文首句', async () => {
    const { project, server } = makeServer();
    const content = diaryText(220);
    const response = await call(server, 'diary_write', { content });
    assert.equal(isError(response), false);
    const written = entry(project);
    assert.equal(written.summary, '今天醒来的时候窗外有雾，玻璃上蒙着一层白。');
    assert.ok(/summary: .+/.test(fs.readFileSync(project.diaryFile(), 'utf8')));
  });

  it('超长正文按句边界截断', async () => {
    const { project, server } = makeServer();
    const content = diaryText(900);
    const response = await call(server, 'diary_write', { content });
    assert.equal(isError(response), false);
    const written = entry(project);
    assert.ok(written.chars <= 400, `截断后 ${written.chars} 字`);
    assert.ok(textOf(response).includes('收短'));
  });

  it('太短拒绝写入', async () => {
    const { project, server } = makeServer();
    const response = await call(server, 'diary_write', { content: '今天没什么事。' });
    assert.equal(isError(response), true);
    assert.ok(textOf(response).includes('太短'));
    assert.equal(fs.existsSync(project.diaryFile()), false);
  });

  it('当天已写 → 拒绝重复（每天最多一篇），合集不变', async () => {
    const { project, server } = makeServer();
    const first = await call(server, 'diary_write', { content: diaryText(300) });
    assert.equal(isError(first), false);
    const before = fs.readFileSync(project.diaryFile(), 'utf8');
    const second = await call(server, 'diary_write', { content: diaryText(300) });
    assert.equal(isError(second), false, '重复写不是错误，只是拒绝');
    assert.ok(textOf(second).includes('已经写过'), textOf(second));
    assert.equal(fs.readFileSync(project.diaryFile(), 'utf8'), before);
    assert.equal(readEntries(project).length, 1);
  });

  it('force=true 覆盖并备份整本合集', async () => {
    const { project, server } = makeServer();
    await call(server, 'diary_write', { content: diaryText(300), summary: '第一次' });
    const oldText = fs.readFileSync(project.diaryFile(), 'utf8');

    const response = await call(server, 'diary_write', { content: `${diaryText(300)}后来重写了一段。`, force: true, summary: '重写' });
    assert.equal(isError(response), false, textOf(response));
    assert.ok(textOf(response).includes('旧版合集已备份'), textOf(response));
    assert.equal(readEntries(project).length, 1, '覆盖同一天不增加篇数');
    assert.equal(entry(project).summary, '重写');

    const backups = fs.readdirSync(path.join(project.diaryDir, '.backup'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^diary\.\d{6}\.md$/);
    assert.equal(fs.readFileSync(path.join(project.diaryDir, '.backup', backups[0]), 'utf8'), oldText);
  });

  it('写两天 → 合集升序 2 篇，diary_list 也按升序', async () => {
    const { project, server } = makeServer();
    const first = await call(server, 'diary_write', { content: diaryText(230), date: '2026-10-22', summary: '22 号' });
    assert.equal(isError(first), false, textOf(first));
    assert.ok(/共 1 篇/.test(textOf(first)));
    const second = await call(server, 'diary_write', { content: diaryText(240), summary: '23 号' });
    assert.equal(isError(second), false, textOf(second));
    assert.ok(/共 2 篇/.test(textOf(second)), textOf(second));

    assert.deepEqual(readEntries(project).map((item) => item.date), ['2026-10-22', FIXED_TODAY]);
    const raw = fs.readFileSync(project.diaryFile(), 'utf8');
    assert.ok(raw.indexOf("date: '2026-10-22'") < raw.indexOf(`date: '${FIXED_TODAY}'`), '合集中 22 号应在 23 号前面');

    const list = await call(server, 'diary_list', { limit: 5 });
    assert.equal(isError(list), false);
    const listText = textOf(list);
    assert.ok(listText.includes('共 2 篇'), listText);
    assert.ok(listText.includes('按日期升序'), listText);
    assert.ok(listText.indexOf('2026-10-22') < listText.indexOf(FIXED_TODAY), listText);

    // limit 只显示最近的 N 篇，但仍按升序
    const limited = await call(server, 'diary_list', { limit: 1 });
    assert.ok(textOf(limited).includes('最近 1 篇'), textOf(limited));
    assert.ok(textOf(limited).includes(FIXED_TODAY));
    assert.ok(!textOf(limited).includes('2026-10-22'));
  });

  it('还没有日记时 list 给出空提示', async () => {
    const { server } = makeServer();
    const list = await call(server, 'diary_list', {});
    assert.equal(isError(list), false);
    assert.ok(textOf(list).includes('还没有写过日记'));
  });

  it('未来日期 / 非法日期 / 群聊 key 都拒绝', async () => {
    const { project, server } = makeServer();
    const future = await call(server, 'diary_write', { content: diaryText(300), date: '2099-01-01' });
    assert.equal(isError(future), true);
    const invalid = await call(server, 'diary_write', { content: diaryText(300), date: '2026-02-30' });
    assert.equal(isError(invalid), true);
    const group = await call(server, 'diary_write', { content: diaryText(300), chatKey: 'group:30001' });
    assert.equal(isError(group), true);
    assert.ok(textOf(group).includes('群聊'));
    assert.equal(fs.existsSync(project.diaryFile()), false);
  });

  it('H3 owner 鉴权四组：群聊/他人私聊/缺 chatKey 拒绝，主人私聊通过', async () => {
    const { project, server } = makeServer();
    const body = diaryText(300);
    // ① 群聊拒
    const group = await call(server, 'diary_read', { chatKey: 'group:30001' });
    assert.equal(isError(group), true);
    // ② 他人私聊拒
    const stranger = await call(server, 'diary_read', { chatKey: 'private:99999' });
    assert.equal(isError(stranger), true);
    assert.ok(textOf(stranger).includes('只有主人私聊'));
    // ③ 缺 chatKey 拒（不再默认放行）
    const missing = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diary_write', arguments: { content: body } } });
    assert.equal(isError(missing), true);
    assert.ok(textOf(missing).includes('chatKey'));
    // ④ 主人私聊通过
    const owner = await call(server, 'diary_write', { content: body });
    assert.equal(isError(owner), false);
    assert.ok(textOf(owner).includes('写进日记本'));
    assert.ok(fs.existsSync(project.diaryFile()));
    // 5 个工具全部受同一鉴权管（read/list/search/status 抽查）
    for (const name of ['diary_list', 'diary_status']) {
      const denied = await call(server, name, { chatKey: 'private:99999' });
      assert.equal(isError(denied), true, `${name} 应拒绝他人私聊`);
    }
    // 未配置 ownerQQ → 失败关闭
    const noOwner = createDiaryServer({
      config: project.config,
      facts: { ownerQQ: null },
      now: () => FIXED_NOW,
      notifyFetchImpl: makeFetchMock()
    });
    const rejected = await call(noOwner, 'diary_status', {});
    assert.equal(isError(rejected), true);
    assert.ok(textOf(rejected).includes('ownerQQ'));
  });

  it('每日写入上限：同日第 4 次（含 force）稳定拒绝', async () => {
    const { server } = makeServer({ config: { maxWritesPerDay: 3 } });
    const body = diaryText(300);
    assert.equal(isError(await call(server, 'diary_write', { content: body })), false);
    assert.equal(isError(await call(server, 'diary_write', { content: body, force: true })), false);
    assert.equal(isError(await call(server, 'diary_write', { content: body, force: true })), false);
    const fourth = await call(server, 'diary_write', { content: body, force: true });
    assert.equal(isError(fourth), true);
    assert.ok(textOf(fourth).includes('上限'));
  });

  it('发通知：走 snowluma 并记入 notify-state', async () => {
    const notifyFetchImpl = makeFetchMock(() => jsonResponse({ status: 'ok', retcode: 0 }));
    const { project, server } = makeServer({ config: { notifyOwner: { enabled: true, channels: ['snowluma'] } } }, { notifyFetchImpl });
    const response = await call(server, 'diary_write', { content: diaryText(300), summary: '今天聊得挺开心' });
    assert.equal(isError(response), false);
    const text = textOf(response);
    assert.ok(text.includes('写进日记本'), text);
    assert.ok(text.includes('现在共 1 篇'), text);
    assert.ok(text.includes('已经给主人发了一句摘要') || text.includes('摘要'), text);
    assert.ok(text.includes('snowluma') || text.includes('摘要'), text);
    assert.equal(notifyFetchImpl.calls.length, 1);
    assert.ok(String(notifyFetchImpl.calls[0].url).includes('/send_private_msg'));
    const state = readJsonFileSync(path.join(project.config.stateDir, 'notify-state.json'));
    assert.equal(state.sent[FIXED_TODAY].ok, true);
  });

  it('notify=false 时不发通知', async () => {
    const notifyFetchImpl = makeFetchMock(() => jsonResponse({ status: 'ok', retcode: 0 }));
    const { project, server } = makeServer({ config: { notifyOwner: { enabled: true, channels: ['snowluma'] } } }, { notifyFetchImpl });
    const response = await call(server, 'diary_write', { content: diaryText(300), notify: false });
    assert.equal(isError(response), false);
    assert.equal(notifyFetchImpl.calls.length, 0);
    assert.equal(fs.existsSync(project.diaryFile()), true);
    assert.equal(readEntries(project).length, 1);
  });
});

describe('diary_read / diary_list / diary_search / diary_status', () => {
  it('读当天与缺失日期', async () => {
    const { server } = makeServer();
    const content = diaryText(300);
    await call(server, 'diary_write', { content });
    const read = await call(server, 'diary_read', {});
    assert.equal(isError(read), false);
    assert.ok(textOf(read).includes(content.slice(0, 20)));
    const missing = await call(server, 'diary_read', { date: '2026-10-01' });
    assert.equal(isError(missing), false);
    assert.ok(textOf(missing).includes('没有日记'));
  });

  it('列表与搜索', async () => {
    const { server } = makeServer();
    await call(server, 'diary_write', { content: diaryText(300), summary: '平静的一天' });
    const list = await call(server, 'diary_list', { limit: 5 });
    assert.equal(isError(list), false);
    assert.ok(textOf(list).includes(FIXED_TODAY));
    const hit = await call(server, 'diary_search', { query: '平静' });
    assert.equal(isError(hit), false);
    assert.ok(textOf(hit).includes(FIXED_TODAY) || textOf(hit).includes('平静'));
    const miss = await call(server, 'diary_search', { query: '不存在的词xyz' });
    assert.equal(isError(miss), false);
    assert.ok(textOf(miss).includes('没有找到'));
  });

  it('status 报告今天已写与下一次定时', async () => {
    const { server } = makeServer();
    const before = await call(server, 'diary_status', {});
    assert.ok(textOf(before).includes('今天还没写'));
    assert.ok(textOf(before).includes('下一次定时写入'));
    await call(server, 'diary_write', { content: diaryText(300) });
    const afterWrite = await call(server, 'diary_status', {});
    assert.ok(textOf(afterWrite).includes('今天已写'));
    assert.ok(textOf(afterWrite).includes('共 1 篇'));
  });

  it('未知工具返回 isError', async () => {
    const { server } = makeServer();
    const response = await call(server, 'diary_nope', {});
    assert.equal(isError(response), true);
  });
});

describe('stdio 传输', () => {
  it('逐行 JSON-RPC：initialize / tools/list / 非法 JSON', async () => {
    const { server } = makeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = serveStdio({ server, input, output });
    const lines = [];
    output.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) lines.push(JSON.parse(line));
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
    input.write('not-json\n');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    const deadline = Date.now() + 2000;
    while (lines.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    transport.stop();
    input.end();
    assert.equal(lines.length, 3, JSON.stringify(lines));
    assert.equal(lines[0].result.serverInfo.name, 'qq-diary');
    assert.equal(lines[1].error.code, -32700);
    assert.equal(lines[2].result.tools.length, 8);
  });
});
