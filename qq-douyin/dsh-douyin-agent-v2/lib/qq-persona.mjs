// lib/qq-persona.mjs —— 人格来源接入 QQ 私聊的人格与角色（2026-10-27 使用者要求）
// ============================================================================
// 设置页的「人格与兴趣」编辑器已删除；本插件的人格直接跟随 qq-bridge 的角色系统：
//   <QQ_BRIDGE>/state/current-role.json  →  split ? roles.private : (roles.private ?? role)
//   <QQ_BRIDGE>/roles/<名称>.md          →  人格卡正文
// 解析语义与 bridge/src/role-card.js 的 resolveRole 保持一致（私聊取卡）。
// 兴趣/观察仍由共享记忆单独记录（自动兴趣不受人格编辑影响）。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

/** qq-bridge 仓库根：env.QQ_BRIDGE_DIR 优先（默认本机布局）。 */
export function resolveQqBridgeRoot(env = process.env) {
  return env.QQ_BRIDGE_DIR || 'D:/github/qq-bridge';
}

/**
 * 解析 QQ 私聊当前人格卡。
 * @returns {{ name: string, text: string } | null} 没有角色/没启用扮演时返回 null。
 */
export function resolveQqPrivateCard({ env = process.env } = {}) {
  const root = resolveQqBridgeRoot(env);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(root, 'state', 'current-role.json'), 'utf8')); } catch { return null; }
  if (!state || typeof state !== 'object') return null;
  if (state.mode && state.mode !== 'active') return null; // 关闭角色扮演 = 不注入人格
  const slots = state.roles && typeof state.roles === 'object' ? state.roles : {};
  const name = String(state.split ? (slots.private ?? '') : (slots.private ?? state.role ?? '')).trim();
  if (!name) return null;
  let text = '';
  try { text = fs.readFileSync(path.join(root, 'roles', `${name}.md`), 'utf8'); } catch { return null; }
  return { name, text };
}
