// 三代仿真记忆层 · V2 → V3 长期记忆沉淀（GEN3 1.3）。
//
// 为什么要自动沉淀：V3 的新工具契约会牵动 preset / MCP 描述 / 控制台共 7 处，
// 风险远大于收益。所以 1.3 只做「桥接侧沉淀」——模型仍用原来的 qq_memory_append，
// 桥接在落 V2 会话记忆的同时，把**可长期成立**的那部分提升成 V3 记忆条目：
//
//   memberImpression → kind=relationship（群友/私聊对象的关系档案，带 aliases 的 u:<uid> 键才收）
//   activeTopic      → kind=episode（24h 内有效的情景记忆，过期由巩固归档）
//   pendingThought   → 不沉淀（那是它自己的念头，不是事实）
//
// 群来源的信任封顶 candidate、私聊来源 observed，owner-confirmed 只能由主人显式确认后由别处写入。

import { defaultTrustFor } from './memory.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOPIC_TTL_MS = DAY_MS;

function norm(value) {
  return String(value ?? '').trim();
}

/** 从会话 key 解析归属：group:<gid> / private:<uid>。 */
export function parseSessionKey(key) {
  const raw = norm(key);
  const idx = raw.indexOf(':');
  if (idx <= 0) return { kind: 'unknown', id: raw };
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (kind === 'group' && id) return { kind: 'group', id };
  if (kind === 'private' && id) return { kind: 'private', id };
  return { kind: 'unknown', id: raw };
}

