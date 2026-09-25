/*
 * 增量 SHA-256（纯 JavaScript 实现，零依赖）
 *
 * 为什么不直接用 Web Crypto 的 crypto.subtle.digest？
 * 该 API 只能接收一个完整的 ArrayBuffer，没有“增量 update / final”接口。
 * 对 500MB–2GB 的文件，整文件入哈希会产生一次与文件等大的内存拷贝，
 * 内存随文件大小线性增长，无法满足“恒定内存”的要求。
 * 因此大文件在 Worker 内使用本增量实现：每读一片 update 一次，
 * 内部只保留 64 字节分组缓存与 256 字节以内的中间状态。
 * 小文件（<= 16MiB）仍走 Web Crypto 快速通道（见 worker.js）。
 *
 * 同时兼容浏览器（importScripts 后挂到 self.Sha256）与 Node（module.exports）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.Sha256 = api.Sha256;
    root.sha256ToHex = api.toHex;
  }
})(typeof self !== 'undefined'
  ? self
  : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  const H0 = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  class Sha256 {
    constructor() {
      this.reset();
    }

    reset() {
      this.h = Uint32Array.from(H0);
      this.block = new Uint8Array(64);
      this.blockView = new DataView(this.block.buffer);
      this.work = new Uint32Array(64);
      this.blockLen = 0;
      this.lenLo = 0;
      this.lenHi = 0;
      return this;
    }

    _compress(view, offset) {
      const w = this.work;
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(offset + (i << 2));
      }
      for (let i = 16; i < 64; i++) {
        const x15 = w[i - 15];
        const x2 = w[i - 2];
        const s0 = ((x15 >>> 7) | (x15 << 25)) ^ ((x15 >>> 18) | (x15 << 14)) ^ (x15 >>> 3);
        const s1 = ((x2 >>> 17) | (x2 << 15)) ^ ((x2 >>> 19) | (x2 << 13)) ^ (x2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3];
      let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];

      for (let i = 0; i < 64; i++) {
        const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
        const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }

      this.h[0] = (this.h[0] + a) >>> 0;
      this.h[1] = (this.h[1] + b) >>> 0;
      this.h[2] = (this.h[2] + c) >>> 0;
      this.h[3] = (this.h[3] + d) >>> 0;
      this.h[4] = (this.h[4] + e) >>> 0;
      this.h[5] = (this.h[5] + f) >>> 0;
      this.h[6] = (this.h[6] + g) >>> 0;
      this.h[7] = (this.h[7] + h) >>> 0;
    }

    update(data) {
      const len = data.length;
      if (len === 0) return this;

      let offset = 0;

      if (this.blockLen > 0) {
        const take = Math.min(64 - this.blockLen, len);
        this.block.set(data.subarray(0, take), this.blockLen);
        this.blockLen += take;
        offset = take;
        if (this.blockLen === 64) {
          this._compress(this.blockView, 0);
          this.blockLen = 0;
        }
      }

      if (len - offset >= 64) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        while (len - offset >= 64) {
          this._compress(view, offset);
          offset += 64;
        }
      }

      if (offset < len) {
        this.block.set(data.subarray(offset));
        this.blockLen = len - offset;
      }

      this.lenLo += len;
      if (this.lenLo >= 0x100000000) {
        this.lenHi += 1;
        this.lenLo -= 0x100000000;
      }
      return this;
    }

    digest() {
      const bitLenLo = (this.lenLo << 3) >>> 0;
      const bitLenHi = ((this.lenHi << 3) | (this.lenLo >>> 29)) >>> 0;

      this.block[this.blockLen++] = 0x80;

      if (this.blockLen > 56) {
        while (this.blockLen < 64) {
          this.block[this.blockLen++] = 0;
        }
        this._compress(this.blockView, 0);
        this.blockLen = 0;
      }

      while (this.blockLen < 56) {
        this.block[this.blockLen++] = 0;
      }
      this.blockView.setUint32(56, bitLenHi);
      this.blockView.setUint32(60, bitLenLo);
      this._compress(this.blockView, 0);

      let hex = '';
      for (let i = 0; i < 8; i++) {
        hex += this.h[i].toString(16).padStart(8, '0');
      }
      return hex;
    }
  }

  function hex(buffer) {
    const view = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < view.length; i++) {
      out += view[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  return { Sha256, toHex: hex };
});
