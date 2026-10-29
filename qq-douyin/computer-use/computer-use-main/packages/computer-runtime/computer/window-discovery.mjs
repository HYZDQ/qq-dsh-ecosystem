// 窗口发现三源兜底（§4.3）：现网证实 windows-mcp Snapshot 的 Opened Windows 会系统性漏行
// （2026-10-26 实测：WPS 窗口出现在 Focused Window，却不在 Opened Windows 里），
// 因此窗口清单合并三源：① Focused Window ② Opened Windows ③ 系统进程表（tasklist /v）真实窗口标题。
// 进程表是只读系统查询，在 Node 侧执行，不经过驱动（Shell/Process 类驱动工具属 L3 禁用，不可达）。
import { execFileSync } from 'node:child_process';

// tasklist /v 会把消息窗/占位窗一并列出，它们不是可操作的界面窗口，按标题剔除。
const NOISE_TITLES = new Set([
  'n/a', 'olemainthreadwndname', 'olechannelwnd', 'task host window',
  'dwm notification window', 'windows push notifications platform', 'windows 输入体验', '新通知',
]);
const NOISE_PATTERNS = [
  /^gdi\+ window/i, // GDI+ 消息窗
  /^\{[0-9a-f-]{8,}\}$/i, // GUID 占位窗
  /^wps cloud service/i, // WPS 后台辅助窗，非操作对象
];

function isNoise(title) {
  const key = String(title ?? '').trim().toLowerCase();
  return !key || NOISE_TITLES.has(key) || NOISE_PATTERNS.some((pattern) => pattern.test(title));
}

// tasklist /v /fo csv：9 列，最后一列是 Window Title。标题含逗号时整列带引号，按 '","' 切分即可。
export function parseTasklistCsv(csv) {
  const rows = [];
  for (const line of String(csv ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split('","').map((part) => part.replace(/^"|"$/g, ''));
    if (cols.length < 9) continue;
    const [image, pid] = cols;
    const title = cols[8];
    if (image === 'Image Name') continue;
    if (isNoise(title)) continue;
    rows.push({ image, pid: Number(pid) || pid, title: String(title).trim() });
  }
  return rows;
}

// 进程表探测失败不阻断 UIA 主路径（降级为两源）。
// 注意（2026-10-26 现网踩坑）：tasklist 按控制台代码页（中文 Windows=GBK）输出，直接按 UTF-8
// 解码会把中文解成「合法但错误」的字符（GBK 字节恰好构成合法 UTF-8 序列，无替换符可查），
// 标题正则全部失配——必须先 chcp 65001 再取。
export function probeProcessTitles({ exec = execFileSync } = {}) {
  try {
    const csv = exec('cmd', ['/c', 'chcp 65001 >nul & tasklist /v /fo csv'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 8000,
    });
    return parseTasklistCsv(csv);
  } catch {
    return [];
  }
}

// 按标题去重合并：焦点窗口优先（带 handle，且它正是常被漏掉的那个），再 UIA 列表，最后进程表补漏。
export function mergeWindows({ focus = null, listed = [], processes = [] }) {
  const byTitle = new Map();
  const push = (win) => {
    if (!win?.title || byTitle.has(win.title)) return;
    byTitle.set(win.title, win);
  };
  if (focus?.title) {
    push({
      app: focus.title, title: focus.title, handle: focus.handle ?? null,
      status: focus.status, width: focus.width, height: focus.height,
      focused: true, source: 'uia-focus',
    });
  }
  for (const item of listed) push({ ...item, source: 'uia-list' });
  for (const item of processes) {
    push({ app: item.title, title: item.title, handle: null, pid: item.pid, process: item.image, focused: false, source: 'process' });
  }
  return [...byTitle.values()];
}
