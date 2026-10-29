// 三代仿真风格模块（GEN3，设计见 docs/design/GEN3_SIMULATION_PLAN.md 6.5 节）：
// 生成后自检「AI 味」+ 高置信度时本地规则轻改写。
//
// 硬约束（6.5 处理规则，全部落在纯函数里）：
//   1. 检测输出 flags（命中项 + 每项置信度 0~1）与总体 score；
//   2. 高置信度（默认 ≥0.8）且非敏感话题 → 轻改写 / 建议重试一次；低置信度 → 放行并记录；
//   3. 改写不改事实、数字、链接、承诺句；不插入随机语气词；不改变称呼/关系；
//   4. 严肃/哀悼/医疗/法律话题不走「卖萌化」改写（isSensitiveTopic 词表+正则识别）；
//   5. 超时预算语义：调用方传 maxMs（默认 2000ms），模块内不做异步、只保证纯函数快，
//      预算耗尽直接放弃改写发原稿（时钟可注入，测试可确定性复现）。
//
// 全模块零 IO、无隐藏随机、可注入（词表 options.wordLists 追加扩展、时钟 options.now）。

// ──────────────────────────── 词表（可扩展常量） ────────────────────────────

/** 客服腔（单发即中，置信度高）。 */
export const CUSTOMER_SERVICE_PHRASES = Object.freeze([
  '很高兴为您服务', '很乐意为您服务', '竭诚为您服务', '为您服务', '为您解答',
  '感谢您的反馈', '感谢你的反馈', '感谢您的耐心等待', '感谢你的耐心等待', '感谢您的支持',
  '温馨提示', '小贴士', '给您带来不便', '抱歉给您带来不便', '请耐心等待', '请注意查收',
  '您的问题已收到', '我们会尽快处理', '已为您', '如有问题请联系', '如有疑问请联系',
  '欢迎随时咨询', '祝您生活愉快', '祝您愉快'
]);

/** 八股/套话（AI 味高频词，单发即中）。 */
export const ESSAY_PHRASES = Object.freeze([
  '综上所述', '总的来说', '总而言之', '简而言之', '总的来说',
  '值得一提的是', '值得注意的是', '需要指出的是', '不难发现', '显而易见', '众所周知',
  '由此可见', '更重要的是', '换言之', '换而言之', '在此基础上', '基于此',
  '一绝', '堪称一绝', '真管用', '显著提升', '极大地', '有效地帮助', '干货满满', '全面解析', '深入浅出'
]);

/** 八股结尾（客服式收尾，单发即中）。 */
export const CLOSING_CLICHES = Object.freeze([
  '希望以上对你有帮助', '希望这对你有帮助', '希望我的回答对你有帮助', '希望对你有帮助',
  '希望这些建议对你有帮助', '希望以上内容对你有帮助', '以上就是我的回答', '以上就是全部内容',
  '如有疑问欢迎随时提问', '如有问题欢迎随时提问', '如有其他问题欢迎', '欢迎随时提出',
  '感谢你的耐心阅读', '感谢您的耐心阅读', '感谢阅读', '期待与你再次交流',
  '祝你生活愉快', '让我们一起加油', '让我们共同努力', '共同进步', '让生活更美好',
  '希望每个人都能', '希望我们都能'
]);

/** 禁词全集（客服腔 + 八股 + 八股结尾）。 */
export const BANNED_PHRASES = Object.freeze([...CUSTOMER_SERVICE_PHRASES, ...ESSAY_PHRASES, ...CLOSING_CLICHES]);

/**
 * 弱连接词：口语里偶尔也用，单发不报警，累计 ≥2 次成低置信度 flag（放行并记录）。
 * 「首先/其次/最后」这类在八股文里成组出现，单字出现不算命中。
 */
export const WEAK_CONNECTIVES = Object.freeze([
  '首先', '其次', '再次', '此外', '因此', '总之', '综上', '不仅', '而且', '并且',
  '进而', '从而', '基于此', '换言之', '也就是说', '事实上', '实际上', '与此同时',
  '除此之外', '一方面', '另一方面', '更重要的是', '由此可见', '总的来说'
]);

/**
 * 八股结构正则（不仅…而且 / 首先…其次…最后 / 一方面…另一方面 / 分点编号），单发即中。
 * 允许跨句（「首先，……。其次，……」是典型八股形态），但长度有界防误吞。
 */
