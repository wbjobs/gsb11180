/*
 * 主线程：只负责 UI。
 * 所有文件读取、缓冲、SHA-256 计算都在 worker.js 内完成，
 * 这里仅接收 5Hz 的节流进度消息，并在 requestAnimationFrame 中渲染。
 */
'use strict';

const els = {
  fileInput: document.getElementById('file-input'),
  fileLabel: document.getElementById('file-label'),
  fileMeta: document.getElementById('file-meta'),
  fileName: document.getElementById('file-name'),
  fileSize: document.getElementById('file-size'),
  chunkSize: document.getElementById('chunk-size'),
  btnStart: document.getElementById('btn-start'),
  btnPause: document.getElementById('btn-pause'),
  btnResume: document.getElementById('btn-resume'),
  btnCancel: document.getElementById('btn-cancel'),
  btnCopy: document.getElementById('btn-copy'),
  errorBanner: document.getElementById('error-banner'),
  statusText: document.getElementById('status-text'),
  percentText: document.getElementById('percent-text'),
  progressBar: document.getElementById('progress-bar'),
  mBytes: document.getElementById('m-bytes'),
  mSpeed: document.getElementById('m-speed'),
  mElapsed: document.getElementById('m-elapsed'),
  mEta: document.getElementById('m-eta'),
  resultBox: document.getElementById('result-box'),
  resultHash: document.getElementById('result-hash'),
  resultVia: document.getElementById('result-via'),
  hFps: document.getElementById('h-fps'),
  hLongtasks: document.getElementById('h-longtasks'),
  hLongtaskMax: document.getElementById('h-longtask-max')
};

const MIN_CHUNK = 1024 * 1024;          // 1 MiB
const MAX_CHUNK = 64 * 1024 * 1024;     // 64 MiB
const SPEED_WINDOW_MS = 3000;           // 速度滑动窗口

let worker = null;
let runId = 0;
let selectedFile = null;
let session = null;
// session: { id, state, bytesTotal, bytesRead,
//            startAt, pausedAt, pausedTotal, samples: [{t, bytes}] }

function createWorker() {
  const w = new Worker('worker.js');
  w.onmessage = onWorkerMessage;
  w.onerror = (e) => {
    showError('哈希线程发生错误：' + (e.message || '未知错误') + '。请刷新页面后重试。');
    finishLocal('error');
  };
  return w;
}

function ensureWorker() {
  if (!worker) worker = createWorker();
  return worker;
}

// ---------- 格式化 ----------
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 ? 1 : 2) + ' ' + units[i];
}

function formatDuration(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function activeDuration(now) {
  if (!session || !session.startAt) return 0;
  let d = now - session.startAt - session.pausedTotal;
  if (session.pausedAt != null) d -= now - session.pausedAt;
  return Math.max(0, d);
}

// 用滑动窗口内首尾两点估算速度，天然平滑且不受单次抖动影响。
function currentSpeed(now) {
  if (!session || session.samples.length < 2) return 0;
  const cutoff = now - SPEED_WINDOW_MS;
  while (session.samples.length > 2 && session.samples[0].t < cutoff) {
    session.samples.shift();
  }
  const first = session.samples[0];
  const last = session.samples[session.samples.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.bytes - first.bytes) / dt : 0;
}

// ---------- 状态切换 ----------
function setButtons(state) {
  const hasFile = !!selectedFile;
  const busy = state === 'running' || state === 'paused' || state === 'starting';
  els.btnStart.disabled = busy || !hasFile;
  els.btnPause.disabled = state !== 'running';
  els.btnResume.disabled = state !== 'paused';
  els.btnCancel.disabled = !busy;
  els.fileInput.disabled = busy;
  els.chunkSize.disabled = busy;

  const labels = {
    idle: '等待开始',
    starting: '正在启动…',
    running: '读取并计算中…',
    paused: '已暂停',
    done: '计算完成',
    canceled: '已取消',
    error: '出错了'
  };
  els.statusText.textContent = labels[state] || labels.idle;

  els.progressBar.classList.toggle('is-paused', state === 'paused');
  els.progressBar.classList.toggle('is-done', state === 'done');
  els.progressBar.classList.toggle('is-error', state === 'error');
}

function showError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.hidden = false;
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
}

