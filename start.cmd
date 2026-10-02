@echo off
chcp 65001 >nul
title 宏观资讯台 - 本地预览
cd /d "%~dp0"

echo.
echo   宏观资讯台 · 本地预览
echo   ==========================
echo.
echo   为什么必须用本地服务器打开？
echo   站点通过 fetch() 读取 data/ 目录下的数据文件，
echo   而浏览器在 file:// 协议下会拦截 fetch（跨源安全限制），
echo   所以直接双击 index.html 必然是空白页。
echo.
echo   正在启动本地服务器...

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [错误] 未找到 Node.js，请先安装：https://nodejs.org
    echo.
    pause
    exit /b 1
)

start "" http://127.0.0.1:8848/
node scripts\serve.mjs

echo.
echo   服务器已停止。
pause
