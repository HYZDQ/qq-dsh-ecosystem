// GEN3 表现面 S1 单测：搜索策略（§6/§17.3）——purpose 门禁、查询脱敏拒绝、结果标注/sourceId、
// 缓存 key；与 fetch-page（§H5）——字符集判定/解码、内容类型白名单、正文提取、12k 截断、contentHash。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SEARCH_PURPOSES,
  annotateResults,
  normalizeUrl,
  prepareQuery,
  resolvePurpose,
  searchCacheKey,
  sourceIdFor,
  wrapSearchResponse
} from '../src/surface/search-policy.js';
import {
  CONTENT_TYPE_ALLOWLIST,
  decodeBytes,
  detectCharset,
  extractMainText,
  fetchPage,
  pageHash
} from '../src/surface/fetch-page.js';

// ── search-policy ──

test('resolvePurpose：缺省 fact_check、非法拒绝、draft_material 只许桥接（§6.4）', () => {
  assert.deepEqual(resolvePurpose(undefined), { ok: true, purpose: 'fact_check' });
  assert.deepEqual(resolvePurpose(''), { ok: true, purpose: 'fact_check' });
  assert.deepEqual(resolvePurpose('slang'), { ok: true, purpose: 'slang' });
  const bad = resolvePurpose('hack');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'SEARCH_QUERY_REJECTED');
  const bridgeOnly = resolvePurpose('draft_material');
  assert.equal(bridgeOnly.ok, false, '普通调用拿不到 draft_material');
  assert.equal(resolvePurpose('draft_material', { fromBridge: true }).ok, true);
  assert.equal(SEARCH_PURPOSES.length, 5);
});

test('prepareQuery：隐私片段多的查询默认拒绝出网；放行开关可解锁', () => {
  const leaky = prepareQuery('帮我查 13800138000 和 a.b@gmail.com 的信息');
  assert.equal(leaky.ok, false, '手机号+邮箱 ≥2 个脱敏痕迹默认拒绝');
  assert.equal(leaky.code, 'SEARCH_QUERY_REJECTED');
  const opened = prepareQuery('帮我查 13800138000 和 a.b@gmail.com 的信息', { allowPrivateContextQuery: true });
  assert.equal(opened.ok, true, 'allowPrivateContextQuery=true 放行');
  assert.ok(!opened.query.includes('13800138000'), '放行也不带原文，仍脱敏');
  // 干净查询正常通过
  const clean = prepareQuery('「绝绝子」是什么意思');
  assert.equal(clean.ok, true);
  assert.equal(clean.query, '「绝绝子」是什么意思');
  assert.equal(clean.changed, false);
  // 单个隐私片段（如只是一个 QQ 号当关键词）仍放行但已脱敏
  const single = prepareQuery('123456789 是什么群');
  assert.equal(single.ok, true, '单个痕迹不拒');
  assert.ok(single.query.includes('[QQ号]'));
  // 脱敏后为空 → 拒绝
  assert.equal(prepareQuery('   ').ok, false);
  assert.equal(prepareQuery('[CQ:at,qq=123456]').ok, false, '纯 CQ 码清洗后为空');
});

test('prepareQuery：截断到 120 字', () => {
  const long = prepareQuery('好'.repeat(500), { maxChars: 120 });
  assert.equal(long.ok, true);
  assert.equal(long.query.length, 120);
});

test('annotateResults：字段白名单 + sourceId 与查询无关 + URL 去重（同 URL 不同 fragment）+ snippet 清洗', () => {
  const rows = annotateResults([
    { title: '<b>标&记</b>题', url: 'https://A.example.com/x#frag', snippet: '内容<script>alert(1)</script>尾部', publishedAt: '2026-10-26', evil: '多余字段' },
    { title: '重复', url: 'https://a.example.com/x#other', snippet: '同 URL 不同 fragment' },
    { title: '无 URL', snippet: '应被丢弃' },
    null
  ]);
  assert.equal(rows.length, 1, 'URL 规范化（去 fragment）后去重 + 无 URL 丢弃');
  assert.equal(rows[0].url, 'https://A.example.com/x#frag', '原 URL 保留给调用方');
  assert.ok(!('evil' in rows[0]), '多余字段丢弃');
  assert.ok(!rows[0].snippet.includes('script'), 'snippet 去 HTML');
  assert.ok(rows[0].snippet.includes('内容') && rows[0].snippet.includes('尾部'));
  assert.match(rows[0].sourceId, /^src_[0-9a-f]{16}$/);
  // sourceId 只与规范化 URL 有关：不同 fragment 同 id，与查询词无关
  assert.equal(rows[0].sourceId, sourceIdFor('https://a.example.com/x'));
  assert.equal(sourceIdFor('https://a.example.com/x#zzz'), sourceIdFor('https://a.example.com/x'));
  assert.equal(normalizeUrl('https://A.example.com/x#frag'), 'https://a.example.com/x');
});

