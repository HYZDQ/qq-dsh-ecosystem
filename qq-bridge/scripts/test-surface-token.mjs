// GEN3 表现面 S0 单测：surface-token 凭据（§17.1 H6）——生成、窄权限白名单、
// 轮换 24h 兼容窗口、qzone/send 一概拒绝、不能轮换自身。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SURFACE_TOKEN_ROUTES,
  SURFACE_TOKEN_PREV_TTL_MS,
  createSurfaceTokenManager
} from '../src/surface/token.js';

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'surface-token-'));
}

test('启动生成：缺失时创建 32 字节 hex 令牌并持久化，0600 语义（单行文本）', () => {
  const stateDir = tmpState();
  const mgr = createSurfaceTokenManager({ stateDir });
  assert.match(mgr.token, /^[0-9a-f]{64}$/, '32 字节随机 hex');
  const file = path.join(stateDir, 'surface-token');
  assert.equal(fs.readFileSync(file, 'utf8'), mgr.token, '持久化为纯文本（qq-diary 直读）');
  // 幂等：再启动读回同一令牌
  const again = createSurfaceTokenManager({ stateDir });
  assert.equal(again.token, mgr.token, '重启不换令牌');
});

test('窄权限：只放行 3 个白名单端点，qzone/* 与 /api/send/* 一概拒绝（H6）', () => {
  const mgr = createSurfaceTokenManager({ stateDir: tmpState() });
  assert.equal(mgr.allows('GET', '/api/socialV3/surface/status'), true);
  assert.equal(mgr.allows('GET', '/api/socialV3/surface/context'), true);
  assert.equal(mgr.allows('POST', '/api/socialV3/memory/capture'), true);
  // H6 明确拒绝的两类
  assert.equal(mgr.allows('POST', '/api/socialV2/qzone/publish'), false);
  assert.equal(mgr.allows('POST', '/api/socialV2/qzone/draft'), false);
  assert.equal(mgr.allows('POST', '/api/send/private'), false);
  assert.equal(mgr.allows('POST', '/api/send/group'), false);
  // 管理面同样不放行（窄凭据不能给自己提权）
  assert.equal(mgr.allows('POST', '/api/socialV3/surface/token-rotate'), false);
  assert.equal(mgr.allows('POST', '/api/mode'), false);
  assert.equal(mgr.allows('GET', '/api/status'), false);
  // 方法也要对：白名单端点的错误方法拒绝
  assert.equal(mgr.allows('POST', '/api/socialV3/surface/status'), false);
  assert.equal(mgr.allows('GET', '/api/socialV3/memory/capture'), false);
  assert.equal(SURFACE_TOKEN_ROUTES.length, 3, '白名单恰好 3 个端点');
});

test('validate：正确令牌通过，错误/空/非字符串拒绝', () => {
  const mgr = createSurfaceTokenManager({ stateDir: tmpState() });
  assert.equal(mgr.validate(mgr.token), true);
  assert.equal(mgr.validate(` ${mgr.token} `), true, '容忍两侧空白');
  assert.equal(mgr.validate('deadbeef'.repeat(8)), false, '同长度错误令牌');
  assert.equal(mgr.validate('short'), false);
  assert.equal(mgr.validate(''), false);
  assert.equal(mgr.validate(null), false);
});

test('轮换：旧令牌进 prev 文件并在 24h 兼容窗口内可用，新令牌立即生效', () => {
  const stateDir = tmpState();
  let now = Date.parse('2026-10-26T10:00:00Z');
  const mgr = createSurfaceTokenManager({ stateDir, now: () => now });
  const oldToken = mgr.token;
  const result = mgr.rotate();
  assert.equal(result.ok, true);
  assert.notEqual(result.token, oldToken, '签发新令牌');
  assert.equal(mgr.validate(result.token), true, '新令牌立即可用');
  assert.equal(mgr.validate(oldToken), true, '旧令牌 24h 内仍可用（日记重启窗口）');
  assert.equal(fs.readFileSync(path.join(stateDir, 'surface-token.prev'), 'utf8'), oldToken);
  assert.equal(result.prevExpiresAt, new Date(now + SURFACE_TOKEN_PREV_TTL_MS).toISOString());
  // 窗口过了：旧令牌失效、新令牌不受影响
  now += SURFACE_TOKEN_PREV_TTL_MS + 1000;
  assert.equal(mgr.validate(oldToken), false, '超 24h 旧令牌失效');
  assert.equal(mgr.validate(result.token), true);
});

test('轮换两次：只有最近一次的旧令牌在窗口内', () => {
  const stateDir = tmpState();
  const mgr = createSurfaceTokenManager({ stateDir, now: () => Date.parse('2026-10-26T10:00:00Z') });
  const t0 = mgr.token;
  const t1 = mgr.rotate().token;
  const t2 = mgr.rotate().token;
  assert.equal(mgr.validate(t2), true);
  assert.equal(mgr.validate(t1), true, '上一次的旧令牌仍在窗口内');
  assert.equal(mgr.validate(t0), false, '更早的令牌已被覆盖失效');
});

test('redacted：日志只露前 6 位', () => {
  const mgr = createSurfaceTokenManager({ stateDir: tmpState() });
  assert.match(mgr.redacted(), /^[0-9a-f]{6}…$/);
  assert.ok(!mgr.redacted().includes(mgr.token.slice(6)));
});
