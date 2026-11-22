@echo off
setlocal
cd /d "%~dp0"
set "PYTHONDONTWRITEBYTECODE=1"
set "EQUITY_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%EQUITY_PYTHON%" set "EQUITY_PYTHON=%~dp0..\..\work\openbb-yahoo\env\Scripts\python.exe"
if not exist "%EQUITY_PYTHON%" (
  echo This copy needs Python 3.12 and its OpenBB packages. See README.md for setup.
  pause
  exit /b 1
)
if /i not "%EQUITY_PYTHON%"=="%~dp0.venv\Scripts\python.exe" (
  echo No .venv in this folder. Using the shared Python outside the project:
  echo   %EQUITY_PYTHON%
  echo Create .venv as described in README.md to run this copy on its own.
)
"%EQUITY_PYTHON%" "%~dp0server.py" --port 8766 --open
if errorlevel 1 pause
