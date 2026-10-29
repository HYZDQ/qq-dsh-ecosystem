// prompt.js：prompt 构建 + 模型输出解析（JSON / 代码块 / 坏 JSON 兜底）+ 字数规整。
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  countDiaryChars,
  cleanDiaryText,
  truncateAtSentence,
  normalizeDiary,
  normalizeSummary,
  firstSentence,
  extractJsonObject,
  recoverJsonStringField,
  parseDiaryResponse,
  truncateRoleText,
  buildPrompts
} from '../src/prompt.js';
import { cleanupTempRoots, diaryText, diaryJson, FIXED_TODAY, DEFAULT_ROLE, DEFAULT_ROLE_TEXT, DEFAULT_SUMMARY } from './helpers.js';

after(cleanupTempRoots);

describe('countDiaryChars / cleanDiaryText', () => {
  test('按码点计数并去掉所有空白', () => {
    assert.equal(countDiaryChars('今天 很好'), 4);
    assert.equal(countDiaryChars('a b\n\tc'), 3);
    assert.equal(countDiaryChars(''), 0);
    assert.equal(countDiaryChars('😀😀'), 2);
  });

  test('清洗 markdown / 标题 / 列表 / 首尾引号', () => {
    assert.equal(cleanDiaryText('**加粗**\n# 标题\n- 列表'), '加粗\n标题\n列表');
    assert.equal(cleanDiaryText('“今天很好。”'), '今天很好。');
    assert.equal(cleanDiaryText('```json\n今天很好。\n```'), '今天很好。');
    assert.equal(cleanDiaryText('日记：今天很好。'), '今天很好。');
  });

  test('truncateAtSentence：优先句子边界，超长时硬切', () => {
    assert.equal(truncateAtSentence('第一句。第二句。第三句。', 8), '第一句。第二句。');
    assert.equal(truncateAtSentence('短句', 10), '短句');
    assert.equal(truncateAtSentence('没有标点的一长串文字', 5), '没有标点的');
  });
});

describe('normalizeDiary / normalizeSummary / firstSentence', () => {
  test('超长日记按句边界截断到 maxChars 以内并 warning', () => {
    const long = diaryText(1200);
    const result = normalizeDiary(long, { minChars: 200, maxChars: 400 });
    assert.ok(result.chars <= 400, `chars=${result.chars}`);
    assert.ok(result.chars >= 200, `chars=${result.chars}`);
    assert.ok(result.warnings.some((item) => item.includes('截断')));
  });

  test('过短日记只给 warning，不丢内容、不补写', () => {
    const result = normalizeDiary('今天很好。', { minChars: 200, maxChars: 400 });
    assert.equal(result.diary, '今天很好。');
    assert.equal(result.chars, 5);
    assert.ok(result.warnings.some((item) => item.includes('低于下限')));
  });

  test('空日记 → diary 为空 + warning', () => {
    const result = normalizeDiary('   ', { minChars: 200, maxChars: 400 });
    assert.equal(result.diary, '');
    assert.equal(result.chars, 0);
    assert.ok(result.warnings.length >= 1);
  });

  test('normalizeSummary ≤ 40 字、单行、去引号', () => {
    const long = '今天'.repeat(100);
    const result = normalizeSummary(`“${long}”`);
    assert.ok(Array.from(result.summary).length <= 40, `len=${Array.from(result.summary).length}`);
    assert.ok(result.warnings.some((item) => item.includes('截断')));

    assert.equal(normalizeSummary('  今天   很好  ').summary, '今天 很好');
    const empty = normalizeSummary('');
    assert.equal(empty.summary, '');
    assert.ok(empty.warnings.length >= 1);
  });

  test('firstSentence 取第一句并截断', () => {
    assert.equal(firstSentence('今天下雨了。心情还行。'), '今天下雨了。');
    assert.ok(Array.from(firstSentence(`${'啊'.repeat(100)}。第二句`)).length <= 40);
  });
});

describe('extractJsonObject / recoverJsonStringField', () => {
  test('优先代码块，其次首尾大括号', () => {
    const fenced = '```json\n{"diary":"x","summary":"y"}\n```';
    assert.deepEqual(extractJsonObject(fenced), { diary: 'x', summary: 'y' });
    const inline = '前言 {"diary":"x","summary":"y"} 尾巴';
    assert.deepEqual(extractJsonObject(inline), { diary: 'x', summary: 'y' });
    assert.equal(extractJsonObject('没有任何 JSON'), null);
  });

  test('截断掉右花括号时仍能救回已闭合的字符串字段', () => {
    const truncated = '{"diary":"今天下了点雨，\\n心情还行","summary":"还行';
    assert.equal(recoverJsonStringField(truncated, 'diary'), '今天下了点雨，\n心情还行');
    assert.equal(recoverJsonStringField('{"diary":"x","summary":"y"}', 'summary'), 'y');
    assert.equal(recoverJsonStringField('{"diary":"x"}', 'missing'), '');
  });

  test('字符串没闭合（max_tokens 截断）也能救回字段', () => {
    assert.equal(recoverJsonStringField('{"diary":"今天下了点雨，心情还行', 'diary'), '今天下了点雨，心情还行');
    assert.equal(recoverJsonStringField('{"diary":"第一句，\\n第二句', 'diary'), '第一句，\n第二句');
    assert.equal(recoverJsonStringField('{"summary":"只有摘要', 'diary'), '');
  });
});

