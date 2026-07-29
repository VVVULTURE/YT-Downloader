(() => {
  // ── Tabs ──────────────────────────────────────────────────────────────
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

  // ── Video quality segmented control ─────────────────────────────────────
  const qualityWrap = document.getElementById('v-quality');
  let selectedQuality = '1080p';
  qualityWrap.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      qualityWrap.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedQuality = btn.dataset.value;
    });
  });

  // ── Health check (shown in the footer) ──────────────────────────────────
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

  // ── Shared download helper ──────────────────────────────────────────────
  async function startDownload({ mode, link, query1, query2, quality, downloadPlaylist, statusEl, buttonEl }) {
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
        body: JSON.stringify({ mode, link, query1, query2, quality, downloadPlaylist }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.details || err.error || `Request failed (${res.status})`);
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

  // ── Music tab wiring ─────────────────────────────────────────────────────
  document.getElementById('m-download').addEventListener('click', () => {
    startDownload({
      mode: 'music',
      link: document.getElementById('m-link').value.trim(),
      query1: document.getElementById('m-artist').value.trim(),
      query2: document.getElementById('m-song').value.trim(),
      downloadPlaylist: document.getElementById('m-playlist').checked,
      statusEl: document.getElementById('m-status'),
      buttonEl: document.getElementById('m-download'),
    });
  });

  // ── Video tab wiring ─────────────────────────────────────────────────────
  document.getElementById('v-download').addEventListener('click', () => {
    startDownload({
      mode: 'video',
      link: document.getElementById('v-link').value.trim(),
      query1: document.getElementById('v-creator').value.trim(),
      query2: document.getElementById('v-title').value.trim(),
      quality: selectedQuality,
      downloadPlaylist: document.getElementById('v-playlist').checked,
      statusEl: document.getElementById('v-status'),
      buttonEl: document.getElementById('v-download'),
    });
  });
})();
