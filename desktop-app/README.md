# YT Downloader

A simple Windows 11 desktop app to download music and YouTube videos.

---

## Requirements

- **Python 3.10+** — https://www.python.org/downloads/
  (check "Add Python to PATH" during install)
- **ffmpeg** — needed for MP3 conversion and best-quality video merging
  (setup.bat tries to install it automatically via winget)

---

## Setup (first time only)

Double-click **setup.bat**. It will:
1. Install `customtkinter` and `yt-dlp` via pip
2. Try to install ffmpeg via winget (Windows 11 built-in package manager)

If winget fails, install ffmpeg manually:
1. Download from https://www.gyan.dev/ffmpeg/builds/ → `ffmpeg-release-essentials.zip`
2. Extract and place the `bin/` contents in `C:\ffmpeg\bin\`
3. Add `C:\ffmpeg\bin` to your system PATH

---

## Running the app

Double-click **run.bat** (or `python downloader.py`).

---

## Building a standalone .exe

Double-click **build_exe.bat**. It will:
1. Make sure `customtkinter` and `yt-dlp` are installed
2. Install/upgrade PyInstaller
3. Locate ffmpeg/ffprobe on your system, or automatically download a static
   build if they aren't found
4. Compile `downloader.py` into `YT-Downloader.exe`, with the app icon
   (`assets/YT-Downloader.ico`) and ffmpeg bundled inside it

When it finishes, `YT-Downloader.exe` will be sitting next to this README —
you can move/share that single file and run it on any Windows 10/11 machine
with **no separate Python or ffmpeg install needed**.

---

## Building a full installer (recommended for sharing)

(YT-Downloader-Setup.exe is in the realeases section :) )

Double-click **build_installer.bat**. It will:
1. Build `YT-Downloader.exe` first if it doesn't already exist (via
   `build_exe.bat`)
2. Locate Inno Setup 6 or 7, or automatically download and silently install
   it if it isn't on your system
3. Compile `YT-Downloader-Setup.exe` into `installer_output\`

Share that one `YT-Downloader-Setup.exe` file. Running it on someone's
Windows 10/11 PC will:
- Install the app to `Program Files\YT Downloader`
- Add a Start Menu shortcut (and optional Desktop shortcut)
- Register a proper uninstaller (Settings → Apps, or Control Panel)
- Work immediately after install — no Python, ffmpeg, or anything else
  needs to be installed separately

Requires admin rights to install (standard for anything installing to
Program Files), same as any normal Windows application installer.

---

## Music tab

| Field  | What to enter                      |
|--------|------------------------------------|
| Artist | The artist's name, e.g. `Adele`    |
| Song   | The song title, e.g. `Rolling in the Deep` |

The app searches for the **official music video**, automatically excluding live
performances, concerts, covers, acoustic sessions, etc.

**Format:**
- **MP3 (audio only)** — requires ffmpeg
- **MP4 (music video)** — full video file

**Audio Bitrate slider** — 128 / 160 / 192 / 256 / 320 kbps for the MP3.
Leave it where it starts (320 kbps) for the same quality as before.

---

## Video tab

| Field   | What to enter                                    |
|---------|--------------------------------------------------|
| Creator | The channel name, e.g. `Linus Tech Tips`         |
| Title   | Approximate title, e.g. `RTX 5090 benchmarks`   |

The app scores every search result by:
- How closely the channel name matches the creator you entered
- How closely the video title matches your query (word-level fuzzy matching)

It picks the highest-scoring result and downloads it.

**Max Video Bitrate slider** — cap the download at ≤ 2 / 4 / 6 / 8 / 12 / 16 /
20 Mbps, or leave it at **Max** (the default) to take the best available
stream with no limit. Lowering it trades quality for a much smaller file.
(ffmpeg is needed to merge the video + audio streams.)

---

## Downloads location

Two separate output folders, shown below the tabs in the app:
- **Music Output Folder** — defaults to `~\Music\YT-Music`
- **Video Output Folder** — defaults to `~\Videos\YT-Videos`

Click **Browse** next to either one to change it, or **Open** to open that
folder in File Explorer. Your choice is remembered between runs.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ModuleNotFoundError: customtkinter` | Run `setup.bat` again |
| MP3 download fails | ffmpeg is not on PATH — see setup above |
| Wrong video found (Music) | Try including more of the official title, e.g. `Rolling in the Deep (Official Video)` |
| Wrong video found (Video) | Add more distinctive words from the title |
| "Download Error" popup / `HTTP Error 403: Forbidden` | Almost always YouTube's extractor needing an update. The app now **auto-updates yt-dlp** on its own: it keeps a fresh copy in `%LOCALAPPDATA%\YT-Downloader` and refreshes it from GitHub in the background (applied on next launch). If it just happened, close and reopen the app once. It also retries each download against several YouTube "player clients" before showing the error. As a last resort, rebuild via `build_exe.bat` (force-upgrades yt-dlp), or delete `%LOCALAPPDATA%\YT-Downloader` and relaunch to force a fresh download. |
