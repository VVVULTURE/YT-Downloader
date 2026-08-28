(() => {
  // ── Tabs ─────────────────────────────────────────────────
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

  // ── Video quality segmented control ────────────────────────────────
  const qualityWrap = document.getElementById('v-quality');
  let selectedQuality = '1080p';
  qualityWrap.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      qualityWrap.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedQuality = btn.dataset.value;
    });
  });

  // ── Bitrate sliders (mirror the desktop app) ───────────────────────
  // Each slider is a plain 0..N range input; the value maps to an entry in
  // `choices`. `render` turns a choice into its label. The defaults (last
  // entry of each) reproduce the previous behaviour: 320 kbps MP3, and no
  // video bitrate cap.
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

  const getAudioKbps = wireSlider(
    'm-bitrate', 'm-bitrate-val',
    [128, 160, 192, 256, 320],
    (v) => `${v} kbps`
  );

  const getVideoMaxMbps = wireSlider(
    'v-bitrate', 'v-bitrate-val',
    [2, 4, 6, 8, 12, 16, 20, null],
    (v) => (v === null ? 'Max' : `≤ ${v} Mbps`)
  );

  // ── Health check (shown in the footer) ────────────────────────────
  fetch('/api/health')
    .then((r) => r.json())
    .then((data) => {
      const line = document.getElementById('health-line');
      if (data.ytdlpPresent && data.ffmpegPresent) {
        line.textContent = `Server ready — yt-dlp ${data.ytdlpVersion || ''}`;
      } else {
        line.textContent = 'Server is missing yt-dlp or ffmpeg — downloads will fail. Check server logs.';
        line.style.color = 'var(--red)';
      }
    })
    .catch(() => {
      document.getElementById('health-line').textContent = 'Could not reach the server.';
    });

  // ── Shared download helper ─────────────────────────────────────
  async function startDownload({
    mode, link, query1, query2, quality, audioKbps, videoMaxMbps,
    downloadPlaylist, statusEl, buttonEl,
  }) {
    if (!link && !query1 && !query2) {
      alert('Please provide at least a URL or search terms.');
      return;
    }

    buttonEl.disabled = true;
    statusEl.textContent = link ? 'Attempting direct download from URL...' : 'Searching YouTube...';
    statusEl.style.color = 'var(--yellow)';

    try {
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode, link, query1, query2, quality, audioKbps, videoMaxMbps, downloadPlaylist,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const parts = [err.error, err.details].filter(Boolean);
        throw new Error(parts.join('\n\n') || `Request failed (${res.status})`);
      }

      // Pull the filename the server suggested, then trigger a browser download.
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'download';

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      statusEl.textContent = 'Finished';
      statusEl.style.color = 'var(--green)';
    } catch (err) {
      statusEl.textContent = 'ERROR: Content Not Found/Unavailable.';
      statusEl.style.color = 'var(--red)';
      alert(`Download Error\n\n${err.message}`);
    } finally {
      buttonEl.disabled = false;
    }
  }

  // ── Music tab wiring ─────────────────────────────────────────
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

  // ── Video tab wiring ─────────────────────────────────────────
  document.getElementById('v-download').addEventListener('click', () => {
    startDownload({
      mode: 'video',
      link: document.getElementById('v-link').value.trim(),
      query1: document.getElementById('v-creator').value.trim(),
      query2: document.getElementById('v-title').value.trim(),
      quality: selectedQuality,
      videoMaxMbps: getVideoMaxMbps(),
      downloadPlaylist: document.getElementById('v-playlist').checked,
      statusEl: document.getElementById('v-status'),
      buttonEl: document.getElementById('v-download'),
    });
  });
})();
