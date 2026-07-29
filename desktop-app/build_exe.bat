@echo off
setlocal EnableDelayedExpansion
title YT Downloader - Build EXE

echo.
echo  ============================================
echo    YT Downloader  ^|  Build Windows .exe
echo  ============================================
echo.

:: ── 1. Resolve the real python.exe (same approach as setup.bat/run.bat) ───────
:: We avoid bare "python"/"py" commands because on some machines cmd.exe
:: fails to resolve them by name even though the files exist (broken PATH).
set "PYTHON_EXE="
if exist "%~dp0python_cmd.txt" (
    set /p PYTHON_EXE=<"%~dp0python_cmd.txt"
)

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

"%PYTHON_EXE%" --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Found "%PYTHON_EXE%" but it would not run. Run setup.bat first.
    pause
    exit /b 1
)
echo  [OK] Using: %PYTHON_EXE%

:: ── 2. Make sure the app's own dependencies are installed ─────────────────────
echo.
echo  [1/4] Making sure app dependencies are installed...
"%PYTHON_EXE%" -m pip install -r "%~dp0requirements.txt" --quiet
if errorlevel 1 (
    echo  [ERROR] Failed to install dependencies from requirements.txt.
    pause
    exit /b 1
)

:: yt-dlp's YouTube extractor breaks often as YouTube changes things, and
:: requirements.txt only has a lower-bound version. Force-upgrade it here so
:: every build bundles the latest fix, instead of whatever was installed
:: locally months ago.
echo  Upgrading yt-dlp to the latest version...
"%PYTHON_EXE%" -m pip install --upgrade yt-dlp --quiet
if errorlevel 1 (
    echo  [ERROR] Failed to upgrade yt-dlp.
    pause
    exit /b 1
)
echo  [OK] Dependencies ready.

:: ── 3. Install PyInstaller ─────────────────────────────────────────────────────
echo.
echo  [2/4] Installing/upgrading PyInstaller...
"%PYTHON_EXE%" -m pip install --upgrade pyinstaller --quiet
if errorlevel 1 (
    echo  [ERROR] Failed to install PyInstaller.
    pause
    exit /b 1
)
echo  [OK] PyInstaller ready.

:: ── 4. Locate or download ffmpeg.exe / ffprobe.exe to bundle ──────────────────
echo.
echo  [3/4] Preparing ffmpeg (to bundle inside the exe)...

set "FFMPEG_EXE="
set "FFPROBE_EXE="

:: Reuse a previously staged copy if this script has already run once.
if exist "%~dp0ffmpeg_bin\ffmpeg.exe" if exist "%~dp0ffmpeg_bin\ffprobe.exe" (
    echo  [OK] Reusing previously staged ffmpeg in ffmpeg_bin\
    set "FFMPEG_EXE=%~dp0ffmpeg_bin\ffmpeg.exe"
    set "FFPROBE_EXE=%~dp0ffmpeg_bin\ffprobe.exe"
    goto GOT_FFMPEG
)

for /f "delims=" %%i in ('where ffmpeg 2^>nul') do if not defined FFMPEG_EXE set "FFMPEG_EXE=%%i"
for /f "delims=" %%i in ('where ffprobe 2^>nul') do if not defined FFPROBE_EXE set "FFPROBE_EXE=%%i"

if defined FFMPEG_EXE if defined FFPROBE_EXE (
    echo  [OK] Found existing ffmpeg: %FFMPEG_EXE%
    echo  [OK] Found existing ffprobe: %FFPROBE_EXE%
    goto GOT_FFMPEG
)

echo  ffmpeg/ffprobe not found on this system — downloading a static build...
set "FFMPEG_ZIP=%TEMP%\ffmpeg-release-essentials.zip"
set "FFMPEG_EXTRACT=%TEMP%\ffmpeg-extract-ytdl"
if exist "%FFMPEG_EXTRACT%" rmdir /s /q "%FFMPEG_EXTRACT%"
if exist "%FFMPEG_ZIP%" del /q "%FFMPEG_ZIP%"

