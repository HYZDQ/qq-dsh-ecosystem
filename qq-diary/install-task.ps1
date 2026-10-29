<#
.SYNOPSIS
    为 qq-diary 注册 Windows 计划任务（推荐：登录时启动常驻 daemon；或每天 22:00 单次运行）。

.DESCRIPTION
    兼容 Windows PowerShell 5.1（powershell.exe）与 PowerShell 7（pwsh）。
    使用「当前用户的交互式登录任务」（InteractiveToken + LeastPrivilege）配合
    schtasks.exe /Create /XML 注册，属于用户级计划任务：普通用户即可创建，通常不需要管理员权限。
    本脚本不会修改项目源码/配置，只创建计划任务和临时 XML 文件（%TEMP%，用完即删）。

    -Mode daemon（默认，推荐）：双触发器 —— 当前用户登录 Windows 时启动 node.exe "<项目>\index.js" 常驻运行，
        并且每天 22:00（跟随 config.json 的 writeAt）再兜底拉起一次。
        推荐理由：常驻进程支持启动补写、错过时间补写、通知失败重试；兜底触发器保证
        「进程被结束 / 机器长期不重新登录」时当天仍能补写（已在跑则被 IgnoreNew + 单实例锁忽略）。
    -Mode daily：每天 22:00 运行 node.exe "<项目>\index.js" --once，不常驻。
        适合不想常驻后台的场景；错过 22:00 后由 StartWhenAvailable 在开机后补跑一次。

    两种模式统一设置：
        StartWhenAvailable=true          错过计划时间后补跑
        DisallowStartIfOnBatteries=false 电池供电也启动
        StopIfGoingOnBatteries=false     切换电池时不停止
        MultipleInstancesPolicy=IgnoreNew 已有实例在跑时忽略新触发（避免重复写日记）
        ExecutionTimeLimit=PT0S（daemon 不限时）/ PT10M（daily 最多 10 分钟）

.PARAMETER Mode
    daemon 或 daily，默认 daemon。

.PARAMETER Uninstall
    等价于调用同目录下的 uninstall-task.ps1（删除任务）。

.PARAMETER TaskName
    计划任务名，默认 QQDiary。测试时请使用临时名字（例如 QQDiaryTest-abc123），别占用正式名。

.PARAMETER Force
    同名任务已存在时覆盖（schtasks /Create /F）。

.PARAMETER WhatIf
    只显示将要执行的操作，不真正创建/删除任务。

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1 -Mode daily -TaskName QQDiaryTest-abc123 -Force

.EXAMPLE
    .\install-task.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('daemon', 'daily')]
    [string]$Mode = 'daemon',

    [switch]$Uninstall,

    [string]$TaskName = 'QQDiary',

    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$SchtasksExe = Join-Path $env:SystemRoot 'System32\schtasks.exe'
$WhereExe = Join-Path $env:SystemRoot 'System32\where.exe'
$DailyStartTime = '22:00:00'

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

function ConvertTo-XmlText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    return [System.Security.SecurityElement]::Escape($Text)
}

# 解析 node.exe 绝对路径：where.exe node -> Get-Command node -> %ProgramFiles%\nodejs\node.exe
function Resolve-NodeExe {
    $candidates = New-Object System.Collections.ArrayList

    $whereResult = Invoke-Native -FilePath $WhereExe -Arguments @('node')
    if ($whereResult.ExitCode -eq 0) {
        foreach ($line in ($whereResult.Output -split "`r?`n")) {
            $trimmed = $line.Trim()
            if ($trimmed -ne '' -and (Test-Path -LiteralPath $trimmed -PathType Leaf)) {
                [void]$candidates.Add($trimmed)
            }
        }
    }

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
        [void]$candidates.Add($cmd.Source)
    }

    $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) {
        [void]$candidates.Add($fallback)
    }

    foreach ($candidate in $candidates) {
        if ([System.IO.Path]::GetExtension($candidate).ToLowerInvariant() -eq '.exe') {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }
    return $null
}

# ───────────────────────── 基础信息 ─────────────────────────

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

if ([string]::IsNullOrWhiteSpace($TaskName)) {
    Write-Err '任务名不能为空。'
    exit 1
}
$TaskName = $TaskName.Trim()

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$currentUser = $identity.Name
$adminText = '否'
if ($isAdmin) { $adminText = '是' }

# ───────────────────────── -Uninstall ─────────────────────────

if ($Uninstall) {
    Write-Head 'qq-diary 计划任务：卸载模式'
    $uninstallScript = Join-Path $ProjectRoot 'uninstall-task.ps1'
    if (-not (Test-Path -LiteralPath $uninstallScript -PathType Leaf)) {
        Write-Err "找不到卸载脚本：$uninstallScript"
        exit 1
    }
    & $uninstallScript -TaskName $TaskName -WhatIf:$WhatIfPreference
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $IndexJs -PathType Leaf)) {
    Write-Err "项目入口不存在：$IndexJs"
    Write-Note "请把 install-task.ps1 / uninstall-task.ps1 / 启动日记.bat 放在 D:\github\qq-diary 根目录后运行。"
    exit 1
}

