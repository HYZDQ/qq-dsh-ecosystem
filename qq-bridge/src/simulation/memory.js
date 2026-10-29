// 三代仿真记忆层（GEN3，对应 docs/design/GEN3_SIMULATION_PLAN.md 5.1/5.2/6.3）。
// 纯逻辑 + 本地文件 IO：不碰网络，也不依赖 bridge.js（原子写在本模块内实现）。
//
// 分层与生命周期（6.3）：
//   工作记忆（分钟~24h）    → scope=session，expiresAt 默认 observedAt + 24h
//   情景记忆（天~周）       → kind=episode，expiresAt 默认 observedAt + 14 天
//   语义事实（月~永久）     → kind=fact，靠 validTo/supersededBy 演化
//   关系档案（长期）        → kind=relationship
//   世界书（长期，可衰减）  → kind=worldbook，可显式给 expiresAt 做衰减
// 每条记忆都带 validFrom/validTo/supersededBy/sourceMessageIds，删除/更正一律可审计。
//
// 存储：方案 B 风格 JSON 分片（mem-<scope>.json）+ 原子写；store 抽象（put/get/query/applyConsolidation）
// 可插拔，未来可把 backend 换成 mnemon 实现而不动上层。
//
// schema 说明：字段全集见 5.2 节 JSON；本模块额外允许两个审计/归属字段：
//   - deletedAt：5.2 硬规则 5 明确要求的归档/软删除时间戳（不静默物理删除）；
//   - sessionId：scope=session 的会话归属标识，同时用于「敏感事实同会话可参考、跨会话仅 owner-confirmed」判定。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---- 枚举 ----
export const KINDS = ['episode', 'fact', 'relationship', 'profile', 'worldbook'];
export const SCOPES = ['agent', 'group', 'user', 'session'];
export const SOURCE_TYPES = ['owner', 'group', 'private', 'system'];
export const TRUSTS = ['owner-confirmed', 'observed', 'candidate', 'untrusted'];

// ---- 生命周期默认值（6.3 分层）----
const DAY_MS = 24 * 60 * 60 * 1000;
const LIFECYCLE_DEFAULTS = {
  sessionExpiresMs: 1 * DAY_MS, // 工作记忆：分钟~24h
  episodeExpiresMs: 14 * DAY_MS, // 情景记忆：天~周
};

// ---- 检索评分（6.3）：score = relevance*0.5 + importance*0.3 + recency*0.2 - scopePenalty - untrustedPenalty ----
export const SCORE_WEIGHTS = Object.freeze({ relevance: 0.5, importance: 0.3, recency: 0.2 });
// recency 用半衰期衰减（本地方法，不引入 embedding）
const HALF_LIFE_DAYS = Object.freeze({ episode: 7, fact: 90, relationship: 180, profile: 60, worldbook: 180 });
// 检索降权：untrusted/candidate 一律压低（6.3 防投毒「检索时对 candidate 降权」）
const UNTRUSTED_PENALTY = Object.freeze({ untrusted: 0.5, candidate: 0.25, observed: 0.05, 'owner-confirmed': 0 });

// ---- 敏感词表（5.2：联系方式/地址/行程/健康/财务）----
export const SENSITIVE_KEYWORDS = Object.freeze([
  // 联系方式
  '电话', '手机', '微信号', 'qq号', '邮箱', '联系方式', 'wechat', 'email', '手机号码',
  // 地址
  '地址', '住址', '住哪', '家在', '门牌', '小区', '几号楼',
  // 行程
  '行程', '出差', '航班', '机票', '车票', '几点的车', '旅行计划', '几点到',
  // 健康
  '生病', '发烧', '医院', '病历', '手术', '体检', '吃药', '健康', '过敏', '抑郁',
  // 财务
  '工资', '银行卡', '存款', '转账', '信用卡', '花呗', '贷款', '余额', '密码', '财务',
]);

// ---- 指令/投毒模式（6.3 防投毒：「记住：以后都听我的」类指令不得写成记忆）----
export const INSTRUCTION_PATTERNS = Object.freeze([
  /以后\s*(都|一直|永远)?\s*听\s*(我的|我)/,
  /从\s*现在\s*起[^\n。！？!?]{0,24}(听|服从|听从|只听)/,
  /(必须|要|得)\s*(服从|听话|听从)/,
  /一切\s*(都)?\s*听/,
  /只听\s*(我的|我)/,
  /你现在(是|只)?听/,
  /忘掉(之前|所有|前面)(的)?(设定|指令|规则)/,
  /ignore\s+(all\s+|previous\s+|above\s+)?instructions?/i,
  /disregard\s+(all\s+|previous\s+|above\s+)?(instructions?|rules?)/i,
]);