export const ESSAY_PATTERNS = Object.freeze([
  { id: 'not-only-but-also', re: /不仅[^！？!?]{1,40}而且/, confidence: 0.85 },
  { id: 'first-then-finally', re: /首先[，,、：:][^！？!?]{2,60}(?:其次|第二)[，,、：:]?[^！？!?]{2,60}(?:最后|第三|总之|综上)/, confidence: 0.9 },
  { id: 'first-then', re: /首先[，,、：:][^！？!?]{2,60}(?:其次|然后)[，,、：:]/, confidence: 0.85 },
  { id: 'on-one-hand', re: /一方面[^！？!?]{2,60}另一方面/, confidence: 0.85 },
  { id: 'numbered-list', re: /(?:^|[。！？!?\n])\s*(?:1[.、)]|①|一[是、.])[^。！？]{2,40}(?:2[.、)]|②|二[是、.])/, confidence: 0.8 }
]);

/**
 * 弱连接词的「裸形」可删集合：即使没有紧跟逗号也只删虚词、不动实义（不仅/而且/换言之…）。
 * 「首先/其次/最后/因此/总之」等口语常用词不进这里，只删带逗号的整段（见 rewriteLite）。
 */
export const BARE_DELETABLE_CONNECTIVES = Object.freeze([
  '不仅', '而且', '并且', '进而', '从而', '更重要的是', '与此同时', '除此之外',
  '基于此', '换言之', '也就是说', '由此可见', '综上', '事实上', '实际上'
]);

/** 语气词/口头禅（只进风格画像，不作为违规 flag）。 */
export const FILLER_WORDS = Object.freeze([
  '呢', '吧', '啊', '呀', '哦', '噢', '嗯', '嘛', '呗', '啦', '哇', '诶', '欸', '咯', '耶', '呃',
  '嘿嘿', '哈哈', '嘻嘻', '呜呜', '哼', '那个', '就是说', '怎么说呢', '有一说一',
  '笑死', '绝了', '好耶', '属实', '麻了', '啊这', '草', '救命', '离谱', 'yyds', 'xswl', 'awsl'
]);

/** 自称词（风格画像 + 改写后校验）。 */
export const ADDRESS_SELF_WORDS = Object.freeze(['我', '咱', '本人', '人家', '在下', '老子', '老娘', '小弟', '鄙人']);

/** 称呼词（裸代词「你/我」不算——套话整句删除常含代词，不算改称呼）。 */
export const ADDRESS_OTHER_WORDS = Object.freeze([
  '您', '哥', '姐', '兄弟', '姐妹', '大佬', '老板', '老师', '同学', '宝', '宝子',
  '亲爱的', '哥们', '妹子', '师傅', '小朋友', '儿子', '爸爸', '妈妈', '老铁', '兄'
]);

/**
 * 敏感话题词表：严肃/哀悼/医疗/法律/危机。
 * 这些话题禁止「卖萌化」改写，rewriteLite 一律放行原稿。
 */
export const SENSITIVE_TOPIC_CATEGORIES = Object.freeze({
  mourning: Object.freeze([
    '去世', '逝世', '离世', '病逝', '过世', '哀悼', '悼念', '追悼', '葬礼', '遗体',
    '灵堂', '节哀', '默哀', '头七', '遗书', '追思会'
  ]),
  medical: Object.freeze([
    '病危', '病重', '住院', '手术', '急救', '抢救', '重症', 'ICU', '昏迷', '癌症',
    '肿瘤', '化疗', '放疗', '透析', '确诊', '病历', '处方', '医疗事故', '白血病',
    '瘫痪', '截肢', '抑郁症', '焦虑症', '精神科', '心理医生', '感染', '阳性'
  ]),
  legal: Object.freeze([
    '法院', '起诉', '诉讼', '律师', '立案', '判决', '判刑', '拘留', '逮捕', '仲裁',
    '赔偿', '维权', '违法', '犯罪', '刑事', '开庭', '传票', '劳动仲裁', '离婚',
    '家暴', '性侵', '猥亵', '诈骗', '派出所', '看守所', '监狱'
  ]),
  crisis: Object.freeze([
    '自杀', '自残', '轻生', '跳楼', '安乐死', '灾难', '地震', '洪水', '事故', '死亡', '车祸', '火灾', '爆炸', '中毒'
  ])
});

