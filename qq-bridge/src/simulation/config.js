// 三代仿真配置单一源（GEN3 P0.2）：socialV3.* 的所有参数**只在这里定义一次**。
//
// 消费关系（docs/design/GEN3_SIMULATION_PLAN.md 0.2 / 8.2）：
//   · scripts/gen-simulation-config.mjs 从本文件生成：
//       config.example.json 的 socialV3 段、控制台字段、MCP 描述、preset 提示（改一处→重新生成）
//   · scripts/test-simulation-config.mjs 钉住「schema ↔ 生成物 ↔ 默认值」三方一致
//   · 后续任务（0.7 控制台面板、1.x MCP 工具/preset）直接读生成物或本模块，不再手写参数副本
//
// 语义来源：GEN3 计划 8.1 配置命名空间 + 6.2/6.3/6.4 各模块约束（首泡 0 延迟、
// 沉默只告警不强制、memory namespace 隔离等）。新增参数必须带 zhLabel + hint，
// 否则契约测试会拒绝——没有说明的参数别人没法调。

/**
 * 参数描述表（数组保序 = 生成物里的字段顺序）。
 * type: boolean | number | int | string | enum | string[]
 * min/max/step 仅数字；enumValues 仅 enum；unit 仅展示。
 */
export const SOCIAL_V3_SCHEMA = Object.freeze([
  // ── 基础 ──
  { path: 'enabled', type: 'boolean', default: false, group: '基础', label: '启用三代仿真', hint: '用途：三代仿真的总开关；关掉就完全回到二代，三代参数仍然保留。调法：想试三代时打开，出问题先关这里。例：关掉后 bot 立刻恢复原来的二代行为，不用逐项改参数。' },
  { path: 'mode', type: 'enum', enumValues: ['shadow', 'canary', 'on'], default: 'shadow', group: '基础', label: '灰度模式', hint: '用途：决定三代在哪些会话真正生效。调法：shadow 只记录、不改行为；canary/on 只对名单里的会话生效；名单为空时两者都不生效。例：先选 shadow 观察；想在一个群试用就选 canary 并填入群号。' },
  { path: 'shadowReadOnly', type: 'boolean', default: true, group: '基础', label: '记忆只读锁', hint: '用途：记忆模块的只读锁，防止试运行阶段往长期记忆里写东西。调法：勾选时记忆不写、不注入、不跑凌晨整理；节奏/风格/注意力不受影响。例：只想先看聊天风格变化就保持勾选；准备测试长期记忆再取消。' },
  { path: 'canaryGroups', type: 'string[]', default: [], group: '基础', label: 'canary 群名单', hint: '用途：三代生效的会话白名单，和 QQ 白名单不是一回事。调法：群写 group:<群号>，私聊写 private:<QQ号>，多个用逗号隔开；留空则没有会话走三代。例：只在一个群试用就填 group:<群号>。' },
  { path: 'modules.rhythm', type: 'boolean', default: false, group: '基础', label: '模块开关：节奏', hint: '用途：让多条消息之间按打字速度拉开间隔，不瞬间刷屏。调法：打开后在下面「节奏」组调速度；只在 canary/on 且名单命中的会话生效。例：bot 回三句话时，会隔一两秒发一条。' },
  { path: 'modules.style', type: 'boolean', default: false, group: '基础', label: '模块开关：风格', hint: '用途：发送前检查客服腔/AI 味，必要时自动轻改一次。调法：打开后在「风格」组调改写时限；敏感话题会自动放行。例：把「总的来说，首先其次最后」改得更像随口说的话。' },
  { path: 'modules.memory', type: 'boolean', default: false, group: '基础', label: '模块开关：记忆', hint: '用途：把有价值的话题和群友印象沉淀成长期记忆，下次聊天能接上。调法：还要关掉「记忆只读锁」才会真正写入；条数/字数在「记忆」组调。例：昨天聊过的「周末搬家」，今天还能自然提起。' },
  { path: 'modules.persona', type: 'boolean', default: false, group: '基础', label: '模块开关：人设', hint: '用途：定期重新强调人设，防止聊久了性格跑偏。调法：间隔和红线在「人设」组调；只在 canary/on 名单内生效。例：每 10 轮补一次「说话特征/红线/称呼」，平时只带基础身份。' },
  { path: 'modules.attention', type: 'boolean', default: false, group: '基础', label: '模块开关：注意力', hint: '用途：决定这条消息要不要接、是不是在叫 bot。调法：阈值和权重在「注意力」组调；私聊/@/提问不受阈值限制。例：群里没人叫 bot 的闲聊可以不回；有人 @ 它时一定回。' },
  { path: 'modules.affect', type: 'boolean', default: false, group: '基础', label: '模块开关：情感', hint: '用途：给回复加一点点情绪惯性，让语气有起伏。调法：影响强度在「情感」组调，默认很轻；只改语气和节奏。例：听到好消息时回复稍积极，几小时后自然恢复。' },
  { path: 'modules.proactive', type: 'boolean', default: false, group: '基础', label: '模块开关：主动性', hint: '用途：群里冷场时偶尔主动开口，但不刷存在感。调法：预算/作息/冷却在「主动性」组调；深夜默认不主动。例：下午群里安静时可能起个话题，凌晨 2 点不会打扰。' },
  { path: 'modules.sticker', type: 'boolean', default: false, group: '基础', label: '模块开关：表情', hint: '用途：按语境挑表情，没有合适的就不发。调法：候选数和最低分在「表情」组调；同一张有复用冷却。例：对方说「笑死我了」时挑一张笑的表情；都不合适就不发。' },
  { path: 'modules.surface', type: 'boolean', default: false, group: '基础', label: '模块开关：表现面', hint: '用途：统一治理联网搜索/QQ空间/日记三个表现面的上下文、预算与观测。调法：总开关，还要在「表现面」组打开对应面的开关才生效。例：关掉后三个插件完全按二代原样运行。' },

  // ── 注意力（6.2）──
  { path: 'attention.speakThreshold', type: 'number', min: 0, max: 1, step: 0.05, default: 0.55, group: '注意力', label: '发言阈值', hint: '用途：群聊里没人叫 bot 时，匹配分达到多少才主动开口。调法：调低更容易接话，调高更安静；私聊/@/提问不受它影响。例：0.55 时普通闲聊往往不接；调到 0.4 会明显更活跃。' },
  { path: 'attention.silentThreshold', type: 'number', min: 0, max: 1, step: 0.05, default: 0.25, group: '注意力', label: '沉默阈值', hint: '用途：匹配分低于多少就保持沉默。调法：不能高于「发言阈值」；两者之间会再观察一下。例：0.25 时，完全不相关的群聊会被判沉默。' },
  { path: 'attention.maxSilentTurnsBeforeReevaluate', type: 'int', min: 0, max: 50, default: 5, group: '注意力', label: '连续沉默提醒', hint: '用途：连续沉默多少轮后提醒你「它是不是太安静了」。调法：只提醒/重新评估，不会强制它说话；设 0 关闭提醒。例：连续 5 轮没接话，控制台会提示，但不会硬插一句。' },
  { path: 'attention.pokeCooldownMs', type: 'int', min: 0, max: 3600000, step: 1000, default: 60000, unit: 'ms', group: '注意力', label: '拍一拍冷却', hint: '用途：防止有人连续拍一拍把 bot 反复叫醒。调法：冷却期内重复拍会被忽略；单位毫秒。例：60000 表示一分钟内只响应第一次拍一拍。' },
  { path: 'attention.weights.addressee', type: 'number', min: 0, max: 1, step: 0.05, default: 0.4, group: '注意力', label: '权重：受话人', hint: '用途：有人 @/叫名字/引用 bot 时，这条消息的重要性权重。调法：一般不用改；调高会让「被点名」更容易触发回复。例：@bot 本来就必回，这个权重主要影响叫了名字但没 @ 的情况。' },
  { path: 'attention.weights.topic', type: 'number', min: 0, max: 1, step: 0.05, default: 0.2, group: '注意力', label: '权重：话题', hint: '用途：这条消息和当前话题越相关，分数越高。调法：调高会让 bot 更愿意接正在聊的话题。例：群里正在聊昨晚的球赛，有人接着说比分，就更容易被接。' },
  { path: 'attention.weights.relationship', type: 'number', min: 0, max: 1, step: 0.05, default: 0.15, group: '注意力', label: '权重：关系', hint: '用途：和发送者越熟，越愿意接话。调法：调高会让熟人优先。例：经常互动的小明说话，比陌生人更容易被回。' },
  { path: 'attention.weights.urgency', type: 'number', min: 0, max: 1, step: 0.05, default: 0.15, group: '注意力', label: '权重：紧急度', hint: '用途：出现「急/救命/在吗」等信号时加分。调法：调高会更快响应求助。例：「有人会修电脑吗，急」会比普通闲聊更容易被接。' },
  { path: 'attention.weights.floorPenalty', type: 'number', min: 0, max: 1, step: 0.05, default: 0.2, group: '注意力', label: '权重：抢话惩罚', hint: '用途：多人正聊得热闹时，降低 bot 插话的分数。调法：调高更少抢话。例：群里三个人连续刷屏时，bot 更倾向等一等。' },
  { path: 'attention.weights.recentBotPenalty', type: 'number', min: 0, max: 1, step: 0.05, default: 0.2, group: '注意力', label: '权重：刚发言惩罚', hint: '用途：bot 刚说过话时，降低马上再说的分数。调法：调高会减少连环发言。例：bot 30 秒前刚回过，别人又发一句，它会更容易保持安静。' },

  // ── 记忆（6.3）──
  { path: 'memory.maxInject', type: 'int', min: 0, max: 50, default: 12, group: '记忆', label: '注入条数上限', hint: '用途：每次唤醒最多带几条长期记忆进提示词。调法：调大记性更好但更费 token；调小更省。例：12 条大概能覆盖最近几个话题和几个熟人印象。' },
  { path: 'memory.maxInjectChars', type: 'int', min: 100, max: 1000000, step: 1, default: 1800, unit: '字符', group: '记忆', label: '注入字符上限', hint: '用途：长期记忆的总字数上限，防止提示词过长。调法：手动输入数值，最大 100 万字符，按需要调大/调小；超出会优先丢不重要的。例：1800 字大约是一屏聊天记录的长度。' },
  { path: 'memory.consolidateAt', type: 'string', default: '04:30', group: '记忆', label: '巩固任务时间', hint: '用途：每天整理长期记忆的时间：合并重复、处理矛盾、归档过期。调法：填 HH:MM，建议放在凌晨没人聊天时。例：04:30 表示每天凌晨四点半整理一次。' },
  { path: 'memory.namespace', type: 'string', default: 'v3', group: '记忆', label: '记忆命名空间', hint: '用途：三代记忆的独立分区名，避免和二代记忆混在一起。调法：一般保持 v3 不动；改名会让旧记忆看起来「消失」。例：保持 v3，回退二代时旧记忆会被隐藏而不是删掉。' },

  // ── 节奏（6.4）──
  { path: 'rhythm.cpmMin', type: 'int', min: 1, max: 300, default: 40, unit: '字/分', group: '节奏', label: '打字速度下限', hint: '用途：估算打字速度的下限（每分钟多少字），决定气泡间隔。调法：调低会让回复更慢、更像在思考。例：40 表示慢速打字，较长的句子会等更久。' },
  { path: 'rhythm.cpmMax', type: 'int', min: 1, max: 300, default: 100, unit: '字/分', group: '节奏', label: '打字速度上限', hint: '用途：打字速度的上限；关系熟/反应快时用这个速度。调法：必须不低于下限；调高会让多条消息发得更快。例：100 表示比较快地连发。' },
  { path: 'rhythm.maxBubbles', type: 'int', min: 1, max: 10, default: 5, group: '节奏', label: '单轮最大气泡数', hint: '用途：一轮最多发几条气泡。调法：超过会把剩余内容合并到最后一条，不会丢字。例：设 5 时，模型给 8 条会合并成 5 条发出去。' },
  { path: 'rhythm.maxTotalDelayMs', type: 'int', min: 0, max: 30000, step: 500, default: 5000, unit: 'ms', group: '节奏', label: '单轮总延迟上限', hint: '用途：一轮所有气泡间隔加起来最多等多久。调法：调大更自然但更慢；只影响第 2 条以后，首条永远立即发。例：5000 表示一轮最多拖 5 秒。' },

  // ── 风格（6.5）──
  { path: 'style.retryOnHighConfidence', type: 'boolean', default: true, group: '风格', label: '自动轻改 AI 味', hint: '用途：命中明显的 AI 味时，是否自动轻改一次。调法：关闭就只检测不改；敏感话题始终不改。例：出现「首先其次最后」时，自动改成更口语的说法。' },
  { path: 'style.maxRetryMs', type: 'int', min: 0, max: 10000, step: 500, default: 2000, unit: 'ms', group: '风格', label: '轻改最长时间', hint: '用途：轻改最多等多久，超时就发原稿。调法：调大给改写更多时间，但可能拖慢回复。例：2000 表示两秒内改不好就直接发原文。' },
  { path: 'style.maxFalsePositiveRate', type: 'number', min: 0, max: 1, step: 0.05, default: 0.1, group: '风格', label: '误报率参考值', hint: '用途：允许的误报率，也就是把正常话判成 AI 味的比例。调法：这是验收参考值，一般不用改。例：0.1 表示每 100 条最多误判 10 条。' },

  // ── 人设/身份锚点（6.1）──
  { path: 'persona.reanchorEveryTurns', type: 'int', min: 1, max: 100, default: 10, group: '人设', label: '重锚周期', hint: '用途：每隔多少轮重新强调一次完整人设。调法：调小人设更稳但提示词更长；调大更省。例：10 表示每 10 轮补一次「说话特征/红线/称呼」。' },
  { path: 'persona.maxAnchorChars', type: 'int', min: 100, max: 1000000, step: 1, default: 500, unit: '字符', group: '人设', label: '锚点字符上限', hint: '用途：人设补充文字的字数上限。调法：手动输入数值，最大 100 万字符；超了会先丢关系、再丢红线、再丢特征；基础身份不计入。例：500 字大约能放 5 条特征 + 3 条红线 + 2 个称呼。' },
  { path: 'persona.speechFeatures', type: 'string[]', default: [], group: '人设', label: '说话特征', hint: '用途：用几个短语描述它说话的特点。调法：填 3~5 条，逗号分隔；留空则人设补充里没有这一项。例：元气开朗, 不说教, 爱用短句。' },
  { path: 'persona.redLines', type: 'string[]', default: [], group: '人设', label: '红线/禁忌', hint: '用途：绝对不能碰的红线，同时用来检测它有没有性格跑偏。调法：填 3 条左右，逗号分隔。例：不冒充真人, 不泄露隐私, 不主动要钱。' },
  { path: 'persona.driftAlertThreshold', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5, group: '人设', label: '跑偏告警阈值', hint: '用途：说话风格偏离多少算一次「跑偏」。调法：调低更敏感（告警多），调高更宽松。例：0.5 表示偏离一半以上才记一次。' },
  { path: 'persona.driftStreak', type: 'int', min: 1, max: 10, default: 2, group: '人设', label: '连续跑偏轮数', hint: '用途：连续几轮跑偏才触发重新强调人设。调法：调低更快拉回，调高更容忍偶发波动。例：2 表示连续两轮不对劲才动手。' },

  // ── 情感（6.6）──
  { path: 'affect.decayHours', type: 'number', min: 0, max: 168, step: 0.5, default: 6, unit: '小时', group: '情感', label: '情绪恢复时间', hint: '用途：情绪多久回到平时的基线。调法：调大情绪持续更久；调小恢复更快。例：6 表示大约六小时后从「很开心」回到平常。' },
  { path: 'affect.modulationScale', type: 'number', min: 0, max: 3, step: 0.1, default: 0.3, group: '情感', label: '情绪影响强度', hint: '用途：情绪对回复的影响有多大。调法：0 完全不影响；默认 0.3 很轻；调大也不会超过 0.8~1.2 倍。例：0.3 时，开心只会让回复稍长、稍快，不会夸张。' },

  // ── 主动性（6.7）──
  { path: 'proactive.perGroupDaily', type: 'int', min: 0, max: 50, default: 3, group: '主动性', label: '每群每日主动上限', hint: '用途：每个群每天最多主动开口几次。调法：调大更容易主动，调小更安静。例：3 表示一个群一天最多主动找话题 3 次。' },
  { path: 'proactive.perUserDaily', type: 'int', min: 0, max: 20, default: 1, group: '主动性', label: '每人每日主动上限', hint: '用途：对同一个人每天最多主动几次。调法：调小避免总找同一个人。例：1 表示同一个人一天最多被主动搭话 1 次。' },
  { path: 'proactive.followUpMax', type: 'int', min: 0, max: 5, default: 2, group: '主动性', label: '未尽话题跟进上限', hint: '用途：答应过/考试/生病/出行这类事最多追问几次。调法：调大更执着，调小更快放下。例：2 表示问两次没人接就不再提。' },
  { path: 'proactive.quietFrom', type: 'int', min: 0, max: 23, default: 23, group: '主动性', label: '深夜起点', hint: '用途：深夜不主动的起始小时（24 小时制）。调法：和「深夜终点」一起组成时间段，支持跨午夜。例：23 表示 23:00 开始进入安静时段。' },
  { path: 'proactive.quietTo', type: 'int', min: 0, max: 23, default: 8, group: '主动性', label: '深夜终点', hint: '用途：深夜时段的结束小时。调法：与起点相同表示没有深夜限制；@/私聊/主人/提问不受限制。例：8 表示早上 8 点后恢复正常主动。' },
  { path: 'proactive.interruptThreshold', type: 'number', min: 0, max: 1, step: 0.05, default: 0.3, group: '主动性', label: '打扰门槛', hint: '用途：现在「适不适合插话」的分数低于多少就不主动。调法：调高更谨慎，调低更积极。例：0.3 表示对方不活跃、群里没人聊时就不打扰。' },
  { path: 'proactive.cooldownMinutes', type: 'int', min: 1, max: 720, default: 90, unit: '分钟', group: '主动性', label: '同一对象冷却时间', hint: '用途：对同一个目标两次主动之间至少隔多久。调法：调大更不打扰；连续没人回应会自动再拉长。例：90 表示同一个群/人 90 分钟内不会被主动找第二次。' },

  // ── 表情（6.8 / P2.4）──
  { path: 'sticker.topK', type: 'int', min: 1, max: 10, default: 3, group: '表情', label: '候选表情数量', hint: '用途：先挑出几张候选再比较。调法：调大选择更多但更慢；一般 3 就够。例：3 表示从库里先选 3 张打分最高的再决定。' },
  { path: 'sticker.minScore', type: 'number', min: 0, max: 1, step: 0.05, default: 0.3, group: '表情', label: '表情最低分', hint: '用途：最低多少分才允许发表情。调法：调高更挑剔，调低更容易发；低于它就干脆不发。例：0.3 时，不相关的表情会被拦下，不会硬凑一张。' },
  { path: 'sticker.cooldownMinutes', type: 'int', min: 1, max: 43200, default: 1440, unit: '分钟', group: '表情', label: '表情复用冷却', hint: '用途：同一张表情用过后多久内降权。调法：调大更防刷屏，调小更快复用。例：60 表示一小时内再用同一张会打七折，容易被别的表情超过。' },

  // ── 表现面（GEN3_SURFACE_INTEGRATION_PLAN S0）──
  // 安全限制（webSearch 预算/脱敏等）放原命名空间，行为开关放 socialV3.surface.*，默认全关。
  { path: 'surface.dailyTokenBudget', type: 'int', min: 0, max: 10000000, step: 1000, default: 20000, unit: 'token', group: '表现面', label: '表现面日 token 软预算', hint: '用途：表现面每天 token 消耗的告警线，只统计不阻断。调法：超限只在控制台告警，硬限额仍由 token 账本负责。例：20000 表示当天超两万 token 时提示。' },
  { path: 'surface.traceRetentionDays', type: 'int', min: 1, max: 365, default: 30, unit: '天', group: '表现面', label: '表现面 trace 保留天数', hint: '用途：surface-trace 观测文件保留多少天，超期可清理。调法：按日分文件，只影响观测不影响聊天。例：30 表示保留最近 30 天的操作记录。' },
  { path: 'surface.tokenFile', type: 'string', default: 'state/surface-token', group: '表现面', label: 'surface 凭据文件', hint: '用途：日记等表现面进程专用凭据的路径，与 console-token 分离。调法：一般不动；轮换时旧凭据兼容 24 小时。例：state/surface-token 只能调上下文与回写两个端点。' },
  { path: 'surface.webSearch.enabled', type: 'boolean', default: false, group: '表现面', label: '搜索面开关', hint: '用途：联网搜索表现面总开关，关掉后搜索保持二代行为。调法：需先开「表现面」总开关；搜索始终只读。例：打开后搜索结果会带 trust 标签和调用预算。' },
  { path: 'surface.webSearch.draftMaterialPerDay', type: 'int', min: 0, max: 20, default: 2, group: '表现面', label: '空间素材搜索上限', hint: '用途：桥接为空间说说预取外部素材的每日次数，writer 本身无工具。调法：0 表示不用外部素材；失败不阻断起草。例：2 表示每天最多预取 2 次素材。' },
  { path: 'surface.webSearch.diaryContextEnabled', type: 'boolean', default: false, group: '表现面', label: '日记外部事件搜索', hint: '用途：日记生成时是否允许联网取外部事件素材。调法：默认关闭；开启后每日最多 2 次。例：关闭时日记只写身边事，不引用新闻。' },
  { path: 'surface.webSearch.diskCache', type: 'boolean', default: true, group: '表现面', label: '搜索磁盘缓存', hint: '用途：把搜索结果缓存到本地，重复查询不再出网。调法：开启后缓存 10 分钟；含私聊原文的查询不落盘。例：连续问同一问题只出网一次。' },
  { path: 'surface.webSearch.emptyResultTtlSeconds', type: 'int', min: 5, max: 600, default: 60, unit: '秒', group: '表现面', label: '空结果缓存秒数', hint: '用途：搜不到结果时把「空结果」缓存多少秒。调法：设短一点，避免上游抖动把没搜到缓存太久。例：60 表示一分钟后才会重新出网。' },
  { path: 'surface.qzone.enabled', type: 'boolean', default: false, group: '表现面', label: '空间面开关', hint: '用途：QQ 空间表现面总开关，关掉后空间完全按二代逻辑运行。调法：需先开「表现面」总开关；发布仍须 confirm。例：打开后才启用 V3 上下文与回读等新行为。' },
  { path: 'surface.qzone.contextSource', type: 'enum', enumValues: ['v2', 'v3'], default: 'v2', group: '表现面', label: '空间素材来源', hint: '用途：空间写作上下文用二代混排素材还是三代主人私聊素材。调法：v2 保持现状（群私混用）；v3 只取主人私聊，群聊一律不进。例：灰度期用 v2，验证后切 v3。' },
  { path: 'surface.qzone.useWebMaterial', type: 'boolean', default: false, group: '表现面', label: '说说带外部素材', hint: '用途：起草说说时是否预取 2~3 条外部搜索素材（标不可信）。调法：失败不阻断起草；素材由桥接预取，writer 仍零工具。例：打开后说说可以引用网页事实。' },
  { path: 'surface.qzone.webImages', type: 'boolean', default: false, group: '表现面', label: '允许网络配图', hint: '用途：说说配图是否允许来自网络搜索。调法：默认关，只用本地目录或主人发的图；开启后记录图片来源。例：关闭时绝不引用搜索摘要里的图片链接。' },
  { path: 'surface.qzone.stylePass', type: 'boolean', default: false, group: '表现面', label: '说说风格复核', hint: '用途：起草后用四类硬信号（禁用短语/敏感话题/承诺句式/裸链接）复核一次。调法：最多重写 1 次，失败发原稿；哀悼医疗等话题不改写。例：降低「客服腔」说说。' },
  { path: 'surface.qzone.useAffect', type: 'boolean', default: false, group: '表现面', label: '说说带情绪', hint: '用途：起草说说时是否注入当前情绪基线。调法：需情感模块同时开启；只影响语气不影响事实。例：开心时说说稍轻快一些。' },
  { path: 'surface.qzone.writeMemory', type: 'boolean', default: false, group: '表现面', label: '发布写回记忆', hint: '用途：说说发布成功后把摘要写进长期记忆。调法：按 tid 幂等，只写摘要不写全文；删除说说时记忆失效。例：之后聊天能自然提起发过什么。' },
  { path: 'surface.qzone.proactiveApproval', type: 'boolean', default: false, group: '表现面', label: '主动发布需确认', hint: '用途：机器人主动发空间前是否要主人确认草稿。调法：主人已定默认关（想发就发）；仅灰度观察期临时打开。例：关闭时配额、静默时段、回读照常生效。' },
  { path: 'surface.qzone.notifyPreview', type: 'boolean', default: false, group: '表现面', label: '通知带正文预览', hint: '用途：发布通知里是否带说说正文预览。调法：默认只发「已发布/所有人可见/tid」；开启也只给前 60 字且先脱敏。例：关闭可避免通知泄露正文。' },
  { path: 'surface.qzone.readback', type: 'boolean', default: true, group: '表现面', label: '发布后回读核实', hint: '用途：发布成功后回读空间列表核对 tid 与内容哈希。调法：核实不到记 unknown，不重发不重试。例：打开后发布状态区分已核实/未核实。' },
  { path: 'surface.qzone.skipIfTopicRecentHours', type: 'int', min: 0, max: 72, default: 6, unit: '小时', group: '表现面', label: '话题重复回避', hint: '用途：最近 N 小时聊天里出现过的话题不再拿去发说说。调法：0 表示不回避；越大越避免「刚说完又发一遍」。例：6 表示 6 小时内聊过的话题不重复发。' },
  { path: 'surface.qzone.minGapAfterManualPostMs', type: 'int', min: 0, max: 86400000, step: 60000, default: 7200000, unit: 'ms', group: '表现面', label: '手动发布后间隔', hint: '用途：主人手动发过说说后，机器人至少等多久再发。调法：毫秒；0 表示不等。例：7200000 表示手动发完 2 小时内机器人不发。' },
  { path: 'surface.qzone.proactiveMinPerDay', type: 'int', min: 0, max: 20, default: 1, group: '表现面', label: '每日最少条数', hint: '用途：机器人主动发说说每天至少发几条（当天有素材时）。调法：主人已定每天随机 1~3 条；0 表示允许不发。例：1 表示通常每天至少一条。' },
  { path: 'surface.qzone.proactiveMaxPerDay', type: 'int', min: 0, max: 20, default: 3, group: '表现面', label: '每日最多条数', hint: '用途：机器人主动发说说每天最多几条，到顶后当天不再发。调法：不能小于最少条数；配额外还受静默时段与去重限制。例：3 表示一天最多三条。' },
  { path: 'surface.diary.enabled', type: 'boolean', default: false, group: '表现面', label: '日记面开关', hint: '用途：日记表现面总开关，关掉后日记完全按现有逻辑运行。调法：需先开「表现面」总开关；上下文来源另由来源字段决定。例：打开后日记可读 V3 记忆并回写。' },
  { path: 'surface.diary.contextSource', type: 'enum', enumValues: ['v2', 'v3'], default: 'v2', group: '表现面', label: '日记素材来源', hint: '用途：日记上下文用现有 V2 聊天文件还是桥接 V3 上下文 API。调法：v3 拿不到时自动回退 v2，不会生成空日记。例：验证期用 v2，稳定后切 v3。' },
  { path: 'surface.diary.writeMemory', type: 'boolean', default: false, group: '表现面', label: '日记写回记忆', hint: '用途：日记生成后把摘要幂等写进长期记忆。调法：按日期去重，只写摘要；失败进队列最多重试 3 次。例：次日聊天能自然提到昨天写了日记。' },
  { path: 'surface.diary.styleProfile', type: 'boolean', default: false, group: '表现面', label: '日记风格签名', hint: '用途：日记措辞套用角色称呼/口头禅签名。调法：只影响措辞，不改 200~400 字与第一人称约束。例：让日记读起来像它本人写的。' },
  { path: 'surface.diary.shareToQzone', type: 'boolean', default: false, group: '表现面', label: '日记可转空间', hint: '用途：是否允许把日记片段（经主人确认）转成空间说说草稿。调法：默认关；只生成草稿不自动发，群聊采样段禁止转。例：打开后可说「把这段发空间」。' },
  { path: 'surface.diary.deferIfActiveMinutes', type: 'int', min: 0, max: 120, default: 0, unit: '分钟', group: '表现面', label: '活跃期延后分钟', hint: '用途：生成日记时若主人最近 N 分钟还在说话就先延后。调法：0 表示关闭（默认）；跨零点按前一天整日窗口生成。例：20 表示主人还在聊就推迟。' },
  { path: 'surface.diary.maxDeferMinutes', type: 'int', min: 0, max: 180, default: 60, unit: '分钟', group: '表现面', label: '延后上限分钟', hint: '用途：活跃期延后最多推迟多久，到点强制生成。调法：与延后分钟配合；跨零点仍写前一天。例：60 表示最多推迟一小时。' },
  { path: 'surface.diary.maxWritesPerDay', type: 'int', min: 1, max: 10, default: 3, group: '表现面', label: '日记每日写入上限', hint: '用途：日记每天最多写几次（含 force 重写）。调法：防止模型循环重写；同日无 force 本就拒绝。例：3 表示一天最多写三次。' }
]);

