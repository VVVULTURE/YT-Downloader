(() => {
  const DEBUG = new URLSearchParams(location.search).has('debug');

  // ── Tabs ────────────────────────────────────
  const tabBtns = document.querySelectorAll('.tab-btn');
  const panels = {
    music: document.getElementById('panel-music'),
    video: document.getElementById('panel-video'),
  };
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      Object.entries(panels).forEach(([key, panel]) => {
        panel.classList.toggle('hidden', key !== btn.dataset.tab);
      });
    });
  });

  // ── Video resolution ────────────────────────
  const resolutionSelect = document.getElementById('v-resolution');

  // ── Bitrate sliders (mirror the desktop app) ─────────────
  function wireSlider(inputId, labelId, choices, render) {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    const update = () => {
      label.textContent = render(choices[Number(input.value)]);
    };
    input.addEventListener('input', update);
    update();
    return () => choices[Number(input.value)];
  }
  const getAudioKbps = wireSlider('m-bitrate', 'm-bitrate-val', [128, 160, 192, 256, 320], (v) => `${v} kbps`);
  const getVideoMaxMbps = wireSlider(
    'v-bitrate', 'v-bitrate-val',
    [2, 4, 6, 8, 12, 16, 20, null],
    (v) => (v === null ? 'Max' : `≤ ${v} Mbps`)
  );

  // ── Where does the work run? ───────────────────────
  // The server is a yt-dlp fetch proxy (+ video mux). MP3 transcoding runs
  // in this page via multi-threaded ffmpeg.wasm — which needs the page to be
  // crossOriginIsolated (server sends COOP/COEP) and the wasm to load. If
  // either fails we ask the server to transcode instead. Playlist .zip
  // assembly runs here via JSZip (no isolation needed).
  const HAS_JSZIP = typeof JSZip !== 'undefined';
  const CAN_TRANSCODE = self.crossOriginIsolated === true && typeof FFmpegWASM !== 'undefined';
  let ffmpegBroken = false;

  let ffmpegPromise = null;
  function getFFmpeg() {
    if (ffmpegPromise) return ffmpegPromise;
    ffmpegPromise = (async () => {
      if (!CAN_TRANSCODE) throw Object.assign(new Error('in-browser transcoding unavailable'), { ffmpegUnavailable: true });
      const base = new URL('/vendor/ffmpeg/', location.origin).href;
      const manifest = await fetch(base + 'manifest.json')
        .then((r) => r.json())
        .catch(() => ({ classWorker: '814.ffmpeg.js' }));
      const ff = new FFmpegWASM.FFmpeg();
      ff.on('log', ({ message }) => DEBUG && console.log('[ffmpeg]', message));
      await ff.load({
        classWorkerURL: base + manifest.classWorker,
        coreURL: base + 'ffmpeg-core.js',
        wasmURL: base + 'ffmpeg-core.wasm',
        workerURL: base + 'ffmpeg-core.worker.js',
      });
      if (DEBUG) console.log('[ffmpeg] loaded');
      return ff;
    })().catch((e) => {
      ffmpegPromise = null;
      ffmpegBroken = true;
      throw Object.assign(e, { ffmpegUnavailable: true });
    });
    return ffmpegPromise;
  }

  async function transcodeToMp3(bytes, kbps, onProgress) {
    const ff = await getFFmpeg();
    const stamp = Math.random().toString(36).slice(2);
    const inName = `in_${stamp}`;
    const outName = `out_${stamp}.mp3`;
    const onProg = ({ progress }) =>
      onProgress && onProgress(Math.max(0, Math.min(1, progress || 0)));
    ff.on('progress', onProg);
    try {
      await ff.writeFile(inName, bytes);
      const code = await ff.exec([
        '-i', inName,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', `${kbps}k`,
        outName,
      ]);
      if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
      const out = await ff.readFile(outName);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    } finally {
      ff.off('progress', onProg);
      ff.deleteFile(inName).catch(() => {});
      ff.deleteFile(outName).catch(() => {});
    }
  }

  // ── Multi-file stream reader (mirrors server writeMultiStream) ──
  //   uint16BE nameLen | name(utf8) | uint64BE dataLen | data   (repeated)
  async function readMultiStream(response, onFile) {
    const reader = response.body.getReader();
    let chunks = [];
    let buffered = 0;
    const peek = (n) => {
      if (buffered < n) return null;
      if (chunks[0].length >= n) return chunks[0].subarray(0, n);
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) {
        const take = c.subarray(0, n - o);
        out.set(take, o);
        o += take.length;
        if (o >= n) break;
      }
      return out;
    };
    const consume = (n) => {
      const out = new Uint8Array(n);
      let o = 0;
      while (o < n) {
        const c = chunks[0];
        if (c.length <= n - o) {
          out.set(c, o);
          o += c.length;
          chunks.shift();
        } else {
          out.set(c.subarray(0, n - o), o);
          chunks[0] = c.subarray(n - o);
          o = n;
        }
      }
      buffered -= n;
      return out;
    };

    const tryFrame = async () => {
      const h = peek(2);
      if (!h) return false;
      const nameLen = new DataView(h.buffer, h.byteOffset, 2).getUint16(0, false);
      const headLen = 2 + nameLen + 8;
      const head = peek(headLen);
      if (!head) return false;
      const hv = new DataView(head.buffer, head.byteOffset, headLen);
      const name = new TextDecoder().decode(head.subarray(2, 2 + nameLen));
      const dataLen = Number(hv.getBigUint64(2 + nameLen, false));
      if (buffered < headLen + dataLen) return false;
      consume(headLen);
      const bytes = consume(dataLen);
      await onFile({ name, bytes });
      return true;
    };

    for (;;) {
      while (await tryFrame()) {
        /* drain complete frames */
      }
      const { value, done } = await reader.read();
      if (value) {
        chunks.push(value);
        buffered += value.length;
      }
      if (done) break;
    }
    while (await tryFrame()) {
      /* trailing frames */
    }
    if (buffered) throw new Error(`truncated stream (${buffered} bytes left over)`);
  }

  // ── helpers ──────────────────────────
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function filenameFromDisposition(header) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header || '');
    if (star) {
      try {
        return decodeURIComponent(star[1]);
      } catch (_) {
        /* fall through */
      }
    }
    const plain = /filename="?([^"]+)"?/i.exec(header || '');
    return plain ? plain[1] : null;
  }

  function swapExt(name, ext) {
    return name.replace(/\.[^.]+$/, '') + ext;
  }

  // ── Health line ──────────────────────────
  fetch('/api/health')
    .then((r) => r.json())
    .then((data) => {
      const line = document.getElementById('health-line');
      const mp3 = CAN_TRANSCODE
        ? 'MP3: in-browser'
        : `MP3: server${data.crossOriginIsolationHeaders ? '' : ' (not isolated)'}`;
      if (data.ytdlpPresent && data.ffmpegPresent) {
        line.textContent = `Server ready — yt-dlp ${data.ytdlpVersion || ''} · ${mp3}`;
      } else {
        line.textContent = 'Server is missing yt-dlp or ffmpeg — downloads will fail. Check server logs.';
        line.style.color = 'var(--red)';
      }
    })
    .catch(() => {
      document.getElementById('health-line').textContent = 'Could not reach the server.';
    });

  // Warm the 33 MB wasm in the background so the first Download click is fast.
  if (CAN_TRANSCODE && typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => getFFmpeg().catch(() => {}), { timeout: 10000 });
  }

  // ── Download flow ────────────────────────
  async function postDownload(body) {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error([err.error, err.details].filter(Boolean).join('\n\n') || `Request failed (${res.status})`);
    }
    return res;
  }

  async function handleResponse(res, body, setStatus) {
    const kind = res.headers.get('X-Ytdl-Kind') || 'media';
    const name = res.headers.get('X-Ytdl-Name') || 'youtube';
    const kbps = Number(res.headers.get('X-Ytdl-Bitrate')) || Number(body.audioKbps) || 320;
    const count = Number(res.headers.get('X-Ytdl-Count')) || 0;

    if (kind === 'media') {
      setStatus('Saving…', 'var(--yellow)');
      const fn = filenameFromDisposition(res.headers.get('Content-Disposition')) || 'download';
      saveBlob(await res.blob(), fn);
      return;
    }

    if (kind === 'audio') {
      setStatus('Preparing MP3 encoder…', 'var(--yellow)');
      const raw = new Uint8Array(await res.arrayBuffer());
      const mp3 = await transcodeToMp3(raw, kbps, (p) =>
        setStatus(`Encoding MP3… ${Math.round(p * 100)}%`, 'var(--yellow)')
      );
      saveBlob(new Blob([mp3], { type: 'audio/mpeg' }), `${name}.mp3`);
      return;
    }

    // media-multi | audio-multi
    const isAudio = kind === 'audio-multi';
    if (!HAS_JSZIP) throw new Error('This browser could not load the .zip builder (JSZip).');
    const zip = new JSZip();
    let n = 0;
    await readMultiStream(res, async ({ name: fname, bytes }) => {
      n += 1;
      const of = count ? `${n}/${count}` : `${n}`;
      if (isAudio) {
        setStatus(`Encoding MP3 ${of}…`, 'var(--yellow)');
        const mp3 = await transcodeToMp3(bytes, kbps);
        zip.file(swapExt(fname, '.mp3'), mp3);
      } else {
        setStatus(`Bundling ${of}…`, 'var(--yellow)');
        zip.file(fname, bytes);
      }
    });
    setStatus('Building .zip…', 'var(--yellow)');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    saveBlob(blob, `${name}.zip`);
  }

  async function startDownload(opts) {
    const { statusEl, buttonEl } = opts;
    if (!opts.link && !opts.query1 && !opts.query2) {
      alert('Please provide at least a URL or search terms.');
      return;
    }
    const setStatus = (text, color = 'var(--yellow)') => {
      statusEl.textContent = text;
      statusEl.style.color = color;
    };

    buttonEl.disabled = true;
    setStatus(opts.link ? 'Fetching from URL…' : 'Searching YouTube…');

    const body = {
      mode: opts.mode,
      link: opts.link,
      query1: opts.query1,
      query2: opts.query2,
      resolution: opts.resolution,
      audioKbps: opts.audioKbps,
      videoMaxMbps: opts.videoMaxMbps,
      downloadPlaylist: opts.downloadPlaylist,
      assembleClient: HAS_JSZIP,
      transcodeClient: opts.mode === 'music' && CAN_TRANSCODE && !ffmpegBroken,
    };

    try {
      try {
        await handleResponse(await postDownload(body), body, setStatus);
      } catch (err) {
        if (err.ffmpegUnavailable && body.transcodeClient) {
          setStatus('In-browser encoder unavailable — asking the server…', 'var(--yellow)');
          const serverBody = { ...body, transcodeClient: false };
          await handleResponse(await postDownload(serverBody), serverBody, setStatus);
        } else {
          throw err;
        }
      }
      setStatus('Finished', 'var(--green)');
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      setStatus(`ERROR: ${msg.split('\n')[0].slice(0, 90)}`, 'var(--red)');
      alert(`Download Error\n\n${msg}`);
    } finally {
      buttonEl.disabled = false;
    }
  }

  // ── Tab wiring ─────────────────────────
  document.getElementById('m-download').addEventListener('click', () => {
    startDownload({
      mode: 'music',
      link: document.getElementById('m-link').value.trim(),
      query1: document.getElementById('m-artist').value.trim(),
      query2: document.getElementById('m-song').value.trim(),
      audioKbps: getAudioKbps(),
      downloadPlaylist: document.getElementById('m-playlist').checked,
      statusEl: document.getElementById('m-status'),
      buttonEl: document.getElementById('m-download'),
    });
  });

  document.getElementById('v-download').addEventListener('click', () => {
    startDownload({
      mode: 'video',
      link: document.getElementById('v-link').value.trim(),
      query1: document.getElementById('v-creator').value.trim(),
      query2: document.getElementById('v-title').value.trim(),
      resolution: resolutionSelect.value,
      videoMaxMbps: getVideoMaxMbps(),
      downloadPlaylist: document.getElementById('v-playlist').checked,
      statusEl: document.getElementById('v-status'),
      buttonEl: document.getElementById('v-download'),
    });
  });
})();