/** 敏感话题平铺全集。 */
export const SENSITIVE_TOPIC_WORDS = Object.freeze(Object.values(SENSITIVE_TOPIC_CATEGORIES).flat());

/** 敏感话题正则兜底（词表覆盖不到的构词，如「肺癌/肝癌/癌细胞」）。 */
export const SENSITIVE_TOPIC_RE = /癌|艾滋|白血病|抢救无效|病危通知书|安定片/;

/** 承诺句识别（改写硬约束：承诺句一字不动）。 */
export const COMMITMENT_RE = /(保证|承诺|答应|发誓|说好的|一言为定|绝不反悔|包在我身上|包你满意|还你|赔你|请客|请你吃饭|(?:明天|后天|大后天|下周|改天|回头|待会儿?|月底|下午|晚上|早上)(?:.{0,4})(?:还|给|发|转|补|请|交))/;

/** 链接识别（改写硬约束：URL 一字不动）。 */
export const URL_RE = /(https?:\/\/[^\s，。；、！？!?]+|www\.[^\s，。；、！？!?]+)/gi;
const URL_TEST_RE = /(https?:\/\/|www\.)/i;

/** emoji / QQ 表情（[doge] 形态）。 */
export const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]|\[[^\[\]\n]{1,10}\]/gu;

/** 话题关键词（风格画像的「话题偏好/禁忌」，可注入扩展）。 */
export const TOPIC_KEYWORDS = Object.freeze({
  游戏: Object.freeze(['游戏', '开黑', '排位', '上分', '王者', '原神', '吃鸡', '副本', '队友']),
  学习: Object.freeze(['作业', '考试', '复习', '上课', '论文', '图书馆', '老师', '实验']),
  美食: Object.freeze(['吃', '喝', '奶茶', '火锅', '外卖', '烧烤', '干饭', '零食']),
  工作: Object.freeze(['加班', '开会', '项目', '工资', '摸鱼', '上班', '老板', 'deadline']),
  技术: Object.freeze(['代码', 'bug', '报错', '服务器', '部署', '编程', '电脑', '手机', '网络']),
  音乐: Object.freeze(['歌', '音乐', '演唱会', '专辑', '耳机', '单曲循环']),
  影视: Object.freeze(['剧', '电影', '番', '动漫', '小说', '追剧']),
  运动: Object.freeze(['打球', '跑步', '健身', '篮球', '足球', '游泳', '爬山'])
});

/** 高置信度改写门槛（6.5：≥0.8 才轻改写/建议重试）。 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/** 改写默认预算（对应 socialV3.style.maxRetryMs 默认 2000ms）。 */
export const DEFAULT_MAX_MS = 2000;

// ──────────────────────────── 内部工具 ────────────────────────────

const r2 = (n) => Math.round(n * 100) / 100;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按次数统计子串出现（不重叠）。 */
function countOcc(hay, needle) {
  if (!needle) return 0;
  return String(hay).split(needle).length - 1;
}

/** 切句（保留分隔符）：句末标点/换行是边界，连续标点（如「！！！」）归并到同一句尾。 */
function splitSentences(text) {
  return [...String(text ?? '').matchAll(/[^。！？!?\n]*[。！？!?\n]+|[^。！？!?\n]+$/g)].map((m) => m[0]);
}

/** 切短句（保留分隔符）：逗号/顿号/分号是边界。 */
function splitClauses(text) {
  return [...String(text ?? '').matchAll(/[^，、；,;]*[，、；,;]+|[^，、；,;]+$/g)].map((m) => m[0]);
}

/** 去掉空白与标点符号后的内容长度（emoji 也算符号被去掉）。 */
function contentLength(s) {
  return String(s).replace(/[\s\p{P}\p{S}]/gu, '').length;
}

function truncate(s, n = 24) {
  const raw = String(s ?? '');
  return raw.length > n ? `${raw.slice(0, n)}…` : raw;
}

