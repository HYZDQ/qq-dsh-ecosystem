// llm.js：key 解析顺序、端点校验、响应提取、重试/超时/空响应（全部用注入的假 fetch）。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  ANTHROPIC_VERSION,
  resolveApiKey,
  buildEndpoint,
  extractText,
  errorDetail,
  callLlm,
  pingLlm
} from '../src/llm.js';
import {
  cleanupTempRoots,
  mkTempRoot,
  writeTextFile,
  makeFetchMock,
  jsonResponse,
  llmBody,
  FIXED_NOW
} from './helpers.js';

after(cleanupTempRoots);

function baseConfig(overrides = {}) {
  return {
    apiKey: 'test-key-0123456789abcdef',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://llm.invalid/v1',
    model: 'deepseek-v4-flash',
    maxRetries: 0,
    timeoutMs: 5000,
    maxTokens: 100,
    ...overrides
  };
}

const VALID_TEXT = JSON.stringify({ diary: '今天很好。', summary: '今天很好。' });

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

describe('resolveApiKey：config > env > dsh-credentials', () => {
  test('三级优先级与 none', () => {
    const dshHome = mkTempRoot();
    writeTextFile(path.join(dshHome, '.credentials.yaml'), 'refs:\n  MY_TEST_KEY: dsh-key-987654\n');

    const config = { apiKey: 'literal-key-1234', apiKeyEnv: 'MY_TEST_KEY' };
    assert.deepEqual(resolveApiKey({ config, env: { MY_TEST_KEY: 'env-key-1234' }, dshHome }), {
      key: 'literal-key-1234',
      source: 'config'
    });

    assert.deepEqual(resolveApiKey({ config: { apiKey: '', apiKeyEnv: 'MY_TEST_KEY' }, env: { MY_TEST_KEY: 'env-key-1234' }, dshHome }), {
      key: 'env-key-1234',
      source: 'env'
    });

    assert.deepEqual(resolveApiKey({ config: { apiKey: '', apiKeyEnv: 'MY_TEST_KEY' }, env: {}, dshHome }), {
      key: 'dsh-key-987654',
      source: 'dsh-credentials'
    });

    const emptyDsh = mkTempRoot();
    assert.deepEqual(resolveApiKey({ config: { apiKey: '', apiKeyEnv: 'MY_TEST_KEY' }, env: {}, dshHome: emptyDsh }), {
      key: '',
      source: 'none'
    });
  });

  test('apiKeyEnv 默认 DEEPSEEK_API_KEY；key 前后空白被 trim', () => {
    assert.deepEqual(resolveApiKey({ config: { apiKey: '' }, env: { DEEPSEEK_API_KEY: '  env-key  ' }, dshHome: mkTempRoot() }), {
      key: 'env-key',
      source: 'env'
    });
  });
});

