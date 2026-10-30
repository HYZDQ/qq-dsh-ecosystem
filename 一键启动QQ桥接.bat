@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title QQ Bridge Launcher

if /I "%~1"=="--elevated" goto run

set "ISADMIN="
for /f "delims=" %%A in ('powershell -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)" 2^>nul') do set "ISADMIN=%%A"
if /I "%ISADMIN%"=="True" goto run

powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c','%~f0 --elevated' -Verb RunAs" 2>nul
if errorlevel 1 (
  echo [ERROR] Failed to obtain administrator rights, or the prompt was cancelled.
  echo         Right-click this file and choose "Run as administrator".
  pause
)
exit /b

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "qq-bridge\local\start-all.ps1"
if errorlevel 1 echo.
echo.
echo (This window stays open; close it to exit.)
pause