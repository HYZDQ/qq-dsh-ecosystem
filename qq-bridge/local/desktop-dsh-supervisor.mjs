// desktop-dsh-supervisor.mjs
// 让 qq-bridge 跟随「DeepSeek Harness 桌面版」使用：桌面版 DSH 每次启动都监听随机端口
// （--port 0），所以本脚本在启动桥接前自动发现当前端口、写回 config.json 的 dsh.baseUrl，
// 并在桌面版 DSH 重启（端口变化）时自动重启桥接。
//
// 用法：
//   node local/desktop-dsh-supervisor.mjs            启动（守护）
//   node local/desktop-dsh-supervisor.mjs --print-port  只打印发现的端口后退出（自检）
//   node local/desktop-dsh-supervisor.mjs --once     只同步端口后前台跑桥接，不监视 DSH 重启
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CONFIG = path.join(REPO, 'config.json');
const BRIDGE = path.join(REPO, 'src', 'bridge.js');
const POLL_MS = 5000;
const args = new Set(process.argv.slice(2));

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (msg) => console.log(`[${stamp()}] [supervisor] ${msg}`);

function run(cmd, argv) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, argv, { windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve({ code: -1, out }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function fingerprint(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(res.statusCode === 401 && /dsh web authentication required/i.test(body)));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function dshPids() {
  const r = await run('tasklist', ['/FO', 'CSV', '/NH']);
  const pids = new Set();
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && /DeepSeek Harness/i.test(m[1])) pids.add(Number(m[2]));
  }
  return pids;
}

async function dshPort() {
  const [{ out }, pids] = await Promise.all([
    run('netstat', ['-ano', '-p', 'tcp']),
    dshPids(),
  ]);
  const listeners = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\[?([0-9a-fA-F.:]+)\]?:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (!m) continue;
    const addr = m[1];
    if (!(addr === '127.0.0.1' || addr === '::1' || addr === '0.0.0.0' || addr === '::')) continue;
    listeners.push({ port: Number(m[2]), pid: Number(m[3]) });
  }
  const owned = listeners.filter((l) => pids.has(l.pid)).map((l) => l.port);
  if (owned.length === 1) return owned[0];
  const candidates = owned.length > 1 ? owned : [...new Set(listeners.map((l) => l.port))];
  const hits = await Promise.all(candidates.map(async (port) => ((await fingerprint(port)) ? port : 0)));
  const found = hits.filter(Boolean);
  if (found.length === 1) return found[0];
  return found.length ? Math.max(...found) : 0;
}

function syncConfig(port) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (error) {
    log(`无法读取 config.json：${error.message}`);
    return false;
  }
  const want = `http://127.0.0.1:${port}`;
  if (cfg.dsh?.baseUrl === want) return false;
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: want };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  log(`config.json dsh.baseUrl -> ${want}`);
  return true;
}

let child = null;
let stopping = false;
let intentionalStop = false;
let lastPort = 0;

function startBridge(port) {
  syncConfig(port);
  lastPort = port;
  log(`启动桥接（DSH http://127.0.0.1:${port}）…`);
  intentionalStop = false;
  child = spawn(process.execPath, [BRIDGE], { cwd: REPO, stdio: 'inherit', windowsHide: false });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || intentionalStop) return;
    if (code === 2) {
      log('桥接已在另一个窗口运行（退出码 2）。本守护退出。');
      process.exit(2);
    }
    log(`桥接退出（code=${code}${signal ? `, signal=${signal}` : ''}），5 秒后重启…`);
    setTimeout(async () => {
      if (stopping) return;
      const port = (await dshPort()) || lastPort;
      if (!stopping) startBridge(port);
    }, 5000);
  });
}

function stopBridge() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const target = child;
    target.once('exit', () => resolve());
    try { target.kill('SIGTERM'); } catch { resolve(); }
    setTimeout(() => { try { target.kill('SIGKILL'); } catch {} }, 8000);
  });
}

async function main() {
  if (args.has('--print-port')) {
    const port = await dshPort();
    console.log(port ? `DSH_PORT=${port}` : 'DSH_PORT=NOT_FOUND');
    process.exit(port ? 0 : 1);
  }
  log('查找 DeepSeek Harness 桌面版监听端口…');
  let port = 0;
  while (!port && !stopping) {
    port = await dshPort();
    if (!port) {
      log('未找到 DSH 桌面版端口（DSH 没在运行？），5 秒后重试…');
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  if (stopping) return;
  startBridge(port);

  if (!args.has('--once')) {
    setInterval(async () => {
      if (stopping) return;
      const now = await dshPort();
      if (!now || now === lastPort) return;
      log(`检测到 DSH 桌面版端口变化（${lastPort} -> ${now}），重启桥接以跟随新端口…`);
      intentionalStop = true;
      await stopBridge();
      if (!stopping) startBridge(now);
    }, POLL_MS);
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log('收到退出信号，停止桥接…');
    await stopBridge();
    process.exit(0);
  });
}

main().catch((error) => {
  log(`启动失败：${error?.stack ?? error}`);
  process.exit(1);
});
