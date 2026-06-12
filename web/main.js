// ===== Video Compressor — Frontend (Flask + FFmpeg Backend) =====

const API = '/api';

// ===== STATE =====
let selectedFile = null;
let currentJobId = null;
let pollTimer = null;

// ===== DOM =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  dropZone:         $('#drop-zone'),
  fileInput:        $('#file-input'),
  fileInfo:         $('#file-info'),
  fileName:         $('#file-name'),
  fileSize:         $('#file-size'),
  btnRemoveFile:    $('#btn-remove-file'),

  tabs:             $$('.tab'),
  tabBasic:         $('#tab-basic'),
  tabAdvanced:      $('#tab-advanced'),

  outputSlider:     $('#output-size-slider'),
  outputInput:      $('#output-size-input'),
  presetBtns:       $$('.preset-btn'),
  crfSlider:        $('#crf-slider'),
  crfValue:         $('#crf-value'),
  resolutionSelect: $('#resolution-select'),
  formatSelect:     $('#format-select'),
  bitrateInput:     $('#bitrate-input'),
  muteAudio:        $('#mute-audio'),

  btnCompress:      $('#btn-compress'),
  progressOverlay:  $('#progress-overlay'),
  progressTitle:    $('#progress-title'),
  progressMessage:  $('#progress-message'),
  progressBar:      $('#progress-bar'),
  progressPercent:  $('#progress-percent'),
  btnCancel:        $('#btn-cancel'),

  resultSection:    $('#result-section'),
  resultOrigSize:   $('#result-original-size'),
  resultCompSize:   $('#result-compressed-size'),
  compressionRatio: $('#compression-ratio'),
  previewOriginal:  $('#preview-original'),
  previewCompressed:$('#preview-compressed'),
  btnDownload:      $('#btn-download'),
  btnNew:           $('#btn-new'),
};

// ===== UTILITY =====
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 1 ? 2 : 0) + ' ' + sizes[i];
}

// ===== FILE HANDLING =====
function handleFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    alert('Please select a valid video file.');
    return;
  }

  if (file.size > 5 * 1024 * 1024 * 1024) {
    alert('File is too large. Maximum size is 5 GB.');
    return;
  }

  selectedFile = file;

  dom.fileName.textContent = file.name;
  dom.fileSize.textContent = formatBytes(file.size);
  dom.fileInfo.classList.remove('hidden');
  dom.dropZone.style.display = 'none';
  $('#btn-choose').parentElement.style.display = 'none';
  dom.btnCompress.disabled = false;

  // Set slider max to original file size in MB
  const sizeMB = Math.ceil(file.size / (1024 * 1024));
  dom.outputSlider.max = sizeMB;
  dom.outputSlider.value = Math.max(1, Math.round(sizeMB * 0.5));
  dom.outputInput.value = dom.outputSlider.value;

  dom.resultSection.classList.add('hidden');
}

function removeFile() {
  selectedFile = null;
  dom.fileInfo.classList.add('hidden');
  dom.dropZone.style.display = '';
  $('#btn-choose').parentElement.style.display = '';
  dom.btnCompress.disabled = true;
  dom.fileInput.value = '';
  dom.resultSection.classList.add('hidden');
}

// ===== COMPRESSION =====
function getActiveTab() {
  return dom.tabBasic.classList.contains('active') ? 'basic' : 'advanced';
}

async function startCompression() {
  if (!selectedFile) return;

  // Show progress
  dom.progressOverlay.classList.remove('hidden');
  dom.progressBar.style.width = '0%';
  dom.progressPercent.textContent = '0%';
  dom.progressTitle.textContent = 'Compressing Video…';
  dom.progressMessage.textContent = 'Uploading video to compressor…';

  try {
    // Build form data
    const formData = new FormData();
    formData.append('video', selectedFile);
    formData.append('mode', getActiveTab());

    if (getActiveTab() === 'basic') {
      formData.append('targetSizeMB', dom.outputInput.value);
      const activePreset = document.querySelector('.preset-btn.active');
      formData.append('quality', activePreset ? activePreset.dataset.quality : 'medium');
    } else {
      formData.append('crf', dom.crfSlider.value);
      formData.append('resolution', dom.resolutionSelect.value);
      formData.append('format', dom.formatSelect.value);
      formData.append('bitrate', dom.bitrateInput.value);
      formData.append('muteAudio', dom.muteAudio.checked.toString());
    }

    // Upload with progress tracking via XMLHttpRequest
    const { jobId, encoder } = await uploadFile(formData);
    currentJobId = jobId;

    dom.progressMessage.textContent = `Compressing with ${encoder}…`;

    // Poll for progress
    pollProgress(jobId, encoder);

  } catch (err) {
    console.error('Compression error:', err);
    alert('Compression failed: ' + err.message);
    dom.progressOverlay.classList.add('hidden');
  }
}

