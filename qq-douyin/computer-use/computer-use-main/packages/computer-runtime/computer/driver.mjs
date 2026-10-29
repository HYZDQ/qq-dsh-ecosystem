// windows-mcp 驱动（P0）：MCP stdio JSON-RPC 客户端。
// 附录 B 要求：参数以 listTools() 的 schema 为准；高危工具不得被触达（白名单调用）；
// Electron 宿主不继承 PATH，command 必须能解析到绝对路径；空闲 10 分钟回收，同会话最多自动重启 2 次。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ALLOWED_DRIVER_TOOLS, FORBIDDEN_DRIVER_TOOLS, fail } from './policy.mjs';

const DRIVER_SPEC = ['windows-mcp==0.7.1'];
// 桌面窗口多时 Snapshot 的 UIA 遍历可超 15 秒，单步超时放宽到 30 秒（§12 ACTION_TIMEOUT）。
const CALL_TIMEOUT_MS = 30_000;
const IDLE_RECYCLE_MS = 10 * 60_000;

export function resolveUvx(env = process.env) {
  if (env.DOUYIN_COMPUTER_UVX) return env.DOUYIN_COMPUTER_UVX;
  const search = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of search.split(path.delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const candidate = path.join(trimmed, 'uvx.exe');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 继续找 */ }
  }
  const fallback = 'C:\\Program Files\\Python311\\Scripts\\uvx.exe';
  try { if (fs.statSync(fallback).isFile()) return fallback; } catch { /* 下面统一报错 */ }
  throw fail('UV_NOT_FOUND', '未找到 uvx.exe，无法启动 windows-mcp 驱动。', '安装 uv（winget install astral-sh.uv）或在 DOUYIN_COMPUTER_UVX 配置绝对路径。');
}

// 契约（§8.4 / §13）：映射层只允许白名单驱动工具，注册表/进程/Shell/文件系统永不可达。
export function assertSafeToolset(names = ALLOWED_DRIVER_TOOLS) {
  const leaked = names.filter((name) => FORBIDDEN_DRIVER_TOOLS.includes(name));
  if (leaked.length) throw fail('TOOLSET_LEAK', `高危驱动工具泄漏到映射层：${leaked.join(',')}`);
  return true;
}

export class WindowsMcpDriver {
  constructor({ stateDir, command, args = DRIVER_SPEC, env = process.env, spawnImpl = spawn, now = Date.now,
    idleMs = IDLE_RECYCLE_MS, maxRestarts = 2, callTimeoutMs = CALL_TIMEOUT_MS } = {}) {
    Object.assign(this, { stateDir, command: command ?? null, args, env, spawnImpl, now, idleMs, maxRestarts, callTimeoutMs });
    assertSafeToolset();
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.restarts = 0;
    this.serverInfo = null;
    this.idleTimer = null;
    this.lastUse = 0;
    this.stderrTail = [];
    this.toolsCache = null;
  }

  #recordState(status) {
    if (!this.stateDir) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(path.join(this.stateDir, 'drivers.json'), JSON.stringify({
        spec: DRIVER_SPEC[0], command: this.command, pid: this.child?.pid ?? null, status,
        server: this.serverInfo, restarts: this.restarts, at: this.now(),
      }, null, 2));
    } catch { /* 状态文件失败不阻断驱动 */ }
  }

  #onLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed.startsWith('{')) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(fail('MCP_START_FAILED', `驱动返回错误：${msg.error.message ?? JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  }

  #send(method, params, timeoutMs = this.callTimeoutMs) {
    if (!this.child || this.child.exitCode !== null) return Promise.reject(fail('MCP_START_FAILED', '驱动进程未运行。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail('ACTION_TIMEOUT', `驱动调用超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  #notify(method, params) {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async ensureSession() {
    if (this.child && this.child.exitCode === null) return this;
    if (this.restarts >= this.maxRestarts) throw fail('MCP_START_FAILED', '驱动反复启动失败，已停止自动重启。', '检查 uv 与 windows-mcp 安装后重启 DSH。');
    this.restarts += 1;
    const command = this.command ?? (this.command = resolveUvx(this.env));
    const child = this.spawnImpl(command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...this.env, ANONYMIZED_TELEMETRY: 'false' },
    });
    this.child = child;
    child.stdout.on('data', (chunk) => { for (const line of String(chunk).split('\n')) this.#onLine(line); });
    child.stderr.on('data', (chunk) => {
      this.stderrTail.push(String(chunk).trim());
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    child.on('exit', () => {
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(fail('MCP_START_FAILED', '驱动进程提前退出。')); }
      this.pending.clear();
      if (this.child === child) this.child = null;
    });
    try {
      const init = await this.#send('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'dsh-computer', version: '1.0.0' },
      }, 60_000);
      this.serverInfo = init?.serverInfo ?? null;
      this.#notify('notifications/initialized', {});
      this.toolsCache = (await this.#send('tools/list', {}, 60_000))?.tools ?? [];
      this.#recordState('running');
    } catch (error) {
      this.#recordState('failed');
      try { child.kill(); } catch { /* 已退出 */ }
      this.child = null;
      throw error;
    }
    this.#touch();
    return this;
  }

  #touch() {
    this.lastUse = this.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close().catch(() => {}), this.idleMs);
    this.idleTimer.unref?.();
  }

  async listTools() {
    await this.ensureSession();
    return this.toolsCache.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  }

  // 只允许白名单工具；映射层之外的名字直接拒绝（TOOLSET_LEAK 防线）。
  async callTool(name, args = {}, { signal, timeoutMs } = {}) {
    if (!ALLOWED_DRIVER_TOOLS.includes(name)) throw fail('TOOLSET_LEAK', `驱动工具 ${name} 不在白名单内，已拒绝调用。`);
    await this.ensureSession();
    signal?.throwIfAborted();
    this.#touch();
    const task = this.#send('tools/call', { name, arguments: args }, timeoutMs);
    const abort = () => task.catch(() => {});
    signal?.addEventListener?.('abort', abort, { once: true });
    let result;
    try { result = await task; } finally { signal?.removeEventListener?.('abort', abort); }
    this.#touch();
    return normalizeResult(result);
  }

  async close() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const child = this.child;
    this.child = null;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(fail('MCP_START_FAILED', '驱动已关闭。')); }
    this.pending.clear();
    if (child && child.exitCode === null) {
      try { child.kill(); } catch { /* 已退出 */ }
      this.#recordState('stopped');
    }
  }
}

// windows-mcp 文本块常是 JSON 数组包裹的字符串；图片块转成 {mimeType, data} 供 attachment 投影。
export function normalizeResult(result) {
  const frames = [];
  const texts = [];
  for (const block of result?.content ?? []) {
    if (block?.type === 'text') {
      let text = String(block.text ?? '');
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) text = parsed.map((item) => String(item)).join('\n');
        else if (typeof parsed === 'string') text = parsed;
      } catch { /* 原样保留 */ }
      texts.push(text);
    } else if (block?.type === 'image' && typeof block.data === 'string') {
      frames.push({ mimeType: block.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png', data: block.data });
    }
  }
  return { ok: result?.isError !== true, text: texts.join('\n'), frames, raw: result };
}
