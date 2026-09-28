@echo off
setlocal
cd /d "%~dp0"
title VoyageDesk AI v0.3.3

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo.
  echo ============================================================
  echo VoyageDesk first-time setup
  echo ============================================================
  echo.
  echo A private .env file has been created.
  echo Enter your Supabase, OpenAI, and Pexels values in Notepad.
  echo Amadeus is optional and may be left blank.
  echo.
  echo IMPORTANT: Do not share or upload your .env file.
  echo.
  start "" notepad.exe ".env"
  echo After saving .env, close Notepad and double-click
  echo "Start VoyageDesk.bat" again.
  echo.
  pause
  exit /b 0
)

echo ============================================================
echo Starting VoyageDesk AI v0.3.3...
echo Keep this window open while you use VoyageDesk.
echo ============================================================
echo.

rem Open the browser shortly after the Node server begins starting.
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"

rem Run the server in this window so any startup error remains visible.
call npm.cmd start

echo.
echo VoyageDesk has stopped. If you see an error above, take a screenshot.
pause