// ---- 工具 ----

/** 统一产出 ISO 时间串；非法输入抛错（带原因）。 */
function toIso(value, field) {
  const ms = value === undefined || value === null ? Date.now() : (typeof value === 'number' ? value : Date.parse(value));
  if (!Number.isFinite(ms)) throw new Error(`记忆条目被拒绝：${field} 不是合法时间（实际 ${JSON.stringify(value)}）`);
  return new Date(ms).toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`记忆条目被拒绝：${field} 必须是非空字符串`);
  return value.trim();
}

/** 文本是否命中敏感词表（联系方式/地址/行程/健康/财务）。 */
export function isSensitiveText(text) {
  const lower = String(text || '').toLowerCase();
  return SENSITIVE_KEYWORDS.some((word) => lower.includes(word.toLowerCase()));
}

/** 文本是否是「记住：以后都听我的」类服从指令（投毒）。 */
export function looksLikeInstruction(text) {
  const lower = String(text || '');
  return INSTRUCTION_PATTERNS.some((re) => re.test(lower));
}

/** 字符二元组 Jaccard 相似度（中文无需分词的本地近似，供巩固判「相似情景」）。 */
export function similarity(a, b) {
  const grams = (text) => {
    const s = String(text || '').toLowerCase().replace(/\s+/g, '');
    const set = new Set();
    if (s.length < 2) { if (s) set.add(s); return set; }
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 群聊来源的信任上限：一律 untrusted→candidate，永不自动升 owner-confirmed。 */
export function defaultTrustFor(sourceType) {
  return sourceType === 'group' ? 'candidate' : 'observed';
}

// ---- buildEntry：schema 校验 + 硬规则，非法抛错带原因 ----

/**
 * 构造一条记忆条目（5.2 字段全集）。
 * 硬规则（5.2 / 6.3 防投毒）：
 *   1. 无 sourceMessageIds / scope / trust 一律拒绝（不得进入长期记忆）；
 *   2. sourceType=group 最高 candidate，禁止升为 owner-confirmed（observed 也不给，群文本一律 untrusted→candidate）；
 *   3. owner-confirmed 只能来自 owner/system 来源（禁止普通用户伪造确认）；
 *   4. 群/私聊来源不得写 agent scope（群友不能写 agent/owner 档案；ownerUserId 可选传入以拦截 owner 档案）；
 *   5. 「记住：以后都听我的」类指令文本一律拒绝，不得沉淀成记忆；
 *   6. trust=untrusted 允许构造（当前轮参考），但持久化由 store.put 拒绝。
 * @param {object} input
 * @param {{ now?: number|string, ownerUserId?: string }} [opts]
 */
export function buildEntry(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('记忆条目被拒绝：输入必须是对象');
  }
  const kind = requireString(input.kind, 'kind');
  if (!KINDS.includes(kind)) throw new Error(`记忆条目被拒绝：kind 必须是 ${KINDS.join('/')}（实际 ${kind}）`);
  const scope = requireString(input.scope, 'scope'); // 硬规则 1：scope 必填
  if (!SCOPES.includes(scope)) throw new Error(`记忆条目被拒绝：scope 必须是 ${SCOPES.join('/')}（实际 ${scope}）`);
  const sourceType = requireString(input.sourceType, 'sourceType');
  if (!SOURCE_TYPES.includes(sourceType)) throw new Error(`记忆条目被拒绝：sourceType 必须是 ${SOURCE_TYPES.join('/')}（实际 ${sourceType}）`);
  const trust = requireString(input.trust, 'trust'); // 硬规则 1：trust 必填
  if (!TRUSTS.includes(trust)) throw new Error(`记忆条目被拒绝：trust 必须是 ${TRUSTS.join('/')}（实际 ${trust}）`);

  // 硬规则 1：sourceMessageIds 必填且非空
  if (!Array.isArray(input.sourceMessageIds) || input.sourceMessageIds.length === 0) {
    throw new Error('记忆条目被拒绝：sourceMessageIds 必须是非空数组（无来源不得进入长期记忆）');
  }
  const sourceMessageIds = [];
  for (const raw of input.sourceMessageIds) {
    const id = requireString(raw, 'sourceMessageIds[]');
    if (!sourceMessageIds.includes(id)) sourceMessageIds.push(id);
  }

  const text = requireString(input.text, 'text');

  // 硬规则 5（防投毒）：服从类指令不得写成任何长期记忆
  if (looksLikeInstruction(text)) {
    throw new Error(`记忆条目被拒绝：文本命中指令/投毒模式，不得沉淀为记忆（${text.slice(0, 30)}）`);
  }

  // 硬规则 2：群聊来源不得升为 owner-confirmed（也不给 observed，一律 untrusted→candidate）
  if (sourceType === 'group' && trust !== 'candidate' && trust !== 'untrusted') {
    throw new Error(`记忆条目被拒绝：sourceType=group 的信任上限是 candidate，禁止标记为 ${trust}`);
  }
  // 硬规则 3 前置：owner-confirmed 只能来自主人/系统确认
  if (trust === 'owner-confirmed' && sourceType !== 'owner' && sourceType !== 'system') {
    throw new Error(`记忆条目被拒绝：owner-confirmed 只能来自 owner/system 来源（实际 ${sourceType}）`);
  }
  // 防投毒：群友/普通私聊不得写 agent scope，也不得写 owner 的 user 档案
  if ((sourceType === 'group' || sourceType === 'private') && scope === 'agent') {
    throw new Error(`记忆条目被拒绝：${sourceType} 来源不得写入 agent 作用域`);
  }
  if ((sourceType === 'group' || sourceType === 'private') && scope === 'user' && opts.ownerUserId
    && requireString(input.userId, 'userId') === requireString(opts.ownerUserId, 'ownerUserId')) {
    throw new Error('记忆条目被拒绝：非主人来源不得写入 owner 的 user 作用域档案');
  }

  // 标识符按 scope 裁剪（5.1 可见性边界）
  const groupId = input.groupId == null ? null : requireString(input.groupId, 'groupId');
  const userId = input.userId == null ? null : requireString(input.userId, 'userId');
  const subjectId = input.subjectId == null ? null : requireString(input.subjectId, 'subjectId');
  const sessionId = input.sessionId == null ? null : requireString(input.sessionId, 'sessionId');
  if (scope === 'group' && !groupId) throw new Error('记忆条目被拒绝：scope=group 必须带 groupId');
  if (scope === 'user' && !userId) throw new Error('记忆条目被拒绝：scope=user 必须带 userId');
  if (scope === 'session' && !sessionId) throw new Error('记忆条目被拒绝：scope=session 必须带 sessionId');

  // structured{key,value}
  let structured = null;
  if (input.structured != null) {
    if (typeof input.structured !== 'object' || Array.isArray(input.structured)) {
      throw new Error('记忆条目被拒绝：structured 必须是 {key,value} 对象');
    }
    structured = {
      key: requireString(input.structured.key, 'structured.key'),
      value: input.structured.value === undefined ? null : input.structured.value,
    };
  }

  // 数值区间
  const num = (value, field, dflt) => {
    if (value === undefined || value === null) return dflt;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`记忆条目被拒绝：${field} 必须是 0~1 的数字`);
    return n;
  };
  const confidence = num(input.confidence, 'confidence', 0.5);
  const importance = num(input.importance, 'importance', 0.5);

  const observedAt = toIso(input.observedAt ?? opts.now, 'observedAt');
  const validFrom = toIso(input.validFrom ?? observedAt, 'validFrom');
  const validTo = input.validTo == null ? null : toIso(input.validTo, 'validTo');
  const supersededBy = input.supersededBy == null ? null : requireString(input.supersededBy, 'supersededBy');
  const deletedAt = input.deletedAt == null ? null : toIso(input.deletedAt, 'deletedAt');
  const lastAccessedAt = toIso(input.lastAccessedAt ?? observedAt, 'lastAccessedAt');
  const accessCountRaw = input.accessCount === undefined || input.accessCount === null ? 0 : Number(input.accessCount);
  if (!Number.isInteger(accessCountRaw) || accessCountRaw < 0) throw new Error('记忆条目被拒绝：accessCount 必须是非负整数');
  if (input.redacted !== undefined && typeof input.redacted !== 'boolean') throw new Error('记忆条目被拒绝：redacted 必须是布尔值');

  // 生命周期默认（6.3）：显式 expiresAt 优先（null 表示永久），其次 session（24h）/episode（14 天），其余长期不过期
  let expiresAt = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    expiresAt = toIso(input.expiresAt, 'expiresAt');
  } else if (input.expiresAt === undefined) {
    if (scope === 'session') {
      expiresAt = new Date(Date.parse(observedAt) + LIFECYCLE_DEFAULTS.sessionExpiresMs).toISOString();
    } else if (kind === 'episode') {
      expiresAt = new Date(Date.parse(observedAt) + LIFECYCLE_DEFAULTS.episodeExpiresMs).toISOString();
    }
  }

  return {
    id: input.id == null ? `mem_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}` : requireString(input.id, 'id'),
    kind,
    scope,
    groupId,
    userId,
    subjectId,
    sessionId,
    text,
    structured,
    sourceMessageIds,
    sourceType,
    trust,
    confidence,
    importance,
    observedAt,
    validFrom,
    validTo,
    supersededBy,
    lastAccessedAt,
    accessCount: accessCountRaw,
    expiresAt,
    redacted: input.redacted === undefined ? false : input.redacted,
    deletedAt, // 扩展审计字段：归档/软删除时间戳（5.2 硬规则 5）
  };
}

