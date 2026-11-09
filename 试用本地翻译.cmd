@echo off
cd /d "%~dp0"
title CET-6 Local Translation Trial
if not exist "local-translation\venv\Scripts\python.exe" (
  echo Please run tools\setup_local_translation.ps1 with Python 3.12 first.
  pause
  exit /b 1
)
"local-translation\venv\Scripts\python.exe" -X utf8 "tools\local_translate.py"
if errorlevel 1 pause
