@echo off
title B1 Prep - telc Deutsch B1
cd /d "%~dp0"

echo.
echo   B1 Prep - telc Deutsch B1
echo   =========================
echo.
echo   Starting the server, then opening the app.
echo   Keep this window open while you study.
echo   Close it, or press Ctrl+C, to stop the server.
echo.

rem Open the browser first: it takes about a second to start, by which time node has
rem already bound the port. This avoids the fragile nested-quote timing trick.
start "" http://127.0.0.1:4321

node server.js

echo.
echo   Server stopped.
pause
