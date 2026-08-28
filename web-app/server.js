'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
// archiver is pinned to the v7 line: v8 went ESM-only and dropped this
// factory-function API, which would need Node 20.19+ for require(ESM).
const archiver = require('archiver');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Allow overriding where the yt-dlp binary lives (e.g. if you installed it
// system-wide via `pip install yt-dlp` instead of using the bundled copy).
const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// YouTube shows "Sign in to confirm you're not a bot" for requests from
// datacenter IPs (i.e. basically every host — Render, Fly, a VPS). The only
// reliable fix is a cookies.txt from a logged-in (ideally throwaway) YouTube
// account. Drop the file at any of these paths and it's used automatically:
//   - $COOKIES_FILE (an explicit path you set)
//   - cookies.txt next to server.js        (good for local dev; gitignored)
//   - /etc/secrets/cookies.txt             (Render "Secret Files" default)
// See web-app/README.md for how to export it. With no file present the app
// still runs — it just can't get past the bot check on a server.
const COOKIES_FILE = [
  process.env.COOKIES_FILE,
  path.join(__dirname, 'cookies.txt'),
  '/etc/secrets/cookies.txt',
].find((p) => p && fs.existsSync(p)) || null;

const COOKIE_ARGS = COOKIES_FILE ? ['--cookies', COOKIES_FILE] : [];

// ── Scoring helpers (ported from the desktop app's search-fallback logic) ──
const scoringConfig = {
  music: {
    blacklist: ['live', 'concert', 'performance', 'stage', 'acoustic', 'cover', 'karaoke'],
  },
};

// Rough JS equivalent of Python's difflib.SequenceMatcher.ratio() using a
// bigram Dice coefficient — good enough for ranking search results.
function similarity(a, b) {
  a = (a || '').toLowerCase();
  b = (b || '').toLowerCase();
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const bigrams = (s) => {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.substring(i, i + 2));
    return out;
  };
  const aBig = bigrams(a);
  const bBig = bigrams(b);
  if (!aBig.length || !bBig.length) return 0;
  let matches = 0;
  const bCopy = bBig.slice();
  for (const bg of aBig) {
    const idx = bCopy.indexOf(bg);
    if (idx !== -1) {
      matches++;
      bCopy.splice(idx, 1);
    }
  }
  return (2 * matches) / (aBig.length + bBig.length);
}

function scoreMusic(entry, artist, song) {
  let score = 0;
  const title = (entry.title || '').toLowerCase();
  const channel = (entry.channel || entry.uploader || '').toLowerCase();

  const s = similarity(song, title);
  if (s > 0) score += Math.floor(s * 40);
  if (artist && channel.includes(artist.toLowerCase())) score += 25;
  if (channel.includes('vevo')) score += 10;

  for (const b of scoringConfig.music.blacklist) {
    if (title.includes(b) && title.split(' ').length > 3) score -= 20;
  }
  return score;
}

function scoreVideo(entry, creator, titleQ) {
  let score = 15;
  const channel = (entry.channel || entry.uploader || '').toLowerCase();
  const creatorLc = (creator || '').trim().toLowerCase();
  if (creatorLc && channel.includes(creatorLc)) score += 30;
  const title = (entry.title || '').toLowerCase();
  score += Math.floor(similarity(titleQ, title) * 45);
  return score;
}

// ── Bitrate helpers (mirror the desktop app's Audio/Video bitrate sliders) ──
const AUDIO_KBPS_CHOICES = [128, 160, 192, 256, 320];

function clampAudioKbps(v) {
  const n = Math.round(Number(v));
  return AUDIO_KBPS_CHOICES.includes(n) ? n : 320; // 320 = the previous default
}

// Build the yt-dlp -f string for a video download.
//   quality       : "best" (no height cap) or "1080p" (<=1080)
//   videoMaxMbps  : cap on video bitrate in Mbit/s, or falsy for no cap ("Max")
// Each clause falls back to the next so a video whose formats don't report a
// bitrate (or that has nothing under the cap) still downloads.
function buildVideoFormat(quality, videoMaxMbps) {
  const h = quality === 'best' ? '' : '[height<=1080]';
  const mbps = Number(videoMaxMbps);
  const clauses = [];
  if (mbps > 0) {
    const cap = Math.round(mbps * 1000); // yt-dlp vbr/tbr filters are in KBit/s
    clauses.push(`bestvideo${h}[vbr<=${cap}]+bestaudio`);
    clauses.push(`bestvideo${h}[tbr<=${cap}]+bestaudio`);
    clauses.push(`best${h}[tbr<=${cap}]`);
  }
  clauses.push(`bestvideo${h}+bestaudio`);
  clauses.push(`best${h}`);
  clauses.push('bestvideo+bestaudio');
  clauses.push('best'); // absolute last resort
  return [...new Set(clauses)].join('/');
}

// ── yt-dlp process helpers ────────────────────────────────────────
function ensureExecutable(filePath) {
  // Some serverless platforms (notably Vercel) can strip the executable bit
  // off bundled binaries when packaging a function. This is a harmless
  // no-op on platforms where the bit is already set (Render, Koyeb, local).
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (_) {
    /* ignore — best-effort only */
  }
}

function runYtDlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(YTDLP_PATH)) {
      reject(
        new Error(
          `yt-dlp binary not found at ${YTDLP_PATH}. Run "npm install" again, or set YTDLP_PATH.`
        )
      );
      return;
    }
    ensureExecutable(YTDLP_PATH);
    if (fs.existsSync(ffmpegPath)) ensureExecutable(ffmpegPath);
    execFile(
      YTDLP_PATH,
      args,
      { maxBuffer: 1024 * 1024 * 64, ...options },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

// Keep yt-dlp current. YouTube breaks old builds within weeks (every download
// starts 403ing), and a container/CDN can hand us a stale bin/yt-dlp from an
// earlier deploy. `yt-dlp -U` replaces the binary in place with the latest
// release. Runs on boot and once a day after that; failures are non-fatal.
function selfUpdateYtDlp() {
  if (!fs.existsSync(YTDLP_PATH)) return;
  ensureExecutable(YTDLP_PATH);
  execFile(YTDLP_PATH, ['-U'], { timeout: 120000 }, (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`.trim();
    if (err) {
      console.error(`[yt-dlp -U] update check failed (non-fatal): ${err.message}`);
    } else if (out) {
      console.log(`[yt-dlp -U] ${out.split('\n').pop()}`);
    }
  });
}

async function searchYouTube(query, limit) {
  const { stdout } = await runYtDlp([
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    ...COOKIE_ARGS,
    `ytsearch${limit}:${query}`,
  ]);
  const data = JSON.parse(stdout);
  return data.entries || [];
}

// ── Keep-alive self-ping ───────────────────────────────────────
// Render's free tier spins a web service down after ~15 min with no inbound
// traffic (the next visitor then waits ~30-60s for a cold start). Pinging our
// own public URL on a timer keeps it warm. Render sets RENDER_EXTERNAL_URL
// automatically; on other hosts set KEEPALIVE_URL yourself. With neither set
// (local dev) the self-ping is simply disabled.
const KEEPALIVE_URL = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '')
  .trim()
  .replace(/\/+$/, '');
const KEEPALIVE_MINUTES = Math.max(1, Number(process.env.KEEPALIVE_MINUTES) || 13);

function keepAlivePing() {
  const target = `${KEEPALIVE_URL}/healthz`;
  fetch(target, {
    headers: { 'User-Agent': 'yt-downloader-keepalive' },
    signal: AbortSignal.timeout(30000),
  })
    .then((r) => {
      if (!r.ok) console.error(`[keep-alive] ${target} -> HTTP ${r.status}`);
    })
    .catch((e) => console.error(`[keep-alive] ${target} failed: ${e.message || e}`));
}

// ── API routes ───────────────────────────────────────────────────

// Ultra-light endpoint for the keep-alive ping (and any external uptime
// monitor). `/api/health` is the richer diagnostic one.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

app.get('/api/health', async (req, res) => {
  const ytdlpExists = fs.existsSync(YTDLP_PATH);
  let ytdlpVersion = null;
  if (ytdlpExists) {
    try {
      const { stdout } = await runYtDlp(['--version']);
      ytdlpVersion = stdout.trim();
    } catch (e) {
      ytdlpVersion = `error: ${e.message}`;
    }
  }
  res.json({
    ok: true,
    ytdlpPath: YTDLP_PATH,
    ytdlpPresent: ytdlpExists,
    ytdlpVersion,
    ffmpegPath,
    ffmpegPresent: fs.existsSync(ffmpegPath),
    cookiesFile: COOKIES_FILE,
    cookiesLoaded: Boolean(COOKIES_FILE),
  });
});

/**
 * POST /api/download
 * body: {
 *   mode: "music" | "video",
 *   link: string,            // direct YouTube URL (optional if search terms given)
 *   query1: string,          // artist (music) or creator (video)
 *   query2: string,          // song (music) or title (video)
 *   quality: "best" | "1080p" (video only),
 *   audioKbps: 128|160|192|256|320   (music only, default 320),
 *   videoMaxMbps: number | null      (video only, cap in Mbit/s; null = no cap),
 *   downloadPlaylist: boolean
 * }
 *
 * Streams back either a single media file, or (when a playlist is
 * downloaded) a .zip of all files in the playlist.
 */
app.post('/api/download', async (req, res) => {
  const {
    mode = 'music',
    link = '',
    query1 = '',
    query2 = '',
    quality = '1080p',
    audioKbps = 320,
    videoMaxMbps = null,
    downloadPlaylist = false,
  } = req.body || {};

  const trimmedLink = (link || '').trim();

  if (!trimmedLink && !query1 && !query2) {
    res.status(400).json({ error: 'Please provide a URL or search terms.' });
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));

  try {
    let url = trimmedLink;

    if (!url) {
      const query =
        mode === 'music'
          ? query1 && query2
            ? `${query1} ${query2}`
            : query1
            ? `'${query1}' official music video`
            : `'${query2}' song official`
          : query1 && query2
          ? `${query1} ${query2}`
          : query1
          ? `'${query1}' official videos`
          : `'${query2}' video official`;

      const entries = await searchYouTube(query, mode === 'music' ? 10 : 20);
      if (!entries.length) {
        res.status(404).json({ error: 'No matching videos found via search.' });
        return;
      }

      const scored = entries.map((e) => ({
        entry: e,
        score: mode === 'music' ? scoreMusic(e, query1, query2) : scoreVideo(e, query1, query2),
      }));
      scored.sort((a, b) => b.score - a.score);
      url = `https://www.youtube.com/watch?v=${scored[0].entry.id}`;
    }

    const outTemplate = path.join(workDir, '%(title)s-%(id)s.%(ext)s');
    const args = [
      '--no-warnings',
      '--ffmpeg-location', ffmpegPath,
      '--retries', '5',
      '--fragment-retries', '10',
      ...COOKIE_ARGS,
      '-o', outTemplate,
    ];

    if (!downloadPlaylist) {
      args.push('--no-playlist');
    }

    if (mode === 'music') {
      args.push(
        '-f', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', `${clampAudioKbps(audioKbps)}K`
      );
    } else {
      args.push(
        '-f', buildVideoFormat(quality, videoMaxMbps),
        '--merge-output-format', 'mp4'
      );
    }

    args.push(url);

    // YouTube periodically 403s whichever player client yt-dlp picks by
    // default. Retry with alternate clients before giving up; a genuinely
    // private/removed video fails on all of them and still surfaces below.
    const clientFallbacks = [null, 'tv', 'web_safari', 'ios', 'android', 'mweb'];
    let lastErr = null;
    let downloaded = false;
    for (const client of clientFallbacks) {
      const attemptArgs = client
        ? ['--extractor-args', `youtube:player_client=${client}`, ...args]
        : args;
      try {
        await runYtDlp(attemptArgs);
        downloaded = true;
        break;
      } catch (e) {
        lastErr = e;
        const msg = `${e.stderr || e.message || ''}`.toLowerCase();
        if (msg.includes('403') || msg.includes('forbidden') || msg.includes('player') || msg.includes('sign in')) {
          continue;
        }
        throw e;
      }
    }
    if (!downloaded) throw lastErr;

    const files = fs
      .readdirSync(workDir)
      .map((f) => path.join(workDir, f))
      .filter((f) => fs.statSync(f).isFile());

    if (!files.length) {
      res.status(500).json({ error: 'Download finished but no output file was found.' });
      return;
    }

    const cleanup = () => fs.rm(workDir, { recursive: true, force: true }, () => {});

    if (files.length === 1) {
      const filePath = files[0];
      res.download(filePath, path.basename(filePath), (err) => {
        cleanup();
        if (err) console.error('Error sending file:', err);
      });
    } else {
      const zipName = `${mode === 'music' ? 'music' : 'video'}-playlist-${Date.now()}.zip`;
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('error', (err) => {
        console.error('Archive error:', err);
        cleanup();
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to build the playlist zip.', details: String(err) });
        } else {
          res.destroy(err);
        }
      });
      archive.on('end', cleanup);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      archive.pipe(res);
      for (const f of files) archive.file(f, { name: path.basename(f) });
      archive.finalize();
    }
  } catch (err) {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    const details = err.stderr || err.message || String(err);
    console.error('Download error:', details);

    const looksLikeBotCheck = /sign in to confirm|not a bot|cookies/i.test(details);
    let errorMsg = 'The video or music appears to be unavailable, private, or does not exist.';
    if (looksLikeBotCheck) {
      errorMsg = COOKIES_FILE
        ? 'YouTube rejected the request even with cookies — the cookies file may be expired. Re-export it (see the web-app README).'
        : "YouTube is asking this server to \"confirm you're not a bot\" (normal for a hosted IP). Add a cookies.txt file — see the web-app README, \"YouTube bot check\".";
    }

    if (!res.headersSent) {
      res.status(500).json({ error: errorMsg, details });
    } else {
      res.destroy(err);
    }
  }
});

app.listen(PORT, () => {
  console.log(`YT Downloader web server listening on port ${PORT}`);
  console.log(`yt-dlp: ${YTDLP_PATH} (${fs.existsSync(YTDLP_PATH) ? 'present' : 'MISSING'})`);
  console.log(`ffmpeg: ${ffmpegPath} (${fs.existsSync(ffmpegPath) ? 'present' : 'MISSING'})`);
  console.log(
    COOKIES_FILE
      ? `cookies: ${COOKIES_FILE}`
      : 'cookies: none — YouTube may block downloads with "confirm you\'re not a bot" (see README)'
  );

  selfUpdateYtDlp();
  setInterval(selfUpdateYtDlp, 24 * 60 * 60 * 1000).unref();

  if (KEEPALIVE_URL) {
    console.log(`keep-alive: pinging ${KEEPALIVE_URL}/healthz every ${KEEPALIVE_MINUTES} min`);
    setInterval(keepAlivePing, KEEPALIVE_MINUTES * 60 * 1000).unref();
  } else {
    console.log('keep-alive: disabled (set RENDER_EXTERNAL_URL or KEEPALIVE_URL to enable)');
  }
});
