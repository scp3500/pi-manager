@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if not defined PORT set "PORT=3001"
set "URL=http://localhost:%PORT%/"
set "LOG_DIR=%~dp0logs"
set "LOG_FILE=%LOG_DIR%\server.log"
set "ERR_FILE=%LOG_DIR%\server.err.log"

set "NODE_CMD=node"
where node >nul 2>&1
if errorlevel 1 (
  rem PATH may be empty when double-clicking .bat; probe common installs.
  set "NODE_DIR="
  for %%D in (
    "%ProgramFiles%\nodejs"
    "%ProgramFiles(x86)%\nodejs"
    "%LocalAppData%\Programs\nodejs"
    "%USERPROFILE%\scoop\apps\nodejs\current"
    "%USERPROFILE%\AppData\Roaming\nvm"
    "D:\Software\bian\node"
    "C:\Program Files\nodejs"
    "C:\nodejs"
  ) do (
    if not defined NODE_DIR if exist "%%~D\node.exe" set "NODE_DIR=%%~D"
  )
  if defined NODE_DIR (
    set "PATH=!NODE_DIR!;!PATH!"
    set "NODE_CMD=!NODE_DIR!\node.exe"
    echo [Pi Manager] node not on PATH; using: !NODE_CMD!
  ) else (
    echo [Pi Manager] node not found. Install Node.js 18+ and add it to PATH.
    echo [Pi Manager] tip: add your node folder to User PATH, or place node.exe in a known path.
    echo.
    pause
    exit /b 1
  )
)

if not exist "server.js" (
  echo [Pi Manager] server.js not found in: %CD%
  echo.
  pause
  exit /b 1
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

set "LISTEN_PID="
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /I "LISTENING" ^| findstr /C:":%PORT% "') do set "LISTEN_PID=%%P"

if not defined LISTEN_PID (
  for /f "tokens=*" %%L in ('netstat -ano 2^>nul ^| findstr /I "LISTENING" ^| findstr /C:":%PORT% "') do (
    for %%P in (%%L) do set "LISTEN_PID=%%P"
  )
)

if defined LISTEN_PID (
  echo [Pi Manager] already running on port %PORT%  PID %LISTEN_PID%
  echo [Pi Manager] opening browser only: %URL%
  start "" "%URL%"
  if errorlevel 1 echo [Pi Manager] could not open browser - open %URL% manually
  exit /b 0
)

echo [Pi Manager] starting in background on port %PORT%
echo [Pi Manager] cwd: %CD%
echo [Pi Manager] log: %LOG_FILE%
echo [Pi Manager] err: %ERR_FILE%
echo [Pi Manager] stop: stop.bat
echo [Pi Manager] open: %URL%
echo.

rem Detached: closing this bat window does NOT kill the server.
rem FOREGROUND=1 start.bat  - old behavior (window holds process)
if /I "%FOREGROUND%"=="1" (
  echo [Pi Manager] FOREGROUND=1 - close this window to stop
  start "" /b cmd /c "ping -n 2 127.0.0.1 >nul & start %URL%"
  "%NODE_CMD%" server.js
  set "ERR=%ERRORLEVEL%"
  if not "%ERR%"=="0" (
    echo.
    echo [Pi Manager] exited with code %ERR%
    pause
    exit /b %ERR%
  )
  exit /b 0
)

powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start-bg.ps1" -NodeCmd "%NODE_CMD%" -WorkDir "%CD%" -LogFile "%LOG_FILE%" -ErrFile "%ERR_FILE%" -PidFile "%LOG_DIR%\last-pid.txt"
if errorlevel 1 (
  echo [Pi Manager] failed to start background process
  echo [Pi Manager] fallback: running in this window
  start "" /b cmd /c "ping -n 2 127.0.0.1 >nul & start %URL%"
  "%NODE_CMD%" server.js
  exit /b %ERRORLEVEL%
)

set /p BG_PID=<"%LOG_DIR%\last-pid.txt"
echo [Pi Manager] started PID %BG_PID%
start "" /b cmd /c "ping -n 2 127.0.0.1 >nul & start %URL%"

ping -n 2 127.0.0.1 >nul
set "OK_PID="
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /I "LISTENING" ^| findstr /C:":%PORT% "') do set "OK_PID=%%P"
if defined OK_PID (
  echo [Pi Manager] listening on %PORT%  PID %OK_PID%
) else (
  echo [Pi Manager] WARN: port %PORT% not listening yet - check logs:
  echo   %LOG_FILE%
  echo   %ERR_FILE%
  if exist "%LOG_DIR%\server-fatal.log" echo   %LOG_DIR%\server-fatal.log
)

endlocal
exit /b 0
