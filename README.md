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

## Music tab

| Field  | What to enter                      |
|--------|------------------------------------|
| Artist | The artist's name, e.g. `Adele`    |
| Song   | The song title, e.g. `Rolling in the Deep` |

The app searches for the **official music video**, automatically excluding live
performances, concerts, covers, acoustic sessions, etc.

**Format:**
- **MP3 (audio only)** — 320 kbps MP3, requires ffmpeg
- **MP4 (music video)** — full video file

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

**Quality:** Best / 1080p / 720p / 480p (Best and 1080p require ffmpeg to merge streams)

---

## Downloads location

Files go to `~/Downloads/YT Downloader/` by default.
Click the **⚙** gear icon in the top-right to change it.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ModuleNotFoundError: customtkinter` | Run `setup.bat` again |
| MP3 download fails | ffmpeg is not on PATH — see setup above |
| Wrong video found (Music) | Try including more of the official title, e.g. `Rolling in the Deep (Official Video)` |
| Wrong video found (Video) | Add more distinctive words from the title |
