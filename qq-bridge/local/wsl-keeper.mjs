// 让 WSL 发行版常驻：开一个 detached 的 `wsl … sleep infinity` 会话。
//
// 为什么不用 PowerShell 的 Start-Process：控制台型进程会挂在一个窗台上，
// 启动它的父进程一退出（或任务计划结束时）就可能收到 CTRL_C 被掐掉
// （实测退出码 0xC000013A）。Node 的 detached:true + stdio:'ignore' 会以
// 独立进程组启动、不继承任何控制台，才能真正活到被显式关掉为止。
//
// 用法：node local\wsl-keeper.mjs [发行版名]
// 关闭：一键关闭所有服务.bat（读 state\wsl-keeper.pid 结束它）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const distro = String(process.argv[2] || 'Ubuntu-22.04').trim() || 'Ubuntu-22.04';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pidFile = path.join(repo, 'state', 'wsl-keeper.pid');

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

try {
  const old = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (alive(old)) {
    console.log(`KEEPER_EXISTS pid=${old}`);
    process.exit(0);
  }
} catch { /* 没有 pid 文件或已失效 */ }

const child = spawn('wsl.exe', ['-d', distro, '-u', 'root', '--', 'sleep', 'infinity'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true
});
child.unref();
fs.mkdirSync(path.dirname(pidFile), { recursive: true });
fs.writeFileSync(pidFile, String(child.pid));
console.log(`KEEPER_STARTED pid=${child.pid} distro=${distro}`);