// ---- 检索评分（6.3）----

function scopePenalty(entry, opts) {
  const { groupId, userId, sessionId, scope } = opts;
  const focused = Boolean(groupId || userId || sessionId || scope);
  if (!focused) return 0;
  if (entry.scope === 'agent') return 0.1; // 全局条目稍降权，优先会话上下文记忆
  if (entry.scope === 'session') return sessionId && entry.sessionId === sessionId ? 0 : 0.4;
  if (entry.scope === 'group') return groupId && entry.groupId === groupId ? 0 : 0.4;
  if (entry.scope === 'user') {
    const userOk = userId && entry.userId === userId;
    const groupOk = !entry.groupId || (groupId && entry.groupId === groupId);
    return userOk && groupOk ? 0 : 0.4;
  }
  return 0.4;
}

function relevanceOf(entry, keywords) {
  const list = (Array.isArray(keywords) ? keywords : []).filter((k) => typeof k === 'string' && k.trim());
  if (!list.length) return 0;
  const hay = `${entry.text} ${entry.structured?.key || ''} ${entry.structured?.value ?? ''} ${entry.kind}`.toLowerCase();
  let hit = 0;
  for (const kw of list) if (hay.includes(kw.trim().toLowerCase())) hit += 1;
  return hit / list.length;
}

