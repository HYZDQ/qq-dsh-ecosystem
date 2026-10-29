// 视觉兜底闭环（§4.1 / §14 P3，dsh-computer-use 模式）：截图 → 识图认图标 → 坐标点击 → 再截图确认。
// 独立虚拟光标语义：识图定位是纯像素计算，绝不移动真实指针；只有最终提交动作（点击/输入）碰输入设备。
// 速度契约 §1.6：单次闭环 ≤15s；连续两次定位失败即报人工；只在结构化失败/无名目标时由调用方启用。
// 视觉模型接入点：locate({ frame, target }) → { x, y, gone? }（gone=true 表示目标已消失，视为有效确认）。
import { execFileSync } from 'node:child_process';
import { fail } from './policy.mjs';

const DEFAULT_BUDGET_MS = 15_000;

// 截图双通道：优先驱动 Screenshot，超时/无帧走 PowerShell CopyFromScreen 兜底
// （现网踩坑：windows-mcp 的 Screenshot/Snapshot(use_vision) 在本机挂起 >70s）。
export async function captureFrame({ driver, capture, timeoutMs = 4_000 } = {}) {
  if (capture) return capture();
  if (driver) {
    try {
      const result = await driver.callTool('Screenshot', { use_annotation: false }, { timeoutMs });
      if (result?.frames?.length) return result.frames[0];
    } catch { /* 走兜底 */ }
  }
  return captureViaPowerShell();
}

export function captureViaPowerShell({ exec = execFileSync } = {}) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)',
    '$ms = New-Object System.IO.MemoryStream',
    '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($ms.ToArray())',
  ].join('\n');
  try {
    const out = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 8_000,
    });
    const data = String(out).trim();
    if (!data) throw new Error('截图输出为空');
    return { mimeType: 'image/png', data };
  } catch (error) {
    throw fail('ACTION_TIMEOUT', `截图失败：${error?.message ?? error}`);
  }
}

export class VisionFallback {
  constructor({ locate, commit, capture, driver, now = Date.now, budgetMs = DEFAULT_BUDGET_MS } = {}) {
    Object.assign(this, { locate, commit, capture, driver, now, budgetMs });
  }

  #budget(started, label) {
    if (this.now() - started > this.budgetMs) throw fail('ACTION_TIMEOUT', `视觉闭环超预算（>${this.budgetMs}ms，§1.6）：${label}`);
  }

  // 一次完整闭环：截图 → 定位（最多两次）→ 提交 → 再截图确认。
  async cycle({ target, commit } = {}) {
    const label = String(target ?? '').trim();
    if (!label) throw fail('ELEMENT_NOT_FOUND', '视觉兜底需要 target 描述。');
    if (typeof this.locate !== 'function') {
      throw fail('VISION_UNAVAILABLE', '未接入视觉定位提供者（vision.locate）。', '在宿主接线视觉模型后启用（§4.1）。');
    }
    const doCommit = commit ?? this.commit;
    if (typeof doCommit !== 'function') throw fail('VISION_UNAVAILABLE', '视觉闭环缺提交动作（commit）。');
    const started = this.now();
    const grab = () => captureFrame({ driver: this.driver, capture: this.capture });

    // ① 截图（不动真实指针）
    const before = await grab();
    this.#budget(started, '截图');

    // ② 识图定位（虚拟光标：纯像素计算）—— 连续两次定位失败即报人工（§4.1）
    let spot = await this.locate({ frame: before, target: label });
    if (!spot?.x && !Number.isFinite(spot?.x)) {
      const retry = await grab();
      this.#budget(started, '重截');
      spot = await this.locate({ frame: retry, target: label });
    }
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) {
      throw fail('ELEMENT_NOT_FOUND', `视觉定位连续两次未找到「${label}」，已报人工接管（§4.1）。`, '人工确认目标位置，或改用坐标/元素 id。');
    }
    this.#budget(started, '定位');

    // ③ 提交（唯一真实指针动作）
    await doCommit(spot.x, spot.y);
    this.#budget(started, '提交');

    // ④ 再截图确认：目标仍在原位附近，或 locate 报 gone（目标消失也算有效确认，如点击关闭）
    const after = await grab();
    this.#budget(started, '复核截图');
    let verified = false;
    try {
      const again = await this.locate({ frame: after, target: label });
      verified = Boolean(again?.gone === true
        || (Number.isFinite(again?.x) && Math.abs(again.x - spot.x) <= 120 && Math.abs(again.y - spot.y) <= 120));
    } catch {
      verified = false;
    }
    return {
      ok: true,
      perceptionPath: 'vision',
      target: label,
      x: spot.x,
      y: spot.y,
      verified,
      frames: [before, after].filter(Boolean),
    };
  }
}
