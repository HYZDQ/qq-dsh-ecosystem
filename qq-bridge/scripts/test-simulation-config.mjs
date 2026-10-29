// GEN3 P0.2 配置单一源契约：schema ↔ 生成物 ↔ config.example 默认值 三方一致，
// 归一化钳制正确，生成器幂等。任何「改了参数忘了重新生成」或「生成物被手改」都会在这里报红。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SOCIAL_V3_SCHEMA,
  describeField,
  fieldId,
  normalizeSocialV3,
  presetHintGroups,
  socialV3Defaults
} from '../src/simulation/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GEN = path.join(ROOT, 'src', 'simulation', 'generated');
const GEN_SCRIPT = path.join(HERE, 'gen-simulation-config.mjs');

test('schema 自身合法：路径唯一、类型已知、默认值在范围内、说明非空', () => {
  const types = new Set(['boolean', 'number', 'int', 'string', 'enum', 'string[]']);
  const paths = new Set();
  const ids = new Set();
  for (const e of SOCIAL_V3_SCHEMA) {
    assert.ok(!paths.has(e.path), `路径重复：${e.path}`);
    paths.add(e.path);
    assert.ok(types.has(e.type), `未知类型：${e.path}=${e.type}`);
    assert.ok(e.label && e.label.length >= 2, `缺 label：${e.path}`);
    assert.ok(e.hint && e.hint.length >= 6, `缺 hint：${e.path}`);
    // 控制台每个字段的说明都必须「用途 + 调法 + 例子」，且别长到把面板撑爆
    for (const part of ['用途：', '调法：', '例：']) {
      assert.ok(e.hint.includes(part), `说明缺少「${part}」：${e.path}`);
    }
    assert.ok(e.hint.length <= 160, `说明过长（${e.hint.length} 字）：${e.path}`);
    assert.ok(e.group, `缺 group：${e.path}`);
    const id = fieldId(e.path);
    assert.ok(!ids.has(id), `DOM id 撞车：${id}`);
    ids.add(id);
    if (e.type === 'enum') assert.ok(e.enumValues.includes(e.default), `enum 默认值非法：${e.path}`);
    if (e.type === 'number' || e.type === 'int') {
      assert.ok(e.min <= e.default && e.default <= e.max, `默认值越界：${e.path}`);
      assert.ok(e.min < e.max, `范围非法：${e.path}`);
    }
    if (e.path === 'memory.consolidateAt') assert.match(e.default, /^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM 格式');
    if (e.path === 'modules.rhythm') assert.equal(e.default, false, '模块默认全关');
  }
  // 已移除的「假旋钮」不得回到 schema（无法接线 / 与硬约束冲突的参数）
  for (const removed of [
    'memory.poisonGuard',
    'memory.fallbackJson',
    'memory.extractEveryTurns',
    'memory.dailyTokenBudget',
    'rhythm.firstBubbleDelayMs'
  ]) {
    assert.ok(!SOCIAL_V3_SCHEMA.some((e) => e.path === removed), `已移除参数不得回到 schema：${removed}`);
  }
});

test('socialV3Defaults：与 schema 路径一一对应，无缺无多', () => {
  const defaults = socialV3Defaults();
  const flat = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      else flat.push(p);
    }
  };
  walk(defaults, '');
  assert.deepEqual(flat.sort(), SOCIAL_V3_SCHEMA.map((e) => e.path).sort());
  // 深克隆：改返回值不污染 schema
  defaults.modules.rhythm = true;
  assert.equal(socialV3Defaults().modules.rhythm, false);
});

test('normalizeSocialV3：类型收敛、范围钳制、跨字段约束、未知键上报', () => {
  const { value, unknown } = normalizeSocialV3({
    attention: { speakThreshold: 0.5, silentThreshold: 2 },
    rhythm: { cpmMin: 80, cpmMax: 20, maxBubbles: 99 },
    mode: 'not-a-mode',
    memory: { consolidateAt: '25:99', namespace: ' v3-test ' },
    canaryGroups: ['group:1', 'group:1', '', 'group:2'],
    enabled: 1,
    futureThing: { xyz: 1 }
  });
  assert.equal(value.attention.speakThreshold, 0.5);
  assert.equal(value.attention.silentThreshold, 0.5, 'silent 越过 speak 时被拉回');
  assert.equal(normalizeSocialV3({ attention: { speakThreshold: 2 } }).value.attention.speakThreshold, 1, '越界钳到 max');
  assert.equal(value.rhythm.cpmMax, 80, 'cpmMax < cpmMin 时对齐');
  assert.equal(value.rhythm.maxBubbles, 10, 'maxBubbles 越界钳到 max');
  assert.equal(value.mode, 'shadow', '非法 enum 回默认');
  assert.equal(value.memory.consolidateAt, '04:30', '非法 HH:MM 回默认');
  assert.equal(value.memory.namespace, 'v3-test', '字符串 trim');
  assert.deepEqual(value.canaryGroups, ['group:1', 'group:2'], '数组去空去重');
  assert.equal(value.enabled, false, '非布尔值（1）不作数，回默认');
  assert.deepEqual(unknown, ['futureThing.xyz'], '未知键上报不静默吞');
});

test('生成物与 schema 一致：generator --check 通过且幂等', () => {
  const check = spawnSync(process.execPath, [GEN_SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, `生成物漂移：${check.stdout}${check.stderr}`);
  // 再跑一次生成（幂等）：--check 必须仍然通过
  const regen = spawnSync(process.execPath, [GEN_SCRIPT], { encoding: 'utf8' });
  assert.equal(regen.status, 0);
  const recheck = spawnSync(process.execPath, [GEN_SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(recheck.status, 0, '生成器必须幂等');
});

test('config.example.json 的 socialV3 段 = schema 默认值', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.deepEqual(example.socialV3, socialV3Defaults());
});

test('生成物覆盖完整：每个参数恰出现一次，console id 与 schema 对应', () => {
  const consoleFields = JSON.parse(fs.readFileSync(path.join(GEN, 'console-fields.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(GEN, 'mcp-descriptions.json'), 'utf8'));
  const hints = JSON.parse(fs.readFileSync(path.join(GEN, 'preset-hints.json'), 'utf8'));
  const paths = SOCIAL_V3_SCHEMA.map((e) => e.path).sort();
  assert.deepEqual(consoleFields.fields.map((f) => f.path).sort(), paths);
  assert.deepEqual(mcp.descriptions.map((d) => d.path).sort(), paths);
  for (const f of consoleFields.fields) {
    assert.equal(f.id, fieldId(f.path), `console id 与 schema 不一致：${f.path}`);
    assert.ok(f.label && f.hint);
  }
  for (const d of mcp.descriptions) {
    assert.equal(d.describe, describeField(SOCIAL_V3_SCHEMA.find((e) => e.path === d.path)));
  }
  // preset 提示：分组行数总和 = 参数数（每参数恰一行）
  const hintLineCount = hints.groups.reduce((n, g) => n + g.lines.length, 0);
  assert.equal(hintLineCount, SOCIAL_V3_SCHEMA.length);
  assert.equal(presetHintGroups().length, hints.groups.length);
  // 「改一个参数只改一处」的抓手：默认值在 console 生成物里逐参数可对上
  for (const e of SOCIAL_V3_SCHEMA) {
    const f = consoleFields.fields.find((x) => x.path === e.path);
    assert.deepEqual(f.default, e.default, `生成物默认值漂移：${e.path}`);
  }
});
