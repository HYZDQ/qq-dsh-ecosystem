// computer_* 工具目录（P0）：独立分组，不动 douyin_* 的 TOOL_DEFINITIONS（§15 兼容迁移）。
// 风险分级（§8）：status/screen/observe/windows(list) 为 L0 只读；click/type/key 与 windows 变更动作
// 为 L1 桌面写，需两段式确认；L2（Shell/系统设置）P0 不注册；L3 永久禁用。
const empty = () => ({ type: 'object', properties: {}, additionalProperties: false });

export const COMPUTER_TOOL_DEFINITIONS = [
  {
    name: 'computer_status',
    description: '读取电脑操控运行时状态：开关、策略、管理员配置、急停、熔断与驱动可用性。只读，不启动驱动进程。',
    parameters: empty(),
  },
  {
    name: 'computer_screen',
    description: '获取整屏截图（attachment），返回画面概要。只读。',
    parameters: empty(),
  },
  {
    name: 'computer_observe',
    description: '观察当前焦点窗口：窗口列表、UIA 可交互元素（id 仅本次观察有效）与坐标。可选附带截图。只读。',
    parameters: { type: 'object', properties: { screenshot: { type: 'boolean', description: '是否附带整屏截图，默认否。' } }, additionalProperties: false },
  },
  {
    name: 'computer_wait',
    description: '等待一段时间（毫秒，1..10000）再继续，用于等应用启动、动画结束、界面渲染或对话框出现。纯等待，无任何桌面副作用，不需要确认令牌。',
    parameters: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 1, maximum: 10000, description: '等待毫秒数（1..10000）。' } },
      required: ['ms'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_receipts',
    description: '查询历史动作收据（默认最近 20 条）：工具、动作、目标、文本 hash、verified 标记。只读，不含明文输入、剪贴板内容或截图。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数，默认 20。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_windows',
    description: '窗口操作：action=list 只读枚举；launch/switch/resize/close 为桌面写操作，需要确认令牌，且仅限管理员私聊发起。launch 的 name 必须在策略 apps 白名单内；close 为受控关闭通道（先切换到目标窗口并核验焦点，再发送关闭键），不终止进程。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'launch', 'switch', 'resize', 'close'], description: 'list 只读；其余为写操作。' },
        name: { type: 'string', maxLength: 200, description: '应用名或窗口名（launch/switch/resize/close 必填）。' },
        width: { type: 'integer', minimum: 100, maximum: 10000, description: 'resize 目标宽。' },
        height: { type: 'integer', minimum: 100, maximum: 10000, description: 'resize 目标高。' },
        x: { type: 'integer', description: 'resize 目标位置 x。' },
        y: { type: 'integer', description: 'resize 目标位置 y。' },
        confirmToken: { type: 'string', maxLength: 64, description: '写操作的确认令牌：首次调用不带此参数返回 needsConfirm 与令牌，60 秒内携带令牌再次调用才执行。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_click',
    description: '点击元素（label 来自 computer_observe，仅本次观察有效）或坐标。也可给 target 描述（如"点赞按钮"）：UIA 有同名元素优先走结构化点击，纯图标/自绘界面自动走视觉兜底闭环（截图→识图→点击→再截图确认）。桌面写操作：仅管理员私聊可发起，首次调用返回 needsConfirm，携带确认令牌再次调用才执行；同参数 24 小时内自动去重。',
    parameters: {
      type: 'object',
      properties: {
        elementId: { type: 'string', maxLength: 20, description: 'computer_observe 返回的元素稳定 id（推荐，跨观察有效）。' },
        label: { type: 'integer', minimum: 0, description: '当次观察内的元素标注号（与 elementId 二选一，仅观察快照内有效）。' },
        x: { type: 'integer', description: '坐标 x（与元素 id 二选一）。' },
        y: { type: 'integer', description: '坐标 y（与元素 id 二选一）。' },
        target: { type: 'string', maxLength: 100, description: '描述性目标（如"点赞按钮"）：无元素/坐标时用；结构化优先，UIA 盲区走视觉兜底（需 allowVisionFallback）。' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '按键，默认 left。' },
        count: { type: 'integer', minimum: 1, maximum: 3, description: '点击次数，默认 1。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_type',
    description: '在元素或坐标处输入文本（中文自动走剪贴板粘贴策略）；也可给 target 描述走视觉兜底定位。桌面写操作，确认流程与 computer_click 相同。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 10000, description: '要输入的文本。' },
        elementId: { type: 'string', maxLength: 20, description: 'computer_observe 返回的元素稳定 id（推荐，跨观察有效）。' },
        label: { type: 'integer', minimum: 0, description: '当次观察内的元素标注号（与 elementId 二选一）。' },
        x: { type: 'integer', description: '坐标 x（与元素 id 二选一）。' },
        y: { type: 'integer', description: '坐标 y（与元素 id 二选一）。' },
        target: { type: 'string', maxLength: 100, description: '描述性目标（如"搜索框"）：无元素/坐标时用；结构化优先，UIA 盲区走视觉兜底（需 allowVisionFallback）。' },
        replace: { type: 'boolean', description: '输入前是否清空原有内容，默认否。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_key',
    description: '发送快捷键组合（如 ctrl+s、alt+tab）。桌面写操作，确认流程与 computer_click 相同；锁屏、关窗等系统级危险组合被永久拒绝。',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', maxLength: 50, description: '组合键，例如 ctrl+s、shift+f3。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_move',
    description: '移动鼠标到元素或坐标（悬停，不点击），用于唤出"见鼠标才出现"的工具栏、提示或浮动按钮。桌面写操作：仅管理员私聊可发起，首次调用返回 needsConfirm，携带确认令牌再次调用才执行。',
    parameters: {
      type: 'object',
      properties: {
        elementId: { type: 'string', maxLength: 20, description: 'computer_observe 返回的元素稳定 id（推荐，跨观察有效）。' },
        label: { type: 'integer', minimum: 0, description: '当次观察内的元素标注号（与 elementId 二选一）。' },
        x: { type: 'integer', description: '坐标 x（与元素 id 二选一）。' },
        y: { type: 'integer', description: '坐标 y（与元素 id 二选一）。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_scroll',
    description: '在元素或坐标处滚动；不给目标时在当前光标位置滚动。桌面写操作：仅管理员私聊可发起，确认流程与 computer_click 相同。',
    parameters: {
      type: 'object',
      properties: {
        elementId: { type: 'string', maxLength: 20, description: 'computer_observe 返回的元素稳定 id（推荐，跨观察有效）。' },
        label: { type: 'integer', minimum: 0, description: '当次观察内的元素标注号（与 elementId 二选一）。' },
        x: { type: 'integer', description: '坐标 x（与元素 id 二选一）。' },
        y: { type: 'integer', description: '坐标 y（与元素 id 二选一）。' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向，默认 down。' },
        times: { type: 'integer', minimum: 1, maximum: 20, description: '滚轮次数（1 次约 3-5 行），默认 1。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_drag',
    description: '把元素或坐标 from 拖拽到 to（如拖动滑块、拖放文件、拖动窗口边缘）。桌面写操作：仅管理员私聊可发起，确认流程与 computer_click 相同。',
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          description: '起点目标：elementId 或 label 或 x,y。',
          properties: {
            elementId: { type: 'string', maxLength: 20, description: '元素稳定 id（推荐）。' },
            label: { type: 'integer', minimum: 0, description: '当次观察内标注号。' },
            x: { type: 'integer', description: '坐标 x。' },
            y: { type: 'integer', description: '坐标 y。' },
          },
          additionalProperties: false,
        },
        to: {
          type: 'object',
          description: '落点目标：elementId 或 label 或 x,y。',
          properties: {
            elementId: { type: 'string', maxLength: 20, description: '元素稳定 id（推荐）。' },
            label: { type: 'integer', minimum: 0, description: '当次观察内标注号。' },
            x: { type: 'integer', description: '坐标 x。' },
            y: { type: 'integer', description: '坐标 y。' },
          },
          additionalProperties: false,
        },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_clipboard',
    description: '读或写系统剪贴板。桌面写操作，确认流程与 computer_click 相同；读操作可能泄露敏感内容，同样需要确认令牌。收据不记录内容。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'read 读取，write 写入。' },
        text: { type: 'string', maxLength: 10000, description: 'action=write 时要写入的文本。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_browser_observe',
    description: '结构化观察浏览器页面（DOM 级）：URL、标题、可交互元素（ref 跨观察稳定）。只读，复用用户已登录的专用浏览器标签页，不启动新浏览器。',
    parameters: {
      type: 'object',
      properties: {
        urlPattern: { type: 'string', maxLength: 200, description: '选页：URL 正则（可省略=第一个可见页）。' },
        titlePattern: { type: 'string', maxLength: 200, description: '选页：标题正则。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_browser_open',
    description: '在浏览器标签页导航到 http(s) 链接（登录态不搬家，不覆写 UA）。桌面写操作同款流程：仅管理员私聊可发起，首次返回 needsConfirm，携带确认令牌才执行；目标域名须在 policy domains 白名单内。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 1000, description: 'http(s) 链接。' },
        urlPattern: { type: 'string', maxLength: 200, description: '选页：URL 正则。' },
        titlePattern: { type: 'string', maxLength: 200, description: '选页：标题正则。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_browser_click',
    description: '点击页面元素（ref 来自 computer_browser_observe，跨观察稳定；执行前重新解析）。走原生 element.click()（派发鼠标事件不可靠）。写操作确认流程与 computer_click 相同。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', maxLength: 20, description: 'computer_browser_observe 返回的元素 ref。' },
        urlPattern: { type: 'string', maxLength: 200, description: '选页：URL 正则。' },
        titlePattern: { type: 'string', maxLength: 200, description: '选页：标题正则。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_browser_fill',
    description: '填写页面表单元素（ref 来自 computer_browser_observe）：设值并派发 input/change（受控组件兼容）。写操作确认流程与 computer_click 相同。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', maxLength: 20, description: 'computer_browser_observe 返回的元素 ref。' },
        text: { type: 'string', maxLength: 10000, description: '要填入的文本。' },
        replace: { type: 'boolean', description: '是否清空原值，默认是。' },
        urlPattern: { type: 'string', maxLength: 200, description: '选页：URL 正则。' },
        titlePattern: { type: 'string', maxLength: 200, description: '选页：标题正则。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_browser_download',
    description: '点击页面下载目标（ref）触发下载，保存到 computer/downloads 并核验落盘。写操作确认流程与 computer_click 相同。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', maxLength: 20, description: '触发下载的元素 ref。' },
        filename: { type: 'string', maxLength: 200, description: '保存文件名（可省略=用建议名）。' },
        urlPattern: { type: 'string', maxLength: 200, description: '选页：URL 正则。' },
        titlePattern: { type: 'string', maxLength: 200, description: '选页：标题正则。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_task_status',
    description: '只读当前任务状态：目标、进度、剩余预算与已完成步骤数。不开始、不改变任务。',
    parameters: empty(),
  },
  {
    name: 'computer_task_plan',
    description: '按任务目标匹配领域包并产出 L1 步骤计划（P3 主干-分支路由）：只读规划，不执行任何动作。没有领域包认领时返回空计划与包清单。任务规划仅限管理员私聊。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', maxLength: 2000, description: '要规划的任务目标；不给就用当前任务的目标。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'computer_task_start',
    description: '创建并启动一个桌面任务（同一时刻仅一个）。任务控制仅限管理员私聊（9.3 红线），其他来源一律 NOT_ADMIN。带预算（步数/时长/写次数），超限自动暂停。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: 2000, description: '任务目标，人话描述要完成什么。' },
        budget: {
          type: 'object',
          additionalProperties: false,
          description: '可选预算覆盖，默认 maxSteps=30、maxWallMs=600000、maxWrites=80。',
          properties: {
            maxSteps: { type: 'integer', minimum: 1, maximum: 10000 },
            maxWallMs: { type: 'integer', minimum: 1000, maximum: 36000000 },
            maxWrites: { type: 'integer', minimum: 1, maximum: 10000 },
          },
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'computer_task_pause',
    description: '暂停当前任务并保留 checkpoint（已完成步骤、预算余量）。任务控制仅限管理员私聊。',
    parameters: empty(),
  },
  {
    name: 'computer_task_resume',
    description: '从 checkpoint 恢复暂停或被中断的任务；之前会话已完成的步骤不会重复执行。任务控制仅限管理员私聊。',
    parameters: empty(),
  },
  {
    name: 'computer_task_stop',
    description: '结束当前任务并落盘收据；completed=true 表示任务目标已完成（done），否则为中止（cancelled）。任务控制仅限管理员私聊。',
    parameters: {
      type: 'object',
      properties: { completed: { type: 'boolean', description: '任务是否已完成，默认否。' } },
      additionalProperties: false,
    },
  },
];

// L1 写工具（执行前必须过策略 + 管理员 + 确认令牌；剪贴板读也含在内，可能泄露敏感内容）。
// computer_wait 属 L0：纯等待无桌面副作用，不在此列。
export const COMPUTER_WRITE_TOOLS = Object.freeze([
  'computer_click', 'computer_type', 'computer_key', 'computer_move', 'computer_scroll', 'computer_drag',
  'computer_windows', 'computer_clipboard',
  'computer_browser_open', 'computer_browser_click', 'computer_browser_fill', 'computer_browser_download',
]);

// 任务控制工具：仅管理员私聊（status 除外，只读可放行）。
export const COMPUTER_TASK_TOOLS = Object.freeze(['computer_task_plan', 'computer_task_start', 'computer_task_pause', 'computer_task_resume', 'computer_task_stop']);

// L2 系统级（§8.3）：profile=power 才注册可见（computer_shell 另需 allowShell=true）；
// 每次显式确认、禁止自治（AUTONOMY_FORBIDDEN）；独立分组，不进常驻目录（L3 名字契约只锁常驻组）。
export const COMPUTER_L2_TOOL_DEFINITIONS = [
  {
    name: 'computer_shell',
    description: '以 PowerShell 执行一条命令（L2 系统级）：仅 profile=power 且 allowShell=true 时存在，仅管理员私聊可发起，首次调用返回 needsConfirm，携带确认令牌再次调用才执行；自治任务内一律拒绝。收据只记命令 hash，不记明文输出。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', maxLength: 2000, description: 'PowerShell 命令（单条，15 秒超时）。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'computer_settings',
    description: '打开 Windows 系统设置页（L2 系统级）：page 限白名单页面（display/sound/notifications/network/apps/privacy 等）。仅 profile=power 时存在，仅管理员私聊可发起，需确认令牌；自治任务内一律拒绝。只打开页面，不修改任何系统开关。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'string', maxLength: 40, description: '设置页标识，如 display、sound、network。' },
        confirmToken: { type: 'string', maxLength: 64 },
      },
      required: ['page'],
      additionalProperties: false,
    },
  },
];

export const COMPUTER_L2_TOOLS = Object.freeze(['computer_shell', 'computer_settings']);

export default COMPUTER_TOOL_DEFINITIONS;
