// 事件桥（§6.3 接线）：跨进程事件收件箱。qq-bridge / 抖音侧 / 任何外部进程只要把事件落成
//   stateDir/computer/events/<type>.json   （type ∈ file | qq-message | douyin，内容为任意 JSON 载荷）
// 就会触发 runtime.notifyEvent(type, payload)——文件即协议，不需要 IPC/端口/跨进程对象。
// 语义：一次性收件箱（触发后删除）；同一事件文件名用时间戳区分（<type>.json 或 <type>-<ts>.json 均可）；
// 只读 events/ 目录内的 *.json，其他文件忽略；fs.watch 噪声（重复事件）由调度器的事件冷却兜底。
import fs from 'node:fs';
import path from 'node:path';

export const EVENTS_DIRNAME = 'events';
const EVENT_TYPES = new Set(['file', 'qq-message', 'douyin']);

export class EventBridge {
  constructor({ stateDir, onEvent, now = Date.now } = {}) {
    Object.assign(this, { stateDir, onEvent, now, dir: path.join(stateDir, EVENTS_DIRNAME), watcher: null });
  }

  static eventTypeOf(filename) {
    const base = path.basename(String(filename), '.json');
    if (EVENT_TYPES.has(base)) return base; // qq-message 等类型名本身含连字符，先整名匹配
    const stem = base.replace(/-\d+$/, ''); // <type>-<timestamp> 形式
    return EVENT_TYPES.has(stem) ? stem : null;
  }

  async #deliver(file) {
    const type = EventBridge.eventTypeOf(file);
    if (!type) return false;
    const full = path.join(this.dir, file);
    let raw = null;
    // 先读再删（同一同步段完成）：fs.watch 对一次写入常发 rename+change 两个事件，
    // 第二次进来读不到文件即视为已消费，不再触发（一次性收件箱语义）。
    try { raw = fs.readFileSync(full, 'utf8'); fs.rmSync(full, { force: true }); } catch { return false; }
    let payload = {};
    try { payload = JSON.parse(raw); } catch { payload = {}; } // 载荷损坏按空载荷触发（事件本身仍有效）
    await this.onEvent?.(type, payload);
    return true;
  }

  // 启动即先消费积压（离线期间落下的事件），再进入 watch。
  async drain() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return 0; }
    let count = 0;
    for (const file of files.sort()) {
      try { if (await this.#deliver(file)) count += 1; } catch { /* 单个事件失败不阻断 */ }
    }
    return count;
  }

  async start() {
    if (this.watcher) return this;
    fs.mkdirSync(this.dir, { recursive: true });
    await this.drain();
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_event, file) => {
        if (!file || !String(file).endsWith('.json')) return;
        this.#deliver(String(file)).catch(() => {});
      });
      this.watcher.unref?.();
    } catch {
      this.watcher = null; // watch 不可用时退化为手动 drain（外部仍可触发轮询）
    }
    return this;
  }

  stop() {
    try { this.watcher?.close(); } catch { /* 已关闭 */ }
    this.watcher = null;
  }
}
