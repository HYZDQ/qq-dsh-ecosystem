// GEN3 P0.4 回归：语料抽取（脱敏/标注播种/V2 基线）+ 最小 eval（指标计算/私聊漏回门槛）。
// 全部用合成 state fixture（临时目录），不读真实 state、不联网。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  identityConsistency,
  styleConsistency,
  personaConsistency,
  piconReport,
  llmScreen,
  createDshJudge,
  buildBlindPack,
  scoreBlindPack,
  runReport,
  checkGates
} from './simulation-eval.mjs';
import { AI_SELF_RE } from '../src/simulation/persona.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(HERE, 'simulation-corpus.mjs');
const EVAL = path.join(HERE, 'simulation-eval.mjs');
const PREDICTIONS = path.join(HERE, 'simulation-trace-to-predictions.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sim-eval-'));
}

/** 合成 state fixture：私聊（天然 me）+ 群聊（显式 me / other / unknown 三类）。 */
function makeFixture(dir) {
  const T = 1792800000000;
  const state = {
    paused: false,
    conversations: {
      'private:999999999': {
        recentMessages: [
          { sender: '主人', userId: '999999999', text: '在吗', plain: '在吗', isSelf: false, isOwner: true, time: T },
          { sender: '我', text: '在的', plain: '在的', isSelf: true, time: T + 3000 },
          { sender: '主人', userId: '999999999', text: '明天几点开会？', plain: '明天几点开会？', isSelf: false, isOwner: true, time: T + 60000 }
          // 这条没人回 → V2 沉默
        ],
        unread: []
      },
      'group:123456789': {
        recentMessages: [
          { seq: 1, messageId: '1', sender: '路人A', userId: '111111111', text: '蓝莓球 你觉得呢', plain: '蓝莓球 你觉得呢', isSelf: false, time: T + 120000 },
          { seq: 2, messageId: '2', sender: '我', text: '我觉得行', plain: '我觉得行', isSelf: true, time: T + 125000 },
          { seq: 3, messageId: '3', sender: '路人B', userId: '222222222', text: '@路人C 你昨天去哪了', plain: '@路人C 你昨天去哪了', isSelf: false, time: T + 180000 },
          { seq: 4, messageId: '4', sender: '路人C', userId: '333333333', text: '随便聊聊天气', plain: '随便聊聊天气', isSelf: false, time: T + 240000 },
          { seq: 5, messageId: '5', sender: '路人A', userId: '111111111', text: '帮我记下他的 QQ 12345678', plain: '帮我记下他的 QQ 12345678', quoteTargetIsSelf: true, isSelf: false, time: T + 300000 },
          { seq: 6, messageId: '6', sender: '我', text: '好', plain: '好', isSelf: true, time: T + 302000 }
        ],
        unread: []
      }
    }
  };
  const stateFile = path.join(dir, 'social-v2.json');
  fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  return stateFile;
}

