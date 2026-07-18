@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if not defined PORT set "PORT=3001"

echo [Pi Manager] looking for LISTENING on port %PORT% ...

set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /I "LISTENING" ^| findstr /C:":%PORT% "') do (
  if not "%%P"=="0" (
    set "FOUND=1"
    echo [Pi Manager] taskkill /F /PID %%P
    taskkill /F /PID %%P >nul 2>&1
  )
)

if "!FOUND!"=="0" (
  for /f "tokens=*" %%L in ('netstat -ano 2^>nul ^| findstr /I "LISTENING" ^| findstr /C:":%PORT% "') do (
    for %%P in (%%L) do set "LAST=%%P"
  )
  if defined LAST (
    if not "!LAST!"=="0" (
      set "FOUND=1"
      echo [Pi Manager] taskkill /F /PID !LAST!
      taskkill /F /PID !LAST! >nul 2>&1
    )
  )
)

timeout /t 1 /nobreak >nul

set "STILL="
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr /I "LISTENING" ^| findstr /C:":%PORT% "') do set "STILL=%%P"

if defined STILL (
  echo [Pi Manager] still on port %PORT%  PID !STILL!
  echo [Pi Manager] try run this bat as admin, or taskkill the PID above
  echo.
  pause
  exit /b 1
)

if "!FOUND!"=="0" (
  echo [Pi Manager] not running on port %PORT%
) else (
  echo [Pi Manager] stopped.
)

endlocal
exit /b 0
