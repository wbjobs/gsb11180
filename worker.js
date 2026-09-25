/*
 * 大文件 SHA-256 计算 Worker
 *
 * 职责（主线程不参与任何读取 / 哈希）：
 *   - 通过 File.stream() 读取，优先 BYOB reader（复用固定缓冲，内存恒定），
 *     不支持时回退默认 reader + 固定大小累积缓冲；
 *   - 每读满“配置的分片大小”就对增量 SHA-256 update 一次；
 *   - 暂停 / 继续靠标志位，取消同时调用 reader.cancel() 立即中断在途读取；
 *   - 进度上报节流（<= 5 次/秒）。
 *
 * 小文件（<= 16MiB）直接走 Web Crypto；大文件用 lib/sha256.js 的增量实现
 * （Web Crypto 没有增量接口，整文件 digest 会让内存随文件大小线性增长）。
 */
'use strict';

importScripts('./lib/sha256.js');

const WEB_CRYPTO_LIMIT = 16 * 1024 * 1024; // <= 16MiB 走 Web Crypto 快速通道
const PROGRESS_INTERVAL_MS = 200;         // 进度上报节流
const PAUSE_POLL_MS = 80;

let session = null;
// session: { id, state: 'running'|'paused'|'canceled'|'done',
//            reader, hasher, bytesTotal, bytesRead, lastProgress }

function post(type, payload) {
  self.postMessage(Object.assign({ type, id: session ? session.id : null }, payload));
}

