'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());

// ── Cross-origin isolation ───────────────────────────────────────
// The browser does the MP3 transcode with multi-threaded ffmpeg.wasm, which
// needs SharedArrayBuffer, which needs the page to be "crossOriginIsolated".
// These three headers grant that. Safe here: the app loads ZERO cross-origin
// resources (ffmpeg.wasm + JSZip are served from public/vendor/, same origin).
// If a browser ends up not isolated anyway, app.js falls back to asking the
// server to transcode (?transcodeClient=false).
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
      // The ~33 MB ffmpeg-core.wasm should download exactly once per visitor.
      if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

const PORT = process.env.PORT || 3000;

// yt-dlp 2026+ needs a JavaScript runtime to solve YouTube's nsig / player
// JS challenges. With none available, extraction degrades hard on a
// datacenter IP — clients fall back to APIs that return no usable formats
// ("Requested format is not available"). Point yt-dlp at the Node binary
// already running this server. (yt-dlp just warns and carries on if it's
// somehow not there.)
const JS_RUNTIME_ARGS = ['--js-runtimes', `node:${process.execPath}`];

// youtube extractor-args string for a given player-client set. `formats=
// missing_pot` also surfaces formats that would need a PO token we don't
// have — on a hosted IP those are often still downloadable and are the
// difference between "works" and "Requested format is not available".
function ytExtractorArgs(clients) {
  return `youtube:player_client=${clients};formats=missing_pot`;
}

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

const RESOLUTION_CHOICES = ['best', '2160', '1440', '1080', '720', '480', '360'];

function normalizeResolution(v) {
  const s = String(v || '').replace(/p$/i, '');
  return RESOLUTION_CHOICES.includes(s) ? s : '1080';
}

