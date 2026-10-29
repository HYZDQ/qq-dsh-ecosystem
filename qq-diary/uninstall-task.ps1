<#
.SYNOPSIS
    删除 qq-diary 的 Windows 计划任务；可选结束正在运行的常驻 daemon 进程。

.DESCRIPTION
    兼容 Windows PowerShell 5.1（powershell.exe）与 PowerShell 7（pwsh）。
    - 用 schtasks.exe /Delete /TN <name> /F 删除任务，删除后用 /Query 复查确认。
    - 任务不存在时给出友好提示（退出码 0，不当作失败）。
    - -AlsoStopDaemon：结束由计划任务/手动启动的 qq-diary 常驻 node 进程，并清理 state\daemon.pid。
      安全策略：
        * 优先读 state\daemon.pid，只有当该 PID 存在且命令行确实包含 index.js 时才结束；
        * 再扫描 node.exe 命令行，只结束命令行里带本项目完整 index.js 路径的进程；
        * 只写 "node index.js"（不含项目路径、且没有锁文件可核对）的进程不自动杀，避免误杀别的项目。
        * 不结束 --once 单次任务进程（可能正在写日记）。
        * 只有被结束进程的 PID 与 daemon.pid 中的 PID 一致时，才删除 daemon.pid。

.PARAMETER TaskName
    计划任务名，默认 QQDiary。测试时用临时名字。

.PARAMETER AlsoStopDaemon
    同时结束正在运行的 qq-diary 常驻 node 进程，并清理 state\daemon.pid（仅当 PID 与锁文件一致）。

.PARAMETER WhatIf
    只显示将要做的事，不真正删除/结束进程。

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall-task.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\uninstall-task.ps1 -TaskName QQDiaryTest-abc123 -AlsoStopDaemon
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$TaskName = 'QQDiary',

    [switch]$AlsoStopDaemon
)

$ErrorActionPreference = 'Stop'

$SchtasksExe = Join-Path $env:SystemRoot 'System32\schtasks.exe'

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "[OK] $Text" -ForegroundColor Green
}

function Write-Note {
    param([string]$Text)
    Write-Host $Text
}

function Write-Warn2 {
    param([string]$Text)
    Write-Host "[警告] $Text" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Text)
    Write-Host "[错误] $Text" -ForegroundColor Red
}

# 调用原生 exe：同时捕获 stdout+stderr 和退出码，且不会因 stderr 在 EAP=Stop 下抛异常。
function Invoke-Native {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & $FilePath @Arguments 2>&1
        $code = $LASTEXITCODE
        $lines = @()
        foreach ($item in @($raw)) {
            $lines += [string]$item
        }
        $text = ($lines -join "`r`n").Trim()
        return [pscustomobject]@{ ExitCode = [int]$code; Output = $text }
    } catch {
        return [pscustomobject]@{ ExitCode = -1; Output = $_.Exception.Message }
    } finally {
        $ErrorActionPreference = $previous
    }
}

$ProjectRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    Write-Err '无法确定脚本所在目录，请在项目目录下用 -File 方式运行本脚本。'
    exit 1
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$IndexJs = Join-Path $ProjectRoot 'index.js'
$PidFile = Join-Path $ProjectRoot 'state\daemon.pid'

if ([string]::IsNullOrWhiteSpace($TaskName)) {
    Write-Err '任务名不能为空。'
    exit 1
}
$TaskName = $TaskName.Trim()

