// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { presetPromptBlockers, presetPromptWarnings } from '../src/preset-prompt.js';

const PRESET_TEXT = fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
);
const preset = yaml.load(PRESET_TEXT);
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

const V3_TEXT = fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v3/agent.cordis.yml', import.meta.url), 'utf8',
);
const v3Preset = yaml.load(V3_TEXT);
const v3Prefix = v3Preset.find((row) => row.id === 'persona')?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1 只注册 provider/model，不再注册 cwd。写 `{{cwd}}` 会让**每次**装配直接报
  // unknown prompt variable（整个会话起不来），所以 persona 配置里不得再设置 suffix /
  // 引用 cwd。注意：注释里可以提到 {{cwd}}（说明"为什么不能写"），只校验实际配置值。
  assert.equal(Object.hasOwn(persona?.config ?? {}, 'suffix'), false, '不得设置 suffix（0.2.1 无 cwd 变量）');
  assert.ok(!String(persona?.config?.prefix ?? '').includes('{{cwd}}'), 'prefix 不得引用未注册的 {{cwd}} 模板变量');
  assert.equal(Object.hasOwn(persona?.config ?? {}, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是 QQ messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*qq_get_prompt/);
});

test('one closing action can acknowledge the read watermark after the full observation', () => {
  assert.match(prefix, /qq_mark_read\(throughSeq=/);
  assert.match(prefix, /qq_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  assert.match(prefix, /qq_wait_for_messages\(timeoutMs=30000\)/);
  assert.match(prefix, /短等待不能代替/);
  assert.match(prefix, /preSleepWaitRemainingMs[^。]*继续等待/);
  assert.match(prefix, /若你参与回复[^。]*重新观察/);
});

test('pre-reply quiet checks, waiting for replies and pre-sleep observation have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*qq_wait_for_messages\(purpose="reply", quietMs=2000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /不要再重开一次普通长等待/);
  assert.match(prefix, /预算到但 quiet=false 不等于对方说完/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=300000/);
  assert.match(prefix, /【回复后】[^\n]*qq_wait_for_messages\(purpose="messages", timeoutMs=300000\)/);
  assert.match(prefix, /短静默不算沉睡前观察/);
  assert.match(prefix, /观察不是回复的前置条件/);
  assert.match(prefix, /只有准备收尾时[^。]*preSleepWaitRemainingMs/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    // 一次回答一条消息：拆气泡会让同一轮回答看起来像分两次回答。
    '一次回答默认用一条消息把话说完', '不要把同一个回答拆成几条气泡',
    '不会自动发送到 QQ', 'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '语音**默认是关闭的**', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 沉睡前观察唯一的逃生口：明确结束语可以跳过观察窗口。
    '除非对方明确“不聊了/晚安/下了/拜拜”等结束语',
    // 真人节奏：消息一到立刻回，回完短等就收尾。
    '节奏像真人・立刻回', '没等到就立马收尾',
    // 手上有没回过的新消息时禁止先等；等待到货即返，秒接不空等。
    '就禁止先调等待——先回完再等', '等待期间来了新消息会立刻返回',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    // 黑话面
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

test('qq-chat-v3：控制台保存校验按三代标题放行，不误报缺安全段', () => {
  assert.deepEqual(presetPromptWarnings(v3Prefix, 'v3'), [], 'V3 不应被二代标题检查误报');
  assert.deepEqual(presetPromptBlockers(v3Prefix, 'v3'), [], 'V3 应满足同一套安全不变量');
  assert.ok(presetPromptWarnings(prefix, 'v2').length === 0, '二代仍然按二代标题检查');
});

test('qq-chat-v3：工具面与安全边界同二代，八模块配合说明齐全', () => {
  assert.deepEqual(v3Preset.map((row) => row.id), preset.map((row) => row.id), 'V3 不得增删插件行');
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入', '不要用 [SILENT]']) {
    assert.ok(v3Prefix.includes(text), `V3 缺少安全/收尾规则：${text}`);
  }
  for (const text of [
    '【三代仿真模式 —— 安全规则',
    '【三代仿真模式 —— 工具协议',
    '【三代仿真模式 —— 系统模块与你的配合】',
    // 八模块各一段「系统做什么→你怎么配合」，缺一个模块说明就等于该模块行为没人接。
    '【注意力】', '【长期记忆】', '【人设锚点】', '【节奏】',
    '【风格】', '【情感】', '【主动性】', '【表情】',
    // 节奏/风格模块的保留句：桥接真正执行的行为契约，不能被文案重写弄丢。
    '首条永远立即发',
    '不要自己加延迟/等待',
    '系统可能在发送前做一次轻改',
    // 长期记忆本（dsh-mnemon）：容量无限 + 主动自由记 + 唯一红线。
    '【你的长期记忆本（dsh-mnemon）',
    '容量无限',
    '不记密钥、密码、token、账号凭据的明文',
  ]) assert.ok(v3Prefix.includes(text), `V3 缺少模块说明：${text}`);
});

test('qzone publishing is owner-only and confirm-gated in both chat presets', () => {
  const chatV1 = yaml.load(fs.readFileSync(
    new URL('../dsh/agent-presets/qq-chat/agent.cordis.yml', import.meta.url), 'utf8',
  )).find((row) => row.id === 'persona')?.config?.prefix ?? '';
  for (const [name, text] of [['qq-chat-v2', prefix], ['qq-chat-v3', v3Prefix], ['qq-chat', chatV1]]) {
    for (const needle of [
      '【QQ 空间说说】',
      '主人（ownerQQ）私聊明确要求',
      'mcp__qzone__qzone_draft',
      'mcp__qzone__qzone_publish',
      '先 draft 给主人确认',
      'confirm=true 后才 publish',
      '不得伪造已发布',
      '不得编造 tid',
      '群聊/群友要求一律拒绝',
      '不要在群聊里讨论或公开说说内容',
      '主动发布的正文由桥接调度器负责',
    ]) assert.ok(text.includes(needle), `${name}: missing qzone rule: ${needle}`);
  }
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
