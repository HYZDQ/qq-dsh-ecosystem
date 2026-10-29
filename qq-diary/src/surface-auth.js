// surface-token 读取（GEN3_SURFACE_INTEGRATION_PLAN §17.1 H6）。
//
// H6 背景：日记进程此前读 state/console-token（发私信/发说说的全权凭据）——一个只写日记的
// 进程拿到了过大权限。拆分后：上下文读取与记忆回写用 state/surface-token（窄权限，
// 只能调 surface/context 与 memory/capture 两个端点）；通知保持现状走 console-token。
// 本模块只读凭据文件，不打印、不落日志。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 读 surface-token。
 * @param {string} qqBridgeDir 桥接项目根目录
 * @returns {{token: string|null, error: string|null}}
 */
export function readSurfaceToken(qqBridgeDir) {
  try {
    const file = path.join(String(qqBridgeDir ?? ''), 'state', 'surface-token');
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!token) return { token: null, error: 'state/surface-token 为空（桥接未初始化表现面凭据）' };
    return { token, error: null };
  } catch {
    return { token: null, error: '缺 state/surface-token（桥接未生成，需重启桥接）' };
  }
}

/** 构造 surface 端点请求头（不打印 token）。 */
export function surfaceHeaders(token) {
  return { 'x-surface-token': String(token), 'x-surface-call': 'diary', 'content-type': 'application/json' };
}
