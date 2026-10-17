@echo off
setlocal
rem ============================================================
rem  以管理员权限运行 Pawchive 辅助程序（HTTP 桥，由它启动 aria2）
rem
rem  为什么需要提权：普通权限下 aria2c.exe 连桌面都建不了目录
rem  （errorCode=18 Permission denied），而 PowerShell 等程序写同一目录完全正常
rem  —— 这是 aria2 进程缺少提升权限，不是目录 ACL 问题。实测管理员权限下
rem  aria2 写盘恢复正常。
rem
rem  用法：双击本文件 -> UAC 弹窗点「是」-> 保持窗口打开即可。
rem  停止：关闭这个窗口（这是停止辅助程序的唯一手段，所以不要改成无窗口常驻）。
rem
rem  Python 不再写死路径：只认 PATH（可用 PD_PY 覆盖），解析逻辑在 find_python.cmd。
rem ============================================================

net session >nul 2>&1
if %errorlevel%==0 goto :run

echo 正在请求管理员权限...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
exit /b

:run
title Pawchive 辅助程序（管理员）
cd /d "%~dp0"

call "%~dp0find_python.cmd"
if errorlevel 1 (
  echo.
  echo 没有可用的 Python，辅助程序无法启动。按任意键关闭窗口...
  pause >nul
  exit /b 1
)

rem 缓存解释器路径：这样浏览器后来通过原生消息拉起的 stdio 宿主也能找到同一个 Python
if not exist "%~dp0python-path.txt" (
  > "%~dp0python-path.txt" echo %PD_PY_RESOLVED%
)

echo ============================================================
echo  Pawchive 辅助程序已以管理员权限启动
echo.
echo  Python     : %PD_PY_RESOLVED%
echo  扩展通过它来启动/复用 aria2（HTTP 桥 127.0.0.1:16850）。
echo  下载相关操作全部走这个桥，扩展不会再自己拉起 aria2。
echo  所以：关闭这个窗口后下载会直接不可用（扩展提示「连不上辅助程序」），
echo  重新双击本文件即可恢复。
echo ============================================================
echo.

%PD_PY_RESOLVED% "%~dp0host.py" --serve

echo.
echo 辅助程序已退出。按任意键关闭窗口...
pause >nul
