export default {
  async fetch(request, env, ctx) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        const { url, cursor = 0, state = null } = data;
        if (!url) {
          server.send(JSON.stringify({ error: "URL is required" }));
          return;
        }
        // 发起单次请求，获取资源流
        const response = await fetch(url, {
          headers: {
            Range: `bytes=${cursor}-`,
          },
        });
        if (response.status !== 200 && response.status !== 206) {
          server.send(JSON.stringify({ error: `Fetch failed: HTTP ${response.status} ${response.statusText}` }));
          server.close();
          return;
        }
        const reader = response.body.getReader();
        let currentCursor = cursor;
        let stateObj = state || {};
        let sha1State = stateObj.sha1 || {
          h: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0],
          len: 0,
        };
        let sha256State = stateObj.sha256 || {
          h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
          len: 0,
        };
        let md5State = stateObj.md5 || {
          h: [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476],
          len: 0,
        };
        const CHUNK_SIZE = 1024 * 1024; // 1MB 推送一次
        let lastSentCursor = cursor;
        let pendingBuffer;
        // 如果服务器不支持 Range 请求 (返回 200 而非 206)，我们需要丢弃前 cursor 字节
        if (response.status === 200 && cursor > 0) {
          let discarded = 0;
          let tempBuffer = null;
          while (discarded < cursor) {
            const { done, value } = await reader.read();
            if (done) {
              server.send(JSON.stringify({ error: `Non-range source URL too short, expected ${cursor} but EOF at ${discarded}` }));
              server.close();
              return;
            }
            if (discarded + value.length <= cursor) {
              discarded += value.length;
            } else {
              const needed = cursor - discarded;
              tempBuffer = value.subarray(needed);
              discarded = cursor;
            }
          }
          pendingBuffer = new Uint8Array(tempBuffer || []);
        } else {
          pendingBuffer = new Uint8Array(sha1State.buffer || []);
        }
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // 合并新数据
          let combined = new Uint8Array(pendingBuffer.length + value.length);
          combined.set(pendingBuffer);
          combined.set(value, pendingBuffer.length);
          let offset = 0;
          while (offset + 64 <= combined.length) {
            // 处理 64 字节的块 - 极其极致地联合分发数据流，减少内存碎片与垃圾回收
            const block = combined.subarray(offset, offset + 64);
            processBlock(block, sha1State);
            processBlockSHA256(block, sha256State);
            processBlockMD5(block, md5State);
            offset += 64;
            currentCursor += 64;
            sha1State.len += 64;
            sha256State.len += 64;
            md5State.len += 64;
            // 每达到 1MB 发送一次快照
            if (currentCursor - lastSentCursor >= CHUNK_SIZE) {
              server.send(
                JSON.stringify({
                  status: "processing",
                  cursor: currentCursor,
                  state: {
                    sha1: {
                      h: Array.from(sha1State.h),
                      len: sha1State.len,
                    },
                    sha256: {
                      h: Array.from(sha256State.h),
                      len: sha256State.len,
                    },
                    md5: {
                      h: Array.from(md5State.h),
                      len: md5State.len,
                    },
                  },
                }),
              );
              lastSentCursor = currentCursor;
            }
          }
          pendingBuffer = combined.subarray(offset);
        }
        // 完成计算：处理最后的 padding
        const finalSHA1 = finalizeSHA1(pendingBuffer, sha1State);
        const finalSHA256 = finalizeSHA256(pendingBuffer, sha256State);
        const finalMD5 = finalizeMD5(pendingBuffer, md5State);
        server.send(
          JSON.stringify({
            status: "completed",
            cursor: currentCursor + pendingBuffer.length,
            hashes: {
              sha1: finalSHA1,
              sha256: finalSHA256,
              md5: finalMD5,
            },
          }),
        );
        server.close();
      } catch (e) {
        server.send(JSON.stringify({ error: e.message }));
        server.close();
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
// SHA-1 核心逻辑实现
function processBlock(block, state) {
  const w = new Uint32Array(80);
  for (let i = 0; i < 16; i++) {
    w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (let i = 16; i < 80; i++) {
    w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  }
  let [a, b, c, d, e] = state.h;
  for (let i = 0; i < 80; i++) {
    let f, k;
    if (i < 20) {
      f = (b & c) | (~b & d);
      k = 0x5a827999;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ed9eba1;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8f1bbcdc;
    } else {
      f = b ^ c ^ d;
      k = 0xca62c1d6;
    }
    const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
    e = d;
    d = c;
    c = rotl(b, 30);
    b = a;
    a = temp;
  }
  state.h[0] = (state.h[0] + a) | 0;
  state.h[1] = (state.h[1] + b) | 0;
  state.h[2] = (state.h[2] + c) | 0;
  state.h[3] = (state.h[3] + d) | 0;
  state.h[4] = (state.h[4] + e) | 0;
}
function rotl(n, b) {
  return (n << b) | (n >>> (32 - b));
}
function finalizeSHA1(tail, state) {
  const totalBits = (state.len + tail.length) * 8;
  const paddingNeeded = 64 - ((tail.length + 9) % 64);
  const padded = new Uint8Array(tail.length + 1 + (paddingNeeded === 64 ? 0 : paddingNeeded) + 8);
  padded.set(tail);
  padded[tail.length] = 0x80;
  // 注入长度信息 (64-bit big endian)
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(padded.length - 4, totalBits & 0xffffffff);
  view.setUint32(padded.length - 8, (totalBits / 0x100000000) >>> 0);
  for (let i = 0; i < padded.length; i += 64) {
    processBlock(padded.subarray(i, i + 64), state);
  }
  return Array.from(state.h)
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
// SHA-256 核心逻辑实现
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function rotR(x, n) {
  return (x >>> n) | (x << (32 - n));
}
function processBlockSHA256(block, state) {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) {
    w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotR(w[i - 15], 7) ^ rotR(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotR(w[i - 2], 17) ^ rotR(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = state.h;
  for (let i = 0; i < 64; i++) {
    const S1 = rotR(e, 6) ^ rotR(e, 11) ^ rotR(e, 25);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + S1 + ch + K256[i] + w[i]) | 0;
    const S0 = rotR(a, 2) ^ rotR(a, 13) ^ rotR(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (S0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) | 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) | 0;
  }
  state.h[0] = (state.h[0] + a) | 0;
  state.h[1] = (state.h[1] + b) | 0;
  state.h[2] = (state.h[2] + c) | 0;
  state.h[3] = (state.h[3] + d) | 0;
  state.h[4] = (state.h[4] + e) | 0;
  state.h[5] = (state.h[5] + f) | 0;
  state.h[6] = (state.h[6] + g) | 0;
  state.h[7] = (state.h[7] + h) | 0;
}
function finalizeSHA256(tail, state) {
  const totalBits = (state.len + tail.length) * 8;
  const paddingNeeded = 64 - ((tail.length + 9) % 64);
  const padded = new Uint8Array(tail.length + 1 + (paddingNeeded === 64 ? 0 : paddingNeeded) + 8);
  padded.set(tail);
  padded[tail.length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(padded.length - 4, totalBits & 0xffffffff);
  view.setUint32(padded.length - 8, (totalBits / 0x100000000) >>> 0);
  for (let i = 0; i < padded.length; i += 64) {
    processBlockSHA256(padded.subarray(i, i + 64), state);
  }
  return Array.from(state.h)
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
// MD5 核心逻辑实现
function F(x, y, z) {
  return (x & y) | (~x & z);
}
function G(x, y, z) {
  return (x & z) | (y & ~z);
}
function H(x, y, z) {
  return x ^ y ^ z;
}
function I(x, y, z) {
  return y ^ (x | ~z);
}
function processBlockMD5(block, state) {
  const x = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    x[i] = block[i * 4] | (block[i * 4 + 1] << 8) | (block[i * 4 + 2] << 16) | (block[i * 4 + 3] << 24);
  }
  let [a, b, c, d] = state.h;
  // Round 1
  a = (b + rotl(a + F(b, c, d) + x[0] + 0xd76aa478, 7)) | 0;
  d = (a + rotl(d + F(a, b, c) + x[1] + 0xe8c7b756, 12)) | 0;
  c = (d + rotl(c + F(d, a, b) + x[2] + 0x242070db, 17)) | 0;
  b = (c + rotl(b + F(c, d, a) + x[3] + 0xc1bdceee, 22)) | 0;
  a = (b + rotl(a + F(b, c, d) + x[4] + 0xf57c0faf, 7)) | 0;
  d = (a + rotl(d + F(a, b, c) + x[5] + 0x4787c62a, 12)) | 0;
  c = (d + rotl(c + F(d, a, b) + x[6] + 0xa8304613, 17)) | 0;
  b = (c + rotl(b + F(c, d, a) + x[7] + 0xfd469501, 22)) | 0;
  a = (b + rotl(a + F(b, c, d) + x[8] + 0x698098d8, 7)) | 0;
  d = (a + rotl(d + F(a, b, c) + x[9] + 0x8b44f7af, 12)) | 0;
  c = (d + rotl(c + F(d, a, b) + x[10] + 0xffff5bb1, 17)) | 0;
  b = (c + rotl(b + F(c, d, a) + x[11] + 0x895cd7be, 22)) | 0;
  a = (b + rotl(a + F(b, c, d) + x[12] + 0x6b901122, 7)) | 0;
  d = (a + rotl(d + F(a, b, c) + x[13] + 0xfd987193, 12)) | 0;
  c = (d + rotl(c + F(d, a, b) + x[14] + 0xa679438e, 17)) | 0;
  b = (c + rotl(b + F(c, d, a) + x[15] + 0x49b40821, 22)) | 0;
  // Round 2
  a = (b + rotl(a + G(b, c, d) + x[1] + 0xf61e2562, 5)) | 0;
  d = (a + rotl(d + G(a, b, c) + x[6] + 0xc040b340, 9)) | 0;
  c = (d + rotl(c + G(d, a, b) + x[11] + 0x265e5a51, 14)) | 0;
  b = (c + rotl(b + G(c, d, a) + x[0] + 0xe9b6c7aa, 20)) | 0;
  a = (b + rotl(a + G(b, c, d) + x[5] + 0xd62f105d, 5)) | 0;
  d = (a + rotl(d + G(a, b, c) + x[10] + 0x02441453, 9)) | 0;
  c = (d + rotl(c + G(d, a, b) + x[15] + 0xd8a1e681, 14)) | 0;
  b = (c + rotl(b + G(c, d, a) + x[4] + 0xe7d3fbc8, 20)) | 0;
  a = (b + rotl(a + G(b, c, d) + x[9] + 0x21e1cde6, 5)) | 0;
  d = (a + rotl(d + G(a, b, c) + x[14] + 0xc33707d6, 9)) | 0;
  c = (d + rotl(c + G(d, a, b) + x[3] + 0xf4d50d87, 14)) | 0;
  b = (c + rotl(b + G(c, d, a) + x[8] + 0x455a14ed, 20)) | 0;
  a = (b + rotl(a + G(b, c, d) + x[13] + 0xa9e3e905, 5)) | 0;
  d = (a + rotl(d + G(a, b, c) + x[2] + 0xfcefa3f8, 9)) | 0;
  c = (d + rotl(c + G(d, a, b) + x[7] + 0x676f02d9, 14)) | 0;
  b = (c + rotl(b + G(c, d, a) + x[12] + 0x8d2a4c8a, 20)) | 0;
  // Round 3
  a = (b + rotl(a + H(b, c, d) + x[5] + 0xfffa3942, 4)) | 0;
  d = (a + rotl(d + H(a, b, c) + x[8] + 0x8771f681, 11)) | 0;
  c = (d + rotl(c + H(d, a, b) + x[11] + 0x6d9d6122, 16)) | 0;
  b = (c + rotl(b + H(c, d, a) + x[14] + 0xfde5380c, 23)) | 0;
  a = (b + rotl(a + H(b, c, d) + x[1] + 0xa4beea44, 4)) | 0;
  d = (a + rotl(d + H(a, b, c) + x[4] + 0x4bdecfa9, 11)) | 0;
  c = (d + rotl(c + H(d, a, b) + x[7] + 0xf6bb4b60, 16)) | 0;
  b = (c + rotl(b + H(c, d, a) + x[10] + 0xbebfbc70, 23)) | 0;
  a = (b + rotl(a + H(b, c, d) + x[13] + 0x289b7ec6, 4)) | 0;
  d = (a + rotl(d + H(a, b, c) + x[0] + 0xeaa127fa, 11)) | 0;
  c = (d + rotl(c + H(d, a, b) + x[3] + 0xd4ef3085, 16)) | 0;
  b = (c + rotl(b + H(c, d, a) + x[6] + 0x04881d05, 23)) | 0;
  a = (b + rotl(a + H(b, c, d) + x[9] + 0xd9d4d039, 4)) | 0;
  d = (a + rotl(d + H(a, b, c) + x[12] + 0xe6db99e5, 11)) | 0;
  c = (d + rotl(c + H(d, a, b) + x[15] + 0x1fa27cf8, 16)) | 0;
  b = (c + rotl(b + H(c, d, a) + x[2] + 0xc4ac5665, 23)) | 0;
  // Round 4
  a = (b + rotl(a + I(b, c, d) + x[0] + 0xf4292244, 6)) | 0;
  d = (a + rotl(d + I(a, b, c) + x[7] + 0x432aff97, 10)) | 0;
  c = (d + rotl(c + I(d, a, b) + x[14] + 0xab9423a7, 15)) | 0;
  b = (c + rotl(b + I(c, d, a) + x[5] + 0xfc93a039, 21)) | 0;
  a = (b + rotl(a + I(b, c, d) + x[12] + 0x655b59c3, 6)) | 0;
  d = (a + rotl(d + I(a, b, c) + x[3] + 0x8f0ccc92, 10)) | 0;
  c = (d + rotl(c + I(d, a, b) + x[10] + 0xffeff47d, 15)) | 0;
  b = (c + rotl(b + I(c, d, a) + x[1] + 0x85845dd1, 21)) | 0;
  a = (b + rotl(a + I(b, c, d) + x[8] + 0x6fa87e4f, 6)) | 0;
  d = (a + rotl(d + I(a, b, c) + x[15] + 0xfe2ce6e0, 10)) | 0;
  c = (d + rotl(c + I(d, a, b) + x[6] + 0xa3014314, 15)) | 0;
  b = (c + rotl(b + I(c, d, a) + x[13] + 0x4e0811a1, 21)) | 0;
  a = (b + rotl(a + I(b, c, d) + x[4] + 0xf7537e82, 6)) | 0;
  d = (a + rotl(d + I(a, b, c) + x[11] + 0xbd3af235, 10)) | 0;
  c = (d + rotl(c + I(d, a, b) + x[2] + 0x2ad7d2bb, 15)) | 0;
  b = (c + rotl(b + I(c, d, a) + x[9] + 0xeb86d391, 21)) | 0;
  state.h[0] = (state.h[0] + a) | 0;
  state.h[1] = (state.h[1] + b) | 0;
  state.h[2] = (state.h[2] + c) | 0;
  state.h[3] = (state.h[3] + d) | 0;
}
function finalizeMD5(tail, state) {
  const totalBits = (state.len + tail.length) * 8;
  const paddingNeeded = 64 - ((tail.length + 9) % 64);
  const padded = new Uint8Array(tail.length + 1 + (paddingNeeded === 64 ? 0 : paddingNeeded) + 8);
  padded.set(tail);
  padded[tail.length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  view.setUint32(padded.length - 8, totalBits & 0xffffffff, true);
  view.setUint32(padded.length - 4, (totalBits / 0x100000000) >>> 0, true);
  for (let i = 0; i < padded.length; i += 64) {
    processBlockMD5(padded.subarray(i, i + 64), state);
  }
  return Array.from(state.h)
    .map((x) => {
      const b0 = (x & 0xff).toString(16).padStart(2, "0");
      const b1 = ((x >> 8) & 0xff).toString(16).padStart(2, "0");
      const b2 = ((x >> 16) & 0xff).toString(16).padStart(2, "0");
      const b3 = ((x >> 24) & 0xff).toString(16).padStart(2, "0");
      return b0 + b1 + b2 + b3;
    })
    .join("");
}
