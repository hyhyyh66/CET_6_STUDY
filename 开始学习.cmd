@echo off
cd /d "%~dp0"
title CET-6 Reading Notebook
"runtime\python.exe" -X utf8 "server.py" --open
if errorlevel 1 pause