$nodeExe = Resolve-NodeExe
if ($null -eq $nodeExe) {
    Write-Err '找不到 node.exe，无法注册计划任务。'
    Write-Note '查找顺序：where.exe node -> Get-Command node -> %ProgramFiles%\nodejs\node.exe'
    Write-Note '请先安装 Node.js（>= 22.13.0），或确认 node.exe 在 PATH 中后重试。'
    exit 1
}

# 每天定时触发器的时间：优先读 config.json 的 writeAt（跟随用户配置），读不到回落 22:00:00
try {
    $cfgPath = Join-Path $ProjectRoot 'config.json'
    if (Test-Path -LiteralPath $cfgPath -PathType Leaf) {
        $cfgJson = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
        if ($cfgJson.writeAt -is [string] -and $cfgJson.writeAt -match '^([01]?\d|2[0-3]):([0-5]\d)$') {
            $DailyStartTime = ([string]$cfgJson.writeAt).Trim() + ':00'
        }
    }
} catch {
    # 配置读不到就用默认 22:00:00
}

if ($Mode -eq 'daemon') {
    $modeLabel = 'daemon（登录时启动常驻 + 每天兜底拉起）'
    $argumentsRaw = '"' + $IndexJs + '"'
    $executionLimit = 'PT0S'
    $triggerLabel = "当前用户登录时（$currentUser） + 每天 $DailyStartTime（兜底拉起；已有常驻实例会被 IgnoreNew 忽略）"
} else {
    $modeLabel = "daily（每天 $DailyStartTime 运行 --once）"
    $argumentsRaw = '"' + $IndexJs + '" --once'
    $executionLimit = 'PT10M'
    $triggerLabel = "每天 $DailyStartTime"
}

Write-Head 'qq-diary 计划任务：安装'
Write-Note "项目目录 : $ProjectRoot"
Write-Note "node.exe : $nodeExe"
Write-Note "任务名   : $TaskName"
Write-Note "模式     : $modeLabel"
Write-Note "触发器   : $triggerLabel"
Write-Note "当前用户 : $currentUser（管理员：$adminText）"

# ───────────────────────── 同名任务检查 ─────────────────────────

$query = Invoke-Native -FilePath $SchtasksExe -Arguments @('/Query', '/TN', $TaskName, '/FO', 'LIST')
$taskExists = ($query.ExitCode -eq 0)
if ($taskExists) {
    Write-Note "同名任务已存在：$TaskName"
} else {
    Write-Note '同名任务不存在（将新建）。'
}

