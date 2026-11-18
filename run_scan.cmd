@echo off
chcp 65001 >nul
title Swing Radar - Kronos taramasi
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
echo Swing Radar: XU100 + Nasdaq-100 taranıyor (Kronos ekran kartında, ~6 dk)...
echo.
".venv\Scripts\python.exe" -I scan.py
echo.
echo Bitti. Sonuçlar siteye yüklendi: https://claude.ai/artifact/Nx49BRsBpLa5QaLXYFcPmj
start "" "https://claude.ai/artifact/Nx49BRsBpLa5QaLXYFcPmj"
pause
