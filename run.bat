@echo off
python downloader.py
if errorlevel 1 (
    echo.
    echo  [ERROR] The app failed to start.
    echo  Make sure you have run setup.bat first.
    echo.
    pause
)
