'use strict';

const els = {
  fileInput: document.getElementById('fileInput'),
  chunkSize: document.getElementById('chunkSize'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  cancelBtn: document.getElementById('cancelBtn'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  statBytes: document.getElementById('statBytes'),
  statSpeed: document.getElementById('statSpeed'),
  statEta: document.getElementById('statEta'),
  statElapsed: document.getElementById('statElapsed'),
  hashOutput: document.getElementById('hashOutput'),
  status: document.getElementById('status'),
  fps: document.getElementById('fps'),
  longtask: document.getElementById('longtask')
};

let worker = null;
let currentFile = null;
let state = 'idle'; // idle | running | paused | done | error | cancelled
let latestProgress = null;
let progressDirty = false;
let startedAt = 0;
let pausedAccum = 0;
let pausedSince = 0;

// ---------- 主线程健康监控：PerformanceObserver(longtask) + FPS ----------
let longtaskCount = 0;
try {
  new PerformanceObserver((list) => {
    longtaskCount += list.getEntries().length;
    els.longtask.textContent = '长任务: ' + longtaskCount;
    els.longtask.classList.toggle('warn', longtaskCount > 0);
  }).observe({ entryTypes: ['longtask'] });
} catch (_) {
  els.longtask.textContent = '长任务: 不支持检测';
}

let frames = 0;
let fpsLast = performance.now();
(function fpsLoop(now) {
  frames++;
  if (now - fpsLast >= 1000) {
    els.fps.textContent = 'FPS: ' + Math.round(frames * 1000 / (now - fpsLast));
    frames = 0;
    fpsLast = now;
  }
  requestAnimationFrame(fpsLoop);
})(performance.now());

// ---------- 渲染循环：进度更新经 rAF 节流，避免频繁 DOM 写入 ----------
(function renderLoop() {
  if (progressDirty && latestProgress) {
    progressDirty = false;
    const p = latestProgress;
    const pct = p.total === 0 ? 100 : (p.loaded / p.total) * 100;
    els.progressBar.style.width = pct.toFixed(2) + '%';
    els.progressText.textContent = pct.toFixed(1) + '%';
    els.statBytes.textContent = formatBytes(p.loaded) + ' / ' + formatBytes(p.total);
    els.statSpeed.textContent = formatBytes(p.speed) + '/s';
    els.statEta.textContent = p.loaded >= p.total ? '—' : formatDuration(p.etaMs);
    els.statElapsed.textContent = formatDuration(elapsedActiveMs());
  }
  requestAnimationFrame(renderLoop);
})();

function elapsedActiveMs() {
  if (!startedAt) return 0;
  const now = state === 'paused' ? pausedSince : performance.now();
  return now - startedAt - pausedAccum;
}

function formatBytes(n) {
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB';
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + ' MB';
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB';
  return Math.round(n) + ' B';
}

function formatDuration(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return h + '时' + (m % 60) + '分' + (s % 60) + '秒';
  if (m > 0) return m + '分' + (s % 60) + '秒';
  return s + '秒';
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = 'status ' + (kind || '');
}

function setState(next) {
  state = next;
  els.startBtn.disabled = !currentFile || next === 'running' || next === 'paused';
  els.pauseBtn.disabled = next !== 'running';
  els.resumeBtn.disabled = next !== 'paused';
  els.cancelBtn.disabled = next !== 'running' && next !== 'paused';
  els.fileInput.disabled = next === 'running' || next === 'paused';
  els.chunkSize.disabled = next === 'running' || next === 'paused';
}

function terminateWorker() {
  if (worker) { worker.terminate(); worker = null; }
}

function resetStats() {
  latestProgress = null;
  progressDirty = false;
  els.progressBar.style.width = '0%';
  els.progressText.textContent = '0%';
  els.statBytes.textContent = '—';
  els.statSpeed.textContent = '—';
  els.statEta.textContent = '—';
  els.statElapsed.textContent = '—';
  els.hashOutput.textContent = '—';
}

els.fileInput.addEventListener('change', () => {
  currentFile = els.fileInput.files[0] || null;
  if (currentFile) {
    terminateWorker();
    resetStats();
    setState('idle');
    setStatus('已选择：' + currentFile.name + '（' + formatBytes(currentFile.size) + '）');
    els.startBtn.disabled = false;
  }
});

els.startBtn.addEventListener('click', () => {
  if (!currentFile) return;
  terminateWorker();
  resetStats();
  const chunkSize = Number(els.chunkSize.value);
  worker = new Worker('hash-worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    setStatus('Worker 异常：' + (e.message || '未知错误'), 'error');
    setState('error');
  };
  startedAt = performance.now();
  pausedAccum = 0;
  setState('running');
  setStatus('正在读取并计算哈希…');
  worker.postMessage({ type: 'start', file: currentFile, chunkSize });
});

els.pauseBtn.addEventListener('click', () => {
  if (!worker || state !== 'running') return;
  pausedSince = performance.now();
  worker.postMessage({ type: 'pause' });
  setState('paused');
  setStatus('已暂停（哈希状态保留，可随时继续）');
});

els.resumeBtn.addEventListener('click', () => {
  if (!worker || state !== 'paused') return;
  pausedAccum += performance.now() - pausedSince;
  worker.postMessage({ type: 'resume' });
  setState('running');
  setStatus('正在读取并计算哈希…');
});

els.cancelBtn.addEventListener('click', () => {
  if (!worker) return;
  worker.postMessage({ type: 'cancel' });
  // 立即终止 Worker，确保“取消后立即停止”，不等回包
  terminateWorker();
  setState('cancelled');
  setStatus('已取消。', 'warn');
});

function onWorkerMessage(e) {
  const msg = e.data;
  switch (msg.type) {
    case 'progress':
      latestProgress = msg;
      progressDirty = true;
      break;
    case 'done': {
      latestProgress = { loaded: msg.total, total: msg.total, speed: 0, etaMs: 0 };
      progressDirty = true;
      els.statElapsed.textContent = formatDuration(msg.elapsedMs);
      els.hashOutput.textContent = msg.hash;
      setStatus('完成 ✔ SHA-256 计算成功', 'ok');
      setState('done');
      terminateWorker();
      break;
    }
    case 'error':
      setStatus(msg.message, 'error');
      setState('error');
      terminateWorker();
      break;
    case 'cancelled':
      break;
  }
}