function nowMs() {
  return self.performance && self.performance.now ? self.performance.now() : Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCanceled() {
  const err = new Error('canceled by user');
  err.name = 'AbortError';
  return err;
}

function ensureRunning() {
  if (session.state === 'canceled') throw makeCanceled();
}

function describeError(err) {
  const name = (err && err.name) || '';
  const message = (err && (err.message || String(err))) || '';

  if (name === 'AbortError' || /abort/i.test(message)) return null;

  // File 句柄还在、但底层文件已被删除 / 移动 / 截断 / 磁盘不可读。
  if (name === 'NotFoundError' ||
      /not found|no such file|deleted|removed|missing|truncated|unexpected eof|could not be read|unreadable|unavailable/i.test(message)) {
    return {
      message: '文件已被删除、移动，或在读取过程中被截断。请重新选择文件后再试。',
      recoverable: true
    };
  }

  if (name === 'NotAllowedError' || /permission|denied|security/i.test(message)) {
    return { message: '没有权限读取该文件。', recoverable: true };
  }

  if (name === 'NotReadableError') {
    return { message: '读取中断：文件所在设备暂时不可读。可重新选择文件后再试。', recoverable: true };
  }

  return {
    message: '读取中断：' + (message || '未知错误') + '。可重新选择文件后再试。',
    recoverable: true
  };
}

function addBytes(n) {
  session.bytesRead += n;
  const ts = nowMs();
  if (ts - session.lastProgress >= PROGRESS_INTERVAL_MS) {
    session.lastProgress = ts;
    post('progress', { bytesRead: session.bytesRead, timestamp: ts });
  }
}

// 分片边界点：处理暂停 / 取消，并让出一次事件循环使控制消息及时生效。
async function checkpoint() {
  while (session.state === 'paused') {
    await sleep(PAUSE_POLL_MS);
  }
  ensureRunning();
  await Promise.resolve();
}

// ---- BYOB 路径：每片一块固定缓冲，哈希完即可回收，常驻内存 ≈ 分片大小 ----
async function readByob(hasher, reader, chunkSize) {
  while (true) {
    await checkpoint();
    // BYOB 语义：每次 read 返回的 value 可能位于传入缓冲，也可能是实现
    // 新分配的缓冲（传入缓冲会被 detach），因此始终以返回的 value 为准，
    // 用拷贝维持“一块分片缓冲”的固定内存上限。
    const batch = new Uint8Array(chunkSize);
    let filled = 0;

    while (filled < chunkSize) {
      // 每次按“剩余容量”提供视图；返回后旧缓冲可能已被 detach。
      const incoming = new Uint8Array(new ArrayBuffer(chunkSize - filled));
      const { done, value } = await reader.read(incoming);
      // 规范允许流结束时 done=true 且同时带回尾部字节，必须一并计入。
      if (value && value.byteLength > 0) {
        batch.set(value, filled);
        filled += value.byteLength;
      }
      if (done) {
        ensureRunning();
        if (filled > 0) {
          hasher.update(batch.subarray(0, filled));
          addBytes(filled);
        }
        return;
      }
    }

    hasher.update(batch);
    addBytes(chunkSize);
  }
}

// ---- 默认 reader 回退路径：同样只用一块固定大小的累积缓冲 ----
async function readDefault(hasher, reader, chunkSize) {
  const batch = new Uint8Array(chunkSize);
  let filled = 0;

  while (true) {
    await checkpoint();
    const { done, value } = await reader.read();
    if (done) {
      ensureRunning();
      if (filled > 0) {
        hasher.update(batch.subarray(0, filled));
        addBytes(filled);
      }
      return;
    }

    let offset = 0;
    while (offset < value.length) {
      const take = Math.min(chunkSize - filled, value.length - offset);
      batch.set(value.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === chunkSize) {
        hasher.update(batch);
        addBytes(chunkSize);
        filled = 0;
      }
    }
  }
}

async function hashLargeFile(file, chunkSize) {
  const stream = file.stream();
  const supportsByob =
    typeof ReadableByteStreamController !== 'undefined' &&
    typeof stream.getReader === 'function';

  const reader = supportsByob ? stream.getReader({ mode: 'byob' }) : stream.getReader();
  session.reader = reader;
  const hasher = new self.Sha256();

  try {
    if (supportsByob) {
      await readByob(hasher, reader, chunkSize);
    } else {
      await readDefault(hasher, reader, chunkSize);
    }

    ensureRunning();
    if (session.bytesRead !== file.size) {
      throw new Error('unexpected EOF: 文件在读取过程中被截断或删除');
    }

    post('progress', { bytesRead: session.bytesRead, timestamp: nowMs() });
    session.state = 'done';
    post('complete', {
      hash: hasher.digest(),
      bytesRead: session.bytesRead,
      via: 'JS-incremental'
    });
  } finally {
    session.reader = null;
    try { reader.releaseLock(); } catch (_) { /* 已取消时忽略 */ }
  }
}

async function hashSmallFile(file) {
  const buffer = await file.arrayBuffer();
  ensureRunning();
  const digestBuffer = await self.crypto.subtle.digest('SHA-256', buffer);
  ensureRunning();
  session.bytesRead = buffer.byteLength;
  session.state = 'done';
  post('complete', {
    hash: self.sha256ToHex(digestBuffer),
    bytesRead: buffer.byteLength,
    via: 'WebCrypto'
  });
}

async function start(id, file, chunkSize) {
  session = {
    id,
    state: 'running',
    reader: null,
    hasher: null,
    bytesTotal: file.size,
    bytesRead: 0,
    lastProgress: 0
  };

  try {
    post('started', { bytesTotal: file.size, chunkSize });
    if (file.size <= WEB_CRYPTO_LIMIT) {
      await hashSmallFile(file);
    } else {
      await hashLargeFile(file, chunkSize);
    }
  } catch (err) {
    if (session.state === 'canceled' || err.name === 'AbortError') {
      post('canceled', { bytesRead: session.bytesRead });
      return;
    }
    const described = describeError(err);
    post('error', described || {
      message: '读取中断：' + ((err && err.message) || '未知错误') + '。',
      recoverable: true
    });
  }
}

async function doCancel() {
  if (!session || session.state === 'done' || session.state === 'canceled') {
    if (session && session.state !== 'canceled') {
      post('canceled', { bytesRead: session.bytesRead });
    }
    return;
  }
  session.state = 'canceled';
  const reader = session.reader;
  if (reader) {
    // 立即中断在途读取（暂停或 IO 等待中都能快速返回）。
    try { await reader.cancel(); } catch (_) { /* ignore */ }
  }
  post('canceled', { bytesRead: session.bytesRead });
}

self.onmessage = async (e) => {
  const msg = e.data || {};

  if (msg.type === 'start') {
    await start(msg.id, msg.file, msg.chunkSize);
    return;
  }

  if (!session || (msg.id !== undefined && msg.id !== session.id)) return;

  if (msg.type === 'pause') {
    if (session.state === 'running') {
      session.state = 'paused';
      post('paused', { bytesRead: session.bytesRead });
    }
  } else if (msg.type === 'resume') {
    if (session.state === 'paused') {
      session.state = 'running';
      post('resumed', { bytesRead: session.bytesRead });
    }
  } else if (msg.type === 'cancel') {
    await doCancel();
  }
};