describe('parseDiaryResponse 三条路径', () => {
  const diary = diaryText(300);

  test('标准 JSON → parseMode=json，diary/summary/chars 正确', () => {
    const raw = diaryJson(300, DEFAULT_SUMMARY);
    const parsed = parseDiaryResponse(raw, { minChars: 200, maxChars: 400 });
    assert.equal(parsed.parseMode, 'json');
    assert.equal(parsed.summary, DEFAULT_SUMMARY);
    assert.ok(parsed.diary.length > 0);
    assert.ok(parsed.chars >= 200 && parsed.chars <= 400);
    assert.equal(parsed.diary, diary);
  });

  test('```json 代码块包裹 → 仍按 JSON 解析', () => {
    const raw = `\`\`\`json\n${JSON.stringify({ diary, summary: '代码块摘要' })}\n\`\`\``;
    const parsed = parseDiaryResponse(raw, { minChars: 200, maxChars: 400 });
    assert.equal(parsed.parseMode, 'json');
    assert.equal(parsed.summary, '代码块摘要');
  });

  test('坏 JSON（纯文本）→ fallback：全文清洗 + 首句摘要', () => {
    const raw = '今天没什么特别的事。只是有点累，早早睡了。';
    const parsed = parseDiaryResponse(raw, { minChars: 200, maxChars: 400 });
    assert.equal(parsed.parseMode, 'fallback');
    assert.equal(parsed.diary, raw);
    assert.equal(parsed.summary, '今天没什么特别的事。');
    assert.ok(parsed.warnings.some((item) => item.includes('不是 JSON')));
  });

  test('JSON 被截断但 diary 字段闭合 → partial 救回', () => {
    const raw = `{"diary":"${diary}","summary":"被截断的摘要`;
    const parsed = parseDiaryResponse(raw, { minChars: 200, maxChars: 400 });
    assert.equal(parsed.parseMode, 'partial');
    assert.equal(parsed.diary, diary);
    assert.ok(parsed.warnings.some((item) => item.includes('救回')));
  });

  test('JSON 被截断且 diary 字符串没闭合 → partial 也能救回', () => {
    const raw = `{"diary":"${diary}`;
    const parsed = parseDiaryResponse(raw, { minChars: 200, maxChars: 400 });
    assert.equal(parsed.parseMode, 'partial');
    assert.equal(parsed.diary, diary);
    assert.ok(parsed.warnings.some((item) => item.includes('救回')));
  });

  test('JSON 合法但 diary 为空 → parseMode=json、empty:true，绝不把整段 JSON 当正文', () => {
    const raw = JSON.stringify({ diary: '', summary: '模型抽风了' });
    const parsed = parseDiaryResponse(raw, { minChars: 200, maxChars: 400 });
    assert.equal(parsed.parseMode, 'json');
    assert.equal(parsed.empty, true);
    assert.equal(parsed.diary, '');
    assert.equal(parsed.summary, '');
    assert.equal(parsed.chars, 0);
    assert.ok(parsed.warnings.length >= 1);
    assert.ok(!parsed.diary.includes('{"diary"'));
  });

  test('summary 缺失 → 用日记首句兜底并 warning', () => {
    const raw = JSON.stringify({ diary });
    const parsed = parseDiaryResponse(raw, { minChars: 200, maxChars: 400 });
    assert.equal(parsed.parseMode, 'json');
    assert.ok(parsed.summary.length > 0);
    assert.ok(parsed.warnings.some((item) => item.includes('首句兜底')));
  });

  test('空输出 → parseMode=fallback、diary 为空', () => {
    const parsed = parseDiaryResponse('', { minChars: 200, maxChars: 400 });
    assert.equal(parsed.diary, '');
    assert.equal(parsed.chars, 0);
  });
});

describe('truncateRoleText / buildPrompts', () => {
  test('人设超长截断并保留开头', () => {
    const short = truncateRoleText('短人设', 3000);
    assert.equal(short, '短人设');
    const long = `开头设定。${'填充'.repeat(3000)}`;
    const truncated = truncateRoleText(long, 200);
    assert.ok(truncated.startsWith('开头设定。'));
    assert.ok(truncated.includes('人设后文已按长度截断'));
  });

  test('system prompt 含人设 / 字数区间 / JSON 要求；user prompt 含日期与格式说明', () => {
    const prompts = buildPrompts({
      role: DEFAULT_ROLE,
      roleText: DEFAULT_ROLE_TEXT,
      dateKey: FIXED_TODAY,
      weekday: '星期五',
      contextText: '【主人私聊】\n23:00 主人: 晚安',
      contextEmpty: false,
      minDiaryChars: 200,
      maxDiaryChars: 400
    });
    assert.ok(prompts.system.includes(DEFAULT_ROLE), 'system 应包含角色名');
    assert.ok(prompts.system.includes('蓝莓球'), 'system 应包含人设正文');
    assert.ok(prompts.system.includes('200~400'), 'system 应包含字数区间');
    assert.ok(prompts.system.includes('JSON'));
    assert.ok(prompts.user.includes(FIXED_TODAY));
    assert.ok(prompts.user.includes('星期五'));
    assert.ok(prompts.user.includes('{"diary":'));
    assert.ok(prompts.user.includes('"summary"'));
    assert.ok(prompts.user.includes('200~400'));
    assert.ok(prompts.user.includes('23:00 主人: 晚安'));
  });

  test('上下文为空时 user prompt 走「平静的一天」分支', () => {
    const prompts = buildPrompts({
      role: DEFAULT_ROLE,
      roleText: '',
      dateKey: FIXED_TODAY,
      contextEmpty: true,
      minDiaryChars: 200,
      maxDiaryChars: 400
    });
    assert.ok(prompts.user.includes('平静的一天'));
    assert.ok(prompts.system.includes('没有可用的人设文件'));
  });
});
