// DeepSeek Anthropic 兼容 Messages 调用。
//
// 端点/鉴权头照 qq-bridge/src/web-search.js 的已验证实现：
//   POST {baseURL}/messages
//   x-api-key + authorization: Bearer + anthropic-version: 2023-06-01
// key 解析顺序：config.apiKey → env[apiKeyEnv] → $DSH_HOME/.credentials.yaml refs.<apiKeyEnv>
//
// 安全：key 只进请求头；错误信息与日志里绝不出现 key；baseURL 必须是 https 或本机回环。
import { readDshCredential } from './config.js';

export const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_DETAIL = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 解析 key；返回 { key, source }（key 只在调用链里传递，不落日志）。 */
export function resolveApiKey({ config, env = process.env, dshHome } = {}) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || 'DEEPSEEK_API_KEY').trim();
  const fromEnv = String(env?.[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = dshHome ? readDshCredential(envName, { dshHome }) : readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/** 拼 /messages 端点；非 https 且非回环 → 拒绝（key 不能明文发到公网）。 */
export function buildEndpoint(baseURL) {
  const raw = String(baseURL ?? '').trim();
  if (!raw) throw new Error('baseURL 未配置');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('baseURL 不是合法 URL');
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('baseURL 必须是 https（或本机回环地址），拒绝把 API key 发给明文端点');
  }
  if (url.username || url.password) throw new Error('baseURL 不能包含凭据');
  return new URL(`${url.toString().replace(/\/+$/, '')}/messages`);
}

/** Anthropic 响应 → 纯文本（拼接所有 text block）。 */
export function extractText(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => String(block?.text ?? ''))
    .join('')
    .trim();
}

async function safeText(response) {
  try {
    const text = await response.text();
    return String(text ?? '').slice(0, MAX_RESPONSE_BYTES);
  } catch {
    return '';
  }
}

/** 从错误响应体里取一句可读原因（截断、不含请求头）。 */
export function errorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    const message = typeof parsed?.error === 'string' ? parsed.error : (parsed?.error?.message ?? parsed?.message);
    if (typeof message === 'string') return message.slice(0, MAX_ERROR_DETAIL);
  } catch {
    // 非 JSON 就原样截断
  }
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DETAIL);
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * 调一次模型（内部按 maxRetries 重试超时/网络/429/5xx/空响应）。
 * 永远 resolve：失败返回 { ok:false, error:{ code, message } }，不抛异常。
 */
export async function callLlm({
  system = '',
  user = '',
  config,
  fetchImpl = globalThis.fetch,
  logger = null,
  maxTokens = null,
  retryDelays = [2000, 5000],
  now = () => Date.now()
}) {
  const startedAt = now();
  const { key, source } = resolveApiKey({ config });
  if (!key) {
    return {
      ok: false,
      source,
      attempts: 0,
      durationMs: 0,
      error: { code: 'NO_KEY', message: '没有可用的 DeepSeek API key（env / ~/.dsh/.credentials.yaml / config.apiKey 都未命中）' }
    };
  }
  let endpoint;
  try {
    endpoint = buildEndpoint(config.baseURL);
  } catch (error) {
    return { ok: false, source, attempts: 0, durationMs: 0, error: { code: 'BAD_BASE_URL', message: String(error?.message ?? error) } };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, source, attempts: 0, durationMs: 0, error: { code: 'NO_FETCH', message: '当前运行环境没有可用的 fetch' } };
  }

  const maxAttempts = Math.max(1, (Number(config.maxRetries) || 0) + 1);
  const timeoutMs = Math.max(1000, Number(config.timeoutMs) || 120000);
  const body = JSON.stringify({
    model: config.model,
    max_tokens: maxTokens ?? config.maxTokens ?? 1600,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }]
  });
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    authorization: `Bearer ${key}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'user-agent': 'qq-diary/0.1.0'
  };

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers, body, signal: controller.signal });
      const status = Number(response?.status) || 0;
      if (!response?.ok) {
        const detail = errorDetail(await safeText(response));
        lastError = { code: 'HTTP_ERROR', status, message: `DeepSeek Messages HTTP ${status}${detail ? `：${detail}` : ''}` };
        if (isRetryableStatus(status) && attempt < maxAttempts) {
          logger?.warn?.(`[llm] 第 ${attempt}/${maxAttempts} 次失败（HTTP ${status}），重试中`);
          await sleep(retryDelays[attempt - 1] ?? 5000);
          continue;
        }
        return { ok: false, source, attempts: attempt, durationMs: now() - startedAt, error: lastError };
      }
      const text = await safeText(response);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastError = { code: 'BAD_BODY', message: '模型返回了无法解析的 JSON 响应' };
        if (attempt < maxAttempts) {
          logger?.warn?.(`[llm] 第 ${attempt}/${maxAttempts} 次响应无法解析，重试中`);
          await sleep(retryDelays[attempt - 1] ?? 5000);
          continue;
        }
        return { ok: false, source, attempts: attempt, durationMs: now() - startedAt, error: lastError };
      }
      const content = extractText(parsed);
      if (!content) {
        lastError = { code: 'EMPTY_RESPONSE', message: '模型返回了空内容' };
        if (attempt < maxAttempts) {
          logger?.warn?.(`[llm] 第 ${attempt}/${maxAttempts} 次返回空内容，重试中`);
          await sleep(retryDelays[attempt - 1] ?? 5000);
          continue;
        }
        return { ok: false, source, attempts: attempt, durationMs: now() - startedAt, error: lastError };
      }
      return {
        ok: true,
        source,
        text: content,
        usage: parsed?.usage ?? null,
        model: parsed?.model ?? config.model,
        attempts: attempt,
        durationMs: now() - startedAt
      };
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      lastError = aborted
        ? { code: 'TIMEOUT', message: `请求超时（${Math.round(timeoutMs / 1000)}s）` }
        : { code: 'NETWORK', message: `网络错误：${error?.name ?? 'Error'} ${error?.message ?? error}` };
      if (attempt < maxAttempts) {
        logger?.warn?.(`[llm] 第 ${attempt}/${maxAttempts} 次失败（${lastError.code}），重试中`);
        await sleep(retryDelays[attempt - 1] ?? 5000);
        continue;
      }
      return { ok: false, source, attempts: attempt, durationMs: now() - startedAt, error: lastError };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, source, attempts: maxAttempts, durationMs: now() - startedAt, error: lastError ?? { code: 'UNKNOWN', message: '未知失败' } };
}

/** --check 用的极小活体探测：只验证端点/key/权限，不产生日记。 */
export async function pingLlm({ config, fetchImpl = globalThis.fetch, retryDelays = [1000] }) {
  // max_tokens 不能太小：deepseek-v4-flash 是推理模型，输出里会先有一个 thinking 块，
  // 16 token 会被 thinking 吃光导致 text 为空（实测 stop_reason=max_tokens、content 只有 thinking）。
  const pingConfig = { ...config, maxRetries: 0, maxTokens: 64 };
  return callLlm({
    system: '你是一个联通性探测助手。',
    user: '只回复两个字符：OK',
    config: pingConfig,
    fetchImpl,
    maxTokens: 64,
    retryDelays
  });
}