/** 词表合并：默认表 + 调用方追加（options.wordLists.{banned,weak,fillers,sensitive}）。 */
function resolveWordLists(options = {}) {
  const extra = options.wordLists || {};
  return {
    banned: [...BANNED_PHRASES, ...(extra.banned || [])],
    weak: [...WEAK_CONNECTIVES, ...(extra.weak || [])],
    fillers: [...FILLER_WORDS, ...(extra.fillers || [])],
    sensitive: [...SENSITIVE_TOPIC_WORDS, ...(extra.sensitive || [])]
  };
}

// ──────────────────────────── 敏感话题 ────────────────────────────

/**
 * 敏感话题识别（严肃/哀悼/医疗/法律/危机）：词表 + 正则。
 * true 时 rewriteLite 一律不改写（6.5：严肃话题不走「卖萌化」改写）。
 */
export function isSensitiveTopic(text, options = {}) {
  const src = String(text ?? '');
  if (!src) return false;
  const lists = resolveWordLists(options);
  if (SENSITIVE_TOPIC_RE.test(src)) return true;
  return lists.sensitive.some((w) => w && src.includes(w));
}

// ──────────────────────────── 检测器 ────────────────────────────

/** 禁词/客服腔/八股：强词单发即中，弱连接词累计 ≥2 才成 flag。 */
function detectBannedPhrases(src, lists) {
  const strong = lists.banned.filter((p) => src.includes(p));
  const weakHits = lists.weak.filter((p) => src.includes(p));
  if (strong.length === 0 && weakHits.length < 2) return null;
  let confidence = 0;
  if (strong.length >= 1) confidence = strong.length === 1 ? 0.85 : strong.length === 2 ? 0.92 : 0.97;
  if (weakHits.length >= 2) confidence = Math.max(confidence, weakHits.length >= 3 ? 0.75 : 0.65);
  return {
    id: 'banned-phrase',
    confidence: r2(confidence),
    evidence: {
      excerpt: truncate(strong[0] || weakHits[0]),
      strong: strong.slice(0, 5),
      weak: weakHits.slice(0, 5),
      count: strong.length + weakHits.length
    }
  };
}

/** 总分总/八股结构：成组连接词正则 + 分点编号。 */
function detectEssayStructure(src) {
  for (const p of ESSAY_PATTERNS) {
    const m = p.re.exec(src);
    if (m) {
      return {
        id: 'essay-structure',
        confidence: p.confidence,
        evidence: { pattern: p.id, excerpt: truncate(m[0]) }
      };
    }
  }
  return null;
}

/**
 * 三连排比：连续 ≥3 个短句/短分句（2~14 字、长度差 ≤3），
 * 且首字相同或尾字相同才算「结构相似」（纯长度相近不报，避免口语误伤）。
 */
function findParallelRun(units) {
  for (let i = 0; i + 2 < units.length; i += 1) {
    const run = [units[i], units[i + 1], units[i + 2]];
    const lens = run.map((u) => u.len);
    if (run.some((u) => u.len < 2 || u.len > 14)) continue;
    if (Math.max(...lens) - Math.min(...lens) > 3) continue;
    const sharedHead = run.every((u) => u.head === run[0].head);
    const sharedTail = run.every((u) => u.tail === run[0].tail);
    if (!sharedHead && !sharedTail) continue;
    return { run, shared: sharedHead ? 'head' : 'tail' };
  }
  return null;
}

function detectTripleParallel(src) {
  const toUnits = (parts) => parts
    .map((s) => s.replace(/^[，、；,;：:\s]+|[。！？!?…，、；,;：:\s]+$/g, ''))
    .filter((s) => s.length > 0)
    .map((s) => ({ text: s, len: contentLength(s), head: s[0], tail: s[s.length - 1] }));
  for (const sentence of splitSentences(src)) {
    const hit = findParallelRun(toUnits(splitClauses(sentence))) || findParallelRun(toUnits(splitSentences(sentence)));
    if (hit) {
      return {
        id: 'triple-parallel',
        confidence: 0.8,
        evidence: {
          shared: hit.shared,
          clauses: hit.run.map((u) => truncate(u.text, 14)),
          excerpt: truncate(hit.run.map((u) => u.text).join('｜'))
        }
      };
    }
  }
  return null;
}