if ($taskExists -and -not $Force) {
    if ($WhatIfPreference) {
        Write-Warn2 '同名任务已存在；真正执行时需要加 -Force 才会覆盖。'
    } else {
        Write-Err "任务已存在：$TaskName。若要覆盖请加 -Force；若要删除请运行： .\uninstall-task.ps1 -TaskName `"$TaskName`""
        exit 2
    }
}

# ───────────────────────── 生成任务 XML ─────────────────────────

$userXml = ConvertTo-XmlText $currentUser
$commandXml = ConvertTo-XmlText $nodeExe
$argumentsXml = ConvertTo-XmlText $argumentsRaw
$workDirXml = ConvertTo-XmlText $ProjectRoot

$startBoundary = (Get-Date).ToString('yyyy-MM-dd') + 'T' + $DailyStartTime
$calendarTriggerXml = "    <CalendarTrigger>`r`n      <StartBoundary>$startBoundary</StartBoundary>`r`n      <Enabled>true</Enabled>`r`n      <ScheduleByDay>`r`n        <DaysInterval>1</DaysInterval>`r`n      </ScheduleByDay>`r`n    </CalendarTrigger>"

if ($Mode -eq 'daemon') {
    $descriptionText = 'qq-diary 常驻：当前用户登录时启动 node index.js，并每天定时兜底拉起（推荐模式，支持启动补写/错过补写/通知重试）。由 install-task.ps1 创建。'
    # 双触发器：登录时启动 + 每天定时兜底拉起（进程被结束后仍能在当天补写；已在跑则由 IgnoreNew 忽略）
    $triggerXml = "    <LogonTrigger>`r`n      <Enabled>true</Enabled>`r`n      <UserId>$userXml</UserId>`r`n    </LogonTrigger>`r`n" + $calendarTriggerXml
} else {
    $descriptionText = 'qq-diary 每日定时运行 node index.js --once。由 install-task.ps1 创建。'
    $triggerXml = $calendarTriggerXml
}
$descriptionXml = ConvertTo-XmlText $descriptionText

$taskXml = @'
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>__USER__</Author>
    <Description>__DESCRIPTION__</Description>
  </RegistrationInfo>
  <Triggers>
__TRIGGERS__
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>__USER__</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>__TIMELIMIT__</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>__COMMAND__</Command>
      <Arguments>__ARGUMENTS__</Arguments>
      <WorkingDirectory>__WORKDIR__</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
'@

$taskXml = $taskXml.Replace('__USER__', $userXml)
$taskXml = $taskXml.Replace('__DESCRIPTION__', $descriptionXml)
$taskXml = $taskXml.Replace('__TRIGGERS__', $triggerXml)
$taskXml = $taskXml.Replace('__TIMELIMIT__', $executionLimit)
$taskXml = $taskXml.Replace('__COMMAND__', $commandXml)
$taskXml = $taskXml.Replace('__ARGUMENTS__', $argumentsXml)
$taskXml = $taskXml.Replace('__WORKDIR__', $workDirXml)

$target = "$TaskName（$modeLabel）"
if (-not $PSCmdlet.ShouldProcess($target, '注册计划任务')) {
    Write-Note '（-WhatIf / 未确认：未创建任务）'
    exit 0
}

# ───────────────────────── 创建任务 ─────────────────────────

$tmpXml = Join-Path $env:TEMP ('qq-diary-task-' + [Guid]::NewGuid().ToString('N') + '.xml')
try {
    # schtasks 对 UTF-16（带 BOM）最稳妥；中文用户名/描述不会乱码。
    [System.IO.File]::WriteAllText($tmpXml, $taskXml, [System.Text.Encoding]::Unicode)

    $createArgs = @('/Create', '/TN', $TaskName, '/XML', $tmpXml)
    if ($Force) { $createArgs += '/F' }

    $created = Invoke-Native -FilePath $SchtasksExe -Arguments $createArgs
    if ($created.ExitCode -ne 0) {
        Write-Err "创建计划任务失败（schtasks 退出码 $($created.ExitCode)）。"
        if ($created.Output) { Write-Note $created.Output }
        if ($created.Output -match 'denied|拒绝|0x80070005') {
            Write-Warn2 '系统拒绝访问：请确认当前用户有创建计划任务的权限、组策略未禁用计划任务；必要时右键 PowerShell「以管理员身份运行」再试。'
        }
        exit 1
    }
} finally {
    if (Test-Path -LiteralPath $tmpXml) {
        Remove-Item -LiteralPath $tmpXml -Force -ErrorAction SilentlyContinue
    }
}

$verify = Invoke-Native -FilePath $SchtasksExe -Arguments @('/Query', '/TN', $TaskName, '/FO', 'LIST')
if ($verify.ExitCode -ne 0) {
    Write-Err "创建命令返回成功，但查询不到任务：$TaskName"
    exit 1
}

# ───────────────────────── 结果 ─────────────────────────

Write-Ok "计划任务已注册：$TaskName"
Write-Note ''
Write-Note "  模式       : $modeLabel"
Write-Note "  Task To Run: `"$nodeExe`" $argumentsRaw"
Write-Note "  工作目录   : $ProjectRoot"
Write-Note "  触发器     : $triggerLabel"
Write-Note "  补跑/电池  : StartWhenAvailable=true / 电池下可启动 / 切换电池不停止"
Write-Note "  多实例     : IgnoreNew（已有实例时忽略新触发）"
Write-Note "  超时限制   : $executionLimit"
Write-Note ''
Write-Note '下一步验证：'
Write-Note "  schtasks /Query /TN `"$TaskName`" /V /FO LIST"
Write-Note '  （重点看 Task To Run / Start In / Schedule Type / Start Time）'
Write-Note '  注：本机 schtasks /V /FO LIST 不显示 Start When Available；可加 /XML 查看 <StartWhenAvailable>true</StartWhenAvailable>'
Write-Note ''
Write-Note '日志位置：'
Write-Note "  程序日志     : $ProjectRoot\logs\（按日期 .log 文件）"
Write-Note '  计划任务历史 : taskschd.msc -> 任务计划程序库 -> 该任务 -> “历史记录”选项卡（需先启用“所有任务历史记录”）'
Write-Note ''
Write-Note '卸载：'
Write-Note "  powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ProjectRoot\uninstall-task.ps1`" -TaskName `"$TaskName`""
Write-Note ''

if ($Mode -eq 'daemon') {
    Write-Note '提示：daemon 为推荐模式（进程常驻，支持启动补写/错过补写/通知重试）。'
    Write-Note '      同一时间只允许一个实例（IgnoreNew + 程序自身 state\daemon.pid 单实例锁）。'
} else {
    Write-Note '提示：daily 模式不常驻，只会在每天 22:00（错过后开机补跑）执行一次 --once。'
    Write-Note '      如果希望支持“程序启动时补写 / 通知重试”，建议改用 -Mode daemon。'
}

if (-not $isAdmin) {
    Write-Note '当前是非管理员会话：本脚本使用用户级任务，通常无需提权；若上面创建失败并提示拒绝访问，再考虑提权。'
}

exit 0
