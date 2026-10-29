// privacy-scan 的误报白名单回归（GEN3 收尾）：
// ① 「文件 + 规则名」粒度的匹配语义（只放行这一条规则，其它规则照旧）；
// ② 内置白名单条目精确（不许退化成整文件放行）；
// ③ 真实跑一遍扫描器：闸门必须是绿的（findings 为空、退出码 0）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { globToRe, matchesAllow } from './privacy-allow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, 'privacy-scan.mjs');
const RULE_PATH = '本机绝对路径（非系统盘的顶层目录）';
const RULE_ENTROPY = '疑似令牌/密钥（高熵串）';

test('globToRe：`*` 不跨目录、`**` 跨目录', () => {
  assert.ok(globToRe('src/simulation/generated/*.json').test('src/simulation/generated/console-fields.json'));
  assert.ok(!globToRe('src/simulation/generated/*.json').test('src/simulation/generated/sub/a.json'), '单个 * 不跨目录');
  assert.ok(globToRe('src/**/*.json').test('src/simulation/generated/a.json'), '** 跨目录');
});

test('matchesAllow：字符串条目 = 整文件放行（旧 allowPaths 语义）', () => {
  assert.equal(matchesAllow(['scripts/test-'], 'scripts/test-x.mjs', RULE_PATH), true, '前缀语义');
  assert.equal(matchesAllow(['scripts/test-'], 'src/bridge.js', RULE_PATH), false);
  assert.equal(matchesAllow([], 'any.js', RULE_PATH), false, '空名单不放行');
});

test('matchesAllow：{path,rule} 只放行指定规则，其它规则照旧命中', () => {
  const entries = [{ path: 'docs/guides/QZONE.md', rule: RULE_PATH }];
  assert.equal(matchesAllow(entries, 'docs/guides/QZONE.md', RULE_PATH), true);
  assert.equal(matchesAllow(entries, 'docs/guides/QZONE.md', RULE_ENTROPY), false, '别的规则必须照查');
  assert.equal(matchesAllow(entries, 'docs/guides/OTHER.md', RULE_PATH), false, '别的文件不放行');
});

test('matchesAllow：规则名支持 `*` 结尾的前缀匹配，path 支持 glob', () => {
  assert.equal(matchesAllow([{ path: 'src/simulation/generated/*.json', rule: '疑似令牌*' }],
    'src/simulation/generated/console-fields.json', RULE_ENTROPY), true);
  assert.equal(matchesAllow([{ path: 'src/simulation/generated/*.json', rule: '疑似令牌密钥*' }],
    'src/simulation/generated/console-fields.json', RULE_ENTROPY), false, '前缀不匹配就是不放行');
  assert.equal(matchesAllow([{ path: 'a/*.json', rule: 'x' }], 'b/a.json', 'x'), false, 'glob 从仓库根整体匹配');
});

test('内置白名单：三条误报按「文件 + 规则」精确放行，且未退化成整文件放行', () => {
  const src = fsRead(SCAN);
  for (const needle of [
    `{ path: 'docs/guides/QZONE.md', rule: '${RULE_PATH}' }`,
    `{ path: 'local/start-all.ps1', rule: '${RULE_PATH}' }`,
    `{ path: 'src/simulation/generated/*.json', rule: '${RULE_ENTROPY}' }`
  ]) assert.ok(src.includes(needle), `缺少精确白名单条目：${needle}`);
  // allowPaths（整文件放行）里不许出现这三个文件——否则就是过度放行
  const allowPathsBlock = src.slice(src.indexOf('allowPaths: ['), src.indexOf('// 误报白名单'));
  for (const bad of ['docs/guides/QZONE.md', 'local/start-all.ps1', 'src/simulation/generated/']) {
    assert.ok(!allowPathsBlock.includes(bad), `allowPaths 不应整文件放行：${bad}`);
  }
});

test('真实扫描：findings 为空且退出码 0（闸门可用）', () => {
  const run = spawnSync(process.execPath, [SCAN, '--json'], { cwd: path.resolve(HERE, '..'), encoding: 'utf8' });
  assert.equal(run.status, 0, `扫描未通过：${run.stdout}${run.stderr}`);
  const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
  assert.deepEqual(report.findings, [], `仍有命中：${JSON.stringify(report.findings)}`);
  assert.ok(report.scanned > 100, `扫描文件数异常：${report.scanned}`);
});

function fsRead(file) {
  return fs.readFileSync(file, 'utf8');
}