test('语料抽取：样本数、标注播种、V2 基线、脱敏', () => {
  const dir = tmpDir();
  const stateFile = makeFixture(dir);
  const out = path.join(dir, 'corpus');
  const run = spawnSync(process.execPath, [CORPUS, '--state', stateFile, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const rows = fs.readFileSync(path.join(out, 'corpus.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // 6 条入站样本（private 2 + group 4；bot 自己的 2 条不算）
  assert.equal(rows.length, 6);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // 脱敏：不得出现任何明文 QQ 号 / 原 key
  const body = fs.readFileSync(path.join(out, 'corpus.jsonl'), 'utf8');
  for (const secret of ['999999999', '123456789', '111111111', '12345678']) {
    assert.ok(!body.includes(secret), `语料不得含明文标识符 ${secret}`);
  }
  assert.ok(rows.every((r) => /^(private|group):h_/.test(r.key)), '会话 key 必须已脱敏');

  // 标注播种：me=私聊 2 + 群@bot 1 + 引用bot 1；other=@别人 1；unknown=闲聊 1
  const addressees = rows.map((r) => r.annotation.addressee);
  assert.equal(addressees.filter((a) => a === 'me').length, 4);
  assert.equal(addressees.filter((a) => a === 'other').length, 1, '@别人 播种为 other');
  assert.equal(addressees.filter((a) => a === 'unknown').length, 1, '闲聊播种为 unknown');
  assert.ok(rows.filter((r) => r.annotation.question).length >= 2);
  assert.ok(rows.every((r) => r.annotation.source === 'auto-seed'));

  // V2 基线（下一条即 bot 回复才算）：在吗→回(3s)；明天几点→沉默；蓝莓球→回(5s)；
  // @路人C→沉默（对话转向）；闲聊→沉默；引用bot→回(2s)
  const latencies = rows.filter((r) => r.baseline.v2Replied).map((r) => r.baseline.replyLatencyMs).sort((a, b) => a - b);
  assert.equal(latencies.length, 3);
  assert.deepEqual(latencies, [2000, 3000, 5000]);
  assert.equal(rows.filter((r) => !r.baseline.v2Replied).length, 3);
  void byId;

  // manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sampleCount, 6);
  assert.equal(manifest.baseline.v2Replied, 3);
});

test('eval：V2 基线统计 + 轻量风格检查可跑', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'corpus');
  const evalOut = path.join(dir, 'eval');
  assert.equal(spawnSync(process.execPath, [CORPUS, '--state', makeFixture(dir), '--out', out], { encoding: 'utf8' }).status, 0);
  const run = spawnSync(process.execPath, [EVAL, '--corpus', path.join(out, 'corpus.jsonl'), '--out', evalOut], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(/V2 基线：回 3 \/ 沉默 3/.test(run.stdout));
  const baseline = JSON.parse(fs.readFileSync(path.join(evalOut, 'baseline-v2.json'), 'utf8'));
  assert.equal(baseline.overall.reply, 3);
  assert.equal(baseline.overall.silent, 3);
  assert.equal(baseline.replyLatencyMs.p50, 3000);
  assert.equal(baseline.byAddressee.me.reply, 3);
});

test('eval：predictions 指标手算校验 + 私聊漏回 strict 门槛', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'corpus');
  assert.equal(spawnSync(process.execPath, [CORPUS, '--state', makeFixture(dir), '--out', out], { encoding: 'utf8' }).status, 0);
  const rows = fs.readFileSync(path.join(out, 'corpus.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // 预测：全部预测 speak + addressee 全对 → F1=1、误插话把 2 条沉默算 fp
  const perfect = rows.map((r) => ({ id: r.id, addressee: r.annotation.addressee, speakSilent: 'speak' }));
  const predFile = path.join(dir, 'pred.jsonl');
  fs.writeFileSync(predFile, perfect.map((p) => JSON.stringify(p)).join('\n'), 'utf8');
  const run = spawnSync(process.execPath, [EVAL, '--corpus', path.join(out, 'corpus.jsonl'), '--predictions', predFile, '--out', path.join(dir, 'e1')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const r1 = JSON.parse(fs.readFileSync(path.join(dir, 'e1', `report-${fs.readdirSync(path.join(dir, 'e1')).find((f) => f.startsWith('report-')).slice(7, -5)}.json`), 'utf8'));
  assert.equal(r1.v3.addresseeAccuracy, 1);
  assert.equal(r1.v3.covered, 6, 'covered 必须是真正对齐的条数');
  assert.equal(r1.v3.coverageRate, 1);
  assert.equal(r1.v3.speakSilentF1, Number(((2 * (3 / 6) * 1) / (3 / 6 + 1)).toFixed(3)), 'tp=3 fp=3 fn=0 → F1=0.667');
  assert.equal(r1.v3.falseInterruptionRate, 0.5);
  assert.equal(r1.v3.falseSilenceRate, 0);
  assert.equal(r1.v3.privateFalseSilence, 0);
  assert.equal(r1.shadowTurns, null, '无 meta 时不得伪造 shadow 轮数');

  // 覆盖率未达标：strict + --min-covered 必须拦下（即使预测本身全对）
  const runCov = spawnSync(process.execPath, [
    EVAL, '--corpus', path.join(out, 'corpus.jsonl'), '--predictions', predFile,
    '--out', path.join(dir, 'e1cov'), '--strict', '--min-covered', '10'
  ], { encoding: 'utf8' });
  assert.equal(runCov.status, 1, '覆盖不足必须退出码 1');
  assert.ok(/对齐/.test(runCov.stderr), `应报覆盖不足：${runCov.stderr}`);

  // 0 条预测对齐：covered 必须为 0（旧实现会错报 predictions.length）
  const unrelated = path.join(dir, 'pred-unrelated.jsonl');
  fs.writeFileSync(unrelated, `${JSON.stringify({ id: 's_nope', addressee: 'me', speakSilent: 'speak' })}\n`, 'utf8');
  const runUnrelated = spawnSync(process.execPath, [
    EVAL, '--corpus', path.join(out, 'corpus.jsonl'), '--predictions', unrelated,
    '--out', path.join(dir, 'e0')
  ], { encoding: 'utf8' });
  assert.equal(runUnrelated.status, 0, runUnrelated.stderr);
  const r0 = JSON.parse(fs.readFileSync(path.join(dir, 'e0', `report-${fs.readdirSync(path.join(dir, 'e0')).find((f) => f.startsWith('report-')).slice(7, -5)}.json`), 'utf8'));
  assert.equal(r0.v3.covered, 0, '没对齐的预测不算覆盖');
  assert.equal(r0.v3.coverageRate, 0);

  // 预测全 silent → 私聊漏回 2 条，--strict 必须退出码 1
  const allSilent = rows.map((r) => ({ id: r.id, addressee: r.annotation.addressee, speakSilent: 'silent' }));
  const pred2 = path.join(dir, 'pred2.jsonl');
  fs.writeFileSync(pred2, allSilent.map((p) => JSON.stringify(p)).join('\n'), 'utf8');
  const run2 = spawnSync(process.execPath, [EVAL, '--corpus', path.join(out, 'corpus.jsonl'), '--predictions', pred2, '--out', path.join(dir, 'e2'), '--strict'], { encoding: 'utf8' });
  assert.equal(run2.status, 1, '私聊漏回必须被 strict 拦下');
  assert.ok(/私聊出现漏回/.test(run2.stderr));
});

// ════════════════ P2.3 评估回归（GEN3）新增用例 ════════════════
// 只追加、不改上方 P0.4 的 3 个用例；全部合成样本 + 纯函数断言，不联网、不读真实 state、不看真实时钟。

/** P2.3 合成样本（与 corpus.jsonl 同形：context.role=self 是 bot 发言）。 */
function piconSample(id, context, extra = {}) {
  return {
    id,
    key: 'group:h_test',
    ts: 0,
    context,
    message: { who: 'h_peer', text: '' },
    annotation: { addressee: 'unknown', speakSilent: 'silent', replyTo: null, topic: null, question: false, source: 'auto-seed' },
    baseline: { v2Replied: false, replyLatencyMs: null },
    ...extra
  };
}

test('PICon：identityConsistency 黄金值（AI_SELF_RE 复用：我是AI模型必中、正常口语不误报）', () => {
  // 4 条 bot 发言：被追问承认 1 条、无端自称 1 条、普通口语 2 条
  const samples = [
    piconSample('i1', [{ role: 'other', text: '你是AI吗' }, { role: 'self', text: '我是AI模型' }]),
    piconSample('i2', [{ role: 'other', text: '今天天气不错' }, { role: 'self', text: '哈哈对啊' }]),
    piconSample('i3', [{ role: 'other', text: '随便说说' }, { role: 'self', text: '作为一个AI我觉得还行' }]),
    piconSample('i4', [{ role: 'other', text: '吃了吗' }, { role: 'self', text: '吃了吃了' }])
  ];
  // 自称 2/4=0.5；无端自称（i3，非追问语境）1/4=0.25；score=1−0.25=0.75
  assert.deepEqual(identityConsistency(samples), { aiSelfRate: 0.5, unsolicitedRate: 0.25, score: 0.75 });

  // 口径必须与 persona.js 的 AI_SELF_RE 逐条一致（复用，不另写正则）
  const cases = [
    ['我是AI模型', true],
    ['作为一个AI我觉得还行', true],
    ['作为AI插一句', true],
    ['我是蓝莓球呀', false],
    ['哈哈对啊', false],
    ['今天吃了三碗饭', false]
  ];
  for (const [text, expect] of cases) {
    const r = identityConsistency([piconSample(`c_${text}`, [{ role: 'other', text: '随便说说' }, { role: 'self', text }])]);
    assert.equal(AI_SELF_RE.test(text), expect, `「${text}」先钉 persona.js 的 AI_SELF_RE 判定`);
    assert.equal(r.aiSelfRate, expect ? 1 : 0, `「${text}」自称判定应与 AI_SELF_RE 同口径`);
    if (expect) assert.equal(r.unsolicitedRate, 1, '非追问语境的自称记无端');
  }
  // 「作为AI…」变体：P0.4 旧口径 /我是(AI|…)/ 不命中、AI_SELF_RE 命中 → 证明复用的是 persona 正则
  assert.ok(!/我是\s?(AI|人工智能|助手|模型|程序)/.test('作为AI插一句'));
  assert.equal(identityConsistency([piconSample('v1', [{ role: 'other', text: '随便说说' }, { role: 'self', text: '作为AI插一句' }])]).aiSelfRate, 1);
  // 被追问语境（你到底是什么）的承认不算无端
  assert.deepEqual(
    identityConsistency([piconSample('v2', [{ role: 'other', text: '你到底是什么' }, { role: 'self', text: '我是AI模型' }])]),
    { aiSelfRate: 1, unsolicitedRate: 0, score: 1 }
  );
  // 空输入记满分
  assert.deepEqual(identityConsistency([]), { aiSelfRate: 0, unsolicitedRate: 0, score: 1 });
});

test('PICon：styleConsistency 黄金值（跨样本方差归一 + 禁词率）', () => {
  // 全同句长/无标点/无语气词/无禁词 → 方差 0 → 满分
  const same = [
    piconSample('s1', [{ role: 'self', text: '今天天气' }]),
    piconSample('s2', [{ role: 'self', text: '今天天气' }])
  ];
  assert.deepEqual(styleConsistency(same), { varianceScore: 1, bannedRate: 0, score: 1 });

  // 4 条等句长（均 4 字/1 句）、无标点无语气词，其中 1 条命中禁词「综上所述」
  // → varianceScore=1、bannedRate=1/4=0.25、score=1×0.75=0.75
  const banned = ['今天天气', '明天放假', '后天再说', '综上所述']
    .map((t, i) => piconSample(`b${i}`, [{ role: 'self', text: t }]));
  assert.deepEqual(styleConsistency(banned), { varianceScore: 1, bannedRate: 0.25, score: 0.75 });

  // 句长跨样本方差 = ((2−4)²+(6−4)²)/2 = 4 → 1−4/25=0.84；标点/语气词方差 0 → (0.84+1+1)/3≈0.947
  const varied = [
    piconSample('v1', [{ role: 'self', text: '你好' }]),
    piconSample('v2', [{ role: 'self', text: '今天天气真好' }])
  ];
  assert.deepEqual(styleConsistency(varied), { varianceScore: 0.947, bannedRate: 0, score: 0.947 });

  // 空输入记满分
  assert.deepEqual(styleConsistency([]), { varianceScore: 1, bannedRate: 0, score: 1 });
});

test('PICon：personaConsistency 黄金值（红线禁忌命中率 + 说话特征覆盖率）', () => {
  const samples = [
    piconSample('p1', [{ role: 'self', text: '好耶' }]),
    piconSample('p2', [{ role: 'self', text: '他背叛了我' }])
  ];
  // 禁忌「背叛」命中 1 次 → tabooRate 0.5；特征「好耶」覆盖 1/2 → score=mean(0.5, 0.5)=0.5
  assert.deepEqual(
    personaConsistency(samples, { tabooWords: ['背叛'], speechFeatures: ['好耶', '哼哼'] }),
    { tabooHits: 1, featureCoverage: 0.5, score: 0.5 }
  );
  // 无禁忌命中 + 特征全覆盖 → 满分；不给词表 = 不设要求即满分
  assert.deepEqual(
    personaConsistency(samples, { tabooWords: ['叛徒'], speechFeatures: ['好耶'] }),
    { tabooHits: 0, featureCoverage: 1, score: 1 }
  );
  assert.deepEqual(personaConsistency(samples), { tabooHits: 0, featureCoverage: 1, score: 1 });
  assert.deepEqual(personaConsistency([]), { tabooHits: 0, featureCoverage: 1, score: 1 });
});

test('PICon：piconReport 三项合成 overall 黄金值', () => {
  const samples = ['今天天气', '明天放假', '后天再说', '综上所述']
    .map((t, i) => piconSample(`r${i}`, [{ role: 'self', text: t }]));
  const opts = { tabooWords: ['背叛'], speechFeatures: ['今天天气'] };
  const report = piconReport(samples, opts);
  // identity 无自称=1；style 禁词 1/4 → 0.75；persona 无禁忌+特征全覆盖=1 → overall=(1+0.75+1)/3≈0.917
  assert.deepEqual(report.identity, { aiSelfRate: 0, unsolicitedRate: 0, score: 1 });
  assert.deepEqual(report.style, { varianceScore: 1, bannedRate: 0.25, score: 0.75 });
  assert.deepEqual(report.persona, { tabooHits: 0, featureCoverage: 1, score: 1 });
  assert.equal(report.overall, 0.917);
  // 三项必须原样透传自各分项函数（合成不重算）
  assert.deepEqual(report.identity, identityConsistency(samples));
  assert.deepEqual(report.style, styleConsistency(samples));
  assert.deepEqual(report.persona, personaConsistency(samples, opts));
});

test('llmScreen：无 judge 离线 skip 绝不触网 + fake judge 汇总', async () => {
  // 无 judge：skip 且一次网络请求都不能有（测试/CI 无网络契约）
  const origFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => {
    fetched += 1;
    throw new Error('默认路径绝不触网');
  };
  try {
    assert.deepEqual(await llmScreen([piconSample('a', [])]), { skipped: true, reason: 'no-judge' });
    assert.equal(fetched, 0, '无 judge 时不得触网');
  } finally {
    globalThis.fetch = origFetch;
  }
  // DSH 适配器可选：构造与默认路径也不触网，且必须显式给 baseUrl
  assert.equal(typeof createDshJudge({ baseUrl: 'http://127.0.0.1:1' }), 'function');
  assert.throws(() => createDshJudge({}), /baseUrl/);

  // fake judge（依赖注入）：逐条判定 + 汇总计数
  const samples = [
    piconSample('a', [], { tag: 'ok' }),
    piconSample('b', [], { tag: 'bad' }),
    piconSample('c', [], { tag: 'ok' })
  ];
  const judge = async (s) => (s.tag === 'bad'
    ? { verdict: 'fail', note: '违禁' }
    : { verdict: 'pass', note: 'ok' });
  const r = await llmScreen(samples, { judge });
  assert.equal(r.skipped, false);
  assert.equal(r.pass, 2);
  assert.equal(r.suspect, 0);
  assert.equal(r.fail, 1);
  assert.deepEqual(r.verdicts.map((v) => v.id), ['a', 'b', 'c']);
  assert.deepEqual(r.verdicts.map((v) => v.verdict), ['pass', 'fail', 'pass']);
  assert.deepEqual(r.verdicts.map((v) => v.note), ['ok', '违禁', 'ok']);
});

test('人评盲测包：同 seed 可复现、脱敏不落明文标识符/模型名、不同 seed 洗牌', () => {
  const samples = [0, 1, 2].map((i) => piconSample(`q-${999999999 + i}`, [
    { role: 'other', who: '路人小明', text: `明天开会 ${987654321 + i} 记得来` },
    { role: 'self', who: 'bot', text: '好' }
  ], {
    message: { who: '路人小明', text: '几点开始' },
    candidates: [{ model: 'gpt-5', text: '回复甲' }, { model: 'claude-x', text: '回复乙' }]
  }));
  const p1 = buildBlindPack(samples, { seed: 7 });
  const p2 = buildBlindPack(samples, { seed: 7 });
  assert.deepEqual(p1, p2, '同 seed 两次必须逐字段一致（seeded RNG 可复现）');

  // 脱敏硬要求：JSON 里不得出现样本中的 QQ 号/姓名/模型名/来源
  const body = JSON.stringify(p1);
  for (const secret of ['路人小明', '987654321', '987654322', '987654323', '999999999', '1000000000', '1000000001', 'gpt-5', 'claude-x']) {
    assert.ok(!body.includes(secret), `盲测包不得含明文标识符/模型名 ${secret}`);
  }

  // 结构：每条恰含 id/context/candidate；多模型候选带匿名标签 A/B 且只留文本
  assert.equal(p1.items.length, 3);
  for (const item of p1.items) {
    assert.deepEqual(Object.keys(item).sort(), ['candidate', 'context', 'id']);
    assert.ok(/^h_[0-9a-f]{8}$/.test(item.id), '标识符必须哈希化（照 trace.js）');
    assert.ok(Array.isArray(item.context) && item.context.length === 3, 'context = 上文 2 条 + 触发消息 1 条');
    assert.ok(item.context.every((c) => Object.keys(c).sort().join() === 'role,text'), 'context 只留 role/text');
    assert.ok(Array.isArray(item.candidate) && item.candidate.length === 2);
    assert.deepEqual(item.candidate.map((c) => c.label).sort(), ['A', 'B']);
    assert.deepEqual(item.candidate.map((c) => c.text).sort(), ['回复甲', '回复乙'].sort());
    assert.ok(item.candidate.every((c) => Object.keys(c).sort().join() === 'label,text'), '候选不带模型名/来源');
  }

  // 不同 seed：条目顺序必须洗开
  const p3 = buildBlindPack(samples, { seed: 3 });
  assert.notDeepEqual(p1.items.map((x) => x.id), p3.items.map((x) => x.id), '不同 seed 洗牌顺序应不同');
});

test('scoreBlindPack：均分/胜率 + 缺失评分跳过不报错', () => {
  const samples = [0, 1, 2].map((i) => piconSample(`s${i}`, [
    { role: 'other', text: '在吗' },
    { role: 'self', text: '在的' }
  ], { reply: '在的呀' }));
  const pack = buildBlindPack(samples, { seed: 1 });
  const [first, , last] = pack.items;
  // 只回填 2 条（中间那条缺失）：5 分记胜、2 分记负
  const r = scoreBlindPack(pack, [
    { id: first.id, score: 5 },
    { id: last.id, score: 2 },
    { id: 'h_unknown00', score: 4 } // 未知 id 忽略
  ]);
  assert.deepEqual(r, { rated: 2, skipped: 1, meanScore: 3.5, winRate: 0.5 });
  // 全缺：均分/胜率为 null 而不是报错
  assert.deepEqual(scoreBlindPack(pack, []), { rated: 0, skipped: 3, meanScore: null, winRate: null });
});

test('runReport：同输入两次 deepEqual（评分报告可复现）', async () => {
  const samples = [
    piconSample('g1', [{ role: 'other', text: '你是AI吗' }, { role: 'self', text: '我是AI模型' }], {
      key: 'private:h_abcd1234',
      annotation: { addressee: 'me', speakSilent: 'speak', replyTo: null, topic: null, question: true, source: 'auto-seed' },
      baseline: { v2Replied: true, replyLatencyMs: 3000 }
    }),
    piconSample('g2', [{ role: 'other', text: '随便聊聊' }, { role: 'self', text: '好耶' }])
  ];
  const args = {
    samples,
    corpus: 'corpus.jsonl',
    predictions: [{ id: 'g1', addressee: 'me', speakSilent: 'speak' }],
    judge: async () => ({ verdict: 'pass', note: 'ok' }),
    tabooWords: ['背叛'],
    speechFeatures: ['好耶'],
    blind: true,
    seed: 3,
    now: '2026-10-25T00:00:00.000Z',
    baseline: { piconOverall: 0.3 },
    strict: true
  };
  const r1 = await runReport(args);
  const r2 = await runReport(args);
  assert.deepEqual(r1, r2, '同输入两次输出必须 deepEqual（含盲测包洗牌）');
  assert.equal(r1.meta.generatedAt, '2026-10-25T00:00:00.000Z', '时间戳走 now 注入');
  assert.deepEqual(
    Object.keys(r1).sort(),
    ['blindPack', 'gates', 'llm', 'meta', 'picon', 'v2Baseline', 'v3'].sort()
  );
  assert.equal(r1.meta.sampleCount, 2);
  assert.equal(r1.v2Baseline.overall.reply, 1);
  assert.equal(r1.llm.pass, 2);
  assert.equal(r1.v3.addresseeAccuracy, 1);
  assert.deepEqual(r1.gates, { pass: true, failures: [] });
});

test('checkGates：倒退/strict 漏回/LLM fail 率超限三门槛分支', () => {
  // ① PICon 不倒退：低于基线不过（给了基线就查，与 strict 无关）
  const regressed = checkGates({ picon: { overall: 0.5 } }, { baseline: { piconOverall: 0.6 } });
  assert.equal(regressed.pass, false);
  assert.equal(regressed.failures.length, 1);
  assert.match(regressed.failures[0], /不倒退/);
  // 恰好等于基线 = 不倒退
  assert.deepEqual(checkGates({ picon: { overall: 0.6 } }, { baseline: { piconOverall: 0.6 } }), { pass: true, failures: [] });

  // ② strict 私聊漏回（沿用 P0.4 strict 门槛逻辑）；非 strict 不查
  const missed = checkGates({ v3: { privateFalseSilence: 2 } }, { strict: true });
  assert.equal(missed.pass, false);
  assert.match(missed.failures[0], /私聊出现漏回/);
  assert.equal(checkGates({ v3: { privateFalseSilence: 2 } }).pass, true, '非 strict 不查私聊漏回');

  // ③ strict 时 LLM fail 率 > 0.1 不过：0.2 拦下、恰 0.1 放行、skip 放行、非 strict 放行
  const hot = checkGates({ llm: { skipped: false, pass: 8, suspect: 0, fail: 2, verdicts: [] } }, { strict: true });
  assert.equal(hot.pass, false);
  assert.match(hot.failures[0], /fail 率/);
  assert.equal(checkGates({ llm: { skipped: false, pass: 9, suspect: 0, fail: 1, verdicts: [] } }, { strict: true }).pass, true);
  assert.equal(checkGates({ llm: { skipped: true, reason: 'no-judge' } }, { strict: true }).pass, true);
  assert.equal(checkGates({ llm: { skipped: false, pass: 8, suspect: 0, fail: 2, verdicts: [] } }).pass, true, '非 strict 不查 fail 率');

  // 全过
  assert.deepEqual(
    checkGates(
      { picon: { overall: 0.9 }, v3: { privateFalseSilence: 0 }, llm: { skipped: true, reason: 'no-judge' } },
      { baseline: { piconOverall: 0.8 }, strict: true }
    ),
    { pass: true, failures: [] }
  );
});

test('checkGates：覆盖率 / F1 / shadow 轮数（P1.6 验收门槛）', () => {
  const low = checkGates(
    { v3: { covered: 0, speakSilentF1: 0 } },
    { strict: true, minCovered: 50, minF1: 0.5, minTurns: 500, shadowTurns: 2 }
  );
  assert.equal(low.pass, false);
  assert.ok(low.failures.some((f) => /对齐/.test(f)), '覆盖不足要报');
  assert.ok(low.failures.some((f) => /F1/.test(f)), 'F1 不足要报');
  assert.ok(low.failures.some((f) => /shadow 轮数/.test(f)), '轮数不足要报');

  assert.deepEqual(
    checkGates(
      { v3: { covered: 60, speakSilentF1: 0.6, privateFalseSilence: 0 } },
      { strict: true, minCovered: 50, minF1: 0.5, minTurns: 500, shadowTurns: 500 }
    ),
    { pass: true, failures: [] }
  );
  // 未显式给门槛时不得凭空新增失败（保持既有调用方兼容）
  assert.equal(checkGates({ v3: { covered: 0, speakSilentF1: 0 } }, { strict: true }).pass, true);
  // 只给 minCovered 时只查覆盖
  assert.equal(checkGates({ v3: { covered: 10, speakSilentF1: 0 } }, { minCovered: 5 }).pass, true);
});

test('语料抽取：默认从最新往回取，保证与 shadow 预测可对齐', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'corpus');
  const run = spawnSync(process.execPath, [CORPUS, '--state', makeFixture(dir), '--out', out, '--max', '2'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const rows = fs.readFileSync(path.join(out, 'corpus.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.message.text.includes('明天几点开会')), '必须选到私聊最新一条');
  assert.ok(rows.some((r) => r.message.text.includes('帮我记下')), '必须选到群聊最新一条');
  // 输出仍按时间升序
  assert.ok((rows[0].ts || 0) <= (rows[1].ts || 0));
});

test('trace→predictions：写 shadow 轮数元数据，--min-turns 不足时退出码 1', () => {
  const dir = tmpDir();
  const traceFile = path.join(dir, 'trace.jsonl');
  const line = (turnId, sample) => JSON.stringify({
    turnId,
    ts: '2026-10-25T00:00:00.000Z',
    key: 'group:h_x',
    attention: {
      source: 'rule-v3-shadow',
      predictedAction: 'silent',
      predictedSpeakSilent: 'silent',
      predictedAddressee: 'unknown',
      forSampleIds: [sample]
    }
  });
  fs.writeFileSync(traceFile, `${line('1', 's_a')}\n${line('2', 's_b')}\n`, 'utf8');
  const out = path.join(dir, 'pred.jsonl');

  const strict = spawnSync(process.execPath, [PREDICTIONS, '--trace', traceFile, '--out', out, '--min-turns', '500'], { encoding: 'utf8' });
  assert.equal(strict.status, 1, 'shadow 不足 500 轮必须退出码 1');
  assert.ok(/shadow 轮数不足/.test(strict.stderr));
  const meta = JSON.parse(fs.readFileSync(`${out}.meta.json`, 'utf8'));
  assert.equal(meta.shadowTurns, 2);
  assert.equal(meta.sampleCount, 2);

  const pass = spawnSync(process.execPath, [PREDICTIONS, '--trace', traceFile, '--out', out, '--min-turns', '1'], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
});

test('CLI 兼容：不带新参数行为不变 + --picon 输出确定性', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'corpus');
  assert.equal(spawnSync(process.execPath, [CORPUS, '--state', makeFixture(dir), '--out', out], { encoding: 'utf8' }).status, 0);
  const corpusFile = path.join(out, 'corpus.jsonl');

  // 不带新参数：与 P0.4 现状一致（退出码 0 + 既有摘要行）
  const run = spawnSync(process.execPath, [EVAL, '--corpus', corpusFile, '--out', path.join(dir, 'e')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(/评估完成：6 样本/.test(run.stdout));
  assert.ok(/V2 基线：回 3 \/ 沉默 3/.test(run.stdout));

  // --picon：只算三项、退出码 0、跑两次输出逐字节一致（可复现）
  const p1 = spawnSync(process.execPath, [EVAL, '--corpus', corpusFile, '--out', path.join(dir, 'p1'), '--picon'], { encoding: 'utf8' });
  const p2 = spawnSync(process.execPath, [EVAL, '--corpus', corpusFile, '--out', path.join(dir, 'p2'), '--picon'], { encoding: 'utf8' });
  assert.equal(p1.status, 0, p1.stderr);
  assert.equal(p2.status, 0, p2.stderr);
  assert.equal(p1.stdout, p2.stdout, '--picon 输出必须确定性（两次无差异）');
  assert.ok(/PICon 三项一致性/.test(p1.stdout));
  assert.ok(/overall=/.test(p1.stdout));
  const piconJson = JSON.parse(fs.readFileSync(path.join(dir, 'p1', 'picon.json'), 'utf8'));
  assert.deepEqual(Object.keys(piconJson).sort(), ['identity', 'overall', 'persona', 'style']);

  // --blind：出脱敏盲测包（含 --strict 时无门槛数据也应放行）
  const blindFile = path.join(dir, 'blind.json');
  const b1 = spawnSync(process.execPath, [EVAL, '--corpus', corpusFile, '--blind', blindFile, '--seed', '7', '--out', path.join(dir, 'be'), '--strict'], { encoding: 'utf8' });
  assert.equal(b1.status, 0, b1.stderr);
  const pack = JSON.parse(fs.readFileSync(blindFile, 'utf8'));
  assert.equal(pack.items.length, 6);
  assert.ok(!JSON.stringify(pack).includes('999999999'), '盲测包不得含明文 QQ 号');
});