function uploadFile(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        dom.progressBar.style.width = (pct * 0.3) + '%';
        dom.progressPercent.textContent = Math.round(pct * 0.3) + '%';
        dom.progressMessage.textContent = `Uploading… ${formatBytes(e.loaded)} / ${formatBytes(e.total)}`;
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        resolve({ jobId: data.jobId, encoder: data.encoder || 'FFmpeg' });
      } else {
        reject(new Error(`Upload failed: ${xhr.statusText}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    xhr.open('POST', `${API}/compress`);
    xhr.send(formData);
  });
}

function pollProgress(jobId, encoderName) {
  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`${API}/status/${jobId}`);
      const data = await resp.json();

      if (data.status === 'processing') {
        const totalPct = 30 + Math.round(data.progress * 0.7);
        dom.progressBar.style.width = totalPct + '%';
        dom.progressPercent.textContent = totalPct + '%';
        const elapsed = data.elapsed ? ` • ${data.elapsed}s elapsed` : '';
        dom.progressMessage.textContent = `⚡ ${encoderName} — ${data.progress}% done${elapsed}`;

      } else if (data.status === 'done') {
        clearInterval(pollTimer);
        pollTimer = null;
        dom.progressBar.style.width = '100%';
        dom.progressPercent.textContent = '100%';
        dom.progressMessage.textContent = `✅ Done in ${data.elapsed}s!`;

        setTimeout(() => {
          dom.progressOverlay.classList.add('hidden');
          showResult(data.originalSize, data.compressedSize, data.ratio, jobId, data.elapsed);
        }, 800);

      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        pollTimer = null;
        dom.progressOverlay.classList.add('hidden');
        alert('Compression error: ' + (data.error || 'Unknown error'));

      } else if (data.status === 'cancelled') {
        clearInterval(pollTimer);
        pollTimer = null;
        dom.progressOverlay.classList.add('hidden');
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, 400);
}

async function cancelCompression() {
  if (currentJobId) {
    try {
      await fetch(`${API}/cancel/${currentJobId}`, { method: 'POST' });
    } catch (e) {}
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  dom.progressOverlay.classList.add('hidden');
  currentJobId = null;
}

// ===== RESULT =====
function showResult(originalSize, compressedSize, ratio, jobId, elapsed) {
  dom.resultOrigSize.textContent = formatBytes(originalSize);
  dom.resultCompSize.textContent = formatBytes(compressedSize);
  dom.compressionRatio.textContent = ratio + '% smaller';

  // Show elapsed time
  const timeEl = document.getElementById('result-time');
  if (timeEl) timeEl.textContent = `Compressed in ${elapsed}s`;

  const origURL = URL.createObjectURL(selectedFile);
  dom.previewOriginal.src = origURL;
  dom.previewCompressed.src = `${API}/download/${jobId}`;

  dom.resultSection.classList.remove('hidden');
  dom.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function downloadResult() {
  if (!currentJobId) return;

  const btn = dom.btnDownload;
  const originalHTML = btn.innerHTML;
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="10"><animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg> Downloading…`;
  btn.disabled = true;

  try {
    const resp = await fetch(`${API}/download/${currentJobId}`);
    if (!resp.ok) throw new Error('Download failed');

    const blob = await resp.blob();
    const contentDisposition = resp.headers.get('Content-Disposition') || '';
    let filename = 'compressed_video.mp4';

    // Extract filename from Content-Disposition header
    const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/);
    if (filenameMatch) {
      filename = filenameMatch[1];
    } else if (selectedFile) {
      const baseName = selectedFile.name.replace(/\.[^.]+$/, '');
      filename = `${baseName}_compressed.mp4`;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Download error:', err);
    alert('Download failed. Please try again.');
  } finally {
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

function resetApp() {
  removeFile();
  currentJobId = null;

  if (dom.previewOriginal.src) {
    URL.revokeObjectURL(dom.previewOriginal.src);
    dom.previewOriginal.removeAttribute('src');
  }
  dom.previewCompressed.removeAttribute('src');
}

// ===== EVENT LISTENERS =====
function init() {
  dom.fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  dom.dropZone.addEventListener('click', () => dom.fileInput.click());

  dom.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropZone.classList.add('dragover');
  });
  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('dragover');
  });
  dom.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  dom.btnRemoveFile.addEventListener('click', removeFile);

  dom.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      dom.tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      dom.tabBasic.classList.toggle('active', target === 'basic');
      dom.tabAdvanced.classList.toggle('active', target === 'advanced');
    });
  });

  dom.outputSlider.addEventListener('input', () => {
    dom.outputInput.value = dom.outputSlider.value;
  });
  dom.outputInput.addEventListener('input', () => {
    const val = Math.max(1, Math.min(parseInt(dom.outputInput.value, 10) || 1, parseInt(dom.outputSlider.max, 10)));
    dom.outputSlider.value = val;
  });

  dom.crfSlider.addEventListener('input', () => {
    dom.crfValue.textContent = dom.crfSlider.value;
  });

  dom.presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      dom.presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  dom.btnCompress.addEventListener('click', startCompression);
  dom.btnCancel.addEventListener('click', cancelCompression);
  dom.btnDownload.addEventListener('click', downloadResult);
  dom.btnNew.addEventListener('click', resetApp);

  // Check backend health
  checkBackend();
}

async function checkBackend() {
  try {
    const resp = await fetch(`${API}/health`);
    if (resp.ok) {
      const data = await resp.json();
      console.log(`✅ Backend connected — Encoder: ${data.encoder}`);
    }
  } catch {
    console.warn('Backend not reachable. Is the container running?');
  }
}

init();
