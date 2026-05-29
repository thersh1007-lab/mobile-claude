@echo off
REM Mobile Claude server launcher with auto-restart.
REM %~dp0 = this file's folder (the server dir). Loops so a crash restarts in ~5s.
cd /d "%~dp0"
:loop
"C:\Program Files\nodejs\node.exe" "dist\index.js" >> "logs\autostart.log" 2>&1
ping 127.0.0.1 -n 6 >nul
goto loop
