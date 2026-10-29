#!/usr/bin/env node
/**
 * GEN3 评估回归（P0.4 最小 eval 扩写为 P2.3 评估闭环，不是从零建）。
 *
 * 输入：simulation-corpus.mjs 产出的 corpus.jsonl（含 annotation + V2 行为基线），
 *       可选 --predictions（V3 注意力层的 speak/silent/addressee 预测，P0.7 shadow 会产出）。
 * 输出：state/simulation-eval/ 下的 report JSON + 控制台人读摘要。
 *
 * 指标（docs/design/GEN3_SIMULATION_PLAN.md 10.2 / P2 表 2.3）：
 *   · 基线统计：V2 回复率（按 addressee 分层）、回复延迟 p50/p95；
 *   · 有 predictions 时：addressee 准确率、speak/silent F1、误插话率(false interruption)、
 *     漏回率(false silence，**私聊必须为 0**，--strict 时违规退出码 1)；
 *   · 轻量风格/一致性检查：禁词率、句长统计、感叹号密度、自称一致性（P0.4 既有口径原样保留）；
 *   · P2.3 新增：PICon 三项一致性（identity/style/persona，规则版、纯函数、离线，自称口径
 *     复用 src/simulation/persona.js 的 AI_SELF_RE）；LLM 初筛（llmScreen 可插拔 judge，
 *     **无 judge 默认离线 skip，绝不触网**）；人评盲测包（buildBlindPack 脱敏+seeded 洗牌+
 *     匿名 A/B；scoreBlindPack 回填）；可复现全量报告（runReport，时间戳可注入）与门槛
 *     （checkGates：PICon 不倒退 / strict 私聊漏回 / LLM fail 率 > 0.1）。
 *
 * 隐私：只读本地语料，输出落 state/（gitignore），默认路径不联网不发消息。
 * 脱敏：盲测包与报告不落明文 QQ 号/姓名/群号（哈希化，照 src/simulation/trace.js）。
 *
 * 用法：
 *   node scripts/simulation-eval.mjs [--corpus <file>] [--predictions <file>] [--out <dir>] [--strict]
 *   node scripts/simulation-eval.mjs --picon [--corpus <file>] [--out <dir>] [--strict]   # 只算 PICon 三项（输出确定性）
 *   node scripts/simulation-eval.mjs --blind <out.json> [--seed <n>]                      # 出人评盲测包（脱敏）
 *   node scripts/simulation-eval.mjs --llm                                               # 有 judge 凭据（DSH_JUDGE_URL）才联网初筛
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_SELF_RE, TONE_WORDS } from '../src/simulation/persona.js';
import { hashId } from '../src/simulation/trace.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function parseArgs(argv) {
  const args = {
    corpus: path.join(ROOT, 'state', 'simulation-corpus', 'corpus.jsonl'),
    predictions: null,
    out: path.join(ROOT, 'state', 'simulation-eval'),
    strict: false,
    // P2.3 新增（默认全关 = 与 P0.4 行为完全一致）
    picon: false,
    blind: null,
    llm: false,
    seed: 0,
    // P1.6 验收门槛（可选；strict 下按预测文件是否存在给默认底线）
    minCovered: null,
    minF1: null,
    minTurns: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--corpus') args.corpus = path.resolve(argv[++i] ?? '');
    else if (a === '--predictions') args.predictions = path.resolve(argv[++i] ?? '');
    else if (a === '--out') args.out = path.resolve(argv[++i] ?? '');
    else if (a === '--strict') args.strict = true;
    else if (a === '--picon') args.picon = true;
    else if (a === '--blind') args.blind = path.resolve(argv[++i] ?? '');
    else if (a === '--llm') args.llm = true;
    else if (a === '--seed') args.seed = Math.floor(Number(argv[++i])) || 0;
    else if (a === '--min-covered') args.minCovered = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--min-f1') args.minF1 = Math.min(1, Math.max(0, Number(argv[++i]) || 0));
    else if (a === '--min-turns') args.minTurns = Math.max(0, Number(argv[++i]) || 0);
  }
  return args;
}

/** 预测文件的伴随元数据（simulation-trace-to-predictions 产出）：shadow 轮数等。缺失返回 null。 */
function readPredictionsMeta(predFile) {
  if (!predFile) return null;
  try {
    return JSON.parse(fs.readFileSync(`${predFile}.meta.json`, 'utf8'));
  } catch {
    return null;
  }
}

