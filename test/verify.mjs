// 验证 lib/sha256.js 的正确性（对比 Node 内置 crypto），并测吞吐。
import { createHash, randomBytes } from 'node:crypto';
import shaModule from '../lib/sha256.js';
const { Sha256 } = shaModule;

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}`);
    console.error(`  expected ${expected}`);
    console.error(`  actual   ${actual}`);
  }
}

const ref = (buf) => createHash('sha256').update(buf).digest('hex');

// 标准向量
const enc = new TextEncoder();
check('empty', new Sha256().digest(), ref(Buffer.alloc(0)));
check('abc', new Sha256().update(enc.encode('abc')).digest(),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('448-bit string',
  new Sha256().update(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).digest(),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');

// 长度边界（0..200）逐长度校验，覆盖各种分组 / padding 边界
for (let len = 0; len <= 200; len++) {
  const data = randomBytes(len);
  const h = new Sha256();
  // 模拟分片：1 字节、7 字节、64 字节混合喂入
  let off = 0;
  const stepPattern = [1, 7, 64, 63, 3, 100, 65];
  let si = 0;
  while (off < len) {
    const take = Math.min(stepPattern[si++ % stepPattern.length], len - off);
    h.update(new Uint8Array(data.buffer, data.byteOffset + off, take));
    off += take;
  }
  check(`random len=${len} (split feeds)`, h.digest(), ref(data));
}

// 大块：1MB 随机数据（单次 update）
const big = randomBytes(1024 * 1024);
check('1 MiB single update', new Sha256().update(new Uint8Array(big.buffer)).digest(), ref(big));

// 1MB 切成 1MiB 对齐附近的小块
{
  const h = new Sha256();
  for (let off = 0; off < big.length;) {
    const take = Math.min(4096 + (off % 65537), big.length - off);
    h.update(new Uint8Array(big.buffer, off, take));
    off += take;
  }
  check('1 MiB split 4KiB-ish', h.digest(), ref(big));
}

if (fail > 0) {
  console.error(`\n${fail} FAILED, ${pass} passed`);
  process.exit(1);
}
console.log(`\nAll ${pass} correctness checks passed.\n`);

// ---- 吞吐基准：256MiB 数据重复喂 4 次（共 1GiB 哈希量），内存只占 256MiB ----
const sizeMiB = 256;
const repeats = 4;
const buf = new Uint8Array(sizeMiB * 1024 * 1024);
for (let i = 0; i < buf.length; i++) buf[i] = (i * 1103515245 + 12345) & 0xff;

const h = new Sha256();
const t0 = performance.now();
for (let r = 0; r < repeats; r++) h.update(buf);
const hash = h.digest();
const ms = performance.now() - t0;

const gib = (sizeMiB * repeats) / 1024;
console.log(`Throughput: ${gib.toFixed(2)} GiB in ${(ms / 1000).toFixed(2)} s`);
const mibps = (gib * 1024) / (ms / 1000);
console.log(`Speed:      ${mibps.toFixed(1)} MiB/s (1 GiB in ${(1024 / mibps).toFixed(2)} s)`);

// 正确性：拼接流哈希 = 直接哈希
const refAll = createHash('sha256');
for (let r = 0; r < repeats; r++) refAll.update(Buffer.from(buf));
check('benchmark 1GiB-equivalent hash', hash, refAll.digest('hex'));
console.log(fail === 0 ? '\nBenchmark OK.' : '\nBenchmark hash MISMATCH!');
process.exit(fail === 0 ? 0 : 1);
