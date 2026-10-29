// 领域包基类（§7.1）：领域包只能通过 L1 动作层执行——这里在结构上强制：
// 包不持有鼠标键盘句柄、不持有驱动，plan() 只产出「L1 工具调用步骤」，由运行时/调用方执行。
// 每个包提供：matches（窗口归属判断）、observe（领域观察）、actions（动作清单）、
// prompt（领域提示）、policyExt（领域附加限制）。
import { fail } from '../policy.mjs';

// 允许出现在领域包计划里的 L1/L0 工具（§8）：包不得通过计划触达 L2/L3 能力。
export const PACK_ALLOWED_TOOLS = Object.freeze([
  'computer_observe', 'computer_wait', 'computer_screen', 'computer_windows',
  'computer_click', 'computer_type', 'computer_key', 'computer_move', 'computer_scroll', 'computer_drag',
  'computer_browser_observe', 'computer_browser_open', 'computer_browser_click', 'computer_browser_fill', 'computer_browser_download',
]);

export class DomainPack {
  id = '';

  // 判断当前窗口/上下文是否属于本包：ctx = { title, process?, url? }
  matches(_ctx) { return false; }

  // 领域专属结构化观察（只读）。
  observe(ctx) { return { pack: this.id, title: ctx?.title ?? '' }; }

  // 领域动作清单：[{ name, description, params? }]
  actions() { return []; }

  // 给模型的领域提示（注入观察结果）。
  prompt() { return ''; }

  // 领域附加限制（并入策略评估）。
  policyExt() { return { deny: [], requireConfirm: [] }; }

  // 产出 L1 步骤计划：[{ tool, args }]。只允许 PACK_ALLOWED_TOOLS（结构约束 §7.1）。
  plan(action, _args = {}) {
    const known = this.actions().some((item) => item.name === action);
    if (!known) throw fail('ELEMENT_NOT_FOUND', `领域包 ${this.id} 没有动作：${action}`);
    return [];
  }

  // 计划自检：越权工具直接拒绝（回归网用）。
  static assertPlanAllowed(steps = []) {
    for (const step of steps) {
      if (!PACK_ALLOWED_TOOLS.includes(step?.tool)) throw fail('TOOLSET_LEAK', `领域包计划触达越权工具：${step?.tool}`);
    }
    return true;
  }
}
