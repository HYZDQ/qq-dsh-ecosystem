param([switch]$DryRun)
$ErrorActionPreference = 'Continue'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {}

$Repo = Split-Path -Parent $PSScriptRoot
$Root = Split-Path -Parent $Repo
$Fail = $false

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }

function Test-ListenPort([int]$port) {
  try {
    $hit = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    return [bool]$hit
  } catch {
    $line = (& netstat -ano -p tcp | Select-String -SimpleMatch ":$port " | Select-Object -First 1)
    return [bool]$line
  }
}

Say '============================================================' Cyan
Say '  QQ 一键启动（DeepSeek Harness 桌面版 + SnowLuma + 本地 TTS + qq-bridge）' Cyan
Say '============================================================' Cyan
Say ''

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  Say '[错误] 没有找到 node.exe（需要 Node.js >= 22.13）。' Red
  Say '       安装后重新双击本文件。' Red
  Read-Host '按回车退出'
  exit 1
}
$nodeVersion = (& node --version).Trim()
Say ("Node.js: {0}" -f $nodeVersion)

$configPath = Join-Path $Repo 'config.json'
if (-not (Test-Path $configPath)) {
  Say '[错误] 缺少 qq-bridge\config.json（应先复制 config.example.json 并填写）。' Red
  Read-Host '按回车退出'
  exit 1
}

$httpPort = 3000
$wsPort = 3001
try {
  $cfgText = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
  $cfg = $cfgText | ConvertFrom-Json
  if ($cfg.snowluma.httpUrl) { $httpPort = ([uri]$cfg.snowluma.httpUrl).Port }
  if ($cfg.snowluma.wsUrl) { $wsPort = ([uri]$cfg.snowluma.wsUrl).Port }
} catch {
  Say '[警告] config.json 解析失败，端口用默认值 3000/3001。' Yellow
}

$dshProcs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($dshProcs.Count -gt 0) {
  Say ("[1/4] DeepSeek Harness 桌面版已在运行（PID {0}）" -f $dshProcs[0].Id) Green
} else {
  $dshExe = 'D:\DeepSeek Harness\DeepSeek Harness.exe'
  if (Test-Path $dshExe) {
    if ($DryRun) {
      Say "[1/4] [DryRun] 将启动 DSH 桌面版：$dshExe" Yellow
    } else {
      Say '[1/4] 未检测到 DSH 桌面版，正在启动…' Yellow
      Start-Process -FilePath $dshExe
      Start-Sleep -Seconds 3
    }
  } else {
    Say ("[1/4] [警告] 未找到 {0}，请手动启动 DSH 桌面版。" -f $dshExe) Yellow
    $Fail = $true
  }
}

