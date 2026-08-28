'use strict';
/**
 * Downloads the yt-dlp binary into bin/ at install time.
 *
 * Deliberately does NOT use the GitHub API (api.github.com/.../releases) —
 * that endpoint is aggressively rate-limited per-IP, which is unreliable on
 * shared build infrastructure. Instead this uses GitHub's "latest release"
 * redirect URL, which is a plain asset download with no API rate limit.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const filename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;
const binDir = path.join(__dirname, '..', 'bin');
const dest = path.join(binDir, filename);

function download(currentUrl, redirectsLeft) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error('Too many redirects'));
    https
      .get(currentUrl, { headers: { 'User-Agent': 'yt-downloader-web (+https://github.com/)' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(download(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} while downloading ${currentUrl}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  try {
    fs.mkdirSync(binDir, { recursive: true });

    // Always fetch the latest release. YouTube breaks old yt-dlp builds
    // constantly (every download starts failing with "HTTP Error 403:
    // Forbidden"), so a cached bin/yt-dlp from a previous deploy is not good
    // enough. server.js additionally runs `yt-dlp -U` on boot and daily.
    if (fs.existsSync(dest)) {
      console.log(`[download-ytdlp] Refreshing existing yt-dlp at ${dest} ...`);
    } else {
      console.log(`[download-ytdlp] Downloading yt-dlp from ${url} ...`);
    }
    await download(url, 5);
    if (!isWin) fs.chmodSync(dest, 0o755);
    console.log(`[download-ytdlp] yt-dlp ready at ${dest}`);
  } catch (err) {
    console.error(`[download-ytdlp] WARNING: could not download yt-dlp automatically: ${err.message}`);
    console.error('[download-ytdlp] The server will still start, but downloads will fail until a yt-dlp');
    console.error(`[download-ytdlp] binary is present at: ${dest}`);
    console.error('[download-ytdlp] You can also set YTDLP_PATH to point at an existing yt-dlp install.');
    // Do not fail the whole `npm install` over this — let deploys proceed and
    // surface a clear error at request time instead (see server.js).
    process.exitCode = 0;
  }
})();
