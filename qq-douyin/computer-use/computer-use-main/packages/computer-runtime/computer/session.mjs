// 会话锁定检测（§4.3 / §6.4）：锁屏、UAC/安全桌面、远程断开时标记 SESSION_LOCKED——
// 写操作拦下、任务暂停，绝不猜测继续。判定来源：系统进程表出现锁屏/安全桌面宿主进程
// （LockApp.exe=Win11 锁屏，LogonUI.exe=安全桌面/UAC/登录）。
// 检测失败按「已锁定」处理（fail-closed，宁停不猜）；进程名为 ASCII，不受 tasklist 代码页影响。
import { execFileSync } from 'node:child_process';

const LOCK_IMAGES = new Set(['lockapp.exe', 'logonui.exe']);

export function parseTasklistImages(csv) {
  const images = new Set();
  for (const line of String(csv ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const image = trimmed.split('","')[0].replace(/^"|"$/g, '').trim().toLowerCase();
    if (image && image !== 'image name') images.add(image);
  }
  return images;
}

export function sessionLocked({ exec = execFileSync } = {}) {
  try {
    const csv = exec('tasklist', ['/fo', 'csv'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 5000,
    });
    const images = parseTasklistImages(csv);
    for (const name of LOCK_IMAGES) if (images.has(name)) return true;
    return false;
  } catch {
    return true;
  }
}
