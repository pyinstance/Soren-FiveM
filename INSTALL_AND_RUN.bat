@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Install Node.js LTS from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\.bin\vite.cmd" (
  echo Installing dependencies for first run...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
) else (
  echo Dependencies already installed - starting immediately...
)
echo Starting Soren FiveM...
call npm run dev
goto :eof
:fail
echo.
echo Setup failed. Check the npm error above.
pause
exit /b 1
