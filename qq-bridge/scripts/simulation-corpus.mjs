#!/usr/bin/env node
/**
 * GEN3 P0.4：仿真评估语料抽取 + 自动标注 + V2 行为基线。
 *
 * 从 state/social-v2.json 的 recentMessages/unread 抽取对话样本（脱敏），每条样本：
 *   · annotation：addressee(me/other/unknown)、speakSilent、replyTo、topic、question（自动播种，
 *     标 source=auto-seed，人工修正后改 source=manual）；
 *   · baseline：V2 真实行为（这条消息后 3 条/10 分钟内 bot 有没有回、回了隔多久）——
 *     这就是 P1 指标的「分母」：同一批样本上 V2 的回复/沉默行为。
 *
 * 隐私（docs/design/GEN3_SIMULATION_PLAN.md 10.1 / 9.4）：
 *   · 输出落在 state/simulation-corpus/（state/ 已被 .gitignore 排除，**不随仓库发布**）；
 *   · userId/会话 key 哈希化（复用 trace.js 的 hashId/redactKey），QQ 号一律掩码；
 *   · 只读 state，不写回、不发消息、不联网。
 *
 * 用法：
 *   node scripts/simulation-corpus.mjs                       # 默认 state/social-v2.json → state/simulation-corpus/
 *   node scripts/simulation-corpus.mjs --state <file> --out <dir> --max 100 --context 4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashId, redactKey, sampleId } from '../src/simulation/trace.js';
import { inferAddressee } from '../src/simulation/attention.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = {
    state: path.join(ROOT, 'state', 'social-v2.json'),
    out: path.join(ROOT, 'state', 'simulation-corpus'),
    max: 100,
    context: 4
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--state') args.state = path.resolve(argv[++i] ?? '');
    else if (a === '--out') args.out = path.resolve(argv[++i] ?? '');
    else if (a === '--max') args.max = Math.max(1, Number(argv[++i]) || 100);
    else if (a === '--context') args.context = Math.max(0, Number(argv[++i]) || 4);
  }
  return args;
}

/** bot 关键词：优先读 config.json 的 socialV2.wake.triggers.keywords，缺省用内置列表。 */
function loadBotKeywords(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const kw = cfg?.socialV2?.wake?.triggers?.keywords;
    if (Array.isArray(kw) && kw.length) return kw.map((k) => String(k).trim()).filter(Boolean);
  } catch { /* config 缺失就用内置 */ }
  return ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', '蓝色大肥鱼', '深度求索', '大肥鱼', '鲸鱼', '蓝莓球', '猫猫', '猫猫头'];
}

const QQ_NUMBER_RE = /\b\d{5,12}\b/g;
const QUESTION_RE = /[?？]|吗|呢|怎么|为什么|能不能|有没有|是不是|啥时候|多少/;

/** 文本脱敏：QQ 号掩码为 <num:hash>；其余保留（评估要看文本，但文件本身不入库）。 */
function maskText(text) {
  return String(text ?? '').replace(QQ_NUMBER_RE, (m) => `<num:${(hashId(m) ?? '').slice(2, 8)}>`);
}

function textOf(m) {
  return String(m?.plain ?? m?.text ?? '').trim();
}

function isNoiseMessage(text) {
  // 纯媒体占位（[图片]/[动画表情]/[语音]…）不作为语言样本，但保留在上下文里。
  return /^\[(图片|动画表情|表情|语音|视频|文件|转发|聊天记录)\]$/.test(text);
}

/**
 * 自动播种 addressee：统一用 attention.js 的 inferAddressee（与 shadow 预测同一套规则，
 * 单条语义与旧标注完全一致）：
 *   me      —— 引用 bot、叫 bot 名字/关键词、私聊；
 *   other   —— 明确 @ 别人、引用别人；
 *   unknown —— 其余（多人群聊大多数轮次没有显式受话人，这正是注意力层要解的题）。
 */
function seedAddressee(msg, { isPrivate, botKeywords }) {
  return inferAddressee([msg], { isPrivate, botKeywords });
}

function seedSpeakSilent(replied) {
  return replied ? 'speak' : 'silent';
}

