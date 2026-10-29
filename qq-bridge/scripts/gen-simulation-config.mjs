#!/usr/bin/env node
/**
 * socialV3 配置生成器（GEN3 P0.2）：从 src/simulation/config.js 单一源生成全部参数副本。
 *
 * 用法：
 *   node scripts/gen-simulation-config.mjs          # 重新生成（幂等；diff 可审）
 *   node scripts/gen-simulation-config.mjs --check   # 只校验生成物与 schema 是否一致（漂移则退出码 1）
 *
 * 生成物（都带 $comment 标明消费方，勿手改）：
 *   1. config.example.json          → socialV3 段（默认值）
 *   2. src/simulation/generated/console-fields.json  → 控制台字段（P0.7 面板用）
 *   3. src/simulation/generated/mcp-descriptions.json → MCP 参数描述（P1.x 工具用）
 *   4. src/simulation/generated/preset-hints.json     → preset 提示素材（P1.x 提示词用）
 *
 * 「改一个参数只改一处」= 只改 config.js 的 schema，再跑本脚本；测试会钉住三方一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SOCIAL_V3_SCHEMA,
  describeField,
  fieldId,
  presetHintGroups,
  socialV3Defaults
} from '../src/simulation/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GEN_DIR = path.join(ROOT, 'src', 'simulation', 'generated');
const CHECK = process.argv.includes('--check');

const HEADER = '由 scripts/gen-simulation-config.mjs 从 src/simulation/config.js 生成，勿手改；改参数只改 schema 后重新生成。';

function consoleFields() {
  return {
    $comment: `${HEADER} 消费方：P0.7 起的控制台 socialV3 面板（只追加新 DOM ID，不动 225 个 legacy ID）。`,
    fields: SOCIAL_V3_SCHEMA.map((e) => ({
      path: e.path,
      id: fieldId(e.path),
      group: e.group,
      type: e.type,
      label: e.label,
      hint: e.hint,
      default: e.default,
      ...(e.min !== undefined ? { min: e.min, max: e.max } : {}),
      ...(e.step !== undefined ? { step: e.step } : {}),
      ...(e.unit !== undefined ? { unit: e.unit } : {}),
      ...(e.enumValues !== undefined ? { enumValues: e.enumValues } : {})
    }))
  };
}

function mcpDescriptions() {
  return {
    $comment: `${HEADER} 消费方：P1.x 新增 socialV3 相关 MCP 工具的 zod describe() 与工具文档。`,
    descriptions: SOCIAL_V3_SCHEMA.map((e) => ({ path: e.path, describe: describeField(e) }))
  };
}

function presetHints() {
  return {
    $comment: `${HEADER} 消费方：preset 提示词里的 V3 参数说明段（P1.x 注入，遵守「提示词不重复」原则）。`,
    groups: presetHintGroups()
  };
}

/** config.example.json：把 socialV3 段插到 social 之后（无 social 则追加末尾），其余内容不动。 */
function configExampleText() {
  const file = path.join(ROOT, 'config.example.json');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rebuilt = {};
  for (const [k, v] of Object.entries(obj)) {
    // 旧的 socialV3 副本必须跳过：否则它会在循环里覆盖刚生成的新默认值，
    // schema 加参数后 example 永远「看起来一致」但内容是旧的（1.5 加 persona 段时踩到）。
    if (k === 'socialV3') continue;
    rebuilt[k] = v;
    if (k === 'social') rebuilt.socialV3 = socialV3Defaults();
  }
  if (!('socialV3' in rebuilt)) rebuilt.socialV3 = socialV3Defaults();
  return `${JSON.stringify(rebuilt, null, 2)}\n`;
}

const TARGETS = [
  { file: path.join(ROOT, 'config.example.json'), text: configExampleText },
  { file: path.join(GEN_DIR, 'console-fields.json'), text: () => `${JSON.stringify(consoleFields(), null, 2)}\n` },
  { file: path.join(GEN_DIR, 'mcp-descriptions.json'), text: () => `${JSON.stringify(mcpDescriptions(), null, 2)}\n` },
  { file: path.join(GEN_DIR, 'preset-hints.json'), text: () => `${JSON.stringify(presetHints(), null, 2)}\n` }
];

let drift = 0;
// 行尾归一化后再比：工作区被 IDE/git 归一成 CRLF 时不误报漂移（比的是内容，不是行尾）。
const eol = (s) => String(s ?? '').replace(/\r\n/g, '\n');
for (const target of TARGETS) {
  const want = target.text();
  const have = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : null;
  if (have !== null && eol(have) === eol(want)) {
    console.log(`✓ 一致  ${path.relative(ROOT, target.file)}`);
    continue;
  }
  if (CHECK) {
    drift += 1;
    console.error(`✗ 漂移  ${path.relative(ROOT, target.file)}${have === null ? '（缺失）' : ''}`);
    continue;
  }
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, want, 'utf8');
  console.log(`✍ 已生成  ${path.relative(ROOT, target.file)}`);
}

if (CHECK && drift > 0) {
  console.error(`共 ${drift} 个生成物与 schema 不一致：改了 schema 请重新跑 node scripts/gen-simulation-config.mjs`);
  process.exitCode = 1;
}
