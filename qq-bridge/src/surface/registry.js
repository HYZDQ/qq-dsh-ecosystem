// 表现面注册表（GEN3 表现面 S0，设计 §17.2.1）：只做能力声明，不做鉴权。
//   · 鉴权仍在各自入口（qzone 的 owner+confirm、日记的 assertOwnerPrivate、搜索的只读边界）；
//   · mode 语义对齐 MCP tool annotations：read≈readOnlyHint、write≈destructiveHint。
export const SURFACES = Object.freeze({
  web: {
    id: 'web',
    label: '联网搜索',
    mode: 'read',
    tools: ['web_search', 'web_fetch'],
    scopes: [] // 不读桥接记忆，只读网络
  },
  qzone: {
    id: 'qzone',
    label: 'QQ 空间',
    mode: 'write',
    tools: ['qzone_draft', 'qzone_publish', 'qzone_list', 'qzone_delete', 'qzone_status'],
    scopes: ['agent', 'owner'] // 只允许 agent 记忆 + 主人私聊
  },
  diary: {
    id: 'diary',
    label: '日记',
    mode: 'own',
    tools: ['diary_write', 'diary_read', 'diary_list', 'diary_search', 'diary_status',
      'diary_share_to_qzone', 'diary_digest', 'diary_digest_write'],
    scopes: ['agent', 'owner']
  }
});

/** 配置段名：registry id → socialV3.surface 下的段名（web 面沿用 webSearch 命名，见设计 §10.2）。 */
export function surfaceConfigSection(id) {
  return id === 'web' ? 'webSearch' : id;
}

/**
 * 表现面总开关：socialV3.enabled + modules.surface + 各面 enabled 三层齐全才开。
 * 任何一层缺失都按关处理（默认全关，关掉即回 V2）。
 */
export function surfaceEnabled(cfg, id) {
  const def = SURFACES[id];
  if (!def) return false;
  if (cfg?.socialV3?.enabled !== true) return false;
  if (cfg.socialV3.modules?.surface !== true) return false;
  return cfg.socialV3.surface?.[surfaceConfigSection(id)]?.enabled === true;
}

/** 工具名 → 表面 id（兼容 mcp__server__tool 全名与裸工具名）；未知工具返回 null。 */
export function surfaceForTool(toolName) {
  const bare = String(toolName ?? '').split('__').filter(Boolean).pop() ?? '';
  for (const def of Object.values(SURFACES)) {
    if (def.tools.includes(bare)) return def.id;
  }
  return null;
}