test('annotateResults：snippet 超长截断 + 零宽字符剥离', () => {
  const [row] = annotateResults([{ title: 't', url: 'https://e.com/1', snippet: `隐${String.fromCharCode(0x200b)}藏${'长'.repeat(600)}` }]);
  assert.ok(!row.snippet.includes(String.fromCharCode(0x200b)), '零宽剥离');
  assert.ok(row.snippet.length <= 501, 'snippet 500 字上限');
  const [tiny] = annotateResults([{ title: 't', url: 'https://e.com/2', snippet: 'x'.repeat(600) }], { maxSnippetChars: 10 });
  assert.equal(tiny.snippet.length, 11, '10 字 + 省略号');
});

test('searchCacheKey：purpose 参与 key（不同用途不共享缓存）', () => {
  const a = searchCacheKey({ purpose: 'fact_check', query: 'q', provider: 'deepseek', maxResults: 8 });
  const b = searchCacheKey({ purpose: 'draft_material', query: 'q', provider: 'deepseek', maxResults: 8 });
  assert.notEqual(a, b, 'purpose 不同 key 不同');
  assert.equal(a, searchCacheKey({ purpose: 'fact_check', query: 'q', provider: 'deepseek', maxResults: 8 }), '稳定');
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('wrapSearchResponse：trust=untrusted + 三明治 notice + cached/degraded 回传', () => {
  const r = wrapSearchResponse({
    queryId: 's_x', query: 'q', provider: 'bing', results: [{ sourceId: 'src_1', title: 't', url: 'u', snippet: 's', publishedAt: null }],
    cached: true, degraded: true, budget: { kind: 'search', used: 3, limit: 80 }
  });
  assert.equal(r.trust, 'untrusted');
  assert.equal(r.cached, true);
  assert.equal(r.degraded, true);
  assert.match(r.notice, /不可信/);
  assert.deepEqual(r.budget, { kind: 'search', used: 3, limit: 80 });
});

// ── fetch-page ──

test('detectCharset：content-type → meta → utf-8 三级判定', () => {
  assert.equal(detectCharset('text/html; charset=GBK', ''), 'gbk');
  assert.equal(detectCharset('text/html', '<meta charset="gb18030">'), 'gb18030');
  assert.equal(detectCharset('text/html', '<meta charset="big5">'), 'big5');
  assert.equal(detectCharset('text/html', '<html><p>无 meta</p>'), 'utf-8');
  assert.equal(detectCharset('text/html; charset=iso-8859-1', ''), 'utf-8', '不在支持列表的回 utf-8');
});

test('decodeBytes：GBK/Big5 正确解码；未知编码降级 utf-8 不抛错', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // GBK 的「中文」
  const dec = decodeBytes(gbk, 'gbk');
  assert.equal(dec.text, '中文');
  assert.equal(dec.charsetFallback, false);
  const utf8 = decodeBytes(Buffer.from('中文', 'utf8'), 'utf-8');
  assert.equal(utf8.text, '中文');
  const fallback = decodeBytes(gbk, 'x-nope-9');
  assert.equal(fallback.charsetFallback, true, '未知编码降级并标记');
});

test('extractMainText：去 script/style/nav/footer、相邻重复行去重、截断', () => {
  const html = `<html><head><title>T</title><style>.a{}</style><script>alert(1)</script></head>
<body><nav>导航</nav><p>第一段</p><p>第一段</p><div>第二段</div><footer>页脚</footer></body></html>`;
  const text = extractMainText(html, 1000);
  assert.ok(!text.includes('alert'), 'script 去除');
  assert.ok(!text.includes('导航'), 'nav 去除');
  assert.ok(!text.includes('页脚'), 'footer 去除');
  assert.ok(text.includes('第一段') && text.includes('第二段'));
  assert.equal(text.split('第一段').length - 1, 1, '相邻重复行只留一行');
  const truncated = extractMainText(`<p>${'字'.repeat(100)}</p>`, 30);
  assert.equal(truncated.length, 31, '30 字 + 省略号');
});

test('pageHash/contentHash：稳定 16 位十六进制', () => {
  assert.match(pageHash('正文'), /^[0-9a-f]{16}$/);
  assert.equal(pageHash('a'), pageHash('a'));
  assert.notEqual(pageHash('a'), pageHash('b'));
});

test('fetchPage：注入 fetcher —— 正文提取/title/contentHash、磁盘缓存命中、二进制 415、GBK 解码', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-page-'));
  let hits = 0;
  const fakeFetch = async (url) => {
    hits += 1;
    if (url.endsWith('/html')) return { url, statusCode: 200, contentType: 'text/html; charset=utf-8', buffer: Buffer.from('<html><head><title>页面标题</title></head><body><script>x()</script><p>正文段落</p></body></html>') };
    if (url.endsWith('/bin')) return { url, statusCode: 200, contentType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) };
    if (url.endsWith('/gbk')) return { url, statusCode: 200, contentType: 'text/plain; charset=gbk', buffer: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) };
    throw new Error('未知路径');
  };
  // HTML：正文提取 + title + contentHash + trust
  const page = await fetchPage('https://e.test/html', { cacheDir, fetchImpl: fakeFetch });
  assert.equal(page.ok, true);
  assert.equal(page.title, '页面标题');
  assert.ok(page.text.includes('正文段落'));
  assert.ok(!page.text.includes('x()'), 'script 不进正文');
  assert.equal(page.trust, 'untrusted');
  assert.match(page.contentHash, /^[0-9a-f]{16}$/);
  assert.equal(page.cached, false);
  assert.equal(hits, 1);
  // 磁盘缓存：第二次不再出网（fetcher 计数验证）
  const cached = await fetchPage('https://e.test/html', { cacheDir, fetchImpl: fakeFetch });
  assert.equal(cached.cached, true);
  assert.equal(cached.text, page.text);
  assert.equal(hits, 1, '缓存命中不出网');
  // 二进制 415
  await assert.rejects(() => fetchPage('https://e.test/bin', { cacheDir, fetchImpl: fakeFetch }),
    (e) => e.code === 'UNSUPPORTED_CONTENT_TYPE');
  // GBK 解码
  const gbk = await fetchPage('https://e.test/gbk', { cacheDir, fetchImpl: fakeFetch });
  assert.equal(gbk.text, '中文');
  assert.equal(gbk.charset, 'gbk');
});

