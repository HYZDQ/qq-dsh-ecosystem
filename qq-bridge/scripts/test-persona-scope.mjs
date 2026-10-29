// 「人格分裂」开关语义与场景标记（src/role-card.js 纯函数）的离线单测。
// 设计见 docs/design/PERSONA_SCOPE_SPLIT_PLAN.md：
//   勾选 split → 群聊用群聊卡、私聊用私聊卡；取消勾选 → 共用一张卡（= 私聊卡）。
// 保证：resolveRole 是唯一解析入口、来回切不丢群聊槽、旧格式零行为变化、
// 〔群聊〕/〔私聊〕 小节标记与 〔一代〕/〔二代〕 正交、front-matter 严格识别。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expandRoleStateOnEnable,
  normalizeRoleState,
  parseRoleCard,
  resolveRole,
  roleCharStats,
  roleScopeOfKey,
  sanitizeRoleName,
  selectRoleText,
} from '../src/role-card.js';

// ── resolveRole：开关语义（单一入口） ──────────────────────────────────────

test('开关关闭：群/私共用一张卡（= 私聊卡，缺省回退 role）', () => {
  const state = { split: false, role: 'A', roles: { group: 'B', private: 'A' } };
  assert.equal(resolveRole(state, 'group'), 'A', '关闭时群聊也用共用卡（私聊卡）');
  assert.equal(resolveRole(state, 'private'), 'A');
});

test('开关关闭 + 私聊槽为空：回退 role（兼容最老文件）', () => {
  assert.equal(resolveRole({ role: 'A' }, 'group'), 'A');
  assert.equal(resolveRole({ role: 'A' }, 'private'), 'A');
});

test('开关开启：各用各的槽，空 = 该场景不扮演（不跨场景借用）', () => {
  const state = { split: true, roles: { group: 'B', private: 'A' } };
  assert.equal(resolveRole(state, 'group'), 'B');
  assert.equal(resolveRole(state, 'private'), 'A');
  assert.equal(resolveRole({ split: true, roles: { group: 'B', private: null } }, 'private'), null);
  assert.equal(resolveRole({ split: true, roles: { group: null, private: 'A' } }, 'group'), null);
});

test('旧格式 {role, mode}：split 视为 false，行为与升级前一致', () => {
  const legacy = normalizeRoleState({ role: '蓝莓球', mode: 'active' });
  assert.equal(legacy.split, false);
  assert.equal(resolveRole(legacy, 'group'), '蓝莓球');
  assert.equal(resolveRole(legacy, 'private'), '蓝莓球');
});

test('非法人格名（路径穿越/特殊字符）一律清洗为 null 或安全名', () => {
  assert.equal(resolveRole({ split: true, roles: { group: '../../../../Users/Public/x' } }, 'group'), 'UsersPublicx');
  assert.equal(resolveRole({ split: true, roles: { private: '..\\..\\etc' } }, 'private'), 'etc');
  assert.equal(resolveRole({ split: true, roles: { group: '' } }, 'group'), null);
  assert.equal(resolveRole({ split: true, roles: { group: '   ' } }, 'group'), null);
  assert.equal(sanitizeRoleName('猫娘-v2_x'), '猫娘-v2_x');
});

// ── 开启时展开 / 来回切保留 ────────────────────────────────────────────────

test('勾选时展开：群聊槽从共用卡起步（群聊先跟私聊卡，再单独改）', () => {
  const next = expandRoleStateOnEnable({ role: 'A', roles: { group: null, private: null } });
  assert.equal(next.split, true);
  assert.equal(next.roles.group, 'A');
  assert.equal(next.roles.private, 'A');
});

test('勾选/取消来回切：群聊槽保留不删，重新勾选即恢复', () => {
  // 勾选 → 群聊槽改成 B → 取消勾选 → 再勾选
  const enabled = expandRoleStateOnEnable({ role: 'A', roles: { group: null, private: null } });
  const withGroup = { ...enabled, roles: { group: 'B', private: 'A' } };
  const disabled = { ...withGroup, split: false };
  assert.equal(resolveRole(disabled, 'group'), 'A', '关闭时群聊回到共用卡');
  assert.equal(disabled.roles.group, 'B', '但群聊槽原样保留');
  const reEnabled = { ...disabled, split: true };
  assert.equal(resolveRole(reEnabled, 'group'), 'B', '重新勾选恢复原群聊卡');
});

test('已有槽位不被展开覆盖', () => {
  const next = expandRoleStateOnEnable({ split: false, role: 'A', roles: { group: 'B', private: 'A' } });
  assert.equal(next.roles.group, 'B', '群聊槽已设置则不动');
  assert.equal(next.roles.private, 'A');
});

// ── 会话 key → 场景 ────────────────────────────────────────────────────────

test('roleScopeOfKey：group:* 归群聊，private:* 归私聊', () => {
  assert.equal(roleScopeOfKey('group:12345'), 'group');
  assert.equal(roleScopeOfKey('private:123456789'), 'private');
  assert.equal(roleScopeOfKey(''), 'private');
});

// ── 场景小节标记 〔群聊〕/〔私聊〕，与代次标记正交 ──────────────────────────

const SCOPED_CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 公共人设。',
  '',
  '## 二、群聊铁律 〔群聊〕',
  '- 群里一句话 1~10 字。',
  '',
  '## 三、私聊铁律 〔私聊〕',
  '- 一对一可以粘人。',
  '',
  '## 四、二代群聊 〔二代·群聊〕',
  '- 只在二代+群聊注入。',
  '',
  '## 五、一代私聊 〔私聊/一代〕',
  '- 只在一代+私聊注入。',
].join('\n');

