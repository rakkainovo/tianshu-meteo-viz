@echo off
title Tianshu Meteorological Visualization Platform
cd /d "%~dp0"

echo ==============================================================
echo   Tianshu - National Meteorological Monitoring and
echo   Disaster Warning Spatio-temporal Visualization Platform
echo ==============================================================
echo.

rem ---- Use project-local venv so it runs on any machine ----
set "PY=%~dp0.venv\Scripts\python.exe"
if exist "%PY%" goto check

echo [1/3] No local venv found, creating one ...
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] Python not found. Please install Python 3.10+ first
  echo           and check "Add Python to PATH" during setup.
  echo           Download: https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)
python -m venv .venv
if errorlevel 1 ( echo   [ERROR] venv creation failed & pause & exit /b 1 )
set "PY=%~dp0.venv\Scripts\python.exe"

:check
echo [1/3] Checking dependencies ...
"%PY%" -c "import flask, curl_cffi" >nul 2>nul
if errorlevel 1 (
  echo       Installing dependencies from requirements.txt ...
  "%PY%" -m pip install -q --disable-pip-version-check -r requirements.txt
  if errorlevel 1 ( echo   [ERROR] pip install failed, check network & pause & exit /b 1 )
)
echo       Dependencies OK

echo [2/3] Checking dataset ...
if not exist "data\meteo.db" (
  echo       Database not found, building ...
  "%PY%" server\db.py
  if errorlevel 1 ( echo   [ERROR] database build failed & pause & exit /b 1 )
)
echo       Dataset OK

echo [3/3] Starting server ...
echo.
echo   Open: http://127.0.0.1:5000
echo   Close this window to stop the server.
echo.
start "" http://127.0.0.1:5000
"%PY%" server\app.py --port 5000

pause
