@echo off
setlocal
rem ============================================================
rem  浏览器通过这个脚本启动原生消息宿主（stdio）。
rem
rem  注意：这个脚本由浏览器进程拉起，它继承的 PATH 可能和你在 cmd 里看到的
rem  不一样。所以解释器解析结果会被缓存到 helper\python-path.txt，下次直接复用。
rem
rem  用 pythonw.exe 启动：stdio 已被浏览器接管，不需要控制台窗口，
rem  用 python.exe 反而会闪一个黑框。
rem
rem  ★ 这个文件是原生消息的入口，删了扩展就直接失联。
rem ============================================================
call "%~dp0find_python.cmd"
if errorlevel 1 exit /b 1

if not exist "%~dp0python-path.txt" (
  > "%~dp0python-path.txt" echo %PD_PY_RESOLVED%
)

"%PD_PYW_RESOLVED%" "%~dp0host.py"
exit /b %errorlevel%
