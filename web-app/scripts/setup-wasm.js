'use strict';
/**
 * Stages the browser-side processing libraries into public/vendor/ at install
 * time, so the app serves them same-origin (required under the COOP/COEP
 * headers server.js sends) instead of hot-linking a CDN.
 *
 *   ffmpeg.wasm  - in-browser MP3 transcoding  (@ffmpeg/ffmpeg + @ffmpeg/core-mt)
 *   JSZip        - in-browser playlist .zip assembly
 *
 * public/vendor/ is git-ignored and rebuilt on every `npm install`. Like
 * download-ytdlp.js this never fails the install: if a file is missing the
 * server still boots, the browser just falls back to server-side transcoding
 * / zipping.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'public', 'vendor');
const ffDir = path.join(vendor, 'ffmpeg');

// This script runs from web-app/ right after `npm install`, so the packages
// sit in ./node_modules. Direct paths — @ffmpeg's "exports" field blocks
// require.resolve() of its dist/ and even its package.json.
function pkgDir(name) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  if (!fs.existsSync(dir)) throw new Error(`${name} not found at ${dir}`);
  return dir;
}

function copy(src, destDir, destName) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, destName || path.basename(src));
  fs.copyFileSync(src, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`[setup-wasm] ${path.relative(root, dest)}  (${kb} KB)`);
}

try {
  fs.mkdirSync(ffDir, { recursive: true });

  // @ffmpeg/ffmpeg UMD wrapper + its worker chunk (webpack-named, e.g.
  // 814.ffmpeg.js — copy every *.js next to ffmpeg.js, skip source maps).
  const ffmpegUmd = path.join(pkgDir('@ffmpeg/ffmpeg'), 'dist', 'umd');
  let classWorker = null;
  for (const f of fs.readdirSync(ffmpegUmd)) {
    if (!f.endsWith('.js')) continue;
    copy(path.join(ffmpegUmd, f), ffDir);
    if (f !== 'ffmpeg.js') classWorker = f;
  }

  // @ffmpeg/core-mt: the actual wasm + its loaders (~33 MB wasm).
  const coreUmd = path.join(pkgDir('@ffmpeg/core-mt'), 'dist', 'umd');
  for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js']) {
    copy(path.join(coreUmd, f), ffDir);
  }

  fs.writeFileSync(
    path.join(ffDir, 'manifest.json'),
    JSON.stringify({ classWorker: classWorker || '814.ffmpeg.js' }) + '\n'
  );
  console.log(`[setup-wasm] manifest.json  { classWorker: ${classWorker || '814.ffmpeg.js'} }`);

  // JSZip (single UMD file).
  copy(path.join(pkgDir('jszip'), 'dist', 'jszip.min.js'), vendor);

  console.log('[setup-wasm] browser libraries staged in public/vendor/');
} catch (err) {
  console.error(`[setup-wasm] WARNING: could not stage browser libraries: ${err.message}`);
  console.error('[setup-wasm] The app still works — the browser will fall back to');
  console.error('[setup-wasm] server-side MP3 transcoding and .zip assembly.');
  process.exitCode = 0;
}
