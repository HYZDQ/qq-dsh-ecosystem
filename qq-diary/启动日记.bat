@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title qq-diary 前台运行

if not exist "index.js" (
    echo [错误] 当前目录找不到 index.js：%CD%
    echo 请把本 .bat 放在 D:\github\qq-diary 目录下运行。
    pause
    exit /b 1
)

set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%I"
)
if not defined NODE_EXE (
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE_EXE (
    echo [错误] 找不到 node.exe：它既不在 PATH 中，也不在 "%ProgramFiles%\nodejs\node.exe"。
    echo 请先安装 Node.js（^>= 22.13.0），或把 node.exe 加入 PATH 后重试。
    pause
    exit /b 1
)

rem 记录原始控制台代码页，node 结束后恢复，避免中文提示乱码
set "OLD_CP="
for /f "tokens=2 delims=:" %%C in ('chcp') do set "OLD_CP=%%C"

echo ============================================================
echo  qq-diary 前台运行（常驻模式，按 Ctrl+C 停止）
echo  项目目录 : %CD%
echo  node     : %NODE_EXE%
echo  日志目录 : %CD%\logs\  （程序日志按日期写在 logs 下）
echo ============================================================
echo.

chcp 65001 >nul
"%NODE_EXE%" index.js
set "EXIT_CODE=%ERRORLEVEL%"
if defined OLD_CP chcp%OLD_CP% >nul

echo.
if not "%EXIT_CODE%"=="0" echo [提示] node 退出码：%EXIT_CODE%
echo 程序已退出，按任意键关闭窗口。
pause >nul
exit /b %EXIT_CODE%