function finishLocal(state) {
  if (!session) return;
  session.state = state;
  setButtons(state);
  render(performance.now());
}

// ---------- Worker 消息 ----------
function onWorkerMessage(e) {
  const msg = e.data || {};
  if (!session || msg.id !== session.id) return;
  const now = performance.now();

  switch (msg.type) {
    case 'started': {
      session.state = 'running';
      session.bytesTotal = msg.bytesTotal;
      session.startAt = now;
      session.pausedAt = null;
      session.pausedTotal = 0;
      session.samples = [{ t: now, bytes: 0 }];
      clearError();
      els.resultBox.hidden = true;
      setButtons('running');
      break;
    }
    case 'progress': {
      session.bytesRead = msg.bytesRead;
      session.samples.push({ t: now, bytes: msg.bytesRead });
      break;
    }
    case 'paused': {
      session.bytesRead = msg.bytesRead;
      session.pausedAt = now;
      session.state = 'paused';
      setButtons('paused');
      break;
    }
    case 'resumed': {
      if (session.pausedAt != null) {
        session.pausedTotal += now - session.pausedAt;
        session.pausedAt = null;
      }
      session.bytesRead = msg.bytesRead;
      session.state = 'running';
      setButtons('running');
      break;
    }
    case 'complete': {
      session.bytesRead = msg.bytesRead;
      session.state = 'done';
      els.resultBox.hidden = false;
      els.resultHash.textContent = msg.hash;
      els.resultVia.textContent =
        msg.via === 'WebCrypto' ? '（小文件快速通道：Web Crypto）' : '（增量哈希，Web Worker 内完成）';
      setButtons('done');
      render(now);
      break;
    }
    case 'canceled': {
      session.bytesRead = msg.bytesRead;
      finishLocal('canceled');
      break;
    }
    case 'error': {
      showError(msg.message || '读取过程中发生未知错误。');
      finishLocal('error');
      break;
    }
    default:
      break;
  }
}

// ---------- 渲染（rAF 节流） ----------
let lastRender = 0;
function render(now) {
  if (!session) return;

  const total = Math.max(session.bytesTotal, 0);
  const read = Math.min(session.bytesRead, total);
  const percent = total > 0 ? (read / total) * 100 : 0;

  els.progressBar.style.width = percent.toFixed(2) + '%';
  els.percentText.textContent = percent.toFixed(2) + '%';
  els.mBytes.textContent = `${formatBytes(read)} / ${formatBytes(total)}`;
  els.mElapsed.textContent = formatDuration(activeDuration(now));

  if (session.state === 'running') {
    const speed = currentSpeed(now);
    els.mSpeed.textContent = speed > 0 ? formatBytes(speed) + '/s' : '计算中…';
    const remaining = total - read;
    els.mEta.textContent =
      speed > 1024 ? formatDuration(remaining / speed) : '估算中…';
  } else if (session.state === 'paused') {
    els.mEta.textContent = '已暂停';
  } else if (session.state === 'done') {
    els.mSpeed.textContent = '完成';
    els.mEta.textContent = '00:00';
  } else if (session.state === 'canceled' || session.state === 'error') {
    els.mSpeed.textContent = '–';
    els.mEta.textContent = '–';
  }
}

