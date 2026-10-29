// 表现面 S3：记忆回写（§8.4 幂等/敏感拦截/队列重试）+ 桥接上下文（§8.3 失败回退）。
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { captureDiaryMemory, flushMemoryQueue } from '../src/memory-writeback.js';
import { fetchBridgeContext } from '../src/bridge-context.js';
import { readSurfaceToken } from '../src/surface-auth.js';
import { cleanupTempRoots, jsonResponse, makeFetchMock, mkTempRoot } from './helpers.js';

after(cleanupTempRoots);

function setupToken(root) {
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'surface-token'), 'test-surface-token-000', 'utf8');
  return stateDir;
}

describe('memory-writeback：幂等 / 敏感拦截 / 队列重试', () => {
  test('成功回写：POST memory/capture 带 dedupeKey=diary:<date>，surface-token 鉴权', async () => {
    const root = mkTempRoot();
    const stateDir = setupToken(root);
    const fetchMock = makeFetchMock(() => jsonResponse({ ok: true, created: true, id: 'mem_x' }));
    const result = await captureDiaryMemory({
      qqBridgeDir: root, stateDir, date: '2026-10-26', summary: '今天写了日记', fetchImpl: fetchMock
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(fetchMock.calls.length, 1);
    const call = fetchMock.calls[0];
    assert.ok(String(call.url).includes('/api/socialV3/memory/capture'));
    assert.equal(call.options.headers['x-surface-token'], 'test-surface-token-000', '走 surface-token 不是 console-token');
    const body = JSON.parse(call.options.body);
    assert.equal(body.dedupeKey, 'diary:2026-10-26');
    assert.equal(body.scope, 'agent');
    assert.equal(body.trust, 'observed');
  });

  test('duplicate＝幂等命中按成功；敏感事实拒绝不入队', async () => {
    const root = mkTempRoot();
    const stateDir = setupToken(root);
    const dup = await captureDiaryMemory({
      qqBridgeDir: root, stateDir, date: '2026-10-26', summary: 'x'.repeat(50),
      fetchImpl: makeFetchMock(() => jsonResponse({ ok: true, created: false, reason: 'duplicate', code: 'MEMORY_CAPTURE_DUPLICATE' }))
    });
    assert.equal(dup.ok, true);
    assert.equal(dup.created, false);
    // 敏感事实（联系方式/健康/财务）直接拒绝，不出网不入队
    let called = 0;
    for (const summary of ['我的手机号是 13800138000', '今天住院了', '发工资了']) {
      const r = await captureDiaryMemory({
        qqBridgeDir: root, stateDir, date: '2026-10-26', summary,
        fetchImpl: makeFetchMock(() => { called += 1; return jsonResponse({ ok: true }); })
      });
      assert.equal(r.ok, false, summary);
      assert.equal(r.code, 'MEMORY_CAPTURE_REJECTED');
    }
    assert.equal(called, 0, '敏感摘要不出网');
  });

  test('失败入队 + flush 重试最多 3 次后放弃；成功后出队', async () => {
    const root = mkTempRoot();
    const stateDir = setupToken(root);
    let fail = true;
    const fetchMock = makeFetchMock(() => (fail
      ? jsonResponse({ ok: false, error: 'boom' }, 500)
      : jsonResponse({ ok: true, created: true, id: 'mem_y' })));
    const r1 = await captureDiaryMemory({ qqBridgeDir: root, stateDir, date: '2026-10-25', summary: '昨天的日记摘要', fetchImpl: fetchMock });
    assert.equal(r1.ok, false);
    assert.equal(r1.queued, true);
    const queueFile = path.join(stateDir, 'memory-queue.json');
    assert.ok(fs.existsSync(queueFile), '失败入队');
    // flush 仍失败：重试计数递增
    fail = true;
    await flushMemoryQueue({ qqBridgeDir: root, stateDir, fetchImpl: fetchMock });
    let queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(queue[0].retries, 1);
    // 恢复后 flush 成功 → 出队
    fail = false;
    await flushMemoryQueue({ qqBridgeDir: root, stateDir, fetchImpl: fetchMock });
    queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    assert.equal(queue.length, 0, '成功后出队');
  });

  test('缺 surface-token：入队并报 MISSING_SURFACE_TOKEN', async () => {
    const root = mkTempRoot();
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const r = await captureDiaryMemory({ qqBridgeDir: root, stateDir, date: '2026-10-26', summary: '摘要内容', fetchImpl: makeFetchMock() });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MISSING_SURFACE_TOKEN');
    assert.equal(r.queued, true);
  });
});

describe('bridge-context：V3 上下文 + 失败回退', () => {
  test('成功拿 V3 上下文；HTTP 失败/超时 → source=fallback', async () => {
    const root = mkTempRoot();
    setupToken(root);
    const ok = await fetchBridgeContext({
      qqBridgeDir: root, date: '2026-10-26',
      fetchImpl: makeFetchMock(() => jsonResponse({ ok: true, schemaVersion: 1, memory: [], recent: [], diary: { date: '2026-10-26' } }))
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.source, 'v3');
    // HTTP 500 → 回退
    const fail = await fetchBridgeContext({
      qqBridgeDir: root,
      fetchImpl: makeFetchMock(() => jsonResponse({ ok: false, error: 'x' }, 500))
    });
    assert.equal(fail.ok, false);
    assert.equal(fail.source, 'fallback');
    // 网络异常 → 回退
    const boom = await fetchBridgeContext({
      qqBridgeDir: root,
      fetchImpl: makeFetchMock(() => { throw new Error('ECONNREFUSED'); })
    });
    assert.equal(boom.ok, false);
    assert.equal(boom.source, 'fallback');
  });

  test('缺 surface-token → 直接 fallback 不出网', async () => {
    const root = mkTempRoot();
    let called = 0;
    const r = await fetchBridgeContext({
      qqBridgeDir: root,
      fetchImpl: makeFetchMock(() => { called += 1; return jsonResponse({ ok: true }); })
    });
    assert.equal(r.ok, false);
    assert.equal(r.source, 'fallback');
    assert.equal(called, 0);
  });

  test('readSurfaceToken：读 state/surface-token，缺失报错不抛', () => {
    const root = mkTempRoot();
    const missing = readSurfaceToken(root);
    assert.equal(missing.token, null);
    assert.ok(missing.error.includes('surface-token'));
    setupToken(root);
    const ok = readSurfaceToken(root);
    assert.equal(ok.token, 'test-surface-token-000');
  });
});