// Build the yt-dlp -f string for a video download.
//   resolution   : "best" (no height cap) or a max height ("2160".."360")
//   videoMaxMbps : cap on video bitrate in Mbit/s, or falsy for no cap ("Max")
// The height is a ceiling: `[height<=H]` still matches a video whose best is
// below H, so it downloads at its max. Whether H is *genuinely* unavailable
// (nothing at or below it) is decided up front from a format probe
// (see probeVideoHeights) — not from a download failure — so it is safe for
// this string to end in an un-capped `bestvideo+bestaudio/best` catch-all.
// That catch-all only ever fires when the working client reports formats with
// no usable height metadata, where grabbing *something* beats failing.
function buildVideoFormat(resolution, videoMaxMbps) {
  const maxH = resolution === 'best' ? null : parseInt(resolution, 10);
  const h = maxH ? `[height<=${maxH}]` : '';
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

// YouTube keeps breaking one "player client" or another for hosted IPs
// (403 Forbidden; "The page needs to be reloaded" from tv_downgraded when
// cookies are set; SABR / PO-token issues; datacenter-IP throttling; ...).
// Try these client sets in order and use the first that works. `default,-tv`
// is the current workaround for the "page needs to be reloaded" error.
const YT_CLIENT_ATTEMPTS = [
  'default',            // best quality when it works
  'default,-tv',        // tv_downgraded is currently broken with cookies
  'tv_simply',          // no PO token needed; solves JS challenges via Node
  'mweb',               // no PO token needed; often works from hosted IPs
  'web_safari,mweb',
  'default,web_embedded',
  'ios',
  'android',
];

// Errors no client can get past — bail out of the rotation immediately.
const YT_TERMINAL_ERROR =
  /this video is private|private video|members[- ]only|join this channel|has been removed by|account associated with this video has been terminated|video has been removed for violating|video unavailable|who has blocked it|not available in your country|inappropriate for some users/i;

// Probe a video URL for the set of video heights YouTube will actually serve
// from this host, and which client set produced them. Rotates the same
// clients as the download. Uses --ignore-no-formats-error so a client that
// returns only audio/storyboard formats yields an (empty) list instead of
// throwing "Requested format is not available" — which must NOT be confused
// with the resolution the user picked being unavailable.
// Returns { clients, heights: number[] (ascending), maxH } or null if no
// client could enumerate any video format.
async function probeVideoHeights(url) {
  let best = null;
  for (const clients of YT_CLIENT_ATTEMPTS) {
    let info;
    try {
      const { stdout } = await runYtDlp([
        '--dump-single-json',
        '--no-warnings',
        '--no-playlist',
        '--skip-download',
        '--ignore-no-formats-error',
        ...JS_RUNTIME_ARGS,
        '--extractor-args', ytExtractorArgs(clients),
        ...COOKIE_ARGS,
        url,
      ]);
      const jsonStart = stdout.indexOf('{');
      if (jsonStart < 0) continue;
      // --dump-single-json emits exactly one JSON object; trim any trailing
      // newline. slice-from-first-brace guards against a stray leading line.
      info = JSON.parse(stdout.slice(jsonStart).trim());
    } catch (e) {
      if (e instanceof SyntaxError) continue; // unparseable probe output — try next client
      if (YT_TERMINAL_ERROR.test(`${e.stderr || e.message || ''}`)) throw e;
      continue;
    }
    const heights = [
      ...new Set(
        (info.formats || [])
          .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
          .map((f) => f.height)
      ),
    ].sort((a, b) => a - b);
    if (!heights.length) continue;
    const maxH = heights[heights.length - 1];
    if (!best || maxH > best.maxH) best = { clients, heights, maxH };
    // `default`-family clients report YouTube's full quality ladder, so the
    // first one that answers is authoritative — stop. Other clients
    // (ios/android/web_safari) often expose only a subset, so keep probing
    // for something better, but don't bother once we already have >=1080p.
    if (clients.startsWith('default')) break;
    if (best.maxH >= 1080) break;
  }
  return best;
}

// ── yt-dlp process helpers ──────────────────────────────
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

// ── Response helpers ─────────────────────────────────────────
// yt-dlp writes files as "<title>-<id>.<ext>". Recover a display name.
function stripYtId(basename) {
  return basename
    .replace(/\.[^.]+$/, '')
    .replace(/-[A-Za-z0-9_-]{11}$/, '')
    .trim();
}

// HTTP header values are Latin-1 and can't hold control chars; also make it a
// safe filename stem.
function headerSafe(s) {
  return (
    String(s || '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/["\\/:*?<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'youtube'
  );
}

// Stream several files back in ONE response for the browser to assemble
// (JSZip, and ffmpeg.wasm for audio). Framing, repeated per file:
//   uint16BE nameLen | name (utf8) | uint64BE dataLen | data
// The caller sets X-Ytdl-Kind / -Name / -Bitrate and calls res.end() after.
function writeMultiStream(res, files) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= files.length) return resolve();
      const { name, path: p } = files[i++];
      const nameBuf = Buffer.from(name, 'utf8');
      const head = Buffer.alloc(2 + nameBuf.length + 8);
      head.writeUInt16BE(nameBuf.length, 0);
      nameBuf.copy(head, 2);
      head.writeBigUInt64BE(BigInt(fs.statSync(p).size), 2 + nameBuf.length);
      res.write(head);
      const rs = fs.createReadStream(p);
      rs.once('error', reject);
      rs.once('end', next);
      rs.pipe(res, { end: false });
    };
    next();
  });
}