// 常驻 rAF 循环：顺带统计主线程 FPS（重活全在 Worker，这里应稳定 60fps）。
let fpsFrames = 0;
let fpsWindowStart = performance.now();
let renderedIdle = false;
function frame(now) {
  fpsFrames++;
  if (now - fpsWindowStart >= 1000) {
    const fps = (fpsFrames * 1000) / (now - fpsWindowStart);
    els.hFps.textContent = fps >= 55 ? fps.toFixed(0) : fps.toFixed(0) + ' ⚠';
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  // 运行/暂停期间持续刷新已用时间等文本；终态只渲染一次，空闲不做 DOM 写入。
  if (session && (session.state === 'running' || session.state === 'paused')) {
    if (now - lastRender >= 100) {
      render(now);
      lastRender = now;
    }
    renderedIdle = false;
  } else if (session && !renderedIdle) {
    render(now);
    renderedIdle = true;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// PerformanceObserver：监控主线程长任务（>50ms），用于验证 60fps 目标。
let longTaskCount = 0;
let longTaskMax = 0;
if ('PerformanceObserver' in window) {
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount++;
        if (entry.duration > longTaskMax) longTaskMax = entry.duration;
      }
      els.hLongtasks.textContent = String(longTaskCount);
      els.hLongtaskMax.textContent = longTaskMax.toFixed(1) + ' ms';
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch (_) {
    els.hFps.textContent = '不支持 longtask';
  }
}

// ---------- 交互 ----------
els.fileInput.addEventListener('change', () => {
  selectedFile = els.fileInput.files && els.fileInput.files[0] ? els.fileInput.files[0] : null;
  resetSessionView();

  if (!selectedFile) {
    els.fileLabel.textContent = '选择文件（支持 500MB–2GB 及任意大小）';
    els.fileLabel.parentElement.classList.remove('has-file');
    els.fileMeta.hidden = true;
  } else {
    els.fileLabel.textContent = '已选择，点击可更换文件';
    els.fileLabel.parentElement.classList.add('has-file');
    els.fileMeta.hidden = false;
    els.fileName.textContent = selectedFile.name;
    els.fileSize.textContent = formatBytes(selectedFile.size);
  }
  setButtons('idle');
});

function resetSessionView() {
  session = null;
  clearError();
  els.resultBox.hidden = true;
  els.progressBar.style.width = '0%';
  els.percentText.textContent = '0.00%';
  els.mBytes.textContent = '0 / 0 B';
  els.mSpeed.textContent = '–';
  els.mElapsed.textContent = '–';
  els.mEta.textContent = '–';
}

els.btnStart.addEventListener('click', () => {
  if (!selectedFile) return;
  const chunkSize = Number(els.chunkSize.value);
  if (!Number.isFinite(chunkSize) || chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) {
    showError('分片大小必须在 1 MiB – 64 MiB 之间。');
    return;
  }
  if (chunkSize > selectedFile.size && selectedFile.size > 0) {
    // 允许，但不会造成问题；保持简单不拦截。
  }

  runId++;
  session = {
    id: runId,
    state: 'starting',
    bytesTotal: selectedFile.size,
    bytesRead: 0,
    startAt: 0,
    pausedAt: null,
    pausedTotal: 0,
    samples: []
  };
  clearError();
  els.resultBox.hidden = true;
  setButtons('starting');
  ensureWorker().postMessage(
    { type: "start", id: runId, file: selectedFile, chunkSize }
  );
});

els.btnPause.addEventListener('click', () => {
  if (session && session.state === 'running') {
    worker.postMessage({ type: 'pause', id: session.id });
  }
});

els.btnResume.addEventListener('click', () => {
  if (session && session.state === 'paused') {
    worker.postMessage({ type: 'resume', id: session.id });
  }
});

els.btnCancel.addEventListener('click', () => {
  if (session && worker) {
    worker.postMessage({ type: 'cancel', id: session.id });
  }
});

els.btnCopy.addEventListener('click', async () => {
  const text = els.resultHash.textContent;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const range = document.createRange();
    range.selectNodeContents(els.resultHash);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
  }
  const old = els.btnCopy.textContent;
  els.btnCopy.textContent = '已复制';
  setTimeout(() => { els.btnCopy.textContent = old; }, 1200);
});

setButtons('idle');