curl -L -o "%FFMPEG_ZIP%" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" >nul 2>&1
if not exist "%FFMPEG_ZIP%" (
    echo  curl failed, trying PowerShell instead...
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile '%FFMPEG_ZIP%' } catch { exit 1 }"
)

if not exist "%FFMPEG_ZIP%" (
    echo.
    echo  [ERROR] Could not download ffmpeg automatically.
    echo  Please download it manually from https://www.gyan.dev/ffmpeg/builds/
    echo  ^(ffmpeg-release-essentials.zip^), extract it, then place ffmpeg.exe
    echo  and ffprobe.exe from its bin\ folder into a "ffmpeg_bin" folder
    echo  next to this script and re-run build_exe.bat.
    echo.
    pause
    exit /b 1
)

echo  Extracting ffmpeg...
powershell -NoProfile -Command "Expand-Archive -Path '%FFMPEG_ZIP%' -DestinationPath '%FFMPEG_EXTRACT%' -Force"

for /f "delims=" %%i in ('dir /s /b "%FFMPEG_EXTRACT%\ffmpeg.exe" 2^>nul') do if not defined FFMPEG_EXE set "FFMPEG_EXE=%%i"
for /f "delims=" %%i in ('dir /s /b "%FFMPEG_EXTRACT%\ffprobe.exe" 2^>nul') do if not defined FFPROBE_EXE set "FFPROBE_EXE=%%i"

if not defined FFMPEG_EXE (
    echo  [ERROR] Downloaded archive did not contain ffmpeg.exe.
    pause
    exit /b 1
)
if not defined FFPROBE_EXE (
    echo  [ERROR] Downloaded archive did not contain ffprobe.exe.
    pause
    exit /b 1
)
echo  [OK] Downloaded ffmpeg: %FFMPEG_EXE%
echo  [OK] Downloaded ffprobe: %FFPROBE_EXE%

:GOT_FFMPEG

:: Copy into a stable local folder so PyInstaller always has a fixed path.
set "FFMPEG_BIN_DIR=%~dp0ffmpeg_bin"
if not exist "%FFMPEG_BIN_DIR%" mkdir "%FFMPEG_BIN_DIR%"
copy /y "%FFMPEG_EXE%" "%FFMPEG_BIN_DIR%\ffmpeg.exe" >nul
copy /y "%FFPROBE_EXE%" "%FFMPEG_BIN_DIR%\ffprobe.exe" >nul
echo  [OK] Staged ffmpeg at: %FFMPEG_BIN_DIR%

:: ── 5. Build the .exe, with ffmpeg bundled inside it ───────────────────────────
echo.
echo  [4/4] Building YT-Downloader.exe (this can take a few minutes)...
echo.

cd /d "%~dp0"

"%PYTHON_EXE%" -m PyInstaller ^
    --noconfirm ^
    --onefile ^
    --windowed ^
    --name "YT-Downloader" ^
    --collect-all customtkinter ^
    --collect-all yt_dlp ^
    --add-binary "%FFMPEG_BIN_DIR%\ffmpeg.exe;ffmpeg" ^
    --add-binary "%FFMPEG_BIN_DIR%\ffprobe.exe;ffmpeg" ^
    downloader.py

if errorlevel 1 (
    echo.
    echo  [ERROR] PyInstaller build failed. See the log above for details.
    pause
    exit /b 1
)

:: ── 6. Copy the finished exe next to this script for convenience ──────────────
if exist "%~dp0dist\YT-Downloader.exe" (
    copy /y "%~dp0dist\YT-Downloader.exe" "%~dp0YT-Downloader.exe" >nul
    echo.
    echo  ============================================
    echo    Build complete!
    echo    Your app:  %~dp0YT-Downloader.exe
    echo    ffmpeg is bundled inside — no separate
    echo    ffmpeg install is needed to run it.
    echo  ============================================
    echo.
) else (
    echo.
    echo  [ERROR] Build finished but the expected exe was not found in dist\.
    echo.
)

pause
