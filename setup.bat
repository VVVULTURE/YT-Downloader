@echo off
setlocal EnableDelayedExpansion
title YT Downloader - Setup

echo.
echo  ============================================
echo    YT Downloader  ^|  First-time Setup
echo  ============================================
echo.

:: ── 1. Check Python ──────────────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python was not found.
    echo.
    echo  Please install Python 3.10 or newer:
    echo    https://www.python.org/downloads/
    echo.
    echo  Make sure to check "Add Python to PATH" during install.
    echo.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo  [OK] Python %PY_VER% found.

:: ── 2. Install Python packages ────────────────────────────────────────────────
echo.
echo  [1/2] Installing Python packages (customtkinter + yt-dlp)...
echo.
pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo.
    echo  [ERROR] pip install failed.
    echo  Try running this script as Administrator, or run manually:
    echo    pip install customtkinter yt-dlp
    echo.
    pause
    exit /b 1
)
echo  [OK] Python packages installed.

:: ── 3. Check / install ffmpeg ─────────────────────────────────────────────────
echo.
echo  [2/2] Checking for ffmpeg...
ffmpeg -version >nul 2>&1
if not errorlevel 1 (
    echo  [OK] ffmpeg is already installed.
    goto DONE
)

echo  ffmpeg not found. Trying to install via winget...
winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements >nul 2>&1
if not errorlevel 1 (
    echo  [OK] ffmpeg installed via winget.
    echo.
    echo  NOTE: You may need to restart this window for ffmpeg to be on PATH.
    goto DONE
)

echo.
echo  ┌─────────────────────────────────────────────────────────────────────┐
echo  │  ffmpeg could not be installed automatically.                        │
echo  │                                                                      │
echo  │  ffmpeg is required for:                                             │
echo  │    - MP3 audio downloads  (Music tab)                                │
echo  │    - Merging video+audio  (best quality)                             │
echo  │                                                                      │
echo  │  To install manually:                                                │
echo  │    1. Go to  https://www.gyan.dev/ffmpeg/builds/                     │
echo  │    2. Download  ffmpeg-release-essentials.zip                        │
echo  │    3. Extract it and copy the 'bin' folder contents to               │
echo  │         C:\ffmpeg\bin\                                               │
echo  │    4. Add  C:\ffmpeg\bin  to your system PATH                        │
echo  │         (System Properties → Advanced → Environment Variables)       │
echo  └─────────────────────────────────────────────────────────────────────┘
echo.
echo  MP4 video downloads may still work without ffmpeg (single-stream only).

:DONE
echo.
echo  ============================================
echo    Setup complete!
echo    Run  run.bat  to launch the app.
echo  ============================================
echo.
pause