/** 该条 V2 记忆对应的来源消息 id：优先真实 messageId，回落可审计的合成 id。 */
export function sourceIdsFor(st, { userId, fallback }) {
  const msgs = [
    ...(Array.isArray(st?.recentMessages) ? st.recentMessages : []),
    ...(Array.isArray(st?.unread) ? st.unread : []),
  ];
  const ids = [];
  for (const msg of msgs) {
    if (!msg || msg.isSelf) continue;
    if (userId && String(msg.userId ?? '') !== String(userId)) continue;
    const id = norm(msg.messageId ?? msg.id ?? msg.seq ?? '');
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (ids.length) return ids.slice(-3);
  return fallback ? [fallback] : [];
}

/**
 * V2 记忆 → V3 候选条目。
 * @returns {{ action: 'skip', reason: string } | { action: 'promote', candidate: object, cluster: string }}
 */
export function buildPromotion({ key, category, content, extra = {}, st = null, ownerUserId = null, now = Date.now() } = {}) {
  const text = norm(content);
  const where = parseSessionKey(key);
  if (!text) return { action: 'skip', reason: 'empty-text' };
  if (where.kind === 'unknown') return { action: 'skip', reason: 'unknown-session-kind' };
  if (where.kind === 'private' && ownerUserId && where.id === String(ownerUserId)) {
    // 主人的私聊档案由 owner 显式写入，不参与自动沉淀（防止「我说了什么」被当事实长期记住）
    return { action: 'skip', reason: 'owner-private' };
  }

  if (category === 'pendingThought') return { action: 'skip', reason: 'internal-thought' };

  if (category === 'activeTopic') {
    const lastMentionAt = Number(extra.lastMentionAt) || now;
    const expiresAt = new Date(Math.max(now, lastMentionAt) + TOPIC_TTL_MS).toISOString();
    const sourceType = where.kind === 'group' ? 'group' : 'private';
    const candidate = {
      kind: 'episode',
      scope: where.kind === 'group' ? 'group' : 'session',
      groupId: where.kind === 'group' ? where.id : null,
      sessionId: norm(key),
      text: text.slice(0, 200),
      structured: { key: 'active_topic', value: text.slice(0, 200) },
      sourceMessageIds: sourceIdsFor(st, { fallback: `topic:${norm(key)}:${lastMentionAt}` }),
      sourceType,
      trust: defaultTrustFor(sourceType),
      confidence: 0.6,
      importance: 0.4,
      observedAt: lastMentionAt,
      expiresAt,
    };
    return { action: 'promote', candidate, cluster: `topic|${key}|${text.slice(0, 40)}` };
  }

  if (category === 'memberImpression') {
    const target = norm(extra.target);
    if (!target) return { action: 'skip', reason: 'missing-target' };
    // 只有解析到 userId 的印象才进长期层 —— 姓名键改名就断（P0.6 已经在 V2 侧解决了这个问题）
    const userId = where.kind === 'group'
      ? resolveImpressionUserId(st, target)
      : where.id;
    if (!userId) return { action: 'skip', reason: 'no-user-id' };

    const sourceType = where.kind === 'group' ? 'group' : 'private';
    const traits = Array.isArray(extra.traits) && extra.traits.length
      ? extra.traits.map((t) => norm(t)).filter(Boolean).slice(0, 10)
      : [text];
    const candidate = {
      kind: 'relationship',
      scope: where.kind === 'group' ? 'group' : 'user',
      groupId: where.kind === 'group' ? where.id : null,
      userId,
      subjectId: userId,
      sessionId: norm(key),
      text: `${target}：${traits.join('、')}`.slice(0, 300),
      structured: { key: 'impression', value: traits },
      sourceMessageIds: sourceIdsFor(st, {
        userId,
        fallback: `imp:u:${userId}:${Number(extra.lastSeenAt) || now}`,
      }),
      sourceType,
      trust: defaultTrustFor(sourceType),
      confidence: 0.5,
      importance: 0.6,
      observedAt: Number(extra.lastSeenAt) || now,
      expiresAt: null, // 关系档案长期保留，靠 supersede 演化
    };
    return { action: 'promote', candidate, cluster: `impression|${key}|${userId}` };
  }

  return { action: 'skip', reason: `unsupported-category:${category}` };
}

/** 从 V2 状态里按显示名解析 userId（与 P0.6 的 u:<uid> 键 + aliases 约定一致）。 */
export function resolveImpressionUserId(st, name) {
  const want = norm(name);
  if (!want || !st?.memberImpressions || typeof st.memberImpressions !== 'object') return null;
  const direct = st.memberImpressions[`u:${want}`];
  if (direct) return want;
  for (const [k, v] of Object.entries(st.memberImpressions)) {
    if (!k.startsWith('u:')) continue;
    if (Array.isArray(v?.aliases) && v.aliases.map(norm).includes(want)) return k.slice(2);
  }
  // 兜底：从最近消息里认人（群名片与印象键不一致时）
  const msgs = [
    ...(Array.isArray(st?.recentMessages) ? st.recentMessages : []),
    ...(Array.isArray(st?.unread) ? st.unread : []),
  ];
  for (const msg of msgs) {
    if (!msg || msg.isSelf) continue;
    if (norm(msg.sender) === want && msg.userId) return String(msg.userId);
  }
  return null;
}

/** 同簇旧条目判定：同 kind + 同作用域 + 同主体 + 同 structured.key。 */
export function isSameSubject(entry, candidate) {
  if (!entry || !candidate) return false;
  if (entry.kind !== candidate.kind) return false;
  if (entry.scope !== candidate.scope) return false;
  if ((entry.structured?.key ?? null) !== (candidate.structured?.key ?? null)) return false;
  if (entry.groupId !== (candidate.groupId ?? null)) return false;
  if ((entry.userId ?? null) !== (candidate.userId ?? null)) return false;
  if (entry.scope === 'session' && entry.sessionId !== candidate.sessionId) return false;
  return true;
}

/**
 * 决定这次沉淀怎么写：
 *   no-change —— 同簇活跃条目内容一致，不写（幂等，避免每次追加都产生新条目）
 *   supersede —— 同簇旧条目内容不同：新建 + 把旧的标 supersededBy（保留审计）
 *   insert    —— 没有同簇条目
 */
export function planPromotion({ candidate, existing = [] } = {}) {
  const active = existing.filter((e) => e && !e.deletedAt && !e.supersededBy && isSameSubject(e, candidate));
  if (!active.length) return { op: 'insert', supersededId: null };
  const latest = active.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  const same = JSON.stringify(latest.structured?.value) === JSON.stringify(candidate.structured?.value);
  if (same) return { op: 'no-change', supersededId: null };
  return { op: 'supersede', supersededId: latest.id };
}