const _crc32 = (() => {
  if (typeof zlib.crc32 === 'function') return (buf) => zlib.crc32(buf) >>> 0;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

// Minimal stored (method 0 — no compression) ZIP writer. Only used on the
// fallback path where the browser can't assemble the .zip itself; media is
// already compressed so "store" costs ~nothing.
function streamStoreZip(res, files, zipName) {
  return new Promise((resolve, reject) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    const central = [];
    let offset = 0;
    const writeAll = (buf) =>
      new Promise((r) => (res.write(buf) ? r() : res.once('drain', r)));

    (async () => {
      for (const { name, path: p } of files) {
        const data = fs.readFileSync(p);
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = _crc32(data);
        const lfh = Buffer.alloc(30 + nameBuf.length);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(0, 6);
        lfh.writeUInt16LE(0, 8); // store
        lfh.writeUInt16LE(0, 10);
        lfh.writeUInt16LE(0x21, 12); // 1980-01-01
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(data.length, 18);
        lfh.writeUInt32LE(data.length, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);
        nameBuf.copy(lfh, 30);
        central.push({ name: nameBuf, crc, size: data.length, offset });
        await writeAll(lfh);
        offset += lfh.length;
        await writeAll(data);
        offset += data.length;
      }
      const cdStart = offset;
      for (const c of central) {
        const cdh = Buffer.alloc(46 + c.name.length);
        cdh.writeUInt32LE(0x02014b50, 0);
        cdh.writeUInt16LE(20, 4);
        cdh.writeUInt16LE(20, 6);
        cdh.writeUInt16LE(0, 8);
        cdh.writeUInt16LE(0, 10);
        cdh.writeUInt16LE(0, 12);
        cdh.writeUInt16LE(0x21, 14);
        cdh.writeUInt32LE(c.crc, 16);
        cdh.writeUInt32LE(c.size, 20);
        cdh.writeUInt32LE(c.size, 24);
        cdh.writeUInt16LE(c.name.length, 28);
        cdh.writeUInt32LE(0, 30); // extra + comment len
        cdh.writeUInt16LE(0, 34); // disk
        cdh.writeUInt16LE(0, 36); // internal attrs
        cdh.writeUInt32LE(0, 38); // external attrs
        cdh.writeUInt32LE(c.offset, 42);
        c.name.copy(cdh, 46);
        await writeAll(cdh);
        offset += cdh.length;
      }
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(central.length, 8);
      eocd.writeUInt16LE(central.length, 10);
      eocd.writeUInt32LE(offset - cdStart, 12);
      eocd.writeUInt32LE(cdStart, 16);
      res.end(eocd);
      resolve();
    })().catch(reject);
  });
}

// ── Keep-alive self-ping ──────────────────────────
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

// ── API routes ───────────────────────────────────────────────

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

  // `?probe=1` runs a real extraction against a known-good public video so
  // you can see, from the deployed host, exactly how far YouTube lets this
  // server get (which player clients work, what heights, or the blocking
  // error). A bit slow — opt-in only.
  let extraction;
  if (ytdlpExists && (req.query.probe === '1' || req.query.probe === 'true')) {
    const TEST_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny
    try {
      const probe = await probeVideoHeights(TEST_URL);
      extraction = probe
        ? { ok: true, client: probe.clients, heights: probe.heights }
        : { ok: false, error: 'no player client returned any video format' };
    } catch (e) {
      extraction = { ok: false, error: `${e.stderr || e.message || e}`.split('\n')[0].slice(0, 300) };
    }
  }

  res.json({
    ok: true,
    ytdlpPath: YTDLP_PATH,
    ytdlpPresent: ytdlpExists,
    ytdlpVersion,
    jsRuntime: process.execPath,
    crossOriginIsolationHeaders: true,
    ffmpegWasmStaged: fs.existsSync(path.join(__dirname, 'public/vendor/ffmpeg/ffmpeg-core.wasm')),
    ffmpegPath,
    ffmpegPresent: fs.existsSync(ffmpegPath),
    cookiesFile: COOKIES_FILE,
    cookiesLoaded: Boolean(COOKIES_FILE),
    ...(extraction ? { extraction } : {}),
  });
});

/**
 * POST /api/download
 * body: {
 *   mode: "music" | "video",
 *   link: string,            // direct YouTube URL (optional if search terms given)
 *   query1: string,          // artist (music) or creator (video)
 *   query2: string,          // song (music) or title (video)
 *   resolution: "best" | "2160" | "1440" | "1080" | "720" | "480" | "360"  (video only, default "1080"),
 *   audioKbps: 128|160|192|256|320   (music only, default 320),
 *   videoMaxMbps: number | null      (video only, cap in Mbit/s; null = no cap),
 *   downloadPlaylist: boolean
 * }
 *
 * Extra flags (new client sends both true; absent = legacy all-server behaviour):
 *   assembleClient  - browser will assemble multi-file (playlist) responses (JSZip)
 *   transcodeClient - browser will transcode audio -> MP3 (ffmpeg.wasm)
 *
 * Response carries an `X-Ytdl-Kind` header telling app.js what to do with the body:
 *   media        - final file, save as-is (Content-Disposition names it)
 *   audio        - one raw audio track; browser transcodes to MP3 @ X-Ytdl-Bitrate,
 *                  saves as `${X-Ytdl-Name}.mp3`
 *   media-multi  - length-prefixed multi-file stream; browser zips as-is
 *   audio-multi  - length-prefixed multi-file stream; browser transcodes each, then zips
 *
 * Status codes: 200 with the body; 400 bad input; 404 nothing found via
 * search; 409 {error} the picked resolution is genuinely unavailable for
 * that video (message names the lowest it offers); 500 {error, details}
 * everything else (bot check, YouTube-side extraction block, ...).
 */
