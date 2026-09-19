@echo off
REM =====================================================================
REM Register LAM (Local Agent Memory Gateway) as a Windows service (NSSM).
REM NOTE: keep this file ASCII-only; cmd parses .bat with the OEM codepage
REM       and non-ASCII content breaks (mis-parsed lines, mojibake).
REM
REM Usage:
REM   Install-Service.bat             install/reinstall + start (auto-elevate)
REM   Install-Service.bat uninstall   stop + uninstall the service
REM
REM What it does:
REM   - Re-launches itself elevated (UAC prompt) if not admin
REM   - Downloads NSSM v2.24 from nssm.cc into tools\ if missing
REM   - Service command: node.exe --import tsx --liftoff-only src/server.ts
REM     (--liftoff-only is required by the CodeGraph engine, DESIGN 67)
REM   - AppDirectory = repo root (so Logs\ and data\ land here)
REM   - Idempotent: existing service is removed and re-created
REM =====================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "SERVICE_NAME=LocalAgentMemory"
set "NSSM=%ROOT%\tools\nssm.exe"

REM -- 1. admin check: relaunch elevated when needed --
net session >nul 2>&1
if errorlevel 1 (
  echo [INFO] Administrator rights required. Relaunching elevated... ^(confirm UAC prompt^)
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs"
  exit /b
)

REM -- 2. uninstall branch --
if /i "%~1"=="uninstall" (
  if not exist "%NSSM%" (
    echo [ERROR] %NSSM% not found. Uninstall manually with: sc delete %SERVICE_NAME%
    pause & exit /b 1
  )
  "%NSSM%" stop %SERVICE_NAME% >nul 2>&1
  "%NSSM%" remove %SERVICE_NAME% confirm
  echo [OK] Service %SERVICE_NAME% removed.
  pause & exit /b 0
)

REM -- 3. locate node (must be >= 24) --
set "NODE_EXE="
for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE (
  echo [ERROR] node not found in PATH. Install Node.js 24+ first.
  pause & exit /b 1
)
echo [INFO] node: %NODE_EXE%

REM -- 4. dependency precheck: tsx must be installed --
if not exist "%ROOT%\node_modules\tsx" (
  echo [ERROR] node_modules\tsx missing. Run "pnpm install" in the repo root first.
  pause & exit /b 1
)

REM -- 5. fetch NSSM if missing (official zip from nssm.cc, take win64\nssm.exe) --
if not exist "%NSSM%" (
  echo [INFO] Downloading NSSM v2.24 from nssm.cc ...
  if not exist "%ROOT%\tools" mkdir "%ROOT%\tools"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; $zip=\"$env:TEMP\nssm-2.24.zip\"; $tmp=\"$env:TEMP\nssm-extract\"; Invoke-WebRequest -Uri 'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip' -OutFile $zip -UserAgent 'Mozilla/5.0'; Expand-Archive -Path $zip -DestinationPath $tmp -Force; $exe=Get-ChildItem -Path $tmp -Recurse -Filter nssm.exe | Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1; if (-not $exe) { $exe=Get-ChildItem -Path $tmp -Recurse -Filter nssm.exe | Select-Object -First 1 }; Copy-Item $exe.FullName '%ROOT%\tools\nssm.exe' -Force; Remove-Item $zip,$tmp -Recurse -Force"
  if not exist "%NSSM%" (
    echo [ERROR] NSSM download failed ^(network blocked?^).
    echo         Manual fallback: download nssm-2.24.zip from https://nssm.cc/download,
    echo         then put win64\nssm.exe into %ROOT%\tools\ and rerun this script.
    pause & exit /b 1
  )
  echo [INFO] NSSM ready: %NSSM%
)

REM -- 6. idempotent: stop + remove existing service first --
"%NSSM%" status %SERVICE_NAME% >nul 2>&1
if not errorlevel 1 (
  echo [INFO] Existing service %SERVICE_NAME% detected. Removing before reinstall...
  "%NSSM%" stop %SERVICE_NAME% >nul 2>&1
  "%NSSM%" remove %SERVICE_NAME% confirm >nul 2>&1
)

REM -- 7. install + configure --
echo [INFO] Registering service %SERVICE_NAME% ...
"%NSSM%" install %SERVICE_NAME% "%NODE_EXE%" --import tsx --liftoff-only src/server.ts
if errorlevel 1 (
  echo [ERROR] Service registration failed.
  pause & exit /b 1
)

if not exist "%ROOT%\Logs\service" mkdir "%ROOT%\Logs\service"

"%NSSM%" set %SERVICE_NAME% AppDirectory "%ROOT%"
"%NSSM%" set %SERVICE_NAME% DisplayName "Local Agent Memory Gateway"
"%NSSM%" set %SERVICE_NAME% Description "Local Agent Memory Gateway: transparent OpenAI proxy + memory/knowledge/codegraph backend on :8790"
"%NSSM%" set %SERVICE_NAME% Start AUTO
REM restart 5s after unexpected exit
"%NSSM%" set %SERVICE_NAME% AppExit Default Restart
"%NSSM%" set %SERVICE_NAME% AppRestartDelay 5000
REM redirect stdout/stderr into Logs\service\, rotate at 10MB
"%NSSM%" set %SERVICE_NAME% AppStdout "%ROOT%\Logs\service\stdout.log"
"%NSSM%" set %SERVICE_NAME% AppStderr "%ROOT%\Logs\service\stderr.log"
"%NSSM%" set %SERVICE_NAME% AppStdoutCreationDisposition 4
"%NSSM%" set %SERVICE_NAME% AppStderrCreationDisposition 4
"%NSSM%" set %SERVICE_NAME% AppRotateFiles 1
"%NSSM%" set %SERVICE_NAME% AppRotateBytes 10485760
REM to override PORT / DATA_DIR / FRONTEND_DIST, uncomment:
REM "%NSSM%" set %SERVICE_NAME% AppEnvironmentExtra PORT=8790 DATA_DIR=E:\Code\LAM\data FRONTEND_DIST=E:\Code\LAM\frontend\dist

echo [INFO] Starting service...
"%NSSM%" start %SERVICE_NAME%
if errorlevel 1 (
  echo [WARN] Service registered but failed to start. Check: sc query %SERVICE_NAME%, Logs\service\stderr.log
) else (
  echo [OK] Service started: http://localhost:8790
)

echo.
echo Manage:
echo   status:  sc query %SERVICE_NAME%
echo   stop:    net stop %SERVICE_NAME%
echo   start:   net start %SERVICE_NAME%
echo   remove:  Install-Service.bat uninstall
pause
endlocal