test('场景标记：群聊只注入群聊小节，私聊只注入私聊小节，公共小节都注入', () => {
  const group = selectRoleText(SCOPED_CARD, 'v2', 'group');
  const priv = selectRoleText(SCOPED_CARD, 'v2', 'private');
  for (const text of [group, priv]) assert.match(text, /公共人设/);
  assert.match(group, /一句话 1~10 字/);
  assert.doesNotMatch(group, /可以粘人/);
  assert.match(priv, /可以粘人/);
  assert.doesNotMatch(priv, /一句话 1~10 字/);
});

test('组合标记 〔二代·群聊〕〔私聊/一代〕：代次 × 场景同时满足才注入', () => {
  assert.match(selectRoleText(SCOPED_CARD, 'v2', 'group'), /二代\+群聊/);
  assert.doesNotMatch(selectRoleText(SCOPED_CARD, 'v2', 'private'), /二代\+群聊/);
  assert.doesNotMatch(selectRoleText(SCOPED_CARD, 'v1', 'group'), /二代\+群聊/);
  assert.match(selectRoleText(SCOPED_CARD, 'v1', 'private'), /一代\+私聊/);
  assert.doesNotMatch(selectRoleText(SCOPED_CARD, 'v1', 'group'), /一代\+私聊/);
});

test('场景标记在注入文本里被剥掉，标题保留且干净', () => {
  const group = selectRoleText(SCOPED_CARD, 'v2', 'group');
  assert.doesNotMatch(group, /〔|】|\[v|群聊〕/);
  assert.match(group, /## 二、群聊铁律\n/);
});

test('不传 scope = 不按场景过滤（旧调用方兼容）', () => {
  const all = selectRoleText(SCOPED_CARD, 'v2');
  assert.match(all, /一句话 1~10 字/);
  assert.match(all, /可以粘人/);
});

test('旧卡（无场景标记）：任何场景都完整注入', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇';
  assert.equal(selectRoleText(legacy, 'v2', 'group'), legacy);
  assert.equal(selectRoleText(legacy, 'v2', 'private'), legacy);
});

test('roleCharStats 四象限：v2Group/v2Private 各自统计', () => {
  const stats = roleCharStats(SCOPED_CARD);
  assert.ok(stats.v2Group > 0 && stats.v2Private > 0);
  assert.ok(stats.groupOnly > 0 && stats.privateOnly > 0);
  assert.equal(stats.hasScopeTags, true);
  assert.notEqual(stats.v2Group, stats.v2Private, '群/私专属内容不同，长度不应相等');
});

// ── front-matter（锚点随卡，严格识别） ─────────────────────────────────────

test('front-matter：识别 scope 与 anchors，正文不含元数据', () => {
  const card = [
    '---',
    'scope: private',
    'anchors:',
    '  speechFeatures: [软萌, 爱用叠词]',
    '  redLines: [不冒充真人, 不泄露隐私]',
    '---',
    '# 角色卡：蓝莓球',
    '',
    '## 一、你是谁',
    '- 正文内容。',
  ].join('\n');
  const parsed = parseRoleCard(card);
  assert.equal(parsed.hasMeta, true);
  assert.equal(parsed.meta.scope, 'private');
  assert.deepEqual(parsed.meta.anchors.speechFeatures, ['软萌', '爱用叠词']);
  assert.deepEqual(parsed.meta.anchors.redLines, ['不冒充真人', '不泄露隐私']);
  assert.match(parsed.body, /正文内容/);
  assert.doesNotMatch(parsed.body, /speechFeatures/);
  assert.doesNotMatch(selectRoleText(card, 'v2', 'private'), /anchors|---/);
});

test('front-matter 严格识别：非对象 YAML / 无闭合 / 首行不是 --- 一律按正文', () => {
  // 首行不是 ---
  assert.equal(parseRoleCard('# 角色卡\n---\nscope: group\n---\n正文').hasMeta, false);
  // 无闭合 ---
  assert.equal(parseRoleCard('---\nscope: group\n正文').hasMeta, false);
  // YAML 是标量不是对象
  assert.equal(parseRoleCard('---\nhello\n---\n正文').hasMeta, false);
  // 正文里的水平线不误伤
  const hr = '# 卡\n\n---\n\n正文';
  const p = parseRoleCard(hr);
  assert.equal(p.hasMeta, false);
  assert.equal(p.body, hr);
});

test('front-matter：scope 可选且不强制（缺省 both），anchors 只认字符串数组', () => {
  const parsed = parseRoleCard('---\nanchors:\n  speechFeatures: [元气]\n---\n正文');
  assert.equal(parsed.meta.scope, 'both');
  assert.deepEqual(parsed.meta.anchors.speechFeatures, ['元气']);
  assert.deepEqual(parsed.meta.anchors.redLines, []);
  const noAnchors = parseRoleCard('---\nscope: group\n---\n正文');
  assert.equal(noAnchors.meta.scope, 'group');
  assert.equal(noAnchors.meta.anchors, null);
});

test('roleCharStats：front-matter 不占正文统计（metaChars 单列）', () => {
  const card = '---\nscope: private\n---\n# 卡\n- 正文';
  const stats = roleCharStats(card);
  assert.ok(stats.metaChars > 0);
  assert.ok(stats.total <= '卡\n- 正文'.length + 10, 'total 只算正文');
  assert.equal(stats.hasMeta, true);
});
