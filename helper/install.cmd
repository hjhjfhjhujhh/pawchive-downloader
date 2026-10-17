@echo off
setlocal
rem ============================================================
rem  注册原生消息宿主 com.pawchive.downloader
rem  作用：写宿主清单（host.py 的启动器）并写 HKCU 注册表，供 Chrome/Edge 使用。
rem  卸载：install.cmd uninstall
rem
rem  扩展 ID 不再写死：manifest.json 里的 key 已经决定性地绑定了 ID，
rem  这里用 helper\install_helper.py 从 manifest 现算，并只做「算出来 == 期望值」的自检。
rem  换机器、换目录、重新加载扩展都不会再对不上。
rem ============================================================

set "HOSTNAME=com.pawchive.downloader"
set "HELPER=%~dp0"
rem 去掉结尾反斜杠
if "%HELPER:~-1%"=="\" set "HELPER=%HELPER:~0,-1%"
set "LAUNCHER=%HELPER%\run_host.cmd"

set "MANIFEST_CHROME=%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\%HOSTNAME%.json"
set "MANIFEST_EDGE=%LOCALAPPDATA%\Microsoft\Edge\User Data\NativeMessagingHosts\%HOSTNAME%.json"

rem 仅当 Python 完全不可用时才使用的最后兜底（正常路径用不到它）
set "FALLBACK_EXTID=ldigpfmekoeakednbiamcfancpobneaf"

rem /auto 用于自动化（不暂停）
set "PAUSE_CMD=pause"
if /i "%~1"=="/auto" set "PAUSE_CMD=rem"

if /i "%~1"=="uninstall" goto :uninstall

if not exist "%LAUNCHER%" (
  echo [错误] 找不到原生消息启动器: %LAUNCHER%
  %PAUSE_CMD%
  exit /b 1
)

rem ---------- 解释器（只认 PATH；失败仅警告，不中断） ----------
call "%HELPER%\find_python.cmd"
if errorlevel 1 (
  echo.
  echo [警告] 在 PATH 里找不到可用的 Python，原生消息宿主将无法启动。
  echo        扩展的弹窗会一直提示「引擎未就绪」。装好 Python 3.8+ 后重跑本脚本即可。
  echo.
  set "PD_PY_RESOLVED="
) else (
  if not exist "%HELPER%\python-path.txt" > "%HELPER%\python-path.txt" echo %PD_PY_RESOLVED%
)

rem ---------- 扩展 ID：从 manifest.json 的 key 推导 ----------
rem 注意：不要在 if 块里 echo %EXTID% 做校验 —— cmd 在解析整块时就展开了变量，
rem 那时 EXTID 还是空的，检查会静默失效（实测踩到）。
rem 也不要用 echo %EXTID% ^| find " " 判空格：echo 会输出尾随空格，必然命中（同样实测踩到）。
rem 统一做法：让 Python 校验后写进 extension-id.txt，批处理只负责读回这一行。
call :derive_id
if not defined EXTID (
  set "EXTID=%FALLBACK_EXTID%"
  echo [警告] 无法从 manifest.json 推导扩展 ID，使用兜底值 %FALLBACK_EXTID%
  echo        若这不是你当前加载的扩展 ID，请先在 manifest.json 里放好 key，再重跑本脚本。
)
goto :derived

:derive_id
set "EXTID="
if not defined PD_PY_RESOLVED (
  echo [警告] 没有可用的 Python，无法从 manifest.json 推导扩展 ID。
  exit /b 0
)
rem --write-id 内部会做完 32 位 a..p 的严格校验，校验不过就不会写文件
%PD_PY_RESOLVED% "%HELPER%\install_helper.py" --write-id >nul 2>&1
if errorlevel 1 (
  echo [警告] install_helper.py 推导扩展 ID 失败（Python 或 manifest 有问题）。
  exit /b 0
)
if not exist "%HELPER%\extension-id.txt" exit /b 0
set "EXTID="
set /p EXTID=<"%HELPER%\extension-id.txt"
exit /b 0

:derived

rem ---------- 写宿主清单 ----------
if not exist "%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts" mkdir "%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts"
if not exist "%LOCALAPPDATA%\Microsoft\Edge\User Data\NativeMessagingHosts" mkdir "%LOCALAPPDATA%\Microsoft\Edge\User Data\NativeMessagingHosts"

rem JSON 里路径必须转义反斜杠
set "LAUNCHER_JSON=%LAUNCHER:\=\\%"

rem ---------- 备份旧清单与旧注册表值（便于回滚） ----------
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%T"
if not defined STAMP set "STAMP=backup"
if exist "%MANIFEST_CHROME%" copy /y "%MANIFEST_CHROME%" "%HELPER%\host-manifest.%STAMP%.json.bak" >nul 2>&1
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOSTNAME%" /ve 2^>nul ^| find "REG_SZ"') do > "%HELPER%\registry-chrome.%STAMP%.txt" echo %%B
for /f "tokens=2,*" %%A in ('reg query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOSTNAME%" /ve 2^>nul ^| find "REG_SZ"') do > "%HELPER%\registry-edge.%STAMP%.txt" echo %%B
echo 备份    : %HELPER%\host-manifest.%STAMP%.json.bak（若之前已注册）

> "%MANIFEST_CHROME%" echo {
>>"%MANIFEST_CHROME%" echo   "name": "%HOSTNAME%",
>>"%MANIFEST_CHROME%" echo   "description": "Pawchive Downloader aria2 RPC host",
>>"%MANIFEST_CHROME%" echo   "path": "%LAUNCHER_JSON%",
>>"%MANIFEST_CHROME%" echo   "type": "stdio",
>>"%MANIFEST_CHROME%" echo   "allowed_origins": ["chrome-extension://%EXTID%/"]
>>"%MANIFEST_CHROME%" echo }

copy /y "%MANIFEST_CHROME%" "%MANIFEST_EDGE%" >nul

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOSTNAME%" /ve /t REG_SZ /d "%MANIFEST_CHROME%" /f >nul 2>&1
if errorlevel 1 echo [警告] 写入 Chrome 注册表失败（权限不足？）
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOSTNAME%" /ve /t REG_SZ /d "%MANIFEST_CHROME%" /f >nul 2>&1
if errorlevel 1 echo [警告] 写入 Edge 注册表失败（权限不足？）

echo.
echo 宿主清单: %MANIFEST_CHROME%
echo 宿主清单: %MANIFEST_EDGE%
echo 注册表  : HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOSTNAME%
echo 注册表  : HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOSTNAME%
echo.
echo 允许的扩展 ID: %EXTID%
echo   （不再写死：由 manifest.json 的 key 推导，见 helper\install_helper.py --check-id）
if defined PD_PY_RESOLVED echo Python 解释器: %PD_PY_RESOLVED%
echo.
echo 接下来：在 edge://extensions 里「加载解压缩的扩展」选 extension 目录，
echo 让扩展 ID 与上面这个 ID 一致（manifest.json 已带 key，所以是确定的）。
echo.
%PAUSE_CMD%
exit /b 0

:uninstall
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOSTNAME%" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOSTNAME%" /f >nul 2>&1
del /q "%MANIFEST_CHROME%" >nul 2>&1
del /q "%MANIFEST_EDGE%" >nul 2>&1
echo 已卸载原生消息宿主 %HOSTNAME%
%PAUSE_CMD%
exit /b 0
