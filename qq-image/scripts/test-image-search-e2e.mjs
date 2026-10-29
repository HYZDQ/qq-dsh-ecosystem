// 网络图片检索「dry-run 端到端」验收脚本（唯一会联网的图片测试）。
//
// 它做三件事，且**绝不向 QQ 发送任何内容**：
//   1) 用 qq-bridge 的 audit-bridge-harness 起真实的 bridge main()（假 OneBot + 假 DSH，本地控制台随机端口）
//   2) 真实联网调用 /api/socialV2/image/search（Baidu/Bing provider，走 safe-fetch 的 SSRF 防护）
//   3) 对选中的候选调用 /api/socialV2/image/send 且 dryRun=true：真实下载原图、真实做
//      https/Content-Type/magic bytes/大小/像素/总大小校验，只回报"将会发什么"。
//
// 用法：
//   node scripts/test-image-search-e2e.mjs                 # 默认查询「猫」
//   node scripts/test-image-search-e2e.mjs "柴犬 表情包"   # 指定查询词
//   QQ_BRIDGE_TEST_NETWORK=0 node scripts/test-image-search-e2e.mjs   # 强制跳过（无网络环境）
//
// 退出码：0 = 成功或跳过；1 = 搜索/下载链路失败（含每个 provider 的失败原因）。
import http from 'node:http';
import { bridgeHarness } from '../../qq-bridge/scripts/audit-bridge-harness.mjs';

const networkDisabled = String(process.env.QQ_BRIDGE_TEST_NETWORK ?? '1') === '0';
const query = String(process.argv[2] ?? process.env.QQ_BRIDGE_IMAGE_QUERY ?? '猫').trim();

function log(...args) {
  console.log('[image-e2e]', ...args);
}

if (networkDisabled) {
  log('QQ_BRIDGE_TEST_NETWORK=0，已跳过联网 dry-run（离线测试见 test-image-search.mjs / test-image-endpoints.mjs）');
  process.exit(0);
}

function postJson(server, pathname, body, headers = {}) {
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    request.setTimeout(60000, () => request.destroy(new Error('request hung')));
    request.end(payload);
  });
}

const harness = await bridgeHarness({
  config: {
    imageSearch: {
      enabled: true,
      providers: ['baidu', 'bing'],
      maxCandidates: 8,
      previewBytes: 262144,
      cacheTtlMinutes: 10,
      dedupeWindowMinutes: 0
    }
  }
});
harness.setMode('reserved2');
const agentToken = harness.getSocialV2State('private:123').agentToken;
const server = harness.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const consoleHeaders = { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1' };

let exitCode = 0;
try {
  log(`真实联网检索：query="${query}"`);
  const startedAt = Date.now();
  const search = await postJson(server, '/api/socialV2/image/search', { query, count: 8 }, consoleHeaders);
  if (search.status !== 200 || search.body?.ok !== true) {
    console.error('[image-e2e] ❌ 检索失败：', JSON.stringify(search.body ?? {}, null, 2));
    exitCode = 1;
  } else {
    const { searchId, candidates = [], previews = [], providers = [], note } = search.body;
    log(`检索完成：searchId=${searchId} 耗时≈${Date.now() - startedAt}ms`);
    for (const provider of providers) {
      log(`  · provider ${provider.id}: ${provider.ok ? `ok（${provider.count} 条）` : `失败：${provider.error ?? '未知原因'}`}`);
    }
    log(`候选 ${candidates.length} 个，可预览缩略图 ${previews.length} 张`);
    console.table(candidates.map((c) => ({
      id: c.candidateId, preview: c.preview, size: `${c.width ?? '?'}×${c.height ?? '?'}`,
      bytes: c.bytes, source: c.source, title: String(c.title ?? '').slice(0, 28)
    })));
    if (note) log('note:', note);
    if (!candidates.length) {
      console.error('[image-e2e] ❌ 两个 provider 都没有返回可用候选');
      exitCode = 1;
    } else {
      // 真实下载 + 校验，但 dryRun：不调用 OneBot（harness 的 fetch 是假网关，这里也不会走它）。
      const picked = candidates.slice(0, 2).map((c) => c.candidateId);
      log(`dry-run 发送候选 ${picked.join(', ')}（真实下载原图并校验，不发送）`);
      const dry = await postJson(server, '/api/socialV2/image/send', {
        searchId, candidateIds: picked, token: agentToken, dryRun: true
      }, consoleHeaders);
      if (dry.status !== 200 || dry.body?.ok !== true) {
        console.error('[image-e2e] ❌ dry-run 失败：', JSON.stringify(dry.body ?? {}, null, 2));
        exitCode = 1;
      } else {
        log(`dry-run 通过：将发送 ${dry.body.wouldSend.length} 张，总字节 ${dry.body.totalBytes}`);
        console.table(dry.body.wouldSend.map((item) => ({
          id: item.candidateId, bytes: item.bytes, size: `${item.width}×${item.height}`,
          mime: item.mimeType, source: item.source
        })));
        if (dry.body.failed?.length) log('未通过校验的候选：', JSON.stringify(dry.body.failed));
        log('✅ 端到端（联网检索 + 下载校验 + dryRun）完成；没有向 QQ 发送任何内容');
      }
    }
  }
} catch (error) {
  console.error('[image-e2e] ❌ 异常：', error?.message ?? error);
  exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  await harness.close();
}
process.exitCode = exitCode;