$slDir = Join-Path $Root 'SnowLuma'
$slLauncher = Join-Path $slDir 'launcher.bat'
$slUp = (Test-ListenPort $httpPort) -or (Test-ListenPort $wsPort)
if ($slUp) {
  Say ("[2/4] SnowLuma 已在线（OneBot 端口 {0}/{1} 在监听）" -f $httpPort, $wsPort) Green
} elseif (Test-Path $slLauncher) {
  if ($DryRun) {
    Say ("[2/4] [DryRun] 将启动 SnowLuma：{0}，并等待端口 {1}/{2}" -f $slLauncher, $httpPort, $wsPort) Yellow
    Say '[DryRun] 将先清理残留的 snowluma-update-* 暂存目录（避免 updater 启动即 EPERM）。' Yellow
  } else {
    Say ("[2/4] 未检测到 SnowLuma（端口 {0}/{1} 未监听），正在启动 launcher.bat…" -f $httpPort, $wsPort) Yellow
    Say '      这是你本机已安装的 SnowLuma；桥接程序本身不代启、不代装（遵守其 EULA）。' DarkGray

    # SnowLuma 每次启动时 updater 都会 rmdir 上一次留下的 snowluma-update-* 暂存目录；
    # 该目录被残留进程/杀软锁住时会 EPERM，导致整个启动失败。先清掉（删不掉就改名避开）。
    $staleDirs = @()
    $staleDirs += @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Directory -Filter 'snowluma-update-*' -Force -ErrorAction SilentlyContinue)
    $localUpdate = Join-Path $slDir 'tmp\update'
    if (Test-Path -LiteralPath $localUpdate) { $staleDirs += @(Get-Item -LiteralPath $localUpdate -Force) }
    foreach ($item in $staleDirs) {
      $done = $false
      for ($try = 1; $try -le 3 -and -not $done; $try++) {
        try {
          Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
          Say ("      已清理残留更新目录：{0}" -f $item.FullName) DarkGray
          $done = $true
        } catch {
          if ($try -lt 3) { Start-Sleep -Seconds 1 }
        }
      }
      if (-not $done) {
        try {
          $newName = (Split-Path -Leaf $item.FullName) + '-stale-' + (Get-Date -Format 'yyyyMMddHHmmss')
          Rename-Item -LiteralPath $item.FullName -NewName $newName -ErrorAction Stop
          Say ("      残留目录删不掉，已改名避开：{0}" -f $item.FullName) Yellow
        } catch {
          Say ("      [警告] 无法清理 {0}：{1}" -f $item.FullName, $_.Exception.Message) Yellow
          Say '              请重启电脑后再启动（该目录被占用）。' Yellow
        }
      }
    }

    # 去掉从 GitHub zip 解压带来的“来自 Internet”标记：否则 ShellExecute 会弹
    # “打开文件-安全警告 / 未知发布者”，整个一键启动就卡在那个人工确认上。
    try {
      if (Get-Item -LiteralPath $slLauncher -Stream Zone.Identifier -ErrorAction SilentlyContinue) {
        Unblock-File -LiteralPath $slLauncher -ErrorAction SilentlyContinue
        Say '      已解除 launcher.bat 的 Internet 锁定标记。' DarkGray
      }
    } catch {}
    # 用 cmd.exe 调起 launcher.bat（不经过 ShellExecute，不会再触发文件安全警告）。
    # -WindowStyle Hidden 让它拥有**自己的隐藏控制台**：这样后面关掉启动器窗口时，
    # Windows 不会把 CTRL_CLOSE 送到 SnowLuma，它也就不必跟着一起死。
    # （2026-10-30 实测：SnowLuma 之前是共享启动器控制台的，关窗口 = 它无声断流，桥接就报 1006。）
    Start-Process -FilePath $env:ComSpec -ArgumentList '/c', ('"{0}"' -f $slLauncher) -WorkingDirectory $slDir -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(90)
    $ticks = 0
    $integrityWarned = $false
    while ((Get-Date) -lt $deadline) {
      if (Test-ListenPort $httpPort) { break }
      Start-Sleep -Seconds 2
      $ticks++
      if ($ticks % 5 -eq 0) { Write-Host '.' -NoNewline }
      if ($ticks % 3 -eq 0) {
        try {
          $logFile = Get-ChildItem (Join-Path $slDir 'logs') -Filter 'snowluma-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
          if ($logFile) {
            $tail = @(Get-Content $logFile.FullName -Encoding UTF8 -Tail 40 -ErrorAction SilentlyContinue)
            if ($tail -match 'Node integrity:.*Low') {
              Write-Host ''
              Say '      [警告] SnowLuma 以“低完整性（Low）”运行，无法注入 QQ，OneBot 端口不会就绪。' Yellow
              Say '              修复（管理员 PowerShell 执行后重启 SnowLuma）：' Yellow
              Say '              icacls "D:\github\SnowLuma" /setintegritylevel (OI)(CI)Medium /T /C' Yellow
              $integrityWarned = $true
              break
            }
          }
        } catch {}
      }
    }
    Write-Host ''
    if (Test-ListenPort $httpPort) {
      Say ("      SnowLuma OneBot HTTP 端口 {0} 已就绪。" -f $httpPort) Green
    } elseif (-not $integrityWarned) {
      Say ("      [警告] 等了 90 秒仍没检测到端口 {0}。请检查 SnowLuma 是否已登录 QQ、" -f $httpPort) Yellow
      Say '              WebUI 里是否开启了 OneBot HTTP/WebSocket 服务；若 WebUI 提示“Node 完整性过低”，' Yellow
      Say '              按上面 icacls 命令修复后重启 SnowLuma。桥接会先启动并在后台自动重连。' Yellow
    }
  }
} else {
  Say ("[2/4] [警告] 未找到 {0}，请手动启动 SnowLuma。" -f $slLauncher) Yellow
  $Fail = $true
}
Say '      提示：SnowLuma 首次使用需要在其 WebUI 完成 QQ 登录；端口见 qq-bridge\config.json。' DarkGray

