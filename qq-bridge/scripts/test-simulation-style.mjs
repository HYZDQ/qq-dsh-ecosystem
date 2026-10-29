// GEN3 风格模块回归（对应 docs/design/GEN3_SIMULATION_PLAN.md 6.5 节硬约束）：
//   1. AI 腔文本必被检出（禁词/八股/排比/句长/标点/emoji/长解释七类检测器）；
//   2. 正常 QQ 口语 20 条误报率 ≤10%（maxFalsePositiveRate 门槛）；
//   3. rewriteLite 不改事实/数字/链接/承诺句、不插入随机语气词、不改变称呼；
//   4. 敏感话题（严肃/哀悼/医疗/法律）不改写；
//   5. 纯函数确定性 + maxMs 超时预算语义（时钟可注入）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BANNED_PHRASES,
  FILLER_WORDS,
  SENSITIVE_TOPIC_WORDS,
  buildProfile,
  detectStyle,
  isSensitiveTopic,
  rewriteLite
} from '../src/simulation/style.js';

/** 取指定命中的 flag。 */
function findFlag(flags, id) {
  return flags.find((f) => f.id === id);
}

test('detectStyle：AI 腔样本七类检测器全部命中（含置信度门槛）', () => {
  const cases = [
    {
      name: '禁词/客服腔/八股结尾',
      text: '这个方法非常好用，一绝。综上所述，坚持练习就能提高成绩。希望以上对你有帮助，如有疑问欢迎随时提问。',
      id: 'banned-phrase',
      minConf: 0.8
    },
    {
      name: '三连排比',
      text: '我们要坚持学习，我们要坚持锻炼，我们要坚持早睡，我们才能变得更好。',
      id: 'triple-parallel',
      minConf: 0.8
    },
    {
      name: '首先其次最后（总分总）',
      text: '首先，我们要制定计划。其次，我们要严格执行。最后，我们要及时复盘。',
      id: 'essay-structure',
      minConf: 0.8
    },
    {
      name: '不仅…而且…八股句式',
      text: '这个方法不仅省时，而且省力，而且省钱。',
      id: 'essay-structure',
      minConf: 0.8
    },
    {
      name: '句长方差过低（太整齐）',
      text: '今天天气很好。我们去公园玩吧。晚上一起吃饭。明天再去逛街。后天一起看书。',
      id: 'low-length-variance',
      minConf: 0.5
    },
    {
      name: '感叹号密度异常',
      text: '这也太棒了吧！！！真的超级推荐！！！谁用谁知道！！！',
      id: 'punct-density',
      minConf: 0.8
    },
    {
      name: '全篇 emoji/表情堆叠',
      text: '🥰🥰🥰🥰🥰🥰真的绝了',
      id: 'emoji-pileup',
      minConf: 0.8
    },
    {
      name: '过长的解释性段落',
      text: `${'这个问题需要解释清楚，'.repeat(20)}差不多就是这个意思。`,
      id: 'long-explanation',
      minConf: 0.8
    }
  ];
  for (const c of cases) {
    const { flags, score } = detectStyle(c.text);
    assert.ok(flags.length >= 1, `${c.name}：必须被检出`);
    const hit = findFlag(flags, c.id);
    assert.ok(hit, `${c.name}：缺 ${c.id}，实际 ${JSON.stringify(flags.map((f) => f.id))}`);
    assert.ok(hit.confidence >= c.minConf, `${c.name}：${c.id} 置信度 ${hit.confidence} < ${c.minConf}`);
    assert.ok(hit.evidence && typeof hit.evidence === 'object', `${c.name}：必须带 evidence`);
    assert.ok(score > 0, `${c.name}：score 必须 > 0`);
    assert.ok(score <= 1, `${c.name}：score 必须 ≤ 1`);
    for (const f of flags) {
      assert.ok(f.confidence >= 0 && f.confidence <= 1, `${c.name}：置信度越界`);
    }
  }
});

test('detectStyle：正常 QQ 口语 20 条误报率 ≤10%', () => {
  const NORMAL_SAMPLES = [
    '在吗',
    '笑死，你怎么才来',
    '今天好累啊，躺了',
    '晚上开黑不，我带你上分',
    '哈哈哈哈哈哈',
    '刚吃完火锅，撑死我了',
    '那个文件我发你了，你看下',
    '明天考试，还没复习完，裂开',
    '真的假的？？',
    '我去，这谁顶得住',
    '周末有空，出来玩啊😂',
    '记得带伞，今天下午有雨',
    '嗯嗯知道了，谢啦',
    '这歌好好听，单曲循环一晚上',
    '困了，先睡了，晚安',
    '你作业写完了吗，借我抄抄',
    '。。。这也太离谱了',
    '打完这把就写作业，真的',
    '我手机快没电了，等会儿说',
    '好耶！！！'
  ];
  assert.equal(NORMAL_SAMPLES.length, 20);
  const falsePositives = [];
  for (const s of NORMAL_SAMPLES) {
    const { flags } = detectStyle(s);
    if (flags.length > 0) falsePositives.push({ s, ids: flags.map((f) => f.id) });
  }
  const rate = falsePositives.length / NORMAL_SAMPLES.length;
  console.log(`[style] 正常口语误报率：${falsePositives.length}/${NORMAL_SAMPLES.length} = ${(rate * 100).toFixed(1)}%`);
  assert.ok(rate <= 0.10, `误报率 ${rate} 超过 10%：${JSON.stringify(falsePositives)}`);
});

