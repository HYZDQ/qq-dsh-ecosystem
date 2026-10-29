// 人格卡（roles/<名称>.md）的解析与「按仿真模式 + 场景取用」，以及
// 「人格分裂」状态（state/current-role.json）的纯函数解析。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
//
// 为什么要分场景（群聊/私聊）：
//   「人格分裂」勾选后群聊/私聊各用一张卡（roles.group / roles.private）；
//   同一张卡内部还可用 〔群聊〕/〔私聊〕 小节标记，让一段人设只在某场景注入。
//   场景标记与模式标记**正交可组合**：`## 分条 〔二代·群聊〕` 只在二代+群聊注入。
//
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
// 例：
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 群聊铁律 〔群聊〕        → 只在群聊会话注入
//   ## 你是谁                   → 任何模式、任何场景都注入
import yaml from 'js-yaml';

export const ROLE_INJECT_MODES = ['v1', 'v2'];
export const ROLE_SCOPES = ['group', 'private'];

// ──────────────────────────── 标题标记 ────────────────────────────
// 括号内可写多个 token（`·`、`、`、`/` 等分隔），例如 〔二代·群聊〕〔群聊/二代〕。
// token 先去所有空白再查表，所以 `〔2 代〕` 与 `〔2代〕` 等价。
const TAG_TOKEN_MODE = new Map([
  ['一代', 'v1'], ['1代', 'v1'], ['v1', 'v1'], ['reserved', 'v1'],
  ['二代', 'v2'], ['2代', 'v2'], ['v2', 'v2'], ['reserved2', 'v2'],
]);
const TAG_TOKEN_SCOPE = new Map([
  ['群聊', 'group'], ['群组', 'group'], ['群', 'group'], ['group', 'group'],
  ['私聊', 'private'], ['单聊', 'private'], ['一对一', 'private'], ['private', 'private'],
]);
const TAG_SEP_RE = /[·・•、,，/|+~]+/;
const TAG_BRACKET_RE = /[[〔（(]([^\]〕）)]*)[\]〕）)]/g;

/**
 * 解析标题里的一个标记括号。返回 null 表示这不是标记（原样保留）。
 * @returns {{mode: 'all'|'v1'|'v2', scope: 'all'|'group'|'private'}|null}
 */
function parseTagBracket(inner) {
  let mode = 'all';
  let scope = 'all';
  let recognized = false;
  for (const piece of String(inner ?? '').split(TAG_SEP_RE)) {
    const token = piece.replace(/\s+/g, '').toLowerCase();
    if (!token) continue;
    const m = TAG_TOKEN_MODE.get(token);
    const s = TAG_TOKEN_SCOPE.get(token);
    if (m) { mode = m; recognized = true; }
    if (s) { scope = s; recognized = true; }
  }
  return recognized ? { mode, scope } : null;
}

/** 把标题里的标记解析掉：返回干净标题 + 该小节的模式/场景归属。 */
function stripTags(heading) {
  let mode = 'all';
  let scope = 'all';
  const out = String(heading).replace(TAG_BRACKET_RE, (match, inner) => {
    const tag = parseTagBracket(inner);
    if (!tag) return match;
    if (tag.mode !== 'all') mode = tag.mode;
    if (tag.scope !== 'all') scope = tag.scope;
    return '';
  });
  return {
    mode,
    scope,
    heading: out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim(),
  };
}

// ──────────────────────────── front-matter ────────────────────────────
// 卡片可选元数据（锚点随卡，见 docs/design/PERSONA_SCOPE_SPLIT_PLAN.md §5.5）：
//   ---
//   scope: private
//   anchors:
//     speechFeatures: [软萌, 爱用叠词]
//     redLines: [不冒充真人]
//   ---
//   # 角色卡：…
// 识别条件**从紧**：第 1 行必须是 `---`，且前 60 行内有闭合 `---`，中间能被 YAML
// 解析成对象；否则一律按普通正文处理（避免误伤正文里的水平线）。
const FRONT_MATTER_MAX_LINES = 60;

function emptyMeta() {
  return { scope: 'both', anchors: null };
}

function normalizeAnchorList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

/**
 * 拆出卡片 front-matter 与正文。
 * @returns {{meta: {scope: 'both'|'group'|'private', anchors: {speechFeatures: string[], redLines: string[]}|null}, body: string, metaChars: number, hasMeta: boolean}}
 */
export function parseRoleCard(text) {
  const raw = String(text ?? '');
  const fallback = { meta: emptyMeta(), body: raw, metaChars: 0, hasMeta: false };
  const lines = raw.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return fallback;
  let close = -1;
  for (let i = 1; i < Math.min(lines.length, FRONT_MATTER_MAX_LINES); i += 1) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close < 0) return fallback;
  let parsed;
  try { parsed = yaml.load(lines.slice(1, close).join('\n')); }
  catch { return fallback; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const meta = emptyMeta();
  const scopeValue = String(parsed.scope ?? '').trim().toLowerCase();
  if (scopeValue === 'group' || scopeValue === '群聊') meta.scope = 'group';
  else if (scopeValue === 'private' || scopeValue === '私聊') meta.scope = 'private';
  const anchorsRaw = parsed.anchors;
  if (anchorsRaw && typeof anchorsRaw === 'object' && !Array.isArray(anchorsRaw)) {
    const speechFeatures = normalizeAnchorList(anchorsRaw.speechFeatures);
    const redLines = normalizeAnchorList(anchorsRaw.redLines);
    if (speechFeatures.length || redLines.length) meta.anchors = { speechFeatures, redLines };
  }
  const body = lines.slice(close + 1).join('\n');
  return { meta, body, metaChars: raw.length - body.length, hasMeta: true };
}

