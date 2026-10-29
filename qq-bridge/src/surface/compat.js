// 表现面兼容层（GEN3 表现面 S0）：schema 版本、上下文断言、配置读取。
// 设计：docs/design/GEN3_SURFACE_INTEGRATION_PLAN.md §5.1 / §17.2.4。
//   · 桥接升级、日记还在读旧字段时，靠 schemaVersion 断言显式失败并回退，避免静默生成空内容；
//   · 配置未知字段只告警不抛错（控制台/手写 config 常有多余键）。
import { normalizeSocialV3 } from '../simulation/config.js';

export const SURFACE_SCHEMA_VERSION = 1;

/** 稳定错误码：调用方按 code 分支，message 只给人看。 */
export class SurfaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SurfaceError';
    this.code = code;
  }
}

const VALID_SURFACES = new Set(['web', 'qzone', 'diary']);

/**
 * SurfaceContext 结构断言：缺字段/版本不符直接抛 SURFACE_CONTEXT_INVALID，
 * 避免下游（空间起草、日记生成）拿到半成品上下文后静默产出错误内容。
 */
export function assertSurfaceContext(ctx) {
  const fail = (msg) => { throw new SurfaceError('SURFACE_CONTEXT_INVALID', `SurfaceContext 非法：${msg}`); };
  if (!ctx || typeof ctx !== 'object') fail('不是对象');
  if (ctx.schemaVersion !== SURFACE_SCHEMA_VERSION) fail(`schemaVersion=${ctx.schemaVersion}，期望 ${SURFACE_SCHEMA_VERSION}`);
  if (!VALID_SURFACES.has(ctx.surface)) fail(`surface=${ctx.surface}`);
  if (!ctx.builtAt || typeof ctx.builtAt !== 'string') fail('缺 builtAt');
  if (!ctx.limits || typeof ctx.limits !== 'object') fail('缺 limits');
  for (const name of ['chars', 'memoryChars', 'recentChars', 'memoryMax']) {
    if (!Number.isFinite(ctx.limits[name])) fail(`limits.${name} 非数字`);
  }
  if (!Array.isArray(ctx.memory)) fail('memory 不是数组');
  for (const item of ctx.memory) {
    if (!item || typeof item !== 'object') fail('memory 元素不是对象');
    if (typeof item.trust !== 'string' || !item.trust) fail('memory 元素缺 trust');
  }
  if (!Array.isArray(ctx.recent)) fail('recent 不是数组');
  for (const item of ctx.recent) {
    if (!item || typeof item !== 'object') fail('recent 元素不是对象');
    if (typeof item.trust !== 'string' || !item.trust) fail('recent 元素缺 trust');
  }
  return ctx;
}

/**
 * 读取 socialV3.surface 配置：未知字段收进 warnings（不静默吞、不抛错）。
 * 返回值始终是 schema 归一化后的完整 surface 段（缺省补默认）。
 */
export function readSurfaceConfig(cfg) {
  const input = cfg && typeof cfg === 'object' && cfg.socialV3 ? cfg.socialV3 : {};
  const { value, unknown } = normalizeSocialV3(input);
  const warnings = unknown.filter((p) => p.startsWith('surface.') || p === 'surface');
  return { config: value.surface, warnings };
}
