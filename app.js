'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let currentFile    = null;
let currentWorkout = null;
let currentOutput  = null; // { blob, filename }

// ─── DOM refs ────────────────────────────────────────────────────────────────

const dropZone        = document.getElementById('dropZone');
const fileInput       = document.getElementById('fileInput');
const optionsSection  = document.getElementById('optionsSection');
const resultSection   = document.getElementById('resultSection');
const errorSection    = document.getElementById('errorSection');
const startDateInput  = document.getElementById('startDateInput');
const convertBtn      = document.getElementById('convertBtn');
const downloadBtn     = document.getElementById('downloadBtn');
const resetBtn        = document.getElementById('resetBtn');
const errorResetBtn   = document.getElementById('errorResetBtn');
const errorMsg        = document.getElementById('errorMsg');
const statsGrid       = document.getElementById('statsGrid');
const chartWrap       = document.getElementById('chartWrap');
const browseBtn       = document.getElementById('browseBtn');
const uploadStravaBtn = document.getElementById('uploadStravaBtn');
const uploadTpBtn     = document.getElementById('uploadTpBtn');
const uploadStatus    = document.getElementById('uploadStatus');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

/** Convert a UTC Date to a value suitable for <input type="datetime-local"> */
function toDatetimeLocalValue(date) {
  // datetime-local needs local time as YYYY-MM-DDTHH:MM
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function showSection(id) {
  ['optionsSection', 'resultSection', 'errorSection'].forEach(s => {
    document.getElementById(s).hidden = (s !== id);
  });
}

function hideAllSections() {
  ['optionsSection', 'resultSection', 'errorSection'].forEach(s => {
    document.getElementById(s).hidden = true;
  });
}

function showError(message) {
  errorMsg.textContent = message;
  showSection('errorSection');
}

function reset() {
  currentFile    = null;
  currentWorkout = null;
  currentOutput  = null;
  fileInput.value = '';
  hideAllSections();
  dropZone.classList.remove('drop-zone--active', 'drop-zone--loaded');
  uploadStatus.hidden        = true;
  uploadStatus.innerHTML     = '';
  uploadStatus.dataset.state = '';
}

// ─── File handling ────────────────────────────────────────────────────────────

function handleFile(file) {
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.3dp')) {
    showError(`"${file.name}" does not appear to be a .3dp file. Please select a PerfPro file.`);
    return;
  }

  currentFile = file;
  hideAllSections();

  // Pre-populate the start time from the filename
  const detected = PerfProConverter.extractStartTime(file.name);
  if (detected) {
    startDateInput.value = toDatetimeLocalValue(detected);
  } else {
    // Fall back to now (local time)
    startDateInput.value = toDatetimeLocalValue(new Date());
  }

  dropZone.classList.add('drop-zone--loaded');
  showSection('optionsSection');
}

// ─── Platform upload ─────────────────────────────────────────────────────────

function setUploadStatus(state, message, url) {
  uploadStatus.hidden        = false;
  uploadStatus.dataset.state = state;
  uploadStatus.innerHTML     = message +
    (url ? ` <a href="${url}" target="_blank" rel="noopener">View on platform →</a>` : '');
}

function startOAuth(platformKey) {
  if (!currentOutput) return;
  const cfg = PLATFORMS[platformKey];

  currentOutput.blob.text().then(tcxText => {
    sessionStorage.setItem('pendingUpload', JSON.stringify({
      content:  tcxText,
      filename: currentOutput.filename,
    }));

    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    const authUrl =
      `${cfg.authUrl}?client_id=${cfg.clientId}` +
      `&redirect_uri=${redirectUri}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(cfg.scope)}` +
      `&state=${platformKey}` +
      `&approval_prompt=auto`;

    window.location.href = authUrl;
  });
}

async function handleOAuthCallback(platformKey, code, blob, filename) {
  const cfg = PLATFORMS[platformKey];
  try {
    const tokenRes = await fetch(cfg.tokenUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  window.location.origin + window.location.pathname,
      }),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);
    const { access_token } = await tokenRes.json();

    setUploadStatus('pending', `Uploading to ${cfg.name}…`);
    await uploadFile(platformKey, access_token, blob, filename);

  } catch (err) {
    setUploadStatus('error', `Upload failed: ${err.message}`);
  }
}

