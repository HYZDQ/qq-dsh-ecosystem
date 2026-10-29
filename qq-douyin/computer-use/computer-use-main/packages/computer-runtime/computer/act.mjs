// 动作层（P0）：点击/输入/快捷键的白名单与驱动映射（§5）。
// 点击顺序固定为「UIA label → 坐标兜底」，派发鼠标事件不作为独立路径；
// 中文输入由 windows-mcp 的 Type 内部处理（UIA Value → 剪贴板），失败返回 INPUT_UNSUPPORTED 不重试。
import { fail } from './policy.mjs';

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'win']);
const PLAIN_KEYS = new Set([
  'esc', 'escape', 'enter', 'return', 'tab', 'space', 'backspace', 'delete', 'insert',
  'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'pause', 'printscreen',
  '-', '=', '+', ',', '.', '/', ';', "'", '[', ']',
]);
// 系统级危险组合：锁屏、运行框、任务管理器、关闭窗口、UAC/安全桌面。
const DENIED_COMBOS = new Set([
  'win+l', 'win+r', 'win+x', 'win+u', 'win+i', 'win+q', 'win+m', 'win+d', 'win+e',
  'alt+f4', 'ctrl+alt+delete', 'ctrl+alt+del', 'ctrl+shift+esc', 'ctrl+alt+end', 'alt+space',
]);

// 白名单组合校验：[ctrl|shift|alt|win]+ … + 单键（字母/数字/F1-F12/常用控制键）。
export function validateShortcut(keys) {
  const combo = String(keys ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!combo) throw fail('INPUT_UNSUPPORTED', '快捷键不能为空。');
  if (DENIED_COMBOS.has(combo)) throw fail('TITLE_DENIED', `快捷键组合 ${combo} 属于系统级危险组合，已拒绝。`);
  const parts = combo.split('+').filter(Boolean);
  if (parts.length < 2 && !PLAIN_KEYS.has(combo) && !/^[a-z0-9]$/.test(combo) && !/^f([1-9]|1[0-2])$/.test(combo)) {
    throw fail('INPUT_UNSUPPORTED', `不支持的按键：${combo}`);
  }
  const finalKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  for (const modifier of modifiers) if (!MODIFIERS.has(modifier)) throw fail('INPUT_UNSUPPORTED', `不支持的修饰键：${modifier}`);
  const plain = /^[a-z0-9]$/.test(finalKey) || PLAIN_KEYS.has(finalKey) || /^f([1-9]|1[0-2])$/.test(finalKey);
  if (!plain) throw fail('INPUT_UNSUPPORTED', `不支持的按键：${finalKey}`);
  if (parts.length >= 2 && finalKey === 'f4' && modifiers.includes('alt')) throw fail('TITLE_DENIED', 'alt+f4 会关闭窗口，已拒绝。');
  return combo;
}

// 元素 id（Snapshot 标注号）或坐标，二选一。
export function targetArgs({ label, x, y }) {
  if (label !== undefined && label !== null) return { label: Number(label) };
  if (Number.isFinite(x) && Number.isFinite(y)) return { loc: [Number(x), Number(y)] };
  throw fail('ELEMENT_NOT_FOUND', '需要元素标注 id（label）或坐标 x,y。', '先调用 computer_observe 获取元素标注。');
}

export function describeTarget({ label, x, y, elementName }) {
  if (elementName) return `${elementName}${label !== undefined ? `（标注 ${label}）` : ''}`;
  if (label !== undefined && label !== null) return `标注 ${label}`;
  return `坐标 (${x},${y})`;
}

export function typeArgs({ text, label, x, y, replace }) {
  const base = targetArgs({ label, x, y });
  return { text: String(text ?? ''), ...base, clear: replace === true, caret_position: 'end' };
}

// 滚动（§5.1）：目标可省略（在当前光标位置滚动）；direction 映射到驱动 Scroll 的 type/direction。
export function scrollArgs({ direction = 'down', times = 1, label, x, y }) {
  const modes = {
    up: ['vertical', 'up'], down: ['vertical', 'down'],
    left: ['horizontal', 'left'], right: ['horizontal', 'right'],
  };
  const mode = modes[String(direction ?? 'down').toLowerCase()];
  if (!mode) throw fail('INPUT_UNSUPPORTED', `不支持的滚动方向：${direction}`, '可用方向：up/down/left/right。');
  const wheelTimes = Number(times ?? 1);
  if (!Number.isInteger(wheelTimes) || wheelTimes < 1 || wheelTimes > 20) throw fail('INPUT_UNSUPPORTED', 'times 必须是 1..20 的整数。');
  const hasTarget = (label !== undefined && label !== null) || (Number.isFinite(x) && Number.isFinite(y));
  return { ...(hasTarget ? targetArgs({ label, x, y }) : {}), type: mode[0], direction: mode[1], wheel_times: wheelTimes };
}

// 拖拽（§5.1）：from/to 各支持元素标注或坐标。驱动 Move(drag=true) 是「从当前光标拖到目标」，
// 因此调用方需先 Move 到 from，再 Move(drag) 到 to（见 runtime #drag）。
export function dragArgs({ from, to }) {
  if (!from || typeof from !== 'object' || !to || typeof to !== 'object') {
    throw fail('ELEMENT_NOT_FOUND', '拖拽需要 from 与 to 两个目标。', '每个目标可用元素 id、标注号或坐标 x,y。');
  }
  return { from: targetArgs(from), to: targetArgs(to) };
}