test('rewriteLite：删套话，但数字/链接/承诺句一字不动', () => {
  const text = '总的来说，这个方法值得一试。成本降低了30%，详情见 https://example.com/doc?id=7 。我保证明天还你。希望以上对你有帮助！！！';
  const { flags } = detectStyle(text);
  const hit = findFlag(flags, 'banned-phrase');
  assert.ok(hit && hit.confidence >= 0.8, '禁词命中应达高置信度');
  const r = rewriteLite(text, flags, { now: () => 0 });
  assert.equal(r.changed, true);
  assert.equal(r.suggestRetry, true, '高置信度应建议重试一次');
  // 硬约束：事实/数字/链接/承诺句原文保留
  assert.ok(r.text.includes('30%'), '数字必须保留');
  assert.ok(r.text.includes('https://example.com/doc?id=7'), '链接必须保留');
  assert.ok(r.text.includes('我保证明天还你。'), '承诺句必须原文保留');
  assert.equal(r.text.split('30').length - 1, text.split('30').length - 1, '数字出现次数不变');
  // 套话被删
  assert.ok(!r.text.includes('总的来说'), '套话连接词应删除');
  assert.ok(!r.text.includes('希望以上对你有帮助'), '八股结尾应删除');
  assert.ok(r.applied.some((a) => a.id === 'drop-cliche'), '应记录改写动作');
});

test('rewriteLite：敏感话题（严肃/哀悼/医疗/法律）不改写', () => {
  const sad = '他上周住院了，查出来是癌症，正在化疗。综上所述，我们要多注意身体，希望以上对你有帮助。';
  assert.equal(isSensitiveTopic(sad), true);
  const { flags } = detectStyle(sad);
  assert.ok(findFlag(flags, 'banned-phrase'), '敏感话题仍要检出并记录');
  const r = rewriteLite(sad, flags, { now: () => 0 });
  assert.equal(r.changed, false, '敏感话题禁止改写');
  assert.equal(r.text, sad, '敏感话题必须发原稿');
  assert.deepEqual(r.skipped, ['sensitive-topic']);
  assert.equal(r.suggestRetry, false);
});

test('rewriteLite：低置信度放行并记录；已重试过不再改写', () => {
  const text = '这个方法非常好用，一绝。';
  const r1 = rewriteLite(text, [{ id: 'triple-parallel', confidence: 0.55, evidence: {} }], { now: () => 0 });
  assert.equal(r1.changed, false);
  assert.deepEqual(r1.skipped, ['low-confidence']);
  assert.equal(r1.text, text);
  const { flags } = detectStyle(text);
  assert.ok(flags.some((f) => f.confidence >= 0.8));
  const r2 = rewriteLite(text, flags, { now: () => 0, alreadyRetried: true });
  assert.equal(r2.changed, false, '只允许一次重试/轻改');
  assert.deepEqual(r2.skipped, ['already-retried']);
});

test('rewriteLite：maxMs 超时预算语义（时钟可注入、超预算发原稿）', () => {
  const text = '这个方法非常好用，一绝。综上所述，坚持练习就行。';
  const { flags } = detectStyle(text);
  // 预算中途耗尽：放弃改写、发原稿、不再建议重试
  let n = 0;
  const r1 = rewriteLite(text, flags, { maxMs: 10, now: () => (n++ === 0 ? 0 : 10000) });
  assert.equal(r1.changed, false);
  assert.deepEqual(r1.skipped, ['budget-exhausted']);
  assert.equal(r1.text, text);
  assert.equal(r1.suggestRetry, false);
  // maxMs<=0 直接放弃
  const r2 = rewriteLite(text, flags, { maxMs: 0, now: () => 0 });
  assert.deepEqual(r2.skipped, ['budget-exhausted']);
  assert.equal(r2.changed, false);
  // 预算充足正常改写
  const r3 = rewriteLite(text, flags, { maxMs: 2000, now: () => 0 });
  assert.equal(r3.changed, true);
  assert.ok(r3.applied.length > 0);
});