function recencyOf(entry, nowMs) {
  const halfLife = HALF_LIFE_DAYS[entry.kind] || 90;
  const ageDays = Math.max(0, (nowMs - Date.parse(entry.observedAt)) / DAY_MS);
  return 0.5 ** (ageDays / halfLife);
}

/**
 * 打分：score = relevance*0.5 + importance*0.3 + recency*0.2 - scopePenalty - untrustedPenalty。
 * relevance 用关键词重叠（本地方法，不引入 embedding）。
 */
export function scoreEntry(entry, { now = Date.now(), keywords = [], groupId = null, userId = null, sessionId = null, scope = null } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const relevance = relevanceOf(entry, keywords);
  const importance = Number(entry.importance) || 0;
  const recency = recencyOf(entry, nowMs);
  const penalty = scopePenalty(entry, { groupId, userId, sessionId, scope });
  const untrusted = UNTRUSTED_PENALTY[entry.trust] ?? 0.25;
  return relevance * SCORE_WEIGHTS.relevance
    + importance * SCORE_WEIGHTS.importance
    + recency * SCORE_WEIGHTS.recency
    - penalty
    - untrusted;
}

/** 注入用的「时间戳 + 来源标签」单行渲染（6.3 检索要求）。 */
export function formatMemoryLine(entry) {
  const day = String(entry.observedAt || '').slice(0, 10);
  const where = entry.scope === 'group' ? `group:${entry.groupId || '-'}` : entry.scope === 'user' ? `user:${entry.userId || '-'}` : entry.scope;
  return `[${day}][${where}][${entry.trust}] ${entry.text}`;
}

// ---- 巩固（6.3）：纯函数，幂等、可补跑 ----

function isActive(entry) {
  return !entry.deletedAt && !entry.supersededBy;
}