app.post('/api/download', async (req, res) => {
  const {
    mode = 'music',
    link = '',
    query1 = '',
    query2 = '',
    resolution: resolutionRaw = '1080',
    audioKbps = 320,
    videoMaxMbps = null,
    downloadPlaylist = false,
    assembleClient = false,
    transcodeClient = false,
  } = req.body || {};

  const resolution = normalizeResolution(resolutionRaw);

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

    if (mode === 'music' && transcodeClient) {
      // Browser will transcode to MP3 — just fetch the raw audio track.
      // Prefer m4a (AAC) so ffmpeg.wasm has the smallest decode job.
      args.push('-f', 'bestaudio[ext=m4a]/bestaudio/best');
    } else if (mode === 'music') {
      args.push(
        '-f', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', `${clampAudioKbps(audioKbps)}K`
      );
    } else {
      args.push(
        '-f', buildVideoFormat(resolution, videoMaxMbps),
        '--merge-output-format', 'mp4'
      );
    }

    args.push(url);

    // For video: probe first so we (a) know which client set actually works
    // from this host, and (b) can tell — from real format data, not a
    // download failure — whether the picked resolution is genuinely
    // unavailable. Probing a single video is representative enough for a
    // playlist too, so we probe even in playlist mode (just don't hard-fail
    // a playlist on one entry missing the resolution).
    let probe = null;
    if (mode === 'video' && resolution !== 'best') {
      probe = await probeVideoHeights(url);

      if (probe && !downloadPlaylist) {
        const maxH = parseInt(resolution, 10);
        const atOrBelow = probe.heights.filter((x) => x <= maxH);
        if (!atOrBelow.length) {
          const lowest = probe.heights[0];
          const e = new Error(
            `${resolution}p isn't available for this video — the lowest it offers is ${lowest}p. ` +
              `Pick "Best available", or ${lowest}p or higher.`
          );
          e.userFacing = true;
          throw e;
        }
      }
    }

    // Try client sets in order; if the probe found a working one, lead with
    // it. A genuinely private/removed video fails on every client and its
    // error is surfaced below.
    const downloadClients = probe
      ? [probe.clients, ...YT_CLIENT_ATTEMPTS.filter((c) => c !== probe.clients)]
      : YT_CLIENT_ATTEMPTS;

    let lastErr = null;
    let downloaded = false;
    for (const clients of downloadClients) {
      try {
        await runYtDlp([
          ...JS_RUNTIME_ARGS,
          '--extractor-args', ytExtractorArgs(clients),
          ...args,
        ]);
        downloaded = true;
        break;
      } catch (e) {
        lastErr = e;
        if (YT_TERMINAL_ERROR.test(`${e.stderr || e.message || ''}`)) break;
        // Otherwise retry with the next client set — 403 / "reload" / missing
        // formats are all client-specific; a truly gone video fails anyway.
      }
    }

    if (!downloaded) {
      const lastMsg = `${(lastErr && (lastErr.stderr || lastErr.message)) || ''}`;
      // The probe proved a usable format existed, but every client failed to
      // actually pull it — that's YouTube blocking downloads from this host
      // right now, not a bad resolution pick.
      if (
        mode === 'video' &&
        probe &&
        /requested format|format is not available/i.test(lastMsg)
      ) {
        const e = new Error(
          'YouTube let this server list the video but blocked every attempt to download it ' +
            '(a known, recurring YouTube-side issue for hosted IPs). Try again in a minute or two.'
        );
        e.userFacing = true;
        throw e;
      }
      // No probe data and a format error — best guess is the resolution pick.
      if (
        mode === 'video' &&
        resolution !== 'best' &&
        !downloadPlaylist &&
        /requested format|format is not available/i.test(lastMsg)
      ) {
        const e = new Error(
          `${resolution}p isn't available for this video. Pick "Best available" or a different resolution.`
        );
        e.userFacing = true;
        throw e;
      }
      throw lastErr || new Error('The download failed for an unknown reason. Try again.');
    }

    const named = fs
      .readdirSync(workDir)
      .map((f) => path.join(workDir, f))
      .filter((f) => fs.statSync(f).isFile())
      .sort()
      .map((p) => ({ path: p, name: path.basename(p) }));

    if (!named.length) {
      res.status(500).json({ error: 'Download finished but no output file was found.' });
      return;
    }

    const cleanup = () => fs.rm(workDir, { recursive: true, force: true }, () => {});
    const stem = headerSafe(stripYtId(named[0].name));

    // ── MUSIC + browser transcode: hand over the raw audio track(s) ──
    if (mode === 'music' && transcodeClient) {
      res.setHeader('X-Ytdl-Bitrate', String(clampAudioKbps(audioKbps)));
      if (named.length === 1) {
        res.setHeader('X-Ytdl-Kind', 'audio');
        res.setHeader('X-Ytdl-Name', stem);
        res.setHeader('Content-Type', 'application/octet-stream');
        // Filename stays ASCII-safe — Node's setHeader rejects non-Latin1, and
        // the browser names the final .mp3 from X-Ytdl-Name anyway.
        res.setHeader('Content-Disposition', `attachment; filename="${headerSafe(named[0].name)}"`);
        const rs = fs.createReadStream(named[0].path);
        rs.once('error', () => res.destroy());
        rs.once('close', cleanup);
        rs.pipe(res);
      } else {
        res.setHeader('X-Ytdl-Kind', 'audio-multi');
        res.setHeader('X-Ytdl-Name', `${stem} playlist`);
        res.setHeader('X-Ytdl-Count', String(named.length));
        res.setHeader('Content-Type', 'application/x-ytdl-multi');
        try {
          await writeMultiStream(res, named);
          res.end();
        } catch (e) {
          res.destroy(e);
        }
        cleanup();
      }
      return;
    }

    // ── everything else: the server produced the final file(s) ──
    if (named.length === 1) {
      res.setHeader('X-Ytdl-Kind', 'media');
      res.download(named[0].path, named[0].name, (err) => {
        cleanup();
        if (err) console.error('Error sending file:', err);
      });
      return;
    }

    if (assembleClient) {
      res.setHeader('X-Ytdl-Kind', 'media-multi');
      res.setHeader('X-Ytdl-Name', `${stem} playlist`);
      res.setHeader('X-Ytdl-Count', String(named.length));
      res.setHeader('Content-Type', 'application/x-ytdl-multi');
      try {
        await writeMultiStream(res, named);
        res.end();
      } catch (e) {
        res.destroy(e);
      }
      cleanup();
      return;
    }

    // Fallback (legacy client / no JS): server assembles the .zip.
    res.setHeader('X-Ytdl-Kind', 'media');
    try {
      await streamStoreZip(res, named, `${stem}-playlist.zip`);
    } catch (e) {
      console.error('Zip error:', e);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to build the playlist zip.', details: String(e) });
      } else {
        res.destroy(e);
      }
    }
    cleanup();
  } catch (err) {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    const details = err.stderr || err.message || String(err);
    console.error('Download error:', details);

    // A message we built ourselves for the user (e.g. resolution unavailable).
    if (err.userFacing) {
      if (!res.headersSent) res.status(409).json({ error: err.message });
      else res.destroy(err);
      return;
    }

    let errorMsg = 'The video or music appears to be unavailable, private, or does not exist.';
    if (/sign in to confirm|not a bot|confirm you.?re not a bot/i.test(details)) {
      errorMsg = COOKIES_FILE
        ? 'YouTube rejected the request even with cookies — the cookies file may be expired. Re-export it (see the web-app README).'
        : "YouTube is asking this server to \"confirm you're not a bot\" (normal for a hosted IP). Add a cookies.txt file — see the web-app README, \"YouTube bot check\".";
    } else if (
      /page needs to be reloaded|only images are available|sabr|requested format|format is not available|nsig extraction failed|unable to extract|failed to extract any player response|player response/i.test(
        details
      )
    ) {
      errorMsg =
        'YouTube is temporarily blocking video extraction for this server ' +
        '(a known, recurring YouTube-side issue for hosted IPs). Try again in a minute or two' +
        (COOKIES_FILE ? '.' : ', or add a cookies.txt file (see the web-app README).');
    } else if (/is not a valid URL|unsupported url/i.test(details)) {
      errorMsg = 'That doesn\'t look like a YouTube link. Paste a full video URL, or use the search fields.';
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