const SCHEMA_BY_PATH = new Map(SOCIAL_V3_SCHEMA.map((e) => [e.path, e]));

function setByPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getByPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** schema → 默认值对象（深克隆，调用方可随意改）。 */
export function socialV3Defaults() {
  const out = {};
  for (const entry of SOCIAL_V3_SCHEMA) {
    setByPath(out, entry.path, Array.isArray(entry.default) ? [...entry.default] : entry.default);
  }
  return out;
}

/** 'attention.speakThreshold' → 'v3AttentionSpeakThreshold'（控制台 DOM id，只追加不改旧 id）。 */
export function fieldId(dotted) {
  return `v3${dotted.split('.').map((p) => p[0].toUpperCase() + p.slice(1)).join('')}`;
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function coerceEntry(entry, raw) {
  switch (entry.type) {
    case 'boolean':
      return raw === true || raw === false ? raw : entry.default;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return entry.default;
      return Math.min(entry.max, Math.max(entry.min, n));
    }
    case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return entry.default;
      return Math.min(entry.max, Math.max(entry.min, Math.round(n)));
    }
    case 'string': {
      const s = String(raw ?? '').trim().slice(0, 200);
      if (!s) return entry.default;
      if (entry.path === 'memory.consolidateAt' && !HHMM_RE.test(s)) return entry.default;
      return s;
    }
    case 'enum':
      return entry.enumValues.includes(String(raw)) ? String(raw) : entry.default;
    case 'string[]': {
      if (!Array.isArray(raw)) return [...entry.default];
      const seen = new Set();
      const out = [];
      for (const item of raw) {
        const s = String(item ?? '').trim();
        if (!s || seen.has(s) || out.length >= 50) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    }
    default:
      return entry.default;
  }
}

