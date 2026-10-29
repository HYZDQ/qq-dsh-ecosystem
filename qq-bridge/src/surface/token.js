// surface-token：表现面专用凭据（GEN3 表现面 S0，设计 §17.1 H6）。
//
// 背景（H6）：qq-diary 为了发摘要读了 state/console-token —— 一个只写日记的进程拿到了
// 发私信/发说说的全权凭据。修复：拆出独立 surface-token，**只能**调表现面只读上下文与
// 记忆回写两个端点（外加 surface/status 只读视图），qzone/*、/api/send/* 一概拒绝。
//
// 形态（对齐 console-token 的既有惯例）：
//   · state/surface-token     —— 当前令牌，32 字节随机 hex，0600（Windows 由 state/ ACL 收口）；
//   · state/surface-token.prev—— 轮换后的旧令牌，**仅 24 小时内**仍可校验通过（按文件 mtime 判定），
//     过期后自然失效，避免日记进程在轮换窗口里重启失败；
//   · 两个文件都是纯文本单行（与 console-token 一致，便于 qq-diary 直接读）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** surface-token 允许调用的端点（方法 + 路径）。不在名单内的一律 SURFACE_TOKEN_FORBIDDEN。 */
export const SURFACE_TOKEN_ROUTES = Object.freeze([
  { method: 'GET', path: '/api/socialV3/surface/context' },
  { method: 'POST', path: '/api/socialV3/memory/capture' },
  { method: 'GET', path: '/api/socialV3/surface/status' }
]);

/** 旧令牌兼容窗口：轮换后 24 小时。 */
export const SURFACE_TOKEN_PREV_TTL_MS = 24 * 3600 * 1000;

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function atomicWriteToken(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readTokenFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * surface-token 管理器：启动生成/校验/轮换。
 * @param {object} opts
 * @param {string} opts.stateDir  state 目录（token 落 state/surface-token）
 * @param {() => number} [opts.now]
 */
export function createSurfaceTokenManager({ stateDir, now = () => Date.now() } = {}) {
  if (!stateDir) throw new Error('createSurfaceTokenManager 需要 stateDir');
  const currentFile = path.join(stateDir, 'surface-token');
  const prevFile = path.join(stateDir, 'surface-token.prev');

  // 启动：缺失则生成（与 console-token 同策略：绝不默认无鉴权）。
  let current = readTokenFile(currentFile);
  if (!current) {
    current = crypto.randomBytes(32).toString('hex');
    atomicWriteToken(currentFile, current);
  }

  function prevUsable() {
    const token = readTokenFile(prevFile);
    if (!token) return null;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(prevFile).mtimeMs; } catch { return null; }
    if (now() - mtimeMs > SURFACE_TOKEN_PREV_TTL_MS) return null; // 超 24h 旧令牌失效
    return token;
  }

  return {
    /** 当前令牌（日志只打前 6 位；调用方如需明文只写给 qq-diary 的 token 文件）。 */
    get token() { return current; },
    redacted() { return `${String(current).slice(0, 6)}…`; },

    /**
     * 校验请求携带的 surface token：命中当前令牌或 24h 内的旧令牌。
     * 定长比较，防本机进程时延试探。
     */
    validate(supplied) {
      const s = String(supplied ?? '').trim();
      if (!s) return false;
      if (timingSafeEqual(s, current)) return true;
      const prev = prevUsable();
      return prev ? timingSafeEqual(s, prev) : false;
    },

    /**
     * 轮换：当前令牌降级为 prev（24h 兼容），签发新令牌。
     * 返回 { ok, token, prevExpiresAt }；写盘失败原样抛出（调用方回错误码）。
     */
    rotate() {
      const prev = current;
      atomicWriteToken(prevFile, prev); // mtime 即 prev 有效期起点
      current = crypto.randomBytes(32).toString('hex');
      atomicWriteToken(currentFile, current);
      return {
        ok: true,
        token: current,
        prevExpiresAt: new Date(now() + SURFACE_TOKEN_PREV_TTL_MS).toISOString()
      };
    },

    /** 是否允许该（方法, 路径）用 surface token 访问。 */
    allows(method, pathname) {
      return SURFACE_TOKEN_ROUTES.some((r) => r.method === String(method).toUpperCase() && r.path === pathname);
    }
  };
}
