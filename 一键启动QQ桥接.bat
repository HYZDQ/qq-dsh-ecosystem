@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title QQ Bridge one-click launcher
powershell -NoProfile -ExecutionPolicy Bypass -File "qq-bridge\local\start-all.ps1" %*
if errorlevel 1 echo.
echo.
echo (this window stays open; close it to exit)
pause