const BANNED_WORDS = ['一绝', '真管用', '总的来说', '综上所述', '值得一提的是', '首先', '其次', '最后', '希望以上对你有帮助', '保证', '绝对'];

/** P0.4 既有自称口径（lightStyleCheck 的 aiSelfCallRate 专用，数值历史可比，勿改）。 */
const LEGACY_AI_SELF_RE = /我是\s?(AI|人工智能|助手|模型|程序)/;

const round3 = (n) => Number(Number(n).toFixed(3));

function loadJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

// ──────────────────────────── 共享文本信号 ────────────────────────────
// 句长/标点/语气词/禁词信号只此一份实现：lightStyleCheck（P0.4）与 styleConsistency（P2.3）
// 都从 textSignals 取数，不复制两份逻辑。

/** 样本里 bot 自己的发言（context.role=self），P0.4 与 PICon 同一取材口径。 */
function botTexts(samples) {
  const texts = [];
  for (const s of samples ?? []) {
    for (const c of s?.context ?? []) if (c?.role === 'self' && c.text) texts.push(c.text);
  }
  return texts;
}

/** 同 botTexts，但带「上一条消息」（判无端自称的追问语境用）。 */
function botTurns(samples) {
  const turns = [];
  for (const s of samples ?? []) {
    const ctx = s?.context ?? [];
    for (let i = 0; i < ctx.length; i += 1) {
      if (ctx[i]?.role === 'self' && ctx[i].text) {
        turns.push({ text: ctx[i].text, prevText: i > 0 ? String(ctx[i - 1]?.text ?? '') : '' });
      }
    }
  }
  return turns;
}

/**
 * 单条文本信号（轻量风格检查 + PICon 风格一致性共用）：
 * chars/sentences（句长）、punctuation（标点数）、tone（语气词命中数）、bannedHits（禁词命中数）、exclaim。
 */