/** 句长方差过低（太整齐）：≥4 句、平均句长 ≥3、变异系数 <0.12。 */
function detectLowLengthVariance(src) {
  const lens = splitSentences(src).map(contentLength).filter((n) => n > 0);
  if (lens.length < 4) return null;
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean < 3) return null;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv >= 0.12) return null;
  return {
    id: 'low-length-variance',
    confidence: cv < 0.05 ? 0.75 : 0.7,
    evidence: { count: lens.length, mean: r2(mean), variance: r2(variance), cv: r2(cv) }
  };
}

/** 感叹号/问号/省略号密度异常。 */
function detectPunctDensity(src) {
  const sentences = Math.max(1, splitSentences(src).length);
  const exclaim = (src.match(/[！!]/g) || []).length;
  const question = (src.match(/[？?]/g) || []).length;
  const ellipsis = (src.match(/…{2,}|。{3,}|\.{3,}/g) || []).length;
  let confidence = 0;
  const parts = [];
  if ((exclaim >= 4 && exclaim / sentences >= 0.5) || /！{4,}|!{4,}/.test(src)) {
    confidence = exclaim >= 6 ? 0.85 : 0.75;
    parts.push(`感叹号 ${exclaim}`);
  }
  if (question >= 3 && question / sentences >= 0.75) {
    confidence = Math.max(confidence, 0.7);
    parts.push(`问号 ${question}`);
  }
  if (ellipsis >= 3) {
    confidence = Math.max(confidence, 0.7);
    parts.push(`省略号 ${ellipsis}`);
  }
  if (confidence === 0) return null;
  if (parts.length >= 2) confidence = Math.min(0.95, confidence + 0.05);
  return {
    id: 'punct-density',
    confidence: r2(confidence),
    evidence: { exclaim, question, ellipsis, sentences, detail: parts.join('、') }
  };
}

/** 全篇 emoji/表情堆叠。 */
function detectEmojiPileup(src) {
  const matches = [...String(src).matchAll(EMOJI_RE)];
  const count = matches.length;
  if (count === 0) return null;
  const chars = Math.max(1, String(src).replace(/\s/g, '').length);
  const rate = count / chars;
  // 连续堆叠：相邻表情之间只剩空白/标点
  let run = 1;
  let maxRun = 1;
  for (let i = 1; i < matches.length; i += 1) {
    const gap = src.slice(matches[i - 1].index + matches[i - 1][0].length, matches[i].index);
    run = /^[\s\p{P}\p{S}]*$/u.test(gap) ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  let confidence = 0;
  if (maxRun >= 4) confidence = 0.8;
  if (count >= 6 && rate >= 0.15) confidence = Math.max(confidence, 0.8);
  else if (count >= 3 && rate >= 0.3) confidence = Math.max(confidence, 0.7);
  if (confidence === 0) return null;
  return {
    id: 'emoji-pileup',
    confidence: r2(confidence),
    evidence: { count, rate: r2(rate), maxRun, excerpt: truncate(matches.slice(0, 4).map((m) => m[0]).join('')) }
  };
}

/** 过长的解释性段落：单句 ≥120 字报警，≥180 字高置信。 */
function detectLongExplanation(src) {
  let maxLen = 0;
  let worst = '';
  for (const s of splitSentences(src)) {
    const len = s.replace(/\s/g, '').length;
    if (len > maxLen) {
      maxLen = len;
      worst = s;
    }
  }
  if (maxLen < 120) return null;
  return {
    id: 'long-explanation',
    confidence: maxLen >= 180 ? 0.85 : 0.75,
    evidence: { maxLen, excerpt: truncate(worst) }
  };
}

/**
 * 风格自检（本地规则，不调模型）。
 * 返回 { flags: [{ id, confidence, evidence }], score }：
 *   · flags 按置信度降序；低于 options.minFlagConfidence（默认 0.5）的弱信号不进 flags；
 *   · score ∈ [0,1]：最高置信度 + 每多一个命中 +0.05，封顶 1。
 */
export function detectStyle(text, options = {}) {
  const src = String(text ?? '');
  const lists = resolveWordLists(options);
  const minConf = Number.isFinite(Number(options.minFlagConfidence)) ? Number(options.minFlagConfidence) : 0.5;
  const all = [
    detectBannedPhrases(src, lists),
    detectEssayStructure(src),
    detectTripleParallel(src),
    detectLowLengthVariance(src),
    detectPunctDensity(src),
    detectEmojiPileup(src),
    detectLongExplanation(src)
  ].filter(Boolean);
  const flags = all
    .filter((f) => f.confidence >= minConf)
    .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1));
  const score = flags.length === 0
    ? 0
    : Math.min(1, r2(flags[0].confidence + 0.05 * (flags.length - 1)));
  return { flags, score };
}