test('fetchPage：12k 截断标记 + 缓存 TTL 过期即重新出网', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-page-'));
  let hits = 0;
  const fakeFetch = async (url) => {
    hits += 1;
    return { url, statusCode: 200, contentType: 'text/plain', buffer: Buffer.from('x'.repeat(20000)) };
  };
  const r = await fetchPage('https://e.test/big', { cacheDir, maxChars: 12000, fetchImpl: fakeFetch });
  assert.equal(r.truncated, true);
  assert.equal(r.chars, 12001, '12k + 省略号');
  assert.equal(hits, 1);
  await fetchPage('https://e.test/big', { cacheDir, maxChars: 12000, fetchImpl: fakeFetch });
  assert.equal(hits, 1, 'TTL 内缓存命中');
  await fetchPage('https://e.test/big', { cacheDir, maxChars: 12000, cacheTtlMs: 0, fetchImpl: fakeFetch });
  assert.equal(hits, 2, 'TTL 过期重新出网');
});

test('fetchPage：内容类型白名单齐全', () => {
  for (const t of ['text/html', 'text/plain', 'application/json', 'application/xml']) {
    assert.ok(CONTENT_TYPE_ALLOWLIST.includes(t), `${t} 应在白名单`);
  }
  assert.ok(!CONTENT_TYPE_ALLOWLIST.includes('application/octet-stream'));
  assert.ok(!CONTENT_TYPE_ALLOWLIST.includes('application/pdf'));
});

// ── draft-material（§6.6 空间素材预取）──

test('prefetchSearchMaterial：素材 sandwich 包裹 + 预算拒绝 + 失败不抛错不阻断', async () => {
  const { prefetchSearchMaterial, renderMaterialText } = await import('../src/surface/draft-material.js');
  // 正常路径：注入 searchFn（不触网）
  const fakeSearch = async (q, opts) => {
    assert.equal(opts.purpose, 'draft_material', 'purpose 必须是 draft_material');
    return { provider: 'deepseek', results: [{ title: '周末天气', url: 'https://e.test/1', snippet: '晴' }], fetchedAt: 't' };
  };
  const r = await prefetchSearchMaterial({ topic: '周末去哪玩', searchFn: fakeSearch });
  assert.equal(r.ok, true);
  assert.match(r.materialText, /^【外部资料 · 不可信】/, '素材顶部断言');
  assert.ok(r.materialText.includes('素材到此结束'), '底部断言');
  assert.ok(r.materialText.includes('周末天气'));
  assert.equal(r.results[0].sourceId.match(/^src_/).length, 1);
  // 预算拒绝：不出网（searchFn 传一个会抛错的，未被调用才是真没出网）
  let called = false;
  const budget = await prefetchSearchMaterial({
    topic: 'x',
    charge: () => ({ ok: false, reason: 'daily limit' }),
    searchFn: async () => { called = true; throw new Error('不应出网'); }
  });
  assert.equal(budget.ok, false);
  assert.equal(called, false, '预算拒绝时不出网');
  assert.match(budget.error, /预算/);
  // 搜索抛错：返回 ok:false 不上抛（失败不阻断起草）
  const fail = await prefetchSearchMaterial({ topic: 'x', searchFn: async () => { throw new Error('boom'); } });
  assert.equal(fail.ok, false);
  assert.equal(fail.materialText, '');
  assert.match(fail.error, /boom/);
  // 无话题：跳过
  assert.equal((await prefetchSearchMaterial({ topic: '  ', searchFn: fakeSearch })).ok, false);
  // renderMaterialText：条数与长度上限
  const text = renderMaterialText([
    { title: 'A', snippet: 'a', url: 'u1' }, { title: 'B', snippet: 'b', url: 'u2' }, { title: 'C', snippet: 'c', url: 'u3' }, { title: 'D', snippet: 'd', url: 'u4' }
  ], { maxItems: 3 });
  assert.ok(text.includes('1. A') && text.includes('3. C') && !text.includes('4. D'), 'maxItems 生效');
});
