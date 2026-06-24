(function () {
  const DATA = (window.CALL_REVIEW_DATA && typeof window.CALL_REVIEW_DATA === 'object')
    ? window.CALL_REVIEW_DATA
    : {};

  const audio = document.getElementById('audioPlayer');
  const audioSourceText = document.getElementById('audioSourceText');
  const progressBar = document.getElementById('progressBar');
  const progressTooltip = document.getElementById('progressTooltip');
  const currentTimeLabel = document.getElementById('currentTimeLabel');
  const durationLabel = document.getElementById('durationLabel');
  const transcriptText = document.getElementById('transcriptText');
  const transcriptStatus = document.getElementById('transcriptStatus');
  const statusLabel = document.getElementById('audioStatus');
  const timelineCanvas = document.getElementById('timelineCanvas');
  const timelineCtx = timelineCanvas.getContext('2d');
  const timelineTooltip = document.getElementById('timelineTooltip');

  const btnPlay = document.getElementById('btnPlay');
  const btnPause = document.getElementById('btnPause');
  const btnRewind = document.getElementById('btnRewind');
  const btnForward = document.getElementById('btnForward');
  const speedControl = document.getElementById('speedControl');
  const btnSaveContinue = document.getElementById('btnSaveContinue');

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function formatMs(ms) {
    return formatTime((ms || 0) / 1000);
  }

  function updateProgressBackground(value) {
    const pct = Number(value || 0);
    progressBar.style.background = `linear-gradient(to right, #2563eb 0%, #2563eb ${pct}%, #d6deea ${pct}%, #d6deea 100%)`;
  }

  function resizeCanvas(canvas, ctx) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: cssWidth, height: cssHeight };
  }

  function quantile(sortedArr, q) {
    if (!sortedArr.length) return 0;
    const pos = (sortedArr.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sortedArr[base + 1] !== undefined) {
      return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
    }
    return sortedArr[base];
  }

  function buildTimelineFromWaveformPoints(points) {
    const rows = Array.isArray(points)
      ? points
          .map(p => ({
            timestamp_ms: Number(p.timestamp_ms) || 0,
            duration_ms: Number(p.duration_ms) || 0,
            amplitude_rms: Number(p.amplitude_rms) || 0,
            amplitude_peak: Number(p.amplitude_peak) || 0
          }))
          .filter(p => Number.isFinite(p.timestamp_ms) && Number.isFinite(p.duration_ms) && Number.isFinite(p.amplitude_rms) && Number.isFinite(p.amplitude_peak))
          .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
      : [];

    if (!rows.length) return [];

    const fullDurationMs = Math.max(...rows.map(r => r.timestamp_ms + r.duration_ms));
    const numSecs = Math.max(1, Math.ceil(fullDurationMs / 1000));
    const bins = Array.from({ length: numSecs }, (_, sec) => ({
      sec_bin: sec,
      start_ms: sec * 1000,
      end_ms: (sec + 1) * 1000,
      mean_rms: 0,
      max_peak: 0,
      _count: 0
    }));

    for (const r of rows) {
      const sec = Math.floor(r.timestamp_ms / 1000);
      const bin = bins[sec];
      if (!bin) continue;
      bin.mean_rms += r.amplitude_rms;
      bin.max_peak = Math.max(bin.max_peak, r.amplitude_peak);
      bin._count += 1;
    }

    for (const bin of bins) {
      bin.mean_rms = bin._count ? (bin.mean_rms / bin._count) : 0;
    }

    const nonZero = bins.map(b => b.mean_rms).filter(v => v > 0).sort((a, b) => a - b);
    const nz = nonZero.length ? nonZero : [0.001];
    const q20 = quantile(nz, 0.20);
    const q50 = quantile(nz, 0.50);
    const q80 = quantile(nz, 0.80);
    const q95 = Math.max(quantile(nz, 0.95), 0.001);

    const states = bins.map(bin => {
      let state = 'high';
      if (bin.mean_rms <= q20) state = 'silence';
      else if (bin.mean_rms <= q50) state = 'low';
      else if (bin.mean_rms <= q80) state = 'speech';
      const intensity = Math.pow(Math.min(bin.mean_rms, q95) / q95, 0.6);
      return {
        start_ms: bin.start_ms,
        end_ms: bin.end_ms,
        mean_rms: bin.mean_rms,
        max_peak: bin.max_peak,
        state,
        intensity,
        intensity_smooth: intensity
      };
    });

    // display smoothing only
    const vals = states.map(s => s.intensity);
    states.forEach((s, i) => {
      const prev = vals[Math.max(0, i - 1)];
      const cur = vals[i];
      const nxt = vals[Math.min(vals.length - 1, i + 1)];
      s.intensity_smooth = (prev + 2 * cur + nxt) / 4;
    });

    return states;
  }

  // Support EITHER pre-built timelineSeconds OR raw waveformPoints
  const timelineSeconds = Array.isArray(DATA.timelineSeconds) && DATA.timelineSeconds.length
    ? DATA.timelineSeconds
    : buildTimelineFromWaveformPoints(DATA.waveformPoints);

  const timelineTotalMs = timelineSeconds.length ? timelineSeconds[timelineSeconds.length - 1].end_ms : 0;

  function getPlaybackRatio() {
    if (audio.duration && isFinite(audio.duration) && audio.duration > 0) {
      return audio.currentTime / audio.duration;
    }
    return timelineTotalMs > 0 ? (audio.currentTime / (timelineTotalMs / 1000)) : 0;
  }

  function getTimelinePointFromEvent(event) {
    const rect = timelineCanvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
    const ratio = rect.width > 0 ? x / rect.width : 0;
    const ms = ratio * timelineTotalMs;
    return { x, ratio, ms };
  }

  function findNearestSecond(targetMs) {
    if (!timelineSeconds.length) return null;
    let nearest = timelineSeconds[0];
    let min = Math.abs(targetMs - nearest.start_ms);
    for (const row of timelineSeconds) {
      const diff = Math.abs(targetMs - row.start_ms);
      if (diff < min) {
        min = diff;
        nearest = row;
      }
    }
    return nearest;
  }

  function stateFill(state, played) {
    if (played) return '#1d4ed8';
    if (state === 'silence') return '#d8deea';
    if (state === 'low') return '#bdd3ff';
    if (state === 'speech') return '#8fb6ff';
    return '#4f8ef7';
  }

  function drawTimeline() {
    const { width: w, height: h } = resizeCanvas(timelineCanvas, timelineCtx);
    const ctx = timelineCtx;
    const totalSec = (timelineTotalMs / 1000) || 0;
    const playX = w * getPlaybackRatio();
    const rulerH = 28;
    const topLaneY = 42;
    const laneH = 28;
    const bottomBaseY = h - 22;
    const bottomMaxH = 74;
    const bottomMinY = 110;

    ctx.clearRect(0, 0, w, h);

    // ruler
    ctx.strokeStyle = '#e5eaf2';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerH + 0.5);
    ctx.lineTo(w, rulerH + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#6b7280';
    ctx.font = '12px Segoe UI, Arial, sans-serif';
    ctx.textBaseline = 'top';
    const tickEvery = totalSec > 360 ? 60 : 30;
    for (let t = 0; t <= totalSec; t += tickEvery) {
      const x = (t / Math.max(totalSec, 1)) * w;
      ctx.strokeStyle = '#d8deea';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 18);
      ctx.lineTo(x + 0.5, rulerH + 6);
      ctx.stroke();
      const label = formatTime(t);
      const lw = ctx.measureText(label).width;
      ctx.fillText(label, Math.max(0, Math.min(w - lw, x - lw / 2)), 2);
    }

    // labels
    ctx.fillStyle = '#6b7280';
    ctx.fillText('Speech state', 0, topLaneY - 18);
    ctx.fillText('Intensity (1s blocks)', 0, bottomMinY - 18);

    // background lane
    ctx.fillStyle = '#eef2f8';
    ctx.fillRect(0, topLaneY, w, laneH);
    ctx.strokeStyle = '#d8deea';
    ctx.strokeRect(0.5, topLaneY + 0.5, Math.max(0, w - 1), laneH - 1);

    // blocks
    for (const item of timelineSeconds) {
      const x0 = (item.start_ms / timelineTotalMs) * w;
      const x1 = (item.end_ms / timelineTotalMs) * w;
      const bw = Math.max(1, x1 - x0 - 1);
      const played = x0 <= playX;

      ctx.fillStyle = stateFill(item.state, false);
      ctx.fillRect(x0, topLaneY, bw, laneH);

      const bh = Math.max(8, (item.intensity_smooth || item.intensity || 0) * bottomMaxH);
      const by = bottomBaseY - bh;
      ctx.fillStyle = stateFill(item.state, played);
      ctx.fillRect(x0, by, bw, bh);
    }

    // playhead
    ctx.strokeStyle = 'rgba(17,24,39,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playX + 0.5, 0);
    ctx.lineTo(playX + 0.5, h);
    ctx.stroke();
  }

  function redrawTimeline() { drawTimeline(); }

  function updatePlaybackVisual() {
    const ratio = getPlaybackRatio();
    const progressValue = ratio * 100;
    progressBar.value = progressValue;
    updateProgressBackground(progressValue);
    currentTimeLabel.textContent = formatTime(audio.currentTime);
    durationLabel.textContent = formatTime(audio.duration || (timelineTotalMs / 1000) || 0);
    redrawTimeline();
    statusLabel.textContent = ``;
  }

  function playAudio() { audio.play(); }
  function pauseAudio() { audio.pause(); }
  function seekAudio(offset) {
    const maxDuration = audio.duration || (timelineTotalMs / 1000) || Number.MAX_SAFE_INTEGER;
    audio.currentTime = Math.max(0, Math.min((audio.currentTime || 0) + offset, maxDuration));
    updatePlaybackVisual();
  }
  function setSpeed(value) {
    audio.playbackRate = Number(value);
    updatePlaybackVisual();
  }

  function updateProgressTooltip(event) {
    const rect = progressBar.getBoundingClientRect();
    const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
    const ratio = rect.width > 0 ? x / rect.width : 0;
    const totalSec = audio.duration || (timelineTotalMs / 1000) || 0;
    progressTooltip.textContent = formatTime(totalSec * ratio);
    progressTooltip.style.left = `${x}px`;
    progressTooltip.style.opacity = '1';
  }

  function showTimelineTooltip(event) {
    const pt = getTimelinePointFromEvent(event);
    const nearest = findNearestSecond(pt.ms);
    timelineTooltip.style.left = `${pt.x}px`;
    timelineTooltip.style.opacity = '1';
    if (nearest) {
      timelineTooltip.innerHTML = `${formatMs(nearest.start_ms)} – ${formatMs(nearest.end_ms)}<br>State: ${nearest.state} | Mean RMS: ${Number(nearest.mean_rms || 0).toFixed(4)}`;
    } else {
      timelineTooltip.textContent = formatMs(pt.ms);
    }
  }

  function saveAndContinue() {
    const payload = {
      caseId: document.getElementById('caseId').value,
      callerName: document.getElementById('callerName').value,
      callDate: document.getElementById('callDate').value,
      classification: document.getElementById('classification').value,
      reviewNotes: document.getElementById('reviewNotes').value,
      transcript: document.getElementById('transcriptText').value,
      currentAudioTime: formatTime(audio.currentTime || 0),
      timelineSeconds: timelineSeconds.length
    };
  }

  function initialiseData() {
    transcriptText.value = typeof DATA.transcript === 'string' ? DATA.transcript : '';
    transcriptStatus.textContent = `Transcript loaded from call_review_data.js (${transcriptText.value.length.toLocaleString()} characters).`;

    if (typeof DATA.audioSrc === 'string' && DATA.audioSrc.trim() !== '') {
      audio.src = DATA.audioSrc;
      audioSourceText.textContent = DATA.audioSrc;
    } else {
      audioSourceText.textContent = 'No audio source supplied in call_review_data.js';
    }

    if (DATA.metadata && typeof DATA.metadata === 'object') {
      if (typeof DATA.metadata.caseId === 'string') document.getElementById('caseId').value = DATA.metadata.caseId;
      if (typeof DATA.metadata.callerName === 'string') document.getElementById('callerName').value = DATA.metadata.callerName;
      if (typeof DATA.metadata.callDate === 'string') document.getElementById('callDate').value = DATA.metadata.callDate;
      if (typeof DATA.metadata.classification === 'string') document.getElementById('classification').value = DATA.metadata.classification;
      if (typeof DATA.metadata.reviewNotes === 'string') document.getElementById('reviewNotes').value = DATA.metadata.reviewNotes;
    }

    redrawTimeline();
    updatePlaybackVisual();
  }

  btnPlay.addEventListener('click', playAudio);
  btnPause.addEventListener('click', pauseAudio);
  btnRewind.addEventListener('click', () => seekAudio(-10));
  btnForward.addEventListener('click', () => seekAudio(10));
  speedControl.addEventListener('change', (e) => setSpeed(e.target.value));
  btnSaveContinue.addEventListener('click', saveAndContinue);

  progressBar.addEventListener('input', function () {
    const maxDuration = audio.duration || (timelineTotalMs / 1000) || 0;
    if (maxDuration > 0) {
      audio.currentTime = (Number(this.value) / 100) * maxDuration;
      updatePlaybackVisual();
    }
  });
  progressBar.addEventListener('mousemove', updateProgressTooltip);
  progressBar.addEventListener('mouseenter', (e) => { updateProgressTooltip(e); progressTooltip.style.opacity = '1'; });
  progressBar.addEventListener('mouseleave', () => { progressTooltip.style.opacity = '0'; });

  timelineCanvas.addEventListener('mousemove', showTimelineTooltip);
  timelineCanvas.addEventListener('mouseenter', showTimelineTooltip);
  timelineCanvas.addEventListener('mouseleave', () => { timelineTooltip.style.opacity = '0'; });
  timelineCanvas.addEventListener('click', (e) => {
    const pt = getTimelinePointFromEvent(e);
    const seconds = pt.ms / 1000;
    const maxDuration = audio.duration || (timelineTotalMs / 1000) || seconds;
    audio.currentTime = Math.max(0, Math.min(seconds, maxDuration));
    updatePlaybackVisual();
  });

  audio.addEventListener('timeupdate', updatePlaybackVisual);
  audio.addEventListener('loadedmetadata', updatePlaybackVisual);
  audio.addEventListener('ratechange', updatePlaybackVisual);
  audio.addEventListener('pause', updatePlaybackVisual);
  audio.addEventListener('play', updatePlaybackVisual);
  window.addEventListener('resize', redrawTimeline);

  updateProgressBackground(0);
  initialiseData();
})();
