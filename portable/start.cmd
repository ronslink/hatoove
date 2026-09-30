@echo off
setlocal
title B1 Prep Portable
cd /d "%~dp0"

if not exist "%~dp0runtime\node.exe" (
  echo.
  echo B1 Prep Portable cannot find its bundled runtime.
  echo Keep the runtime folder beside start.cmd.
  echo.
  pause
  exit /b 1
)

"%~dp0runtime\node.exe" "%~dp0portable-launcher.cjs" %*
set "B1PREP_EXIT_CODE=%ERRORLEVEL%"
if not "%B1PREP_EXIT_CODE%"=="0" (
  echo.
  echo B1 Prep Portable stopped with an error. See the message above.
  pause
)
exit /b %B1PREP_EXIT_CODE%