// ──────────────────────────── 风格画像 ────────────────────────────

/**
 * 正向风格签名（6.5）：句长分布、标点习惯、语气词/口头禅率、表情包使用率、
 * 称呼/自称、话题偏好/禁忌。供后续与角色卡基线对比。
 * samples：字符串数组（历史发言样本）；options.tabooWords 可注入角色卡禁忌词。
 */
export function buildProfile(samples, options = {}) {
  const arr = (Array.isArray(samples) ? samples : [samples])
    .map((s) => String(s ?? ''))
    .filter((s) => s.length > 0);
  const allText = arr.join('\n');
  const totalChars = Math.max(1, allText.replace(/\s/g, '').length);

  // 句长分布
  const lens = arr.flatMap(splitSentences).map(contentLength).filter((n) => n > 0);
  const count = lens.length;
  const mean = count ? lens.reduce((a, b) => a + b, 0) / count : 0;
  const variance = count ? lens.reduce((a, b) => a + (b - mean) ** 2, 0) / count : 0;
  const shortRatio = count ? lens.filter((n) => n <= 8).length / count : 0;

  // 标点习惯（每百字密度）
  const per100 = (n) => r2((n / totalChars) * 100);
  const punctuation = {
    period: per100((allText.match(/[。．]/g) || []).length),
    exclaim: per100((allText.match(/[！!]/g) || []).length),
    ellipsis: per100((allText.match(/…{2,}|。{3,}|\.{3,}/g) || []).length),
    question: per100((allText.match(/[？?]/g) || []).length)
  };

  // 语气词/口头禅率（每百字命中次数 + Top）
  const fillerCounts = new Map();
  let fillerHits = 0;
  for (const w of resolveWordLists(options).fillers) {
    const n = countOcc(allText, w);
    if (n > 0) {
      fillerCounts.set(w, n);
      fillerHits += n;
    }
  }
  const topOf = (map, n) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([word, hits]) => ({ word, count: hits }));
  const fillers = { rate: per100(fillerHits), top: topOf(fillerCounts, 5) };

  // 表情包使用率
  const emojiCount = [...allText.matchAll(EMOJI_RE)].length;
  const emoji = { count: emojiCount, rate: r2(emojiCount / totalChars) };

  // 称呼/自称
  const tally = (words) => {
    const m = new Map();
    for (const w of words) {
      const n = countOcc(allText, w);
      if (n > 0) m.set(w, n);
    }
    return topOf(m, 5);
  };
  const address = {
    self: tally(ADDRESS_SELF_WORDS),
    other: tally(ADDRESS_OTHER_WORDS)
  };

  // 话题偏好/禁忌 + 敏感样本占比
  const topicMap = new Map();
  for (const [topic, words] of Object.entries(options.topicKeywords || TOPIC_KEYWORDS)) {
    const n = words.reduce((a, w) => a + countOcc(allText, w), 0);
    if (n > 0) topicMap.set(topic, n);
  }
  const tabooWords = Array.isArray(options.tabooWords) ? options.tabooWords : [];
  const tabooMap = new Map();
  for (const w of tabooWords) {
    const n = countOcc(allText, w);
    if (n > 0) tabooMap.set(w, n);
  }
  const topics = {
    preferred: topOf(topicMap, 3),
    taboo: topOf(tabooMap, 5)
  };

  return {
    sampleCount: arr.length,
    totalChars,
    sentenceLength: {
      count,
      mean: r2(mean),
      variance: r2(variance),
      shortRatio: r2(shortRatio),
      max: count ? Math.max(...lens) : 0
    },
    punctuation,
    fillers,
    emoji,
    address,
    topics,
    sensitiveRate: r2(arr.filter((s) => isSensitiveTopic(s, options)).length / Math.max(1, arr.length))
  };
}

// ──────────────────────────── 轻改写 ────────────────────────────

/** 句子是否「硬保护」：含数字/链接/承诺句 → 一字不动（6.5 硬约束 3）。 */
function isProtectedSentence(s) {
  return /\d/.test(s) || URL_TEST_RE.test(s) || COMMITMENT_RE.test(s);
}