function textSignals(text) {
  const t = String(text ?? '');
  let bannedHits = 0;
  for (const w of BANNED_WORDS) if (t.includes(w)) bannedHits += 1;
  let tone = 0;
  for (const w of TONE_WORDS) {
    let idx = t.indexOf(w);
    while (idx >= 0) {
      tone += 1;
      idx = t.indexOf(w, idx + w.length);
    }
  }
  return {
    chars: t.length,
    sentences: t.split(/[。！？!?…\n]/).filter((x) => x.trim()).length,
    punctuation: (t.match(/[，。！？、；：…～!?,.;:~「」“”'"（）()]/g) ?? []).length,
    tone,
    bannedHits,
    exclaim: (t.match(/[!！]/g) ?? []).length
  };
}

/** 轻量风格/一致性检查（规则版）：对语料里的 bot 文本（context.role=self + 预测用）。 */
function lightStyleCheck(samples) {
  const texts = botTexts(samples);
  if (!texts.length) return { checked: 0 };
  let bannedHits = 0;
  let exclaim = 0;
  let chars = 0;
  let sentences = 0;
  let aiSelfCalls = 0;
  for (const t of texts) {
    const sig = textSignals(t);
    bannedHits += sig.bannedHits;
    exclaim += sig.exclaim;
    chars += sig.chars;
    sentences += sig.sentences;
    if (LEGACY_AI_SELF_RE.test(t)) aiSelfCalls += 1;
  }
  return {
    checked: texts.length,
    bannedWordRate: Number((bannedHits / texts.length).toFixed(3)),
    avgSentenceChars: Number((chars / Math.max(1, sentences)).toFixed(1)),
    exclaimPerMsg: Number((exclaim / texts.length).toFixed(2)),
    aiSelfCallRate: Number((aiSelfCalls / texts.length).toFixed(3))
  };
}

// ──────────────────────────── PICon 三项一致性（规则版、纯函数、离线） ────────────────────────────

/**
 * 追问身份语境：上一条对方消息在追问 bot 是不是 AI/机器人/真人（被追问时承认身份不算漂移）。
 * 只做规则近似，不引模型。
 */
const IDENTITY_PROBE_RE = /(?:你|您)[^。！？!?]{0,6}?(?:是|算)[^。！？!?]{0,8}?(?:AI|人工智能|机器人|模型|程序|助手|工具|真人|人类|生物|什么东西|什么玩意)|(?:你到底|你究竟)(?:是什么|是谁)|(?:你|您)(?:是)?谁/i;

/**
 * 自称 AI 一致性：自称口径**复用 persona.js 的 AI_SELF_RE**（不另写正则）。
 *   aiSelfRate      自称条数 / bot 发言条数；
 *   unsolicitedRate 无端自称（非被追问语境的自称）条数 / bot 发言条数；
 *   score = 1 − unsolicitedRate（保留 3 位小数）。空输入记满分。
 */
export function identityConsistency(samples) {
  const turns = botTurns(samples);
  if (!turns.length) return { aiSelfRate: 0, unsolicitedRate: 0, score: 1 };
  let selfCalls = 0;
  let unsolicited = 0;
  for (const turn of turns) {
    if (!AI_SELF_RE.test(turn.text)) continue;
    selfCalls += 1;
    if (!IDENTITY_PROBE_RE.test(turn.prevText)) unsolicited += 1;
  }
  const aiSelfRate = round3(selfCalls / turns.length);
  const unsolicitedRate = round3(unsolicited / turns.length);
  return { aiSelfRate, unsolicitedRate, score: round3(1 - unsolicitedRate) };
}

/** 跨样本方差归一尺度（方差上限，聊天场景的自然波动幅度² 量级）。 */
const STYLE_VARIANCE_SCALES = Object.freeze({ avgSentenceChars: 25, punctuationRate: 0.02, toneWordRate: 0.005 });

/**
 * 风格一致性：句长/标点/语气词/禁词信号（textSignals 同源）按样本求跨样本方差，
 * 方差 / 尺度封顶 1 归一后取均值：
 *   varianceScore = 1 − mean(min(1, 方差/尺度))；
 *   bannedRate    = min(1, 禁词命中数 / 样本条数)；
 *   score         = varianceScore × (1 − bannedRate)（保留 3 位小数）。空输入记满分。
 */
export function styleConsistency(samples) {
  const texts = botTexts(samples);
  if (!texts.length) return { varianceScore: 1, bannedRate: 0, score: 1 };
  const per = texts.map((t) => {
    const sig = textSignals(t);
    return {
      avgSentenceChars: sig.chars / Math.max(1, sig.sentences),
      punctuationRate: sig.chars ? sig.punctuation / sig.chars : 0,
      toneWordRate: sig.chars ? sig.tone / sig.chars : 0,
      bannedHits: sig.bannedHits
    };
  });
  const varianceOf = (key) => {
    const mean = per.reduce((a, x) => a + x[key], 0) / per.length;
    return per.reduce((a, x) => a + (x[key] - mean) ** 2, 0) / per.length;
  };
  let normSum = 0;
  for (const [key, scale] of Object.entries(STYLE_VARIANCE_SCALES)) {
    normSum += Math.min(1, varianceOf(key) / scale);
  }
  const varianceScore = round3(1 - normSum / Object.keys(STYLE_VARIANCE_SCALES).length);
  const bannedHits = per.reduce((a, x) => a + x.bannedHits, 0);
  const bannedRate = round3(Math.min(1, bannedHits / texts.length));
  return { varianceScore, bannedRate, score: round3(varianceScore * (1 - bannedRate)) };
}

/**
 * 人设一致性：红线禁忌命中率 + 说话特征词覆盖率。
 *   tabooHits       禁忌词命中次数（每条文本里每个禁忌词命中记 1 次，同条同词多次也只记 1 次）；
 *   featureCoverage 说话特征词覆盖率（至少出现 1 次的特征词占比；不给特征表 = 不设要求即 1）；
 *   score = mean(1 − tabooRate, featureCoverage)（tabooRate = min(1, tabooHits/条数)，保留 3 位小数）。
 */
export function personaConsistency(samples, { tabooWords, speechFeatures } = {}) {
  const texts = botTexts(samples);
  const taboo = (Array.isArray(tabooWords) ? tabooWords : []).map((w) => String(w ?? '').trim()).filter(Boolean);
  const features = (Array.isArray(speechFeatures) ? speechFeatures : []).map((w) => String(w ?? '').trim()).filter(Boolean);
  let tabooHits = 0;
  for (const t of texts) {
    for (const w of taboo) if (t.includes(w)) tabooHits += 1;
  }
  const tabooRate = texts.length ? Math.min(1, tabooHits / texts.length) : 0;
  const covered = features.filter((w) => texts.some((t) => t.includes(w))).length;
  const featureCoverage = features.length ? round3(covered / features.length) : 1;
  return { tabooHits, featureCoverage, score: round3(((1 - tabooRate) + featureCoverage) / 2) };
}

/** PICon 三项合成报告：overall = 三项 score 平均（保留 3 位小数）。 */
export function piconReport(samples, opts = {}) {
  const identity = identityConsistency(samples);
  const style = styleConsistency(samples);
  const persona = personaConsistency(samples, opts);
  return {
    identity,
    style,
    persona,
    overall: round3((identity.score + style.score + persona.score) / 3)
  };
}

// ──────────────────────────── LLM 初筛（可插拔、默认离线） ────────────────────────────

/**
 * LLM 初筛：judge 是注入的判定函数 `async (sample) => ({ verdict: 'pass'|'suspect'|'fail', note })`。
 * **没有 judge 时返回 { skipped: true, reason: 'no-judge' }，绝不触网**（测试/CI 无网络契约）。
 * 有 judge 时逐条判定（judge 抛错按 suspect 记，不打断整批），汇总 { pass, suspect, fail, verdicts }。
 */
export async function llmScreen(samples, { judge } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  if (typeof judge !== 'function') return { skipped: true, reason: 'no-judge' };
  const counts = { pass: 0, suspect: 0, fail: 0 };
  const verdicts = [];
  for (const s of list) {
    let v;
    try {
      v = await judge(s);
    } catch (error) {
      v = { verdict: 'suspect', note: `judge-error: ${error?.message ?? error}` };
    }
    const verdict = v?.verdict === 'pass' || v?.verdict === 'fail' ? v.verdict : 'suspect';
    counts[verdict] += 1;
    verdicts.push({ id: s?.id ?? null, verdict, note: v?.note ?? null });
  }
  return { skipped: false, pass: counts.pass, suspect: counts.suspect, fail: counts.fail, verdicts };
}

const JUDGE_SYSTEM_PROMPT = [
  '你是对话质量初筛员。给定一段聊天上下文与一条候选回复，判定候选回复是否合格。',
  '只输出一个 JSON 对象：{"verdict":"pass|suspect|fail","note":"一句话理由"}。',
  'pass=符合人设与口语风格；suspect=存疑（客服腔/八股/跑题）；fail=明显违规（禁词、暴露 AI 身份、承诺敏感事项）。'
].join('\n');

/**
 * 可选 DSH judge 适配器：**只有显式传入 baseUrl/token 并真正调用时才可能联网**，
 * 构造与默认路径完全离线（依赖注入，测试用 fake judge 走 llmScreen 即可）。
 * 走 DeepSeek 兼容 chat 接口（POST {baseUrl}{endpoint}），回复里抠 {verdict,note} JSON。
 */
export function createDshJudge({ baseUrl, token, model = 'deepseek-chat', endpoint = '/v1/chat/completions', timeoutMs = 30000 } = {}) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('createDshJudge 需要 baseUrl（显式注入才联网）');
  return async function dshJudge(sample) {
    const ctx = (sample?.context ?? []).map((c) => `${c?.role === 'self' ? 'bot' : 'peer'}: ${c?.text ?? ''}`).join('\n');
    const user = `上下文：\n${ctx}\n\n候选回复：\n${sample?.message?.text ?? ''}`;
    const res = await fetch(base + endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: user }
        ]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { verdict: 'suspect', note: `judge-http-${res.status}` };
    const data = await res.json().catch(() => null);
    const text = String(data?.choices?.[0]?.message?.content ?? '');
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return { verdict: 'suspect', note: 'judge 回复无法解析' };
    try {
      const parsed = JSON.parse(m[0]);
      const verdict = parsed?.verdict === 'pass' || parsed?.verdict === 'fail' ? parsed.verdict : 'suspect';
      return { verdict, note: parsed?.note != null ? String(parsed.note) : null };
    } catch {
      return { verdict: 'suspect', note: 'judge 回复不是合法 JSON' };
    }
  };
}

// ──────────────────────────── 人评盲测包 ────────────────────────────

/** 8 位十六进制前缀哈希脱敏（照 src/simulation/trace.js 的 hashId 约定，直接复用它）。 */
function redactBlindText(text) {
  return String(text ?? '').replace(/\b\d{5,12}\b/g, (m) => `<num:${(hashId(m) ?? '').slice(2, 8)}>`);
}

/** seeded RNG（mulberry32）：洗牌可复现，**禁止 Math.random**。 */
function mulberry32(seed) {
  let a = (Number.isFinite(Number(seed)) ? Number(seed) : 0) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded(arr, rng) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const BLIND_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 候选回复取材：sample.candidates（多模型对比）或 sample.reply/sample.candidate（单条）。 */
function blindCandidateTexts(sample) {
  const raw = Array.isArray(sample?.candidates) && sample.candidates.length
    ? sample.candidates
    : (sample?.reply != null ? [{ text: sample.reply }] : (sample?.candidate != null ? [{ text: sample.candidate }] : []));
  return raw.map((c) => redactBlindText(typeof c === 'string' ? c : (c?.text ?? '')));
}

function blindItem(sample, rng, index) {
  const turns = [
    ...(sample?.context ?? []),
    ...(sample?.message?.text ? [{ role: 'other', text: sample.message.text }] : [])
  ];
  const context = turns.map((c) => ({
    role: c?.role === 'self' ? 'self' : 'other',
    text: redactBlindText(c?.text)
  }));
  const texts = blindCandidateTexts(sample);
  let candidate;
  if (texts.length > 1) {
    // 对比多模型：候选顺序 seeded 洗牌后派匿名标签 A/B，**不含模型名/来源**。
    candidate = shuffleSeeded(texts.slice(), rng).map((t, i) => ({ label: BLIND_LABELS[i] ?? `L${i}`, text: t }));
  } else {
    candidate = texts[0] ?? '';
  }
  return {
    id: hashId(String(sample?.id ?? '')) || `h_${index}`,
    context,
    candidate
  };
}

/**
 * 人评盲测包：从样本生成**脱敏**盲测包——
 *   · 标识符哈希化（hashId，照 trace.js）、QQ 号掩码（<num:hash>）、不落模型名/来源；
 *   · 条目洗牌（seeded RNG 可复现，禁止 Math.random）；
 *   · 每条含 id/context/candidate（多模型对比时 candidate 带匿名标签 A/B）。
 * 输出确定性 JSON 结构（同 seed 两次逐字节一致）。
 */
export function buildBlindPack(samples, { seed = 0 } = {}) {
  const rng = mulberry32(seed);
  const items = (Array.isArray(samples) ? samples : []).map((s, i) => blindItem(s, rng, i));
  shuffleSeeded(items, rng);
  return {
    $comment: 'GEN3 人评盲测包：脱敏（标识符哈希/号码掩码）+ 匿名（不含模型名/来源）+ seeded 洗牌。盲评后用 scoreBlindPack 回填评分。',
    seed: Number.isFinite(Number(seed)) ? Number(seed) : 0,
    items
  };
}

/**
 * 人评回填：ratings: [{ id, score }]（1~5 分，≥3 记胜）。
 * 算均分/胜率；缺失评分与未知 id 跳过不报错。
 */
export function scoreBlindPack(pack, ratings) {
  const items = Array.isArray(pack?.items) ? pack.items : [];
  const byId = new Map();
  for (const r of Array.isArray(ratings) ? ratings : []) {
    const score = Number(r?.score);
    if (r?.id == null || !Number.isFinite(score)) continue;
    byId.set(String(r.id), score);
  }
  const scores = [];
  for (const item of items) {
    const score = byId.get(String(item.id));
    if (score === undefined) continue; // 缺失评分跳过不报错
    scores.push(score);
  }
  const rated = scores.length;
  return {
    rated,
    skipped: items.length - rated,
    meanScore: rated ? round3(scores.reduce((a, b) => a + b, 0) / rated) : null,
    winRate: rated ? round3(scores.filter((s) => s >= 3).length / rated) : null
  };
}

// ──────────────────────────── V2 基线 / 预测指标 ────────────────────────────

function computeV2Baseline(samples) {
  const latencies = [];
  const baseline = { overall: { reply: 0, silent: 0 }, byAddressee: {} };
  for (const s of samples) {
    const cls = s.annotation.addressee;
    if (!baseline.byAddressee[cls]) baseline.byAddressee[cls] = { reply: 0, silent: 0 };
    if (s.baseline.v2Replied) {
      baseline.overall.reply += 1;
      baseline.byAddressee[cls].reply += 1;
      if (Number.isFinite(s.baseline.replyLatencyMs)) latencies.push(s.baseline.replyLatencyMs);
    } else {
      baseline.overall.silent += 1;
      baseline.byAddressee[cls].silent += 1;
    }
  }
  latencies.sort((a, b) => a - b);
  return {
    ...baseline,
    replyLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) }
  };
}

