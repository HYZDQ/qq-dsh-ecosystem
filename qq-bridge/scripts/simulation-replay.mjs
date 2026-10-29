#!/usr/bin/env node
/**
 * 三代仿真离线回放（GEN3 P0.1）：用 fake model 回放合成对话，产出 trace 并做确定性校验。
 *
 * 硬性约束（docs/design/GEN3_SIMULATION_PLAN.md P0.1 验收）：
 *   · **不访问真实 QQ / DSH / 任何网络**——本脚本只用 node:fs/path/os/child_process 标准库，
 *     fake model 就是 fixture 里的 modelReply 字段（确定性、零联网）；
 *   · 语料是合成数据（scripts/fixtures/simulation-replay-fixture.jsonl），可随仓库公开；
 *     真实语料只在本机评估用，按 PRIVACY 口径不入库。
 *
 * 用法：
 *   node scripts/simulation-replay.mjs                        # 默认 fixture 回放到 state/simulation-replay/
 *   node scripts/simulation-replay.mjs --fixture <path>       # 指定合成语料（JSONL）
 *   node scripts/simulation-replay.mjs --out <dir>            # 指定输出目录
 *   node scripts/simulation-replay.mjs --check               # 跑两遍比对输出，确定性回归（退出码 0/1）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTurnRecord, createTraceWriter, snapshotPrompt } from '../src/simulation/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_FIXTURE = path.join(HERE, 'fixtures', 'simulation-replay-fixture.jsonl');
const DEFAULT_OUT = path.join(ROOT, 'state', 'simulation-replay');

function parseArgs(argv) {
  const args = { fixture: DEFAULT_FIXTURE, out: DEFAULT_OUT, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fixture') args.fixture = path.resolve(argv[++i] ?? '');
    else if (a === '--out') args.out = path.resolve(argv[++i] ?? '');
    else if (a === '--check') args.check = true;
  }
  return args;
}

/** 读 JSONL 语料：每行一个回合，字段见 fixture 文件头注释（turn/key/wakeReason/promptText/modelReply/send）。 */
function loadFixture(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, i) => {
      const row = JSON.parse(line);
      if (!row.promptText) throw new Error(`fixture 第 ${i + 1} 行缺 promptText`);
      return row;
    });
}

/**
 * 跑一遍回放：fake model = 直接取 fixture 的 modelReply（不做任何模型调用），
 * 用与线上同构的构建函数产出 trace 记录（turnId/ts 由 fixture 派生，保证确定性）。
 */
function replayOnce(rows, outDir) {
  const BASE_TS = Date.parse('2026-01-01T00:00:00.000Z');
  const writer = createTraceWriter({ dir: outDir, now: () => new Date(BASE_TS) });
  const written = [];
  rows.forEach((row, i) => {
    const snapshot = snapshotPrompt(row.promptText);
    const record = buildTurnRecord({
      turnId: `t_fix_${String(i + 1).padStart(3, '0')}`,
      ts: new Date(BASE_TS + i * 1000).toISOString(),
      durationMs: 1000 + i,
      key: row.key,
      wakeReason: row.wakeReason,
      promptSnapshot: snapshot,
      outcome: 'completed',
      send: row.send ?? null,
      textChars: String(row.modelReply ?? '').length
    });
    written.push(writer.write(record, new Date(BASE_TS)));
  });
  return written;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadFixture(args.fixture);
  if (args.check) {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-replay-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-replay-b-'));
    replayOnce(rows, dirA);
    replayOnce(rows, dirB);
    const fileA = fs.readdirSync(dirA).sort();
    const fileB = fs.readdirSync(dirB).sort();
    const same = JSON.stringify(fileA) === JSON.stringify(fileB) && fileA.every((f, i) => (
      fs.readFileSync(path.join(dirA, f), 'utf8') === fs.readFileSync(path.join(dirB, fileB[i]), 'utf8')
    ));
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
    if (!same) {
      console.error('❌ 两次回放输出不一致（非确定性）');
      process.exitCode = 1;
      return;
    }
    console.log(`✅ 确定性校验通过：${rows.length} 回合两次输出逐字节一致`);
    return;
  }
  const written = replayOnce(rows, args.out);
  console.log(`回放完成：${rows.length} 回合 → ${written[0] ?? args.out}`);
  // 可读摘要：只展示结构信息（trace 本身不含正文）。
  for (const file of [...new Set(written)]) {
    const writer = createTraceWriter({ dir: path.dirname(file) });
    for (const rec of writer.read(new Date(Date.parse('2026-01-01T00:00:00.000Z')))) {
      const segs = (rec.promptSnapshot?.segments ?? []).map((s) => s.name).join(' / ');
      console.log(`  ${rec.turnId}  ${rec.key ?? '-'}  wake=${rec.wakeReason ?? '-'}  段[${rec.promptSnapshot?.segmentCount ?? 0}]: ${segs}  send=${rec.send ? `${rec.send.attempted}/${rec.send.ok}` : '-'}`);
    }
  }
}

main();
