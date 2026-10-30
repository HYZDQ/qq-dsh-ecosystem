param(
  [int]$ConsolePort = 3100,
  [string]$Token = '',
  [string]$SnowUrl = '',
  [int]$TimeoutSec = 240,
  [string]$DshUrl = ''
)
# 等桥接控制台就绪后，用 **Edge** 打开控制台与 SnowLuma 网页（令牌直接带在 URL 里，不用手输）。
# 用普通窗口/标签页（不另开独立配置目录）：关闭脚本只关命令行窗口，浏览器页面保持打开。
$ErrorActionPreference = 'Continue'

$deadline = (Get-Date).AddSeconds($TimeoutSec)

while ((Get-Date) -lt $deadline) {
  try {
    if (Get-NetTCPConnection -State Listen -LocalPort $ConsolePort -ErrorAction SilentlyContinue) { break }
  } catch {
    if ((& netstat -ano -p tcp | Select-String -SimpleMatch ":$ConsolePort ")) { break }
  }
  Start-Sleep -Seconds 2
}

$q = ''
if ($Token) { $q = '?token=' + [uri]::EscapeDataString($Token) }
$consoleUrl = ('http://127.0.0.1:{0}/{1}' -f $ConsolePort, $q)

# 固定用 Edge；找不到 Edge 才退回默认浏览器。
$edgeExe = $null
foreach ($candidate in @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe')
  )) {
  if ($candidate -and (Test-Path -LiteralPath $candidate)) { $edgeExe = $candidate; break }
}

$urls = @($consoleUrl)
if ($SnowUrl) { $urls += $SnowUrl }
if ($DshUrl) { $urls += $DshUrl }

if ($edgeExe) {
  # 一次传多个 URL，Edge 会把它们开成同一实例里的多个标签页
  try { Start-Process -FilePath $edgeExe -ArgumentList $urls | Out-Null } catch { }
} else {
  foreach ($u in $urls) { try { Start-Process $u | Out-Null } catch { } }
}

