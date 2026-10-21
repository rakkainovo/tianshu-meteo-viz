@echo off
title Tianshu Meteorological Visualization Platform
cd /d "%~dp0"

echo ==============================================================
echo   Tianshu - National Meteorological Monitoring and
echo   Disaster Warning Spatio-temporal Visualization Platform
echo ==============================================================
echo.

rem ----------------------------------------------------------------------
rem  Pick a virtual environment whose path can actually start Python.
rem
rem  A venv created under a non-ASCII path (Chinese / Japanese folder names)
rem  CANNOT run on Windows at all: its python.exe is a "venv launcher" that
rem  fails to read pyvenv.cfg and exits with a bare
rem        failed to open '...\.venv\pyvenv.cfg':
rem  Mapping the folder to an ASCII drive letter does NOT help either
rem  (both verified 2026-10-08). So: use the in-project .venv when it works,
rem  otherwise fall back to a plain-ASCII location under %LOCALAPPDATA%.
rem ----------------------------------------------------------------------
set "VENV=%~dp0.venv"
set "PY=%VENV%\Scripts\python.exe"

if not exist "%PY%" goto pick_fallback
"%PY%" -c "pass" >nul 2>nul
if not errorlevel 1 goto check
echo [i] In-project .venv cannot start (non-ASCII install path detected).
echo     Falling back to %LOCALAPPDATA%\tianshu-venv

:pick_fallback
set "VENV=%LOCALAPPDATA%\tianshu-venv"
set "PY=%VENV%\Scripts\python.exe"

:check
echo [1/3] Checking dependencies ...
if not exist "%PY%" (
  echo       Creating virtual environment at %VENV% ...
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
  python -m venv "%VENV%"
  if errorlevel 1 ( echo   [ERROR] venv creation failed & pause & exit /b 1 )
)

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
