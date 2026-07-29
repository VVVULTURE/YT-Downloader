@echo off
setlocal EnableDelayedExpansion
title YT Downloader - Build Installer

echo.
echo  ============================================
echo    YT Downloader  ^|  Build Installer (.exe)
echo  ============================================
echo.

cd /d "%~dp0"

:: ── 1. Make sure the standalone app exe exists (build it if missing) ──────────
if not exist "%~dp0dist\YT-Downloader.exe" (
    echo  [1/3] YT-Downloader.exe not found yet — building it first...
    echo.
    call "%~dp0build_exe.bat"
    if not exist "%~dp0dist\YT-Downloader.exe" (
        echo.
        echo  [ERROR] build_exe.bat did not produce dist\YT-Downloader.exe.
        pause
        exit /b 1
    )
) else (
    echo  [1/3] [OK] Found existing dist\YT-Downloader.exe
    echo  ^(Delete the dist\ folder first if you want a fresh rebuild.^)
)

:: ── 2. Locate Inno Setup's compiler (ISCC.exe), installing it if needed ───────
echo.
echo  [2/3] Locating Inno Setup...

set "ISCC_EXE="
for /f "delims=" %%i in ('where ISCC 2^>nul') do if not defined ISCC_EXE set "ISCC_EXE=%%i"
if not defined ISCC_EXE if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC_EXE if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%ProgramFiles%\Inno Setup 6\ISCC.exe"

if defined ISCC_EXE (
    echo  [OK] Found Inno Setup: %ISCC_EXE%
) else (
    echo  Inno Setup not found — downloading and installing it silently...
    set "IS_INSTALLER=%TEMP%\innosetup-installer.exe"
    if exist "!IS_INSTALLER!" del /q "!IS_INSTALLER!"

    set "IS_URL1=https://jrsoftware.org/download.php/is.exe"
    set "IS_URL2=https://files.jrsoftware.org/is/6/innosetup-6.3.3.exe"
    set "IS_OK=0"

    curl -fL -A "Mozilla/5.0" -o "!IS_INSTALLER!" "!IS_URL1!" >nul 2>&1
    if exist "!IS_INSTALLER!" (
        for %%F in ("!IS_INSTALLER!") do if %%~zF GTR 500000 set "IS_OK=1"
    )

    if "!IS_OK!"=="0" (
        echo  First download source failed or was invalid, trying fallback URL...
        if exist "!IS_INSTALLER!" del /q "!IS_INSTALLER!"
        curl -fL -A "Mozilla/5.0" -o "!IS_INSTALLER!" "!IS_URL2!" >nul 2>&1
        if exist "!IS_INSTALLER!" (
            for %%F in ("!IS_INSTALLER!") do if %%~zF GTR 500000 set "IS_OK=1"
        )
    )

    if "!IS_OK!"=="0" (
        echo  curl failed, trying PowerShell instead...
        if exist "!IS_INSTALLER!" del /q "!IS_INSTALLER!"
        powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '!IS_URL1!' -OutFile '!IS_INSTALLER!' -UserAgent 'Mozilla/5.0' } catch { exit 1 }"
        if exist "!IS_INSTALLER!" (
            for %%F in ("!IS_INSTALLER!") do if %%~zF GTR 500000 set "IS_OK=1"
        )
    )

    if "!IS_OK!"=="0" (
        echo.
        echo  [ERROR] Could not download a valid Inno Setup installer
        echo  automatically ^(the download may have been blocked by your
        echo  network/firewall^). Install it manually from:
        echo    https://jrsoftware.org/isdl.php
        echo  then re-run this script — it will detect the install and
        echo  skip straight to compiling.
        echo.
        pause
        exit /b 1
    )

    echo  Installing Inno Setup ^(silent^)...
    "!IS_INSTALLER!" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-

    if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
    if not defined ISCC_EXE if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC_EXE=%ProgramFiles%\Inno Setup 6\ISCC.exe"

    if not defined ISCC_EXE (
        echo.
        echo  [ERROR] Inno Setup installed but ISCC.exe still could not be found.
        echo  Try installing manually from https://jrsoftware.org/isdl.php
        echo.
        pause
        exit /b 1
    )
    echo  [OK] Inno Setup installed: %ISCC_EXE%
)

:: ── 3. Compile the installer ────────────────────────────────────────────────
echo.
echo  [3/3] Compiling YT-Downloader-Setup.exe...
echo.

"%ISCC_EXE%" "%~dp0installer.iss"
if errorlevel 1 (
    echo.
    echo  [ERROR] Inno Setup compilation failed. See the log above for details.
    pause
    exit /b 1
)

if exist "%~dp0installer_output\YT-Downloader-Setup.exe" (
    echo.
    echo  ============================================
    echo    Installer built!
    echo    %~dp0installer_output\YT-Downloader-Setup.exe
    echo.
    echo    Share that single file — running it installs
    echo    YT Downloader to Program Files, adds Start Menu
    echo    / optional Desktop shortcuts, and an uninstaller.
    echo    No Python, ffmpeg, or anything else needs to be
    echo    installed separately on the target machine.
    echo  ============================================
    echo.
) else (
    echo.
    echo  [ERROR] Expected installer_output\YT-Downloader-Setup.exe was not found.
    echo.
)

pause