# ── 自动打开两个网页：控制台（URL 里带令牌，不用手输）+ SnowLuma WebUI ──
$consoleToken = ''
try { $consoleToken = [string]$cfg.consoleToken } catch {}
if (-not $consoleToken) {
  try { $consoleToken = (Get-Content (Join-Path $Repo 'state\console-token') -Raw -ErrorAction Stop).Trim() } catch {}
}
$consolePort = 3100
try { if ($cfg.consolePort) { $consolePort = [int]$cfg.consolePort } } catch {}
$snowWebPort = 5099
try {
  $rtPath = Join-Path $slDir 'config\runtime.json'
  if (Test-Path -LiteralPath $rtPath) {
    $rt = ([System.IO.File]::ReadAllText($rtPath, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
    if ($rt.webuiPort) { $snowWebPort = [int]$rt.webuiPort }
  }
} catch {}
$snowUrl = 'http://127.0.0.1:' + $snowWebPort
if (-not $DryRun) {
  try {
    $openArgs = @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', (Join-Path $PSScriptRoot 'open-consoles.ps1'),
      '-ConsolePort', "$consolePort", '-Token', $consoleToken, '-SnowUrl', $snowUrl
    )
    Start-Process -FilePath 'powershell.exe' -ArgumentList $openArgs -WindowStyle Hidden
    Say ("      桥接就绪后会自动打开：控制台（已带令牌）与 SnowLuma 网页 {0}" -f $snowUrl) DarkGray
  } catch {
    Say ("      [警告] 自动打开网页失败：{0}" -f $_.Exception.Message) Yellow
  }
} else {
  Say ('[DryRun] 将打开：http://127.0.0.1:{0}/?token=*** 与 {1}' -f $consolePort, $snowUrl) Yellow
}

# ── [3/4] 本地语音合成（TTS）：WSL 里的 audiocpp 引擎 + sidecar ────────────────
# 只在 config.json 的 tts.enabled=true 时才启动：关掉 TTS 的部署完全不受影响。
# 失败**不**置 $Fail —— 语音是可选能力，引擎没起来时桥接会自动降级成文字回复。
$ttsPort = 18100
try { if ($cfg.tts.baseUrl) { $ttsPort = ([uri]$cfg.tts.baseUrl).Port } } catch {}
$ttsEnabled = $false
try { $ttsEnabled = ($cfg.tts -and $cfg.tts.enabled -eq $true) } catch {}
$ttsDistro = 'Ubuntu-22.04'

if (-not $ttsEnabled) {
  Say '[3/4] 本地语音合成未启用（tts.enabled=false），跳过。' Green
} elseif ($DryRun) {
  Say ("[3/4] [DryRun] 将启动 WSL 发行版 {0} 里的 audiocpp + tts-sidecar，并等待端口 {1} 就绪。" -f $ttsDistro, $ttsPort) Yellow
} else {
  # 先把服务拉起来（顺带唤醒 WSL VM；服务是 systemd enable 过的，重复 start 无副作用）。
  $wslOut = ''
  try {
    $wslOut = (& wsl.exe -d $ttsDistro -u root -- systemctl start audiocpp tts-sidecar 2>&1 | Out-String).Trim()
    $wslCode = $LASTEXITCODE
  } catch {
    $wslCode = 1
    $wslOut = $_.Exception.Message
  }
  if ($wslCode -ne 0) {
    Say ("[3/4] [警告] 启动 WSL 服务失败（退出码 {0}）：{1}" -f $wslCode, $wslOut) Yellow
    Say '      语音功能会降级为文字回复；排查：wsl -d Ubuntu-22.04 -u root -- journalctl -u tts-sidecar -n 30' Yellow
  } else {
    # 常驻：用一个 detached 的 WSL 会话把 VM 顶住（模型加载后就能一直留在内存里）。
    # 旧方案是"每 5 分钟唤醒一次"，实测 VM 一空闲就关、服务跟着退出、模型白加载。
    # 注意不能用 Start-Process 直接挂 wsl：控制台型进程会被掐掉（0xC000013A），
    # 所以统一走 local\wsl-keeper.mjs（Node detached spawn，不继承控制台）。
    $keeperPidFile = Join-Path $Repo 'state\wsl-keeper.pid'
    $keeperOut = ''
    try {
      $keeperOut = (& node (Join-Path $PSScriptRoot 'wsl-keeper.mjs') $ttsDistro 2>&1 | Out-String).Trim()
      if ($keeperOut -match 'KEEPER_EXISTS pid=(\d+)') {
        Say ("      常驻会话已在运行（PID {0}），TTS 会一直留在内存里。" -f $matches[1]) DarkGray
      } elseif ($keeperOut -match 'KEEPER_STARTED pid=(\d+)') {
        Say ("      已启动常驻会话（PID {0}）：合成过一次后模型会一直驻留。" -f $matches[1]) DarkGray
      } else {
        Say ("      [警告] 常驻会话输出异常：{0}（WSL 可能仍会被闲置关停）" -f $keeperOut) Yellow
      }
    } catch {
      Say ("      [警告] 常驻会话启动失败：{0}（WSL 仍会被闲置关停）" -f $_.Exception.Message) Yellow
    }
    # 旧保活任务（每 5 分钟唤醒）已不需要，存在就删掉，避免它和常驻会话重复拉扯。
    try {
      & schtasks.exe /query /tn 'WSL KeepAlive' 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        & schtasks.exe /delete /tn 'WSL KeepAlive' /f 2>&1 | Out-Null
        Say '      已移除旧的"每 5 分钟唤醒"任务（改由常驻会话维持）。' DarkGray
      }
    } catch {}

    # 等 sidecar 的 /health 回 ready（引擎是懒加载，这里只等它"能应答"，不预热模型）。
    $deadline = (Get-Date).AddSeconds(40)
    $ttsReady = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $ttsPort) -TimeoutSec 5 -UseBasicParsing
        if ($r.ready -eq $true) { $ttsReady = $true; break }
      } catch {}
      Write-Host '.' -NoNewline
      Start-Sleep -Seconds 2
    }
    if ($ttsReady) {
      Write-Host ''
      Say ("[3/4] 本地语音合成已就绪（引擎 + sidecar 在线，端口 {0}）。" -f $ttsPort) Green
      Say '      首次合成要加载模型（CPU 约 30 秒），之后每句十几秒。' DarkGray
    } else {
      Write-Host ''
      Say ("[3/4] [警告] 等了 40 秒 sidecar 仍未就绪（端口 {0}）。" -f $ttsPort) Yellow
      Say '      桥接仍会正常启动，语音失败会自动改文字；排查：' Yellow
      Say ('      wsl -d {0} -u root -- systemctl status audiocpp tts-sidecar --no-pager' -f $ttsDistro) Yellow
    }
  }
}

Say '[4/4] 启动 qq-bridge（自动探测 DSH 端口；DSH 重启换端口会自动跟随）…' Cyan
if ($DryRun) {
  Say '[DryRun] 将执行：node scripts\harden-state-acl.mjs --quiet' Yellow
  Say '[DryRun] 将执行：node local\desktop-dsh-supervisor.mjs' Yellow
  Say '[DryRun] 结束（未做任何实际启动）。' Yellow
  exit 0
}
Push-Location $Repo
try {
  & node 'scripts\harden-state-acl.mjs' --quiet
  & node 'local\desktop-dsh-supervisor.mjs'
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
Say ''
Say ("桥接已退出（code={0}）。日志：state\bridge.log；控制台：http://127.0.0.1:3100" -f $code) Gray
if ($Fail) { Say '（有前置项未就绪，请按上面的警告处理。）' Yellow }
