@echo off
setlocal
cd /d "%~dp0"
where pythonw.exe >nul 2>nul
if not errorlevel 1 (
    start "" pythonw.exe "%~dp0launcher.py"
    exit /b 0
)
python "%~dp0launcher.py"
