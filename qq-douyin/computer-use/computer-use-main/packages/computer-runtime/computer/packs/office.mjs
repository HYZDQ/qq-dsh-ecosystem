// Office 领域包（§7.3 P3）：Excel/Word/WPS 文档操作。
// 结构化操作优先于 GUI——当前阶段先落 GUI 配方（真机验证过的 WPS 流程），动作产出 L1 步骤计划。
import { DomainPack } from './domain-pack.mjs';
import { fail } from '../policy.mjs';

export class OfficePack extends DomainPack {
  id = 'office';

  matches({ title = '' } = {}) {
    return /Excel|Word|PowerPoint|WPS|演示|表格|文字|\.xlsx|\.docx|\.pptx/i.test(String(title));
  }

  observe(ctx = {}) {
    return {
      pack: this.id,
      title: ctx.title ?? '',
      note: '文档网格多为自绘（UIA 无名/稀疏，§4.1 盲区）：单元格输入按窗口坐标，另存为走 F12 流程（见 prompt）。',
    };
  }

  actions() {
    return [
      { name: 'inputCell', description: '在坐标处输入一行并回车', params: ['text', 'x', 'y'] },
      { name: 'saveAs', description: '打开另存为对话框（后续按 prompt 填文件名）', params: [] },
    ];
  }

  plan(action, args = {}) {
    super.plan(action);
    if (action === 'inputCell') {
      const text = String(args.text ?? '');
      const x = Number(args.x), y = Number(args.y);
      if (!text || !Number.isFinite(x) || !Number.isFinite(y)) throw fail('ELEMENT_NOT_FOUND', 'inputCell 需要 text 与 x,y。');
      return [
        { tool: 'computer_click', args: { x, y } },
        { tool: 'computer_type', args: { text, x, y } },
        { tool: 'computer_key', args: { keys: 'enter' } },
      ];
    }
    if (action === 'saveAs') {
      return [
        { tool: 'computer_key', args: { keys: 'f12' } },
        { tool: 'computer_wait', args: { ms: 3000 } },
      ];
    }
    return [];
  }

  prompt() {
    return [
      'Office/WPS 领域约束（§7.3，真机实测配方）：',
      '1. 工作簿网格与名称框是自绘控件：单元格输入按 UIA 坐标点击后 type，别依赖元素名。',
      '2. 另存为：F12 → 在「文件名称(N)」框先 Ctrl+A 全选清掉预填文本，再输入**纯文件名**（如 莓莓你好.txt）→ 回车即落盘。**不要把整条路径塞进文件名框**——预填+整路径回车会弹错框存不下（现网踩坑）；要改目录用对话框左侧/地址栏。',
      '3. 未落盘再找「保存/确定」确认按钮。',
      '4. WPS home 启动页（标题「WPS Office - WPS Office」）不是工作簿，不要当文档操作。',
      '5. 只操作自动化新建的文档；用户已打开的文件绝不触碰（不可逆动作 §9.2）。',
    ].join('\n');
  }

  policyExt() {
    return {
      deny: ['delete', 'overwrite-user-file'],
      requireConfirm: [],
      note: '动作均为 L1 写操作，走统一确认令牌与收据。',
    };
  }
}