function clusterKeyOf(entry) {
  return [entry.scope, entry.groupId || '', entry.userId || '', entry.subjectId || '', entry.sessionId || ''].join('|');
}

/**
 * 巩固：重复情景(≥3 次相似)→语义事实；矛盾→新事实 + 旧事实 supersededBy；过期→归档不物理删除。
 * 纯函数：输入数组不被就地修改，重复调用结果一致（幂等、可补跑）。
 * @param {Array<object>} entries
 * @param {{ now?: number|string, similarityThreshold?: number }} [opts]
 * @returns {{ entries: Array<object>, report: { archivedIds: string[], supersessions: {fromId:string,toId:string}[], createdFacts: object[] } }}
 */
export function applyConsolidation(entries, opts = {}) {
  const nowMs = typeof opts.now === 'number' ? opts.now : (opts.now ? Date.parse(opts.now) : Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const threshold = Number.isFinite(opts.similarityThreshold) ? opts.similarityThreshold : 0.5;
  const next = clone(entries);
  const report = { archivedIds: [], supersessions: [], createdFacts: [] };

  // 1) 过期 → 归档（写 deletedAt 审计戳，绝不物理删除）
  for (const entry of next) {
    if (!isActive(entry)) continue;
    const expiring = entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs;
    const ended = entry.validTo && Date.parse(entry.validTo) <= nowMs;
    if (expiring || ended) {
      entry.deletedAt = entry.deletedAt || nowIso;
      report.archivedIds.push(entry.id);
    }
  }
  report.archivedIds.sort();

  // 2) 矛盾事实 → 新事实生效，旧事实 supersededBy（旧值原样保留，可审计回溯）
  const factGroups = new Map();
  for (const entry of next) {
    if (entry.kind !== 'fact' || !isActive(entry) || !entry.structured?.key) continue;
    const key = [clusterKeyOf(entry), entry.structured.key].join('|');
    if (!factGroups.has(key)) factGroups.set(key, []);
    factGroups.get(key).push(entry);
  }
  for (const group of factGroups.values()) {
    const values = new Set(group.map((e) => JSON.stringify(e.structured.value)));
    if (values.size < 2) continue;
    const ranked = [...group].sort((a, b) => (Date.parse(b.observedAt) - Date.parse(a.observedAt)) || (a.id < b.id ? 1 : -1));
    const winner = ranked[0];
    for (const old of ranked.slice(1)) {
      if (old.supersededBy === winner.id) continue; // 幂等：已处理过就跳过
      old.supersededBy = winner.id;
      const cut = Date.parse(winner.observedAt);
      if (!old.validTo || Date.parse(old.validTo) > cut) old.validTo = winner.observedAt;
      report.supersessions.push({ fromId: old.id, toId: winner.id });
    }
  }
  report.supersessions.sort((a, b) => (a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : 0));

  // 3) 重复情景(≥3 次相似) → 语义事实；来源合并进 sourceMessageIds，供幂等去重
  const episodesByCluster = new Map();
  for (const entry of next) {
    if (entry.kind !== 'episode' || !isActive(entry)) continue;
    const key = clusterKeyOf(entry);
    if (!episodesByCluster.has(key)) episodesByCluster.set(key, []);
    episodesByCluster.get(key).push(entry);
  }
  for (const [clusterKey, episodes] of episodesByCluster) {
    const sorted = [...episodes].sort((a, b) => (Date.parse(a.observedAt) - Date.parse(b.observedAt)) || (a.id < b.id ? -1 : 1));
    const clusters = [];
    for (const episode of sorted) {
      const target = clusters.find((c) => similarity(c.representative, episode.text) >= threshold);
      if (target) target.members.push(episode);
      else clusters.push({ representative: episode.text, members: [episode] });
    }
    for (const cluster of clusters) {
      if (cluster.members.length < 3) continue;
      const members = cluster.members;
      const sourceMessageIds = [];
      for (const member of members) for (const id of member.sourceMessageIds) if (!sourceMessageIds.includes(id)) sourceMessageIds.push(id);
      const sharedKey = members.every((m) => m.structured?.key && m.structured.key === members[0].structured?.key)
        ? members[0].structured.key : null;
      const sharedValue = sharedKey && members.every((m) => JSON.stringify(m.structured.value) === JSON.stringify(members[0].structured.value))
        ? members[0].structured.value : null;

      // 幂等去重：已有事实覆盖同一 key 且证据重叠就不再新建
      const covered = next.some((e) => e.kind === 'fact'
        && e.structured?.key === (sharedKey || 'repeated_observation')
        && e.sourceMessageIds.some((id) => sourceMessageIds.includes(id)));
      if (covered) continue;

      const sourceTypes = new Set(members.map((m) => m.sourceType));
      const sourceType = sourceTypes.size === 1 ? members[0].sourceType : 'system';
      // 群聊证据永不升 owner-confirmed；群来源封顶 candidate
      let trust = members.some((m) => m.trust === 'observed') ? 'observed' : 'candidate';
      if (sourceType === 'group') trust = 'candidate';
      const latest = members.reduce((a, b) => (Date.parse(a.observedAt) >= Date.parse(b.observedAt) ? a : b));
      const fact = buildEntry({
        id: `mem_${nowMs.toString(36)}_${crypto.randomBytes(5).toString('hex')}`,
        kind: 'fact',
        scope: latest.scope,
        groupId: latest.groupId,
        userId: latest.userId,
        subjectId: latest.subjectId,
        sessionId: latest.sessionId,
        text: sharedKey ? `多次观察到：${sharedKey}=${JSON.stringify(sharedValue)}` : `反复出现：${cluster.representative.slice(0, 40)}`,
        structured: { key: sharedKey || 'repeated_observation', value: sharedKey ? sharedValue : cluster.representative.slice(0, 40) },
        sourceMessageIds,
        sourceType,
        trust,
        confidence: Math.min(...members.map((m) => Number(m.confidence) || 0)),
        importance: Math.min(1, Math.max(...members.map((m) => Number(m.importance) || 0)) + 0.1),
        observedAt: latest.observedAt,
        validFrom: latest.observedAt,
        expiresAt: null, // 语义事实月~永久
      }, { now: nowMs });
      next.push(fact);
      report.createdFacts.push(fact);
    }
  }
  report.createdFacts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 稳定排序，方便「跑两次结果一致」的对比
  next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { entries: next, report };
}

// ---- 原子写（参考 bridge.js atomicWriteJson 思路，模块内自实现）----

function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch { }
    }
  }
  throw lastError;
}