function confusionMetrics(samples, predictions) {
  const byId = new Map(predictions.map((p) => [p.id, p]));
  let matched = 0;
  let addresseeHit = 0;
  let addresseeTotal = 0;
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let privateFalseSilence = 0;
  for (const s of samples) {
    const p = byId.get(s.id);
    if (!p) continue;
    matched += 1;
    if (p.addressee && s.annotation.addressee !== 'unknown') {
      addresseeTotal += 1;
      if (p.addressee === s.annotation.addressee) addresseeHit += 1;
    }
    const predSpeak = p.speakSilent === 'speak';
    const labelSpeak = s.annotation.speakSilent === 'speak';
    if (predSpeak && labelSpeak) tp += 1;
    else if (predSpeak && !labelSpeak) fp += 1;
    else if (!predSpeak && labelSpeak) {
      fn += 1;
      if (String(s.key ?? '').startsWith('private:')) privateFalseSilence += 1;
    } else tn += 1;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    // covered = **真正与语料对齐**的预测条数（不是预测文件行数）：0 覆盖时不能当作「评估通过」
    covered: matched,
    coverageRate: samples.length ? round3(matched / samples.length) : 0,
    addresseeAccuracy: addresseeTotal ? Number((addresseeHit / addresseeTotal).toFixed(3)) : null,
    speakSilentF1: Number(f1.toFixed(3)),
    falseInterruptionRate: tp + fp ? Number((fp / (tp + fp)).toFixed(3)) : 0,
    falseSilenceRate: tp + fn ? Number((fn / (tp + fn)).toFixed(3)) : 0,
    privateFalseSilence
  };
}