/**
 * 归一化入口（输入边界）：类型收敛 + 范围钳制 + 跨字段约束 + 未知键上报。
 * 返回 { value, unknown }；unknown 是配置里出现但 schema 没定义的路径（供日志提示，不静默吞）。
 * 跨字段规则（GEN3 计划 6.2/6.4）：silentThreshold ≤ speakThreshold；cpmMax ≥ cpmMin。
 */
export function normalizeSocialV3(input = {}) {
  const value = socialV3Defaults();
  const known = new Set(SOCIAL_V3_SCHEMA.map((e) => e.path));
  for (const entry of SOCIAL_V3_SCHEMA) {
    const raw = getByPath(input, entry.path);
    if (raw !== undefined) setByPath(value, entry.path, coerceEntry(entry, raw));
  }
  // 跨字段钳制
  const att = value.attention;
  if (att.silentThreshold > att.speakThreshold) att.silentThreshold = att.speakThreshold;
  const rhy = value.rhythm;
  if (rhy.cpmMax < rhy.cpmMin) rhy.cpmMax = rhy.cpmMin;
  // 表现面：主动发布每日条数 min ≤ max（配置面板手输时可能写反）
  const qz = value.surface?.qzone;
  if (qz && qz.proactiveMinPerDay > qz.proactiveMaxPerDay) qz.proactiveMaxPerDay = qz.proactiveMinPerDay;
  // 未知键收集（按点路径展开，最多报 50 个）
  const unknown = [];
  const walk = (node, prefix) => {
    if (unknown.length >= 50 || node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!known.has(p)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
        else unknown.push(p);
      }
    }
  };
  walk(input, '');
  return { value, unknown };
}

/** MCP 工具参数描述（zod describe 用）：label（类型/范围/单位）：hint */
export function describeField(entry) {
  const bits = [entry.type];
  if (entry.type === 'enum') bits.push(entry.enumValues.join('/'));
  else if (entry.min !== undefined) bits.push(`${entry.min}~${entry.max}`);
  if (entry.unit) bits.push(entry.unit);
  return `${entry.label}（${bits.join('，')}）：${entry.hint}`;
}

/** preset 提示词素材：按分组给「参数=默认值 — 说明」行。 */
export function presetHintGroups() {
  const groups = new Map();
  for (const entry of SOCIAL_V3_SCHEMA) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    const def = Array.isArray(entry.default) ? entry.default.join(',') || '(空)' : entry.default;
    groups.get(entry.group).push(`${entry.label}=${def} — ${entry.hint}`);
  }
  return [...groups.entries()].map(([name, lines]) => ({ name, lines }));
}

export { SCHEMA_BY_PATH };
