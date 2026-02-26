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

// ─── ZIP extraction ───────────────────────────────────────────────────────────

async function extractFromZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // Locate End of Central Directory (EOCD) by scanning backward for PK\x05\x06
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP file.');

  const entryCount  = view.getUint16(eocdOffset + 10, true);
  const cdOffset    = view.getUint32(eocdOffset + 16, true);

  // Parse Central Directory to find .3dp entries
  const CD_SIG = 0x02014b50;
  const matches = [];
  let pos = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== CD_SIG) break;
    const compression      = view.getUint16(pos + 10, true);
    const compressedSize   = view.getUint32(pos + 20, true);
    const fileNameLen      = view.getUint16(pos + 28, true);
    const extraLen         = view.getUint16(pos + 30, true);
    const commentLen       = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const fileName = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + fileNameLen));

    if (fileName.toLowerCase().endsWith('.3dp')) {
      matches.push({ fileName, compression, compressedSize, localHeaderOffset });
    }
    pos += 46 + fileNameLen + extraLen + commentLen;
  }

  if (matches.length === 0) throw new Error('No .3dp file found inside the ZIP.');
  if (matches.length > 1)   throw new Error('Multiple .3dp files found in ZIP; please include only one.');

  // Extract file data using the local file header to find the data start
  const { fileName, compression, compressedSize, localHeaderOffset } = matches[0];
  const LFH_SIG = 0x04034b50;
  if (view.getUint32(localHeaderOffset, true) !== LFH_SIG) throw new Error('Invalid local file header in ZIP.');

  const localFileNameLen = view.getUint16(localHeaderOffset + 26, true);
  const localExtraLen    = view.getUint16(localHeaderOffset + 28, true);
  const dataStart        = localHeaderOffset + 30 + localFileNameLen + localExtraLen;
  const compressedData   = bytes.slice(dataStart, dataStart + compressedSize);

  if (compression === 0) {
    // Stored — no decompression needed
    return { fileName, data: compressedData };
  }

  if (compression === 8) {
    // Deflated — decompress with native DecompressionStream
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(compressedData);
    writer.close();

    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const data = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return { fileName, data };
  }

  throw new Error(`Unsupported ZIP compression method: ${compression}.`);
}

// ─── File handling ────────────────────────────────────────────────────────────

