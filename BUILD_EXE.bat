@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Soren FiveM - Windows EXE Builder

set "MODE=%~1"
if "%MODE%"=="" set "MODE=both"

:: electron-builder's winCodeSign package contains symlinks. Windows normally
:: requires an elevated process (or Developer Mode) to extract them correctly.
powershell -NoProfile -NonInteractive -Command "$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 0}else{exit 1}"
if errorlevel 1 (
  echo Requesting Administrator permission for the Windows packaging tools...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%MODE%' -Verb RunAs"
  exit /b
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed.
  echo Install the current Node.js LTS release, then run this file again.
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo          Soren FiveM EXE Builder
echo ==========================================
echo Build mode: %MODE%
echo.
echo Installing/checking build dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

:: A failed non-elevated build leaves partial winCodeSign folders behind.
echo.
echo Clearing old Electron Builder signing-tool cache...
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"

echo Cleaning old release files...
if exist "release" rmdir /s /q "release"

set CSC_IDENTITY_AUTO_DISCOVERY=false

echo.
if /I "%MODE%"=="installer" (
  echo Building Windows installer...
  call npm run dist:installer
) else if /I "%MODE%"=="portable" (
  echo Building portable Windows EXE...
  call npm run dist:portable
) else (
  echo Building installer and portable Windows EXEs...
  call npm run dist
)
if errorlevel 1 goto :fail

if exist "release" (
  echo.
  echo Creating stable website filenames...
  for %%F in ("release\Soren FiveM Setup *.exe") do copy /Y "%%~fF" "release\Soren-FiveM-Setup.exe" >nul 2>nul
  for %%F in ("release\Soren FiveM *.exe") do (
    echo %%~nxF | findstr /I /C:"Setup" >nul || copy /Y "%%~fF" "release\Soren-FiveM-Portable.exe" >nul 2>nul
  )
)

echo.
echo ==========================================
echo BUILD COMPLETE
echo ==========================================
echo.
echo Output folder:
echo   %CD%\release
echo.
echo Website installer:
echo   release\Soren-FiveM-Setup.exe
echo.
echo Portable build:
echo   release\Soren-FiveM-Portable.exe
echo.
start "" "%CD%\release"
pause
exit /b 0

:fail
echo.
echo ==========================================
echo BUILD FAILED
echo ==========================================
echo.
echo If the error still says "Cannot create symbolic link", enable:
echo   Windows Settings ^> System ^> For developers ^> Developer Mode
 echo then run BUILD_EXE.bat again.
echo.
pause
exit /b 1
