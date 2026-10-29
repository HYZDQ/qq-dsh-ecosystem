param(
  [int]$ConsolePort = 3100,
  [string]$Token = '',
  [string]$SnowUrl = '',
  [int]$TimeoutSec = 240,
  [string]$DshUrl = ''
)
# 等桥接控制台就绪后自动打开两个网页（令牌直接带在 URL 里，不用手输）
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

try { Start-Process $consoleUrl | Out-Null } catch { }
if ($SnowUrl) { try { Start-Process $SnowUrl | Out-Null } catch { } }
if ($DshUrl) { try { Start-Process $DshUrl | Out-Null } catch { } }