function Stop-DaemonProcess {
    $lockPid = 0
    $targets = New-Object System.Collections.ArrayList

    # 1) 优先使用 state\daemon.pid（程序自身写的单实例锁）
    if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
        try {
            $raw = Get-Content -LiteralPath $PidFile -Raw -Encoding UTF8
            $data = $raw | ConvertFrom-Json
            if ($data -and $data.pid) {
                $lockPid = [int]$data.pid
            }
        } catch {
            Write-Warn2 "无法解析锁文件 $PidFile：$($_.Exception.Message)"
        }
    }

    if ($lockPid -gt 0) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $lockPid" -ErrorAction SilentlyContinue
        if ($null -eq $proc) {
            Write-Note "state\daemon.pid 指向的 PID $lockPid 已不存在，清理残留锁文件。"
            if ($PSCmdlet.ShouldProcess($PidFile, '删除残留锁文件')) {
                Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
            }
            $lockPid = 0
        } elseif ($proc.CommandLine -and $proc.CommandLine.IndexOf('index.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            [void]$targets.Add([pscustomobject]@{
                ProcessId   = [int]$proc.ProcessId
                CommandLine = [string]$proc.CommandLine
                FromLock    = $true
            })
        } else {
            $cmdText = ''
            if ($proc.CommandLine) { $cmdText = [string]$proc.CommandLine }
            Write-Warn2 "state\daemon.pid 指向 PID $lockPid，但该进程命令行不含 index.js（cmdline: $cmdText），为安全起见不结束它，也不删除锁文件。"
            $lockPid = 0
        }
    }

    # 2) 扫描 node.exe 命令行（覆盖计划任务/手动用完整路径启动的常驻实例）
    $ambiguous = @()
    $nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)
    foreach ($p in $nodeProcs) {
        if ($null -eq $p.CommandLine) { continue }
        $cmd = [string]$p.CommandLine
        if ($cmd.IndexOf('index.js', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        if ($cmd -match '--once') { continue }   # 不结束单次写入进程
        $isProject = ($cmd.IndexOf($IndexJs, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
        if (-not $isProject) {
            $isProject = ($cmd.IndexOf('qq-diary', [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
        }
        if (-not $isProject) {
            $ambiguous += $p
            continue
        }
        $already = $false
        foreach ($t in $targets) {
            if ($t.ProcessId -eq [int]$p.ProcessId) { $already = $true }
        }
        if (-not $already) {
            [void]$targets.Add([pscustomobject]@{
                ProcessId   = [int]$p.ProcessId
                CommandLine = $cmd
                FromLock    = $false
            })
        }
    }

    if ($targets.Count -eq 0) {
        if ($ambiguous.Count -gt 0) {
            Write-Warn2 "发现 $($ambiguous.Count) 个命令行只含 index.js、无法确认工作目录的 node 进程，未自动结束："
            foreach ($a in $ambiguous) {
                Write-Note ("  PID {0}  {1}" -f $a.ProcessId, $a.CommandLine)
            }
            Write-Note '如确认是 qq-diary，可手动结束；正常情况下 daemon 会写 state\daemon.pid，重新运行本脚本即可精确匹配。'
        } else {
            Write-Note '未发现正在运行的 qq-diary 常驻进程。'
        }
        return
    }

    foreach ($target in $targets) {
        if (-not $PSCmdlet.ShouldProcess("PID $($target.ProcessId)", '结束 qq-diary 常驻 node 进程')) {
            continue
        }
        try {
            Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
            Write-Ok "已结束进程 PID $($target.ProcessId)（$($target.CommandLine)）"
        } catch {
            Write-Err "结束 PID $($target.ProcessId) 失败：$($_.Exception.Message)"
            continue
        }

        $alive = $true
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 200
            if (-not (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue)) {
                $alive = $false
                break
            }
        }
        if ($alive) {
            Write-Warn2 "PID $($target.ProcessId) 仍在运行，请手动检查（可能无权限结束）。"
        }
    }

    # 3) 清理锁文件：仅当被结束进程的 PID 与锁文件记录一致
    if ($lockPid -gt 0 -and (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
        $matched = $false
        foreach ($target in $targets) {
            if ($target.ProcessId -eq $lockPid) { $matched = $true }
        }
        if ($matched) {
            if ($PSCmdlet.ShouldProcess($PidFile, '删除 daemon.pid 锁文件')) {
                Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $PidFile) {
                    Write-Warn2 "锁文件删除失败（可能被占用）：$PidFile"
                } else {
                    Write-Ok "已清理锁文件：$PidFile"
                }
            }
        } else {
            Write-Note "锁文件 PID ($lockPid) 与实际结束的进程不一致，按约定保留 $PidFile。"
        }
    }
}

# ───────────────────────── 删除计划任务 ─────────────────────────

Write-Head 'qq-diary 计划任务：卸载'
Write-Note "任务名 : $TaskName"
Write-Note "项目   : $ProjectRoot"

$query = Invoke-Native -FilePath $SchtasksExe -Arguments @('/Query', '/TN', $TaskName, '/FO', 'LIST')
if ($query.ExitCode -ne 0) {
    Write-Note "任务不存在：$TaskName（无需删除）"
} else {
    if ($PSCmdlet.ShouldProcess($TaskName, '删除计划任务')) {
        $delete = Invoke-Native -FilePath $SchtasksExe -Arguments @('/Delete', '/TN', $TaskName, '/F')
        if ($delete.ExitCode -ne 0) {
            Write-Err "删除计划任务失败（schtasks 退出码 $($delete.ExitCode)）。"
            if ($delete.Output) { Write-Note $delete.Output }
            if ($delete.Output -match 'denied|拒绝|0x80070005') {
                Write-Warn2 '系统拒绝访问：请确认该任务属于当前用户；若任务由其他用户/管理员创建，可能需要以管理员身份运行。'
            }
            exit 1
        }

        $verify = Invoke-Native -FilePath $SchtasksExe -Arguments @('/Query', '/TN', $TaskName, '/FO', 'LIST')
        if ($verify.ExitCode -eq 0) {
            Write-Err "删除命令返回成功，但 schtasks /Query 仍能查到任务：$TaskName"
            exit 1
        }
        Write-Ok "已删除计划任务：$TaskName"
        Write-Note 'schtasks /Query 复查：任务已不存在。'
    }
}

# ───────────────────────── 可选：停止常驻 daemon ─────────────────────────

if ($AlsoStopDaemon) {
    Write-Head '停止 qq-diary 常驻 daemon'
    Stop-DaemonProcess
}

Write-Note ''
Write-Note '卸载完成。'
exit 0
