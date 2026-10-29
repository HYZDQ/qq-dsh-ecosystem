#!/usr/bin/env node
/**
 * GEN3 P1.6 评估衔接：把 trace 里的注意力 shadow/gate 决策转成 eval 可用的 predictions JSONL。
 *
 * trace.attention.forSampleIds 与语料 sample id 同源（sampleId()），按 id 精确对齐：
 *   每个样本取「最新一条覆盖它的决策」作为预测（shadow=规则预测；gate=拦下即 silent 预测）。
 * 用法：
 *   node scripts/simulation-trace-to-predictions.mjs [--trace <file>] [--out <file>] [--min-turns 500]
 *   （产出后：node scripts/simulation-eval.mjs --corpus ... --predictions <out> --strict）
 *   --min-turns：shadow 轮数不足时以 1 退出（P1.6 验收要求 ≥500 轮）；同时写一份
 *   `<out>.meta.json` 给 eval 读轮数，strict 模式据此拦下「数据不够就宣布通过」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = {
    trace: null,
    out: path.join(ROOT, 'state', 'simulation-eval', 'predictions.jsonl'),
    minTurns: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--trace') args.trace = path.resolve(argv[++i] ?? '');
    else if (a === '--out') args.out = path.resolve(argv[++i] ?? '');
    else if (a === '--min-turns') args.minTurns = Math.max(0, Number(argv[++i]) || 0);
  }
  return args;
}

/** 默认 trace：state/ 下最近一份 simulation-trace-*.jsonl。 */
function latestTrace() {
  const dir = path.join(ROOT, 'state');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^simulation-trace-.*\.jsonl$/.test(f)).sort()
    : [];
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const traceFile = args.trace || latestTrace();
  if (!traceFile || !fs.existsSync(traceFile)) {
    console.error('找不到 trace 文件（先让桥接跑几轮，或用 --trace 指定）');
    process.exitCode = 1;
    return;
  }
  const bySample = new Map();
  const turnIds = new Set();
  for (const line of fs.readFileSync(traceFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    const att = rec.attention;
    if (!att || !Array.isArray(att.forSampleIds)) continue;
    if (rec.turnId != null) turnIds.add(String(rec.turnId));
    for (const id of att.forSampleIds) {
      bySample.set(id, {
        id,
        addressee: att.predictedAddressee ?? null,
        speakSilent: att.predictedSpeakSilent ?? (att.predictedAction === 'silent' ? 'silent' : 'speak'),
        source: att.source ?? null
      });
    }
  }
  const out = [...bySample.values()];
  const shadowTurns = turnIds.size;
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${out.map((p) => JSON.stringify(p)).join('\n')}${out.length ? '\n' : ''}`, 'utf8');
  // 伴随元数据：eval strict 用 shadowTurns 拦「轮数不够就宣布通过」
  const meta = {
    $comment: 'GEN3 P1.6 predictions 元数据（本地，state/ 不入库）',
    predictions: path.basename(args.out),
    sourceTrace: path.basename(traceFile),
    shadowTurns,
    sampleCount: out.length
  };
  fs.writeFileSync(`${args.out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(`预测转换完成：${out.length} 条（shadow ${shadowTurns} 轮，源 ${path.basename(traceFile)}）→ ${args.out}`);
  if (args.minTurns > 0 && shadowTurns < args.minTurns) {
    console.error(`❌ shadow 轮数不足：${shadowTurns} < ${args.minTurns}（先积累更多影子回合）`);
    process.exitCode = 1;
  }
}

main();
