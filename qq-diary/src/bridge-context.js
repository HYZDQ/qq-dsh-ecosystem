// 桥接只读上下文（GEN3_SURFACE_INTEGRATION_PLAN §8.3/S3）：
// 调桥接 GET /api/socialV3/surface/context 拿 V3 上下文（记忆/情绪/主人私聊素材），
// 失败/超时**自动回退**旧文件读取（state/social-v2.json 等），绝不让日记生成空转。
//
// 安全：走 surface-token（H6 窄凭据）；15s 超时；只读，不写任何桥接文件。
import { readSurfaceToken, surfaceHeaders } from './surface-auth.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 拉取桥接 V3 上下文。
 * @param {object} [opts.window] {start,end,kind}——qq-diary windowForDate 算好的时间窗，
 *   原样传给桥接再原样回传（§17.5 第 3 条：今天=滚动 24h、过去日期=整日窗口，语义不改写）
 * @returns {{ok:boolean, context:object|null, error:string|null, source:'v3'|'fallback'}}
 */
export async function fetchBridgeContext({
  qqBridgeDir,
  consoleUrl = 'http://127.0.0.1:3100',
  date,
  window: windowParam = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch
} = {}) {
  const { token, error: tokenError } = readSurfaceToken(qqBridgeDir);
  if (!token) return { ok: false, context: null, error: tokenError, source: 'fallback' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('/api/socialV3/surface/context', consoleUrl);
    url.searchParams.set('surface', 'diary');
    if (date) url.searchParams.set('date', String(date));
    if (windowParam && typeof windowParam === 'object') {
      if (windowParam.start) url.searchParams.set('windowStart', String(windowParam.start));
      if (windowParam.end) url.searchParams.set('windowEnd', String(windowParam.end));
      if (windowParam.kind) url.searchParams.set('windowKind', String(windowParam.kind));
    }
    const res = await fetchImpl(url, { headers: surfaceHeaders(token), signal: controller.signal });
    if (!res.ok) {
      return { ok: false, context: null, error: `桥接上下文 HTTP ${res.status}`, source: 'fallback' };
    }
    const body = await res.json();
    if (!body?.ok) {
      return { ok: false, context: null, error: body?.error || '桥接上下文不可用', source: 'fallback' };
    }
    return { ok: true, context: body, error: null, source: 'v3' };
  } catch (error) {
    return { ok: false, context: null, error: `桥接上下文获取失败：${error?.message ?? error}`, source: 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}