async function handleFile(file) {
  if (!file) return;

  if (file.name.toLowerCase().endsWith('.zip')) {
    dropZone.classList.add('drop-zone--active');
    try {
      const ab = await file.arrayBuffer();
      const extracted = await extractFromZip(ab);
      const inner = new File([extracted.data], extracted.fileName, { type: 'application/octet-stream' });
      dropZone.classList.remove('drop-zone--active');
      handleFile(inner);
    } catch (err) {
      dropZone.classList.remove('drop-zone--active');
      showError(err.message);
    }
    return;
  }

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

// ─── Platform defaults ───────────────────────────────────────────────────────
// Safe fallback: both platforms disabled. config.js (loaded after this script)
// overrides this with real credentials when present. Because config.js uses
// `var PLATFORMS`, it simply reassigns this global. If config.js is absent or
// fails to load, this fallback remains in effect and upload buttons stay hidden.
/* eslint-disable no-var */
var PLATFORMS = { strava: { enabled: false }, trainingpeaks: { enabled: false } };
/* eslint-enable no-var */

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
// Must run after DOMContentLoaded so that config.js has already executed and
// PLATFORMS contains the real credentials (tokenUrl, uploadUrl, etc.).
document.addEventListener('DOMContentLoaded', function checkOAuthCallback() {
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
});

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
  const hasSpeed = stats.totalDistMeters > 0;

  const VW = 640, VH = 210;
  const padL = 52, padR = hasSpeed ? 58 : 20, padT = 18, padB = 38;
  const plotW = VW - padL - padR;
  const plotH = VH - padT - padB;

  const maxSec = stats.durationSec || 1;

  // ── Power scale (left Y) ─────────────────────────────────────────────────
  const yMax = Math.max(50, Math.ceil(stats.maxWatts / 50) * 50);
  const avgW  = stats.avgWatts;

  const sx  = sec   => padL + (sec   / maxSec) * plotW;
  const syW = watts => padT + plotH  - (watts  / yMax)  * plotH;

  // ── Speed data (right Y) ─────────────────────────────────────────────────
  let speedLinePath = '', speedYLabels = '', speedRightAxis = '', speedTitle = '', legend = '';

  if (hasSpeed) {
    // Instantaneous speed (m/s → mph) from per-second cumulative distance deltas
    const raw = trackpoints.map((tp, i) => {
      if (tp.distMeters === null || i === 0) return { sec: tp.sec, mph: 0 };
      const prev = trackpoints[i - 1];
      if (prev.distMeters === null) return { sec: tp.sec, mph: 0 };
      const deltaSec = tp.sec - prev.sec;
      const mph = deltaSec > 0 ? ((tp.distMeters - prev.distMeters) / deltaSec) * 2.23694 : 0;
      return { sec: tp.sec, mph: Math.max(0, mph) };
    });

    // 5-point rolling average for smoothness
    const HALF = 2;
    const speedPoints = raw.map((d, i) => {
      const slice = raw.slice(Math.max(0, i - HALF), i + HALF + 1);
      return { sec: d.sec, mph: slice.reduce((s, v) => s + v.mph, 0) / slice.length };
    });

    const speedMax = Math.max(5, Math.ceil(Math.max(...speedPoints.map(d => d.mph)) / 5) * 5);
    const syS = mph => padT + plotH - (mph / speedMax) * plotH;

    // Right Y axis labels
    const sStep = speedMax <= 20 ? 5 : speedMax <= 40 ? 10 : 15;
    for (let v = 0; v <= speedMax; v += sStep) {
      const y = syS(v).toFixed(2);
      speedYLabels += `<text x="${VW - padR + 8}" y="${y}" dy="0.35em">${v}</text>`;
    }

    speedRightAxis = `<line class="chart__axis" x1="${VW - padR}" y1="${padT}" x2="${VW - padR}" y2="${padT + plotH}" />`;
    speedTitle     = `<text class="chart__axis-title" x="${VW - padR}" y="${padT - 6}" text-anchor="middle">mph</text>`;

    // Speed line path
    speedLinePath = speedPoints
      .map((d, i) => (i === 0 ? 'M' : 'L') + sx(d.sec).toFixed(2) + ',' + syS(d.mph).toFixed(2))
      .join(' ');

    legend = `
  <g class="chart__legend" transform="translate(${padL + 8}, ${padT + 8})">
    <line x1="0" y1="0" x2="14" y2="0" class="chart__line" />
    <text x="18" dy="0.35em" class="chart__legend-label">Power</text>
    <line x1="72" y1="0" x2="86" y2="0" class="chart__speed-line" />
    <text x="90" dy="0.35em" class="chart__legend-label">Speed</text>
  </g>`;
  }

  // ── Power area + line path ────────────────────────────────────────────────
  let lineParts = [];
  trackpoints.forEach((tp, i) => {
    const x = sx(tp.sec).toFixed(2);
    const y = syW(tp.watts).toFixed(2);
    lineParts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`);
  });
  const linePath = lineParts.join(' ');

  const firstX = sx(trackpoints[0].sec).toFixed(2);
  const lastX  = sx(trackpoints[trackpoints.length - 1].sec).toFixed(2);
  const baseY  = (padT + plotH).toFixed(2);
  const areaPath = `${linePath} L${lastX},${baseY} L${firstX},${baseY} Z`;

  // ── Power Y axis ticks ────────────────────────────────────────────────────
  const yStep = yMax <= 200 ? 50 : yMax <= 400 ? 100 : 150;
  let gridLines = '', yLabels = '';
  for (let w = 0; w <= yMax; w += yStep) {
    const y = syW(w).toFixed(2);
    gridLines += `<line x1="${padL}" y1="${y}" x2="${VW - padR}" y2="${y}" />`;
    yLabels   += `<text x="${padL - 8}" y="${y}" dy="0.35em">${w}</text>`;
  }

  // ── X axis ticks (every 10 min, or every 5 min for short rides) ──────────
  const xTickInterval = maxSec <= 1800 ? 300 : 600;
  let xLabels = '';
  for (let s = 0; s <= maxSec; s += xTickInterval) {
    const x   = sx(s).toFixed(2);
    const min = Math.floor(s / 60);
    xLabels += `<text x="${x}" y="${padT + plotH + 20}">${min}m</text>`;
  }

  // ── Average power line ────────────────────────────────────────────────────
  const avgY    = syW(avgW).toFixed(2);
  const avgLine = `<line class="chart__avg-line" x1="${padL}" y1="${avgY}" x2="${VW - padR}" y2="${avgY}" />`;
  // Avg label only shown in single-axis mode; right side is occupied by speed axis when dual
  const avgLabel = hasSpeed ? '' : `<text class="chart__avg-label" x="${VW - padR + 4}" y="${avgY}" dy="0.35em">${avgW}W</text>`;

  return `
<svg class="power-chart" viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg" aria-label="Power${hasSpeed ? ' and speed' : ''} chart">
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

  <!-- Power area + line -->
  <g clip-path="url(#plotClip)">
    <path class="chart__area" d="${areaPath}" fill="url(#areaGrad)" />
    <path class="chart__line" d="${linePath}" />
    ${avgLine}
  </g>

  <!-- Speed line -->
  ${hasSpeed ? `<g clip-path="url(#plotClip)"><path class="chart__speed-line" d="${speedLinePath}" /></g>` : ''}

  <!-- Avg label (single-axis mode only) -->
  ${avgLabel}

  <!-- Axes -->
  <line class="chart__axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" />
  <line class="chart__axis" x1="${padL}" y1="${padT + plotH}" x2="${VW - padR}" y2="${padT + plotH}" />
  ${speedRightAxis}

  <!-- Labels -->
  <g class="chart__y-labels">${yLabels}</g>
  <g class="chart__x-labels">${xLabels}</g>
  ${hasSpeed ? `<g class="chart__y-labels chart__y-labels--right">${speedYLabels}</g>` : ''}

  <!-- Axis titles -->
  <text class="chart__axis-title chart__axis-title--y"
        transform="rotate(-90) translate(${-(padT + plotH / 2)}, 12)">Watts</text>
  <text class="chart__axis-title chart__axis-title--x"
        x="${padL + plotW / 2}" y="${VH - 2}">Time</text>
  ${speedTitle}

  <!-- Legend -->
  ${legend}
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

    const distKm    = stats.totalDistMeters / 1000;
    const distMiles = distKm * 0.621371;
    const hours     = stats.durationSec / 3600;
    const avgSpeedMph = hours > 0 ? distMiles / hours : 0;
    const avgSpeedKph = hours > 0 ? distKm    / hours : 0;

    const rows = [
      ['Athlete',      athleteName],
      ['Duration',     formatDuration(stats.durationSec)],
      ['Avg Power',    `${stats.avgWatts} W`],
      ['Max Power',    `${stats.maxWatts} W`],
      ...(stats.totalDistMeters > 0 ? [
        ['Distance',   `${distMiles.toFixed(2)} mi (${distKm.toFixed(2)} km)`],
        ['Avg Speed',  `${avgSpeedMph.toFixed(1)} mph (${avgSpeedKph.toFixed(1)} km/h)`],
      ] : []),
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
