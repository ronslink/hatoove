@echo off
setlocal
title B1 Prep - Sync SSD progress to home
cd /d "%~dp0"
echo.
echo This performs the one-time merge from the SSD into your home B1 Prep app.
echo Close BOTH app browser tabs and BOTH server consoles before continuing.
echo.
if not exist "%~dp0runtime\node.exe" (
  echo The bundled runtime is missing. Keep the application folder together.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0tools\sync-home.js" %*
set "B1PREP_SYNC_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %B1PREP_SYNC_EXIT%
