@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo ERROR: Node.js not found & pause & exit /b 1)
if not exist node_modules call npm install
echo.
echo Starting server...
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5000"
node src/index.js
pause