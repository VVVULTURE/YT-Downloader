# YT Downloader — Web

A browser-based port of the desktop YT Downloader app. Paste a YouTube link
(or search by artist/song or creator/title), and download the result as an
MP3 or MP4 straight from your browser. No install required for end users —
just visit the deployed site.

Built with Node.js + Express. The **server** is a thin [yt-dlp](https://github.com/yt-dlp/yt-dlp)
fetch proxy — it resolves the URL, gets past YouTube's player API, and streams
the raw media track(s). The **browser** does the heavy lifting: MP3 transcoding
with [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) and playlist `.zip`
assembly with [JSZip](https://stuk.github.io/jszip/). See
[Where the work runs](#where-the-work-runs) below.

---

## Features

- **Music tab** — paste a link, or search by artist + song. Downloads as
  MP3 with an **Audio Bitrate** slider (128 / 160 / 192 / 256 / 320 kbps;
  default 320).
- **Video tab** — paste a link, or search by creator + title. Pick a
  **Resolution** (Best / 2160p / 1440p / 1080p / 720p / 480p / 360p;
  default 1080p) and set a **Max Video Bitrate** cap (≤ 2 … 20 Mbps, or
  **Max** for no limit — the default). Downloads as MP4. The resolution is
  a **ceiling**: a video whose highest quality is below your pick still
  downloads at its best. If the pick is genuinely unavailable for a video,
  the download stops and asks you to choose a different one.
- Stays working as YouTube changes — `yt-dlp -U` runs on boot and once a
  day, `npm install` always pulls the latest yt-dlp release into `bin/`, and
  each download retries against several YouTube "player clients" if the
  first hits `HTTP Error 403: Forbidden`.
- **"If Video has list, Download everything"** checkbox on both tabs —
  unchecked (default) downloads only the single requested item even if the
  link is part of a playlist or YouTube "radio mix"; checked downloads the
  whole playlist as a `.zip` (assembled in your browser).
- No server-side storage — each request downloads into a temp folder,
  streams the result straight to your browser, then cleans up.

---

## Where the work runs

To keep the (free-tier) server light, only the parts that *need* yt-dlp run
server-side; everything else runs in your browser.

| Task | Runs on | Notes |
|---|---|---|
| Resolve URL / search, get past YouTube's player API, pick the `-f` format string, client-rotation retries | **server** | needs yt-dlp; microseconds of CPU |
| Download the raw media track(s) | **server** | streamed straight through, nothing stored |
| Mux video-only + audio-only → MP4 | **server** | just a `-c copy` remux, nearly free |
| **Transcode audio → MP3** at the chosen bitrate | **browser** | multi-threaded `ffmpeg.wasm`; the heaviest job, and the reason it moved |
| **Assemble a playlist into one `.zip`** | **browser** | JSZip, from a single multi-file response |

**In-browser MP3 needs the page to be cross-origin isolated.** `server.js`
sends `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp` for that (safe — the app loads
zero third-party resources). If a browser ends up not isolated, or the
`ffmpeg.wasm` core (~33 MB, cached after first load) fails to load, the app
silently falls back to asking the **server** to transcode. `GET /api/health`
reports `crossOriginIsolationHeaders` and `ffmpegWasmStaged`; the footer line
shows `MP3: in-browser` or `MP3: server`.

**Browser-memory ceiling:** the whole download is held in RAM to process it
(~2 GB cap per tab). Fine for audio and single 1080p videos; a very long 4K
video or a large playlist can run a phone out of memory — use the desktop
site or smaller picks for those.

`npm install` stages `ffmpeg.wasm` + JSZip (~35 MB, mostly the wasm core)
into `public/vendor/` via `scripts/setup-wasm.js`. That folder is
git-ignored and rebuilt on every install; if staging fails the server still
boots and just uses the server-side fallback.

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

### Render (recommended)

This repo is a monorepo — the web app is the `web-app/` subfolder — so the
key setting is telling Render to build **from that folder**.

**Option A — manual Web Service (most control):**

1. **New +** → **Web Service** → connect this GitHub repo.
2. **Root Directory**: `web-app`  ← this is the important one.
3. **Runtime**: `Node`
4. **Build Command**: `npm install`
5. **Start Command**: `node server.js`
6. **Instance Type**: `Free` is fine (see keep-alive below).
7. **Health Check Path** (Advanced): `/healthz`
8. **Environment Variables** (Advanced) — all optional:
   - `NODE_VERSION` = `20`
   - `KEEPALIVE_MINUTES` = `13` (only if you want to change the default)

   You do **not** need to set a keep-alive URL — Render injects
   `RENDER_EXTERNAL_URL` automatically and the server uses it.
9. **Create Web Service**. First build takes a few minutes (it downloads
   yt-dlp and a static ffmpeg). When it's live, open the `.onrender.com` URL.

Every push to the repo's default branch redeploys automatically.

**Option B — Blueprint (one click):** **New +** → **Blueprint** → pick this
repo. Render reads the root **`render.yaml`**, which already sets
`rootDir: web-app` and the values above.

### Koyeb

Create a new app from this repo (or the included `Dockerfile`), set the
working directory / Dockerfile path to `web-app/`. Koyeb picks up `PORT`
automatically.

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

## Keep-alive (free-tier spin-down)

Render's free instances go to sleep after ~15 minutes with no inbound
traffic, and the next visitor then waits ~30–60s for a cold start. To avoid
that, `server.js` pings its own public URL every **13 minutes** (just enough
to count as traffic).

- On **Render** it works with zero setup — `RENDER_EXTERNAL_URL` is provided
  automatically.
- **Anywhere else**, set `KEEPALIVE_URL` to the app's public base URL
  (e.g. `https://my-app.example.com`).
- `KEEPALIVE_MINUTES` overrides the interval; with no URL known (local dev)
  the self-ping is disabled and the startup log says so.

The ping hits `GET /healthz` (returns `ok`), which is also a good target for
an external uptime monitor.

---

## YouTube bot check ("Sign in to confirm you're not a bot")

YouTube shows this for requests coming from a **datacenter IP** — which is
every host (Render, Fly, a VPS, CI). It's not a bug and there's no flag that
turns it off; the same download works fine from your laptop's home
connection. The reliable fix is to give yt-dlp a **cookies file** from a
logged-in YouTube account.

> **Use a throwaway Google account, not your main one.** yt-dlp's own docs
> warn the account can get rate-limited or banned when used this way.

### 1. Export `cookies.txt`

Do it from a **private / incognito window** so the session doesn't rotate:

1. Open a private window, sign in to YouTube (throwaway account).
2. In that same tab, go to `https://www.youtube.com/robots.txt`.
3. With a "cookies.txt" browser extension (e.g. *Get cookies.txt LOCALLY*),
   export cookies for **youtube.com** → save as `cookies.txt` (Netscape
   format).
4. **Close the private window** — don't reopen that session.

Re-export every few weeks; if downloads start failing again with the bot
message, the cookies have expired.

### 2. Give it to the app

- **Local**: drop `cookies.txt` in the `web-app/` folder (it's gitignored).
- **Render**: service → **Environment** → **Secret Files** → **Add Secret
  File**, filename `cookies.txt`, paste the contents. Render mounts it at
  `/etc/secrets/cookies.txt`, which the app checks automatically. Redeploy.
- **Custom path**: set the `COOKIES_FILE` env var to wherever the file is.

`GET /api/health` reports `cookiesLoaded` so you can confirm it was picked
up. **Never commit `cookies.txt`** — it's account credentials.

---

## "Requested format is not available" on a server

Different from the bot check. This means YouTube let the request through
but is refusing to hand this server real video formats for that video
(SABR streaming / a missing PO token — worse from datacenter IPs).

The server already mitigates this: it needs a **JavaScript runtime** to
solve YouTube's player challenges and uses the Node binary it's already
running (`--js-runtimes node`); it asks for PO-token-gated formats anyway
(`formats=missing_pot`, often still downloadable); and it rotates through
`tv_simply` / `mweb` / mobile clients that don't need a PO token.

To see exactly how far YouTube lets your deployment get, hit
**`GET /api/health?probe=1`** — it runs a real extraction against a known
public video and reports which player client worked and what heights it
saw, or the blocking error. If that shows `extraction.ok: false`,
add/refresh `cookies.txt` (above); a fresh cookies file from a throwaway
account is still the most reliable fix.

---

## API

- `GET /healthz` — returns `ok` (plain text). Used by the keep-alive ping
  and suitable for an uptime monitor / Render health check.
- `GET /api/health` — reports whether yt-dlp, ffmpeg and a cookies file are
  present (`cookiesLoaded`), the JS runtime path, `crossOriginIsolationHeaders`,
  and `ffmpegWasmStaged`. Add `?probe=1` to also run a real extraction test and
  report the working player client + heights (or the blocking error) as
  `extraction`.
- `POST /api/download` — body:
  ```json
  {
    "mode": "music",            // or "video"
    "link": "https://...",      // optional if query1/query2 given
    "query1": "Artist or Creator",
    "query2": "Song or Title",
    "resolution": "1080",       // video only: "best"|"2160"|"1440"|"1080"|"720"|"480"|"360" (default "1080")
    "audioKbps": 320,           // music only: 128|160|192|256|320 (default 320)
    "videoMaxMbps": null,       // video only: bitrate cap in Mbit/s, null = no cap
    "downloadPlaylist": false,
    "assembleClient": false,    // browser will assemble multi-file responses (JSZip)
    "transcodeClient": false    // browser will transcode audio -> MP3 (ffmpeg.wasm)
  }
  ```
  On success the response carries an **`X-Ytdl-Kind`** header telling the
  client what the body is:
  - `media` — a finished file, save as-is (`Content-Disposition` names it).
  - `audio` — one raw audio track; transcode to MP3 at `X-Ytdl-Bitrate`, save
    as `${X-Ytdl-Name}.mp3`.
  - `media-multi` / `audio-multi` — a length-prefixed multi-file stream
    (`uint16BE nameLen │ name │ uint64BE dataLen │ data`, repeated,
    `X-Ytdl-Count` files); zip them (transcoding each first for `audio-multi`).

  With both extra flags absent/false the server does all of that itself and
  always returns `media` (a file, or a server-built `.zip`) — so old clients
  still work.

  Errors are JSON `{ error, details }`. A `409 { error }` means the requested
  resolution isn't available for that video — pick a different one.

---

## Notes / limitations

- This is a single-user tool by design — there's no auth, queueing, or rate
  limiting built in. If you deploy it publicly, consider adding some
  (e.g. a shared password gate) so it isn't wide open to anyone on the
  internet.
- Only use this to download content you have the right to download.
