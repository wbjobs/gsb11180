// 在 Node 中模拟浏览器 Worker 环境，端到端驱动 worker.js：
// 验证正常哈希、暂停后继续结果不变、取消立即停止。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 极简 Blob/File：提供 size 和 stream()（返回字节 ReadableStream）
class FakeFile {
  constructor(name, buf) {
    this.name = name;
    this._buf = buf;
    this.size = buf.length;
  }
  arrayBuffer() {
    return Promise.resolve(this._buf.buffer.slice(
      this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength));
  }
  stream() {
    if (this._failMode) {
      const msg = this._failMode;
      return new ReadableStream({
        type: 'bytes',
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 2));
          controller.error(Object.assign(new Error(msg), { name: 'NotReadableError' }));
        }
      });
    }
    const buf = this._buf;
    let offset = 0;
    return new ReadableStream({
      type: 'bytes',
      async pull(controller) {
        // 模拟磁盘 IO 延迟，让暂停 / 取消能在读取途中介入。
        await new Promise((r) => setTimeout(r, 2));
        if (offset >= buf.length) {
          controller.close();
          return;
        }
        const byob = controller.byobRequest;
        if (byob) {
          const len = Math.min(byob.view.byteLength, buf.length - offset);
          byob.view.set(buf.subarray(offset, offset + len));
          byob.respond(len);
          offset += len;
          if (offset >= buf.length) controller.close();
        } else {
          const len = Math.min(65536 + Math.floor(Math.random() * 200000), buf.length - offset);
          controller.enqueue(buf.subarray(offset, offset + len));
          offset += len;
        }
      }
    });
  }
}

async function loadWorker() {
  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.performance = { now: () => performance.now() };
  sandbox.crypto = webcrypto;
  sandbox.ReadableStream = ReadableStream;
  sandbox.ReadableByteStreamController = (class RBSC {});
  const messages = [];
  sandbox.postMessage = (msg) => messages.push(msg);
  sandbox.importScripts = () => {
    const code = readFileSync(new URL('../lib/sha256.js', import.meta.url), 'utf8');
    vm.runInContext(code, ctx);
  };
  const ctx = vm.createContext(sandbox);
  const workerCode = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  vm.runInContext(workerCode, ctx);

  return {
    send(msg) { vm.runInContext('self.onmessage', ctx); sandbox.onmessage({ data: msg }); },
    messages
  };
}

function waitFor(messages, type, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const m = messages.find((x) => x.type === type);
      if (m) return resolve(m);
      if (Date.now() - t0 > timeout) return reject(new Error('timeout waiting ' + type));
      setTimeout(poll, 5);
    })();
  });
}

const ref = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- 测试 1：20MiB 大文件走增量路径，结果与参考一致 ----
{
  const size = 20 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + 3) & 0xff;
  const expected = ref(buf);

  const w = await loadWorker();
  w.send({ type: 'start', id: 1, file: new FakeFile('a.bin', buf), chunkSize: 1024 * 1024 });
  await waitFor(w.messages, 'started');
  const done = await waitFor(w.messages, 'complete');
  console.log('T1 complete via:', done.via, 'bytes:', done.bytesRead);
  if (done.hash !== expected) {
    console.error('T1 FAIL hash mismatch');
    console.error(' expected', expected);
    console.error(' actual  ', done.hash);
    process.exit(1);
  }
  console.log('T1 PASS 大文件增量哈希正确');
}

// ---- 测试 2：暂停 -> 继续，进度停滞且最终哈希不变 ----
{
  const size = 64 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 13 + 1) & 0xff;
  const expected = ref(buf);

  const w = await loadWorker();
  w.send({ type: 'start', id: 2, file: new FakeFile('b.bin', buf), chunkSize: 1024 * 1024 });
  await waitFor(w.messages, 'started');
  await sleep(30);
  w.send({ type: 'pause', id: 2 });
  await waitFor(w.messages, 'paused');
  const atPause = w.messages.filter((m) => m.type === 'progress').pop()?.bytesRead ?? 0;
  await sleep(200);
  const afterWait = w.messages.filter((m) => m.type === 'progress').pop()?.bytesRead ?? 0;
  if (atPause !== afterWait) {
    console.error(`T2 FAIL 暂停期间仍在读: ${atPause} -> ${afterWait}`);
    process.exit(1);
  }
  console.log(`T2 暂停生效，已读停在 ${atPause} 字节`);
  w.send({ type: 'resume', id: 2 });
  const done = await waitFor(w.messages, 'complete');
  if (done.hash !== expected) {
    console.error('T2 FAIL 暂停后继续哈希不一致');
    process.exit(1);
  }
  console.log('T2 PASS 暂停/继续后哈希与原文件一致');
}

// ---- 测试 3：运行中取消，立即收到 canceled 且不会 complete ----
{
  const size = 32 * 1024 * 1024;
  const buf = Buffer.alloc(size, 0xab);
  const w = await loadWorker();
  w.send({ type: 'start', id: 3, file: new FakeFile('c.bin', buf), chunkSize: 4 * 1024 * 1024 });
  await waitFor(w.messages, 'started');
  await sleep(30);
  w.send({ type: 'cancel', id: 3 });
  const canceled = await waitFor(w.messages, 'canceled', 5000);
  await sleep(300);
  if (w.messages.some((m) => m.type === 'complete')) {
    console.error('T3 FAIL 取消后仍产生了 complete');
    process.exit(1);
  }
  if (w.messages.some((m) => m.type === 'error')) {
    console.error('T3 FAIL 取消不应产生 error');
    process.exit(1);
  }
  console.log(`T3 PASS 取消立即停止，停止于 ${canceled.bytesRead} 字节`);
}

// ---- 测试 4：小文件走 Web Crypto 快速通道 ----
{
  const buf = Buffer.from('hello web crypto path');
  const expected = ref(buf);
  const w = await loadWorker();
  w.send({ type: 'start', id: 4, file: new FakeFile('small.txt', buf), chunkSize: 1024 * 1024 });
  const done = await waitFor(w.messages, 'complete');
  if (done.via !== 'WebCrypto' || done.hash !== expected) {
    console.error('T4 FAIL', done);
    process.exit(1);
  }
  console.log('T4 PASS 小文件 WebCrypto 快速通道正确');
}

// ---- 测试 5：读取中途文件不可读（删除/拔盘），给出可读提示且可恢复标志 ----
{
  const buf = Buffer.alloc(32 * 1024 * 1024, 5);
  const f = new FakeFile('gone.bin', buf);
  f._failMode = 'A requested file could not be read, typically due to hardware problems';
  const w = await loadWorker();
  w.send({ type: 'start', id: 5, file: f, chunkSize: 1024 * 1024 });
  const err = await waitFor(w.messages, 'error');
  if (!err.recoverable || !/删除|不可读|重新选择/.test(err.message)) {
    console.error('T5 FAIL 错误提示不友好:', err.message);
    process.exit(1);
  }
  if (w.messages.some((m) => m.type === 'complete')) {
    console.error('T5 FAIL 出错后不应 complete');
    process.exit(1);
  }
  console.log('T5 PASS 文件不可读时有可读、可恢复的提示：', err.message);
}

console.log('\n全部 Worker 端到端测试通过。');