describe('buildEndpoint', () => {
  test('https 与回环地址可用，拼接 /messages', () => {
    assert.equal(String(buildEndpoint('https://api.deepseek.com/anthropic/v1')), 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(String(buildEndpoint('https://api.deepseek.com/anthropic/v1/')), 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(String(buildEndpoint('http://127.0.0.1:3100')), 'http://127.0.0.1:3100/messages');
    assert.equal(String(buildEndpoint('http://localhost:3000')), 'http://localhost:3000/messages');
  });

  test('拒绝 http 公网地址 / 凭据 / 非法 URL', () => {
    assert.throws(() => buildEndpoint('http://api.example.com/v1'), /https/);
    assert.throws(() => buildEndpoint('ftp://api.example.com/v1'), /https/);
    assert.throws(() => buildEndpoint(''), /baseURL/);
    assert.throws(() => buildEndpoint('not a url'), /URL/);
    assert.throws(() => buildEndpoint('https://user:pass@api.example.com/v1'), /凭据/);
  });
});

describe('extractText / errorDetail', () => {
  test('拼接所有 text block，忽略非 text block', () => {
    assert.equal(
      extractText({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' }] }),
      'ab'
    );
    assert.equal(extractText({ content: [] }), '');
    assert.equal(extractText(null), '');
    assert.equal(extractText({ content: [{ type: 'text', text: '   ' }] }), '');
  });

  test('从错误体里取可读原因并截断', () => {
    assert.equal(errorDetail('{"error":{"message":"boom"}}'), 'boom');
    assert.equal(errorDetail('{"error":"plain"}'), 'plain');
    assert.equal(errorDetail('not json'), 'not json');
    assert.ok(errorDetail('x'.repeat(500)).length <= 200);
  });
});

describe('callLlm：成功路径', () => {
  test('标准响应 → ok:true，请求头/端点/body 正确，text 正确', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse(llmBody({ chars: 300 })));
    const config = baseConfig();
    const result = await callLlm({
      system: '系统提示',
      user: '用户提示',
      config,
      fetchImpl: fetchMock,
      retryDelays: [0],
      now: () => 1000
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'config');
    assert.equal(result.attempts, 1);
    assert.equal(result.durationMs, 0);
    assert.equal(typeof result.text, 'string');
    assert.ok(result.text.length > 0);
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.deepEqual(result.usage, { input_tokens: 321, output_tokens: 456 });

    assert.equal(fetchMock.calls.length, 1);
    const call = fetchMock.calls[0];
    assert.equal(call.url, 'https://llm.invalid/v1/messages');
    assert.equal(call.method, 'POST');
    assert.equal(call.options.headers['x-api-key'], config.apiKey);
    assert.equal(call.options.headers.authorization, `Bearer ${config.apiKey}`);
    assert.equal(call.options.headers['anthropic-version'], ANTHROPIC_VERSION);
    const body = JSON.parse(call.options.body);
    assert.equal(body.model, config.model);
    assert.equal(body.max_tokens, 100);
    assert.equal(body.system, '系统提示');
    assert.equal(body.messages[0].content[0].text, '用户提示');
    assert.ok(call.options.signal, '应传入 AbortSignal');
  });
});

describe('callLlm：失败/重试路径', () => {
  test('HTTP 500 → HTTP_ERROR，按 maxRetries 重试（2 → 共 3 次）', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse({ error: { message: 'server boom' } }, 500));
    const result = await callLlm({
      system: 's',
      user: 'u',
      config: baseConfig({ maxRetries: 2 }),
      fetchImpl: fetchMock,
      retryDelays: [0, 0]
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'HTTP_ERROR');
    assert.equal(result.error.status, 500);
    assert.match(result.error.message, /server boom/);
    assert.equal(result.attempts, 3);
    assert.equal(fetchMock.calls.length, 3);
  });

  test('HTTP 401 → 不重试（只调用 1 次）', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse({ error: { message: 'invalid key' } }, 401));
    const result = await callLlm({
      system: 's',
      user: 'u',
      config: baseConfig({ maxRetries: 2 }),
      fetchImpl: fetchMock,
      retryDelays: [0, 0]
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'HTTP_ERROR');
    assert.equal(result.error.status, 401);
    assert.equal(result.attempts, 1);
    assert.equal(fetchMock.calls.length, 1);
  });

  test('空内容 → EMPTY_RESPONSE，重试到上限', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse({ content: [{ type: 'text', text: '   ' }] }));
    const result = await callLlm({
      system: 's',
      user: 'u',
      config: baseConfig({ maxRetries: 1 }),
      fetchImpl: fetchMock,
      retryDelays: [0]
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EMPTY_RESPONSE');
    assert.equal(result.attempts, 2);
    assert.equal(fetchMock.calls.length, 2);
  });

  test('响应不是 JSON → BAD_BODY', async () => {
    const fetchMock = makeFetchMock(() => new Response('这不是 JSON', { status: 200 }));
    const result = await callLlm({ system: 's', user: 'u', config: baseConfig(), fetchImpl: fetchMock, retryDelays: [0] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'BAD_BODY');
    assert.equal(result.attempts, 1);
  });

  test('fetch 抛 AbortError → TIMEOUT（不重试时 attempts=1）', async () => {
    const fetchMock = makeFetchMock(() => {
      throw abortError();
    });
    const result = await callLlm({ system: 's', user: 'u', config: baseConfig(), fetchImpl: fetchMock, retryDelays: [0] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TIMEOUT');
    assert.equal(result.attempts, 1);
  });

  test('请求永不返回 + timeoutMs 到点 abort → TIMEOUT', async () => {
    const fetchMock = makeFetchMock(
      (record) =>
        new Promise((resolve, reject) => {
          const signal = record.options.signal;
          const onAbort = () => reject(abortError());
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })
    );
    const startedAt = Date.now();
    const result = await callLlm({
      system: 's',
      user: 'u',
      config: baseConfig({ timeoutMs: 1000 }),
      fetchImpl: fetchMock,
      retryDelays: [0]
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TIMEOUT');
    assert.ok(elapsed >= 800, `实际耗时 ${elapsed}ms，应等待超时 abort`);
    assert.equal(fetchMock.calls.length, 1);
  });

  test('网络错误 → NETWORK', async () => {
    const fetchMock = makeFetchMock(() => {
      const error = new Error('getaddrinfo ENOTFOUND llm.invalid');
      error.name = 'TypeError';
      throw error;
    });
    const result = await callLlm({ system: 's', user: 'u', config: baseConfig(), fetchImpl: fetchMock, retryDelays: [0] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NETWORK');
  });

  test('没有 key → NO_KEY（不调用 fetch）', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse(llmBody()));
    const result = await callLlm({
      system: 's',
      user: 'u',
      config: baseConfig({ apiKey: '', apiKeyEnv: 'QQDIARY_TEST_UNSET_KEY_XYZ' }),
      fetchImpl: fetchMock
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NO_KEY');
    assert.equal(result.attempts, 0);
    assert.equal(fetchMock.calls.length, 0);
  });

  test('baseURL 不安全 → BAD_BASE_URL（不调用 fetch）', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse(llmBody()));
    const result = await callLlm({
      system: 's',
      user: 'u',
      config: baseConfig({ baseURL: 'http://api.example.com/v1' }),
      fetchImpl: fetchMock
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'BAD_BASE_URL');
    assert.equal(fetchMock.calls.length, 0);
  });

  test('fetchImpl 不是函数 → NO_FETCH', async () => {
    const result = await callLlm({ system: 's', user: 'u', config: baseConfig(), fetchImpl: null });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NO_FETCH');
  });
});

describe('pingLlm', () => {
  test('成功时 ok:true，且强制 maxRetries=0 / maxTokens=64', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse(llmBody({ chars: 10, summary: 'ok' })));
    const result = await pingLlm({ config: baseConfig({ maxRetries: 2 }), fetchImpl: fetchMock });
    assert.equal(result.ok, true);
    assert.equal(fetchMock.calls.length, 1);
    const body = JSON.parse(fetchMock.calls[0].options.body);
    assert.equal(body.max_tokens, 64);
  });

  test('失败时 ok:false 且只尝试一次（ping 覆盖 maxRetries=0）', async () => {
    const fetchMock = makeFetchMock(() => jsonResponse({ error: { message: 'down' } }, 500));
    const result = await pingLlm({ config: baseConfig({ maxRetries: 2 }), fetchImpl: fetchMock, retryDelays: [0] });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1);
    assert.equal(fetchMock.calls.length, 1);
  });
});

describe('callLlm：时间注入', () => {
  test('durationMs 用注入的 now 计算', async () => {
    let clock = 5000;
    const result = await callLlm({
      system: 's',
      user: 'u',
      config: baseConfig(),
      fetchImpl: makeFetchMock(() => jsonResponse(llmBody())),
      retryDelays: [0],
      now: () => {
        const value = clock;
        clock += 250;
        return value;
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.durationMs, 250);
    void FIXED_NOW;
  });
});