test('rewriteLite：纯函数确定性、不插语气词、不改称呼', () => {
  const text = '哥，这个真管用，总的来说不错，你快试试，好耶。';
  const a = detectStyle(text);
  const b = detectStyle(text);
  assert.deepEqual(a, b, 'detectStyle 必须确定性');
  const r1 = rewriteLite(text, a.flags, { now: () => 0 });
  const r2 = rewriteLite(text, b.flags, { now: () => 0 });
  assert.deepEqual(r1, r2, 'rewriteLite 必须确定性');
  assert.equal(r1.changed, true);
  assert.ok(!r1.text.includes('真管用') && !r1.text.includes('总的来说'));
  // 不改变称呼/关系
  for (const w of ['哥']) {
    const count = (s) => s.split(w).length - 1;
    assert.equal(count(r1.text), count(text), `称呼「${w}」不得变化`);
  }
  // 不插入随机语气词：输出里出现的语气词必须是原文就有的
  const added = FILLER_WORDS.filter((w) => r1.text.includes(w) && !text.includes(w));
  assert.deepEqual(added, [], `禁止插入语气词：${JSON.stringify(added)}`);
  // 原有语气词不得被改写误删出新词（原有内容只做删除级改动）
  assert.ok(r1.text.includes('好耶'), '原语气词保留');
});

test('buildProfile：句长/标点/语气词/表情/称呼/话题画像', () => {
  const samples = [
    '今天好累啊，躺了',
    '晚上开黑不，我带你上分',
    '好耶！！！',
    '这歌好好听😂😂',
    '哥，作业写完了吗'
  ];
  const p = buildProfile(samples);
  assert.equal(p.sampleCount, 5);
  assert.ok(p.totalChars > 0);
  assert.ok(p.sentenceLength.count >= 5);
  assert.ok(p.sentenceLength.mean > 0);
  assert.ok(p.sentenceLength.max >= p.sentenceLength.mean);
  assert.ok(p.sentenceLength.shortRatio >= 0 && p.sentenceLength.shortRatio <= 1);
  assert.ok(p.punctuation.exclaim > 0, '感叹号密度应统计到');
  assert.ok(p.fillers.rate > 0, '语气词率应统计到');
  assert.ok(Array.isArray(p.fillers.top));
  assert.equal(p.emoji.count, 2);
  assert.ok(p.address.self.some((x) => x.word === '我'), '自称应统计到');
  assert.ok(p.address.other.some((x) => x.word === '哥'), '称呼应统计到');
  assert.ok(p.topics.preferred.length > 0, '话题偏好应统计到');
  // 话题禁忌可注入（角色卡禁忌词）
  const p2 = buildProfile(samples, { tabooWords: ['开黑'] });
  assert.ok(p2.topics.taboo.some((x) => x.word === '开黑'));
  // 空输入不炸
  const p3 = buildProfile([]);
  assert.equal(p3.sampleCount, 0);
  assert.equal(p3.sentenceLength.count, 0);
});

test('isSensitiveTopic：词表 + 正则兜底 + 可扩展', () => {
  assert.equal(isSensitiveTopic(''), false);
  assert.equal(isSensitiveTopic('今天吃火锅，好撑'), false);
  assert.equal(isSensitiveTopic('他上周去世了'), true, '哀悼类');
  assert.equal(isSensitiveTopic('医生说要住院做手术'), true, '医疗类');
  assert.equal(isSensitiveTopic('准备去法院起诉他'), true, '法律类');
  assert.equal(isSensitiveTopic('查出来是肺癌晚期'), true, '正则兜底');
  assert.equal(isSensitiveTopic('有点zz雷区', { wordLists: { sensitive: ['zz雷区'] } }), true, '词表可扩展');
  assert.ok(SENSITIVE_TOPIC_WORDS.length >= 50, '敏感词表应有规模');
});

test('词表可扩展：options.wordLists 追加禁词即生效，不追加不误报', () => {
  const text = '这个产品真是业界良心。';
  assert.equal(detectStyle(text).flags.length, 0, '默认词表不得误报');
  const { flags } = detectStyle(text, { wordLists: { banned: ['业界良心'] } });
  const hit = findFlag(flags, 'banned-phrase');
  assert.ok(hit && hit.confidence >= 0.8, '追加禁词应立即生效');
});

test('detectStyle：空文本安全 + 词表规模在位', () => {
  assert.deepEqual(detectStyle(''), { flags: [], score: 0 });
  assert.deepEqual(detectStyle(null), { flags: [], score: 0 });
  assert.ok(BANNED_PHRASES.length >= 50, '禁词表应有规模');
  assert.ok(FILLER_WORDS.length >= 30, '语气词表应有规模');
});
