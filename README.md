# YT Downloader

Download YouTube videos as MP3 (music) or MP4 (video), by pasting a link or
searching by artist/song or creator/title. This repo has two editions built
from the same core idea:

| Edition | Location | What it is |
|---|---|---|
| **Desktop app (Windows)** | [`desktop-app/`](desktop-app/) | A Python + customtkinter GUI app. Run it from source, or build it into a standalone `.exe` / full Windows installer — no Python needed on the end user's machine. |
| **Web app** | [`web-app/`](web-app/) | A Node.js + Express web port with the same features, deployable to Render, Koyeb, Vercel, Docker, or any similar host. |

Each has its own README with full setup/build/deploy instructions.

---

## Desktop app quick start

```
cd desktop-app
setup.bat        REM installs Python deps
run.bat          REM launches the app
```

To ship a standalone Windows installer (no Python/ffmpeg required on the
target machine):

```
cd desktop-app
build_installer.bat
```

Produces `installer_output\YT-Downloader-Setup.exe`. See
[`desktop-app/README.md`](desktop-app/README.md) for details.

(YT-Downloader-Setup.exe is in the releases section :) )

## Web app quick start

```
cd web-app
npm install
npm start
```

Then open http://localhost:3000. See [`web-app/README.md`](web-app/README.md)
for deployment instructions (Render, Koyeb, Vercel, Docker).

---

## Shared features (both editions)

- **Music mode** — paste a link or search by artist + song, download as
  320kbps MP3.
- **Video mode** — paste a link or search by creator + title, choose
  Best or 1080p quality, download as MP4.
- **"If Video has list, Download everything"** checkbox — unchecked
  (default) downloads only the single requested item even if the link is
  part of a playlist or YouTube "radio mix" (`list=` param); checked
  downloads the whole playlist.

## Notes

- Both editions use [yt-dlp](https://github.com/yt-dlp/yt-dlp) under the
  hood, which needs occasional updates as YouTube changes things — the
  desktop build script force-upgrades it on every build, and the web app's
  `npm install` fetches the latest binary automatically.
- Only use this to download content you have the right to download.