async function uploadFile(platformKey, accessToken, blob, filename) {
  const cfg  = PLATFORMS[platformKey];
  const form = new FormData();

  if (platformKey === 'strava') {
    form.append('file',      blob, filename);
    form.append('data_type', 'tcx');
    form.append('name',      filename.replace(/\.tcx$/i, '').replace(/_/g, ' '));
  } else {
    form.append('file', blob, filename);
  }

  const res = await fetch(cfg.uploadUrl, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body:    form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${cfg.name} returned ${res.status}${detail ? ': ' + detail : ''}`);
  }

  const activityUrl = platformKey === 'strava'
    ? 'https://www.strava.com/athlete/training'
    : 'https://app.trainingpeaks.com/';

  setUploadStatus('success', `Successfully uploaded to ${cfg.name}!`, activityUrl);
}

// Check for OAuth callback on page load (fires after redirect back from platform)
(function checkOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const state  = params.get('state');
  const error  = params.get('error');

  if (!code && !error) return;

  history.replaceState(null, '', window.location.pathname);

  const pending = JSON.parse(sessionStorage.getItem('pendingUpload') || 'null');
  sessionStorage.removeItem('pendingUpload');

  if (error || !pending || !state || !PLATFORMS[state]) {
    showSection('resultSection');
    setUploadStatus('error', `Authorization was cancelled or failed: ${error || 'unknown error'}`);
    return;
  }

  const blob = new Blob([pending.content], { type: 'application/xml' });
  currentOutput = { blob, filename: pending.filename };
  showSection('resultSection');
  setUploadStatus('pending', `Connecting to ${PLATFORMS[state].name}…`);
  handleOAuthCallback(state, code, blob, pending.filename);
})();

// ─── Drag and drop ───────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drop-zone--active');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drop-zone--active');
});

dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drop-zone--active');
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

dropZone.addEventListener('click', () => fileInput.click());

// Browse button: open file picker without letting the click bubble to dropZone
// (which would call fileInput.click() a second time and cancel the dialog).
browseBtn.addEventListener('click', e => {
  e.stopPropagation();
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
});

// ─── Power chart ─────────────────────────────────────────────────────────────

function buildPowerChart(trackpoints, stats) {
  const VW = 640, VH = 210;
  const padL = 52, padR = 20, padT = 18, padB = 38;
  const plotW = VW - padL - padR;
  const plotH = VH - padT - padB;

  const maxSec = stats.durationSec || 1;

  // Round the Y ceiling up to the nearest 50 W for clean grid lines
  const yMax = Math.max(50, Math.ceil(stats.maxWatts / 50) * 50);
  const avgW  = stats.avgWatts;

  const sx = sec   => padL + (sec   / maxSec) * plotW;
  const sy = watts => padT + plotH  - (watts  / yMax)  * plotH;

  // ── Area + line path ──────────────────────────────────────────────────────
  let lineParts = [];
  trackpoints.forEach((tp, i) => {
    const x = sx(tp.sec).toFixed(2);
    const y = sy(tp.watts).toFixed(2);
    lineParts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
  });
  const linePath = lineParts.join(' ');

  const firstX = sx(trackpoints[0].sec).toFixed(2);
  const lastX  = sx(trackpoints[trackpoints.length - 1].sec).toFixed(2);
  const baseY  = (padT + plotH).toFixed(2);
  const areaPath = `${linePath} L${lastX},${baseY} L${firstX},${baseY} Z`;

  // ── Y axis ticks ─────────────────────────────────────────────────────────
  const yStep = yMax <= 200 ? 50 : yMax <= 400 ? 100 : 150;
  let gridLines = '', yLabels = '';
  for (let w = 0; w <= yMax; w += yStep) {
    const y = sy(w).toFixed(2);
    gridLines += `<line x1="${padL}" y1="${y}" x2="${VW - padR}" y2="${y}" />`;
    yLabels   += `<text x="${padL - 8}" y="${y}" dy="0.35em">${w}</text>`;
  }

  // ── X axis ticks (every 10 min, or every 5 min for short rides) ──────────
  const xTickInterval = maxSec <= 1800 ? 300 : 600; // 5 min or 10 min
  let xLabels = '';
  for (let s = 0; s <= maxSec; s += xTickInterval) {
    const x   = sx(s).toFixed(2);
    const min = Math.floor(s / 60);
    xLabels += `<text x="${x}" y="${padT + plotH + 20}">${min}m</text>`;
  }

  // ── Average power line ────────────────────────────────────────────────────
  const avgY    = sy(avgW).toFixed(2);
  const avgLine = `<line class="chart__avg-line" x1="${padL}" y1="${avgY}" x2="${VW - padR}" y2="${avgY}" />`;
  const avgLabel = `<text class="chart__avg-label" x="${VW - padR + 4}" y="${avgY}" dy="0.35em">${avgW}W</text>`;

  return `
<svg class="power-chart" viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" aria-label="Power output chart">
  <defs>
    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#4f8ef7" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#4f8ef7" stop-opacity="0.04" />
    </linearGradient>
    <clipPath id="plotClip">
      <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" />
    </clipPath>
  </defs>

  <!-- Grid lines -->
  <g class="chart__grid">${gridLines}</g>

  <!-- Plot area clipped -->
  <g clip-path="url(#plotClip)">
    <path class="chart__area" d="${areaPath}" fill="url(#areaGrad)" />
    <path class="chart__line" d="${linePath}" />
    ${avgLine}
  </g>

  <!-- Avg label (outside clip) -->
  ${avgLabel}

  <!-- Axes -->
  <line class="chart__axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" />
  <line class="chart__axis" x1="${padL}" y1="${padT + plotH}" x2="${VW - padR}" y2="${padT + plotH}" />

  <!-- Labels -->
  <g class="chart__y-labels">${yLabels}</g>
  <g class="chart__x-labels">${xLabels}</g>

  <!-- Axis titles -->
  <text class="chart__axis-title chart__axis-title--y"
        transform="rotate(-90) translate(${-(padT + plotH / 2)}, 12)">Watts</text>
  <text class="chart__axis-title chart__axis-title--x"
        x="${padL + plotW / 2}" y="${VH - 2}">Time</text>
</svg>`.trim();
}

// ─── Convert ─────────────────────────────────────────────────────────────────

convertBtn.addEventListener('click', () => {
  if (!currentFile) return;

  convertBtn.disabled = true;
  convertBtn.textContent = 'Converting…';

  const reader = new FileReader();

  reader.onload = function (e) {
    try {
      currentWorkout = PerfProConverter.parse3dp(e.target.result);
    } catch (err) {
      convertBtn.disabled = false;
      convertBtn.textContent = 'Convert';
      showError(`Parse error: ${err.message}`);
      return;
    }

    // Read chosen start time from the picker (treat as local time)
    const pickerValue = startDateInput.value; // "YYYY-MM-DDTHH:MM"
    const startTime   = pickerValue ? new Date(pickerValue) : new Date();

    let outputContent;
    let outputFilename;
    let mimeType;

    const format = document.getElementById('formatSelect').value;

    if (format === 'tcx') {
      outputContent  = PerfProConverter.buildTcx(currentWorkout, startTime);
      outputFilename = currentFile.name.replace(/\.3dp$/i, '.tcx');
      mimeType       = 'application/xml';
    }

    const blob = new Blob([outputContent], { type: mimeType });
    currentOutput = { blob, filename: outputFilename };

    // Build stats display
    const { stats, athleteName } = currentWorkout;
    statsGrid.innerHTML = '';

    // Build power chart
    chartWrap.innerHTML = buildPowerChart(currentWorkout.trackpoints, stats);

    const rows = [
      ['Athlete',      athleteName],
      ['Duration',     formatDuration(stats.durationSec)],
      ['Avg Power',    `${stats.avgWatts} W`],
      ['Max Power',    `${stats.maxWatts} W`],
      ['Cadence',      stats.hasCadence ? 'Included (sensor detected)' : 'Not included (no sensor)'],
      ['Heart Rate',   stats.hasHR      ? 'Included (HR monitor detected)' : 'Not included (no monitor)'],
      ['Trackpoints',  currentWorkout.trackpoints.length.toLocaleString()],
      ['Output File',  outputFilename],
    ];

    rows.forEach(([label, value]) => {
      statsGrid.insertAdjacentHTML('beforeend',
        `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`
      );
    });

    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert';
    showSection('resultSection');

    uploadStravaBtn.hidden      = !PLATFORMS.strava.enabled;
    uploadTpBtn.hidden          = !PLATFORMS.trainingpeaks.enabled;
    uploadStatus.hidden         = true;
    uploadStatus.innerHTML      = '';
    uploadStatus.dataset.state  = '';
  };

  reader.onerror = function () {
    convertBtn.disabled = false;
    convertBtn.textContent = 'Convert';
    showError('Could not read the file. Please try again.');
  };

  reader.readAsArrayBuffer(currentFile);
});

// ─── Download ────────────────────────────────────────────────────────────────

downloadBtn.addEventListener('click', () => {
  if (!currentOutput) return;
  const url = URL.createObjectURL(currentOutput.blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = currentOutput.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// ─── Platform upload buttons ─────────────────────────────────────────────────

uploadStravaBtn.addEventListener('click', () => startOAuth('strava'));
uploadTpBtn.addEventListener('click',     () => startOAuth('trainingpeaks'));

// ─── Reset ───────────────────────────────────────────────────────────────────

resetBtn.addEventListener('click', reset);
errorResetBtn.addEventListener('click', reset);