// 原子写 JSON：先写唯一临时文件再 rename，中断不会留半截目标文件；失败时清理临时文件。
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { }
    throw error;
  }
}

// ---- 默认后端：JSON 分片文件（mem-<scope>.json），store 抽象可换 mnemon ----

/**
 * JSON 文件后端：load/save 按 scope 分片。可被自定义 backend（如 mnemon 适配器）替换，
 * 只需实现 { load(scope), save(scope, entries), scopes() }。
 */
export function createJsonFileBackend({ dir } = {}) {
  if (!dir || typeof dir !== 'string') throw new Error('createJsonFileBackend 需要 dir');
  const fileOf = (scope) => path.join(dir, `mem-${scope}.json`);
  return {
    scopes: () => [...SCOPES],
    load(scope) {
      const file = fileOf(scope);
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`记忆分片损坏（无法解析 JSON）：${file}`);
      }
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(entries)) throw new Error(`记忆分片格式不对（缺 entries 数组）：${file}`);
      return entries;
    },
    save(scope, entries) {
      atomicWriteJson(fileOf(scope), { schemaVersion: 1, updatedAt: new Date().toISOString(), entries });
    },
  };
}

// ---- store 门面：put/get/query/applyConsolidation 等 ----

/**
 * 创建记忆存储（方案 B：JSON 分片 + 原子写；backend 可插拔）。
 * @param {{ dir?: string, backend?: object, ownerUserId?: string, limits?: { maxEntries?: number, maxChars?: number }, lockStaleMs?: number }} [options]
 */