// ──────────────────────────── 可复现报告 + 门槛 ────────────────────────────

/**
 * 门槛（不倒退）：
 *   ① PICon overall ≥ baseline.piconOverall（给了基线就查，不倒退）；
 *   ② strict 时私聊漏回（沿用 P0.4 的 strict 门槛逻辑，false silence 必须为 0）；
 *   ③ strict 时 LLM 初筛 fail 率 > 0.1 不过；
 *   ④ 可选：预测与语料对齐条数 ≥ minCovered（防止 0 覆盖时误报通过）；
 *   ⑤ 可选：speak/silent F1 ≥ minF1（初始验收底线；人工标注后再按基线调）；
 *   ⑥ 可选：attention shadow 轮数 ≥ minTurns（计划要求 500，数据不够时严格模式必须拦下）。
 * 返回 { pass, failures: [] }。
 */
export function checkGates(report = {}, {
  baseline = null,
  strict = false,
  minCovered = null,
  minF1 = null,
  minTurns = null,
  shadowTurns = null
} = {}) {
  const failures = [];
  const need = Number(baseline?.piconOverall);
  if (Number.isFinite(need) && report.picon && Number(report.picon.overall) < need) {
    failures.push(`PICon overall ${report.picon.overall} 低于基线 ${need}（不倒退门槛）`);
  }
  if (strict && Number(report.v3?.privateFalseSilence ?? 0) > 0) {
    failures.push('私聊出现漏回（false silence 必须为 0）');
  }
  const llm = report.llm;
  if (strict && llm && !llm.skipped) {
    const total = Number(llm.pass ?? 0) + Number(llm.suspect ?? 0) + Number(llm.fail ?? 0);
    const failRate = total ? Number(llm.fail ?? 0) / total : 0;
    if (failRate > 0.1) failures.push(`LLM 初筛 fail 率 ${round3(failRate)} 超过 0.1`);
  }
  if (minCovered != null) {
    const covered = Number(report.v3?.covered ?? 0);
    if (!(covered >= Number(minCovered))) {
      failures.push(`预测只与 ${covered} 条语料对齐，低于门槛 ${minCovered}（覆盖不足，不能当作评估通过）`);
    }
  }
  if (minF1 != null) {
    const f1 = Number(report.v3?.speakSilentF1 ?? 0);
    if (!(f1 >= Number(minF1))) failures.push(`speak/silent F1 ${round3(f1)} 低于门槛 ${minF1}`);
  }
  if (minTurns != null) {
    const turns = Number(shadowTurns);
    if (!Number.isFinite(turns) || turns < Number(minTurns)) {
      failures.push(`attention shadow 轮数 ${Number.isFinite(turns) ? turns : '未知'}，低于门槛 ${minTurns}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

/**
 * 一次产出全量报告：{ meta, v2Baseline, picon, llm, v3, blindPack?, gates }。
 * **同输入两次输出 deepEqual**：时间戳等非确定字段只出现在 meta.generatedAt，
 * 且可用 `now` 注入（字符串或返回 ISO 串的函数）；盲测包走 seeded 洗牌。
 * samples 传样本数组（或用 corpus 传 corpus.jsonl 路径）；judge 缺省 = LLM 初筛离线 skip。
 */
export async function runReport({
  samples,
  corpus,
  predictions,
  judge,
  tabooWords,
  speechFeatures,
  blind = false,
  seed = 0,
  now = null,
  baseline = null,
  strict = false,
  minCovered = null,
  minF1 = null,
  minTurns = null,
  shadowTurns = null
} = {}) {
  const rows = Array.isArray(samples) ? samples : (typeof corpus === 'string' ? loadJsonl(corpus) : []);
  const generatedAt = typeof now === 'function' ? now() : (now ?? new Date().toISOString());
  const report = {
    meta: {
      $comment: 'GEN3 P2.3 评估回归报告（本地，state/ 不入库）',
      generatedAt,
      corpus: typeof corpus === 'string' ? path.basename(corpus) : (corpus ?? null),
      sampleCount: rows.length,
      shadowTurns: Number.isFinite(Number(shadowTurns)) ? Number(shadowTurns) : null
    },
    v2Baseline: computeV2Baseline(rows),
    picon: piconReport(rows, { tabooWords, speechFeatures }),
    llm: await llmScreen(rows, { judge }),
    v3: Array.isArray(predictions) ? confusionMetrics(rows, predictions) : null
  };
  if (blind) report.blindPack = buildBlindPack(rows, { seed });
  report.gates = checkGates(report, { baseline, strict, minCovered, minF1, minTurns, shadowTurns });
  return report;
}

// ──────────────────────────── CLI ────────────────────────────

/** 人设词表：读 config.json 的 socialV3.persona（红线/说话特征），缺省空表（离线、纯本地）。 */
function loadPersonaLexicon(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const p = cfg?.socialV3?.persona ?? {};
    return {
      tabooWords: Array.isArray(p.redLines) ? p.redLines.map((w) => String(w)).filter(Boolean) : [],
      speechFeatures: Array.isArray(p.speechFeatures) ? p.speechFeatures.map((w) => String(w)).filter(Boolean) : []
    };
  } catch {
    return { tabooWords: [], speechFeatures: [] };
  }
}

/** --llm 的 judge：只有显式给出 DSH_JUDGE_URL（+可选 DSH_JUDGE_TOKEN）才可能联网；否则 null = 离线。 */
function cliJudge() {
  const baseUrl = process.env.DSH_JUDGE_URL;
  if (!baseUrl) return null;
  return createDshJudge({ baseUrl, token: process.env.DSH_JUDGE_TOKEN ?? '' });
}

/** P2.3 确定性子命令（--picon / --blind）：只算指定产物，输出可复现（不含时间戳路径）。 */
async function runDeterministicMode(samples, args, judge) {
  let picon = null;
  if (args.picon) {
    picon = piconReport(samples, loadPersonaLexicon(ROOT));
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(path.join(args.out, 'picon.json'), `${JSON.stringify(picon, null, 2)}\n`, 'utf8');
    console.log(`PICon 三项一致性（${samples.length} 样本）：`);
    console.log(`  自称：aiSelfRate=${picon.identity.aiSelfRate} unsolicitedRate=${picon.identity.unsolicitedRate} score=${picon.identity.score}`);
    console.log(`  风格：varianceScore=${picon.style.varianceScore} bannedRate=${picon.style.bannedRate} score=${picon.style.score}`);
    console.log(`  人设：tabooHits=${picon.persona.tabooHits} featureCoverage=${picon.persona.featureCoverage} score=${picon.persona.score}`);
    console.log(`  overall=${picon.overall}`);
  }
  if (args.blind) {
    const pack = buildBlindPack(samples, { seed: args.seed });
    fs.mkdirSync(path.dirname(args.blind), { recursive: true });
    fs.writeFileSync(args.blind, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    console.log(`盲测包：${pack.items.length} 条 → ${args.blind}`);
  }
  const llm = args.llm ? await llmScreen(samples, { judge }) : null;
  if (llm) {
    if (llm.skipped) console.log(`LLM 初筛：跳过（${llm.reason}，离线）`);
    else console.log(`LLM 初筛：pass=${llm.pass} suspect=${llm.suspect} fail=${llm.fail}`);
  }
  if (args.strict) {
    const baselineFile = path.join(args.out, 'picon-baseline.json');
    const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
    const gates = checkGates({ picon, llm, v3: null }, { baseline, strict: true });
    if (!gates.pass) {
      for (const f of gates.failures) console.error(`❌ strict：${f}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.corpus)) {
    console.error(`找不到语料：${args.corpus}（先跑 node scripts/simulation-corpus.mjs）`);
    process.exitCode = 1;
    return;
  }
  const samples = loadJsonl(args.corpus);
  const judge = args.llm ? cliJudge() : null;
  // P2.3 确定性子命令：只算三项 / 只出盲测包（不落时间戳文件名，输出可复现）
  if (args.picon || args.blind) {
    await runDeterministicMode(samples, args, judge);
    return;
  }
  // ── P0.4 既有全量评估路径（不带新参数时输出与现状一致） ──
  // V2 基线统计（P1 指标的分母）
  const v2Baseline = computeV2Baseline(samples);
  const report = {
    $comment: 'GEN3 P0.4 最小评估报告（本地，state/ 不入库）',
    evaluatedAt: new Date().toISOString(),
    corpus: path.basename(args.corpus),
    sampleCount: samples.length,
    v2Baseline,
    lightStyle: lightStyleCheck(samples),
    v3: null
  };
  if (args.predictions) {
    if (!fs.existsSync(args.predictions)) {
      console.error(`找不到预测文件：${args.predictions}`);
      process.exitCode = 1;
      return;
    }
    report.v3 = confusionMetrics(samples, loadJsonl(args.predictions));
    const meta = readPredictionsMeta(args.predictions);
    report.shadowTurns = Number.isFinite(Number(meta?.shadowTurns)) ? Number(meta.shadowTurns) : null;
  }
  if (args.llm) {
    report.llm = await llmScreen(samples, { judge });
    if (report.llm.skipped) console.log(`LLM 初筛：跳过（${report.llm.reason}，离线）`);
    else console.log(`LLM 初筛：pass=${report.llm.pass} suspect=${report.llm.suspect} fail=${report.llm.fail}`);
  }
  fs.mkdirSync(args.out, { recursive: true });
  const outFile = path.join(args.out, `report-${Date.now()}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(args.out, 'baseline-v2.json'), `${JSON.stringify(report.v2Baseline, null, 2)}\n`, 'utf8');

  console.log(`评估完成：${samples.length} 样本 → ${outFile}`);
  console.log(`  V2 基线：回 ${v2Baseline.overall.reply} / 沉默 ${v2Baseline.overall.silent}；延迟 p50=${report.v2Baseline.replyLatencyMs.p50}ms p95=${report.v2Baseline.replyLatencyMs.p95}ms`);
  for (const [cls, v] of Object.entries(v2Baseline.byAddressee)) {
    console.log(`    ${cls}：回 ${v.reply} / 沉默 ${v.silent}`);
  }
  const st = report.lightStyle;
  if (st.checked) {
    console.log(`  轻量风格：禁词率 ${st.bannedWordRate}、平均句长 ${st.avgSentenceChars} 字、感叹号/条 ${st.exclaimPerMsg}、自称 AI 率 ${st.aiSelfCallRate}`);
  }
  if (report.v3) {
    console.log(`  V3 预测：覆盖 ${report.v3.covered}/${samples.length} 条（${report.v3.coverageRate}）、addressee 准确率 ${report.v3.addresseeAccuracy}、speak/silent F1 ${report.v3.speakSilentF1}、误插话 ${report.v3.falseInterruptionRate}、漏回 ${report.v3.falseSilenceRate}（私聊漏回 ${report.v3.privateFalseSilence}）`);
    if (report.shadowTurns != null) console.log(`  attention shadow：${report.shadowTurns} 轮`);
  }
  // strict 门槛统一走 checkGates：私聊漏回 / 覆盖率 / F1 / shadow 轮数 / LLM 初筛
  // 覆盖率与 F1 的默认底线只在「有预测文件 + strict」时生效（无预测的 --picon/--blind 不受影响）
  if (args.strict) {
    const minCovered = args.minCovered ?? (args.predictions ? 50 : null);
    const minF1 = args.minF1 ?? (args.predictions ? 0.5 : null);
    const minTurns = args.minTurns ?? (report.shadowTurns != null ? 500 : null);
    const gates = checkGates(report, {
      strict: true,
      minCovered,
      minF1,
      minTurns,
      shadowTurns: report.shadowTurns
    });
    for (const f of gates.failures) {
      console.error(`❌ strict：${f}`);
      process.exitCode = 1;
    }
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) await main();