/** 整句是否只剩套话/语气词（可整句删除）。 */
function isAllCliche(core, words) {
  let rest = core;
  for (const w of words) rest = rest.split(w).join('');
  return rest.length <= 1;
}

/** 删套话连接词 / 整句套话（只删词，不动事实）。 */
function dropCliche(text, deletable, fillers) {
  let removed = 0;
  const out = [];
  for (const s of splitSentences(text)) {
    if (isProtectedSentence(s)) {
      out.push(s);
      continue;
    }
    const core = s.replace(/[\s。！？!?…，、；,;：:]/g, '');
    if (core && isAllCliche(core, [...deletable, ...fillers])) {
      removed += 1;
      continue;
    }
    let t = s;
    for (const p of deletable) {
      if (t.includes(p)) {
        removed += countOcc(t, p);
        t = t.split(p).join('');
      }
    }
    // 清理删除后的残余标点（不碰行内其它内容）
    t = t
      .replace(/^[，、；,;：:]+/, '')
      .replace(/([，、；,;])[，、；,;]+/g, '$1')
      .replace(/[，、；,;]+(?=[。！？!?…])/g, '');
    out.push(t);
  }
  return { text: out.join(''), removed };
}

/** 削感叹号：连排折叠 + 超额时把尾部句子的「！」降级为「。」（不碰保护句）。 */
function trimExclaim(text) {
  const before = (text.match(/[！!]/g) || []).length;
  const collapsed = [];
  for (const s of splitSentences(text)) {
    collapsed.push(isProtectedSentence(s) ? s : s.replace(/！{2,}/g, '！').replace(/!{2,}/g, '!'));
  }
  let out = collapsed.join('');
  let sentences = splitSentences(out).filter((s) => !isProtectedSentence(s));
  const cap = Math.max(1, Math.floor(sentences.length / 2));
  let exclaims = (out.match(/[！!]/g) || []).length;
  // 从最后一句往前降级，直到回到上限
  for (let i = sentences.length - 1; i >= 0 && exclaims > cap; i -= 1) {
    const s = sentences[i];
    if (/[！!]$/.test(s.trimEnd()) && !isProtectedSentence(s)) {
      const replaced = s.trimEnd().replace(/[！!]$/, (m) => (m === '！' ? '。' : '.'));
      out = out.replace(s, replaced);
      exclaims -= 1;
    }
  }
  const after = (out.match(/[！!]/g) || []).length;
  return { text: out, removed: before - after };
}

/** 拆长句：只在短句边界后换行（内容不变，纯空白级改动）。 */
function splitLong(text, maxChars) {
  let breaks = 0;
  const out = [];
  for (const s of splitSentences(text)) {
    if (isProtectedSentence(s) || s.replace(/\s/g, '').length <= maxChars) {
      out.push(s);
      continue;
    }
    const clauses = splitClauses(s);
    let cur = '';
    for (const c of clauses) {
      if (cur && cur.length + c.length > maxChars) {
        out.push(cur);
        cur = c;
        breaks += 1;
      } else {
        cur += c;
      }
    }
    if (cur) out.push(cur);
  }
  return { text: out.join(''), breaks };
}

/** 改写后硬约束校验：数字/链接/承诺句/称呼必须原样保留，任何一条不满足就整体回退。 */
function verifyInvariants(src, out) {
  const issues = [];
  for (const n of src.match(/\d+/g) || []) {
    if (countOcc(out, n) < countOcc(src, n)) issues.push(`数字丢失:${n}`);
  }
  for (const u of src.match(URL_RE) || []) {
    if (!out.includes(u)) issues.push(`链接丢失:${truncate(u, 20)}`);
  }
  for (const s of splitSentences(src)) {
    if (COMMITMENT_RE.test(s) && !out.includes(s)) issues.push('承诺句被改写');
  }
  for (const w of ADDRESS_OTHER_WORDS) {
    if (countOcc(out, w) !== countOcc(src, w)) issues.push(`称呼变化:${w}`);
  }
  return issues;
}