export function createMemoryStore(options = {}) {
  const backend = options.backend || createJsonFileBackend({ dir: options.dir });
  const ownerUserId = options.ownerUserId || null;
  const limits = {
    maxEntries: Number(options.limits?.maxEntries) > 0 ? Number(options.limits.maxEntries) : 10, // 6.3：每次最多注入 10~20 条
    maxChars: Number(options.limits?.maxChars) > 0 ? Number(options.limits.maxChars) : 2000, // 按预算裁剪
  };
  const lockFile = options.lockFile || (options.dir ? path.join(options.dir, 'mem-consolidate.lock') : null);
  const lockStaleMs = Number(options.lockStaleMs) > 0 ? Number(options.lockStaleMs) : 120 * 1000;

  const loadAll = () => {
    const all = [];
    for (const scope of backend.scopes()) for (const entry of backend.load(scope)) all.push(entry);
    return all;
  };

  const visible = (entry, opts) => {
    // 先按 scope 过滤（5.1 可见性边界，零泄漏），再排序
    if (opts.scope && entry.scope !== opts.scope) return false;
    if (entry.scope === 'group') return Boolean(opts.groupId) && entry.groupId === opts.groupId;
    if (entry.scope === 'user') {
      if (!opts.userId || entry.userId !== opts.userId) return false;
      return !entry.groupId || (Boolean(opts.groupId) && entry.groupId === opts.groupId);
    }
    if (entry.scope === 'session') return Boolean(opts.sessionId) && entry.sessionId === opts.sessionId;
    return entry.scope === 'agent'; // agent 自身记忆全局可见
  };

  // 实际巩固执行（按分片差异落盘，保证重复跑不产生无谓写入）
  const runConsolidation = (nowMs) => {
    const before = new Map();
    for (const scope of backend.scopes()) before.set(scope, backend.load(scope));
    const flat = [];
    for (const [, entries] of before) flat.push(...entries);
    const { entries: next, report } = applyConsolidation(flat, { now: nowMs });
    for (const scope of backend.scopes()) {
      const after = next.filter((e) => e.scope === scope);
      if (JSON.stringify(after) !== JSON.stringify(before.get(scope))) backend.save(scope, after);
    }
    return {
      skipped: false,
      archivedIds: report.archivedIds,
      supersessions: report.supersessions,
      createdFacts: report.createdFacts.map((f) => clone(f)),
    };
  };

  return {
    /** 持久化一条记忆；untrusted 只允许当前轮参考，这里直接拒绝。 */
    put(input) {
      const entry = buildEntry(input, { ownerUserId });
      if (entry.trust === 'untrusted') {
        throw new Error('记忆写入被拒绝：trust=untrusted 只在当前轮参考，不得持久化');
      }
      const existing = loadAll();
      if (existing.some((e) => e.id === entry.id)) {
        throw new Error(`记忆写入被拒绝：id 已存在（${entry.id}），更正请走 supersede 以保留审计`);
      }
      backend.save(entry.scope, [...backend.load(entry.scope), entry]);
      return clone(entry);
    },

    /** 按 id 取回（含已归档/被替代条目，供审计回溯）。 */
    getById(id) {
      const found = loadAll().find((e) => e.id === id);
      return found ? clone(found) : null;
    },

    /**
     * 检索：先按 scope 过滤，再按评分排序，按条数/字符预算裁剪。
     * 敏感事实（联系方式/地址/行程/健康/财务）仅 owner-confirmed 可跨会话检索（同 sessionId 除外）。
     */
    query(opts = {}) {
      const nowMs = typeof opts.now === 'number' ? opts.now : (opts.now ? Date.parse(opts.now) : Date.now());
      const picked = [];
      for (const entry of loadAll()) {
        if (!visible(entry, opts)) continue;
        if (!opts.includeArchived && entry.deletedAt) continue;
        if (!opts.includeSuperseded && entry.supersededBy) continue;
        if (!opts.includeArchived && (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs)) continue; // 过期视为待归档
        if (!opts.includeArchived && (entry.validTo && Date.parse(entry.validTo) <= nowMs)) continue;
        if (entry.trust === 'untrusted') continue; // 持久层里不该出现，双保险
        const sameSession = Boolean(opts.sessionId) && entry.sessionId === opts.sessionId;
        if (isSensitiveText(entry.text) && entry.trust !== 'owner-confirmed' && !sameSession) continue;
        picked.push({ entry, score: scoreEntry(entry, { ...opts, now: nowMs }) });
      }
      picked.sort((a, b) => (b.score - a.score)
        || (Date.parse(b.entry.observedAt) - Date.parse(a.entry.observedAt))
        || (a.entry.id < b.entry.id ? -1 : 1));
      const maxEntries = Math.max(1, Number(opts.limit) > 0 ? Number(opts.limit) : limits.maxEntries);
      const budgetChars = Math.max(0, Number(opts.budgetChars) > 0 ? Number(opts.budgetChars) : limits.maxChars);
      const out = [];
      let used = 0;
      for (const { entry } of picked) {
        if (out.length >= maxEntries) break;
        const line = formatMemoryLine(entry);
        if (used + line.length > budgetChars && out.length > 0) continue; // 超预算就跳过，继续装更短的
        used += line.length;
        out.push(entry);
      }
      if (opts.trackAccess) {
        const touched = new Set(out.map((e) => e.id));
        if (touched.size) {
          for (const scope of backend.scopes()) {
            const shard = backend.load(scope);
            let changed = false;
            for (const entry of shard) {
              if (touched.has(entry.id)) {
                entry.lastAccessedAt = new Date(nowMs).toISOString();
                entry.accessCount = (Number(entry.accessCount) || 0) + 1;
                changed = true;
              }
            }
            if (changed) backend.save(scope, shard);
          }
        }
      }
      return clone(out);
    },

    /** 归档（软删除）：写 deletedAt 审计戳，不物理删除。 */
    archive(id, { now } = {}) {
      const nowIso = new Date(typeof now === 'number' ? now : (now ? Date.parse(now) : Date.now())).toISOString();
      for (const scope of backend.scopes()) {
        const shard = backend.load(scope);
        const entry = shard.find((e) => e.id === id);
        if (!entry) continue;
        if (!entry.deletedAt) {
          entry.deletedAt = nowIso;
          backend.save(scope, shard);
        }
        return clone(entry);
      }
      throw new Error(`记忆归档失败：找不到条目 ${id}`);
    },

    /** 更正：旧条目打 supersededBy + validTo，新旧都保留（可审计，不静默覆盖）。 */
    supersede(id, newId, { now } = {}) {
      const nowIso = new Date(typeof now === 'number' ? now : (now ? Date.parse(now) : Date.now())).toISOString();
      for (const scope of backend.scopes()) {
        const shard = backend.load(scope);
        const entry = shard.find((e) => e.id === id);
        if (!entry) continue;
        if (entry.supersededBy && entry.supersededBy !== newId) {
          throw new Error(`记忆更正失败：${id} 已被 ${entry.supersededBy} 替代，不允许再次覆盖`);
        }
        entry.supersededBy = newId;
        if (!entry.validTo || Date.parse(entry.validTo) > Date.parse(nowIso)) entry.validTo = nowIso;
        backend.save(scope, shard);
        return clone(entry);
      }
      throw new Error(`记忆更正失败：找不到条目 ${id}`);
    },

    /** 纯巩固逻辑（导出到 store，便于自定义 backend 复用）。 */
    applyConsolidation,

    /** 立即巩固：带单实例文件锁，幂等、可补跑；失败只报错不影响调用方。 */
    consolidateNow({ now } = {}) {
      const nowMs = typeof now === 'number' ? now : (now ? Date.parse(now) : Date.now());
      if (!lockFile) return runConsolidation(nowMs);
      let locked = false;
      try {
        locked = acquireLock(lockFile, lockStaleMs);
        if (!locked) return { skipped: true, reason: 'locked', archivedIds: [], supersessions: [], createdFacts: [] };
        return runConsolidation(nowMs);
      } finally {
        if (locked) releaseLock(lockFile);
      }
    },

    /** 统计（供控制台/回归观察）。 */
    stats() {
      const all = loadAll();
      const byKind = {};
      const byScope = {};
      const byTrust = {};
      for (const entry of all) {
        byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
        byScope[entry.scope] = (byScope[entry.scope] || 0) + 1;
        byTrust[entry.trust] = (byTrust[entry.trust] || 0) + 1;
      }
      return {
        total: all.length,
        active: all.filter((e) => isActive(e)).length,
        archived: all.filter((e) => e.deletedAt).length,
        superseded: all.filter((e) => e.supersededBy).length,
        byKind,
        byScope,
        byTrust,
      };
    },
  };
}

// ---- 文件锁（巩固单实例，文件锁即可）----

function acquireLock(lockFile, staleMs) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const tryOnce = () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
    return true;
  };
  try {
    return tryOnce();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  // 陈旧锁（进程崩溃残留）可接管；新鲜锁说明别的实例在跑
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch { }
  if (ageMs <= staleMs) return false;
  try { fs.unlinkSync(lockFile); } catch { }
  try {
    return tryOnce();
  } catch {
    return false;
  }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { }
}
