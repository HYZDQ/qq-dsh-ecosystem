@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
set "LOG=%~dp0launcher.log"
echo [%time%] launcher start>>"%LOG%"
where node>>"%LOG%" 2>&1
if errorlevel 1 goto nonode
echo ============================================================
echo  QQ Bridge for DeepSeek Harness Desktop
echo  It finds the desktop DSH port automatically and follows it.
echo  Close this window to stop the bridge.
echo ============================================================
node scripts\harden-state-acl.mjs --quiet
node "local\desktop-dsh-supervisor.mjs"
echo.
echo Bridge stopped. Log: state\bridge.log  Launcher log: local\launcher.log
pause
exit /b 0
:nonode
echo ERROR: node.exe not found in PATH.
echo Please install Node.js 22.13 or newer, then run this file again.
pause
exit /b 1
