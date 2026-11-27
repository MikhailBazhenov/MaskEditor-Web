@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    py -3 -m venv .venv 2>nul
    if errorlevel 1 python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
    echo Python 3 not found. Install Python from python.org and run again.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo Failed to install Pillow. Check internet connection and try again.
    pause
    exit /b 1
)
if "%~1"=="" (
    set "DATA=%CD%\sample_data"
) else (
    set "DATA=%~1"
)
".venv\Scripts\python.exe" server.py --data "%DATA%"
pause
