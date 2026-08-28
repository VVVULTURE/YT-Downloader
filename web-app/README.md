# YT Downloader — Web

A browser-based port of the desktop YT Downloader app. Paste a YouTube link
(or search by artist/song or creator/title), and download the result as an
MP3 or MP4 straight from your browser. No install required for end users —
just visit the deployed site.

Built with Node.js + Express, using [yt-dlp](https://github.com/yt-dlp/yt-dlp)
for extraction and a bundled static `ffmpeg` for audio extraction / video
merging.

---

## Features

- **Music tab** — paste a link, or search by artist + song. Downloads as
  MP3 with an **Audio Bitrate** slider (128 / 160 / 192 / 256 / 320 kbps;
  default 320).
- **Video tab** — paste a link, or search by creator + title. Choose
  **Best** or **1080p**, and set a **Max Video Bitrate** cap (≤ 2 … 20 Mbps,
  or **Max** for no limit — the default). Downloads as MP4.
- Stays working as YouTube changes — `yt-dlp -U` runs on boot and once a
  day, `npm install` always pulls the latest yt-dlp release into `bin/`, and
  each download retries against several YouTube "player clients" if the
  first hits `HTTP Error 403: Forbidden`.
- **"If Video has list, Download everything"** checkbox on both tabs —
  unchecked (default) downloads only the single requested item even if the
  link is part of a playlist or YouTube "radio mix"; checked downloads the
  whole playlist as a `.zip`.
- No server-side storage — each request downloads into a temp folder,
  streams the result straight to your browser, then cleans up.

---

## Running locally

Requires [Node.js](https://nodejs.org/) 18+.

```bash
cd web-app
npm install     # also downloads a yt-dlp binary into bin/ automatically
npm start
```

Then open **http://localhost:3000**.

> The first `npm install` downloads a yt-dlp binary from GitHub's "latest
> release" URL (not the GitHub API, which is rate-limited) into `bin/`.
> If that ever fails on a restricted network, install yt-dlp yourself
> (e.g. `pip install yt-dlp`) and set the `YTDLP_PATH` environment variable
> to point at it.

---

## Deploying

### Render / Koyeb (recommended)

Both support long-running Node servers with no strict request-time limit,
which matters for anything beyond a very short clip.

- **Render**: push this repo, create a new **Web Service**, point it at the
  `web-app/` folder (or use the included `render.yaml` via Render's Blueprint
  deploy). Build command `npm install`, start command `node server.js`.
- **Koyeb**: create a new app from this repo (or the included `Dockerfile`),
  set the working directory / Dockerfile path to `web-app/`. Koyeb will pick
  up `PORT` automatically.

### Vercel

Vercel works too, via the included `vercel.json`, but keep its limits in
mind:
- Serverless functions have a **execution time limit** (10–60s on the free
  Hobby plan, up to 900s on Pro). Short audio clips will usually finish in
  time; longer videos may time out.
- The filesystem is **read-only except `/tmp`**, which `server.js` already
  uses for temp downloads — no changes needed there.
- Bundled binaries occasionally lose their executable bit when packaged;
  `server.js` re-applies `chmod 755` at request time as a safety net.

For heavy/long-video use, Render or Koyeb will be more reliable than Vercel.

### Docker (Render, Koyeb, Fly.io, your own VPS, etc.)

```bash
docker build -t yt-downloader-web .
docker run -p 3000:3000 yt-downloader-web
```

---

## API

- `GET /api/health` — reports whether yt-dlp and ffmpeg are present and
  working.
- `POST /api/download` — body:
  ```json
  {
    "mode": "music",           // or "video"
    "link": "https://...",     // optional if query1/query2 given
    "query1": "Artist or Creator",
    "query2": "Song or Title",
    "quality": "1080p",        // video only: "best" or "1080p"
    "audioKbps": 320,          // music only: 128|160|192|256|320 (default 320)
    "videoMaxMbps": null,      // video only: bitrate cap in Mbit/s, null = no cap
    "downloadPlaylist": false
  }
  ```
  Returns the media file directly (or a `.zip` if a playlist was requested
  and multiple files were downloaded), or a JSON `{ error, details }` on
  failure.

---

## Notes / limitations

- This is a single-user tool by design — there's no auth, queueing, or rate
  limiting built in. If you deploy it publicly, consider adding some
  (e.g. a shared password gate) so it isn't wide open to anyone on the
  internet.
- Only use this to download content you have the right to download.
