// 资源管理器领域包（§7.3 P2）：文件对话框、目录整理。
// 动作全部产出 L1 步骤计划（§7.1 结构约束），由运行时/调用方执行；包自身不碰键鼠。
import { DomainPack } from './domain-pack.mjs';
import { fail } from '../policy.mjs';

export class ExplorerPack extends DomainPack {
  id = 'explorer';

  matches({ title = '' } = {}) {
    return /文件资源管理器|资源管理器|Explorer/i.test(String(title));
  }

  observe(ctx = {}) {
    return {
      pack: this.id,
      title: ctx.title ?? '',
      note: '导航用 ctrl+l 聚焦地址栏；路径含中文走剪贴板粘贴策略（§5.2）。',
    };
  }

  actions() {
    return [
      { name: 'navigate', description: '导航到目录', params: ['path'] },
      { name: 'newFolder', description: '新建文件夹（可命名）', params: ['name?'] },
      { name: 'archive', description: '归档：新建归档文件夹（newFolder 的语义别名）', params: ['name'] },
    ];
  }

  plan(action, args = {}) {
    super.plan(action);
    const path_ = String(args.path ?? '').trim();
    const name = String(args.name ?? '').trim();
    if (action === 'navigate') {
      if (!path_) throw fail('ELEMENT_NOT_FOUND', 'navigate 需要 path。');
      return [
        { tool: 'computer_key', args: { keys: 'ctrl+l' } },
        { tool: 'computer_type', args: { text: path_, replace: true } },
        { tool: 'computer_key', args: { keys: 'enter' } },
        { tool: 'computer_wait', args: { ms: 1200 } },
      ];
    }
    if (action === 'newFolder' || action === 'archive') {
      return [
        { tool: 'computer_key', args: { keys: 'ctrl+shift+n' } },
        ...(name ? [{ tool: 'computer_type', args: { text: name, replace: true } }] : []),
        { tool: 'computer_key', args: { keys: 'enter' } },
        { tool: 'computer_wait', args: { ms: 1200 } },
      ];
    }
    return [];
  }

  prompt() {
    return [
      '资源管理器领域约束（§7.3）：',
      '1. 只做「新建/重命名/导航」类整理；删除、移动用户文件不在本包动作内（不可逆动作 §9.2）。',
      '2. 文件对话框里要定位目录：地址栏（Ctrl+L）填完整路径；「文件名」框只输纯文件名（先 Ctrl+A 清预填），整条路径塞进文件名框会弹错框（现网踩坑）。',
      '3. 归档目录建在 TEMP 或任务指定目录下，不触碰用户文档目录。',
    ].join('\n');
  }

  policyExt() {
    return {
      deny: ['delete', 'move-user-file'],
      requireConfirm: [],
      note: '本包动作均为 L1 写操作，仍走统一确认令牌与收据。',
    };
  }
}