// ──────────────────────────── 小节解析 ────────────────────────────

/**
 * 按标题把人格卡拆成小节（front-matter 先行剥离，不进小节）。
 * @returns {{mode: 'all'|'v1'|'v2', scope: 'all'|'group'|'private', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of parseRoleCard(text).body.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', scope: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const tag = stripTags(heading[2]);
    current = { mode: tag.mode, scope: tag.scope, heading: tag.heading, lines: [`${heading[1]} ${tag.heading}`] };
    sections.push(current);
  }
  return sections;
}

function sectionMatches(section, wantMode, wantScope) {
  if (section.mode !== 'all' && section.mode !== wantMode) return false;
  if (wantScope && section.scope !== 'all' && section.scope !== wantScope) return false;
  return true;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉标记与 front-matter）。
 * @param {'v1'|'v2'} mode
 * @param {'group'|'private'|undefined} scope 省略 = 不按场景过滤（兼容老调用方）
 */
export function selectRoleText(text, mode, scope) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => sectionMatches(section, want, scope))
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 报告每个小节在当前模式/场景下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 * @param {'group'|'private'|undefined} scope
 */
export function roleSectionReport(text, mode, scope) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    scope: section.scope,
    injected: sectionMatches(section, want, scope),
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式 × 场景的字符数，用于控制台提示「筛完还剩多少」。 */
export function roleCharStats(text) {
  const card = parseRoleCard(text);
  const source = card.body;
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    metaChars: card.metaChars,
    hasMeta: card.hasMeta,
    common: sum(sections.filter((section) => section.mode === 'all' && section.scope === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    groupOnly: sum(sections.filter((section) => section.scope === 'group')),
    privateOnly: sum(sections.filter((section) => section.scope === 'private')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
    v1Group: selectRoleText(source, 'v1', 'group').length,
    v1Private: selectRoleText(source, 'v1', 'private').length,
    v2Group: selectRoleText(source, 'v2', 'group').length,
    v2Private: selectRoleText(source, 'v2', 'private').length,
    hasScopeTags: sections.some((section) => section.scope !== 'all'),
  };
}

// ──────────────────────────── 「人格分裂」状态解析 ────────────────────────────
// state/current-role.json（schema v2）：
//   { "split": true, "mode": "active", "role": "蓝莓球", "roles": { "group": "小鲸鱼", "private": "蓝莓球" } }
// 开关语义（单一入口 resolveRole，所有取卡点都走它，禁止散写 roles[kind] ?? role）：
//   split: true  → 群聊取 roles.group、私聊取 roles.private；空 = 该场景不扮演
//   split: false → 群/私共用一张卡 = roles.private ?? role（共用卡默认为私聊的人物卡）

/** 人格名清洗：仅保留中文 / 字母 / 数字 / 横线 / 下划线（与历史行为一致）。 */
export function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

function slotName(value) {
  const t = typeof value === 'string' ? value.trim() : '';
  return sanitizeRoleName(t) || null;
}

/** 把任意来源（含用户手编）的状态归一成 schema v2 形状。 */
export function normalizeRoleState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const slots = source.roles && typeof source.roles === 'object' && !Array.isArray(source.roles) ? source.roles : {};
  const str = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    split: source.split === true,
    mode: source.mode === 'silent' ? 'silent' : 'active',
    role: str(source.role),
    roles: {
      group: str(slots.group),
      private: str(slots.private),
    },
  };
}

/** 会话 key → 场景：group:* 归群聊，其余（private:* 等）归私聊。 */
export function roleScopeOfKey(key) {
  return String(key ?? '').trim().startsWith('group:') ? 'group' : 'private';
}

/**
 * 「人格分裂」开关语义的唯一解析入口。
 * @param {object} state 未归一的状态（会自动 normalizeRoleState）
 * @param {'group'|'private'} kind
 * @returns {string|null} 清洗后的人格名；null = 该场景不扮演
 */
export function resolveRole(state, kind) {
  const st = normalizeRoleState(state);
  const slot = kind === 'group' ? st.roles.group : st.roles.private;
  const name = st.split ? slot : (st.roles.private ?? st.role);
  return slotName(name);
}

/**
 * 勾选「人格分裂」时的展开：群聊槽从共用卡起步，已有槽位原样保留
 * （取消勾选只写 split:false 不动 roles.group，重新勾选即恢复之前的群聊卡）。
 */
export function expandRoleStateOnEnable(state) {
  const st = normalizeRoleState(state);
  const base = st.roles.private ?? st.role;
  return {
    ...st,
    split: true,
    roles: {
      group: st.roles.group ?? base,
      private: st.roles.private ?? base,
    },
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
