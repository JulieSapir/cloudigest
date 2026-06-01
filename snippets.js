export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);
    const url = requestUrl.searchParams.get("url");
    const cursorStr = requestUrl.searchParams.get("cursor") || "0";
    const cursor = Number.parseInt(cursorStr, 10);
    const stateStr = requestUrl.searchParams.get("state");
    if (!url) return jsonError("URL is required", 400);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return jsonError("Invalid cursor", 400);
    let resumeState = null;
    if (stateStr) {
      try {
        resumeState = JSON.parse(stateStr);
      } catch {
        try {
          resumeState = JSON.parse(decodeURIComponent(stateStr));
        } catch {
          return jsonError("Invalid state parameter", 400);
        }
      }
    }
    if (cursor > 0 && !resumeState) {
      return jsonError("State is required when cursor > 0", 400);
    }
    const isIntermediate = cursor > 0;
    let hasher;
    try {
      hasher = new MultiHasher(resumeState);
      if (hasher.cursor !== cursor) {
        return jsonError(`State/cursor mismatch: state cursor is ${hasher.cursor}, request cursor is ${cursor}`, 400);
      }
    } catch (e) {
      return jsonError(e?.message || String(e), 400);
    }
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    if (request.signal) {
      request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
    const stream = new ReadableStream({
      start(controller) {
        const sendRaw = (text) => controller.enqueue(encoder.encode(text));
        const sendComment = (text = "") => sendRaw(`: ${text}\n\n`);
        const sendSSE = (data) => sendRaw(`data: ${JSON.stringify(data)}\n\n`);
        (async () => {
          let writers = [];
          try {
            sendComment("open");
            const upstream = await fetch(url, {
              headers: cursor > 0 ? { Range: `bytes=${cursor}-` } : {},
              signal: abortController.signal,
            });
            if (upstream.status !== 200 && upstream.status !== 206) {
              sendSSE({ error: `Fetch failed: HTTP ${upstream.status} ${upstream.statusText}` });
              return;
            }
            if (!upstream.body) {
              sendSSE({ error: "Upstream response has no body" });
              return;
            }
            const reader = upstream.body.getReader();
            const SIZE_LIMIT = 1024 * 1024 * 1024;
            const contentLength = parseContentLength(upstream.headers.get("content-length"));
            const useNative = !isIntermediate && upstream.status === 200 && contentLength !== null && contentLength <= SIZE_LIMIT;
            if (useNative) {
              const md5 = new crypto.DigestStream("MD5");
              const sha1 = new crypto.DigestStream("SHA-1");
              const sha256 = new crypto.DigestStream("SHA-256");
              const md5w = md5.getWriter();
              const sha1w = sha1.getWriter();
              const sha256w = sha256.getWriter();
              writers = [md5w, sha1w, sha256w];
              const HEARTBEAT_INTERVAL = 10 * 1024 * 1024;
              let processed = 0;
              let lastBeat = 0;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const len = value ? value.byteLength : 0;
                if (!len) continue;
                await Promise.all([md5w.write(value), sha1w.write(value), sha256w.write(value)]);
                processed += len;
                if (processed - lastBeat >= HEARTBEAT_INTERVAL) {
                  sendComment("ping");
                  lastBeat = processed;
                }
              }
              await Promise.all([md5w.close(), sha1w.close(), sha256w.close()]);
              writers = [];
              const [md5d, sha1d, sha256d] = await Promise.all([md5.digest, sha1.digest, sha256.digest]);
              sendSSE({
                status: "completed",
                engine: "native",
                cursor: processed,
                hashes: {
                  md5: toHex(md5d),
                  sha1: toHex(sha1d),
                  sha256: toHex(sha256d),
                },
              });
            } else {
              if (upstream.status === 200 && cursor > 0) {
                const leftover = await discardBytes(reader, cursor);
                if (leftover) hasher.update(leftover);
              }
              const PROGRESS_INTERVAL = 10 * 1024 * 1024;
              let lastSentCursor = cursor;
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength) {
                  hasher.update(value);
                  if (hasher.cursor - lastSentCursor >= PROGRESS_INTERVAL) {
                    sendSSE({
                      status: "processing",
                      cursor: hasher.cursor,
                      state: hasher.exportState(),
                    });
                    lastSentCursor = hasher.cursor;
                  }
                }
              }
              sendSSE({
                status: "completed",
                engine: "js",
                cursor: hasher.cursor,
                hashes: hasher.digest(),
              });
            }
          } catch (e) {
            for (const w of writers) {
              try {
                await w.abort(e);
              } catch {}
            }
            try {
              sendSSE({ error: e?.message || String(e) });
            } catch {}
          } finally {
            try {
              controller.close();
            } catch {}
          }
        })();
      },
      cancel() {
        abortController.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
function jsonError(error, status = 400) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function parseContentLength(headerValue) {
  if (!headerValue) return null;
  const n = Number(headerValue);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}
function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  const hex = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    hex[i] = bytes[i].toString(16).padStart(2, "0");
  }
  return hex.join("");
}
async function discardBytes(reader, bytes) {
  let discarded = 0;
  while (discarded < bytes) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(`Non-range source URL too short, expected ${bytes} but EOF at ${discarded}`);
    }
    const next = discarded + value.byteLength;
    if (next <= bytes) {
      discarded = next;
      continue;
    }
    const offset = bytes - discarded;
    return value.subarray(offset);
  }
  return null;
}
class MultiHasher {
  constructor(saved = null) {
    const savedBuffer = saved?.buffer;
    const savedLen = savedBuffer ? savedBuffer.length : 0;
    if (savedLen >= 64) throw new Error("Invalid state: buffer must be shorter than 64 bytes");
    this.buffer = new Uint8Array(64);
    this.bufferLen = savedLen;
    if (savedLen > 0) this.buffer.set(savedBuffer);
    this.sha1 = normalizeHashState(saved?.sha1, [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], 5);
    this.sha256 = normalizeHashState(saved?.sha256, [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], 8);
    this.md5 = normalizeHashState(saved?.md5, [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476], 4);
    if (this.sha1.len !== this.sha256.len || this.sha1.len !== this.md5.len) {
      throw new Error("Invalid state: hash lengths mismatch");
    }
    if (this.sha1.len % 64 !== 0) {
      throw new Error("Invalid state: processed length must be a multiple of 64");
    }
  }
  get cursor() {
    return this.sha1.len + this.bufferLen;
  }
  update(chunk) {
    if (!chunk || chunk.byteLength === 0) return;
    let offset = 0;
    const length = chunk.byteLength;
    if (this.bufferLen > 0) {
      const need = 64 - this.bufferLen;
      const take = Math.min(need, length);
      this.buffer.set(chunk.subarray(0, take), this.bufferLen);
      this.bufferLen += take;
      offset += take;
      if (this.bufferLen === 64) {
        this.process64(this.buffer);
        this.bufferLen = 0;
      }
    }
    const fullEnd = offset + Math.floor((length - offset) / 64) * 64;
    while (offset < fullEnd) {
      this.process64(chunk.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < length) {
      this.bufferLen = length - offset;
      this.buffer.set(chunk.subarray(offset), 0);
    }
  }
  process64(block) {
    processBlockSHA1(block, this.sha1);
    processBlockSHA256(block, this.sha256);
    processBlockMD5(block, this.md5);
    this.sha1.len += 64;
    this.sha256.len += 64;
    this.md5.len += 64;
  }
  exportState() {
    const tail = Array.from(this.buffer.subarray(0, this.bufferLen));
    return {
      sha1: { h: Array.from(this.sha1.h), len: this.sha1.len },
      sha256: { h: Array.from(this.sha256.h), len: this.sha256.len },
      md5: { h: Array.from(this.md5.h), len: this.md5.len },
      buffer: tail,
    };
  }
  digest() {
    const tail = this.buffer.subarray(0, this.bufferLen);
    return {
      sha1: finalizeSHA1(tail, cloneState(this.sha1)),
      sha256: finalizeSHA256(tail, cloneState(this.sha256)),
      md5: finalizeMD5(tail, cloneState(this.md5)),
    };
  }
}
function normalizeHashState(saved, initialH, hLen) {
  if (!saved) return { h: initialH.slice(), len: 0 };
  if (!Array.isArray(saved.h) || saved.h.length !== hLen) {
    throw new Error("Invalid state: bad hash state");
  }
  if (!Number.isSafeInteger(saved.len) || saved.len < 0) {
    throw new Error("Invalid state: bad hash length");
  }
  return {
    h: saved.h.map((x) => x | 0),
    len: saved.len,
  };
}
function cloneState(state) {
  const next = {
    h: state.h.slice(),
    len: state.len,
  };
  if (state.w) next.w = new Uint32Array(state.w.length);
  if (state.x) next.x = new Uint32Array(state.x.length);
  return next;
}
function rotl(n, b) {
  return (n << b) | (n >>> (32 - b));
}
function rotr(n, b) {
  return (n >>> b) | (n << (32 - b));
}
function writeLen64BE(view, offset, byteLen) {
  const bits = byteLen * 8;
  const high = Math.floor(bits / 0x100000000);
  const low = bits >>> 0;
  view.setUint32(offset, high, false);
  view.setUint32(offset + 4, low, false);
}
function writeLen64LE(view, offset, byteLen) {
  const bits = byteLen * 8;
  const high = Math.floor(bits / 0x100000000);
  const low = bits >>> 0;
  view.setUint32(offset, low, true);
  view.setUint32(offset + 4, high, true);
}
// SHA-1
function processBlockSHA1(block, state) {
  const w = state.w || (state.w = new Uint32Array(80));
  for (let i = 0; i < 16; i++) {
    w[i] = ((block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3]) >>> 0;
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
function finalizeSHA1(tail, state) {
  const totalLen = state.len + tail.byteLength;
  const zeroLen = (56 - ((tail.byteLength + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(tail.byteLength + 1 + zeroLen + 8);
  padded.set(tail);
  padded[tail.byteLength] = 0x80;
  writeLen64BE(new DataView(padded.buffer), padded.byteLength - 8, totalLen);
  for (let i = 0; i < padded.byteLength; i += 64) {
    processBlockSHA1(padded.subarray(i, i + 64), state);
  }
  return state.h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}
// SHA-256
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
function processBlockSHA256(block, state) {
  const w = state.w || (state.w = new Uint32Array(64));
  for (let i = 0; i < 16; i++) {
    w[i] = ((block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = state.h;
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const temp1 = (h + S1 + ch + K256[i] + w[i]) | 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
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
  const totalLen = state.len + tail.byteLength;
  const zeroLen = (56 - ((tail.byteLength + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(tail.byteLength + 1 + zeroLen + 8);
  padded.set(tail);
  padded[tail.byteLength] = 0x80;
  writeLen64BE(new DataView(padded.buffer), padded.byteLength - 8, totalLen);
  for (let i = 0; i < padded.byteLength; i += 64) {
    processBlockSHA256(padded.subarray(i, i + 64), state);
  }
  return state.h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}
// MD5
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
  const x = state.x || (state.x = new Uint32Array(16));
  for (let i = 0; i < 16; i++) {
    x[i] = block[i * 4] | (block[i * 4 + 1] << 8) | (block[i * 4 + 2] << 16) | (block[i * 4 + 3] << 24);
  }
  let [a, b, c, d] = state.h;
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
  const totalLen = state.len + tail.byteLength;
  const zeroLen = (56 - ((tail.byteLength + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(tail.byteLength + 1 + zeroLen + 8);
  padded.set(tail);
  padded[tail.byteLength] = 0x80;
  writeLen64LE(new DataView(padded.buffer), padded.byteLength - 8, totalLen);
  for (let i = 0; i < padded.byteLength; i += 64) {
    processBlockMD5(padded.subarray(i, i + 64), state);
  }
  return state.h
    .map((x) => {
      return (
        (x & 0xff).toString(16).padStart(2, "0") +
        ((x >>> 8) & 0xff).toString(16).padStart(2, "0") +
        ((x >>> 16) & 0xff).toString(16).padStart(2, "0") +
        ((x >>> 24) & 0xff).toString(16).padStart(2, "0")
      );
    })
    .join("");
}
