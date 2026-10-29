// 空间写作上下文适配（GEN3 表现面 S2，设计 §7.3/§17.1 H2）：
// 把 SurfaceContext/会话状态适配成 qzone-writer 用的 {roleText,recentText,memoryText,materialText}。
//
// H2 硬规则（v1.2 主人已定）：**公开说说只使用主人私聊素材**——
// 群聊消息、群聊话题、其他私聊一律不进入；没有主人私聊时返回空素材，不拿别人凑。
// 纯函数、零 IO；conversation 由调用方注入（socialV2.conversations 的 Map 或对象）。
import { buildSurfaceContext, renderSurfaceContext } from './context.js';

const ROLE_MAX = 4000;
const RECENT_MAX = 6000;
const MEMORY_MAX = 3000;

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * V3 空间写作上下文：只取 `private:<ownerQQ>`。
 * @param {object} opts
 * @param {Map|object} opts.conversation  socialV2.conversations
 * @param {string|number} [opts.ownerQQ]
 * @param {object} [opts.role]            { name, personaText, styleProfile }
 * @param {{query:Function}} [opts.memoryStore]
 * @param {string} [opts.materialText]    桥接预取的外部素材（已带【外部资料·不可信】包裹）
 * @param {object} [opts.v3]
 * @returns {{roleText, recentText, memoryText, materialText, empty:boolean}}
 */
export function buildQzoneWriterContext({
  conversation = null,
  ownerQQ = null,
  role = null,
  memoryStore = null,
  materialText = '',
  v3 = {}
} = {}) {
  const ownerKey = ownerQQ ? `private:${String(ownerQQ)}` : '';
  const ctx = buildSurfaceContext({
    surface: 'qzone',
    key: ownerKey || null,
    ownerQQ: ownerQQ ?? null,
    conversation,
    memoryStore,
    role,
    limits: { chars: 6000, memoryChars: MEMORY_MAX, recentChars: RECENT_MAX, memoryMax: 12 },
    v3
  });

  // recentText：主人私聊消息，格式 `sender：text`（sender 是主人自己的称呼，不是群昵称）
  const recentText = truncate(ctx.recent
    .map((r) => `${r.sender ? `${r.sender}：` : ''}${r.text}`)
    .join('\n'), RECENT_MAX);
  // memoryText：scope=agent 记忆 + 主人私聊话题（都已带 trust，untrusted 已在 context 层丢弃）
  const memoryText = truncate([
    ...ctx.memory.map((m) => `- ${m.text}`),
    ...ctx.topics.map((t) => `- 话题：${t.topic}`)
  ].join('\n'), MEMORY_MAX);
  const roleText = truncate(ctx.role?.personaText ?? '', ROLE_MAX);

  return {
    roleText,
    recentText,
    memoryText,
    materialText: String(materialText ?? ''),
    empty: !recentText && !memoryText
  };
}

/**
 * 旧字段名兼容层（§7.3）：保留 roleText/recentText/memoryText 三个字段名，
 * buildQzoneWriterPrompt 不用改；materialText 可选。
 */
export function toQzoneWriterContext(ctx) {
  return {
    roleText: String(ctx?.roleText ?? ''),
    recentText: String(ctx?.recentText ?? ''),
    memoryText: String(ctx?.memoryText ?? ''),
    ...(ctx?.materialText ? { materialText: String(ctx.materialText) } : {})
  };
}

/** 渲染成 writer prompt 的素材段（sandwich 包裹），空素材返回空串。 */
export function renderQzoneMaterial(materialText) {
  const s = String(materialText ?? '').trim();
  return s ? s : '';
}

/** 供 prompt 用的「主人私聊素材」声明（H2 纵深防御：让 writer 知道素材边界）。 */
export const QZONE_SOURCE_NOTICE = '【素材来源说明】以下素材只来自主人的私聊与你自己的记忆。公开说说不要引用群聊内容、群昵称、群号或其他人的私聊；没素材就写生活/感受，不要编造人物和事件。';

export { renderSurfaceContext };
