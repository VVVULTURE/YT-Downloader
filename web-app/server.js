'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
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

// ── yt-dlp process helpers ───────────────────────────────────────────────
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

async function searchYouTube(query, limit) {
  const { stdout } = await runYtDlp([
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    `ytsearch${limit}:${query}`,
  ]);
  const data = JSON.parse(stdout);
  return data.entries || [];
}

// ── API routes ───────────────────────────────────────────────────────────

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
    const args = ['--no-warnings', '--ffmpeg-location', ffmpegPath, '-o', outTemplate];

    if (!downloadPlaylist) {
      args.push('--no-playlist');
    }

    if (mode === 'music') {
      args.push(
        '-f', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '320K'
      );
    } else {
      args.push(
        '-f',
        quality === 'best' ? 'bestvideo+bestaudio/best' : 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
        '--merge-output-format', 'mp4'
      );
    }

    args.push(url);

    await runYtDlp(args);

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
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => {
        console.error('Archive error:', err);
        res.status(500).end();
      });
      archive.on('end', cleanup);
      archive.pipe(res);
      for (const f of files) archive.file(f, { name: path.basename(f) });
      archive.finalize();
    }
  } catch (err) {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    const details = err.stderr || err.message || String(err);
    console.error('Download error:', details);
    res.status(500).json({
      error: 'The video or music appears to be unavailable, private, or does not exist.',
      details,
    });
  }
});

app.listen(PORT, () => {
  console.log(`YT Downloader web server listening on port ${PORT}`);
  console.log(`yt-dlp: ${YTDLP_PATH} (${fs.existsSync(YTDLP_PATH) ? 'present' : 'MISSING'})`);
  console.log(`ffmpeg: ${ffmpegPath} (${fs.existsSync(ffmpegPath) ? 'present' : 'MISSING'})`);
});
