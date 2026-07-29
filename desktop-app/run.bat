@echo off
setlocal EnableDelayedExpansion

:: Use the exact absolute python.exe path setup.bat found and verified.
set "PYTHON_EXE="
if exist "%~dp0python_cmd.txt" (
    set /p PYTHON_EXE=<"%~dp0python_cmd.txt"
)

:: Fall back to re-detecting via "where" if setup.bat hasn't been run yet.
if not defined PYTHON_EXE (
    for /f "delims=" %%i in ('where python 2^>nul') do (
        echo %%i | findstr /I "WindowsApps" >nul
        if errorlevel 1 (
            if not defined PYTHON_EXE set "PYTHON_EXE=%%i"
        )
    )
)
if not defined PYTHON_EXE (
    for /f "delims=" %%i in ('where py 2^>nul') do (
        if not defined PYTHON_EXE set "PYTHON_EXE=%%i"
    )
)
if not defined PYTHON_EXE (
    echo  [ERROR] Python was not found. Run setup.bat first.
    pause
    exit /b 1
)

"%PYTHON_EXE%" "%~dp0downloader.py"
if errorlevel 1 (
    echo.
    echo  [ERROR] The app failed to start.
    echo  Make sure you have run setup.bat first.
    echo.
    pause
)