/**
 * 本地规则轻改写（不调模型、纯函数、可注入时钟）。
 * options：
 *   confidenceThreshold（默认 0.8）：低于它的 flag 只记录不改写；
 *   maxMs / now：超时预算，超预算放弃改写发原稿；
 *   alreadyRetried：本轮已重试过 → 不再改写/不再建议重试（6.5：只重试一次）；
 *   wordLists / maxSentenceChars / parallelLineChars：词表与拆句参数。
 * 返回 { text, changed, applied, skipped, suggestRetry }。
 */
export function rewriteLite(text, flags, options = {}) {
  const src = String(text ?? '');
  const result = { text: src, changed: false, applied: [], skipped: [], suggestRetry: false };
  const threshold = Number.isFinite(Number(options.confidenceThreshold))
    ? Number(options.confidenceThreshold)
    : DEFAULT_CONFIDENCE_THRESHOLD;
  const maxMs = Number.isFinite(Number(options.maxMs)) ? Number(options.maxMs) : DEFAULT_MAX_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // 硬约束 4：敏感话题不走「卖萌化」改写
  if (isSensitiveTopic(src, options)) {
    result.skipped.push('sensitive-topic');
    return result;
  }
  const list = Array.isArray(flags) ? flags : [];
  const high = list.filter((f) => Number(f && f.confidence) >= threshold);
  // 硬约束 2：低置信度 → 放行并记录
  if (high.length === 0) {
    result.skipped.push('low-confidence');
    return result;
  }
  // 6.5：只重试一次，已重试过就发原稿
  if (options.alreadyRetried) {
    result.skipped.push('already-retried');
    return result;
  }
  // 硬约束 5：超时预算语义（纯函数不做异步，只按注入时钟判预算）
  const started = now();
  const deadline = started + maxMs;
  if (!(deadline > started)) {
    result.skipped.push('budget-exhausted');
    return result;
  }

  result.suggestRetry = true;
  const ids = new Set(high.map((f) => f.id));
  const lists = resolveWordLists(options);
  const plan = [];
  if (ids.has('banned-phrase') || ids.has('essay-structure')) plan.push('drop-cliche');
  if (ids.has('punct-density')) plan.push('trim-exclaim');
  if (ids.has('long-explanation') || ids.has('triple-parallel')) plan.push('split-long');
  if (plan.length === 0) {
    result.skipped.push('no-safe-transform');
    return result;
  }

  const deletable = [...lists.banned];
  if (ids.has('essay-structure')) {
    // 八股结构确认后才删连接词：带逗号的整段先删，裸虚词其次，口语常用词（最后/因此…）不动实义
    deletable.push(...lists.weak.map((w) => `${w}，`), ...lists.weak.map((w) => `${w}、`), ...BARE_DELETABLE_CONNECTIVES);
  }
  const maxChars = Math.min(
    ids.has('triple-parallel') ? (Number(options.parallelLineChars) || 12) : Infinity,
    Number(options.maxSentenceChars) || 48
  );

  let out = src;
  for (const step of plan) {
    // 预算耗尽 → 放弃改写发原稿（6.5：超过时限直接发原稿）
    if (now() > deadline) {
      return { text: src, changed: false, applied: [], skipped: ['budget-exhausted'], suggestRetry: false };
    }
    if (step === 'drop-cliche') {
      const r = dropCliche(out, deletable, lists.fillers);
      if (r.removed > 0) {
        out = r.text;
        result.applied.push({ id: 'drop-cliche', detail: `删除 ${r.removed} 处套话` });
      }
    } else if (step === 'trim-exclaim') {
      const r = trimExclaim(out);
      if (r.removed > 0) {
        out = r.text;
        result.applied.push({ id: 'trim-exclaim', detail: `削减 ${r.removed} 个感叹号` });
      }
    } else if (step === 'split-long') {
      const r = splitLong(out, maxChars);
      if (r.breaks > 0) {
        out = r.text;
        result.applied.push({ id: 'split-long', detail: `拆分 ${r.breaks} 处长句` });
      }
    }
  }

  // 硬约束 3 兜底：数字/链接/承诺句/称呼被碰到 → 整体回退
  const issues = verifyInvariants(src, out);
  if (issues.length > 0) {
    return { text: src, changed: false, applied: [], skipped: ['verify-failed'], suggestRetry: true };
  }

  result.text = out;
  result.changed = out !== src;
  return result;
}
