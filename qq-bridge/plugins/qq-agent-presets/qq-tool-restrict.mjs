// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 /
// qzone-writer 三个 agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。qzone-writer 另有自己的
// qzone-writer-guard：它不挂载任何工具行，并在执行期无条件拒绝所有工具。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
  // mcp-image：只提供“检索 + 发送图片”（image_search 检索候选并返回缩略图，
  // image_send 把挑选过的 1~3 张图交给桥接发送）。它不含本地文件、命令执行、
  // 子代理或群管理能力：下载/白名单/审计/限流全部在桥接侧，因此与
  // web-search-safe 同属可放行面。
  'mcp__image__',
  // mcp-qzone：QQ 空间说说起草/发布。仅主人私聊明确要求时由聊天 agent 使用；
  // qzone_draft 先给主人确认、confirm=true 后才 qzone_publish。qzone-writer
  // 撰稿会话不挂载本守卫（它有自己的 qzone-writer-guard，禁止一切工具）。
  'mcp__qzone__',
  // mcp-diary（qq-diary 项目）：写/读角色自己的日记。只有本地 Markdown 读写，
  // 不含命令执行、网络访问或群管理能力；写日记在预设提示里限定为「主人私聊明确要求
  // 或角色自己想写」，群聊 key 会被工具自身拒绝。
  'mcp__diary__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

// dsh-mnemon 的“长期记忆本”工具（只放行记/查/状态这一层）：
// - runtime_memory：机器人自己的长期小本本（每轮自动注入，可 add/replace/remove）
// - recall / related / document_search / status：按需回忆长期事实、项目文档、健康检查（只读）
// - remember：写入 Memory Space（未配置 Provider 时会失败；留作以后启用长期空间）
// 不放行：document_manage/create、memory_body_*、forget/link、view_action/route、subagent_result
// —— 那些属于管理面/敏感面，群聊场景不应暴露。
const SAFE_MNEMON = new Set([
  'mnemon_runtime_memory',
  'mnemon_recall',
  'mnemon_related',
  'mnemon_document_search',
  'mnemon_status',
  'mnemon_remember',
])

// dsh-douyin-agent 的“刷抖音”工具（只放行看/搜/播放/自主观看/共享记忆；
// 评论、分享、私信自动回复、续火花问候等外发工具一律不放行）。
// 自主观看还受插件设置里的允许时段、单轮时长、请求预算和总开关限制，
// 且 douyin_watch_start 为持续观看（当天时段内自动续轮、请求无上限），主人说停才停。
const SAFE_DOUYIN = new Set([
  // 只读/状态
  'douyin_status',
  'douyin_screenshot',
  'douyin_video_limits_status',
  'douyin_watch_status',
  'douyin_persona_status',
  // 浏览与播放
  'douyin_open',
  'douyin_open_video',
  'douyin_search',
  'douyin_next',
  'douyin_previous',
  'douyin_play',
  'douyin_pause',
  'douyin_observe',
  // 自主观看（受插件设置约束）
  'douyin_watch_start',
  'douyin_watch_stop',
  'douyin_interest_record',
  // 共享记忆
  'douyin_recall',
  'douyin_remember',
  // ── 新插件 dsh-douyin-agent（v2）的**只读**工具名 ──
  // 说明：这些只读、不外发，群聊/仿真模式下放行是安全的；
  // 写操作（douyin_dm / douyin_share_card / douyin_comment_reply /
  // douyin_comment_mention / douyin_tell_owner）一律**不放行**，
  // 它们只在主人私聊（closed-agent）里可用。
  'douyin_doctor',
  'douyin_feed',
  'douyin_video',
  'douyin_comments',
  'douyin_notices',
  'douyin_at_me',
  'douyin_im_read',
  'douyin_run',
  'douyin_scout', // 只读采集（推荐流+热榜打分清单），与 douyin_run 同性质；2026-10-27 主干-分支重组 P1 补
  'douyin_persona',
  // ── 写操作（2026-10-24 使用者明确要求：reserved2 下群聊与私聊同等放行）──
  // ⚠️ 放行后群里任何人都能驱动它对外发私信/评论/分享卡片。
  //    网关侧仍有：插件自己的 confirm 闸、autoSend 开关、熔断、收据去重；
  //    桥接侧仍有：config 私聊/群白名单、速率、敏感词。
  'douyin_dm',
  'douyin_share_card',
  'douyin_comment_reply',
  'douyin_comment_mention',
  'douyin_like', // 2026-10-27 新增：点赞/收藏（低风险写操作）与直播间（只读进房）
  'douyin_collect',
  'douyin_live_open',
  'douyin_live_observe',
])

// ── computer_*（computer-use 的电脑操控工具）─────────────────────────────
// 红线（2026-10-26 二次修订，使用者明确要求）：**仿真会话的管理员私聊也可以下命令操控电脑**。
// 身份把关从「注册期藏工具」改为「运行期按真实身份」：qq-bridge 把「DSH 会话 ↔ QQ 会话」
// 映射发布到 computer/qq-sessions.json，插件按 exec.agent.session.id 反查 kind/userId 交给
// 运行时闸门——群聊/非管理员私聊只有 computer_status / computer_task_status，
// 管理员私聊才有观察/点击/输入/任务控制。因此本守卫**放行全部 computer_***，
// 注册期不再隐藏（注册期无法区分会话，藏了管理员私聊也用不了）。
// 层次：pwsh/fs/subagent 等本地执行工具仍按 L7 铁律注册期隐藏+执行期拒绝，不受本次修订影响。
const SAFE_COMPUTER_READ = new Set([
  'computer_status',
  'computer_task_status',
])
const COMPUTER_OWNER_ONLY = [
  'computer_screen', 'computer_observe', 'computer_wait', 'computer_receipts', 'computer_windows',
  'computer_click', 'computer_type', 'computer_key', 'computer_move', 'computer_scroll', 'computer_drag', 'computer_clipboard',
  'computer_browser_observe', 'computer_browser_open', 'computer_browser_click', 'computer_browser_fill', 'computer_browser_download',
  'computer_task_start', 'computer_task_pause', 'computer_task_resume', 'computer_task_stop',
]

// 供 test-preset-local-tools.mjs 对账，避免两份名单漂移。
export const COMPUTER_OWNER_ONLY_TOOL_NAMES = Object.freeze([...COMPUTER_OWNER_ONLY])

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] })
    } catch (error) {
      // 名字不存在时跳过；执行期白名单仍然兜底。
      console.error(`[qq-tool-restrict] skip restrict ${name}: ${error?.message ?? error}`)
    }
  }

  // computer_* 不再注册期隐藏（2026-10-26 二次修订）：注册期无法区分会话身份，
  // 隐藏会让管理员私聊也用不了；身份把关在运行时（见上方红线注释）。
  // 本守卫只留执行期放行（下方 guard）。

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (SAFE_EXACT.has(name)) return
    if (SAFE_MNEMON.has(name)) return
    if (SAFE_DOUYIN.has(name)) return
    if (SAFE_COMPUTER_READ.has(name)) return
    // computer_* 一律放行到运行时把关（红线 2026-10-26 二次修订：放行全部 computer_*）。
    // 前缀匹配而非名单匹配：名单漏一个新工具（2026-10-27 现网踩坑：move/scroll/drag/wait/
    // browser_* 都没进旧名单），守卫就会拒掉管理员的正常操控；身份/档位/确认令牌
    // 全部由运行时逐次复核，这里只挡非 computer_* 的本地执行面。
    if (name.startsWith('computer_')) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
