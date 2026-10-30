param([switch]$DryRun)
$ErrorActionPreference = 'Continue'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}

$Repo = Split-Path -Parent $PSScriptRoot
$Root = Split-Path -Parent $Repo
$script:failed = 0

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Test-Admin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

function Get-Procs {
  # 其它用户/受保护进程读不到 CommandLine；单个失败不能拖垮整段。
  try { return @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch { return @() }
}

function Stop-Tree([int]$procId, [string]$label) {
  if (-not $procId -or $procId -eq $PID) { return }
  if ($DryRun) {
    Say ("      [DryRun] 将结束 {0}（PID {1}）" -f $label, $procId) Yellow
    return
  }
  # 杀掉父进程后子进程往往已经一起消失，没必要再报一次"找不到进程"。
  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
    Say ("      {0}（PID {1}）已随父进程退出" -f $label, $procId) DarkGray
    return
  }
  $null = (& taskkill.exe /PID $procId /T /F 2>&1)
  $gone = -not (Get-Process -Id $procId -ErrorAction SilentlyContinue)
  if ($gone) {
    Say ("      已结束 {0}（PID {1}）" -f $label, $procId) DarkGray
    return
  }
  $script:failed++
  Say ("      [失败] {0}（PID {1}）：进程仍在运行（可能需要管理员权限）" -f $label, $procId) Red
}

function Stop-Where([string]$label, [scriptblock]$match) {
  $killed = 0
  foreach ($p in (Get-Procs)) {
    if (-not $p.CommandLine) { continue }
    if ($p.ProcessId -eq $PID) { continue }
    try {
      if (& $match $p) { Stop-Tree $p.ProcessId ("{0} " -f $label + $p.Name); $killed++ }
    } catch {}
  }
  if ($killed -eq 0) { Say ("      {0}：没有在运行" -f $label) DarkGray }
}

Say '============================================================' Cyan
Say '  QQ 一键关闭（qq-bridge + SnowLuma + WSL/TTS）' Cyan
Say '  DeepSeek Harness（含它的 MCP 工具进程）保持运行，不关。' DarkGray
Say '  浏览器里的控制台 / SnowLuma 网页保持打开，不关。' DarkGray
Say '============================================================' Cyan
Say ''
if (-not (Test-Admin)) {
  Say '[警告] 当前不是管理员：以管理员运行的桥接窗口会杀不掉（表现为"点了一点反应都没有"）。' Yellow
  Say '        请直接双击「一键关闭所有服务.bat」，它会自动请求管理员权限。' Yellow
  Say ''
}

# 判定规则集中放这里：关闭前逐个执行，关闭后再用同一份规则复查残留。
# 注意：**不含 DeepSeek Harness 和它的 MCP 工具进程** —— DSH 要一直开着。
$targets = @(
  @{ Label = '桥接守护'; Match = { param($p) $p.CommandLine -like '*desktop-dsh-supervisor.mjs*' } },
  @{ Label = '桥接主进程'; Match = { param($p) $p.Name -eq 'node.exe' -and $p.CommandLine -like '*bridge.js*' -and $p.CommandLine -notlike '*mcp-*' } },
  @{ Label = '桥接启动窗口'; Match = { param($p) $p.Name -eq 'cmd.exe' -and ($p.CommandLine -like '*start.bat*' -or $p.CommandLine -like '*一键启动QQ桥接.bat') -and $p.CommandLine -notlike '*restart.bat*' } },
  @{ Label = 'SnowLuma'; Match = { param($p) ($p.Name -eq 'node.exe' -and ($p.CommandLine -like '*SnowLuma\index.mjs*' -or $p.CommandLine -like '*SnowLuma\node.exe*')) -or ($p.Name -eq 'cmd.exe' -and $p.CommandLine -like '*launcher.bat*') } }
)

# [1/3] 桥接：先杀守护进程（否则它会拉起下一个），再杀 bridge 本体与守护它的 cmd 窗口
Say '[1/3] 关闭 qq-bridge…' Cyan
Stop-Where '桥接守护' $targets[0].Match
Stop-Where '桥接主进程' $targets[1].Match
Stop-Where '桥接启动窗口' $targets[2].Match

# [2/3] SnowLuma（node 本体 + 它的 launcher 窗口）
Say '[2/3] 关闭 SnowLuma…' Cyan
Stop-Where 'SnowLuma' $targets[3].Match

# [3/3] WSL / TTS：先收常驻会话，再停服务、关 VM（TTS 引擎与 sidecar 都在里面）
Say '[3/3] 关闭 WSL 与本地 TTS…' Cyan
$keeperPidFile = Join-Path $Repo 'state\wsl-keeper.pid'
$keeperPid = 0
try {
  if (Test-Path $keeperPidFile) {
    $keeperPid = [int]((Get-Content $keeperPidFile -Raw).Trim())
    $proc = Get-Process -Id $keeperPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'wsl') { Stop-Tree $keeperPid '常驻 WSL 会话' }
  }
} catch {}
if ($DryRun) {
  Say '      [DryRun] 将执行：systemctl stop audiocpp tts-sidecar' Yellow
  Say '      [DryRun] 将执行：wsl --shutdown（连同 TTS 引擎与 sidecar 一起关）' Yellow
  Say '      [DryRun] 将删除保活任务 WSL KeepAlive（如存在）' Yellow
} else {
  try {
    & wsl.exe -d Ubuntu-22.04 -u root -- systemctl stop audiocpp tts-sidecar 2>&1 | Out-Null
    Say '      已停止 audiocpp / tts-sidecar' DarkGray
  } catch {}
  try {
    & wsl.exe --shutdown 2>&1 | Out-Null
    Say '      已执行 wsl --shutdown（WSL 与其中的服务全部退出）' DarkGray
  } catch {}
  Remove-Item $keeperPidFile -Force -ErrorAction SilentlyContinue
  try { & schtasks.exe /delete /tn 'WSL KeepAlive' /f 2>&1 | Out-Null } catch {}
}

Say ''
if ($DryRun) {
  Say '（DryRun：只列出将要做的事，没有真正结束任何进程。）' Yellow
  exit 0
}

# 复查：按同一份规则再扫一遍，把"没关掉的"明确列出来（而不是静默失败）
Start-Sleep -Seconds 2
$left = @()
foreach ($t in $targets) {
  foreach ($p in (Get-Procs)) {
    if (-not $p.CommandLine) { continue }
    if ($p.ProcessId -eq $PID) { continue }
    try { if (& $t.Match $p) { $left += ("{0}（{1}，PID {2}）" -f $t.Label, $p.Name, $p.ProcessId) } } catch {}
  }
}
if ($left.Count -gt 0) {
  Say '[未关闭] 以下进程仍在运行：' Red
  $left | ForEach-Object { Say ("      {0}" -f $_) Red }
  if (-not (Test-Admin)) {
    Say '      多半是管理员权限问题：请双击「一键关闭所有服务.bat」（会自动提权）。' Yellow
  } else {
    Say '      已是管理员仍失败：可能是进程被保护或正被系统占用，重启电脑可彻底清理。' Yellow
  }
  exit 1
}

Say '全部关闭完成。下次用「一键启动QQ桥接.bat」重新拉起。' Green