/** 合并 recent + unread（按 messageId / seq+time+text 去重）后按时间排序。 */
function mergeMessages(conv) {
  const seen = new Set();
  const out = [];
  for (const m of [...(conv.recentMessages ?? []), ...(conv.unread ?? [])]) {
    if (!m) continue;
    const dedupeKey = m.messageId != null ? `m:${m.messageId}`
      : m.seq != null ? `s:${m.seq}`
        : `t:${m.time}|${m.sender}|${textOf(m)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(m);
  }
  out.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0) || (Number(a.seq) || 0) - (Number(b.seq) || 0));
  return out;
}

/** 从单个会话抽样本（含上下文、标注、基线）。 */
function extractConversation(key, conv, { botKeywords, contextLen }) {
  const msgs = mergeMessages(conv);
  const isPrivate = key.startsWith('private:');
  const samples = [];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (m.isSelf) continue;
    const text = textOf(m);
    if (!text || isNoiseMessage(text)) continue;
    // V2 行为基线：下一条消息就是 bot 的回复（且 10 分钟内）才算「回了这条」——
    // 对话已经转向（中间插了别人的消息）就不算，避免把回给 seq5 的话错记到 seq3 头上。
    let replied = false;
    let latencyMs = null;
    const nxt = msgs[i + 1];
    if (nxt && nxt.isSelf && textOf(nxt)) {
      const dt = (Number(nxt.time) || 0) - (Number(m.time) || 0);
      if (dt >= 0 && dt <= 10 * 60 * 1000) {
        replied = true;
        latencyMs = dt;
      }
    }
    const context = msgs.slice(Math.max(0, i - contextLen), i).map((c) => ({
      role: c.isSelf ? 'self' : 'other',
      who: c.isSelf ? 'bot' : (hashId(String(c.userId ?? c.sender ?? '')) ?? '').slice(2, 8),
      text: maskText(textOf(c)).slice(0, 120)
    }));
    samples.push({
      id: sampleId(key, m.messageId ?? m.seq ?? m.time),
      key: redactKey(key),
      ts: Number(m.time) || null,
      context,
      message: {
        who: (hashId(String(m.userId ?? m.sender ?? '')) ?? '').slice(2, 8),
        text: maskText(text),
        hasMedia: !!m.hasMedia,
        isOwner: !!m.isOwner
      },
      annotation: {
        addressee: seedAddressee(m, { isPrivate, botKeywords }),
        speakSilent: seedSpeakSilent(replied),
        replyTo: null,
        topic: null,
        question: QUESTION_RE.test(text),
        source: 'auto-seed'
      },
      baseline: { v2Replied: replied, replyLatencyMs: latencyMs }
    });
  }
  return samples;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.state)) {
    console.error(`找不到状态文件：${args.state}`);
    process.exitCode = 1;
    return;
  }
  const state = JSON.parse(fs.readFileSync(args.state, 'utf8'));
  const botKeywords = loadBotKeywords(ROOT);
  // 跨会话轮转抽取（最多 max 条，保证群/私聊都有覆盖）。
  // **从最新往回取**：shadow 预测落在最近的消息上，若按最旧优先截断，预测与语料会 0 覆盖，
  // 评估就会在「没对齐」的情况下误报通过（见 P1.6 验收教训）。
  const pending = Object.entries(state.conversations ?? {})
    .map(([key, conv]) => extractConversation(key, conv, { botKeywords, contextLen: args.context }))
    .filter((arr) => arr.length > 0);
  const samples = [];
  let round = 0;
  while (samples.length < args.max && pending.some((arr) => round < arr.length)) {
    for (const arr of pending) {
      if (samples.length >= args.max) break;
      if (round < arr.length) samples.push(arr[arr.length - 1 - round]);
    }
    round += 1;
  }
  // 输出仍按时间升序，V2 基线与人工阅读都按对话顺序
  samples.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || (a.id < b.id ? -1 : 1));
  fs.mkdirSync(args.out, { recursive: true });
  const corpusFile = path.join(args.out, 'corpus.jsonl');
  fs.writeFileSync(corpusFile, `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  const byAddressee = { me: 0, other: 0, unknown: 0 };
  let replied = 0;
  for (const s of samples) {
    byAddressee[s.annotation.addressee] += 1;
    if (s.baseline.v2Replied) replied += 1;
  }
  const manifest = {
    $comment: 'GEN3 P0.4 语料清单（本地评估用，state/ 不入库）。标注 source=auto-seed 可人工修正为 manual。',
    extractedAt: new Date().toISOString(),
    sourceFile: path.basename(args.state),
    sourceKeys: Object.keys(state.conversations ?? {}).map(redactKey),
    sampleCount: samples.length,
    byAddressee,
    baseline: { v2Replied: replied, v2Silent: samples.length - replied },
    questionCount: samples.filter((s) => s.annotation.question).length
  };
  fs.writeFileSync(path.join(args.out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`语料抽取完成：${samples.length} 轮 → ${corpusFile}`);
  console.log(`  addressee：me=${byAddressee.me} other=${byAddressee.other} unknown=${byAddressee.unknown}`);
  console.log(`  V2 基线：回 ${replied} / 沉默 ${samples.length - replied}；提问 ${manifest.questionCount} 条`);
}

main();
