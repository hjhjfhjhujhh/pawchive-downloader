@echo off
rem ============================================================
rem  解析 Python 解释器（被 run_host.cmd / run-as-admin.cmd / install.cmd 共用）
rem
rem  设计取舍（按使用者要求）：**只用 PATH 里的 Python**，不翻注册表、
rem  不找便携版、不捆绑解释器。想指定别的解释器就设 PD_PY 环境变量。
rem
rem  顺序：PD_PY -> helper\python-path.txt 缓存 -> PATH 里的 python(.exe) -> py -3
rem
rem  为什么"PATH 里的 python"排在 py 启动器之前：
rem    py -3 只能给出一个带参数的命令行，拿不到配套的 pythonw.exe，
rem    而原生消息宿主必须用 pythonw.exe 启动（否则闪黑框），且变量要能当单个路径用。
rem
rem  实测坑：
rem    Microsoft Store 的 python 存根在
rem    %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe，直接跑会打开应用商店。
rem    所以候选要跳过 WindowsApps，并用 `--version` 真正跑一次来判定可用性。
rem
rem  本脚本不依赖调用方开启 delayed expansion。
rem
rem  输出：PD_PY_RESOLVED=可直接执行的解释器
rem        PD_PYW_RESOLVED=用于无窗口启动原生消息宿主的解释器
rem  成功：errorlevel 0；失败：errorlevel 1
rem ============================================================
set "PD_PY_RESOLVED="
set "PD_PYW_RESOLVED="

if defined PD_PY if exist "%PD_PY%" set "PD_PY_RESOLVED=%PD_PY%"
if defined PD_PY_RESOLVED goto :accept

set "PD_PY_CACHE=%~dp0python-path.txt"
if exist "%PD_PY_CACHE%" (
  set "PD_PY_CACHED="
  set /p PD_PY_CACHED=<"%PD_PY_CACHE%"
  if defined PD_PY_CACHED if exist "%PD_PY_CACHED%" set "PD_PY_RESOLVED=%PD_PY_CACHED%"
)
if defined PD_PY_RESOLVED goto :accept

rem PATH 里的 python.exe / python3.exe；跳过 Store 存根，并真正跑一次确认可用
call :try_where python.exe
if defined PD_PY_RESOLVED goto :accept
call :try_where python3.exe
if defined PD_PY_RESOLVED goto :accept

rem 最后兜底：py 启动器（拿不到 pythonw，就让它自己处理）
py -3 -c "pass" >nul 2>&1
if not errorlevel 1 (
  set "PD_PY_RESOLVED=py -3"
  goto :accept
)

echo [错误] 在 PATH 里找不到可用的 Python 3。
echo        请安装 Python 3.8+ 并勾选 "Add python.exe to PATH"，
echo        或设置环境变量 PD_PY 指向 python.exe 的完整路径。
exit /b 1

:try_where
for /f "delims=" %%P in ('where.exe %1 2^>nul') do (
  if not defined PD_PY_RESOLVED (
    echo %%P | find /i "\WindowsApps\" >nul
    if errorlevel 1 (
      "%%P" --version >nul 2>&1
      if not errorlevel 1 set "PD_PY_RESOLVED=%%P"
    )
  )
)
exit /b 0

:accept
if "%PD_PY_RESOLVED%"=="py -3" (
  set "PD_PYW_RESOLVED=py -3"
  for /f "delims=" %%P in ('where.exe py.exe 2^>nul') do if not defined PD_PY_DIR set "PD_PY_DIR=%%~dpP"
) else (
  for %%D in ("%PD_PY_RESOLVED%") do set "PD_PYW_RESOLVED=%%~dpDpythonw.exe"
  for %%D in ("%PD_PY_RESOLVED%") do set "PD_PY_DIR=%%~dpD"
  if not exist "%PD_PYW_RESOLVED%" set "PD_PYW_RESOLVED=%PD_PY_RESOLVED%"
)
if defined PD_PY_DIR set "PATH=%PD_PY_DIR%;%PATH%"
set "PD_PY_DIR="
set "PD_PY_CACHED="
exit /b 0
