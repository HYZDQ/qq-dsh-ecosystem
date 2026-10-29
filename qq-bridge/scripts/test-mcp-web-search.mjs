// 测试安全 Web Search / Fetch MCP server：
// - 离线确定性用例：隐私查询拒绝、纯 CQ 查询拒绝、draft_material 门禁、预算超限（S1）
// - web_search：查一个网络用语/梗
// - web_fetch：抓取一个公开 URL 并检查是否返回正文
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dayKeyOf, hourKeyOf } from '../src/surface/budget.js';

const entry = fileURLToPath(new URL('../src/mcp-web-search-safe.js', import.meta.url));
const budgetFile = fileURLToPath(new URL('../state/cache/web-search-budget.json', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

function parseToolJson(response) {
  try { return JSON.parse(response.content?.[0]?.text ?? ''); } catch { return null; }
}

try {
  await client.connect(transport);
  console.log('✅ Web Search MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  // ── S1 离线用例：拒绝路径不触网，结果必须带稳定错误码 ──
  const privacy = parseToolJson(await client.callTool({ name: 'web_search', arguments: { query: '帮我查 13800138000 和 a.b@gmail.com 的事' } }));
  console.log(privacy?.code === 'SEARCH_QUERY_REJECTED' ? '✅ 隐私查询被拒出网' : `⚠️ 隐私查询未被拒：${JSON.stringify(privacy)?.slice(0, 120)}`);
  if (privacy?.code !== 'SEARCH_QUERY_REJECTED') process.exit(1);

  const pureCq = parseToolJson(await client.callTool({ name: 'web_search', arguments: { query: '[CQ:at,qq=123456]' } }));
  console.log(pureCq?.code === 'SEARCH_QUERY_REJECTED' ? '✅ 纯 CQ 码查询被拒' : `⚠️ 纯 CQ 查询未被拒：${JSON.stringify(pureCq)?.slice(0, 120)}`);
  if (pureCq?.code !== 'SEARCH_QUERY_REJECTED') process.exit(1);

  const bridgeOnly = parseToolJson(await client.callTool({ name: 'web_search', arguments: { query: '随便搜点素材', purpose: 'draft_material' } }));
  console.log(bridgeOnly?.code === 'SEARCH_QUERY_REJECTED' ? '✅ draft_material 非桥接调用被拒' : `⚠️ draft_material 未被拒：${JSON.stringify(bridgeOnly)?.slice(0, 120)}`);
  if (bridgeOnly?.code !== 'SEARCH_QUERY_REJECTED') process.exit(1);

  // 预算超限：必须在 spawn 前写入快照（预算在 MCP 进程启动时读入内存）——放最后单独起进程测

  const search = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
  const searchJson = parseToolJson(search);
  console.log('✅ web_search:', search.content?.[0]?.text?.slice(0, 300));
  // S1 契约：结果带 trust=untrusted 与 sourceId（联网时校验；降级也必须带）
  if (searchJson?.ok && !search.isError) {
    console.log(searchJson.trust === 'untrusted' ? '✅ 结果带 trust=untrusted' : '⚠️ 结果缺 trust 标注');
    if (searchJson.trust !== 'untrusted') process.exit(1);
    const bad = (searchJson.results ?? []).filter((r) => !/^src_[0-9a-f]{16}$/.test(r.sourceId ?? ''));
    console.log(bad.length === 0 ? '✅ 所有结果带 sourceId' : `⚠️ 有结果缺 sourceId：${bad.length}`);
    if (bad.length) process.exit(1);
    console.log(searchJson.notice?.includes('不可信') ? '✅ 返回体带不可信声明' : '⚠️ 缺不可信声明');
    if (!searchJson.notice?.includes('不可信')) process.exit(1);
  }

  const fetch = await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'https://mobile.moegirl.org.cn/DeepSeek%E5%A8%98' }
  });
  const text = fetch.content?.[0]?.text ?? '';
  console.log('✅ web_fetch:', text.slice(0, 500));
  console.log('isError:', fetch.isError ? '是' : '否');

  // 内网地址应被拒绝
  const bad = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  console.log('🚫 内网拦截:', bad.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', bad.content?.[0]?.text?.slice(0, 120));
  // 不调 process.exit(0)：会让下面 finally 的预算用例被跳过。
  // 但必须关 client：stdio 句柄不关会让 node 事件环挂住永不退出。
  await client.close();
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exitCode = 1;
} finally {
  // 兜底关闭主 client（try 里失败提前退出时不会走到 close）
  await client.close().catch(() => { });
  // 预算超限用例：预算在 MCP 进程启动时读入内存，必须 spawn 前写好快照——
  // 所以单独起一个 MCP 进程测。快照用后恢复，不影响真实预算计数。
  try {
    const backup = fs.existsSync(budgetFile) ? fs.readFileSync(budgetFile) : null;
    fs.mkdirSync(path.dirname(budgetFile), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(budgetFile, JSON.stringify({ dayKey: dayKeyOf(now), hourKey: hourKeyOf(now), counts: { search: { day: 999999, hour: 999999 } } }), 'utf8');
    const t2 = new StdioClientTransport({ command: process.execPath, args: [entry] });
    const c2 = new Client({ name: 'bridge-test-budget', version: '0.1.0' });
    await c2.connect(t2);
    const over = parseToolJson(await c2.callTool({ name: 'web_search', arguments: { query: '普通查询词' } }));
    console.log(over?.code === 'SEARCH_BUDGET_EXCEEDED' && over?.resetAt ? '✅ 预算超限稳定拒绝（含 resetAt）' : `⚠️ 预算未生效：${JSON.stringify(over)?.slice(0, 120)}`);
    if (over?.code !== 'SEARCH_BUDGET_EXCEEDED' || !over?.resetAt) process.exitCode = 1;
    await c2.close();
    if (backup) fs.writeFileSync(budgetFile, backup);
    else fs.rmSync(budgetFile, { force: true });
  } catch (error) {
    console.error('❌ 预算用例失败:', error?.message ?? error);
    process.exitCode = 1;
  }
}
