// lib/pack.mjs —— 抖音领域包（P3 主干-分支接线的「分支」端）
// ============================================================================
// 主干（computer-use 包的 computer-runtime）通过 DomainPack 契约调用本包：
//   matches / observe / actions / prompt / policyExt / plan / handlesGoal
// 结构约束（§7.1）：包不持有鼠标键盘句柄、不驱动浏览器；plan() 只产出主干 L1 工具
// （computer_*）步骤，由主干的任务引擎执行。深度领域操作走本包的 douyin_* 工具面。
//
// 接入方式：分支插件激活时把 { id, name, module } 写进共享状态目录的
//   <stateDir>/computer/packs.d/douyin.json（见 registerPack / unregisterPack），
// 主干的 PackRegistry 扫描 packs.d 动态加载 createPack(deps)。卸载时自清理。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_ID = 'douyin';

// 主干 L1 允许清单（与 computer/packs/domain-pack.mjs 的 PACK_ALLOWED_TOOLS 对齐）：
// 分支计划只准用这些工具，越权步骤会被主干 assertPlanAllowed 拒绝（TOOLSET_LEAK）。
const L1_ALLOWED = Object.freeze([
  'computer_observe', 'computer_wait', 'computer_screen', 'computer_windows',
  'computer_click', 'computer_type', 'computer_key', 'computer_move', 'computer_scroll', 'computer_drag',
  'computer_browser_observe', 'computer_browser_open', 'computer_browser_click', 'computer_browser_fill', 'computer_browser_download',
]);

class DouyinBranchPack {
  id = PACK_ID;

  constructor(deps = {}) {
    this.deps = deps;
  }

  // 判断当前窗口/上下文是否属于抖音（§7.2 归属判断，与内置包同语义）。
  matches({ title = '', url = '' } = {}) {
    return /抖音|douyin/i.test(String(title)) || /douyin\.com/i.test(String(url));
  }

  observe(ctx = {}) {
    return {
      pack: this.id,
      title: ctx.title ?? '',
      note: '深度观察走 douyin_observe / douyin_status（分支领域工具）；本包负责归属判断与 L1 计划。',
    };
  }

  actions() {
    return [
      { name: 'open', description: '打开抖音推荐流（L1 计划）' },
      { name: 'browse', description: '推荐流向下翻一条（L1 计划）' },
      { name: 'playback', description: '播放/暂停当前视频（L1 计划）' },
      { name: 'memory', description: '记忆与回忆（douyin_remember / douyin_recall，分支工具面执行）' },
      { name: 'chat', description: '私信（douyin_chat_*，许可名单制，分支工具面执行）' },
      { name: 'watch', description: '自主观看/续火花/日报（douyin_watch_* / douyin_spark_* / douyin_report_*，分支工具面执行）' },
    ];
  }

  prompt() {
    return [
      '抖音领域约束（现网硬约束）：',
      '1. 浏览器反检测补丁（navigator.webdriver、plugins）必须保留，否则接口返回空数据；禁止覆写 User-Agent（自定义 UA 会下发降级前端，评论编辑器/私信列表无法挂载）。',
      '2. 评论区懒加载：定位目标评论前先滚动触发渲染。',
      '3. 带 @ 的公开评论可能进审核队列：回读按「已提交成功」判定，不强求列表立即可见。',
      '4. 私信发送前二次核对对端 sec_uid，不一致即中止；分享卡片先卡片、间隔几秒再发文字。',
      '5. 搜索走 UI 搜索页（douyin_search，分支新实现）；遇风控返回空清单，不重试轰炸。',
    ].join('\n');
  }

  policyExt() {
    return {
      deny: [],
      requireConfirm: ['douyin_dm', 'douyin_share_card', 'douyin_comment_mention', 'douyin_comment_reply', 'douyin_forward_video'],
      note: '对外发送类动作受许可名单与 24h 收据去重约束（分支既有实现）。',
    };
  }

  // goal 认领（P3 路由）：命中抖音领域就把目标映射到可 L1 计划的动作。
  handlesGoal(goal = '') {
    const text = String(goal ?? '');
    if (!/抖音|douyin/i.test(text)) return null;
    if (/播放|暂停/.test(text)) return { action: 'playback', args: {}, note: '播放控制' };
    if (/刷|翻|看|浏览|下一条/.test(text)) return { action: 'browse', args: {}, note: '推荐流浏览' };
    return { action: 'open', args: {}, note: '默认先打开推荐流' };
  }

  // L1 步骤计划（§7.1）：只产出 PACK_ALLOWED_TOOLS 成员，主干执行。
  plan(action, args = {}) {
    void args;
    if (action === 'open') {
      return [
        { tool: 'computer_browser_open', args: { url: 'https://www.douyin.com/?recommend=1&from_nav=1' } },
        { tool: 'computer_wait', args: { ms: 3000 } },
        { tool: 'computer_observe', args: {} },
      ];
    }
    if (action === 'browse') {
      return [
        { tool: 'computer_browser_open', args: { url: 'https://www.douyin.com/?recommend=1&from_nav=1' } },
        { tool: 'computer_wait', args: { ms: 2500 } },
        { tool: 'computer_scroll', args: { deltaY: 820 } },
        { tool: 'computer_wait', args: { ms: 2500 } },
        { tool: 'computer_observe', args: {} },
      ];
    }
    if (action === 'playback') {
      return [
        { tool: 'computer_key', args: { key: 'space' } },
        { tool: 'computer_wait', args: { ms: 600 } },
        { tool: 'computer_observe', args: {} },
      ];
    }
    throw new Error(`动作 ${action} 由分支工具面（douyin_*）执行，不走 L1 计划。`);
  }
}

/** 主干 PackRegistry 的加载入口：契约要求导出 createPack(deps)。 */
export function createPack(deps = {}) {
  return new DouyinBranchPack(deps);
}

// ── 自注册（分支插件激活时调用；卸载时 unregisterPack）──────────────────────

function packsDir(stateDir) {
  return path.join(stateDir, 'computer', 'packs.d');
}

/**
 * 把本分支写进主干的 packs.d 注册表。
 * @param stateDir 主干共享状态目录（resolveRuntimePaths().stateDir）。
 */
export function registerPack(stateDir, modulePath = fileURLToPath(import.meta.url)) {
  const dir = packsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${PACK_ID}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: PACK_ID, name: 'dsh-douyin-agent', module: modulePath }, null, 2));
  return file;
}

/** 分支卸载时清理注册声明（幂等）。 */
export function unregisterPack(stateDir) {
  try { fs.unlinkSync(path.join(packsDir(stateDir), `${PACK_ID}.json`)); } catch { /* 幂等 */ }
}
